import type { EngineAdapter, EngineTurnRun, TurnParams } from './engine/engineAdapter.js'
import type { TurnSummary } from './engine/engineEvents.js'

/** Default wall-clock budget for one internal idle compact turn. */
export const BOX_IDLE_TURN_TIMEOUT_MS = 180_000
/** After interrupt, how long the child may take to stop before it is shut down. */
export const BOX_IDLE_TURN_KILL_GRACE_MS = 5_000

/** The idle turn ran out of time. The CCB child is always shut down after
 * the interrupt grace, so `killed` is true once shutdown() returned: the
 * child can no longer send a compact request. Timeout never proves a result. */
export class IdleTurnTimeoutError extends Error {
  constructor(readonly killed: boolean) {
    super('IDLE_TURN_TIMEOUT')
    this.name = 'IdleTurnTimeoutError'
  }
}

export interface IdleTurnLimits {
  timeoutMs?: number
  killGraceMs?: number
}

const TIMEOUT = Symbol('timeout')

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function boxIdleTurnTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OC_BOX_IDLE_TURN_TIMEOUT_MS)
  return Number.isSafeInteger(raw) && raw >= 10_000 && raw <= 900_000 ? raw : BOX_IDLE_TURN_TIMEOUT_MS
}

/** Internal idle turns own the same end-on-failure duty as ordinary turns.
 * CCB exit is already stdout-drained; no model retry belongs here. A hung
 * turn is bounded: interrupt, then shut the child down, so session.lock is
 * always released. */
export async function runBoxIdleTurn(runner: EngineAdapter, params: TurnParams,
  limits: IdleTurnLimits = {}): Promise<TurnSummary> {
  const timeoutMs = limits.timeoutMs ?? boxIdleTurnTimeoutMs()
  const killGraceMs = limits.killGraceMs ?? BOX_IDLE_TURN_KILL_GRACE_MS
  let run: EngineTurnRun | undefined
  let closed = false
  let failure: Error | undefined
  let earlyFailure: Error | undefined
  const fail = (error: unknown): void => {
    if (closed || failure || run?.finalized) return
    const reason = error instanceof Error ? error : new Error(String(error))
    // submitTurn may emit synchronously, before returning its scoped handle.
    if (!run) { earlyFailure ??= reason; return }
    failure = reason
    run.end()
  }
  const onExit = (info: { code: number | null; signal: string | null; crashed: boolean }): void => {
    // Model/route lifecycle replacement can precede submission to a new child.
    if (!info.crashed && info.code === 0 && info.signal == null) return
    fail(new Error(`IDLE_TURN_EXIT: ${info.signal ?? info.code ?? 'unknown'}`))
  }
  runner.on('error', fail)
  runner.on('exit', onExit)
  try {
    run = runner.submitTurn(params)
    // Always consume rejection, including a late rejection after completion.
    void run.submitted.catch(fail)
    // A real result finalized synchronously wins over a following exit, but
    // our own end() never manufactures success: failure is claimed first.
    if (earlyFailure) fail(earlyFailure)
    const first = await within(run.summary, timeoutMs)
    if (first === TIMEOUT) {
      runner.interrupt('system')
      await within(run.summary, killGraceMs)
      // A turn that stopped on interrupt is not proof the child stopped
      // sending: shut it down unconditionally before reporting.
      let killed = true
      await runner.shutdown().catch(() => { killed = false })
      // An interrupted or late result is never treated as the compact result;
      // an exit caused by the shutdown is reported as this timeout.
      throw new IdleTurnTimeoutError(killed)
    }
    const summary = first
    if (failure) throw failure
    if (!summary) throw new Error('IDLE_TURN_NO_RESULT')
    return summary
  } finally {
    closed = true
    runner.off('error', fail)
    runner.off('exit', onExit)
    run?.end()
  }
}
