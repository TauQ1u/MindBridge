<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { signalApi, type EegEmgData } from '@/services/api/signalApi'

/*
 * 复核工作台脑电/肌电查看器：
 * 以当前时刻为中心绘制 ±3 s 的 1000 Hz 原始波形，
 * 四通道小倍数排布；时间由父组件的 tick 驱动刷新
 * （视频 timeupdate / seeked 都会 bump tick）。
 */

const props = defineProps<{
  conditionId: string
  /** 当前时间（秒） */
  timestamp: number
  /** 父组件的时间更新计数器，变化即重绘 */
  tick: number
}>()

const wrap = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const loading = ref(true)
const error = ref('')

let data: EegEmgData | null = null
/* 每条通道的全局稳健量程（P1–P99，一次性采样计算），
   避免窗口滑动时幅度来回跳 */
let ranges: { min: number; max: number }[] = []
const CHANNELS = [
  { key: 'eeg1', label: 'EEG1', color: '#2f7ef7' },
  { key: 'eeg2', label: 'EEG2', color: '#8b5cf6' },
  { key: 'emg', label: 'EMG', color: '#f97316' },
  { key: 'activ', label: 'Activ', color: '#12a594' },
] as const
const HALF_WINDOW = 3 // ±3 s

function percentile(sorted: number[], p: number) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[idx]
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data = await signalApi.loadEegEmg(props.conditionId)
    ranges = CHANNELS.map((ch) => {
      const arr = data![ch.key]
      const step = Math.max(1, Math.floor(arr.length / 20000))
      const sample: number[] = []
      for (let i = 0; i < arr.length; i += step) sample.push(arr[i])
      sample.sort((a, b) => a - b)
      const lo = percentile(sample, 1)
      const hi = percentile(sample, 99)
      const pad = (hi - lo) * 0.15 || 1
      return { min: lo - pad, max: hi + pad }
    })
    loading.value = false
    draw()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '脑电数据加载失败'
    loading.value = false
  }
}

function draw() {
  const el = canvas.value
  if (!el || !wrap.value || !data) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = wrap.value.clientWidth
  const h = wrap.value.clientHeight
  if (!w || !h) return
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    el.style.width = w + 'px'
    el.style.height = h + 'px'
  }
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)

  const { sampleRate, duration } = data
  const t = Math.min(Math.max(props.timestamp, 0), duration)
  const rowH = h / CHANNELS.length
  const yPad = rowH * 0.16
  const t0 = t - HALF_WINDOW
  const t1 = t + HALF_WINDOW

  CHANNELS.forEach((ch, ci) => {
    const arr = data![ch.key]
    const range = ranges[ci]
    const top = ci * rowH
    const plotH = rowH - yPad * 2
    const yOf = (v: number) => top + yPad + plotH * (1 - (v - range.min) / (range.max - range.min))

    // 通道分隔线 + 基线
    if (ci > 0) {
      ctx.strokeStyle = '#e6ebf3'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, top)
      ctx.lineTo(w, top)
      ctx.stroke()
    }
    ctx.strokeStyle = '#f0f3f8'
    ctx.beginPath()
    ctx.moveTo(0, yOf(0))
    ctx.lineTo(w, yOf(0))
    ctx.stroke()

    // 波形：每像素列取样本区间 min–max 竖线（6000 点窗口全分辨率绘制）
    const startIdx = Math.max(0, Math.floor(t0 * sampleRate))
    const endIdx = Math.min(arr.length - 1, Math.ceil(t1 * sampleRate))
    ctx.strokeStyle = ch.color
    ctx.lineWidth = 1
    ctx.beginPath()
    const span = t1 - t0
    for (let x = 0; x < w; x += 1) {
      const ta = t0 + (x / w) * span
      const tb = t0 + ((x + 1) / w) * span
      const ia = Math.max(startIdx, Math.floor(ta * sampleRate))
      const ib = Math.min(endIdx, Math.ceil(tb * sampleRate))
      if (ib <= ia) continue
      let lo = Infinity, hi = -Infinity
      for (let i = ia; i < ib; i += 1) {
        const v = arr[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (lo === Infinity) continue
      const ya = yOf(hi)
      const yb = yOf(lo)
      ctx.moveTo(x + 0.5, ya)
      ctx.lineTo(x + 0.5, Math.max(yb, ya + 0.5))
    }
    ctx.stroke()

    // 通道标签 + 当前值
    const centerIdx = Math.min(arr.length - 1, Math.max(0, Math.round(t * sampleRate)))
    ctx.fillStyle = ch.color
    ctx.font = '600 13px "Segoe UI", "Microsoft YaHei", sans-serif'
    ctx.fillText(ch.label, 8, top + 14)
    ctx.fillStyle = '#8a94a6'
    ctx.font = '12px "JetBrains Mono", Consolas, monospace'
    ctx.fillText(arr[centerIdx].toFixed(3), 8, top + 27)
  })

  // 中央游标（当前时刻）
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(w / 2, 0)
  ctx.lineTo(w / 2, h)
  ctx.stroke()

  // 窗口起止时间
  ctx.fillStyle = '#8a94a6'
  ctx.font = '12px "JetBrains Mono", Consolas, monospace'
  ctx.fillText(`−${HALF_WINDOW}s`, 6, h - 6)
  const endLabel = `+${HALF_WINDOW}s`
  ctx.fillText(endLabel, w - ctx.measureText(endLabel).width - 6, h - 6)
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  load()
  resizeObserver = new ResizeObserver(() => draw())
  if (wrap.value) resizeObserver.observe(wrap.value)
})
onBeforeUnmount(() => { resizeObserver?.disconnect() })

watch(() => props.conditionId, () => { data = null; load() })
watch(() => props.tick, () => { if (!loading.value) draw() })
</script>

<template>
  <div ref="wrap" class="sig-viewer">
    <canvas v-show="!loading && !error" ref="canvas" />
    <div v-if="loading" class="sig-viewer__state">正在加载脑电 / 肌电数据…</div>
    <div v-else-if="error" class="sig-viewer__state is-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.sig-viewer { position: relative; width: 100%; height: 100%; min-height: 0; background: #fff; border-radius: var(--radius); overflow: hidden; }
.sig-viewer canvas { display: block; }
.sig-viewer__state { position: absolute; inset: 0; display: grid; place-content: center; color: var(--text-faint); font-size: 15px; background: var(--bg-subtle); }
.sig-viewer__state.is-error { color: var(--warn); }
</style>
