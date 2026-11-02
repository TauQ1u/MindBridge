<script setup lang="ts">
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const emit = defineEmits<{ add: [] }>()
// 颜色仅按导入顺序区分数据系列，不绑定 condition 语义（文档 §3.3）
const palette = ['#12a594', '#2f7ef7', '#8b7cf6', '#e5a323', '#e15b78']
</script>

<template>
  <section class="condition-rail">
    <div class="rail-head"><span>实验条件</span><b>{{ store.loadedExperiments.length }}</b></div>

    <div v-if="store.loadedExperiments.length" class="rail-list">
      <button v-for="(experiment, index) in store.loadedExperiments" :key="experiment.experimentId"
        class="rail-item" :class="{ active: store.selectedExperiment?.experimentId === experiment.experimentId }"
        :style="{ '--condition-color': palette[index % palette.length] }"
        @click="store.switchCondition(experiment)">
        <i class="dot" />
        <span class="rail-item__text">
          <strong>{{ experiment.displayName }}</strong>
          <small class="mono">{{ experiment.experimentId }}</small>
        </span>
      </button>
    </div>
    <p v-else class="rail-empty">— 尚未导入实验条件 —</p>

    <button class="rail-add" type="button" @click="emit('add')" title="打开数据中心 / 选择实验"><i>＋</i><span>添加实验</span></button>
  </section>
</template>

<style scoped>
.condition-rail { flex: 1; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); padding: 12px 10px; box-shadow: var(--shadow-sm); }
.rail-head { display: flex; justify-content: space-between; align-items: center; color: var(--text-faint); font-size: 12px; letter-spacing: 1.2px; font-weight: 700; }
.rail-head b { font-size: 13px; color: var(--text-muted); font-family: var(--font-mono); }
.rail-list { position: relative; display: grid; margin: 12px 0 14px; padding-left: 4px; }
.rail-list::before { content: ''; position: absolute; left: 8px; top: 10px; bottom: 10px; width: 1px; background: var(--border-strong); }
.rail-item { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 8px 4px; border: 0; background: transparent; text-align: left; color: var(--text-faint); transition: color var(--dur); }
.rail-item:hover, .rail-item:focus-visible { color: var(--text-muted); }
.rail-item.active { color: var(--text-strong); }
.dot { flex: 0 0 auto; width: 9px; height: 9px; border: 2px solid var(--condition-color); border-radius: 50%; background: var(--surface); z-index: 1; }
.rail-item.active .dot { background: var(--condition-color); box-shadow: 0 0 0 4px color-mix(in srgb, var(--condition-color) 18%, transparent); }
.rail-item__text { min-width: 0; }
.rail-item strong, .rail-item small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-item strong { font-size: 14.5px; }
.rail-item small { margin-top: 2px; color: var(--text-faint); font-size: 11px; }
.rail-empty { padding: 16px 0; color: var(--text-faint); font-size: 13px; text-align: center; }
.rail-add { margin-top: auto; display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 9px; border: 1px dashed var(--border-strong); border-radius: 8px; background: transparent; color: var(--brand-text); font-size: 14.5px; }
.rail-add i { font-style: normal; font-size: 18px; line-height: 1; }
.rail-add:hover { border-color: var(--brand); background: var(--brand-soft); }
</style>
