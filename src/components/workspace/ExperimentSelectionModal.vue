<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppModal from '@/components/ui/AppModal.vue'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Experiment } from '@/types/models'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const store = useWorkspaceStore()
const loading = ref(false)
const error = ref(false)

onMounted(async () => {
  loading.value = true
  error.value = false
  try {
    await store.loadExperiments()
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
})

// 三种原始模态：系统真实接收的初始数据
const modalities = [
  { key: 'video' as const, label: '行为视频', file: 'video.mp4' },
  { key: 'calcium' as const, label: '钙成像', file: 'calcium_traces.csv' },
  { key: 'eegEmg' as const, label: 'EEG / EMG', file: 'eeg_emg.csv' },
]

const stageLabel = (e: Experiment) => (e.imported ? '科研工作区已就绪' : e.stage === 'visualization' ? '可视化数据已就绪' : e.stage === 'review' ? '待一致性复核' : '原始数据已发现')
const stageTone = (e: Experiment) => (e.imported ? 'ok' : e.stage === 'review' ? 'purple' : 'blue') as 'ok' | 'purple' | 'blue'
const actionLabel = (e: Experiment) => (e.imported ? '进入工作区' : '开始处理')

async function choose(e: Experiment) {
  emit('close')
  if (e.imported) {
    await store.switchCondition(e)
    await router.push('/mpfc')
    return
  }
  store.selectExperiment(e)
  await router.push('/processing')
}</script>

<template>
  <AppModal :open="props.open" title="选择实验数据" sub="选择服务器已发现的实验，进入数据处理与一致性复核" width="880px" @close="emit('close')">
    <div class="picker" v-if="!loading && !error">
      <div class="picker__bar">
        <span class="picker__count">服务器已发现 {{ store.experiments.length }} 组小鼠实验数据</span>
      </div>

      <div class="cards">
        <div v-for="e in store.experiments" :key="e.experimentId" class="card" :class="{ imported: e.imported }">
          <div class="card__main">
            <div class="card__id">
              <strong class="mono">{{ e.experimentId.replace(e.condition, e.displayName) }}</strong>
            </div>
            <AppBadge tone="teal">{{ e.displayName }}</AppBadge>
          </div>

          <div class="card__mods">
            <div v-for="m in modalities" :key="m.key" class="mod" :class="{ ok: e[m.key] }" :title="m.file">
              <i>{{ e[m.key] ? '✓' : '—' }}</i>
              <span>{{ m.label }}</span>
            </div>
          </div>

          <div class="card__side">
            <AppBadge :tone="stageTone(e)">{{ stageLabel(e) }}</AppBadge>
            <AppButton size="sm" :variant="e.imported ? 'ghost' : 'primary'" @click.stop="choose(e)">{{ actionLabel(e) }}</AppButton>
          </div>
        </div>
      </div>

    </div>
    <div v-else-if="loading" class="picker-state"><div class="spinner"></div><p>正在读取实验列表…</p></div>
    <div v-else class="picker-state"><EmptyState title="读取实验列表失败" hint="请确认后端服务状态后重试。" /></div>
  </AppModal>
</template>

<style scoped>
.picker { padding: 4px 22px 16px; }
.picker__bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0 12px; }
.picker__count { font-weight: 600; color: var(--text); font-size: 15.5px; }
.cards { display: grid; gap: 10px; }
.card { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.6fr) auto; gap: 16px; align-items: center; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); transition: all var(--dur); }
.card:hover { border-color: var(--brand-line); box-shadow: var(--shadow-sm); }
.card.imported { background: var(--surface-alt); }
.card__main { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.card__id { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.card__id strong { color: var(--text-strong); font-size: 15.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card__mods { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.mod { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 8px; background: var(--bg-subtle); color: var(--text-faint); font-size: 13px; }
.mod i { font-style: normal; font-weight: 700; color: var(--text-faint); }
.mod.ok { background: var(--ok-soft); color: var(--text); }
.mod.ok i { color: var(--ok); }
.card__side { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.picker__foot-note { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: var(--surface-alt); border: 1px dashed var(--border-strong); color: var(--text-faint); font-size: 13px; line-height: 1.6; }
.picker-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 260px; }
.spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--brand-soft); border-top-color: var(--brand); animation: rot .7s linear infinite; }
.picker-state p { color: var(--text-faint); margin-top: 14px; }
@keyframes rot { to { transform: rotate(360deg); } }
@media (max-width: 760px) { .card { grid-template-columns: 1fr; } .card__side { flex-direction: row; justify-content: space-between; align-items: center; } }
</style>
