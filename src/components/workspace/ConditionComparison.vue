<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import AppBadge from '@/components/ui/AppBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { experimentApi, type BehaviorStats } from '@/services/api/experimentApi'

const store = useWorkspaceStore()
const chartEl = ref<HTMLDivElement>()
const loading = ref(false)
const stats = ref<Array<{ name: string; data: BehaviorStats }>>([])
let chart: echarts.ECharts | null = null
const colors = ['#12a594', '#2f7ef7', '#8b7cf6', '#e5a323', '#e15b78', '#93a1b8']

async function load() {
  if (store.loadedExperiments.length < 2) return
  loading.value = true
  stats.value = await Promise.all(store.loadedExperiments.map(async experiment => ({
    name: experiment.displayName,
    data: await experimentApi.behaviorStats(experiment.condition),
  })))
  loading.value = false
  await nextTick()
  render()
}

function render() {
  if (!chartEl.value || stats.value.length < 2) return
  chart?.dispose()
  chart = echarts.init(chartEl.value)
  const behaviors = Array.from(new Set(stats.value.flatMap(item => Object.keys(item.data.behavior_fraction))))
  chart.setOption({
    animationDuration: 350,
    tooltip: { trigger: 'axis', valueFormatter: (value: number) => `${value.toFixed(1)}%` },
    legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#64748f', fontSize: 12 } },
    grid: { top: 12, left: 38, right: 12, bottom: 52 },
    xAxis: { type: 'category', data: stats.value.map(item => item.name), axisLine: { lineStyle: { color: 'rgba(23,35,61,.18)' } }, axisLabel: { color: '#64748f', fontSize: 12 } },
    yAxis: { type: 'value', max: 100, splitLine: { lineStyle: { color: 'rgba(23,35,61,.07)' } }, axisLabel: { color: '#93a1b8', fontSize: 12 }, name: '%' },
    series: behaviors.map((behavior, index) => ({
      name: behavior,
      type: 'bar',
      stack: 'behavior',
      data: stats.value.map(item => (item.data.behavior_fraction[behavior] ?? 0) * 100),
      itemStyle: { color: colors[index % colors.length] },
    })),
  })
}
function resize() { chart?.resize() }
onMounted(() => { window.addEventListener('resize', resize); void load() })
onBeforeUnmount(() => { chart?.dispose(); window.removeEventListener('resize', resize) })
</script>

<template>
  <div class="compare">
    <div class="compare__head"><span class="compare__title">Condition 对比</span><AppBadge v-if="store.loadedExperiments.length" tone="slate">{{ store.loadedExperiments.length }} 组</AppBadge></div>
    <template v-if="store.loadedExperiments.length >= 2">
      <p class="compare__hint">行为时间占比 · behavior_stats.json</p>
      <div v-if="loading" class="loading">正在加载已有统计结果…</div>
      <div v-show="!loading" ref="chartEl" class="compare__chart" />
      <div class="compare__list"><div v-for="item in stats" :key="item.data.condition_id" class="compare__row"><span>{{ item.name }}</span><AppBadge tone="teal">{{ item.data.review_status === 'baseline_accepted' ? '已复核' : item.data.review_status }}</AppBadge></div></div>
    </template>
    <div v-else class="compare__empty"><EmptyState title="需要至少两个 Condition" hint="通过右侧“添加实验条件”完成处理与复核后，可比较已有行为统计。" /></div>
  </div>
</template>

<style scoped>
.compare{display:flex;flex-direction:column}.compare__head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}.compare__title{font-weight:600;color:var(--text);font-size: 15.5px}.compare__hint{font-size: 13px;color:var(--text-faint);padding:12px 18px 0}.compare__chart{height:260px;margin:8px}.compare__list{padding:8px 18px 16px;display:grid;gap:6px}.compare__row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-top:1px dashed var(--border);color:var(--text);font-size: 14.5px}.compare__empty,.loading{padding:12px}.loading{color:var(--text-faint);font-size: 14.5px}
</style>
