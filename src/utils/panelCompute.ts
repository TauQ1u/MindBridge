import { numericNeuronSort } from '@neuron3d/neuron/neuronUtils'
import type { NeuronFrame } from '@neuron3d/neuron/neuronUtils'

/*
 * 单条件数据面板的确定性派生计算。
 * 同一数据必然得到同一结果，仅在展示层使用：
 * - PCA（均值中心化 + 协方差 Jacobi 特征分解，取前 2 主成分）
 * - 神经元 × 神经元功能相关矩阵（Pearson，按神经元编号排序）
 */

export interface PcaResult {
  /** 每帧投影坐标，与输入帧顺序一致 */
  points: Array<{ x: number; y: number }>
  /** PC1 / PC2 方差解释率 */
  explained: [number, number]
  methodLabel: string
}

export interface CorrelationResult {
  /** 排序后的神经元 id（按神经元编号） */
  ids: string[]
  /** 每个模块在排序后序列中的起始下标（画边界线用；无模块划分，恒为空） */
  boundaries: number[]
  /** ids.length × ids.length 的 Pearson 相关矩阵 */
  matrix: number[][]
  methodLabel: string
}

function activityColumns(frames: NeuronFrame[], ids: string[]) {
  const frameCount = frames.length
  const columns = ids.map((id) => {
    const values = new Float64Array(frameCount)
    for (let i = 0; i < frameCount; i += 1) {
      const value = frames[i].values[id]
      values[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    return values
  })
  return { frameCount, columns }
}

/** 对称矩阵 Jacobi 特征分解，返回按特征值降序的前 topK 个特征向量 */
function jacobiEigen(matrix: number[][], topK: number) {
  const n = matrix.length
  const a = matrix.map((row) => row.slice())
  const vectors: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  )

  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) off += a[p][q] * a[p][q]
    }
    if (off < 1e-12) break

    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(a[p][q]) < 1e-14) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c

        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = vectors[k][p]
          const vkq = vectors[k][q]
          vectors[k][p] = c * vkp - s * vkq
          vectors[k][q] = s * vkp + c * vkq
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i)
    .sort((i, j) => a[j][j] - a[i][i])
    .slice(0, topK)

  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => vectors.map((row) => row[i])),
  }
}

/** PCA：把每帧的多神经元整体活动压缩到二维平面 */
export function computePca(frames: NeuronFrame[], ids: string[]): PcaResult {
  const frameCount = frames.length
  const dim = ids.length
  const empty: PcaResult = { points: [], explained: [0, 0], methodLabel: 'PCA · 均值中心化 + 协方差特征分解' }

  if (frameCount === 0 || dim === 0) return empty

  const { columns } = activityColumns(frames, ids)

  const means = columns.map((col) => {
    let sum = 0
    for (let i = 0; i < frameCount; i += 1) sum += col[i]
    return sum / frameCount
  })

  const centered = columns.map((col, j) => {
    const mean = means[j]
    const row = new Float64Array(frameCount)
    for (let i = 0; i < frameCount; i += 1) row[i] = col[i] - mean
    return row
  })

  const covariance: number[][] = Array.from({ length: dim }, (_, p) =>
    Array.from({ length: dim }, (_, q) => {
      let sum = 0
      const cp = centered[p]
      const cq = centered[q]
      for (let i = 0; i < frameCount; i += 1) sum += cp[i] * cq[i]
      return sum / frameCount
    }),
  )

  const totalVariance = covariance.reduce((sum, row, i) => sum + row[i], 0)
  const { values, vectors } = jacobiEigen(covariance, 2)
  if (!vectors.length) return empty

  const points = Array.from({ length: frameCount }, (_, i) => ({
    x: centered.reduce((sum, col, j) => sum + col[i] * vectors[0][j], 0),
    y: vectors[1] ? centered.reduce((sum, col, j) => sum + col[i] * vectors[1][j], 0) : 0,
  }))

  const safeTotal = Math.max(totalVariance, 1e-12)
  return {
    points,
    explained: [Math.max(values[0] ?? 0, 0) / safeTotal, Math.max(values[1] ?? 0, 0) / safeTotal],
    methodLabel: empty.methodLabel,
  }
}

/**
 * 神经元 × 神经元功能相关矩阵：
 * 对全程 ΔF/F 序列做两两 Pearson 相关，行/列按神经元编号排序。
 * 红线：这是活动相关网络，不是解剖 / 突触连接。
 */
export function computeCorrelationMatrix(
  frames: NeuronFrame[],
): CorrelationResult {
  const empty: CorrelationResult = { ids: [], boundaries: [], matrix: [], methodLabel: 'Pearson 相关 · 全程 ΔF/F' }
  const frameCount = frames.length
  if (frameCount === 0) return empty

  const sortedIds = (frames[0] ? Object.keys(frames[0].values) : []).sort(numericNeuronSort)
  const n = sortedIds.length
  if (n === 0) return empty

  const { columns } = activityColumns(frames, sortedIds)
  const means = new Array<number>(n).fill(0)
  for (let j = 0; j < n; j += 1) {
    let sum = 0
    const col = columns[j]
    for (let i = 0; i < frameCount; i += 1) sum += col[i]
    means[j] = sum / frameCount
  }

  const stds = new Array<number>(n).fill(0)
  for (let j = 0; j < n; j += 1) {
    const mean = means[j]
    const col = columns[j]
    let sum = 0
    for (let i = 0; i < frameCount; i += 1) {
      const d = col[i] - mean
      sum += d * d
    }
    stds[j] = Math.sqrt(sum / frameCount)
  }

  const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let a = 0; a < n; a += 1) {
    matrix[a][a] = 1
    const ca = columns[a]
    const ma = means[a]
    for (let b = a + 1; b < n; b += 1) {
      const denom = stds[a] * stds[b]
      if (denom < 1e-12) continue
      const cb = columns[b]
      const mb = means[b]
      let sum = 0
      for (let i = 0; i < frameCount; i += 1) sum += (ca[i] - ma) * (cb[i] - mb)
      const value = sum / frameCount / denom
      matrix[a][b] = value
      matrix[b][a] = value
    }
  }

  return { ids: sortedIds, boundaries: [], matrix, methodLabel: empty.methodLabel }
}
