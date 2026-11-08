import type { EngineAdapter } from './engine/engineAdapter.js'
import { fetchBoxIdleProof, type IdleProofResponse } from './engine/boxIdleProofClient.js'
import { notifyBoxUserStop } from './engine/boxUserStopClient.js'
import {
  idleCandidateAgedOut, writeIdleCandidate, readIdleCandidate, readPendingIdleOps,
  IdleCompactRejected, type IdleSourceCandidate,
} from './boxIdleCompact.js'

/** Caller owns session.lock. A resolved shutdown alone does not prove that
 * retained child stdout is drained. Bound both barriers without losing them. */
export async function fenceIdleSourceRunner(runner: EngineAdapter, timeoutMs = 5_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = Promise.resolve().then(async () => {
    await runner.shutdown()
    await runner.waitForOutputDrain()
    return runner.isRunning === false
  }).catch(() => false)
  try {
    return await Promise.race([stopped, new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** Call synchronously at the first pending observation, before polling again. */
export function markIdleCandidatePending(dir: string, candidate: IdleSourceCandidate): IdleSourceCandidate {
  if (candidate.observedPending) return candidate
  const observed = { ...candidate, observedPending: true as const }
  writeIdleCandidate(dir, observed)
  return observed
}

/** Recover a source with no dispatched compact op. Age only requests a stop;
 * the existing egress coordinator owns nonce/epoch fencing and settlement.
 * Neither local shutdown, stop ACK nor a missing row proves remote failure. */
export async function recoverIdleCandidate(input: {
  dir: string
  candidate: IdleSourceCandidate
  runner: EngineAdapter
  proof: IdleProofResponse
}): Promise<IdleProofResponse> {
  let { candidate, proof } = input
  if (proof.status === 'not_found' && candidate.observedPending) {
    return { status: 'pending', reason: 'source_proof_missing' }
  }
  if (proof.status !== 'pending') return proof
  candidate = markIdleCandidatePending(input.dir, candidate)
  if (!idleCandidateAgedOut(candidate) || !await fenceIdleSourceRunner(input.runner)) return proof
  const source = { sessionId: candidate.sessionId, turnKey: candidate.turnKey }
  await notifyBoxUserStop(source, { timeoutMs: 30_000 }).catch(() => 'pending')
  proof = await fetchBoxIdleProof(source)
  return proof.status === 'not_found'
    ? { status: 'pending', reason: 'source_proof_missing' } : proof
}

/** Operator reset uses the same proof boundary for every durable identity. */
export async function fenceIdleReset(runner: EngineAdapter, dir: string, sessionKey: string): Promise<void> {
  // The marker requests recovery, not permission to abandon a possibly live
  // Box operation. Keep it for the next submit until every identity is proved.
  if (!await fenceIdleSourceRunner(runner)) throw new IdleCompactRejected('IDLE_HISTORY_PENDING')
  let candidate = readIdleCandidate(dir, sessionKey)
  const pending = readPendingIdleOps(dir, sessionKey)
  const sources = new Map<string, { sessionId: string; turnKey: string }>()
  const add = (sessionId: string, turnKey: string) => sources.set(`${sessionId}:${turnKey}`, { sessionId, turnKey })
  if (candidate) add(candidate.sessionId, candidate.turnKey)
  for (const op of pending) {
    add(op.sourceSessionId, op.sourceTurnKey)
    add(op.sourceSessionId, op.idleTurnKey)
  }
  const deadline = Date.now() + 40_000
  for (const source of sources.values()) {
    let proof = await fetchBoxIdleProof(source, { timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())) })
    if (proof.status === 'pending') {
      if (candidate?.sessionId === source.sessionId && candidate.turnKey === source.turnKey) {
        candidate = markIdleCandidatePending(dir, candidate)
      }
      await notifyBoxUserStop(source, { timeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())) }).catch(() => 'pending')
      proof = await fetchBoxIdleProof(source, { timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())) })
    }
    if (!['failed', 'terminal', 'terminal_set'].includes(proof.status)) {
      throw new IdleCompactRejected('IDLE_HISTORY_PENDING')
    }
  }
}
