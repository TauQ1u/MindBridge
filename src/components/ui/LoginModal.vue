<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { LoginError } from '@/services/api/authApi'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; success: [] }>()

const auth = useAuthStore()
const username = ref('admin')
const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const shaking = ref(false)
const usernameInput = ref<HTMLInputElement | null>(null)

watch(() => props.open, async (open) => {
  if (!open) return
  errorMessage.value = ''
  username.value = 'admin'
  password.value = ''
  showPassword.value = false
  await nextTick()
  usernameInput.value?.focus()
})

async function submit() {
  if (submitting.value) return
  errorMessage.value = ''
  if (!username.value.trim() || !password.value) {
    fail('请输入用户名和密码')
    return
  }
  submitting.value = true
  try {
    await auth.login(username.value.trim(), password.value)
    emit('success')
  } catch (error) {
    fail(error instanceof LoginError ? error.message : '网络异常，请稍后重试')
  } finally {
    submitting.value = false
  }
}

function fail(message: string) {
  errorMessage.value = message
  shaking.value = false
  requestAnimationFrame(() => { shaking.value = true })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="login-overlay" @click.self="emit('close')">
        <div class="login-panel" :class="{ shake: shaking }" role="dialog" aria-modal="true" aria-label="账号登录" @animationend="shaking = false">
          <button class="login-close" aria-label="关闭" @click="emit('close')">×</button>

          <div class="login-brand">
            <div class="brand-mark"><span></span><span></span><span></span></div>
            <h3>登录 MindBridge</h3>
            <p>授权访问 mPFC 工作区</p>
          </div>

          <form class="login-form" novalidate @submit.prevent="submit">
            <label class="field">
              <span class="field-label">用户名</span>
              <span class="field-box">
                <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.6-3.2 4.4-5 8-5s6.4 1.8 8 5"/></svg>
                <input ref="usernameInput" v-model="username" type="text" autocomplete="username" readonly :disabled="submitting" />
              </span>
            </label>

            <label class="field">
              <span class="field-label">密码</span>
              <span class="field-box">
                <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                <input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码" :disabled="submitting" />
                <button type="button" class="eye-btn" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">
                  <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6c2 0 3.7.6 5.1 1.5M22 12s-3.5 6-10 6c-2 0-3.7-.6-5.1-1.5"/><path d="M3 3l18 18"/></svg>
                </button>
              </span>
            </label>

            <Transition name="fade">
              <p v-if="errorMessage" class="login-error" role="alert">{{ errorMessage }}</p>
            </Transition>

            <button class="login-submit" type="submit" :disabled="submitting">
              <span v-if="!submitting">登 录</span>
              <span v-else class="loading"><i></i>验证中…</span>
            </button>
          </form>

          <p class="login-note">演示账号登录不提供数据访问控制 · 关闭浏览器后需重新登录</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.login-overlay { position: fixed; inset: 0; background: rgba(22,35,31,.36); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 200; }
.login-panel { position: relative; width: 100%; max-width: 400px; background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: 34px 32px 24px; }
.login-panel.shake { animation: shake .4s var(--ease); }

.login-close { position: absolute; top: 14px; right: 14px; border: 0; background: transparent; font-size: 26px; line-height: 1; color: var(--text-faint); width: 30px; height: 30px; border-radius: 8px; }
.login-close:hover { background: var(--bg-subtle); color: var(--text); }

.login-brand { display: flex; flex-direction: column; align-items: center; text-align: center; }
.brand-mark { width: 44px; height: 44px; background: linear-gradient(135deg, #2f7ef7, #6ba3ff); border-radius: 12px; display: flex; align-items: center; justify-content: center; gap: 4px; box-shadow: 0 6px 16px rgba(47,126,247,.28); }
.brand-mark span { width: 6px; height: 6px; background: #fff; border-radius: 50%; }
.brand-mark span:first-child { width: 9px; height: 9px; }
.login-brand h3 { margin-top: 14px; font-size: 21px; color: var(--text-strong); letter-spacing: -.2px; }
.login-brand p { margin-top: 4px; font-size: 14px; color: var(--text-faint); }

.login-form { margin-top: 24px; display: grid; gap: 16px; }
.field { display: grid; gap: 6px; }
.field-label { font-size: 13.5px; font-weight: 600; color: var(--text-muted); }
.field-box { display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-alt); transition: border-color var(--dur), box-shadow var(--dur), background var(--dur); }
.field-box:focus-within { border-color: var(--brand); box-shadow: var(--focus-ring); background: var(--surface); }
.field-icon { width: 17px; height: 17px; color: var(--text-faint); flex: 0 0 auto; }
.field-box input { flex: 1; min-width: 0; height: 42px; border: 0; outline: 0; background: transparent; font-size: 15px; color: var(--text); }
.field-box input::placeholder { color: var(--text-faint); }
.eye-btn { border: 0; background: transparent; padding: 4px; border-radius: 6px; color: var(--text-faint); display: grid; place-items: center; }
.eye-btn:hover { color: var(--text-muted); background: var(--bg-subtle); }
.eye-btn svg { width: 17px; height: 17px; }

.login-error { padding: 8px 12px; border-radius: 8px; background: var(--danger-soft); color: var(--danger); font-size: 13.5px; }

.login-submit { height: 44px; border: 0; border-radius: var(--radius); background: var(--brand); color: #fff; font-size: 16px; font-weight: 600; letter-spacing: 2px; box-shadow: 0 8px 20px rgba(47,126,247,.28); transition: all var(--dur); }
.login-submit:hover:not(:disabled) { background: var(--brand-strong); transform: translateY(-1px); }
.login-submit:disabled { opacity: .7; cursor: not-allowed; }
.loading { display: inline-flex; align-items: center; gap: 8px; letter-spacing: normal; font-weight: 500; }
.loading i { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }

.login-note { margin-top: 18px; text-align: center; font-size: 12.5px; color: var(--text-faint); }

.modal-enter-active, .modal-leave-active { transition: opacity var(--dur) var(--ease); }
.modal-enter-active .login-panel { transition: transform var(--dur) var(--ease); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .login-panel { transform: translateY(12px) scale(.98); }
.fade-enter-active, .fade-leave-active { transition: opacity var(--dur) var(--ease); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-8px); }
  40%, 80% { transform: translateX(8px); }
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
