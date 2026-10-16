/**
 * OCV5-424 — shared outcome classification for every service pool.
 *
 * Each pool (claude / codex / grok / box / static providers / gemini) reports what
 * happened to a member as one `PoolOutcome`; `decide()` turns it into a state
 * transition. Pools never decide cooldowns themselves.
 */

export type CooldownReason = 'rate_limited' | 'quota' | 'auth' | 'credential' | 'upstream'

export type PoolOutcome =
  | { kind: 'success' }
  /** 429 without quota semantics. `retryAfterMs` from Retry-After when present. */
  | { kind: 'rate_limited'; retryAfterMs?: number | null }
  /** Usage window / billing quota used up. `resetAt` when the provider says when. */
  | { kind: 'quota_exhausted'; resetAt?: Date | null }
  /** 401/403, refresh rejected, revoked grant, expired session. */
  | { kind: 'auth_invalid'; detail?: string | null }
  /** Stored credential cannot be decrypted. */
  | { kind: 'credential_corrupt'; detail?: string | null }
  /** 5xx and other provider-side failures. */
  | { kind: 'upstream_error'; detail?: string | null }
  /** Egress / socket problems: frees the slot, no health penalty. */
  | { kind: 'network'; detail?: string | null }
  /** Caller's fault (bad request body, client abort): no health effect at all. */
  | { kind: 'client_error'; detail?: string | null }

export type PoolOutcomeKind = PoolOutcome['kind']

/** Retry-After as delta-seconds or HTTP-date → ms (null when absent/invalid). */
export function parseRetryAfterMs(value: string | null | undefined, now: Date): number | null {
  if (value == null) return null
  const v = value.trim()
  if (v === '') return null
  if (/^\d+$/.test(v)) {
    const sec = Number.parseInt(v, 10)
    return Number.isFinite(sec) ? sec * 1000 : null
  }
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now.getTime())
}

/** Epoch seconds / ms / ISO string → Date (null when unparseable). */
export function parseResetAt(value: string | null | undefined): Date | null {
  if (value == null) return null
  const v = value.trim()
  if (v === '') return null
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    return new Date(n > 1e12 ? n : n * 1000)
  }
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t)
}

interface HeaderSource {
  get(name: string): string | null
}

/** A 429 whose reset is further away than this is a used-up window, not a burst limit. */
export const QUOTA_RESET_THRESHOLD_MS = 15 * 60 * 1000

/**
 * HTTP status (+ headers) from a provider → outcome.
 *
 * - 2xx → success
 * - 429: Anthropic's unified rate-limit headers carry the window reset; a reset
 *   more than 15 min away (or `quotaHint`) means the window is used up → quota.
 *   Otherwise rate_limited with Retry-After.
 * - 402 → quota (billing). 401 → auth. 408/425 → network. 5xx → upstream.
 * - 403 → upstream (counted toward the 3-strike cooldown, not an instant auth
 *   cooldown): providers also send 403 for request-specific refusals.
 * - Other 4xx → client_error (request-specific; the member is not at fault).
 */
export function classifyHttpOutcome(
  status: number,
  headers: HeaderSource | null,
  now: Date,
  opts: { quotaHint?: boolean } = {},
): PoolOutcome {
  if (status >= 200 && status < 300) return { kind: 'success' }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers?.get('retry-after'), now)
    const resetAt =
      parseResetAt(headers?.get('anthropic-ratelimit-unified-reset')) ??
      parseResetAt(headers?.get('x-ratelimit-reset'))
    const resetFar = resetAt !== null && resetAt.getTime() - now.getTime() > QUOTA_RESET_THRESHOLD_MS
    if (opts.quotaHint === true || resetFar) {
      return { kind: 'quota_exhausted', resetAt }
    }
    return { kind: 'rate_limited', retryAfterMs }
  }
  if (status === 402) return { kind: 'quota_exhausted', resetAt: null }
  if (opts.quotaHint === true) return { kind: 'quota_exhausted', resetAt: null }
  if (status === 401) return { kind: 'auth_invalid', detail: 'http_401' }
  if (status === 403) return { kind: 'upstream_error', detail: 'http_403' }
  if (status === 408 || status === 425) return { kind: 'network', detail: `http_${status}` }
  if (status >= 500) return { kind: 'upstream_error', detail: `http_${status}` }
  return { kind: 'client_error', detail: `http_${status}` }
}

// ── attaching an outcome to an error so finalize/release can read it ──────────

const OUTCOME = Symbol.for('openclaude.poolOutcome')

/** Tag an error with the pool outcome that caused it (returns the same error). */
export function attachPoolOutcome<E>(err: E, outcome: PoolOutcome): E {
  if (err !== null && typeof err === 'object') {
    Object.defineProperty(err, OUTCOME, { value: outcome, enumerable: false, configurable: true })
  }
  return err
}

export function readPoolOutcome(err: unknown): PoolOutcome | null {
  if (err === null || typeof err !== 'object') return null
  const v = (err as Record<symbol, unknown>)[OUTCOME]
  return v !== null && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string'
    ? (v as PoolOutcome)
    : null
}

/** Short, credential-free label for last_error / pool_events. */
export function outcomeLabel(o: PoolOutcome): string {
  switch (o.kind) {
    case 'success':
      return 'success'
    case 'rate_limited':
      return o.retryAfterMs != null ? `rate_limited:${Math.round(o.retryAfterMs / 1000)}s` : 'rate_limited'
    case 'quota_exhausted':
      return o.resetAt ? `quota_exhausted:${o.resetAt.toISOString()}` : 'quota_exhausted'
    default:
      return o.detail ? `${o.kind}:${o.detail}`.slice(0, 200) : o.kind
  }
}
