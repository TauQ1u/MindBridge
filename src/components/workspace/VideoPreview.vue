<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { formatTimestamp } from '@/utils/time'
import { withBehaviorZh, withSleepZh } from '@/utils/behaviorLabels'
import { apiUrl } from '@/services/api/http'

const emit = defineEmits<{ selectData: [] }>()
const store = useWorkspaceStore()
const videoSrc = computed(() => store.selectedExperiment ? apiUrl(`/api/artifacts/${store.selectedExperiment.condition}.raw.video`) : '')
const video = ref<HTMLVideoElement | null>(null)
const videoFailed = ref(false)

const finalLabel = computed(() => {
  if (!store.hasImportedData) return ''
  const raw = store.currentFrame?.finalLabel
  return raw ? withBehaviorZh(raw) : '待复核'
})
const sleepStage = computed(() => store.hasImportedData ? withSleepZh(store.currentFrame?.sleepStage) : '')

/*
 * 视频下方只保留一个状态标记：
 * 睡眠帧（最终行为即 NREM/REM/MA）显示睡眠阶段，
 * 清醒行为帧显示最终行为，避免两行重复显示同一状态。
 */
const SLEEP_LABELS = new Set(['NREM', 'REM', 'MA'])
const overlay = computed(() => {
  if (!store.hasImportedData) return null
  const raw = store.currentFrame?.finalLabel
  if (raw && SLEEP_LABELS.has(raw)) return { label: '睡眠阶段', value: sleepStage.value || '—' }
  return { label: '最终行为', value: finalLabel.value || '—' }
})

// currentTimestamp → video：播放时由原生视频时钟推进，暂停/拖动时执行精确 seek
watch(() => store.currentTimestamp, (timestamp) => {
  const el = video.value
  if (!el || store.playing || !Number.isFinite(timestamp)) return
  if (Math.abs(el.currentTime - timestamp) > 0.08) el.currentTime = timestamp
})

// 播放状态联动：store.playing 是唯一播放控制源
watch(() => store.playing, (playing) => {
  const el = video.value
  if (!el) return
  if (playing) {
    el.playbackRate = store.playbackSpeed
    void el.play().catch(() => { /* 浏览器自动播放限制：时间轴仍由统一时钟驱动 */ })
  } else {
    el.pause()
  }
})
watch(() => store.playbackSpeed, (speed) => { if (video.value) video.value.playbackRate = speed })
watch(videoSrc, () => { videoFailed.value = false })

// 原生视频是唯一播放时钟：限制为约 30Hz，避免 60Hz 全局响应式重绘
let lastPublishedTime = -1
function onTimeUpdate() {
  const time = video.value?.currentTime
  if (time == null || !Number.isFinite(time)) return
  if (Math.abs(time - lastPublishedTime) < 0.033 && store.playing) return
  lastPublishedTime = time
  store.setTimestamp(time)
}
</script>

<template>
  <section class="video-panel">
    <div class="video-stage" v-if="videoSrc && !videoFailed">
      <video ref="video" :src="videoSrc" crossorigin="use-credentials" muted preload="metadata" playsinline
        @timeupdate="onTimeUpdate" @error="videoFailed = true"
        @play="store.setPlaying(true)" @pause="store.setPlaying(false)"></video>
      <span class="video-time mono">{{ formatTimestamp(store.currentTimestamp) }}</span>
      <div class="video-overlay" v-if="overlay">
        <div class="overlay-row"><span>{{ overlay.label }}</span><strong>{{ overlay.value }}</strong></div>
      </div>
    </div>
    <div class="video-empty" v-else>
      <p>{{ videoFailed ? '视频加载失败' : '— 尚未加载实验 —' }}</p>
      <span>{{ videoFailed ? '检查原始数据中是否存在 video.mp4' : '导入实验后此处显示同步行为视频' }}</span>
      <button v-if="!videoFailed" type="button" @click="emit('selectData')">选择实验数据</button>
    </div>
  </section>
</template>

<style scoped>
.video-panel { flex: 0 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-sm); }
.video-stage { position: relative; background: #101b2e; aspect-ratio: 16 / 9; }
.video-stage video { width: 100%; height: 100%; object-fit: contain; display: block; }
.video-time { position: absolute; top: 8px; right: 10px; padding: 2px 8px; border-radius: 6px; background: rgba(15,25,45,.72); color: #fff; font-size: 13px; }
.video-overlay { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 16px; padding: 8px 12px; background: linear-gradient(transparent, rgba(15,25,45,.85) 45%); }
.overlay-row { display: flex; flex-direction: column; gap: 1px; }
.overlay-row span { font-size: 11px; letter-spacing: .8px; color: rgba(255,255,255,.62); }
.overlay-row strong { font-size: 15.5px; color: #fff; text-transform: capitalize; }
.video-empty { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: var(--bg-subtle); }
.video-empty p { color: var(--text-faint); font-size: 14.5px; }
.video-empty span { color: var(--text-faint); font-size: 12px; }
.video-empty button { margin-top: 8px; padding: 8px 16px; border: 0; border-radius: 8px; background: var(--brand); color: #fff; font-size: 14.5px; font-weight: 600; box-shadow: 0 4px 12px rgba(47,126,247,.24); }
</style>
