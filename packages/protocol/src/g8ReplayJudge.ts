/**
 * Bounded judgments for the G8 replay gate. No I/O, no model, no session control.
 * A hit is one of three classes: Box rejected the continuation, the engine report
 * disagrees with the dispatch, or a second charge settled. stopSession is always
 * false — this slice classifies and, when a listener is installed, alerts.
 */
import { TRACE_ID_REGEX } from './traceId.js'

export const G8_REPLAY_POINTS = ['compact_summary', 'turn_end'] as const
export type G8ReplayPoint = (typeof G8_REPLAY_POINTS)[number]

export const G8_REPLAY_VERDICTS = [
  'ok',
  'box_rejected',
  'engine_state_mismatch',
  'duplicate_charge',
  'check_failed',
] as const
export type G8ReplayVerdictName = (typeof G8_REPLAY_VERDICTS)[number]

export type G8DispatchStatus =
  | 'admitted'
  | 'accepted'
  | 'rejecting'
  | 'terminal'
  | 'manual_reconcile'

export type G8DispatchOutcome =
  | 'completed'
  | 'interrupted'
  | 'crashed'
  | 'executed_error'
  | 'not_accepted'

export type G8EngineReported = 'starting' | 'running' | 'compacting' | 'idle' | 'ended'

/**
 * Box continuation rejects the live decoder already names, plus replay evidence
 * that never becomes a billed turn. Kept here so the gate does not import commercial.
 */
export const G8_BOX_REJECT_CODES: ReadonlySet<string> = new Set([
  'BOX_AUTHORITY_MALFORMED',
  'BOX_CACHE_ANNOTATION_INVALID',
  'BOX_CALL_AMBIGUOUS',
  'BOX_PREPARED_CATALOG_MISSING',
  'BOX_PREPARED_REJECT',
  'BOX_PREPARED_STALE',
  'BOX_REPLAY_EVIDENCE_INVALID',
  'BOX_RESUME_IN_PROGRESS',
  'BOX_TOOL_ASSISTANT_CHANGED',
  'BOX_TOOL_CATALOG_CHANGED',
  'BOX_TOOL_CONTEXT_CHANGED',
  'BOX_TOOL_ECHO_CLI_BACKGROUNDED',
  'BOX_TOOL_ECHO_CONTENT_INVALID',
  'BOX_TOOL_ECHO_CONTENT_MISMATCH',
  'BOX_TOOL_ECHO_EXPECTED_INVALID',
  'BOX_TOOL_ECHO_ID_INVALID',
  'BOX_TOOL_ECHO_INCOMPLETE',
  'BOX_TOOL_ECHO_INVALID',
  'BOX_TOOL_ECHO_UNVERIFIED',
  'BOX_TOOL_OWNER_INVALID',
  'BOX_TOOL_OWNER_UNKNOWN',
  'BOX_TOOL_RESULT_MISMATCH',
  'BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION',
  'BOX_TOOL_RESUME_BINDING_INVALID',
  'BOX_TOOL_RESUME_DECISION_UNBOUND',
  'BOX_TOOL_RESUME_IDENTITY_INVALID',
  'BOX_TOOL_RESUME_JOURNAL_INVALID',
  'BOX_TOOL_RESUME_REQUEST_INVALID',
  'BOX_TOOL_ROUND_LIMIT',
  'BOX_TOOL_SPOOL_CAPACITY_EXCEEDED',
])

const USER_CANCEL_CODES = new Set(['USER_CANCELLED', 'user_cancelled', 'stopped'])
const BUSY_ENGINE = new Set<G8EngineReported>(['starting', 'running', 'compacting'])

export interface G8ReplayObservation {
  point: G8ReplayPoint
  traceId: string | null
  boxDecision?: 'accepted' | 'rejected'
  dispatchStatus?: G8DispatchStatus
  dispatchOutcome?: G8DispatchOutcome | null
  failureCode?: string | null
  engineReported?: G8EngineReported
  /** Absent means unknown. Only an explicit false means no process. */
  engineProcessAlive?: boolean
  /** Settled positive charges for this trace. An idempotent replay is not a second bill. */
  settledChargeCount?: number
  idempotentReplay?: boolean
  /** User turns that were admitted on top of an open turn and both settled. */
  stackedSettledTurns?: number
  summaryWritten?: boolean
}

export interface G8ReplayVerdict {
  point: G8ReplayPoint
  traceId: string | null
  verdict: G8ReplayVerdictName
  severity: 'info' | 'warning' | 'critical'
  retryable: boolean
  askHuman: boolean
  alert: boolean
  stopSession: false
  reason: string
}

export function sanitizeG8TraceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !TRACE_ID_REGEX.test(value)) return null
  return value
}

function atLeastTwo(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value >= 2
}

function verdictOf(
  obs: G8ReplayObservation,
  verdict: G8ReplayVerdictName,
  severity: G8ReplayVerdict['severity'],
  reason: string,
  askHuman: boolean,
  alert: boolean,
): G8ReplayVerdict {
  return {
    point: obs.point,
    traceId: sanitizeG8TraceId(obs.traceId),
    verdict,
    severity,
    retryable: false,
    askHuman,
    alert,
    stopSession: false,
    reason,
  }
}

function engineMismatch(obs: G8ReplayObservation): string | null {
  const reported = obs.engineReported
  if (!reported) return null
  if (BUSY_ENGINE.has(reported) && obs.dispatchStatus === 'terminal') {
    return 'engine_busy_after_terminal'
  }
  if (reported === 'starting' && obs.engineProcessAlive === false) {
    return 'engine_starting_without_process'
  }
  if ((reported === 'idle' || reported === 'ended') && obs.dispatchStatus === 'accepted') {
    return 'engine_idle_while_open'
  }
  return null
}

function boxRejected(obs: G8ReplayObservation): boolean {
  if (obs.boxDecision === 'accepted') return false
  if (obs.boxDecision === 'rejected') return true
  const code = obs.failureCode
  if (!code || USER_CANCEL_CODES.has(code)) return false
  return G8_BOX_REJECT_CODES.has(code)
}

/**
 * One verdict. Duplicate charge wins, then an engine/dispatch disagreement,
 * then a Box rejection. Anything else is ok. Never asks the caller to stop.
 */
export function judgeG8Replay(obs: G8ReplayObservation): G8ReplayVerdict {
  const duplicate =
    atLeastTwo(obs.stackedSettledTurns) ||
    (atLeastTwo(obs.settledChargeCount) && obs.idempotentReplay !== true)
  if (duplicate) {
    return verdictOf(obs, 'duplicate_charge', 'critical', 'duplicate_charge', true, true)
  }
  const engine = engineMismatch(obs)
  if (engine) {
    return verdictOf(obs, 'engine_state_mismatch', 'warning', engine, false, true)
  }
  if (boxRejected(obs)) {
    return verdictOf(obs, 'box_rejected', 'warning', 'box_rejected', true, true)
  }
  return verdictOf(obs, 'ok', 'info', 'ok', false, false)
}

export type G8ReplaySink = (verdict: G8ReplayVerdict) => void
export type G8ReplayChecker = (obs: G8ReplayObservation) => G8ReplayVerdict

let sink: G8ReplaySink | null = null
let checker: G8ReplayChecker = judgeG8Replay

/** Install the side effects. Null (the default) keeps the checkpoint off. */
export function setG8ReplayCheckpoint(next: G8ReplaySink | null): void {
  sink = next
}

/** Replace the judge. Null restores the built-in rules. */
export function setG8ReplayChecker(next: G8ReplayChecker | null): void {
  checker = next ?? judgeG8Replay
}

export function resetG8ReplayCheckpointForTest(): void {
  sink = null
  checker = judgeG8Replay
}

function checkFailed(obs: G8ReplayObservation): G8ReplayVerdict {
  return {
    point: obs.point,
    traceId: sanitizeG8TraceId(obs.traceId),
    verdict: 'check_failed',
    severity: 'warning',
    retryable: false,
    askHuman: false,
    alert: false,
    stopSession: false,
    reason: 'check_failed',
  }
}

/**
 * Runs only when a listener is installed. Returns null while off.
 * Listener and checker failures stay inside this function.
 */
export function runG8ReplayCheckpoint(obs: G8ReplayObservation): G8ReplayVerdict | null {
  const current = sink
  if (!current) return null
  let verdict: G8ReplayVerdict
  try {
    const judged = checker(obs)
    verdict = {
      ...judged,
      point: obs.point,
      traceId: sanitizeG8TraceId(judged.traceId ?? obs.traceId),
      stopSession: false,
    }
  } catch {
    verdict = checkFailed(obs)
  }
  try {
    current(verdict)
  } catch {
    // Recording must not change the turn or the summary write.
  }
  return verdict
}

export function g8TurnEndCheckpointInput(row: {
  traceId: string | null
  outcome: G8DispatchOutcome | null
  failureCode: string | null
}): G8ReplayObservation {
  return {
    point: 'turn_end',
    traceId: row.traceId,
    dispatchStatus: 'terminal',
    dispatchOutcome: row.outcome,
    failureCode: row.failureCode,
  }
}

export function g8CompactSummaryCheckpointInput(traceId: string | null): G8ReplayObservation {
  return {
    point: 'compact_summary',
    traceId,
    summaryWritten: true,
    engineReported: 'compacting',
  }
}
