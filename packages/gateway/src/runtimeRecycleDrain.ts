/**
 * Planned v5 runtime recycle drain.
 *
 * The host may replace a stale runtime only after both in-memory admission
 * gates are armed and the durable inbox proves that no model turn is still in
 * `running`. A non-200 result always means "defer recycle" to the supervisor.
 */

export interface RuntimeRecycleDrainDeps {
  ttlMs: number
  now: () => number
  armGatewayDrain: (until: number) => void
  isGatewayDrainActive: (now: number) => boolean
  releaseGatewayDrain: () => void
  armSessionDrain: (ttlMs: number) => { accepted: boolean; activeTurns: number }
  isSessionDrainActive: (now: number) => boolean
  releaseSessionDrain: () => void
  activeIngress: () => number
  countDurableRunning: () => Promise<number>
}

export type RuntimeRecycleDrainDecision =
  | { ok: true; status: 200; drainTtlMs: number }
  | {
      ok: false
      status: 409 | 503
      reason:
        | 'active_turn'
        | 'drain_in_progress'
        | 'drain_state_unavailable'
        | 'drain_fence_expired'
      activeIngress?: number
      activeTurns?: number
      durableRunning?: number
    }

export async function attemptRuntimeRecycleDrain(
  deps: RuntimeRecycleDrainDeps,
): Promise<RuntimeRecycleDrainDecision> {
  const release = (): void => {
    deps.releaseGatewayDrain()
    deps.releaseSessionDrain()
  }

  deps.armGatewayDrain(deps.now() + deps.ttlMs)
  const sessionDrain = deps.armSessionDrain(deps.ttlMs)
  const initialIngress = deps.activeIngress()
  if (!sessionDrain.accepted || initialIngress > 0) {
    release()
    return {
      ok: false,
      status: 409,
      reason: 'active_turn',
      activeIngress: initialIngress,
      activeTurns: sessionDrain.activeTurns,
    }
  }

  let durableRunning: number
  try {
    durableRunning = await deps.countDurableRunning()
  } catch {
    release()
    return { ok: false, status: 503, reason: 'drain_state_unavailable' }
  }

  // Re-read ingress after the awaited SQLite acquisition. New ingress cannot
  // pass while the gateway gate is armed; this catches any work that entered
  // immediately before the gate was set and had not yet been observed.
  const activeIngress = deps.activeIngress()
  if (activeIngress > 0 || durableRunning > 0) {
    release()
    return {
      ok: false,
      status: 409,
      reason: 'active_turn',
      activeIngress,
      activeTurns: sessionDrain.activeTurns,
      durableRunning,
    }
  }

  // SQLite can wait close to its busy timeout. Never answer 200 using a gate
  // that expired while the durable read was pending.
  const finalNow = deps.now()
  if (!deps.isGatewayDrainActive(finalNow) || !deps.isSessionDrainActive(finalNow)) {
    release()
    return { ok: false, status: 503, reason: 'drain_fence_expired' }
  }

  return { ok: true, status: 200, drainTtlMs: deps.ttlMs }
}

/**
 * Serializes the host handshake for one gateway process.
 *
 * A failed overlapping request must never release the scalar gates retained
 * by an earlier successful request. While an evaluation is pending, or while
 * its accepted dual fence is still active, later callers get a fail-closed
 * busy response without touching either gate.
 */
export class RuntimeRecycleDrainCoordinator {
  private current: { state: 'pending' | 'accepted' } | null = null

  constructor(private readonly deps: RuntimeRecycleDrainDeps) {}

  attempt(): Promise<RuntimeRecycleDrainDecision> {
    const current = this.current
    if (current !== null) {
      const now = this.deps.now()
      const fenceStillActive =
        current.state === 'accepted' &&
        this.deps.isGatewayDrainActive(now) &&
        this.deps.isSessionDrainActive(now)
      if (current.state === 'pending' || fenceStillActive) {
        return Promise.resolve({
          ok: false,
          status: 409,
          reason: 'drain_in_progress',
        })
      }
      this.current = null
    }

    const entry: { state: 'pending' | 'accepted' } = { state: 'pending' }
    this.current = entry
    return attemptRuntimeRecycleDrain(this.deps).then(
      (decision) => {
        if (decision.ok) {
          entry.state = 'accepted'
        } else if (this.current === entry) {
          this.current = null
        }
        return decision
      },
      (err) => {
        if (this.current === entry) this.current = null
        throw err
      },
    )
  }
}
