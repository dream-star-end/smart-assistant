/**
 * OCV5-424 — shared member selection for every service pool.
 *
 * Weighted Rendezvous Hashing (Thaler-Ravishankar): the same key + same members +
 * same weights always rank the same way, and a weight/member change only moves a
 * proportional share of keys. `rankWRH` returns the full order so callers can fail
 * over down the list; `pickWRH` (scheduler) is `rankWRH(...)[0]`.
 *
 * Tiers: members are grouped by ascending `tier` (e.g. subscriptions 0, API keys 1);
 * a later tier is only ranked after every member of the earlier tier.
 */

import { createHash } from 'node:crypto'

export function defaultHash(s: string): bigint {
  const h = createHash('sha256').update(s).digest()
  return h.readBigUInt64BE(0)
}

/** -ln(u)/w with u ∈ (0,1) from the 53 high bits of the hash. Lower is better. */
export function wrhScore(key: string, id: string, weight: number, hash: (s: string) => bigint = defaultHash): number {
  const h = hash(`${key}:${id}`)
  const h53 = Number(BigInt.asUintN(64, h) >> 11n)
  const u = (h53 + 0.5) / 2 ** 53
  const w = Number.isFinite(weight) && weight > 0 ? weight : 0.05
  return -Math.log(u) / w
}

export interface RankOptions<T> {
  key: string
  id: (m: T) => string
  weight: (m: T) => number
  tier?: (m: T) => number
  hash?: (s: string) => bigint
}

export function rankWRH<T>(members: ReadonlyArray<T>, opts: RankOptions<T>): T[] {
  const hash = opts.hash ?? defaultHash
  const scored = members.map((m, i) => ({
    m,
    i,
    tier: opts.tier ? opts.tier(m) : 0,
    score: wrhScore(opts.key, opts.id(m), opts.weight(m), hash),
  }))
  scored.sort((a, b) => a.tier - b.tier || a.score - b.score || a.i - b.i)
  return scored.map((s) => s.m)
}

/** Weight for members that only carry a health score (API keys, relay keys). */
export function healthWeight(healthScore: number, weight = 100): number {
  return Math.max(0.05, Math.max(1, healthScore) * (weight / 100))
}

export type FailoverMode = 'next_request' | 'before_first_byte'

/**
 * Whether the caller may retry the same request on the next ranked member.
 * Subscription pools never do (switching accounts on a 429 looks like quota
 * evasion — see http/proxy/core.ts); API-key pools may, before any byte was sent.
 */
export function mayFailoverWithinRequest(
  mode: FailoverMode,
  outcomeKind: string,
  bytesSent: boolean,
): boolean {
  if (mode !== 'before_first_byte' || bytesSent) return false
  return (
    outcomeKind === 'rate_limited' ||
    outcomeKind === 'quota_exhausted' ||
    outcomeKind === 'auth_invalid' ||
    outcomeKind === 'credential_corrupt' ||
    outcomeKind === 'upstream_error' ||
    outcomeKind === 'network'
  )
}
