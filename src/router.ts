import { createRouter, createWebHashHistory } from 'vue-router';
import { isAuthenticated } from './store/session';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
    { path: '/verify', name: 'verify', component: () => import('./views/VerifyView.vue') },
    { path: '/', name: 'launcher', component: () => import('./views/LauncherView.vue'), meta: { requiresAuth: true } },
    {
      path: '/photobank/:folderId?',
      name: 'photobank',
      component: () => import('./modules/photobank/PhotobankView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/requests/:requestId?',
      name: 'requests',
      component: () => import('./modules/requests/RequestsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
      meta: { requiresAuth: true },
    },
  ],
});

router.beforeEach((to) => {
  if (to.meta.requiresAuth && !isAuthenticated()) {
    return { name: 'login' };
  }
  return true;
});

export default router;
