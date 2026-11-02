<script setup lang="ts">
import { computed, nextTick, ref, watch, type VNodeRef } from 'vue'
import type { CorrelationResult } from '@/utils/panelCompute'

/*
 * 功能共活动三联矩阵：Reference | Target | Δ（Target − Reference）。
 * - 行/列按神经元编号排序，三个视图同一顺序；
 * - 蓝 → 白 → 橙发散色带（避开红-绿），绝对值固定 [-1,1]，
 *   Δ 以 0 为中心、按本矩阵最大绝对差值归一；
 * - 功能共活动 ≠ 解剖 / 突触连接。
 */

const props = defineProps<{
  left: CorrelationResult | null
  right: CorrelationResult | null
  leftName: string
  rightName: string
  computing: boolean
}>()
const emit = defineEmits<{ selectNeuron: [id: string] }>()

const leftCanvas = ref<HTMLCanvasElement | null>(null)
const rightCanvas = ref<HTMLCanvasElement | null>(null)
const deltaCanvas = ref<HTMLCanvasElement | null>(null)
const hover = ref<{ panel: 'left' | 'right' | 'delta'; row: number; col: number; x: number; y: number } | null>(null)

function setCanvasRef(panel: 'left' | 'right' | 'delta'): VNodeRef {
  return (el) => {
    const canvas = (el as HTMLCanvasElement | null) ?? null
    if (panel === 'left') leftCanvas.value = canvas
    else if (panel === 'right') rightCanvas.value = canvas
    else deltaCanvas.value = canvas
  }
}

/* 两个条件的神经元顺序必须一致（同一只小鼠的同一视野），否则 Δ 无意义 */
const aligned = computed(() => {
  if (!props.left || !props.right) return false
  const a = props.left.ids
  const b = props.right.ids
  return a.length === b.length && a.every((id, index) => id === b[index])
})

const deltaMatrix = computed<number[][]>(() => {
  if (!aligned.value || !props.left || !props.right) return []
  return props.right.matrix.map((row, i) => row.map((value, j) => value - (props.left!.matrix[i]?.[j] ?? 0)))
})

const deltaMaxAbs = computed(() => {
  let max = 0
  for (const row of deltaMatrix.value) for (const value of row) max = Math.max(max, Math.abs(value))
  return Math.max(max, 1e-6)
})

/* 蓝（负）→ 白（0）→ 橙（正）发散色带 */
function divergingColor(value: number, scale: number): [number, number, number] {
  const t = Math.min(Math.abs(value) / Math.max(scale, 1e-6), 1)
  if (value >= 0) {
    return [
      Math.round(247 + (232 - 247) * t),
      Math.round(249 + (118 - 249) * t),
      Math.round(252 + (45 - 252) * t),
    ]
  }
  return [
    Math.round(247 + (47 - 247) * t),
    Math.round(249 + (107 - 249) * t),
    Math.round(252 + (214 - 252) * t),
  ]
}

function paint(canvas: HTMLCanvasElement | null, matrix: number[][], scale: number) {
  if (!canvas || matrix.length === 0) return
  const n = matrix.length
  canvas.width = n
  canvas.height = n
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(n, n)
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const [r, g, b] = divergingColor(matrix[row][col], scale)
      const offset = (row * n + col) * 4
      image.data[offset] = r
      image.data[offset + 1] = g
      image.data[offset + 2] = b
      image.data[offset + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

async function repaint() {
  await nextTick()
  paint(leftCanvas.value, props.left?.matrix ?? [], 1)
  paint(rightCanvas.value, props.right?.matrix ?? [], 1)
  paint(deltaCanvas.value, deltaMatrix.value, deltaMaxAbs.value)
}
watch(() => [props.left, props.right], repaint, { immediate: true, deep: false })

function cellFromEvent(event: MouseEvent, panel: 'left' | 'right' | 'delta') {
  const el = event.currentTarget as HTMLElement
  const canvas = el.querySelector('canvas')
  const ids = props.left?.ids ?? []
  if (!canvas || ids.length === 0) { hover.value = null; return }
  const bounds = canvas.getBoundingClientRect()
  const col = Math.floor(((event.clientX - bounds.left) / bounds.width) * ids.length)
  const row = Math.floor(((event.clientY - bounds.top) / bounds.height) * ids.length)
  if (row < 0 || col < 0 || row >= ids.length || col >= ids.length) { hover.value = null; return }
  hover.value = { panel, row, col, x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function onMatrixClick(panel: 'left' | 'right' | 'delta') {
  const ids = props.left?.ids ?? []
  if (!hover.value || hover.value.panel !== panel || !ids.length) return
  emit('selectNeuron', ids[hover.value.row])
}

const hoverText = computed(() => {
  const h = hover.value
  const ids = props.left?.ids ?? []
  if (!h || !ids.length) return null
  const a = ids[h.row]
  const b = ids[h.col]
  if (h.panel === 'delta') {
    const lv = props.left?.matrix[h.row]?.[h.col]
    const rv = props.right?.matrix[h.row]?.[h.col]
    const dv = deltaMatrix.value[h.row]?.[h.col]
    return {
      title: `${a} × ${b}`,
      lines: [
        `${props.leftName}: ${lv?.toFixed(3) ?? '—'}`,
        `${props.rightName}: ${rv?.toFixed(3) ?? '—'}`,
        `变化值: ${dv == null ? '—' : (dv >= 0 ? '+' : '') + dv.toFixed(3)}`,
      ],
    }
  }
  const source = h.panel === 'left' ? props.left : props.right
  const value = source?.matrix[h.row]?.[h.col]
  return { title: `${a} × ${b}`, lines: [`r = ${value == null ? '—' : value.toFixed(3)}`] }
})
</script>

<template>
  <div class="triptych">
    <div v-if="computing" class="triptych-state"><span class="triptych-spinner" />正在比较神经元之间的同步活动…</div>
    <template v-else-if="left && right">
      <p v-if="!aligned" class="triptych-warning">两个条件的神经元集合不一致，无法计算 Δ 矩阵。</p>
      <div class="triptych-grid">
        <figure v-for="panel in [
          { key: 'left' as const, name: leftName },
          { key: 'right' as const, name: rightName },
          { key: 'delta' as const, name: `变化：${rightName} − ${leftName}` },
        ]" :key="panel.key">
          <figcaption>
            <strong>{{ panel.name }}</strong>
            <span v-if="panel.key === 'delta'" class="mono">变化范围 ±{{ deltaMaxAbs.toFixed(2) }}</span>
          </figcaption>
          <div class="matrix-stage"
            @mousemove="cellFromEvent($event, panel.key)"
            @mouseleave="hover = null"
            @click="onMatrixClick(panel.key)">
            <canvas :ref="setCanvasRef(panel.key)" />
            <div v-if="hover && hover.panel === panel.key && hoverText" class="matrix-tooltip"
              :style="{ left: hover.x + 12 + 'px', top: hover.y + 12 + 'px' }">
              <strong class="mono">{{ hoverText.title }}</strong>
              <span v-for="line in hoverText.lines" :key="line">{{ line }}</span>
            </div>
          </div>
        </figure>
      </div>
      <div class="guide-grid">
        <section class="guide-card guide-card--action">
          <header><i>1</i><strong>操作提示</strong></header>
          <ul>
            <li>把鼠标移到任意小格，可查看这两个神经元的具体数值。</li>
            <li>点击右侧“变化图”的小格，可进入 3D 工作区定位对应神经元。</li>
          </ul>
        </section>
        <section class="guide-card guide-card--reading">
          <header><i>2</i><strong>读图提示</strong></header>
          <ul>
            <li>左图和中图分别代表两个实验条件；每个小格表示一对神经元的活动是否同步。</li>
            <li><span class="color-key pos" />橙色越深，活动越同步；<span class="color-key neg" />蓝色越深，活动趋势越相反；接近白色表示关系较弱。</li>
            <li>右侧变化图中，橙色表示第二个条件下关系增强，蓝色表示减弱。</li>
            <li>对角线是神经元与自身的比较，可忽略；这里展示的是统计关联，不代表存在真实突触连接。</li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.triptych { display: grid; gap: 12px; }
.triptych-state { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 260px; color: var(--text-faint); font-size: 14px; }
.triptych-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--brand-soft); border-top-color: var(--brand); animation: trip-spin .8s linear infinite; }
@keyframes trip-spin { to { transform: rotate(360deg); } }
.triptych-warning { margin: 0; padding: 10px 12px; border: 1px solid var(--warn); border-radius: 8px; background: var(--warn-soft); color: var(--warn); font-size: 13px; }
.triptych-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
figure { margin: 0; display: grid; gap: 8px; min-width: 0; }
figcaption { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
figcaption strong { font-size: 14px; color: var(--text-strong); }
figcaption span { font-size: 11px; color: var(--text-faint); }
.matrix-stage { position: relative; cursor: crosshair; }
.matrix-stage canvas { width: 100%; aspect-ratio: 1; display: block; image-rendering: pixelated; border-radius: 8px; border: 1px solid var(--border); background: #fff; }
.matrix-tooltip { position: absolute; z-index: 3; display: grid; gap: 2px; padding: 6px 9px; background: rgba(15,25,45,.92); color: #fff; border-radius: 6px; font-size: 12.5px; pointer-events: none; white-space: nowrap; }
.matrix-tooltip span { color: #b8c6d8; }
.guide-grid { display: grid; grid-template-columns: minmax(260px,.78fr) minmax(420px,1.5fr); gap: 10px; }
.guide-card { padding: 11px 13px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-alt); }
.guide-card--action { border-left: 3px solid var(--brand); }
.guide-card--reading { border-left: 3px solid #e8762d; }
.guide-card header { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; color: var(--text-strong); font-size: 13px; }
.guide-card header i { display: grid; place-items: center; width: 19px; height: 19px; border-radius: 50%; background: var(--brand-soft); color: var(--brand-text); font: 700 10px var(--font-mono); }
.guide-card ul { display: grid; gap: 5px; margin: 0; padding-left: 18px; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.color-key { display: inline-block; width: 11px; height: 8px; margin: 0 3px 0 1px; border-radius: 2px; }
.color-key.neg { background: #2f6bd6; }
.color-key.pos { background: #e8762d; }
@media (max-width: 1050px) { .triptych-grid { grid-template-columns: 1fr; } }
@media (max-width: 800px) { .guide-grid { grid-template-columns: 1fr; } }
</style>
