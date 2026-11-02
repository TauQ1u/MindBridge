<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { NeuronFrame } from '@neuron3d/neuron/neuronUtils'
import { signalApi, type EegEmgData } from '@/services/api/signalApi'
import { formatTimestamp } from '@/utils/time'

/* EEG/EMG 合并视图：只保留一张当前时刻同步信号图，降低读图门槛。 */

const props = defineProps<{
  conditionId: string
  frames: NeuronFrame[]
  currentTimestamp: number
}>()
const CHANNELS = [
  { key: 'EEG1', label: '脑电 1', color: '#2f7ef7' },
  { key: 'EEG2', label: '脑电 2', color: '#8b5cf6' },
  { key: 'EMG', label: '肌肉活动', color: '#f97316' },
] as const

/** 局部窗口 = 当前时刻前后各 3 个主时钟格 */
const DETAIL_SPAN_FRAMES = 3

const data = ref<EegEmgData | null>(null)
const loadState = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const errorMessage = ref('')
const detailCanvas = ref<HTMLCanvasElement | null>(null)

const frameCount = computed(() => props.frames.length)
const duration = computed(() => frameCount.value > 0 ? Number(props.frames[frameCount.value - 1].stamp) : 0)
const dt = computed(() => {
  if (frameCount.value < 2) return 0.52
  const delta = (duration.value - Number(props.frames[0].stamp)) / (frameCount.value - 1)
  return delta > 0 ? delta : 0.52
})
let loadToken = 0
async function load() {
  const token = ++loadToken
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    const result = await signalApi.loadEegEmg(props.conditionId)
    if (token !== loadToken) return
    data.value = result
    loadState.value = 'success'
  } catch (error) {
    if (token !== loadToken) return
    loadState.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '生理信号加载失败'
  }
}

function channelValues(source: EegEmgData, key: string): Float32Array {
  switch (key) {
    case 'EEG1': return source.eeg1
    case 'EEG2': return source.eeg2
    case 'EMG': return source.emg
    default: return source.activ
  }
}

/** 稳健显示范围：全程 P1 / P99 */
function robustRange(values: Float32Array) {
  const sample: number[] = []
  for (let i = 0; i < values.length; i += 37) sample.push(values[i])
  sample.sort((a, b) => a - b)
  const lo = sample[Math.floor(sample.length * 0.01)] ?? 0
  const hi = sample[Math.floor(sample.length * 0.99)] ?? 1
  return { lo, hi: hi > lo ? hi : lo + 1 }
}

interface Envelope { min: Float32Array; max: Float32Array; mean: Float32Array; lo: number; hi: number }

/** 全程包络：每个主时钟格对应采样区间的 min / max / mean */
function computeEnvelopes(source: EegEmgData): Envelope[] {
  const sr = source.sampleRate
  return CHANNELS.map((channel) => {
    const values = channelValues(source, channel.key)
    const min = new Float32Array(frameCount.value)
    const max = new Float32Array(frameCount.value)
    const mean = new Float32Array(frameCount.value)
    for (let frame = 0; frame < frameCount.value; frame += 1) {
      const start = Math.min(Math.floor(frame * dt.value * sr), values.length)
      const end = Math.min(Math.floor((frame + 1) * dt.value * sr), values.length)
      let lo = Infinity
      let hi = -Infinity
      let sum = 0
      for (let i = start; i < end; i += 1) {
        const value = values[i]
        if (value < lo) lo = value
        if (value > hi) hi = value
        sum += value
      }
      if (end > start) {
        min[frame] = lo; max[frame] = hi; mean[frame] = sum / (end - start)
      } else {
        const value = values[Math.min(start, values.length - 1)] ?? 0
        min[frame] = value; max[frame] = value; mean[frame] = value
      }
    }
    return { min, max, mean, ...robustRange(values) }
  })
}

let envelopes: Envelope[] | null = null

function drawDetail() {
  const canvas = detailCanvas.value
  const source = data.value
  if (!canvas || !source || !envelopes || frameCount.value < 2) return
  const cssWidth = Math.max(canvas.parentElement?.clientWidth ?? 720, 240)
  const cssHeight = 270
  const dpr = Math.min(window.devicePixelRatio, 2)
  canvas.width = cssWidth * dpr
  canvas.height = cssHeight * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const sr = source.sampleRate
  const centerTime = props.currentTimestamp
  const windowSeconds = DETAIL_SPAN_FRAMES * dt.value
  const startTime = Math.max(centerTime - windowSeconds, 0)
  const endTime = Math.min(centerTime + windowSeconds, source.duration)
  const startSample = Math.floor(startTime * sr)
  const endSample = Math.min(Math.floor(endTime * sr), source.eeg1.length - 1)

  const labelWidth = 48
  const plotWidth = cssWidth - labelWidth - 8
  const rows = 3
  const rowHeight = cssHeight / rows
  const xOf = (sample: number) => labelWidth + ((sample - startSample) / Math.max(endSample - startSample, 1)) * plotWidth

  for (let row = 0; row < rows; row += 1) {
    const channel = CHANNELS[row]
    const envelope = envelopes[row]
    const values = channelValues(source, channel.key)
    const top = row * rowHeight
    const mid = top + rowHeight / 2
    const half = rowHeight / 2 - 5
    const span = envelope.hi - envelope.lo
    const yOf = (value: number) => mid - ((value - envelope.lo) / span - 0.5) * 2 * half

    ctx.strokeStyle = 'rgba(23,35,61,.14)'
    ctx.beginPath(); ctx.moveTo(labelWidth, mid); ctx.lineTo(cssWidth - 8, mid); ctx.stroke()

    ctx.beginPath()
    for (let sample = startSample; sample <= endSample; sample += 1) {
      const x = xOf(sample)
      const y = yOf(values[sample])
      if (sample === startSample) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = channel.color
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = channel.color
    ctx.font = '600 13px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(channel.label, 6, mid)
  }

  const cursorX = xOf(Math.min(Math.max(Math.floor(centerTime * sr), startSample), endSample))
  ctx.strokeStyle = '#17233d'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cursorX, 0); ctx.lineTo(cursorX, cssHeight); ctx.stroke()

  ctx.fillStyle = '#64748f'
  ctx.font = '12px Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.fillText(`${startTime.toFixed(2)} s`, labelWidth, cssHeight - 5)
  ctx.textAlign = 'right'
  ctx.fillText(`${endTime.toFixed(2)} s`, cssWidth - 8, cssHeight - 5)
}

function redraw() {
  drawDetail()
}

let resizeObserver: ResizeObserver | null = null
onMounted(async () => {
  await load()
  if (data.value) envelopes = computeEnvelopes(data.value)
  redraw()
  if (detailCanvas.value?.parentElement) {
    resizeObserver = new ResizeObserver(() => redraw())
    resizeObserver.observe(detailCanvas.value.parentElement)
  }
})
watch(() => props.conditionId, async () => {
  envelopes = null
  await load()
  if (data.value) envelopes = computeEnvelopes(data.value)
  redraw()
})
watch(() => props.currentTimestamp, drawDetail)
onBeforeUnmount(() => { resizeObserver?.disconnect(); loadToken += 1 })
</script>

<template>
  <div class="eeg-figure">
    <div v-if="loadState === 'loading'" class="eeg-state">
      <span class="eeg-spinner" />正在读取原始 EEG/EMG 记录（1000 Hz · 约 15 MB）…
    </div>
    <div v-else-if="loadState === 'error'" class="eeg-state is-error">
      <strong>生理信号加载失败</strong><span>{{ errorMessage }}</span>
    </div>
    <template v-else-if="data">
      <div class="signal-guide">
        <strong>三条信号放在同一时间窗口内对照</strong>
        <span>蓝色、紫色代表脑电活动，橙色代表肌肉活动；中间竖线是当前播放时刻。</span>
      </div>
      <div class="eeg-detail">
        <canvas ref="detailCanvas" />
      </div>
      <div class="eeg-foot">
        <span>读图提示：波动越明显，表示该时刻脑活动或身体活动变化越强。</span>
        <span class="mono">{{ formatTimestamp(currentTimestamp) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.eeg-figure { display: grid; gap: 10px; }
.eeg-state { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 220px; color: var(--text-faint); font-size: 14.5px; }
.eeg-state.is-error { flex-direction: column; gap: 6px; color: var(--danger); }
.eeg-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--brand-soft); border-top-color: var(--brand); animation: eeg-spin .8s linear infinite; }
@keyframes eeg-spin { to { transform: rotate(360deg); } }
.signal-guide{display:grid;gap:3px;padding:9px 11px;border-radius:8px;background:var(--surface);border:1px solid var(--border)}.signal-guide strong{color:var(--text-strong);font-size:12px}.signal-guide span{color:var(--text-faint);font-size:11px;line-height:1.5}
.eeg-detail { position: relative; }
.eeg-detail canvas { width: 100%; height: 270px; display: block; background: var(--bg-subtle); border-radius: 8px; }
.eeg-foot { display: flex; justify-content: space-between; gap: 12px; color: var(--text-faint); font-size: 13px; }
</style>
