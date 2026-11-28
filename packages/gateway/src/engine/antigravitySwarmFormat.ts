/**
 * Pure SwarmSnapshot formatting, terminal settlement, and durable persistence helpers.
 */
import { basename } from 'node:path'
import { compactSwarmSnapshotToByteBudget, type SwarmPhase, type SwarmSnapshot } from '@openclaude/protocol'
import {
  analyzeBackgroundTasksInSteps, createBackgroundTaskState, extractGenericBgTaskStartId, mergeBackgroundTaskStates,
  type BackgroundTaskState, type BackgroundTaskTelemetrySummary, type MergedBackgroundTaskState, type TrackedBackgroundTask,
} from './antigravitySwarmBgTasks.js'

export {
  analyzeBackgroundTasksInSteps, createBackgroundTaskState, mergeBackgroundTaskStates,
  type BackgroundTaskState, type BackgroundTaskTelemetrySummary, type MergedBackgroundTaskState, type TrackedBackgroundTask,
}

let turnReductionCandidateVisitsForTests = 0
let turnReductionSetCopiesForTests = 0
let turnReductionBucketWritesForTests = 0
let turnReductionIdLookupsForTests = 0
export function resetTurnReductionCandidateVisitsForTests(): void {
  turnReductionCandidateVisitsForTests = 0
  turnReductionSetCopiesForTests = 0
  turnReductionBucketWritesForTests = 0
  turnReductionIdLookupsForTests = 0
}
export function getTurnReductionCandidateVisitsForTests(): number { return turnReductionCandidateVisitsForTests }
export function getTurnReductionMetricsForTests() {
  return { candidateVisits: turnReductionCandidateVisitsForTests, setCopies: turnReductionSetCopiesForTests, bucketWrites: turnReductionBucketWritesForTests, idLookups: turnReductionIdLookupsForTests }
}

const SWARM_MCP_TOOL_PREFIX = 'mcp_openclaude-memory_'

/** Strip the container MCP prefix (`mcp_openclaude-memory_`) so remote swarm tools
 *  normalize to the same canonical names as native Antigravity CLI tools. */
export function normalizeSwarmToolName(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith(SWARM_MCP_TOOL_PREFIX) ? trimmed.slice(SWARM_MCP_TOOL_PREFIX.length) : trimmed
}

function shortFileTarget(args: Record<string, unknown> | null): string {
  if (!args) return ''
  const raw = strOf(args.Path) || strOf(args.AbsolutePath) || strOf(args.TargetFile) || strOf(args.file_path) || strOf(args.path)
  return raw ? (basename(raw) || raw) : ''
}

const FILE_VERB_BY_TOOL: Readonly<Record<string, [string, string]>> = {
  read_file: ['阅读 ', '阅读文件'], view_file: ['阅读 ', '阅读文件'],
  write_file: ['写入 ', '写入文件'], write_to_file: ['写入 ', '写入文件'],
  edit_file: ['编辑 ', '编辑文件'], replace_file_content: ['编辑 ', '编辑文件'],
  multi_replace_file_content: ['编辑 ', '编辑文件'], sed_file: ['编辑 ', '编辑文件'],
}

const STATIC_LABEL_BY_TOOL: Readonly<Record<string, string>> = {
  run_command: '运行命令', oc_bash: '运行命令', grep_search: '检索代码', oc_grep: '检索代码',
  find_by_name: '浏览目录', list_dir: '浏览目录', oc_glob: '浏览目录',
  search_web: '联网检索', read_url_content: '抓取网页',
  post_message: '发送讨论消息', read_board: '查看讨论板', swarm_wait: '等待讨论板消息',
}

const SWARM_ACTION_LABEL: Readonly<Record<string, string>> = {
  add: '招募蜂群成员', status: '检查蜂群状态', kill: '回收蜂群成员',
}

export function describeToolActivity(toolName: string, args: Record<string, unknown> | null): string {
  const rawName = toolName.trim()
  const name = normalizeSwarmToolName(rawName)
  const fileVerb = FILE_VERB_BY_TOOL[name]
  if (fileVerb) {
    const target = shortFileTarget(args)
    return target ? `${fileVerb[0]}${target}` : fileVerb[1]
  }
  const staticLabel = STATIC_LABEL_BY_TOOL[name]
  if (staticLabel) return staticLabel
  if (name === 'swarm') return SWARM_ACTION_LABEL[args ? strOf(args.action) : ''] ?? '调度蜂群'
  if (rawName.startsWith('mcp_')) return `调用 ${rawName.split('_').slice(-1)[0] || rawName}`
  return name ? `执行 ${name}` : '处理中…'
}

export function settleSwarmSnapshotTerminal(snap: SwarmSnapshot, phase: SwarmPhase): SwarmSnapshot {
  const { postsMode: _pm, deltaBaseSeq: _dbs, ...clean } = structuredClone(snap)
  return {
    ...clean, phase, revision: snap.revision + 1, updatedAt: Date.now(),
    members: snap.members.map((m) => ({ ...m, status: m.status === 'killed' ? 'killed' : 'waiting' })),
  }
}

/** Concise one-line status text for the live turn_status working bar. */
export function formatSwarmWorkingDetail(snap: SwarmSnapshot): string {
  const working = snap.members.filter((m) => m.status === 'working' && m.role !== 'monitor' && m.role !== 'narrator').length
  const live = snap.members.filter((m) => m.status !== 'killed').length
  const parts: string[] = [`蜂群「${snap.title}」`, working > 0 ? `${working} 成员运行中` : `${live} 成员协作中`]
  if (snap.totalPosts > 0) parts.push(`${snap.totalPosts} 条讨论`)
  return parts.join(' · ')
}

export interface DurableSwarmBoardInput { swarmId: string; title: string; phase: SwarmPhase; snapshot: SwarmSnapshot }

export function compactSwarmSnapshotForPersistence(snap: SwarmSnapshot, maxBytes = 13_000): SwarmSnapshot {
  return structuredClone(compactSwarmSnapshotToByteBudget(snap, maxBytes))
}

export function buildDurableSwarmBoardInput(snap: SwarmSnapshot, maxBytes = 13_000): DurableSwarmBoardInput {
  const snapshot = compactSwarmSnapshotForPersistence(snap, maxBytes)
  return { swarmId: snapshot.swarmId, title: snapshot.title, phase: snapshot.phase, snapshot }
}

const BOARD_COORD_TOOLS = new Set(['swarm_wait', 'post_message', 'read_board'])

function plannerBatchHasSwarmWait(calls: readonly unknown[]): boolean {
  for (const raw of calls) {
    if (normTool(strOf(recOf(raw)?.name)) === 'swarm_wait') return true
  }
  return false
}

function recordUnsettledStep(
  cid: string, tname: string, b: BatchDoneTracker,
): void {
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
  if (tname && (b.unsettledAnonTools.get(tname) ?? 0) > 0) {
    b.unsettledAnonTools.set(tname, b.unsettledAnonTools.get(tname)! - 1)
    b.unsettledAnonCount -= 1
  } else if ((b.unsettledAnonTools.get('*') ?? 0) > 0) {
    b.unsettledAnonTools.set('*', b.unsettledAnonTools.get('*')! - 1)
    b.unsettledAnonCount -= 1
  }
  return true
}

interface BatchDoneTracker {
  readonly seenIds: Set<string>
  readonly unsettledIds: Set<string>
  readonly unsettledAnonTools: Map<string, number>
  unsettledAnonCount: number
  readonly seenIndices: Set<number>
  readonly seenPayloads: Set<string>
  doneCount: number
  explicitSwarmWaitDone: boolean
}

function createBatchDoneTracker(): BatchDoneTracker {
  return {
    seenIds: new Set(), unsettledIds: new Set(), unsettledAnonTools: new Map(), unsettledAnonCount: 0,
    seenIndices: new Set(), seenPayloads: new Set(), doneCount: 0, explicitSwarmWaitDone: false,
  }
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

function batchHasUnsettled(b: BatchDoneTracker): boolean {
  return b.unsettledIds.size > 0 || b.unsettledAnonCount > 0
}

interface TurnBoundaryState {
  hasSteps: boolean
  lastType: string
  lastSt: string
  lastToolName: string
  lastCallsLen: number
  hasPlanner: boolean
  lastPlannerSt: string
  lastPlannerHasWait: boolean
  lastPlannerCallsLen: number
  epoch: number
  readonly callState: CallReductionState
  batch: BatchDoneTracker
  cachedEnded: boolean | null
}

function createTurnBoundaryState(): TurnBoundaryState {
  return {
    hasSteps: false, lastType: '', lastSt: '', lastToolName: '', lastCallsLen: 0,
    hasPlanner: false, lastPlannerSt: '', lastPlannerHasWait: false, lastPlannerCallsLen: 0,
    epoch: 0, callState: createCallReductionState(), batch: createBatchDoneTracker(), cachedEnded: null,
  }
}

function ingestTurnBoundaryStep(
  t: TurnBoundaryState,
  step: Record<string, unknown>,
  stepType: string,
  bgTasks?: BackgroundTaskState,
): void {
  t.hasSteps = true
  t.cachedEnded = null
  t.lastType = stepType
  t.lastSt = strOf(step.status).toUpperCase()
  if (stepType === 'PLANNER_RESPONSE') {
    if (t.epoch > 0) settleCompletedEpoch(t.callState, t.epoch)
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

function isTurnEndedIncremental(t: TurnBoundaryState): boolean {
  if (!t.hasSteps) return false
  if (t.cachedEnded !== null) return t.cachedEnded
  let ended = false
  if (t.lastType === 'ERROR_MESSAGE') {
    ended = true
  } else if (t.lastType === 'PLANNER_RESPONSE') {
    ended = t.lastSt === 'DONE' && t.lastCallsLen === 0
  } else if (!t.hasPlanner) {
    ended =
      t.lastToolName === 'swarm_wait' &&
      t.lastSt === 'DONE' &&
      !batchHasUnsettled(t.batch) &&
      t.batch.explicitSwarmWaitDone &&
      !hasUnaccountedNonBoardToolSnapshot(t.callState)
  } else if (
    t.lastPlannerSt === 'DONE' &&
    t.lastPlannerHasWait &&
    !batchHasUnsettled(t.batch) &&
    (t.batch.explicitSwarmWaitDone || t.batch.doneCount >= t.lastPlannerCallsLen)
  ) {
    ended = !hasUnaccountedNonBoardToolSnapshot(t.callState)
  }
  t.cachedEnded = ended
  return ended
}

/**
 * Single-pass O(N) turn boundary locator: `USER_INPUT` always starts a new turn,
 * while `SYSTEM_MESSAGE` starts a new turn only after the preceding turn has
 * verifiably ended (never slicing or re-scanning prefixes on consecutive system messages).
 */
export function findTurnStartIndex(
  steps: readonly Record<string, unknown>[],
  bgTasks?: BackgroundTaskState,
): number {
  let turnStart = 0
  let tracker = createTurnBoundaryState()
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!
    const stepType = strOf(step.type).toUpperCase()
    if (stepType === 'USER_INPUT') {
      turnStart = i
      tracker = createTurnBoundaryState()
      ingestTurnBoundaryStep(tracker, step, stepType, bgTasks)
    } else if (stepType === 'SYSTEM_MESSAGE') {
      if (i > turnStart && isTurnEndedIncremental(tracker)) {
        turnStart = i
        tracker = createTurnBoundaryState()
        ingestTurnBoundaryStep(tracker, step, stepType, bgTasks)
      }
    } else {
      ingestTurnBoundaryStep(tracker, step, stepType, bgTasks)
    }
  }
  return turnStart
}

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

interface TrackedToolCall {
  readonly idx: number; name: string; readonly norm: string; id: string; readonly isBoard: boolean
  args: Record<string, unknown> | null; readonly fromPlanner: boolean; boundDirect: boolean; readonly epoch: number
}
interface TerminalToolStep { readonly id: string; readonly norm: string; readonly epoch: number }

interface ArgsBucket { readonly indices: number[]; head: number; second: number }
interface FallbackOverlay { readonly accounted: Set<number>; nonBoardCovered: number }

interface CallReductionState {
  readonly calls: TrackedToolCall[]; readonly callIndicesById: Map<string, number[]>
  readonly callsByEpoch: Map<number, number[]>; readonly callsByEpochNorm: Map<string, number[]>
  readonly unboundByEpochNormArgs: Map<string, ArgsBucket>
  readonly accounted: Set<number>; readonly unaccountedNonBoard: Set<number>
  readonly idMatchedEpochNorms: Set<string>; readonly plannerEpochNormCounts: Map<string, number>
  readonly plannerEpochCallCounts: Map<number, number>; readonly genericTerminalsByEpoch: Map<number, number>
  readonly namedFallbacksByEpoch: Map<number, TerminalToolStep[]>; readonly seenUnidNamedEpochNorms: Set<string>
  nonBoardNamedFallbackCount: number
  readonly pendingIdFallbacks: Map<string, TerminalToolStep>; readonly speculativeIdOwners: Map<string, number>
  readonly backupSpeculativeNamedByIdx: Map<number, TerminalToolStep[]>; readonly exactIdSettled: Set<string>
  readonly seenTerminalIds: Set<string>; readonly seenStepIndices: Set<number>; readonly seenUnindexedPayloads: Set<string>
}

function createCallReductionState(): CallReductionState {
  return {
    calls: [], callIndicesById: new Map(), callsByEpoch: new Map(), callsByEpochNorm: new Map(),
    unboundByEpochNormArgs: new Map(), accounted: new Set(), unaccountedNonBoard: new Set(),
    idMatchedEpochNorms: new Set(), plannerEpochNormCounts: new Map(), plannerEpochCallCounts: new Map(),
    genericTerminalsByEpoch: new Map(), namedFallbacksByEpoch: new Map(), seenUnidNamedEpochNorms: new Set(),
    nonBoardNamedFallbackCount: 0, pendingIdFallbacks: new Map(), speculativeIdOwners: new Map(),
    backupSpeculativeNamedByIdx: new Map(), exactIdSettled: new Set(),
    seenTerminalIds: new Set(), seenStepIndices: new Set(), seenUnindexedPayloads: new Set(),
  }
}

function pushBucketIndex<K, V = number>(map: Map<K, V[]>, key: K, item: V): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(item)
  else map.set(key, [item])
}

function pushArgsBucket(state: CallReductionState, key: string, idx: number): void {
  turnReductionBucketWritesForTests += 1
  const bucket = state.unboundByEpochNormArgs.get(key)
  if (bucket) bucket.indices.push(idx)
  else state.unboundByEpochNormArgs.set(key, { indices: [idx], head: 0, second: 1 })
}

function pushNamedFallback(state: CallReductionState, epoch: number, term: TerminalToolStep): void {
  if (!term.id) {
    const key = `${epoch}:${term.norm}`
    if (state.seenUnidNamedEpochNorms.has(key)) return
    state.seenUnidNamedEpochNorms.add(key)
  }
  pushBucketIndex(state.namedFallbacksByEpoch, epoch, term)
  if (!BOARD_COORD_TOOLS.has(term.norm)) state.nonBoardNamedFallbackCount += 1
}

function indexCallId(state: CallReductionState, id: string, idx: number): void {
  if (id) pushBucketIndex(state.callIndicesById, id, idx)
}

function markCallAccounted(state: CallReductionState, idx: number): void {
  state.accounted.add(idx)
  state.unaccountedNonBoard.delete(idx)
}

function unmarkCallAccounted(state: CallReductionState, idx: number): void {
  state.accounted.delete(idx)
  const c = state.calls[idx]
  if (c && !c.isBoard) state.unaccountedNonBoard.add(idx)
}

function isCallAccounted(state: CallReductionState, overlay: FallbackOverlay | null, idx: number): boolean {
  return state.accounted.has(idx) || (overlay?.accounted.has(idx) ?? false)
}

function recordFallbackMatch(state: CallReductionState, overlay: FallbackOverlay | null, idx: number): void {
  if (!overlay) {
    markCallAccounted(state, idx)
    return
  }
  if (overlay.accounted.has(idx)) return
  overlay.accounted.add(idx)
  if (!state.calls[idx]!.isBoard) overlay.nonBoardCovered += 1
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
  turnReductionIdLookupsForTests += 1
  const pending = state.pendingIdFallbacks.get(id)
  if (pending) {
    state.pendingIdFallbacks.delete(id)
    state.exactIdSettled.add(id)
    markCallAccounted(state, idx)
    state.idMatchedEpochNorms.add(`${epoch}:${norm}`)
    return
  }
  const prevIdx = state.speculativeIdOwners.get(id)
  if (prevIdx !== undefined) {
    state.speculativeIdOwners.delete(id)
    state.exactIdSettled.add(id)
    if (prevIdx !== idx) releaseSpeculativeOwner(state, prevIdx)
    markCallAccounted(state, idx)
    state.idMatchedEpochNorms.add(`${epoch}:${norm}`)
  }
}

function findUnaccountedIndexById(
  state: CallReductionState, id: string, overlay: FallbackOverlay | null = null,
): number {
  turnReductionIdLookupsForTests += 1
  const bucket = state.callIndicesById.get(id)
  if (!bucket) return -1
  for (const idx of bucket) {
    if (!isCallAccounted(state, overlay, idx)) return idx
  }
  return -1
}

function isUnboundPlannerCandidate(state: CallReductionState, idx: number): boolean {
  const c = state.calls[idx]!
  return !state.accounted.has(idx) && c.fromPlanner && !c.id && !c.boundDirect
}

function findUnboundPlannerCallByEpochNorm(
  state: CallReductionState, epoch: number, norm: string, requireNoId: boolean,
): TrackedToolCall | null {
  const bucket = state.callsByEpochNorm.get(`${epoch}:${norm}`)
  if (!bucket || bucket.length === 0) return null
  turnReductionCandidateVisitsForTests += 1
  const idx = bucket[0]!
  const c = state.calls[idx]!
  return !state.accounted.has(idx) && c.fromPlanner && !c.boundDirect && (!requireNoId || !c.id) ? c : null
}

function findUniqueArgsMatchedUnboundPlannerCall(
  state: CallReductionState, epoch: number, norm: string, args: Record<string, unknown> | null,
): TrackedToolCall | null {
  if (!args) return null
  const bucket = state.unboundByEpochNormArgs.get(`${epoch}:${norm}:${JSON.stringify(args)}`)
  if (!bucket) return null
  const { indices } = bucket
  while (bucket.head < indices.length) {
    turnReductionCandidateVisitsForTests += 1
    if (isUnboundPlannerCandidate(state, indices[bucket.head]!)) break
    bucket.head += 1
  }
  if (bucket.head >= indices.length) return null
  if (bucket.second <= bucket.head) bucket.second = bucket.head + 1
  while (bucket.second < indices.length) {
    turnReductionCandidateVisitsForTests += 1
    if (isUnboundPlannerCandidate(state, indices[bucket.second]!)) return null
    bucket.second += 1
  }
  return state.calls[indices[bucket.head]!]!
}

function bindIdDirectCall(
  state: CallReductionState, norm: string, id: string, args: Record<string, unknown> | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): boolean {
  const existingIdx = state.callIndicesById.get(id)?.[0]
  if (existingIdx !== undefined) {
    const existing = state.calls[existingIdx]!
    if (!existing.args && args) existing.args = args
    existing.boundDirect = true
    return true
  }
  if (fromPlanner || !hasPlannerRoot) return false
  const epochNormTotal = state.plannerEpochNormCounts.get(`${epoch}:${norm}`) ?? 0
  const unbound = epochNormTotal === 1
    ? findUnboundPlannerCallByEpochNorm(state, epoch, norm, true)
    : findUniqueArgsMatchedUnboundPlannerCall(state, epoch, norm, args)
  if (!unbound) return false
  unbound.id = id
  indexCallId(state, id, unbound.idx)
  unbound.boundDirect = true
  if (!unbound.args && args) unbound.args = args
  claimTerminalIdForCall(state, unbound.idx, id, norm, unbound.epoch)
  return true
}

function bindUnidDirectCall(
  state: CallReductionState, norm: string, args: Record<string, unknown> | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): boolean {
  if (fromPlanner || !hasPlannerRoot) return false
  const epochNormTotal = state.plannerEpochNormCounts.get(`${epoch}:${norm}`) ?? 0
  const unbound = epochNormTotal === 1
    ? findUnboundPlannerCallByEpochNorm(state, epoch, norm, false)
    : findUniqueArgsMatchedUnboundPlannerCall(state, epoch, norm, args)
  if (!unbound) return false
  unbound.boundDirect = true
  if (!unbound.args && args) unbound.args = args
  return true
}

function bindExistingOrPlannerCall(
  state: CallReductionState, norm: string, id: string, args: Record<string, unknown> | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): boolean {
  if (id) return bindIdDirectCall(state, norm, id, args, fromPlanner, hasPlannerRoot, epoch)
  return bindUnidDirectCall(state, norm, args, fromPlanner, hasPlannerRoot, epoch)
}

function registerTrackedCallStart(
  state: CallReductionState, rawName: string, id: string, args: Record<string, unknown> | null,
  fromPlanner: boolean, hasPlannerRoot: boolean, epoch: number,
): void {
  const norm = normTool(rawName)
  if (!norm) return
  if (bindExistingOrPlannerCall(state, norm, id, args, fromPlanner, hasPlannerRoot, epoch)) return
  const idx = state.calls.length
  const isBoard = BOARD_COORD_TOOLS.has(norm)
  state.calls.push({ idx, name: rawName, norm, id, isBoard, args, fromPlanner, boundDirect: !fromPlanner, epoch })
  indexCallId(state, id, idx)
  pushBucketIndex(state.callsByEpoch, epoch, idx)
  pushBucketIndex(state.callsByEpochNorm, `${epoch}:${norm}`, idx)
  if (fromPlanner && !id && args !== null) pushArgsBucket(state, `${epoch}:${norm}:${JSON.stringify(args)}`, idx)
  if (!isBoard) state.unaccountedNonBoard.add(idx)
  if (id) claimTerminalIdForCall(state, idx, id, norm, epoch)
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
    if (validPlannerCount > 0) {
      state.plannerEpochCallCounts.set(epoch, (state.plannerEpochCallCounts.get(epoch) ?? 0) + validPlannerCount)
    }
  }
  for (const raw of rawCalls) {
    const obj = recOf(raw)
    if (!obj) continue
    registerTrackedCallStart(state, strOf(obj.name || obj.tool_name), stepCallId(obj), recOf(obj.arguments ?? obj.args), fromPlanner, hasPlannerRoot, epoch)
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
      markCallAccounted(state, idx)
      state.exactIdSettled.add(cid)
      state.idMatchedEpochNorms.add(`${matched.epoch}:${matched.norm}`)
      return
    }
    const term: TerminalToolStep = { id: cid, norm: tname, epoch }
    state.pendingIdFallbacks.set(cid, term)
    if (tname) pushNamedFallback(state, epoch, term)
    return
  }
  if (tname) pushNamedFallback(state, epoch, { id: '', norm: tname, epoch })
}

function findUnambiguousNameFallbackIndex(
  state: CallReductionState, overlay: FallbackOverlay | null, term: TerminalToolStep,
): number {
  const key = `${term.epoch}:${term.norm}`
  if (state.idMatchedEpochNorms.has(key)) return -1
  const bucket = state.callsByEpochNorm.get(key)
  if (!bucket || bucket.length !== 1) return -1
  turnReductionCandidateVisitsForTests += 1
  const idx = bucket[0]!
  const c = state.calls[idx]!
  if (isCallAccounted(state, overlay, idx) || (term.id && c.id)) return -1
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

function resolveGenericEpochForOne(
  state: CallReductionState, epoch: number, genericCount: number, overlay: FallbackOverlay | null,
): void {
  const bucket = state.callsByEpoch.get(epoch)
  if (!bucket || bucket.length === 0) return
  const retirableTargets: number[] = []
  for (const idx of bucket) {
    turnReductionCandidateVisitsForTests += 1
    const c = state.calls[idx]!
    if (c.fromPlanner && !c.id && !c.boundDirect && !isCallAccounted(state, overlay, idx)) retirableTargets.push(idx)
  }
  const possibleAnonymousSources = Math.max(bucket.length, state.plannerEpochCallCounts.get(epoch) ?? 0)
  if (retirableTargets.length > 0 && genericCount >= possibleAnonymousSources) {
    for (const idx of retirableTargets) recordFallbackMatch(state, overlay, idx)
  }
}

function settleCompletedEpoch(state: CallReductionState, epoch: number): void {
  const named = state.namedFallbacksByEpoch.get(epoch)
  const deferredIdNamed: TerminalToolStep[] = []
  if (named) {
    for (const term of named) {
      if (!BOARD_COORD_TOOLS.has(term.norm)) state.nonBoardNamedFallbackCount -= 1
      if (term.id) {
        deferredIdNamed.push(term)
        continue
      }
      const idx = findUnambiguousNameFallbackIndex(state, null, term)
      if (idx >= 0) markCallAccounted(state, idx)
    }
    state.namedFallbacksByEpoch.delete(epoch)
  }
  const genericCount = state.genericTerminalsByEpoch.get(epoch)
  if (genericCount !== undefined) {
    resolveGenericEpochForOne(state, epoch, genericCount, null)
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
    const idx = findUnambiguousNameFallbackIndex(state, null, term)
    if (idx >= 0) {
      markCallAccounted(state, idx)
      state.pendingIdFallbacks.delete(term.id)
      state.speculativeIdOwners.set(term.id, idx)
      speculativeIdxByNorm.set(term.norm, idx)
    }
  }
}

function resolveFallbackTerminals(state: CallReductionState, overlay: FallbackOverlay | null = null): void {
  const nonBoardOnly = overlay !== null
  const deferredIdNamed: TerminalToolStep[] = []
  for (const list of state.namedFallbacksByEpoch.values()) {
    for (const term of list) {
      if (nonBoardOnly && BOARD_COORD_TOOLS.has(term.norm)) continue
      if (term.id) {
        deferredIdNamed.push(term)
        continue
      }
      const fallbackIdx = findUnambiguousNameFallbackIndex(state, overlay, term)
      if (fallbackIdx >= 0) recordFallbackMatch(state, overlay, fallbackIdx)
    }
  }
  for (const [epoch, genericCount] of state.genericTerminalsByEpoch.entries()) {
    resolveGenericEpochForOne(state, epoch, genericCount, overlay)
  }
  const usedIds = deferredIdNamed.length > 0 ? new Set<string>() : null
  for (const term of deferredIdNamed) {
    if (usedIds!.has(term.id) || state.exactIdSettled.has(term.id) || !state.pendingIdFallbacks.has(term.id)) continue
    const fallbackIdx = findUnambiguousNameFallbackIndex(state, overlay, term)
    if (fallbackIdx >= 0) {
      recordFallbackMatch(state, overlay, fallbackIdx)
      usedIds!.add(term.id)
    }
  }
}

function hasUnaccountedNonBoardToolSnapshot(state: CallReductionState): boolean {
  if (state.unaccountedNonBoard.size === 0) return false
  if (state.nonBoardNamedFallbackCount === 0 && state.genericTerminalsByEpoch.size === 0) return true
  const overlay: FallbackOverlay = { accounted: new Set(), nonBoardCovered: 0 }
  resolveFallbackTerminals(state, overlay)
  return overlay.nonBoardCovered < state.unaccountedNonBoard.size
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
      if (epoch > 0) settleCompletedEpoch(state, epoch)
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
