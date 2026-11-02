import { useCallback, useMemo, useRef } from 'react'
import { NeuronScene } from '@neuron3d/neuron/NeuronScene'
import { calculateExtent, createDefaultSizes, createPositionMap, numericNeuronSort } from '@neuron3d/neuron/neuronUtils'
import type { VisualizationDataset } from '@/services/api/visualizationApi'

export interface MPFCNeuronRootProps {
  dataset: VisualizationDataset
  currentTimestamp: number
  selectedNeuronId?: string
  highlightNeuronIds?: string[]
  topNeuronIds?: string[]
  highlightColor?: string
  onNeuronSelect: (id: string | null) => void
}

export function MPFCNeuronRoot({ dataset, currentTimestamp, selectedNeuronId, highlightNeuronIds, topNeuronIds, highlightColor, onNeuronSelect }: MPFCNeuronRootProps) {
  /*
   * NeuronScene 的场景重建 effect 依赖 onSelect 的引用稳定性。
   * 父层每次渲染都传入新的内联函数会直接触发整场景销毁重建，
   * 这里用 ref 固化成稳定回调，保证场景只在数据 / 筛选变化时重建。
   */
  const onNeuronSelectRef = useRef(onNeuronSelect)
  onNeuronSelectRef.current = onNeuronSelect
  const stableOnNeuronSelect = useCallback((id: string | null) => {
    onNeuronSelectRef.current(id)
  }, [])

  /*
   * 行为解码贡献模块高亮集合：
   * 成员集合 + Top 3 集合以 Set 形式固化，避免播放期间
   * 父层每帧传入新数组导致场景反复重建。
   */
  const highlightSet = useMemo(() => new Set(highlightNeuronIds ?? []), [highlightNeuronIds])
  const topSet = useMemo(() => new Set(topNeuronIds ?? []), [topNeuronIds])

  const allIds = useMemo(() => {
    const frameIds = dataset.frames[0] ? Object.keys(dataset.frames[0].values) : []
    return Array.from(new Set([...frameIds, ...dataset.positions.keys()])).sort(numericNeuronSort)
  }, [dataset])
  const neuronIds = allIds
  const sizes = useMemo(() => createDefaultSizes(neuronIds), [neuronIds])
  const positions = useMemo(() => createPositionMap(neuronIds, dataset.positions), [neuronIds, dataset])
  const extent = useMemo(() => calculateExtent(dataset.frames), [dataset])
  const currentIndex = useMemo(() => {
    const frames = dataset.frames
    if (frames.length < 2) return 0
    let lo = 0
    let hi = frames.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (Number(frames[mid].stamp) < currentTimestamp) lo = mid + 1
      else hi = mid
    }
    if (lo === 0) return 0
    return Math.abs(Number(frames[lo].stamp) - currentTimestamp) < Math.abs(Number(frames[lo - 1].stamp) - currentTimestamp) ? lo : lo - 1
  }, [currentTimestamp, dataset.frames])
  const frame = dataset.frames[currentIndex] ?? dataset.frames[0]
  const allowed = useMemo(() => new Set(neuronIds), [neuronIds])
  const edges = useMemo(() => (dataset.edgeFrames[currentIndex] ?? [])
    .filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)), [allowed, currentIndex, dataset.edgeFrames])
  if (!frame) return null
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }} data-selected-neuron={selectedNeuronId || ''}>
      <NeuronScene neuronIds={neuronIds} frame={frame} sizes={sizes} positions={positions} edges={edges} extent={extent}
        hasActivityData resetSignal={0} transitionMs={390} onSelect={stableOnNeuronSelect}
        highlightNeuronIds={highlightSet} topNeuronIds={topSet} highlightColor={highlightColor} />
      {selectedNeuronId ? <div style={{ position: 'absolute', left: 12, top: 12, zIndex: 3, padding: '5px 8px', border: '1px solid rgba(127,180,255,.4)', borderRadius: 6, background: 'rgba(8,16,30,.85)', color: '#7fb4ff', font: '11px Consolas, monospace', pointerEvents: 'none' }}>Selected · {selectedNeuronId}</div> : null}
    </div>
  )
}
