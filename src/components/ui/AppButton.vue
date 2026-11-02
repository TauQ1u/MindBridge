<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'soft' | 'ghost' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  icon?: string
  loading?: boolean
}>(), { variant: 'soft', size: 'md', icon: '', loading: false })

defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <button class="app-btn" :class="[`app-btn--${variant}`, `app-btn--${size}`]" :disabled="loading" @click="$emit('click', $event)">
    <span v-if="loading" class="btn-spinner" aria-hidden="true"></span>
    <svg v-else-if="icon" class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path v-if="icon==='plus'" d="M12 5v14M5 12h14"/><path v-else-if="icon==='arrow'" d="M5 12h14M13 6l6 6-6 6"/><path v-else-if="icon==='download'" d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/><path v-else-if="icon==='play'" d="M8 5v14l11-7z"/><path v-else-if="icon==='upload'" d="M12 15V3m0 0 4 4m-4-4L8 7M4 21h16"/><path v-else-if="icon==='close'" d="M6 6l12 12M18 6 6 18"/></svg>
    <span class="btn-label"><slot /></span>
  </button>
</template>

<style scoped>
.app-btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; border-radius: var(--radius-sm); font-weight:600; border:1px solid transparent; transition: all var(--dur) var(--ease); white-space: nowrap; }
.app-btn:disabled { opacity:.55; cursor: not-allowed; }
.btn-label { line-height:1; }
.btn-icon { width: 15px; height:15px; }
.app-btn--sm { padding: 6px 12px; font-size: 14.5px; }
.app-btn--md { padding: 8px 16px; font-size: 15.5px; }
.app-btn--lg { padding: 11px 22px; font-size: 17px; }
.app-btn--primary { background: var(--brand); color: #fff; box-shadow: 0 3px 10px rgba(15,157,143,.24); }
.app-btn--primary:hover { background: var(--brand-strong); transform: translateY(-1px); }
.app-btn--soft { background: var(--brand-soft); color: var(--brand-text); }
.app-btn--soft:hover { background: var(--brand-line); }
.app-btn--ghost { background: transparent; color: var(--text-muted); }
.app-btn--ghost:hover { background: var(--bg-subtle); color: var(--text); }
.app-btn--outline { background: var(--surface); border-color: var(--border-strong); color: var(--text); }
.app-btn--outline:hover { border-color: var(--brand); color: var(--brand-text); background: var(--brand-soft); }
.btn-spinner { width:14px; height:14px; border-radius:50%; border:2px solid rgba(255,255,255,.4); border-top-color:#fff; animation: rot .7s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }
</style>
