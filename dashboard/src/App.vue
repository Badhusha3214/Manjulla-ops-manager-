<script setup>
import { onMounted, onUnmounted } from 'vue';
import { loading, error, lastUpdated, startPolling, stopPolling } from './composables/useTasks';

onMounted(startPolling);
onUnmounted(stopPolling);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <h1>DevMorphix Ops</h1>
      <p class="meta">
        <span v-if="loading">Loading…</span>
        <span v-else-if="error" class="error">Error: {{ error }}</span>
        <span v-else-if="lastUpdated">Last updated {{ lastUpdated.toLocaleTimeString() }} · refreshes every 30s</span>
      </p>
      <nav class="nav">
        <router-link to="/">Overview</router-link>
        <router-link to="/team">Team</router-link>
        <router-link to="/tasks">Tasks</router-link>
      </nav>
    </header>

    <router-view />
  </div>
</template>
