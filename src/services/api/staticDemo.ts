export const isStaticDemoMode = !import.meta.env.VITE_API_BASE_URL

const base = import.meta.env.BASE_URL

export function staticDataUrl(path: string) {
  return `${base}data/${path.replace(/^\/+/, '')}`
}

export function staticArtifactUrl(artifactId: string) {
  const [scope, ...parts] = artifactId.split('.')
  const name = parts.join('.')
  const condition = /^[a-z0-9_-]+$/i.test(scope) && scope !== 'shared' ? scope : ''
  const legacy: Record<string, string> = {
    'raw.video': `raw_input/${condition}/video.mp4`,
    'raw.eeg_emg': `raw_input/${condition}/eeg_emg.csv`,
    'raw.calcium': `raw_input/${condition}/calcium_traces.csv`,
    'review.timeline': `review/${condition}/timeline.csv`,
    'review.conflicts': `review/${condition}/conflicts.csv`,
    'visualization.calcium': `visualization_input/${condition}/calcium.csv`,
    'visualization.dynamic_edges': `visualization_input/${condition}/dynamic_edges.csv`,
    'visualization.final_label_timeline': `visualization_input/${condition}/final_label_timeline.csv`,
    'visualization.metadata': `visualization_input/${condition}/metadata.json`,
    'visualization.behavior_stats': `visualization_input/${condition}/behavior_stats.json`,
    'model_output.decoder_modules': `model_output/${condition}/decoder_modules.json`,
    'model_output.neuron_module_profiles': `model_output/${condition}/neuron_module_profiles.csv`,
    'model_output.module_frame_evidence': `model_output/${condition}/module_frame_evidence.json`,
  }
  if (scope === 'shared' && name === 'neuron_positions') return staticDataUrl('visualization_input/neuron_positions.csv')
  const mapped = legacy[name]
  return mapped ? staticDataUrl(mapped) : staticDataUrl('missing')
}

export async function fetchStaticJson<T>(path: string): Promise<T> {
  const response = await fetch(staticDataUrl(path))
  if (!response.ok) throw new Error(`静态演示数据读取失败 (${response.status}): ${path}`)
  return response.json() as Promise<T>
}

export async function fetchStaticText(path: string): Promise<string> {
  const response = await fetch(staticDataUrl(path))
  if (!response.ok) throw new Error(`静态演示数据读取失败 (${response.status}): ${path}`)
  return response.text()
}

export function readDemoState<T>(key: string, fallback: T): T {
  try {
    const value = sessionStorage.getItem(`mindbridge.demo.${key}`)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

export function writeDemoState<T>(key: string, value: T) {
  try { sessionStorage.setItem(`mindbridge.demo.${key}`, JSON.stringify(value)) } catch { /* ignore private browsing restrictions */ }
}
