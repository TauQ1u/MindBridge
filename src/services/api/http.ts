export const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api').replace(/\/$/, '')

export function apiUrl(path: string): string {
  if (!import.meta.env.VITE_API_BASE_URL && path.startsWith('/api/artifacts/')) {
    return staticArtifactUrl(path.slice('/api/artifacts/'.length))
  }
  if (!path.startsWith('/api/')) return path
  return `${apiBase}${path.slice(4)}`
}

import { staticArtifactUrl } from '@/services/api/staticDemo'

export const UNAUTHORIZED_EVENT = 'mindbridge:unauthorized'

/**
 * 统一 API 请求封装：
 * - 写操作附带防伪标头（配合服务端 SameSite Cookie 抵御 CSRF）
 * - 401 时广播事件，由 App 层清理会话并回到登录
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Requested-With', 'fetch')
  const response = await fetch(apiUrl(input), { ...init, headers, credentials: 'include' })
  if (response.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
  return response
}
