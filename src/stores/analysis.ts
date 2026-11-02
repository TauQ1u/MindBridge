import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Experiment } from '@/types/models'

export type AnalysisTab = 'overview' | 'behavior-neural' | 'network' | 'advanced' | 'report'

export const useAnalysisStore = defineStore('analysis', () => {
  const selectedConditionIds = ref<string[]>([])
  const referenceConditionId = ref('')
  const selectedBehavior = ref('')
  const selectedNeuronId = ref('')
  const selectedPair = ref<{ left: string; right: string }>({ left: '', right: '' })
  const activeTab = ref<AnalysisTab>('overview')
  const reportEvidence = ref<string[]>([])

  const mode = computed(() => selectedConditionIds.value.length > 1 ? 'comparison' : 'single')

  function initialize(experiments: Experiment[], context?: { conditionId?: string; behavior?: string; neuronId?: string }) {
    const available = experiments.map(item => item.condition)
    if (!selectedConditionIds.value.length) selectedConditionIds.value = available
    else selectedConditionIds.value = selectedConditionIds.value.filter(id => available.includes(id))
    if (!selectedConditionIds.value.length && available.length) selectedConditionIds.value = [available[0]]
    if (!referenceConditionId.value || !selectedConditionIds.value.includes(referenceConditionId.value)) {
      referenceConditionId.value = selectedConditionIds.value[0] || ''
    }
    selectedPair.value = {
      left: referenceConditionId.value,
      right: selectedConditionIds.value.find(id => id !== referenceConditionId.value) || referenceConditionId.value,
    }
    if (context?.behavior) selectedBehavior.value = context.behavior
    if (context?.neuronId) {
      selectedNeuronId.value = context.neuronId
      activeTab.value = 'behavior-neural'
    }
  }

  function toggleCondition(id: string) {
    if (selectedConditionIds.value.includes(id)) {
      // 多条件分析至少保留两个条件，避免退化为单条件页面。
      if (selectedConditionIds.value.length <= 2) return
      selectedConditionIds.value = selectedConditionIds.value.filter(item => item !== id)
    } else {
      selectedConditionIds.value = [...selectedConditionIds.value, id]
    }
    if (!selectedConditionIds.value.includes(referenceConditionId.value)) {
      referenceConditionId.value = selectedConditionIds.value[0] || ''
    }
    if (!selectedConditionIds.value.includes(selectedPair.value.left) || !selectedConditionIds.value.includes(selectedPair.value.right)) {
      selectedPair.value = {
        left: referenceConditionId.value,
        right: selectedConditionIds.value.find(item => item !== referenceConditionId.value) || referenceConditionId.value,
      }
    }
  }

  function addEvidence(id: string) {
    if (!reportEvidence.value.includes(id)) reportEvidence.value.push(id)
  }

  function toggleEvidence(id: string) {
    reportEvidence.value = reportEvidence.value.includes(id)
      ? reportEvidence.value.filter(item => item !== id)
      : [...reportEvidence.value, id]
  }

  return {
    selectedConditionIds, referenceConditionId, selectedBehavior, selectedNeuronId,
    selectedPair, activeTab, reportEvidence, mode, initialize, toggleCondition, addEvidence, toggleEvidence,
  }
})
