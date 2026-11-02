import express from 'express'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPipelineProvider } from './src/providers/index.mjs'
import { createApiRouter, createLegacyDataAlias } from './src/routes/api.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(serverDir, '..')

/* 零依赖 .env 加载：已存在的环境变量优先，不覆盖 */
try {
  const envFile = await fs.readFile(path.join(projectRoot, '.env'), 'utf8')
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || line.trimStart().startsWith('#')) continue
    const [, key, raw] = match
    if (process.env[key] !== undefined) continue
    const value = raw.replace(/^["']|["']$/g, '')
    if (value) process.env[key] = value
  }
} catch { /* 无 .env 文件时忽略 */ }

const dataRoot = path.resolve(process.env.MINDBRIDGE_DATA_ROOT || path.join(serverDir, 'data'))
const stateRoot = path.resolve(process.env.MINDBRIDGE_STATE_ROOT || path.join(serverDir, 'state'))
const distRoot = path.join(projectRoot, 'dist')
const port = Number(process.env.PORT || 3001)

/* ================= 账号与会话（单账号 + HMAC 签名会话） ================= */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }
const SCRYPT_KEYLEN = 64
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000 // 12 小时
const SESSION_COOKIE = 'mb_session'

const adminUser = process.env.MINDBRIDGE_ADMIN_USER || 'admin'
const sessionSecret = process.env.MINDBRIDGE_SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const secureCookie = process.env.MINDBRIDGE_SECURE_COOKIE === '1'

if (!process.env.MINDBRIDGE_SESSION_SECRET) {
  console.warn('[security] 未配置 MINDBRIDGE_SESSION_SECRET，已生成随机密钥：服务重启后所有会话将失效')
}

function loadAdminCredential() {
  const spec = process.env.MINDBRIDGE_ADMIN_PASSWORD_HASH
  if (!spec) {
    throw new Error('未配置 MINDBRIDGE_ADMIN_PASSWORD_HASH。请运行 node scripts/hash-password.mjs <密码> 并将哈希写入 .env')
  }
  const [algo, n, r, p, salt, hash] = spec.split('$')
  if (algo === 'scrypt' && salt && hash && /^\d+$/.test(n) && /^\d+$/.test(r) && /^\d+$/.test(p)) {
    return { salt, hash, params: { N: Number(n), r: Number(r), p: Number(p) } }
  }
  throw new Error('MINDBRIDGE_ADMIN_PASSWORD_HASH 格式错误，请使用 scripts/hash-password.mjs 生成')
}

const adminCredential = loadAdminCredential()

function verifyPassword(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 256) return false
  const digest = crypto.scryptSync(candidate, adminCredential.salt, SCRYPT_KEYLEN, adminCredential.params)
  const expected = Buffer.from(adminCredential.hash, 'hex')
  return digest.length === expected.length && crypto.timingSafeEqual(digest, expected)
}

function verifyUsername(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 128) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(adminUser)
  const len = Math.max(a.length, b.length)
  const pa = Buffer.concat([a, Buffer.alloc(len - a.length)])
  const pb = Buffer.concat([b, Buffer.alloc(len - b.length)])
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length
}

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url')
  const sig = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest()
  let provided
  try { provided = Buffer.from(sig, 'base64url') } catch { return null }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data || data.u !== adminUser || typeof data.exp !== 'number' || data.exp < Date.now()) return null
    return { user: data.u, expiresAt: new Date(data.exp).toISOString() }
  } catch { return null }
}

function parseCookies(req) {
  const header = req.headers.cookie
  if (!header) return {}
  const cookies = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return cookies
}

function setSessionCookie(res, token) {
  // 浏览器会话级 Cookie：关闭浏览器即失效，重新打开网站需重新登录；
  // 令牌本身仍有 12 小时签名有效期兜底
  const flags = [`Path=/`, 'HttpOnly', `SameSite=${secureCookie ? 'None' : 'Strict'}`]
  if (secureCookie) flags.push('Secure')
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${flags.join('; ')}`)
}

function clearSessionCookie(res) {
  const flags = ['Path=/', 'HttpOnly', `SameSite=${secureCookie ? 'None' : 'Strict'}`, 'Max-Age=0']
  if (secureCookie) flags.push('Secure')
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${flags.join('; ')}`)
}

function readSession(req) {
  const bearer = req.headers.authorization
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : parseCookies(req)[SESSION_COOKIE]
  return verifyToken(token)
}

/* ---- 登录限流：同一 IP 连续失败 5 次锁定 10 分钟 ---- */
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCK_MS = 10 * 60 * 1000
const loginAttempts = new Map()

function loginThrottleState(ip) {
  const state = loginAttempts.get(ip)
  if (state && state.lockedUntil > Date.now()) return state
  if (state && state.lockedUntil && state.lockedUntil <= Date.now()) loginAttempts.delete(ip)
  return null
}

function recordLoginFailure(ip) {
  const state = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 }
  state.count += 1
  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOGIN_LOCK_MS
    state.count = 0
  }
  loginAttempts.set(ip, state)
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, state] of loginAttempts) {
    if (!state.lockedUntil || state.lockedUntil <= now) loginAttempts.delete(ip)
  }
}, 5 * 60 * 1000).unref()

/* ================= Express 应用 ================= */

const app = express()
app.disable('x-powered-by')
const allowedOrigins = new Set((process.env.MINDBRIDGE_ALLOWED_ORIGINS || '')
  .split(',').map(origin => origin.trim()).filter(Boolean))
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Authorization')
      return res.sendStatus(204)
    }
    return res.sendStatus(403)
  }
  next()
})
app.use(express.json({ limit: '256kb' }))

/* ---- 安全响应头 ---- */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '))
  next()
})

/* ---- 鉴权中间件：保护 API 与数据文件，写操作要求防伪标头 ---- */
function requireAuth(req, res, next) {
  const session = readSession(req)
  if (!session) return res.status(401).json({ error: '未登录或会话已过期' })
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'fetch') {
    return res.status(403).json({ error: '请求缺少防伪标头' })
  }
  req.session = session
  next()
}

/* ---- 认证接口 ---- */
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const ip = req.ip || 'unknown'
    const locked = loginThrottleState(ip)
    if (locked) {
      res.setHeader('Retry-After', String(Math.ceil((locked.lockedUntil - Date.now()) / 1000)))
      return res.status(429).json({ error: '尝试次数过多，账号已临时锁定，请 10 分钟后再试' })
    }
    const { username, password } = req.body || {}
    const ok = verifyUsername(username) & verifyPassword(password)
    if (!ok) {
      recordLoginFailure(ip)
      await new Promise(resolve => setTimeout(resolve, 400 + Math.random() * 400))
      return res.status(401).json({ error: '用户名或密码错误' })
    }
    loginAttempts.delete(ip)
    const token = issueToken(adminUser)
    setSessionCookie(res, token)
    res.status(201).json({ user: adminUser, expiresAt: verifyToken(token).expiresAt })
  } catch (error) { next(error) }
})

app.get('/api/auth/session', (req, res) => {
  const session = readSession(req)
  res.json({ authenticated: Boolean(session), user: session?.user ?? null, expiresAt: session?.expiresAt ?? null })
})

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res)
  res.json({ loggedOut: true })
})

/* ================= 流水线 Provider 装配 =================
 * 切换预计算/真实模型只改 MINDBRIDGE_PIPELINE_PROVIDER，路由与前端不变。
 */
const pipelineProvider = createPipelineProvider({ dataRoot, stateRoot })

async function exists(target) {
  try { await fs.access(target); return true } catch { return false }
}

app.get('/api/health', async (_req, res, next) => {
  try { res.json({ status: 'ok', conditions: (await pipelineProvider.listExperiments()).length }) } catch (error) { next(error) }
})

/* ---- 以下 API 与数据文件均需登录 ---- */
app.use('/api', requireAuth)
app.use('/data', requireAuth)
app.use('/data', createLegacyDataAlias({ dataRoot }))
app.use('/api', createApiRouter(pipelineProvider))

/* ---- 前端静态资源 ---- */
app.use(express.static(distRoot, { index: false }))
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/data/')) return next()
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(distRoot, 'index.html'))
  } catch (error) { next(error) }
})

app.use((error, _req, res, _next) => {
  console.error(error)
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500
  res.status(status).json({ error: status === 500 ? '服务器内部错误' : error.message })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`MindBridge server listening on http://0.0.0.0:${port}`)
  console.log(`Data root: ${dataRoot}`)
  console.log(`Pipeline provider: ${process.env.MINDBRIDGE_PIPELINE_PROVIDER || 'precomputed'}`)
})
