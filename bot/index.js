import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';
import * as sheetsApi from './sheets.js';
import { interpretMessage, interpretCheckInReply, transcribeVoice } from './ai.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set (see .env.example)');
}

const bot = new Bot(BOT_TOKEN);

// In-memory state for the guided "/assign <description>" flow (no @mention
// given, so we ask who it's for). This is per-process and lost on restart —
// fine for a short-lived "pick a person" prompt, not meant to survive a deploy.
const pendingAssign = new Map(); // chatId -> { description, people, assignedByName }

// Same idea, for AI-proposed writes (status change / new task) — Gemini
// never writes to the Sheet directly, it only proposes; this holds the
// proposal until the user taps Yes/No.
const pendingAiAction = new Map(); // chatId -> { type, params, expiresAt }
const AI_ACTION_TTL_MS = 5 * 60 * 1000;
const VALID_STATUSES = new Set(Object.values(sheetsApi.STATUS));

// Evening check-in: chatId -> that person's open tasks at prompt time, so a
// reply can be interpreted against a fixed list rather than a live re-fetch
// (avoids racing a status change made elsewhere between prompt and reply).
// Requires the bot process itself to be running at check-in time — unlike
// the stale-task nudge (which runs from the always-on Worker cron), this
// needs two-way conversation, so it can only live where inbound messages
// are received.
const pendingCheckIn = new Map(); // chatId -> { tasks, expiresAt }
const CHECKIN_TTL_MS = 60 * 60 * 1000;
const CHECKIN_CRON = process.env.CHECKIN_CRON || '0 18 * * *'; // 6pm, server-local time

// Marking a task Blocked always asks why first — the reason becomes the
// task's notes. "button" applies immediately (the tap itself is the
// confirmation, same as In Progress/Done); "ai_status" still goes through
// the usual Yes/No confirm once the reason is attached.
const pendingBlockReason = new Map(); // chatId -> { taskId, mode, expiresAt }
const BLOCK_REASON_TTL_MS = 5 * 60 * 1000;

const STATUS_BUTTONS = [
  { label: '🔵 In Progress', value: sheetsApi.STATUS.IN_PROGRESS, key: 'in_progress' },
  { label: '✅ Done', value: sheetsApi.STATUS.DONE, key: 'done' },
  { label: '⛔ Blocked', value: sheetsApi.STATUS.BLOCKED, key: 'blocked' },
];

function statusKeyboard(taskId) {
  const kb = new InlineKeyboard();
  for (const b of STATUS_BUTTONS) kb.text(b.label, `status:${taskId}:${b.key}`);
  return kb;
}

function aiConfirmKeyboard() {
  return new InlineKeyboard().text('✅ Yes', 'ai_confirm:yes').text('❌ No', 'ai_confirm:no');
}

async function notifyAssignerOfStatusChange(ctx, task, newStatus, reason) {
  const assigner = await sheetsApi.getPersonByName(task.assignedBy);
  if (!assigner) return;
  let text = `Update on Task #${task.taskId} ("${task.description}"): ${task.assignedTo} marked it as ${newStatus}.`;
  if (reason) text += ` Reason: ${reason}`;
  try {
    await ctx.api.sendMessage(assigner.chatId, text);
  } catch {
    // Assigner may have blocked the bot — nothing more we can do.
  }
}

function displayNameFor(from) {
  // Mirrors the registration name derived in /start, used as a fallback
  // for people who assign tasks before ever registering themselves.
  return from.username || [from.first_name, from.last_name].filter(Boolean).join(' ');
}

async function createAndDispatchTask(ctx, { description, assignedByName, assignee }) {
  const task = await sheetsApi.addTask({
    description,
    assignedBy: assignedByName,
    assignedTo: assignee.name,
  });

  await ctx.reply(`Task #${task.taskId} assigned to ${assignee.name}.`);

  try {
    await ctx.api.sendMessage(
      assignee.chatId,
      `📋 New task from ${assignedByName}:\n\n${description}\n\n(Task #${task.taskId})`,
      { reply_markup: statusKeyboard(task.taskId) }
    );
  } catch {
    await ctx.reply(
      `Heads up: I couldn't DM ${assignee.name} directly (they may have blocked the bot, or never started a chat with me). ` +
        `The task was still recorded as #${task.taskId}.`
    );
  }
}

// ---- /start: self-registration -----------------------------------------
// Telegram only exposes a chat's numeric ID to the bot once that chat has
// messaged it, and never exposes it for a bare "@username" the bot hasn't
// talked to. So /start IS the registration step — there is no separate
// "share contact" round-trip needed, ctx.from.id already gives us the real
// chat ID directly. A contact-share button would only add a phone number,
// which nothing here uses, so we skip it.
bot.command('start', async (ctx) => {
  const existing = await sheetsApi.getPersonByChatId(ctx.from.id);
  if (existing) {
    await ctx.reply(`Welcome back, ${existing.name}! You're already registered.`);
    return;
  }

  const name = displayNameFor(ctx.from);
  if (!name) {
    await ctx.reply('I need a Telegram username or name to register you — please set one in your Telegram settings and send /start again.');
    return;
  }

  await sheetsApi.addPerson({ name, chatId: ctx.from.id, role: 'Member' });
  await ctx.reply(
    `You're registered as "${name}". Teammates can now assign you tasks with /assign @${name.replace(/\s+/g, '')} <description>, ` +
      `and you'll get a DM here with buttons to update status.`
  );
});

// ---- /assign: direct (@username) or guided (pick from list) -------------
bot.command('assign', async (ctx) => {
  const from = await sheetsApi.getPersonByChatId(ctx.from.id);
  const assignedByName = from ? from.name : displayNameFor(ctx.from);
  const text = (ctx.match || '').toString().trim();

  if (!text) {
    await ctx.reply(
      'Usage:\n' +
        '/assign @username <task description>\n' +
        'or just:\n' +
        '/assign <task description>   (I\'ll ask who it\'s for)'
    );
    return;
  }

  const mentionMatch = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (mentionMatch) {
    const [, username, description] = mentionMatch;
    const assignee = await sheetsApi.getPersonByName(username);
    if (!assignee) {
      await ctx.reply(
        `@${username} isn't registered with me yet. Ask them to send /start to this bot once, then try again.`
      );
      return;
    }
    await createAndDispatchTask(ctx, { description: description.trim(), assignedByName, assignee });
    return;
  }

  // No @mention — guided flow: whole text is the description, ask who.
  const people = await sheetsApi.getAllPeople();
  if (people.length === 0) {
    await ctx.reply('Nobody is registered yet. Ask your teammates to send /start to this bot first.');
    return;
  }

  pendingAssign.set(ctx.from.id, { description: text, people, assignedByName });
  const kb = new InlineKeyboard();
  people.forEach((p, i) => kb.text(p.name, `pick:${i}`).row());
  await ctx.reply(`Who should get: "${text}"?`, { reply_markup: kb });
});

bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
  const pending = pendingAssign.get(ctx.from.id);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'This assignment has expired — run /assign again.' });
    return;
  }

  const assignee = pending.people[Number(ctx.match[1])];
  pendingAssign.delete(ctx.from.id);
  if (!assignee) {
    await ctx.answerCallbackQuery({ text: 'Something went wrong, please try again.' });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Assigning "${pending.description}" to ${assignee.name}...`);
  await createAndDispatchTask(ctx, {
    description: pending.description,
    assignedByName: pending.assignedByName,
    assignee,
  });
});

// ---- Status button taps ---------------------------------------------------
bot.callbackQuery(/^status:(\d+):(in_progress|done|blocked)$/, async (ctx) => {
  const [, taskId, key] = ctx.match;
  const button = STATUS_BUTTONS.find((b) => b.key === key);

  const task = await sheetsApi.getTaskById(taskId);
  if (!task) {
    await ctx.answerCallbackQuery({ text: 'Task not found — it may have been removed from the sheet.' });
    return;
  }

  // Only the assignee may update their own task's status.
  const tapper = await sheetsApi.getPersonByChatId(ctx.from.id);
  if (!tapper || tapper.name !== task.assignedTo) {
    await ctx.answerCallbackQuery({ text: 'Only the assignee can update this task.', show_alert: true });
    return;
  }

  if (button.key === 'blocked') {
    await ctx.answerCallbackQuery();
    pendingBlockReason.set(ctx.from.id, {
      taskId,
      mode: 'button',
      expiresAt: Date.now() + BLOCK_REASON_TTL_MS,
    });
    await ctx.reply(`Why is Task #${taskId} ("${task.description}") blocked? Reply with a short reason.`);
    return;
  }

  await sheetsApi.updateTaskStatus(taskId, button.value);
  await ctx.answerCallbackQuery({ text: `Marked as ${button.value}` });
  await ctx.editMessageText(`${task.description}\n\nStatus: ${button.value}\n(Task #${taskId})`, {
    reply_markup: statusKeyboard(taskId),
  });

  await notifyAssignerOfStatusChange(ctx, task, button.value);
});

// ---- Free text: AI-assisted status updates / task creation / Q&A --------
// Shared by typed messages and transcribed voice notes (see message:voice
// below) — a spoken "mark it done" goes through the exact same
// pendingBlockReason / pendingCheckIn / interpretMessage logic as if it had
// been typed, so a write still needs the same Yes/No confirm either way.
async function handleUserText(ctx, text) {
  // A pending "why is it blocked?" question takes priority over everything
  // else — the very next message is treated as the reason, whatever it says.
  const blockReason = pendingBlockReason.get(ctx.from.id);
  if (blockReason) {
    pendingBlockReason.delete(ctx.from.id);
    if (blockReason.expiresAt > Date.now()) {
      if (blockReason.mode === 'button') {
        const task = await sheetsApi.updateTaskStatus(blockReason.taskId, sheetsApi.STATUS.BLOCKED, text);
        if (!task) {
          await ctx.reply(`Couldn't find Task #${blockReason.taskId} anymore.`);
          return;
        }
        await ctx.reply(`Marked Task #${blockReason.taskId} as Blocked: "${text}"`);
        await notifyAssignerOfStatusChange(ctx, task, sheetsApi.STATUS.BLOCKED, text);
      } else {
        // ai_status — still goes through the usual Yes/No confirm.
        const task = await sheetsApi.getTaskById(blockReason.taskId);
        pendingAiAction.set(ctx.from.id, {
          type: 'status_update',
          params: { taskId: blockReason.taskId, status: sheetsApi.STATUS.BLOCKED, notes: text },
          expiresAt: Date.now() + AI_ACTION_TTL_MS,
        });
        await ctx.reply(
          `Mark Task #${blockReason.taskId} ("${task?.description || '—'}") as Blocked — "${text}"?`,
          { reply_markup: aiConfirmKeyboard() }
        );
      }
      return;
    }
    // Expired — fall through to normal handling below.
  }

  // An open evening check-in takes priority over everything else — the
  // reply is interpreted against the fixed task list captured at prompt
  // time, not routed through the general chat flow.
  const checkIn = pendingCheckIn.get(ctx.from.id);
  if (checkIn && checkIn.expiresAt > Date.now()) {
    pendingCheckIn.delete(ctx.from.id);
    const updates = await interpretCheckInReply(checkIn.tasks, text);
    if (updates.length === 0) {
      await ctx.reply("Thanks for the update — I didn't catch any status changes to make, so nothing's changed.");
      return;
    }
    const lines = updates.map((u) => {
      const task = checkIn.tasks.find((t) => t.taskId === u.taskId);
      return `#${u.taskId} (${task?.description || '—'}) → ${u.status}`;
    });
    pendingAiAction.set(ctx.from.id, {
      type: 'checkin_batch',
      params: { updates },
      expiresAt: Date.now() + AI_ACTION_TTL_MS,
    });
    await ctx.reply(`Here's what I'll update:\n${lines.join('\n')}\n\nConfirm?`, {
      reply_markup: aiConfirmKeyboard(),
    });
    return;
  }

  if (text.startsWith('/')) {
    await ctx.reply("I don't recognize that command. Try /assign, or just tell me in plain words what you need.");
    return;
  }

  const result = await interpretMessage(ctx, text);

  if (result.type === 'text') {
    await ctx.reply(result.text);
    return;
  }

  if (result.type === 'status_update') {
    const { taskId, status, notes } = result.params;
    const task = await sheetsApi.getTaskById(taskId);
    if (!task) {
      await ctx.reply(`I couldn't find Task #${taskId}.`);
      return;
    }
    const tapper = await sheetsApi.getPersonByChatId(ctx.from.id);
    if (!tapper || tapper.name !== task.assignedTo) {
      await ctx.reply('Only the assignee can update that task.');
      return;
    }
    if (!VALID_STATUSES.has(status)) {
      await ctx.reply(`I understood a status of "${status}", which isn't valid — try Pending, In Progress, Done, or Blocked.`);
      return;
    }
    if (status === sheetsApi.STATUS.BLOCKED && !notes) {
      pendingBlockReason.set(ctx.from.id, {
        taskId,
        mode: 'ai_status',
        expiresAt: Date.now() + BLOCK_REASON_TTL_MS,
      });
      await ctx.reply(`Why is Task #${taskId} ("${task.description}") blocked?`);
      return;
    }
    pendingAiAction.set(ctx.from.id, {
      type: 'status_update',
      params: { taskId, status, notes },
      expiresAt: Date.now() + AI_ACTION_TTL_MS,
    });
    await ctx.reply(`Mark Task #${taskId} ("${task.description}") as ${status}?`, {
      reply_markup: aiConfirmKeyboard(),
    });
    return;
  }

  if (result.type === 'create_tasks') {
    const { tasks } = result.params;
    const from = await sheetsApi.getPersonByChatId(ctx.from.id);
    const assignedByName = from ? from.name : displayNameFor(ctx.from);

    const resolved = [];
    const unregistered = new Set();
    for (const t of tasks) {
      const assignee = await sheetsApi.getPersonByName(t.assignedToName);
      if (!assignee) {
        unregistered.add(t.assignedToName);
        continue;
      }
      resolved.push({ description: t.description, assignee });
    }

    if (resolved.length === 0) {
      await ctx.reply(
        `${[...unregistered].join(', ')} isn't registered with me yet. Ask them to send /start to this bot once, then try again.`
      );
      return;
    }

    pendingAiAction.set(ctx.from.id, {
      type: 'create_tasks',
      params: { tasks: resolved, assignedByName },
      expiresAt: Date.now() + AI_ACTION_TTL_MS,
    });

    let prompt =
      resolved.length === 1
        ? `Create task "${resolved[0].description}" for ${resolved[0].assignee.name}?`
        : `Create these ${resolved.length} tasks?\n` +
          resolved.map((t) => `• "${t.description}" → ${t.assignee.name}`).join('\n');
    if (unregistered.size > 0) {
      prompt += `\n\n(Skipping — not registered yet: ${[...unregistered].join(', ')})`;
    }
    await ctx.reply(prompt, { reply_markup: aiConfirmKeyboard() });
    return;
  }
}

// Registered after the /command handlers, so it only sees text that no
// command matched.
bot.on('message:text', (ctx) => handleUserText(ctx, ctx.message.text.trim()));

// ---- Voice messages: transcribe, then run through the same pipeline -----
// Telegram voice notes are OGG/Opus; Gemini accepts that mime type directly.
// The transcript is echoed back before acting on it, since a misheard word
// could otherwise mark the wrong task — the existing Yes/No confirm on any
// AI-proposed write is a second backstop on top of that.
bot.on('message:voice', async (ctx) => {
  const { file_id, mime_type } = ctx.message.voice;
  const file = await ctx.api.getFile(file_id);
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  const audioBase64 = Buffer.from(await res.arrayBuffer()).toString('base64');

  const transcript = await transcribeVoice(audioBase64, mime_type || 'audio/ogg');
  if (!transcript) {
    await ctx.reply("Sorry, I couldn't make out that voice message — try again, or type it instead.");
    return;
  }

  await ctx.reply(`🎙️ Heard: "${transcript}"`);
  await handleUserText(ctx, transcript);
});

bot.callbackQuery(/^ai_confirm:(yes|no)$/, async (ctx) => {
  const [, choice] = ctx.match;

  if (choice === 'no') {
    pendingAiAction.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Okay, no changes made.');
    return;
  }

  const pending = pendingAiAction.get(ctx.from.id);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingAiAction.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'This proposal has expired — just tell me again.' });
    return;
  }
  pendingAiAction.delete(ctx.from.id);
  await ctx.answerCallbackQuery();

  if (pending.type === 'status_update') {
    const { taskId, status, notes } = pending.params;
    const task = await sheetsApi.updateTaskStatus(taskId, status, notes);
    await ctx.editMessageText(`Marked Task #${taskId} as ${status}.`);
    if (task) await notifyAssignerOfStatusChange(ctx, task, status, notes);
    return;
  }

  if (pending.type === 'create_tasks') {
    const { tasks, assignedByName } = pending.params;
    await ctx.editMessageText(
      tasks.length > 1 ? `Creating ${tasks.length} tasks...` : `Creating "${tasks[0].description}" for ${tasks[0].assignee.name}...`
    );
    for (const { description, assignee } of tasks) {
      await createAndDispatchTask(ctx, { description, assignedByName, assignee });
    }
    return;
  }

  if (pending.type === 'checkin_batch') {
    const summaries = [];
    for (const { taskId, status, notes } of pending.params.updates) {
      const task = await sheetsApi.updateTaskStatus(taskId, status, notes);
      if (task) {
        summaries.push(`#${taskId}: ${status}`);
        await notifyAssignerOfStatusChange(ctx, task, status, notes);
      }
    }
    await ctx.editMessageText(
      summaries.length ? `Updated:\n${summaries.join('\n')}` : 'Nothing to update after all.'
    );
  }
});

bot.catch((err) => {
  console.error('Bot error:', err.message, err.stack);
});

// ---- Evening check-in: DM everyone with open tasks, wait for their reply --
// Only fires while this process is running — unlike the stale-task nudge
// (worker/src/index.js, an always-on Cloudflare Cron Trigger), this needs a
// two-way conversation, so it can't be moved to the Worker.
cron.schedule(CHECKIN_CRON, async () => {
  const [people, tasks] = await Promise.all([sheetsApi.getAllPeople(), sheetsApi.getAllTasks()]);
  for (const person of people) {
    const openTasks = tasks.filter((t) => t.assignedTo === person.name && t.status !== sheetsApi.STATUS.DONE);
    if (openTasks.length === 0) continue;

    pendingCheckIn.set(Number(person.chatId), { tasks: openTasks, expiresAt: Date.now() + CHECKIN_TTL_MS });
    const list = openTasks.map((t) => `• #${t.taskId}: ${t.description} (${t.status})`).join('\n');
    try {
      await bot.api.sendMessage(
        person.chatId,
        `🌆 End-of-day check-in! Here's what's open for you:\n\n${list}\n\nWhat did you get done today? Just reply in your own words.`
      );
    } catch (err) {
      pendingCheckIn.delete(Number(person.chatId));
      console.error(`Check-in DM failed for ${person.name}:`, err.message);
    }
  }
});

// Not awaited: bot.start() only resolves when polling stops. A rejection
// here (most commonly a 409 — Telegram still finalizing the previous
// instance's connection during a redeploy) would otherwise crash as an
// unhandled rejection with a raw stack trace; log it plainly instead and
// exit, so the host's restart policy (e.g. Render) can retry cleanly.
bot.start().catch((err) => {
  console.error('Bot stopped:', err.message);
  process.exit(1);
});
console.log('DevMorphix Ops bot started.');
