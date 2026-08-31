<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [Number, String], required: true },
  color: { type: String, default: null },
});
</script>

<template>
  <div class="stat-tile">
    <p class="label">
      <span v-if="color" class="swatch" :style="{ background: color }"></span>{{ label }}
    </p>
    <p class="value">{{ value }}</p>
  </div>
</template>
