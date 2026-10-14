/**
 * OCV5-424 — service pool registry + the single recovery actor.
 *
 * Each storage (claude_accounts, api_relay_credentials, pool_api_keys,
 * box_claude_profiles, and later Gemini OAuth accounts) registers one adapter.
 * The shared actor drives recovery for all of them on one timer:
 *   1. half-open members whose plain cooldown (rate_limited/quota/upstream) expired;
 *   2. probe members whose auth/credential cooldown is due, then apply the result
 *      through the shared decideProbe (success → active, failure → longer backoff,
 *      transient → retry soon without escalating).
 * Pools never run their own recovery timers.
 */

import type { CooldownReason } from './outcome.js'
import type { PoolMemberKind } from './events.js'

export interface DueProbe {
  id: string
  /** Service pool the member belongs to (e.g. 'claude', 'codex', 'deepseek'). */
  service: string
  reason: CooldownReason
}

export type ProbeResult =
  | { ok: true }
  /** The credential is still bad: escalate the backoff. */
  | { ok: false; detail: string }
  /** Could not tell (egress down, provider 5xx): re-check soon, do not escalate. */
  | { ok: false; transient: true; detail: string }

/** Row shown on the admin 服务池 page (no credential material, ever). */
export interface PoolMemberView {
  service: string
  memberKind: PoolMemberKind
  id: string
  /** 'subscription' (OAuth / session login) or 'api_key'. */
  credentialType: 'subscription' | 'api_key'
  label: string
  status: string
  disabledBy: string | null
  healthScore: number | null
  cooldownReason: CooldownReason | null
  cooldownUntil: string | null
  nextProbeAt: string | null
  lastError: string | null
  lastUsedAt: string | null
  /** Short, non-secret hints: plan, quota %, key fingerprint, egress label. */
  hints: Record<string, string | number | null>
}

export interface PoolAdapter {
  /** Stable adapter name for logs (one adapter may serve several services). */
  name: string
  memberKind: PoolMemberKind
  /** Reactivate expired plain cooldowns; returns how many were reactivated. */
  halfOpenDue(): Promise<number>
  listDueProbes(limit: number): Promise<DueProbe[]>
  probe(member: DueProbe): Promise<ProbeResult>
  applyProbeResult(member: DueProbe, result: ProbeResult): Promise<void>
  /** Members for the admin page. */
  listMembers?(): Promise<PoolMemberView[]>
}

const adapters = new Map<string, PoolAdapter>()

export function registerPoolAdapter(a: PoolAdapter): void {
  adapters.set(a.name, a)
}

export function unregisterPoolAdapter(name: string): void {
  adapters.delete(name)
}

export function listPoolAdapters(): PoolAdapter[] {
  return [...adapters.values()]
}

/** Tests only. */
export function _resetPoolRegistryForTest(): void {
  adapters.clear()
}

export interface PoolRecoveryActorDeps {
  intervalMs?: number
  /** Max probes per adapter per tick (probes call providers; keep it gentle). */
  probesPerTick?: number
  runOnStart?: boolean
  adapters?: () => PoolAdapter[]
  onError?: (msg: string, err: unknown) => void
}

export interface PoolRecoveryTickResult {
  halfOpened: number
  probed: number
  recovered: number
}

export interface PoolRecoveryActorHandle {
  stop(): void
  runNow(): Promise<PoolRecoveryTickResult>
}

export const DEFAULT_POOL_RECOVERY_INTERVAL_MS = 60_000
export const DEFAULT_PROBES_PER_TICK = 3

export function startPoolRecoveryActor(deps: PoolRecoveryActorDeps = {}): PoolRecoveryActorHandle {
  const intervalMs = Math.max(1000, deps.intervalMs ?? DEFAULT_POOL_RECOVERY_INTERVAL_MS)
  const perTick = Math.max(1, deps.probesPerTick ?? DEFAULT_PROBES_PER_TICK)
  const getAdapters = deps.adapters ?? listPoolAdapters
  const onError =
    deps.onError ??
    ((msg: string, err: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn(`[poolRecovery] ${msg}:`, err)
    })
  let stopped = false
  let running: Promise<PoolRecoveryTickResult> | null = null

  async function tickOnce(): Promise<PoolRecoveryTickResult> {
    const out: PoolRecoveryTickResult = { halfOpened: 0, probed: 0, recovered: 0 }
    for (const a of getAdapters()) {
      if (stopped) break
      try {
        out.halfOpened += await a.halfOpenDue()
      } catch (err) {
        onError(`${a.name} halfOpen failed`, err)
      }
      let due: DueProbe[] = []
      try {
        due = await a.listDueProbes(perTick)
      } catch (err) {
        onError(`${a.name} listDueProbes failed`, err)
      }
      for (const m of due) {
        if (stopped) break
        let result: ProbeResult
        try {
          result = await a.probe(m)
        } catch (err) {
          result = { ok: false, transient: true, detail: `probe_threw:${(err as Error)?.name ?? 'error'}` }
        }
        out.probed += 1
        if (result.ok) out.recovered += 1
        try {
          await a.applyProbeResult(m, result)
        } catch (err) {
          onError(`${a.name} applyProbeResult failed`, err)
        }
      }
    }
    return out
  }

  // Single-flight: a slow probe never overlaps the next tick.
  function runOneTick(): Promise<PoolRecoveryTickResult> {
    if (running) return running
    running = tickOnce().finally(() => {
      running = null
    })
    return running
  }

  const timer = setInterval(() => {
    if (stopped) return
    void runOneTick().catch((err) => onError('tick crashed', err))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  if (deps.runOnStart) void runOneTick().catch((err) => onError('initial tick crashed', err))

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: runOneTick,
  }
}
