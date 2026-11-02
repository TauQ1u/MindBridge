/**
 * PipelineProvider —— 流水线统一抽象。
 *
 * 前端与路由层只依赖本接口；当前使用 PrecomputedPipelineProvider（读取预置结果），
 * 未来接入真实模型时切换为 ModelPipelineProvider，API 路由与前端保持不变。
 */
export class PipelineProvider {
  /** 列出全部实验（数据源发现） */
  async listExperiments() { throw new Error('not implemented') }

  /** 创建处理任务，返回 run 记录 */
  async createRun(experimentId) { throw new Error('not implemented') }

  /** 查询任务状态/进度 */
  async getRun(runId) { throw new Error('not implemented') }

  /** 获取复核数据包（元信息 + 冲突清单 + 文件清单） */
  async getReviewBundle(experimentId, version) { throw new Error('not implemented') }

  /** 获取 3D 可视化数据包（元信息 + 文件清单） */
  async getVisualizationBundle(experimentId, version) { throw new Error('not implemented') }

  /** 复核定稿：检查冲突处理状态并绑定结果版本 */
  async finalizeReview(experimentId, reviewer) { throw new Error('not implemented') }

  /** 复核定稿状态查询 */
  async getReviewStatus(experimentId) { throw new Error('not implemented') }

  /** 获取科研分析结果（多 Condition 组合） */
  async getAnalysisBundle(conditionIds, version) { throw new Error('not implemented') }

  /** 创建报告任务 */
  async createReport(input) { throw new Error('not implemented') }

  /** 查询报告任务 */
  async getReport(reportId) { throw new Error('not implemented') }

  /** 将 artifactId 解析为安全文件路径（manifest 映射，拒绝路径穿越） */
  async resolveArtifact(artifactId) { throw new Error('not implemented') }

  /** 读取某实验的全部人工复核记录 */
  async readReviews(experimentId) { throw new Error('not implemented') }

  /** 保存一条人工复核记录 */
  async saveReview(input) { throw new Error('not implemented') }

  /** 创建行为解码贡献 Module 任务（异步任务语义，内部读取预计算归因结果） */
  async createModuleJob(input) { throw new Error('not implemented') }

  /** 查询 Module 任务状态；ready 时返回完整预计算结果 */
  async getModuleJob(jobId) { throw new Error('not implemented') }

  /** 判断某 Condition 是否具备完整的 Module 证据数据包 */
  async moduleEvidenceAvailable(conditionId) { throw new Error('not implemented') }
}
