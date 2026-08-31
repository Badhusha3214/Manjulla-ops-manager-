// Read-only Sheets-to-JSON proxy for the dashboard.
//
// Cloudflare Workers have no filesystem and no Node `googleapis` SDK, so
// service-account auth is done by hand here: build a JWT, sign it with the
// service account's private key via Web Crypto, and trade it for a Google
// OAuth access token. The service account key never leaves this Worker.

const TASKS_RANGE = 'Tasks!A2:H';
const PEOPLE_RANGE = 'People!A2:C';

let cachedToken = null; // { token, expiresAt } — best-effort, per-isolate

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function createSignedJwt(env) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  // GOOGLE_PRIVATE_KEY is stored with literal "\n" escapes in wrangler
  // secrets/.dev.vars; normalize back to real newlines before parsing.
  const keyData = pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  const jwt = await createSignedJwt(env);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

async function fetchSheetData(env, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet`);
  url.searchParams.append('ranges', TASKS_RANGE);
  url.searchParams.append('ranges', PEOPLE_RANGE);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Sheets API request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const [taskRange, peopleRange] = data.valueRanges;
  return { taskRows: taskRange.values || [], peopleRows: peopleRange.values || [] };
}

function rowToTask(row) {
  const [taskId, description, assignedBy, assignedTo, status, createdAt, updatedAt, notes] = row;
  return {
    taskId: String(taskId ?? ''),
    description: description || '',
    assignedBy: assignedBy || '',
    assignedTo: assignedTo || '',
    status: status || 'Pending',
    createdAt: createdAt || '',
    updatedAt: updatedAt || '',
    notes: notes || '',
  };
}

// ---- Reminders (Cron Trigger) --------------------------------------------
// Runs entirely server-side here rather than from the bot process, since
// this Worker is the only piece of the stack with a reliable persistent
// deployment (the bot only runs via `npm start` locally). Re-checks
// staleness from scratch on every firing — no KV/DO needed: a task that
// gets touched drops back under the threshold on its own, and one that
// doesn't gets re-flagged the next day, which is the intended nag.

const STALE_STATUSES = new Set(['Pending', 'In Progress']);

function isStaleTask(task, staleDays) {
  if (!STALE_STATUSES.has(task.status)) return false;
  const basis = task.updatedAt || task.createdAt;
  if (!basis) return false;
  const ageMs = Date.now() - new Date(basis).getTime();
  if (Number.isNaN(ageMs)) return false;
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}

function groupStaleByAssignee(tasks) {
  const byAssignee = new Map();
  for (const task of tasks) {
    if (!byAssignee.has(task.assignedTo)) byAssignee.set(task.assignedTo, []);
    byAssignee.get(task.assignedTo).push(task);
  }
  return byAssignee;
}

function buildFallbackMessage(assigneeName, tasks) {
  const lines = tasks.map((t) => `• #${t.taskId}: ${t.description} (${t.status})`);
  return `👋 ${assigneeName}, a nudge on tasks that haven't moved in a while:\n\n${lines.join('\n')}`;
}

// One Gemini call per cron firing, covering every stale assignee at once.
// Returns a Map<assigneeName, message> on success, or null on any failure —
// callers must fall back to buildFallbackMessage() for everyone, so an AI
// hiccup never means a reminder silently doesn't go out.
async function generateAiReminders(env, staleByAssignee) {
  const payload = Array.from(staleByAssignee.entries()).map(([assignedTo, tasks]) => ({
    assignedTo,
    tasks: tasks.map((t) => ({ taskId: t.taskId, description: t.description, status: t.status })),
  }));

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Write one short, friendly Telegram reminder message per person about their stale tasks ' +
              '(tasks that have sat without an update for a while). Keep each message under 3 sentences, ' +
              'mention the task descriptions, and do not invent tasks not listed. ' +
              `Input (JSON): ${JSON.stringify(payload)}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          reminders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                assignedTo: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['assignedTo', 'message'],
            },
          },
        },
        required: ['reminders'],
      },
    },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      console.error('Gemini reminder generation failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.reminders)) return null;

    const byAssignee = new Map();
    for (const entry of parsed.reminders) {
      if (entry?.assignedTo && entry?.message) byAssignee.set(entry.assignedTo, entry.message);
    }
    return byAssignee;
  } catch (err) {
    console.error('Gemini reminder generation error:', err.message);
    return null;
  }
}

async function sendTelegramMessage(env, chatId, text) {
  if (env.DRY_RUN === 'true') {
    console.log('[DRY_RUN] would send to', chatId, ':', text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.error('Telegram send failed for', chatId, ':', res.status, await res.text());
  }
}

async function runReminders(env) {
  const staleDays = Number(env.STALE_DAYS) || 3;
  const accessToken = await getAccessToken(env);
  const { taskRows, peopleRows } = await fetchSheetData(env, accessToken);

  const chatIdByName = new Map(peopleRows.map((r) => [String(r[0] || '').trim(), r[1]]));
  const tasks = taskRows.filter((r) => r[0]).map(rowToTask);
  const stale = tasks.filter((t) => isStaleTask(t, staleDays));

  if (stale.length === 0) {
    console.log('runReminders: no stale tasks, nothing to send.');
    return;
  }

  const staleByAssignee = groupStaleByAssignee(stale);
  const aiMessages = await generateAiReminders(env, staleByAssignee);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const entries = Array.from(staleByAssignee.entries());
  const CHUNK_SIZE = 5;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(
      chunk.map(async ([assigneeName, assigneeTasks]) => {
        const chatId = chatIdByName.get(assigneeName);
        if (!chatId) {
          console.warn('runReminders: no chat ID for', assigneeName, '— they likely never /start-ed.');
          skipped++;
          return;
        }
        const message = aiMessages?.get(assigneeName) || buildFallbackMessage(assigneeName, assigneeTasks);
        await sendTelegramMessage(env, chatId, message);
        sent++;
      })
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        console.error('runReminders: send failed:', r.reason?.message || r.reason);
      }
    }
  }

  console.log(`runReminders: sent=${sent} skipped=${skipped} failed=${failed} (ai=${aiMessages ? 'ok' : 'fallback'})`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname !== '/api/tasks') {
      return new Response('Not found', { status: 404, headers: cors });
    }

    // Optional shared-secret gate. With it unset, the endpoint is open —
    // fine for read-only, non-sensitive task data behind an unguessable
    // workers.dev URL; set DASHBOARD_API_KEY if that's not good enough.
    if (env.DASHBOARD_API_KEY) {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.DASHBOARD_API_KEY}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    try {
      const accessToken = await getAccessToken(env);
      const { taskRows, peopleRows } = await fetchSheetData(env, accessToken);

      // Chat IDs are intentionally left out of the public response — the
      // dashboard only needs name/role, not a way to DM people.
      const roleByName = new Map(peopleRows.map((r) => [String(r[0] || '').trim(), r[2] || 'Member']));
      const tasks = taskRows
        .filter((r) => r[0])
        .map((r) => {
          const task = rowToTask(r);
          return { ...task, assignedToRole: roleByName.get(task.assignedTo) || 'Member' };
        });

      return new Response(JSON.stringify({ tasks, updatedAt: new Date().toISOString() }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch((err) => console.error('runReminders failed:', err.message)));
  },
};
