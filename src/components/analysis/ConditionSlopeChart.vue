<script setup lang="ts">
import { computed } from 'vue'

/*
 * 跨条件效应图（坡度图）：
 * 每行一个指标，x 轴为所选条件（2–N 个），点为指标值。
 * 两条件 = 双点连线 + Δ；三条件及以上 = 多点趋势，
 * 当前 Pair（详细比较的两端）用描边圆点与加粗线段突出。
 * 只呈现描述性数值与差值，不做显著性推断。
 */

export interface SlopeCondition {
  id: string
  name: string
  color: string
}

export interface SlopeRow {
  key: string
  label: string
  /** 与 conditions 顺序一致；null = 该条件无此指标 */
  values: Array<number | null>
  /** 当前 Pair 的差值（right − left），与 unit 同量纲 */
  delta: number | null
  unit: 'fraction' | 'raw'
}

const props = defineProps<{
  conditions: SlopeCondition[]
  pairIds: [string, string]
  rows: SlopeRow[]
}>()

const pairIndexes = computed<[number, number]>(() => {
  const left = props.conditions.findIndex(c => c.id === props.pairIds[0])
  const right = props.conditions.findIndex(c => c.id === props.pairIds[1])
  return [left, right]
})

function xAt(index: number, total: number) {
  if (total <= 1) return 50
  return 9 + (index * 82) / (total - 1)
}

interface Point { x: number; y: number; value: number; color: string; inPair: boolean; index: number }

function pointsOf(row: SlopeRow): Point[] {
  const present = row.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!present.length) return []
  const min = Math.min(...present)
  const max = Math.max(...present)
  const span = Math.max(max - min, Math.abs(max) * 0.02, 1e-6)
  const [li, ri] = pairIndexes.value
  return row.values.flatMap((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return []
    const x = xAt(index, props.conditions.length)
    /* y: 12%–88% 区间，值大者在上 */
    const y = 88 - ((value - min) / span) * 72
    return [{ x, y, value, color: props.conditions[index]?.color ?? '#93a1b8', inPair: index === li || index === ri, index }]
  })
}

function pairSegment(row: SlopeRow): { x1: number; y1: number; x2: number; y2: number } | null {
  const [li, ri] = pairIndexes.value
  if (li < 0 || ri < 0 || li === ri) return null
  const points = pointsOf(row)
  const a = points.find(p => p.index === li)
  const b = points.find(p => p.index === ri)
  if (!a || !b) return null
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
}

function linePath(points: Point[]): string {
  return points.map(p => `${p.x},${p.y}`).join(' ')
}

function formatValue(value: number, unit: 'fraction' | 'raw'): string {
  return unit === 'fraction' ? `${(value * 100).toFixed(1)}%` : value.toFixed(3)
}

function formatDelta(delta: number | null, unit: 'fraction' | 'raw'): string {
  if (delta == null || !Number.isFinite(delta)) return '—'
  if (Math.abs(delta) < (unit === 'fraction' ? 0.0005 : 0.0005)) return '≈ 0'
  const sign = delta > 0 ? '+' : '−'
  return unit === 'fraction'
    ? `${sign}${(Math.abs(delta) * 100).toFixed(1)} pp`
    : `${sign}${Math.abs(delta).toFixed(3)}`
}

function deltaTone(delta: number | null): 'up' | 'down' | 'flat' {
  if (delta == null || !Number.isFinite(delta) || Math.abs(delta) < 0.0005) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

const pairName = computed(() => {
  const [li, ri] = pairIndexes.value
  if (li < 0 || ri < 0) return ''
  return `${props.conditions[li]?.name ?? ''} → ${props.conditions[ri]?.name ?? ''}`
})
</script>

<template>
  <div class="slope-chart">
    <div v-for="row in rows" :key="row.key" class="slope-row">
      <span class="slope-label" :title="row.label">{{ row.label }}</span>
      <div class="slope-track">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline
            :points="linePath(pointsOf(row))"
            fill="none"
            stroke="rgba(100,116,139,.28)"
            stroke-width="1.6"
            vector-effect="non-scaling-stroke"
          />
          <line
            v-if="pairSegment(row)"
            :x1="pairSegment(row)!.x1" :y1="pairSegment(row)!.y1"
            :x2="pairSegment(row)!.x2" :y2="pairSegment(row)!.y2"
            stroke="rgba(51,65,92,.55)"
            stroke-width="2.4"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <template v-for="point in pointsOf(row)" :key="point.index">
          <i
            class="slope-dot"
            :class="{ 'in-pair': point.inPair }"
            :style="{ left: point.x + '%', top: point.y + '%', background: point.color }"
            :title="`${conditions[point.index]?.name}: ${formatValue(point.value, row.unit)}`"
          />
          <span
            class="slope-value mono"
            :class="{ 'in-pair': point.inPair }"
            :style="{ left: point.x + '%', top: point.y + '%' }"
          >{{ formatValue(point.value, row.unit) }}</span>
        </template>
      </div>
      <b class="slope-delta mono" :class="`is-${deltaTone(row.delta)}`" :title="`当前比较 ${pairName}`">
        {{ formatDelta(row.delta, row.unit) }}
      </b>
    </div>
  </div>
</template>

<style scoped>
.slope-chart { display: grid; gap: 4px; }
.slope-row { display: grid; grid-template-columns: minmax(120px, 180px) 1fr 86px; align-items: center; gap: 12px; padding: 3px 0; }
.slope-label { font-size: 13px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slope-track { position: relative; height: 40px; }
.slope-track svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.slope-dot { position: absolute; width: 9px; height: 9px; border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 2px #fff; z-index: 2; }
.slope-dot.in-pair { width: 11px; height: 11px; box-shadow: 0 0 0 2px #fff, 0 0 0 4px color-mix(in srgb, currentColor 30%, transparent); outline: 2px solid rgba(51,65,92,.45); }
.slope-value { position: absolute; transform: translate(-50%, -130%); font-size: 10px; color: var(--text-faint); z-index: 2; white-space: nowrap; pointer-events: none; }
.slope-value.in-pair { color: var(--text-strong); font-weight: 700; }
.slope-delta { font-size: 12.5px; text-align: right; padding: 3px 7px; border-radius: 6px; background: var(--bg-subtle); color: var(--text-muted); }
.slope-delta.is-up { color: #b4540a; background: rgba(232,118,45,.1); }
.slope-delta.is-down { color: #2f6bd6; background: rgba(47,107,214,.1); }
</style>
