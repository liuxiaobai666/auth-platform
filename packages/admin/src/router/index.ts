import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/components/AppLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { title: '总览', icon: 'DataLine', group: '概览' } },
      { path: 'applications', name: 'applications', component: () => import('@/views/ApplicationsView.vue'), meta: { title: '应用管理', icon: 'Menu', perm: 'application:read', group: '配置' } },
      { path: 'plans', name: 'plans', component: () => import('@/views/PlansView.vue'), meta: { title: '套餐管理', icon: 'Discount', perm: 'plan:read', group: '业务' } },
      { path: 'licenses', name: 'licenses', component: () => import('@/views/LicensesView.vue'), meta: { title: '卡密管理', icon: 'Ticket', perm: 'license:read', group: '业务' } },
      { path: 'licenses/:id', name: 'license-detail', component: () => import('@/views/LicenseDetailView.vue'), meta: { title: '卡密详情', hidden: true, perm: 'license:read' } },
      { path: 'batches', name: 'batches', component: () => import('@/views/BatchesView.vue'), meta: { title: '批次管理', icon: 'Files', perm: 'license:read', group: '业务' } },
      { path: 'releases', name: 'releases', component: () => import('@/views/ReleasesView.vue'), meta: { title: '版本发布', icon: 'UploadFilled', perm: 'release:read', group: '配置' } },
      { path: 'integration', name: 'integration', component: () => import('@/views/IntegrationView.vue'), meta: { title: '接入文档', icon: 'Reading', perm: 'application:read', group: '配置' } },
      { path: 'webhooks', name: 'webhooks', component: () => import('@/views/WebhooksView.vue'), meta: { title: 'Webhook', icon: 'Share', perm: 'application:read', group: '配置' } },
      { path: 'logs', name: 'logs', component: () => import('@/views/LogsView.vue'), meta: { title: '日志审计', icon: 'Tickets', perm: 'audit:read', group: '概览' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.public) return true;
  if (!auth.isLoggedIn) return { name: 'login', query: { redirect: to.fullPath } };
  // 没有权限的页面直接回总览，避免进去之后满屏 403
  if (to.meta.perm && !auth.can(to.meta.perm as string)) {
    return { name: 'dashboard' };
  }
  return true;
});

export default router;
