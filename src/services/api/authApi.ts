import { apiBase, apiFetch } from '@/services/api/http'

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
    return response.json() as Promise<{ user: string; expiresAt: string | null }>
  },

  async session(): Promise<AuthSession> {
    const response = await apiFetch(`${apiBase}/auth/session`)
    if (!response.ok) return { authenticated: false, user: null, expiresAt: null }
    return response.json() as Promise<AuthSession>
  },

  async logout(): Promise<void> {
    await apiFetch(`${apiBase}/auth/logout`, { method: 'POST' })
  },
}
