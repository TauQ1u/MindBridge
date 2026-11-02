/**
 * 数据布局迁移 + 派生数据生成脚本（一次性，可重复执行，幂等）
 *
 * 将旧的 server/data/{raw_input,review,visualization_input} 迁移为：
 *   server/data/experiments/<condition>/{manifest.json, raw/, versions/demo-v1/{review/,visualization/,provenance.json}}
 *   server/data/experiments/_shared/            （跨实验共享文件及其 manifest）
 *   server/data/analyses/*.json                 （确定性生成的预计算分析结果）
 *   server/data/reports/*.md                    （保持不动）
 *
 * 用法：node scripts/build-data-layout.mjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.join(projectRoot, 'server', 'data')
const experimentsRoot = path.join(dataRoot, 'experiments')
const sharedRoot = path.join(experimentsRoot, '_shared')
const analysesRoot = path.join(dataRoot, 'analyses')
const RESULT_VERSION = 'demo-v1'
const LABEL_VERSION = 'labels-demo-v1'
const CREATED_AT = '2026-09-21T10:00:00+08:00'

const CONDITION_IDS = ['healthy', 'cort_like', 'ketamine_like_recovery']
const CONDITION_ORDER = ['healthy', 'cort_like', 'ketamine_like_recovery']
const DISPLAY_NAMES = { healthy: '健康', cort_like: '抑郁', ketamine_like_recovery: '给药后恢复' }

const PIPELINE = {
  video: { model: 'DeepLabCut-HRNetW32 + VideoMAE + MS-TCN++', modelVersion: 'video-demo-v1' },
  calcium: { model: 'STFS-Former', modelVersion: 'stfs-v2' },
  sleep: { source: 'preprovided-label' },
}

async function exists(target) {
  try { await fs.access(target); return true } catch { return false }
}

async function readJson(target, fallback = null) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')) } catch { return fallback }
}

async function sha256(file) {
  const buf = await fs.readFile(file)
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`
}

/** 移动目录内容：src/* -> dst/*（已存在的目标文件跳过，保证幂等） */
async function moveContents(src, dst) {
  if (!(await exists(src))) return
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src)) {
    const from = path.join(src, entry)
    const to = path.join(dst, entry)
    if (await exists(to)) continue
    await fs.rename(from, to)
  }
}

async function removeIfEmpty(dir) {
  if (!(await exists(dir))) return
  try { await fs.rmdir(dir) } catch { /* 非空则保留 */ }
}

/* ---------- 1. 迁移目录 ---------- */

async function migrateLayout() {
  await fs.mkdir(experimentsRoot, { recursive: true })
  await fs.mkdir(sharedRoot, { recursive: true })
  await fs.mkdir(analysesRoot, { recursive: true })

  for (const conditionId of CONDITION_IDS) {
    const expRoot = path.join(experimentsRoot, conditionId)
    const versionRoot = path.join(expRoot, 'versions', RESULT_VERSION)
    await moveContents(path.join(dataRoot, 'raw_input', conditionId), path.join(expRoot, 'raw'))
    await moveContents(path.join(dataRoot, 'review', conditionId), path.join(versionRoot, 'review'))
    await moveContents(path.join(dataRoot, 'visualization_input', conditionId), path.join(versionRoot, 'visualization'))
  }

  // 跨实验共享文件
  for (const name of ['neuron_positions.csv', 'activity_norm.json', 'layout_method.json', 'schema.json']) {
    const from = path.join(dataRoot, 'visualization_input', name)
    if (await exists(from)) await fs.rename(from, path.join(sharedRoot, name)).catch(() => {})
  }
  // review 顶层 manifest 归入共享区
  const reviewManifest = path.join(dataRoot, 'review', 'manifest.json')
  if (await exists(reviewManifest)) {
    await fs.rename(reviewManifest, path.join(sharedRoot, 'review_manifest.json')).catch(() => {})
  }
  // 可视化构建 provenance 留档到共享区
  const vizProvenance = path.join(dataRoot, 'visualization_input', 'provenance.json')
  if (await exists(vizProvenance)) {
    await fs.rename(vizProvenance, path.join(sharedRoot, 'visualization_provenance.json')).catch(() => {})
  }

  // 清理旧空目录
  for (const dir of ['raw_input', 'review', 'visualization_input']) {
    const target = path.join(dataRoot, dir)
    if (!(await exists(target))) continue
    for (const entry of await fs.readdir(target)) await removeIfEmpty(path.join(target, entry))
    await removeIfEmpty(target)
  }
}

/* ---------- 2. 每实验 manifest + 版本 provenance ---------- */

function artifactMap(conditionId) {
  const v = `versions/${RESULT_VERSION}`
  return {
    'raw.video': 'raw/video.mp4',
    'raw.calcium': 'raw/calcium_traces.csv',
    'raw.eeg_emg': 'raw/eeg_emg.csv',
    'raw.meta': 'raw/meta.json',
    'review.timeline': `${v}/review/timeline.csv`,
    'review.conflicts': `${v}/review/conflicts.csv`,
    'review.video_prediction': `${v}/review/video_prediction.csv`,
    'review.neural_prediction': `${v}/review/neural_prediction.csv`,
    'review.sleep_stage_prediction': `${v}/review/sleep_stage_prediction.csv`,
    'visualization.calcium': `${v}/visualization/calcium.csv`,
    'visualization.dynamic_edges': `${v}/visualization/dynamic_edges.csv`,
    'visualization.final_label_timeline': `${v}/visualization/final_label_timeline.csv`,
    'visualization.metadata': `${v}/visualization/metadata.json`,
    'visualization.behavior_stats': `${v}/visualization/behavior_stats.json`,
  }
}

const CHECKSUM_MAX_BYTES = 32 * 1024 * 1024 // 大文件（视频）跳过校验和

async function writeExperimentMetadata() {
  const reviewManifest = await readJson(path.join(sharedRoot, 'review_manifest.json'), {})
  const mouseId = reviewManifest.mouse || 'mouse1'
  const manifestConditions = new Map((reviewManifest.conditions || []).map(item => [item.condition_id, item]))

  for (const conditionId of CONDITION_IDS) {
    const expRoot = path.join(experimentsRoot, conditionId)
    const artifacts = artifactMap(conditionId)
    const checksums = {}
    for (const [key, rel] of Object.entries(artifacts)) {
      const file = path.join(expRoot, rel)
      if (!(await exists(file))) continue
      const { size } = await fs.stat(file)
      if (size <= CHECKSUM_MAX_BYTES) checksums[key] = await sha256(file)
    }

    const meta = await readJson(path.join(expRoot, 'raw', 'meta.json'), {})
    const manifest = {
      schemaVersion: '1.0',
      experimentId: `${String(mouseId).toUpperCase()}-${conditionId}`,
      conditionId,
      displayName: manifestConditions.get(conditionId)?.display_name || DISPLAY_NAMES[conditionId] || conditionId,
      executionMode: 'precomputed',
      mouseId: meta.mouse_id || meta.subject || mouseId,
      dataNature: meta.data_nature || reviewManifest.data_nature || 'unspecified',
      pipeline: PIPELINE,
      defaultVersion: RESULT_VERSION,
      versions: {
        [RESULT_VERSION]: {
          resultVersion: RESULT_VERSION,
          labelVersion: LABEL_VERSION,
          createdAt: CREATED_AT,
          provenance: `versions/${RESULT_VERSION}/provenance.json`,
        },
      },
      artifacts,
      checksums,
    }
    await fs.writeFile(path.join(expRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    const provenance = {
      schemaVersion: '1.0',
      resultVersion: RESULT_VERSION,
      experimentId: manifest.experimentId,
      conditionId,
      executionMode: 'precomputed',
      createdAt: CREATED_AT,
      pipeline: PIPELINE,
      reviewPackage: manifestConditions.get(conditionId) || null,
      dataLineage: reviewManifest.data_lineage || null,
      modalityRoles: reviewManifest.modality_roles || null,
      reviewLogic: reviewManifest.review_logic || null,
      literatureContext: reviewManifest.literature_context || null,
    }
    await fs.writeFile(
      path.join(expRoot, 'versions', RESULT_VERSION, 'provenance.json'),
      JSON.stringify(provenance, null, 2), 'utf8',
    )
  }

  // 共享区 manifest（键不含 scope 前缀，与 /api/artifacts/<scope>.<name> 解析约定一致）
  const sharedArtifacts = {
    'neuron_positions': 'neuron_positions.csv',
    'activity_norm': 'activity_norm.json',
    'layout_method': 'layout_method.json',
    'visualization_schema': 'schema.json',
    'review_manifest': 'review_manifest.json',
    'visualization_provenance': 'visualization_provenance.json',
  }
  const sharedChecksums = {}
  for (const [key, rel] of Object.entries(sharedArtifacts)) {
    const file = path.join(sharedRoot, rel)
    if (await exists(file)) sharedChecksums[key] = await sha256(file)
  }
  await fs.writeFile(path.join(sharedRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0',
    scope: 'shared',
    executionMode: 'precomputed',
    artifacts: sharedArtifacts,
    checksums: sharedChecksums,
  }, null, 2), 'utf8')
}

/* ---------- 3. 生成 analyses/*.json ---------- */

async function readConditionMetrics(conditionId) {
  const expRoot = path.join(experimentsRoot, conditionId)
  const versionRoot = path.join(expRoot, 'versions', RESULT_VERSION)
  const stats = await readJson(path.join(versionRoot, 'visualization', 'behavior_stats.json'), {})
  const vizMeta = await readJson(path.join(versionRoot, 'visualization', 'metadata.json'), {})
  const reviewManifest = await readJson(path.join(sharedRoot, 'review_manifest.json'), {})
  const reviewInfo = (reviewManifest.conditions || []).find(item => item.condition_id === conditionId) || {}
  return {
    conditionId,
    displayName: DISPLAY_NAMES[conditionId] || conditionId,
    durationSeconds: stats.duration_seconds ?? null,
    frames: stats.frames ?? vizMeta.frame_count ?? null,
    samplingRateHz: vizMeta.sampling_rate_hz ?? null,
    neuronCount: vizMeta.neuron_count ?? null,
    edgeMethod: vizMeta.edge_method ?? null,
    sleepStageFraction: stats.sleep_stage_fraction ?? {},
    behaviorFraction: stats.behavior_fraction ?? {},
    reviewStatus: stats.review_status ?? null,
    conflicts: {
      total: reviewInfo.conflict_frames ?? 0,
      byType: reviewInfo.conflicts_by_type ?? {},
      plan: reviewInfo.conflict_plan ?? [],
    },
    framesByStage: reviewInfo.frames_by_stage ?? {},
  }
}

function fractionDelta(base, other) {
  const keys = new Set([...Object.keys(base), ...Object.keys(other)])
  const delta = {}
  for (const key of keys) delta[key] = Number(((other[key] ?? 0) - (base[key] ?? 0)).toFixed(6))
  return delta
}

async function buildAnalysis(analysisId, conditionIds) {
  const ordered = CONDITION_ORDER.filter(id => conditionIds.includes(id))
  const metrics = {}
  for (const id of ordered) metrics[id] = await readConditionMetrics(id)
  const kind = ordered.length === 1 ? 'single' : ordered.length === 2 ? 'pairwise' : 'three_way'

  const analysis = {
    schemaVersion: '1.0',
    analysisId,
    kind,
    conditions: ordered,
    generatedAt: CREATED_AT,
    executionMode: 'precomputed',
    metrics,
  }

  if (kind !== 'single') {
    const base = ordered[0]
    analysis.comparison = {
      baseline: base,
      deltas: Object.fromEntries(
        ordered.slice(1).map(id => [id, {
          vsBaseline: base,
          sleepStageFractionDelta: fractionDelta(metrics[base].sleepStageFraction, metrics[id].sleepStageFraction),
          behaviorFractionDelta: fractionDelta(metrics[base].behaviorFraction, metrics[id].behaviorFraction),
          neuronCountDelta: (metrics[id].neuronCount ?? 0) - (metrics[base].neuronCount ?? 0),
          conflictCountDelta: (metrics[id].conflicts.total) - (metrics[base].conflicts.total),
        }]),
      ),
    }
  }
  return analysis
}

const ANALYSIS_SPECS = [
  ['healthy', ['healthy']],
  ['cort_like', ['cort_like']],
  ['ketamine_like_recovery', ['ketamine_like_recovery']],
  ['compare_healthy_cort', ['healthy', 'cort_like']],
  ['compare_healthy_recovery', ['healthy', 'ketamine_like_recovery']],
  ['compare_3', ['healthy', 'cort_like', 'ketamine_like_recovery']],
]

async function writeAnalyses() {
  for (const [analysisId, conditionIds] of ANALYSIS_SPECS) {
    const analysis = await buildAnalysis(analysisId, conditionIds)
    await fs.writeFile(path.join(analysesRoot, `${analysisId}.json`), JSON.stringify(analysis, null, 2), 'utf8')
  }
}

/* ---------- main ---------- */

await migrateLayout()
await writeExperimentMetadata()
await writeAnalyses()
console.log('[build-data-layout] done')
console.log(`  experiments: ${CONDITION_IDS.map(id => path.join('server/data/experiments', id)).join(', ')}`)
console.log(`  analyses:    ${ANALYSIS_SPECS.map(([id]) => `${id}.json`).join(', ')}`)
