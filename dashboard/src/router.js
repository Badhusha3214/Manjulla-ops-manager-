import { createRouter, createWebHistory } from 'vue-router';
import OverviewPage from './pages/OverviewPage.vue';
import TeamPage from './pages/TeamPage.vue';
import TasksPage from './pages/TasksPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewPage },
    { path: '/team', name: 'team', component: TeamPage },
    { path: '/tasks', name: 'tasks', component: TasksPage },
  ],
});
