/** 统一时间戳格式：mm:ss.mmm（文档 §4 等宽数字规范） */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  const whole = Math.floor(rest)
  const millis = Math.round((rest - whole) * 1000)
  const carry = millis === 1000
  return `${String(minutes).padStart(2, '0')}:${String(carry ? whole + 1 : whole).padStart(2, '0')}.${String(carry ? 0 : millis).padStart(3, '0')}`
}
