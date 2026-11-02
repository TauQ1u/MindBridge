import type { ProcessingRun, ProcessingStage } from '@/types/models'
import { apiBase, apiFetch } from '@/services/api/http'
import { isStaticDemoMode } from '@/services/api/staticDemo'

/*
 * 统一处理任务 API。
 * 前端不感知结果来自实时模型 / Python Worker / 预计算文件：
 * 只负责 创建任务 → 轮询进度 → ready 后进入复核。
 * 后端按演示时间推进固定阶段，前端把单阶段进度归一化为完整阶段列表渲染。
 */

/** 固定处理管线，与页面展示及后端 RUN_STAGES 保持一致。 */
const RUN_PIPELINE: Array<{ id: string; label: string; detail: string }> = [
  { id: 'video', label: '行为视频识别', detail: '行为状态 · 结果可信度' },
  { id: 'decode', label: '钙神经信号分析', detail: '神经活动特征 · 状态标签' },
  { id: 'review-package', label: '时间轴对齐与复核准备', detail: '统一时间基准 · 待复核片段定位' },
  { id: 'visualization', label: '3D 建模数据生成', detail: '神经活动 · 动态功能连接 · 建模参数' },
]

interface RawRun {
  runId: string
  experimentId: string
  status: ProcessingRun['status']
  progress: number
  stage: { id: string; label: string; index: number; total: number } | null
  resultVersion?: string
  nextAction?: string | null
}

/** 把后端的“当前阶段”语义展开为完整阶段列表 */
function normalizeRun(raw: RawRun): ProcessingRun {
  const stageIndex = raw.status === 'ready' ? RUN_PIPELINE.length : (raw.stage?.index ?? 0)
  const stages: ProcessingStage[] = RUN_PIPELINE.map((stage, index) => {
    const order = index + 1
    if (order < stageIndex || raw.status === 'ready') return { ...stage, status: 'completed', progress: 100 }
    if (order > stageIndex) return { ...stage, status: 'pending', progress: 0 }
    return { ...stage, status: 'running', progress: Math.min(99, raw.progress) }
  })
  return {
    runId: raw.runId,
    experimentId: raw.experimentId,
    status: raw.status,
    progress: raw.progress,
    stage: raw.stage,
    stages,
    resultVersion: raw.resultVersion,
    nextAction: raw.nextAction ?? null,
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `处理任务创建失败 (${response.status})`
    try { message = (await response.json()).error ?? message } catch { /* 保留默认信息 */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

async function getJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url)
  if (!response.ok) {
    let message = `处理任务查询失败 (${response.status})`
    try { message = (await response.json()).error ?? message } catch { /* 保留默认信息 */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export interface ProcessingApi {
  createRun(experimentId: string): Promise<ProcessingRun>
  getRun(runId: string): Promise<ProcessingRun>
}

export const processingApi: ProcessingApi = {
  async createRun(experimentId) {
    if (isStaticDemoMode) return normalizeRun({
      runId: `DEMO-${Date.now()}`,
      experimentId,
      status: 'ready',
      progress: 100,
      stage: null,
      resultVersion: 'demo-v1',
      nextAction: 'review',
    })
    return normalizeRun(await postJson<RawRun>(`${apiBase}/experiments/${encodeURIComponent(experimentId)}/runs`))
  },
  async getRun(runId) {
    if (isStaticDemoMode) return normalizeRun({ runId, experimentId: '', status: 'ready', progress: 100, stage: null, resultVersion: 'demo-v1' })
    return normalizeRun(await getJson<RawRun>(`${apiBase}/runs/${encodeURIComponent(runId)}`))
  },
}
