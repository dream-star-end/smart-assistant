/**
 * Single-pass O(N) Antigravity transcript turn-boundary and active-tool reducer.
 * Pure, side-effect-free module extracted from `antigravitySwarmFormat.ts`.
 */
import { extractGenericBgTaskStartId, type BackgroundTaskState } from './antigravitySwarmBgTasks.js'

const turnReductionMetricsForTests = { candidateVisits: 0, setCopies: 0, bucketWrites: 0, idLookups: 0 }
export function resetTurnReductionCandidateVisitsForTests(): void {
  turnReductionMetricsForTests.candidateVisits = 0
  turnReductionMetricsForTests.setCopies = 0
  turnReductionMetricsForTests.bucketWrites = 0
  turnReductionMetricsForTests.idLookups = 0
}
export function getTurnReductionCandidateVisitsForTests(): number { return turnReductionMetricsForTests.candidateVisits }
export function getTurnReductionMetricsForTests() { return { ...turnReductionMetricsForTests } }

const BOARD_COORD_TOOLS = new Set(['swarm_wait', 'post_message', 'read_board'])

function recOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function strOf(v: unknown): string { return typeof v === 'string' ? v.trim() : '' }
function normTool(raw: string): string {
  const t = raw.trim().toLowerCase()
  return t.startsWith('mcp_openclaude-memory_') ? t.slice('mcp_openclaude-memory_'.length) : t
}
export function firstNonBoardToolCall(calls: readonly unknown[]): Record<string, unknown> | null {
  for (const c of calls) {
    const obj = recOf(c)
    const name = normTool(strOf(obj?.name))
    if (name && !BOARD_COORD_TOOLS.has(name)) return obj
  }
  return null
}
function stepCallId(obj: Record<string, unknown> | null): string { return obj ? strOf(obj.tool_call_id || obj.call_id || obj.id) : '' }
function stepToolName(obj: Record<string, unknown> | null): string { return obj ? normTool(strOf(obj.tool_name || obj.name)) : '' }

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`
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

type TurnEndKind = 'none' | 'speculative' | 'certain'

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
  t.hasSteps = true
  t.cachedEnded = null
  t.lastCutPending = false
  t.lastType = stepType
  t.lastSt = strOf(step.status).toUpperCase()
  t.lastCallsLen = 0
  t.lastToolName = ''
  t.hasPlanner = false
  t.lastPlannerSt = ''
  t.lastPlannerHasWait = false
  t.lastPlannerCallsLen = 0
  t.batch = createBatchDoneTracker()
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
  readonly activeNonBoardTool: { name: string; args: Record<string, unknown> | null } | null
}

/**
 * Single-pass O(N) turn boundary and active-tool reducer.
 * Preserves consumed DONE deduplication across `SYSTEM_MESSAGE` cuts and defers
 * speculative ID-bearing cuts until end-of-scan ownership confirmation.
 */
export function analyzeTurnWindow(
  steps: readonly Record<string, unknown>[], bgTasks?: BackgroundTaskState,
): TurnReductionResult {
  if (steps.length === 0) return { turnStart: 0, activeNonBoardTool: null }
  let turnStart = 0
  let tracker = createTurnBoundaryState()
  const pendingCuts: Array<{ stepIdx: number; preCutCallCount: number }> = []
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!
    const stepType = strOf(step.type).toUpperCase()
    if (stepType === 'USER_INPUT') {
      turnStart = i
      pendingCuts.length = 0
      tracker = createTurnBoundaryState()
      ingestTurnBoundaryStep(tracker, step, stepType, bgTasks)
    } else if (stepType === 'SYSTEM_MESSAGE') {
      if (i > turnStart && !tracker.lastCutPending) {
        const endKind = isTurnEndedIncremental(tracker)
        if (endKind === 'certain') {
          turnStart = i
          pendingCuts.length = 0
          advanceTurnSegmentOnCertainCut(tracker, step, stepType)
        } else if (endKind === 'speculative') {
          pendingCuts.push({ stepIdx: i, preCutCallCount: tracker.callState.calls.length })
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
  let finalTurnStart = turnStart
  for (let k = pendingCuts.length - 1; k >= 0; k -= 1) {
    if (pendingCuts[k]!.preCutCallCount <= minUnaccounted) {
      finalTurnStart = pendingCuts[k]!.stepIdx
      break
    }
  }
  return { turnStart: finalTurnStart, activeNonBoardTool }
}

export function findTurnStartIndex(steps: readonly Record<string, unknown>[], bgTasks?: BackgroundTaskState): number {
  return analyzeTurnWindow(steps, bgTasks).turnStart
}

interface TrackedToolCall {
  readonly idx: number; name: string; readonly norm: string; id: string; readonly isBoard: boolean
  args: Record<string, unknown> | null; argsKey: string | null; readonly fromPlanner: boolean; boundDirect: boolean; readonly epoch: number
}
interface TerminalToolStep { readonly id: string; readonly norm: string; readonly epoch: number }
interface ArgsBucket { readonly indices: number[]; head: number; second: number }

interface CallReductionState {
  openEpoch: number; readonly calls: TrackedToolCall[]; readonly callIndicesById: Map<string, number[]>
  readonly callsByEpoch: Map<number, number[]>; readonly callsByEpochNorm: Map<string, number[]>
  readonly unboundByEpochNormArgs: Map<string, ArgsBucket>
  readonly accounted: Set<number>; readonly unaccountedNonBoard: Set<number>
  readonly retirableNonBoardByEpoch: Map<number, number>
  readonly openCertainNamedNonBoard: Set<number>; readonly openSpecNamedNonBoard: Set<number>
  readonly openCertainRetirable: Set<number>; readonly openSpecRetirable: Set<number>
  readonly openIdNamedCountByKey: Map<string, number>
  readonly idMatchedEpochNorms: Set<string>; readonly plannerEpochNormCounts: Map<string, number>
  readonly plannerEpochCallCounts: Map<number, number>; readonly genericTerminalsByEpoch: Map<number, number>
  readonly namedFallbacksByEpoch: Map<number, TerminalToolStep[]>; readonly seenUnidNamedEpochNorms: Set<string>
  readonly pendingIdFallbacks: Map<string, TerminalToolStep>; readonly speculativeIdOwners: Map<string, number>
  readonly backupSpeculativeNamedByIdx: Map<number, TerminalToolStep[]>; readonly exactIdSettled: Set<string>
  readonly seenTerminalIds: Set<string>; readonly seenStepIndices: Set<number>; readonly seenUnindexedPayloads: Set<string>
}

function createCallReductionState(): CallReductionState {
  return {
    openEpoch: 0, calls: [], callIndicesById: new Map(), callsByEpoch: new Map(), callsByEpochNorm: new Map(),
    unboundByEpochNormArgs: new Map(), accounted: new Set(), unaccountedNonBoard: new Set(),
    retirableNonBoardByEpoch: new Map(), openCertainNamedNonBoard: new Set(), openSpecNamedNonBoard: new Set(),
    openCertainRetirable: new Set(), openSpecRetirable: new Set(), openIdNamedCountByKey: new Map(),
    idMatchedEpochNorms: new Set(), plannerEpochNormCounts: new Map(), plannerEpochCallCounts: new Map(),
    genericTerminalsByEpoch: new Map(), namedFallbacksByEpoch: new Map(), seenUnidNamedEpochNorms: new Set(),
    pendingIdFallbacks: new Map(), speculativeIdOwners: new Map(), backupSpeculativeNamedByIdx: new Map(),
    exactIdSettled: new Set(), seenTerminalIds: new Set(), seenStepIndices: new Set(), seenUnindexedPayloads: new Set(),
  }
}

function pushBucketIndex<K, V = number>(map: Map<K, V[]>, key: K, item: V): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(item)
  else map.set(key, [item])
}
function pushArgsBucket(state: CallReductionState, key: string, idx: number): void {
  turnReductionMetricsForTests.bucketWrites += 1
  const bucket = state.unboundByEpochNormArgs.get(key)
  if (bucket) bucket.indices.push(idx)
  else state.unboundByEpochNormArgs.set(key, { indices: [idx], head: 0, second: 1 })
}
function syncOpenNamedCoverage(state: CallReductionState, epoch: number, norm: string): void {
  if (epoch !== state.openEpoch || BOARD_COORD_TOOLS.has(norm)) return
  const key = `${epoch}:${norm}`
  const bucket = state.callsByEpochNorm.get(key)
  if (!bucket || bucket.length === 0) return
  const idx = bucket[0]!
  state.openCertainNamedNonBoard.delete(idx)
  state.openSpecNamedNonBoard.delete(idx)
  state.openCertainRetirable.delete(idx)
  state.openSpecRetirable.delete(idx)
  if (bucket.length !== 1 || state.idMatchedEpochNorms.has(key) || state.accounted.has(idx)) return
  const retirable = isRetirablePlannerNonBoard(state, idx)
  if (state.seenUnidNamedEpochNorms.has(key)) {
    state.openCertainNamedNonBoard.add(idx)
    if (retirable) state.openCertainRetirable.add(idx)
  } else if (!state.calls[idx]!.id && (state.openIdNamedCountByKey.get(key) ?? 0) > 0) {
    state.openSpecNamedNonBoard.add(idx)
    if (retirable) state.openSpecRetirable.add(idx)
  }
}
function pushNamedFallback(state: CallReductionState, epoch: number, term: TerminalToolStep): void {
  const key = `${epoch}:${term.norm}`
  if (!term.id) {
    if (state.seenUnidNamedEpochNorms.has(key)) return
    state.seenUnidNamedEpochNorms.add(key)
  } else if (epoch === state.openEpoch && !BOARD_COORD_TOOLS.has(term.norm)) {
    state.openIdNamedCountByKey.set(key, (state.openIdNamedCountByKey.get(key) ?? 0) + 1)
  }
  pushBucketIndex(state.namedFallbacksByEpoch, epoch, term)
  syncOpenNamedCoverage(state, epoch, term.norm)
}
function indexCallId(state: CallReductionState, id: string, idx: number): void { if (id) pushBucketIndex(state.callIndicesById, id, idx) }
function isRetirablePlannerNonBoard(state: CallReductionState, idx: number): boolean {
  const c = state.calls[idx]
  return !!c && !c.isBoard && c.fromPlanner && !c.id && !c.boundDirect && !state.accounted.has(idx)
}
function adjustRetirableNonBoard(state: CallReductionState, epoch: number, delta: number): void {
  const next = (state.retirableNonBoardByEpoch.get(epoch) ?? 0) + delta
  if (next > 0) state.retirableNonBoardByEpoch.set(epoch, next)
  else state.retirableNonBoardByEpoch.delete(epoch)
}
function markCallAccounted(state: CallReductionState, idx: number): void {
  const c = state.calls[idx]
  if (isRetirablePlannerNonBoard(state, idx)) adjustRetirableNonBoard(state, c!.epoch, -1)
  state.accounted.add(idx)
  state.unaccountedNonBoard.delete(idx)
  if (c) syncOpenNamedCoverage(state, c.epoch, c.norm)
}
function unmarkCallAccounted(state: CallReductionState, idx: number): void {
  state.accounted.delete(idx)
  const c = state.calls[idx]
  if (c && !c.isBoard) state.unaccountedNonBoard.add(idx)
  if (isRetirablePlannerNonBoard(state, idx)) adjustRetirableNonBoard(state, c!.epoch, 1)
  if (c) syncOpenNamedCoverage(state, c.epoch, c.norm)
}

function releaseSpeculativeOwner(state: CallReductionState, prevIdx: number): void {
  const backups = state.backupSpeculativeNamedByIdx.get(prevIdx)
  if (backups) {
    while (backups.length > 0) {
      const nextTerm = backups.shift()!
      if (state.exactIdSettled.has(nextTerm.id) || !state.pendingIdFallbacks.has(nextTerm.id)) continue
      state.pendingIdFallbacks.delete(nextTerm.id)
      state.speculativeIdOwners.set(nextTerm.id, prevIdx)
      return
    }
    state.backupSpeculativeNamedByIdx.delete(prevIdx)
  }
  unmarkCallAccounted(state, prevIdx)
}

function claimTerminalIdForCall(
  state: CallReductionState, idx: number, id: string, norm: string, epoch: number,
): void {
  if (!id || state.exactIdSettled.has(id)) return
  turnReductionMetricsForTests.idLookups += 1
  const pending = state.pendingIdFallbacks.get(id)
  if (pending) {
    state.pendingIdFallbacks.delete(id)
    state.exactIdSettled.add(id)
    if (pending.norm && pending.epoch === state.openEpoch && !BOARD_COORD_TOOLS.has(pending.norm)) {
      const pKey = `${pending.epoch}:${pending.norm}`
      const next = (state.openIdNamedCountByKey.get(pKey) ?? 0) - 1
      if (next > 0) state.openIdNamedCountByKey.set(pKey, next)
      else state.openIdNamedCountByKey.delete(pKey)
      syncOpenNamedCoverage(state, pending.epoch, pending.norm)
    }
    state.idMatchedEpochNorms.add(`${epoch}:${norm}`)
    markCallAccounted(state, idx)
    return
  }
  const prevIdx = state.speculativeIdOwners.get(id)
  if (prevIdx !== undefined) {
    state.speculativeIdOwners.delete(id)
    state.exactIdSettled.add(id)
    if (prevIdx !== idx) releaseSpeculativeOwner(state, prevIdx)
    state.idMatchedEpochNorms.add(`${epoch}:${norm}`)
    markCallAccounted(state, idx)
  }
}

function findUnaccountedIndexById(state: CallReductionState, id: string): number {
  turnReductionMetricsForTests.idLookups += 1
  const bucket = state.callIndicesById.get(id)
  if (!bucket) return -1
  for (const idx of bucket) {
    if (!state.accounted.has(idx)) return idx
  }
  return -1
}

function isUnboundPlannerCandidate(state: CallReductionState, idx: number): boolean {
  const c = state.calls[idx]!
  return !state.accounted.has(idx) && c.fromPlanner && !c.id && !c.boundDirect
}

function findUnboundPlannerCallByEpochNorm(
  state: CallReductionState, epoch: number, norm: string, requireNoId: boolean, argsKey: string | null,
): TrackedToolCall | null {
  const bucket = state.callsByEpochNorm.get(`${epoch}:${norm}`)
  if (!bucket || bucket.length === 0) return null
  turnReductionMetricsForTests.candidateVisits += 1
  const idx = bucket[0]!
  const c = state.calls[idx]!
  if (state.accounted.has(idx) || !c.fromPlanner || c.boundDirect || (requireNoId && c.id)) return null
  if (argsKey !== null && c.argsKey !== null && c.argsKey !== argsKey) return null
  return c
}

function findUniqueArgsMatchedUnboundPlannerCall(
  state: CallReductionState, epoch: number, norm: string, argsKey: string | null,
): TrackedToolCall | null {
  if (argsKey === null) return null
  const bucket = state.unboundByEpochNormArgs.get(`${epoch}:${norm}:${argsKey}`)
  if (!bucket) return null
  const { indices } = bucket
  while (bucket.head < indices.length) {
    turnReductionMetricsForTests.candidateVisits += 1
    if (isUnboundPlannerCandidate(state, indices[bucket.head]!)) break
    bucket.head += 1
  }
  if (bucket.head >= indices.length) return null
  if (bucket.second <= bucket.head) bucket.second = bucket.head + 1
  while (bucket.second < indices.length) {
    turnReductionMetricsForTests.candidateVisits += 1
    if (isUnboundPlannerCandidate(state, indices[bucket.second]!)) return null
    bucket.second += 1
  }
  return state.calls[indices[bucket.head]!]!
}

function bindIdDirectCall(
  state: CallReductionState, norm: string, id: string, args: Record<string, unknown> | null, argsKey: string | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): boolean {
  const existingIdx = state.callIndicesById.get(id)?.[0]
  if (existingIdx !== undefined) {
    const existing = state.calls[existingIdx]!
    if (!existing.args && args) {
      existing.args = args
      existing.argsKey = argsKey
    }
    existing.boundDirect = true
    return true
  }
  if (fromPlanner || !hasPlannerRoot) return false
  const epochNormTotal = state.plannerEpochNormCounts.get(`${epoch}:${norm}`) ?? 0
  const unbound = epochNormTotal === 1
    ? findUnboundPlannerCallByEpochNorm(state, epoch, norm, true, argsKey)
    : findUniqueArgsMatchedUnboundPlannerCall(state, epoch, norm, argsKey)
  if (!unbound) return false
  if (isRetirablePlannerNonBoard(state, unbound.idx)) adjustRetirableNonBoard(state, unbound.epoch, -1)
  unbound.id = id
  indexCallId(state, id, unbound.idx)
  unbound.boundDirect = true
  if (!unbound.args && args) {
    unbound.args = args
    unbound.argsKey = argsKey
  }
  claimTerminalIdForCall(state, unbound.idx, id, norm, unbound.epoch)
  syncOpenNamedCoverage(state, unbound.epoch, norm)
  return true
}

function bindUnidDirectCall(
  state: CallReductionState, norm: string, args: Record<string, unknown> | null, argsKey: string | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): boolean {
  if (fromPlanner || !hasPlannerRoot) return false
  const epochNormTotal = state.plannerEpochNormCounts.get(`${epoch}:${norm}`) ?? 0
  const unbound = epochNormTotal === 1
    ? findUnboundPlannerCallByEpochNorm(state, epoch, norm, false, argsKey)
    : findUniqueArgsMatchedUnboundPlannerCall(state, epoch, norm, argsKey)
  if (!unbound) return false
  if (isRetirablePlannerNonBoard(state, unbound.idx)) adjustRetirableNonBoard(state, unbound.epoch, -1)
  unbound.boundDirect = true
  if (!unbound.args && args) {
    unbound.args = args
    unbound.argsKey = argsKey
  }
  syncOpenNamedCoverage(state, unbound.epoch, norm)
  return true
}

function bindExistingOrPlannerCall(
  state: CallReductionState, norm: string, id: string, args: Record<string, unknown> | null, argsKey: string | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): boolean {
  return id
    ? bindIdDirectCall(state, norm, id, args, argsKey, fromPlanner, hasPlannerRoot, epoch)
    : bindUnidDirectCall(state, norm, args, argsKey, fromPlanner, hasPlannerRoot, epoch)
}

function registerTrackedCallStart(
  state: CallReductionState, rawName: string, id: string, args: Record<string, unknown> | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): void {
  const norm = normTool(rawName)
  if (!norm) return
  const argsKey = args !== null ? canonicalJson(args) : null
  if (bindExistingOrPlannerCall(state, norm, id, args, argsKey, fromPlanner, hasPlannerRoot, epoch)) return
  const idx = state.calls.length
  const isBoard = BOARD_COORD_TOOLS.has(norm)
  state.calls.push({ idx, name: rawName, norm, id, isBoard, args, argsKey, fromPlanner, boundDirect: !fromPlanner, epoch })
  indexCallId(state, id, idx)
  pushBucketIndex(state.callsByEpoch, epoch, idx)
  pushBucketIndex(state.callsByEpochNorm, `${epoch}:${norm}`, idx)
  if (fromPlanner && !id && argsKey !== null) pushArgsBucket(state, `${epoch}:${norm}:${argsKey}`, idx)
  if (!isBoard) {
    state.unaccountedNonBoard.add(idx)
    if (fromPlanner && !id) adjustRetirableNonBoard(state, epoch, 1)
  }
  if (id) claimTerminalIdForCall(state, idx, id, norm, epoch)
  syncOpenNamedCoverage(state, epoch, norm)
}

function registerCallList(
  state: CallReductionState, rawCalls: readonly unknown[], fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): void {
  if (fromPlanner) {
    let validPlannerCount = 0
    for (const raw of rawCalls) {
      const obj = recOf(raw)
      const norm = obj ? normTool(strOf(obj.name || obj.tool_name)) : ''
      if (norm) {
        validPlannerCount += 1
        const key = `${epoch}:${norm}`
        state.plannerEpochNormCounts.set(key, (state.plannerEpochNormCounts.get(key) ?? 0) + 1)
      }
    }
    if (validPlannerCount > 0) state.plannerEpochCallCounts.set(epoch, (state.plannerEpochCallCounts.get(epoch) ?? 0) + validPlannerCount)
  }
  for (const raw of rawCalls) {
    const obj = recOf(raw)
    if (obj) registerTrackedCallStart(state, strOf(obj.name || obj.tool_name), stepCallId(obj), recOf(obj.arguments ?? obj.args), fromPlanner, hasPlannerRoot, epoch)
  }
}

function recordTerminalToolEvent(state: CallReductionState, step: Record<string, unknown>, epoch: number): void {
  const cid = stepCallId(step)
  if (cid) {
    if (state.seenTerminalIds.has(cid)) return
    state.seenTerminalIds.add(cid)
  }
  const rawStepIdx = step.step_index
  if (typeof rawStepIdx === 'number' && Number.isFinite(rawStepIdx)) {
    if (state.seenStepIndices.has(rawStepIdx)) return
    state.seenStepIndices.add(rawStepIdx)
  } else if (!cid) {
    const fingerprint = `${epoch}:${JSON.stringify(step)}`
    if (state.seenUnindexedPayloads.has(fingerprint)) return
    state.seenUnindexedPayloads.add(fingerprint)
  }
  const tname = stepToolName(step)
  if (!cid && !tname) {
    if (strOf(step.type).toUpperCase() === 'GENERIC') {
      state.genericTerminalsByEpoch.set(epoch, (state.genericTerminalsByEpoch.get(epoch) ?? 0) + 1)
    }
    return
  }
  if (cid) {
    const idx = findUnaccountedIndexById(state, cid)
    if (idx >= 0) {
      const matched = state.calls[idx]!
      state.exactIdSettled.add(cid)
      state.idMatchedEpochNorms.add(`${matched.epoch}:${matched.norm}`)
      markCallAccounted(state, idx)
      return
    }
    const term: TerminalToolStep = { id: cid, norm: tname, epoch }
    state.pendingIdFallbacks.set(cid, term)
    if (tname) pushNamedFallback(state, epoch, term)
    return
  }
  if (tname) pushNamedFallback(state, epoch, { id: '', norm: tname, epoch })
}

function findUnambiguousNameFallbackIndex(state: CallReductionState, term: TerminalToolStep): number {
  const key = `${term.epoch}:${term.norm}`
  if (state.idMatchedEpochNorms.has(key)) return -1
  const bucket = state.callsByEpochNorm.get(key)
  if (!bucket || bucket.length !== 1) return -1
  turnReductionMetricsForTests.candidateVisits += 1
  const idx = bucket[0]!
  const c = state.calls[idx]!
  if (state.accounted.has(idx) || (term.id && c.id)) return -1
  return idx
}

function extractBatchCallsIfToolStep(step: Record<string, unknown>, stepType: string): readonly unknown[] | null {
  return (stepType === 'TOOL_CALL' || stepType === 'TOOL_USE') && Array.isArray(step.tool_calls) ? step.tool_calls : null
}

function ingestTurnStep(
  state: CallReductionState, step: Record<string, unknown>, hasPlannerRoot: boolean, epoch: number,
  bgTasks?: BackgroundTaskState, knownStepType?: string,
): void {
  const stepType = knownStepType ?? strOf(step.type).toUpperCase()
  if (stepType === 'SYSTEM_MESSAGE' || stepType === 'USER_INPUT') return
  const st = strOf(step.status).toUpperCase()
  const batchCalls = extractBatchCallsIfToolStep(step, stepType)
  if (st === 'DONE' || st === 'ERROR') {
    if (batchCalls) {
      for (const raw of batchCalls) {
        const obj = recOf(raw)
        if (obj) recordTerminalToolEvent(state, { ...obj, status: st }, epoch)
      }
    }
    recordTerminalToolEvent(state, step, epoch)
    return
  }
  const bgStartId = bgTasks ? extractGenericBgTaskStartId(step) : null
  if (bgStartId && (bgTasks!.active.has(bgStartId) || bgTasks!.retired.has(bgStartId))) {
    recordTerminalToolEvent(state, step, epoch)
    return
  }
  const direct = strOf(step.tool_name || step.name)
  if (direct) {
    registerTrackedCallStart(state, direct, stepCallId(step), recOf(step.arguments ?? step.args), false, hasPlannerRoot, epoch)
  } else if (batchCalls) {
    registerCallList(state, batchCalls, false, hasPlannerRoot, epoch)
  }
}

function resolveGenericEpochForOne(state: CallReductionState, epoch: number, genericCount: number): void {
  const bucket = state.callsByEpoch.get(epoch)
  if (!bucket || bucket.length === 0) return
  const possibleAnonymousSources = Math.max(bucket.length, state.plannerEpochCallCounts.get(epoch) ?? 0)
  if (genericCount < possibleAnonymousSources) return
  for (const idx of bucket) {
    turnReductionMetricsForTests.candidateVisits += 1
    const c = state.calls[idx]!
    if (c.fromPlanner && !c.id && !c.boundDirect && !state.accounted.has(idx)) markCallAccounted(state, idx)
  }
}

function settleCompletedEpoch(state: CallReductionState, epoch: number): void {
  const named = state.namedFallbacksByEpoch.get(epoch)
  const deferredIdNamed: TerminalToolStep[] = []
  if (named) {
    for (const term of named) {
      if (term.id) {
        deferredIdNamed.push(term)
        continue
      }
      const idx = findUnambiguousNameFallbackIndex(state, term)
      if (idx >= 0) markCallAccounted(state, idx)
    }
    state.namedFallbacksByEpoch.delete(epoch)
  }
  const genericCount = state.genericTerminalsByEpoch.get(epoch)
  if (genericCount !== undefined) {
    resolveGenericEpochForOne(state, epoch, genericCount)
    state.genericTerminalsByEpoch.delete(epoch)
  }
  const speculativeIdxByNorm = new Map<string, number>()
  for (const term of deferredIdNamed) {
    if (state.exactIdSettled.has(term.id) || !state.pendingIdFallbacks.has(term.id)) continue
    const existingSpecIdx = speculativeIdxByNorm.get(term.norm)
    if (existingSpecIdx !== undefined) {
      pushBucketIndex(state.backupSpeculativeNamedByIdx, existingSpecIdx, term)
      continue
    }
    const idx = findUnambiguousNameFallbackIndex(state, term)
    if (idx >= 0) {
      markCallAccounted(state, idx)
      state.pendingIdFallbacks.delete(term.id)
      state.speculativeIdOwners.set(term.id, idx)
      speculativeIdxByNorm.set(term.norm, idx)
    }
  }
  state.openCertainNamedNonBoard.clear()
  state.openSpecNamedNonBoard.clear()
  state.openCertainRetirable.clear()
  state.openSpecRetirable.clear()
  state.openIdNamedCountByKey.clear()
  state.openEpoch = epoch + 1
}

function resolveFallbackTerminals(state: CallReductionState): void {
  const deferredIdNamed: TerminalToolStep[] = []
  for (const list of state.namedFallbacksByEpoch.values()) {
    for (const term of list) {
      if (term.id) {
        deferredIdNamed.push(term)
        continue
      }
      const fallbackIdx = findUnambiguousNameFallbackIndex(state, term)
      if (fallbackIdx >= 0) markCallAccounted(state, fallbackIdx)
    }
  }
  for (const [epoch, genericCount] of state.genericTerminalsByEpoch.entries()) {
    resolveGenericEpochForOne(state, epoch, genericCount)
  }
  const usedIds = deferredIdNamed.length > 0 ? new Set<string>() : null
  for (const term of deferredIdNamed) {
    if (usedIds!.has(term.id) || state.exactIdSettled.has(term.id) || !state.pendingIdFallbacks.has(term.id)) continue
    const fallbackIdx = findUnambiguousNameFallbackIndex(state, term)
    if (fallbackIdx >= 0) {
      markCallAccounted(state, fallbackIdx)
      usedIds!.add(term.id)
    }
  }
}

function classifyNonBoardTurnEnd(state: CallReductionState): TurnEndKind {
  const totalNeeded = state.unaccountedNonBoard.size
  if (totalNeeded === 0) return state.speculativeIdOwners.size > 0 ? 'speculative' : 'certain'
  let certain = state.openCertainNamedNonBoard.size
  let spec = state.openSpecNamedNonBoard.size
  const genericCount = state.genericTerminalsByEpoch.get(state.openEpoch) ?? 0
  if (genericCount > 0) {
    const bucket = state.callsByEpoch.get(state.openEpoch)
    const possible = Math.max(bucket?.length ?? 0, state.plannerEpochCallCounts.get(state.openEpoch) ?? 0)
    if (possible > 0 && genericCount >= possible) {
      certain += (state.retirableNonBoardByEpoch.get(state.openEpoch) ?? 0) - state.openCertainRetirable.size
      spec -= state.openSpecRetirable.size
    }
  }
  if (certain >= totalNeeded) return state.speculativeIdOwners.size > 0 ? 'speculative' : 'certain'
  return certain + spec >= totalNeeded ? 'speculative' : 'none'
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
