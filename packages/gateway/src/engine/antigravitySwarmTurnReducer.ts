/**
 * Single-pass O(N) Antigravity transcript turn-boundary and active-tool reducer.
 * Pure, side-effect-free orchestrator built on `antigravitySwarmCallState.ts`.
 */
import type { BackgroundTaskState } from './antigravitySwarmBgTasks.js'
import {
  canonicalJson, classifyNonBoardTurnEnd, createCallReductionState, firstNonBoardToolCall,
  getTurnReductionCandidateVisitsForTests, getTurnReductionMetricsForTests, ingestTurnStep, normTool,
  recOf, registerCallList, resetTurnReductionCandidateVisitsForTests, resolveFallbackTerminals,
  settleCompletedEpoch, stepCallId, stepToolName, strOf,
  type CallReductionState, type TurnEndKind,
} from './antigravitySwarmCallState.js'

export {
  firstNonBoardToolCall, getTurnReductionCandidateVisitsForTests, getTurnReductionMetricsForTests,
  resetTurnReductionCandidateVisitsForTests,
}

function plannerBatchHasSwarmWait(calls: readonly unknown[]): boolean {
  return calls.some((raw) => normTool(strOf(recOf(raw)?.name)) === 'swarm_wait')
}

interface BatchDoneTracker {
  readonly seenIds: Set<string>; readonly unsettledIds: Set<string>
  readonly unsettledAnonTools: Map<string, number>; unsettledAnonCount: number
  readonly seenIndices: Set<number>; readonly seenPayloads: Set<string>
  doneCount: number; explicitSwarmWaitDone: boolean
}

function createBatchDoneTracker(): BatchDoneTracker {
  return {
    seenIds: new Set(), unsettledIds: new Set(), unsettledAnonTools: new Map(), unsettledAnonCount: 0,
    seenIndices: new Set(), seenPayloads: new Set(), doneCount: 0, explicitSwarmWaitDone: false,
  }
}

function recordUnsettledStep(cid: string, tname: string, b: BatchDoneTracker): void {
  if (cid) {
    if (!b.seenIds.has(cid)) b.unsettledIds.add(cid)
    return
  }
  const key = tname || '*'
  b.unsettledAnonTools.set(key, (b.unsettledAnonTools.get(key) ?? 0) + 1)
  b.unsettledAnonCount += 1
}

function consumeAnonymousDoneStep(step: Record<string, unknown>, tname: string, b: BatchDoneTracker): boolean {
  if (typeof step.step_index === 'number' && Number.isFinite(step.step_index)) {
    if (b.seenIndices.has(step.step_index)) return false
    b.seenIndices.add(step.step_index)
  } else {
    const fp = JSON.stringify(step)
    if (b.seenPayloads.has(fp)) return false
    b.seenPayloads.add(fp)
  }
  const key = tname && (b.unsettledAnonTools.get(tname) ?? 0) > 0 ? tname : ((b.unsettledAnonTools.get('*') ?? 0) > 0 ? '*' : '')
  if (key) {
    b.unsettledAnonTools.set(key, b.unsettledAnonTools.get(key)! - 1)
    b.unsettledAnonCount -= 1
  }
  return true
}

function ingestBatchDoneStep(b: BatchDoneTracker, step: Record<string, unknown>, stepType: string): void {
  if (stepType === 'SYSTEM_MESSAGE' || stepType === 'USER_INPUT') return
  const st = strOf(step.status).toUpperCase()
  const cid = stepCallId(step)
  const tname = stepToolName(step)
  if (st !== 'DONE') {
    recordUnsettledStep(cid, tname, b)
    return
  }
  if (cid) {
    b.unsettledIds.delete(cid)
    if (b.seenIds.has(cid)) return
    b.seenIds.add(cid)
  } else if (!consumeAnonymousDoneStep(step, tname, b)) {
    return
  }
  if (tname === 'swarm_wait') b.explicitSwarmWaitDone = true
  b.doneCount += 1
}

function batchHasUnsettled(b: BatchDoneTracker): boolean { return b.unsettledIds.size > 0 || b.unsettledAnonCount > 0 }

interface TurnBoundaryState {
  hasSteps: boolean; lastType: string; lastSt: string; lastToolName: string; lastCallsLen: number
  hasPlanner: boolean; lastPlannerSt: string; lastPlannerHasWait: boolean; lastPlannerCallsLen: number
  epoch: number; readonly callState: CallReductionState; batch: BatchDoneTracker
  cachedEnded: TurnEndKind | null; lastCutPending: boolean
}

function createTurnBoundaryState(): TurnBoundaryState {
  return {
    hasSteps: false, lastType: '', lastSt: '', lastToolName: '', lastCallsLen: 0,
    hasPlanner: false, lastPlannerSt: '', lastPlannerHasWait: false, lastPlannerCallsLen: 0,
    epoch: 0, callState: createCallReductionState(), batch: createBatchDoneTracker(),
    cachedEnded: null, lastCutPending: false,
  }
}

function ingestTurnBoundaryStep(
  t: TurnBoundaryState, step: Record<string, unknown>, stepType: string, bgTasks?: BackgroundTaskState,
): void {
  t.hasSteps = true
  t.cachedEnded = null
  if (stepType !== 'SYSTEM_MESSAGE') t.lastCutPending = false
  t.lastType = stepType
  t.lastSt = strOf(step.status).toUpperCase()
  if (stepType === 'PLANNER_RESPONSE') {
    settleCompletedEpoch(t.callState, t.epoch)
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
    t.lastCallsLen = calls.length
    t.lastToolName = ''
    t.hasPlanner = true
    t.lastPlannerSt = t.lastSt
    t.lastPlannerHasWait = plannerBatchHasSwarmWait(calls)
    t.lastPlannerCallsLen = calls.length
    t.epoch += 1
    t.batch = createBatchDoneTracker()
    registerCallList(t.callState, calls, true, true, t.epoch)
    return
  }
  t.lastCallsLen = 0
  t.lastToolName = stepToolName(step)
  ingestTurnStep(t.callState, step, t.epoch > 0, t.epoch, bgTasks, stepType)
  ingestBatchDoneStep(t.batch, step, stepType)
}

function advanceTurnSegmentOnCertainCut(t: TurnBoundaryState, step: Record<string, unknown>, stepType: string): void {
  settleCompletedEpoch(t.callState, t.epoch)
  t.epoch += 1
  t.callState.unaccountedNonBoard.clear()
  t.callState.retirableNonBoardByEpoch.clear()
  Object.assign(t, {
    hasSteps: true, cachedEnded: null, lastCutPending: false, lastType: stepType, lastSt: strOf(step.status).toUpperCase(),
    lastCallsLen: 0, lastToolName: '', hasPlanner: false, lastPlannerSt: '', lastPlannerHasWait: false, lastPlannerCallsLen: 0,
    batch: createBatchDoneTracker(),
  })
}

function isExactDuplicatePlannerStep(
  step: Record<string, unknown>, stepType: string, seenByIndex: Map<number, Set<string>>,
): boolean {
  if (stepType !== 'PLANNER_RESPONSE') return false
  const rawIdx = step.step_index
  if (typeof rawIdx !== 'number' || !Number.isFinite(rawIdx)) return false
  const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
  const st = strOf(step.status).toUpperCase()
  const key = calls.length > 0 ? `${st}:${canonicalJson(calls)}` : `${st}:[]:${strOf(step.content)}`
  let bucket = seenByIndex.get(rawIdx)
  if (bucket?.has(key)) return true
  if (!bucket) {
    bucket = new Set()
    seenByIndex.set(rawIdx, bucket)
  }
  bucket.add(key)
  return false
}

function isTurnEndedIncremental(t: TurnBoundaryState): TurnEndKind {
  if (!t.hasSteps) return 'none'
  if (t.cachedEnded !== null) return t.cachedEnded
  let kind: TurnEndKind = 'none'
  const hasSpeculative = t.callState.speculativeIdOwners.size > 0
  if (t.lastType === 'ERROR_MESSAGE') {
    kind = hasSpeculative ? 'speculative' : 'certain'
  } else if (t.lastType === 'PLANNER_RESPONSE') {
    if (t.lastSt === 'DONE' && t.lastCallsLen === 0) kind = hasSpeculative ? 'speculative' : 'certain'
  } else if (!t.hasPlanner) {
    if (t.lastToolName === 'swarm_wait' && t.lastSt === 'DONE' && !batchHasUnsettled(t.batch) && t.batch.explicitSwarmWaitDone) {
      kind = classifyNonBoardTurnEnd(t.callState)
    }
  } else if (
    t.lastPlannerSt === 'DONE' && t.lastPlannerHasWait && !batchHasUnsettled(t.batch) &&
    (t.batch.explicitSwarmWaitDone || t.batch.doneCount >= t.lastPlannerCallsLen)
  ) {
    kind = classifyNonBoardTurnEnd(t.callState)
  }
  t.cachedEnded = kind
  return kind
}

export interface TurnReductionResult {
  readonly turnStart: number
  readonly turnSteps: readonly Record<string, unknown>[]
  readonly activeNonBoardTool: { name: string; args: Record<string, unknown> | null } | null
}

/**
 * Single-pass O(N) turn boundary and active-tool reducer.
 * Drops exact replayed `PLANNER_RESPONSE` steps before reduction, preserves consumed DONE
 * deduplication across `SYSTEM_MESSAGE` cuts, and defers speculative cuts until confirmation.
 */
export function analyzeTurnWindow(
  steps: readonly Record<string, unknown>[], bgTasks?: BackgroundTaskState,
): TurnReductionResult {
  if (steps.length === 0) return { turnStart: 0, turnSteps: [], activeNonBoardTool: null }
  let turnStartOrig = 0
  let turnStartEff = 0
  let tracker = createTurnBoundaryState()
  const effectiveSteps: Record<string, unknown>[] = []
  const seenPlannerByIndex = new Map<number, Set<string>>()
  const pendingCuts: Array<{ origIdx: number; effIdx: number; preCutCallCount: number }> = []
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!
    const stepType = strOf(step.type).toUpperCase()
    if (isExactDuplicatePlannerStep(step, stepType, seenPlannerByIndex)) continue
    const effIdx = effectiveSteps.length
    effectiveSteps.push(step)
    if (stepType === 'USER_INPUT') {
      turnStartOrig = i
      turnStartEff = effIdx
      pendingCuts.length = 0
      seenPlannerByIndex.clear()
      tracker = createTurnBoundaryState()
      ingestTurnBoundaryStep(tracker, step, stepType, bgTasks)
    } else if (stepType === 'SYSTEM_MESSAGE') {
      if (i > turnStartOrig && !tracker.lastCutPending) {
        const endKind = isTurnEndedIncremental(tracker)
        if (endKind === 'certain') {
          turnStartOrig = i
          turnStartEff = effIdx
          pendingCuts.length = 0
          advanceTurnSegmentOnCertainCut(tracker, step, stepType)
        } else if (endKind === 'speculative') {
          pendingCuts.push({ origIdx: i, effIdx, preCutCallCount: tracker.callState.calls.length })
          tracker.lastCutPending = true
        }
      }
    } else {
      ingestTurnBoundaryStep(tracker, step, stepType, bgTasks)
    }
  }
  resolveFallbackTerminals(tracker.callState)
  let activeNonBoardTool: { name: string; args: Record<string, unknown> | null } | null = null
  let minUnaccounted = Number.POSITIVE_INFINITY
  for (const idx of tracker.callState.unaccountedNonBoard) {
    if (!tracker.callState.accounted.has(idx)) {
      if (idx < minUnaccounted) minUnaccounted = idx
      if (!activeNonBoardTool) {
        const call = tracker.callState.calls[idx]!
        activeNonBoardTool = { name: call.name, args: call.args }
      }
    }
  }
  for (let k = pendingCuts.length - 1; k >= 0; k -= 1) {
    if (pendingCuts[k]!.preCutCallCount <= minUnaccounted) {
      turnStartOrig = pendingCuts[k]!.origIdx
      turnStartEff = pendingCuts[k]!.effIdx
      break
    }
  }
  return { turnStart: turnStartOrig, turnSteps: effectiveSteps.slice(turnStartEff), activeNonBoardTool }
}

export function findTurnStartIndex(steps: readonly Record<string, unknown>[], bgTasks?: BackgroundTaskState): number {
  return analyzeTurnWindow(steps, bgTasks).turnStart
}

export function findActiveNonBoardToolInTurn(
  turnSteps: readonly Record<string, unknown>[], lastPlannerIdx: number, lastPlannerCalls: readonly unknown[], bgTasks?: BackgroundTaskState,
): { name: string; args: Record<string, unknown> | null } | null {
  if (turnSteps.length === 0) return null
  const state = createCallReductionState()
  let epoch = 0
  for (let i = 0; i < turnSteps.length; i += 1) {
    const step = turnSteps[i]!
    const stepType = strOf(step.type).toUpperCase()
    if (stepType === 'PLANNER_RESPONSE') {
      settleCompletedEpoch(state, epoch)
      epoch += 1
      const calls = i === lastPlannerIdx ? lastPlannerCalls : (Array.isArray(step.tool_calls) ? step.tool_calls : [])
      registerCallList(state, calls, true, true, epoch)
      continue
    }
    ingestTurnStep(state, step, epoch > 0, epoch, bgTasks, stepType)
  }
  resolveFallbackTerminals(state)
  for (const idx of state.unaccountedNonBoard) {
    const call = state.calls[idx]!
    if (!state.accounted.has(idx)) return { name: call.name, args: call.args }
  }
  return null
}
