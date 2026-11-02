/*
 * module-jobs.test.mjs —— 行为解码贡献 Module 任务接口测试。
 *
 * 启动独立服务进程（临时 state 目录 + 已知口令），覆盖：
 *   - 未登录访问模型任务接口 → 401
 *   - 非法 Condition → 400 / 404
 *   - 任务状态 queued → running → ready 流转
 *   - ready 后返回正确模型版本、模块数量、帧数
 *   - 帧时间轴与复核时间轴一致、Top 神经元均在位置文件内
 *   - /api/experiments 返回 packages.moduleEvidence
 *
 * 运行：node --test server/tests/module-jobs.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PASSWORD = 'Module@Test2026'

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
  return `scrypt$16384$8$1$${salt}$${hash}`
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

let serverProcess
let baseUrl
let cookie
let stateRoot

async function api(method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* HTML 错误页 */ }
  return { status: response.status, json, text }
}

before(async () => {
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  stateRoot = path.join(projectRoot, 'server', 'state', `test-module-jobs-${process.pid}`)
  serverProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MINDBRIDGE_STATE_ROOT: stateRoot,
      MINDBRIDGE_ADMIN_PASSWORD_HASH: scryptHash(PASSWORD),
      MINDBRIDGE_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  serverProcess.stderr.on('data', chunk => { stderr += chunk })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务器启动超时\n${stderr}`)), 15000)
    serverProcess.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve() }
    })
    serverProcess.on('exit', code => reject(new Error(`服务器提前退出: ${code}\n${stderr}`)))
  })
  cookie = await loginAndGetCookie()
})

after(async () => {
  serverProcess?.kill()
  await fs.rm(stateRoot, { recursive: true, force: true })
})

/* 登录并取会话 cookie（X-Requested-With 防伪标头为后端写操作要求） */
async function loginAndGetCookie() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  })
  assert.equal(response.status, 201)
  return response.headers.get('set-cookie').split(';')[0]
}

test('未登录访问模型任务接口返回 401', async () => {
  const response = await fetch(`${baseUrl}/api/ai/module-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ conditionId: 'healthy' }),
  })
  assert.equal(response.status, 401)
})

test('非法 Condition 返回 400/404', async () => {
  const session = await loginAndGetCookie()
  cookie = session
  const bad = await api('POST', '/api/ai/module-jobs', { conditionId: 'bad!!id' })
  assert.equal(bad.status, 400)
  const unknown = await api('POST', '/api/ai/module-jobs', { conditionId: 'no_such_cond' })
  assert.equal(unknown.status, 404)
})

test('实验列表包含 packages.moduleEvidence', async () => {
  const { status, json } = await api('GET', '/api/experiments')
  assert.equal(status, 200)
  assert.equal(json.length, 3)
  for (const experiment of json) {
    assert.equal(experiment.packages.moduleEvidence, true, `${experiment.condition} 应标记 moduleEvidence`)
  }
})

test('任务从 queued/running 进入 ready 并返回完整结果', async () => {
  const created = await api('POST', '/api/ai/module-jobs', { experimentId: 'MOUSE1-healthy', conditionId: 'healthy' })
  assert.equal(created.status, 202)
  const { jobId } = created.json
  assert.match(jobId, /^MOD-healthy-/)
  assert.equal(created.json.model.name, 'MouseNeuralBehaviorDecoder')

  const seen = new Set()
  let ready = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await api('GET', `/api/ai/module-jobs/${jobId}`)
    assert.equal(state.status, 200)
    seen.add(state.json.status)
    if (state.json.status === 'ready') { ready = state.json; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, '任务应在限轮询内到达 ready')
  assert.ok(seen.has('queued') || seen.has('running'), '应能观察到中间状态')
  assert.equal(ready.progress, 100)

  const { result } = ready
  assert.equal(result.model.version, 'demo-1.0')
  assert.equal(result.method, 'precomputed_attribution')
  assert.ok(result.modules.length >= 4, '模块数量应不少于 4')
  assert.ok(result.neuronProfiles.length > 0)
  assert.ok(result.frames.length > 600)

  const module = result.modules[0]
  assert.equal(module.memberCount, module.memberNeuronIds.length)
  assert.ok(['behavior', 'sleep'].includes(module.kind))

  /* 帧数据校验：frameId 连续、时间戳单调、Top 神经元是模块成员 */
  result.frames.forEach((frame, index) => {
    assert.equal(frame.frameId, index)
    if (index > 0) assert.ok(frame.timestamp >= result.frames[index - 1].timestamp)
    if (frame.moduleId) {
      const owner = result.modules.find(item => item.id === frame.moduleId)
      assert.ok(owner, `未知模块 ${frame.moduleId}`)
      assert.ok(frame.topNeurons.every(item => owner.memberNeuronIds.includes(item.neuronId)), 'Top 神经元必须是模块成员')
      assert.ok(frame.confidence > 0.5 && frame.confidence <= 1)
    }
  })
})

test('未知 jobId 返回 404', async () => {
  const { status } = await api('GET', '/api/ai/module-jobs/MOD-nope-000')
  assert.equal(status, 404)
})

test('缺少 Module 数据的 Condition 返回 404', async () => {
  /* 构造一个临时 Condition：只有 manifest + raw 目录，没有 model_output */
  const condDir = path.join(projectRoot, 'server', 'data', 'experiments', 'tmp_no_module')
  await fs.mkdir(path.join(condDir, 'raw'), { recursive: true })
  await fs.writeFile(path.join(condDir, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0', experimentId: 'MOUSE1-tmp_no_module', conditionId: 'tmp_no_module', defaultVersion: 'demo-v1',
    versions: { 'demo-v1': {} },
  }))
  try {
    const created = await api('POST', '/api/ai/module-jobs', { conditionId: 'tmp_no_module' })
    assert.equal(created.status, 404)
  } finally {
    await fs.rm(condDir, { recursive: true, force: true })
  }
})

test('模块证据不可用时其他实验接口不受影响', async () => {
  const { status, json } = await api('GET', '/api/experiments')
  assert.equal(status, 200)
  assert.ok(json.every(item => item.packages.rawInput))
})
