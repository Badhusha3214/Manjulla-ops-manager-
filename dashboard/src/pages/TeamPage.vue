<script setup>
import { computed } from 'vue';
import { tasks, loading, error } from '../composables/useTasks';
import { STATUS_ORDER, statusBadgeClass } from '../statusColors';
import WorkloadChart from '../components/WorkloadChart.vue';

const groupedByAssignee = computed(() => {
  const groups = new Map();
  for (const task of tasks.value) {
    const key = task.assignedTo || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()]
    .map(([name, items]) => ({
      name,
      role: items[0]?.assignedToRole || '',
      tasks: [...items].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}
</script>

<template>
  <h2 class="page-title">Team</h2>

  <div v-if="!loading && !error && tasks.length > 0">
    <WorkloadChart :tasks="tasks" />

    <section v-for="group in groupedByAssignee" :key="group.name" class="group">
      <h2>{{ group.name }} <span v-if="group.role" class="role">({{ group.role }})</span></h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>Status</th>
            <th>Assigned By</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in group.tasks" :key="task.taskId">
            <td>{{ task.taskId }}</td>
            <td>{{ task.description }}</td>
            <td><span :class="statusBadgeClass(task.status)">{{ task.status }}</span></td>
            <td>{{ task.assignedBy }}</td>
            <td>{{ formatDate(task.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>

  <p v-else-if="!loading && !error" class="empty">No tasks yet.</p>
</template>
