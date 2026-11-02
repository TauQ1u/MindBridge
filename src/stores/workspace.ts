import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { experimentApi } from '@/services/api/experimentApi'
import { moduleApi } from '@/services/api/moduleApi'
import { toConditionViewModel, type ConditionViewModel } from '@/services/data/conditionAdapter'
import type { Experiment, ProcessingRun, TimelineFrame, Neuron, ReportTask, DecoderModule, ModuleFrameEvidence, NeuronModuleProfile, ModuleHighlightMode } from '@/types/models'
import { reportApi } from '@/services/api/reportApi'
import { reviewApi } from '@/services/api/reviewApi'
import { processingApi } from '@/services/api/processingApi'

const IMPORT_KEY = 'mindbridge.importedConditions'
const ACTIVE_KEY = 'mindbridge.activeCondition'

function loadImportedConditions(): Set<string> {
  try {
    const raw = sessionStorage.getItem(IMPORT_KEY)
    return raw ? new Set(JSON.parse(raw) as string) : new Set()
  } catch {
    return new Set()
  }
}

function persistImportedConditions(conditions: Set<string>) {
  try { sessionStorage.setItem(IMPORT_KEY, JSON.stringify([...conditions])) } catch { /* ignore quota / privacy errors */ }
}

export type ModuleCardStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed'

export const useWorkspaceStore = defineStore('workspace', () => {
  const experiments = ref<Experiment[]>([])
  const importedConditions = loadImportedConditions()
  const processingRun = ref<ProcessingRun | null>(null)
  const processingError = ref('')
  let pollTimer: number | null = null
  let pollToken = 0
  const timeline = ref<TimelineFrame[]>([])
  const neurons = ref<Neuron[]>([])
  const edgeCounts = ref<number[]>([])
  const selectedExperiment = ref<Experiment | null>(null)
  const selectedNeuron = ref<Neuron | null>(null)
  const currentTimestamp = ref(0)
  const activeStep = ref<'workspace' | 'processing' | 'review'>('workspace')
  const report = ref<ReportTask>({ id: '', status: 'idle' })
  const hasImportedData = ref(false)
  const playing = ref(false)
  const playbackSpeed = ref(1)
  const activeDrawer = ref<'neuron' | 'compare' | 'report' | null>(null)
  const visualizationMetadata = ref<Record<string, unknown> | null>(null)

  /* ---- 行为解码贡献 Module：一次性加载整段预计算结果，播放时只查当前帧 ---- */
  const moduleJobStatus = ref<ModuleCardStatus>('idle')
  const decoderModules = ref<DecoderModule[]>([])
  const moduleFrameEvidence = ref<ModuleFrameEvidence[]>([])
  const neuronModuleProfiles = ref<NeuronModuleProfile[]>([])
  const selectedDecoderModuleId = ref<string | null>(null)
  const moduleHighlightMode = ref<ModuleHighlightMode>('none')
  let moduleLoadToken = 0

  const selectedCondition = computed<ConditionViewModel | null>(() => selectedExperiment.value ? toConditionViewModel(selectedExperiment.value) : null)
  const loadedExperiments = computed(() => experiments.value.filter(experiment => experiment.imported))
  const duration = computed(() => timeline.value[timeline.value.length - 1]?.timestamp ?? 0)

  const currentFrame = computed(() => {
    const frames = timeline.value
    if (!frames.length) return undefined
    let lo = 0
    let hi = frames.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid].timestamp < currentTimestamp.value) lo = mid + 1
      else hi = mid
    }
    return frames[lo] ?? frames[frames.length - 1]
  })
  const disagreementCount = computed(() => timeline.value.filter(frame => frame.disagreement && !frame.reviewed).length)
  const currentEdgeCount = computed(() => {
    const frame = currentFrame.value
    const index = frame ? timeline.value.indexOf(frame) : -1
    return index >= 0 ? (edgeCounts.value[index] ?? 0) : 0
  })

  const currentModuleEvidence = computed<ModuleFrameEvidence | null>(() => {
    const frame = currentFrame.value
    if (!frame || !moduleFrameEvidence.value.length) return null
    const evidence = moduleFrameEvidence.value
    let lo = 0
    let hi = evidence.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (evidence[mid].frameId < frame.frameId) lo = mid + 1
      else hi = mid
    }
    return evidence[lo]?.frameId === frame.frameId ? evidence[lo] : null
  })
  const currentDecoderModule = computed<DecoderModule | null>(() => {
    const moduleId = currentModuleEvidence.value?.moduleId ?? selectedDecoderModuleId.value
    if (moduleId) return decoderModules.value.find(module => module.id === moduleId) ?? null
    /* 证据帧缺失 moduleId 时按当前行为/睡眠标签兜底匹配模块，
       保证“当前行为模块”高亮在有对应模块时始终生效 */
    const label = (currentFrame.value?.finalLabel || currentFrame.value?.sleepStage || '').trim().toLowerCase()
    if (!label) return null
    return decoderModules.value.find(module => String(module.targetLabel).toLowerCase() === label) ?? null
  })
  const currentTopContributionNeurons = computed(() => currentModuleEvidence.value?.topNeurons ?? [])
  const currentTopNeuronIds = computed(() => currentTopContributionNeurons.value.map(item => item.neuronId))
  /* 3D 高亮集合：module 模式高亮整个模块成员，top3 模式只高亮当前 Top 神经元 */
  const highlightedNeuronIds = computed<string[]>(() => {
    if (moduleHighlightMode.value === 'module') return currentDecoderModule.value?.memberNeuronIds ?? []
    if (moduleHighlightMode.value === 'top3') return currentTopNeuronIds.value
    return []
  })

  function resetModuleState() {
    moduleLoadToken += 1
    moduleJobStatus.value = 'idle'
    decoderModules.value = []
    moduleFrameEvidence.value = []
    neuronModuleProfiles.value = []
    selectedDecoderModuleId.value = null
    moduleHighlightMode.value = 'none'
  }

  /* 切换 Condition 后启动一次 Module 任务；ready 前不重复发起 */
  async function startModuleJob(conditionId = selectedExperiment.value?.condition) {
    const token = moduleLoadToken
    if (!conditionId) { resetModuleState(); return }
    const experiment = experiments.value.find(item => item.condition === conditionId)
    if (experiment && experiment.packages.moduleEvidence === false) {
      resetModuleState()
      moduleJobStatus.value = 'unavailable'
      return
    }
    if (moduleJobStatus.value === 'loading' || moduleJobStatus.value === 'ready') return
    moduleJobStatus.value = 'loading'
    try {
      const result = await moduleApi.loadEvidence(conditionId, experiment?.experimentId)
      if (token !== moduleLoadToken) return
      decoderModules.value = result.modules
      neuronModuleProfiles.value = result.neuronProfiles
      moduleFrameEvidence.value = result.frames
      moduleJobStatus.value = 'ready'
    } catch {
      if (token !== moduleLoadToken) return
      moduleJobStatus.value = 'failed'
    }
  }

  async function loadExperiments() {
    const discovered = await experimentApi.list()
    /* 合并后端复核定稿状态（finalized / analysisReady），用于列表决定按钮：
       开始处理 / 进入复核 / 科研工作区。个别状态读取失败不阻断列表。 */
    const enriched = await Promise.all(discovered.map(async experiment => {
      try {
        const status = await experimentApi.reviewStatus(experiment.condition)
        return { ...experiment, reviewStatus: status.finalized ? 'finalized' : 'pending', analysisReady: status.analysisReady }
      } catch {
        return experiment
      }
    }))
    experiments.value = enriched.map(experiment => ({ ...experiment, imported: importedConditions.has(experiment.condition) }))
    if (selectedExperiment.value) {
      const refreshed = experiments.value.find(experiment => experiment.condition === selectedExperiment.value?.condition)
      if (refreshed) selectedExperiment.value = refreshed
    } else {
      const activeId = sessionStorage.getItem(ACTIVE_KEY)
      const restored = experiments.value.find(experiment => experiment.imported && experiment.condition === activeId)
        ?? experiments.value.find(experiment => experiment.imported)
      if (restored) {
        selectedExperiment.value = restored
        hasImportedData.value = true
      }
    }
  }
  async function loadWorkspaceData(conditionId = selectedExperiment.value?.condition) {
    if (!conditionId) {
      timeline.value = []; neurons.value = []; edgeCounts.value = []; visualizationMetadata.value = null
      resetModuleState()
      return
    }
    const experiment = experiments.value.find(item => item.condition === conditionId) ?? selectedExperiment.value
    const [frames, visualization, reviews] = await Promise.all([
      experimentApi.timeline(conditionId),
      experimentApi.visualization(conditionId),
      experiment ? reviewApi.list(experiment.experimentId) : Promise.resolve([]),
    ])
    reviews.forEach(review => {
      const frame = frames.find(item => item.frameId === review.frameId)
      if (frame) { frame.finalLabel = review.finalLabel; frame.reviewed = true }
    })
    timeline.value = frames; neurons.value = visualization.neurons; edgeCounts.value = visualization.edgeCounts; visualizationMetadata.value = visualization.metadata
    // Module 证据在人工确认 final_label 后的工作台阶段加载；复核会话中不发起
    if (experiment?.imported) void startModuleJob(conditionId)
    else resetModuleState()
  }
  /* ---- 统一处理任务：创建 → 轮询后端状态；页面只渲染 processingRun，不自行推导进度 ---- */

  function stopProcessingPolling() {
    pollToken += 1
    if (pollTimer !== null) { window.clearTimeout(pollTimer); pollTimer = null }
  }

  async function pollProcessingRun(runId: string, token: number) {
    try {
      const run = await processingApi.getRun(runId)
      if (token !== pollToken) return
      processingRun.value = run
      processingError.value = ''
      if (run.status === 'running' || run.status === 'queued') {
        pollTimer = window.setTimeout(() => { void pollProcessingRun(runId, token) }, 800)
      } else {
        pollTimer = null
      }
    } catch (error) {
      if (token !== pollToken) return
      processingError.value = error instanceof Error ? error.message : '处理任务查询失败'
      pollTimer = window.setTimeout(() => { void pollProcessingRun(runId, token) }, 2000)
    }
  }

  async function createProcessingRun(experimentId = selectedExperiment.value?.experimentId) {
    stopProcessingPolling()
    processingRun.value = null
    processingError.value = ''
    if (!experimentId) return
    const token = pollToken
    try {
      const run = await processingApi.createRun(experimentId)
      if (token !== pollToken) return
      processingRun.value = run
      void pollProcessingRun(run.runId, token)
    } catch (error) {
      if (token !== pollToken) return
      processingError.value = error instanceof Error ? error.message : '处理任务创建失败'
    }
  }

  function selectExperiment(experiment: Experiment) {
    // 选择实验 ≠ 导入完成：只有在一致性复核完成后才计入工作区
    selectedExperiment.value = experiment
    selectedNeuron.value = null
    currentTimestamp.value = 0
    playing.value = false
    activeStep.value = 'processing'
    resetModuleState()
    void createProcessingRun(experiment.experimentId)
  }
  async function switchCondition(experiment: Experiment) {
    selectedExperiment.value = experiment
    selectedNeuron.value = null
    currentTimestamp.value = 0
    playing.value = false
    hasImportedData.value = true
    /*
     * analysisReady（复核已定稿）的实验从数据中心直接进入科研工作区，
     * 与走完复核流程等价：登记为已导入，否则右侧条件轨为空、
     * Module 贡献数据永远不加载（AI 贡献显示失效）。
     */
    if (!experiment.imported) {
      experiment.imported = true
      importedConditions.add(experiment.condition)
      persistImportedConditions(importedConditions)
      experiments.value = experiments.value.map(item => item.condition === experiment.condition ? { ...item, imported: true } : item)
    }
    try { sessionStorage.setItem(ACTIVE_KEY, experiment.condition) } catch { /* ignore */ }
    resetModuleState()
    await loadWorkspaceData(experiment.condition)
  }
  async function openReview() {
    activeStep.value = 'review'
    await loadWorkspaceData()
    // 数据包中的 reviewed 只表示历史/预置结果；每次进入工作台都开启新的人工复核会话。
    timeline.value = timeline.value.map(frame => frame.disagreement
      ? { ...frame, reviewed: false, finalLabel: '' }
      : frame)
  }
  async function completeReview() {
    activeStep.value = 'workspace'
    hasImportedData.value = true
    if (selectedExperiment.value) {
      selectedExperiment.value.imported = true
      importedConditions.add(selectedExperiment.value.condition)
      try { sessionStorage.setItem(ACTIVE_KEY, selectedExperiment.value.condition) } catch { /* ignore */ }
      persistImportedConditions(importedConditions)
      experiments.value = experiments.value.map(item => item.condition === selectedExperiment.value?.condition ? { ...item, imported: true } : item)
      // 后端复核定稿：登记 finalized / analysisReady；失败不阻断本地演示流程
      try { await experimentApi.finalizeReview(selectedExperiment.value.condition) } catch { /* 定稿失败仅影响服务端状态 */ }
      await loadWorkspaceData(selectedExperiment.value.condition)
    }
  }
  async function generateReport() {
    report.value = { id: 'pending', status: 'generating' }
    try {
      report.value = await reportApi.create({ conditionIds: loadedExperiments.value.map(experiment => experiment.condition), evidenceIds: [], template: 'comparison' })
    } catch {
      report.value = { id: 'failed', status: 'failed' }
    }
  }
  function selectNeuron(neuron: Neuron | null) {
    selectedNeuron.value = neuron
    activeDrawer.value = neuron ? 'neuron' : (activeDrawer.value === 'neuron' ? null : activeDrawer.value)
  }
  function setTimestamp(timestamp: number) { currentTimestamp.value = timestamp }

  /*
   * 切换 AI 贡献高亮模式。
   * 若当前帧没有贡献数据（如数据集中 rearing 片段不参与归因），
   * 自动跳到最近的有证据帧，保证选择后立即在 3D 中看到高亮。
   */
  function setModuleHighlightMode(mode: ModuleHighlightMode) {
    moduleHighlightMode.value = mode
    if (mode === 'none' || currentModuleEvidence.value?.moduleId || !moduleFrameEvidence.value.length) return
    const frameId = currentFrame.value?.frameId ?? 0
    let nearest: ModuleFrameEvidence | null = null
    for (const evidence of moduleFrameEvidence.value) {
      if (!evidence.moduleId) continue
      if (!nearest || Math.abs(evidence.frameId - frameId) < Math.abs(nearest.frameId - frameId)) nearest = evidence
    }
    if (nearest) setTimestamp(nearest.timestamp)
  }
  function setPlaying(value: boolean) {
    if (value && (!hasImportedData.value || duration.value <= 0)) return
    if (value && duration.value > 0 && currentTimestamp.value >= duration.value) currentTimestamp.value = 0
    playing.value = value
  }
  function setPlaybackSpeed(value: number) { playbackSpeed.value = value }
  function resetFlow() { activeStep.value = 'workspace'; selectedExperiment.value = null; resetModuleState(); stopProcessingPolling(); processingRun.value = null; processingError.value = '' }

  /* 退出登录 / 重新登录时调用：清空工作区全部状态与本地持久化，
     保证每次登录后界面回到初始（实验条件需重新导入） */
  function resetSessionData() {
    stopProcessingPolling()
    resetModuleState()
    experiments.value = []
    importedConditions.clear()
    processingRun.value = null
    processingError.value = ''
    timeline.value = []
    neurons.value = []
    edgeCounts.value = []
    selectedExperiment.value = null
    selectedNeuron.value = null
    currentTimestamp.value = 0
    activeStep.value = 'workspace'
    report.value = { id: '', status: 'idle' }
    hasImportedData.value = false
    playing.value = false
    playbackSpeed.value = 1
    activeDrawer.value = null
    visualizationMetadata.value = null
    try {
      sessionStorage.removeItem(IMPORT_KEY)
      sessionStorage.removeItem(ACTIVE_KEY)
      // 清理旧版本遗留的持久化导入状态，避免跨演示会话误显示“已就绪”。
      localStorage.removeItem(IMPORT_KEY)
      localStorage.removeItem(ACTIVE_KEY)
    } catch { /* ignore */ }
  }

  return {
    experiments, processingRun, processingError, timeline, neurons, selectedExperiment, selectedCondition, selectedNeuron,
    currentTimestamp, activeStep, report, hasImportedData, playing, playbackSpeed, activeDrawer, visualizationMetadata,
    moduleJobStatus, decoderModules, moduleFrameEvidence, neuronModuleProfiles, selectedDecoderModuleId, moduleHighlightMode,
    loadedExperiments, duration, currentFrame, disagreementCount, currentEdgeCount,
    currentModuleEvidence, currentDecoderModule, currentTopContributionNeurons, currentTopNeuronIds, highlightedNeuronIds,
    loadExperiments, loadWorkspaceData, createProcessingRun, pollProcessingRun, stopProcessingPolling, startModuleJob, selectExperiment, switchCondition, openReview,
    completeReview, generateReport, selectNeuron, setTimestamp, setModuleHighlightMode, setPlaying, setPlaybackSpeed, resetFlow, resetSessionData,
  }
})
