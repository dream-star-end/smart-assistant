/**
 * OCV5-22 stage 3 Phase F: BeginCutover freeze + pause.
 *
 * Flag-off callers must not invoke this. Timeout path marks remaining
 * running rows `paused_for_cutover` with checkpoint `none` — no SIGTERM,
 * no `failed`. G1 reconciler then ClaimPaused or killed_by_cutover.
 * Generation-bound receipt/source jobs instead close via their original
 * terminal CAS without rekeying identity. Neither path proves OS process exit.
 */
import { DELEGATE_CUTOVER_FREEZE_MS } from '@openclaude/protocol'
import type { DelegateJobSnapshot, DelegateJobStore } from './delegateJobs.js'

export { DELEGATE_CUTOVER_FREEZE_MS }

export type BeginCutoverOptions = {
  generation?: number
  freezeBudgetMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** True when the runner has stopped feeding turns and will not write terminal. */
  isIdle?: (job: DelegateJobSnapshot) => boolean
}

export type BeginCutoverResult = {
  generation: number
  paused: number
  quiesced: number
  timedOut: number
  completedDuring: number
  remainingRunning: number
  closedBound: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

export function resolveDelegateCutoverFreezeMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.OC_DELEGATE_CUTOVER_FREEZE_MS ?? ''), 10)
  if (!Number.isFinite(n) || n < 0) return DELEGATE_CUTOVER_FREEZE_MS
  return Math.min(DELEGATE_CUTOVER_FREEZE_MS, Math.floor(n))
}

export function cutoverFreezeHolder(generation: number): string {
  return `cutover:${generation}`
}

/**
 * Production idle proof: only a current-fence quiesce ACK is idle. Missing
 * runner (hydrated row), fence mismatch, or live attached writer is never
 * idle. Session turn counters are negative evidence only — missing session
 * or zero turns cannot prove quiesce.
 */
export function isDelegateRunnerIdle(
  job: DelegateJobSnapshot,
  store: Pick<DelegateJobStore, 'isRunnerIdle'>,
  sessionTurns?: { activeTurnCount: number; activeClientTurnCount: number } | null,
): boolean {
  if (!store.isRunnerIdle(job)) return false
  if (sessionTurns) {
    const turns =
      Math.max(0, sessionTurns.activeTurnCount) + Math.max(0, sessionTurns.activeClientTurnCount)
    if (turns > 0) return false
  }
  return true
}

export type EndCutoverResult = {
  generation: number
  thawed: boolean
  closed: number
  failed: number
  /** Internal diagnostics only; never spread into an HTTP response. */
  errors: Array<{ jobId?: string; error: unknown }>
}

/**
 * Generation-owned cancel: thaw this cutover freeze (other holders stay) and
 * close matching paused rows. This stage has no safe in-process resume hook,
 * so closed rows become `killed_by_cutover` + pending rather than ClaimPaused.
 */
export function endDelegateCutover(
  store: DelegateJobStore,
  generation: number,
): EndCutoverResult {
  const thawed = store.thawDispatch(cutoverFreezeHolder(generation))
  let closed = 0
  const errors: EndCutoverResult['errors'] = []
  let jobs: DelegateJobSnapshot[] = []
  try { jobs = store.listNonTerminal() }
  catch (error) { errors.push({ error }) }
  for (const job of jobs) {
    if (job.state !== 'paused_for_cutover') continue
    if (job.generation !== generation) continue
    try {
      if (store.killOwnedPaused(job.id)) closed += 1
      else {
        const current = store.snapshotOf(job.id)
        if (!current || current.state === 'paused_for_cutover') {
          errors.push({ jobId: job.id, error: new Error('cutover paused writer unresolved') })
        }
      }
    } catch (error) { errors.push({ jobId: job.id, error }) }
  }
  return { generation, thawed, closed, failed: errors.length, errors }
}

export async function beginDelegateCutover(
  store: DelegateJobStore,
  opts: BeginCutoverOptions = {},
): Promise<BeginCutoverResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const freezeBudgetMs = opts.freezeBudgetMs ?? DELEGATE_CUTOVER_FREEZE_MS
  const pollMs = Math.max(1, opts.pollMs ?? 25)
  const generation = opts.generation ?? now()
  const isIdle =
    opts.isIdle ?? ((job: DelegateJobSnapshot) => store.isRunnerIdle(job))
  store.freezeDispatch(cutoverFreezeHolder(generation))
  try {
    const initialIds = new Set(store.listRunning().map((job) => job.id))
    const closedBound = new Set<string>()
    const closeBound = (job: DelegateJobSnapshot): boolean => {
      if (!store.hasCutoverGenerationBinding(job.id, job.generation)) return false
      if (job.claimToken && store.closeBoundForCutover(job.id, {
        claimToken: job.claimToken, fencingEpoch: job.fencingEpoch,
      })) closedBound.add(job.id)
      return true // Bound jobs must never fall back to generation-changing pause.
    }

    const pauseIdle = (): number => {
      let n = 0
      for (const job of store.listRunning()) {
        if (isIdle(job) !== true) continue
        if (!job.claimToken) continue
        if (closeBound(job)) continue
        const paused = store.pauseForCutover(job.id, {
          claimToken: job.claimToken,
          fencingEpoch: job.fencingEpoch,
          generation,
          checkpointKind: 'runner_quiesced',
        })
        if (paused) n += 1
      }
      return n
    }

    let quiesced = pauseIdle()
    const deadline = now() + freezeBudgetMs
    while (store.countRunning() > 0 && now() < deadline) {
      await sleep(pollMs)
      quiesced += pauseIdle()
    }

    let timedOut = 0
    for (const job of store.listRunning()) {
      if (!job.claimToken) continue
      if (closeBound(job)) continue
      const paused = store.pauseForCutover(job.id, {
        claimToken: job.claimToken,
        fencingEpoch: job.fencingEpoch,
        generation,
        checkpointKind: 'none',
      })
      if (paused) timedOut += 1
    }

    let completedDuring = 0
    for (const id of initialIds) {
      if (closedBound.has(id)) continue
      const snap = store.snapshotOf(id)
      if (!snap || snap.state === 'completed' || snap.state === 'failed' || snap.state === 'cancelled') {
        completedDuring += 1
      }
    }

    const remainingRunning = store.countRunning()
    if (remainingRunning > 0) throw new Error(`delegate cutover incomplete: ${remainingRunning} running`)
    return {
      generation,
      paused: quiesced + timedOut,
      quiesced,
      timedOut,
      completedDuring,
      remainingRunning,
      closedBound: closedBound.size,
    }
  } catch (err) {
    const cleanup = endDelegateCutover(store, generation)
    if (cleanup.failed > 0) throw new AggregateError(
      [err, ...cleanup.errors.map(item => item.error)], 'delegate cutover and cleanup failed', { cause: err })
    throw err
  }
}
