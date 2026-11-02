import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2 } from 'lucide-react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import {
  DISPLAY_SIZE,
  EDGE_TRANSITION_MS,
  FIXED_NODE_SCALE,
  MISSING_ACTIVITY_COLOR,
  NEURON_SCALE_MIN,
  calculateNodeRadius,
  clamp,
  colorDistance,
  createBumpTexture,
  easeInOutCubic,
  edgeWidthFromWeight,
  getEdgeKey,
  neuronScaleFromSignal,
  stateActivityColor,
  type Edge,
  type NeuronFrame,
} from './neuronUtils'
import {
  createBrainShellMaterial,
  createNormalizedAtlas,
  createStructureMaterial,
  loadAtlasModels,
  setSurfaceMinOpacity,
} from '../brain/atlas'
import {
  createMeshSampler,
  fitCloudInsideMesh,
  fitCloudScaleAtPivot,
  type MeshSampler,
} from '../brain/containment'
import { ALLEN_STRUCTURE_MODEL_URLS } from '../brain/brainStructures'

/*
 * 神经元 3D 场景组件。
 *
 * 渲染、连接动画、颜色渐变与交互逻辑为系统
 * 【不可变更】的核心逻辑，从原 App.tsx 逐字迁移。
 *
 * 背景层：整脑 + 全量脑区结构图谱模型（src/brain/atlas
 * 共享实现）。空间位置数据已升级为三方向（真实 ROI 的
 * x / y + 功能纵深 z），神经元网络是三维点云；
 * 背景缩放由 src/brain/containment 的适配计算决定：
 * 迭代放大 mPFC 图谱，直到每个神经元球（半径硬标准
 * 0.8 系数）都完全位于 mPFC 脑区体积之内——以此作为
 * 位置标准。mPFC 保持原木色 0.6 常驻显色，其余脑区
 * 统一按 0.1 中性灰地标档静态展示（不可点击）。
 *
 * 神经元球面微透光（0.78~0.86），每个球心处有一个
 * 静态常驻的细胞核微光小点。
 */

interface AnimatedEdgeLine {
  key: string
  edge: Edge
  sourceLine: Line2
  targetLine: Line2
  sourceGeometry: LineGeometry
  targetGeometry: LineGeometry
  sourceMaterial: LineMaterial
  targetMaterial: LineMaterial
  progress: number
  fromProgress: number
  toProgress: number
  animationStart: number | null
}

/*
 * weight（|correlation|）映射连线不透明度：
 * 越靠近 1 越不透明；保留最小透明度避免完全不可见。
 */
function edgeOpacity(weight: number) {
  return 0.08 + 0.82 * clamp(weight, 0, 1)
}

/*
 * 当前相机位姿（目标点 / 方向 / 距离），
 * 供「重置视角」恢复。
 */
interface CameraPose {
  target: THREE.Vector3
  direction: THREE.Vector3
  distance: number
}

export interface NeuronSceneProps {
  neuronIds: string[]
  frame: NeuronFrame
  sizes: Map<string, number>
  positions: Map<string, THREE.Vector3>
  edges: Edge[]
  extent: number
  hasActivityData: boolean
  resetSignal: number
  /**
   * 连接建立/回收与神经元变色动画时长（ms）。
   * 标准：0.75 × 帧间隔；缺省用回退常量。
   */
  transitionMs?: number
  onSelect: (id: string | null) => void
  /**
   * 行为解码贡献模块高亮（可空）：
   * highlightNeuronIds 为模块成员集合，Top 3 成员使用更强亮度；
   * 非成员降低不透明度但不隐藏。随播放只更新颜色/大小，不改变成员。
   */
  highlightNeuronIds?: ReadonlySet<string>
  topNeuronIds?: ReadonlySet<string>
  highlightColor?: string
}

function updateLineGeometry(
  geometry: LineGeometry,
  start: THREE.Vector3,
  end: THREE.Vector3,
) {
  const startAttribute =
    geometry.getAttribute('instanceStart') as
      | THREE.InterleavedBufferAttribute
      | undefined

  const endAttribute =
    geometry.getAttribute('instanceEnd') as
      | THREE.InterleavedBufferAttribute
      | undefined

  if (!startAttribute || !endAttribute) {
    return
  }

  startAttribute.setXYZ(
    0,
    start.x,
    start.y,
    start.z,
  )

  endAttribute.setXYZ(
    0,
    end.x,
    end.y,
    end.z,
  )

  startAttribute.needsUpdate = true
  endAttribute.needsUpdate = true
}

/*
 * 连接几何更新（连线始终为直线，不做弯曲偏移）：
 *
 * - 建立（retract = false）：两段线分别固定在 source /
 *   target 神经元上，向中点生长汇合；
 * - 消失（retract = true）：两端（神经元侧）先消失，
 *   可见线段从两端向中点收缩，直至在中点消失。
 */
function updateAnimatedEdgeGeometry(
  animatedEdge: AnimatedEdgeLine,
  positions: Map<string, THREE.Vector3>,
  progress: number,
  retract = false,
) {
  const source = positions.get(
    animatedEdge.edge.source,
  )

  const target = positions.get(
    animatedEdge.edge.target,
  )

  if (!source || !target) {
    return
  }

  const t = clamp(progress, 0, 1)

  const middle = source.clone().lerp(target, 0.5)

  let sourceStart = source
  let targetStart = target
  let sourceEnd: THREE.Vector3
  let targetEnd: THREE.Vector3

  if (retract) {
    /*
     * 消失：外端点从神经元位置向中点推进，
     * 连线贴着两个神经元先消失。
     */
    sourceStart = source.clone().lerp(middle, 1 - t)
    targetStart = target.clone().lerp(middle, 1 - t)
    sourceEnd = middle
    targetEnd = middle
  } else {
    // 建立：两端向中间生长
    sourceEnd = source.clone().lerp(middle, t)
    targetEnd = target.clone().lerp(middle, t)
  }

  updateLineGeometry(
    animatedEdge.sourceGeometry,
    sourceStart,
    sourceEnd,
  )

  updateLineGeometry(
    animatedEdge.targetGeometry,
    targetStart,
    targetEnd,
  )

  const visible = t > 0.001

  animatedEdge.sourceLine.visible = visible
  animatedEdge.targetLine.visible = visible
  animatedEdge.progress = t
}

function createAnimatedEdgeLine(
  edge: Edge,
  positions: Map<string, THREE.Vector3>,
  material: LineMaterial,
): AnimatedEdgeLine | undefined {
  const source = positions.get(edge.source)
  const target = positions.get(edge.target)

  if (!source || !target) {
    return undefined
  }

  const sourceGeometry = new LineGeometry()
  const targetGeometry = new LineGeometry()

  sourceGeometry.setPositions([
    source.x,
    source.y,
    source.z,
    source.x,
    source.y,
    source.z,
  ])

  targetGeometry.setPositions([
    target.x,
    target.y,
    target.z,
    target.x,
    target.y,
    target.z,
  ])

  /*
   * 每条连接使用独立的材质实例：
   * weight 同时驱动不透明度和粗细；
   * 粗细只绕现有 1.25 基准做 1.25–1.7 倍变化。
   */
  const opacity = edgeOpacity(edge.weight)
  const linewidth = edgeWidthFromWeight(edge.weight)

  const sourceMaterial = material.clone()
  sourceMaterial.opacity = opacity
  sourceMaterial.linewidth = linewidth
  sourceMaterial.resolution.copy(material.resolution)

  const targetMaterial = material.clone()
  targetMaterial.opacity = opacity
  targetMaterial.linewidth = linewidth
  targetMaterial.resolution.copy(material.resolution)

  const sourceLine = new Line2(
    sourceGeometry,
    sourceMaterial,
  )

  const targetLine = new Line2(
    targetGeometry,
    targetMaterial,
  )

  sourceLine.frustumCulled = false
  targetLine.frustumCulled = false
  sourceLine.visible = false
  targetLine.visible = false
  sourceLine.renderOrder = 0
  targetLine.renderOrder = 0

  return {
    key: getEdgeKey(edge),
    edge,
    sourceLine,
    targetLine,
    sourceGeometry,
    targetGeometry,
    sourceMaterial,
    targetMaterial,
    progress: 0,
    fromProgress: 0,
    toProgress: 1,
    animationStart: performance.now(),
  }
}

function disposeAnimatedEdgeLine(
  animatedEdge: AnimatedEdgeLine,
) {
  animatedEdge.sourceGeometry.dispose()
  animatedEdge.targetGeometry.dispose()
  animatedEdge.sourceMaterial.dispose()
  animatedEdge.targetMaterial.dispose()
}

export function NeuronScene({
  neuronIds,
  frame,
  sizes,
  positions,
  edges,
  extent,
  hasActivityData,
  resetSignal,
  transitionMs,
  onSelect,
  highlightNeuronIds,
  topNeuronIds,
  highlightColor,
}: NeuronSceneProps) {
  /*
   * 高亮集合内容键：Set 引用随父层渲染每帧变化，
   * 用内容键去重，播放期间高亮集合不变时
   * 不触发颜色/大小 effect 重放。
   */
  const highlightKey = useMemo(() => {
    const ids = Array.from(highlightNeuronIds ?? []).sort().join(',')
    const tops = Array.from(topNeuronIds ?? []).sort().join(',')
    return `${ids}|${tops}|${highlightColor ?? ''}`
  }, [highlightNeuronIds, topNeuronIds, highlightColor])

  const highlightActive =
    (highlightNeuronIds?.size ?? 0) > 0
  const containerRef =
    useRef<HTMLDivElement | null>(null)

  /*
   * 场景就绪标记：背景脑图谱加载 + 涟漪网络装配
   * 完成后才撤下加载遮罩，避免用户看到半成品
   * 渲染过程。
   */
  const [sceneReady, setSceneReady] = useState(false)

  /*
   * 连接/变色动画时长（0.75 × 帧间隔）。
   * 用 ref 持有，避免时长变化重建整个场景；
   * 渲染循环每帧读取最新值。
   */
  const transitionMsRef = useRef(
    transitionMs ?? EDGE_TRANSITION_MS,
  )
  transitionMsRef.current =
    transitionMs ?? EDGE_TRANSITION_MS

  const meshMapRef = useRef(
    new Map<string, THREE.Mesh>(),
  )

  const lineGroupRef =
    useRef<THREE.Group | null>(null)

  const lineMaterialRef =
    useRef<LineMaterial | null>(null)

  const animatedEdgesRef = useRef(
    new Map<string, AnimatedEdgeLine>(),
  )

  const colorAnimationStartRef = useRef(0)

  /*
   * AI 贡献高亮是否激活：渲染循环每帧读取，
   * 决定颜色动画是否同时驱动外壳/内核不透明度。
   */
  const highlightActiveRef = useRef(false)

  const colorFromRef = useRef(
    new Map<string, THREE.Color>(),
  )

  const colorToRef = useRef(
    new Map<string, THREE.Color>(),
  )

  const emissiveFromRef = useRef(
    new Map<string, number>(),
  )

  const emissiveToRef = useRef(
    new Map<string, number>(),
  )

  const scaleAnimationStartRef = useRef(0)

  const scaleFromRef = useRef(
    new Map<string, number>(),
  )

  const scaleToRef = useRef(
    new Map<string, number>(),
  )

  /*
   * 节点尺寸补偿系数：神经元块整体放大 f 倍时
   * （graphGroup.scale = f），单个神经元球尺寸保持
   * 不变——所有写入 mesh.scale 的位置都要乘上
   * 该系数（= 1 / f），读取时除以它。
   */
  const nodeScaleCompRef = useRef(1)

  const cameraRef =
    useRef<THREE.PerspectiveCamera | null>(null)

  const controlsRef =
    useRef<OrbitControls | null>(null)

  /*
   * 当前相机位姿（目标点 / 方向 / 距离），
   * 供「重置视角」恢复。
   */
  const cameraPoseRef = useRef<CameraPose | null>(null)

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    // 场景重建（数据切换）时重新挂上加载遮罩
    setSceneReady(false)

    // 在 effect 开始时保存当前 Map，供清理函数使用
    const animatedEdges = animatedEdgesRef.current

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#000000')

    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)

    /*
     * 神经元簇局部几何中心与外接半径，
     * 用于初始怼近机位与缩放范围。
     */
    const localBounds = new THREE.Box3()
    positions.forEach((point) =>
      localBounds.expandByPoint(point),
    )

    const localCenter = localBounds.getCenter(
      new THREE.Vector3(),
    )

    let localRadius = 1
    positions.forEach((point) => {
      localRadius = Math.max(
        localRadius,
        point.distanceTo(localCenter),
      )
    })

    /*
     * 初始机位：网络水平摆放后从斜上方俯视，
     * 同时看到网络平面与背景脑模型。
     */
    const initialDirection = new THREE.Vector3(
      0.3,
      0.85,
      0.4,
    ).normalize()

    const camera = new THREE.PerspectiveCamera(
      42,
      width / height,
      0.05,
      1000,
    )

    camera.position
      .copy(localCenter)
      .add(
        initialDirection
          .clone()
          .multiplyScalar(localRadius * 1.5),
      )
    cameraRef.current = camera

    cameraPoseRef.current = {
      target: localCenter.clone(),
      direction: initialDirection.clone(),
      distance: localRadius * 1.5,
    }

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })

    const pixelRatio = () =>
      Math.min(window.devicePixelRatio, 1.5)

    renderer.setPixelRatio(pixelRatio())
    renderer.setSize(width, height, false)
    renderer.outputColorSpace =
      THREE.SRGBColorSpace

    renderer.toneMapping =
      THREE.ACESFilmicToneMapping

    renderer.toneMappingExposure = 1.1
    renderer.setClearColor('#000000', 1)

    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(
      camera,
      renderer.domElement,
    )

    /*
     * 只允许绕簇中心旋转与缩放，
     * 取消拖拽平移。
     */
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.enablePan = false
    controls.minDistance = localRadius * 0.6
    // 允许拉远看到背景整脑
    controls.maxDistance = Math.max(localRadius * 8, 80)
    controls.target.copy(localCenter)

    controlsRef.current = controls

  const ambientLight = new THREE.AmbientLight(
    '#ffffff',
    1.25,
  )

  const keyLight = new THREE.DirectionalLight(
    '#ffffff',
    2.6,
  )

  const blueLight = new THREE.PointLight(
    '#4ea8ff',
    22,
    24,
  )

  const redLight = new THREE.PointLight(
    '#ff4c5f',
    18,
    22,
  )

    keyLight.position.set(3, 6, 10)
    blueLight.position.set(-7, 4, 8)
    redLight.position.set(7, -4, 7)

    scene.add(
      ambientLight,
      keyLight,
      blueLight,
      redLight,
    )

    /*
     * 背景层：Allen 小鼠脑图谱（整脑 + mPFC）。
     *
     * 摆放方式：神经元网络为三维点云（x = 左右，y = 前后，
     * z = 功能纵深），graphGroup 绕 X 轴旋转 -90° 后
     * 局部 (x, y, z) → 世界 (x, z, -y)，即功能纵深
     * 映射到背腹方向；脑模型保持自然方位（背侧朝上），
     * mPFC 中心对准点云中心（原点）。
     *
     * 缩放：由 containment 适配计算决定——迭代放大
     * 图谱直到每个神经元球完全位于 mPFC 体积之内。
     * 背景均 depthWrite: false + 负 renderOrder，
     * 神经元与连接永不被遮挡。
     */
    const bgGeometries: THREE.BufferGeometry[] = []
    const bgMaterials: THREE.Material[] = []
    let bgDisposed = false
    let bgMpfcMaterial: THREE.MeshPhysicalMaterial | null =
      null

    /*
     * 背景层除整脑 + mPFC 外，合并首页的全量脑区结构
     * （大脑皮层 / 小脑 / 脑干 / 海马 / 杏仁核亚区等
     * 共 12 个）。透明度以工作台标准为准：mPFC 保持
     * 0.6 原木色常驻显色，其余结构统一按地标档
     * （0.1 中性灰）处理，仅作空间参照——
     * 不注册 userData.structureId（静态、不可点击），
     * 不参与神经元贴附射线。
     */
    const bgStructureIds = Object.keys(
      ALLEN_STRUCTURE_MODEL_URLS,
    )

    void loadAtlasModels(bgStructureIds)
      .then(({ brainModel, structureModels }) => {
        if (bgDisposed) {
          // effect 已清理：直接释放加载到的几何体
          brainModel.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.geometry.dispose()
            }
          })
          structureModels.forEach((model) =>
            model.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.geometry.dispose()
              }
            }),
          )
          return
        }

        const mpfcIndex = bgStructureIds.indexOf('mpfc')
        const mpfcModel = structureModels[mpfcIndex]
        const landmarkModels = structureModels.filter(
          (_, index) => index !== mpfcIndex,
        )

        /*
         * 背景脑壳：FrontSide 单面 + 较高不透明度 +
         * 在网络之后渲染（renderOrder 4）。
         * 相机在脑外：壳罩住网络 → 明确"在外面"；
         * 相机进入脑内：正面被剔除、壳消失 →
         * 明确"在里面"。解决双面透明壳层层叠叠、
         * 内外难分的问题。
         */
        const brainMaterial = createBrainShellMaterial(
          0.35,
          false,
        )

        /*
         * mPFC 壳：原木色淡染（#DEB887，与首页统一）、
         * 不透明度 0.6——保留可辨识的区域色调，但
         * 不遮挡内部神经元的表面色（透明叠加、
         * 不写深度、菲涅尔正视处更透）。
         * 双侧完整（不裁切），单面渲染。
         */
        const mpfcMaterial = createStructureMaterial({
          color: '#DEB887',
          opacity: 0.6,
          highlight: true,
          clipped: false,
        })
        /* 正视处更透：神经元表面色优先可见 */
        setSurfaceMinOpacity(mpfcMaterial, 0.42)

        /*
         * 地标脑区壳：极低透明度中性灰，仅作空间参照。
         * 单面渲染、不写深度、renderOrder 与脑壳同层；
         * 不注册 userData.structureId（不可点击），
         * 不加入 mpfcMeshes（不参与神经元贴附射线）。
         */
        const landmarkMaterial = createStructureMaterial({
          color: '#9aa0a6',
          opacity: 0.1,
          highlight: false,
          clipped: false,
        })

        bgMaterials.push(
          brainMaterial,
          mpfcMaterial,
          landmarkMaterial,
        )
        bgMpfcMaterial = mpfcMaterial

        brainModel.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.material = brainMaterial
            child.renderOrder = 4
            bgGeometries.push(child.geometry)
          }
        })

        mpfcModel.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.material = mpfcMaterial
            child.renderOrder = 5
            bgGeometries.push(child.geometry)
          }
        })

        landmarkModels.forEach((model) => {
          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.material = landmarkMaterial
              child.renderOrder = 4
              bgGeometries.push(child.geometry)
            }
          })
        })

        const { wrapper, content } =
          createNormalizedAtlas(brainModel)
        content.add(mpfcModel)
        landmarkModels.forEach((model) =>
          content.add(model),
        )
        wrapper.updateMatrixWorld(true)

        /*
         * mPFC 完整包围盒（归一化图谱坐标）：
         * 中心对准点云中心（原点），缩放由内部适配
         * 计算决定。
         */
        const mpfcBounds = new THREE.Box3().setFromObject(
          mpfcModel,
        )
        const mpfcCenter = mpfcBounds.getCenter(
          new THREE.Vector3(),
        )
        const mpfcSize = mpfcBounds.getSize(
          new THREE.Vector3(),
        )

        /*
         * mPFC 内部适配计算（位置标准）：
         *
         * 空间位置数据升级为三方向后，神经元点云不再
         * 贴附壳面，而是整体放入 mPFC 体积内部。
         * 把 mPFC 三角面烘焙到归一化图谱坐标建 BVH，
         * 从包围盒比例出发迭代放大背景图谱，直到每个
         * 神经元球（半径 = nodeRadius）都在闭合网格
         * 内部且到表面净余量充足——所有神经元完全
         * 位于 mPFC 脑区之内。
         *
         * 坐标关系：graphGroup 绕 X 轴旋转 -90°，
         * 局部 (x, y, z) → 世界 (x, z, -y)。
         */
        let sampler: MeshSampler | null = null

        mpfcModel.traverse((child) => {
          if (!sampler && child instanceof THREE.Mesh) {
            sampler = createMeshSampler(child)
          }
        })

        const cloudPoints: THREE.Vector3[] = []

        positions.forEach((point) => {
          cloudPoints.push(
            new THREE.Vector3(point.x, point.z, -point.y),
          )
        })

        const fit = sampler
          ? fitCloudInsideMesh(
              sampler,
              mpfcCenter,
              mpfcSize,
              cloudPoints,
              nodeRadius,
            )
          : null

        /*
         * 适配失败（网格采样缺失）时回退到旧的
         * footprint 启发式，保证场景仍可渲染。
         *
         * 注：旧适配（fitCloudInsideMesh）的 scale 此处
         * 只用于决定背景整脑在画面中的显示大小；
         * 神经元块的位置与放大由下方的中心适配决定。
         */
        const footprint = Math.max(
          Math.min(mpfcSize.x * 0.6, mpfcSize.z * 0.9),
          0.8,
        )
        const inv =
          fit && fit.allInside
            ? fit.scale
            : DISPLAY_SIZE / (footprint * 0.86)

        if (fit && !fit.allInside) {
          console.warn(
            'mPFC 内部适配未完全收敛，回退到 footprint 启发式。',
            fit,
          )
        }

        /*
         * 神经元块中心适配（位置标准）：
         *
         * 摆放中心选在 mPFC 脑区中心（包围盒中心位于
         * 组织内时直接使用，否则取离中心最近的内部点），
         * 神经元块以该中心为基准整体均匀放大，尽量铺满
         * mPFC 区域——横向 / 纵向 / 竖向任一方向都不
         * 穿模：二分搜索最大倍数，使每个放大后的神经元
         * 都在闭合网格内部且净余量充足。
         *
         * 注意：放大的是神经元块的位置分布（节点间距），
         * 单个神经元球尺寸不变——由 nodeScaleCompRef
         * 反向补偿节点缩放。
         */
        const cloudBox = new THREE.Box3()

        cloudPoints.forEach((point) =>
          cloudBox.expandByPoint(point),
        )

        const cloudCenter = cloudBox.getCenter(
          new THREE.Vector3(),
        )
        const cloudSpan = cloudBox.getSize(
          new THREE.Vector3(),
        )

        /*
         * 净余量要求（网格局部单位）。
         *
         * 实测权衡（__fitDebug 档位诊断）：mPFC 中线附近
         * 层厚 ≈ 0.0156 局部单位，小于节点球直径
         * （2 × nodeRadius / inv ≈ 0.0166）——整球不出界
         * 的标准在解剖上不可能满足（可行倍数 ≈ 0.003，
         * 网络会缩成一点）。因此采用「节点中心严格位于
         * 脑区并集内 + 少量壁面余量（0.18 × 节点半径）」
         * 的标准：轮廓不穿模，可行倍数 ≈ 0.144
         * （graphScale ≈ 1.53），pivot 恰好是脑区中心。
         */
        /*
         * 净余量要求（网格局部单位）：0.18 × 节点基准
         * 显示半径（nodeRadius × 0.9），随节点放大
         * 等比例提高，保证轮廓不穿模。
         */
        const requiredClearanceLocal =
          (nodeRadius * NEURON_SCALE_MIN * 0.18) / inv

        /*
         * 摆放中心上移：mPFC 高度的 5%（世界单位），
         * 即神经元块在脑区内稍微偏上。上移后的点
         * 作为新的适配中心，不穿模约束随之重新求解。
         */
        const shiftUpWorld = mpfcSize.y * inv * 0.05
        const fitCenter = mpfcCenter.clone()
        fitCenter.y += shiftUpWorld / inv

        const centerFit = sampler
          ? fitCloudScaleAtPivot(
              sampler,
              fitCenter,
              mpfcSize,
              cloudPoints,
              requiredClearanceLocal,
            )
          : null

        /*
         * 诊断（?fitDebug=1 时启用）：不同净余量标准下
         * 可行的最大放大倍数，用于权衡「严格不穿模」
         * 与「铺满 mPFC」。
         */
        if (
          sampler &&
          window.location.search.includes('fitDebug')
        ) {
          const levels = [
            requiredClearanceLocal,
            0.004,
            0.0015,
            0.0005,
            0,
          ]
          const table = levels.map((level) => {
            const r = fitCloudScaleAtPivot(
              sampler as MeshSampler,
              fitCenter,
              mpfcSize,
              cloudPoints,
              level,
            )
            return {
              required: level,
              ratio: r.ratio,
              graphScale: r.ratio * inv,
              pivotOffset: r.pivotOffsetFromCenter,
              pivotIsCenter: r.pivotIsCenter,
            }
          })
          ;(
            window as unknown as Record<string, unknown>
          ).__fitDebug = table
        }

        /*
         * graphScale = 点云世界放大倍数：
         * 网格局部 = pivot + (q − 云中心) × ratio，
         * 世界 = (网格局部 − pivot) × inv，
         * 故世界放大倍数 graphScale = ratio × inv。
         * 中心适配失败（ratio ≈ 0）时回退：不放大、
         * 沿用旧锚点，保证场景仍可渲染。
         */
        const centerFitOk =
          centerFit !== null && centerFit.ratio > 1e-4
        const graphScale = centerFitOk
          ? centerFit.ratio * inv
          : 1

        if (centerFit && !centerFitOk) {
          console.warn(
            'mPFC 中心适配未找到可行放大倍数，回退到旧锚点。',
            centerFit,
          )
        }

        /*
         * 调试探针：把适配结果挂到 window，
         * 供一次性验证脚本读取（不影响渲染）。
         */
        ;(window as unknown as Record<string, unknown>).__mpfcFit =
          {
            backgroundScale: inv,
            legacyFit: fit
              ? {
                  scale: fit.scale,
                  anchor: {
                    x: fit.anchor.x,
                    y: fit.anchor.y,
                    z: fit.anchor.z,
                  },
                  iterations: fit.iterations,
                  minClearance: fit.minClearance,
                  allInside: fit.allInside,
                }
              : null,
            centerFit: centerFit
              ? {
                  ratio: centerFit.ratio,
                  pivot: {
                    x: centerFit.pivot.x,
                    y: centerFit.pivot.y,
                    z: centerFit.pivot.z,
                  },
                  pivotIsCenter: centerFit.pivotIsCenter,
                  pivotOffsetFromCenter:
                    centerFit.pivotOffsetFromCenter,
                  bboxRatio: centerFit.bboxRatio,
                  minClearance: centerFit.minClearance,
                  iterations: centerFit.iterations,
                  feasible: centerFit.feasible,
                }
              : null,
            graphScale,
            nodeRadius,
            shiftUpWorld,
            requiredClearanceLocal,
            mpfcCenter: {
              x: mpfcCenter.x,
              y: mpfcCenter.y,
              z: mpfcCenter.z,
            },
            mpfcSize: {
              x: mpfcSize.x,
              y: mpfcSize.y,
              z: mpfcSize.z,
            },
            cloudCenter: {
              x: cloudCenter.x,
              y: cloudCenter.y,
              z: cloudCenter.z,
            },
            cloudSpan: {
              x: cloudSpan.x,
              y: cloudSpan.y,
              z: cloudSpan.z,
            },
          }

        const background = new THREE.Group()
        background.add(wrapper)
        background.scale.setScalar(inv)
        /*
         * 以 mPFC 中心适配的 pivot 对准点云中心；
         * 适配失败时回退到旧锚点 / 包围盒中心。
         */
        const anchor = centerFitOk
          ? (centerFit as NonNullable<typeof centerFit>).pivot
          : fit && fit.allInside
            ? fit.anchor
            : mpfcCenter

        background.position.set(
          -anchor.x * inv,
          -anchor.y * inv,
          -anchor.z * inv,
        )
        scene.add(background)

        /*
         * 神经元块整体放大并重新对中：
         * world = graphScale × R × (local − 云中心)，
         * 即 graphGroup.scale = graphScale 且
         * graphGroup.position = −graphScale × 云中心。
         * 节点球尺寸由 nodeScaleCompRef 补偿保持不变。
         */
        graphGroup.scale.setScalar(graphScale)
        graphGroup.position.set(
          -graphScale * cloudCenter.x,
          -graphScale * cloudCenter.y,
          -graphScale * cloudCenter.z,
        )

        nodeScaleCompRef.current = 1 / graphScale
        meshes.forEach((mesh) => {
          mesh.scale.multiplyScalar(1 / graphScale)
        })

        /*
         * 相机随神经元块的整体尺寸重新取景：
         * 目标点为放大后的云中心（世界原点），
         * 距离按世界半径（localRadius × graphScale）设定。
         */
        const worldRadius = localRadius * graphScale

        controls.target.set(0, 0, 0)
        controls.minDistance = worldRadius * 0.6
        controls.maxDistance = Math.max(
          worldRadius * 8,
          80,
        )

        camera.position
          .set(0, 0, 0)
          .add(
            initialDirection
              .clone()
              .multiplyScalar(worldRadius * 1.5),
          )
        controls.update()

        cameraPoseRef.current = {
          target: new THREE.Vector3(0, 0, 0),
          direction: initialDirection.clone(),
          distance: worldRadius * 1.5,
        }

        scene.updateMatrixWorld(true)

        /* 背景图谱装配完毕，撤下加载遮罩 */
        setSceneReady(true)
      })
      .catch((error) => {
        console.warn(
          '神经元场景背景脑模型加载失败。',
          error,
        )

        /* 加载失败也要撤下遮罩，避免永久卡住 */
        setSceneReady(true)
      })

    /*
     * 神经元网络三维摆放：graphGroup 绕 X 轴旋转 -90°，
     * 局部 (x, y, z) 映射为世界 (x, z, -y)——
     * 功能纵深（局部 z）落到世界背腹方向。
     * 节点 / 连接 / 动画逻辑不变。
     */
    const graphGroup = new THREE.Group()
    graphGroup.rotation.x = -Math.PI / 2
    scene.add(graphGroup)

    const lineGroup = new THREE.Group()
    graphGroup.add(lineGroup)
    lineGroupRef.current = lineGroup

    const lineMaterial = new LineMaterial({
      color: 0xffffff,
      linewidth: 1.25,
      transparent: true,
      opacity: 0.8,
      depthTest: true,
      depthWrite: false,
      worldUnits: false,
    })

    lineMaterial.resolution.set(width, height)
    lineMaterialRef.current = lineMaterial

    const nodeRadius =
      calculateNodeRadius(positions, sizes) *
      FIXED_NODE_SCALE

    const bumpTexture = createBumpTexture()

    const sphereGeometry = new THREE.SphereGeometry(
      nodeRadius,
      24,
      16,
    )

    /*
     * 内核实心球：每个神经元球内部套一颗不透明实心球，
     * 半径恒为外球的 30%。作为外球的子节点挂载，
     * 自动继承外球的缩放动画，比例恒定不变。
     */
    const innerGeometry = new THREE.SphereGeometry(
      nodeRadius * 0.3,
      20,
      14,
    )

    const meshes = new Map<string, THREE.Mesh>()

    neuronIds.forEach((id) => {
      const position = positions.get(id)

      if (!position) {
        return
      }

      /*
       * 微透光外壳：transparent + 固定 40% 不透明度——
       * 表面仍然清晰承载兴奋度颜色，同时让内部实心
       * 内核（30% 半径）稳定可见。
       * depthWrite 保留，避免半透明球之间排序穿帮。
       */
      const material =
        new THREE.MeshPhysicalMaterial({
          color: MISSING_ACTIVITY_COLOR,
          transparent: true,
          opacity: 0.4,
          roughness: 0.88,
          metalness: 0.03,
          clearcoat: 0.08,
          clearcoatRoughness: 0.8,
          bumpMap: bumpTexture,
          bumpScale: 0.045,
          emissive: '#000000',
          emissiveIntensity: 0,
          depthTest: true,
          depthWrite: true,
        })

      const mesh = new THREE.Mesh(
        sphereGeometry,
        material,
      )

      /*
       * 内核：实心不透明（transparent 关闭、opacity 1），
       * 材质参数与外球一致，保证光照下色彩观感统一；
       * 颜色在变色动画中逐帧与外球同步。
       */
      const innerMaterial =
        new THREE.MeshPhysicalMaterial({
          color: MISSING_ACTIVITY_COLOR,
          roughness: 0.88,
          metalness: 0.03,
          clearcoat: 0.08,
          clearcoatRoughness: 0.8,
          depthTest: true,
          depthWrite: true,
        })

      const innerMesh = new THREE.Mesh(
        innerGeometry,
        innerMaterial,
      )

      mesh.add(innerMesh)

      mesh.position.copy(position)
      /*
       * 初始尺寸 = 基准 0.9 倍（信号域）× 整体放大补偿。
       * 动态大小变化范围 0.9–2.6 倍由
       * neuronScaleFromSignal 驱动。
       */
      mesh.scale.setScalar(
        nodeScaleCompRef.current * NEURON_SCALE_MIN,
      )
      mesh.userData.neuronId = id
      mesh.userData.inner = innerMesh
      mesh.renderOrder = 1

      meshes.set(id, mesh)
      graphGroup.add(mesh)
    })

    meshMapRef.current = meshes

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    let pointerStart = {
      x: 0,
      y: 0,
    }

    const setPointer = (
      event: PointerEvent,
    ) => {
      const bounds =
        renderer.domElement.getBoundingClientRect()

      if (bounds.width <= 0 || bounds.height <= 0) {
        return
      }

      pointer.x =
        ((event.clientX - bounds.left) /
          bounds.width) *
          2 -
        1

      pointer.y =
        -(
          ((event.clientY - bounds.top) /
            bounds.height) *
            2 -
          1
        )

      raycaster.setFromCamera(pointer, camera)
    }

    const getSelectedNeuronId = () => {
      const intersections =
        raycaster.intersectObjects(
          Array.from(meshes.values()),
          false,
        )

      if (intersections.length === 0) {
        return null
      }

      return String(
        intersections[0].object.userData.neuronId,
      )
    }

    const handlePointerDown = (
      event: PointerEvent,
    ) => {
      pointerStart = {
        x: event.clientX,
        y: event.clientY,
      }
    }

    const handlePointerUp = (
      event: PointerEvent,
    ) => {
      const movement = Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      )

      if (movement > 5) {
        return
      }

      setPointer(event)
      onSelect(getSelectedNeuronId())
    }

    const handlePointerMove = (
      event: PointerEvent,
    ) => {
      setPointer(event)

      renderer.domElement.style.cursor =
        getSelectedNeuronId()
          ? 'pointer'
          : 'grab'
    }

    renderer.domElement.addEventListener(
      'pointerdown',
      handlePointerDown,
    )

    renderer.domElement.addEventListener(
      'pointerup',
      handlePointerUp,
    )

    renderer.domElement.addEventListener(
      'pointermove',
      handlePointerMove,
    )

    let animationId = 0

const animate = (time: number) => {
  /*
   * 每条连接单独维护动画时间。
   *
   * animationStart === null：
   * 表示这条连接已经完成动画，后续保持当前状态，
   * 不会因为其他连接发生变化而重新播放。
   */
  animatedEdges.forEach((animatedEdge, key) => {
    if (animatedEdge.animationStart === null) {
      return
    }

    const animationProgress = easeInOutCubic(
      (time - animatedEdge.animationStart) /
        transitionMsRef.current,
    )

    const currentProgress = THREE.MathUtils.lerp(
      animatedEdge.fromProgress,
      animatedEdge.toProgress,
      animationProgress,
    )

    updateAnimatedEdgeGeometry(
      animatedEdge,
      positions,
      currentProgress,
      /*
       * toProgress === 0 表示连接正在消失：
       * 两端（神经元侧）先消失，向中点收缩。
       */
      animatedEdge.toProgress === 0,
    )

    if (animationProgress < 1) {
      return
    }

    /*
     * 连接消失：
     * 进度从 1 变成 0，动画完成后删除线段。
     */
    if (animatedEdge.toProgress === 0) {
      lineGroup.remove(
        animatedEdge.sourceLine,
        animatedEdge.targetLine,
      )

      disposeAnimatedEdgeLine(animatedEdge)
      animatedEdges.delete(key)

      return
    }

    /*
     * 连接建立：
     * 进度从 0 变成 1，动画完成后固定为完整连接。
     */
    animatedEdge.progress = 1
    animatedEdge.fromProgress = 1
    animatedEdge.toProgress = 1
    animatedEdge.animationStart = null
  })

  const colorStart =
    colorAnimationStartRef.current

      if (colorStart > 0) {
        const progress = easeInOutCubic(
          (time - colorStart) /
            transitionMsRef.current,
        )

        meshes.forEach((mesh, id) => {
          const from =
            colorFromRef.current.get(id)

          const to =
            colorToRef.current.get(id)

          const fromIntensity =
            emissiveFromRef.current.get(id)

          const toIntensity =
            emissiveToRef.current.get(id)

          if (
            !from ||
            !to ||
            fromIntensity === undefined ||
            toIntensity === undefined
          ) {
            return
          }

          const material =
            mesh.material as THREE.MeshBasicMaterial

          material.color.lerpColors(
            from,
            to,
            progress,
          )

          /* 内核颜色与外球保持同步 */
          const innerMesh = mesh.userData.inner as
            | THREE.Mesh
            | undefined

          if (innerMesh) {
            ;(
              innerMesh.material as THREE.MeshPhysicalMaterial
            ).color.copy(material.color)
          }

          /*
           * AI 贡献高亮：非成员整体压暗（外壳 + 内核），
           * 成员 / Top 神经元保持全亮——这是高亮模式
           * 唯一的视觉通道，必须真实作用于不透明度。
           * 非高亮模式外壳固定 40% 不透明度、内核实心，
           * 兴奋度只经颜色与内核大小呈现。
           */
          const intensity = THREE.MathUtils.lerp(
            fromIntensity,
            toIntensity,
            progress,
          )

          if (highlightActiveRef.current) {
            material.opacity = Math.max(0.05, intensity * 0.5)

            if (innerMesh) {
              const innerMaterial =
                innerMesh.material as THREE.MeshPhysicalMaterial
              innerMaterial.transparent = true
              innerMaterial.opacity = Math.max(0.04, intensity)
            }
          } else {
            material.opacity = 0.4

            if (innerMesh) {
              const innerMaterial =
                innerMesh.material as THREE.MeshPhysicalMaterial
              innerMaterial.transparent = false
              innerMaterial.opacity = 1
            }
          }
        })

        if (progress >= 1) {
          colorAnimationStartRef.current = 0
        }
      }

      /*
       * 神经元大小动画：只由行为贴合分（或兜底平滑活动）
       * 驱动；与颜色共用同一过渡时长，避免引入新节奏。
       */
      const scaleStart =
        scaleAnimationStartRef.current

      if (scaleStart > 0) {
        const progress = easeInOutCubic(
          (time - scaleStart) /
            transitionMsRef.current,
        )

        meshes.forEach((mesh, id) => {
          const from = scaleFromRef.current.get(id)
          const to = scaleToRef.current.get(id)

          if (from === undefined || to === undefined) {
            return
          }

          /*
           * 信号驱动的目标尺寸 × 整体放大补偿系数，
           * 保证神经元块放大后单个节点尺寸不变。
           */
          mesh.scale.setScalar(
            THREE.MathUtils.lerp(from, to, progress) *
              nodeScaleCompRef.current,
          )
        })

        if (progress >= 1) {
          scaleAnimationStartRef.current = 0
        }
      }

      // 背景层呼吸：mPFC 壳（与其他视图同节奏）
      if (bgMpfcMaterial) {
        bgMpfcMaterial.emissiveIntensity =
          0.22 + Math.sin(time * 0.0016) * 0.08
      }

      controls.update()
      renderer.render(scene, camera)

      animationId =
        window.requestAnimationFrame(animate)
    }

    animationId =
      window.requestAnimationFrame(animate)

    const resizeObserver = new ResizeObserver(
      () => {
        const nextWidth = Math.max(
          container.clientWidth,
          1,
        )

        const nextHeight = Math.max(
          container.clientHeight,
          1,
        )

        camera.aspect =
          nextWidth / nextHeight

        camera.updateProjectionMatrix()

        renderer.setPixelRatio(pixelRatio())
        renderer.setSize(
          nextWidth,
          nextHeight,
          false,
        )

        lineMaterial.resolution.set(
          nextWidth,
          nextHeight,
        )

        // 同步更新每条连接独立材质的分辨率
        animatedEdgesRef.current.forEach(
          (animatedEdge) => {
            animatedEdge.sourceMaterial.resolution.set(
              nextWidth,
              nextHeight,
            )
            animatedEdge.targetMaterial.resolution.set(
              nextWidth,
              nextHeight,
            )
          },
        )
      },
    )

    resizeObserver.observe(container)

    return () => {
      window.cancelAnimationFrame(animationId)
      resizeObserver.disconnect()

      // 背景脑模型资源释放
      bgDisposed = true
      bgGeometries.forEach((geometry) =>
        geometry.dispose(),
      )
      bgMaterials.forEach((material) =>
        material.dispose(),
      )
      bgMpfcMaterial = null

      renderer.domElement.removeEventListener(
        'pointerdown',
        handlePointerDown,
      )

      renderer.domElement.removeEventListener(
        'pointerup',
        handlePointerUp,
      )

      renderer.domElement.removeEventListener(
        'pointermove',
        handlePointerMove,
      )

      /*
       * 清理当前 effect 创建的连接。
       * 使用局部 animatedEdges，避免 Hooks 警告。
       */
      animatedEdges.forEach((animatedEdge) => {
        lineGroup.remove(
          animatedEdge.sourceLine,
          animatedEdge.targetLine,
        )

        disposeAnimatedEdgeLine(animatedEdge)
      })

      animatedEdges.clear()

      meshes.forEach((mesh) => {
        const material =
          mesh.material as THREE.Material

        material.dispose()

        const innerMesh = mesh.userData.inner as
          | THREE.Mesh
          | undefined

        if (innerMesh) {
          ;(innerMesh.material as THREE.Material).dispose()
        }
      })

      meshMapRef.current.clear()
      lineGroup.clear()

      sphereGeometry.dispose()
      innerGeometry.dispose()
      lineMaterial.dispose()

      controls.dispose()
      renderer.renderLists.dispose()
      renderer.dispose()

      if (
        renderer.domElement.parentElement ===
        container
      ) {
        container.removeChild(
          renderer.domElement,
        )
      }

      if (lineGroupRef.current === lineGroup) {
        lineGroupRef.current = null
      }

      if (
        lineMaterialRef.current ===
        lineMaterial
      ) {
        lineMaterialRef.current = null
      }

      cameraRef.current = null
      controlsRef.current = null
      cameraPoseRef.current = null
    }
  }, [
    neuronIds,
    onSelect,
    positions,
    sizes,
  ])

  /*
   * 更新连接关系：
   *
   * 1. 当前帧仍存在的连接：保持原状，不重新开始动画；
   * 2. 当前帧消失的连接：从两端向中间消退；
   * 3. 当前帧新增的连接：从两端向中间汇合；
   * 4. 所有发生变化的连接共享同一个开始时间。
   */
useEffect(() => {
  const lineGroup = lineGroupRef.current
  const lineMaterial =
    lineMaterialRef.current

  if (!lineGroup || !lineMaterial) {
    return
  }

  const animatedEdges = animatedEdgesRef.current
  const nextKeys = new Set(
    edges.map(getEdgeKey),
  )
  const now = performance.now()

  /*
   * 处理前一帧存在、当前帧消失的连接。
   *
   * 例如：
   * 前一帧：n11 -> n23
   * 当前帧：不存在 n11 -> n23
   *
   * 连接两端会从 source 和 target 两侧向中间消退。
   */
  animatedEdges.forEach(
    (animatedEdge, key) => {
      if (
        !nextKeys.has(key) &&
        animatedEdge.toProgress !== 0
      ) {
        animatedEdge.fromProgress =
          animatedEdge.progress

        animatedEdge.toProgress = 0
        animatedEdge.animationStart = now
      }
    },
  )

  edges.forEach((edge) => {
    const key = getEdgeKey(edge)
    const existing = animatedEdges.get(key)

    /*
     * 前一帧没有、当前帧新增的连接。
     *
     * 初始进度为 0：
     * source 端和 target 端分别从两个神经元向中间延伸。
     */
    if (!existing) {
      const created = createAnimatedEdgeLine(
        edge,
        positions,
        lineMaterial,
      )

      if (!created) {
        return
      }

      created.progress = 0
      created.fromProgress = 0
      created.toProgress = 1
      created.animationStart = now

      animatedEdges.set(key, created)

      lineGroup.add(
        created.sourceLine,
        created.targetLine,
      )

      return
    }

    /*
     * 前一帧和当前帧都存在的连接。
     *
     * 这里不修改 progress，
     * 不修改 animationStart，
     * 因此 n11 -> n23 会保持原状，不会重新播放动画。
     * 仅同步最新 weight 对应的不透明度。
     */
    existing.edge = edge

    const opacity = edgeOpacity(edge.weight)
    const linewidth = edgeWidthFromWeight(edge.weight)

    existing.sourceMaterial.opacity = opacity
    existing.targetMaterial.opacity = opacity
    existing.sourceMaterial.linewidth = linewidth
    existing.targetMaterial.linewidth = linewidth

    /*
     * 如果连接正在回收过程中又重新出现，
     * 则从当前进度反向恢复到完整连接。
     */
    if (
      existing.toProgress === 0 &&
      existing.progress < 1
    ) {
      existing.fromProgress =
        existing.progress

      existing.toProgress = 1
      existing.animationStart = now
    }
  })
}, [edges, positions])

  /*
   * 更新神经元颜色（对调后新标准）：
   * 色相 = 当前状态色系，深浅 = 兴奋程度（钙活动值）。
   * 当前颜色作为起点，目标颜色作为终点。
   */
  useEffect(() => {
    const meshes = meshMapRef.current

    highlightActiveRef.current = highlightActive

    if (meshes.size === 0) {
      return
    }

    const stateKey =
      frame.behavior || frame.sleepStage || ''

    const white = new THREE.Color(0xffffff)
    const moduleColor =
      highlightActive && highlightColor
        ? new THREE.Color(highlightColor)
        : null

    const colorFrom = new Map<
      string,
      THREE.Color
    >()

    const colorTo = new Map<
      string,
      THREE.Color
    >()

    const emissiveFrom = new Map<
      string,
      number
    >()

    const emissiveTo = new Map<
      string,
      number
    >()

    let hasChanged = false

    meshes.forEach((mesh, id) => {
      const material =
        mesh.material as THREE.MeshBasicMaterial

      const currentColor =
        material.color.clone()

      const value = hasActivityData
        ? frame.values[id] ?? null
        : null

      const targetColor = new THREE.Color(
        stateActivityColor(stateKey, value, extent),
      )

      /*
       * AI 贡献模块高亮层：
       * 成员 → 模块色（Top 3 向白偏移 45%、不透明度 1.0；
       * 普通成员偏移 12%、不透明度 0.82）；
       * 非成员 → 保持状态活动色，降到 0.07 弱显示，
       * 只淡化不隐藏。
       */
      let targetIntensity: number
      if (highlightActive) {
        if (highlightNeuronIds?.has(id)) {
          const isTop =
            topNeuronIds?.has(id) ?? false
          targetColor.copy(
            moduleColor ?? targetColor,
          )
          targetColor.lerp(
            white,
            isTop ? 0.45 : 0.12,
          )
          targetIntensity = isTop ? 1.0 : 0.82
        } else {
          targetIntensity = 0.07
        }
      } else {
        targetIntensity =
          value === null
            ? 0.2
            : 0.35 +
              clamp(
                Math.abs(value) /
                  Math.max(extent, 0.0001),
                0,
                1,
              ) *
                1.8
      }

      const currentIntensity =
        material.opacity

      colorFrom.set(id, currentColor)
      colorTo.set(id, targetColor)
      emissiveFrom.set(id, currentIntensity)
      emissiveTo.set(id, targetIntensity)

      if (
        colorDistance(
          currentColor,
          targetColor,
        ) > 0.001 ||
        Math.abs(
          currentIntensity - targetIntensity,
        ) > 0.01
      ) {
        hasChanged = true
      }
    })

    colorFromRef.current = colorFrom
    colorToRef.current = colorTo
    emissiveFromRef.current = emissiveFrom
    emissiveToRef.current = emissiveTo

    colorAnimationStartRef.current = hasChanged
      ? performance.now()
      : 0
  }, [
    extent,
    frame,
    hasActivityData,
    highlightKey,
    highlightActive,
  ])

  /*
   * 更新神经元大小（对调后新标准）：
   * 大小 = 兴奋程度，与颜色深浅共用同一刻度
   * （(值+量程)/(2×量程) → 0.9–2.6 倍），
   * 保证「浅+小=抑制、深+大=兴奋」读图自洽。
   * 大小只新增一个数据通道，不改变颜色/连线/位置逻辑。
   */
  useEffect(() => {
    const meshes = meshMapRef.current

    if (meshes.size === 0) {
      return
    }

    const scaleFrom = new Map<string, number>()
    const scaleTo = new Map<string, number>()

    let hasChanged = false

    meshes.forEach((mesh, id) => {
      const value = hasActivityData
        ? frame.values[id] ?? null
        : null

      const activitySignal =
        value === null
          ? null
          : clamp(
              (value + Math.max(extent, 0.0001)) /
                (Math.max(extent, 0.0001) * 2),
              0,
              1,
            )

      const targetScale =
        neuronScaleFromSignal(
          activitySignal,
        ) * (highlightActive &&
        topNeuronIds?.has(id)
          ? 1.35
          : 1)

      /*
       * mesh.scale 含整体放大补偿系数，
       * 读回信号域尺寸时除以它。
       */
      const currentScale =
        mesh.scale.x / nodeScaleCompRef.current

      scaleFrom.set(id, currentScale)
      scaleTo.set(id, targetScale)

      if (Math.abs(currentScale - targetScale) > 0.005) {
        hasChanged = true
      }
    })

    scaleFromRef.current = scaleFrom
    scaleToRef.current = scaleTo

    scaleAnimationStartRef.current = hasChanged
      ? performance.now()
      : 0
  }, [
    extent,
    frame,
    hasActivityData,
    highlightKey,
    highlightActive,
  ])

  /*
   * 重置视角：恢复神经元簇中心的怼近机位。
   */
  useEffect(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const pose = cameraPoseRef.current

    if (!camera || !controls || !pose) {
      return
    }

    controls.target.copy(pose.target)
    camera.position
      .copy(pose.target)
      .add(
        pose.direction
          .clone()
          .multiplyScalar(pose.distance),
      )
    controls.update()
  }, [resetSignal])

  return (
    <>
      <div
        ref={containerRef}
        className="scene-container"
      />

      {!sceneReady && (
        <div className="intro-loading-mask neuron-loading-mask">
          <Loader2
            className="intro-loading-spinner"
            size={30}
          />
          <strong>正在装配神经元网络场景</strong>
          <span>三维模型加载中，请稍候…</span>
        </div>
      )}
    </>
  )
}
