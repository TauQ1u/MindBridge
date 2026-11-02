import {
  mergeLabelsIntoFrames,
  parseCalciumCsv,
  parseDynamicEdgeCsv,
  parseLabelTimelineCsv,
  parsePositionCsv,
  type EdgeFrames,
  type NeuronFrame,
  type NeuronPosition,
} from '@neuron3d/neuron/neuronUtils'
import { apiBase, apiFetch, apiUrl } from '@/services/api/http'
import { fetchStaticJson, fetchStaticText, isStaticDemoMode } from '@/services/api/staticDemo'

export interface VisualizationDataset {
  conditionId: string
  frames: NeuronFrame[]
  edgeFrames: EdgeFrames
  positions: Map<string, NeuronPosition>
  metadata: Record<string, unknown> | null
}

/** 后端可视化数据包描述：文件位置由后端 manifest 映射，前端不感知服务器目录 */
export interface VisualizationBundle {
  experimentId: string
  conditionId: string
  version: string
  labelVersion: string
  executionMode: string
  metadata: Record<string, unknown> | null
  files: Record<string, string>
}

export interface VisualizationDataSource {
  getBundle(conditionId: string): Promise<VisualizationBundle>
  loadCondition(conditionId: string, signal?: AbortSignal): Promise<VisualizationDataset>
}

async function readText(url: string, signal?: AbortSignal) {
  const response = await apiFetch(apiUrl(url), { signal })
  if (!response.ok) throw new Error(`数据请求失败 (${response.status}): ${url}`)
  const text = await response.text()
  if (text.trimStart().startsWith('<!doctype html')) throw new Error(`数据文件不存在: ${url}`)
  return text
}

async function readJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url)
  if (!response.ok) throw new Error(`可视化数据包请求失败 (${response.status}): ${url}`)
  return response.json() as Promise<T>
}

/** Artifact API 传输层：先取可视化数据包描述，再按 artifact 接口拉取具体文件。 */
export const staticVisualizationDataSource: VisualizationDataSource = {
  async getBundle(conditionId) {
    if (!/^[a-z0-9_-]+$/i.test(conditionId)) throw new Error('conditionId 格式无效')
    if (isStaticDemoMode) {
      const metadata = await fetchStaticJson<Record<string, unknown>>(`visualization_input/${conditionId}/metadata.json`)
      return { experimentId: `MOUSE1-${conditionId}`, conditionId, version: 'demo-v1', labelVersion: 'labels-demo-v1', executionMode: 'static-demo', metadata, files: {} }
    }
    return readJson<VisualizationBundle>(`${apiBase}/experiments/${encodeURIComponent(conditionId)}/visualization-bundle`)
  },

  async loadCondition(conditionId, signal) {
    if (!/^[a-z0-9_-]+$/i.test(conditionId)) throw new Error('conditionId 格式无效')
    if (isStaticDemoMode) {
      const [calcium, labels, edges, positions, metadata] = await Promise.all([
        fetchStaticText(`visualization_input/${conditionId}/calcium.csv`),
        fetchStaticText(`visualization_input/${conditionId}/final_label_timeline.csv`),
        fetchStaticText(`visualization_input/${conditionId}/dynamic_edges.csv`),
        fetchStaticText('visualization_input/neuron_positions.csv'),
        fetchStaticJson<Record<string, unknown>>(`visualization_input/${conditionId}/metadata.json`),
      ])
      const frames = parseCalciumCsv(calcium)
      mergeLabelsIntoFrames(frames, parseLabelTimelineCsv(labels))
      return { conditionId, frames, edgeFrames: parseDynamicEdgeCsv(edges), positions: parsePositionCsv(positions), metadata }
    }
    /* 第一步：向后端确认结果版本与数据包可用性（切换 Provider 时本接口不变） */
    const bundle = await staticVisualizationDataSource.getBundle(conditionId)
    /* 第二步：按 artifact 接口拉取各文件，CSV 解析逻辑保持不变 */
    const [calcium, labels, edges, positions] = await Promise.all([
      readText(`/api/artifacts/${conditionId}.visualization.calcium`, signal),
      readText(`/api/artifacts/${conditionId}.visualization.final_label_timeline`, signal),
      readText(`/api/artifacts/${conditionId}.visualization.dynamic_edges`, signal),
      readText('/api/artifacts/shared.neuron_positions', signal),
    ])
    const frames = parseCalciumCsv(calcium)
    mergeLabelsIntoFrames(frames, parseLabelTimelineCsv(labels))
    return {
      conditionId,
      frames,
      edgeFrames: parseDynamicEdgeCsv(edges),
      positions: parsePositionCsv(positions),
      metadata: bundle.metadata,
    }
  },
}

export const visualizationApi: VisualizationDataSource = staticVisualizationDataSource
