import type { Experiment } from '@/types/models'

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
    videoUrl: `/api/artifacts/${id}.raw.video`,
  }
}
