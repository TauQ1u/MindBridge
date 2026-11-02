import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrecomputedPipelineProvider } from '../src/providers/PrecomputedPipelineProvider.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('同一条件组合复用同一报告，并把已选图表写入新增章节', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindbridge-report-'))
  const dataRoot = path.join(root, 'data')
  const stateRoot = path.join(root, 'state')
  await fs.mkdir(path.join(dataRoot, 'reports'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'analyses'), { recursive: true })
  await fs.copyFile(
    path.join(projectRoot, 'server', 'data', 'reports', 'compare_3.md'),
    path.join(dataRoot, 'reports', 'compare_3.md'),
  )
  for (const conditionId of ['healthy', 'cort_like', 'ketamine_like_recovery']) {
    const conditionRoot = path.join(dataRoot, 'experiments', conditionId)
    await fs.mkdir(path.join(conditionRoot, 'raw'), { recursive: true })
    await fs.writeFile(path.join(conditionRoot, 'manifest.json'), JSON.stringify({
      experimentId: `MOUSE1-${conditionId}`,
      conditionId,
      defaultVersion: 'demo-v1',
      versions: { 'demo-v1': {} },
    }))
  }

  try {
    const provider = new PrecomputedPipelineProvider({ dataRoot, stateRoot })
    const input = { conditionIds: ['healthy', 'cort_like', 'ketamine_like_recovery'] }
    const first = await provider.createReport({ ...input, evidenceIds: ['overview', 'network'] })
    const second = await provider.createReport({ ...input, evidenceIds: ['advanced'] })

    assert.equal(first.id, 'report-compare_3')
    assert.equal(second.id, first.id)
    assert.equal(second.url, first.url)

    const generated = await fs.readFile(path.join(dataRoot, 'reports', 'generated-compare_3.md'), 'utf8')
    assert.match(generated, /## 七 图表证据/)
    assert.match(generated, /群体活动分布图/)
    assert.doesNotMatch(generated, /功能共活动网络比较图/)
    assert.match(generated, /所有图表仍属于本报告/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
