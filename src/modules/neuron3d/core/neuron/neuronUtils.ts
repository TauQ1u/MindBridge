import * as THREE from 'three'
import Papa from 'papaparse'

/*
 * 神经元核心逻辑模块。
 *
 * 本文件中的配色、尺寸、连接动画、播放与解析逻辑
 * 为系统核心逻辑；当前已适配 Nerous_Data 真实数据格式：
 * - 位置：真实 2D ROI 中心坐标（x_norm / y_norm）+
 *   功能纵深 z_norm（谱嵌入坐标，非解剖深度），三维建模；
 * - 连接：按 frame 列分帧，weight 映射连线不透明度；
 * - 活动：calcium.csv（frame_idx,time_seconds,n1..nN）；
 * - 标签：final_label_timeline.csv（behavior / sleep_stage）。
 */

export interface NeuronFrame {
  stamp: string
  behavior: string
  /** 睡眠阶段：W / NREM / REM / MA（无标签数据时为空串） */
  sleepStage: string
  /** 拼接缝标记：true 表示人工拼接点，非生理转移 */
  seamBefore: boolean
  values: Record<string, number | null>
}

export interface Edge {
  source: string
  target: string
  /** 连接强度 |correlation|，映射连线不透明度 */
  weight: number
}

export type EdgeFrames = Edge[][]

export interface NeuronPosition {
  neuronId: string
  neuronName: string
  x: number
  y: number
  /** 功能纵深（谱嵌入坐标，非解剖深度；无数据时为 0） */
  z: number
  xNorm: number
  yNorm: number
  zNorm: number
  /** 功能模块编号（谱聚类着色用；无数据时为 -1） */
  moduleId: number
  /** z 是否为解剖测量（本数据包恒为 false：功能纵深） */
  zAnatomical: boolean
  snr: number
  snrNorm: number
}

export const MISSING_ACTIVITY_COLOR = '#b5b7bb'
export const DISPLAY_SIZE = 7.2

/*
 * 神经元尺寸硬标准：0.8。
 * 空间位置数据已升级为三方向（x / y / z），
 * 节点半径不再使用 1.1 的旧放大系数。
 */
export const FIXED_NODE_SCALE = 0.8

/*
 * 功能纵深显示跨度比：z_norm 独立归一化到 [-1, 1]，
 * 若与 x/y 共用同一比例尺，纵深跨度会被放大到
 * 平面跨度的近 3 倍；此处将功能纵深跨度固定为
 * 平面跨度的 0.45，保证三维关系可见且不压过
 * 真实 ROI 平面结构（z 为功能嵌入坐标，非解剖测量）。
 */
export const DEPTH_SPAN_RATIO = 0.45

/*
 * 播放节奏标准（视频为主时钟）：
 *
 *   视频总时长 = 神经元从第 1 帧播放到最后一帧的总时长
 *   → 帧间隔 = 视频总时长 / (帧数 − 1)
 *   （第 1 帧对应 t=0，最后一帧对应 t=视频总时长）
 *
 *   连接建立/回收时长 = 神经元变色时长 = 0.75 × 帧间隔
 *
 * 三个条件视频实测均为 359.8s：
 *   healthy / ketamine（693 帧）→ 帧间隔 ≈ 519.9ms，
 *     连接/变色 ≈ 390.0ms
 *   cort_like（691 帧）→ 帧间隔 ≈ 521.4ms，
 *     连接/变色 ≈ 391.1ms
 *
 * 以下常量为视频缺失（或元数据未就绪）时的回退值。
 */
export const FRAME_PLAY_INTERVAL_MS = 500

/* 连接 / 变色时长占帧间隔的比例（硬标准 0.75） */
export const TRANSITION_RATIO = 0.75

// 连接建立和回收的动画时长（回退值：帧间隔的 75%）
export const EDGE_TRANSITION_MS =
  FRAME_PLAY_INTERVAL_MS * TRANSITION_RATIO

// 神经元颜色渐变时长（回退值：与连接动画相同）
export const COLOR_TRANSITION_MS = EDGE_TRANSITION_MS

/** 由视频真实时长计算帧间隔（ms）；视频缺失时回退 */
export function playbackFrameIntervalMs(
  videoDurationSec: number | null,
  frameCount: number,
): number {
  if (
    videoDurationSec !== null &&
    Number.isFinite(videoDurationSec) &&
    videoDurationSec > 0 &&
    frameCount > 1
  ) {
    return (videoDurationSec * 1000) / (frameCount - 1)
  }

  return FRAME_PLAY_INTERVAL_MS
}

export const ACTIVITY_COLORS = [
  '#b5b7bb',
  '#FAECEB',
  '#F4D9D7',
  '#EFC5C3',
  '#E9B2AF',
  '#E49F9C',
  '#DF8C88',
  '#D97974',
  '#D46560',
  '#CE524C',
]

export const SCALE_ACTIVITY_COLORS = ACTIVITY_COLORS.slice(1)

export const BEHAVIOR_CONFIG: Record<
  string,
  {
    meaning: string
    color: string
  }
> = {
  rearing: {
    meaning: '直立探索',
    color: '#f97316',
  },
  locomotion: {
    meaning: '笼内移动',
    color: '#22c55e',
  },
  motor: {
    meaning: '跑轮运动',
    color: '#dc2626',
  },
  grooming: {
    meaning: '巢外理毛',
    color: '#e5a323',
  },
  nestgrooming: {
    meaning: '巢内理毛',
    color: '#e15b78',
  },
  nestactivity: {
    meaning: '巢内活动',
    color: '#93a1b8',
  },
  drinking: {
    meaning: '饮水',
    color: '#3b82f6',
  },
  eating: {
    meaning: '进食',
    color: '#84cc16',
  },
  nesting: {
    meaning: '筑巢',
    color: '#ec4899',
  },
  quiet_wake: {
    meaning: '安静清醒',
    color: '#0d9488',
  },
  w: {
    meaning: '清醒',
    color: '#38bdf8',
  },
  nrem: {
    meaning: 'NREM 睡眠',
    color: '#6366f1',
  },
  rem: {
    meaning: 'REM 睡眠',
    color: '#8b5cf6',
  },
  ma: {
    meaning: '微觉醒',
    color: '#c084fc',
  },
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function easeInOutCubic(value: number) {
  const t = clamp(value, 0, 1)

  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export function colorDistance(a: THREE.Color, b: THREE.Color) {
  return Math.sqrt(
    (a.r - b.r) ** 2 +
      (a.g - b.g) ** 2 +
      (a.b - b.b) ** 2,
  )
}

export function getEdgeKey(edge: Edge) {
  return `${edge.source}->${edge.target}`
}

export function numericNeuronSort(a: string, b: string) {
  return Number(a.slice(1)) - Number(b.slice(1))
}

export function normalizeBehavior(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export function getBehaviorConfig(value: string) {
  return (
    BEHAVIOR_CONFIG[normalizeBehavior(value)] ?? {
      meaning: '未分类',
      color: '#a3a3a3',
    }
  )
}

/*
 * 状态渐变色系（颜色双编码）：
 * 色相 = 当前状态（沿用 BEHAVIOR_CONFIG 主题色），
 * 深浅 = 兴奋程度（钙活动强度）。
 * 每族 8 级：1 级 = 主题色混入 85% 白（低兴奋、偏白），
 * 8 级 = 主题色加深 18%（最高兴奋），中间线性过渡。
 */
export const STATE_PALETTE_LEVELS = 8

function hexToRgbTuple(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')

  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ]
}

function rgbTupleToHex(rgb: [number, number, number]) {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function mixHexColors(a: string, b: string, t: number) {
  const ca = hexToRgbTuple(a)
  const cb = hexToRgbTuple(b)

  return rgbTupleToHex([
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  ])
}

const statePaletteCache = new Map<string, string[]>()

/** 由状态主题色生成 8 级渐变色系（浅 → 深），带缓存 */
export function buildStatePalette(baseColor: string) {
  const cached = statePaletteCache.get(baseColor)

  if (cached) {
    return cached
  }

  const light = mixHexColors(baseColor, '#ffffff', 0.85)
  const deep = mixHexColors(baseColor, '#000000', 0.18)

  const palette = Array.from(
    { length: STATE_PALETTE_LEVELS },
    (_, index) =>
      mixHexColors(
        light,
        deep,
        index / (STATE_PALETTE_LEVELS - 1),
      ),
  )

  statePaletteCache.set(baseColor, palette)

  return palette
}

/*
 * 神经元取色（对调后新标准）：
 * 先按状态取色系，再按钙活动值在族内取深浅级。
 * 数据缺失时仍返回灰色 MISSING_ACTIVITY_COLOR。
 */
export function stateActivityColor(
  state: string,
  value: number | null | undefined,
  extent: number,
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return MISSING_ACTIVITY_COLOR
  }

  const baseColor = getBehaviorConfig(state).color
  const palette = buildStatePalette(baseColor)

  const safeExtent = Math.max(extent, 0.0001)

  const normalized = clamp(
    (value + safeExtent) / (safeExtent * 2),
    0,
    1,
  )

  const index = Math.round(
    normalized * (palette.length - 1),
  )

  return palette[index]
}

export function activityColor(
  value: number | null | undefined,
  extent: number,
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return MISSING_ACTIVITY_COLOR
  }

  const safeExtent = Math.max(extent, 0.0001)

  const normalized = clamp(
    (value + safeExtent) / (safeExtent * 2),
    0,
    1,
  )

  const index = Math.round(
    normalized * (SCALE_ACTIVITY_COLORS.length - 1),
  )

  return SCALE_ACTIVITY_COLORS[index]
}

export function activityPosition(value: number, extent: number) {
  const safeExtent = Math.max(extent, 0.0001)

  return clamp(
    ((value + safeExtent) / (safeExtent * 2)) * 100,
    1.5,
    98.5,
  )
}

export function activityDescription(
  value: number | null | undefined,
  extent: number,
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return '数据缺失'
  }

  const ratio = value / Math.max(extent, 0.0001)

  if (ratio <= -0.66) return '强抑制'
  if (ratio <= -0.25) return '抑制'
  if (ratio < 0.25) return '接近平衡'
  if (ratio < 0.66) return '兴奋'

  return '强兴奋'
}

export function deterministicRandom(index: number) {
  const value =
    Math.sin(index * 12.9898 + 78.233) * 43758.5453

  return value - Math.floor(value)
}

/*
 * 神经元大小基准：统一为 1。
 * 早期版本在这里加入伪随机大小差异；现在大小只允许
 * 由「兴奋程度」驱动，且与颜色深浅共用同一有符号刻度
 * （(值+量程)/(2×量程)），初始不得随机。
 */
export const NEURON_SCALE_MIN = 0.9
export const NEURON_SCALE_MAX = 2.6

/*
 * 连线粗细：现有基准线宽为 1.25（CSS 像素）。
 * 连接强度只在线宽上乘以 1.25–1.7，不改变出现/消失逻辑。
 */
export const EDGE_BASE_WIDTH = 1.25
export const EDGE_WIDTH_MULT_MIN = 1.25
export const EDGE_WIDTH_MULT_MAX = 1.7

/** 行为贴合分表：行为类别 -> 神经元编号 -> 0..1 分数 */
export type BehaviorRelevanceTable = Record<
  string,
  Record<string, number>
>

export function createDefaultSizes(ids: string[]) {
  const sizes = new Map<string, number>()

  ids.forEach((id) => {
    sizes.set(id, 1)
  })

  return sizes
}

/*
 * 大小映射：输入 0..1，输出 0.9–2.6（线性）。
 * 基准尺寸为 0.9 倍（无信号时的静态大小），
 * 信号越强越大，最高 2.6 倍。
 */
export function neuronScaleFromSignal(value: number | null | undefined) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return NEURON_SCALE_MIN
  }

  const signal = clamp(value, 0, 1)

  const scale =
    NEURON_SCALE_MIN +
    (NEURON_SCALE_MAX - NEURON_SCALE_MIN) * signal

  return clamp(scale, NEURON_SCALE_MIN, NEURON_SCALE_MAX)
}

export function edgeWidthMultiplier(weight: number) {
  const signal = clamp(weight, 0, 1)

  return (
    EDGE_WIDTH_MULT_MIN +
    (EDGE_WIDTH_MULT_MAX - EDGE_WIDTH_MULT_MIN) * signal
  )
}

export function edgeWidthFromWeight(weight: number) {
  return EDGE_BASE_WIDTH * edgeWidthMultiplier(weight)
}

export function behaviorRelevanceScore(
  table: BehaviorRelevanceTable | null | undefined,
  behavior: string,
  neuronId: string,
) {
  if (!table) {
    return null
  }

  const key = normalizeBehavior(behavior)
  const value = table[key]?.[neuronId]

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return null
  }

  return clamp(value, 0, 1)
}

export function createFallbackPositions(ids: string[]) {
  const result = new Map<string, THREE.Vector3>()
  const columns = Math.ceil(Math.sqrt(ids.length))
  const rows = Math.ceil(ids.length / columns)
  const spacing = 2.1

  ids.forEach((id, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)

    const x =
      (column - (columns - 1) / 2) * spacing

    const y =
      ((rows - 1) / 2 - row) * spacing

    const z =
      (deterministicRandom(index + 500) - 0.5) * 2.4

    result.set(id, new THREE.Vector3(x, y, z))
  })

  return result
}

export interface RoiTransform {
  xCenter: number
  yCenter: number
  zCenter: number
  /** 平面（x/y）比例尺：ROI 归一化坐标 → 场景坐标 */
  scale: number
  /** 功能纵深（z）比例尺：跨度固定为平面跨度的 DEPTH_SPAN_RATIO 倍 */
  zScale: number
}

/*
 * ROI 归一化坐标 → 主场景三维坐标的变换参数。
 * 由全部导入位置共同决定（x/y/z 各自居中，x/y 等比
 * 缩放到 DISPLAY_SIZE 跨度，z 按 DEPTH_SPAN_RATIO
 * 压缩），BrainLocator 复用同一变换的 x/y 部分，
 * 保证主场景点云与脑内微点同构。
 */
export function createRoiTransform(
  imported: NeuronPosition[],
): RoiTransform | null {
  if (imported.length === 0) {
    return null
  }

  const xs = imported.map((item) => item.xNorm)
  const ys = imported.map((item) => item.yNorm)
  const zs = imported.map((item) => item.zNorm)

  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  const zMin = Math.min(...zs)
  const zMax = Math.max(...zs)

  const maxRange = Math.max(
    xMax - xMin,
    yMax - yMin,
    0.001,
  )

  const zRange = Math.max(zMax - zMin, 0.001)

  return {
    xCenter: (xMin + xMax) / 2,
    yCenter: (yMin + yMax) / 2,
    zCenter: (zMin + zMax) / 2,
    scale: DISPLAY_SIZE / maxRange,
    zScale: (DISPLAY_SIZE * DEPTH_SPAN_RATIO) / zRange,
  }
}

/*
 * 唯一坐标映射：ROI 归一化坐标 → 主场景三维坐标。
 *
 * 空间位置数据包含三个方向：
 * - x / y：真实 ROI 中心坐标（x_norm / y_norm）；
 * - z：功能纵深（z_norm，谱嵌入坐标，非解剖深度）。
 * y 轴翻转：ROI 像素坐标 y 向下，场景坐标 y 向上。
 * 位置一旦确定不再改变。
 */
export function roiToScene(
  position: NeuronPosition,
  transform: RoiTransform,
): THREE.Vector3 {
  return new THREE.Vector3(
    (position.xNorm - transform.xCenter) * transform.scale,
    (transform.yCenter - position.yNorm) * transform.scale,
    (position.zNorm - transform.zCenter) * transform.zScale,
  )
}

export function createPositionMap(
  ids: string[],
  importedPositions: Map<string, NeuronPosition>,
) {
  const imported = ids
    .map((id) => importedPositions.get(id))
    .filter(
      (position): position is NeuronPosition =>
        Boolean(position),
    )

  const fallback = createFallbackPositions(ids)
  const transform = createRoiTransform(imported)

  if (!transform) {
    return fallback
  }

  ids.forEach((id) => {
    const position = importedPositions.get(id)

    if (!position) {
      return
    }

    fallback.set(id, roiToScene(position, transform))
  })

  return fallback
}

export function calculateNodeRadius(
  positions: Map<string, THREE.Vector3>,
  sizes: Map<string, number>,
) {
  const points = Array.from(positions.entries())

  if (points.length < 2) {
    return 0.18
  }

  const nearestDistances: number[] = []

  points.forEach(([, point], index) => {
    let nearest = Infinity

    points.forEach(([, other], otherIndex) => {
      if (index === otherIndex) {
        return
      }

      const distance = point.distanceTo(other)

      if (distance > 0 && distance < nearest) {
        nearest = distance
      }
    })

    if (Number.isFinite(nearest)) {
      nearestDistances.push(nearest)
    }
  })

  if (nearestDistances.length === 0) {
    return 0.18
  }

  nearestDistances.sort((a, b) => a - b)

  const reference =
    nearestDistances[
      Math.floor((nearestDistances.length - 1) * 0.1)
    ]

  const maximumSize = Math.max(
    ...points.map(([id]) => sizes.get(id) ?? 1),
    1,
  )

  return THREE.MathUtils.clamp(
    (reference * 0.26) / maximumSize,
    0.11,
    0.28,
  )
}

export function calculateExtent(frames: NeuronFrame[]) {
  const values: number[] = []

  frames.forEach((frame) => {
    Object.values(frame.values).forEach((value) => {
      if (
        typeof value === 'number' &&
        Number.isFinite(value)
      ) {
        values.push(Math.abs(value))
      }
    })
  })

  if (values.length === 0) {
    return 1
  }

  values.sort((a, b) => a - b)

  return Math.max(
    values[Math.floor((values.length - 1) * 0.98)],
    0.5,
  )
}

export function createBumpTexture() {
  const size = 64
  const data = new Uint8Array(size * size)

  for (
    let index = 0;
    index < data.length;
    index += 1
  ) {
    const noise = deterministicRandom(index + 400)

    data[index] = Math.floor(
      80 + noise * 175,
    )
  }

  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  )

  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(4, 4)
  texture.needsUpdate = true

  return texture
}

export function parseCalciumCsv(text: string): NeuronFrame[] {
  const result = Papa.parse<Record<string, unknown>>(
    text,
    {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header: string) =>
        header
          .replace(/^\uFEFF/, '')
          .trim()
          .toLowerCase(),
    },
  )

  if (result.errors.length > 0) {
    throw new Error(
      `钙活动数据 CSV 解析失败：${result.errors[0].message}`,
    )
  }

  const fields = result.meta.fields ?? []

  if (!fields.includes('time_seconds')) {
    throw new Error(
      '钙活动数据缺少 time_seconds 列。',
    )
  }

  const neuronIds = fields
    .filter((field) => /^n\d+$/.test(field))
    .sort(numericNeuronSort)

  if (neuronIds.length === 0) {
    throw new Error(
      '钙活动数据中没有识别到 n1、n2 等神经元列。',
    )
  }

  const frames = result.data.map((row, rowIndex) => {
    const stamp = String(
      row.time_seconds ?? '',
    ).trim()

    if (!stamp) {
      throw new Error(
        `第 ${rowIndex + 2} 行缺少 time_seconds。`,
      )
    }

    const values: Record<string, number | null> = {}

    neuronIds.forEach((id) => {
      const raw = row[id]

      if (
        raw === null ||
        raw === undefined ||
        (typeof raw === 'string' &&
          raw.trim() === '')
      ) {
        values[id] = null
        return
      }

      const value = Number(raw)

      if (!Number.isFinite(value)) {
        throw new Error(
          `第 ${rowIndex + 2} 行的 ${id} 不是有效数值。`,
        )
      }

      values[id] = value
    })

    return {
      stamp,
      behavior: '',
      sleepStage: '',
      seamBefore: false,
      values,
    }
  })

  if (frames.length === 0) {
    throw new Error('钙活动数据中没有有效记录。')
  }

  return frames
}

export interface LabelTick {
  behavior: string
  sleepStage: string
  seamBefore: boolean
}

/**
 * 解析 final_label_timeline.csv（主时钟 + 最终行为标签）。
 * 返回与主时钟行序一致的标签数组。
 */
export function parseLabelTimelineCsv(
  text: string,
): LabelTick[] {
  const result = Papa.parse<Record<string, unknown>>(
    text,
    {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header: string) =>
        header
          .replace(/^\uFEFF/, '')
          .trim()
          .toLowerCase(),
    },
  )

  if (result.errors.length > 0) {
    throw new Error(
      `标签时间轴 CSV 解析失败：${result.errors[0].message}`,
    )
  }

  const fields = result.meta.fields ?? []

  if (!fields.includes('behavior')) {
    throw new Error('标签时间轴缺少 behavior 列。')
  }

  return result.data.map((row) => ({
    behavior: String(row.behavior ?? '').trim(),
    sleepStage: String(row.sleep_stage ?? '').trim(),
    seamBefore:
      String(row.seam_before ?? '')
        .trim()
        .toLowerCase() === 'true',
  }))
}

/**
 * 把标签时间轴按主时钟行序合并进钙活动帧。
 */
export function mergeLabelsIntoFrames(
  frames: NeuronFrame[],
  labels: LabelTick[],
) {
  const count = Math.min(frames.length, labels.length)

  for (let index = 0; index < count; index += 1) {
    frames[index].behavior = labels[index].behavior
    frames[index].sleepStage = labels[index].sleepStage
    frames[index].seamBefore = labels[index].seamBefore
  }

  return frames
}

export interface PredictionTick {
  /** 主时钟整数索引 */
  frame: number
  behavior: string
  sleepStage: string
}

/**
 * 解析一致性复核的预测文件
 * （video_prediction.csv / neural_prediction.csv）。
 * 列：frame,time_seconds,sleep_stage,behavior,...
 * 返回按 frame 升序的预测数组。
 */
export function parsePredictionCsv(
  text: string,
): PredictionTick[] {
  const result = Papa.parse<Record<string, unknown>>(
    text,
    {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header: string) =>
        header
          .replace(/^﻿/, '')
          .trim()
          .toLowerCase(),
    },
  )

  if (result.errors.length > 0) {
    throw new Error(
      `预测数据 CSV 解析失败：${result.errors[0].message}`,
    )
  }

  const fields = result.meta.fields ?? []

  if (
    !fields.includes('frame') ||
    !fields.includes('behavior')
  ) {
    throw new Error(
      '预测数据必须包含 frame 和 behavior 列。',
    )
  }

  return result.data
    .map((row) => ({
      frame: Number(row.frame),
      behavior: String(row.behavior ?? '').trim(),
      sleepStage: String(row.sleep_stage ?? '').trim(),
    }))
    .filter((tick) => Number.isInteger(tick.frame))
    .sort((a, b) => a.frame - b.frame)
}

export function parsePositionCsv(
  text: string,
): Map<string, NeuronPosition> {
  const result = Papa.parse<Record<string, unknown>>(
    text,
    {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header: string) =>
        header
          .replace(/^\uFEFF/, '')
          .trim()
          .toLowerCase(),
    },
  )

  if (result.errors.length > 0) {
    throw new Error(
      `位置数据 CSV 解析失败：${result.errors[0].message}`,
    )
  }

  const fields = result.meta.fields ?? []
  const requiredFields = [
    'neuron_id',
    'neuron_name',
    'x',
    'y',
    'x_norm',
    'y_norm',
  ]

  const missingFields = requiredFields.filter(
    (field) => !fields.includes(field),
  )

  if (missingFields.length > 0) {
    throw new Error(
      `位置数据缺少字段：${missingFields.join(', ')}`,
    )
  }

  /*
   * z / z_norm / module_id 为 Nerous_Data 新增列
   * （功能纵深与功能模块）；旧版纯 2D 位置表缺列时
   * 回退为 z=0、moduleId=-1，保持兼容。
   */
  const hasZ =
    fields.includes('z') && fields.includes('z_norm')

  const positions = new Map<
    string,
    NeuronPosition
  >()

  result.data.forEach((row, index) => {
    const neuronName = String(
      row.neuron_name ?? '',
    )
      .trim()
      .toLowerCase()

    const x = Number(row.x)
    const y = Number(row.y)
    const xNorm = Number(row.x_norm)
    const yNorm = Number(row.y_norm)
    const z = hasZ ? Number(row.z) : 0
    const zNorm = hasZ ? Number(row.z_norm) : 0

    if (!/^n\d+$/.test(neuronName)) {
      throw new Error(
        `位置表第 ${index + 2} 行的 neuron_name 无效。`,
      )
    }

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(xNorm) ||
      !Number.isFinite(yNorm) ||
      !Number.isFinite(z) ||
      !Number.isFinite(zNorm)
    ) {
      throw new Error(
        `位置表第 ${index + 2} 行的空间坐标无效。`,
      )
    }

    const rawModule = Number(row.module_id)

    positions.set(neuronName, {
      neuronId: String(row.neuron_id ?? '').trim(),
      neuronName,
      x,
      y,
      z,
      xNorm,
      yNorm,
      zNorm,
      moduleId: Number.isInteger(rawModule)
        ? rawModule
        : -1,
      zAnatomical:
        String(row.z_anatomical ?? '')
          .trim()
          .toLowerCase() === 'true',
      snr: Number(row.snr) || 0,
      snrNorm: Number(row.snr_norm) || 0,
    })
  })

  return positions
}

export function parseDynamicEdgeCsv(
  text: string,
): EdgeFrames {
  const result = Papa.parse<Record<string, unknown>>(
    text,
    {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: 'greedy',
      transformHeader: (header: string) =>
        header
          .replace(/^\uFEFF/, '')
          .trim()
          .toLowerCase(),
    },
  )

  if (result.errors.length > 0) {
    throw new Error(
      `连接数据 CSV 解析失败：${result.errors[0].message}`,
    )
  }

  const fields = result.meta.fields ?? []

  if (
    !fields.includes('frame') ||
    !fields.includes('source') ||
    !fields.includes('target')
  ) {
    throw new Error(
      '连接数据必须包含 frame、source 和 target 列。',
    )
  }

  const edgeFrames: EdgeFrames = []
  const keysByFrame: Array<Set<string>> = []

  result.data.forEach((row, rowIndex) => {
    /*
     * 新格式带显式 frame 列（主时钟整数索引），
     * 按 frame 分帧，不再按固定行数切分。
     */
    const frameIndex = Number(row.frame)

    if (
      !Number.isInteger(frameIndex) ||
      frameIndex < 0
    ) {
      throw new Error(
        `连接表第 ${rowIndex + 2} 行的 frame 无效。`,
      )
    }

    edgeFrames[frameIndex] ??= []
    keysByFrame[frameIndex] ??= new Set<string>()

    const source = String(row.source ?? '')
      .trim()
      .toLowerCase()

    const target = String(row.target ?? '')
      .trim()
      .toLowerCase()

    if (
      !/^n\d+$/.test(source) ||
      !/^n\d+$/.test(target)
    ) {
      throw new Error(
        `连接表第 ${rowIndex + 2} 行的 source 或 target 无效。`,
      )
    }

    if (source === target) {
      return
    }

    const key = `${source}->${target}`

    if (keysByFrame[frameIndex].has(key)) {
      return
    }

    /*
     * weight = |correlation|，表示连接强弱，
     * 渲染时映射为连线不透明度（越靠近 1 越不透明）。
     */
    const rawWeight = Number(row.weight)

    const weight = Number.isFinite(rawWeight)
      ? clamp(rawWeight, 0, 1)
      : 1

    keysByFrame[frameIndex].add(key)
    edgeFrames[frameIndex].push({
      source,
      target,
      weight,
    })
  })

  if (
    edgeFrames.every(
      (frameEdges) => !frameEdges || frameEdges.length === 0,
    )
  ) {
    throw new Error('连接数据中没有有效连接。')
  }

  return edgeFrames
}
