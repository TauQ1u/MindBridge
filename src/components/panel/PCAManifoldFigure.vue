<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { getBehaviorConfig } from '@neuron3d/neuron/neuronUtils'
import type { NeuronFrame } from '@neuron3d/neuron/neuronUtils'
import { computePca, type PcaResult } from '@/utils/panelCompute'
import { formatTimestamp } from '@/utils/time'

/*
 * Figure：PCA 神经流形。
 * 每个点 = 一个时刻的 117 神经元整体活动投影到前 2 主成分；
 * 颜色可按行为 / 睡眠阶段切换；显示 PC1 / PC2 方差解释率；
 * 点击点跳转到对应时刻（返回 3D 同一时间点）。
 * 这是单条件 PCA，不是 Shared State Space，不可跨条件比较。
 */

const props = defineProps<{
  frames: NeuronFrame[]
  active: boolean
}>()
const emit = defineEmits<{ seek: [timestamp: number] }>()

const colorBy = ref<'行为' | '睡眠阶段'>('行为')
const pca = ref<PcaResult | null>(null)
const state = ref<'idle' | 'computing' | 'ready' | 'error'>('idle')

const neuronIds = computed(() =>
  props.frames[0] ? Object.keys(props.frames[0].values).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) : [],
)

const W = 860
const H = 460

function labelOf(frame: NeuronFrame): string {
  return colorBy.value === '行为' ? (frame.behavior || 'unknown') : (frame.sleepStage || '')
}
const meaning = (label: string) => colorBy.value === '行为' ? getBehaviorConfig(label).meaning : (label ? label.toUpperCase() : '无数据')
const pointColor = (label: string) => getBehaviorConfig(label).color

const plot = computed(() => {
  if (!pca.value || pca.value.points.length === 0) return []
  const points = pca.value.points
  const extentX = Math.max(...points.map((p) => Math.abs(p.x)), 1e-6)
  const extentY = Math.max(...points.map((p) => Math.abs(p.y)), 1e-6)
  return points.map((point, index) => ({
    index,
    cx: W / 2 + (point.x / extentX) * (W / 2 - 20),
    cy: H / 2 - (point.y / extentY) * (H / 2 - 20),
    label: labelOf(props.frames[index]),
    stamp: Number(props.frames[index].stamp),
  }))
})

const legend = computed(() => {
  const seen = new Map<string, string>()
  for (const item of plot.value) {
    if (!seen.has(item.label)) seen.set(item.label, pointColor(item.label))
  }
  return [...seen.entries()].map(([label, color]) => ({ label, meaning: meaning(label), color }))
})

let computeToken = 0
async function compute() {
  if (!props.active || state.value === 'computing' || (state.value === 'ready' && pca.value && pca.value.points.length === props.frames.length)) return
  if (props.frames.length === 0) return
  const token = ++computeToken
  state.value = 'computing'
  // 让出主线程先渲染“计算中”状态，再执行 PCA
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (token !== computeToken) return
  try {
    const result = computePca(props.frames, neuronIds.value)
    if (token !== computeToken) return
    pca.value = result
    state.value = 'ready'
  } catch {
    if (token !== computeToken) return
    state.value = 'error'
  }
}

function onPointClick(index: number) {
  const frame = props.frames[index]
  if (frame) emit('seek', Number(frame.stamp))
}

onMounted(compute)
watch(() => props.active, compute)
watch(() => props.frames, () => { if (state.value === 'ready') { state.value = 'idle'; pca.value = null; compute() } })
</script>

<template>
  <div class="pca-figure">
    <div class="pca-toolbar">
      <label>着色方式
        <select v-model="colorBy">
          <option value="行为">行为</option>
          <option value="睡眠阶段">睡眠阶段</option>
        </select>
      </label>
      <div class="pca-legend">
        <span v-for="item in legend" :key="item.label"><i :style="{ background: item.color }" />{{ item.meaning }}</span>
      </div>
    </div>

    <div v-if="state === 'computing'" class="pca-state"><span class="pca-spinner" />正在整理群体神经活动分布…</div>
    <div v-else-if="state === 'error'" class="pca-state is-error">活动分布图生成失败，请重试。</div>
    <svg v-else-if="state === 'ready'" :viewBox="`0 0 ${W} ${H}`" class="pca-svg">
      <line :x1="W / 2" y1="10" :x2="W / 2" :y2="H - 10" class="axis" />
      <line x1="20" :y1="H / 2" :x2="W - 20" :y2="H / 2" class="axis" />
      <circle v-for="point in plot" :key="point.index" :cx="point.cx" :cy="point.cy" r="3.2"
        :fill="pointColor(point.label)" opacity=".72" class="pca-point"
        @click="onPointClick(point.index)">
        <title>{{ meaning(point.label) }} · {{ formatTimestamp(point.stamp) }}</title>
      </circle>
    </svg>

    <div class="pca-foot">
      <span v-if="pca">横向信息覆盖 {{ (pca.explained[0] * 100).toFixed(1) }}% · 纵向信息覆盖 {{ (pca.explained[1] * 100).toFixed(1) }}%</span>
      <span>点越靠近，整体神经活动模式越相似 · 点击圆点可跳转到对应时刻</span>
    </div>
  </div>
</template>

<style scoped>
.pca-figure { display: grid; gap: 10px; }
.pca-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.pca-toolbar label { display: flex; align-items: center; gap: 8px; font-size: 14.5px; color: var(--text-muted); }
.pca-toolbar select { padding: 5px 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-alt); color: var(--text); font-size: 14.5px; }
.pca-legend { display: flex; gap: 12px; flex-wrap: wrap; }
.pca-legend span { display: flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-muted); }
.pca-legend i { width: 8px; height: 8px; border-radius: 50%; }
.pca-state { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 300px; color: var(--text-faint); font-size: 14.5px; }
.pca-state.is-error { color: var(--danger); }
.pca-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--brand-soft); border-top-color: var(--brand); animation: pca-spin .8s linear infinite; }
@keyframes pca-spin { to { transform: rotate(360deg); } }
.pca-svg { width: 100%; height: 460px; background: var(--bg-subtle); border-radius: 8px; }
.pca-svg .axis { stroke: rgba(23,35,61,.18); stroke-width: 1; }
.pca-point { cursor: pointer; }
.pca-point:hover { opacity: 1; stroke: #17233d; stroke-width: .6; }
.pca-foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--text-faint); font-size: 13px; }
</style>
