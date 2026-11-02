import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { DISPLAY_SIZE } from '../neuron/neuronUtils'
import {
  ALLEN_BRAIN_MODEL_URL,
  ALLEN_STRUCTURE_MODEL_URLS,
  BRAIN_LONG_AXIS,
  BRAIN_SHELL_COLOR,
  MPFC_COLOR,
} from './brainStructures'

/*
 * Allen 小鼠脑图谱共享模块。
 *
 * 首页（BrainScene）与工作台成像位置指示器（BrainLocator）
 * 共用同一套图谱加载、归一化、矢状面裁切与成像视野（FOV）
 * 标定逻辑，禁止在两处各自重复实现：
 *
 * - createNormalizedAtlas：脑中心对齐原点、长轴缩放到
 *   BRAIN_LONG_AXIS、翻转 Y（唯一实现）；
 * - HEMISPHERE_PLANE：正中矢状面裁切，保留 Z <= 0 半球；
 * - computeFovPlacement：mPFC 成像平面在图谱坐标系中的
 *   位置 / 尺寸 / 朝向（唯一定义）；
 * - neuronSceneToFov：神经元主场景平面坐标 → FOV 平面
 *   局部坐标的唯一映射，保证主场景点云与脑内微点同构。
 */

/** 正中矢状面裁切平面：保留 Z <= 0 半球 */
export const HEMISPHERE_PLANE = new THREE.Plane(
  new THREE.Vector3(0, 0, -1),
  0,
)

/** 批量加载整脑 + 指定结构 OBJ */
export async function loadAtlasModels(structureIds: string[]) {
  const loader = new OBJLoader()

  const [brainModel, ...structureModels] =
    await Promise.all([
      loader.loadAsync(ALLEN_BRAIN_MODEL_URL),
      ...structureIds.map((id) =>
        loader.loadAsync(ALLEN_STRUCTURE_MODEL_URLS[id]),
      ),
    ])

  return { brainModel, structureModels }
}

export interface NormalizedAtlas {
  /** 已做 Y 翻转与长轴缩放的外层组，加入场景即可 */
  wrapper: THREE.Group
  /** 内容组：整脑与结构模型都加入这里，共享同一变换 */
  content: THREE.Group
}

/*
 * 图谱归一化（唯一实现）：
 * 包围盒中心对齐原点 → 最长轴缩放到 BRAIN_LONG_AXIS
 * → wrapper 做 (s, -s, s) 缩放翻转 Y。
 */
export function createNormalizedAtlas(
  brainModel: THREE.Object3D,
): NormalizedAtlas {
  const content = new THREE.Group()
  const wrapper = new THREE.Group()

  const bounds = new THREE.Box3().setFromObject(brainModel)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())
  const scale =
    BRAIN_LONG_AXIS / Math.max(size.x, size.y, size.z, 0.001)

  content.position.copy(center).multiplyScalar(-1)
  content.add(brainModel)

  wrapper.scale.set(scale, -scale, scale)
  wrapper.add(content)

  return { wrapper, content }
}

export interface FresnelNoiseOptions {
  /** 菲涅尔透明下限：曲面正对视线处的最低透明度比例 */
  minOpacity?: number
  /** 菲涅尔指数：越大透明区越收缩到曲面正中央 */
  fresnelPower?: number
  /** 噪声法线扰动强度：哑光磨砂微起伏 */
  noiseStrength?: number
}

/*
 * 磨砂透视表面（菲涅尔透明 + 程序化噪声质感）。
 *
 * - 菲涅尔透明：alpha 随"法线·视线"变化——曲面正对
 *   视线处透明（看穿内部结构），轮廓边缘接近不透明
 *   （颜色浓度保持拉满），即 Allen Brain Explorer 的
 *   磨砂透视效果；颜色饱和度本身不降低。
 * - 噪声质感：OBJ 模型无 UV，无法用 bump 贴图，
 *   改用世界坐标驱动的双八度 value noise +
 *   屏幕空间导数扰动法线（three.js bumpmap 同款
 *   数学），产生哑光磨砂的微起伏；只影响光照，
 *   不改变几何轮廓。
 * - 选中提亮：通过 material.userData.minOpacity
 *   动态调整菲涅尔下限（编译前后都生效）。
 */
export function applyFresnelNoiseSurface(
  material: THREE.MeshPhysicalMaterial,
  {
    minOpacity = 0.55,
    fresnelPower = 2.2,
    noiseStrength = 0.1,
  }: FresnelNoiseOptions = {},
) {
  material.userData.minOpacity = minOpacity

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMinOpacity = {
      value: material.userData.minOpacity as number,
    }
    shader.uniforms.uFresnelPower = { value: fresnelPower }
    shader.uniforms.uNoiseStrength = { value: noiseStrength }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vNeuroWorldPos;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvNeuroWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vNeuroWorldPos;
uniform float uMinOpacity;
uniform float uFresnelPower;
uniform float uNoiseStrength;

float neuroHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float neuroNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(neuroHash(i), neuroHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(neuroHash(i + vec3(0.0, 1.0, 0.0)), neuroHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(neuroHash(i + vec3(0.0, 0.0, 1.0)), neuroHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(neuroHash(i + vec3(0.0, 1.0, 1.0)), neuroHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  float neuroH =
    neuroNoise(vNeuroWorldPos * 1.6) * 0.65 +
    neuroNoise(vNeuroWorldPos * 6.5) * 0.35;
  vec3 neuroPos = -vViewPosition;
  vec3 neuroSigmaX = dFdx(neuroPos);
  vec3 neuroSigmaY = dFdy(neuroPos);
  float neurodHdx = dFdx(neuroH);
  float neurodHdy = dFdy(neuroH);
  vec3 neuroR1 = cross(neuroSigmaY, normal);
  vec3 neuroR2 = cross(normal, neuroSigmaX);
  float neuroDet = dot(neuroSigmaX, neuroR1);
  vec3 neuroGrad =
    sign(neuroDet) * (neurodHdx * neuroR1 + neurodHdy * neuroR2);
  normal = normalize(
    abs(neuroDet) * normal - uNoiseStrength * neuroGrad
  );
}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  float neuroFresnel = pow(
    1.0 - abs(dot(normalize(normal), normalize(vViewPosition))),
    uFresnelPower
  );
  diffuseColor.a *= mix(uMinOpacity, 1.0, neuroFresnel);
}
#include <opaque_fragment>`,
      )

    material.userData.shader = shader
  }
}

/** 动态调整菲涅尔透明下限（选中提亮用） */
export function setSurfaceMinOpacity(
  material: THREE.MeshPhysicalMaterial,
  value: number,
) {
  material.userData.minOpacity = value

  const shader = material.userData.shader as
    | { uniforms: Record<string, { value: number }> }
    | undefined

  if (shader?.uniforms.uMinOpacity) {
    shader.uniforms.uMinOpacity.value = value
  }
}

/** 整脑外壳材质（浅灰、高透明、单面、内部空心） */
export function createBrainShellMaterial(
  opacity = 0.14,
  clipped = false,
) {
  const material = new THREE.MeshPhysicalMaterial({
    color: BRAIN_SHELL_COLOR,
    transparent: true,
    opacity,
    roughness: 0.92,
    metalness: 0,
    sheen: 0.3,
    sheenRoughness: 0.6,
    sheenColor: '#ffffff',
    side: THREE.FrontSide,
    depthWrite: false,
    clippingPlanes: clipped ? [HEMISPHERE_PLANE] : [],
  })

  applyFresnelNoiseSurface(material, {
    minOpacity: 0.45,
    noiseStrength: 0.08,
  })

  return material
}

export interface StructureMaterialOptions {
  color: string
  opacity: number
  highlight?: boolean
  side?: THREE.Side
  clipped?: boolean
}

/** 脑区结构壳材质（默认中性灰 / 选中后显示家族预设色） */
export function createStructureMaterial({
  color,
  opacity,
  highlight = false,
  side = THREE.FrontSide,
  clipped = true,
}: StructureMaterialOptions) {
  const material = new THREE.MeshPhysicalMaterial({
    color,
    transparent: true,
    opacity,
    roughness: 0.9,
    metalness: 0,
    sheen: 0.3,
    sheenRoughness: 0.6,
    sheenColor: '#ffffff',
    side,
    depthWrite: false,
    emissive: highlight ? color : '#000000',
    emissiveIntensity: highlight ? 0.4 : 0,
    clippingPlanes: clipped ? [HEMISPHERE_PLANE] : [],
  })

  applyFresnelNoiseSurface(material, {
    minOpacity: 0.55,
    noiseStrength: 0.1,
  })

  return material
}

/** mPFC 高亮壳（Locator 用：双面、更实） */
export function createMpfcShellMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: MPFC_COLOR,
    transparent: true,
    opacity: 0.72,
    roughness: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    emissive: MPFC_COLOR,
    emissiveIntensity: 0.7,
    clippingPlanes: [HEMISPHERE_PLANE],
  })
}

/** 统计裁切后保留半球（Z <= 0）的网格包围盒（世界坐标） */
export function computeClippedBounds(object: THREE.Object3D) {
  const bounds = new THREE.Box3()
  const vertex = new THREE.Vector3()

  object.updateMatrixWorld(true)
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return
    }

    const position = child.geometry.getAttribute(
      'position',
    )

    if (!position) {
      return
    }

    for (
      let index = 0;
      index < position.count;
      index += 1
    ) {
      vertex
        .fromBufferAttribute(position, index)
        .applyMatrix4(child.matrixWorld)

      if (vertex.z <= 0) {
        bounds.expandByPoint(vertex)
      }
    }
  })

  if (bounds.isEmpty()) {
    bounds.setFromObject(object)
  }

  return bounds
}

export interface FovPlacement {
  /** 成像平面中心（图谱世界坐标，Z 固定贴在剖面前方） */
  center: THREE.Vector3
  width: number
  height: number
}

/*
 * mPFC 成像视野（FOV）标定（唯一定义）：
 * 贴在 mPFC 中线剖面处，尺寸随 mPFC 剖面包围盒缩放。
 * 首页与工作台 Locator 必须使用同一标定，
 * 成像平面位置为示意性标定。
 */
export function computeFovPlacement(
  mpfcModel: THREE.Object3D,
): FovPlacement {
  const bounds = computeClippedBounds(mpfcModel)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())

  return {
    center: new THREE.Vector3(center.x, center.y, 0.12),
    width: Math.max(size.x * 0.6, 1.1),
    height: Math.max(size.y * 0.68, 1.1),
  }
}

export interface FovMarker {
  group: THREE.Group
  fillMaterial: THREE.MeshBasicMaterial
  borderMaterial: THREE.LineBasicMaterial
}

/*
 * 成像视野标记：浅紫低透明填充 + 描边框，
 * 首页与工作台共用同一视觉语言。
 */
export function createFovMarker(
  placement: FovPlacement,
): FovMarker {
  const group = new THREE.Group()
  group.position.copy(placement.center)

  const fillMaterial = new THREE.MeshBasicMaterial({
    color: '#c4b5fd',
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  const borderMaterial = new THREE.LineBasicMaterial({
    color: '#e2d8ff',
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(
      placement.width,
      placement.height,
    ),
    fillMaterial,
  )

  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(fill.geometry),
    borderMaterial,
  )

  fill.renderOrder = 3
  border.renderOrder = 4
  group.add(fill, border)

  return { group, fillMaterial, borderMaterial }
}

/*
 * 神经元主场景平面坐标 → FOV 平面局部坐标（唯一映射）。
 *
 * 主场景把 ROI 坐标等比缩放到 DISPLAY_SIZE 跨度（z=0），
 * 这里再按同一比例缩进 FOV 平面：等比、无剪切，
 * 保证主场景中相邻的神经元在脑内视图中依然相邻。
 */
export function neuronSceneToFov(
  x: number,
  y: number,
  placement: FovPlacement,
  fit = 0.86,
) {
  const scale =
    (Math.min(placement.width, placement.height) * fit) /
    DISPLAY_SIZE

  return { x: x * scale, y: y * scale, scale }
}
