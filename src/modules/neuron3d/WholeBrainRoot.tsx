import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { BrainLoadState, BrainSceneHandle } from '@neuron3d/brain/BrainScene'
import { NeuronGalaxyScene } from '@neuron3d/brain/NeuronGalaxyScene'

export interface WholeBrainRootProps {
  /* 受控选中态：右侧导航与场景内双击共用同一状态源 */
  selectedId: string | null
  onSelect: (id: string | null) => void
  onLoadStateChange: (state: BrainLoadState) => void
}

export interface WholeBrainRootHandle {
  getSnapshot: (id: string) => string | null
}

/*
 * 网站首页整脑场景：直接复用建模项目的最新合并场景
 * （脑区结构 + 神经元信号网，单击涟漪 / 双击选区），
 * 黑色背景以匹配建模项目原生夜空效果。
 */
export const WholeBrainRoot = forwardRef<WholeBrainRootHandle, WholeBrainRootProps>(
  function WholeBrainRoot({ selectedId, onSelect, onLoadStateChange }, ref) {
    const brainRef = useRef<BrainSceneHandle | null>(null)

    useImperativeHandle(ref, () => ({
      getSnapshot: (id: string) => brainRef.current?.getSnapshot(id) ?? null,
    }))

    return (
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <NeuronGalaxyScene
          ref={brainRef}
          theme="dark"
          selectedId={selectedId}
          onLoadStateChange={onLoadStateChange}
          onSelect={onSelect}
        />
      </div>
    )
  },
)
