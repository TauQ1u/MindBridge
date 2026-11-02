<script setup lang="ts">
import { onBeforeUnmount, onMounted, computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ExperimentSelectionModal from '@/components/workspace/ExperimentSelectionModal.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const router = useRouter()
const modalOpen = ref(false)

const exp = computed(() => store.selectedExperiment)
const run = computed(() => store.processingRun)

type NodeState = 'waiting' | 'running' | 'completed' | 'failed'
interface Row { id: string; label: string; detail?: string; state: NodeState }
interface Stage { id: string; index: string; title: string; desc: string; rows: Row[]; action?: 'review' }

/** 后端固定处理管线阶段顺序（与 processingApi 的 RUN_PIPELINE 对应） */
const STAGE_ORDER: Record<string, number> = {
  video: 1,
  decode: 2,
  'review-package': 3,
  visualization: 4,
}

/** 行状态由 Store 中的后端任务状态推导，页面不再自行模拟进度 */
function stageState(stageId: string): NodeState {
  const current = run.value
  if (!current) return 'waiting'
  const order = STAGE_ORDER[stageId] ?? 0
  const reached = current.status === 'ready' ? Number.MAX_SAFE_INTEGER : (current.stage?.index ?? 0)
  if (current.status === 'failed') return order < reached ? 'completed' : order === reached ? 'failed' : 'waiting'
  return order < reached ? 'completed' : order === reached ? 'running' : 'waiting'
}
const stateOf = (id: string) => stageState(id)

const stages = computed<Stage[]>(() => {
  const e = exp.value
  const done: NodeState = 'completed'
  const wait: NodeState = 'waiting'
  return [
    {
      id: 'input', index: '01', title: '数据接入', desc: '三种模态原始数据',
      rows: [
        { id: 'input-video', label: '行为视频', state: e?.video ? done : wait },
        { id: 'input-calcium', label: '钙成像', state: e?.calcium ? done : wait },
        { id: 'input-eeg', label: 'EEG / EMG', state: e?.eegEmg ? done : wait },
      ],
    },
    {
      id: 'analysis', index: '02', title: '智能分析', desc: '多模态信号分析',
      rows: [
        { id: 'video', label: '行为视频识别', detail: '识别动物行为状态并评估结果可信度', state: stateOf('video') },
        { id: 'decode', label: '钙神经信号分析', detail: '提取神经活动特征并生成状态标签', state: stateOf('decode') },
        { id: 'sleep', label: 'EEG / EMG 睡眠分期', detail: '结合脑电与肌电信号识别睡眠阶段', state: e?.eegEmg ? done : wait },
      ],
    },
    {
      id: 'review-package', index: '03', title: '时间轴对齐与复核准备', desc: '统一时间基准',
      rows: [
        { id: 'align', label: '多模态时间轴对齐', detail: '统一行为视频、钙成像与脑电肌电的时间基准', state: stateOf('review-package') },
        { id: 'conflicts', label: '待复核片段定位', detail: '自动标记可信度较低或结果不一致的片段', state: stateOf('review-package') },
      ],
    },
    {
      id: 'visualization', index: '04', title: '3D 建模数据', desc: '生成神经网络可视化数据',
      rows: [
        { id: 'viz', label: '3D 建模数据生成', detail: '神经活动 · 动态功能连接 · 建模参数', state: stateOf('visualization') },
        { id: 'verdict', label: '人工复核与结果确认', detail: '进入复核工作台确认最终状态标签', state: e?.imported ? done : wait },
      ],
      action: 'review',
    },
  ]
})

const readyForReview = computed(() => run.value?.status === 'ready')
const failed = computed(() => run.value?.status === 'failed')
const activeTaskLabel = computed(() => run.value?.stage?.label ?? '')
const progressPct = computed(() => run.value ? `${run.value.progress}%` : '—')
const stateLabel: Record<NodeState, string> = { waiting: '等待', running: '运行中', completed: '已完成', failed: '失败' }

async function goReview() {
  if (!exp.value) return
  await store.openReview()
  router.push('/review')
}

onMounted(async () => {
  if (!store.selectedExperiment) await store.loadExperiments()
  // 已选择实验但还没有任务（例如直接刷新本页）时，向后端补建一个处理任务
  else if (!store.processingRun && !store.processingError) void store.createProcessingRun()
})
watch(() => store.selectedExperiment, (experiment, previous) => {
  if (experiment && experiment !== previous) void store.createProcessingRun(experiment.experimentId)
})
onBeforeUnmount(() => store.stopProcessingPolling())
</script>

<template>
  <div class="proc">
    <section v-if="!exp" class="proc__empty">
      <EmptyState title="尚未选择实验数据" hint="从数据中心选择服务器已发现的实验，查看其多模态处理流程。" />
      <AppButton variant="primary" size="md" icon="plus" @click="modalOpen = true">选择实验数据</AppButton>
    </section>

    <template v-else>
      <header class="proc__head">
        <div>
          <h1>数据处理流程</h1>
        </div>
        <div class="proc__exp">
          <span>当前实验</span>
          <strong class="mono">{{ exp.experimentId.replace(exp.condition, exp.displayName) }}</strong>
        </div>
      </header>

      <div class="proc__status" :class="{ done: readyForReview, failed }">
        <span v-if="store.processingError && !run">任务启动失败 · {{ store.processingError }}</span>
        <span v-else-if="failed">处理任务失败，请重试</span>
        <span v-else>{{ activeTaskLabel ? `正在处理 · ${activeTaskLabel}` : readyForReview ? '自动处理完成，可以进入人工复核' : '正在准备处理任务…' }}</span>
        <strong class="mono">{{ progressPct }}</strong>
      </div>

      <!-- 四阶段横向流程：按后端状态依次显现 -->
      <div class="flow">
        <template v-for="(stage, i) in stages" :key="stage.id">
          <section class="stage" :style="{ '--stage-delay': `${i * 140}ms` }">
            <div class="stage__head">
              <span class="stage__index">{{ stage.index }}</span>
              <div><h3>{{ stage.title }}</h3><p>{{ stage.desc }}</p></div>
            </div>
            <div class="stage__rows">
              <div v-for="row in stage.rows" :key="row.id" class="row" :class="`is-${row.state}`">
                <i class="row__dot"></i>
                <div class="row__body">
                  <strong>{{ row.label }}</strong>
                  <small v-if="row.detail">{{ row.detail }}</small>
                </div>
                <span class="row__state">{{ stateLabel[row.state] }}</span>
              </div>
            </div>
            <button v-if="stage.action === 'review'" class="stage__action" :disabled="!readyForReview" @click="goReview">
              进入一致性复核 →
            </button>
          </section>
          <span v-if="i < stages.length - 1" class="flow__arrow" :style="{ '--arrow-delay': `${i * 140 + 110}ms` }">→</span>
        </template>
      </div>

      <p class="proc__note" v-if="exp?.imported">该实验已完成一致性复核，可重新进入复核工作台查看或修正最终标签。</p>
    </template>

    <ExperimentSelectionModal :open="modalOpen" @close="modalOpen = false" />
  </div>
</template>

<style scoped>
.proc { max-width: var(--layout-max); margin: 0 auto; padding: 28px 32px 40px; min-height: calc(100vh - var(--topbar-h)); display: flex; flex-direction: column; }
.proc__empty { display: flex; flex-direction: column; align-items: center; gap: 16px; margin: auto 0; }
.proc__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 26px; }
.proc__head h1 { font-size: 26.5px; color: var(--text-strong); letter-spacing: -.3px; }
.proc__head p { margin-top: 6px; color: var(--text-faint); font-size: 15px; }
.proc__exp { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 16px; display: flex; flex-direction: column; gap: 3px; box-shadow: var(--shadow-sm); }
.proc__exp span { font-size: 12px; color: var(--text-faint); }
.proc__exp strong { font-size: 15.5px; color: var(--text-strong); }
.proc__status { display:flex; align-items:center; justify-content:space-between; margin:-12px 0 16px; padding:9px 12px; border:1px solid var(--brand-line); border-radius:9px; background:var(--brand-soft); color:var(--brand-text); font-size: 13px; }
.proc__status.done { border-color:color-mix(in srgb,var(--ok) 30%,transparent); background:var(--ok-soft); color:var(--ok); }
.proc__status.failed { border-color:color-mix(in srgb,var(--danger) 30%,transparent); background:var(--danger-soft); color:var(--danger); }
.proc__status strong { font-size: 12px; }

.flow { flex: 1; display: flex; align-items: stretch; gap: 10px; }
.stage { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px 16px; box-shadow: var(--shadow-sm); transition: box-shadow var(--dur); opacity: 0; transform: translateY(12px); animation: stage-in .48s var(--ease) forwards; animation-delay: var(--stage-delay); }
.stage:hover { box-shadow: var(--shadow-md); }
.stage__head { display: flex; gap: 12px; align-items: center; padding-bottom: 14px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.stage__index { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font: 700 13px var(--font-mono); color: #fff; background: linear-gradient(135deg, #2f7ef7, #6ba3ff); box-shadow: 0 4px 10px rgba(47,126,247,.25); }
.stage__head h3 { font-size: 18px; color: var(--text-strong); }
.stage__head p { font-size: 13px; color: var(--text-faint); margin-top: 2px; }
.stage__rows { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 9px; background: var(--bg-subtle); border: 1px solid transparent; }
.row__dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--neutral); }
.row__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.row__body strong { font-size: 14.5px; color: var(--text); }
.row__body small { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row__state { font-size: 12px; color: var(--text-faint); }
.row.is-completed { background: var(--ok-soft); }
.row.is-completed .row__dot { background: var(--ok); box-shadow: 0 0 0 3px rgba(31,170,107,.15); }
.row.is-completed .row__state { color: var(--ok); font-weight: 600; }
.row.is-running { border-color: var(--brand-line); }
.row.is-running .row__dot { background: var(--info); animation: task-pulse 1s ease-in-out infinite; }
.row.is-completed { animation: task-complete .35s var(--ease); }
.row.is-running .row__state { color: var(--info); }
.row.is-failed { background: var(--danger-soft); }
.row.is-failed .row__dot { background: var(--danger); }
.row.is-failed .row__state { color: var(--danger); }
.stage__action { margin-top: 12px; padding: 10px; border: 0; border-radius: 9px; background: var(--brand); color: #fff; font-size: 15px; font-weight: 600; box-shadow: 0 4px 12px rgba(47,126,247,.24); transition: all var(--dur); }
.stage__action:hover:not(:disabled) { background: var(--brand-strong); }
.stage__action:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
.stage__action.is-ghost { background: var(--bg-subtle); color: var(--text-muted); box-shadow: none; }
.stage__action.is-ghost:hover { background: var(--brand-soft); color: var(--brand-text); }
.flow__arrow { align-self: center; color: var(--brand); font-size: 19px; font-weight: 700; flex: 0 0 auto; opacity: 0; animation: arrow-in .28s var(--ease) forwards; animation-delay: var(--arrow-delay, 110ms); }
@keyframes stage-in { to { opacity: 1; transform: translateY(0); } }
@keyframes arrow-in { to { opacity: 1; transform: translateX(0); } }
@keyframes task-pulse { 50% { box-shadow: 0 0 0 5px rgba(47,126,247,.16); transform:scale(1.12); } }
@keyframes task-complete { from { transform:translateY(2px); filter:saturate(.5); } to { transform:none; filter:none; } }
@media (prefers-reduced-motion: reduce) { .stage, .flow__arrow { animation: none; opacity: 1; transform: none; } }
.proc__note { margin-top: 18px; color: var(--text-faint); font-size: 13px; text-align: center; }
@media (max-width: 1100px) { .flow { flex-direction: column; } .flow__arrow { transform: rotate(90deg); } }
</style>
