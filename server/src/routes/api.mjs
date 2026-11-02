import { Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 业务 API 路由：全部委托给 PipelineProvider，
 * 切换 Provider 实现（预计算 → 真实模型）时本文件不变。
 */
export function createApiRouter(provider) {
  const router = Router()

  /* ---- 实验发现 ---- */
  router.get('/experiments', async (_req, res, next) => {
    try { res.json(await provider.listExperiments()) } catch (error) { next(error) }
  })

  router.get('/experiments/:experimentId/manifest', async (req, res, next) => {
    try {
      const conditionId = provider.safeConditionId(req.params.experimentId)
      const manifest = await provider.readManifest(conditionId)
      res.json(manifest)
    } catch (error) { next(error) }
  })

  /* ---- 处理任务（接口形态与真实模型任务一致，内部为固定阶段模拟） ---- */
  router.post('/experiments/:experimentId/runs', async (req, res, next) => {
    try { res.status(201).json(await provider.createRun(req.params.experimentId)) } catch (error) { next(error) }
  })

  router.get('/runs/:runId', async (req, res, next) => {
    try { res.json(await provider.getRun(req.params.runId)) } catch (error) { next(error) }
  })

  /* ---- 复核数据包与定稿 ---- */
  router.get('/experiments/:experimentId/review-bundle', async (req, res, next) => {
    try {
      res.json(await provider.getReviewBundle(req.params.experimentId, req.query.version))
    } catch (error) { next(error) }
  })

  router.get('/experiments/:experimentId/visualization-bundle', async (req, res, next) => {
    try {
      res.json(await provider.getVisualizationBundle(req.params.experimentId, req.query.version))
    } catch (error) { next(error) }
  })

  router.get('/experiments/:experimentId/review-status', async (req, res, next) => {
    try { res.json(await provider.getReviewStatus(req.params.experimentId)) } catch (error) { next(error) }
  })

  router.post('/experiments/:experimentId/review/finalize', async (req, res, next) => {
    try {
      res.json(await provider.finalizeReview(req.params.experimentId, req.session?.user))
    } catch (error) { next(error) }
  })

  /* ---- 人工复核记录（兼容旧前端字段，存储为新结构） ---- */
  router.get('/reviews', async (req, res, next) => {
    try {
      const experimentId = String(req.query.experimentId || '')
      res.json(await provider.readReviews(experimentId))
    } catch (error) { next(error) }
  })

  router.post('/reviews', async (req, res, next) => {
    try {
      const { experimentId, frameId, finalLabel, reason } = req.body || {}
      const result = await provider.saveReview({ experimentId, frameId, finalLabel, reason })
      res.status(201).json({ saved: result.saved, transport: result.transport })
    } catch (error) { next(error) }
  })

  /* ---- 科研分析：仅校验/排序/匹配/schema 校验，不做任何计算 ---- */
  router.get('/analysis', async (req, res, next) => {
    try {
      const conditions = String(req.query.conditions || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
      res.json(await provider.getAnalysisBundle(conditions, req.query.version))
    } catch (error) { next(error) }
  })

  /* ---- 报告任务 ---- */
  router.post('/reports', async (req, res, next) => {
    try {
      const { conditionIds, evidenceIds } = req.body || {}
      res.status(201).json(await provider.createReport({ conditionIds, evidenceIds }))
    } catch (error) { next(error) }
  })

  router.get('/reports/:reportId', async (req, res, next) => {
    try { res.json(await provider.getReport(req.params.reportId)) } catch (error) { next(error) }
  })

  /* ---- 行为解码贡献 Module：异步任务语义，ready 后一次性返回整段预计算结果 ---- */
  router.post('/ai/module-jobs', async (req, res, next) => {
    try {
      const job = await provider.createModuleJob(req.body || {})
      res.status(202).json(job)
    } catch (error) { next(error) }
  })

  router.get('/ai/module-jobs/:jobId', async (req, res, next) => {
    try { res.json(await provider.getModuleJob(req.params.jobId)) } catch (error) { next(error) }
  })

  /* ---- Artifact 下载：manifest 映射，前端不感知服务器目录 ---- */
  router.get('/artifacts/:artifactId', async (req, res, next) => {
    try {
      const target = await provider.resolveArtifact(req.params.artifactId)
      res.setHeader('Cache-Control', 'no-store')
      res.sendFile(target)
    } catch (error) { next(error) }
  })

  return router
}

/**
 * 旧版 /data 静态路径兼容别名（已废弃，保留以保证旧前端代码可用）。
 * 新代码请使用 GET /api/artifacts/:artifactId。
 */
const conditionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function createLegacyDataAlias({ dataRoot }) {
  const experimentsRoot = path.join(dataRoot, 'experiments')
  const reportsRoot = path.join(dataRoot, 'reports')
  const RESULT_VERSION = 'demo-v1'

  const mappings = [
    { regex: /^\/raw_input\/([^/]+)\/([^/]+)$/, resolve: (c, f) => path.join(experimentsRoot, c, 'raw', f) },
    { regex: /^\/review\/manifest\.json$/, resolve: () => path.join(experimentsRoot, '_shared', 'review_manifest.json') },
    { regex: /^\/review\/([^/]+)\/([^/]+)$/, resolve: (c, f) => path.join(experimentsRoot, c, 'versions', RESULT_VERSION, 'review', f) },
    { regex: /^\/visualization_input\/([^/]+)\/([^/]+)$/, resolve: (c, f) => path.join(experimentsRoot, c, 'versions', RESULT_VERSION, 'visualization', f) },
    { regex: /^\/visualization_input\/([^/]+)$/, resolve: f => path.join(experimentsRoot, '_shared', f) },
    { regex: /^\/model_output\/([^/]+)\/([^/]+)$/, resolve: (c, f) => path.join(experimentsRoot, c, 'versions', RESULT_VERSION, 'model_output', f) },
    { regex: /^\/reports\/([^/]+)$/, resolve: f => path.join(reportsRoot, f) },
  ]

  return async function legacyDataAlias(req, res, next) {
    if (req.method !== 'GET') return next()
    const route = mappings.find(item => item.regex.test(req.path))
    if (!route) return next()
    const match = req.path.match(route.regex)
    const params = match.slice(1)
    if (params.some(value => !fileNamePattern.test(value))) return res.status(400).json({ error: 'Invalid path' })
    if (params.length === 2 && !conditionPattern.test(params[0])) return res.status(400).json({ error: 'Invalid path' })
    const target = path.resolve(route.resolve(...params))
    const inside = [experimentsRoot, reportsRoot].some(root => {
      const rootWithSep = path.resolve(root) + path.sep
      return target.startsWith(rootWithSep)
    })
    if (!inside) return res.status(400).json({ error: 'Invalid path' })
    try {
      await fs.access(target)
    } catch {
      return res.status(404).json({ error: 'Not found' })
    }
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(target)
  }
}
