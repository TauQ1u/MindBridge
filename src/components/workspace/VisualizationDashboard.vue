<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SynchronizedTimelineFigure from '@/components/panel/SynchronizedTimelineFigure.vue'
import PhysiologicalSignalFigure from '@/components/panel/PhysiologicalSignalFigure.vue'
import PCAManifoldFigure from '@/components/panel/PCAManifoldFigure.vue'
import ConnectivityMatrixFigure from '@/components/panel/ConnectivityMatrixFigure.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { visualizationApi, type VisualizationDataset } from '@/services/api/visualizationApi'
import { formatTimestamp } from '@/utils/time'
import { withBehaviorZh, withSleepZh } from '@/utils/behaviorLabels'

const store = useWorkspaceStore()
const emit = defineEmits<{ figureModeChange: [active: boolean] }>()
const frameIndex = computed(() => store.currentFrame ? store.timeline.indexOf(store.currentFrame) : -1)

const baselines = computed(() => new Map(store.neurons.map(neuron => {
  const trace = (neuron.activityTrace ?? []).filter(Number.isFinite)
  if (!trace.length) return [neuron.id, { mean: 0, sd: 0 }] as const
  const mean = trace.reduce((sum, value) => sum + value, 0) / trace.length
  const variance = trace.reduce((sum, value) => sum + (value - mean) ** 2, 0) / trace.length
  return [neuron.id, { mean, sd: Math.sqrt(variance) }] as const
})))

const currentActivities = computed(() => {
  if (!store.hasImportedData || frameIndex.value < 0) return []
  return store.neurons.flatMap(neuron => {
    const value = neuron.activityTrace?.[frameIndex.value]
    return typeof value === 'number' && Number.isFinite(value) ? [{ neuron, value }] : []
  })
})

const populationActivity = computed(() => {
  const values = currentActivities.value
  return values.length ? values.reduce((sum, item) => sum + item.value, 0) / values.length : null
})

const activeNeuronCount = computed(() => currentActivities.value.filter(({ neuron, value }) => {
  const baseline = baselines.value.get(neuron.id)
  return baseline ? value >= baseline.mean + baseline.sd : false
}).length)

const activeFraction = computed(() => currentActivities.value.length ? activeNeuronCount.value / currentActivities.value.length : null)
const possibleEdges = computed(() => store.neurons.length * Math.max(store.neurons.length - 1, 0) / 2)
const networkDensity = computed(() => possibleEdges.value ? store.currentEdgeCount / possibleEdges.value : null)
const behaviorText = computed(() => {
  const raw = store.currentFrame?.finalLabel || store.currentFrame?.videoLabel
  return raw ? withBehaviorZh(raw) : '待复核'
})
const sleepText = computed(() => store.currentFrame?.sleepStage ? withSleepZh(store.currentFrame.sleepStage) : '—')

// ---- AI 神经解码证据卡片：当前行为/睡眠阶段的模型解释 ----
const SLEEP_LABELS = new Set(['nrem', 'rem', 'ma', 'w'])
const aiCardTitle = computed(() => {
  const label = store.currentDecoderModule?.targetLabel ?? store.currentFrame?.finalLabel ?? ''
  return SLEEP_LABELS.has(label.trim().toLowerCase()) ? 'AI 睡眠解码证据' : 'AI 神经解码证据'
})
const aiFinalText = computed(() => {
  const raw = store.currentFrame?.finalLabel || store.currentFrame?.videoLabel
  return raw ? withBehaviorZh(raw) : '—'
})
const aiPredictedText = computed(() => {
  const evidence = store.currentModuleEvidence
  return evidence?.predictedLabel ? withBehaviorZh(evidence.predictedLabel) : '—'
})
const aiConfidence = computed(() => {
  const confidence = store.currentModuleEvidence?.confidence
  return confidence == null ? null : `${(confidence * 100).toFixed(0)}%`
})
const aiModuleScore = computed(() => {
  const score = store.currentModuleEvidence?.moduleScore
  return score == null ? null : `${score >= 0 ? '+' : ''}${score.toFixed(2)}`
})
const aiTopText = computed(() => store.currentTopNeuronIds.join(' · ') || '—')

// ---- 图表面板：原右下角数据面板（四张核心图）合并进数据看板 ----
const view = ref<'readings' | 'figures'>('readings')
const FIGURES = [
  { id: 'timeline', num: '01', label: '全程活动地图', short: '行为、睡眠与神经活动是否同步',
    question: '这张图看什么？', description: '把整段实验压缩到一张图中：上方是行为与睡眠状态，下方是全部神经元的活动强弱。竖线表示当前播放位置。' },
  { id: 'eeg', num: '02', label: '睡眠与肌肉信号', short: '脑电与肌电如何随当前时刻变化',
    question: '这张图看什么？', description: '蓝色和紫色是两路脑电，橙色是肌肉活动。波动明显通常表示脑活动或身体活动发生变化，三条信号已合并在同一张图中便于对照。' },
  { id: 'pca', num: '03', label: '神经活动分布', short: '相似活动模式会聚在一起',
    question: '这张图看什么？', description: '每个点代表一个时刻的整体神经活动。点越靠近，说明活动模式越相似；不同颜色形成分区，说明不同状态可能对应不同神经模式。' },
  { id: 'matrix', num: '04', label: '神经协同关系', short: '哪些神经元经常同步变化',
    question: '这张图看什么？', description: '每个小格代表一对神经元。暖色表示两者更常同步变化，冷色表示变化方向相反；这只是统计关系，不代表真实突触连接。' },
] as const
type FigureId = (typeof FIGURES)[number]['id']
const activeFigure = ref<FigureId>('timeline')
const activeFigureLabel = computed(() => FIGURES.find(fig => fig.id === activeFigure.value)?.label ?? '')
const activeFigureMeta = computed(() => FIGURES.find(fig => fig.id === activeFigure.value) ?? FIGURES[0])

const conditionId = computed(() => store.selectedExperiment?.condition ?? '')
const dataset = ref<VisualizationDataset | null>(null)
const loadState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')

async function loadFigures() {
  if (!conditionId.value || view.value !== 'figures') return
  loadState.value = 'loading'
  try {
    dataset.value = await visualizationApi.loadCondition(conditionId.value)
    loadState.value = 'ready'
  } catch {
    loadState.value = 'error'
  }
}
watch([conditionId, view], () => { dataset.value = null; void loadFigures() }, { immediate: true })
watch(view, value => emit('figureModeChange', value === 'figures'), { immediate: true })

const figureFrames = computed(() => dataset.value?.frames ?? [])
function seek(timestamp: number) {
  store.setTimestamp(timestamp)
}
function locateIn3D(neuronId: string) {
  const neuron = store.neurons.find(item => item.id === neuronId)
  if (neuron) store.selectNeuron(neuron)
}
</script>

<template>
  <section class="dashboard">
    <div class="dash-head">
      <div><span class="kicker">{{ view === 'readings' ? '数据看板' : '图表解读区' }}</span><strong>{{ view === 'readings' ? '实时状态读数' : activeFigureLabel }}</strong></div>
      <div v-if="store.hasImportedData" class="view-switch">
        <button :class="{ active: view === 'readings' }" @click="view = 'readings'">关键读数</button>
        <button :class="{ active: view === 'figures' }" @click="view = 'figures'">图表解读</button>
      </div>
    </div>

    <template v-if="store.hasImportedData">
      <template v-if="view === 'readings'">
        <div class="state-card">
          <div><span>当前行为状态</span><strong>{{ behaviorText }}</strong></div>
          <i />
          <div><span>睡眠阶段</span><strong>{{ sleepText }}</strong></div>
          <time class="mono">{{ formatTimestamp(store.currentTimestamp) }}</time>
        </div>

        <section class="ai-card" :class="`is-${store.moduleJobStatus}`">
          <header class="ai-card__head">
            <div><span class="kicker">模型解释</span><strong>{{ aiCardTitle }}</strong></div>
            <span v-if="store.moduleJobStatus === 'ready' && store.currentModuleEvidence?.moduleId" class="ai-card__method mono">预计算归因</span>
          </header>

          <div v-if="store.moduleJobStatus === 'loading'" class="ai-card__state">
            <span class="ai-card__spinner" />正在载入 AI 神经解码证据…
          </div>
          <div v-else-if="store.moduleJobStatus === 'failed'" class="ai-card__state is-error">
            模型结果加载失败
            <button type="button" @click="store.startModuleJob()">重试</button>
          </div>
          <div v-else-if="store.moduleJobStatus === 'unavailable'" class="ai-card__state">
            当前实验未提供 AI 解码贡献数据
          </div>
          <div v-else-if="store.moduleJobStatus === 'ready' && !store.currentModuleEvidence?.moduleId" class="ai-card__state">
            当前片段暂无贡献数据
          </div>
          <template v-else-if="store.moduleJobStatus === 'ready' && store.currentDecoderModule">
            <div class="ai-card__row">
              <span>最终行为</span><b>{{ aiFinalText }}</b>
            </div>
            <div class="ai-card__row">
              <span>神经模型预测</span><b>{{ aiPredictedText }}<em v-if="aiConfidence" class="mono">置信度 {{ aiConfidence }}</em></b>
            </div>
            <div class="ai-card__module" :style="{ '--module-color': store.currentDecoderModule.color }">
              <div>
                <strong>{{ store.currentDecoderModule.name }}</strong>
                <span>{{ store.currentDecoderModule.memberCount }} 个神经元</span>
              </div>
              <b class="mono">{{ aiModuleScore }}</b>
            </div>
            <div class="ai-card__top">
              <span>主要贡献</span><b class="mono">{{ aiTopText }}</b>
            </div>
          </template>
        </section>

        <div class="section-title"><span>神经群体</span><small>钙活动实时截面</small></div>
        <div class="metric-grid">
          <article>
            <span>群体平均活动</span><strong class="mono">{{ populationActivity == null ? '—' : populationActivity.toFixed(3) }}</strong><small>当前帧 · 全神经元均值</small>
          </article>
          <article>
            <span>高活动神经元</span><strong class="mono">{{ activeNeuronCount }}<em> / {{ store.neurons.length }}</em></strong><small>{{ activeFraction == null ? '—' : (activeFraction * 100).toFixed(1) + '%' }} · 个体基线 +1 SD</small>
          </article>
        </div>

        <div class="section-title"><span>功能网络</span><small>共活动连接，不代表解剖连接</small></div>
        <div class="network-row network-row--two">
          <div><span>当前连接</span><strong class="mono">{{ store.currentEdgeCount }}</strong></div>
          <div><span>连边密度</span><strong class="mono">{{ networkDensity == null ? '—' : (networkDensity * 100).toFixed(2) + '%' }}</strong></div>
        </div>

      </template>

      <template v-else>
        <div class="fig-rail">
          <button v-for="fig in FIGURES" :key="fig.id"
            :class="{ active: activeFigure === fig.id }" :title="fig.label"
            @click="activeFigure = fig.id">
            <b>{{ fig.num }}</b><span><strong>{{ fig.label }}</strong><small>{{ fig.short }}</small></span>
          </button>
        </div>
        <div class="figure-intro">
          <span>{{ activeFigureMeta.question }}</span>
          <p>{{ activeFigureMeta.description }}</p>
          <small>操作提示：{{ activeFigure === 'matrix' ? '移动鼠标查看数值，点击小格可定位神经元。' : activeFigure === 'pca' ? '点击圆点可跳转到对应时刻。' : activeFigure === 'timeline' ? '点击图中任意位置可跳转实验时间。' : '信号会跟随底部时间轴同步更新。' }}</small>
        </div>
        <div class="fig-body">
          <div v-if="loadState === 'loading'" class="fig-state"><span class="fig-spinner" />正在加载图表数据…</div>
          <div v-else-if="loadState === 'error'" class="fig-state is-error">图表数据加载失败<button @click="loadFigures">重试</button></div>
          <template v-else-if="dataset">
            <SynchronizedTimelineFigure v-show="activeFigure === 'timeline'" :frames="figureFrames" :current-timestamp="store.currentTimestamp" @seek="seek" />
            <PhysiologicalSignalFigure v-show="activeFigure === 'eeg'" :condition-id="conditionId" :frames="figureFrames" :current-timestamp="store.currentTimestamp" />
            <PCAManifoldFigure v-show="activeFigure === 'pca'" :frames="figureFrames" :active="activeFigure === 'pca'" @seek="seek" />
            <ConnectivityMatrixFigure v-show="activeFigure === 'matrix'" :frames="figureFrames" :active="activeFigure === 'matrix'" @select-neuron="locateIn3D" />
          </template>
        </div>
      </template>
    </template>

    <div v-else class="empty-dashboard"><strong>等待实验数据</strong><span>完成一致性复核后展示实时神经与网络指标。</span></div>
  </section>
</template>

<style scoped>
.dashboard{flex:1;min-height:0;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px;box-shadow:var(--shadow-sm)}
.dash-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}.dash-head>div:first-child{display:grid;gap:2px}.kicker,.section-title span{font-size: 11px;letter-spacing:1.2px;color:var(--brand-text);font-weight:800}.dash-head strong{font-size: 14.5px;color:var(--text-strong)}
.view-switch{display:flex;gap:2px;padding:2px;background:var(--bg-subtle);border-radius:7px;flex:0 0 auto}.view-switch button{border:0;background:transparent;color:var(--text-faint);font-size: 12px;padding:4px 9px;border-radius:5px;transition:all var(--dur)}.view-switch button.active{background:var(--surface);color:var(--brand-text);font-weight:700;box-shadow:var(--shadow-sm)}
.state-card{display:grid;grid-template-columns:1fr 1px 1fr auto;align-items:center;gap:10px;padding:11px;background:linear-gradient(135deg,var(--brand-soft),rgba(139,124,246,.08));border:1px solid var(--brand-line);border-radius:9px}.state-card>div{display:grid}.state-card span{font-size: 9.5px;color:var(--text-faint)}.state-card strong{font-size: 15.5px;color:var(--text-strong);text-transform:capitalize}.state-card>i{width:1px;height:25px;background:var(--border-strong)}.state-card time{font-size: 11px;color:var(--brand-text)}
/* AI 神经解码证据卡片 */
.ai-card{margin-top:10px;padding:11px;border:1px solid var(--border);border-left:3px solid var(--tag-purple);border-radius:9px;background:var(--surface);box-shadow:var(--shadow-sm)}
.ai-card__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.ai-card__head strong{font-size: 13px;color:var(--text-strong)}
.ai-card__method{font-size: 9px;color:var(--text-faint);border:1px solid var(--border);border-radius:10px;padding:2px 6px}
.ai-card__state{display:flex;align-items:center;gap:8px;min-height:44px;color:var(--text-faint);font-size: 12px}
.ai-card__state.is-error{color:var(--warn)}
.ai-card__state button{margin-left:auto;padding:4px 10px;border:1px solid var(--brand-line);border-radius:6px;background:var(--surface);color:var(--brand-text);font-size: 11.5px}
.ai-card__spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--brand-soft);border-top-color:var(--brand);animation:fig-rot .8s linear infinite}
.ai-card__row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:3px 0;font-size: 12px}
.ai-card__row span{color:var(--text-faint);font-size: 10.5px;flex:0 0 auto}
.ai-card__row b{color:var(--text-strong);font-weight:600;text-align:right}
.ai-card__row em{font-style:normal;color:var(--text-faint);font-size: 10px;margin-left:6px}
.ai-card__module{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:7px;padding:8px 10px;border-radius:7px;background:color-mix(in srgb,var(--module-color) 10%,var(--bg-subtle));border:1px solid color-mix(in srgb,var(--module-color) 35%,var(--border))}
.ai-card__module>div{display:grid;gap:1px}
.ai-card__module strong{font-size: 12.5px;color:var(--text-strong)}
.ai-card__module span{font-size: 9.5px;color:var(--text-faint)}
.ai-card__module b{font-size: 15px;color:var(--module-color)}
.ai-card__top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:7px;font-size: 11px}
.ai-card__top span{color:var(--text-faint);font-size: 10px}
.ai-card__top b{color:var(--text-muted);font-size: 10.5px;text-align:right}
.section-title{display:flex;justify-content:space-between;align-items:center;margin:13px 1px 6px}.section-title small{font-size: 9.5px;color:var(--text-faint)}
.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.metric-grid article{display:grid;gap:2px;padding:9px;background:var(--bg-subtle);border-radius:8px}.metric-grid span,.network-row span{font-size: 10px;color:var(--text-faint)}.metric-grid strong{font-size: 20.5px;color:var(--text-strong)}.metric-grid em{font-size: 11px;color:var(--text-faint);font-style:normal}.metric-grid small{font-size: 9px;color:var(--text-faint)}
.network-row{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.network-row--two{grid-template-columns:1fr 1fr}.network-row>div{display:grid;gap:1px;padding:8px;background:var(--bg-subtle);border-left:2px solid var(--tag-purple);border-radius:6px}.network-row strong{font-size: 14.5px;color:var(--text-strong)}
.empty-dashboard{min-height:180px;display:grid;place-content:center;text-align:center;gap:5px}.empty-dashboard strong{color:var(--text-strong)}.empty-dashboard span{max-width:230px;color:var(--text-faint);font-size: 12px;line-height:1.6}
.fig-rail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:10px}.fig-rail button{display:grid;grid-template-columns:30px 1fr;align-items:center;gap:8px;padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface-alt);color:var(--text-faint);text-align:left;transition:all var(--dur)}.fig-rail button>b{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--bg-subtle);font-family:var(--font-mono);font-size:10px}.fig-rail button>span{display:grid;gap:2px;min-width:0}.fig-rail button strong{color:var(--text);font-size:12.5px}.fig-rail button small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-faint);font-size:9.5px}.fig-rail button:hover{border-color:var(--brand-line);transform:translateY(-1px)}.fig-rail button.active{border-color:var(--brand);background:var(--brand-soft);color:var(--brand-text);box-shadow:var(--shadow-sm)}.fig-rail button.active>b{background:var(--brand);color:#fff}
.figure-intro{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin-bottom:10px;padding:10px 12px;border-radius:9px;background:linear-gradient(135deg,var(--brand-soft),rgba(139,124,246,.07));border:1px solid var(--brand-line)}.figure-intro>span{grid-row:1/3;color:var(--brand-text);font-size:11px;font-weight:800}.figure-intro p{margin:0;color:var(--text-muted);font-size:11.5px;line-height:1.55}.figure-intro small{color:var(--text-faint);font-size:10px}
.fig-body{min-height:0;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface-alt)}
.fig-state{display:flex;align-items:center;justify-content:center;gap:10px;min-height:200px;color:var(--text-faint);font-size: 14.5px}.fig-state.is-error{color:var(--warn)}.fig-state button{padding:5px 12px;border:1px solid var(--brand-line);border-radius:7px;background:var(--surface);color:var(--brand-text);font-size: 13px}
.fig-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--brand-soft);border-top-color:var(--brand);animation:fig-rot .8s linear infinite}
@keyframes fig-rot{to{transform:rotate(360deg)}}
@media (max-width:560px){.fig-rail{grid-template-columns:1fr}.figure-intro{grid-template-columns:1fr}.figure-intro>span{grid-row:auto}}
</style>
