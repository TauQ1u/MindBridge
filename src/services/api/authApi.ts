import { apiBase, apiFetch } from '@/services/api/http'

const DEMO_SESSION_KEY = 'mindbridge.demo.session'
const DEMO_USERNAME = 'admin'
const DEMO_PASSWORD_SHA256 = '0f57e5ad45da4aac9121026c08e2239573152609dda3bc185d2828aba8b4e0a2'

function isStaticDemoMode() {
  return !import.meta.env.VITE_API_BASE_URL
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export interface AuthSession {
  authenticated: boolean
  user: string | null
  expiresAt: string | null
}

export class LoginError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const authApi = {
  async login(username: string, password: string): Promise<{ user: string; expiresAt: string | null }> {
    if (isStaticDemoMode()) {
      if (username !== DEMO_USERNAME || await sha256(password) !== DEMO_PASSWORD_SHA256) {
        throw new LoginError('用户名或密码错误', 401)
      }
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
      sessionStorage.setItem(DEMO_SESSION_KEY, JSON.stringify({ user: DEMO_USERNAME, expiresAt }))
      return { user: DEMO_USERNAME, expiresAt }
    }
    const response = await apiFetch(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) {
      let message = '登录失败，请稍后重试'
      try { message = (await response.json()).error || message } catch { /* 保留默认提示 */ }
      throw new LoginError(message, response.status)
    }
    try {
      return await response.json() as { user: string; expiresAt: string | null }
    } catch {
      throw new LoginError('登录服务未正确响应，请检查后端地址和部署状态', response.status)
    }
  },

  async session(): Promise<AuthSession> {
    if (isStaticDemoMode()) {
      try {
        const session = JSON.parse(sessionStorage.getItem(DEMO_SESSION_KEY) || 'null')
        if (session?.user === DEMO_USERNAME && new Date(session.expiresAt).getTime() > Date.now()) {
          return { authenticated: true, user: DEMO_USERNAME, expiresAt: session.expiresAt }
        }
      } catch { /* ignore invalid local session */ }
      sessionStorage.removeItem(DEMO_SESSION_KEY)
      return { authenticated: false, user: null, expiresAt: null }
    }
    const response = await apiFetch(`${apiBase}/auth/session`)
    if (!response.ok) return { authenticated: false, user: null, expiresAt: null }
    try {
      return await response.json() as AuthSession
    } catch {
      return { authenticated: false, user: null, expiresAt: null }
    }
  },

  async logout(): Promise<void> {
    if (isStaticDemoMode()) {
      sessionStorage.removeItem(DEMO_SESSION_KEY)
      return
    }
    await apiFetch(`${apiBase}/auth/logout`, { method: 'POST' })
  },
}
