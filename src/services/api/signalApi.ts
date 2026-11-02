import Papa from 'papaparse'
import { apiFetch } from '@/services/api/http'

/*
 * 生理信号（EEG/EMG）静态数据访问层。
 * 原始记录约 36 万行（1000 Hz × 360 s），模块级缓存
 * 保证同一条件只下载解析一次。
 */

export interface EegEmgData {
  sampleRate: number
  duration: number
  eeg1: Float32Array
  eeg2: Float32Array
  emg: Float32Array
  activ: Float32Array
}

const cache = new Map<string, Promise<EegEmgData>>()

export const signalApi = {
  loadEegEmg(conditionId: string): Promise<EegEmgData> {
    if (!/^[a-z0-9_-]+$/i.test(conditionId)) return Promise.reject(new Error('conditionId 格式无效'))
    const cached = cache.get(conditionId)
    if (cached) return cached

    const request = (async (): Promise<EegEmgData> => {
      const response = await apiFetch(`/api/artifacts/${conditionId}.raw.eeg_emg`)
      if (!response.ok) throw new Error(`生理信号数据请求失败 (${response.status})`)
      const text = await response.text()
      const result = Papa.parse<Record<string, unknown>>(text, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: 'greedy',
      })
      if (result.errors.length) throw new Error(`生理信号 CSV 解析失败: ${result.errors[0].message}`)

      const rows = result.data
      const count = rows.length
      const time = new Float32Array(count)
      const eeg1 = new Float32Array(count)
      const eeg2 = new Float32Array(count)
      const emg = new Float32Array(count)
      const activ = new Float32Array(count)

      rows.forEach((row, index) => {
        time[index] = Number(row.time_seconds ?? 0)
        eeg1[index] = Number(row.EEG1 ?? 0)
        eeg2[index] = Number(row.EEG2 ?? 0)
        emg[index] = Number(row.EMG ?? 0)
        activ[index] = Number(row.Activ ?? 0)
      })

      const duration = count > 1 && time[count - 1] > time[0] ? time[count - 1] : 0
      const sampleRate = duration > 0 ? (count - 1) / duration : 1000
      return { sampleRate, duration, eeg1, eeg2, emg, activ }
    })()

    cache.set(conditionId, request)
    request.catch(() => { cache.delete(conditionId) })
    return request
  },
}
