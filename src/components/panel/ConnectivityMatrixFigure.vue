<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { NeuronFrame } from '@neuron3d/neuron/neuronUtils'
import { computeCorrelationMatrix, type CorrelationResult } from '@/utils/panelCompute'

/*
 * Figure：功能连接矩阵热图。
 * neuron × neuron Pearson 相关方阵，行/列按神经元编号排序；
 * 发散色标以 0 为中心；
 * hover 显示神经元对与相关系数，点击格子定位 3D 中的神经元。
 * 固定提示：功能相关不代表物理连接。
 */

const props = defineProps<{
  frames: NeuronFrame[]
  active: boolean
}>()
const emit = defineEmits<{ selectNeuron: [id: string] }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const result = ref<CorrelationResult | null>(null)
const state = ref<'idle' | 'computing' | 'ready' | 'error'>('idle')
const hover = ref<{ row: number; col: number; x: number; y: number } | null>(null)

let computeToken = 0
async function compute() {
  if (!props.active || props.frames.length === 0) return
  if (state.value === 'ready' && result.value && result.value.ids.length > 0) return
  const token = ++computeToken
  state.value = 'computing'
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (token !== computeToken) return
  try {
    const value = computeCorrelationMatrix(props.frames)
    if (token !== computeToken) return
    result.value = value
    state.value = 'ready'
    requestAnimationFrame(draw)
  } catch {
    if (token !== computeToken) return
    state.value = 'error'
  }
}

/** r ∈ [-1, 1] → 蓝（负相关）/ 白（0）/ 红（正相关） */
function corrColor(r: number): [number, number, number] {
  const t = Math.min(Math.abs(r), 1)
  if (r >= 0) return [Math.round(247 + (214 - 247) * t), Math.round(249 + (48 - 249) * t), Math.round(252 + (38 - 252) * t)]
  return [Math.round(247 + (47 - 247) * t), Math.round(249 + (107 - 249) * t), Math.round(252 + (214 - 252) * t)]
}

function draw() {
  const el = canvas.value
  const res = result.value
  if (!el || !res || res.ids.length === 0) return
  const n = res.ids.length
  el.width = n
  el.height = n
  const ctx = el.getContext('2d')
  if (!ctx) return

  const image = ctx.createImageData(n, n)
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const [r, g, b] = corrColor(res.matrix[row][col])
      const offset = (row * n + col) * 4
      image.data[offset] = r
      image.data[offset + 1] = g
      image.data[offset + 2] = b
      image.data[offset + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

function onCanvasMove(event: MouseEvent) {
  const res = result.value
  const el = canvas.value
  if (!res || !el || res.ids.length === 0) { hover.value = null; return }
  const bounds = el.getBoundingClientRect()
  const col = Math.floor(((event.clientX - bounds.left) / bounds.width) * res.ids.length)
  const row = Math.floor(((event.clientY - bounds.top) / bounds.height) * res.ids.length)
  if (row < 0 || col < 0 || row >= res.ids.length || col >= res.ids.length) { hover.value = null; return }
  hover.value = { row, col, x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function onCanvasClick() {
  if (!result.value || !hover.value) return
  emit('selectNeuron', result.value.ids[hover.value.row])
}

onMounted(compute)
watch(() => props.active, compute)
watch(() => props.frames, () => { if (state.value === 'ready') { state.value = 'idle'; result.value = null; compute() } })
</script>

<template>
  <div class="corr-figure">
    <div v-if="state === 'computing'" class="corr-state"><span class="corr-spinner" />正在整理神经元之间的协同关系…</div>
    <div v-else-if="state === 'error'" class="corr-state is-error">协同关系图生成失败，请重试。</div>
    <template v-else-if="state === 'ready' && result">
      <div class="corr-stage" @mousemove="onCanvasMove" @mouseleave="hover = null" @click="onCanvasClick">
        <canvas ref="canvas" />
        <div v-if="hover" class="corr-tooltip" :style="{ left: hover.x + 12 + 'px', top: hover.y + 12 + 'px' }">
          <strong class="mono">{{ result.ids[hover.row] }} × {{ result.ids[hover.col] }}</strong>
          <span>同步程度 {{ result.matrix[hover.row][hover.col].toFixed(3) }}</span>
        </div>
      </div>
      <div class="corr-foot">
        <span>共比较 {{ result.ids.length }} 个神经元 · 每个小格代表一对神经元</span>
        <span class="corr-scale"><i class="neg" />反向变化　关系较弱　同步变化<i class="pos" /></span>
      </div>
      <p class="corr-note">读图提示：颜色越深，关系越明显；该图表示统计上的同步变化，不代表神经元之间存在直接连接。</p>
    </template>
  </div>
</template>

<style scoped>
.corr-figure { display: grid; gap: 10px; }
.corr-state { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 320px; color: var(--text-faint); font-size: 14.5px; }
.corr-state.is-error { color: var(--danger); }
.corr-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--brand-soft); border-top-color: var(--brand); animation: corr-spin .8s linear infinite; }
@keyframes corr-spin { to { transform: rotate(360deg); } }
.corr-stage { position: relative; max-width: 640px; margin: 0 auto; cursor: crosshair; }
.corr-stage canvas { width: 100%; aspect-ratio: 1; display: block; image-rendering: pixelated; border-radius: 8px; border: 1px solid var(--border); }
.corr-tooltip { position: absolute; z-index: 3; display: grid; gap: 2px; padding: 6px 9px; background: rgba(15,25,45,.92); color: #fff; border-radius: 6px; font-size: 13px; pointer-events: none; white-space: nowrap; }
.corr-tooltip span { color: #b8c6d8; }
.corr-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; color: var(--text-faint); font-size: 13px; }
.corr-scale { display: flex; align-items: center; gap: 6px; }
.corr-scale i { width: 12px; height: 8px; border-radius: 2px; }
.corr-scale .neg { background: #2f6bd6; }
.corr-scale .pos { background: #d63026; }
.corr-note { margin: 0; padding: 8px 12px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--text-muted); font-size: 14px; }
</style>
