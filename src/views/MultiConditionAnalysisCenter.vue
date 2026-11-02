<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAnalysisStore, type AnalysisTab } from '@/stores/analysis'
import { experimentApi } from '@/services/api/experimentApi'
import { analysisApi } from '@/services/api/analysisApi'
import { visualizationApi, type VisualizationDataset } from '@/services/api/visualizationApi'
import { reportApi } from '@/services/api/reportApi'
import { withBehaviorZh, withSleepZh } from '@/utils/behaviorLabels'
import { computeCorrelationMatrix, type CorrelationResult } from '@/utils/panelCompute'
import ConditionSlopeChart, { type SlopeRow } from '@/components/analysis/ConditionSlopeChart.vue'
import CorrelationMatrixTriptych from '@/components/analysis/CorrelationMatrixTriptych.vue'
import type { AnalysisConditionMetrics, Experiment, TimelineFrame } from '@/types/models'

interface Bundle { experiment: Experiment; metrics: AnalysisConditionMetrics | null; dataset: VisualizationDataset; timeline: TimelineFrame[] }

const router = useRouter()
const workspace = useWorkspaceStore()
const analysis = useAnalysisStore()
const loading = ref(true)
const errorMessage = ref('')
const bundles = ref<Bundle[]>([])
const reportState = ref<'idle' | 'generating' | 'ready' | 'failed'>('idle')
const reportUrl = ref('')
const stateColorBy = ref('条件')

/*
 * 页面 = 通用跨条件比较引擎：选择 2–N 个条件，
 * 上层为全部所选条件的趋势总览，详细比较始终落到
 * selectedPair 指定的任意两个条件（Reference / Target / Δ）。
 * 条件名称、颜色、顺序全部来自后端 manifest，不写死三种 Condition。
 */
const tabs: Array<{ id: AnalysisTab; label: string; short: string }> = [
  { id: 'overview', label: '总览', short: '总览' },
  { id: 'behavior-neural', label: '行为与神经', short: '行为' },
  { id: 'network', label: '功能网络', short: '网络' },
  { id: 'advanced', label: '高级分析', short: '高级' },
  { id: 'report', label: '报告', short: '报告' },
]
const palette = ['#53d39b', '#f2a65a', '#a78bfa', '#4fc3e8', '#ef718c']
const candidates = computed(() => workspace.loadedExperiments.length ? workspace.loadedExperiments : workspace.experiments.filter(item => item.packages.visualization))
const selectedBundles = computed(() => bundles.value.filter(bundle => analysis.selectedConditionIds.includes(bundle.experiment.condition)))
const referenceBundle = computed(() => selectedBundles.value.find(bundle => bundle.experiment.condition === analysis.referenceConditionId) || selectedBundles.value[0])
const colorMap = computed(() => new Map(candidates.value.map((item, index) => [item.condition, palette[index % palette.length]])))
const conditionColor = (id: string) => colorMap.value.get(id) || '#4fc3e8'
const neuronCount = computed(() => referenceBundle.value?.dataset.positions.size || 0)
const mouseLabel = computed(() => candidates.value[0]?.mouseId || '小鼠 01')
const fmt = (value: number, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—'
const pct = (value: number) => `${(value * 100).toFixed(1)}%`

/* ---- 当前详细比较 Pair：所有 Δ 的统一计算基准 ---- */
const leftBundle = computed(() => selectedBundles.value.find(bundle => bundle.experiment.condition === analysis.selectedPair.left) || referenceBundle.value)
const rightBundle = computed(() => selectedBundles.value.find(bundle => bundle.experiment.condition === analysis.selectedPair.right) || selectedBundles.value.find(bundle => bundle !== leftBundle.value) || leftBundle.value)
const pairName = computed(() => `${leftBundle.value?.experiment.displayName ?? '—'} → ${rightBundle.value?.experiment.displayName ?? '—'}`)

/* ---- 状态标签体系：行为 + 睡眠分期；清醒行为在前，睡眠阶段在后 ---- */
const SLEEP_ORDER = ['W', 'NREM', 'REM', 'MA']
const SLEEP_KEYS = new Set(['w', 'nrem', 'rem', 'ma'])
function fracOf(bundle: Bundle | undefined, label: string): number {
  if (!bundle?.metrics) return 0
  return bundle.metrics.behaviorFraction[label] ?? bundle.metrics.sleepStageFraction[label] ?? 0
}
const allLabels = computed(() => {
  const behaviorKeys = new Set<string>()
  const sleepKeys = new Set<string>()
  selectedBundles.value.forEach(bundle => {
    Object.keys(bundle.metrics?.behaviorFraction || {}).forEach(label => behaviorKeys.add(label))
    Object.keys(bundle.metrics?.sleepStageFraction || {}).forEach(label => sleepKeys.add(label))
  })
  const hasData = (label: string) => selectedBundles.value.some(bundle => fracOf(bundle, label) > 0)
  const behaviors = [...behaviorKeys]
    .filter(label => !SLEEP_KEYS.has(label.toLowerCase()) && hasData(label))
    .sort((a, b) => Math.max(...selectedBundles.value.map(bundle => fracOf(bundle, b))) - Math.max(...selectedBundles.value.map(bundle => fracOf(bundle, a))))
  const sleeps = SLEEP_ORDER.filter(label => sleepKeys.has(label) && hasData(label))
  return [...behaviors, ...sleeps]
})
const labelText = (label: string) => withBehaviorZh(label) || withSleepZh(label) || label
const pairFracDelta = (label: string) => fracOf(rightBundle.value, label) - fracOf(leftBundle.value, label)

/* ---- 群体活动：逐帧全神经元均值，再按状态取均值（条件 × 状态热图） ---- */
function populationSeries(bundle: Bundle) {
  const ids = [...bundle.dataset.positions.keys()]
  return bundle.dataset.frames.map(frame => {
    const values = ids.map(id => frame.values[id]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
  })
}
function populationMean(bundle: Bundle, behavior?: string) {
  const series = populationSeries(bundle)
  const values = series.filter((_, i) => !behavior || bundle.timeline[i]?.finalLabel === behavior || bundle.timeline[i]?.sleepStage === behavior)
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
}
const popDelta = (label: string) => (rightBundle.value ? populationMean(rightBundle.value, label) : 0) - (leftBundle.value ? populationMean(leftBundle.value, label) : 0)
const heatMax = computed(() => {
  let max = 0
  selectedBundles.value.forEach(bundle => allLabels.value.forEach(label => { max = Math.max(max, populationMean(bundle, label)) }))
  return Math.max(max, 1e-6)
})
const popDeltaMax = computed(() => {
  let max = 0
  allLabels.value.forEach(label => { max = Math.max(max, Math.abs(popDelta(label))) })
  return Math.max(max, 1e-6)
})
/* 清醒 / 睡眠活动比：清醒 = 非睡眠阶段标签，睡眠 = NREM/REM/MA */
function wakeSleepRatio(bundle: Bundle | undefined): { wake: number; sleep: number; ratio: number | null } {
  if (!bundle) return { wake: 0, sleep: 0, ratio: null }
  const wakeLabels = allLabels.value.filter(label => !['nrem', 'rem', 'ma'].includes(label.toLowerCase()))
  const sleepLabels = allLabels.value.filter(label => ['nrem', 'rem', 'ma'].includes(label.toLowerCase()))
  const meanOf = (labels: string[]) => {
    const values = labels.map(label => populationMean(bundle, label)).filter(v => v > 0)
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0
  }
  const wake = meanOf(wakeLabels)
  const sleep = meanOf(sleepLabels)
  return { wake, sleep, ratio: sleep > 1e-6 ? wake / sleep : null }
}

/* ---- 坡度图行：总览取差异最大的 5 项，行为页展示全部状态 ---- */
const slopeConditions = computed(() => selectedBundles.value.map(bundle => ({
  id: bundle.experiment.condition,
  name: bundle.experiment.displayName,
  color: conditionColor(bundle.experiment.condition),
})))
function fractionRow(label: string): SlopeRow {
  return {
    key: label,
    label: labelText(label),
    values: selectedBundles.value.map(bundle => fracOf(bundle, label)),
    delta: pairFracDelta(label),
    unit: 'fraction',
  }
}
const effectRows = computed(() => [...allLabels.value]
  .sort((a, b) => Math.abs(pairFracDelta(b)) - Math.abs(pairFracDelta(a)))
  .slice(0, 5)
  .map(fractionRow))
const behaviorRows = computed(() => allLabels.value.map(fractionRow))

/* ---- 功能共活动矩阵：全神经元 Pearson 相关，后台预计算并缓存 ---- */
const corrResults = ref<Record<string, CorrelationResult>>({})
const corrComputing = ref(false)
async function ensureCorrelations() {
  const needed = selectedBundles.value.filter(bundle => !corrResults.value[bundle.experiment.condition])
  if (!needed.length) return
  corrComputing.value = true
  try {
    for (const bundle of needed) {
      /* 让出主线程，避免 117×117 相关计算阻塞交互 */
      await new Promise(resolve => setTimeout(resolve, 20))
      corrResults.value[bundle.experiment.condition] = computeCorrelationMatrix(bundle.dataset.frames)
    }
  } finally {
    corrComputing.value = false
  }
}
watch(selectedBundles, () => { void ensureCorrelations() })
const leftCorr = computed(() => (leftBundle.value ? corrResults.value[leftBundle.value.experiment.condition] : null) ?? null)
const rightCorr = computed(() => (rightBundle.value ? corrResults.value[rightBundle.value.experiment.condition] : null) ?? null)
function meanAbsOffDiag(result: CorrelationResult | null): number | null {
  if (!result) return null
  const n = result.ids.length
  let sum = 0, count = 0
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) { sum += Math.abs(result.matrix[i][j]); count += 1 }
  return count ? sum / count : null
}
const meanAbsDelta = computed(() => {
  const a = leftCorr.value, b = rightCorr.value
  if (!a || !b || a.ids.length !== b.ids.length) return null
  const n = a.ids.length
  let sum = 0, count = 0
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) { sum += Math.abs(b.matrix[i][j] - a.matrix[i][j]); count += 1 }
  return count ? sum / count : null
})
const networkSummaryText = computed(() => {
  const lm = meanAbsOffDiag(leftCorr.value)
  const rm = meanAbsOffDiag(rightCorr.value)
  const dm = meanAbsDelta.value
  if (lm == null || rm == null || dm == null) return ''
  const totalShift = rm - lm
  if (Math.abs(totalShift) < 0.02 && dm > 0.03) return '两个条件的平均共活动总量接近，差异主要体现在局部连接的组织方式。'
  return totalShift > 0 ? '目标条件整体功能共活动增强。' : '目标条件整体功能共活动减弱。'
})

/* ---- 结论卡：完全由当前 Pair 的数据驱动，不写死条件语义 ---- */
interface ConclusionCard { kicker: string; title: string; from: string; to: string; delta: string; tone: 'up' | 'down' | 'flat'; note: string; tab: AnalysisTab }
const conclusionCards = computed<ConclusionCard[]>(() => {
  const left = leftBundle.value
  const right = rightBundle.value
  if (!left || !right || !allLabels.value.length) return []
  const toneOf = (delta: number): 'up' | 'down' | 'flat' => Math.abs(delta) < 0.0005 ? 'flat' : delta > 0 ? 'up' : 'down'

  let behaviorLabel = allLabels.value[0]
  allLabels.value.forEach(label => { if (Math.abs(pairFracDelta(label)) > Math.abs(pairFracDelta(behaviorLabel))) behaviorLabel = label })
  const behaviorDelta = pairFracDelta(behaviorLabel)

  let neuralLabel = allLabels.value[0]
  allLabels.value.forEach(label => { if (Math.abs(popDelta(label)) > Math.abs(popDelta(neuralLabel))) neuralLabel = label })
  const neuralDelta = popDelta(neuralLabel)
  const leftRatio = wakeSleepRatio(left)
  const rightRatio = wakeSleepRatio(right)

  const lm = meanAbsOffDiag(leftCorr.value)
  const rm = meanAbsOffDiag(rightCorr.value)
  const dm = meanAbsDelta.value
  const networkReady = lm != null && rm != null && dm != null
  const networkDelta = networkReady ? rm - lm : null

  return [
    {
      kicker: '结论 01 · 行为表型',
      title: `${labelText(behaviorLabel)} 占比变化最大`,
      from: pct(fracOf(left, behaviorLabel)),
      to: pct(fracOf(right, behaviorLabel)),
      delta: `${behaviorDelta >= 0 ? '+' : '−'}${(Math.abs(behaviorDelta) * 100).toFixed(1)} pp`,
      tone: toneOf(behaviorDelta),
      note: `当前比较 ${pairName.value} · 全部状态占比见“行为与神经”`,
      tab: 'behavior-neural',
    },
    {
      kicker: '结论 02 · 神经活动',
      title: `${labelText(neuralLabel)} 状态群体活动差异最大`,
      from: fmt(populationMean(left, neuralLabel)),
      to: fmt(populationMean(right, neuralLabel)),
      delta: `${neuralDelta >= 0 ? '+' : '−'}${Math.abs(neuralDelta).toFixed(3)}`,
      tone: toneOf(neuralDelta),
      note: `清醒/睡眠活动比 ${leftRatio.ratio == null ? '—' : leftRatio.ratio.toFixed(1) + '×'} → ${rightRatio.ratio == null ? '—' : rightRatio.ratio.toFixed(1) + '×'} · 状态依赖性见热图`,
      tab: 'behavior-neural',
    },
    {
      kicker: '结论 03 · 网络组织',
      title: networkReady ? '功能共活动组织对比' : '功能共活动矩阵计算中…',
      from: networkReady ? fmt(lm) : '—',
      to: networkReady ? fmt(rm) : '—',
      delta: networkReady && networkDelta != null ? `${networkDelta >= 0 ? '+' : '−'}${Math.abs(networkDelta).toFixed(3)}` : '—',
      tone: networkDelta == null ? 'flat' : toneOf(networkDelta),
      note: networkReady ? `平均 |r|（非对角）· 平均 |Δ| ${fmt(dm)} · ${networkSummaryText.value}` : '正在准备功能网络对比',
      tab: 'network',
    },
  ]
})

/* ---- 行为片段结构（下钻） ---- */
function boutStats(bundle: Bundle, label: string) {
  const labels = bundle.timeline.map(frame => frame.finalLabel || frame.sleepStage)
  const durations: number[] = []
  let start = -1
  labels.forEach((value, index) => {
    if (value === label && start < 0) start = index
    if (start >= 0 && (value !== label || index === labels.length - 1)) {
      const end = value === label && index === labels.length - 1 ? index : index - 1
      durations.push(Math.max(.52, (bundle.timeline[end]?.timestamp || 0) - (bundle.timeline[start]?.timestamp || 0) + .52))
      start = -1
    }
  })
  const sorted = durations.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0
  return { count: durations.length, median }
}

/* ---- 单神经元对比（下钻）：跨条件均值 + 当前 Pair Δ ---- */
const neuronRows = computed(() => {
  const reference = referenceBundle.value
  if (!reference) return []
  const comparisonId = rightBundle.value?.experiment.condition ?? analysis.referenceConditionId
  return [...reference.dataset.positions.keys()].map(id => {
    const values = Object.fromEntries(selectedBundles.value.map(bundle => {
      const trace = bundle.dataset.frames.map(frame => frame.values[id]).filter((v): v is number => typeof v === 'number')
      return [bundle.experiment.condition, trace.length ? trace.reduce((s, v) => s + v, 0) / trace.length : 0]
    }))
    return { id, values, delta: (values[comparisonId] || 0) - (values[analysis.referenceConditionId] || 0) }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 14)
})

/* ---- 高级分析：群体活动描述图（非 Shared PCA） ---- */
const statePoints = computed(() => {
  const raw: Array<{ id: string; x: number; y: number; behavior: string; time: number }> = []
  selectedBundles.value.forEach(bundle => {
    const ids = [...bundle.dataset.positions.keys()]
    const step = Math.max(1, Math.floor(bundle.dataset.frames.length / 110))
    for (let index = 0; index < bundle.dataset.frames.length; index += step) {
      const frame = bundle.dataset.frames[index]
      const values = ids.map(id => frame.values[id]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      const mean = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0
      const dispersion = values.length ? Math.sqrt(values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length) : 0
      raw.push({ id: bundle.experiment.condition, x: mean, y: dispersion, behavior: bundle.timeline[index]?.finalLabel || bundle.timeline[index]?.sleepStage || '', time: bundle.timeline[index]?.timestamp || 0 })
    }
  })
  const xs = raw.map(p => p.x), ys = raw.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  return raw.map(point => ({ ...point, sx: 34 + ((point.x - minX) / Math.max(maxX - minX, 1e-6)) * 632, sy: 254 - ((point.y - minY) / Math.max(maxY - minY, 1e-6)) * 220 }))
})
function statePointColor(point: { id: string; behavior: string; time: number }) {
  if (stateColorBy.value === '行为') { const index = allLabels.value.indexOf(point.behavior); return palette[(index < 0 ? 0 : index) % palette.length] }
  if (stateColorBy.value === '时间') return `hsl(${190 + (point.time / 360) * 90} 72% 62%)`
  return conditionColor(point.id)
}
function centroid(id: string) {
  const points = statePoints.value.filter(point => point.id === id)
  return { x: points.length ? points.reduce((s, p) => s + p.sx, 0) / points.length : 0, y: points.length ? points.reduce((s, p) => s + p.sy, 0) / points.length : 0 }
}

/* ---- 数据装配 ---- */
async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    if (!workspace.experiments.length) await workspace.loadExperiments()
    analysis.initialize(candidates.value, { conditionId: workspace.selectedExperiment?.condition, behavior: workspace.currentFrame?.finalLabel, neuronId: workspace.selectedNeuron?.id })
    const pack = await analysisApi.getAnalysisBundle(candidates.value.map(experiment => experiment.condition))
    bundles.value = await Promise.all(candidates.value.map(async experiment => ({
      experiment,
      metrics: pack.metrics?.[experiment.condition] ?? null,
      dataset: await visualizationApi.loadCondition(experiment.condition),
      timeline: await experimentApi.timeline(experiment.condition),
    })))
    void ensureCorrelations()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '多状态分析数据加载失败'
  } finally {
    loading.value = false
  }
}
async function openIn3D(conditionId = analysis.selectedPair.right || analysis.selectedConditionIds[0]) {
  const experiment = workspace.experiments.find(item => item.condition === conditionId)
  if (!experiment) return
  await workspace.switchCondition(experiment)
  if (analysis.selectedNeuronId) workspace.selectNeuron(workspace.neurons.find(item => item.id === analysis.selectedNeuronId) || null)
  if (analysis.selectedBehavior) {
    const frame = workspace.timeline.find(item => item.finalLabel === analysis.selectedBehavior || item.sleepStage === analysis.selectedBehavior)
    if (frame) workspace.setTimestamp(frame.timestamp)
  }
  await router.push('/mpfc')
}
function locateNeuronIn3D(neuronId: string) {
  analysis.selectedNeuronId = neuronId
  void openIn3D(rightBundle.value?.experiment.condition)
}
async function generateReport() {
  reportState.value = 'generating'
  try {
    const report = await reportApi.create({ conditionIds: analysis.selectedConditionIds, evidenceIds: analysis.reportEvidence, template: 'comparison' })
    reportState.value = report.status === 'ready' ? 'ready' : 'failed'
    reportUrl.value = report.url || ''
  } catch {
    reportState.value = 'failed'
  }
}
onMounted(load)
</script>

<template>
  <div class="analysis-page">
    <div class="mode-bar">
      <nav>
        <button type="button" @click="router.push('/mpfc')">3D 工作区</button>
        <button type="button" class="active">多条件对比分析</button>
      </nav>
    </div>
    <header class="analysis-header">
      <div class="title-row">
        <div><span class="eyebrow">多条件科研对比工作区</span><h1>多条件对比分析</h1></div>
        <div class="mouse-card"><span>实验对象</span><strong>{{ mouseLabel }}</strong></div>
      </div>
      <div class="control-row">
        <div class="control-group grow">
          <label>分析条件（至少选择 2 个）</label>
          <div class="condition-selector">
            <button v-for="experiment in candidates" :key="experiment.condition" type="button"
              :class="{ active: analysis.selectedConditionIds.includes(experiment.condition) }"
              :style="{ '--cc': conditionColor(experiment.condition) }"
              @click="analysis.toggleCondition(experiment.condition)">
              <i />{{ experiment.displayName }}
              <b class="condition-check"><span>✓</span></b>
            </button>
          </div>
        </div>
        <button class="report-action" @click="analysis.activeTab = 'report'">生成报告 <span>{{ analysis.reportEvidence.length }}</span></button>
      </div>
      <div class="provenance-row">
        <span class="mode-pill">已选择 {{ selectedBundles.length }} 个条件</span>
        <span>✓ 同一实验对象 {{ mouseLabel }} · {{ neuronCount }} 个神经元</span>
        <span class="warning">文献约束重采样 · 不做显著性推断</span>
      </div>
    </header>

    <nav class="analysis-tabs">
      <button v-for="tab in tabs" :key="tab.id" :class="{ active: analysis.activeTab === tab.id }" @click="analysis.activeTab = tab.id"><i>{{ tab.short }}</i><span>{{ tab.label }}</span></button>
    </nav>

    <main class="analysis-canvas">
      <div v-if="loading" class="center-state"><div class="spinner" /><strong>正在装配多条件比较画布</strong><span>读取复核标签、活动与功能共活动数据…</span></div>
      <div v-else-if="errorMessage" class="center-state error"><strong>分析数据加载失败</strong><span>{{ errorMessage }}</span><button @click="load">重试</button></div>
      <template v-else>

        <!-- ============ 总览：结论卡 + 跨条件效应图 ============ -->
        <section v-if="analysis.activeTab === 'overview'" class="tab-view">
          <div class="section-heading"><div><span>总览</span><h2>结论与跨条件效应</h2></div><button class="evidence" :class="{ selected: analysis.reportEvidence.includes('overview') }" @click="analysis.toggleEvidence('overview')">{{ analysis.reportEvidence.includes('overview') ? '✓ 已加入报告' : '＋ 加入报告' }}</button></div>

          <div class="conclusion-grid">
            <article v-for="card in conclusionCards" :key="card.kicker" class="conclusion-card">
              <span class="conclusion-kicker">{{ card.kicker }}</span>
              <strong class="conclusion-title">{{ card.title }}</strong>
              <div class="conclusion-values">
                <b>{{ card.from }}</b><i>→</i><b>{{ card.to }}</b>
                <em class="mono" :class="`is-${card.tone}`">{{ card.delta }}</em>
              </div>
              <p>{{ card.note }}</p>
              <button type="button" @click="analysis.activeTab = card.tab">查看证据 →</button>
            </article>
          </div>

          <article class="panel hero-panel">
            <div class="panel-title">
              <div><span>核心视图</span><h3>跨条件效应图 · 当前 Pair 差异最大的 {{ effectRows.length }} 项指标</h3></div>
            </div>
            <ConditionSlopeChart :conditions="slopeConditions" :pair-ids="[analysis.selectedPair.left, analysis.selectedPair.right]" :rows="effectRows" />
            <p class="panel-note">描述性差值 · 点 = 条件占比，描边圆点与加粗线段 = 当前详细比较（{{ pairName }}）· 由「详细比较」控件切换</p>
          </article>

          <p class="method-note">结论均为描述性发现：Condition 为同一只小鼠真实记录的文献约束重采样，不构成群体药效推断；恢复指数、置信区间等推断性指标需后端预计算后方可展示。</p>
        </section>

        <!-- ============ 行为与神经：占比坡度图 + 状态活动热图 ============ -->
        <section v-else-if="analysis.activeTab === 'behavior-neural'" class="tab-view">
          <div class="section-heading"><div><span>行为与神经</span><h2>行为表型与神经活动状态依赖性</h2></div><button class="evidence" :class="{ selected: analysis.reportEvidence.includes('behavior-neural') }" @click="analysis.toggleEvidence('behavior-neural')">{{ analysis.reportEvidence.includes('behavior-neural') ? '✓ 已加入报告' : '＋ 加入报告' }}</button></div>

          <article class="panel hero-panel">
            <div class="panel-title"><div><span>01 · 行为与睡眠表型</span><h3>状态占比对比（已复核 final_label）</h3></div></div>
            <ConditionSlopeChart :conditions="slopeConditions" :pair-ids="[analysis.selectedPair.left, analysis.selectedPair.right]" :rows="behaviorRows" />
            <details class="drill">
              <summary>下钻 · 行为片段结构（次数 / 中位时长）</summary>
              <div class="table-wrap"><table>
                <thead><tr><th>状态</th><th v-for="bundle in selectedBundles" :key="bundle.experiment.condition">{{ bundle.experiment.displayName }}</th></tr></thead>
                <tbody><tr v-for="label in allLabels" :key="label"><td>{{ labelText(label) }}</td><td v-for="bundle in selectedBundles" :key="bundle.experiment.condition">{{ boutStats(bundle, label).count }} / {{ boutStats(bundle, label).median.toFixed(1) }}s</td></tr></tbody>
              </table></div>
            </details>
          </article>

          <article class="panel hero-panel">
            <div class="panel-title"><div><span>02 · 神经活动状态依赖性</span><h3>条件 × 状态 群体活动热图</h3></div></div>
            <div class="heatmap" :style="{ gridTemplateColumns: `120px repeat(${allLabels.length}, 1fr)` }">
              <i class="heatmap-corner" />
              <b v-for="label in allLabels" :key="'h' + label" class="heatmap-head" :title="labelText(label)">{{ labelText(label) }}</b>
              <template v-for="bundle in selectedBundles" :key="bundle.experiment.condition">
                <span class="heatmap-row-name"><i :style="{ background: conditionColor(bundle.experiment.condition) }" />{{ bundle.experiment.displayName }}</span>
                <span v-for="label in allLabels" :key="bundle.experiment.condition + label" class="heatmap-cell mono"
                  :style="{ background: `rgba(47,126,247,${(0.06 + 0.78 * (populationMean(bundle, label) / heatMax)).toFixed(3)})` }"
                  :title="`${bundle.experiment.displayName} · ${labelText(label)} · 群体活动均值 ${fmt(populationMean(bundle, label))}`">
                  {{ fmt(populationMean(bundle, label), 2) }}
                </span>
              </template>
              <span class="heatmap-row-name is-delta">Δ {{ pairName }}</span>
              <span v-for="label in allLabels" :key="'d' + label" class="heatmap-cell is-delta mono"
                :style="{ background: popDelta(label) >= 0 ? `rgba(232,118,45,${(0.08 + 0.72 * Math.abs(popDelta(label)) / popDeltaMax).toFixed(3)})` : `rgba(47,107,214,${(0.08 + 0.72 * Math.abs(popDelta(label)) / popDeltaMax).toFixed(3)})` }"
                :title="`Δ（${pairName}）· ${labelText(label)} · ${popDelta(label) >= 0 ? '+' : ''}${fmt(popDelta(label))}`">
                {{ popDelta(label) >= 0 ? '+' : '' }}{{ fmt(popDelta(label), 2) }}
              </span>
            </div>
            <div class="mod-summary">
              <span v-for="bundle in selectedBundles" :key="bundle.experiment.condition">
                <i :style="{ background: conditionColor(bundle.experiment.condition) }" />
                {{ bundle.experiment.displayName }}：清醒期 {{ fmt(wakeSleepRatio(bundle).wake, 2) }} · 睡眠期 {{ fmt(wakeSleepRatio(bundle).sleep, 2) }} · 清醒/睡眠 {{ wakeSleepRatio(bundle).ratio == null ? '—' : wakeSleepRatio(bundle).ratio!.toFixed(1) + '×' }}
              </span>
            </div>
            <p class="panel-note">全条件共用同一色标（蓝 = 群体活动均值）；Δ 行橙 = 升高、蓝 = 降低，仅描述当前 Pair（{{ pairName }}）</p>
          </article>

          <article class="panel">
            <div class="panel-title">
              <div><span>下钻 · 单神经元</span><h3>神经元均值对比（按当前 Pair |Δ| 排序）</h3></div>
              <button class="open3d" :disabled="!analysis.selectedNeuronId" @click="openIn3D()">在 mPFC 3D 中打开 →</button>
            </div>
            <div class="table-wrap"><table>
              <thead><tr><th>神经元</th><th v-for="bundle in selectedBundles" :key="bundle.experiment.condition">{{ bundle.experiment.displayName }}</th><th>Δ（相对参考）</th></tr></thead>
              <tbody>
                <tr v-for="row in neuronRows" :key="row.id" :class="{ selected: analysis.selectedNeuronId === row.id }" @click="analysis.selectedNeuronId = row.id">
                  <td>{{ row.id }}</td>
                  <td v-for="bundle in selectedBundles" :key="bundle.experiment.condition">{{ fmt(row.values[bundle.experiment.condition]) }}</td>
                  <td :class="{ negative: row.delta < 0 }">{{ row.delta >= 0 ? '+' : '' }}{{ fmt(row.delta) }}</td>
                </tr>
              </tbody>
            </table></div>
            <p class="panel-note">单个神经元波动不代表总体结论，仅用于回溯定位证据</p>
          </article>
        </section>

        <!-- ============ 功能网络：Reference / Target / Δ 三联矩阵 ============ -->
        <section v-else-if="analysis.activeTab === 'network'" class="tab-view">
          <div class="section-heading"><div><span>功能网络</span><h2>功能共活动结构的两两比较</h2></div><button class="evidence" :class="{ selected: analysis.reportEvidence.includes('network') }" @click="analysis.toggleEvidence('network')">{{ analysis.reportEvidence.includes('network') ? '✓ 已加入报告' : '＋ 加入报告' }}</button></div>

          <article class="panel hero-panel">
            <div class="panel-title">
              <div><span>核心视图 · {{ pairName }}</span><h3>神经元 × 神经元 功能共活动矩阵</h3></div>
            </div>
            <CorrelationMatrixTriptych
              :left="leftCorr" :right="rightCorr"
              :left-name="leftBundle?.experiment.displayName ?? '—'"
              :right-name="rightBundle?.experiment.displayName ?? '—'"
              :computing="corrComputing"
              @select-neuron="locateNeuronIn3D" />
            <div v-if="meanAbsOffDiag(leftCorr) != null" class="network-stats">
              <strong>本图结论</strong>
              <span>整体关联强度：{{ leftBundle?.experiment.displayName }} <b class="mono">{{ fmt(meanAbsOffDiag(leftCorr)!) }}</b> → {{ rightBundle?.experiment.displayName }} <b class="mono">{{ fmt(meanAbsOffDiag(rightCorr)!) }}</b></span>
              <span>平均变化幅度 <b class="mono">{{ meanAbsDelta == null ? '—' : fmt(meanAbsDelta) }}</b></span>
              <span v-if="networkSummaryText" class="network-verdict">{{ networkSummaryText }}</span>
            </div>
          </article>
        </section>

        <!-- ============ 高级分析：群体活动描述性投影 ============ -->
        <section v-else-if="analysis.activeTab === 'advanced'" class="tab-view">
          <div class="section-heading"><div><span>高级分析</span><h2>群体活动分布</h2></div><button class="evidence" :class="{ selected: analysis.reportEvidence.includes('advanced') }" @click="analysis.toggleEvidence('advanced')">{{ analysis.reportEvidence.includes('advanced') ? '✓ 已加入报告' : '＋ 加入报告' }}</button></div>

          <div class="state-layout">
            <article class="panel state-main">
              <div class="panel-title"><div><span>描述性投影</span><h3>群体活动描述图（群体活动 × 离散度）</h3></div></div>
              <svg viewBox="0 0 700 270" preserveAspectRatio="none">
                <line x1="350" y1="10" x2="350" y2="260" /><line x1="18" y1="135" x2="682" y2="135" />
                <circle v-for="(point, index) in statePoints" :key="index" :cx="point.sx" :cy="point.sy" r="3" :fill="statePointColor(point)" opacity=".62" />
                <g v-for="bundle in selectedBundles" :key="bundle.experiment.condition">
                  <circle :cx="centroid(bundle.experiment.condition).x" :cy="centroid(bundle.experiment.condition).y" r="8" fill="none" :stroke="conditionColor(bundle.experiment.condition)" stroke-width="3" />
                  <text :x="centroid(bundle.experiment.condition).x + 10" :y="centroid(bundle.experiment.condition).y - 8" :fill="conditionColor(bundle.experiment.condition)">{{ bundle.experiment.displayName }}</text>
                </g>
              </svg>
            </article>
            <aside class="panel state-side">
              <span class="eyebrow">视图说明</span>
              <h3>显示控制</h3>
              <label>着色方式
                <select v-model="stateColorBy"><option>条件</option><option>行为</option><option>时间</option></select>
              </label>
              <div class="legend-list"><span v-for="bundle in selectedBundles" :key="bundle.experiment.condition"><i :style="{ background: conditionColor(bundle.experiment.condition) }" />{{ bundle.experiment.displayName }}</span></div>
              <p>横轴表示群体活动均值，纵轴表示神经元之间的活动差异。不同颜色对应不同实验条件，用于观察群体活动分布是否发生整体变化。</p>
            </aside>
          </div>
        </section>

        <!-- ============ 报告 ============ -->
        <section v-else class="tab-view">
          <div class="section-heading"><div><span>报告中心</span><h2>把已有分析证据组织成正式交付</h2></div></div>
          <div class="report-layout">
            <article class="panel report-settings">
              <h3>报告设置</h3>
              <label>对比条件</label>
              <div class="report-checks"><span v-for="bundle in selectedBundles" :key="bundle.experiment.condition"><i :style="{ background: conditionColor(bundle.experiment.condition) }" />✓ {{ bundle.experiment.displayName }}</span></div>
              <label>详细比较</label>
              <div class="report-checks"><span>{{ pairName }}</span></div>
              <label>已选证据</label>
              <div class="evidence-stack">
                <button v-for="item in analysis.reportEvidence" :key="item" type="button" @click="analysis.toggleEvidence(item)">
                  <span>{{ tabs.find(tab => tab.id === item)?.label || item }}</span><b>✓ 已包含</b><small>点击移除</small>
                </button>
                <p v-if="!analysis.reportEvidence.length">在任意分析标签页点击“加入报告”。</p>
              </div>
              <button class="generate" :disabled="reportState === 'generating'" @click="generateReport">{{ reportState === 'generating' ? '生成中…' : '生成报告' }}</button>
              <a v-if="reportState === 'ready' && reportUrl" :href="reportUrl" download>下载生成的报告 →</a>
              <p v-if="reportState === 'failed'" class="report-error">报告生成失败，请稍后重试。</p>
            </article>
            <article class="panel report-preview">
              <span class="eyebrow">报告结构预览</span>
              <div class="report-page">
                <header class="report-cover">
                  <small>NEUROSCIENCE RESEARCH DATA REPORT</small>
                  <h3>mPFC 多条件神经行为分析报告</h3>
                  <p>Multi Condition Neural and Behavioral Analysis Report</p>
                </header>
                <div class="report-meta">
                  <span><b>实验对象</b>{{ mouseLabel }}</span>
                  <span><b>比较条件</b>{{ selectedBundles.map(item => item.experiment.displayName).join(' / ') }}</span>
                  <span><b>记录规模</b>{{ neuronCount }} 个神经元</span>
                </div>
                <section class="report-toc">
                  <span>报告目录</span>
                  <ol>
                    <li><b>01</b><div><strong>实验概况与数据质量</strong><small>实验信息、数据完整性与处理流程</small></div><em>固定章节</em></li>
                    <li :class="{ included: analysis.reportEvidence.includes('behavior-neural') }"><b>02</b><div><strong>行为表型量化与神经活动</strong><small>状态占比、群体活动热图与单神经元证据</small></div><em>{{ analysis.reportEvidence.includes('behavior-neural') ? '已加入图表' : '待选择' }}</em></li>
                    <li :class="{ included: analysis.reportEvidence.includes('advanced') }"><b>03</b><div><strong>行为与神经联合表征</strong><small>群体活动分布及条件间差异</small></div><em>{{ analysis.reportEvidence.includes('advanced') ? '已加入图表' : '待选择' }}</em></li>
                    <li :class="{ included: analysis.reportEvidence.includes('network') }"><b>04</b><div><strong>功能共活动网络比较</strong><small>条件矩阵、变化矩阵与网络解读</small></div><em>{{ analysis.reportEvidence.includes('network') ? '已加入图表' : '待选择' }}</em></li>
                    <li :class="{ included: analysis.reportEvidence.includes('overview') }"><b>05</b><div><strong>综合科研结论与建议</strong><small>关键发现、证据汇总与后续实验建议</small></div><em>{{ analysis.reportEvidence.includes('overview') ? '已加入结论' : '待选择' }}</em></li>
                    <li><b>A</b><div><strong>附录 分析方法与指标说明</strong><small>计算方法、读图说明与适用边界</small></div><em>固定章节</em></li>
                  </ol>
                </section>
                <footer>图表将按照所选证据插入对应章节，并自动生成标题、图注与解读。</footer>
              </div>
            </article>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
/* 与 mPFC 3D 工作区一致的设计语言：白底卡片 + 品牌蓝点缀 + 浅灰蓝背景 */
.analysis-page{--bg:#f2f5fa;--panel:#ffffff;--elev:#f7f9fd;--line:var(--border);--text:#33415c;--muted:var(--text-muted);--cyan:var(--brand);min-height:calc(100vh - var(--topbar-h));background:radial-gradient(circle at 74% -20%,rgba(47,126,247,.08),transparent 35%),var(--bg);color:var(--text);padding:22px 26px 36px}
.mode-bar{display:flex;align-items:center;margin:-22px -26px 22px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)}.mode-bar nav{display:flex;padding:3px;background:var(--bg-subtle);border-radius:8px}.mode-bar nav button{padding:6px 13px;border:0;border-radius:6px;background:transparent;color:var(--text-muted);font-size: 13px;cursor:pointer}.mode-bar nav button.active{background:var(--surface);color:var(--brand-text);box-shadow:var(--shadow-sm)}
.analysis-header{max-width:1560px;margin:auto}.title-row,.control-row,.provenance-row,.panel-title,.section-heading{display:flex;align-items:center}.title-row{gap:18px}.eyebrow,.section-heading span,.panel-title span{font-size: 11px;letter-spacing:1.5px;color:var(--cyan);font-weight:700}.title-row h1{font-size: 29px;margin:3px 0 0;font-weight:600}.mouse-card{margin-left:auto;border-left:1px solid var(--line);padding-left:20px;display:grid;gap:3px}.mouse-card span,.control-group label{font-size: 11px;letter-spacing:1px;color:var(--muted)}
.control-row{gap:14px;margin-top:18px;padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm)}.control-group{display:grid;gap:7px}.grow{flex:1}.condition-selector{display:flex;gap:8px;flex-wrap:wrap}.condition-selector button{display:flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--elev);color:var(--muted);padding:8px 10px;border-radius:8px;cursor:pointer;transition:transform .22s var(--ease),border-color .22s,background .22s,box-shadow .22s}.condition-selector button:hover{transform:translateY(-1px)}.condition-selector button i{width:7px;height:7px;border-radius:50%;border:2px solid var(--cc);transition:all .24s var(--ease)}.condition-selector button.active{color:var(--text);border-color:color-mix(in srgb,var(--cc) 55%,var(--line));background:color-mix(in srgb,var(--cc) 10%,var(--elev));box-shadow:0 4px 12px color-mix(in srgb,var(--cc) 14%,transparent)}.condition-selector button.active i{background:var(--cc);box-shadow:0 0 0 4px color-mix(in srgb,var(--cc) 14%,transparent)}.condition-check{display:grid;place-items:center;width:18px;height:18px;margin-left:2px;border-radius:50%;background:var(--cc);color:#fff;transform:scale(0);opacity:0}.condition-check span{font-size:12px;line-height:1}.condition-selector button.active .condition-check{opacity:1;animation:condition-check-in .36s cubic-bezier(.2,1.65,.45,1) forwards}
select{border:1px solid var(--line);background:var(--elev);color:var(--text);padding:8px 30px 8px 10px;border-radius:8px;font:inherit}.report-action,.generate,.open3d{border:0;background:var(--cyan);color:#fff;font-weight:700;border-radius:8px;padding:10px 14px;cursor:pointer}.report-action span{background:#fff;color:var(--cyan);padding:2px 6px;border-radius:10px;margin-left:5px}.provenance-row{gap:18px;padding:10px 4px;color:var(--muted);font-size: 12px}.mode-pill{color:var(--cyan)!important;border:1px solid var(--brand-line);padding:4px 8px;border-radius:20px;background:var(--brand-soft)}.warning{margin-left:auto;color:var(--warn)}
.analysis-tabs{max-width:1560px;margin:16px auto 0;display:flex;gap:2px;width:fit-content;max-width:100%;padding:3px;background:var(--bg-subtle);border:1px solid var(--line);border-radius:10px;overflow:auto}.analysis-tabs button{display:flex;align-items:center;gap:8px;padding:8px 16px;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size: 14.5px;white-space:nowrap;cursor:pointer;transition:all var(--dur) var(--ease)}.analysis-tabs button i{display:none}.analysis-tabs button.active{background:var(--panel);color:var(--brand-text);font-weight:600;box-shadow:var(--shadow-sm)}
.analysis-canvas{max-width:1560px;margin:0 auto;padding-top:22px}.center-state{min-height:560px;display:grid;place-content:center;text-align:center;gap:10px;color:var(--muted)}.center-state strong{color:var(--text-strong)}.spinner{width:32px;height:32px;border:3px solid var(--line);border-top-color:var(--cyan);border-radius:50%;animation:spin .7s linear infinite;margin:auto}.tab-view{display:grid;gap:16px}.section-heading{justify-content:space-between}.section-heading h2{font-size: 24px;margin:3px 0 0;font-weight:600}.evidence{border:1px solid var(--line);background:var(--panel);color:var(--cyan);border-radius:8px;padding:8px 11px;cursor:pointer;transition:all .24s var(--ease)}.evidence.selected{border-color:var(--brand);background:var(--brand-soft);font-weight:700;animation:evidence-check .32s cubic-bezier(.2,1.5,.45,1)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);padding:16px;min-width:0}.hero-panel{border-top:2px solid var(--brand-line)}.panel-title{justify-content:space-between;margin-bottom:14px}.panel-title h3{font-size: 17px;margin:4px 0 0;color:var(--text-strong)}.panel-title button{border:0;background:transparent;color:var(--cyan);cursor:pointer}.panel-note{margin:12px 0 0;color:var(--text-faint);font-size: 12px}.method-note{padding:10px 12px;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size: 12px}
/* 结论卡 */
.conclusion-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.conclusion-card{display:grid;gap:8px;padding:15px;background:linear-gradient(145deg,var(--elev),var(--panel));border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm)}
.conclusion-kicker{font-size: 11px;letter-spacing:1.2px;color:var(--cyan);font-weight:700}
.conclusion-title{font-size: 15.5px;color:var(--text-strong)}
.conclusion-values{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.conclusion-values b{font-size: 22px;color:var(--text-strong)}
.conclusion-values i{color:var(--text-faint);font-style:normal}
.conclusion-values em{font-style:normal;font-size: 13px;font-weight:700;padding:2px 8px;border-radius:6px;background:var(--bg-subtle);color:var(--text-muted)}
.conclusion-values em.is-up{color:#b4540a;background:rgba(232,118,45,.12)}
.conclusion-values em.is-down{color:#2f6bd6;background:rgba(47,107,214,.12)}
.conclusion-card p{margin:0;color:var(--muted);font-size: 12px;line-height:1.5}
.conclusion-card button{justify-self:start;border:0;background:transparent;color:var(--cyan);font-size: 13px;font-weight:600;padding:0;cursor:pointer}
.conclusion-card button:hover{text-decoration:underline}
/* 条件 × 状态热图 */
.heatmap{display:grid;gap:3px;overflow:auto}
.heatmap-corner{min-height:26px}
.heatmap-head{font-size: 11px;color:var(--muted);display:grid;place-content:center;text-align:center;padding:4px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.heatmap-row-name{display:flex;align-items:center;gap:7px;font-size: 12.5px;color:var(--text);padding-right:8px;white-space:nowrap}
.heatmap-row-name i{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.heatmap-row-name.is-delta{color:var(--text-faint);font-size: 11.5px}
.heatmap-cell{display:grid;place-content:center;min-height:34px;border-radius:5px;font-size: 11.5px;color:var(--text-strong)}
.heatmap-cell.is-delta{min-height:28px;font-weight:700}
.mod-summary{display:grid;gap:6px;margin-top:12px;padding:10px 12px;background:var(--elev);border-radius:8px}
.mod-summary span{display:flex;align-items:center;gap:7px;color:var(--muted);font-size: 12.5px}
.mod-summary i{width:8px;height:8px;border-radius:50%}
/* 下钻 */
.drill{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.drill summary{cursor:pointer;color:var(--text-faint);font-size: 13px;list-style:none}
.drill summary::before{content:'▸ '}
.drill[open] summary::before{content:'▾ '}
.table-wrap{overflow:auto;margin-top:8px}table{width:100%;border-collapse:collapse;font-size: 12px}th{text-align:left;color:var(--muted);font-weight:600;padding:8px;border-bottom:1px solid var(--line)}td{padding:8px;border-bottom:1px solid var(--line)}tbody tr{cursor:pointer}tbody tr:hover,tbody tr.selected{background:var(--brand-soft)}
.negative{color:var(--danger)!important}
/* 网络统计 */
.network-stats{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:0;padding:10px 12px;background:var(--elev);border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size: 12.5px}
.network-stats>strong{color:var(--text-strong);font-size:12.5px}
.network-stats b{color:var(--text-strong)}
.network-verdict{color:var(--cyan);font-weight:600}
/* 高级分析 */
.state-layout{display:grid;grid-template-columns:minmax(0,3fr) minmax(240px,1fr);gap:14px}.state-main svg{width:100%;height:340px;background:var(--elev);border-radius:8px}.state-main line{stroke:var(--border-strong);stroke-width:1}.state-main text{font-size: 12px}.state-side{display:flex;flex-direction:column;gap:12px}.state-side label{display:grid;gap:6px;color:var(--muted)}.legend-list{display:grid;gap:8px}.legend-list span,.report-checks span{display:flex;align-items:center;gap:7px}.legend-list i,.report-checks i{width:7px;height:7px;border-radius:50%}.state-side p{color:var(--muted);font-size: 12px;line-height:1.6}
/* 报告 */
.report-layout{display:grid;grid-template-columns:minmax(280px,.8fr) minmax(0,2fr);gap:14px}.report-settings,.report-preview{display:flex;flex-direction:column;gap:14px}.report-settings>label{color:var(--muted);font-size: 11px;letter-spacing:1px}.report-checks,.evidence-stack{display:grid;gap:8px}.evidence-stack button{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:9px;border:1px solid var(--line);border-radius:7px;background:var(--elev);color:var(--text);text-align:left;cursor:pointer}.evidence-stack button b{color:var(--cyan)}.evidence-stack button small{grid-column:1/-1;color:var(--text-faint)}.report-settings a{color:var(--cyan)}.report-error{color:var(--danger)}.report-page{padding:28px 32px;border:1px solid #d9dee8;border-radius:4px;background:#fff;box-shadow:0 12px 30px rgba(23,35,61,.08);color:#1f2a3d}.report-cover{padding:8px 0 20px;border-bottom:1px solid #d9dee8}.report-cover small{letter-spacing:2px;color:#60708a;font-size:9px;font-weight:700}.report-cover h3{margin:12px 0 4px;font-size:25px;color:#111827}.report-cover p{margin:0;color:#7a879b;font-size:12px}.report-meta{display:grid;grid-template-columns:.7fr 1.5fr .8fr;gap:18px;padding:16px 0;border-bottom:1px solid #e7eaf0}.report-meta span{display:grid;gap:4px;color:#3f4b61;font-size:12px}.report-meta b{color:#8a96a8;font-size:9px;letter-spacing:1px}.report-toc{padding-top:20px}.report-toc>span{font-size:11px;letter-spacing:1.5px;color:#2f7ef7;font-weight:800}.report-toc ol{display:grid;gap:0;margin:12px 0 0;padding:0;list-style:none}.report-toc li{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f4;opacity:.5}.report-toc li.included,.report-toc li:first-child,.report-toc li:last-child{opacity:1}.report-toc li>b{font:700 13px var(--font-mono);color:#8a96a8}.report-toc li div{display:grid;gap:2px}.report-toc li strong{font-size:13px}.report-toc li small{color:#7a879b;font-size:10.5px}.report-toc li em{font-style:normal;font-size:10px;color:#8a96a8}.report-toc li.included em{color:#2f7ef7;font-weight:700}.report-page footer{margin-top:16px;color:#7a879b;font-size:10.5px;line-height:1.6}.open3d:disabled{opacity:.4}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes condition-check-in{0%{transform:scale(0) rotate(-20deg)}65%{transform:scale(1.18) rotate(5deg)}100%{transform:scale(1) rotate(0)}}
@keyframes evidence-check{0%{transform:scale(.96)}65%{transform:scale(1.025)}100%{transform:scale(1)}}
@media(max-width:1050px){.state-layout,.report-layout{grid-template-columns:1fr}.conclusion-grid{grid-template-columns:1fr}.control-row{align-items:stretch;flex-direction:column}.warning{margin-left:0}}
@media(max-width:680px){.analysis-page{padding:14px}.mode-bar{margin:-14px -14px 14px}.title-row{align-items:flex-start;flex-wrap:wrap}.mouse-card{margin-left:0}.analysis-tabs button{font-size: 13px;padding:7px 10px}}
</style>
