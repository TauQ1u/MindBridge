<script setup lang="ts">
import { computed, ref } from 'vue'
import AppBadge from '@/components/ui/AppBadge.vue'
import MPFC3DAdapter from '@/components/visualization/MPFC3DAdapter.vue'
import type { ModuleHighlightMode, Neuron } from '@/types/models'

const props = defineProps<{
  hasData: boolean
  condition?: string
  conditionId?: string
  currentTimestamp: number
  selectedNeuronId?: string
  highlightMode?: ModuleHighlightMode
  highlightNeuronIds?: string[]
  highlightColor?: string
  neurons: Neuron[]
}>()
const emit = defineEmits<{
  neuronSelect: [id: string | null]
  highlightModeSelect: [mode: ModuleHighlightMode]
  selectData: []
}>()

const search = ref('')
const searchResults = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return []
  return props.neurons.filter(n => n.id.toLowerCase().includes(query)).slice(0, 6)
})
/* 高亮模式已选但当前帧没有可归因的神经元（如 rearing 片段），给出可见反馈 */
const highlightEmpty = computed(() =>
  (props.highlightMode ?? 'none') !== 'none' && (props.highlightNeuronIds?.length ?? 0) === 0)
function pickNeuron(id: string) {
  emit('neuronSelect', id)
  search.value = ''
}
function toggleRelatedGroup() {
  emit('highlightModeSelect', (props.highlightMode ?? 'none') === 'module' ? 'none' : 'module')
}
</script>

<template>
  <div class="viewer">
    <div class="viewer__bar">
      <div><span class="viewer__kicker">动态功能网络</span><strong>mPFC 神经网络 3D 视图</strong></div>
      <div class="viewer__tools">
        <button class="related-group-btn" :class="{ active: highlightMode === 'module' }" type="button" :disabled="!hasData" @click="toggleRelatedGroup">
          <i />{{ highlightMode === 'module' ? '隐藏相关神经亚群' : '显示相关神经亚群' }}
        </button>
        <label class="viewer__search">神经元
          <input v-model="search" :disabled="!hasData" placeholder="搜索 n42…" />
          <div v-if="searchResults.length" class="search-pop">
            <button v-for="n in searchResults" :key="n.id" @click="pickNeuron(n.id)">
              <span class="mono">{{ n.id }}</span>
            </button>
          </div>
        </label>
        <AppBadge v-if="condition" tone="teal">{{ condition }}</AppBadge>
        <AppBadge v-else tone="slate">未加载</AppBadge>
      </div>
    </div>
    <div class="viewer__stage">
      <MPFC3DAdapter
        v-if="hasData"
        :condition-id="conditionId"
        :current-timestamp="currentTimestamp"
        :selected-neuron-id="selectedNeuronId"
        :highlight-neuron-ids="highlightNeuronIds"
        :highlight-color="highlightColor"
        @neuron-select="emit('neuronSelect', $event)"
      />
      <p v-if="highlightEmpty" class="highlight-empty">当前时刻暂未识别到明确的相关神经亚群，可拖动时间轴继续查看</p>
      <p class="hint">拖动旋转 · 滚轮缩放 · 点击神经元</p>
      <div class="scene-legend">
        <span><i class="activity-scale" />节点浅小＝低活动，深大＝高活动</span>
        <span v-if="(highlightMode ?? 'none') !== 'none'"><i class="dim-dot" />暗化节点＝不在当前归因范围</span>
        <small>连线表示功能共活动，不代表解剖或突触连接</small>
      </div>
      <!-- 首次进入真实空状态 -->
      <div v-if="!hasData" class="viewer__empty">
        <strong>尚未导入实验数据</strong>
        <span>选择服务器中已发现的实验，完成处理与复核后即可开始分析。</span>
        <button type="button" @click="emit('selectData')">选择实验数据</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-sm)}
.viewer__bar{height:52px;flex:0 0 52px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--border)}
.viewer__bar>div:first-child{display:flex;flex-direction:column;gap:2px}
.viewer__bar strong{color:var(--text-strong);font-size: 15.5px}
.viewer__kicker{color:var(--text-faint);font-size: 12px;letter-spacing:1px}
.viewer__tools{display:flex;align-items:center;gap:10px}
.viewer__tools label{display:flex;align-items:center;gap:6px;color:var(--text-faint);font-size: 13px;position:relative}
.viewer__tools select,.viewer__tools input{padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface-alt);color:var(--text);font-size: 13px}
.related-group-btn{display:flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid var(--brand-line);border-radius:8px;background:var(--surface);color:var(--brand-text);font-size:12.5px;font-weight:600;transition:all var(--dur)}.related-group-btn i{width:7px;height:7px;border-radius:50%;background:var(--text-faint);transition:all var(--dur)}.related-group-btn:hover:not(:disabled){background:var(--brand-soft)}.related-group-btn.active{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 3px 10px rgba(47,126,247,.22)}.related-group-btn.active i{background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.2)}.related-group-btn:disabled{opacity:.4;cursor:not-allowed}
.viewer__tools input{width:110px}
.search-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:6;min-width:170px;background:var(--surface);border:1px solid var(--border-strong);border-radius:9px;box-shadow:var(--shadow-md);overflow:hidden}
.search-pop button{display:flex;justify-content:space-between;gap:12px;width:100%;padding:7px 10px;border:0;background:transparent;color:var(--text);font-size: 13px;text-align:left}
.search-pop button:hover{background:var(--brand-soft)}
.search-pop em{font-style:normal;color:var(--text-faint);font-size: 12px}
.viewer__stage{flex:1;position:relative;min-height:0;background:var(--scene-bg-neuron)}
.hint{position:absolute;z-index:4;left:12px;bottom:10px;color:#7d93b2;font-size: 12px;pointer-events:none}
.highlight-empty{position:absolute;z-index:4;left:50%;top:12px;transform:translateX(-50%);padding:5px 12px;border-radius:8px;background:rgba(8,16,30,.85);border:1px solid rgba(229,163,35,.4);color:#e5a323;font-size: 12px;pointer-events:none;white-space:nowrap}
.scene-legend{position:absolute;z-index:4;right:12px;bottom:10px;display:grid;justify-items:end;gap:4px;padding:7px 9px;border:1px solid rgba(127,147,178,.2);border-radius:7px;background:rgba(8,16,30,.72);color:#a9bad0;font-size:10.5px;pointer-events:none;backdrop-filter:blur(4px)}
.scene-legend span{display:flex;align-items:center;gap:6px}.scene-legend i{display:inline-block;flex:0 0 auto}.scene-legend small{color:#7d93b2;font-size:9.5px}.activity-scale{width:30px;height:7px;border-radius:8px;background:linear-gradient(90deg,#f4d9d7,#ce524c)}.dim-dot{width:8px;height:8px;border-radius:50%;background:#20242b;border:1px solid #596273}
.viewer__empty{position:absolute;z-index:5;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(0,0,0,.78);backdrop-filter:blur(2px);text-align:center;padding:32px}
.viewer__empty strong{color:#dbe7f5;font-size: 19px}
.viewer__empty span{max-width:320px;color:#7d93b2;font-size: 14.5px;line-height:1.7}
.viewer__empty button{margin-top:10px;padding:10px 24px;border:0;border-radius:9px;background:var(--brand);color:#fff;font-size: 15.5px;font-weight:600;box-shadow:0 6px 16px rgba(47,126,247,.28)}
.viewer__empty button:hover{background:var(--brand-strong)}
</style>
