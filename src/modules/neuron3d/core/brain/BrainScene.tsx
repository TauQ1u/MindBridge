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
  getStructureOpacity,
} from './brainStructures'
import {
  createBrainShellMaterial,
  createNormalizedAtlas,
  createStructureMaterial,
  loadAtlasModels,
  setSurfaceMinOpacity,
} from './atlas'

/*
 * 页面一：Allen 小鼠脑 3D 模型场景。
 *
 * - 整脑轮廓（root 997）完整、略微透明显示；
 * - 全脑双侧显示：脑区结构不做矢状面裁切，
 *   左右半球完整可见；
 * - 默认所有脑区为中性灰磨砂壳（含 mPFC），
 *   点击选中后才显示该脑区的家族预设色；
 * - 表面为菲涅尔磨砂透视：正对视线处透明可见内部，
 *   轮廓边缘保持满浓度；
 * - 结构可点击（支持原地循环穿透内部结构），
 *   选中后回调父组件展示图文介绍。
 *
 * 图谱加载 / 归一化统一来自 ./atlas 共享模块，
 * 此处不重复实现。
 */

export type BrainLoadState =
  | 'loading'
  | 'ready'
  | 'fallback'

interface BrainSceneProps {
  selectedId: string | null
  onSelect: (id: string | null) => void
  onLoadStateChange: (state: BrainLoadState) => void
}

function replaceObjectMaterial(
  object: THREE.Object3D,
  material: THREE.Material,
  renderOrder: number,
) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = material
      child.renderOrder = renderOrder
    }
  })
}

/*
 * 选中态视觉规则（唯一实现，创建与选中变更共用）：
 * - 未选中：中性灰、无发光、基础透明度、菲涅尔下限 0.6；
 * - mPFC（目标脑区）：常驻显示琥珀橙预设色，
 *   不受"默认全灰"约束；
 * - 选中：显示家族预设色 + 发光提亮 + 透明度拉满，
 *   菲涅尔下限提到 0.75（曲面中央也更实）。
 */
function applySelectionState(
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
    material.opacity = 1
    setSurfaceMinOpacity(material, 0.75)
  } else if (isTarget && info) {
    // mPFC 常驻显色
    material.color.set(info.color)
    material.emissive.set(info.color)
    material.emissiveIntensity = 0.25
    material.opacity = 0.9
    setSurfaceMinOpacity(material, 0.6)
  } else {
    material.color.set(STRUCTURE_GRAY)
    material.emissive.set('#000000')
    material.emissiveIntensity = 0
    material.opacity = getStructureOpacity(id)
    setSurfaceMinOpacity(material, 0.6)
  }
}

/*
 * 为选中结构生成一张离屏渲染图片，
 * 供右侧介绍面板展示；颜色与场景配色同步。
 * 全脑双侧显示：快照同样不做矢状面裁切。
 * （导出供合并场景 NeuronGalaxyScene 复用）
 */
export function renderStructureSnapshot(
  source: THREE.Object3D,
  color: string,
  background = '#000000',
) {
  const width = 560
  const height = 400

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  })

  renderer.localClippingEnabled = true
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(background)

  scene.add(new THREE.AmbientLight('#ffffff', 1.5))

  const keyLight = new THREE.DirectionalLight('#ffffff', 2.4)
  keyLight.position.set(3, 5, 8)
  scene.add(keyLight)

  const fillLight = new THREE.PointLight('#66b7e8', 26, 40)
  fillLight.position.set(-6, -3, 6)
  scene.add(fillLight)

  // 克隆结构并烘焙世界变换，保持图谱中的真实形态。
  const clone = source.clone(true)
  clone.updateMatrixWorld(true)
  clone.matrix
    .copy(source.matrixWorld)
    .decompose(clone.position, clone.quaternion, clone.scale)

  const snapshotMaterial = new THREE.MeshPhysicalMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    roughness: 0.6,
    side: THREE.DoubleSide,
  })

  clone.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = snapshotMaterial
    }
  })

  // 居中
  const bounds = new THREE.Box3().setFromObject(clone)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())

  const holder = new THREE.Group()
  clone.position.sub(center)
  holder.add(clone)
  holder.rotation.y = -0.5
  holder.rotation.x = 0.12
  scene.add(holder)

  const radius = Math.max(size.x, size.y, size.z, 0.001)
  const camera = new THREE.PerspectiveCamera(
    38,
    width / height,
    0.01,
    1000,
  )

  camera.position.set(0, radius * 0.18, radius * 1.35)
  camera.lookAt(0, 0, 0)

  renderer.render(scene, camera)

  const url = renderer.domElement.toDataURL('image/png')

  snapshotMaterial.dispose()
  renderer.dispose()

  return url
}

export interface BrainSceneHandle {
  /** 为选中结构生成离屏渲染图片（带缓存） */
  getSnapshot: (id: string) => string | null
}

export const BrainScene = forwardRef<
  BrainSceneHandle,
  BrainSceneProps
>(function BrainScene(
  { selectedId, onSelect, onLoadStateChange },
  ref,
) {
  const containerRef =
    useRef<HTMLDivElement | null>(null)

  const structureMeshesRef = useRef(
    new Map<string, THREE.Object3D>(),
  )

  const structureMaterialsRef = useRef(
    new Map<string, THREE.MeshPhysicalMaterial>(),
  )

  const snapshotCacheRef = useRef(
    new Map<string, string>(),
  )

  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const onLoadStateChangeRef = useRef(onLoadStateChange)
  onLoadStateChangeRef.current = onLoadStateChange

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
    const container = containerRef.current

    if (!container) {
      return
    }

    let sceneDisposed = false

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#000000')
    scene.fog = new THREE.Fog('#000000', 26, 60)

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
    renderer.localClippingEnabled = true

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

    /*
     * 慢速自动旋转：相机绕脑水平环绕
     * （speed 0.6 ≈ 100 秒一圈）。
     * 旋转始终开启：拖拽只是在旋转基础上叠加
     * 手动调整，松手后从当前视角继续环绕，
     * 不回到初始机位。
     */
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.6

    scene.add(new THREE.AmbientLight('#ffffff', 1.1))

    const keyLight = new THREE.DirectionalLight('#ffffff', 2.2)
    keyLight.position.set(4, 7, 9)
    scene.add(keyLight)

    const rimLight = new THREE.PointLight('#4ea8ff', 30, 40)
    rimLight.position.set(-9, 4, 7)
    scene.add(rimLight)

    const warmLight = new THREE.PointLight('#ff8a5c', 16, 30)
    warmLight.position.set(7, -3, 8)
    scene.add(warmLight)

    const brainRoot = new THREE.Group()
    brainRoot.rotation.x = -0.05
    scene.add(brainRoot)

    const structureIds = Object.keys(
      ALLEN_STRUCTURE_MODEL_URLS,
    )

    const disposableMaterials: THREE.Material[] = []

    void loadAtlasModels(structureIds)
      .then(({ brainModel, structureModels }) => {
        if (sceneDisposed) {
          return
        }

        // 外脑轮廓：完整、高透明单面外壳（内部空心）
        const brainMaterial = createBrainShellMaterial(0.32)

        disposableMaterials.push(brainMaterial)
        replaceObjectMaterial(brainModel, brainMaterial, -2)

        // 图谱归一化：共享模块唯一实现
        const { wrapper, content: atlasContent } =
          createNormalizedAtlas(brainModel)
        brainRoot.add(wrapper)

        // 脑区结构：默认统一中性灰，选中后才显示预设色
        structureIds.forEach((id, index) => {
          const model = structureModels[index]
          const info = getStructureInfo(id)

          if (!info) {
            return
          }

          /*
           * 空心渲染：单面外壳（FrontSide），内部不做
           * 不透明填充；菲涅尔磨砂透视表面。
           * 全脑双侧显示：不做矢状面裁切，
           * 左右半球结构完整可见。
           */
          const material = createStructureMaterial({
            color: STRUCTURE_GRAY,
            opacity: getStructureOpacity(id),
            highlight: false,
            clipped: false,
          })

          disposableMaterials.push(material)
          replaceObjectMaterial(model, material, 0)

          model.traverse((child) => {
            child.userData.structureId = id
          })

          structureMeshesRef.current.set(id, model)
          structureMaterialsRef.current.set(id, material)
          atlasContent.add(model)

          // 与加载前可能已存在的选中状态同步
          applySelectionState(
            material,
            id,
            selectedIdRef.current,
          )
        })

        wrapper.updateMatrixWorld(true)

        /*
         * 取景：全脑几何中心对准可视区域显示中心
         * （场景 canvas 即右侧面板之外的自由区域，
         * 故对准 canvas 中心即可），不再锁定 mPFC。
         * OrbitControls target 锁定为脑几何中心，
         * 只允许环绕旋转与缩放，不允许平移。
         */
        const brainCenter = new THREE.Box3()
          .setFromObject(brainModel)
          .getCenter(new THREE.Vector3())
        controls.target.copy(brainCenter)
        /*
         * 初始机位：略高于脑的俯视角（约 15°），
         * 距离与截图确认过的缩放程度一致（≈17）。
         */
        camera.position
          .copy(brainCenter)
          .add(new THREE.Vector3(0.6, 4.6, 16.4))
        controls.update()

        onLoadStateChangeRef.current('ready')
      })
      .catch((error) => {
        console.warn('Allen 小鼠脑模型加载失败。', error)

        if (!sceneDisposed) {
          onLoadStateChangeRef.current('fallback')
        }
      })

    // 结构点击与悬停
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()

    let pointerStart = { x: 0, y: 0 }

    /*
     * 射线拾取：返回命中的全部结构 id
     * （按距离由近及远、同结构去重）。
     *
     * 透明只是视觉穿透，射线检测不看透明度——
     * 皮层等外层壳体会在几何上挡住海马、杏仁核等
     * 内部结构，因此保留完整命中链供循环穿透。
     */
    const pickStructureHits = (event: PointerEvent) => {
      const rect =
        renderer.domElement.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) {
        return []
      }

      pointer.x =
        ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y =
        -(
          ((event.clientY - rect.top) / rect.height) * 2 -
          1
        )

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
     * 同点循环穿透状态：与上一次点击位置相近（≤ 10px）、
     * 间隔 < 1.5s 且命中链相同，则选中命中链中的下一个，
     * 依次穿透外层壳体选中内部结构。
     */
    let lastPick: {
      x: number
      y: number
      ids: string[]
      index: number
      time: number
    } | null = null

    const handlePointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY }
    }

    const handlePointerUp = (event: PointerEvent) => {
      const movement = Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      )

      if (movement > 5) {
        return
      }

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

      // 命中多层结构时提示可以穿透点击
      setPenetrateHint((nonce) =>
        ids.length > 1 ? nonce + 1 : 0,
      )
    }

    const handlePointerMove = (event: PointerEvent) => {
      renderer.domElement.style.cursor =
        pickStructureHits(event).length > 0
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
       * 呼吸发光：有选中时作用于选中脑区，
       * 无选中时作用于常驻显色的 mPFC。
       */
      const currentSelectedId = selectedIdRef.current
      const breathingId = currentSelectedId ?? 'mpfc'
      const breathingMaterial =
        structureMaterialsRef.current.get(breathingId)

      if (breathingMaterial) {
        const base = currentSelectedId ? 0.35 : 0.25
        const amplitude = currentSelectedId ? 0.12 : 0.08

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
      const nextHeight = Math.max(
        container.clientHeight,
        1,
      )

      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setPixelRatio(pixelRatio())
      renderer.setSize(nextWidth, nextHeight, false)
    })

    resizeObserver.observe(container)

    return () => {
      sceneDisposed = true
      window.cancelAnimationFrame(animationId)
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

      structureMeshesRef.current.forEach((model) => {
        model.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
          }
        })
      })

      brainRoot.traverse((child) => {
        if (
          child instanceof THREE.Mesh ||
          child instanceof THREE.LineSegments
        ) {
          child.geometry.dispose()
        }
      })

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
   * 选中态视觉反馈：选中脑区显示家族预设色，
   * 未选中脑区回到中性灰。
   */
  useEffect(() => {
    structureMaterialsRef.current.forEach(
      (material, id) => {
        applySelectionState(material, id, selectedId)
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
          检测到多层脑区重叠 · 原地再次点击可穿透选中内部结构
        </div>
      )}
    </div>
  )
})
