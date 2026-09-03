# DevMorphix Ops Bot

Assign and track tasks entirely through Telegram. Google Sheets is the
database; a read-only Vue dashboard shows live status.

```
/bot         Node.js + grammy Telegram bot, writes/reads Google Sheets directly
/worker      Cloudflare Worker — read-only JSON proxy for the dashboard
/dashboard   Vue 3 + Vite dashboard, polls the Worker every 30s
```

The bot and the Worker both authenticate to Google as the **same service
account**, but the bot uses full read/write access (it needs to create rows
and update status) while the Worker requests only the `spreadsheets.readonly`
OAuth scope (it only ever displays data). The service account key lives in
two places — the bot's local `.env`/JSON file, and the Worker's encrypted
secrets — and is never sent to the browser.

## Sheet schema

Create one Google Sheet with two tabs, named exactly:

**People**

| Name | Telegram Chat ID | Role |
|---|---|---|
| alice | 123456789 | Member |

- `Name` is the person's **Telegram username** (no `@`), captured
  automatically the first time they `/start` the bot. This is what you type
  after `@` in `/assign @alice ...`.
- Row 1 must be the header row shown above; data starts at row 2.

**Tasks**

| Task ID | Description | Assigned By | Assigned To | Status | Created At | Updated At | Notes |
|---|---|---|---|---|---|---|---|

- `Task ID` is a sequential integer assigned by the bot. Don't reorder or
  delete rows out of order — the bot finds a task's row by scanning column A
  for a matching ID, and computes the *next* ID from the row count, so
  deleting from the middle can produce duplicate IDs later.
- `Status` is one of `Pending` (just assigned), `In Progress`, `Done`,
  `Blocked`.
- The bot manages this tab entirely; you generally shouldn't hand-edit it
  while the bot is running.

## 1. Create the Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the
   prompts.
2. Copy the token it gives you — that's `BOT_TOKEN`.

## 2. Create the Google service account

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project, then enable the **Google Sheets API**.
2. **IAM & Admin → Service Accounts → Create Service Account**. No project
   roles are needed — access is granted by sharing the Sheet directly (next
   step).
3. Open the new service account → **Keys → Add Key → Create new key → JSON**.
   Download it.
4. Note the service account's email — looks like
   `something@your-project.iam.gserviceaccount.com`.

## 3. Create and share the Sheet

1. Create a Google Sheet with the `People` and `Tasks` tabs/headers above.
2. **Share** the Sheet with the service account's email as **Editor** (the
   bot needs to write rows; the Worker's own OAuth request narrows itself to
   read-only regardless of this grant).
3. Copy the Sheet ID out of its URL:
   `https://docs.google.com/spreadsheets/d/THIS_PART/edit` → that's
   `SHEET_ID`.

## 4. Run the bot

```bash
cd bot
npm install
cp .env.example .env
# fill in BOT_TOKEN, SHEET_ID, and point GOOGLE_SERVICE_ACCOUNT_KEY_PATH
# at the JSON key file from step 2 (e.g. drop it in bot/service-account.json).
# Also fill in GEMINI_API_KEY (from https://aistudio.google.com/apikey) —
# powers free-text understanding, see "AI features" below.
npm start
```

Each teammate sends `/start` to the bot once — this registers them (captures
their Telegram username and numeric chat ID into the People sheet). After
that, anyone can run:

```
/assign @alice Fix the login bug
```

or, without knowing anyone's exact username:

```
/assign Fix the login bug
```

which replies with an inline list of everyone registered to pick from.

**Why `/start` is the whole registration flow:** Telegram never gives a bot
a chat's numeric ID for a bare `@username` it hasn't talked to — there's no
API for that. The only reliable way to learn someone's chat ID is for them
to message the bot, and `/start` already carries that ID in `ctx.from.id`,
so no separate "share your contact" step is needed. The tradeoff is real,
though: **you cannot assign a task to someone who has never messaged the
bot.** If `/assign @bob ...` is used before Bob has `/start`ed, the bot
tells the assigner Bob isn't registered yet and to ask him to `/start`
first.

## Deploy the bot (Render)

`bot/index.js` is a long-running process — an open Telegram long-poll
connection, a `node-cron` schedule for the evening check-in, and in-memory
state that only survives while the process stays up. That rules out
Cloudflare Workers and Vercel (both spin functions up per-request and kill
them after — no persistent background loop); it needs a host that keeps a
Node process running continuously. [Render](https://render.com)'s
**Background Worker** service type is built for exactly this — no HTTP port
needed, unlike a Web Service.

1. Push this repo to GitHub (see below) if you haven't already.
2. In Render: **New → Background Worker** → connect this GitHub repo.
3. **Root Directory** → `bot`. **Build Command** → `npm install` (there's no
   build step, see "why there is no build" below). **Start Command** →
   `npm start`.
4. **Environment** → add every var from `bot/.env.example`:
   - `BOT_TOKEN`, `SHEET_ID`, `GEMINI_API_KEY` (and `GEMINI_MODEL`,
     `CHECKIN_CRON` if you want non-default values)
   - For the service account key, use `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`
     (paste the full contents of `bot/service-account.json`) — **not**
     `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`, since Render has no file there to
     point at.
5. Deploy. Check the logs for `DevMorphix Ops bot started.` with no errors.

Only ever run **one** instance of the bot at a time — Telegram rejects a
second long-poll connection with a 409 conflict, so once Render is running
it, stop any local `npm start` copy.

**bot/ has no build step** because it's plain Node.js (`.js`, ESM), not
TypeScript or a bundled framework — `node index.js` runs the source
directly. That's different from `dashboard/`, whose Vue components do need
compiling (`npm run build`) before a browser can run them.

## AI features

**Free-text understanding (bot, always on once `GEMINI_API_KEY` is set):**
send the bot a plain-language message instead of a command — "I finished
the login bug", "assign Bob to fix the header", "what's pending for me" —
and it uses Gemini to either answer directly (read-only questions) or
propose a status change / new task. Proposed writes always show a Yes/No
button first; nothing is written to the Sheet until you confirm. See
`bot/ai.js`.

**Voice messages (bot, always on once `GEMINI_API_KEY` is set):** send a
Telegram voice note instead of typing — the bot transcribes it with Gemini,
echoes back what it heard, then runs the transcript through the exact same
free-text pipeline as typed messages (status updates, task creation, Q&A,
block-reason replies, evening check-in replies). Any proposed write still
needs the usual Yes/No confirm. See `bot/ai.js`'s `transcribeVoice`.

**Scheduled reminders (Worker cron, always on once deployed):** once a day
(`STALE_DAYS`, default 3, and the cron hour are set in `worker/wrangler.toml`)
the Worker checks for `Pending`/`In Progress` tasks that haven't been
updated in a while and DMs the assignee a reminder, drafted by Gemini and
falling back to a plain templated message if the AI call fails. Set
`DRY_RUN=true` in `worker/.dev.vars` to log intended reminders locally
instead of actually sending them.

**Evening check-in (bot process, requires it to be running at check-in
time):** at `CHECKIN_CRON` (default 6pm server-local time, `bot/.env`),
everyone with open tasks gets DM'd their list and asked what they finished
today. Reply in plain words — Gemini maps it to specific task updates and
shows a single Yes/No summary before writing anything. Unlike the stale-task
reminder above, this can't run from the Worker: it needs to receive your
reply, and only the bot process (long-polling Telegram) does that — so keep
`npm start` running in `bot/` for this feature to actually fire.

## Task status colors

The `Tasks` sheet is conditionally formatted: rows with `Status = Done` turn
green, `Status = Blocked` turn red, everything else stays white. This is a
one-time Sheet setting (not code) — if you create a fresh Sheet from
scratch, reapply it via Format → Conditional formatting in Google Sheets, or
ask an agent to redo it via the Sheets API.

## 5. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login

# Secrets (paste the service account's email, and the private_key value
# from the same JSON key file used by the bot):
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_PRIVATE_KEY
# the same Sheet ID as bot/.env's SHEET_ID — kept as a secret, not a
# wrangler.toml [vars] entry, so a public repo doesn't reveal which Sheet
# backs this deployment:
npx wrangler secret put SHEET_ID
# optional — require dashboard requests to send a bearer token:
npx wrangler secret put DASHBOARD_API_KEY

# For reminders: same bot token as bot/.env's BOT_TOKEN, and the same (or a
# separate) Gemini key as bot/.env's GEMINI_API_KEY:
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY

# Edit ALLOWED_ORIGIN once you know the dashboard's URL in wrangler.toml,
# then:
npx wrangler deploy
```

For local development, copy `worker/.dev.vars.example` to `worker/.dev.vars`
and fill it in — `wrangler dev` reads it automatically.

Note the deployed `*.workers.dev` URL — that's `VITE_WORKER_URL` for the
dashboard.

## 6. Run the dashboard

```bash
cd dashboard
npm install
cp .env.example .env.local
# set VITE_WORKER_URL to the Worker URL from step 5
npm run dev
```

`npm run build` produces a static `dist/` you can deploy anywhere (Cloudflare
Pages, Netlify, GitHub Pages, ...). Set the same env vars in that host's
build settings.

## Environment variables reference

| Variable | Where | Purpose |
|---|---|---|
| `BOT_TOKEN` | `bot/.env` | Telegram bot token from BotFather |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | `bot/.env` | Path to the service account JSON key (local dev) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | `bot/.env` or Render env var | The key file's full JSON contents, for hosts with no file to point at |
| `SHEET_ID` | `bot/.env`, Worker secret | The Google Sheet's ID — a Worker secret, not a `[vars]` entry, so it isn't exposed in a public repo |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Worker secret | Same service account, email only |
| `GOOGLE_PRIVATE_KEY` | Worker secret | Same service account, `private_key` field |
| `DASHBOARD_API_KEY` | Worker secret (optional) | Require a bearer token on `/api/tasks` |
| `ALLOWED_ORIGIN` | `worker/wrangler.toml` | CORS origin allowed to call the Worker |
| `GEMINI_API_KEY` | `bot/.env`, Worker secret | Google AI Studio key — powers free-text chat and reminder text |
| `GEMINI_MODEL` | `bot/.env` (optional), `worker/wrangler.toml` | Defaults to `gemini-3.7-flash` |
| `TELEGRAM_BOT_TOKEN` | Worker secret | Same value as `bot/.env`'s `BOT_TOKEN` — lets reminders DM through the same bot |
| `STALE_DAYS` | `worker/wrangler.toml` | Days without an update before a task is nudged (default 3) |
| `DRY_RUN` | `worker/wrangler.toml` / `.dev.vars` | `true` logs reminders instead of sending them |
| `VITE_WORKER_URL` | `dashboard/.env.local` | Deployed Worker's base URL |
| `VITE_DASHBOARD_API_KEY` | `dashboard/.env.local` (optional) | Must match `DASHBOARD_API_KEY` if set |
