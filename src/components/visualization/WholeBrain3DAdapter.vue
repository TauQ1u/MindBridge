<script setup lang="ts">
import { createElement, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { WholeBrainRoot, type WholeBrainRootHandle } from '@/modules/neuron3d/WholeBrainRoot'
import type { BrainLoadState } from '@neuron3d/brain/BrainScene'

const props = defineProps<{
  selectedId?: string | null
}>()

const emit = defineEmits<{
  select: [id: string | null]
  loadStateChange: [state: BrainLoadState]
}>()
const host = ref<HTMLElement | null>(null)
let root: Root | null = null
const handle: { current: WholeBrainRootHandle | null } = { current: null }

function render() {
  if (!root) return
  root.render(createElement(WholeBrainRoot, {
    ref: handle as unknown as Ref<WholeBrainRootHandle>,
    selectedId: props.selectedId ?? null,
    onSelect: (id: string | null) => emit('select', id),
    onLoadStateChange: (state) => emit('loadStateChange', state),
  }))
}

onMounted(() => {
  if (!host.value) return
  root = createRoot(host.value)
  render()
})
watch(() => props.selectedId, render)
onBeforeUnmount(() => { root?.unmount(); root = null })

defineExpose({
  getSnapshot: (id: string) => handle.current?.getSnapshot(id) ?? null,
})
</script>

<template><div ref="host" class="react-3d-host" /></template>

<style scoped>
.react-3d-host{width:100%;height:100%;min-height:520px;position:relative;overflow:hidden;background:#000}
.react-3d-host :deep(.scene-container){position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
.react-3d-host :deep(canvas){display:block;width:100%!important;height:100%!important}
.react-3d-host :deep(.penetrate-hint){position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:2;padding:8px 12px;border:1px solid rgba(127,180,255,.35);border-radius:8px;background:rgba(8,16,30,.85);color:#9db8d8;font-size: 14.5px;pointer-events:none;box-shadow:var(--shadow-sm)}
</style>
