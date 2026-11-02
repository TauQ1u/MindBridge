<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppBadge from '@/components/ui/AppBadge.vue'
import SynchronizedTimelineFigure from '@/components/panel/SynchronizedTimelineFigure.vue'
import PhysiologicalSignalFigure from '@/components/panel/PhysiologicalSignalFigure.vue'
import PCAManifoldFigure from '@/components/panel/PCAManifoldFigure.vue'
import ConnectivityMatrixFigure from '@/components/panel/ConnectivityMatrixFigure.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { visualizationApi, type VisualizationDataset } from '@/services/api/visualizationApi'
import { formatTimestamp } from '@/utils/time'

/*
 * 单条件数据面板（/mpfc/condition/:conditionId）。
 * 只回答“当前 Condition 的记录与整体神经模式”：
 * 四张核心图每次突出一张；顶部不出现 Reference / Δ / Recovery。
 * 时间与 3D 工作区共享同一 currentTimestamp。
 */

type PanelTab = 'timeline' | 'eeg' | 'pca' | 'matrix'

const route = useRoute()
const router = useRouter()
const store = useWorkspaceStore()

const tabs: Array<{ id: PanelTab; label: string }> = [
  { id: 'timeline', label: '多模态同步时间轴' },
  { id: 'eeg', label: 'EEG / EMG' },
  { id: 'pca', label: 'PCA 神经流形' },
  { id: 'matrix', label: '功能连接矩阵' },
]
const activeTab = ref<PanelTab>('timeline')

const conditionId = computed(() => String(route.params.conditionId ?? ''))
const dataset = ref<VisualizationDataset | null>(null)
const loadState = ref<'loading' | 'ready' | 'error' | 'missing'>('loading')
const errorMessage = ref('')

const experiment = computed(() => store.experiments.find((item) => item.condition === conditionId.value) ?? null)
const frames = computed(() => dataset.value?.frames ?? [])
const duration = computed(() => frames.value.length > 0 ? Number(frames.value[frames.value.length - 1].stamp) : 0)
const neuronCount = computed(() => dataset.value?.positions.size ?? 0)
const samplingHz = computed(() => {
  if (frames.value.length < 2 || duration.value <= 0) return 0
  return (frames.value.length - 1) / duration.value
})

async function load() {
  if (!conditionId.value) { loadState.value = 'missing'; return }
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    if (!store.experiments.length) await store.loadExperiments()
    if (experiment.value && store.selectedExperiment?.condition !== conditionId.value) {
      await store.switchCondition(experiment.value)
    }
    dataset.value = await visualizationApi.loadCondition(conditionId.value)
    loadState.value = experiment.value ? 'ready' : 'missing'
  } catch (error) {
    loadState.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '数据加载失败'
  }
}

function seek(timestamp: number) {
  store.setTimestamp(timestamp)
}

function locateIn3D(neuronId: string) {
  const neuron = store.neurons.find((item) => item.id === neuronId)
  if (neuron) store.selectNeuron(neuron)
  void router.push('/mpfc')
}

onMounted(load)
watch(conditionId, load)
</script>

<template>
  <div class="panel-page">
    <header v-if="loadState === 'ready' && experiment" class="panel-head">
      <div class="panel-head__info">
        <div class="panel-head__title">
          <strong>{{ experiment.mouseId }} · {{ experiment.displayName }}</strong>
          <AppBadge tone="teal">{{ conditionId }}</AppBadge>
          <AppBadge :tone="experiment.imported ? 'ok' : 'purple'">{{ experiment.imported ? '复核完成 ✓' : '待复核' }}</AppBadge>
        </div>
        <div class="panel-head__meta mono">
          <span>记录时长 {{ formatTimestamp(duration) }}</span>
          <span>{{ neuronCount }} 个神经元</span>
          <span v-if="samplingHz">采样 {{ samplingHz.toFixed(2) }} Hz</span>
        </div>
      </div>
      <div class="panel-head__actions">
        <button class="ghost" type="button" @click="router.push('/mpfc')">← 返回 3D 工作区</button>
        <button class="primary" type="button" :disabled="store.loadedExperiments.length < 2" @click="router.push('/analysis')">多条件对比分析</button>
      </div>
    </header>

    <nav v-if="loadState === 'ready'" class="panel-tabs">
      <button v-for="tab in tabs" :key="tab.id" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">
        {{ tab.label }}
      </button>
    </nav>

    <main class="panel-body">
      <div v-if="loadState === 'loading'" class="panel-state">
        <span class="panel-spinner" />正在加载当前条件的数据记录…
      </div>
      <div v-else-if="loadState === 'error'" class="panel-state is-error">
        <strong>数据加载失败</strong><span>{{ errorMessage }}</span><button @click="load">重试</button>
      </div>
      <div v-else-if="loadState === 'missing'" class="panel-state">
        <strong>未找到该条件的实验数据</strong><span>请从数据中心选择服务器已发现并完成处理的实验。</span>
      </div>

      <template v-else>
        <section v-show="activeTab === 'timeline'" class="figure-wrap">
          <h2>多模态同步时间轴</h2>
          <SynchronizedTimelineFigure :frames="frames" :current-timestamp="store.currentTimestamp" @seek="seek" />
        </section>
        <section v-show="activeTab === 'eeg'" class="figure-wrap">
          <h2>EEG / EMG 生理信号</h2>
          <PhysiologicalSignalFigure :condition-id="conditionId" :frames="frames" :current-timestamp="store.currentTimestamp" @seek="seek" />
        </section>
        <section v-show="activeTab === 'pca'" class="figure-wrap">
          <h2>PCA 神经流形</h2>
          <PCAManifoldFigure :frames="frames" :active="activeTab === 'pca'" @seek="seek" />
        </section>
        <section v-show="activeTab === 'matrix'" class="figure-wrap">
          <h2>功能连接矩阵</h2>
          <ConnectivityMatrixFigure :frames="frames" :active="activeTab === 'matrix'" @select-neuron="locateIn3D" />
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.panel-page { max-width: var(--layout-max); margin: 0 auto; padding: 20px 28px 40px; min-height: calc(100vh - var(--topbar-h)); display: flex; flex-direction: column; gap: 14px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
.panel-head__info { display: grid; gap: 7px; }
.panel-head__title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.panel-head__title strong { font-size: 23px; color: var(--text-strong); letter-spacing: -.2px; }
.panel-head__meta { display: flex; gap: 16px; color: var(--text-faint); font-size: 14px; }
.panel-head__actions { display: flex; gap: 8px; }
.panel-head__actions button { padding: 8px 14px; border-radius: 8px; font-size: 14.5px; font-weight: 600; transition: all var(--dur); }
.panel-head__actions .ghost { border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); }
.panel-head__actions .ghost:hover { border-color: var(--brand); color: var(--brand-text); }
.panel-head__actions .primary { border: 0; background: var(--brand); color: #fff; box-shadow: 0 4px 12px rgba(47,126,247,.24); }
.panel-head__actions .primary:hover:not(:disabled) { background: var(--brand-strong); }
.panel-head__actions .primary:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
.panel-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.panel-tabs button { padding: 10px 16px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-muted); font-size: 15.5px; white-space: nowrap; }
.panel-tabs button:hover { color: var(--text-strong); }
.panel-tabs button.active { color: var(--brand-text); border-bottom-color: var(--brand); font-weight: 600; }
.panel-body { flex: 1; min-height: 0; }
.panel-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 320px; color: var(--text-faint); font-size: 15.5px; }
.panel-state.is-error { color: var(--danger); }
.panel-state button { margin-top: 4px; padding: 7px 16px; border: 1px solid var(--brand-line); border-radius: 8px; background: var(--surface); color: var(--brand-text); font-size: 14.5px; }
.panel-spinner { width: 22px; height: 22px; border-radius: 50%; border: 3px solid var(--brand-soft); border-top-color: var(--brand); animation: panel-rot .8s linear infinite; }
@keyframes panel-rot { to { transform: rotate(360deg); } }
.figure-wrap { display: grid; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px; box-shadow: var(--shadow-sm); }
.figure-wrap h2 { font-size: 18px; color: var(--text-strong); }
</style>
