import { writeIdleRollback } from '@openclaude/storage'
import type { EngineAdapter } from './engine/engineAdapter.js'
import { shutdownIdleRunner } from './boxIdleTurn.js'
import { fetchBoxIdleProof } from './engine/boxIdleProofClient.js'
import { notifyBoxUserStop } from './engine/boxUserStopClient.js'
import { idleSummaryAccepted, readIdleNative, writeIdleOp, type IdleOp } from './boxIdleCompact.js'

/** Only the caller holding session.lock may invoke this. Shutdown proves no
 * local apply can arrive; authoritative proof rules out a late Box result.
 * Native rollback is durable BEFORE op abandonment (crash-safe ordering). */
export async function recoverUnconfirmedIdle(runner: EngineAdapter, op: IdleOp, dir: string,
  deadline: number): Promise<IdleOp> {
  const left = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()))
  if (typeof op.runnerKilledAt !== 'number') {
    if (!await shutdownIdleRunner(runner, left(5_000))) return op
    op = { ...op, runnerKilledAt: Date.now() }
    writeIdleOp(dir, op, { preservePreparedMtime: true })
  }
  await notifyBoxUserStop({ sessionId: op.sourceSessionId, turnKey: op.idleTurnKey },
    { timeoutMs: left(30_000) }).catch(() => 'pending')
  const proof = await fetchBoxIdleProof({ sessionId: op.sourceSessionId, turnKey: op.idleTurnKey },
    { timeoutMs: left(10_000) })
  const native = readIdleNative(dir, op.sourceSessionId, op.revision)
  // Legacy files without a pre-apply rollback anchor remain fail-closed.
  if (!native?.rollbackTip || native.opId !== op.idleTurnKey) return op
  const accepted = idleSummaryAccepted(proof, {
    sessionId: op.sourceSessionId, idleTurnKey: op.idleTurnKey, nativeSummary: native.summaryText,
  })
  if (proof.status !== 'failed' && !accepted) return op
  writeIdleRollback(dir, { v: 1, sessionId: op.sourceSessionId, opId: op.idleTurnKey,
    restoreTip: native.rollbackTip })
  return { ...op, disposition: 'abandoned', abandonReason: 'idle_apply_unconfirmed' }
}
