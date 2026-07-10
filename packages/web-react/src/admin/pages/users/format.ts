// users 页纯展示 / 解析助手（自带副本，页面自洽，不依赖姊妹页目录）。

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

/** 百分比（0~1 → "12.3%"）。 */
export function fmtPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** ISO → 本地日期时间（24h）。null → '—'。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 「¥ 金额字符串」→ cents 整数。合法要求：可选负号 + 整数部分 + 最多 2 位小数，
 * 且结果非零。非法（空 / 格式错 / 零）→ null。
 *
 * 与 vanilla `parseYuanToCents` 同语义：admin 输入 ¥，内部转 cents，避免把「加 ¥1」
 * 误发成 1 分或 100×。
 */
export function parseYuanToCents(raw: string): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null
  const neg = s.startsWith('-')
  const [intPart, fracRaw = ''] = s.replace('-', '').split('.')
  const frac = `${fracRaw}00`.slice(0, 2)
  const cents = Number(intPart) * 100 + Number(frac)
  if (!Number.isFinite(cents) || cents === 0) return null
  return neg ? -cents : cents
}
