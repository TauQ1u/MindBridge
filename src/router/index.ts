import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomePage.vue') },
    { path: '/mpfc', name: 'mpfc', component: () => import('@/views/MPFCWorkspace.vue'), meta: { requiresAuth: true } },
    { path: '/mpfc/condition/:conditionId', name: 'condition-panel', component: () => import('@/views/ConditionPanelView.vue'), meta: { requiresAuth: true } },
    { path: '/processing', name: 'processing', component: () => import('@/views/ProcessingWorkspace.vue'), meta: { requiresAuth: true } },
    { path: '/review', name: 'review', component: () => import('@/views/ReviewWorkspace.vue'), meta: { requiresAuth: true } },
    { path: '/analysis', name: 'analysis', component: () => import('@/views/MultiConditionAnalysisCenter.vue'), meta: { requiresAuth: true } },
  ],
})

// 工作区页面需登录：未认证则回到首页并弹出登录框
router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true
  const auth = useAuthStore()
  await auth.ensureSession()
  if (auth.isAuthenticated) return true
  return { name: 'home', query: { login: '1', redirect: to.fullPath } }
})
