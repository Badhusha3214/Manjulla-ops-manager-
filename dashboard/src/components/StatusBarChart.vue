<script setup>
import { ref, computed } from 'vue';
import { STATUS_ORDER, statusColor } from '../statusColors';

const props = defineProps({
  tasks: { type: Array, required: true },
});

const showTable = ref(false);
const tooltip = ref(null); // { x, y, label, value }

const rows = computed(() => {
  const total = props.tasks.length || 1;
  const counts = new Map(STATUS_ORDER.map((s) => [s, 0]));
  for (const t of props.tasks) {
    counts.set(t.status, (counts.get(t.status) || 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  return STATUS_ORDER.map((status) => {
    const count = counts.get(status) || 0;
    return {
      status,
      count,
      pct: Math.round((count / total) * 100),
      widthPct: (count / max) * 100,
      color: statusColor(status),
    };
  });
});

function showTooltip(evt, row) {
  tooltip.value = {
    x: evt.clientX + 12,
    y: evt.clientY + 12,
    label: row.status,
    value: `${row.count} task${row.count === 1 ? '' : 's'} (${row.pct}%)`,
  };
}

function hideTooltip() {
  tooltip.value = null;
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <h2>Tasks by status</h2>
        <p class="subtitle">How the current workload breaks down.</p>
      </div>
      <button class="table-toggle" @click="showTable = !showTable">
        {{ showTable ? 'Chart' : 'Table' }}
      </button>
    </div>

    <div v-if="!showTable" class="bar-chart-rows">
      <div v-for="row in rows" :key="row.status" class="bar-row">
        <span class="row-label">{{ row.status }}</span>
        <div class="bar-track">
          <div
            class="bar-segment only-segment"
            tabindex="0"
            :style="{ width: row.widthPct + '%', background: row.color }"
            @pointermove="showTooltip($event, row)"
            @pointerleave="hideTooltip"
            @focus="showTooltip($event, row)"
            @blur="hideTooltip"
          ></div>
        </div>
        <span class="row-value">{{ row.count }}</span>
      </div>
    </div>

    <table v-else class="chart-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Count</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.status">
          <td>{{ row.status }}</td>
          <td>{{ row.count }}</td>
          <td>{{ row.pct }}%</td>
        </tr>
      </tbody>
    </table>

    <Teleport to="body">
      <div v-if="tooltip" class="chart-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
        {{ tooltip.label }}: <span class="tt-value">{{ tooltip.value }}</span>
      </div>
    </Teleport>
  </div>
</template>
