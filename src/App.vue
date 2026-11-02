<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAuthStore } from '@/stores/auth'
import { UNAUTHORIZED_EVENT } from '@/services/api/http'
import { formatTimestamp } from '@/utils/time'

const router = useRouter()
const route = useRoute()
const store = useWorkspaceStore()
const auth = useAuthStore()

// 会话失效（401）时清理本地状态并回到首页重新登录
function onUnauthorized() {
  auth.clearLocal()
  store.resetSessionData()
  if (route.name !== 'home') router.push({ name: 'home', query: { login: '1' } })
}
onMounted(() => window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized))
onBeforeUnmount(() => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized))

const showAccount = computed(() => auth.isAuthenticated && route.name !== 'home')

async function onLogout() {
  await auth.logout()
  store.resetSessionData()
  router.push('/')
}

const space = computed(() => {
  switch (route.name) {
    case 'home': return '全鼠脑总览'
    case 'processing': return 'mPFC / 数据处理'
    case 'review': return 'mPFC / 一致性复核'
    case 'analysis': return 'mPFC / 多条件对比分析'
    default: return 'mPFC 科研工作区'
  }
})
const context = computed(() => {
  // 工作区内已由右侧条件轨承载实验条件，顶栏不重复展示。
  if (route.name === 'mpfc') return ''
  const exp = store.selectedExperiment
  if (!exp) return ''
  return exp.displayName
})
const showTimestamp = computed(() => route.name === 'mpfc' && store.hasImportedData)
const showReport = computed(() => route.name === 'mpfc')
const reportTip = computed(() => store.hasImportedData ? '生成分析报告' : '请先完成至少一个实验的数据处理与复核')

function onReport() {
  if (!store.hasImportedData) return
  store.activeDrawer = 'report'
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar__brand" @click="router.push('/')">
        <div class="brand-mark"><span></span><span></span><span></span></div>
        <div class="brand-copy">
          <strong>MindBridge</strong>
          <small>神经科学分析工作站</small>
        </div>
      </div>
      <span class="topbar__space">/ {{ space }}</span>
      <span v-if="context" class="topbar__context">{{ context }}</span>
      <div class="topbar__right">
        <span v-if="showTimestamp" class="topbar__clock mono">{{ formatTimestamp(store.currentTimestamp) }}</span>
        <button v-if="showReport" class="report-btn" :disabled="!store.hasImportedData" :title="reportTip" @click="onReport">
          生成报告
        </button>
        <span v-if="showAccount" class="account-chip"><i></i>{{ auth.user }}</span>
        <button v-if="showAccount" class="logout-btn" title="退出登录" @click="onLogout">退出</button>
        <span class="system-status"><i></i>系统就绪</span>
      </div>
    </header>
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
.topbar { height: var(--topbar-h); flex: 0 0 var(--topbar-h); display: flex; align-items: center; padding: 0 24px; background: rgba(255,255,255,.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); position: relative; z-index: 40; overflow: hidden; }
.topbar__brand { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 0 0 auto; }
.brand-mark { width: 28px; height: 28px; background: linear-gradient(135deg, #2f7ef7, #6ba3ff); border-radius: 8px; display:flex; align-items:center; justify-content:center; gap: 3px; box-shadow: 0 3px 8px rgba(47,126,247,.25); }
.brand-mark span { width: 4px; height: 4px; background: #fff; border-radius: 50%; }
.brand-mark span:first-child { width: 6px; height: 6px; }
.brand-copy { display:flex; flex-direction:column; line-height: 1.05; }
.brand-copy strong { color: var(--text-strong); font-size: 18px; letter-spacing: -.2px; }
.brand-copy small { color: var(--text-faint); font-size: 11px; letter-spacing: 1px; margin-top: 3px; }
.topbar__space { margin-left: 14px; color: var(--text-muted); font-size: 15.5px; flex: 0 0 auto; white-space: nowrap; }
.topbar__context { margin-left: 18px; padding-left: 18px; border-left: 1px solid var(--border); font-family: var(--font-sans); color: var(--text-muted); font-size: 13px; max-width: 340px; min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar__right { margin-left: auto; display: flex; align-items: center; gap: 14px; flex: 0 0 auto; }
.topbar__clock { color: var(--brand-text); font-size: 15.5px; }
.report-btn { padding: 7px 16px; border: 0; border-radius: 8px; background: var(--brand); color: #fff; font-size: 14.5px; font-weight: 600; box-shadow: 0 3px 10px rgba(47,126,247,.24); transition: all var(--dur); }
.report-btn:hover:not(:disabled) { background: var(--brand-strong); transform: translateY(-1px); }
.report-btn:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
.system-status { display: flex; align-items: center; gap: 6px; color: var(--ok); font-size: 14.5px; }
.system-status i { width: 6px; height: 6px; background: var(--ok); border-radius: 50%; box-shadow: 0 0 0 3px var(--ok-soft); }
.account-chip { display: flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: var(--radius-full); background: var(--brand-soft); border: 1px solid var(--brand-line); color: var(--brand-text); font-size: 13.5px; font-weight: 600; }
.account-chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--brand); }
.logout-btn { padding: 6px 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text-muted); font-size: 13.5px; transition: all var(--dur); }
.logout-btn:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
@media (max-width: 900px) { .topbar__context, .topbar__clock { display: none; } }
</style>
