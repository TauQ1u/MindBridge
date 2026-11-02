import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  ALLEN_STRUCTURE_MODEL_URLS,
  STRUCTURE_GRAY,
  getStructureInfo,
} from './brainStructures'
import {
  createBrainShellMaterial,
  createNormalizedAtlas,
  createStructureMaterial,
  loadAtlasModels,
  setSurfaceMinOpacity,
} from './atlas'
import {
  renderStructureSnapshot,
  type BrainLoadState,
  type BrainSceneHandle,
} from './BrainScene'
import {
  EDGE_REST_COLOR,
  FIRE_COLOR,
  MAX_RIPPLES,
  NODE_RADIUS,
  REST_COLOR,
  RIPPLE_TAU,
  WAVE_TRAVEL_TAU,
  buildBvh,
  buildGraph,
  buildTriangleData,
  propagateRipple,
  raycastBvh,
  sampleNeuronPositions,
  type NeuronGraph,
  type RippleWave,
  type TriBvh,
} from './rippleNet'

/*
 * 首页统一场景（脑区结构 + 神经元信号合并版）。
 *
 * 渲染层常驻合一：
 * - 整脑外壳 + 各脑区结构（默认低透明中性灰壳）；
 * - 脑内体积采样的神经元节点网（静息微光、近隐没）。
 *
 * 点击分工（甲方要求的方案 B，互不触发）：
 * - 单击脑内任意位置 → 最近神经元激发，青蓝涟漪
 *   沿连接网扩散（延迟 260ms 判定，若期间出现
 *   第二次点击则取消涟漪）；
 * - 双击脑区结构 → 该脑区显示家族预设色并回调
 *   父组件展示图文介绍（原地连击穿透内层结构）。
 *
 * 相机慢速自动旋转永不停止，拖拽/点击只是叠加。
 * 点位采样、涟漪拾取（脑壳 BVH）与脑区拾取
 * （结构网格射线）各自独立。
 */

interface NeuronGalaxySceneProps {
  selectedId: string | null
  onSelect: (id: string | null) => void
  onLoadStateChange: (state: BrainLoadState) => void
  /*
   * 视觉主题：dark = 深蓝夜空（默认，建模项目原生效果）；
   * light = 白底科研演示（网站首页使用），
   * 神经元网改用实色混合以保证白底可见。
   */
  theme?: 'dark' | 'light'
}

/*
 * 合并场景的选中态视觉规则：
 * - 未选中：中性灰、无发光、透明度减半（透出内部节点）；
 * - mPFC（目标脑区）：常驻琥珀橙弱显色，保持可辨识；
 * - 选中：家族预设色 + 发光提亮 + 透明度拉高
 *   （保留少许透明，不完全遮挡内部神经元网）。
 */
function applyGalaxySelectionState(
  material: THREE.MeshPhysicalMaterial,
  id: string,
  selectedId: string | null,
) {
  const info = getStructureInfo(id)
  const isSelected = id === selectedId
  const isTarget = Boolean(info?.highlight)

  if (isSelected) {
    const color = info?.color ?? '#ffffff'

    material.color.set(color)
    material.emissive.set(color)
    material.emissiveIntensity = 0.35
    material.opacity = 0.92
    setSurfaceMinOpacity(material, 0.55)
  } else if (isTarget && info) {
    /*
     * mPFC 常驻显色（原木色 #DEB887）：不透明度 0.7，
     * 与所有脑区结构同一浓度标准；菲涅尔下限 0.7，
     * 正视处也真实呈现约七成浓度。
     */
    material.color.set(info.color)
    material.emissive.set(info.color)
    material.emissiveIntensity = 0.18
    material.opacity = 0.7
    setSurfaceMinOpacity(material, 0.7)
  } else {
    /*
     * 所有脑区结构统一 0.7 不透明度（含正视处），
     * 中性灰、无发光；神经元网以加色混合透出。
     */
    material.color.set(STRUCTURE_GRAY)
    material.emissive.set('#000000')
    material.emissiveIntensity = 0
    material.opacity = 0.7
    setSurfaceMinOpacity(material, 0.7)
  }
}

/* ---------------- 场景组件 ---------------- */

/*
 * 浅色主题（网站白底首页）的静息配色：
 * 不能用深空近黑色（视觉上过重），
 * 改用与浅色界面协调的灰蓝，激发态仍是青蓝信号色。
 */
const REST_COLOR_LIGHT = new THREE.Color('#9fb4cc')
const EDGE_REST_COLOR_LIGHT = new THREE.Color('#c3d0e0')

export const NeuronGalaxyScene = forwardRef<
  BrainSceneHandle,
  NeuronGalaxySceneProps
>(function NeuronGalaxyScene(
  { selectedId, onSelect, onLoadStateChange, theme = 'dark' },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const onLoadStateChangeRef = useRef(onLoadStateChange)
  /* 主题在场景创建时固化（effect 只运行一次） */
  const themeRef = useRef(theme)

  /* 脑区结构拾取 / 选中态 / 快照缓存 */
  const structureMeshesRef = useRef(
    new Map<string, THREE.Object3D>(),
  )
  const structureMaterialsRef = useRef(
    new Map<string, THREE.MeshPhysicalMaterial>(),
  )
  const snapshotCacheRef = useRef(new Map<string, string>())

  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  /*
   * 穿透提示批次号：0 = 隐藏；命中多层结构时递增，
   * 2.6s 后自动隐藏。
   */
  const [penetrateHint, setPenetrateHint] = useState(0)

  useEffect(() => {
    if (penetrateHint === 0) {
      return
    }

    const timer = window.setTimeout(
      () => setPenetrateHint(0),
      2600,
    )

    return () => {
      window.clearTimeout(timer)
    }
  }, [penetrateHint])

  useEffect(() => {
    onLoadStateChangeRef.current = onLoadStateChange
  }, [onLoadStateChange])

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    let sceneDisposed = false

    const scene = new THREE.Scene()
    const isLight = themeRef.current === 'light'
    const bgColor = isLight ? '#f4f6fb' : '#000000'
    scene.background = new THREE.Color(bgColor)
    scene.fog = new THREE.Fog(bgColor, 26, 60)

    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)

    const camera = new THREE.PerspectiveCamera(
      40,
      width / height,
      0.1,
      1000,
    )

    camera.position.set(0.6, 4.5, 16.8)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })

    const pixelRatio = () =>
      Math.min(window.devicePixelRatio, 1.5)

    renderer.setPixelRatio(pixelRatio())
    renderer.setSize(width, height, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05

    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(
      camera,
      renderer.domElement,
    )

    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = false
    controls.minDistance = 8
    controls.maxDistance = 34
    controls.target.set(0, -0.2, 0)
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.6

    /*
     * 自动旋转永不停止：拖动 / 点击（涟漪）期间相机
     * 继续保持旋转，用户交互只是叠加在旋转之上。
     */

    /*
     * 银河模式灯光：整体压暗，让青蓝涟漪成为视觉主角；
     * 保留一盏冷蓝轮廓灯维持脑壳的立体轮廓。
     * 浅色主题下整体提亮，脑区灰壳在白底上保持立体。
     */
    scene.add(
      new THREE.AmbientLight('#ffffff', isLight ? 1.15 : 0.75),
    )

    const keyLight = new THREE.DirectionalLight(
      '#dfe8f2',
      isLight ? 2.0 : 1.5,
    )
    keyLight.position.set(4, 7, 9)
    scene.add(keyLight)

    const rimLight = new THREE.PointLight(
      '#3d8fd1',
      isLight ? 34 : 26,
      42,
    )
    rimLight.position.set(-9, 4, 7)
    scene.add(rimLight)

    const brainRoot = new THREE.Group()
    brainRoot.rotation.x = -0.05
    scene.add(brainRoot)

    const structureIds = Object.keys(ALLEN_STRUCTURE_MODEL_URLS)
    const disposableMaterials: THREE.Material[] = []
    const disposableGeometries: THREE.BufferGeometry[] = []

    /*
     * 涟漪状态：每次点击产生一条沿连接网传播的波
     * （节点/连线的到达时间在触发时一次性算好）。
     */
    const ripples: RippleWave[] = []

    /* 神经元系统运行时引用（加载完成后填充） */
    let neuronMesh: THREE.InstancedMesh | null = null
    let edgeLines: THREE.LineSegments | null = null
    let neuronPositions: Float32Array | null = null
    let neuronCount = 0
    let neuronPhases: Float32Array | null = null
    let graph: NeuronGraph | null = null
    let edgePairs: number[][] = []
    let nodeIntensity: Float32Array | null = null
    let edgeIntensity: Float32Array | null = null
    let shellBvh: TriBvh | null = null

    void loadAtlasModels(structureIds)
      .then(({ brainModel, structureModels }) => {
        if (sceneDisposed) {
          return
        }

        // 外脑轮廓：比结构模式更透，让内部节点透出来
        const brainMaterial = createBrainShellMaterial(0.22)
        setSurfaceMinOpacity(brainMaterial, 0.32)

        disposableMaterials.push(brainMaterial)
        brainModel.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.material = brainMaterial
            child.renderOrder = -2
          }
        })

        const { wrapper, content: atlasContent } =
          createNormalizedAtlas(brainModel)
        brainRoot.add(wrapper)

        /*
         * 脑区结构：默认低透明中性灰壳（透出内部节点），
         * 注册拾取表与材质表；mPFC 常驻弱显色，
         * 双击选中后显示家族预设色。
         */
        structureIds.forEach((id, index) => {
          const model = structureModels[index]
          const material = createStructureMaterial({
            color: STRUCTURE_GRAY,
            opacity: 0.7,
            highlight: false,
            clipped: false,
          })
          setSurfaceMinOpacity(material, 0.7)

          disposableMaterials.push(material)
          model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.material = material
              child.renderOrder = -1
            }
            child.userData.structureId = id
          })

          structureMeshesRef.current.set(id, model)
          structureMaterialsRef.current.set(id, material)
          atlasContent.add(model)

          // 与加载前可能已存在的选中状态同步
          applyGalaxySelectionState(
            material,
            id,
            selectedIdRef.current,
          )
        })

        wrapper.updateMatrixWorld(true)
        /*
         * 脑壳挂在带旋转的 brainRoot 下：先刷新整棵场景树的
         * 世界矩阵，保证 BVH / 节点 / 连线与渲染结果处于
         * 同一世界坐标系（节点直接挂在 scene 下）。
         */
        scene.updateMatrixWorld(true)

        /* ---- 脑壳 BVH：采样与点击拾取共用 ---- */
        let shellMesh: THREE.Mesh | null = null
        brainModel.traverse((child) => {
          if (!shellMesh && child instanceof THREE.Mesh) {
            shellMesh = child
          }
        })

        if (!shellMesh) {
          throw new Error('脑壳网格缺失')
        }

        shellBvh = buildBvh(buildTriangleData(shellMesh))

        const shellBounds = new THREE.Box3().setFromObject(
          brainModel,
        )

        /* ---- 神经元节点：脑内体积均匀采样 ---- */
        const sampled = sampleNeuronPositions(
          shellBvh,
          shellBounds,
        )
        // 局部常量保持 TS 空值收窄在闭包内有效
        const positions = sampled.positions
        neuronPositions = positions
        neuronCount = sampled.count
        neuronPhases = new Float32Array(neuronCount)
        nodeIntensity = new Float32Array(neuronCount)

        for (let i = 0; i < neuronCount; i += 1) {
          neuronPhases[i] = Math.random() * Math.PI * 2
        }

        const nodeGeometry = new THREE.OctahedronGeometry(
          NODE_RADIUS,
          0,
        )
        disposableGeometries.push(nodeGeometry)

        const nodeMaterial = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.55,
          /*
           * 浅色主题不能用加色混合（白底上加色≈不可见），
           * 改回实色混合：静息深色节点 + 青蓝激发在白底上
           * 对比清晰。
           */
          blending: isLight
            ? THREE.NormalBlending
            : THREE.AdditiveBlending,
          depthWrite: false,
        })
        disposableMaterials.push(nodeMaterial)

        const instanced = new THREE.InstancedMesh(
          nodeGeometry,
          nodeMaterial,
          neuronCount,
        )

        const dummy = new THREE.Object3D()

        for (let i = 0; i < neuronCount; i += 1) {
          dummy.position.set(
            neuronPositions[i * 3],
            neuronPositions[i * 3 + 1],
            neuronPositions[i * 3 + 2],
          )
          dummy.rotation.set(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI,
          )
          dummy.scale.setScalar(0.6 + Math.random() * 0.6)
          dummy.updateMatrix()
          instanced.setMatrixAt(i, dummy.matrix)
          instanced.setColorAt(
            i,
            isLight ? REST_COLOR_LIGHT : REST_COLOR,
          )
        }

        instanced.renderOrder = 2
        scene.add(instanced)
        neuronMesh = instanced

        /* ---- 连接网：最近邻细线 + 传播图 ---- */
        graph = buildGraph(positions, neuronCount)
        edgePairs = graph.pairs
        edgeIntensity = new Float32Array(edgePairs.length)

        const edgePositions = new Float32Array(
          edgePairs.length * 6,
        )
        const edgeColors = new Float32Array(edgePairs.length * 6)

        edgePairs.forEach(([a, b], index) => {
          edgePositions.set(
            [
              positions[a * 3],
              positions[a * 3 + 1],
              positions[a * 3 + 2],
              positions[b * 3],
              positions[b * 3 + 1],
              positions[b * 3 + 2],
            ],
            index * 6,
          )
        })

        const edgeGeometry = new THREE.BufferGeometry()
        edgeGeometry.setAttribute(
          'position',
          new THREE.BufferAttribute(edgePositions, 3),
        )
        edgeGeometry.setAttribute(
          'color',
          new THREE.BufferAttribute(edgeColors, 3),
        )
        disposableGeometries.push(edgeGeometry)

        const edgeMaterial = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.6,
          blending: isLight
            ? THREE.NormalBlending
            : THREE.AdditiveBlending,
          depthWrite: false,
        })
        disposableMaterials.push(edgeMaterial)

        const lines = new THREE.LineSegments(
          edgeGeometry,
          edgeMaterial,
        )
        lines.renderOrder = 1
        scene.add(lines)
        edgeLines = lines

        /* ---- 取景：与结构模式一致的机位 ---- */
        const brainCenter = new THREE.Box3()
          .setFromObject(brainModel)
          .getCenter(new THREE.Vector3())
        controls.target.copy(brainCenter)
        camera.position
          .copy(brainCenter)
          .add(new THREE.Vector3(0.6, 4.6, 16.4))
        controls.update()

        onLoadStateChangeRef.current('ready')
      })
      .catch((error) => {
        console.warn('神经元银河场景加载失败。', error)

        if (!sceneDisposed) {
          onLoadStateChangeRef.current('fallback')
        }
      })

    /* ---- 点击激发：射线 → 脑壳入射点 → 最近神经元 ---- */
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let pointerStart = { x: 0, y: 0 }

    const pickBrainEntry = (event: PointerEvent) => {
      if (!shellBvh || !neuronPositions) {
        return null
      }

      const rect = renderer.domElement.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }

      pointer.x =
        ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y =
        -(((event.clientY - rect.top) / rect.height) * 2 - 1)

      raycaster.setFromCamera(pointer, camera)

      const ray = raycaster.ray
      const t = raycastBvh(
        shellBvh,
        ray.origin.x,
        ray.origin.y,
        ray.origin.z,
        ray.direction.x,
        ray.direction.y,
        ray.direction.z,
        'nearest',
      )

      if (t === null) {
        return null
      }

      const hit = ray.origin
        .clone()
        .add(ray.direction.clone().multiplyScalar(t))

      // 最近的神经元作为激发源
      let bestIndex = -1
      let bestDistSq = Infinity

      for (let i = 0; i < neuronCount; i += 1) {
        const dx = neuronPositions[i * 3] - hit.x
        const dy = neuronPositions[i * 3 + 1] - hit.y
        const dz = neuronPositions[i * 3 + 2] - hit.z
        const distSq = dx * dx + dy * dy + dz * dz

        if (distSq < bestDistSq) {
          bestDistSq = distSq
          bestIndex = i
        }
      }

      if (bestIndex < 0) {
        return null
      }

      return bestIndex
    }

    /*
     * 脑区结构射线拾取：返回命中的全部结构 id
     * （按距离由近及远、同结构去重）。
     * 透明只是视觉穿透，射线检测不看透明度——
     * 外层壳体会几何遮挡内部结构，保留完整命中链
     * 供双击时原地循环穿透。
     */
    const pickStructureHits = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) {
        return []
      }

      pointer.x =
        ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y =
        -(((event.clientY - rect.top) / rect.height) * 2 - 1)

      raycaster.setFromCamera(pointer, camera)

      const candidates: THREE.Object3D[] = []
      structureMeshesRef.current.forEach((model) => {
        model.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            candidates.push(child)
          }
        })
      })

      const hits = raycaster.intersectObjects(
        candidates,
        false,
      )

      const ids: string[] = []

      for (const hit of hits) {
        const id = hit.object.userData.structureId as
          | string
          | undefined

        if (id && !ids.includes(id)) {
          ids.push(id)
        }
      }

      return ids
    }

    /*
     * 双击脑区选中：同点循环穿透状态。
     * 与上一次双击位置相近（≤ 10px）、间隔 < 1.5s
     * 且命中链相同，则选中命中链中的下一个。
     */
    let lastPick: {
      x: number
      y: number
      ids: string[]
      index: number
      time: number
    } | null = null

    const selectStructureAt = (event: PointerEvent) => {
      const ids = pickStructureHits(event)

      if (ids.length === 0) {
        lastPick = null
        setPenetrateHint(0)
        onSelectRef.current(null)
        return
      }

      const now = performance.now()
      let index = 0

      if (
        lastPick &&
        now - lastPick.time < 1500 &&
        Math.hypot(
          event.clientX - lastPick.x,
          event.clientY - lastPick.y,
        ) <= 10 &&
        lastPick.ids.join('|') === ids.join('|')
      ) {
        index = (lastPick.index + 1) % ids.length
      }

      lastPick = {
        x: event.clientX,
        y: event.clientY,
        ids,
        index,
        time: now,
      }

      onSelectRef.current(ids[index])

      // 命中多层结构时提示可以穿透双击
      setPenetrateHint((nonce) =>
        ids.length > 1 ? nonce + 1 : 0,
      )
    }

    const handlePointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY }
    }

    /*
     * 点击分工（甲方要求的方案 B）：
     * - 单击 = 触发信号涟漪（延迟 260ms 判定，
     *   若期间出现第二次点击则取消涟漪）；
     * - 双击 = 选中脑区查看介绍（原地连击穿透内层）。
     * 两种交互互不触发对方，彻底无冲突。
     */
    let clickTimer = 0
    let lastClick = { x: 0, y: 0, time: 0 }

    const handlePointerUp = (event: PointerEvent) => {
      const movement = Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      )

      if (movement > 5) {
        return
      }

      const now = performance.now()
      const isDoubleClick =
        now - lastClick.time < 350 &&
        Math.hypot(
          event.clientX - lastClick.x,
          event.clientY - lastClick.y,
        ) <= 8

      lastClick = {
        x: event.clientX,
        y: event.clientY,
        time: now,
      }

      if (isDoubleClick) {
        // 双击：取消待触发的涟漪，改为选中脑区
        window.clearTimeout(clickTimer)
        lastClick.time = 0 // 三连击不重复触发
        selectStructureAt(event)
        return
      }

      // 单击：延迟触发涟漪，等待可能到来的第二击
      const { clientX, clientY } = event

      window.clearTimeout(clickTimer)
      clickTimer = window.setTimeout(() => {
        if (
          !graph ||
          !neuronPositions ||
          !shellBvh
        ) {
          return
        }

        const originIndex = pickBrainEntry({
          clientX,
          clientY,
        } as PointerEvent)

        if (originIndex === null) {
          return
        }

        // 沿连接网传播：触发时一次性算出到达时刻
        const wave = propagateRipple(
          graph,
          neuronPositions,
          neuronCount,
          originIndex,
        )
        wave.start = performance.now()

        ripples.push(wave)

        if (ripples.length > MAX_RIPPLES) {
          ripples.shift()
        }

        /* 涟漪播放期间相机保持自动旋转（不暂停） */
      }, 260)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!shellBvh) {
        return
      }

      const rect = renderer.domElement.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) {
        return
      }

      pointer.x =
        ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y =
        -(((event.clientY - rect.top) / rect.height) * 2 - 1)

      raycaster.setFromCamera(pointer, camera)

      const ray = raycaster.ray
      const hit = raycastBvh(
        shellBvh,
        ray.origin.x,
        ray.origin.y,
        ray.origin.z,
        ray.direction.x,
        ray.direction.y,
        ray.direction.z,
        'nearest',
      )

      renderer.domElement.style.cursor =
        hit === null ? 'grab' : 'pointer'
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

    /* ---- 渲染循环：静息微光 + 涟漪沿连接网传播衰减 ---- */
    let animationId = 0
    const color = new THREE.Color()

    const animate = (time: number) => {
      const now = performance.now()

      // 清理已完全衰减的涟漪（最晚到达 + 余晖散尽）
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        const elapsed = (now - ripples[i].start) / 1000
        if (elapsed > ripples[i].maxArrival + RIPPLE_TAU * 5) {
          ripples.splice(i, 1)
        }
      }

      if (neuronMesh && neuronPositions && neuronPhases) {
        const twinkleTime = time * 0.0009

        for (let i = 0; i < neuronCount; i += 1) {
          let intensity = 0

          for (const ripple of ripples) {
            const arrival = ripple.nodeArrival[i]

            if (arrival < 0) {
              continue
            }

            // 波前到达后的存活时长；中心点也随时间消退
            const age = (now - ripple.start) / 1000 - arrival

            if (age > 0) {
              intensity +=
                Math.exp(-age / RIPPLE_TAU) *
                Math.exp(-arrival / WAVE_TRAVEL_TAU)
            }
          }

          intensity = Math.min(intensity, 1)
          if (nodeIntensity) {
            nodeIntensity[i] = intensity
          }

          // 静息态：近乎隐没的微光缓慢呼吸
          const twinkle =
            0.85 + 0.15 * Math.sin(twinkleTime + neuronPhases[i])

          color
            .copy(isLight ? REST_COLOR_LIGHT : REST_COLOR)
            .lerp(FIRE_COLOR, intensity)
            .multiplyScalar(twinkle * (1 + intensity * 1.8))

          neuronMesh.setColorAt(i, color)
        }

        if (neuronMesh.instanceColor) {
          neuronMesh.instanceColor.needsUpdate = true
        }
      }

      /*
       * 连线只在波前实际穿过时短暂点亮：
       * 未参与本次传播的连线保持静息（不整片泛亮）。
       */
      if (edgeLines && edgeIntensity) {
        const edgeColorsAttr = edgeLines.geometry.getAttribute(
          'color',
        ) as THREE.BufferAttribute

        for (let e = 0; e < edgePairs.length; e += 1) {
          let intensity = 0

          for (const ripple of ripples) {
            const arrival = ripple.edgeArrival[e]

            if (arrival < 0) {
              continue
            }

            const age = (now - ripple.start) / 1000 - arrival

            if (age > 0) {
              intensity +=
                Math.exp(-age / (RIPPLE_TAU * 0.7)) *
                Math.exp(-arrival / WAVE_TRAVEL_TAU)
            }
          }

          intensity = Math.min(intensity, 1)
          edgeIntensity[e] = intensity

          color
            .copy(isLight ? EDGE_REST_COLOR_LIGHT : EDGE_REST_COLOR)
            .lerp(FIRE_COLOR, intensity * 0.9)

          edgeColorsAttr.setXYZ(e * 2, color.r, color.g, color.b)
          edgeColorsAttr.setXYZ(
            e * 2 + 1,
            color.r,
            color.g,
            color.b,
          )
        }

        edgeColorsAttr.needsUpdate = true
      }

      /*
       * 呼吸发光：有双击选中时作用于选中脑区，
       * 无选中时作用于常驻弱显色的 mPFC。
       */
      const currentSelectedId = selectedIdRef.current
      const breathingId = currentSelectedId ?? 'mpfc'
      const breathingMaterial =
        structureMaterialsRef.current.get(breathingId)

      if (breathingMaterial) {
        const base = currentSelectedId ? 0.35 : 0.18
        const amplitude = currentSelectedId ? 0.12 : 0.06

        breathingMaterial.emissiveIntensity =
          base + Math.sin(time * 0.0016) * amplitude
      }

      controls.update()
      renderer.render(scene, camera)
      animationId = window.requestAnimationFrame(animate)
    }

    animationId = window.requestAnimationFrame(animate)

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = Math.max(container.clientWidth, 1)
      const nextHeight = Math.max(container.clientHeight, 1)

      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setPixelRatio(pixelRatio())
      renderer.setSize(nextWidth, nextHeight, false)
    })

    resizeObserver.observe(container)

    return () => {
      sceneDisposed = true
      window.cancelAnimationFrame(animationId)
      window.clearTimeout(clickTimer)
      resizeObserver.disconnect()

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

      brainRoot.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
        }
      })

      disposableGeometries.forEach((geometry) =>
        geometry.dispose(),
      )
      disposableMaterials.forEach((material) =>
        material.dispose(),
      )

      structureMeshesRef.current.clear()
      structureMaterialsRef.current.clear()
      snapshotCacheRef.current.clear()

      controls.dispose()
      renderer.renderLists.dispose()
      renderer.dispose()

      if (
        renderer.domElement.parentElement === container
      ) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [])

  /*
   * 选中态视觉反馈：双击选中的脑区显示家族预设色，
   * 未选中脑区回到低透明中性灰。
   */
  useEffect(() => {
    structureMaterialsRef.current.forEach(
      (material, id) => {
        applyGalaxySelectionState(material, id, selectedId)
      },
    )
  }, [selectedId])

  useImperativeHandle(ref, () => ({
    getSnapshot(id: string) {
      const cached = snapshotCacheRef.current.get(id)

      if (cached) {
        return cached
      }

      const model = structureMeshesRef.current.get(id)

      if (!model) {
        return null
      }

      try {
        const url = renderStructureSnapshot(
          model,
          getStructureInfo(id)?.color ?? '#9aa0a6',
          themeRef.current === 'light' ? '#f4f6fb' : '#000000',
        )

        snapshotCacheRef.current.set(id, url)

        return url
      } catch {
        return null
      }
    },
  }))

  return (
    <div
      ref={containerRef}
      className="scene-container"
    >
      {penetrateHint > 0 && (
        <div className="penetrate-hint">
          检测到多层脑区重叠 · 原地再次双击可穿透选中内部结构
        </div>
      )}
    </div>
  )
})
