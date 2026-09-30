import type { EngineAdapter, EngineTurnRun, TurnParams } from './engine/engineAdapter.js'
import type { TurnSummary } from './engine/engineEvents.js'

/** Internal idle turns own the same end-on-failure duty as ordinary turns.
 * CCB exit is already stdout-drained; no timer or model retry belongs here. */
export async function runBoxIdleTurn(runner: EngineAdapter, params: TurnParams): Promise<TurnSummary> {
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
    const summary = await run.summary
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
