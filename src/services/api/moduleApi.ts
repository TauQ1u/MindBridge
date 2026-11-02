import type { ModuleEvidenceResult, ModuleJobState } from '@/types/models'
import { apiFetch } from '@/services/api/http'
import Papa from 'papaparse'
import { fetchStaticJson, fetchStaticText, isStaticDemoMode } from '@/services/api/staticDemo'

/*
 * 行为解码贡献 Module API。
 * 异步任务语义：创建任务 → 轮询状态 → ready 后一次性取得整段预计算结果。
 * 时间轴播放期间不再请求后端，只在前端按帧查找。
 */

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `Module 任务创建失败 (${response.status})`
    try { message = (await response.json()).error ?? message } catch { /* 保留默认信息 */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

async function getJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url)
  if (!response.ok) {
    let message = `Module 任务查询失败 (${response.status})`
    try { message = (await response.json()).error ?? message } catch { /* 保留默认信息 */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 20000

export const moduleApi = {
  /** 启动 Module 数据加载任务，返回 jobId */
  createJob(conditionId: string, experimentId?: string): Promise<ModuleJobState> {
    if (!/^[a-z0-9_-]+$/i.test(conditionId)) return Promise.reject(new Error('conditionId 格式无效'))
    return postJson<ModuleJobState>('/api/ai/module-jobs', { conditionId, experimentId })
  },

  getJob(jobId: string): Promise<ModuleJobState> {
    return getJson<ModuleJobState>(`/api/ai/module-jobs/${encodeURIComponent(jobId)}`)
  },

  /** 创建任务并轮询到 ready，一次性返回整段预计算结果 */
  async loadEvidence(conditionId: string, experimentId?: string): Promise<ModuleEvidenceResult> {
    if (isStaticDemoMode) {
      const [modules, framesDoc, profileText] = await Promise.all([
        fetchStaticJson<{ modelName?: string; modelVersion?: string; method?: string; modules: Array<Record<string, unknown>> }>(`model_output/${conditionId}/decoder_modules.json`),
        fetchStaticJson<{ frames: ModuleEvidenceResult['frames'] }>(`model_output/${conditionId}/module_frame_evidence.json`),
        fetchStaticText(`model_output/${conditionId}/neuron_module_profiles.csv`),
      ])
      const profiles = Papa.parse<Record<string, string>>(profileText, { header: true, skipEmptyLines: true }).data.map(row => ({
        neuronId: row.neuron_id,
        primaryModuleId: row.primary_module_id || null,
        primaryTargetLabel: row.target_label || null,
        membershipScore: row.membership_score ? Number(row.membership_score) : null,
      }))
      return {
        model: { name: modules.modelName || 'MouseNeuralBehaviorDecoder', version: modules.modelVersion || 'demo-1.0' },
        method: modules.method || 'precomputed_attribution',
        modules: modules.modules.map(module => ({
          id: String(module.id), name: String(module.name), kind: module.kind as 'behavior' | 'sleep',
          targetLabel: String(module.targetLabel), memberCount: Array.isArray(module.memberNeuronIds) ? module.memberNeuronIds.length : 0,
          memberNeuronIds: (module.memberNeuronIds as string[]) || [], color: String(module.color || '#8b5cf6'),
        })),
        neuronProfiles: profiles,
        frames: framesDoc.frames,
      }
    }
    const job = await moduleApi.createJob(conditionId, experimentId)
    const startedAt = Date.now()
    for (;;) {
      const state = await moduleApi.getJob(job.jobId)
      if (state.status === 'ready' && state.result) return state.result
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new Error('Module 数据加载超时，请重试')
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  },
}
