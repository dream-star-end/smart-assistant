/**
 * OCV5-22 stage 3 Phase F: BeginCutover freeze + pause.
 *
 * Flag-off callers must not invoke this. Timeout path marks remaining
 * running rows `paused_for_cutover` with checkpoint `none` — no SIGTERM,
 * no `failed`. G1 reconciler then ClaimPaused or killed_by_cutover.
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

export async function beginDelegateCutover(
  store: DelegateJobStore,
  opts: BeginCutoverOptions = {},
): Promise<BeginCutoverResult> {
  store.setDispatchFrozen(true)
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const freezeBudgetMs = opts.freezeBudgetMs ?? DELEGATE_CUTOVER_FREEZE_MS
  const pollMs = Math.max(1, opts.pollMs ?? 25)
  const generation = opts.generation ?? now()
  const initialIds = new Set(store.listRunning().map((job) => job.id))

  const pauseIdle = (): number => {
    let n = 0
    for (const job of store.listRunning()) {
      if (opts.isIdle?.(job) !== true) continue
      if (!job.claimToken) continue
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
    const snap = store.snapshotOf(id)
    if (!snap || snap.state === 'completed' || snap.state === 'failed' || snap.state === 'cancelled') {
      completedDuring += 1
    }
  }

  return {
    generation,
    paused: quiesced + timedOut,
    quiesced,
    timedOut,
    completedDuring,
    remainingRunning: store.countRunning(),
  }
}
