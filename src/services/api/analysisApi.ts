import type { AnalysisBundle } from '@/types/models'
import { apiBase, apiFetch } from '@/services/api/http'

/*
 * 科研分析 API：一次性取回后端预计算分析包。
 * 页面只负责选择 Condition、请求分析包、渲染后端结果，
 * 不做 Module 均值 / 网络矩阵 / 状态空间 / 转换统计等浏览器端计算。
 */

export interface AnalysisApi {
  getAnalysisBundle(conditionIds: string[]): Promise<AnalysisBundle>
}

export const analysisApi: AnalysisApi = {
  async getAnalysisBundle(conditionIds) {
    if (!conditionIds.length) throw new Error('至少需要一个 Condition')
    const query = encodeURIComponent(conditionIds.join(','))
    const response = await apiFetch(`${apiBase}/analysis?conditions=${query}`)
    if (!response.ok) {
      let message = `科研分析数据请求失败 (${response.status})`
      try { message = (await response.json()).error ?? message } catch { /* 保留默认信息 */ }
      throw new Error(message)
    }
    return response.json() as Promise<AnalysisBundle>
  },
}
