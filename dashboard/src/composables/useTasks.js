// Module-level singleton store: every page imports the same refs, so
// switching pages doesn't refetch or restart the poll. Polling itself is
// started once from App.vue's onMounted, not from individual pages.

import { ref } from 'vue';
import { fetchTasks } from '../api';

const POLL_INTERVAL_MS = 30_000;

export const tasks = ref([]);
export const error = ref(null);
export const loading = ref(true);
export const lastUpdated = ref(null);

let timer = null;

export async function load() {
  try {
    const data = await fetchTasks();
    tasks.value = data.tasks;
    lastUpdated.value = new Date();
    error.value = null;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

export function startPolling() {
  if (timer) return;
  load();
  timer = setInterval(load, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
