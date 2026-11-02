<script setup lang="ts">
withDefaults(defineProps<{ title: string; hint?: string }>(), { hint: '' })
</script>

<template>
  <div class="empty">
    <div class="empty__mark" aria-hidden="true">
      <span class="node n1"></span><span class="node n2"></span><span class="node n3"></span>
      <svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M40 18v8M40 54v8M18 40h8M54 40h8" stroke-linecap="round"/><path d="M25 25l5.6 5.6M49 49l5.6 5.6M55 25l-5.6 5.6M31 49l-5.6 5.6" stroke-linecap="round" opacity=".55"/></svg>
    </div>
    <h4 class="empty__title">{{ title }}</h4>
    <p v-if="hint" class="empty__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.empty { display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 40px 20px; text-align:center; }
.empty__mark { width: 84px; height:84px; color: var(--brand-line); position:relative; margin-bottom: 12px; }
.empty__mark svg { width:84px; height:84px; }
.node { position:absolute; width:9px; height:9px; border-radius:50%; background: var(--brand); box-shadow: 0 0 0 4px var(--brand-soft); }
.n1 { top:2px; left:36px; } .n2 { top:36px; left:2px; } .n3 { top:36px; right:2px; }
.empty__title { color: var(--text-strong); font-size: 18px; }
.empty__hint { color: var(--text-faint); font-size: 15px; margin-top: 6px; max-width: 300px; }
</style>