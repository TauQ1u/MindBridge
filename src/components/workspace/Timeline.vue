<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { formatTimestamp } from '@/utils/time'
import { withBehaviorZh } from '@/utils/behaviorLabels'

const store = useWorkspaceStore()
const speeds = [0.5, 1, 2, 4]

// 播放由原生视频时钟推进；Timeline 只负责播放控制与拖动 seek。
function togglePlay() {
  store.setPlaying(!store.playing)
}
function reset() {
  store.setPlaying(false)
  store.setTimestamp(0)
}
 onBeforeUnmount(() => {})

// ---- 行为轨：final_label 分段；颜色按标签出现顺序分配，不绑定语义 ----
const palette = ['#12a594', '#2f7ef7', '#8b7cf6', '#e5a323', '#1faa6b', '#e15b78', '#63a9e8']
const segments = computed(() => {
  const frames = store.hasImportedData ? store.timeline : []
  if (!frames.length || store.duration <= 0) return []
  const colorOf = new Map<string, string>()
  const result: { start: number; end: number; label: string; color: string }[] = []
  for (const frame of frames) {
    const label = frame.finalLabel || '待复核'
    if (!colorOf.has(label)) colorOf.set(label, label === '待复核' ? '#c3cfdf' : palette[colorOf.size % palette.length])
    const last = result[result.length - 1]
    if (last && last.label === label) last.end = frame.timestamp
    else result.push({ start: frame.timestamp, end: frame.timestamp, label, color: colorOf.get(label)! })
  }
  return result
})
const legendLabels = computed(() => {
  const seen = new Map<string, string>()
  for (const seg of segments.value) if (!seen.has(seg.label)) seen.set(seg.label, seg.color)
  return [...seen.entries()].map(([label, color]) => ({ label, color }))
})

// ---- 群体活动摘要：全部神经元逐帧活动均值（真实数据派生），降采样为 sparkline ----
const SPARK_POINTS = 220
const sparkline = computed(() => {
  const neurons = store.hasImportedData ? store.neurons : []
  if (!neurons.length) return ''
  const length = Math.max(...neurons.map(n => n.activityTrace?.length ?? 0), 0)
  if (!length) return ''
  const bucket = Math.max(1, Math.floor(length / SPARK_POINTS))
  const values: number[] = []
  for (let i = 0; i < length; i += bucket) {
    let sum = 0, count = 0
    for (const neuron of neurons) {
      const v = neuron.activityTrace?.[i]
      if (typeof v === 'number') { sum += v; count++ }
    }
    values.push(count ? sum / count : 0)
  }
  const max = Math.max(...values, 1e-6)
  const w = 100 / (values.length - 1 || 1)
  return values.map((v, i) => `${(i * w).toFixed(2)},${(100 - (v / max) * 100).toFixed(1)}`).join(' ')
})

// ---- 视频式自由滑动：按下即定位，拖动全程实时联动（视频 / 3D / 看板同步刷新） ----
const track = ref<HTMLElement | null>(null)
const dragging = ref(false)
const hoverPct = ref<number | null>(null)
let scrubRaf = 0
let pendingRatio = 0

function ratioFromEvent(e: PointerEvent) {
  const rect = track.value!.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}
function commitSeek(ratio: number) {
  pendingRatio = ratio
  if (scrubRaf) return
  scrubRaf = requestAnimationFrame(() => {
    scrubRaf = 0
    store.setTimestamp(pendingRatio * store.duration)
  })
}
function onTrackDown(e: PointerEvent) {
  if (!store.hasImportedData || !track.value) return
  try { track.value.setPointerCapture(e.pointerId) } catch { /* 合成事件无活动指针，可安全忽略 */ }
  dragging.value = true
  commitSeek(ratioFromEvent(e))
}
function onTrackMove(e: PointerEvent) {
  if (!track.value || !store.hasImportedData) return
  const ratio = ratioFromEvent(e)
  hoverPct.value = ratio * 100
  if (dragging.value) commitSeek(ratio)
}
function onTrackUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  commitSeek(ratioFromEvent(e))
  track.value?.releasePointerCapture(e.pointerId)
}
onBeforeUnmount(() => { if (scrubRaf) cancelAnimationFrame(scrubRaf) })

const cursorPct = computed(() => store.duration > 0 ? (store.currentTimestamp / store.duration) * 100 : 0)
function segStyle(seg: { start: number; end: number; color: string }) {
  const left = (seg.start / store.duration) * 100
  const width = Math.max(((seg.end - seg.start) / store.duration) * 100, 100 / Math.max(store.timeline.length, 1))
  return { left: `${left}%`, width: `${width}%`, background: seg.color }
}

// ---- 跳转：支持 "90"、"01:22"、"01:22.160" 三种输入，回车或按钮触发 ----
const jumpInput = ref('')
const jumpError = ref(false)
function parseJumpInput(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const match = /^(?:(\d+):)?([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(text)
  if (!match) return null
  const minutes = Number(match[1] ?? 0)
  const seconds = Number(match[2])
  const ms = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0
  return minutes * 60 + seconds + ms
}
function doJump() {
  const target = parseJumpInput(jumpInput.value)
  if (target == null || !store.hasImportedData || store.duration <= 0) {
    jumpError.value = !!jumpInput.value.trim()
    return
  }
  jumpError.value = false
  store.setPlaying(false)
  store.setTimestamp(Math.min(Math.max(target, 0), store.duration))
}
</script>

<template>
  <div class="timeline">
    <!-- 左：播放控制 -->
    <div class="tl-controls">
      <button class="tl-btn" title="返回起点" :disabled="!store.hasImportedData" @click="reset">↺</button>
      <button class="tl-btn tl-btn--main" :disabled="!store.hasImportedData" @click="togglePlay">{{ store.playing ? '❚❚' : '▶' }}</button>
      <div class="tl-speed" :class="{ off: !store.hasImportedData }">
        <button v-for="s in speeds" :key="s" :class="{ active: store.playbackSpeed === s }" @click="store.setPlaybackSpeed(s)">{{ s }}×</button>
      </div>
    </div>

    <!-- 中：行为轨 + 群体活动 + 图例 + 游标（可自由拖动） -->
    <div class="tl-tracks" ref="track" :class="{ disabled: !store.hasImportedData, dragging }"
      @pointerdown="onTrackDown" @pointermove="onTrackMove" @pointerup="onTrackUp" @pointerleave="hoverPct = null">
      <div class="tl-behavior">
        <template v-if="segments.length">
          <span v-for="(seg, i) in segments" :key="i" class="seg" :style="segStyle(seg)"
            :title="`${formatTimestamp(seg.start)} · ${seg.label === '待复核' ? seg.label : withBehaviorZh(seg.label)}`"></span>
        </template>
      </div>
      <div class="tl-activity">
        <svg v-if="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline :points="sparkline" fill="none" stroke="#2f7ef7" stroke-width="1.2" vector-effect="non-scaling-stroke" />
        </svg>
      </div>
      <div v-if="legendLabels.length" class="tl-legend">
        <span v-for="item in legendLabels" :key="item.label"><i :style="{ background: item.color }"></i>{{ item.label === '待复核' ? item.label : withBehaviorZh(item.label) }}</span>
      </div>
      <div class="tl-cursor" :style="{ left: cursorPct + '%' }"><i></i></div>
      <div v-if="hoverPct !== null && !dragging" class="tl-hover mono" :style="{ left: hoverPct + '%' }">
        {{ formatTimestamp((hoverPct / 100) * store.duration) }}
      </div>
    </div>

    <!-- 右：跳转 + 当前 / 总时长 -->
    <div class="tl-right">
      <div class="tl-jump" :class="{ error: jumpError, off: !store.hasImportedData }">
        <input v-model="jumpInput" class="mono" placeholder="跳转 01:22" :disabled="!store.hasImportedData"
          @keyup.enter="doJump" @input="jumpError = false" />
        <button :disabled="!store.hasImportedData" @click="doJump">跳转</button>
      </div>
      <span class="tl-time mono">{{ formatTimestamp(store.currentTimestamp) }} / {{ formatTimestamp(store.duration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.timeline { display: flex; align-items: center; gap: 14px; }
.tl-controls { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.tl-btn { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: 14.5px; display: grid; place-items: center; transition: all var(--dur); }
.tl-btn:hover:not(:disabled) { border-color: var(--brand); color: var(--brand-text); background: var(--brand-soft); }
.tl-btn:disabled { opacity: .4; cursor: not-allowed; }
.tl-btn--main { width: 36px; height: 36px; background: var(--brand); border: 0; color: #fff; box-shadow: 0 4px 12px rgba(47,126,247,.28); }
.tl-btn--main:hover:not(:disabled) { background: var(--brand-strong); color: #fff; }
.tl-speed { display: flex; gap: 2px; background: var(--bg-subtle); padding: 2px; border-radius: 8px; }
.tl-speed.off { opacity: .4; pointer-events: none; }
.tl-speed button { border: 0; background: transparent; color: var(--text-muted); font-size: 12px; padding: 3px 7px; border-radius: 6px; font-family: var(--font-mono); }
.tl-speed button.active { background: var(--surface); color: var(--brand-text); font-weight: 700; box-shadow: var(--shadow-sm); }
.tl-tracks { flex: 1; min-width: 0; position: relative; display: flex; flex-direction: column; gap: 4px; padding: 8px 0; cursor: pointer; user-select: none; touch-action: none; }
.tl-tracks.disabled { cursor: default; }
.tl-tracks.dragging { cursor: grabbing; }
.tl-behavior { position: relative; height: 14px; border-radius: 5px; background: var(--bg-subtle); overflow: hidden; }
.seg { position: absolute; top: 0; bottom: 0; opacity: .85; }
.tl-activity { height: 22px; border-radius: 5px; background: var(--bg-subtle); overflow: hidden; }
.tl-activity svg { width: 100%; height: 100%; display: block; }
.tl-cursor { position: absolute; top: 8px; height: 40px; width: 2px; margin-left: -1px; background: var(--brand); z-index: 2; pointer-events: none; }
.tl-cursor i { position: absolute; top: -3px; left: 50%; transform: translateX(-50%); width: 10px; height: 10px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.tl-hover { position: absolute; top: -18px; transform: translateX(-50%); padding: 1px 6px; border-radius: 5px; background: var(--text-strong); color: #fff; font-size: 11.5px; pointer-events: none; z-index: 3; }
.tl-legend { display: flex; flex-wrap: wrap; gap: 3px 10px; pointer-events: none; }
.tl-legend span { display: flex; align-items: center; gap: 4px; color: var(--text-faint); font-size: 11px; text-transform: capitalize; white-space: nowrap; }
.tl-legend i { width: 7px; height: 7px; border-radius: 2px; flex: 0 0 auto; }
.tl-right { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.tl-jump { display: flex; gap: 4px; }
.tl-jump.off { opacity: .45; }
.tl-jump input { width: 86px; padding: 4px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-alt); color: var(--text); font-size: 12.5px; }
.tl-jump input:focus { outline: none; border-color: var(--brand-line); }
.tl-jump.error input { border-color: var(--danger); }
.tl-jump button { padding: 4px 10px; border: 1px solid var(--brand-line); border-radius: 6px; background: var(--brand-soft); color: var(--brand-text); font-size: 12.5px; font-weight: 600; }
.tl-jump button:hover:not(:disabled) { background: var(--brand); color: #fff; }
.tl-jump button:disabled { cursor: not-allowed; }
.tl-time { color: var(--text-muted); font-size: 14.5px; }
@media (max-width: 1100px) { .tl-legend { display: none; } }
</style>
