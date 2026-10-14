/**
 * OCV5-424 — the one cooldown state machine shared by every service pool.
 *
 * Pure: given a member's current state and an outcome, return the next state.
 * Storage adapters (claude_accounts, api_relay_credentials, pool_api_keys,
 * box_claude_profiles) persist the result; they do not add rules of their own.
 *
 * Invariants:
 *   - never produces 'disabled' / 'banned' (admin-only states). A member that is
 *     disabled/banned keeps its status; only counters move.
 *   - every cooldown has a finite `cooldownUntil`, so recovery always happens
 *     without a human: plain reasons half-open when it passes, auth/credential
 *     reasons are probed first (`needsProbe`).
 */

import type { CooldownReason, PoolOutcome } from './outcome.js'

export type MemberStatus = 'active' | 'cooldown' | 'disabled' | 'banned'

export interface MemberState {
  status: MemberStatus
  healthScore: number
  backoffLevel: number
  /** Consecutive upstream failures in the current window, including this one. */
  consecutiveFailures?: number
}

export interface Transition {
  status: MemberStatus
  healthScore: number
  backoffLevel: number
  /** Set when entering/extending a cooldown; null leaves cooldown fields cleared. */
  cooldownUntil: Date | null
  cooldownReason: CooldownReason | null
  /** True when recovery must probe the credential before reactivating. */
  needsProbe: boolean
  /** Whether the consecutive-failure counter should be cleared. */
  resetFailures: boolean
  /** success / failure counter deltas. */
  successDelta: 0 | 1
  failDelta: 0 | 1
  /** True when status/cooldown changed (callers log a pool_event). */
  changed: boolean
}

export interface PolicyConfig {
  failThreshold: number
  rateLimitMinMs: number
  rateLimitMaxMs: number
  rateLimitBaseMs: number
  quotaDefaultMs: number
  quotaMaxMs: number
  authBaseMs: number
  authMaxMs: number
  credentialBaseMs: number
  credentialMaxMs: number
  upstreamBaseMs: number
  upstreamMaxMs: number
  healthOnSuccess: number
  healthOnFailure: number
  maxBackoffLevel: number
}

const MIN = 60 * 1000
const HOUR = 60 * MIN

export const DEFAULT_POLICY: PolicyConfig = Object.freeze({
  failThreshold: 3,
  rateLimitMinMs: 15 * 1000,
  rateLimitMaxMs: 15 * MIN,
  rateLimitBaseMs: 30 * 1000,
  quotaDefaultMs: HOUR,
  quotaMaxMs: 7 * 24 * HOUR,
  authBaseMs: 5 * MIN,
  authMaxMs: 6 * HOUR,
  credentialBaseMs: 30 * MIN,
  credentialMaxMs: 24 * HOUR,
  upstreamBaseMs: 10 * MIN,
  upstreamMaxMs: HOUR,
  healthOnSuccess: 10,
  healthOnFailure: 20,
  maxBackoffLevel: 30,
})

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** base · 2^level, capped. */
export function backoffMs(baseMs: number, level: number, maxMs: number): number {
  const exp = Math.min(level, 20)
  return Math.min(maxMs, baseMs * 2 ** exp)
}

function isAdminState(s: MemberStatus): boolean {
  return s === 'disabled' || s === 'banned'
}

export function decide(
  state: MemberState,
  outcome: PoolOutcome,
  now: Date,
  cfg: PolicyConfig = DEFAULT_POLICY,
): Transition {
  const t = now.getTime()
  const health = clamp(state.healthScore, 0, 100)
  const level = clamp(state.backoffLevel, 0, cfg.maxBackoffLevel)
  const nextLevel = Math.min(cfg.maxBackoffLevel, level + 1)
  const keep: Transition = {
    status: state.status,
    healthScore: health,
    backoffLevel: level,
    cooldownUntil: null,
    cooldownReason: null,
    needsProbe: false,
    resetFailures: false,
    successDelta: 0,
    failDelta: 0,
    changed: false,
  }

  const cool = (reason: CooldownReason, ms: number, opts: { health?: number; probe?: boolean; level?: number } = {}): Transition => {
    if (isAdminState(state.status)) {
      return { ...keep, healthScore: opts.health ?? health, failDelta: 1 }
    }
    return {
      status: 'cooldown',
      healthScore: opts.health ?? health,
      backoffLevel: opts.level ?? nextLevel,
      cooldownUntil: new Date(t + Math.max(1000, ms)),
      cooldownReason: reason,
      needsProbe: opts.probe === true,
      resetFailures: true,
      successDelta: 0,
      failDelta: 1,
      changed: true,
    }
  }

  switch (outcome.kind) {
    case 'success':
      return {
        ...keep,
        healthScore: Math.min(100, health + cfg.healthOnSuccess),
        backoffLevel: 0,
        resetFailures: true,
        successDelta: 1,
      }
    case 'client_error':
    case 'network':
      return keep
    case 'rate_limited': {
      const fromHeader = outcome.retryAfterMs
      const ms =
        fromHeader != null && Number.isFinite(fromHeader)
          ? clamp(fromHeader, cfg.rateLimitMinMs, cfg.rateLimitMaxMs)
          : backoffMs(cfg.rateLimitBaseMs, level, cfg.rateLimitMaxMs)
      return cool('rate_limited', ms)
    }
    case 'quota_exhausted': {
      const until = outcome.resetAt?.getTime()
      const ms =
        until != null && Number.isFinite(until) && until > t
          ? Math.min(until - t, cfg.quotaMaxMs)
          : cfg.quotaDefaultMs
      // A used-up window is not a fault: keep health, keep the backoff level.
      return cool('quota', ms, { level })
    }
    case 'auth_invalid':
      return cool('auth', backoffMs(cfg.authBaseMs, level, cfg.authMaxMs), {
        health: Math.max(0, health - cfg.healthOnFailure),
        probe: true,
      })
    case 'credential_corrupt':
      return cool('credential', backoffMs(cfg.credentialBaseMs, level, cfg.credentialMaxMs), {
        health: 0,
        probe: true,
      })
    case 'upstream_error': {
      const lowered = Math.max(0, health - cfg.healthOnFailure)
      const strikes = state.consecutiveFailures ?? 1
      if (strikes >= cfg.failThreshold && state.status === 'active') {
        return cool('upstream', backoffMs(cfg.upstreamBaseMs, level, cfg.upstreamMaxMs), { health: lowered })
      }
      return { ...keep, healthScore: lowered, failDelta: 1 }
    }
  }
}

/**
 * Result of a recovery probe (auth/credential cooldowns). Success reactivates at
 * half health; failure extends the same reason with a longer backoff.
 */
export function decideProbe(
  state: MemberState & { cooldownReason: CooldownReason | null },
  ok: boolean,
  now: Date,
  cfg: PolicyConfig = DEFAULT_POLICY,
): Transition {
  if (isAdminState(state.status)) return decide(state, { kind: 'client_error' }, now, cfg)
  if (ok) {
    return {
      status: 'active',
      healthScore: 50,
      backoffLevel: state.backoffLevel,
      cooldownUntil: null,
      cooldownReason: null,
      needsProbe: false,
      resetFailures: true,
      successDelta: 0,
      failDelta: 0,
      changed: true,
    }
  }
  const outcome: PoolOutcome =
    state.cooldownReason === 'credential'
      ? { kind: 'credential_corrupt', detail: 'probe_failed' }
      : { kind: 'auth_invalid', detail: 'probe_failed' }
  return decide({ ...state, status: 'cooldown' }, outcome, now, cfg)
}

/** Half-open for reasons that need no probe. */
export function halfOpenTransition(state: MemberState): Transition {
  return {
    status: 'active',
    healthScore: 50,
    backoffLevel: state.backoffLevel,
    cooldownUntil: null,
    cooldownReason: null,
    needsProbe: false,
    resetFailures: true,
    successDelta: 0,
    failDelta: 0,
    changed: true,
  }
}

export function reasonNeedsProbe(reason: CooldownReason | null | undefined): boolean {
  return reason === 'auth' || reason === 'credential'
}
