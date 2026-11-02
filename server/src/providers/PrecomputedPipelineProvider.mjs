import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PipelineProvider } from './PipelineProvider.mjs'

export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

const conditionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const artifactKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

/** 模拟处理阶段（固定时长，保证重复演示结果可控，不用随机进度） */
const RUN_STAGES = [
  { id: 'video', label: '行为视频识别', untilMs: 2000 },
  { id: 'decode', label: '钙神经信号分析', untilMs: 4000 },
  { id: 'review', label: '时间轴对齐与复核准备', untilMs: 5000 },
  { id: 'visualization', label: '3D 建模数据生成', untilMs: 7000 },
]
const RUN_TOTAL_MS = RUN_STAGES[RUN_STAGES.length - 1].untilMs

const CANONICAL_CONDITION_ORDER = ['healthy', 'cort_like', 'ketamine_like_recovery']

const REPORT_EVIDENCE = {
  overview: {
    title: '跨条件效应图',
    source: '总览 · 结论与跨条件效应',
    caption: '汇总当前比较条件中变化最明显的行为、睡眠与神经活动指标。',
    guide: '比较各条件对应点的位置与连线方向；连线仅表示描述性变化，不代表统计显著性。',
  },
  'behavior-neural': {
    title: '行为表型与神经活动图组',
    source: '行为与神经 · 状态占比、群体活动热图与单神经元证据',
    caption: '呈现行为状态占比、不同状态下的群体神经活动以及可回溯的单神经元结果。',
    guide: '先看状态占比，再看相同状态下各条件的群体活动颜色，最后按需下钻到单个神经元。',
  },
  network: {
    title: '功能共活动网络比较图',
    source: '功能网络 · 条件矩阵与变化矩阵',
    caption: '比较不同条件下神经元两两活动的同步变化结构。',
    guide: '暖色表示更一致的活动趋势，冷色表示更相反的活动趋势；该结果不是解剖或突触连接。',
  },
  advanced: {
    title: '群体活动分布图',
    source: '高级分析 · 群体活动描述性投影',
    caption: '展示不同条件下群体活动水平与神经元间活动差异的整体分布。',
    guide: '观察不同颜色点云及其中心位置是否发生整体偏移，不将点间距离解释为统计显著性。',
  },
}

function buildEvidenceChapter(evidenceIds) {
  const items = evidenceIds.map(id => REPORT_EVIDENCE[id]).filter(Boolean)
  const lines = [
    '## 七 图表证据',
    '',
    '本章节由分析页面中“加入报告”的选择统一生成，所有图表仍属于本报告，不单独生成另一份报告。',
    '',
  ]
  if (!items.length) {
    lines.push('本次未选择附加图表，报告保留固定分析章节。', '')
    return lines.join('\n')
  }
  items.forEach((item, index) => {
    lines.push(
      `### 图 ${index + 1} ${item.title}`,
      '',
      `- 图表来源：${item.source}`,
      `- 图表内容：${item.caption}`,
      `- 读图提示：${item.guide}`,
      '',
    )
  })
  return lines.join('\n')
}

async function exists(target) {
  try { await fs.access(target); return true } catch { return false }
}

async function readJson(target, fallback = null) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')) } catch { return fallback }
}

function conditionLabel(id) {
  return id.split(/[_-]+/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim())
  if (!lines.length) return { columns: [], rows: [] }
  const columns = lines[0].split(',').map(col => col.trim())
  const rows = lines.slice(1).map(line => {
    const cells = line.split(',')
    return Object.fromEntries(columns.map((col, index) => [col, (cells[index] ?? '').trim()]))
  })
  return { columns, rows }
}

/**
 * PrecomputedPipelineProvider —— 当前使用的 Provider：
 * 接口形态与真实模型任务一致，内部读取预置结果文件，不启动任何模型计算。
 */
export class PrecomputedPipelineProvider extends PipelineProvider {
  constructor({ dataRoot, stateRoot }) {
    super()
    this.dataRoot = dataRoot
    this.stateRoot = stateRoot
    this.experimentsRoot = path.join(dataRoot, 'experiments')
    this.analysesRoot = path.join(dataRoot, 'analyses')
    this.reportsRoot = path.join(dataRoot, 'reports')
    this.sharedRoot = path.join(this.experimentsRoot, '_shared')

    this.reviewsFile = path.join(stateRoot, 'reviews.json')
    this.finalizedFile = path.join(stateRoot, 'finalized.json')
    this.runsFile = path.join(stateRoot, 'runs.json')
    this.reportsStateFile = path.join(stateRoot, 'report_tasks.json')

    this.manifestCache = new Map()
    this.runs = new Map()
    this.reportTasks = new Map()
    this.moduleJobs = new Map()
    this.writeQueue = Promise.resolve()
  }

  /* ---------- 基础工具 ---------- */

  safeConditionId(value) {
    if (typeof value !== 'string' || !conditionPattern.test(value)) throw httpError(400, 'Invalid condition id')
    return value
  }

  async readManifest(conditionId) {
    if (this.manifestCache.has(conditionId)) return this.manifestCache.get(conditionId)
    const manifest = await readJson(path.join(this.experimentsRoot, conditionId, 'manifest.json'))
    if (!manifest) throw httpError(404, `Unknown experiment: ${conditionId}`)
    this.manifestCache.set(conditionId, manifest)
    return manifest
  }

  /**
   * 归一化实验标识：接受 conditionId（healthy）或完整 experimentId（MOUSE1-healthy），
   * 统一返回 conditionId。匹配 experimentId 时扫描目录 manifest 并缓存映射。
   */
  async resolveConditionId(raw) {
    const id = this.safeConditionId(raw)
    if (await exists(path.join(this.experimentsRoot, id, 'manifest.json'))) return id
    if (!this.experimentIdIndex) {
      this.experimentIdIndex = new Map()
      const entries = await fs.readdir(this.experimentsRoot, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || !conditionPattern.test(entry.name)) continue
        const manifest = await readJson(path.join(this.experimentsRoot, entry.name, 'manifest.json'))
        if (manifest?.experimentId) this.experimentIdIndex.set(manifest.experimentId, entry.name)
      }
    }
    const conditionId = this.experimentIdIndex.get(id)
    if (!conditionId) throw httpError(404, `Unknown experiment: ${raw}`)
    return conditionId
  }

  async versionRoot(experimentId, version) {
    const conditionId = await this.resolveConditionId(experimentId)
    const manifest = await this.readManifest(conditionId)
    const resultVersion = version || manifest.defaultVersion
    if (!manifest.versions?.[resultVersion]) throw httpError(404, `Unknown result version: ${resultVersion}`)
    return { manifest, conditionId, resultVersion, root: path.join(this.experimentsRoot, conditionId, 'versions', resultVersion) }
  }

  async experimentExists(experimentId) {
    try {
      await this.resolveConditionId(experimentId)
      return true
    } catch (error) {
      if (error.status === 404) return false
      throw error
    }
  }

  /* ---------- 实验发现 ---------- */

  async listExperiments() {
    const entries = await fs.readdir(this.experimentsRoot, { withFileTypes: true })
    const experiments = await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && conditionPattern.test(entry.name))
        .map(async entry => {
          const conditionId = entry.name
          const manifest = await readManifestSafe(path.join(this.experimentsRoot, conditionId, 'manifest.json'))
          if (!manifest) return null
          const rawDir = path.join(this.experimentsRoot, conditionId, 'raw')
          const defaultVersion = manifest.defaultVersion
          const versionDir = path.join(this.experimentsRoot, conditionId, 'versions', defaultVersion)
          const stat = await fs.stat(rawDir).catch(() => null)
          const [video, calcium, eegEmg, timeline, visualization, moduleEvidence] = await Promise.all([
            exists(path.join(rawDir, 'video.mp4')),
            exists(path.join(rawDir, 'calcium_traces.csv')),
            exists(path.join(rawDir, 'eeg_emg.csv')),
            exists(path.join(versionDir, 'review', 'timeline.csv')),
            Promise.all(['metadata.json', 'calcium.csv', 'dynamic_edges.csv', 'final_label_timeline.csv']
              .map(file => exists(path.join(versionDir, 'visualization', file)))).then(values => values.every(Boolean)),
            this.moduleEvidenceAvailable(conditionId, defaultVersion),
          ])
          const rawCount = [video, calcium, eegEmg].filter(Boolean).length
          return {
            experimentId: manifest.experimentId || `${String(manifest.mouseId || 'mouse1').toUpperCase()}-${conditionId}`,
            mouseId: manifest.mouseId || 'mouse1',
            condition: conditionId,
            displayName: manifest.displayName || conditionLabel(conditionId),
            collectedAt: stat?.mtime.toISOString() ?? new Date(0).toISOString(),
            completeness: Math.round((rawCount / 3) * 100),
            video, calcium, eegEmg,
            stage: visualization ? 'visualization' : timeline ? 'review' : 'raw_input',
            packages: { rawInput: rawCount > 0, review: timeline, visualization, moduleEvidence },
            resultVersion: defaultVersion,
            executionMode: manifest.executionMode || 'precomputed',
            discovered: true,
            imported: false,
            dataNature: manifest.dataNature || 'unspecified',
          }
        }),
    )
    return experiments.filter(Boolean).sort((a, b) => a.condition.localeCompare(b.condition))
  }

  /* ---------- 处理任务（模拟固定阶段进度） ---------- */

  async createRun(experimentId) {
    const conditionId = await this.resolveConditionId(experimentId)
    const manifest = await this.readManifest(conditionId)
    const run = {
      runId: `run-${crypto.randomBytes(6).toString('hex')}`,
      experimentId: conditionId,
      startedAt: new Date().toISOString(),
      resultVersion: manifest.defaultVersion,
      status: 'running',
    }
    this.runs.set(run.runId, run)
    // 记录任务日志（可审计），失败不影响主流程
    this.enqueueStateWrite(this.runsFile, async () => {
      const history = await readJson(this.runsFile, [])
      history.push(run)
      return history.slice(-500)
    })
    return this.describeRun(run)
  }

  describeRun(run) {
    const elapsedMs = Date.now() - new Date(run.startedAt).getTime()
    if (elapsedMs >= RUN_TOTAL_MS) {
      return {
        runId: run.runId,
        experimentId: run.experimentId,
        status: 'ready',
        progress: 100,
        stage: null,
        resultVersion: run.resultVersion,
        startedAt: run.startedAt,
        elapsedMs,
        nextAction: 'review',
      }
    }
    const stage = RUN_STAGES.find(item => elapsedMs < item.untilMs) ?? RUN_STAGES[RUN_STAGES.length - 1]
    const stageIndex = RUN_STAGES.indexOf(stage)
    const stageStart = stageIndex === 0 ? 0 : RUN_STAGES[stageIndex - 1].untilMs
    const stageProgress = Math.min(1, (elapsedMs - stageStart) / (stage.untilMs - stageStart))
    const prevTotal = stageIndex === 0 ? 0 : RUN_STAGES[stageIndex - 1].untilMs / RUN_TOTAL_MS * 100
    const progress = Math.min(99, Math.floor(prevTotal + stageProgress * ((stage.untilMs - stageStart) / RUN_TOTAL_MS * 100)))
    return {
      runId: run.runId,
      experimentId: run.experimentId,
      status: 'running',
      progress,
      stage: { id: stage.id, label: stage.label, index: stageIndex + 1, total: RUN_STAGES.length },
      resultVersion: run.resultVersion,
      startedAt: run.startedAt,
      elapsedMs,
      nextAction: null,
    }
  }

  async getRun(runId) {
    let run = this.runs.get(runId)
    if (!run) {
      // 重启后从日志恢复任务头信息
      const history = await readJson(this.runsFile, [])
      const record = history.find(item => item.runId === runId)
      if (!record) throw httpError(404, `Unknown run: ${runId}`)
      run = record
      this.runs.set(runId, run)
    }
    return this.describeRun(run)
  }

  /* ---------- 复核数据包 ---------- */

  async readConflictFrames(root) {
    const file = path.join(root, 'review', 'conflicts.csv')
    if (!(await exists(file))) return []
    const { rows } = parseCsvRows(await fs.readFile(file, 'utf8'))
    return rows.map(row => ({
      conflictId: row.conflict_id || null,
      frameId: Number(row.frame_id),
      timestamp: Number(row.timestamp_s),
      conflictType: row.conflict_type || null,
      referenceLabel: row.reference_label || null,
      neuralLabel: row.neural_label || null,
      status: row.status || 'pending',
    })).filter(item => Number.isInteger(item.frameId))
  }

  async getReviewBundle(experimentId, version) {
    const { manifest, conditionId, resultVersion, root } = await this.versionRoot(experimentId, version)
    const [conflicts, reviews, finalized] = await Promise.all([
      this.readConflictFrames(root),
      this.readReviews(conditionId),
      this.getReviewStatus(conditionId),
    ])
    const reviewedFrames = new Set(reviews.map(item => item.frameId))
    const pending = conflicts.filter(item => !reviewedFrames.has(item.frameId))
    const labelVersion = manifest.versions?.[resultVersion]?.labelVersion || 'labels-demo-v1'
    return {
      experimentId: manifest.experimentId,
      conditionId,
      version: resultVersion,
      labelVersion,
      executionMode: manifest.executionMode || 'precomputed',
      pipeline: manifest.pipeline || {},
      files: {
        timeline: 'review/timeline.csv',
        conflicts: 'review/conflicts.csv',
        videoPrediction: 'review/video_prediction.csv',
        neuralPrediction: 'review/neural_prediction.csv',
        sleepStagePrediction: 'review/sleep_stage_prediction.csv',
      },
      conflicts,
      reviewState: {
        savedReviews: reviews.length,
        conflictTotal: conflicts.length,
        pendingConflicts: pending.length,
        pendingFrameIds: pending.map(item => item.frameId),
        finalized: finalized.finalized,
      },
    }
  }

  /* ---------- 3D 可视化数据包 ---------- */

  async getVisualizationBundle(experimentId, version) {
    const { manifest, conditionId, resultVersion, root } = await this.versionRoot(experimentId, version)
    const metadata = await readJson(path.join(root, 'visualization', 'metadata.json'), {})
    return {
      experimentId: manifest.experimentId,
      conditionId,
      version: resultVersion,
      labelVersion: manifest.versions?.[resultVersion]?.labelVersion || 'labels-demo-v1',
      executionMode: manifest.executionMode || 'precomputed',
      metadata,
      files: {
        calcium: 'visualization/calcium.csv',
        dynamicEdges: 'visualization/dynamic_edges.csv',
        finalLabelTimeline: 'visualization/final_label_timeline.csv',
        behaviorStats: 'visualization/behavior_stats.json',
        neuronPositions: '_shared/neuron_positions.csv',
      },
    }
  }

  /* ---------- 行为解码贡献 Module（异步任务语义，内部读取预计算归因结果） ----------
   *
   * 接口形态与真实解释模型一致：创建任务 → 轮询状态 → ready 后一次性返回整段结果。
   * 状态按创建后的时间推进（queued → running → ready），ready 时读取
   * versions/<v>/model_output/ 下的预计算文件并做 schema / 神经元 / 时间轴校验。
   */

  moduleOutputRoot(conditionId, version) {
    return path.join(this.experimentsRoot, conditionId, 'versions', version || 'demo-v1', 'model_output')
  }

  /** 三个证据文件齐全且 schemaVersion 合法时才视为可用 */
  async moduleEvidenceAvailable(conditionId, version) {
    try {
      const dir = this.moduleOutputRoot(this.safeConditionId(conditionId), version)
      const [modules, profiles, frames] = await Promise.all([
        readJson(path.join(dir, 'decoder_modules.json')),
        exists(path.join(dir, 'neuron_module_profiles.csv')),
        readJson(path.join(dir, 'module_frame_evidence.json')),
      ])
      return modules?.schemaVersion === '1.0'
        && Array.isArray(modules.modules)
        && profiles === true
        && frames?.schemaVersion === '1.0'
        && Array.isArray(frames.frames)
    } catch {
      return false
    }
  }

  async readModuleEvidence(conditionId, version) {
    const dir = this.moduleOutputRoot(conditionId, version)
    const [modulesRaw, profilesText, framesRaw] = await Promise.all([
      fs.readFile(path.join(dir, 'decoder_modules.json'), 'utf8'),
      fs.readFile(path.join(dir, 'neuron_module_profiles.csv'), 'utf8'),
      fs.readFile(path.join(dir, 'module_frame_evidence.json'), 'utf8'),
    ])
    const modulesDoc = JSON.parse(modulesRaw)
    const framesDoc = JSON.parse(framesRaw)

    /* schema 校验：不合法视为数据包损坏，明确 422 */
    const problems = []
    if (modulesDoc.schemaVersion !== '1.0') problems.push('decoder_modules.schemaVersion')
    if (!Array.isArray(modulesDoc.modules) || !modulesDoc.modules.length) problems.push('decoder_modules.modules')
    if (framesDoc.schemaVersion !== '1.0') problems.push('module_frame_evidence.schemaVersion')
    if (!Array.isArray(framesDoc.frames) || !framesDoc.frames.length) problems.push('module_frame_evidence.frames')
    if (problems.length) throw httpError(422, `Module 数据包 schema 校验失败: ${problems.join(', ')}`)

    /* 成员与 profile 中的神经元必须存在于神经元位置文件 */
    const positionsText = await fs.readFile(path.join(this.sharedRoot, 'neuron_positions.csv'), 'utf8')
    const validIds = new Set()
    parseCsvRows(positionsText).rows.forEach(row => {
      if (row.neuron_id) validIds.add(`n${row.neuron_id}`)
      if (row.neuron_name) validIds.add(row.neuron_name)
    })
    for (const module of modulesDoc.modules) {
      if (!module.id || !module.name || !['behavior', 'sleep'].includes(module.kind) || typeof module.targetLabel !== 'string') {
        throw httpError(422, `Module 定义字段非法: ${JSON.stringify(module.id ?? module)}`)
      }
      for (const neuronId of module.memberNeuronIds ?? []) {
        if (!validIds.has(neuronId)) throw httpError(422, `Module ${module.id} 引用了未知神经元: ${neuronId}`)
      }
    }

    const profileRows = parseCsvRows(profilesText).rows
    const neuronProfiles = profileRows.map(row => ({
      neuronId: row.neuron_id,
      primaryModuleId: row.primary_module_id || null,
      primaryTargetLabel: row.target_label || null,
      membershipScore: row.membership_score === '' || row.membership_score == null ? null : Number(row.membership_score),
    })).filter(item => item.neuronId && validIds.has(item.neuronId))

    /* frameId / 时间戳必须与人复核时间轴一一对应 */
    const timelineText = await fs.readFile(path.join(dir, '..', 'review', 'timeline.csv'), 'utf8')
    const timelineRows = parseCsvRows(timelineText).rows
    if (framesDoc.frames.length !== timelineRows.length) {
      throw httpError(422, `Module 证据帧数 (${framesDoc.frames.length}) 与时间轴 (${timelineRows.length}) 不一致`)
    }
    const frames = framesDoc.frames.map((frame, index) => {
      const stamp = Number(timelineRows[index]?.timestamp_s)
      if (!Number.isInteger(frame.frameId) || frame.frameId !== index || !Number.isFinite(Number(frame.timestamp))) {
        throw httpError(422, `Module 证据 frameId 不连续: index=${index}`)
      }
      if (Number.isFinite(stamp) && Math.abs(Number(frame.timestamp) - stamp) > 0.26) {
        throw httpError(422, `Module 证据第 ${index} 帧时间戳与时间轴不一致`)
      }
      return {
        frameId: frame.frameId,
        timestamp: Number(frame.timestamp),
        targetLabel: String(frame.targetLabel ?? ''),
        predictedLabel: String(frame.predictedLabel ?? ''),
        confidence: frame.confidence == null ? null : Number(frame.confidence),
        moduleId: frame.moduleId ?? null,
        moduleScore: frame.moduleScore == null ? null : Number(frame.moduleScore),
        topNeurons: Array.isArray(frame.topNeurons)
          ? frame.topNeurons.map(item => ({ neuronId: String(item.neuronId), contribution: Number(item.contribution) }))
          : [],
      }
    })

    return {
      model: {
        name: modulesDoc.modelName || 'MouseNeuralBehaviorDecoder',
        version: modulesDoc.modelVersion || 'demo-1.0',
      },
      method: modulesDoc.method || 'precomputed_attribution',
      modules: modulesDoc.modules.map(module => ({
        id: String(module.id),
        name: String(module.name),
        kind: module.kind,
        targetLabel: module.targetLabel,
        memberCount: Array.isArray(module.memberNeuronIds) ? module.memberNeuronIds.length : 0,
        memberNeuronIds: Array.isArray(module.memberNeuronIds) ? module.memberNeuronIds.map(String) : [],
        color: typeof module.color === 'string' ? module.color : '#8b5cf6',
      })),
      neuronProfiles,
      frames,
    }
  }

  async createModuleJob(input) {
    const rawId = input?.experimentId || input?.conditionId
    if (!rawId) throw httpError(400, 'experimentId or conditionId is required')
    const conditionId = await this.resolveConditionId(rawId)
    const manifest = await this.readManifest(conditionId)
    const resultVersion = input?.version || manifest.defaultVersion
    if (!manifest.versions?.[resultVersion]) throw httpError(404, `Unknown result version: ${resultVersion}`)
    if (!(await this.moduleEvidenceAvailable(conditionId, resultVersion))) {
      throw httpError(404, `该 Condition 没有预计算的 Module 贡献数据: ${conditionId}`)
    }
    const job = {
      jobId: `MOD-${conditionId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      experimentId: manifest.experimentId || conditionId,
      conditionId,
      resultVersion,
      createdAt: Date.now(),
    }
    this.moduleJobs.set(job.jobId, job)
    return { ...this.describeModuleJob(job), model: { name: 'MouseNeuralBehaviorDecoder', version: 'demo-1.0' } }
  }

  describeModuleJob(job) {
    const elapsed = Date.now() - job.createdAt
    if (elapsed < 300) return { jobId: job.jobId, status: 'queued', progress: 10, conditionId: job.conditionId }
    if (elapsed < 900) return { jobId: job.jobId, status: 'running', progress: 60, conditionId: job.conditionId }
    return { jobId: job.jobId, status: 'ready', progress: 100, conditionId: job.conditionId }
  }

  async getModuleJob(jobId) {
    const job = this.moduleJobs.get(String(jobId || ''))
    if (!job) throw httpError(404, `Unknown module job: ${jobId}`)
    const state = this.describeModuleJob(job)
    if (state.status !== 'ready') return state
    // ready 时读取并校验预计算结果；数据损坏返回 422 而不是伪装成功
    const result = await this.readModuleEvidence(job.conditionId, job.resultVersion)
    return { ...state, result }
  }

  /* ---------- 复核定稿 ---------- */

  async getReviewStatus(experimentId) {
    const conditionId = await this.resolveConditionId(experimentId)
    const all = await readJson(this.finalizedFile, [])
    return all.find(item => item.conditionId === conditionId || item.experimentId === experimentId)
      || { conditionId, finalized: false, analysisReady: false }
  }

  async finalizeReview(experimentId, reviewer) {
    const { manifest, conditionId, resultVersion, root } = await this.versionRoot(experimentId)
    const [conflicts, reviews] = await Promise.all([
      this.readConflictFrames(root),
      this.readReviews(conditionId),
    ])
    const reviewedFrames = new Set(reviews.map(item => item.frameId))
    const pending = conflicts.filter(item => !reviewedFrames.has(item.frameId))
    if (pending.length) {
      throw httpError(409, `仍有 ${pending.length} 个预定冲突未完成复核`)
    }
    const labelVersion = manifest.versions?.[resultVersion]?.labelVersion || 'labels-demo-v1'
    const record = {
      conditionId,
      experimentId: manifest.experimentId,
      finalized: true,
      finalizedAt: new Date().toISOString(),
      reviewer: reviewer || 'unknown',
      resultVersion,
      labelVersion,
      visualizationVersion: resultVersion,
      analysisReady: true,
    }
    await this.enqueueStateWrite(this.finalizedFile, async () => {
      const all = await readJson(this.finalizedFile, [])
      const rest = all.filter(item => item.conditionId !== conditionId)
      rest.push(record)
      return rest
    })
    return {
      finalized: true,
      labelVersion,
      visualizationVersion: resultVersion,
      analysisReady: true,
    }
  }

  /* ---------- 科研分析（只做校验/排序/匹配/schema 校验，不做计算） ---------- */

  /** 预计算分析文件名使用短键：cort_like → cort，ketamine_like_recovery → recovery */
  analysisFileFor(conditionIds) {
    const FILE_KEY = { healthy: 'healthy', cort_like: 'cort', ketamine_like_recovery: 'recovery' }
    const ordered = CANONICAL_CONDITION_ORDER.filter(id => conditionIds.includes(id))
    if (ordered.length !== conditionIds.length) return null // 存在未知 condition
    if (ordered.length === 1) return `${ordered[0]}.json`
    if (ordered.length === 2) return `compare_${FILE_KEY[ordered[0]]}_${FILE_KEY[ordered[1]]}.json`
    return 'compare_3.json'
  }

  validateAnalysisSchema(analysis, analysisId) {
    const problems = []
    if (analysis?.schemaVersion !== '1.0') problems.push('schemaVersion')
    if (typeof analysis?.analysisId !== 'string') problems.push('analysisId')
    if (!Array.isArray(analysis?.conditions) || !analysis.conditions.length) problems.push('conditions')
    if (analysis?.analysisId !== analysisId) problems.push('analysisId mismatch')
    if (analysis && typeof analysis.metrics !== 'object') problems.push('metrics')
    if (problems.length) throw httpError(500, `预计算分析文件 schema 校验失败: ${problems.join(', ')}`)
  }

  async getAnalysisBundle(conditionIds, _version) {
    if (!Array.isArray(conditionIds) || !conditionIds.length) throw httpError(400, 'conditions is required')
    const unique = [...new Set(conditionIds.map(id => this.safeConditionId(id)))].sort()
    if (unique.length > CANONICAL_CONDITION_ORDER.length) throw httpError(400, 'too many conditions')
    const file = this.analysisFileFor(unique)
    if (!file) throw httpError(400, `未知 Condition 组合: ${unique.join(', ')}`)
    const analysisId = file.replace(/\.json$/, '')
    const target = path.join(this.analysesRoot, file)
    if (!(await exists(target))) throw httpError(404, `该 Condition 组合没有预计算分析结果: ${unique.join(', ')}`)
    const analysis = await readJson(target)
    this.validateAnalysisSchema(analysis, analysisId)
    return analysis
  }

  /* ---------- 报告任务（预生成文件 + 固定模拟生成进度） ---------- */

  reportKeyFor(conditionIds) {
    if (conditionIds.length >= 3) return 'compare_3'
    if (conditionIds.length === 2) return 'compare_2'
    return conditionIds[0]
  }

  async createReport({ conditionIds, evidenceIds }) {
    if (!Array.isArray(conditionIds) || !conditionIds.length) throw httpError(400, 'conditionIds is required')
    const unique = [...new Set(conditionIds.map(id => this.safeConditionId(id)))].sort()
    for (const id of unique) {
      if (!(await this.experimentExists(id))) throw httpError(400, `未知 Condition: ${id}`)
    }
    if (evidenceIds !== undefined && !Array.isArray(evidenceIds)) throw httpError(400, 'evidenceIds must be an array')
    const key = this.reportKeyFor(unique)
    const sourceFile = `${key}.md`
    const sourcePath = path.join(this.reportsRoot, sourceFile)
    if (!(await exists(sourcePath))) {
      throw httpError(404, '该 Condition 组合没有预生成报告')
    }
    const selectedEvidence = Array.isArray(evidenceIds) ? [...new Set(evidenceIds)] : []
    const selectedLabels = selectedEvidence.map(id => REPORT_EVIDENCE[id]?.title).filter(Boolean)
    const source = await fs.readFile(sourcePath, 'utf8')
    const reportInfo = [
      '',
      '## 报告信息',
      '',
      `- 比较条件数：${unique.length}`,
      `- 纳入图表证据：${selectedLabels.length ? selectedLabels.join('、') : '未单独勾选图表，仅生成基础章节'}`,
      `- 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      '',
    ].join('\n')
    const reportId = `report-${key}`
    const generatedName = `generated-${key}.md`
    const reportBody = source.replace(/\n## /, `${reportInfo}\n## `).trimEnd()
    const generatedReport = `${reportBody}\n\n${buildEvidenceChapter(selectedEvidence)}\n`
    await fs.writeFile(path.join(this.reportsRoot, generatedName), generatedReport, 'utf8')
    const task = {
      reportId,
      status: 'ready',
      conditionIds: unique,
      evidenceIds: selectedEvidence,
      artifactId: `report.${generatedName.replace(/\.md$/, '')}`,
      url: `/api/artifacts/report.${generatedName.replace(/\.md$/, '')}`,
      createdAt: new Date().toISOString(),
      // executionMode 元数据：预计算文件直接就绪；真实模型接入后此处改为固定模拟进度
      executionMode: 'precomputed',
    }
    this.reportTasks.set(reportId, task)
    this.enqueueStateWrite(this.reportsStateFile, async () => {
      const all = await readJson(this.reportsStateFile, [])
      return [...all.filter(item => item.reportId !== reportId), task].slice(-200)
    })
    return { id: task.reportId, status: task.status, url: task.url }
  }

  async getReport(reportId) {
    let task = this.reportTasks.get(reportId)
    if (!task) {
      const all = await readJson(this.reportsStateFile, [])
      task = all.find(item => item.reportId === reportId || item.id === reportId)
      if (task) this.reportTasks.set(reportId, task)
    }
    if (!task) throw httpError(404, `Unknown report: ${reportId}`)
    return { id: task.reportId, status: task.status, url: task.url, artifactId: task.artifactId, conditionIds: task.conditionIds }
  }

  /* ---------- Artifact 解析（manifest 映射 + 路径穿越防护） ---------- */

  async resolveArtifact(artifactId) {
    if (typeof artifactId !== 'string' || artifactId.length > 256 || artifactId.includes('..')) {
      throw httpError(400, 'Invalid artifact id')
    }
    const segments = artifactId.split('.')
    if (segments.length < 2 || segments.some(seg => !artifactKeyPattern.test(seg))) {
      throw httpError(400, 'Invalid artifact id')
    }
    const scope = segments[0]
    const name = segments.slice(1).join('.')

    if (scope === 'report') {
      const file = `${name}.md`
      const target = path.resolve(this.reportsRoot, file)
      if (path.dirname(target) !== path.resolve(this.reportsRoot)) throw httpError(400, 'Invalid artifact id')
      if (!(await exists(target))) throw httpError(404, `Artifact not found: ${artifactId}`)
      return target
    }

    const manifestDir = scope === 'shared'
      ? this.sharedRoot
      : path.join(this.experimentsRoot, this.safeConditionId(scope))
    const manifest = await readJson(path.join(manifestDir, 'manifest.json'))
    if (!manifest) throw httpError(404, `Unknown artifact scope: ${scope}`)
    const rel = manifest.artifacts?.[name] ?? manifest.artifacts?.[`${scope}.${name}`]
    if (!rel) throw httpError(404, `Unknown artifact: ${artifactId}`)
    const target = path.resolve(manifestDir, rel)
    const rootWithSep = path.resolve(manifestDir) + path.sep
    if (!target.startsWith(rootWithSep)) throw httpError(400, 'Artifact path escapes its root')
    if (!(await exists(target))) throw httpError(404, `Artifact file missing: ${artifactId}`)
    return target
  }

  /* ---------- 人工复核记录（新存储结构，便于未来迁移数据库） ---------- */

  /** 旧结构记录（无 resultVersion 字段）迁移为新结构，幂等 */
  async migrateLegacyReviews() {
    const current = await readJson(this.reviewsFile, [])
    if (!Array.isArray(current) || !current.some(item => item && typeof item === 'object' && !item.resultVersion)) return
    const upgraded = []
    for (const item of current) {
      if (item.resultVersion || !item.experimentId) { upgraded.push(item); continue }
      const conditionId = item.conditionId
        || String(item.experimentId).split('-').slice(1).join('-')
        || String(item.experimentId)
      const manifest = await readJson(path.join(this.experimentsRoot, conditionId, 'manifest.json'))
      upgraded.push({
        experimentId: item.experimentId,
        conditionId: manifest?.conditionId || conditionId,
        frameId: item.frameId,
        originalLabel: item.originalLabel ?? await this.findOriginalLabel(conditionId, item.frameId),
        finalLabel: item.finalLabel,
        reason: item.reason || 'manual-review',
        reviewer: item.reviewer || 'admin',
        resultVersion: manifest?.defaultVersion || 'demo-v1',
        updatedAt: item.updatedAt || new Date(0).toISOString(),
      })
    }
    await this.enqueueStateWrite(this.reviewsFile, async () => upgraded)
  }

  /** experimentId（MOUSE1-healthy）与 conditionId（healthy）两种形式均可 */
  async readReviews(experimentId) {
    await this.migrateLegacyReviews()
    const all = await readJson(this.reviewsFile, [])
    if (!experimentId) return all
    return all.filter(item => item.experimentId === experimentId || item.conditionId === experimentId)
  }

  async findOriginalLabel(conditionId, frameId) {
    try {
      const manifest = await this.readManifest(conditionId)
      const root = path.join(this.experimentsRoot, conditionId, 'versions', manifest.defaultVersion)
      const { rows } = parseCsvRows(await fs.readFile(path.join(root, 'review', 'timeline.csv'), 'utf8'))
      const row = rows.find(item => Number(item.frame_id) === frameId)
      return row?.final_behavior || row?.video_behavior || row?.neural_behavior || null
    } catch {
      return null
    }
  }

  async saveReview({ experimentId, frameId, finalLabel, reason }) {
    const conditionId = await this.resolveConditionId(experimentId)
    if (!Number.isInteger(frameId)) throw httpError(400, 'integer frameId is required')
    if (typeof finalLabel !== 'string' || !finalLabel.trim()) throw httpError(400, 'finalLabel is required')
    const manifest = await this.readManifest(conditionId)
    const record = {
      experimentId: manifest.experimentId,
      conditionId,
      frameId,
      originalLabel: await this.findOriginalLabel(conditionId, frameId),
      finalLabel: finalLabel.trim(),
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'manual-review',
      reviewer: 'admin', // 当前为单账号系统；接入多用户后取会话用户
      resultVersion: manifest.defaultVersion,
      updatedAt: new Date().toISOString(),
    }
    await this.enqueueStateWrite(this.reviewsFile, async () => {
      const current = await readJson(this.reviewsFile, [])
      const next = current.filter(item => !(item.experimentId === record.experimentId && item.frameId === frameId))
      next.push(record)
      return next
    })
    return { saved: true, transport: 'backend', review: record }
  }

  /** 串行化 state 文件写入，避免并发覆盖 */
  enqueueStateWrite(file, producer) {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(this.stateRoot, { recursive: true })
      const next = await producer()
      await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
    })
    return this.writeQueue
  }
}

async function readManifestSafe(target) {
  return readJson(target)
}
