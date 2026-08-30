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
  /**
   * Stage 3: running durable delegate jobs. Absent = flag-off (do not count).
   * `paused_for_cutover` is not running and must not block drain.
   */
  countRunningDelegateJobs?: () => Promise<number> | number
  /**
   * Synchronous ACK-time snapshot. Used after every await so a queued job
   * cannot sneak `queued→running` between count and 200.
   */
  peekRunningDelegateJobs?: () => number
  /** Generation-owned freeze of `claimQueued`. Flag-off omits both freeze/thaw. */
  freezeDelegateDispatch?: (holder: string) => void
  thawDelegateDispatch?: (holder: string) => void
}

export type RuntimeRecycleDrainDecision =
  | { ok: true; status: 200; drainTtlMs: number; freezeHolder?: string }
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
      runningDelegateJobs?: number
    }

export async function attemptRuntimeRecycleDrain(
  deps: RuntimeRecycleDrainDeps,
): Promise<RuntimeRecycleDrainDecision> {
  const holder = deps.freezeDelegateDispatch ? `drain:${deps.now()}` : undefined
  const thaw = (): void => {
    if (holder) deps.thawDelegateDispatch?.(holder)
  }
  const release = (): void => {
    deps.releaseGatewayDrain()
    deps.releaseSessionDrain()
  }
  const fail = (decision: Extract<RuntimeRecycleDrainDecision, { ok: false }>): RuntimeRecycleDrainDecision => {
    thaw()
    release()
    return decision
  }

  // Freeze claimQueued before any await so a queued job cannot promote during
  // durable / delegate count continuations (TOCTOU). Flag-off omits freeze.
  if (holder) deps.freezeDelegateDispatch!(holder)

  deps.armGatewayDrain(deps.now() + deps.ttlMs)
  const sessionDrain = deps.armSessionDrain(deps.ttlMs)
  const initialIngress = deps.activeIngress()
  if (!sessionDrain.accepted || initialIngress > 0) {
    return fail({
      ok: false,
      status: 409,
      reason: 'active_turn',
      activeIngress: initialIngress,
      activeTurns: sessionDrain.activeTurns,
    })
  }

  let durableRunning: number
  try {
    durableRunning = await deps.countDurableRunning()
  } catch {
    return fail({ ok: false, status: 503, reason: 'drain_state_unavailable' })
  }

  let runningDelegateJobs = 0
  if (deps.countRunningDelegateJobs) {
    try {
      runningDelegateJobs = await deps.countRunningDelegateJobs()
    } catch {
      return fail({ ok: false, status: 503, reason: 'drain_state_unavailable' })
    }
  }

  // No await after this point. Peek is the ACK-time snapshot.
  if (deps.peekRunningDelegateJobs) {
    runningDelegateJobs = deps.peekRunningDelegateJobs()
  }
  const activeIngress = deps.activeIngress()
  if (activeIngress > 0 || durableRunning > 0 || runningDelegateJobs > 0) {
    return fail({
      ok: false,
      status: 409,
      reason: 'active_turn',
      activeIngress,
      activeTurns: sessionDrain.activeTurns,
      durableRunning: durableRunning + runningDelegateJobs,
      ...(deps.countRunningDelegateJobs || deps.peekRunningDelegateJobs
        ? { runningDelegateJobs }
        : {}),
    })
  }

  const finalNow = deps.now()
  if (!deps.isGatewayDrainActive(finalNow) || !deps.isSessionDrainActive(finalNow)) {
    return fail({ ok: false, status: 503, reason: 'drain_fence_expired' })
  }

  return {
    ok: true,
    status: 200,
    drainTtlMs: deps.ttlMs,
    ...(holder ? { freezeHolder: holder } : {}),
  }
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
  private current: { state: 'pending' | 'accepted'; freezeHolder?: string } | null = null

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
      if (current.freezeHolder) this.deps.thawDelegateDispatch?.(current.freezeHolder)
      this.current = null
    }

    const entry: { state: 'pending' | 'accepted'; freezeHolder?: string } = { state: 'pending' }
    this.current = entry
    return attemptRuntimeRecycleDrain(this.deps).then(
      (decision) => {
        if (decision.ok) {
          entry.state = 'accepted'
          entry.freezeHolder = decision.freezeHolder
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
