/**
 * Read-only live watcher for Antigravity CLI 1.5.8+ native swarm directories (OCV5-809).
 *
 * Official CLI on-disk layout under `<appData>/brain/`:
 *   - `<coordinatorConv>/.system_generated/swarm/members.json`
 *   - `<coordinatorConv>/.system_generated/swarm/board.jsonl`
 *   - `<memberConv>/.system_generated/logs/transcript.jsonl`
 *
 * Security & resource bounds:
 *   - Strictly read-only, bounded file reads (`O_NOFOLLOW`), tail-only transcript reads (64 KB).
 *   - Caps members/channels/posts/post-length before emitting to wire.
 *   - Deduplicates unchanged snapshots by deterministic fingerprint.
 *   - Timer is `.unref()`'d and unconditionally cleared on `stop()`.
 */
import { createHash } from 'node:crypto'
import {
  SWARM_MAX_CHANNELS,
  SWARM_MAX_MEMBERS,
  SWARM_MAX_POSTS,
  SWARM_MAX_POST_CHARS,
  extractSwarmMentions,
  type SwarmBoardPost,
  type SwarmChannelSnapshot,
  type SwarmMemberRole,
  type SwarmMemberSnapshot,
  type SwarmMemberStatus,
  type SwarmPhase,
  type SwarmSnapshot,
} from '@openclaude/protocol'
import {
  analyzeBackgroundTasksInSteps,
  buildDurableSwarmBoardInput,
  compactSwarmSnapshotForPersistence,
  createBackgroundTaskState,
  describeToolActivity,
  findActiveNonBoardToolInTurn,
  findTurnStartIndex,
  formatSwarmWorkingDetail,
  mergeBackgroundTaskStates,
  normalizeSwarmToolName,
  settleSwarmSnapshotTerminal,
  type BackgroundTaskTelemetrySummary,
  type DurableSwarmBoardInput,
} from './antigravitySwarmFormat.js'
import {
  CONVERSATION_ID_RE,
  IncrementalTranscriptTelemetryCache,
  extractStepTelemetry,
  getSwarmRealRootResolveCount,
  readBoundedFileWithinRoot,
  readBoundedFileWithinRootAsync,
  recordOf,
  resetSwarmRealRootCache,
  statSignatureWithinRoot,
  statSignatureWithinRootAsync,
  type MemberTelemetrySnapshot,
} from './antigravitySwarmTelemetry.js'
import {
  SwarmStallMonitor,
  type SwarmStallAlert,
  type SwarmStallExhaustion,
  type SwarmStallMonitorOptions,
} from './swarmStallMonitor.js'

export {
  IncrementalTranscriptTelemetryCache,
  extractStepTelemetry,
  getSwarmRealRootResolveCount,
  resetSwarmRealRootCache,
  type MemberTelemetrySnapshot,
}

const MAX_MEMBERS_JSON_BYTES = 512 * 1024
const MAX_BOARD_JSONL_BYTES = 2 * 1024 * 1024
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
const TRANSCRIPT_TAIL_ADAPTIVE_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_POLL_MS = 750
/** Minimum interval between activity-only (`stepCount`/`activity`/`unreadCount`) emissions.
 * Structural changes (new posts, member status/role/error changes, channels, terminal phase)
 * still emit with 0ms delay (OCV5-819). */
export const SWARM_ACTIVITY_THROTTLE_MS = 2_500
/** Force a periodic full-posts keyframe when new posts accumulated since the last full frame
 *  so partial replays self-heal without bloating live_frames on activity-only churn (OCV5-837). */
export const SWARM_FULL_KEYFRAME_INTERVAL_EMITS = 120
export const SWARM_FULL_KEYFRAME_INTERVAL_MS = 300_000

interface RawRosterMember {
  conversation_id?: unknown; model?: unknown; role?: unknown; phase?: unknown
  wake_mode?: unknown; wait_since?: unknown; last_read_seq?: unknown; killed?: unknown
  channels?: unknown; workspace?: unknown; workspace_mode?: unknown; desired_state?: unknown
  desired_model?: unknown; applied_model?: unknown; last_nudged_seq?: unknown
  last_park_blocked_seq?: unknown; added_by?: unknown; runtime?: unknown
}

interface RawRoster { title?: unknown; runtime?: unknown; members?: unknown; channels?: unknown }

interface TranscriptSummary {
  stepCount: number
  status: SwarmMemberStatus | null
  activity?: string
  waitingOnBoard?: boolean
  hasActiveNonWaitTool?: boolean
  incompleteBgEvidence?: boolean
  failed?: boolean
  lastError?: string
  firstStepAt?: number
  lastActiveAt?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  toolCalls: number
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function inferRole(name: string, rawRole: unknown): SwarmMemberRole {
  const roleStr = asStr(rawRole).toLowerCase()
  const lowerName = name.toLowerCase()
  if (roleStr === 'coordinator' || lowerName === 'coordinator') return 'coordinator'
  if (roleStr === 'narrator' || /^narrator(?:-\d+)?$/.test(lowerName)) return 'narrator'
  if (roleStr === 'monitor' || /^monitor(?:-\d+)?$/.test(lowerName)) return 'monitor'
  if (roleStr === 'verifier' || /verif|review|audit|qa|test/.test(lowerName)) return 'verifier'
  return 'worker'
}

export { normalizeSwarmToolName }

function hasSwarmWaitCall(calls: readonly unknown[]): boolean {
  return calls.some((c) => normalizeSwarmToolName(asStr(recordOf(c)?.name)).toLowerCase() === 'swarm_wait')
}

function findLastPlannerInTurn(turnSteps: readonly Record<string, unknown>[]): {
  lastPlanner: Record<string, unknown> | null
  lastPlannerIdx: number
  lastPlannerCalls: unknown[]
} {
  for (let i = turnSteps.length - 1; i >= 0; i -= 1) {
    const step = turnSteps[i]!
    if (asStr(step.type).toUpperCase() === 'PLANNER_RESPONSE') {
      return {
        lastPlanner: step,
        lastPlannerIdx: i,
        lastPlannerCalls: Array.isArray(step.tool_calls) ? step.tool_calls : [],
      }
    }
  }
  return { lastPlanner: null, lastPlannerIdx: -1, lastPlannerCalls: [] }
}

function buildErrorTranscriptSummary(
  telBase: Omit<TranscriptSummary, 'stepCount' | 'status'>,
  maxStepIndex: number,
  last: Record<string, unknown>,
): TranscriptSummary {
  return {
    ...telBase,
    stepCount: maxStepIndex,
    status: 'waiting',
    activity: '步骤异常',
    failed: true,
    lastError: clampText(asStr(last.content) || asStr(last.error) || '执行出错', 160),
  }
}

function summarizeEmptyTranscriptTail(opts?: { incBgTasks?: BackgroundTaskTelemetrySummary; tailTruncated?: boolean }): TranscriptSummary {
  const mergedBg = mergeBackgroundTaskStates(createBackgroundTaskState(), opts?.incBgTasks, { tailTruncated: opts?.tailTruncated })
  const base: TranscriptSummary = {
    stepCount: 0, status: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, toolCalls: 0,
    ...(mergedBg.incompleteEvidence ? { incompleteBgEvidence: true } : {}),
  }
  return mergedBg.activeIds.size > 0 || mergedBg.overflowed
    ? { ...base, status: 'working', activity: '后台运行命令', waitingOnBoard: false, hasActiveNonWaitTool: true }
    : base
}

/**
 * Inspect a member's compact `transcript.jsonl` tail to determine its live
 * status, step count, current activity, error state, and lightweight telemetry
 * (mirrors Antigravity CLI `board.StateOf`).
 */
export function parseMemberTranscriptTail(
  text: string | null,
  opts?: { incBgTasks?: BackgroundTaskTelemetrySummary; incPartial?: boolean; tailTruncated?: boolean },
): TranscriptSummary {
  if (!text) return summarizeEmptyTranscriptTail(opts)
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return summarizeEmptyTranscriptTail(opts)

  const steps: Array<Record<string, unknown>> = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown
      const obj = recordOf(parsed)
      if (obj) steps.push(obj)
    } catch {
      // Ignore partial trailing line while CLI is appending.
    }
  }
  if (steps.length === 0) return summarizeEmptyTranscriptTail(opts)

  let maxStepIndex = steps.length
  let firstStepAt: number | undefined
  let lastActiveAt: number | undefined
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let thinkingTokens = 0
  let toolCalls = 0
  for (const step of steps) {
    if (typeof step.step_index === 'number' && Number.isFinite(step.step_index)) {
      maxStepIndex = Math.max(maxStepIndex, Math.floor(step.step_index) + 1)
    }
    const tel = extractStepTelemetry(step)
    if (tel.ts !== undefined) {
      if (firstStepAt === undefined || tel.ts < firstStepAt) firstStepAt = tel.ts
      if (lastActiveAt === undefined || tel.ts > lastActiveAt) lastActiveAt = tel.ts
    }
    inputTokens += tel.inputTokens
    outputTokens += tel.outputTokens
    cacheReadTokens += tel.cacheReadTokens
    thinkingTokens += tel.thinkingTokens
    toolCalls += tel.toolCalls
  }
  const bgTasks = analyzeBackgroundTasksInSteps(steps, { truncatedStart: opts?.tailTruncated })
  const mergedBg = mergeBackgroundTaskStates(bgTasks, opts?.incBgTasks, {
    tailTruncated: opts?.tailTruncated,
  })
  const telBase: Omit<TranscriptSummary, 'stepCount' | 'status'> = {
    ...(firstStepAt !== undefined ? { firstStepAt } : {}),
    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingTokens,
    toolCalls,
    ...(mergedBg.incompleteEvidence ? { incompleteBgEvidence: true } : {}),
  }
  const turnStart = findTurnStartIndex(steps, bgTasks)
  const turnSteps = steps.slice(turnStart)
  const last = turnSteps[turnSteps.length - 1]!
  const lastType = asStr(last.type).toUpperCase()
  const lastStatus = asStr(last.status).toUpperCase()

  if (lastType === 'ERROR_MESSAGE') return buildErrorTranscriptSummary(telBase, maxStepIndex, last)

  const { lastPlanner, lastPlannerIdx, lastPlannerCalls } = findLastPlannerInTurn(turnSteps)
  const activeNonBoardTool = findActiveNonBoardToolInTurn(turnSteps, lastPlannerIdx, lastPlannerCalls, bgTasks)
  if (activeNonBoardTool) {
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: describeToolActivity(activeNonBoardTool.name, activeNonBoardTool.args),
      waitingOnBoard: false,
      hasActiveNonWaitTool: true,
    }
  }
  if (mergedBg.activeIds.size > 0 || mergedBg.overflowed) {
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: '后台运行命令',
      waitingOnBoard: false,
      hasActiveNonWaitTool: true,
    }
  }

  if (lastStatus === 'ERROR') return buildErrorTranscriptSummary(telBase, maxStepIndex, last)

  if (lastType === 'PLANNER_RESPONSE') {
    const calls = Array.isArray(last.tool_calls) ? last.tool_calls : []
    if (lastStatus === 'DONE' && calls.length === 0) {
      return {
        ...telBase,
        stepCount: maxStepIndex,
        status: 'waiting',
        activity: '已完成本轮思考',
        waitingOnBoard: true,
      }
    }
    if (calls.length > 0) {
      if (hasSwarmWaitCall(calls)) {
        return {
          ...telBase,
          stepCount: maxStepIndex,
          status: 'waiting',
          activity: '等待讨论板消息',
          waitingOnBoard: true,
        }
      }
      const lastCall = recordOf(calls[calls.length - 1])
      const callName = asStr(lastCall?.name)
      const callArgs = recordOf(lastCall?.arguments ?? lastCall?.args)
      return {
        ...telBase,
        stepCount: maxStepIndex,
        status: 'working',
        activity: describeToolActivity(callName, callArgs),
      }
    }
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: '思考与规划中…',
    }
  }

  // Check if a tool batch ended with `swarm_wait` DONE (member parked itself).
  // Handles both explicit tool steps (`tool_name`/`name`) and native CLI 1.5.8 `GENERIC`
  // tool results whose planner batch included `swarm_wait` in any position (e.g. `[swarm_wait, post_message]`).
  const isSwarmWaitDone =
    turnSteps.slice(-6).some((step) => {
      const name = normalizeSwarmToolName(asStr(step.tool_name || step.name)).toLowerCase()
      const st = asStr(step.status).toUpperCase()
      return name === 'swarm_wait' && st === 'DONE'
    }) ||
    (lastPlannerCalls.length > 0 && hasSwarmWaitCall(lastPlannerCalls))
  if (isSwarmWaitDone && lastStatus === 'DONE') {
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'waiting',
      activity: '等待讨论板消息',
      waitingOnBoard: true,
    }
  }

  // Otherwise inspect the active tool or latest planner call (handles both native
  // tool steps and RemoteSwarm `TOOL_CALL` records that store `tool_calls[]`).
  const directTool = asStr(last.tool_name || last.name)
  if (directTool) {
    const isSwarmWait = normalizeSwarmToolName(directTool).toLowerCase() === 'swarm_wait'
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: isSwarmWait ? 'waiting' : 'working',
      activity: describeToolActivity(directTool, recordOf(last.arguments ?? last.args)),
      ...(isSwarmWait ? { waitingOnBoard: true } : {}),
    }
  }
  if ((lastType === 'TOOL_CALL' || lastType === 'TOOL_USE') && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    if (hasSwarmWaitCall(last.tool_calls)) {
      return {
        ...telBase,
        stepCount: maxStepIndex,
        status: 'waiting',
        activity: '等待讨论板消息',
        waitingOnBoard: true,
      }
    }
    const latestToolCall = recordOf(last.tool_calls[last.tool_calls.length - 1])
    const toolName = asStr(latestToolCall?.name)
    const toolArgs = recordOf(latestToolCall?.arguments ?? latestToolCall?.args)
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: describeToolActivity(toolName, toolArgs),
    }
  }
  if (lastPlannerCalls.length > 0) {
    if (hasSwarmWaitCall(lastPlannerCalls)) {
      return {
        ...telBase,
        stepCount: maxStepIndex,
        status: lastStatus === 'DONE' ? 'waiting' : 'working',
        activity: '等待讨论板消息',
        waitingOnBoard: true,
      }
    }
    const latestCall = recordOf(lastPlannerCalls[lastPlannerCalls.length - 1])
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: describeToolActivity(asStr(latestCall?.name), recordOf(latestCall?.arguments ?? latestCall?.args)),
    }
  }
  const isTurnStartStep = lastType === 'USER_INPUT' || lastType === 'SYSTEM_MESSAGE'
  const firstTailType = asStr(steps[0]?.type).toUpperCase()
  const tailTruncatedMidTurn =
    turnStart === 0 && firstTailType !== 'USER_INPUT' && firstTailType !== 'SYSTEM_MESSAGE'
  if (tailTruncatedMidTurn && lastPlanner === null && lastType === 'GENERIC') {
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: '处理工具结果…',
    }
  }
  return {
    ...telBase,
    stepCount: maxStepIndex,
    status: isTurnStartStep ? 'working' : 'waiting',
    activity: isTurnStartStep ? '启动处理中…' : '待命中',
  }
}

function parseChannelsMeta(raw: unknown): Map<string, { topic?: string; archived?: boolean }> {
  const map = new Map<string, { topic?: string; archived?: boolean }>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const obj = recordOf(item)
      const name = asStr(obj?.name)
      if (!name) continue
      map.set(name, {
        ...(asStr(obj?.topic) ? { topic: asStr(obj?.topic) } : {}),
        ...(obj?.archived === true ? { archived: true } : {}),
      })
    }
    return map
  }
  const obj = recordOf(raw)
  if (obj) {
    for (const [name, val] of Object.entries(obj)) {
      const v = recordOf(val)
      if (!name.trim()) continue
      map.set(name.trim(), {
        ...(asStr(v?.topic) ? { topic: asStr(v?.topic) } : {}),
        ...(v?.archived === true ? { archived: true } : {}),
      })
    }
  }
  return map
}

function sanitizeWorkspacePath(rawPath: string): string | undefined {
  const trimmed = rawPath.trim().replace(/\\/g, '/')
  if (!trimmed) return undefined
  const wtMarker = '.oc-swarm-worktrees/'
  const wtIdx = trimmed.indexOf(wtMarker)
  if (wtIdx >= 0) {
    const rel = trimmed.slice(wtIdx).replace(/\/+$/, '')
    const parts = rel.split('/').filter((p) => p && p !== '.' && p !== '..')
    return parts.length > 0 ? clampText(parts.join('/'), 80) : undefined
  }
  const isAbs = trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)
  const parts = trimmed
    .replace(/^[A-Za-z]:/, '')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
  if (parts.length === 0) return undefined
  if (!isAbs) return clampText(parts.join('/'), 80)
  const tail = parts.slice(-2).join('/')
  return clampText(parts.length > 2 ? `…/${tail}` : tail, 80)
}

function parseMemberWorkspace(m: RawRosterMember): {
  workspace?: string
  workspaceBranch?: string
  workspacePath?: string
} {
  const wsObj = recordOf(m.workspace)
  if (wsObj) {
    const mode = asStr(wsObj.mode) || asStr(m.workspace_mode) || undefined
    const branch = asStr(wsObj.branch) || undefined
    const wsPath = sanitizeWorkspacePath(asStr(wsObj.path))
    return {
      ...(mode ? { workspace: mode } : {}),
      ...(branch ? { workspaceBranch: clampText(branch, 64) } : {}),
      ...(wsPath ? { workspacePath: wsPath } : {}),
    }
  }
  const rawMode = asStr(m.workspace_mode)
  const rawWs = asStr(m.workspace)
  if (rawMode) {
    const wsPath = rawWs && rawWs !== rawMode ? sanitizeWorkspacePath(rawWs) : undefined
    return {
      workspace: rawMode,
      ...(wsPath ? { workspacePath: wsPath } : {}),
    }
  }
  return rawWs ? { workspace: rawWs } : {}
}

/**
 * Distinguish RemoteSwarm rosters from native Antigravity CLI 1.5.8+ rosters.
 *
 * Native CLI 1.5.8 keeps `phase: "RUNNING"` even while a member is asleep in
 * `swarm_wait`, encoding working vs sleeping in `wake_mode` (`"working"` vs
 * `"mentions"` / `"all"`). RemoteSwarm authoritatively tracks active turns in
 * `phase: "RUNNING" | "WAITING" | "STOPPED" | "KILLED"` while leaving
 * `wake_mode` as `"mentions"` / `"all"`.
 */
function isRemoteSwarmRoster(roster: RawRoster, rawMembersObj: Record<string, unknown>): boolean {
  const explicitRuntime = asStr(roster.runtime).toLowerCase()
  if (explicitRuntime === 'remote') return true
  if (explicitRuntime === 'native') return false

  let hasNativeField = false
  let hasRemoteField = false
  for (const rawVal of Object.values(rawMembersObj)) {
    const m = recordOf(rawVal) as RawRosterMember | null
    if (!m) continue
    const memberRuntime = asStr(m.runtime).toLowerCase()
    if (memberRuntime === 'remote') return true
    if (memberRuntime === 'native') return false
    if (
      m.desired_state !== undefined ||
      m.desired_model !== undefined ||
      m.applied_model !== undefined ||
      m.workspace_mode !== undefined ||
      m.last_nudged_seq !== undefined ||
      m.last_park_blocked_seq !== undefined ||
      asStr(m.wake_mode).toLowerCase() === 'working'
    ) {
      hasNativeField = true
    }
    const rawPhase = asStr(m.phase).toUpperCase()
    if (
      rawPhase === 'WAITING' ||
      rawPhase === 'STOPPED' ||
      m.added_by !== undefined ||
      recordOf(m.workspace) !== null
    ) {
      hasRemoteField = true
    }
  }
  if (hasNativeField) return false
  return hasRemoteField
}

function parseBoardPosts(text: string | null): {
  posts: SwarmBoardPost[]
  totalPosts: number
  headSeq: number
  lastPostByAgent: Map<string, number>
  postCountByChannel: Map<string, number>
} {
  const lastPostByAgent = new Map<string, number>()
  const postCountByChannel = new Map<string, number>()
  if (!text) return { posts: [], totalPosts: 0, headSeq: 0, lastPostByAgent, postCountByChannel }
  const all: SwarmBoardPost[] = []
  let headSeq = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = recordOf(JSON.parse(trimmed))
      if (!obj) continue
      const seq = asNonNegInt(obj.seq) || all.length + 1
      const agent = asStr(obj.agent) || 'unknown'
      const rawText = typeof obj.text === 'string' ? obj.text : ''
      const time = asStr(obj.time) || undefined
      const channel = asStr(obj.channel) || 'main'
      headSeq = Math.max(headSeq, seq)
      // Aggregate full-board per-agent lastPostSeq & per-channel postCount BEFORE tail slicing
      // so boards longer than SWARM_MAX_POSTS (120) never lose older members' lastPostSeq.
      const agentKey = agent.toLowerCase()
      const prevSeq = lastPostByAgent.get(agentKey)
      if (prevSeq === undefined || seq > prevSeq) {
        lastPostByAgent.set(agentKey, seq)
      }
      postCountByChannel.set(channel, (postCountByChannel.get(channel) ?? 0) + 1)
      all.push({
        seq,
        agent,
        text: clampText(rawText, SWARM_MAX_POST_CHARS),
        ...(time ? { time } : {}),
        channel,
        mentions: extractSwarmMentions(rawText),
      })
    } catch {
      // Torn final JSONL line will be parsed on next poll tick.
    }
  }
  const totalPosts = Math.max(all.length, headSeq)
  const posts = all.length > SWARM_MAX_POSTS ? all.slice(all.length - SWARM_MAX_POSTS) : all
  return { posts, totalPosts, headSeq, lastPostByAgent, postCountByChannel }
}

interface LoadedMemberData {
  name: string
  member: RawRosterMember
  transcriptText: string | null
  tailTruncated?: boolean
  incTelemetry: MemberTelemetrySnapshot | null
}

function resolveActiveMemberStatus(
  remoteRoster: boolean,
  rawPhase: string,
  wakeMode: string | undefined,
  wakeModeLower: string | undefined,
  transcript: TranscriptSummary,
): SwarmMemberStatus {
  const defaultStatus: SwarmMemberStatus = wakeMode ? 'waiting' : 'working'
  if (remoteRoster) {
    if (rawPhase === 'RUNNING') return transcript.failed ? 'waiting' : 'working'
    return transcript.status ?? defaultStatus
  }
  if (transcript.failed) return 'waiting'
  if (transcript.status !== null) return transcript.status
  if (wakeModeLower === 'mentions' || wakeModeLower === 'all' || wakeModeLower === 'anything') {
    return 'waiting'
  }
  if (wakeModeLower === 'working' || (!wakeMode && rawPhase === 'RUNNING')) {
    return 'working'
  }
  return defaultStatus
}

function resolveMemberStatusFromRoster(
  killed: boolean,
  phase: SwarmPhase,
  remoteRoster: boolean,
  rawPhase: string,
  wakeMode: string | undefined,
  wakeModeLower: string | undefined,
  transcript: TranscriptSummary,
): SwarmMemberStatus {
  if (killed || rawPhase === 'KILLED') return 'killed'
  if (phase === 'completed' || phase === 'interrupted' || phase === 'error') {
    return transcript.status === 'killed' ? 'killed' : 'waiting'
  }
  if (transcript.hasActiveNonWaitTool) return 'working'
  if (rawPhase === 'WAITING') return 'waiting'
  if (rawPhase === 'STOPPED') return 'stopped'
  return resolveActiveMemberStatus(remoteRoster, rawPhase, wakeMode, wakeModeLower, transcript)
}

function resolveMemberActivityAndBoardWait(
  killed: boolean,
  status: SwarmMemberStatus,
  wakeModeLower: string | undefined,
  transcript: TranscriptSummary,
): { activity: string; waitingOnBoardProp: { waitingOnBoard?: boolean } } {
  const activity = killed
    ? '已回收'
    : transcript.activity ||
      (wakeModeLower === 'mentions' ? '等待 @提及' : status === 'waiting' ? '待命中' : '工作中…')
  const waitingOnBoard =
    !transcript.hasActiveNonWaitTool &&
    status !== 'killed' &&
    (status === 'waiting' || status === 'stopped' || transcript.waitingOnBoard === true)
  const waitingOnBoardProp = waitingOnBoard
    ? { waitingOnBoard: true }
    : transcript.hasActiveNonWaitTool
      ? { waitingOnBoard: false }
      : {}
  return { activity, waitingOnBoardProp }
}

function buildSwarmSnapshotFromLoadedData(
  opts: {
    conversationId: string
    phase: SwarmPhase
    revision: number
    startedAt?: number
    now?: number
  },
  roster: RawRoster,
  boardRaw: string | null,
  loadedMembers: readonly LoadedMemberData[],
): SwarmSnapshot {
  const { posts, totalPosts, headSeq, lastPostByAgent, postCountByChannel } = parseBoardPosts(boardRaw)

  const rawMembersObj = recordOf(roster.members) ?? {}
  const remoteRoster = isRemoteSwarmRoster(roster, rawMembersObj)
  const channelMeta = parseChannelsMeta(roster.channels)
  const memberCountByChannel = new Map<string, number>()
  const members: SwarmMemberSnapshot[] = []

  for (const { name, member: m, transcriptText, tailTruncated, incTelemetry } of loadedMembers) {
    const killed = m.killed === true
    const transcript = parseMemberTranscriptTail(transcriptText, {
      incBgTasks: incTelemetry?.bgTasks,
      incPartial: incTelemetry?.partial === true,
      tailTruncated,
    })
    const wakeMode = asStr(m.wake_mode) || undefined
    const wakeModeLower = wakeMode?.toLowerCase()
    const rawPhase = asStr(m.phase).toUpperCase()
    const status = resolveMemberStatusFromRoster(
      killed,
      opts.phase,
      remoteRoster,
      rawPhase,
      wakeMode,
      wakeModeLower,
      transcript,
    )

    const firstStepAt = incTelemetry?.firstStepAt ?? transcript.firstStepAt
    const lastActiveAt = incTelemetry?.lastActiveAt ?? transcript.lastActiveAt
    const inputTokens = incTelemetry ? incTelemetry.inputTokens : transcript.inputTokens
    const outputTokens = incTelemetry ? incTelemetry.outputTokens : transcript.outputTokens
    const cacheReadTokens = incTelemetry ? incTelemetry.cacheReadTokens : transcript.cacheReadTokens
    const thinkingTokens = incTelemetry ? incTelemetry.thinkingTokens : transcript.thinkingTokens
    const toolCalls = incTelemetry ? incTelemetry.toolCalls : transcript.toolCalls
    const telemetryPartial =
      incTelemetry?.partial === true ||
      (!incTelemetry && tailTruncated === true)
    const livenessEvidencePartial = transcript.incompleteBgEvidence === true
    const snapshotNow = opts.now ?? Date.now()
    let elapsedMs: number | undefined
    if (firstStepAt !== undefined) {
      const endTs =
        status === 'working'
          ? Math.max(snapshotNow, lastActiveAt ?? firstStepAt)
          : (lastActiveAt ?? firstStepAt)
      elapsedMs = Math.max(0, endTs - firstStepAt)
    }

    const memberChannels = Array.isArray(m.channels)
      ? m.channels.map((c) => asStr(c)).filter(Boolean)
      : []
    const effectiveChannels = memberChannels.length > 0 ? memberChannels : ['main']
    for (const ch of new Set(['main', ...effectiveChannels])) {
      memberCountByChannel.set(ch, (memberCountByChannel.get(ch) ?? 0) + 1)
    }

    const lastReadSeq = asNonNegInt(m.last_read_seq)
    const unreadCount = killed ? 0 : Math.max(0, headSeq - lastReadSeq)
    const lastPostSeq = lastPostByAgent.get(name.toLowerCase())
    const workspaceInfo = parseMemberWorkspace(m)
    const { activity, waitingOnBoardProp } = resolveMemberActivityAndBoardWait(
      killed,
      status,
      wakeModeLower,
      transcript,
    )

    members.push({
      name,
      role: inferRole(name, m.role),
      status,
      ...(asStr(m.model) ? { model: asStr(m.model) } : {}),
      ...(memberChannels.length > 0 ? { channels: memberChannels } : {}),
      ...workspaceInfo,
      ...(wakeMode ? { wakeMode } : {}),
      stepCount: transcript.stepCount,
      activity,
      ...waitingOnBoardProp,
      ...(transcript.failed ? { failed: true } : {}),
      ...(transcript.lastError ? { lastError: transcript.lastError } : {}),
      unreadCount,
      ...(lastPostSeq !== undefined ? { lastPostSeq } : {}),
      ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
      ...(toolCalls > 0 ? { toolCalls } : {}),
      ...(telemetryPartial ? { telemetryPartial: true } : {}),
      ...(livenessEvidencePartial
        ? { livenessEvidencePartial: true }
        : telemetryPartial
          ? { livenessEvidencePartial: false }
          : {}),
    })
  }

  // Sort members: coordinator first, then working workers, waiting workers, verifier, monitor/narrator, killed last.
  const roleWeight = (role: SwarmMemberRole): number => {
    if (role === 'coordinator') return 0
    if (role === 'worker') return 1
    if (role === 'verifier') return 2
    if (role === 'monitor') return 3
    return 4
  }
  members.sort((a, b) => {
    if (a.status === 'killed' && b.status !== 'killed') return 1
    if (b.status === 'killed' && a.status !== 'killed') return -1
    const rw = roleWeight(a.role) - roleWeight(b.role)
    if (rw !== 0) return rw
    if (a.status === 'working' && b.status !== 'working') return -1
    if (b.status === 'working' && a.status !== 'working') return 1
    return a.name.localeCompare(b.name)
  })

  const channelNames = new Set<string>(['main', ...channelMeta.keys(), ...postCountByChannel.keys(), ...memberCountByChannel.keys()])
  const channels: SwarmChannelSnapshot[] = [...channelNames]
    .slice(0, SWARM_MAX_CHANNELS)
    .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)))
    .map((name) => {
      const meta = channelMeta.get(name)
      return {
        name,
        ...(meta?.topic ? { topic: meta.topic } : {}),
        ...(meta?.archived ? { archived: true } : {}),
        memberCount: memberCountByChannel.get(name) ?? members.length,
        postCount: postCountByChannel.get(name) ?? 0,
      }
    })

  const title = asStr(roster.title) || '蜂群协作'
  const truncatedPosts = totalPosts > posts.length ? totalPosts - posts.length : undefined

  return {
    swarmId: opts.conversationId,
    title,
    phase: opts.phase,
    revision: opts.revision,
    updatedAt: opts.now ?? Date.now(),
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    members,
    channels,
    posts,
    totalPosts,
    ...(truncatedPosts ? { truncatedPosts } : {}),
  }
}

/** Pure one-shot reader for a coordinator conversation's swarm directory. */
export function readAntigravitySwarmSnapshot(opts: {
  brainDir: string
  conversationId: string
  phase: SwarmPhase
  revision: number
  startedAt?: number
  now?: number
  /** Internal collector so the watcher can stat member transcripts without exposing IDs on wire. */
  outMemberConvIds?: string[]
  /** Optional incremental transcript telemetry cache (avoids re-scanning full transcripts). */
  telemetryCache?: IncrementalTranscriptTelemetryCache
  /** When true (terminal snapshot), drain unread telemetry backlog up to the terminal budget. */
  drainTelemetry?: boolean
}): SwarmSnapshot | null {
  if (!CONVERSATION_ID_RE.test(opts.conversationId)) return null
  const membersRaw = readBoundedFileWithinRoot(
    opts.brainDir,
    [opts.conversationId, '.system_generated', 'swarm', 'members.json'],
    MAX_MEMBERS_JSON_BYTES,
  )
  if (!membersRaw) return null
  let roster: RawRoster
  try {
    const parsed = JSON.parse(membersRaw) as unknown
    const obj = recordOf(parsed)
    if (!obj) return null
    roster = obj as RawRoster
  } catch {
    return null
  }

  const boardRaw = readBoundedFileWithinRoot(
    opts.brainDir,
    [opts.conversationId, '.system_generated', 'swarm', 'board.jsonl'],
    MAX_BOARD_JSONL_BYTES,
  )
  const rawMembersObj = recordOf(roster.members) ?? {}
  const entries = Object.entries(rawMembersObj).slice(0, SWARM_MAX_MEMBERS)
  const loadedMembers: LoadedMemberData[] = []
  for (const [name, rawVal] of entries) {
    const m = (recordOf(rawVal) ?? {}) as RawRosterMember
    const memberConvId = asStr(m.conversation_id)
    const validConvId = Boolean(memberConvId && CONVERSATION_ID_RE.test(memberConvId))
    if (validConvId) opts.outMemberConvIds?.push(memberConvId)
    let tailTruncated = false
    const transcriptText = validConvId
      ? readBoundedFileWithinRoot(
          opts.brainDir,
          [memberConvId, '.system_generated', 'logs', 'transcript.jsonl'],
          TRANSCRIPT_TAIL_BYTES,
          { maxAdaptiveBytes: TRANSCRIPT_TAIL_ADAPTIVE_MAX_BYTES, onTruncated: () => { tailTruncated = true } },
        )
      : null
    const incTelemetry =
      opts.telemetryCache && validConvId
        ? opts.telemetryCache.scan(opts.brainDir, memberConvId, { drainAll: opts.drainTelemetry })
        : null
    loadedMembers.push({ name, member: m, transcriptText, tailTruncated, incTelemetry })
  }
  return buildSwarmSnapshotFromLoadedData(opts, roster, boardRaw, loadedMembers)
}

/** Async reader used by high-frequency interval polling to avoid blocking the gateway event loop. */
async function readAntigravitySwarmSnapshotAsync(opts: {
  brainDir: string
  conversationId: string
  phase: SwarmPhase
  revision: number
  startedAt?: number
  now?: number
  outMemberConvIds?: string[]
  telemetryCache?: IncrementalTranscriptTelemetryCache
  drainTelemetry?: boolean
}): Promise<SwarmSnapshot | null> {
  if (!CONVERSATION_ID_RE.test(opts.conversationId)) return null
  const membersRaw = await readBoundedFileWithinRootAsync(
    opts.brainDir,
    [opts.conversationId, '.system_generated', 'swarm', 'members.json'],
    MAX_MEMBERS_JSON_BYTES,
  )
  if (!membersRaw) return null
  let roster: RawRoster
  try {
    const parsed = JSON.parse(membersRaw) as unknown
    const obj = recordOf(parsed)
    if (!obj) return null
    roster = obj as RawRoster
  } catch {
    return null
  }

  const rawMembersObj = recordOf(roster.members) ?? {}
  const entries = Object.entries(rawMembersObj).slice(0, SWARM_MAX_MEMBERS)
  const [boardRaw, loadedMembers] = await Promise.all([
    readBoundedFileWithinRootAsync(
      opts.brainDir,
      [opts.conversationId, '.system_generated', 'swarm', 'board.jsonl'],
      MAX_BOARD_JSONL_BYTES,
    ),
    Promise.all(
      entries.map(async ([name, rawVal]): Promise<LoadedMemberData> => {
        const m = (recordOf(rawVal) ?? {}) as RawRosterMember
        const memberConvId = asStr(m.conversation_id)
        const validConvId = Boolean(memberConvId && CONVERSATION_ID_RE.test(memberConvId))
        if (validConvId) opts.outMemberConvIds?.push(memberConvId)
        let tailTruncated = false
        const [transcriptText, incTelemetry] = validConvId
          ? await Promise.all([
              readBoundedFileWithinRootAsync(
                opts.brainDir,
                [memberConvId, '.system_generated', 'logs', 'transcript.jsonl'],
                TRANSCRIPT_TAIL_BYTES,
                { maxAdaptiveBytes: TRANSCRIPT_TAIL_ADAPTIVE_MAX_BYTES, onTruncated: () => { tailTruncated = true } },
              ),
              opts.telemetryCache
                ? opts.telemetryCache.scanAsync(opts.brainDir, memberConvId, { drainAll: opts.drainTelemetry })
                : Promise.resolve(null),
            ])
          : [null, null]
        return { name, member: m, transcriptText, tailTruncated, incTelemetry }
      }),
    ),
  ])
  return buildSwarmSnapshotFromLoadedData(opts, roster, boardRaw, loadedMembers)
}

function stripVolatileMemberFields(m: SwarmMemberSnapshot) {
  const { lastActiveAt: _la, elapsedMs: _em, ...rest } = m
  return rest
}

/**
 * Exclude volatile timestamps AND incremental historical telemetry counters from
 * dormant activation comparison so draining a >128KB historical worker transcript
 * never falsely flips a non-swarm follow-up turn into `turnActive = true` (OCV5-842).
 */
function stripActivationVolatileMemberFields(m: SwarmMemberSnapshot) {
  const {
    lastActiveAt: _la,
    elapsedMs: _em,
    inputTokens: _it,
    outputTokens: _ot,
    cacheReadTokens: _crt,
    thinkingTokens: _tt,
    toolCalls: _tc,
    telemetryPartial: _tp,
    livenessEvidencePartial: _lep,
    ...rest
  } = m
  return rest
}

function snapshotFingerprint(snap: SwarmSnapshot): string {
  const {
    revision: _r,
    updatedAt: _u,
    startedAt: _s,
    postsMode: _pm,
    deltaBaseSeq: _dbs,
    ...rest
  } = snap
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...rest,
        members: rest.members.map(stripVolatileMemberFields),
      }),
      'utf8',
    )
    .digest('hex')
}

/**
 * High-priority structural fingerprint: changes here (new board posts, member
 * join/leave/status/error/workspace transitions, title/channel updates) emit
 * with 0ms delay. Activity-only churn (`stepCount`, `activity`, `unreadCount`)
 * is coalesced under `activityThrottleMs` (OCV5-819).
 */
function structuralFingerprint(snap: SwarmSnapshot): string {
  const normalized = {
    swarmId: snap.swarmId,
    title: snap.title,
    phase: snap.phase,
    channels: snap.channels,
    posts: snap.posts,
    totalPosts: snap.totalPosts,
    members: snap.members.map((m) => ({
      name: m.name,
      role: m.role,
      status: m.status,
      model: m.model,
      channels: m.channels,
      workspace: m.workspace,
      workspaceBranch: m.workspaceBranch,
      workspacePath: m.workspacePath,
      wakeMode: m.wakeMode,
      waitingOnBoard: m.waitingOnBoard,
      failed: m.failed,
      lastError: m.lastError,
      lastPostSeq: m.lastPostSeq,
    })),
  }
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
}

/**
 * Activation fingerprint used ONLY while a resumed turn is still dormant
 * (`seedBaselineOnStart && !turnActive`). Excludes the coordinator's own
 * transcript-derived fields (`stepCount`/`activity`/`status`/`lastActiveAt`/
 * `failed`/`lastError`) so ordinary non-swarm follow-up prompts appending a
 * `USER_INPUT` to the coordinator's transcript do NOT re-activate an old board.
 */
function swarmActivationFingerprint(snap: SwarmSnapshot): string {
  const normalized = {
    swarmId: snap.swarmId,
    title: snap.title,
    channels: snap.channels,
    posts: snap.posts,
    totalPosts: snap.totalPosts,
    members: snap.members.map((m) =>
      m.role === 'coordinator'
        ? {
            name: m.name,
            role: m.role,
            model: m.model,
            channels: m.channels,
            unreadCount: m.unreadCount,
            lastPostSeq: m.lastPostSeq,
          }
        : stripActivationVolatileMemberFields(m),
    ),
  }
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
}

export interface AntigravitySwarmWatcherOptions {
  brainDir: string
  conversationId: string
  pollMs?: number
  /** Coalesce window for activity-only (`stepCount`/`activity`/`unreadCount`) updates.
   * Defaults to `SWARM_ACTIVITY_THROTTLE_MS` (2500ms). Pass `0` to disable throttling. */
  activityThrottleMs?: number
  /** Emit a full-posts keyframe every N emissions (default `SWARM_FULL_KEYFRAME_INTERVAL_EMITS`). */
  fullKeyframeIntervalEmits?: number
  /** Emit a full-posts keyframe at least every T ms (default `SWARM_FULL_KEYFRAME_INTERVAL_MS`). */
  fullKeyframeIntervalMs?: number
  /** Clock override for deterministic tests. */
  now?: () => number
  /**
   * When true (resumed native conversations), an already-existing swarm directory
   * at turn start is recorded purely as a baseline without emitting or marking
   * this turn as swarm-active until either disk state changes or the turn executes
   * an explicit native swarm tool (`activateTurnSwarm()`).
   */
  seedBaselineOnStart?: boolean
  onSnapshot: (snapshot: SwarmSnapshot) => void
  /** Optional zero-token deterministic stall monitor configuration (enabled when `onStallDetected` or `onStallExhausted` is provided). */
  stallMonitor?: SwarmStallMonitorOptions
  /** Invoked when every live core member stays parked past the stall threshold without `[done]`. */
  onStallDetected?: (alert: SwarmStallAlert) => void
  /** Invoked at most once per generation when all core members remain parked past `exhaustedGraceMs` after the final stall alert. */
  onStallExhausted?: (event: SwarmStallExhaustion) => void
}

export {
  buildDurableSwarmBoardInput,
  compactSwarmSnapshotForPersistence,
  formatSwarmWorkingDetail,
  settleSwarmSnapshotTerminal,
  type DurableSwarmBoardInput,
}

/**
 * Per-turn lifecycle watcher. Starts polling once `conversationId` is bound;
 * emits only when swarm state actually exists and changes during this turn.
 */
export class AntigravitySwarmWatcher {
  private readonly brainDir: string
  private readonly conversationId: string
  private readonly pollMs: number
  private readonly activityThrottleMs: number
  private readonly fullKeyframeIntervalEmits: number
  private readonly fullKeyframeIntervalMs: number
  private readonly now: () => number
  private readonly seedBaselineOnStart: boolean
  private readonly onSnapshot: (snapshot: SwarmSnapshot) => void
  private readonly onStallDetected?: (alert: SwarmStallAlert) => void
  private readonly stallMonitor: SwarmStallMonitor | null
  private timer: NodeJS.Timeout | null = null
  private throttleTimer: NodeJS.Timeout | null = null
  private keyframeTimer: NodeJS.Timeout | null = null
  private backlogTimer: NodeJS.Timeout | null = null
  private pendingActivitySnap: SwarmSnapshot | null = null
  private stopped = false
  private pollInFlight = false
  private pollGeneration = 0
  private revision = 0
  private startedAt: number | undefined
  private lastHash: string | null = null
  private lastStructuralHash: string | null = null
  private baselineActivationHash: string | null = null
  private lastStatSignature: string | null = null
  private trackedMemberConvIds: string[] = []
  private nonCoordinatorConvIds = new Set<string>()
  private readonly telemetryCache: IncrementalTranscriptTelemetryCache
  private lastSnapshot: SwarmSnapshot | null = null
  private emittedInTurn = false
  private turnActive = false
  private lastEmitAt = 0
  private lastFullEmitAt = 0
  private emitsSinceFull = 0
  private lastFullPostSeq = 0
  private lastEmittedPostSeq = 0
  private lastEmittedTotalPosts = 0

  constructor(opts: AntigravitySwarmWatcherOptions) {
    this.brainDir = opts.brainDir
    this.conversationId = opts.conversationId
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS
    this.activityThrottleMs = opts.activityThrottleMs ?? SWARM_ACTIVITY_THROTTLE_MS
    this.fullKeyframeIntervalEmits = opts.fullKeyframeIntervalEmits ?? SWARM_FULL_KEYFRAME_INTERVAL_EMITS
    this.fullKeyframeIntervalMs = opts.fullKeyframeIntervalMs ?? SWARM_FULL_KEYFRAME_INTERVAL_MS
    this.now = opts.now ?? Date.now
    this.seedBaselineOnStart = opts.seedBaselineOnStart === true
    this.onSnapshot = opts.onSnapshot
    this.onStallDetected = opts.onStallDetected
    const watcherExhausted = opts.onStallExhausted
    const monitorExhausted = opts.stallMonitor?.onStallExhausted
    const combinedExhausted =
      watcherExhausted || monitorExhausted
        ? (ev: SwarmStallExhaustion) => {
            if (this.stopped || !this.turnActive) return
            try {
              monitorExhausted?.(ev)
            } catch (err) {
              void err
            }
            if (watcherExhausted && watcherExhausted !== monitorExhausted) {
              try {
                watcherExhausted(ev)
              } catch (err) {
                void err
              }
            }
          }
        : undefined
    this.stallMonitor =
      opts.onStallDetected || combinedExhausted
        ? new SwarmStallMonitor({
            ...opts.stallMonitor,
            ...(combinedExhausted ? { onStallExhausted: combinedExhausted } : {}),
          })
        : null
    // When resuming an existing swarm (`seedBaselineOnStart`), anchor window token
    // deltas at turn start (minus 1s clock skew margin) so historical worker steps
    // are not re-counted in `turnWorkerUsageDelta()`.
    const windowStart = this.seedBaselineOnStart ? Math.max(0, this.now() - 1_000) : undefined
    this.telemetryCache = new IncrementalTranscriptTelemetryCache(
      undefined,
      undefined,
      windowStart,
    )
  }

  start(): void {
    if (this.stopped || this.timer) return
    if (this.seedBaselineOnStart) {
      this.captureBaseline()
    } else {
      this.pollOnce(true)
    }
    this.timer = setInterval(() => {
      void this.pollOnceAsync(false)
    }, this.pollMs)
    this.timer.unref()
  }

  /** Trigger an immediate poll (e.g., right after a `swarm` / `post_message` tool step). */
  kick(): void {
    if (this.stopped) return
    this.pollGeneration += 1
    this.pollOnce(true)
  }

  /**
   * Mark this turn as actively engaging the swarm (e.g. an own native swarm tool
   * executed in this turn). If a baseline board already exists and has not yet
   * been emitted for this turn, emit it immediately and refresh from disk.
   */
  activateTurnSwarm(): void {
    if (this.stopped) return
    this.pollGeneration += 1
    this.turnActive = true
    if (!this.emittedInTurn && this.lastSnapshot) {
      const nextRev = this.revision + 1
      const snap: SwarmSnapshot = {
        ...structuredClone(this.lastSnapshot),
        phase: 'running',
        revision: nextRev,
        updatedAt: this.now(),
      }
      this.revision = nextRev
      this.lastSnapshot = snap
      this.lastHash = snapshotFingerprint(snap)
      this.lastStructuralHash = structuralFingerprint(snap)
      this.emitWireSnapshot(snap, true)
    }
    this.pollOnce(true)
  }

  hasSwarm(): boolean {
    return this.lastSnapshot !== null
  }

  hasTurnActivity(): boolean {
    return this.turnActive
  }

  latestSnapshot(): SwarmSnapshot | null {
    return this.lastSnapshot ? structuredClone(this.lastSnapshot) : null
  }

  /** Roll back a stall alert's quota consumption when lock contention prevented board delivery. */
  rollbackStallAlert(alert: SwarmStallAlert): void {
    this.stallMonitor?.rollbackAlert(alert)
  }

  /** True iff this active swarm is stuck in `suppressed_max_alerts` with zero working core members. */
  isStallSuppressedAllParked(): boolean {
    if (this.stopped || !this.turnActive || !this.stallMonitor) return false
    return this.stallMonitor.isStallSuppressedAllParked()
  }

  /** Non-coordinator worker token delta observed during this turn (for tape display accuracy). */
  turnWorkerUsageDelta(): {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    thinkingTokens: number
  } {
    if (!this.turnActive) {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 }
    }
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let thinkingTokens = 0
    for (const convId of this.nonCoordinatorConvIds) {
      const snap = this.telemetryCache.peek(convId)
      if (!snap) continue
      inputTokens += snap.windowInputTokens ?? snap.inputTokens
      outputTokens += snap.windowOutputTokens ?? snap.outputTokens
      cacheReadTokens += snap.windowCacheReadTokens ?? snap.cacheReadTokens
      thinkingTokens += snap.windowThinkingTokens ?? snap.thinkingTokens
    }
    return { inputTokens, outputTokens, cacheReadTokens, thinkingTokens }
  }

  private computeStatSignature(): string {
    const parts: string[] = [
      statSignatureWithinRoot(this.brainDir, [this.conversationId, '.system_generated', 'swarm', 'members.json']),
      statSignatureWithinRoot(this.brainDir, [this.conversationId, '.system_generated', 'swarm', 'board.jsonl']),
    ]
    for (const memberConvId of this.trackedMemberConvIds) {
      parts.push(
        statSignatureWithinRoot(this.brainDir, [memberConvId, '.system_generated', 'logs', 'transcript.jsonl']),
      )
    }
    return parts.join('|')
  }

  private async computeStatSignatureAsync(): Promise<string> {
    const probes: Array<Promise<string>> = [
      statSignatureWithinRootAsync(this.brainDir, [this.conversationId, '.system_generated', 'swarm', 'members.json']),
      statSignatureWithinRootAsync(this.brainDir, [this.conversationId, '.system_generated', 'swarm', 'board.jsonl']),
    ]
    for (const memberConvId of this.trackedMemberConvIds) {
      probes.push(
        statSignatureWithinRootAsync(this.brainDir, [memberConvId, '.system_generated', 'logs', 'transcript.jsonl']),
      )
    }
    const parts = await Promise.all(probes)
    return parts.join('|')
  }

  private setTrackedMembers(ids: string[]): void {
    const uniq = Array.from(new Set(ids.filter((id) => CONVERSATION_ID_RE.test(id)))).sort()
    this.trackedMemberConvIds = uniq
    this.nonCoordinatorConvIds = new Set(
      uniq.filter((id) => id.toLowerCase() !== this.conversationId.toLowerCase()),
    )
    this.telemetryCache.prune(new Set(uniq))
  }

  private captureBaseline(): void {
    const statSig = this.computeStatSignature()
    this.lastStatSignature = statSig
    const memberConvIds: string[] = []
    // Intentionally omit `telemetryCache` while capturing a dormant baseline:
    // incremental 128 KB chunk draining on historical >128 KB worker transcripts
    // would otherwise create backlog ticks and burn I/O on non-swarm follow-ups.
    const snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase: 'running',
      revision: 0,
      now: this.now(),
      outMemberConvIds: memberConvIds,
    })
    if (!snap) return
    this.setTrackedMembers(memberConvIds)
    this.lastStatSignature = this.computeStatSignature()
    this.lastHash = snapshotFingerprint(snap)
    this.lastStructuralHash = structuralFingerprint(snap)
    this.baselineActivationHash = swarmActivationFingerprint(snap)
    this.lastSnapshot = snap
  }

  private clearThrottleTimer(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    this.pendingActivitySnap = null
  }

  private clearKeyframeTimer(): void {
    if (this.keyframeTimer) {
      clearTimeout(this.keyframeTimer)
      this.keyframeTimer = null
    }
  }

  /** Schedule a single bounded full-posts keyframe refresh after a delta carrying new posts
   * so even a board that goes quiet after a post delta self-heals within `fullKeyframeIntervalMs`,
   * while activity-only churn (no new posts since last full keyframe) never bloats live_frames (OCV5-819/837). */
  private scheduleQuietKeyframe(): void {
    this.clearKeyframeTimer()
    if (this.stopped || this.fullKeyframeIntervalMs <= 0) return
    if (this.lastEmittedPostSeq <= this.lastFullPostSeq) return
    const delayMs = Math.max(10, this.fullKeyframeIntervalMs)
    this.keyframeTimer = setTimeout(() => {
      this.keyframeTimer = null
      if (this.stopped || !this.lastSnapshot || this.lastEmittedPostSeq <= this.lastFullPostSeq) return
      const nextRev = this.revision + 1
      const snap: SwarmSnapshot = {
        ...structuredClone(this.lastSnapshot),
        revision: nextRev,
        updatedAt: this.now(),
      }
      this.revision = nextRev
      this.lastSnapshot = snap
      this.emitWireSnapshot(snap, true)
    }, delayMs)
    this.keyframeTimer.unref()
  }

  private emitWireSnapshot(fullSnap: SwarmSnapshot, forceFull: boolean): void {
    this.clearThrottleTimer()
    this.clearKeyframeTimer()
    const ts = this.now()
    const headSeq = fullSnap.posts.length > 0 ? fullSnap.posts[fullSnap.posts.length - 1]!.seq : 0
    const postsShrank =
      fullSnap.totalPosts < this.lastEmittedTotalPosts ||
      headSeq < this.lastEmittedPostSeq
    const hasUnkeyframedPosts = headSeq > this.lastFullPostSeq
    const keyframeDue =
      !this.emittedInTurn ||
      forceFull ||
      postsShrank ||
      (hasUnkeyframedPosts &&
        (this.emitsSinceFull >= this.fullKeyframeIntervalEmits ||
          ts - this.lastFullEmitAt >= this.fullKeyframeIntervalMs))

    let wireSnap: SwarmSnapshot
    if (keyframeDue) {
      wireSnap = {
        ...structuredClone(fullSnap),
        postsMode: 'full',
      }
      this.lastFullEmitAt = ts
      this.lastFullPostSeq = headSeq
      this.emitsSinceFull = 0
    } else {
      const deltaPosts = fullSnap.posts.filter((p) => p.seq > this.lastEmittedPostSeq)
      wireSnap = {
        ...structuredClone(fullSnap),
        posts: structuredClone(deltaPosts),
        postsMode: 'delta',
        deltaBaseSeq: this.lastEmittedPostSeq,
      }
      this.emitsSinceFull += 1
    }

    this.lastEmitAt = ts
    this.lastEmittedPostSeq = Math.max(this.lastEmittedPostSeq, headSeq)
    this.lastEmittedTotalPosts = fullSnap.totalPosts
    this.emittedInTurn = true
    if (!keyframeDue && this.lastEmittedPostSeq > this.lastFullPostSeq) {
      this.scheduleQuietKeyframe()
    }
    try {
      this.onSnapshot(wireSnap)
    } catch {
      // Observer errors must never crash the adapter timer loop.
    }
  }

  private scheduleThrottledActivityEmit(snap: SwarmSnapshot, delayMs: number): void {
    this.pendingActivitySnap = snap
    if (this.throttleTimer) return
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      if (this.stopped) {
        this.pendingActivitySnap = null
        return
      }
      const queued = this.pendingActivitySnap
      this.pendingActivitySnap = null
      if (!queued) return
      const nextRev = this.revision + 1
      const toEmit: SwarmSnapshot = {
        ...queued,
        revision: nextRev,
        updatedAt: this.now(),
      }
      this.revision = nextRev
      this.lastSnapshot = toEmit
      this.emitWireSnapshot(toEmit, false)
    }, Math.max(1, delayMs))
    this.throttleTimer.unref()
  }

  private clearBacklogTimer(): void {
    if (this.backlogTimer) {
      clearTimeout(this.backlogTimer)
      this.backlogTimer = null
    }
  }

  private scheduleBacklogCatchup(): void {
    if (this.stopped || this.backlogTimer || !this.telemetryCache.hasAnyBacklog()) return
    this.backlogTimer = setTimeout(() => {
      this.backlogTimer = null
      if (!this.stopped && this.telemetryCache.hasAnyBacklog()) {
        void this.pollOnceAsync(false)
      }
    }, 15)
    this.backlogTimer.unref()
  }

  private evaluateStall(snap: SwarmSnapshot, now: number): void {
    if (this.stopped || !this.turnActive || !this.stallMonitor) return
    const alert = this.stallMonitor.evaluate(snap, now)
    if (!alert || !this.onStallDetected) return
    try {
      this.onStallDetected(alert)
    } catch {
      // Observer errors must never crash the adapter timer loop.
    }
  }

  private static trackedSignaturesAdvanced(
    prevIds: readonly string[],
    preSig: string,
    nextIds: readonly string[],
    postSig: string,
  ): boolean {
    const preParts = preSig.split('|')
    const postParts = postSig.split('|')
    // Board or members.json changed during read -> must re-read on next tick.
    if (preParts[0] !== postParts[0] || preParts[1] !== postParts[1]) return true
    const prevSet = new Set(prevIds)
    // Newly discovered members had no pre-read signature; force one catch-up tick
    // so writes appended between reading their transcript and taking postSig are never missed.
    for (const id of nextIds) {
      if (!prevSet.has(id)) return true
    }
    const postById = new Map<string, string>()
    for (let i = 0; i < nextIds.length; i += 1) {
      postById.set(nextIds[i]!, postParts[i + 2] ?? '-')
    }
    for (let i = 0; i < prevIds.length; i += 1) {
      const id = prevIds[i]!
      const after = postById.get(id)
      if (after !== undefined && after !== (preParts[i + 2] ?? '-')) return true
    }
    return false
  }

  private finishPollEmit(snap: SwarmSnapshot, ts: number): void {
    if (this.telemetryCache.hasAnyBacklog()) this.scheduleBacklogCatchup()
    const hash = snapshotFingerprint(snap)
    const structHash = structuralFingerprint(snap)
    if (this.startedAt === undefined) {
      this.startedAt = snap.updatedAt
      snap.startedAt = this.startedAt
    }
    if (hash === this.lastHash) {
      if (!this.turnActive || !this.stallMonitor) return
      // Wire dedup ignores lastActiveAt; keep the quiet-tick input fresh anyway.
      this.lastSnapshot = { ...snap, revision: this.revision }
      if (this.pendingActivitySnap) this.pendingActivitySnap = this.lastSnapshot
      this.evaluateStall(this.lastSnapshot, ts)
      return
    }
    const isStructuralChange = !this.emittedInTurn || structHash !== this.lastStructuralHash
    this.turnActive = true
    this.lastHash = hash
    this.lastStructuralHash = structHash

    if (!isStructuralChange && this.activityThrottleMs > 0) {
      const elapsed = ts - this.lastEmitAt
      if (elapsed < this.activityThrottleMs) {
        this.lastSnapshot = { ...snap, revision: this.revision }
        this.scheduleThrottledActivityEmit(snap, this.activityThrottleMs - elapsed)
        this.evaluateStall(this.lastSnapshot, ts)
        return
      }
    }

    // Allocate revision strictly synchronously at publish time so concurrent
    // throttle timers and async polls can never emit two snapshots with the same revision.
    const nextRev = this.revision + 1
    const toEmit: SwarmSnapshot = snap.revision === nextRev ? snap : { ...snap, revision: nextRev }
    this.revision = nextRev
    this.lastSnapshot = toEmit
    this.emitWireSnapshot(toEmit, false)
    this.evaluateStall(toEmit, ts)
  }

  private pollOnce(force: boolean): void {
    if (this.stopped) return
    const isDormantBaseline =
      !this.turnActive && this.seedBaselineOnStart && this.baselineActivationHash !== null
    const prevTracked = this.trackedMemberConvIds
    const statSig = this.computeStatSignature()
    const hasBacklog = !isDormantBaseline && this.telemetryCache.hasAnyBacklog()
    if (!force && !hasBacklog && this.lastStatSignature !== null && statSig === this.lastStatSignature) {
      // When disk files stop changing completely (true stall), still evaluate
      // the in-memory stall state machine with zero disk I/O and zero LLM calls.
      if (this.turnActive && this.lastSnapshot) {
        this.evaluateStall(this.lastSnapshot, this.now())
      }
      return
    }
    const memberConvIds: string[] = []
    const ts = this.now()
    let snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase: 'running',
      revision: this.revision + 1,
      startedAt: this.startedAt,
      now: ts,
      outMemberConvIds: memberConvIds,
      ...(isDormantBaseline ? {} : { telemetryCache: this.telemetryCache }),
    })
    if (!snap) return
    this.setTrackedMembers(memberConvIds)
    const postSig = this.computeStatSignature()
    this.lastStatSignature = AntigravitySwarmWatcher.trackedSignaturesAdvanced(
      prevTracked,
      statSig,
      this.trackedMemberConvIds,
      postSig,
    )
      ? null
      : postSig
    if (isDormantBaseline) {
      const actHash = swarmActivationFingerprint(snap)
      if (actHash === this.baselineActivationHash) {
        // Coordinator-only transcript advance on an ordinary resumed turn:
        // keep baseline fresh without activating or emitting the historical board.
        this.lastHash = snapshotFingerprint(snap)
        this.lastStructuralHash = structuralFingerprint(snap)
        this.lastSnapshot = snap
        return
      }
      // Genuine non-coordinator / board mutation woke the dormant board:
      // transition to active and re-read with incremental telemetry enabled.
      this.turnActive = true
      const activePrevTracked = this.trackedMemberConvIds
      const activePreSig = this.computeStatSignature()
      const activeMemberConvIds: string[] = []
      const activeSnap = readAntigravitySwarmSnapshot({
        brainDir: this.brainDir,
        conversationId: this.conversationId,
        phase: 'running',
        revision: this.revision + 1,
        startedAt: this.startedAt,
        now: ts,
        outMemberConvIds: activeMemberConvIds,
        telemetryCache: this.telemetryCache,
      })
      if (activeSnap) {
        snap = activeSnap
        this.setTrackedMembers(activeMemberConvIds)
        const activePostSig = this.computeStatSignature()
        this.lastStatSignature = AntigravitySwarmWatcher.trackedSignaturesAdvanced(
          activePrevTracked,
          activePreSig,
          this.trackedMemberConvIds,
          activePostSig,
        )
          ? null
          : activePostSig
      }
    }
    this.finishPollEmit(snap, ts)
  }

  private async pollOnceAsync(force: boolean): Promise<void> {
    if (this.stopped || this.pollInFlight) return
    this.pollInFlight = true
    const gen = this.pollGeneration
    try {
      const isDormantBaseline =
        !this.turnActive && this.seedBaselineOnStart && this.baselineActivationHash !== null
      const prevTracked = this.trackedMemberConvIds
      const statSig = await this.computeStatSignatureAsync()
      if (this.stopped || gen !== this.pollGeneration) return
      const hasBacklog = !isDormantBaseline && this.telemetryCache.hasAnyBacklog()
      if (!force && !hasBacklog && this.lastStatSignature !== null && statSig === this.lastStatSignature) {
        if (this.turnActive && this.lastSnapshot) {
          this.evaluateStall(this.lastSnapshot, this.now())
        }
        return
      }
      const memberConvIds: string[] = []
      const ts = this.now()
      let snap = await readAntigravitySwarmSnapshotAsync({
        brainDir: this.brainDir,
        conversationId: this.conversationId,
        phase: 'running',
        revision: this.revision + 1,
        startedAt: this.startedAt,
        now: ts,
        outMemberConvIds: memberConvIds,
        ...(isDormantBaseline ? {} : { telemetryCache: this.telemetryCache }),
      })
      if (this.stopped || gen !== this.pollGeneration || !snap) return
      this.setTrackedMembers(memberConvIds)
      const postSig = await this.computeStatSignatureAsync()
      if (this.stopped || gen !== this.pollGeneration) return
      // Never stamp a newer concurrent write's signature onto an older snapshot.
      this.lastStatSignature = AntigravitySwarmWatcher.trackedSignaturesAdvanced(
        prevTracked,
        statSig,
        this.trackedMemberConvIds,
        postSig,
      )
        ? null
        : postSig
      if (isDormantBaseline) {
        const actHash = swarmActivationFingerprint(snap)
        if (actHash === this.baselineActivationHash) {
          this.lastHash = snapshotFingerprint(snap)
          this.lastStructuralHash = structuralFingerprint(snap)
          this.lastSnapshot = snap
          return
        }
        this.turnActive = true
        const activePrevTracked = this.trackedMemberConvIds
        const activePreSig = await this.computeStatSignatureAsync()
        if (this.stopped || gen !== this.pollGeneration) return
        const activeMemberConvIds: string[] = []
        const activeSnap = await readAntigravitySwarmSnapshotAsync({
          brainDir: this.brainDir,
          conversationId: this.conversationId,
          phase: 'running',
          revision: this.revision + 1,
          startedAt: this.startedAt,
          now: ts,
          outMemberConvIds: activeMemberConvIds,
          telemetryCache: this.telemetryCache,
        })
        if (this.stopped || gen !== this.pollGeneration) return
        if (activeSnap) {
          snap = activeSnap
          this.setTrackedMembers(activeMemberConvIds)
          const activePostSig = await this.computeStatSignatureAsync()
          if (this.stopped || gen !== this.pollGeneration) return
          this.lastStatSignature = AntigravitySwarmWatcher.trackedSignaturesAdvanced(
            activePrevTracked,
            activePreSig,
            this.trackedMemberConvIds,
            activePostSig,
          )
            ? null
            : activePostSig
        }
      }
      this.finishPollEmit(snap, ts)
    } finally {
      this.pollInFlight = false
    }
  }

  /** Stop polling and capture one final authoritative snapshot with terminal phase.
   *  Returns null if this turn never created, modified, or explicitly engaged a swarm. */
  stopAndReadFinal(phase: SwarmPhase): SwarmSnapshot | null {
    this.stop()
    if (!this.turnActive) {
      // Do one final synchronous disk check before returning null so board/member
      // mutations written while an async poll was pending or invalidated by stop()
      // are never silently skipped at turn end.
      const probe = readAntigravitySwarmSnapshot({
        brainDir: this.brainDir,
        conversationId: this.conversationId,
        phase: 'running',
        revision: this.revision + 1,
        startedAt: this.startedAt,
        now: this.now(),
      })
      if (!probe) return null
      if (
        this.seedBaselineOnStart &&
        this.baselineActivationHash !== null &&
        swarmActivationFingerprint(probe) === this.baselineActivationHash
      ) {
        return null
      }
      this.turnActive = true
    }
    const nextRev = this.revision + 1
    const finalMemberConvIds: string[] = []
    const snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase,
      revision: nextRev,
      startedAt: this.startedAt,
      now: this.now(),
      outMemberConvIds: finalMemberConvIds,
      telemetryCache: this.telemetryCache,
      drainTelemetry: true,
    })
    if (finalMemberConvIds.length > 0) this.setTrackedMembers(finalMemberConvIds)
    if (!snap) {
      if (!this.lastSnapshot) return null
      const fallback = settleSwarmSnapshotTerminal(this.lastSnapshot, phase)
      this.revision = fallback.revision
      this.lastSnapshot = fallback
      return structuredClone(fallback)
    }
    this.revision = nextRev
    this.lastSnapshot = snap
    return structuredClone(snap)
  }

  stop(): void {
    this.stopped = true
    this.pollGeneration += 1
    this.stallMonitor?.reset()
    this.clearThrottleTimer()
    this.clearKeyframeTimer()
    this.clearBacklogTimer()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
