<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { getBehaviorConfig } from '@neuron3d/neuron/neuronUtils'
import type { NeuronFrame } from '@neuron3d/neuron/neuronUtils'
import { formatTimestamp } from '@/utils/time'

/*
 * Figure 01 多模态同步时间轴：
 * 行为标签轨 + 睡眠阶段轨 + 钙活动热图（neuron × time），
 * 白色游标 = currentTimestamp，灰色虚线 = 人工拼接缝，
 * 点击任意位置跳转到对应时刻（与 3D 工作区共用统一时间）。
 */

const props = defineProps<{
  frames: NeuronFrame[]
  currentTimestamp: number
}>()
const emit = defineEmits<{ seek: [timestamp: number] }>()

const heatmapCanvas = ref<HTMLCanvasElement | null>(null)

const frameCount = computed(() => props.frames.length)
const duration = computed(() => frameCount.value > 0 ? Number(props.frames[frameCount.value - 1].stamp) : 0)

const behaviorKeys = computed(() => props.frames.map((frame) => (frame.behavior || 'unknown').toLowerCase()))
const sleepKeys = computed(() => props.frames.map((frame) => (frame.sleepStage || '').toLowerCase()))
const seamIndexes = computed(() => props.frames.map((frame, index) => (frame.seamBefore ? index : -1)).filter((index) => index > 0))

/* 钙活动热图：逐神经元 min-max 归一化，安静 = 浅色，兴奋 = 红 */
function drawHeatmap() {
  const canvas = heatmapCanvas.value
  const frames = props.frames
  if (!canvas || frames.length === 0) return

  const ids = Object.keys(frames[0].values).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  const rows = ids.length
  const cols = frames.length
  canvas.width = cols
  canvas.height = rows

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const image = ctx.createImageData(cols, rows)
  ids.forEach((id, row) => {
    let min = Infinity
    let max = -Infinity
    const values = frames.map((frame) => {
      const value = frame.values[id]
      const v = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (v < min) min = v
      if (v > max) max = v
      return v
    })
    const range = Math.max(max - min, 1e-9)
    values.forEach((value, col) => {
      const t = (value - min) / range
      const offset = (row * cols + col) * 4
      // 浅灰白 → 深红
      image.data[offset] = Math.round(244 - t * 200)
      image.data[offset + 1] = Math.round(246 - t * 214)
      image.data[offset + 2] = Math.round(251 - t * 219)
      image.data[offset + 3] = 255
    })
  })
  ctx.putImageData(image, 0, 0)
}

const cursorPct = computed(() => {
  if (frameCount.value < 2 || duration.value <= 0) return 0
  return Math.min(100, Math.max(0, (props.currentTimestamp / duration.value) * 100))
})

onMounted(() => { drawHeatmap() })
watch(() => props.frames, () => { drawHeatmap() })

function onFigureClick(event: MouseEvent) {
  if (duration.value <= 0) return
  const target = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - target.left) / target.width))
  emit('seek', ratio * duration.value)
}

const bandColor = (key: string) => getBehaviorConfig(key).color
const bandTitle = (key: string) => getBehaviorConfig(key).meaning
</script>

<template>
  <div class="sync-figure" @click="onFigureClick">
    <div class="sync-band-row" v-for="band in [
      { title: '行为标签', keys: behaviorKeys },
      { title: '睡眠阶段', keys: sleepKeys },
    ]" :key="band.title">
      <span class="sync-band-label">{{ band.title }}</span>
      <div class="sync-band">
        <span v-for="(key, index) in band.keys" :key="index" class="sync-cell"
          :style="{ background: bandColor(key) }" :title="`${bandTitle(key)} · ${formatTimestamp(Number(frames[index].stamp))}`" />
        <span v-for="index in seamIndexes" :key="'seam-' + index" class="sync-seam"
          :style="{ left: `${(index / Math.max(frameCount - 1, 1)) * 100}%` }" title="数据片段分界" />
      </div>
    </div>

    <div class="sync-band-row">
      <span class="sync-band-label">钙活动</span>
      <div class="sync-band sync-heatmap">
        <canvas ref="heatmapCanvas" />
      </div>
    </div>

    <span class="sync-cursor" :style="{ left: `calc(64px + (100% - 70px) * ${(cursorPct / 100).toFixed(4)})` }" />

    <div class="sync-foot">
      <span>上方看状态，下方看神经活动强弱 · 点击任意位置可跳转 · 灰虚线表示数据片段分界</span>
      <span class="mono">{{ formatTimestamp(currentTimestamp) }} / {{ formatTimestamp(duration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.sync-figure { position: relative; display: grid; gap: 8px; cursor: crosshair; }
.sync-band-row { display: grid; grid-template-columns: 64px 1fr; align-items: stretch; gap: 6px; }
.sync-band-label { font-size: 13px; color: var(--text-faint); display: flex; align-items: center; justify-content: flex-end; padding-right: 2px; }
.sync-band { position: relative; height: 18px; border-radius: 5px; overflow: hidden; background: var(--bg-subtle); display: flex; }
.sync-cell { flex: 1 1 0; min-width: 0; opacity: .88; }
.sync-seam { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px dashed #9aa7b8; z-index: 2; pointer-events: none; }
.sync-heatmap { height: 260px; }
.sync-heatmap canvas { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
.sync-cursor { position: absolute; top: 0; bottom: 26px; width: 2px; margin-left: -1px; background: var(--brand); z-index: 3; pointer-events: none; box-shadow: 0 0 0 1px rgba(255,255,255,.6); }
.sync-foot { display: flex; justify-content: space-between; gap: 12px; color: var(--text-faint); font-size: 13px; padding-top: 2px; }
</style>
