<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WholeBrain3DAdapter from '@/components/visualization/WholeBrain3DAdapter.vue'
import LoginModal from '@/components/ui/LoginModal.vue'
import { BRAIN_STRUCTURES, getStructureInfo } from '@neuron3d/brain/brainStructures'
import type { BrainLoadState } from '@neuron3d/brain/BrainScene'
import { useAuthStore } from '@/stores/auth'
import { useWorkspaceStore } from '@/stores/workspace'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const workspace = useWorkspaceStore()
const loadState = ref<BrainLoadState>('loading')
const selectedId = ref<string | null>(null)
const snapshotUrl = ref<string | null>(null)
const adapter = ref<InstanceType<typeof WholeBrain3DAdapter> | null>(null)
const loginOpen = ref(false)

onMounted(() => { auth.ensureSession() })

// 路由守卫重定向回首页时（?login=1）自动弹出登录框
watch(() => route.query.login, (value) => {
  if (value && !auth.isAuthenticated) loginOpen.value = true
}, { immediate: true })

function enterWorkspace() {
  if (auth.isAuthenticated) router.push('/mpfc')
  else loginOpen.value = true
}

function closeLogin() {
  loginOpen.value = false
  if (route.query.login) router.replace({ query: {} })
}

function onLoginSuccess() {
  loginOpen.value = false
  // 每次登录都从全新状态开始：清空上次会话残留的实验条件与本地持久化
  workspace.resetSessionData()
  const redirect = route.query.redirect
  const target = typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/mpfc'
  router.replace({ query: {} })
  router.push(target)
}

const activeId = computed(() => selectedId.value ?? 'mpfc')
const info = computed(() => getStructureInfo(activeId.value))

// 模型就绪后截取当前脑区结构图
watch([loadState, activeId], () => {
  if (loadState.value !== 'ready') return
  snapshotUrl.value = null
  const id = activeId.value
  window.setTimeout(() => {
    snapshotUrl.value = adapter.value?.getSnapshot(id) ?? null
  }, 80)
}, { flush: 'post' })
</script>

<template>
  <main class="brain-home">
    <section class="brain-viewer" aria-label="全鼠脑三维模型">
      <WholeBrain3DAdapter ref="adapter" :selected-id="selectedId" @select="selectedId = $event" @load-state-change="loadState = $event" />
      <div class="viewer-hint">拖拽旋转视角 · 单击激发信号涟漪 · 双击脑区查看介绍</div>
      <div v-if="loadState === 'loading'" class="viewer-mask">
        <strong>正在渲染小鼠脑三维图谱模型</strong>
        <span>模型装配中，请稍候…</span>
      </div>
      <div v-else-if="loadState === 'fallback'" class="viewer-mask">
        <strong>模型文件缺失</strong>
        <span>请将 Allen CCFv3 OBJ 模型放入 public/models 目录后刷新页面。</span>
      </div>
    </section>

    <aside class="brain-side">
      <section class="info-card">
        <span class="panel-caption">脑区结构介绍</span>
        <h2>{{ info?.name }}<em v-if="info?.highlight" class="hl-tag">目标脑区</em></h2>
        <p class="info-en">{{ info?.englishName }}</p>
        <div class="info-image">
          <img v-if="snapshotUrl" :src="snapshotUrl" :alt="info?.name" />
          <div v-else class="info-image-empty"><span>{{ loadState === 'ready' ? '结构渲染图生成中…' : '模型加载中…' }}</span></div>
        </div>
        <p class="info-desc">{{ info?.description }}</p>
      </section>

      <section class="nav-card">
        <span class="panel-caption">脑区导航 · 点击直接选中</span>
        <div class="nav-list">
          <button v-for="item in BRAIN_STRUCTURES" :key="item.id" type="button"
            class="nav-item" :class="{ active: activeId === item.id }"
            @click="selectedId = item.id">
            <span>{{ item.name }}</span>
            <em v-if="item.highlight" class="hl-tag">目标</em>
          </button>
        </div>
      </section>

      <button class="enter-btn" type="button" @click="enterWorkspace">
        进入 mPFC 工作区 <b>→</b>
      </button>
    </aside>

    <LoginModal :open="loginOpen" @close="closeLogin" @success="onLoginSuccess" />
  </main>
</template>

<style scoped>
.brain-home { height: calc(100vh - var(--topbar-h)); min-height: 640px; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; padding: 14px 16px; background: var(--bg); }
.brain-viewer { position: relative; min-width: 0; overflow: hidden; border-radius: var(--radius-lg); background: #000; border: 1px solid var(--border); box-shadow: var(--shadow-sm); }
.viewer-hint { position: absolute; z-index: 3; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 7px 14px; border-radius: 8px; background: rgba(8,16,30,.85); border: 1px solid rgba(127,180,255,.3); color: #9db8d8; font-size: 14.5px; pointer-events: none; white-space: nowrap; }
.viewer-mask { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: #000; }
.viewer-mask strong { color: #dbe7f5; font-size: 18px; }
.viewer-mask span { color: #7d93b2; font-size: 14.5px; }

.brain-side { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; }
.info-card, .nav-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px 18px; box-shadow: var(--shadow-sm); }
.panel-caption { font-size: 12px; letter-spacing: 1.6px; color: var(--text-faint); font-weight: 700; }
.info-card { flex: 0 0 auto; }
.info-card h2 { margin-top: 8px; font-size: 21px; color: var(--text-strong); display: flex; align-items: center; gap: 10px; }
.hl-tag { font-style: normal; font-size: 12px; font-weight: 600; color: var(--brand-text); background: var(--brand-soft); border: 1px solid var(--brand-line); padding: 2px 8px; border-radius: var(--radius-full); }
.info-en { margin-top: 3px; color: var(--text-faint); font-size: 13.5px; font-family: var(--font-mono); }
.info-image { margin-top: 10px; border-radius: var(--radius); overflow: hidden; background: #f4f6fb; border: 1px solid var(--border); aspect-ratio: 16 / 7; display: grid; place-items: center; }
.info-image img { width: 100%; height: 100%; object-fit: contain; display: block; }
.info-image-empty { color: var(--text-faint); font-size: 13.5px; }
.info-desc { margin-top: 10px; color: var(--text-muted); font-size: 14px; line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }

.nav-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.nav-list { margin-top: 10px; display: grid; gap: 6px; overflow: auto; }
.nav-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 12px; border: 0; border-radius: 9px; background: transparent; color: var(--text-muted); font-size: 15.5px; text-align: left; transition: all var(--dur); }
.nav-item:hover { background: var(--bg-subtle); color: var(--text); }
.nav-item.active { background: var(--brand-soft); color: var(--brand-text); font-weight: 600; }

.enter-btn { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border: 0; border-radius: var(--radius-lg); background: var(--brand); color: #fff; font-size: 17px; font-weight: 600; box-shadow: 0 8px 20px rgba(47,126,247,.28); transition: all var(--dur); }
.enter-btn:hover { background: var(--brand-strong); transform: translateY(-1px); }
.enter-btn b { font-weight: 600; }
@media (max-width: 900px) { .brain-home { grid-template-columns: 1fr; height: auto; } .brain-viewer { min-height: 480px; } }
</style>
