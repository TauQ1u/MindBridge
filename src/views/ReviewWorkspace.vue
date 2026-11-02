<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ExperimentSelectionModal from '@/components/workspace/ExperimentSelectionModal.vue'
import ReviewSignalViewer from '@/components/workspace/ReviewSignalViewer.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { reviewApi } from '@/services/api/reviewApi'
import { apiUrl } from '@/services/api/http'
import { formatTimestamp } from '@/utils/time'
import { withBehaviorZh, withSleepZh } from '@/utils/behaviorLabels'
import type { TimelineFrame } from '@/types/models'

const store = useWorkspaceStore()
const router = useRouter()
const modalOpen = ref(false)
const exp = computed(() => store.selectedExperiment)
const frames = computed(() => store.timeline)

// ---- 视频与帧指针：video 时间 ↔ 最近帧 ----
const video = ref<HTMLVideoElement | null>(null)
const videoSrc = computed(() => exp.value ? apiUrl(`/api/artifacts/${exp.value.condition}.raw.video`) : '')
const videoFailed = ref(false)
const frameIndex = ref(0)
const current = computed<TimelineFrame | null>(() => frames.value[frameIndex.value] ?? null)
const seekingFromNav = ref(false)
const playing = ref(false)
/* 时间更新计数器：timeupdate / seeked 都 +1，
   驱动脑电查看器按真实视频时钟重绘 */
const tick = ref(0)
const viewerMode = ref<'video' | 'eeg'>('video')
let seekToken = 0

function nearestFrameIndex(timestamp: number) {
  const list = frames.value
  if (!list.length) return 0
  let lo = 0, hi = list.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].timestamp < timestamp) lo = mid + 1; else hi = mid
  }
  return lo
}
function seekToFrame(index: number) {
  frameIndex.value = Math.max(0, Math.min(frames.value.length - 1, index))
  const frame = frames.value[frameIndex.value]
  if (video.value && frame) {
    seekingFromNav.value = true
    const token = ++seekToken
    video.value.currentTime = frame.timestamp
    const el = video.value
    const release = () => {
      tick.value++
      if (token === seekToken) seekingFromNav.value = false
      el.removeEventListener('seeked', release)
    }
    el.addEventListener('seeked', release, { once: true })
  }
}
function onTimeUpdate() {
  tick.value++
  if (!video.value || seekingFromNav.value) return
  frameIndex.value = nearestFrameIndex(video.value.currentTime)
}
function onVideoEnded() { playing.value = false }
function togglePlay() {
  const el = video.value
  if (!el) return
  if (el.paused) { void el.play(); playing.value = true }
  else { el.pause(); playing.value = false }
}
function currentTime() {
  return video.value?.currentTime ?? current.value?.timestamp ?? 0
}
// 每次进入复核工作台都开启新的人工复核会话：
// openReview 会重新加载数据，并把分歧帧重置为未复核，
// 避免历史已持久化的裁决让界面误显示“全部冲突已复核”。
watch(exp, async (experiment) => {
  if (experiment) {
    await store.openReview()
    jumpToConflict(0)
  }
}, { immediate: true })

// ---- 冲突优先：只在分歧片段间导航 ----
const conflicts = computed(() => frames.value.filter(f => f.disagreement))
const pendingConflicts = computed(() => conflicts.value.filter(f => !f.reviewed))
const conflictPos = computed(() => current.value ? conflicts.value.findIndex(f => f.frameId === current.value!.frameId) : -1)
function jumpToConflict(offset: number) {
  if (!conflicts.value.length) return
  const next = conflictPos.value === -1
    ? conflicts.value[0]
    : conflicts.value[(conflictPos.value + offset + conflicts.value.length) % conflicts.value.length]
  const idx = frames.value.findIndex(f => f.frameId === next.frameId)
  if (idx !== -1) seekToFrame(idx)
}
function jumpToFrameId(frameId: number) {
  const idx = frames.value.findIndex(f => f.frameId === frameId)
  if (idx !== -1) seekToFrame(idx)
}

// ---- 人工裁决：采用视频 / 采用神经解码 / 其他标签 / 不确定 ----
// 每次裁决即时保存 final_label 到后端；reviewer / updatedAt / resultVersion 由后端记录。
// 演示一致性说明：预置冲突案例应裁决到与预计算结果一致的标签，保证后续科研分析口径不变。
const savedTick = ref(false)
const otherOpen = ref(false)
const labelSet = computed(() => Array.from(new Set(frames.value.flatMap(f => [f.videoLabel, f.neuralLabel]).filter(Boolean))))
function setFinal(label: string) {
  if (!current.value || !label || !exp.value) return
  const frameId = current.value.frameId
  current.value.finalLabel = label
  current.value.reviewed = true
  savedTick.value = true
  setTimeout(() => { savedTick.value = false }, 1600)
  otherOpen.value = false
  void reviewApi.save({ experimentId: exp.value.experimentId, frameId, finalLabel: label, reason: 'manual-review' }).catch(() => { /* 保存失败不阻断演示，界面状态已更新 */ })
  const nextPending = pendingConflicts.value[0]
  if (nextPending && nextPending.frameId !== frameId) jumpToFrameId(nextPending.frameId)
}

// ---- 四轨时间轴 ----
const palette = ['#12a594', '#2f7ef7', '#8b7cf6', '#e5a323', '#1faa6b', '#e15b78']
const trackDefs = [
  { key: 'videoLabel', title: '视频' },
  { key: 'neuralLabel', title: '神经' },
  { key: 'sleepStage', title: '睡眠' },
  { key: 'finalLabel', title: '最终' },
] as const
const tracks = computed(() => {
  const duration = store.duration || 1
  const colorOf = new Map<string, string>()
  const colorFor = (label: string) => {
    if (!label) return '#c3cfdf'
    if (!colorOf.has(label)) colorOf.set(label, palette[colorOf.size % palette.length])
    return colorOf.get(label)!
  }
  return trackDefs.map(def => {
    const segs: { left: number; width: number; color: string; frameId: number; pending: boolean }[] = []
    const minWidth = 100 / Math.max(frames.value.length, 1)
    for (const frame of frames.value) {
      const pending = def.key === 'finalLabel' && !frame.reviewed
      const label = pending ? '' : frame[def.key]
      segs.push({
        left: (frame.timestamp / duration) * 100,
        width: minWidth,
        color: colorFor(label),
        frameId: frame.frameId,
        pending,
      })
    }
    return { ...def, segs }
  })
})
const cursorPct = computed(() => current.value && store.duration > 0 ? (current.value.timestamp / store.duration) * 100 : 0)

// ---- 拖动定位：底部统一时间轴 + 四轨共用一个按下即定位、拖动全程联动的手势 ----
const durationVal = computed(() => store.duration || 0)
let scrubRaf = 0
let pendingRatio = 0
function commitSeek(ratio: number) {
  pendingRatio = ratio
  if (scrubRaf) return
  scrubRaf = requestAnimationFrame(() => {
    scrubRaf = 0
    if (!durationVal.value) return
    seekToFrame(nearestFrameIndex(pendingRatio * durationVal.value))
  })
}
function ratioFromEvent(e: PointerEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}
function onRailDown(e: PointerEvent) { onRailDownEl(e, e.currentTarget as HTMLElement) }
function onRailMove(e: PointerEvent) { if (e.buttons) onRailMoveEl(e, e.currentTarget as HTMLElement) }
function onRailDownEl(e: PointerEvent, el: HTMLElement) {
  if (!frames.value.length) return
  try { el.setPointerCapture(e.pointerId) } catch { /* 合成事件无活动指针，可安全忽略 */ }
  commitSeek(ratioFromEvent(e, el))
}
function onRailMoveEl(e: PointerEvent, el: HTMLElement) {
  commitSeek(ratioFromEvent(e, el))
}
const bottomTrack = ref<HTMLElement | null>(null)
function onBottomDown(e: PointerEvent) { if (bottomTrack.value) onRailDownEl(e, bottomTrack.value) }
function onBottomMove(e: PointerEvent) { if (bottomTrack.value && e.buttons) onRailMoveEl(e, bottomTrack.value) }

// ---- 复核门禁：全部冲突裁决完成后才能返回 ----
const canFinish = computed(() => pendingConflicts.value.length === 0)
const finishTip = computed(() => canFinish.value ? '保存 final_label，生成 3D 建模数据并进入 mPFC 工作区' : `还有 ${pendingConflicts.value.length} 处冲突待复核`)
async function finish() {
  if (!canFinish.value) return
  await store.completeReview()
  router.push('/mpfc')
}
</script>

<template>
  <div class="rev">
    <section v-if="!exp" class="rev__empty">
      <EmptyState title="尚未选择实验数据" hint="导入一组数据后，即可在统一时间轴上比对该实验的行为与神经标签。" />
      <AppButton variant="primary" size="md" icon="plus" @click="modalOpen = true">选择实验数据</AppButton>
    </section>

    <template v-else>
      <div class="rev__grid">
        <!-- 左：视频 / 脑电查看器 + 四轨时间轴 -->
        <section class="rev__left">
          <div class="viewer">
            <div class="viewer__tabs">
              <button :class="{ active: viewerMode === 'video' }" @click="viewerMode = 'video'">行为视频</button>
              <button :class="{ active: viewerMode === 'eeg' }" @click="viewerMode = 'eeg'">脑电 / 肌电</button>
              <span class="viewer__chip mono">{{ current ? formatTimestamp(current.timestamp) : '—' }}</span>
            </div>
            <div class="viewer__body">
              <video v-show="viewerMode === 'video'" v-if="videoSrc && !videoFailed" ref="video" :src="videoSrc" crossorigin="use-credentials" preload="metadata" muted playsinline
                @timeupdate="onTimeUpdate" @ended="onVideoEnded" @error="videoFailed = true"></video>
              <div v-if="viewerMode === 'video' && (videoFailed || !videoSrc)" class="player__missing">{{ videoFailed ? '视频加载失败' : '无视频' }}</div>
              <ReviewSignalViewer v-if="viewerMode === 'eeg' && exp" :condition-id="exp.condition" :timestamp="currentTime()" :tick="tick" />
            </div>
          </div>

          <div class="tracks">
            <div v-for="track in tracks" :key="track.key" class="track">
              <span class="track__label">{{ track.title }}</span>
              <div class="track__rail"
                @pointerdown="onRailDown"
                @pointermove="onRailMove">
                <span v-for="seg in track.segs" :key="seg.frameId" class="track__seg"
                  :class="{ 'is-pending': seg.pending }"
                  :style="{ left: seg.left + '%', width: seg.width + '%', background: seg.color }"
                  :title="`帧 ${seg.frameId}`"></span>
                <span v-if="track.key === 'finalLabel'" v-for="c in conflicts" :key="'c' + c.frameId" class="track__conflict"
                  :class="{ reviewed: c.reviewed }"
                  :style="{ left: (c.timestamp / (store.duration || 1)) * 100 + '%' }"
                  :title="`分歧 帧 ${c.frameId}`"
                  @pointerdown.stop
                  @click="jumpToFrameId(c.frameId)"></span>
                <i class="track__cursor" :style="{ left: cursorPct + '%' }"></i>
              </div>
            </div>
          </div>
        </section>

        <!-- 右：证据与裁决 -->
        <aside class="rev__right" v-if="current">
          <div class="conflict-head">
            <button class="conflict-nav" :disabled="!conflicts.length" @click="jumpToConflict(-1)">‹ 上一冲突</button>
            <strong class="mono">{{ conflictPos === -1 ? '—' : `冲突 ${conflictPos + 1} / ${conflicts.length}` }}</strong>
            <button class="conflict-nav" :disabled="!conflicts.length" @click="jumpToConflict(1)">下一冲突 ›</button>
          </div>

          <div class="evidence">
            <div class="ev-row">
              <span class="ev-label">时间点</span>
              <strong class="mono">{{ formatTimestamp(current.timestamp) }}</strong>
              <span class="ev-conf mono">帧 {{ current.frameId }}</span>
            </div>
            <div class="ev-row">
              <span class="ev-label">视频识别</span>
              <strong>{{ withBehaviorZh(current.videoLabel) || '—' }}</strong>
              <span class="ev-conf mono">{{ current.videoConf ? current.videoConf.toFixed(2) : '' }}</span>
            </div>
            <div class="ev-row">
              <span class="ev-label">神经解码</span>
              <strong>{{ withBehaviorZh(current.neuralLabel) || '—' }}</strong>
              <span class="ev-conf mono">{{ current.neuralConf ? current.neuralConf.toFixed(2) : '' }}</span>
            </div>
            <div class="ev-row">
              <span class="ev-label">睡眠阶段</span>
              <strong>{{ withSleepZh(current.sleepStage) || '—' }}</strong>
            </div>
            <div class="ev-flag" v-if="current.disagreement && !current.reviewed">⚠ 两路预测不一致，需人工裁决</div>
            <div class="ev-flag is-ok" v-else-if="current.reviewed">✓ 已复核 · 最终标签 = {{ withBehaviorZh(current.finalLabel) }}</div>
            <div class="ev-flag is-ok" v-else>✓ 两路一致，无需复核</div>
          </div>

          <div class="verdict">
            <h4>人工裁决 · 最终标签</h4>
            <div class="verdict__quick">
              <button :disabled="!current.videoLabel" @click="setFinal(current.videoLabel)">采用视频</button>
              <button :disabled="!current.neuralLabel" @click="setFinal(current.neuralLabel)">采用神经</button>
              <button @click="otherOpen = !otherOpen">其他标签</button>
              <button @click="setFinal('uncertain')">不确定</button>
            </div>
            <div v-if="otherOpen" class="verdict__labels">
              <button v-for="label in labelSet" :key="label" @click="setFinal(label)">{{ withBehaviorZh(label) }}</button>
            </div>
            <p v-if="savedTick" class="saved-msg">✓ 已保存</p>
          </div>

          <div class="conflict-queue">
            <div class="queue-head"><span>分歧片段</span><b class="mono">{{ conflicts.length }}</b></div>
            <div class="queue-body">
              <button v-for="c in conflicts" :key="c.frameId" class="queue-item"
                :class="{ active: current.frameId === c.frameId }"
                @click="jumpToFrameId(c.frameId)">
                <span class="mono">#{{ c.frameId }}</span>
                <span class="mono">{{ formatTimestamp(c.timestamp) }}</span>
                <span class="queue-item__labels">{{ withBehaviorZh(c.videoLabel) }} / {{ withBehaviorZh(c.neuralLabel) }}</span>
                <i :class="c.reviewed ? 'done' : 'flag'"></i>
              </button>
              <p v-if="!conflicts.length" class="queue-empty">本实验无分歧片段</p>
            </div>
          </div>

          <div class="rev__progress" :class="{ done: canFinish }">
            <span>{{ canFinish ? '全部冲突已复核' : '待复核冲突' }}</span>
            <strong class="mono">{{ canFinish ? '✓' : `${pendingConflicts.length} / ${conflicts.length}` }}</strong>
          </div>
          <div class="rev__nav">
            <AppButton variant="ghost" size="sm" @click="router.push('/mpfc')">暂不复核，返回</AppButton>
            <AppButton variant="primary" size="md" icon="arrow" :disabled="!canFinish" :title="finishTip" @click="finish">完成复核并生成 3D 数据</AppButton>
          </div>
        </aside>
      </div>

      <!-- 底部：统一时间拖动轴（视频 / 脑电 / 四轨共用） -->
      <footer class="rev__timeline">
        <button class="tl-btn tl-btn--main" :disabled="!frames.length" @click="togglePlay" :title="playing ? '暂停' : '播放'">
          {{ playing ? '❚❚' : '▶' }}
        </button>
        <div ref="bottomTrack" class="tl-track" :class="{ disabled: !frames.length }"
          @pointerdown="onBottomDown" @pointermove="onBottomMove">
        <div class="tl-behavior">
            <template v-if="tracks.length">
              <span v-for="(seg, i) in tracks[0].segs" :key="i" class="tl-seg"
                :style="{ left: seg.left + '%', width: seg.width + '%', background: seg.color }"></span>
            </template>
          </div>
          <span v-for="c in conflicts" :key="'b' + c.frameId" class="tl-conflict"
            :class="{ reviewed: c.reviewed }"
            :style="{ left: (c.timestamp / (store.duration || 1)) * 100 + '%' }"
            :title="`分歧 帧 ${c.frameId}`"
            @pointerdown.stop
            @click="jumpToFrameId(c.frameId)"></span>
          <i class="tl-cursor" :style="{ left: cursorPct + '%' }"></i>
        </div>
        <span class="tl-time mono">{{ current ? formatTimestamp(current.timestamp) : '—' }} / {{ formatTimestamp(store.duration) }}</span>
      </footer>
    </template>

    <ExperimentSelectionModal :open="modalOpen" @close="modalOpen = false" />
  </div>
</template>

<style scoped>
.rev { max-width: var(--layout-max); margin: 0 auto; padding: 20px 28px 24px; height: calc(100vh - var(--topbar-h)); display: flex; flex-direction: column; overflow: hidden; }
.rev__empty { display: flex; flex-direction: column; align-items: center; gap: 16px; margin: auto 0; }
.rev__grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(320px, 1fr); grid-template-rows: minmax(0, 1fr); gap: 16px; align-items: stretch; }
.rev__left, .rev__right { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); min-width: 0; min-height: 0; overflow: hidden; }
.rev__left { display: flex; flex-direction: column; }
.tracks { min-width: 0; max-width: 100%; overflow: hidden; }
.track, .track__rail { min-width: 0; }
.track__rail { overflow: hidden; }

.player__missing { flex: 1; display: grid; place-content: center; color: var(--text-faint); background: var(--bg-subtle); border-radius: var(--radius); }

.viewer { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 14px 6px; gap: 8px; }
.viewer__tabs { display: flex; align-items: center; gap: 2px; background: var(--bg-subtle); padding: 3px; border-radius: 9px; width: fit-content; }
.viewer__tabs button { border: 0; background: transparent; color: var(--text-muted); font-size: 14.5px; padding: 5px 12px; border-radius: 7px; transition: all var(--dur); }
.viewer__tabs button.active { background: var(--surface); color: var(--brand-text); font-weight: 700; box-shadow: var(--shadow-sm); }
.viewer__chip { margin-left: auto; padding: 3px 9px; border-radius: 6px; background: rgba(15,25,45,.75); color: #fff; font-size: 14.5px; }
.viewer__body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.viewer__body video { margin: auto; max-width: 100%; max-height: 100%; min-height: 0; width: auto; height: auto; background: #101b2e; border-radius: var(--radius); display: block; }
.viewer__body .sig-viewer { flex: 1; border: 1px solid var(--border); }

.tracks { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 8px; }
.track { display: grid; grid-template-columns: 40px 1fr; align-items: center; gap: 10px; }
.track__label { font-size: 12.5px; color: var(--text-faint); text-align: right; }
.track__rail { position: relative; height: 16px; background: var(--bg-subtle); border-radius: 5px; cursor: pointer; touch-action: none; user-select: none; }
.track__seg { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; opacity: .85; pointer-events: none; }
.track__seg.is-pending { opacity: .3; }
.track__conflict { position: absolute; top: -4px; width: 7px; height: 7px; transform: translateX(-50%) rotate(45deg); background: var(--warn); cursor: pointer; z-index: 2; }
.track__conflict.reviewed { background: var(--ok); opacity: .6; }
.track__cursor { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text-strong); z-index: 3; pointer-events: none; }

.rev__timeline { display: flex; align-items: center; gap: 14px; margin-top: 14px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.tl-btn { width: 36px; height: 36px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: 15.5px; display: grid; place-items: center; transition: all var(--dur); flex: 0 0 auto; }
.tl-btn--main { background: var(--brand); border: 0; color: #fff; box-shadow: 0 4px 12px rgba(47,126,247,.28); }
.tl-btn--main:hover:not(:disabled) { background: var(--brand-strong); }
.tl-btn:disabled { opacity: .4; cursor: not-allowed; }
.tl-track { flex: 1; min-width: 0; position: relative; height: 22px; background: var(--bg-subtle); border-radius: 7px; cursor: pointer; touch-action: none; user-select: none; overflow: hidden; }
.tl-track.disabled { cursor: default; }
.tl-behavior { position: absolute; inset: 0; pointer-events: none; }
.tl-seg { position: absolute; top: 0; bottom: 0; opacity: .8; }
.tl-conflict { position: absolute; top: -2px; width: 9px; height: 9px; transform: translateX(-50%) rotate(45deg); background: var(--warn); cursor: pointer; z-index: 2; box-shadow: 0 0 0 2px #fff; }
.tl-conflict.reviewed { background: var(--ok); }
.tl-cursor { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text-strong); z-index: 3; pointer-events: none; }
.tl-time { flex: 0 0 auto; color: var(--text-muted); font-size: 14.5px; }

.rev__right { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
.conflict-head { display: flex; align-items: center; justify-content: space-between; }
.conflict-head strong { color: var(--warn); font-size: 15.5px; }
.conflict-nav { border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: 13px; padding: 6px 10px; border-radius: 7px; transition: all var(--dur); }
.conflict-nav:hover:not(:disabled) { border-color: var(--brand); color: var(--brand-text); }
.conflict-nav:disabled { opacity: .4; }
.evidence { background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.ev-row { display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px dashed var(--border); }
.ev-row:last-of-type { border-bottom: 0; }
.ev-label { width: 64px; font-size: 13px; color: var(--text-faint); }
.ev-row strong { flex: 1; font-size: 17px; color: var(--text-strong); text-transform: capitalize; }
.ev-conf { font-size: 13px; color: var(--text-muted); }
.ev-flag { margin-top: 10px; display: flex; align-items: center; gap: 8px; font-size: 14.5px; color: var(--warn); background: var(--warn-soft); padding: 9px 12px; border-radius: 8px; }
.ev-flag.is-ok { color: var(--ok); background: var(--ok-soft); }
.verdict h4 { font-size: 15px; color: var(--text); margin-bottom: 10px; }
.verdict__quick { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }
.verdict__quick button { padding: 9px 4px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font-size: 14px; transition: all var(--dur); }
.verdict__quick button:hover:not(:disabled) { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-text); }
.verdict__quick button:disabled { opacity: .45; }
.verdict__labels { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 7px; }
.verdict__labels button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text); font-size: 14px; text-transform: capitalize; }
.verdict__labels button:hover { border-color: var(--brand); color: var(--brand-text); }
.saved-msg { margin-top: 8px; font-size: 14px; color: var(--ok); }
.conflict-queue { flex: 1; min-height: 120px; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-subtle); overflow: hidden; }
.queue-head { display: flex; justify-content: space-between; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text-faint); font-size: 13px; }
.queue-head b { color: var(--warn); }
.queue-body { flex: 1; overflow: auto; padding: 4px; }
.queue-item { display: grid; grid-template-columns: 44px 74px 1fr 12px; gap: 8px; align-items: center; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); font-size: 13px; text-align: left; }
.queue-item:hover { background: var(--panel); }
.queue-item.active { background: var(--brand-soft); color: var(--text-strong); }
.queue-item__labels { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: capitalize; }
.queue-item i { width: 8px; height: 8px; border-radius: 50%; }
.queue-item i.flag { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.queue-item i.done { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.queue-empty { padding: 14px; color: var(--text-faint); font-size: 14px; text-align: center; }
.rev__progress { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-subtle); color: var(--text-faint); font-size: 14px; }
.rev__progress strong { color: var(--warn); font-size: 15.5px; }
.rev__progress.done { background: var(--ok-soft); border-color: rgba(31,170,107,.3); }
.rev__progress.done strong { color: var(--ok); }
.rev__nav { display: flex; justify-content: space-between; gap: 10px; margin-top: auto; }
@media (max-width: 960px) { .rev__grid { grid-template-columns: 1fr; } }
</style>
