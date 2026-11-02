import { PipelineProvider } from './PipelineProvider.mjs'
import { httpError } from './PrecomputedPipelineProvider.mjs'

/**
 * ModelPipelineProvider —— 未来真实模型接入占位。
 *
 * 接入后由本类负责调用真实推理服务（视频行为识别 / STFS 钙信号解码 / 睡眠分期），
 * 接口签名与 PrecomputedPipelineProvider 完全一致，路由层与前端无需任何改动。
 * 当前默认未启用；设置 MINDBRIDGE_PIPELINE_PROVIDER=model 时实例化，
 * 在实现完成前会明确报错而不是静默降级。
 */
export class ModelPipelineProvider extends PipelineProvider {
  constructor(config) {
    super()
    this.config = config
  }

  notReady() {
    throw httpError(503, 'ModelPipelineProvider 尚未接入真实模型服务，请使用 PrecomputedPipelineProvider（预计算模式）')
  }

  async listExperiments() { return this.notReady() }
  async createRun() { return this.notReady() }
  async getRun() { return this.notReady() }
  async getReviewBundle() { return this.notReady() }
  async getVisualizationBundle() { return this.notReady() }
  async finalizeReview() { return this.notReady() }
  async getReviewStatus() { return this.notReady() }
  async getAnalysisBundle() { return this.notReady() }
  async createReport() { return this.notReady() }
  async getReport() { return this.notReady() }
  async resolveArtifact() { return this.notReady() }
  async readReviews() { return this.notReady() }
  async saveReview() { return this.notReady() }
  async createModuleJob() { return this.notReady() }
  async getModuleJob() { return this.notReady() }
  async moduleEvidenceAvailable() { return this.notReady() }
}
