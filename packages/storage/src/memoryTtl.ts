/**
 * Core memory TTL helpers for auto-written entries.
 *
 * Contract:
 *  - Auto writes stamp `expires: YYYY-MM-DD` (default +30 days) and `source: auto`.
 *  - Manual entries without `expires` never expire.
 *  - Invalid / unparseable `expires` is treated as not expired (keep the memory)
 *    and emits a warn. Do not drop memories because parsing failed.
 *  - `expires === today` is still valid; expiry starts the next calendar day.
 *  - Deep layers take an injected `today` string. They must not call `new Date()`.
 */

export const AUTO_MEMORY_TTL_DAYS = 30
export const AUTO_MEMORY_SOURCE = 'auto'
export const MEMORY_EXPIRES_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export type MemoryTtlWarn = (message: string) => void

/** Format a calendar date as YYYY-MM-DD in UTC. Tests pass a frozen Date. */
export function memoryCalendarDate(now?: Date): string {
  const d = now ?? new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addCalendarDays(today: string, days: number): string {
  const parsed = parseStrictYmd(today)
  if (!parsed) {
    throw new Error(`invalid calendar date: ${today}`)
  }
  const dt = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return memoryCalendarDate(dt)
}

function parseStrictYmd(value: string): { y: number; m: number; d: number } | null {
  const match = MEMORY_EXPIRES_RE.exec(value.trim())
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
    return null
  }
  return { y, m, d }
}

/**
 * Parse frontmatter `expires`. Returns the normalized YYYY-MM-DD or null
 * when missing / invalid (null = never expire).
 */
export function parseMemoryExpires(
  raw: string | undefined,
  warn?: MemoryTtlWarn,
  context?: string,
): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = parseStrictYmd(trimmed)
  if (!parsed) {
    const where = context ? ` (${context})` : ''
    warn?.(`invalid memory expires${where}: ${JSON.stringify(raw)}; treating as not expired`)
    return null
  }
  return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
}

/** True only when `expires` is a valid date strictly before `today`. */
export function isMemoryExpired(
  expires: string | undefined,
  today: string,
  warn?: MemoryTtlWarn,
  context?: string,
): boolean {
  const parsed = parseMemoryExpires(expires, warn, context)
  if (!parsed) return false
  const todayParsed = parseStrictYmd(today)
  if (!todayParsed) {
    warn?.(`invalid memory today baseline: ${JSON.stringify(today)}; treating entries as not expired`)
    return false
  }
  return parsed < today
}

export function defaultAutoExpires(today: string): string {
  return addCalendarDays(today, AUTO_MEMORY_TTL_DAYS)
}
