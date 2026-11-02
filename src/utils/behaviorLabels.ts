/*
 * 小鼠行为 / 睡眠标签的中文注释。
 * 语义统一复用 3D 模块的 BEHAVIOR_CONFIG（与建模项目同一字典），
 * UI 展示时通过 withBehaviorZh 附加括号中文。
 */
import { BEHAVIOR_CONFIG } from '@neuron3d/neuron/neuronUtils'

const EXTRA_ZH: Record<string, string> = {
  uncertain: '不确定',
  na: '无标签',
  unknown: '未知',
}

function annotate(label: string): string {
  const key = label.trim().toLowerCase()
  const zh = BEHAVIOR_CONFIG[key]?.meaning ?? EXTRA_ZH[key]
  return zh ? `${label}（${zh}）` : label
}

/** 行为标签 → "English（中文）"；无映射时原样返回 */
export function withBehaviorZh(label?: string | null): string {
  return label ? annotate(label) : ''
}

/** 睡眠分期标签 → "English（中文）"；与行为共用同一字典 */
export function withSleepZh(label?: string | null): string {
  return label ? annotate(label) : ''
}
