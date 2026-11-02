import Papa from 'papaparse'
import type { Experiment, TimelineFrame, Neuron } from '@/types/models'
import { visualizationApi } from '@/services/api/visualizationApi'
import { apiFetch } from '@/services/api/http'
import { fetchStaticJson, fetchStaticText, isStaticDemoMode, readDemoState, writeDemoState } from '@/services/api/staticDemo'

export interface BehaviorStats {
  condition_id: string
  duration_seconds: number
  behavior_fraction: Record<string, number>
  sleep_stage_fraction: Record<string, number>
  review_status: string
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url)
  if (!response.ok) throw new Error(`API 请求失败 (${response.status}): ${url}`)
  return response.json() as Promise<T>
}

function conditionPath(conditionId: string) {
  if (!/^[a-z0-9_-]+$/i.test(conditionId)) throw new Error('conditionId 格式无效')
  return conditionId
}

export const experimentApi = {
  async list(): Promise<Experiment[]> {
    if (isStaticDemoMode) {
      const definitions = [
        { condition: 'healthy', displayName: '健康' },
        { condition: 'cort_like', displayName: '抑郁' },
        { condition: 'ketamine_like_recovery', displayName: '给药后恢复' },
      ]
      const imported = new Set<string>(readDemoState('imported', []))
      return definitions.map(({ condition, displayName }) => ({
        experimentId: `MOUSE1-${condition}`,
        mouseId: 'mouse1',
        condition,
        displayName,
        collectedAt: '2026-09-21T10:00:00+08:00',
        completeness: 100,
        video: true,
        calcium: true,
        eegEmg: true,
        stage: 'visualization',
        packages: { rawInput: true, review: true, visualization: true, moduleEvidence: true },
        discovered: true,
        imported: imported.has(condition),
        dataNature: 'synthetic_demo',
        reviewStatus: readDemoState<Record<string, boolean>>('finalized', {})[condition] ? 'finalized' : 'pending',
        analysisReady: Boolean(readDemoState<Record<string, boolean>>('finalized', {})[condition]),
      }))
    }
    return fetchJson<Experiment[]>('/api/experiments')
  },

  /** 复核定稿状态（finalized / analysisReady），用于实验列表决定按钮状态 */
  async reviewStatus(conditionId: string): Promise<{ conditionId: string; finalized: boolean; analysisReady: boolean; finalizedAt?: string }> {
    if (isStaticDemoMode) {
      const finalized = Boolean(readDemoState<Record<string, boolean>>('finalized', {})[conditionId])
      return { conditionId, finalized, analysisReady: finalized }
    }
    return fetchJson(`/api/experiments/${conditionPath(conditionId)}/review-status`)
  },

  /** 一致性复核定稿：登记 finalized / analysisReady，后端校验无遗留冲突 */
  async finalizeReview(conditionId: string): Promise<{ finalized: boolean; analysisReady: boolean }> {
    if (isStaticDemoMode) {
      const finalized = readDemoState<Record<string, boolean>>('finalized', {})
      finalized[conditionId] = true
      writeDemoState('finalized', finalized)
      return { finalized: true, analysisReady: true }
    }
    const response = await apiFetch(`/api/experiments/${conditionPath(conditionId)}/review/finalize`, { method: 'POST' })
    if (!response.ok) throw new Error(`复核定稿失败 (${response.status})`)
    return response.json() as Promise<{ finalized: boolean; analysisReady: boolean }>
  },

  async timeline(conditionId: string): Promise<TimelineFrame[]> {
    let timelineText: string
    if (isStaticDemoMode) timelineText = await fetchStaticText(`review/${conditionPath(conditionId)}/timeline.csv`)
    else {
      const response = await apiFetch(`/api/artifacts/${conditionPath(conditionId)}.review.timeline`)
      if (!response.ok) throw new Error(`API 请求失败 (${response.status})`)
      timelineText = await response.text()
    }
    const result = Papa.parse<Record<string, unknown>>(timelineText, { header: true, dynamicTyping: true, skipEmptyLines: 'greedy' })
    if (result.errors.length) throw new Error(`CSV 解析失败: ${result.errors[0].message}`)
    const rows = result.data
    return rows.map((row, index) => ({
      frameId: Number(row.frame_id ?? index),
      timestamp: Number(row.timestamp_s ?? 0),
      videoLabel: String(row.video_behavior ?? ''),
      videoConf: Number(row.video_behavior_conf ?? 0),
      neuralLabel: String(row.neural_behavior ?? row.neural_sleep_stage ?? ''),
      neuralConf: Number(row.neural_behavior_conf ?? row.neural_sleep_conf ?? 0),
      sleepStage: String(row.final_sleep_stage ?? row.eeg_sleep_stage ?? ''),
      disagreement: Number(row.disagreement ?? 0) === 1,
      reviewed: Number(row.reviewed ?? 0) === 1,
      finalLabel: String(row.final_behavior ?? row.final_sleep_stage ?? ''),
    }))
  },

  async visualization(conditionId: string): Promise<{ neurons: Neuron[]; edgeCounts: number[]; metadata: Record<string, unknown> | null }> {
    const dataset = await visualizationApi.loadCondition(conditionPath(conditionId))
    const firstFrame = dataset.frames[0]
    const neurons = Array.from(dataset.positions.keys()).map((id) => ({
      id,
      activity: firstFrame?.values[id] ?? 0,
      activityTrace: dataset.frames.map((frame) => frame.values[id]).filter((value): value is number => typeof value === 'number'),
    }))
    const edgeCounts = dataset.frames.map((_, index) => (dataset.edgeFrames[index] ?? []).length)
    return { neurons, edgeCounts, metadata: dataset.metadata }
  },

  behaviorStats(conditionId: string): Promise<BehaviorStats> {
    if (isStaticDemoMode) return fetchStaticJson(`visualization_input/${conditionPath(conditionId)}/behavior_stats.json`)
    return fetchJson(`/api/artifacts/${conditionPath(conditionId)}.visualization.behavior_stats`)
  },
}
