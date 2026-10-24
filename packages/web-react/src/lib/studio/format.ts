// OCV5-593 display helpers (credits, durations, time codes, relative time).

const nf = new Intl.NumberFormat('zh-CN')

export function formatCredits(value: string | number | bigint): string {
  const n = typeof value === 'string' ? Number(value) : Number(value)
  return Number.isFinite(n) ? nf.format(n) : String(value)
}

/** 37 → "0:37", 75 → "1:15" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 2.4 → "00:02.4" */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

export function formatAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const sec = Math.max(0, Math.round((now - t) / 1000))
  if (sec < 60) return '刚刚'
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时前`
  const days = Math.floor(sec / 86_400)
  return days === 1 ? '昨天' : `${days} 天前`
}

/** Budget share used, 0–100, for the credit pill and budget bars. */
export function budgetPercent(spent: string, reserved: string, budget: string): number {
  const b = Number(budget)
  if (!Number.isFinite(b) || b <= 0) return 0
  return Math.min(100, Math.max(0, ((Number(spent) + Number(reserved)) / b) * 100))
}
