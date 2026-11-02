import * as THREE from 'three'

/*
 * mPFC 脑区内部适配计算。
 *
 * 空间位置数据升级为三方向（x / y / z）后，神经元不再
 * 贴附在 mPFC 壳面上，而是作为三维点云整体放入脑区
 * 体积内部。本模块回答唯一问题：
 *
 *   「当前 3D 位置下，脑图谱背景要放大到多大，
 *     才能让每个神经元（半径 r 的球）完全位于
 *     mPFC 脑区之内？」
 *
 * 方法：
 * 1. 把 mPFC 网格三角面烘焙到归一化图谱坐标，
 *    建 AABB BVH（射线奇偶判定 + 点到网格最近距离
 *    共用一棵树）；
 * 2. 背景摆放 = (局部坐标 − mPFC 中心) × scale，
 *    即 mPFC 中心对准神经元点云中心（原点）；
 * 3. 从「mPFC 包围盒每轴 ≥ 点云跨度 / 0.8」的初始
 *    scale 出发迭代放大，直到每个神经元都满足
 *    在闭合网格内部 且 到表面的最近距离 ≥ 球半径
 *    （加安全余量）——此刻所有神经元球完全位于
 *    mPFC 之内，该 scale 即位置标准。
 */

interface TriBvh {
  /** 每个三角面 9 个 float（网格局部坐标） */
  tris: Float32Array
  /** 叶节点内三角面索引重排 */
  order: Uint32Array
  /** 节点：[minX,minY,minZ,maxX,maxY,maxZ,leftOrStart,rightOrCount] */
  nodes: Float64Array
  /** 节点标记：1 = 叶 */
  leaf: Uint8Array
}

const LEAF_SIZE = 8

/** 为一批已烘焙到世界坐标的三角面构建 AABB BVH */
function buildBvh(tris: Float32Array, triCount: number): TriBvh {
  const order = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i += 1) {
    order[i] = i
  }

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

  const maxNodes = Math.max(triCount * 2, 1)
  const nodes = new Float64Array(maxNodes * 8)
  const leaf = new Uint8Array(maxNodes)
  let nodeCount = 0

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

    const extX = maxX - minX
    const extY = maxY - minY
    const extZ = maxZ - minZ
    const axis =
      extX > extY ? (extX > extZ ? 0 : 2) : extY > extZ ? 1 : 2

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

  return { tris, order, nodes, leaf }
}

/*
 * 连通分量划分：焊接坐标相同的顶点后用并查集合并
 * 共享顶点的三角面。mPFC 图谱的 PL 区由两个互相嵌入
 * 的闭合壳组成，整体奇偶在重叠区失效（穿两个壳 =
 * 偶数），必须逐分量判定「内部」。
 */
function splitComponents(
  tris: Float32Array,
  triCount: number,
): Float32Array[] {
  const weld = new Map<string, number>()
  const welded = new Uint32Array(triCount * 3)
  let weldCount = 0

  for (let i = 0; i < triCount * 3; i += 1) {
    const x = tris[i * 3]
    const y = tris[i * 3 + 1]
    const z = tris[i * 3 + 2]
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`
    let id = weld.get(key)

    if (id === undefined) {
      id = weldCount
      weldCount += 1
      weld.set(key, id)
    }

    welded[i] = id
  }

  const parent = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i += 1) {
    parent[i] = i
  }

  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) {
      root = parent[root]
    }
    while (parent[i] !== root) {
      const next = parent[i]
      parent[i] = root
      i = next
    }
    return root
  }

  const owner = new Map<number, number>()

  for (let t = 0; t < triCount; t += 1) {
    for (let v = 0; v < 3; v += 1) {
      const wid = welded[t * 3 + v]
      const prev = owner.get(wid)

      if (prev === undefined) {
        owner.set(wid, t)
      } else {
        const ra = find(prev)
        const rb = find(t)
        if (ra !== rb) {
          parent[ra] = rb
        }
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let t = 0; t < triCount; t += 1) {
    const root = find(t)
    const list = groups.get(root)
    if (list) {
      list.push(t)
    } else {
      groups.set(root, [t])
    }
  }

  return Array.from(groups.values()).map((list) => {
    const out = new Float32Array(list.length * 9)
    list.forEach((t, i) => {
      out.set(tris.subarray(t * 9, t * 9 + 9), i * 9)
    })
    return out
  })
}

export interface MeshSampler {
  /** 全网格 BVH：点到表面最近距离（距离不分量） */
  distance: TriBvh
  /** 每个连通分量一棵 BVH：奇偶判定逐分量进行 */
  components: TriBvh[]
}

/** 把网格三角面烘焙到世界（此处即归一化图谱）坐标并建 BVH */
export function createMeshSampler(mesh: THREE.Mesh): MeshSampler {
  mesh.updateWorldMatrix(true, false)

  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const triCount = index
    ? index.count / 3
    : position.count / 3
  const tris = new Float32Array(triCount * 9)
  const vertex = new THREE.Vector3()

  const readVertex = (i: number, out: number) => {
    vertex
      .fromBufferAttribute(position, i)
      .applyMatrix4(mesh.matrixWorld)
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

  const componentTris = splitComponents(tris, triCount)

  return {
    distance: buildBvh(tris, triCount),
    components: componentTris.map((component) =>
      buildBvh(component, component.length / 9),
    ),
  }
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

  /* Möller–Trumbore：t = (e2 · qvec) / det */
  const hit = (e2x * qx + e2y * qy + e2z * qz) * inv

  return hit > 1e-6 ? hit : -1
}

/** 单方向射线命中次数（BVH 加速） */
function raycastCount(
  bvh: TriBvh,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
) {
  let hits = 0
  const stack: number[] = [0]

  while (stack.length > 0) {
    const id = stack.pop() as number
    const base = id * 8

    // slab 法 AABB 相交测试
    let tMin = 0
    let tMax = Infinity
    let miss = false

    const axes: Array<[number, number, number, number]> = [
      [x, dx, bvh.nodes[base], bvh.nodes[base + 3]],
      [y, dy, bvh.nodes[base + 1], bvh.nodes[base + 4]],
      [z, dz, bvh.nodes[base + 2], bvh.nodes[base + 5]],
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

    if (miss) {
      continue
    }

    if (bvh.leaf[id] === 1) {
      const start = bvh.nodes[base + 6]
      const count = bvh.nodes[base + 7]

      for (let i = 0; i < count; i += 1) {
        if (
          rayTriangle(
            bvh.tris,
            bvh.order[start + i],
            x,
            y,
            z,
            dx,
            dy,
            dz,
          ) > 0
        ) {
          hits += 1
        }
      }
    } else {
      stack.push(bvh.nodes[base + 6])
      stack.push(bvh.nodes[base + 7])
    }
  }

  return hits
}

/*
 * 三条分离良好、无对称性的固定方向。
 * 单射线可能恰好穿过共享边/顶点导致奇偶误判，
 * 三方向多数表决可以把这种退化误判压到可忽略。
 */
const PARITY_DIRECTIONS: Array<[number, number, number]> = [
  [0.5789, 0.6123, 0.5385],
  [-0.3456, 0.7891, -0.5123],
  [0.1234, -0.4567, 0.8812],
]

/*
 * 奇偶判定：点是否在闭合网格内部。
 * mPFC 图谱含多个互相嵌入的闭合分量，整体奇偶在
 * 重叠区失效；改为逐分量判定——任一分量内部即视为
 * 位于脑区之内。每个分量用三方向射线多数表决
 * （确定性，同一点结果稳定）。
 */
export function isInsideMesh(
  sampler: MeshSampler,
  x: number,
  y: number,
  z: number,
) {
  for (const component of sampler.components) {
    let votes = 0

    for (const [dx, dy, dz] of PARITY_DIRECTIONS) {
      if (raycastCount(component, x, y, z, dx, dy, dz) % 2 === 1) {
        votes += 1
      }
    }

    if (votes >= 2) {
      return true
    }
  }

  return false
}

/** 点到三角形的最近距离平方（Ericson 最近点算法） */
function pointTriangleDistSq(
  tris: Float32Array,
  t: number,
  px: number,
  py: number,
  pz: number,
) {
  const base = t * 9
  const ax = tris[base]
  const ay = tris[base + 1]
  const az = tris[base + 2]
  const bx = tris[base + 3]
  const by = tris[base + 4]
  const bz = tris[base + 5]
  const cx = tris[base + 6]
  const cy = tris[base + 7]
  const cz = tris[base + 8]

  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const acx = cx - ax
  const acy = cy - ay
  const acz = cz - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az

  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz

  if (d1 <= 0 && d2 <= 0) {
    return apx * apx + apy * apy + apz * apz
  }

  const bpx = px - bx
  const bpy = py - by
  const bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz

  if (d3 >= 0 && d4 <= d3) {
    return bpx * bpx + bpy * bpy + bpz * bpz
  }

  const vc = d1 * d4 - d3 * d2

  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    const qx = ax + v * abx - px
    const qy = ay + v * aby - py
    const qz = az + v * abz - pz
    return qx * qx + qy * qy + qz * qz
  }

  const cpx = px - cx
  const cpy = py - cy
  const cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz

  if (d6 >= 0 && d5 <= d6) {
    return cpx * cpx + cpy * cpy + cpz * cpz
  }

  const vb = d5 * d2 - d1 * d6

  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    const qx = ax + w * acx - px
    const qy = ay + w * acy - py
    const qz = az + w * acz - pz
    return qx * qx + qy * qy + qz * qz
  }

  const va = d3 * d6 - d5 * d4

  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    const qx = bx + w * (cx - bx) - px
    const qy = by + w * (cy - by) - py
    const qz = bz + w * (cz - bz) - pz
    return qx * qx + qy * qy + qz * qz
  }

  // 点在三角形面片区域内：点到平面的距离
  const nx = aby * acz - abz * acy
  const ny = abz * acx - abx * acz
  const nz = abx * acy - aby * acx
  const area =
    nx * apx + ny * apy + nz * apz
  const lenSq = nx * nx + ny * ny + nz * nz

  return lenSq > 1e-20 ? (area * area) / lenSq : Infinity
}

/** 点到网格表面的最近距离（全网格 BVH + AABB 距离剪枝） */
function distanceToBvh(
  bvh: TriBvh,
  x: number,
  y: number,
  z: number,
) {
  let bestSq = Infinity
  const stack: number[] = [0]

  while (stack.length > 0) {
    const id = stack.pop() as number
    const base = id * 8

    // 点到节点 AABB 的最小距离平方，用于剪枝
    const ddx =
      Math.max(
        bvh.nodes[base] - x,
        0,
        x - bvh.nodes[base + 3],
      ) ** 2
    const ddy =
      Math.max(
        bvh.nodes[base + 1] - y,
        0,
        y - bvh.nodes[base + 4],
      ) ** 2
    const ddz =
      Math.max(
        bvh.nodes[base + 2] - z,
        0,
        z - bvh.nodes[base + 5],
      ) ** 2

    if (ddx + ddy + ddz > bestSq) {
      continue
    }

    if (bvh.leaf[id] === 1) {
      const start = bvh.nodes[base + 6]
      const count = bvh.nodes[base + 7]

      for (let i = 0; i < count; i += 1) {
        const distSq = pointTriangleDistSq(
          bvh.tris,
          bvh.order[start + i],
          x,
          y,
          z,
        )

        if (distSq < bestSq) {
          bestSq = distSq
        }
      }
    } else {
      stack.push(bvh.nodes[base + 6])
      stack.push(bvh.nodes[base + 7])
    }
  }

  return Math.sqrt(bestSq)
}

/** 点到整个网格表面的最近距离 */
export function distanceToMesh(
  sampler: MeshSampler,
  x: number,
  y: number,
  z: number,
) {
  return distanceToBvh(sampler.distance, x, y, z)
}

/*
 * 到「并集边界」的净余量。
 *
 * mPFC 图谱由两个互相嵌入的闭合壳（左右 PL 区）组成，
 * 两壳的内侧壁在中线附近几乎贴合。若用「到全网格
 * 表面的最近距离」作净余量，位于左壳内部中线旁的
 * 点会量出到右壳内侧壁的极小距离——但穿过那面墙
 * 只是进入另一个分量，并没有离开脑区并集，不是穿模。
 *
 * 真正的约束是到「并集补集」的距离：点必须穿出
 * 所有包含它的分量才算离开脑区。因此净余量 =
 * 所有包含该点的分量中「到该分量表面距离」的最大值
 * （并集补集 = 各分量补集的交集，故该最大值为安全
 * 下界）。点不在任何分量内时返回 -1。
 */
export function unionClearance(
  sampler: MeshSampler,
  x: number,
  y: number,
  z: number,
) {
  let best = -1

  for (const component of sampler.components) {
    let votes = 0

    for (const [dx, dy, dz] of PARITY_DIRECTIONS) {
      if (raycastCount(component, x, y, z, dx, dy, dz) % 2 === 1) {
        votes += 1
      }
    }

    if (votes < 2) {
      continue
    }

    const clearance = distanceToBvh(component, x, y, z)

    if (clearance > best) {
      best = clearance
    }
  }

  return best
}

export interface ContainmentFit {
  /** 背景图谱缩放系数：锚点对准点云中心后按此放大 */
  scale: number
  /**
   * 内部锚点（网格局部坐标）：脑区内部净余量最大的点。
   * 背景摆放 = (局部坐标 − anchor) × scale，
   * 即锚点对准点云中心（原点）。
   */
  anchor: THREE.Vector3
  /** 迭代次数（初始值即通过时为 0） */
  iterations: number
  /** 所有神经元球到 mPFC 表面的最小净余量（世界单位） */
  minClearance: number
  /** 是否全部神经元都严格位于脑区内部 */
  allInside: boolean
}

/*
 * 在脑区内部寻找锚点：mPFC（前边缘皮层）是沿中线的
 * 弯曲薄层，包围盒中心通常落在组织之外，直接以它为
 * 摆放中心永远无法收敛。改为在包围盒内采样候选点，
 * 用奇偶判定筛出内部点，取到表面净余量最大者。
 */
function findInteriorAnchor(
  sampler: MeshSampler,
  meshCenter: THREE.Vector3,
  meshSize: THREE.Vector3,
): { point: THREE.Vector3; clearance: number } {
  const candidates: THREE.Vector3[] = [
    meshCenter.clone(),
  ]

  // 确定性伪随机采样（坐标散列），结果可复现
  let seed = 12345
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  for (let i = 0; i < 240; i += 1) {
    candidates.push(
      new THREE.Vector3(
        meshCenter.x + (random() - 0.5) * meshSize.x,
        meshCenter.y + (random() - 0.5) * meshSize.y,
        meshCenter.z + (random() - 0.5) * meshSize.z,
      ),
    )
  }

  let best: THREE.Vector3 | null = null
  let bestClearance = -Infinity

  for (const candidate of candidates) {
    if (
      !isInsideMesh(sampler, candidate.x, candidate.y, candidate.z)
    ) {
      continue
    }

    const clearance = distanceToMesh(
      sampler,
      candidate.x,
      candidate.y,
      candidate.z,
    )

    if (clearance > bestClearance) {
      bestClearance = clearance
      best = candidate
    }
  }

  // 极端情况（网格不闭合等）：回退到包围盒中心
  return {
    point: best ?? meshCenter.clone(),
    clearance: bestClearance,
  }
}

export interface CenterFit {
  /** 神经元块整体放大倍数：网格局部坐标 / 点云世界坐标 */
  ratio: number
  /** 摆放中心（网格局部坐标）：优先包围盒中心，其次最近的内部点 */
  pivot: THREE.Vector3
  /** pivot 是否就是 mPFC 包围盒中心（中心在组织内时为 true） */
  pivotIsCenter: boolean
  /** pivot 到 mPFC 包围盒中心的距离（网格局部单位） */
  pivotOffsetFromCenter: number
  /** 仅按包围盒各轴跨度计算的上限倍数 */
  bboxRatio: number
  /** 放大后所有神经元到表面的最小净余量（网格局部单位） */
  minClearance: number
  /** 二分迭代次数 */
  iterations: number
  /** 是否找到可行的放大倍数 */
  feasible: boolean
}

/*
 * 以 mPFC 中心为摆放中心的点云整体放大计算。
 *
 * 与 fitCloudInsideMesh（固定点云、放大背景）相反：
 * 背景图谱缩放保持不变，神经元块以 pivot 为中心整体
 * 均匀放大 ratio 倍，尽量铺满 mPFC 区域——前提是横向 /
 * 纵向 / 竖向任一方向都不穿模：每个放大后的神经元
 * 都必须位于闭合网格内部，且到表面的净余量（网格
 * 局部单位）≥ requiredClearance。
 *
 * pivot 首选 mPFC 包围盒中心；mPFC 是沿中线的薄层，
 * 中心常落在组织之外，此时取「离中心最近」的内部点
 * （确定性采样，可复现）。
 *
 * 二分搜索 ratio：上界为包围盒各轴跨度比的最小值
 * （bboxRatio），feasible(r) 检验所有点
 * pivot + (q − cloudCenter) × r 的在内部性与净余量。
 */
export function fitCloudScaleAtPivot(
  sampler: MeshSampler,
  meshCenter: THREE.Vector3,
  meshSize: THREE.Vector3,
  cloudPoints: THREE.Vector3[],
  requiredClearance: number,
): CenterFit {
  /*
   * 摆放中心：首选 mPFC 包围盒中心——不仅要在组织内，
   * 还要自身净余量足够容纳节点球（mPFC 是沿中线的
   * 薄层，正中矢面处层厚可能不足以容纳整个节点球）。
   * 不满足时，确定性采样取「离中心最近且净余量充足」
   * 的内部点；都不满足时取净余量最大者。
   */
  let pivot = meshCenter.clone()
  const centerClearance = unionClearance(
    sampler,
    meshCenter.x,
    meshCenter.y,
    meshCenter.z,
  )
  let pivotIsCenter = centerClearance >= requiredClearance

  if (!pivotIsCenter) {
    let seed = 54321
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    let best: THREE.Vector3 | null = null
    let bestDist = Infinity
    let fallback: THREE.Vector3 | null = null
    let fallbackClearance = -Infinity

    for (let i = 0; i < 400; i += 1) {
      const candidate = new THREE.Vector3(
        meshCenter.x + (random() - 0.5) * meshSize.x,
        meshCenter.y + (random() - 0.5) * meshSize.y,
        meshCenter.z + (random() - 0.5) * meshSize.z,
      )

      const clearance = unionClearance(
        sampler,
        candidate.x,
        candidate.y,
        candidate.z,
      )

      if (clearance < 0) {
        continue
      }

      if (clearance > fallbackClearance) {
        fallback = candidate
        fallbackClearance = clearance
      }

      if (clearance < requiredClearance) {
        continue
      }

      const dist = candidate.distanceTo(meshCenter)

      if (dist < bestDist) {
        best = candidate
        bestDist = dist
      }
    }

    if (best) {
      pivot = best
    } else if (fallback) {
      pivot = fallback
    }
  }

  if (cloudPoints.length === 0) {
    return {
      ratio: 1,
      pivot,
      pivotIsCenter,
      pivotOffsetFromCenter: pivot.distanceTo(meshCenter),
      bboxRatio: 1,
      minClearance: 0,
      iterations: 0,
      feasible: false,
    }
  }

  /* 点云包围盒中心与各轴跨度 */
  const box = new THREE.Box3()
  cloudPoints.forEach((point) => box.expandByPoint(point))
  const cloudCenter = box.getCenter(new THREE.Vector3())
  const span = box.getSize(new THREE.Vector3())

  /*
   * 包围盒上限：任一轴向不允许超出 mPFC 包围盒。
   * 跨度为 0 的轴不参与限制。
   */
  const axisRatio = (meshAxis: number, spanAxis: number) =>
    spanAxis > 1e-6 ? meshAxis / spanAxis : Infinity

  const bboxRatio = Math.min(
    axisRatio(meshSize.x, span.x),
    axisRatio(meshSize.y, span.y),
    axisRatio(meshSize.z, span.z),
  )

  const local = new THREE.Vector3()
  const offset = new THREE.Vector3()

  /*
   * 检验放大倍数 r 是否可行：所有点放大后仍在
   * 脑区并集内部，且到并集边界的净余量满足要求
   * （unionClearance < 0 表示不在任何分量内）。
   */
  const feasible = (r: number): boolean => {
    for (const point of cloudPoints) {
      offset.copy(point).sub(cloudCenter)
      local.copy(pivot).addScaledVector(offset, r)

      if (
        unionClearance(sampler, local.x, local.y, local.z) <
        requiredClearance
      ) {
        return false
      }
    }

    return true
  }

  /* 二分搜索最大可行倍数 */
  let lo = 0
  let hi = Math.max(bboxRatio, 1e-3)
  let iterations = 0

  if (feasible(hi)) {
    lo = hi
  } else {
    for (; iterations < 48; iterations += 1) {
      const mid = (lo + hi) / 2

      if (feasible(mid)) {
        lo = mid
      } else {
        hi = mid
      }
    }
  }

  const ratio = lo

  /* 统计最终净余量（到并集边界） */
  let minClearance = Infinity

  for (const point of cloudPoints) {
    offset.copy(point).sub(cloudCenter)
    local.copy(pivot).addScaledVector(offset, ratio)

    const clearance = unionClearance(
      sampler,
      local.x,
      local.y,
      local.z,
    )

    if (clearance < minClearance) {
      minClearance = clearance
    }
  }

  return {
    ratio,
    pivot,
    pivotIsCenter,
    pivotOffsetFromCenter: pivot.distanceTo(meshCenter),
    bboxRatio,
    minClearance,
    iterations,
    feasible: ratio > 0 && minClearance >= requiredClearance,
  }
}

/*
 * 计算神经元点云完全位于 mPFC 之内的背景缩放。
 *
 * - cloudPoints：神经元三维位置（世界坐标，云中心在原点）；
 * - radius：神经元球半径（世界单位，含安全余量由内部追加）；
 * - 背景摆放约定：(网格局部坐标 − anchor) × scale，
 *   anchor 为脑区内部净余量最大的点，对准点云中心。
 */
export function fitCloudInsideMesh(
  sampler: MeshSampler,
  meshCenter: THREE.Vector3,
  meshSize: THREE.Vector3,
  cloudPoints: THREE.Vector3[],
  radius: number,
): ContainmentFit {
  const { point: anchor } = findInteriorAnchor(
    sampler,
    meshCenter,
    meshSize,
  )

  if (cloudPoints.length === 0) {
    return {
      scale: 1,
      anchor,
      iterations: 0,
      minClearance: 0,
      allInside: false,
    }
  }

  /* 点云各轴跨度 */
  const span = new THREE.Vector3()
  const box = new THREE.Box3()
  cloudPoints.forEach((point) => box.expandByPoint(point))
  box.getSize(span)

  /*
   * 初始 scale：mPFC 包围盒每个轴至少容纳点云跨度的
   * 1 / 0.8 倍（四周各留 10%），随后按真实网格
   * 距离迭代修正——包围盒只是起点，表面距离才是判据。
   */
  let scale = Math.max(
    span.x / Math.max(meshSize.x * 0.8, 0.001),
    span.y / Math.max(meshSize.y * 0.8, 0.001),
    span.z / Math.max(meshSize.z * 0.8, 0.001),
    0.001,
  )

  /* 球完全位于内部所需的净余量：半径 + 15% 安全系数 */
  const requiredClearance = radius * 1.15 + 0.02

  let iterations = 0
  let minClearance = -Infinity
  let allInside = false
  const local = new THREE.Vector3()

  for (; iterations < 60; iterations += 1) {
    minClearance = Infinity
    allInside = true

    for (const point of cloudPoints) {
      /*
       * 世界点 → 网格局部坐标：
       * world = (local − anchor) × scale
       * 内部判定与 scale 无关，净余量随 scale 线性放大。
       */
      local
        .copy(point)
        .divideScalar(scale)
        .add(anchor)

      if (!isInsideMesh(sampler, local.x, local.y, local.z)) {
        allInside = false
        minClearance = -Infinity
        break
      }

      const clearance =
        distanceToMesh(sampler, local.x, local.y, local.z) *
        scale

      if (clearance < minClearance) {
        minClearance = clearance
      }
    }

    if (allInside && minClearance >= requiredClearance) {
      break
    }

    scale *= 1.06
  }

  return { scale, anchor, iterations, minClearance, allInside }
}
