import { PrecomputedPipelineProvider } from './PrecomputedPipelineProvider.mjs'
import { ModelPipelineProvider } from './ModelPipelineProvider.mjs'

/**
 * Provider 装配点：切换实现只改这里，API 路由与前端不变。
 *
 *   MINDBRIDGE_PIPELINE_PROVIDER=precomputed（默认）→ 读取预置结果
 *   MINDBRIDGE_PIPELINE_PROVIDER=model              → 真实模型服务（接入中）
 */
export function createPipelineProvider(config) {
  const kind = process.env.MINDBRIDGE_PIPELINE_PROVIDER || 'precomputed'
  if (kind === 'model') return new ModelPipelineProvider(config)
  return new PrecomputedPipelineProvider(config)
}

export { PipelineProvider } from './PipelineProvider.mjs'
export { PrecomputedPipelineProvider } from './PrecomputedPipelineProvider.mjs'
export { ModelPipelineProvider } from './ModelPipelineProvider.mjs'
