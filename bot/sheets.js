// Google Sheets wrapper — the only file that talks to the Sheets API directly.
// Everything else (bot/index.js) goes through these functions.

import fs from 'fs';
import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
const KEY_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;

const PEOPLE_SHEET = 'People';
const TASKS_SHEET = 'Tasks';

// People!A:C -> Name | Telegram Chat ID | Role
// Tasks!A:H  -> Task ID | Description | Assigned By | Assigned To | Status | Created At | Updated At | Notes

export const STATUS = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  DONE: 'Done',
  BLOCKED: 'Blocked',
};

let sheetsClientPromise = null;

// Local dev points GOOGLE_SERVICE_ACCOUNT_KEY_PATH at a JSON file on disk.
// Hosts with no persistent/writable filesystem for secrets (Railway, Render,
// etc.) instead get the key's full JSON contents pasted directly into
// GOOGLE_SERVICE_ACCOUNT_KEY_JSON as an env var — either works.
function loadServiceAccountKey() {
  if (KEY_JSON) return JSON.parse(KEY_JSON);
  if (KEY_PATH) return JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  throw new Error(
    'Set GOOGLE_SERVICE_ACCOUNT_KEY_JSON (the key file\'s full contents) or ' +
      'GOOGLE_SERVICE_ACCOUNT_KEY_PATH (a local file path) — see .env.example'
  );
}

function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      if (!SHEET_ID) {
        throw new Error('SHEET_ID is not set (see .env.example)');
      }
      const key = loadServiceAccountKey();
      const auth = new google.auth.JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      await auth.authorize();
      return google.sheets({ version: 'v4', auth });
    })();
  }
  return sheetsClientPromise;
}

function rowToPerson(row) {
  if (!row || !row[0]) return null;
  const [name, chatId, role] = row;
  return { name: String(name).trim(), chatId: String(chatId ?? '').trim(), role: role || 'Member' };
}

function rowToTask(row) {
  if (!row || !row[0]) return null;
  const [taskId, description, assignedBy, assignedTo, status, createdAt, updatedAt, notes] = row;
  return {
    taskId: String(taskId).trim(),
    description: description || '',
    assignedBy: assignedBy || '',
    assignedTo: assignedTo || '',
    status: status || STATUS.PENDING,
    createdAt: createdAt || '',
    updatedAt: updatedAt || '',
    notes: notes || '',
  };
}

// ---- People -----------------------------------------------------------

export async function getAllPeople() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${PEOPLE_SHEET}!A2:C`,
  });
  return (res.data.values || []).map(rowToPerson).filter(Boolean);
}

export async function getPersonByChatId(chatId) {
  const people = await getAllPeople();
  const target = String(chatId).trim();
  return people.find((p) => p.chatId === target) || null;
}

// Name matching is case-insensitive and tolerates a leading "@" since
// people are registered by their Telegram username (see README) and
// /assign is typically typed as "/assign @username ...".
export async function getPersonByName(name) {
  const target = String(name).trim().replace(/^@/, '').toLowerCase();
  const people = await getAllPeople();
  return people.find((p) => p.name.replace(/^@/, '').toLowerCase() === target) || null;
}

export async function addPerson({ name, chatId, role }) {
  const sheets = await getSheetsClient();
  const row = [name, String(chatId), role || 'Member'];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${PEOPLE_SHEET}!A:C`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return rowToPerson(row);
}

// ---- Tasks --------------------------------------------------------------

export async function getAllTasks() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TASKS_SHEET}!A2:H`,
  });
  return (res.data.values || []).map(rowToTask).filter(Boolean);
}

export async function getTaskById(taskId) {
  const tasks = await getAllTasks();
  const target = String(taskId).trim();
  return tasks.find((t) => t.taskId === target) || null;
}

export async function addTask({ description, assignedBy, assignedTo }) {
  const sheets = await getSheetsClient();
  // Task ID = next sequential integer, derived from current row count.
  // Small team / low write-concurrency, so the race window is acceptable;
  // do not manually delete rows out of order or IDs can collide.
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TASKS_SHEET}!A2:A`,
  });
  const taskId = (existing.data.values || []).length + 1;
  const now = new Date().toISOString();
  const row = [taskId, description, assignedBy, assignedTo, STATUS.PENDING, now, now, ''];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TASKS_SHEET}!A:H`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  return rowToTask(row);
}

async function findTaskRowNumber(sheets, taskId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TASKS_SHEET}!A2:A`,
  });
  const rows = res.data.values || [];
  const target = String(taskId).trim();
  const index = rows.findIndex((r) => r[0] && String(r[0]).trim() === target);
  return index === -1 ? null : index + 2; // +2: header row + 1-based index
}

export async function updateTaskStatus(taskId, status, notes) {
  const sheets = await getSheetsClient();
  const rowNumber = await findTaskRowNumber(sheets, taskId);
  if (!rowNumber) return null;

  const now = new Date().toISOString();
  const data = [
    { range: `${TASKS_SHEET}!E${rowNumber}`, values: [[status]] },
    { range: `${TASKS_SHEET}!G${rowNumber}`, values: [[now]] },
  ];
  if (notes !== undefined) {
    data.push({ range: `${TASKS_SHEET}!H${rowNumber}`, values: [[notes]] });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });

  return getTaskById(taskId);
}
