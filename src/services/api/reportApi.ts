import type { ReportTask } from '@/types/models'
import { apiBase, apiFetch } from '@/services/api/http'

export interface CreateReportInput {
  conditionIds: string[]
  evidenceIds?: string[]
  template?: string
}
export interface ReportApi { create(input: CreateReportInput): Promise<ReportTask> }

export const reportApi: ReportApi = {
  async create(input) {
    if (!input.conditionIds.length) throw new Error('至少需要一个已完成复核的 Condition')
    const response = await apiFetch(`${apiBase}/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`报告任务创建失败 (${response.status})`)
    return response.json() as Promise<ReportTask>
  },
}
