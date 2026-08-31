<script setup>
import { computed } from 'vue';
import { tasks, loading, error } from '../composables/useTasks';
import { STATUS_ORDER, statusColor } from '../statusColors';
import StatTile from '../components/StatTile.vue';
import StatusBarChart from '../components/StatusBarChart.vue';

const statusCounts = computed(() => {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const t of tasks.value) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
});
</script>

<template>
  <h2 class="page-title">Overview</h2>

  <div v-if="!loading && !error && tasks.length > 0">
    <div class="kpi-row">
      <StatTile label="Total tasks" :value="tasks.length" />
      <StatTile
        v-for="status in STATUS_ORDER"
        :key="status"
        :label="status"
        :value="statusCounts[status]"
        :color="statusColor(status)"
      />
    </div>

    <StatusBarChart :tasks="tasks" />
  </div>

  <p v-else-if="!loading && !error" class="empty">No tasks yet.</p>
</template>
