// dashboard/users 页共用的纯展示格式化助手（无副作用，便于单测）。
// 不放进 admin/lib（地基所有），页面自带一份轻量副本，避免跨页 agent 争用地基文件。

/** 整数千分位（zh-CN）。null/NaN → '—'。 */
export function fmtInt(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? Number(n) : n
  if (v == null || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('zh-CN')
}

/** cents → ¥ 金额（两位小数，千分位）。 */
export function fmtYuan(cents: number | string | null | undefined): string {
  const v = typeof cents === 'string' ? Number(cents) : cents
  if (v == null || !Number.isFinite(v)) return '—'
  return `¥${(v / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** 大数紧凑表示（1.2K / 3.4M / 5.6B）。用于累计请求 / token 这类大计数。 */
export function fmtCompact(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? Number(n) : n
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs < 1000) return String(Math.round(v))
  const units: Array<[string, number]> = [
    ['B', 1e9],
    ['M', 1e6],
    ['K', 1e3],
  ]
  for (const [u, base] of units) {
    if (abs >= base) {
      const scaled = v / base
      return `${scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : 1)}${u}`
    }
  }
  return String(Math.round(v))
}

/** 百分比（0~1 → "12.3%"）。 */
export function fmtPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** ISO 日期 "YYYY-MM-DD" → "MM-DD"（图表 X 轴短标签）。 */
export function dayShort(day: string): string {
  return typeof day === 'string' && day.length >= 10 ? day.slice(5) : day || ''
}

/** 小时桶 "YYYY-MM-DD HH:00" → 窄窗 "HH:00" / 宽窗 "MM-DD HH:00"。 */
export function hourShort(hour: string, wide: boolean): string {
  if (typeof hour !== 'string' || hour.length < 16) return hour || ''
  return wide ? hour.slice(5, 16) : hour.slice(11, 16)
}

/** ISO → 本地日期时间（24h）。null → '—'。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}
