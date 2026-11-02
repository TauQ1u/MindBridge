<script setup lang="ts">
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MPFCNeuronRoot } from '@/modules/neuron3d/MPFCNeuronRoot'
import { visualizationApi, type VisualizationDataset } from '@/services/api/visualizationApi'

const props = defineProps<{
  conditionId?: string
  currentTimestamp: number
  selectedNeuronId?: string
  highlightNeuronIds?: string[]
  topNeuronIds?: string[]
  highlightColor?: string
}>()
const emit = defineEmits<{
  neuronSelect: [id: string | null]
  ready: [metadata: Record<string, unknown> | null]
  error: [message: string]
}>()
const host = ref<HTMLElement | null>(null)
const status = ref<'empty' | 'loading' | 'ready' | 'error'>('empty')
const errorMessage = ref('')
let root: Root | null = null
let dataset: VisualizationDataset | null = null
let controller: AbortController | null = null

/*
 * 渲染去重：神经数据按帧网格采样（约 0.5s 一帧），
 * 播放时 currentTimestamp 每帧视频都会变化，但 3D 场景
 * 只需要帧粒度更新。量化到帧索引后跳过重复渲染，
 * 把 React 重渲染频率从 ~30 次/s 降到 ~2 次/s。
 */
let lastRenderedIndex = -1
let lastRenderedNeuron: string | undefined
let lastRenderedHighlight = ''

function frameIndexFor(timestamp: number) {
  const frames = dataset?.frames
  if (!frames || frames.length < 2) return 0
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (Number(frames[mid].stamp) < timestamp) lo = mid + 1
    else hi = mid
  }
  if (lo === 0) return 0
  return Math.abs(Number(frames[lo].stamp) - timestamp) < Math.abs(Number(frames[lo - 1].stamp) - timestamp) ? lo : lo - 1
}

function render() {
  if (!root || !dataset) return
  const index = frameIndexFor(props.currentTimestamp)
  const highlightKey = `${(props.highlightNeuronIds ?? []).join(',')}|${(props.topNeuronIds ?? []).join(',')}|${props.highlightColor ?? ''}`
  if (index === lastRenderedIndex && props.selectedNeuronId === lastRenderedNeuron && highlightKey === lastRenderedHighlight) return
  lastRenderedIndex = index
  lastRenderedNeuron = props.selectedNeuronId
  lastRenderedHighlight = highlightKey
  root.render(createElement(MPFCNeuronRoot, {
    dataset,
    currentTimestamp: props.currentTimestamp,
    selectedNeuronId: props.selectedNeuronId,
    highlightNeuronIds: props.highlightNeuronIds,
    topNeuronIds: props.topNeuronIds,
    highlightColor: props.highlightColor,
    onNeuronSelect: (id) => emit('neuronSelect', id),
  }))
}

async function load(conditionId?: string) {
  controller?.abort()
  dataset = null
  lastRenderedIndex = -1
  if (!conditionId) { status.value = 'empty'; root?.render(null); return }
  controller = new AbortController()
  status.value = 'loading'
  errorMessage.value = ''
  try {
    dataset = await visualizationApi.loadCondition(conditionId, controller.signal)
    status.value = 'ready'
    render()
    emit('ready', dataset.metadata)
  } catch (error) {
    if (controller.signal.aborted) return
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '3D 数据加载失败'
    emit('error', errorMessage.value)
  }
}

onMounted(() => { if (host.value) root = createRoot(host.value); void load(props.conditionId) })
watch(() => props.conditionId, (value) => void load(value))
watch(() => [props.currentTimestamp, props.selectedNeuronId, props.highlightNeuronIds, props.topNeuronIds, props.highlightColor], render)
onBeforeUnmount(() => { controller?.abort(); root?.unmount(); root = null })
</script>

<template>
  <div class="adapter-stage">
    <div ref="host" class="react-3d-host" :class="{ hidden: status !== 'ready' }" />
    <div v-if="status !== 'ready'" class="adapter-state">
      <strong>{{ status === 'loading' ? '正在加载 mPFC 可视化…' : status === 'error' ? '可视化加载失败' : '尚未导入实验数据' }}</strong>
      <span>{{ status === 'error' ? errorMessage : status === 'empty' ? '完成数据处理与一致性复核后加载实验动态层。' : '正在解析活动、位置与功能连接数据。' }}</span>
      <button v-if="status === 'error'" type="button" @click="load(conditionId)">重试</button>
    </div>
  </div>
</template>

<style scoped>
.adapter-stage,.react-3d-host{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}.react-3d-host{background:var(--scene-bg-neuron)}.react-3d-host.hidden{visibility:hidden}.react-3d-host :deep(.scene-container){position:absolute;inset:0;width:100%;height:100%;overflow:hidden}.react-3d-host :deep(canvas){display:block;width:100%!important;height:100%!important}.adapter-state{position:absolute;inset:0;display:grid;place-content:center;gap:8px;text-align:center;padding:32px;background:var(--scene-bg-neuron);color:#dbe7f5}.adapter-state span{max-width:360px;color:#7d93b2;font-size: 14.5px;line-height:1.6}.adapter-state button{justify-self:center;margin-top:6px;padding:7px 14px;border:1px solid rgba(127,180,255,.4);border-radius:8px;background:rgba(255,255,255,.08);color:#7fb4ff}
/* 原版 NeuronScene 自带的场景装配遮罩（模型加载期间显示） */
.react-3d-host :deep(.neuron-loading-mask){position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#000;color:#dbe7f5;font-size: 15px;pointer-events:none}
.react-3d-host :deep(.neuron-loading-mask span){color:#7d93b2;font-size: 13px}
.react-3d-host :deep(.intro-loading-spinner){animation:adapter-spin 1s linear infinite;color:#4fc3e8}
@keyframes adapter-spin{to{transform:rotate(360deg)}}
</style>
