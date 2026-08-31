<script setup>
import { ref, computed } from 'vue';
import { STATUS_ORDER, statusColor } from '../statusColors';

const props = defineProps({
  tasks: { type: Array, required: true },
});

const showTable = ref(false);
const tooltip = ref(null);

const rows = computed(() => {
  const byPerson = new Map();
  for (const t of props.tasks) {
    const name = t.assignedTo || 'Unassigned';
    if (!byPerson.has(name)) {
      byPerson.set(name, Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])));
    }
    byPerson.get(name)[t.status] = (byPerson.get(name)[t.status] || 0) + 1;
  }

  const people = [...byPerson.entries()].map(([name, counts]) => ({
    name,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  }));
  people.sort((a, b) => b.total - a.total);

  const max = Math.max(1, ...people.map((p) => p.total));
  return people.map((p) => ({
    ...p,
    segments: STATUS_ORDER.filter((s) => p.counts[s] > 0).map((s) => ({
      status: s,
      count: p.counts[s],
      widthPct: (p.counts[s] / max) * 100,
      color: statusColor(s),
    })),
  }));
});

function showTooltip(evt, personName, segment) {
  tooltip.value = {
    x: evt.clientX + 12,
    y: evt.clientY + 12,
    label: `${personName} · ${segment.status}`,
    value: `${segment.count} task${segment.count === 1 ? '' : 's'}`,
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
        <h2>Workload by teammate</h2>
        <p class="subtitle">Task count per person, colored by status.</p>
      </div>
      <button class="table-toggle" @click="showTable = !showTable">
        {{ showTable ? 'Chart' : 'Table' }}
      </button>
    </div>

    <template v-if="!showTable">
      <div class="bar-chart-rows">
        <div v-for="row in rows" :key="row.name" class="bar-row">
          <span class="row-label">{{ row.name }}</span>
          <div class="bar-track">
            <div
              v-for="seg in row.segments"
              :key="seg.status"
              class="bar-segment"
              tabindex="0"
              :style="{ width: seg.widthPct + '%', background: seg.color }"
              @pointermove="showTooltip($event, row.name, seg)"
              @pointerleave="hideTooltip"
              @focus="showTooltip($event, row.name, seg)"
              @blur="hideTooltip"
            ></div>
          </div>
          <span class="row-value">{{ row.total }}</span>
        </div>
      </div>

      <div class="chart-legend">
        <span v-for="status in STATUS_ORDER" :key="status" class="legend-item">
          <span class="legend-swatch" :style="{ background: statusColor(status) }"></span>{{ status }}
        </span>
      </div>
    </template>

    <table v-else class="chart-table">
      <thead>
        <tr>
          <th>Teammate</th>
          <th v-for="status in STATUS_ORDER" :key="status">{{ status }}</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.name">
          <td>{{ row.name }}</td>
          <td v-for="status in STATUS_ORDER" :key="status">{{ row.counts[status] || 0 }}</td>
          <td>{{ row.total }}</td>
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
