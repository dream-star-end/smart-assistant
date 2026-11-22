/**
 * 4-digit short-code <-> pending decision bidirectional registry.
 *
 * Security invariants:
 *   - Strict per-uid isolation: codes are scoped to `(userId, code)` and lookup
 *     rejects any attempt to resolve a code owned by a different userId.
 *   - TTL enforced on every lookup; expired codes are evicted immediately and
 *     cannot be replayed.
 *   - Bidirectional: repeated `getOrAssign(userId, decisionId)` returns the same
 *     active 4-digit code so `/pending` and proactive push cards stay consistent.
 */

import { randomInt } from 'node:crypto'

export const DEFAULT_SHORT_CODE_TTL_MS = 15 * 60_000
export const DEFAULT_SHORT_CODE_COOLDOWN_MS = 15 * 60_000
const SHORT_CODE_RE = /^\d{4}$/

export interface ShortCodeEntry {
  code: string
  userId: string
  decisionId: string
  createdAt: number
  expiresAt: number
}

export class ShortCodeRegistry {
  /** Key: `${userId}:${code}` -> ShortCodeEntry */
  private readonly byUserCode = new Map<string, ShortCodeEntry>()
  /** Key: `${userId}:${decisionId}` -> code */
  private readonly byUserDecision = new Map<string, string>()
  /** Key: `${userId}:${code}` -> cooldownUntilMs (prevents immediate reuse after release). */
  private readonly cooldownUntil = new Map<string, number>()
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly cooldownMs: number
  private readonly randDigit: () => number

  constructor(opts?: {
    now?: () => number
    defaultTtlMs?: number
    /** Cooldown duration after a code is invalidated/expired before it may be reassigned. */
    cooldownMs?: number
    /** Test-injectable random integer generator in [1000, 9999]. */
    randCode?: () => number
  }) {
    this.now = opts?.now ?? (() => Date.now())
    this.defaultTtlMs = Math.max(1000, opts?.defaultTtlMs ?? DEFAULT_SHORT_CODE_TTL_MS)
    this.cooldownMs = Math.max(0, opts?.cooldownMs ?? DEFAULT_SHORT_CODE_COOLDOWN_MS)
    this.randDigit = opts?.randCode ?? (() => randomInt(1000, 10000))
  }

  private userCodeKey(userId: string, code: string): string {
    return `${userId}:${code}`
  }

  private userDecisionKey(userId: string, decisionId: string): string {
    return `${userId}:${decisionId}`
  }

  pruneExpired(nowMs = this.now()): number {
    let removed = 0
    for (const [k, entry] of this.byUserCode.entries()) {
      if (entry.expiresAt <= nowMs) {
        this.byUserCode.delete(k)
        const decKey = this.userDecisionKey(entry.userId, entry.decisionId)
        if (this.byUserDecision.get(decKey) === entry.code) {
          this.byUserDecision.delete(decKey)
        }
        if (this.cooldownMs > 0) {
          this.cooldownUntil.set(k, nowMs + this.cooldownMs)
        }
        removed += 1
      }
    }
    for (const [k, until] of this.cooldownUntil.entries()) {
      if (until <= nowMs) this.cooldownUntil.delete(k)
    }
    return removed
  }

  private isCodeUnavailable(userId: string, candidate: string, nowMs: number): boolean {
    const key = this.userCodeKey(userId, candidate)
    if (this.byUserCode.has(key)) return true
    const until = this.cooldownUntil.get(key)
    return until !== undefined && until > nowMs
  }

  /**
   * Return an existing unexpired 4-digit code for `(userId, decisionId)` or
   * allocate a fresh collision-free 4-digit code bounded by TTL, cooldown, and decision expiry.
   */
  getOrAssign(
    userId: string,
    decisionId: string,
    opts?: { expiresAtMs?: number | null; ttlMs?: number },
  ): ShortCodeEntry {
    const uid = userId.trim()
    const nowMs = this.now()
    this.pruneExpired(nowMs)

    const decKey = this.userDecisionKey(uid, decisionId)
    const existingCode = this.byUserDecision.get(decKey)
    if (existingCode) {
      const existing = this.byUserCode.get(this.userCodeKey(uid, existingCode))
      if (existing && existing.expiresAt > nowMs) {
        return { ...existing }
      }
    }

    const ttlMs = Math.max(1000, opts?.ttlMs ?? this.defaultTtlMs)
    const desiredExpiry = nowMs + ttlMs
    const expiresAt =
      typeof opts?.expiresAtMs === 'number' && Number.isFinite(opts.expiresAtMs)
        ? Math.min(desiredExpiry, Math.max(nowMs + 1000, opts.expiresAtMs))
        : desiredExpiry

    let code = ''
    for (let attempt = 0; attempt < 64; attempt++) {
      const candidate = String(this.randDigit()).padStart(4, '0').slice(-4)
      if (!SHORT_CODE_RE.test(candidate)) continue
      if (!this.isCodeUnavailable(uid, candidate, nowMs)) {
        code = candidate
        break
      }
    }
    if (!code) {
      for (let n = 1000; n <= 9999; n++) {
        const candidate = String(n)
        if (!this.isCodeUnavailable(uid, candidate, nowMs)) {
          code = candidate
          break
        }
      }
    }
    if (!code) {
      throw new Error('short code space exhausted for user')
    }

    const entry: ShortCodeEntry = {
      code,
      userId: uid,
      decisionId,
      createdAt: nowMs,
      expiresAt,
    }
    this.byUserCode.set(this.userCodeKey(uid, code), entry)
    this.byUserDecision.set(decKey, code)
    return { ...entry }
  }

  /**
   * Look up a 4-digit code strictly scoped to `userId`.
   * Returns `{ ok: true, entry }` or `{ ok: false, reason }`.
   */
  lookup(
    userId: string,
    rawCode: string,
  ):
    | { ok: true; entry: ShortCodeEntry }
    | { ok: false; reason: 'invalid_format' | 'expired' | 'not_found' } {
    const code = rawCode.trim()
    if (!SHORT_CODE_RE.test(code)) {
      return { ok: false, reason: 'invalid_format' }
    }
    const uid = userId.trim()
    const nowMs = this.now()
    const key = this.userCodeKey(uid, code)
    const entry = this.byUserCode.get(key)
    if (!entry) {
      return { ok: false, reason: 'not_found' }
    }
    if (entry.userId !== uid) {
      return { ok: false, reason: 'not_found' }
    }
    if (entry.expiresAt <= nowMs) {
      this.byUserCode.delete(key)
      const decKey = this.userDecisionKey(uid, entry.decisionId)
      if (this.byUserDecision.get(decKey) === code) {
        this.byUserDecision.delete(decKey)
      }
      return { ok: false, reason: 'expired' }
    }
    return { ok: true, entry: { ...entry } }
  }

  /** Reverse lookup: decisionId -> active 4-digit code for `userId`. */
  getCodeForDecision(userId: string, decisionId: string): string | null {
    const uid = userId.trim()
    const nowMs = this.now()
    const code = this.byUserDecision.get(this.userDecisionKey(uid, decisionId))
    if (!code) return null
    const entry = this.byUserCode.get(this.userCodeKey(uid, code))
    if (!entry || entry.expiresAt <= nowMs) return null
    return code
  }

  invalidateByDecisionId(userId: string, decisionId: string): boolean {
    const uid = userId.trim()
    const decKey = this.userDecisionKey(uid, decisionId)
    const code = this.byUserDecision.get(decKey)
    if (!code) return false
    const codeKey = this.userCodeKey(uid, code)
    this.byUserDecision.delete(decKey)
    this.byUserCode.delete(codeKey)
    if (this.cooldownMs > 0) {
      this.cooldownUntil.set(codeKey, this.now() + this.cooldownMs)
    }
    return true
  }

  invalidateByCode(userId: string, code: string): boolean {
    const uid = userId.trim()
    const key = this.userCodeKey(uid, code.trim())
    const entry = this.byUserCode.get(key)
    if (!entry) return false
    this.byUserCode.delete(key)
    const decKey = this.userDecisionKey(uid, entry.decisionId)
    if (this.byUserDecision.get(decKey) === entry.code) {
      this.byUserDecision.delete(decKey)
    }
    if (this.cooldownMs > 0) {
      this.cooldownUntil.set(key, this.now() + this.cooldownMs)
    }
    return true
  }
}
