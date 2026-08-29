/**
 * Single source of truth for delegate concurrency caps.
 *
 * Review vs non-review use different effective maxima (one reserved slot).
 * Gateway's resource gate (`_checkDelegateResourceGate`) and the reject copy
 * (`formatDelegateConcurrencyReject`) both read these values via
 * `delegateConcurrencyCap` — do not duplicate the numeric literals in server.ts.
 *
 * Defaults are the exported constants. Call-time env overlays:
 *   OPENCLAUDE_DELEGATE_MAX_CONCURRENT        integer ≥1, else 5
 *   OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS integer ≥0, else 1,
 *     clamped to max−1 so ordinary work always keeps ≥1 slot.
 * Non-integers (including 2.9) fall back; they are not floored.
 */

export const DELEGATE_MAX_CONCURRENT_DELEGATIONS = 5
export const DELEGATE_REVIEW_RESERVED_SLOTS = 1

function parseDelegateEnvInt(name: string, min: number, fallback: number): number {
  const trimmed = process.env[name]?.trim()
  if (!trimmed) return fallback
  const raw = Number(trimmed)
  if (!Number.isInteger(raw)) return fallback
  return raw >= min ? raw : fallback
}

export function getDelegateMaxConcurrent(): number {
  return parseDelegateEnvInt(
    'OPENCLAUDE_DELEGATE_MAX_CONCURRENT',
    1,
    DELEGATE_MAX_CONCURRENT_DELEGATIONS,
  )
}

export function getDelegateReviewReservedSlots(): number {
  const max = getDelegateMaxConcurrent()
  const parsed = parseDelegateEnvInt(
    'OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS',
    0,
    DELEGATE_REVIEW_RESERVED_SLOTS,
  )
  return Math.min(parsed, Math.max(0, max - 1))
}

export function delegateConcurrencyCap(isReview: boolean): number {
  const max = getDelegateMaxConcurrent()
  return isReview ? max : max - getDelegateReviewReservedSlots()
}

export function formatDelegateConcurrencyReject(args: {
  isReview: boolean
  inUse: number
  perParentInUse?: number
  perParentMax?: number
  waitedS?: number
  queueFull?: boolean
  queueMaxWaiters?: number
}): string {
  const max = delegateConcurrencyCap(args.isReview)
  const role = args.isReview ? 'review' : 'non-review'
  const parts = [`max ${max} ${role}`, `in-use ${args.inUse}/${max}`]
  if (!args.isReview && args.perParentMax != null && args.perParentInUse != null) {
    const full = args.perParentInUse >= args.perParentMax
    parts.push(`per-parent ${args.perParentInUse}/${args.perParentMax}${full ? ' full' : ''}`)
  }
  let msg = `too many concurrent delegations (${parts.join('; ')})`
  if (args.queueFull) {
    const n = args.queueMaxWaiters ?? 8
    msg += `; 排队等待者已满(${n} 个)`
  } else if (args.waitedS !== undefined) {
    msg += `; 已等待 ${args.waitedS}s 资源仍紧张,请稍后重试`
  }
  return msg
}
