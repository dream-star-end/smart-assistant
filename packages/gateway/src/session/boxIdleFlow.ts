/**
 * Box idle compaction / recovery flow executed while holding `session.lock`.
 * Receives `gateway-turn` and `gateway-runtime` primitives via `BoxIdleFlowDeps`
 * so this submodule stays a pure DAG leaf inside `gateway-session`.
 */
import { createHash } from 'node:crypto'
import { withIdleNativeLock } from '@openclaude/storage'
import type {
  IdleCompactRejected,
  IdleNativeFile,
  IdleOp,
  IdleSourceCandidate,
} from '../boxIdleCompact.js'
import { fetchBoxIdleProof, type IdleProofResponse } from '../engine/boxIdleProofClient.js'
import { notifyBoxUserStop } from '../engine/boxUserStopClient.js'
import type { EngineAdapter } from '../engine/engineAdapter.js'
import type { TurnSummary } from '../engine/engineEvents.js'
import { log } from '../sessionManagerLog.js'
import type { AgentSession } from '../sessionTypes.js'

const IDLE_TURN_STOP_WAIT_MS = 30_000

export interface BoxIdleFlowDeps {
  BOX_IDLE_PRE_EXPIRY_MIN_TOKENS: number
  BOX_IDLE_TURN_TIMEOUT_MS: number
  IDLE_COMPACT_PROMPT: string
  boxIdlePreExpiryMs: (dir: string) => number
  boxIdleTurnTimeoutMs: () => number
  advanceIdleOp: (args: {
    op: IdleOp
    proof: IdleProofResponse
    allowDispatch: boolean
  }) => { op: IdleOp; callModel: boolean }
  clearIdleCandidate: (dir: string, sessionKey: string) => void
  idleAbandonReason: (op: IdleOp, proof: IdleProofResponse) => IdleOp['abandonReason']
  idleCandidateAgedOut: (cand: IdleSourceCandidate) => boolean
  idleCompactAlways: () => boolean
  idleNativePath: (dir: string, sessionId: string, revision: string) => string
  idleOpSettled: (op: IdleOp) => boolean
  idleProofWaitMs: () => number
  idleSummaryAccepted: (
    proof: IdleProofResponse,
    ctx: { sessionId: string; idleTurnKey: string; nativeSummary?: string },
  ) => { summaryText: string; capsuleSha256: string } | undefined
  nativeShortForOp: (
    native: IdleNativeFile | undefined,
    ctx: { idleTurnKey: string; revision: string; sourceSessionId: string },
  ) => boolean
  pruneIdleOps: (dir: string, sessionKey: string) => void
  readIdleCandidate: (dir: string, sessionKey: string) => IdleSourceCandidate | undefined
  readIdleNative: (dir: string, sessionId: string, revision: string) => IdleNativeFile | undefined
  readIdleOp: (dir: string, sessionKey: string, revision: string) => IdleOp | undefined
  readPendingIdle: (dir: string, sessionKey: string) => IdleOp | undefined
  sourceNeedsIdleOp: (proof: IdleProofResponse) => boolean
  startIdleOp: (args: {
    dir: string
    sessionKey: string
    sourceSessionId: string
    sourceTurnKey: string
    revision: string
    idleTurnKey: string
    frozenTail: IdleOp['frozenTail']
    attachments: IdleOp['attachments']
  }) => { op: IdleOp; ownedDispatch: boolean }
  withIncarnationShutdown: (dir: string, op: IdleOp) => IdleOp
  writeIdleNative: (dir: string, rec: IdleNativeFile) => void
  writeIdleOp: (dir: string, op: IdleOp, opts?: { preservePreparedMtime?: boolean }) => void
  recoverUnconfirmedIdle: (
    runner: EngineAdapter,
    op: IdleOp,
    recoveryDir: string,
    deadline: number,
  ) => Promise<IdleOp>
  runBoxIdleTurn: (
    runner: EngineAdapter,
    params: {
      input: string
      turnKey: string
      onEvent: () => void
      sessionTotals: AgentSession
      toolUseIdToName: Map<string, string>
    },
    opts: { timeoutMs: number },
  ) => Promise<TurnSummary | null>
  shutdownIdleRunner: (runner: EngineAdapter, timeoutMs: number) => Promise<boolean>
  createIdleTurnTimeoutError: (killed: boolean) => Error
  isIdleTurnTimeoutError: (err: unknown) => err is Error & { killed: boolean }
  createIdleCompactRejected: (code: IdleCompactRejected['code']) => Error
  refreshRunnerPromptPrivacy: (
    runner: EngineAdapter,
    peerId: string,
    opts: { assertCurrent: () => void; shutdown: () => Promise<void> },
  ) => Promise<void>
  clearRunnerPromptPrivacy: (runner: EngineAdapter) => void
}

function writeSettledIdleOp(deps: BoxIdleFlowDeps, recoveryDir: string, op: IdleOp): void {
  deps.writeIdleOp(recoveryDir, op, { preservePreparedMtime: true })
  if (deps.idleOpSettled(op)) deps.pruneIdleOps(recoveryDir, op.sessionKey)
}

async function stopParkedIdleTurn(
  deps: BoxIdleFlowDeps,
  op: IdleOp,
  timeoutMs = IDLE_TURN_STOP_WAIT_MS,
): Promise<void> {
  if (deps.idleOpSettled(op) || op.summaryText || typeof op.runnerKilledAt !== 'number') return
  const outcome = await notifyBoxUserStop(
    { sessionId: op.sourceSessionId, turnKey: op.idleTurnKey },
    { timeoutMs },
  ).catch(() => 'pending' as const)
  if (outcome !== 'skipped') {
    log.info('box idle turn stop requested', {
      sessionKey: op.sessionKey,
      revision: op.revision,
      outcome,
    })
  }
}

async function settleStrandedIdleOp(
  deps: BoxIdleFlowDeps,
  session: AgentSession,
  op: IdleOp,
  recoveryDir: string,
): Promise<void> {
  const evidenced = deps.withIncarnationShutdown(recoveryDir, op)
  if (op.summaryText) {
    const recovered = await deps.recoverUnconfirmedIdle(
      session.runner,
      evidenced,
      recoveryDir,
      session._idleDeadline ?? Date.now() + 45_000,
    )
    writeSettledIdleOp(deps, recoveryDir, recovered)
    return
  }
  if (deps.readIdleNative(recoveryDir, op.sourceSessionId, op.revision)?.summaryText) return
  const idleProof = await fetchBoxIdleProof(
    { sessionId: op.sourceSessionId, turnKey: op.idleTurnKey },
    { timeoutMs: Math.max(1, Math.min(10_000, (session._idleDeadline ?? Date.now() + 10_000) - Date.now())) },
  )
  const reason = deps.idleAbandonReason(evidenced, idleProof)
  if (!reason) return
  log.warn('box idle op abandoned', {
    sessionKey: session.sessionKey,
    revision: op.revision,
    reason,
  })
  writeSettledIdleOp(deps, recoveryDir, { ...evidenced, disposition: 'abandoned', abandonReason: reason })
}

async function waitBoxIdleProof(
  deps: BoxIdleFlowDeps,
  input: { sessionId: string; turnKey: string },
  outerDeadline = Number.POSITIVE_INFINITY,
): Promise<IdleProofResponse> {
  const deadline = Math.min(outerDeadline, Date.now() + deps.idleProofWaitMs())
  let delay = 1000
  for (;;) {
    const proof = await fetchBoxIdleProof(input, {
      timeoutMs: Math.max(1, Math.min(10_000, outerDeadline - Date.now())),
    })
    if (proof.status !== 'pending' || Date.now() + delay > deadline) return proof
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 8000)
  }
}

async function handleNonTerminalSourceProof(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  recoveryDir: string
  pending: IdleOp | undefined
  proofStatus: string
}): Promise<void> {
  const { deps, session, recoveryDir, pending, proofStatus } = args
  const stuckCand = deps.readIdleCandidate(recoveryDir, session.sessionKey)
  if (stuckCand && deps.idleCandidateAgedOut(stuckCand)) {
    log.warn('box idle candidate aged out', {
      sessionKey: session.sessionKey,
      createdAt: stuckCand.createdAt,
      proofStatus,
    })
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
  }
  if (pending && !deps.readIdleCandidate(recoveryDir, session.sessionKey)) {
    await settleStrandedIdleOp(deps, session, pending, recoveryDir)
  }
}

function checkTerminalProofExistingGate(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  mode: 'after_turn' | 'pre_expiry'
  proof: IdleProofResponse & { revision: string }
}): 'proceed' | 'done' | 'deferred' {
  const { deps, session, source, recoveryDir, mode, proof } = args
  const existing = deps.readIdleOp(recoveryDir, session.sessionKey, proof.revision)
  if (!existing && !deps.sourceNeedsIdleOp(proof)) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    return 'done'
  }
  if (
    mode === 'after_turn' &&
    !existing &&
    !deps.idleCompactAlways() &&
    deps.boxIdlePreExpiryMs(recoveryDir) > 0
  ) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    return 'deferred'
  }
  if (existing && deps.idleOpSettled(existing)) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    return 'done'
  }
  const existingNative = existing && deps.readIdleNative(recoveryDir, source.sessionId, proof.revision)
  if (
    existing &&
    deps.nativeShortForOp(existingNative || undefined, {
      idleTurnKey: existing.idleTurnKey,
      revision: proof.revision,
      sourceSessionId: source.sessionId,
    })
  ) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    writeSettledIdleOp(deps, recoveryDir, {
      ...deps.withIncarnationShutdown(recoveryDir, existing),
      disposition: 'short',
    })
    return 'done'
  }
  return 'proceed'
}

async function evaluateSourceProofGate(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  mode: 'after_turn' | 'pre_expiry'
  deadline: number
  pending: IdleOp | undefined
}): Promise<{ kind: 'proceed'; proof: IdleProofResponse & { revision: string } } | { kind: 'done' | 'deferred' }> {
  const { deps, session, source, recoveryDir, mode, deadline, pending } = args
  if (Date.now() >= deadline && !pending) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    return { kind: 'done' }
  }
  const proof = await waitBoxIdleProof(deps, source, deadline)
  if (proof.status === 'skipped') {
    log.error('box idle proof unavailable', {
      sessionKey: session.sessionKey,
      reason: proof.reason,
      pendingOp: Boolean(pending),
    })
    if (!pending) deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    return { kind: 'done' }
  }
  if (proof.status === 'not_found' || proof.status === 'failed') {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    if (pending) await settleStrandedIdleOp(deps, session, pending, recoveryDir)
    return { kind: 'done' }
  }
  if (proof.status !== 'terminal' && proof.status !== 'terminal_set') {
    await handleNonTerminalSourceProof({ deps, session, recoveryDir, pending, proofStatus: proof.status })
    return { kind: 'done' }
  }
  const terminalProof = proof as IdleProofResponse & { revision: string }
  const verdict = checkTerminalProofExistingGate({ deps, session, source, recoveryDir, mode, proof: terminalProof })
  return verdict === 'proceed' ? { kind: 'proceed', proof: terminalProof } : { kind: verdict }
}

async function applyConfirmedIdleSummary(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  privacyRunner: EngineAdapter
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  proof: IdleProofResponse & { revision: string }
  step: { op: IdleOp; callModel: boolean }
  after: IdleNativeFile
  deadline: number
  left: (cap: number) => number
  assertIdleCurrent: () => void
}): Promise<{ op: IdleOp; callModel: boolean }> {
  const { deps, session, privacyRunner, source, recoveryDir, proof, after, deadline, left, assertIdleCurrent } = args
  let step = args.step
  const again = await fetchBoxIdleProof(
    { sessionId: source.sessionId, turnKey: step.op.idleTurnKey },
    { timeoutMs: left(10_000) },
  )
  const confirmed = deps.idleSummaryAccepted(again, {
    sessionId: source.sessionId,
    idleTurnKey: step.op.idleTurnKey,
    nativeSummary: after.summaryText,
  })
  if (!confirmed) return step
  step = deps.advanceIdleOp({
    op: {
      ...step.op,
      summaryText: confirmed.summaryText,
      capsuleSha256: confirmed.capsuleSha256,
      frozenTail: after.frozenTail.length ? after.frozenTail : step.op.frozenTail,
      attachments: after.attachments,
    },
    proof,
    allowDispatch: false,
  })
  if (!step.op.artifact || step.op.receiptDigest === step.op.artifact.digest) return step
  assertIdleCurrent()
  if (deadline - Date.now() <= 60_000) throw deps.createIdleTurnTimeoutError(false)
  const applied = await deps.runBoxIdleTurn(
    privacyRunner,
    {
      input: deps.IDLE_COMPACT_PROMPT,
      turnKey: step.op.idleTurnKey,
      onEvent: () => {},
      sessionTotals: session,
      toolUseIdToName: session.toolUseIdToName ?? new Map(),
    },
    { timeoutMs: left(deps.BOX_IDLE_TURN_TIMEOUT_MS) - 60_000 },
  )
  if (applied?.isError && /\bIDLE_RECOVERY_CORRUPT\b/.test(applied.errorDetail ?? '')) {
    throw deps.createIdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
  const applyReceipt = applied?.nativeIdleReceipt
  if (applyReceipt?.digest !== step.op.artifact.digest || applyReceipt?.opId !== step.op.idleTurnKey) {
    log.warn('box idle apply receipt unconfirmed', {
      sessionKey: session.sessionKey,
      revision: step.op.revision,
      expectedDigest: step.op.artifact.digest,
      actualDigest: applyReceipt?.digest ?? null,
      actualOpId: applyReceipt?.opId ?? null,
      error: applied?.errorDetail ?? null,
    })
  }
  if (
    applyReceipt &&
    applyReceipt.opId === step.op.idleTurnKey &&
    applyReceipt.digest === step.op.artifact.digest
  ) {
    step = { ...step, op: { ...step.op, receiptDigest: applyReceipt.digest } }
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
  }
  return step
}

async function ensureIdleNativeRecordExists(args: {
  deps: BoxIdleFlowDeps
  recoveryDir: string
  sourceSessionId: string
  revision: string
  mode: 'after_turn' | 'pre_expiry'
  op: IdleOp
}): Promise<void> {
  const { deps, recoveryDir, sourceSessionId, revision, mode, op } = args
  await withIdleNativeLock(deps.idleNativePath(recoveryDir, sourceSessionId, revision), () => {
    if (deps.readIdleNative(recoveryDir, sourceSessionId, revision)) return
    deps.writeIdleNative(recoveryDir, {
      v: 1,
      opId: op.idleTurnKey,
      revision: op.revision,
      sessionId: sourceSessionId,
      ...(op.summaryText ? { summaryText: op.summaryText } : {}),
      modelCalls: 0,
      frozenTail: op.frozenTail,
      attachments: op.attachments,
      ...(mode === 'pre_expiry' ? { minInputTokens: deps.BOX_IDLE_PRE_EXPIRY_MIN_TOKENS } : {}),
    })
  })
}

async function processSettledIdleTurn(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  privacyRunner: EngineAdapter
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  proof: IdleProofResponse & { revision: string }
  step: { op: IdleOp; callModel: boolean }
  needsApply: boolean
  settled: TurnSummary | null
  deadline: number
  left: (cap: number) => number
  assertIdleCurrent: () => void
}): Promise<{ op: IdleOp; callModel: boolean }> {
  const { deps, session, privacyRunner, source, recoveryDir, proof, needsApply, settled, deadline, left, assertIdleCurrent } = args
  let step = args.step
  if (settled?.isError && /\bIDLE_RECOVERY_CORRUPT\b/.test(settled.errorDetail ?? '')) {
    throw deps.createIdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
  const receipt = settled?.nativeIdleReceipt
  if (needsApply && (receipt?.digest !== step.op.artifact?.digest || receipt?.opId !== step.op.idleTurnKey)) {
    log.warn('box idle apply receipt unconfirmed', {
      sessionKey: session.sessionKey,
      revision: step.op.revision,
      expectedDigest: step.op.artifact?.digest ?? null,
      actualDigest: receipt?.digest ?? null,
      actualOpId: receipt?.opId ?? null,
      error: settled?.errorDetail ?? null,
    })
  }
  const after = deps.readIdleNative(recoveryDir, source.sessionId, proof.revision)
  if (
    deps.nativeShortForOp(after, {
      idleTurnKey: step.op.idleTurnKey,
      revision: proof.revision,
      sourceSessionId: source.sessionId,
    })
  ) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    step = { ...step, op: { ...step.op, disposition: 'short' } }
  } else if (!step.op.summaryText && after?.summaryText) {
    step = await applyConfirmedIdleSummary({
      deps, session, privacyRunner, source, recoveryDir, proof, step, after, deadline, left, assertIdleCurrent,
    })
  }
  if (
    receipt &&
    receipt.opId === step.op.idleTurnKey &&
    step.op.artifact &&
    receipt.digest === step.op.artifact.digest
  ) {
    step = { ...step, op: { ...step.op, receiptDigest: receipt.digest } }
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
  }
  return step
}

async function handleIdleTurnWithoutResult(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  privacyRunner: EngineAdapter
  step: { op: IdleOp; callModel: boolean }
  left: (cap: number) => number
  idleErr?: unknown
}): Promise<{ op: IdleOp; callModel: boolean }> {
  const { deps, session, privacyRunner, left, idleErr } = args
  let step = args.step
  let killed = idleErr !== undefined && deps.isIdleTurnTimeoutError(idleErr) && idleErr.killed
  if (!killed && typeof session.runner.shutdown === 'function') {
    killed = await deps.shutdownIdleRunner(privacyRunner, left(5_000))
  }
  if (killed) {
    step = { ...step, op: { ...step.op, runnerKilledAt: Date.now() } }
    await stopParkedIdleTurn(deps, step.op, left(IDLE_TURN_STOP_WAIT_MS))
  }
  log.warn(
    'box idle turn ended without result',
    {
      sessionKey: session.sessionKey,
      revision: step.op.revision,
      timeout: idleErr !== undefined && deps.isIdleTurnTimeoutError(idleErr),
      ...(idleErr === undefined ? { noSummary: true } : {}),
      runnerKilled: killed,
    },
    ...(idleErr !== undefined ? [idleErr] : []),
  )
  return step
}

async function runIdleModelOrApplyStep(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  privacyRunner: EngineAdapter
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  mode: 'after_turn' | 'pre_expiry'
  proof: IdleProofResponse & { revision: string }
  step: { op: IdleOp; callModel: boolean }
  needsApply: boolean
  deadline: number
  left: (cap: number) => number
  assertIdleCurrent: () => void
}): Promise<{ op: IdleOp; callModel: boolean }> {
  const { deps, session, privacyRunner, source, recoveryDir, mode, proof, needsApply, deadline, left, assertIdleCurrent } = args
  let step = args.step
  await ensureIdleNativeRecordExists({
    deps, recoveryDir, sourceSessionId: source.sessionId, revision: proof.revision, mode, op: step.op,
  })
  step = { ...step, op: { ...step.op, runnerKilledAt: undefined } }
  writeSettledIdleOp(deps, recoveryDir, step.op)
  session._idleRunning = true
  session._idleInternalTurns = (session._idleInternalTurns ?? 0) + 1
  try {
    assertIdleCurrent()
    if (deadline - Date.now() <= 60_000) throw deps.createIdleTurnTimeoutError(false)
    const settled = await deps.runBoxIdleTurn(
      privacyRunner,
      {
        input: deps.IDLE_COMPACT_PROMPT,
        turnKey: step.op.idleTurnKey,
        onEvent: () => {},
        sessionTotals: session,
        toolUseIdToName: session.toolUseIdToName ?? new Map(),
      },
      { timeoutMs: left(deps.BOX_IDLE_TURN_TIMEOUT_MS) - 60_000 },
    )
    step = await processSettledIdleTurn({
      deps, session, privacyRunner, source, recoveryDir, proof, step, needsApply, settled, deadline, left, assertIdleCurrent,
    })
    if (
      step.callModel &&
      !step.op.summaryText &&
      !deps.idleOpSettled(step.op) &&
      !deps.readIdleNative(recoveryDir, source.sessionId, proof.revision)?.summaryText
    ) {
      step = await handleIdleTurnWithoutResult({ deps, session, privacyRunner, step, left })
    }
  } catch (idleErr) {
    if (idleErr instanceof Error && idleErr.message === 'IDLE_RECOVERY_CORRUPT') throw idleErr
    step = await handleIdleTurnWithoutResult({ deps, session, privacyRunner, step, left, idleErr })
  } finally {
    session._idleRunning = false
    session._idleInternalTurns = Math.max(0, (session._idleInternalTurns ?? 0) - 1)
  }
  return step
}

async function prepareOpAndNativeForDispatch(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  proof: IdleProofResponse & { revision: string }
  left: (cap: number) => number
}): Promise<{ op: IdleOp; native: IdleNativeFile | undefined; ownedDispatch: boolean } | null> {
  const { deps, session, source, recoveryDir, proof, left } = args
  const started = deps.startIdleOp({
    dir: recoveryDir,
    sessionKey: session.sessionKey,
    sourceSessionId: source.sessionId,
    sourceTurnKey: source.turnKey,
    revision: proof.revision,
    idleTurnKey: createHash('sha256').update(`${session.sessionKey}:${proof.revision}`).digest('hex'),
    frozenTail: [],
    attachments: [],
  })
  let op = deps.withIncarnationShutdown(recoveryDir, started.op)
  if (deps.idleOpSettled(op)) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    return null
  }
  let native = deps.readIdleNative(recoveryDir, source.sessionId, proof.revision)
  if (
    deps.nativeShortForOp(native, {
      idleTurnKey: op.idleTurnKey,
      revision: proof.revision,
      sourceSessionId: source.sessionId,
    })
  ) {
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    writeSettledIdleOp(deps, recoveryDir, { ...op, disposition: 'short' })
    return null
  }
  if (native?.frozenTail.length) {
    op = { ...op, frozenTail: native.frozenTail, attachments: native.attachments }
  }
  const summaryProof = await fetchBoxIdleProof(
    { sessionId: source.sessionId, turnKey: op.idleTurnKey },
    { timeoutMs: left(10_000) },
  )
  const abandon = native?.summaryText ? undefined : deps.idleAbandonReason(op, summaryProof)
  if (abandon) {
    log.warn('box idle op abandoned', {
      sessionKey: session.sessionKey,
      revision: op.revision,
      reason: abandon,
    })
    deps.clearIdleCandidate(recoveryDir, session.sessionKey)
    writeSettledIdleOp(deps, recoveryDir, { ...op, disposition: 'abandoned', abandonReason: abandon })
    return null
  }
  const accepted = deps.idleSummaryAccepted(summaryProof, {
    sessionId: source.sessionId,
    idleTurnKey: op.idleTurnKey,
    nativeSummary: native?.summaryText,
  })
  if (accepted) {
    const unpreparedOp = !op.summaryText && !op.artifact && !op.receiptDigest
    op = { ...op, summaryText: accepted.summaryText, capsuleSha256: accepted.capsuleSha256 }
    native = await withIdleNativeLock(
      deps.idleNativePath(recoveryDir, source.sessionId, proof.revision),
      () => {
        const current = deps.readIdleNative(recoveryDir, source.sessionId, proof.revision)
        if (current?.summaryText || current?.applied || current?.artifact) return current
        const next: IdleNativeFile = {
          ...current,
          ...(!current && unpreparedOp ? { captureRollbackTip: true } : {}),
          v: 1,
          opId: op.idleTurnKey,
          revision: op.revision,
          sessionId: source.sessionId,
          summaryText: accepted.summaryText,
          modelCalls: current?.modelCalls ?? 1,
          modelStarted: true,
          frozenTail: current?.frozenTail ?? op.frozenTail,
          attachments: current?.attachments ?? op.attachments,
        }
        deps.writeIdleNative(recoveryDir, next)
        return next
      },
    )
  }
  return { op, native, ownedDispatch: started.ownedDispatch }
}

async function preSettlePendingIdleBeforeProof(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  pending: IdleOp | undefined
  recoveryDir: string
  deadline: number
  left: (cap: number) => number
}): Promise<boolean> {
  const { deps, session, pending, recoveryDir, deadline, left } = args
  if (!pending) return false
  const evidenced = deps.withIncarnationShutdown(recoveryDir, pending)
  await stopParkedIdleTurn(deps, evidenced, left(IDLE_TURN_STOP_WAIT_MS))
  if (pending.summaryText && typeof evidenced.runnerKilledAt === 'number') {
    const recovered = await deps.recoverUnconfirmedIdle(session.runner, evidenced, recoveryDir, deadline)
    writeSettledIdleOp(deps, recoveryDir, recovered)
    if (deps.idleOpSettled(recovered)) {
      deps.clearIdleCandidate(recoveryDir, session.sessionKey)
      return true
    }
  }
  return false
}

async function executeIdleOpUnderPrivacy(args: {
  deps: BoxIdleFlowDeps
  session: AgentSession
  privacyRunner: EngineAdapter
  source: { sessionId: string; turnKey: string }
  recoveryDir: string
  mode: 'after_turn' | 'pre_expiry'
  proof: IdleProofResponse & { revision: string }
  deadline: number
  left: (cap: number) => number
  assertIdleCurrent: () => void
}): Promise<void> {
  const { deps, session, privacyRunner, source, recoveryDir, mode, proof, deadline, left, assertIdleCurrent } = args
  const prepared = await prepareOpAndNativeForDispatch({
    deps, session, source, recoveryDir, proof, left,
  })
  if (!prepared) return
  let step = deps.advanceIdleOp({
    op: prepared.op,
    proof,
    allowDispatch:
      prepared.ownedDispatch &&
      !prepared.op.summaryText &&
      !prepared.native?.summaryText &&
      !prepared.native?.modelStarted,
  })
  const needsApply = Boolean(
    step.op.summaryText && step.op.receiptDigest !== step.op.artifact?.digest,
  )
  if (step.callModel || needsApply) {
    step = await runIdleModelOrApplyStep({
      deps, session, privacyRunner, source, recoveryDir, mode, proof, step, needsApply, deadline, left, assertIdleCurrent,
    })
  }
  if (step.op.summaryText && !deps.idleOpSettled(step.op)) {
    log.warn('box idle apply receipt unconfirmed', {
      sessionKey: session.sessionKey,
      revision: step.op.revision,
      expectedDigest: step.op.artifact?.digest ?? null,
      actualDigest: step.op.receiptDigest ?? null,
    })
    assertIdleCurrent()
    step = { ...step, op: await deps.recoverUnconfirmedIdle(privacyRunner, step.op, recoveryDir, deadline) }
    if (deps.idleOpSettled(step.op)) deps.clearIdleCandidate(recoveryDir, session.sessionKey)
  }
  writeSettledIdleOp(deps, recoveryDir, step.op)
  if (!step.op.summaryText && !deps.idleOpSettled(step.op)) {
    await settleStrandedIdleOp(deps, session, step.op, recoveryDir)
    const settled = deps.readIdleOp(recoveryDir, session.sessionKey, step.op.revision)
    if (settled && deps.idleOpSettled(settled)) deps.clearIdleCandidate(recoveryDir, session.sessionKey)
  }
}

export async function finishIdleUnderLockFlow(
  deps: BoxIdleFlowDeps,
  session: AgentSession,
  source: { sessionId: string; turnKey: string },
  recoveryDir: string,
  mode: 'after_turn' | 'pre_expiry',
): Promise<'deferred' | undefined> {
  if (session._idleRunning) return
  const pending = deps.readPendingIdle(recoveryDir, session.sessionKey)
  if (!pending && !deps.readIdleCandidate(recoveryDir, session.sessionKey)) return
  const deadline = (session._idleDeadline ??=
    Date.now() + Math.min(deps.BOX_IDLE_TURN_TIMEOUT_MS, deps.boxIdleTurnTimeoutMs()))
  const left = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()))
  if (await preSettlePendingIdleBeforeProof({ deps, session, pending, recoveryDir, deadline, left })) return
  const gate = await evaluateSourceProofGate({
    deps, session, source, recoveryDir, mode, deadline, pending,
  })
  if (gate.kind !== 'proceed') return gate.kind === 'deferred' ? 'deferred' : undefined
  const proof = gate.proof
  const privacyRunner = session.runner
  const assertIdleCurrent = () => {
    if (session._plannedTeardown || session._replacing || session.runner !== privacyRunner) {
      throw new Error('SESSION_IDLE_PRIVACY_CANCELLED')
    }
  }
  await deps.refreshRunnerPromptPrivacy(privacyRunner, session.peerId, {
    assertCurrent: assertIdleCurrent,
    shutdown: async () => {
      if (!(await deps.shutdownIdleRunner(privacyRunner, left(5_000)))) {
        throw deps.createIdleTurnTimeoutError(false)
      }
    },
  })
  try {
    await executeIdleOpUnderPrivacy({
      deps, session, privacyRunner, source, recoveryDir, mode, proof, deadline, left, assertIdleCurrent,
    })
  } finally {
    deps.clearRunnerPromptPrivacy(session.runner)
  }
}
