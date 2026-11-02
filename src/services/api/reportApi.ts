import type { ReportTask } from '@/types/models'
import { apiBase, apiFetch } from '@/services/api/http'
import { fetchStaticText, isStaticDemoMode } from '@/services/api/staticDemo'

export interface CreateReportInput {
  conditionIds: string[]
  evidenceIds?: string[]
  template?: string
}
export interface ReportApi { create(input: CreateReportInput): Promise<ReportTask> }

export const reportApi: ReportApi = {
  async create(input) {
    if (!input.conditionIds.length) throw new Error('至少需要一个已完成复核的 Condition')
    if (isStaticDemoMode) {
      const key = input.conditionIds.length >= 3 ? 'compare_3' : input.conditionIds.length === 2 ? 'compare_2' : input.conditionIds[0]
      const source = await fetchStaticText(`reports/${key}.md`)
      const evidence = (input.evidenceIds || []).map(id => `- ${id}`).join('\n')
      const report = `${source}\n\n## 本次演示选择的图表证据\n\n${evidence || '未单独选择图表。'}\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n`
      const url = URL.createObjectURL(new Blob([report], { type: 'text/markdown;charset=utf-8' }))
      return { id: `demo-${key}`, status: 'ready', url }
    }
    const response = await apiFetch(`${apiBase}/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`报告任务创建失败 (${response.status})`)
    return response.json() as Promise<ReportTask>
  },
}
