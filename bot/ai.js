// Gemini-powered free-text understanding for the bot: answers questions
// directly (read-only tools) and turns status/creation requests into a
// proposal object — it never writes to the Sheet itself. bot/index.js owns
// confirmation and the actual write, mirroring the existing pendingAssign
// pattern so there's one place that talks to Telegram.

import { GoogleGenAI } from '@google/genai';
import * as sheetsApi from './sheets.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const WRITE_TOOLS = new Set(['propose_status_update', 'propose_create_task']);

const toolDeclarations = [
  {
    type: 'function',
    name: 'list_my_tasks',
    description: "List the caller's own tasks, optionally filtered by status.",
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['Pending', 'In Progress', 'Done', 'Blocked'] },
      },
    },
  },
  {
    type: 'function',
    name: 'find_task',
    description: 'Look up a single task by its numeric Task ID.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    type: 'function',
    name: 'list_team_tasks',
    description: "List tasks across the team, optionally filtered by assignee name and/or status. Use for questions about what someone else is working on.",
    parameters: {
      type: 'object',
      properties: {
        assignedTo: { type: 'string', description: "A teammate's registered name" },
        status: { type: 'string', enum: ['Pending', 'In Progress', 'Done', 'Blocked'] },
      },
    },
  },
  {
    type: 'function',
    name: 'propose_status_update',
    description:
      "Propose changing the status of one of the caller's own tasks (e.g. marking it done). " +
      'This does NOT apply the change — it only records a proposal the user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The Task ID being updated' },
        status: { type: 'string', enum: ['Pending', 'In Progress', 'Done', 'Blocked'] },
        notes: { type: 'string', description: 'Optional short note about the update' },
      },
      required: ['taskId', 'status'],
    },
  },
  {
    type: 'function',
    name: 'propose_create_task',
    description:
      'Propose creating a new task for a named teammate. ' +
      'This does NOT create the task — it only records a proposal the user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        assignedToName: { type: 'string', description: "The teammate's registered name" },
      },
      required: ['description', 'assignedToName'],
    },
  },
];

async function executeReadTool(name, args, caller) {
  switch (name) {
    case 'list_my_tasks': {
      if (!caller) return { error: 'Caller is not registered.' };
      const tasks = await sheetsApi.getAllTasks();
      return {
        tasks: tasks.filter((t) => t.assignedTo === caller.name && (!args.status || t.status === args.status)),
      };
    }
    case 'find_task': {
      const task = await sheetsApi.getTaskById(args.taskId);
      return task ? { task } : { error: 'Task not found.' };
    }
    case 'list_team_tasks': {
      const tasks = await sheetsApi.getAllTasks();
      const targetName = args.assignedTo ? String(args.assignedTo).replace(/^@/, '').toLowerCase() : null;
      return {
        tasks: tasks.filter(
          (t) =>
            (!targetName || t.assignedTo.toLowerCase() === targetName) &&
            (!args.status || t.status === args.status)
        ),
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Returns either { type: 'text', text } for a direct reply, or
// { type: 'status_update' | 'create_task', params } for a write proposal
// that bot/index.js must confirm with the user before touching the Sheet.
export async function interpretMessage(ctx, text) {
  const caller = await sheetsApi.getPersonByChatId(ctx.from.id);
  const systemPrompt = [
    "You are an ops assistant for a small team's task tracker, reachable via Telegram.",
    caller
      ? `The person messaging you is "${caller.name}" (role: ${caller.role}), already registered.`
      : 'The person messaging you is NOT registered yet — if they ask to change or create a task, ' +
        'tell them to send /start to this bot first, and do not call any tool.',
    'For questions, use the read tools (list_my_tasks, find_task, list_team_tasks) and answer briefly.',
    'For a status change or new task, call the matching propose_* tool — never claim you made the ' +
      'change yourself; the user still has to confirm it.',
  ].join('\n');

  let interaction = await ai.interactions.create({
    model: GEMINI_MODEL,
    input: `${systemPrompt}\n\nMessage: ${text}`,
    tools: toolDeclarations,
  });

  // Resolve read-tool calls in a loop; stop at the first write proposal.
  for (let i = 0; i < 4; i++) {
    const fcStep = interaction.steps?.find((s) => s.type === 'function_call');
    if (!fcStep) break;

    if (WRITE_TOOLS.has(fcStep.name)) {
      return {
        type: fcStep.name === 'propose_status_update' ? 'status_update' : 'create_task',
        params: fcStep.arguments,
      };
    }

    const result = await executeReadTool(fcStep.name, fcStep.arguments || {}, caller);
    interaction = await ai.interactions.create({
      model: GEMINI_MODEL,
      previous_interaction_id: interaction.id,
      tools: toolDeclarations,
      input: [
        {
          type: 'function_result',
          name: fcStep.name,
          call_id: fcStep.id,
          result: [{ type: 'text', text: JSON.stringify(result) }],
        },
      ],
    });
  }

  return { type: 'text', text: interaction.output_text || "Sorry, I didn't quite catch that." };
}

// Evening check-in: interprets a free-text reply against a specific person's
// already-known open tasks (no read tools needed — the caller passes the
// task list directly) and returns every status change it can confidently
// infer. Like interpretMessage, this never writes — bot/index.js confirms
// the whole batch with one Yes/No before applying anything.
export async function interpretCheckInReply(openTasks, replyText) {
  const prompt = [
    "You're reading a teammate's evening check-in reply about their open tasks.",
    'Open tasks (JSON): ' + JSON.stringify(openTasks.map((t) => ({ taskId: t.taskId, description: t.description, status: t.status }))),
    `Their reply: "${replyText}"`,
    'For each task they clearly reference as done, in progress, or blocked, include an update. ' +
      "Leave out any task they didn't mention or that's ambiguous. If they mention nothing you can " +
      'map to a task, return an empty updates array.',
  ].join('\n');

  const interaction = await ai.interactions.create({
    model: GEMINI_MODEL,
    input: prompt,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                status: { type: 'string', enum: ['Pending', 'In Progress', 'Done', 'Blocked'] },
                notes: { type: 'string' },
              },
              required: ['taskId', 'status'],
            },
          },
        },
        required: ['updates'],
      },
    },
  });

  try {
    const parsed = JSON.parse(interaction.output_text);
    const validIds = new Set(openTasks.map((t) => t.taskId));
    return (parsed.updates || []).filter((u) => validIds.has(u.taskId));
  } catch {
    return [];
  }
}
