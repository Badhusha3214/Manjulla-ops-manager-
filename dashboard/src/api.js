const WORKER_URL = import.meta.env.VITE_WORKER_URL;
const API_KEY = import.meta.env.VITE_DASHBOARD_API_KEY;

export async function fetchTasks() {
  if (!WORKER_URL) {
    throw new Error('VITE_WORKER_URL is not set (see .env.example)');
  }

  const headers = {};
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(`${WORKER_URL.replace(/\/$/, '')}/api/tasks`, { headers });
  if (!res.ok) {
    throw new Error(`Worker request failed: ${res.status}`);
  }
  return res.json();
}
