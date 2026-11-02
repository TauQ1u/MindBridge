/*
 * build-module-output.mjs —— 行为解码贡献 Module 离线生成脚本。
 *
 * 从可视化数据包（final_label_timeline.csv + calcium.csv）推导确定性的
 * 预计算归因结果，写入每个实验版本目录的 model_output/：
 *
 *   versions/demo-v1/model_output/
 *   ├─ decoder_modules.json        模块定义（成员固定）
 *   ├─ neuron_module_profiles.csv  神经元归属（每个神经元至多一个主要模块）
 *   └─ module_frame_evidence.json  每帧贡献证据（Top 3 神经元 + 聚合分数）
 *
 * 归属规则（与项目技术口径一致）：
 *   - 对每个神经元统计其在各已复核标签片段中的平均正向活动贡献；
 *   - 取平均贡献最高的标签作为该神经元的主要支持行为；
 *   - 归属强度低于阈值的神经元不强行分组（非特异神经元）。
 *
 * 运行：node scripts/build-module-output.mjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const experimentsRoot = path.join(projectRoot, 'server', 'data', 'experiments')
const RESULT_VERSION = 'demo-v1'

const CONDITIONS = ['healthy', 'cort_like', 'ketamine_like_recovery']

/* 与 3D 内核 BEHAVIOR_CONFIG 同一字典，保证模块配色与状态色系一致 */
const LABEL_META = {
  rearing: { zh: '直立探索', color: '#f97316', kind: 'behavior' },
  locomotion: { zh: '笼内移动', color: '#22c55e', kind: 'behavior' },
  motor: { zh: '跑轮运动', color: '#dc2626', kind: 'behavior' },
  grooming: { zh: '巢外理毛', color: '#e5a323', kind: 'behavior' },
  nesting: { zh: '筑巢', color: '#ec4899', kind: 'behavior' },
  quiet_wake: { zh: '安静清醒', color: '#0d9488', kind: 'behavior' },
  w: { zh: '清醒', color: '#38bdf8', kind: 'sleep' },
  nrem: { zh: 'NREM 睡眠', color: '#6366f1', kind: 'sleep' },
  rem: { zh: 'REM 睡眠', color: '#8b5cf6', kind: 'sleep' },
  ma: { zh: '微觉醒', color: '#c084fc', kind: 'sleep' },
}

/* 标签片段太短（帧数不足）时不为其建立模块 */
const MIN_MODULE_FRAMES = 12
/* 归属强度阈值：相对跨标签均值的标准化分数低于该值为非特异神经元 */
const MEMBERSHIP_THRESHOLD = 0.25
/* 模块最小成员数：低于该值不成立模块（该标签帧证据记为不可用） */
const MIN_MODULE_MEMBERS = 2

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim())
  const columns = lines[0].split(',').map(col => col.trim().replace(/^\uFEFF/, ''))
  return lines.slice(1).map(line => {
    const cells = line.split(',')
    return Object.fromEntries(columns.map((col, index) => [col, (cells[index] ?? '').trim()]))
  })
}

const round = (value, digits = 4) => Number(value.toFixed(digits))

async function buildCondition(conditionId) {
  const versionRoot = path.join(experimentsRoot, conditionId, 'versions', RESULT_VERSION)
  const labelRows = parseCsv(await fs.readFile(path.join(versionRoot, 'visualization', 'final_label_timeline.csv'), 'utf8'))
  const calciumRows = parseCsv(await fs.readFile(path.join(versionRoot, 'visualization', 'calcium.csv'), 'utf8'))

  const neuronIds = Object.keys(calciumRows[0]).filter(key => /^n\d+$/.test(key)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  const frameCount = Math.min(labelRows.length, calciumRows.length)
  if (!frameCount || !neuronIds.length) throw new Error(`${conditionId}: 数据为空`)

  const labels = labelRows.slice(0, frameCount).map(row => (row.behavior || '').trim())
  const timestamps = calciumRows.slice(0, frameCount).map(row => Number(row.time_seconds))
  const activity = calciumRows.slice(0, frameCount).map(row => neuronIds.map(id => {
    const value = Number(row[id])
    return Number.isFinite(value) ? value : 0
  }))

  /* ---- 每神经元 z 分数（跨时间），作为贡献的原始信号 ---- */
  const zScores = neuronIds.map((_, n) => {
    const series = activity.map(frame => frame[n])
    const mean = series.reduce((sum, v) => sum + v, 0) / frameCount
    const variance = series.reduce((sum, v) => sum + (v - mean) ** 2, 0) / frameCount
    const sd = Math.sqrt(variance) || 1
    return series.map(v => (v - mean) / sd)
  })

  /*
   * 归属：各标签片段中的平均贡献，按神经元跨标签 z 化。
   * 睡眠阶段整体活动偏低，绝对阈值会让睡眠模块无人可分配；
   * 相对分数 rel = (m_L - μ) / σ 保证每个神经元在自己的标签间比较。
   */
  const targetLabels = [...new Set(labels)].filter(label => LABEL_META[label.toLowerCase()])
  const labelStats = targetLabels.map(label => {
    const indices = labels.map((value, index) => (value === label ? index : -1)).filter(index => index >= 0)
    return { label, indices }
  }).filter(item => item.indices.length >= MIN_MODULE_FRAMES)

  const meanDuring = zScores.map((series, n) => labelStats.map(({ indices }) =>
    indices.reduce((sum, index) => sum + series[index], 0) / indices.length))

  const relScores = meanDuring.map((means) => {
    const mu = means.reduce((sum, v) => sum + v, 0) / means.length
    const sigma = Math.sqrt(means.reduce((sum, v) => sum + (v - mu) ** 2, 0) / means.length)
    return means.map(mean => (sigma > 1e-9 ? (mean - mu) / sigma : 0))
  })

  /* 归属强度归一：sigmoid(rel)，0.5 对应跨标签均值水平 */
  const membershipOf = rel => round(1 / (1 + Math.exp(-rel * 2)), 4)

  const modules = labelStats.map(({ label, indices }, labelIndex) => {
    const key = label.toLowerCase()
    const meta = LABEL_META[key]
    const members = []
    relScores.forEach((relList, n) => {
      const best = relList.indexOf(Math.max(...relList))
      if (best === labelIndex && relList[labelIndex] >= MEMBERSHIP_THRESHOLD) members.push(n)
    })
    return {
      label, key, meta, indices,
      members: members.sort((a, b) => a - b),
      baseline: meanDuring.map((means, n) => means[labelIndex]),
      labelIndex,
    }
  }).filter(module => module.members.length >= MIN_MODULE_MEMBERS)

  const moduleByLabel = new Map(modules.map(module => [module.label, module]))

  /* ---- 每帧证据：相对标签基线的波动贡献 + Top 3 ---- */
  const labelIndexOf = new Map(labelStats.map((item, index) => [item.label, index]))
  const frames = labels.map((label, frameIndex) => {
    const module = moduleByLabel.get(label) ?? null
    const stamp = timestamps[frameIndex]
    if (!module) {
      return { frameId: frameIndex, timestamp: round(stamp, 4), targetLabel: label, predictedLabel: label, confidence: null, moduleId: null, moduleScore: null, topNeurons: [] }
    }
    const baselineIndex = labelIndexOf.get(label)
    const memberZ = module.members.map(n => ({
      n,
      c: zScores[n][frameIndex] - meanDuring[n][baselineIndex],
    }))
    const moduleScore = round(Math.tanh(memberZ.reduce((sum, item) => sum + Math.max(0, item.c), 0) / Math.max(memberZ.length, 1)), 4)
    const topNeurons = memberZ
      .map(item => ({ neuronId: neuronIds[item.n], contribution: round(Math.tanh(item.c / 1.5), 4) }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
    const confidence = round(Math.min(0.98, Math.max(0.55, 0.58 + moduleScore * 0.4)), 4)
    return {
      frameId: frameIndex,
      timestamp: round(stamp, 4),
      targetLabel: label,
      predictedLabel: label,
      confidence,
      moduleId: `${module.meta.kind}-${module.key}`,
      moduleScore,
      topNeurons,
    }
  })

  /* ---- 写文件 ---- */
  const outputRoot = path.join(versionRoot, 'model_output')
  await fs.mkdir(outputRoot, { recursive: true })

  const decoderModules = {
    schemaVersion: '1.0',
    modelName: 'MouseNeuralBehaviorDecoder',
    modelVersion: 'demo-1.0',
    conditionId,
    generatedAt: new Date().toISOString(),
    method: 'precomputed_attribution',
    modules: modules.map(module => ({
      id: `${module.meta.kind}-${module.key}`,
      name: `${module.meta.zh}解码模块`,
      kind: module.meta.kind,
      targetLabel: module.label,
      memberNeuronIds: module.members.map(n => neuronIds[n]),
      memberCount: module.members.length,
      color: module.meta.color,
    })),
  }

  const memberSet = new Set(modules.flatMap(module => module.members.map(n => neuronIds[n])))
  const moduleIdByLabel = new Map(modules.map(module => [module.label, `${module.meta.kind}-${module.key}`]))
  const profileLines = ['neuron_id,primary_module_id,target_label,membership_score']
  relScores.forEach((relList, n) => {
    const best = relList.indexOf(Math.max(...relList))
    const label = labelStats[best]?.label ?? ''
    if (!memberSet.has(neuronIds[n]) || !moduleIdByLabel.has(label)) {
      profileLines.push(`${neuronIds[n]},,,`)
      return
    }
    profileLines.push(`${neuronIds[n]},${moduleIdByLabel.get(label)},${label},${membershipOf(relList[best])}`)
  })

  const evidence = {
    schemaVersion: '1.0',
    modelName: 'MouseNeuralBehaviorDecoder',
    modelVersion: 'demo-1.0',
    conditionId,
    method: 'precomputed_attribution',
    frameCount: frames.length,
    frames,
  }

  const files = {
    'decoder_modules.json': JSON.stringify(decoderModules, null, 2),
    'neuron_module_profiles.csv': profileLines.join('\n') + '\n',
    'module_frame_evidence.json': JSON.stringify(evidence),
  }
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(outputRoot, name), content, 'utf8')
  }

  /* ---- 注册 artifact + checksum 到 manifest.json ---- */
  const manifestPath = path.join(experimentsRoot, conditionId, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.pipeline = manifest.pipeline || {}
  manifest.pipeline.decoder = { model: 'MouseNeuralBehaviorDecoder', modelVersion: 'demo-1.0', contribution: 'precomputed_attribution' }
  const artifactPrefix = `versions/${RESULT_VERSION}/model_output`
  manifest.artifacts = manifest.artifacts || {}
  manifest.checksums = manifest.checksums || {}
  for (const name of Object.keys(files)) {
    const key = `model_output.${name.replace(/\.[^.]+$/, '').replace(/\./g, '_')}`
    manifest.artifacts[key] = `${artifactPrefix}/${name}`
    manifest.checksums[key] = `sha256:${crypto.createHash('sha256').update(files[name]).digest('hex')}`
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const summary = decoderModules.modules.map(module => `${module.name}:${module.memberCount}`).join(' · ')
  console.log(`[module-output] ${conditionId}: ${frames.length} 帧, ${modules.length} 模块 — ${summary}`)
}

for (const conditionId of CONDITIONS) {
  await buildCondition(conditionId)
}
console.log('[module-output] 完成')
