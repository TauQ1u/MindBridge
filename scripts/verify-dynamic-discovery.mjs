import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindbridge-discovery-'))
const rawRoot = path.join(root, 'raw_input')
const conditions = ['healthy', 'cort_like', 'ketamine_like_recovery', 'fourth_state']
let server

try {
  await Promise.all(conditions.map(async condition => {
    const directory = path.join(rawRoot, condition)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify({ condition_id: condition, display_name: condition.replaceAll('_', ' ') }))
  }))

  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, MINDBRIDGE_DATA_ROOT: root, MINDBRIDGE_STATE_ROOT: path.join(root, 'state'), PORT: '3101' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const deadline = Date.now() + 15000
  let response
  while (Date.now() < deadline) {
    try { response = await fetch('http://127.0.0.1:3101/api/experiments'); if (response.ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!response?.ok) throw new Error('temporary discovery server did not start')
  const experiments = await response.json()
  const fourth = experiments.find(item => item.condition === 'fourth_state')
  if (experiments.length !== 4 || !fourth) throw new Error(`expected 4 discovered conditions, got ${experiments.length}`)
  if (fourth.stage !== 'raw_input' || fourth.packages.review || fourth.packages.visualization) throw new Error('fourth state package status is incorrect')
  console.log(JSON.stringify({ discovered: experiments.map(item => item.condition), fourthStage: fourth.stage }))
} finally {
  server?.kill('SIGTERM')
  const resolved = path.resolve(root)
  if (!resolved.startsWith(path.resolve(os.tmpdir()))) throw new Error('refusing to remove non-temporary discovery fixture')
  await fs.rm(resolved, { recursive: true, force: true })
}
