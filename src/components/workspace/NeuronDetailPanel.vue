<script setup lang="ts">
import { computed } from 'vue'
import AppBadge from '@/components/ui/AppBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { withBehaviorZh } from '@/utils/behaviorLabels'

const store = useWorkspaceStore()
const neuron = computed(() => store.selectedNeuron)

/* 行为解码贡献模块画像（离线计算，成员关系固定） */
const profile = computed(() => {
  const id = neuron.value?.id
  if (!id) return null
  return store.neuronModuleProfiles.find(p => p.neuronId === id) ?? null
})

const profileModule = computed(() => {
  const moduleId = profile.value?.primaryModuleId
  if (!moduleId) return null
  return store.decoderModules.find(m => m.id === moduleId) ?? null
})

/* 当前帧贡献：随播放更新，仅排名进入 Top N 的帧有记录 */
const frameContribution = computed(() => {
  const id = neuron.value?.id
  const evidence = store.currentModuleEvidence
  if (!id || !evidence) return null
  return evidence.topNeurons.find(t => t.neuronId === id) ?? null
})

const rows = computed(() => {
  if (!neuron.value) return []
  const numberOrDash = (value: number | undefined, digits: number) => value === undefined ? '—' : value.toFixed(digits)
  const unassigned = '未归入特定行为模块'
  const contributionText = (() => {
    const item = frameContribution.value
    if (!item) return '当前帧无记录'
    const sign = item.contribution >= 0 ? '+' : '−'
    return `${sign}${Math.abs(item.contribution).toFixed(2)}（${item.contribution >= 0 ? '支持' : '抑制'}）`
  })()
  return [
    { k: '神经元 ID', v: neuron.value.id, mono: true },
    { k: '当前活动强度', v: neuron.value.activity.toFixed(2), mono: true },
    { k: '重要性', v: numberOrDash(neuron.value.importance, 2), mono: true },
    { k: '效应量', v: numberOrDash(neuron.value.effectSize, 2), mono: true },
    { k: 'q 值', v: numberOrDash(neuron.value.qValue, 3), mono: true },
    { k: '消融 Δ', v: numberOrDash(neuron.value.ablationDelta, 2), mono: true },
    { k: '主要支持行为', v: profile.value?.primaryTargetLabel ? withBehaviorZh(profile.value.primaryTargetLabel) : unassigned },
    { k: '所属贡献模块', v: profileModule.value?.name ?? unassigned },
    { k: '模块归属强度（离线）', v: profile.value?.membershipScore == null ? '—' : `${(profile.value.membershipScore * 100).toFixed(1)}%`, mono: true },
    { k: '当前帧贡献', v: contributionText, mono: true },
    { k: '当前模块排名', v: frameContribution.value ? `Top ${(store.currentModuleEvidence?.topNeurons.indexOf(frameContribution.value) ?? 0) + 1}` : '当前帧未进 Top', mono: true },
  ]
})

const moduleBadge = computed(() => profileModule.value?.name ?? null)
const moduleBadgeColor = computed(() => profileModule.value?.color ?? undefined)

const trace = computed(() => {
  const values = neuron.value?.activityTrace ?? []
  if (!values.length) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(max - min, 0.0001)
  const step = Math.max(1, Math.floor(values.length / 120))
  const sampled = values.filter((_, index) => index % step === 0)
  return sampled.map((value, index) => `${(index / Math.max(1, sampled.length - 1)) * 320},${(110 - ((value - min) / span) * 100).toFixed(1)}`).join(' ')
})
</script>

<template>
  <div class="neuron">
    <div class="neuron__head">
      <span class="neuron__title">单神经元详情</span>
      <button class="neuron__clear" v-if="neuron" @click="store.selectNeuron(null)">关闭</button>
    </div>

    <template v-if="neuron">
      <div class="neuron__summary">
        <div class="neuron__badge"><span class="neuron__id mono">{{ neuron.id }}</span></div>
        <AppBadge v-if="moduleBadge" tone="teal" class="neuron__module" :style="moduleBadgeColor ? { borderColor: moduleBadgeColor, color: moduleBadgeColor } : undefined">{{ moduleBadge }}</AppBadge>
        <AppBadge v-else tone="slate" class="neuron__module">未归入特定行为模块</AppBadge>
      </div>

      <div class="neuron__trace">
        <div class="neuron__trace-label">活动曲线 <span class="mono">(calcium.csv)</span></div>
        <svg class="trace-svg" viewBox="0 0 320 120" preserveAspectRatio="none">
          <line v-for="i in [0,30,60,90,120]" :key="i" x1="0" x2="320" :y1="i" :y2="i" class="trace-grid"/>
          <polyline :points="trace" class="trace-line"/>
          <circle cx="160" cy="120" r="0"/>
        </svg>
      </div>

      <dl class="neuron__rows">
        <div v-for="r in rows" :key="r.k" class="neuron__row">
          <dt>{{ r.k }}</dt>
          <dd :class="{ mono: r.mono }">{{ r.v }}</dd>
        </div>
      </dl>
    </template>

    <div v-else class="neuron__empty">
      <EmptyState title="未选择神经元" hint="在神经元列表中选中一项以查看其活动与统计证据。" />
    </div>
  </div>
</template>

<style scoped>
.neuron { display:flex; flex-direction:column; }
.neuron__head { display:flex; align-items:center; justify-content:space-between; padding: 14px 18px; border-bottom:1px solid var(--border); }
.neuron__title { font-weight:600; color: var(--text); font-size: 15.5px; }
.neuron__clear { border:0; background:transparent; color: var(--text-faint); font-size: 14.5px; }
.neuron__clear:hover { color: var(--danger); }
.neuron__summary { display:flex; align-items:center; gap:10px; padding: 16px 18px 6px; }
.neuron__badge { background: var(--brand); color:#fff; border-radius:9px; padding: 5px 12px; box-shadow: 0 3px 8px rgba(15,157,143,.24); }
.neuron__id { font-size: 17px; font-weight:700; }
.neuron__trace { padding: 10px 18px; }
.neuron__trace-label { font-size: 13px; color: var(--text-faint); margin-bottom: 6px; }
.trace-svg { width:100%; height: 96px; display:block; background: var(--bg-subtle); border-radius:8px; }
.trace-grid { stroke: var(--border); stroke-width:1; }
.trace-line { fill:none; stroke: var(--brand); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
.neuron__rows { padding: 6px 18px 16px; margin:0; }
.neuron__row { display:flex; align-items:center; justify-content:space-between; padding: 7px 0; border-bottom:1px dashed var(--border); font-size: 15px; }
.neuron__row:last-child { border-bottom:0; }
.neuron__row dt { color: var(--text-muted); }
.neuron__row dd { margin:0; color: var(--text-strong); font-weight:600; }
</style>
