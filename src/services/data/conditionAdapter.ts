import type { Experiment } from '@/types/models'
import { apiUrl } from '@/services/api/http'

export interface ConditionViewModel {
  id: string
  label: string
  mouseLabel: string
  videoUrl: string
}

export function toConditionViewModel(experiment: Experiment): ConditionViewModel {
  const id = experiment.condition
  return {
    id,
    label: experiment.displayName,
    mouseLabel: experiment.mouseId,
    videoUrl: apiUrl(`/api/artifacts/${id}.raw.video`),
  }
}
