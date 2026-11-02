export type AsyncState = 'idle' | 'loading' | 'success' | 'empty' | 'error'

export type PackageStage = 'raw_input' | 'review' | 'visualization'

export interface PackageAvailability {
  rawInput: boolean
  review: boolean
  visualization: boolean
  /** 行为解码贡献 Module 证据包（model_output）是否可用 */
  moduleEvidence?: boolean
}

export interface Experiment {
  experimentId: string
  mouseId: string
  condition: string
  displayName: string
  collectedAt: string
  completeness: number
  video: boolean
  calcium: boolean
  eegEmg: boolean
  stage: PackageStage
  packages: PackageAvailability
  discovered: boolean
  imported: boolean
  dataNature?: string
  /** 最近一次处理任务（后端提供时据此决定“开始处理 / 查看结果”） */
  latestRun?: { runId: string; status: RunStatus; resultVersion?: string }
  /** 复核完成状态（后端 review-status 接口补充） */
  reviewStatus?: string
  analysisReady?: boolean
}

/* ---- 统一处理任务：前端只面向后端任务状态，不关心结果来自实时模型 / Worker / 预计算文件 ---- */

export type RunStatus = 'queued' | 'running' | 'ready' | 'failed'

export interface ProcessingStage {
  id: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  detail?: string
}

export interface ProcessingRun {
  runId: string
  experimentId: string
  status: RunStatus
  progress: number
  /** 后端当前推进到的阶段（单阶段语义；整体阶段列表由前端按固定管线渲染） */
  stage: { id: string; label: string; index: number; total: number } | null
  stages: ProcessingStage[]
  resultVersion?: string
  nextAction?: string | null
}

export interface TimelineFrame {
  frameId: number
  timestamp: number
  videoLabel: string
  videoConf: number
  neuralLabel: string
  neuralConf: number
  sleepStage: string
  disagreement: boolean
  reviewed: boolean
  finalLabel: string
}

export interface Neuron {
  id: string
  activity: number
  activityTrace?: number[]
  importance?: number
  effectSize?: number
  qValue?: number
  ablationDelta?: number
}

/*
 * ---- 行为解码贡献 Module ----
 * 根据神经行为解码模型的预计算贡献结果，将对某类行为预测具有稳定支持作用
 * 的神经元组织为一个行为相关模块。模块成员离线固定，实时只更新贡献分数。
 */

export interface DecoderModule {
  id: string
  name: string
  kind: 'behavior' | 'sleep'
  targetLabel: string
  memberCount: number
  memberNeuronIds: string[]
  color: string
}

export interface ModuleTopNeuron {
  neuronId: string
  contribution: number
}

export interface ModuleFrameEvidence {
  frameId: number
  timestamp: number
  targetLabel: string
  predictedLabel: string
  confidence: number | null
  moduleId: string | null
  moduleScore: number | null
  topNeurons: ModuleTopNeuron[]
}

export interface NeuronModuleProfile {
  neuronId: string
  primaryModuleId: string | null
  primaryTargetLabel: string | null
  membershipScore: number | null
}

export interface DecoderModuleModel {
  name: string
  version: string
}

export interface ModuleEvidenceResult {
  model: DecoderModuleModel
  method: string
  modules: DecoderModule[]
  neuronProfiles: NeuronModuleProfile[]
  frames: ModuleFrameEvidence[]
}

export type ModuleJobStatus = 'queued' | 'running' | 'ready'

export interface ModuleJobState {
  jobId: string
  status: ModuleJobStatus
  progress: number
  conditionId: string
  model?: DecoderModuleModel
  result?: ModuleEvidenceResult
}

/* ---- 预计算科研分析包：GET /api/analysis 返回，页面只渲染不做计算 ---- */

export interface ScientificFinding {
  id: string
  type: string
  title: string
  summary: string
  confidence?: number
  evidenceRefs: string[]
}

export interface AnalysisConditionMetrics {
  conditionId: string
  displayName: string
  durationSeconds: number
  frames: number
  samplingRateHz: number
  neuronCount: number
  edgeMethod: string
  sleepStageFraction: Record<string, number>
  behaviorFraction: Record<string, number>
  reviewStatus: string
  conflicts: {
    total: number
    byType: Record<string, number>
    plan: Array<{ frame_id: number; who: string; kind: string }>
  }
  framesByStage: Record<string, number>
}

export interface AnalysisConditionDelta {
  vsBaseline: string
  sleepStageFractionDelta: Record<string, number>
  behaviorFractionDelta: Record<string, number>
  neuronCountDelta: number
  conflictCountDelta: number
}

export interface AnalysisBundle {
  analysisId: string
  resultVersion?: string
  kind: string
  conditions: string[]
  generatedAt: string
  executionMode: string
  overview?: unknown
  behavior?: unknown
  modules?: unknown
  networks?: unknown
  stateSpace?: unknown
  transitions?: unknown
  findings?: ScientificFinding[]
  metrics: Record<string, AnalysisConditionMetrics>
  comparison?: {
    baseline: string
    deltas: Record<string, AnalysisConditionDelta>
  }
  evidenceIndex?: Record<string, unknown>
}

export type ModuleHighlightMode = 'none' | 'module' | 'top3'

export interface ReportTask {
  id: string
  status: 'idle' | 'generating' | 'ready' | 'failed'
  url?: string
}
