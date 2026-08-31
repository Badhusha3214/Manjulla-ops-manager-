<script setup>
import { ref, computed } from 'vue';
import { tasks, loading, error } from '../composables/useTasks';
import { STATUS_ORDER, statusBadgeClass } from '../statusColors';

const search = ref('');
const statusFilter = ref('');
const assigneeFilter = ref('');

const assignees = computed(() => [...new Set(tasks.value.map((t) => t.assignedTo).filter(Boolean))].sort());

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return tasks.value
    .filter((t) => !statusFilter.value || t.status === statusFilter.value)
    .filter((t) => !assigneeFilter.value || t.assignedTo === assigneeFilter.value)
    .filter((t) => !q || t.description.toLowerCase().includes(q))
    .sort((a, b) => Number(b.taskId) - Number(a.taskId));
});

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}
</script>

<template>
  <h2 class="page-title">All tasks</h2>

  <div v-if="!loading && !error && tasks.length > 0">
    <div class="filter-row">
      <input v-model="search" type="search" placeholder="Search descriptions…" />
      <select v-model="statusFilter">
        <option value="">All statuses</option>
        <option v-for="s in STATUS_ORDER" :key="s" :value="s">{{ s }}</option>
      </select>
      <select v-model="assigneeFilter">
        <option value="">Everyone</option>
        <option v-for="name in assignees" :key="name" :value="name">{{ name }}</option>
      </select>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>Assigned To</th>
            <th>Status</th>
            <th>Assigned By</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in filtered" :key="task.taskId">
            <td>{{ task.taskId }}</td>
            <td>{{ task.description }}</td>
            <td>{{ task.assignedTo }}</td>
            <td><span :class="statusBadgeClass(task.status)">{{ task.status }}</span></td>
            <td>{{ task.assignedBy }}</td>
            <td>{{ formatDate(task.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="filtered.length === 0" class="empty">No tasks match those filters.</p>
    </div>
  </div>

  <p v-else-if="!loading && !error" class="empty">No tasks yet.</p>
</template>
