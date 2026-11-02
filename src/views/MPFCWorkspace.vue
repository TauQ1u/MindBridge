<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MPFCViewerContainer from '@/components/workspace/MPFCViewerContainer.vue'
import VideoPreview from '@/components/workspace/VideoPreview.vue'
import VisualizationDashboard from '@/components/workspace/VisualizationDashboard.vue'
import Timeline from '@/components/workspace/Timeline.vue'
import NeuronDetailPanel from '@/components/workspace/NeuronDetailPanel.vue'
import ExperimentSelectionModal from '@/components/workspace/ExperimentSelectionModal.vue'
import ConditionRail from '@/components/workspace/ConditionRail.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const router = useRouter()
const modalOpen = ref(false)
const reportMsg = ref('')
const figureMode = ref(false)

onMounted(async () => {
  await store.loadExperiments()
  await store.loadWorkspaceData()
})

async function generateReport() {
  await store.generateReport()
  reportMsg.value = store.report.status === 'ready' ? '报告已生成，可下载。' : '报告生成失败。'
  setTimeout(() => { reportMsg.value = '' }, 3000)
}
</script>

<template>
  <div class="mpfc-page" :class="{ 'drawer-open': store.activeDrawer }">
    <div class="mode-bar">
      <nav>
        <button class="active">3D 工作区</button>
        <button :disabled="store.loadedExperiments.length < 2" @click="router.push('/analysis')">多条件对比分析</button>
      </nav>
    </div>
    <div class="workspace-grid" :class="{ 'figure-mode': figureMode }">
      <!-- 左列 28%：行为视频（上）+ 数据看板（下） -->
      <section class="col-left" :class="{ 'figure-mode': figureMode }">
        <VideoPreview v-show="!figureMode" @select-data="modalOpen = true" />
        <VisualizationDashboard @figure-mode-change="figureMode = $event" />
      </section>

      <!-- 中央自适应：mPFC 3D Viewer（主视觉）+ 右下角数据面板 -->
      <section class="col-center">
        <div class="center-stage">
          <MPFCViewerContainer
            :has-data="store.hasImportedData"
            :condition="store.selectedExperiment?.displayName || store.selectedExperiment?.condition"
            :condition-id="store.selectedExperiment?.condition"
            :current-timestamp="store.currentTimestamp"
            :selected-neuron-id="store.selectedNeuron?.id"
            :highlight-mode="store.moduleHighlightMode"
            :highlight-neuron-ids="store.highlightedNeuronIds"
            :highlight-color="store.currentDecoderModule?.color"
            :neurons="store.neurons"
            @neuron-select="store.selectNeuron($event ? store.neurons.find(n => n.id === $event) || null : null)"
            @highlight-mode-select="store.setModuleHighlightMode($event)"
            @select-data="modalOpen = true"
          />
        </div>
      </section>

      <!-- 右列 12%：条件垂直实验轨（收窄） -->
      <aside class="col-right">
        <ConditionRail @add="modalOpen = true" />
      </aside>
    </div>

    <!-- 底部主时间轴：UI2 的脊柱 -->
    <footer class="timeline-dock" :class="{ 'drawer-open': store.activeDrawer }">
      <Timeline />
    </footer>

    <!-- 侧边抽屉：仅承载后续分析模式与报告；神经元详情由 3D 点击触发 -->
    <Transition name="drawer">
      <aside v-if="store.activeDrawer" class="detail-drawer">
        <div class="drawer-head">
          <strong>{{ store.activeDrawer === 'neuron' ? '神经元详情' : '分析报告' }}</strong>
          <button @click="store.activeDrawer = null">×</button>
        </div>
        <div class="drawer-body">
          <NeuronDetailPanel v-if="store.activeDrawer === 'neuron'" />
          
          <div v-else class="report-panel">
            <p>汇总当前已导入并完成复核的全部实验条件，由后端生成报告并下载。</p>
            <AppButton variant="primary" icon="download" :disabled="!store.hasImportedData || store.report.status === 'generating'" @click="generateReport">
              {{ store.report.status === 'generating' ? '正在生成…' : '生成分析报告' }}
            </AppButton>
            <a v-if="store.report.status === 'ready' && store.report.url" class="report-download" :href="store.report.url" download>下载报告</a>
            <span v-if="reportMsg" class="report-msg">{{ reportMsg }}</span>
          </div>
        </div>
      </aside>
    </Transition>

    <ExperimentSelectionModal :open="modalOpen" @close="modalOpen = false" />
  </div>
</template>

<style scoped>
.mpfc-page { display: flex; flex-direction: column; height: calc(100vh - var(--topbar-h)); overflow: hidden; }
.mode-bar{display:flex;align-items:center;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)}.mode-bar nav{display:flex;padding:3px;background:var(--bg-subtle);border-radius:8px}.mode-bar nav button{padding:6px 13px;border:0;border-radius:6px;background:transparent;color:var(--text-muted);font-size: 13px}.mode-bar nav button.active{background:var(--surface);color:var(--brand-text);box-shadow:var(--shadow-sm)}.mode-bar nav button:disabled{opacity:.4}
.workspace-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px, 28%) minmax(0, 1fr) minmax(150px, 12%); gap: 12px; padding: 12px 16px; }
.workspace-grid.figure-mode { grid-template-columns: minmax(520px, 44%) minmax(0, 1fr) minmax(150px, 12%); }
.col-left, .col-center, .col-right { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
.col-left.figure-mode :deep(.dashboard) { padding: 16px; }
.col-center :deep(.viewer) { flex: 1; min-height: 0; }
.col-center :deep(.viewer__stage) { min-height: 0; }
.center-stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.timeline-dock { flex: 0 0 auto; border-top: 1px solid var(--border); background: var(--surface); padding: 10px 16px 12px; box-shadow: 0 -4px 16px rgba(23,35,61,.04); }
.timeline-dock.drawer-open :deep(.tl-legend) { visibility: hidden; }
.mpfc-page.drawer-open :deep(.viewer__stage .note) { visibility: hidden; }
.drawer-body :deep(.neuron__head) { display: none; }
.drawer-head strong { font-weight: 600; }
.detail-drawer { position: fixed; top: var(--topbar-h); right: 0; bottom: 0; width: 360px; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); z-index: 30; overflow: auto; }
.drawer-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); color: var(--text-strong); }
.drawer-head button { border: 0; background: transparent; font-size: 26.5px; color: var(--text-faint); }
.drawer-body { padding: 8px; }
.report-panel { padding: 16px; display: flex; flex-direction: column; gap: 14px; color: var(--text-muted); font-size: 15.5px; }
.report-msg { color: var(--ok); font-size: 14.5px; }
.report-download { display: inline-flex; justify-content: center; padding: 9px 12px; border: 1px solid var(--brand-line); border-radius: 6px; background: var(--brand-soft); color: var(--brand-text); font-weight: 600; }
.drawer-enter-active, .drawer-leave-active { transition: transform var(--dur) var(--ease); }
.drawer-enter-from, .drawer-leave-to { transform: translateX(100%); }
@media (max-width: 1200px) {
  .mpfc-page { height: auto; }
  .workspace-grid { grid-template-columns: minmax(240px, 30%) minmax(0, 1fr); }
  .col-right { grid-column: span 2; }
  .col-center :deep(.viewer) { min-height: 480px; }
}
@media (max-width: 1500px) {
  .workspace-grid.figure-mode { grid-template-columns: minmax(440px, 42%) minmax(0, 1fr); }
  .workspace-grid.figure-mode .col-right { display: none; }
}
</style>
