import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { authApi } from '@/services/api/authApi'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<string | null>(null)
  const expiresAt = ref<string | null>(null)
  /** 首次会话探测是否完成（刷新页面后需先确认 Cookie 会话） */
  const ready = ref(false)

  const isAuthenticated = computed(() => Boolean(user.value))

  async function ensureSession(force = false) {
    if (ready.value && !force) return
    try {
      const session = await authApi.session()
      user.value = session.authenticated ? session.user : null
      expiresAt.value = session.expiresAt
    } catch {
      user.value = null
      expiresAt.value = null
    } finally {
      ready.value = true
    }
  }

  async function login(username: string, password: string) {
    const result = await authApi.login(username, password)
    user.value = result.user
    expiresAt.value = result.expiresAt
    ready.value = true
  }

  async function logout() {
    try { await authApi.logout() } catch { /* 网络异常时本地照常清理 */ }
    clearLocal()
  }

  function clearLocal() {
    user.value = null
    expiresAt.value = null
  }

  return { user, expiresAt, ready, isAuthenticated, ensureSession, login, logout, clearLocal }
})
