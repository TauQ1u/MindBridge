<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'teal' | 'blue' | 'amber' | 'slate' | 'purple' | 'rose' | 'ok' | 'warn' | 'danger' | 'neutral' }>(), { tone: 'neutral' })
</script>

<template>
  <span class="badge" :class="`badge--${tone}`"><slot /></span>
</template>

<style scoped>
.badge { display:inline-flex; align-items:center; gap:5px; padding: 2px 9px; border-radius: var(--radius-full); font-size: 13px; font-weight:600; line-height: 1.6; white-space: nowrap; }
.badge--teal { background: var(--brand-soft); color: var(--brand-text); }
.badge--blue { background: var(--info-soft); color: var(--info); }
.badge--amber { background: var(--warn-soft); color: var(--warn); }
.badge--purple { background: #efeefb; color: #6d5fc0; }
.badge--rose { background: #fbe9ef; color: #c54a6f; }
.badge--slate { background: var(--neutral-soft); color: var(--text-muted); }
.badge--ok { background: var(--ok-soft); color: var(--ok); }
.badge--warn { background: var(--warn-soft); color: var(--warn); }
.badge--danger { background: var(--danger-soft); color: var(--danger); }
.badge--neutral { background: var(--neutral-soft); color: var(--neutral); }
</style>