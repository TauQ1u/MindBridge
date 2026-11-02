import { apiBase, apiFetch } from '@/services/api/http'
import { isStaticDemoMode, readDemoState, writeDemoState } from '@/services/api/staticDemo'

export interface SaveReviewInput {
  experimentId: string
  frameId: number
  finalLabel: string
  /** 人工修正原因；reviewer / updatedAt / resultVersion 由后端记录 */
  reason?: string
}

export interface SavedReview extends SaveReviewInput {
  reviewer: string
  resultVersion: string
  updatedAt: string
}

export interface ReviewApi {
  save(input: SaveReviewInput): Promise<{ saved: true; transport: 'backend' }>
  list(experimentId: string): Promise<SavedReview[]>
}

export const reviewApi: ReviewApi = {
  async save(input) {
    if (isStaticDemoMode) {
      const reviews = readDemoState<SavedReview[]>('reviews', [])
      const record: SavedReview = {
        ...input,
        reviewer: 'admin',
        resultVersion: 'demo-v1',
        updatedAt: new Date().toISOString(),
      }
      writeDemoState('reviews', [...reviews.filter(item => item.frameId !== input.frameId || item.experimentId !== input.experimentId), record])
      return { saved: true, transport: 'backend' }
    }
    const response = await apiFetch(`${apiBase}/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`复核保存失败 (${response.status})`)
    return response.json() as Promise<{ saved: true; transport: 'backend' }>
  },
  async list(experimentId) {
    if (isStaticDemoMode) return readDemoState<SavedReview[]>('reviews', []).filter(item => item.experimentId === experimentId)
    const response = await apiFetch(`${apiBase}/reviews?experimentId=${encodeURIComponent(experimentId)}`)
    if (!response.ok) throw new Error(`复核记录读取失败 (${response.status})`)
    return response.json() as Promise<SavedReview[]>
  },
}
