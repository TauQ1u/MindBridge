import * as THREE from 'three'

/*
 * 神经信号涟漪网络共享模块。
 *
 * 从首页合并场景（NeuronGalaxyScene）抽取，供首页与
 * 工作台神经元场景（NeuronScene）共用同一套实现：
 * - 三角面 BVH（脑壳采样与点击拾取加速）；
 * - 脑内体积均匀采样传播节点；
 * - 最近邻连接图；
 * - 涟漪沿连接网传播（Dijkstra 到达时刻一次性算好）。
 *
 * 可选参数均为向后兼容扩展：首页不传参，行为与抽取前
 * 完全一致；工作台通过 reject 谓词排除 mPFC 内部采样、
 * 通过 minDegree 保证稀疏节点（细胞核）必有连接。
 */

/* ---------------- 常量：密度 / 配色 / 涟漪参数 ---------------- */

/** 神经元节点数（美观与性能的甜区） */
export const NEURON_COUNT = 3200
/** 每个节点的邻居连接数上限 */
export const EDGE_NEIGHBORS = 3
/** 连接的最大距离（脑长轴为 12 的世界单位） */
export const EDGE_MAX_DIST = 1.1
/** 菱形基础半径：极小点状，近似连线交点（再乘 0.6~1.2 随机缩放） */
export const NODE_RADIUS = 0.03

/*
 * 静息态亮度压到最低：节点与连线都近乎隐没，
 * 只有点击激发的涟漪经过时才显亮。
 */
/** 静息态节点色：近黑的微灰 */
export const REST_COLOR = new THREE.Color(0.05, 0.056, 0.068)
/** 静息态连线色：近黑的微蓝 */
export const EDGE_REST_COLOR = new THREE.Color(0.012, 0.014, 0.018)
/** 激发色：饱和青蓝（低浓度、半透明空灵） */
export const FIRE_COLOR = new THREE.Color(0.18, 0.72, 1.0)

/** 涟漪沿连接网传播的波速（世界单位 / 秒） */
export const RIPPLE_SPEED = 5.2
/** 单次传播的最大空间范围（约四分之一脑区） */
export const RIPPLE_MAX_DIST = 3.2
/** 节点局部余晖衰减常数（秒）：中心点亮后也会慢慢消退 */
export const RIPPLE_TAU = 0.85
/** 波前随传播距离变浅的衰减时间（秒）：越小变浅越明显 */
export const WAVE_TRAVEL_TAU = 0.55
/** 每个节点向外转发涟漪时，单条连线参与传播的概率 */
export const PROPAGATE_PROB = 0.7
/** 同时存在的涟漪上限 */
export const MAX_RIPPLES = 5

/* ---------------- AABB BVH（三角面射线加速） ---------------- */

export interface TriBvh {
  /** 每个三角面 9 个 float（世界坐标） */
  tris: Float32Array
  /** 叶节点内三角面索引重排 */
  order: Uint32Array
  /** 节点：[minX,minY,minZ,maxX,maxY,maxZ,leftOrStart,rightOrCount] */
  nodes: Float64Array
  /** 节点标记：1 = 叶 */
  leaf: Uint8Array
  nodeCount: number
}

export function buildTriangleData(mesh: THREE.Mesh) {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const triCount = index
    ? index.count / 3
    : position.count / 3
  const tris = new Float32Array(triCount * 9)
  const vertex = new THREE.Vector3()

  const readVertex = (i: number, out: number) => {
    vertex.fromBufferAttribute(position, i).applyMatrix4(
      mesh.matrixWorld,
    )
    tris[out] = vertex.x
    tris[out + 1] = vertex.y
    tris[out + 2] = vertex.z
  }

  for (let t = 0; t < triCount; t += 1) {
    const a = index ? index.getX(t * 3) : t * 3
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const c = index ? index.getX(t * 3 + 2) : t * 3 + 2
    readVertex(a, t * 9)
    readVertex(b, t * 9 + 3)
    readVertex(c, t * 9 + 6)
  }

  return tris
}

export function buildBvh(tris: Float32Array): TriBvh {
  const triCount = tris.length / 9
  const order = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i += 1) {
    order[i] = i
  }

  // 每个三角面的包围盒（构建期使用）
  const triMin = new Float32Array(triCount * 3)
  const triMax = new Float32Array(triCount * 3)
  const centroid = new Float32Array(triCount * 3)

  for (let t = 0; t < triCount; t += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const v0 = tris[t * 9 + axis]
      const v1 = tris[t * 9 + 3 + axis]
      const v2 = tris[t * 9 + 6 + axis]
      triMin[t * 3 + axis] = Math.min(v0, v1, v2)
      triMax[t * 3 + axis] = Math.max(v0, v1, v2)
      centroid[t * 3 + axis] = (v0 + v1 + v2) / 3
    }
  }

  const maxNodes = triCount * 2
  const nodes = new Float64Array(maxNodes * 8)
  const leaf = new Uint8Array(maxNodes)
  let nodeCount = 0

  const LEAF_SIZE = 8

  const buildNode = (start: number, end: number): number => {
    const id = nodeCount
    nodeCount += 1

    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity

    for (let i = start; i < end; i += 1) {
      const t = order[i]
      minX = Math.min(minX, triMin[t * 3])
      minY = Math.min(minY, triMin[t * 3 + 1])
      minZ = Math.min(minZ, triMin[t * 3 + 2])
      maxX = Math.max(maxX, triMax[t * 3])
      maxY = Math.max(maxY, triMax[t * 3 + 1])
      maxZ = Math.max(maxZ, triMax[t * 3 + 2])
    }

    const base = id * 8
    nodes[base] = minX
    nodes[base + 1] = minY
    nodes[base + 2] = minZ
    nodes[base + 3] = maxX
    nodes[base + 4] = maxY
    nodes[base + 5] = maxZ

    const count = end - start

    if (count <= LEAF_SIZE) {
      leaf[id] = 1
      nodes[base + 6] = start
      nodes[base + 7] = count
      return id
    }

    // 最长轴上按质心中位数切分
    const extX = maxX - minX
    const extY = maxY - minY
    const extZ = maxZ - minZ
    const axis = extX > extY ? (extX > extZ ? 0 : 2) : extY > extZ ? 1 : 2

    const slice = Array.from(order.subarray(start, end))
    slice.sort(
      (a, b) => centroid[a * 3 + axis] - centroid[b * 3 + axis],
    )
    order.set(slice, start)

    const mid = start + Math.floor(count / 2)
    const left = buildNode(start, mid)
    const right = buildNode(mid, end)

    nodes[base + 6] = left
    nodes[base + 7] = right

    return id
  }

  buildNode(0, triCount)

  return { tris, order, nodes, leaf, nodeCount }
}

/** 射线与单个三角面求交（Möller–Trumbore），返回 t 或 -1 */
function rayTriangle(
  tris: Float32Array,
  t: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
) {
  const base = t * 9
  const ax = tris[base]
  const ay = tris[base + 1]
  const az = tris[base + 2]
  const e1x = tris[base + 3] - ax
  const e1y = tris[base + 4] - ay
  const e1z = tris[base + 5] - az
  const e2x = tris[base + 6] - ax
  const e2y = tris[base + 7] - ay
  const e2z = tris[base + 8] - az

  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz

  if (Math.abs(det) < 1e-10) {
    return -1
  }

  const inv = 1 / det
  const tx = ox - ax
  const ty = oy - ay
  const tz = oz - az
  const u = (tx * px + ty * py + tz * pz) * inv

  if (u < -1e-6 || u > 1 + 1e-6) {
    return -1
  }

  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inv

  if (v < -1e-6 || u + v > 1 + 1e-6) {
    return -1
  }

  const hit = (e2x * qx + e2y * qy + e2z * qz) * inv

  return hit > 1e-6 ? hit : -1
}

/**
 * 遍历 BVH 射线求交。
 * mode 'count'：统计全部命中数（点在体内奇偶判定）；
 * mode 'nearest'：返回最近命中距离（点击拾取入射点）。
 */
export function raycastBvh(
  bvh: TriBvh,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  mode: 'count',
): number
export function raycastBvh(
  bvh: TriBvh,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  mode: 'nearest',
): number | null
export function raycastBvh(
  bvh: TriBvh,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  mode: 'count' | 'nearest',
): number | null {
  let hits = 0
  let nearest = Infinity

  const stack: number[] = [0]

  while (stack.length > 0) {
    const id = stack.pop() as number
    const base = id * 8
    const minX = bvh.nodes[base]
    const minY = bvh.nodes[base + 1]
    const minZ = bvh.nodes[base + 2]
    const maxX = bvh.nodes[base + 3]
    const maxY = bvh.nodes[base + 4]
    const maxZ = bvh.nodes[base + 5]

    //  slab 法 AABB 相交测试
    let tMin = 0
    let tMax = Infinity
    let miss = false

    const axes: Array<[number, number, number, number]> = [
      [ox, dx, minX, maxX],
      [oy, dy, minY, maxY],
      [oz, dz, minZ, maxZ],
    ]

    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-12) {
        if (o < lo || o > hi) {
          miss = true
          break
        }
        continue
      }
      let t1 = (lo - o) / d
      let t2 = (hi - o) / d
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      tMin = Math.max(tMin, t1)
      tMax = Math.min(tMax, t2)
      if (tMin > tMax) {
        miss = true
        break
      }
    }

    if (miss || (mode === 'nearest' && tMin > nearest)) {
      continue
    }

    if (bvh.leaf[id] === 1) {
      const start = bvh.nodes[base + 6]
      const count = bvh.nodes[base + 7]

      for (let i = 0; i < count; i += 1) {
        const tri = bvh.order[start + i]
        const t = rayTriangle(
          bvh.tris,
          tri,
          ox,
          oy,
          oz,
          dx,
          dy,
          dz,
        )

        if (t > 0) {
          hits += 1
          if (t < nearest) {
            nearest = t
          }
        }
      }
    } else {
      stack.push(bvh.nodes[base + 6])
      stack.push(bvh.nodes[base + 7])
    }
  }

  return mode === 'count'
    ? hits
    : nearest === Infinity
      ? null
      : nearest
}

/** 奇偶判定：点是否在闭合脑壳内部 */
export function isInsideBrain(
  bvh: TriBvh,
  x: number,
  y: number,
  z: number,
) {
  // 随机方向减少射线穿过共享边/顶点的退化计数误差
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  const dx = Math.sin(phi) * Math.cos(theta)
  const dy = Math.sin(phi) * Math.sin(theta)
  const dz = Math.cos(phi)

  return raycastBvh(bvh, x, y, z, dx, dy, dz, 'count') % 2 === 1
}

/* ---------------- 神经元采样与连接网 ---------------- */

export interface SampleOptions {
  /** 采样节点数（默认 NEURON_COUNT） */
  count?: number
  /** 包围盒内缩边距（默认 0.3） */
  margin?: number
  /*
   * 额外拒绝谓词：返回 true 表示该点不可用。
   * 工作台用它排除 mPFC 体积内的随机采样——
   * mPFC 内的传播节点由神经元中心的细胞核承担。
   */
  reject?: (x: number, y: number, z: number) => boolean
}

export function sampleNeuronPositions(
  bvh: TriBvh,
  bounds: THREE.Box3,
  options: SampleOptions = {},
) {
  const total = options.count ?? NEURON_COUNT
  const margin = options.margin ?? 0.3
  const positions = new Float32Array(total * 3)

  const minX = bounds.min.x + margin
  const minY = bounds.min.y + margin
  const minZ = bounds.min.z + margin
  const spanX = Math.max(bounds.max.x - bounds.min.x - margin * 2, 0.1)
  const spanY = Math.max(bounds.max.y - bounds.min.y - margin * 2, 0.1)
  const spanZ = Math.max(bounds.max.z - bounds.min.z - margin * 2, 0.1)

  let placed = 0
  let attempts = 0
  const maxAttempts = total * 60

  while (placed < total && attempts < maxAttempts) {
    attempts += 1

    const x = minX + Math.random() * spanX
    const y = minY + Math.random() * spanY
    const z = minZ + Math.random() * spanZ

    if (!isInsideBrain(bvh, x, y, z)) {
      continue
    }

    if (options.reject && options.reject(x, y, z)) {
      continue
    }

    positions[placed * 3] = x
    positions[placed * 3 + 1] = y
    positions[placed * 3 + 2] = z
    placed += 1
  }

  return { positions, count: placed }
}

export interface EdgePairOptions {
  /** 连接的最大距离（默认 EDGE_MAX_DIST） */
  maxDist?: number
  /*
   * 每个节点的最小连接数（默认 0 = 不保证）。
   * 距离上限内找不到足够邻居时，无条件连接最近的
   * 若干个节点兜底——工作台细胞核节点分布稀疏，
   * 用 minDegree 保证它们不会成为孤立节点。
   */
  minDegree?: number
}

/** 每个节点连最近的若干个邻居，去重后返回成对索引 */
export function buildEdgePairs(
  positions: Float32Array,
  count: number,
  options: EdgePairOptions = {},
) {
  const maxDist = options.maxDist ?? EDGE_MAX_DIST
  const minDegree = options.minDegree ?? 0
  const maxDistSq = maxDist * maxDist
  const pairs = new Set<number>()
  const best: number[] = []
  const bestDist: number[] = []

  for (let i = 0; i < count; i += 1) {
    best.length = 0
    bestDist.length = 0

    const ix = positions[i * 3]
    const iy = positions[i * 3 + 1]
    const iz = positions[i * 3 + 2]

    for (let j = 0; j < count; j += 1) {
      if (j === i) {
        continue
      }

      const dx = positions[j * 3] - ix
      const dy = positions[j * 3 + 1] - iy
      const dz = positions[j * 3 + 2] - iz
      const distSq = dx * dx + dy * dy + dz * dz

      if (distSq > maxDistSq) {
        continue
      }

      // 保留最近的 EDGE_NEIGHBORS 个
      let slot = bestDist.length
      for (let s = 0; s < bestDist.length; s += 1) {
        if (distSq < bestDist[s]) {
          slot = s
          break
        }
      }
      if (slot < EDGE_NEIGHBORS) {
        bestDist.splice(slot, 0, distSq)
        best.splice(slot, 0, j)
        if (bestDist.length > EDGE_NEIGHBORS) {
          bestDist.pop()
          best.pop()
        }
      }
    }

    /*
     * 最小度数兜底：距离上限内邻居不足时，
     * 再做一遍全量扫描，无条件补最近的若干个。
     */
    if (best.length < minDegree) {
      const need = minDegree - best.length
      const fallback: number[] = []
      const fallbackDist: number[] = []

      for (let j = 0; j < count; j += 1) {
        if (j === i || best.includes(j)) {
          continue
        }

        const dx = positions[j * 3] - ix
        const dy = positions[j * 3 + 1] - iy
        const dz = positions[j * 3 + 2] - iz
        const distSq = dx * dx + dy * dy + dz * dz

        let slot = fallbackDist.length
        for (let s = 0; s < fallbackDist.length; s += 1) {
          if (distSq < fallbackDist[s]) {
            slot = s
            break
          }
        }
        if (slot < need) {
          fallbackDist.splice(slot, 0, distSq)
          fallback.splice(slot, 0, j)
          if (fallbackDist.length > need) {
            fallbackDist.pop()
            fallback.pop()
          }
        }
      }

      best.push(...fallback)
    }

    for (const j of best) {
      const a = Math.min(i, j)
      const b = Math.max(i, j)
      pairs.add(a * 100000 + b)
    }
  }

  return Array.from(pairs, (key) => [
    Math.floor(key / 100000),
    key % 100000,
  ])
}

/* ---------------- 连接图与涟漪传播 ---------------- */

export interface NeuronGraph {
  pairs: number[][]
  /** 每个节点关联的边索引列表 */
  nodeEdges: number[][]
  /** 每条边的长度（世界单位） */
  edgeLengths: Float32Array
}

export function buildGraph(
  positions: Float32Array,
  count: number,
  options: EdgePairOptions = {},
): NeuronGraph {
  const pairs = buildEdgePairs(positions, count, options)
  const nodeEdges: number[][] = Array.from(
    { length: count },
    () => [],
  )
  const edgeLengths = new Float32Array(pairs.length)

  pairs.forEach(([a, b], edgeIndex) => {
    nodeEdges[a].push(edgeIndex)
    nodeEdges[b].push(edgeIndex)

    const dx = positions[a * 3] - positions[b * 3]
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1]
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2]
    edgeLengths[edgeIndex] = Math.sqrt(dx * dx + dy * dy + dz * dz)
  })

  return { pairs, nodeEdges, edgeLengths }
}

/*
 * 一次涟漪的传播记录。
 * 信号沿连接图传播（Dijkstra 最短路到达时间），
 * 每个节点向外转发时单条连线只有 PROPAGATE_PROB 的概率
 * 参与传播——总有一两条连线不亮，网络不会整片均匀点亮。
 */
export interface RippleWave {
  /** 触发时刻（performance.now()） */
  start: number
  /** 每个节点的信号到达偏移（秒），-1 = 未到达 */
  nodeArrival: Float32Array
  /** 每条边被波前穿过的时刻偏移（秒），-1 = 未参与传播 */
  edgeArrival: Float32Array
  /** 最晚到达偏移，用于涟漪清理 */
  maxArrival: number
}

export interface RippleOptions {
  /** 单次传播的最大空间范围（默认 RIPPLE_MAX_DIST） */
  maxDist?: number
  /** 传播波速（默认 RIPPLE_SPEED） */
  speed?: number
}

export function propagateRipple(
  graph: NeuronGraph,
  positions: Float32Array,
  count: number,
  originIndex: number,
  options: RippleOptions = {},
): RippleWave {
  const maxDist = options.maxDist ?? RIPPLE_MAX_DIST
  const speed = options.speed ?? RIPPLE_SPEED

  const nodeArrival = new Float32Array(count).fill(-1)
  const edgeArrival = new Float32Array(graph.pairs.length).fill(-1)
  const settled = new Uint8Array(count)

  const ox = positions[originIndex * 3]
  const oy = positions[originIndex * 3 + 1]
  const oz = positions[originIndex * 3 + 2]

  // 小二叉堆：[arrival, nodeIndex]
  const heap: number[] = [0, originIndex]
  nodeArrival[originIndex] = 0
  let maxArrival = 0

  const heapPush = (arrival: number, node: number) => {
    heap.push(arrival, node)
    let i = heap.length / 2 - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent * 2] <= heap[i * 2]) {
        break
      }
      ;[heap[parent * 2], heap[i * 2]] = [
        heap[i * 2],
        heap[parent * 2],
      ]
      ;[heap[parent * 2 + 1], heap[i * 2 + 1]] = [
        heap[i * 2 + 1],
        heap[parent * 2 + 1],
      ]
      i = parent
    }
  }

  const heapPop = (): number => {
    const topNode = heap[1]
    const lastArrival = heap[heap.length - 2]
    const lastNode = heap[heap.length - 1]
    heap.length -= 2
    if (heap.length > 0) {
      heap[0] = lastArrival
      heap[1] = lastNode
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = i * 2 + 2
        let smallest = i
        if (
          left < heap.length / 2 &&
          heap[left * 2] < heap[smallest * 2]
        ) {
          smallest = left
        }
        if (
          right < heap.length / 2 &&
          heap[right * 2] < heap[smallest * 2]
        ) {
          smallest = right
        }
        if (smallest === i) {
          break
        }
        ;[heap[smallest * 2], heap[i * 2]] = [
          heap[i * 2],
          heap[smallest * 2],
        ]
        ;[heap[smallest * 2 + 1], heap[i * 2 + 1]] = [
          heap[i * 2 + 1],
          heap[smallest * 2 + 1],
        ]
        i = smallest
      }
    }
    return topNode
  }

  while (heap.length > 0) {
    const arrival = heap[0]
    const node = heapPop()

    if (settled[node] === 1) {
      continue
    }
    settled[node] = 1

    if (arrival > maxArrival) {
      maxArrival = arrival
    }

    // 节点首次定型时向外转发一次（随机子集）
    for (const edgeIndex of graph.nodeEdges[node]) {
      // 这条连线不参与本次传播
      if (Math.random() > PROPAGATE_PROB) {
        continue
      }

      const [a, b] = graph.pairs[edgeIndex]
      const next = a === node ? b : a

      if (settled[next] === 1) {
        continue
      }

      // 范围限制：只传播到以激发点为中心的一小块区域
      const dx = positions[next * 3] - ox
      const dy = positions[next * 3 + 1] - oy
      const dz = positions[next * 3 + 2] - oz
      if (dx * dx + dy * dy + dz * dz > maxDist * maxDist) {
        continue
      }

      const nextArrival =
        arrival + graph.edgeLengths[edgeIndex] / speed

      if (
        nodeArrival[next] === -1 ||
        nextArrival < nodeArrival[next]
      ) {
        nodeArrival[next] = nextArrival
        edgeArrival[edgeIndex] = arrival
        heapPush(nextArrival, next)
      }
    }
  }

  return { start: 0, nodeArrival, edgeArrival, maxArrival }
}
