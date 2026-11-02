<script setup lang="ts">
withDefaults(defineProps<{ open: boolean; title: string; width?: string; sub?: string }>(), { width: '620px', sub: '' })
defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-overlay" @click.self="$emit('close')">
        <div class="modal-panel" :style="{ maxWidth: width }" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-title-wrap">
              <h3 class="modal-title">{{ title }}</h3>
              <p v-if="sub" class="modal-sub">{{ sub }}</p>
            </div>
            <button class="modal-close" aria-label="关闭" @click="$emit('close')">×</button>
          </div>
          <div class="modal-body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay { position: fixed; inset:0; background: rgba(22,35,31,.36); backdrop-filter: blur(3px); display:flex; align-items:center; justify-content:center; padding: 24px; z-index: 100; }
.modal-panel { width: 100%; background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); overflow: hidden; display:flex; flex-direction: column; max-height: 86vh; }
.modal-head { display:flex; align-items:center; justify-content:space-between; padding: 18px 22px; border-bottom: 1px solid var(--border); }
.modal-title { font-size: 19px; color: var(--text-strong); letter-spacing: -.2px; }
.modal-sub { font-size: 14.5px; color: var(--text-faint); margin-top: 2px; }
.modal-close { border:0; background: transparent; font-size: 29px; line-height:1; color: var(--text-faint); width:30px; height:30px; border-radius:8px; }
.modal-close:hover { background: var(--bg-subtle); color: var(--text); }
.modal-body { overflow-y:auto; padding: 8px 0; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--dur) var(--ease); }
.modal-enter-active .modal-panel { transition: transform var(--dur) var(--ease); }
.modal-enter-from, .modal-leave-to { opacity:0; }
.modal-enter-from .modal-panel { transform: translateY(12px) scale(.98); }
</style>