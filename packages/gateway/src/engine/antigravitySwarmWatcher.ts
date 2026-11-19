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
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { basename, join, sep } from 'node:path'
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

const MAX_MEMBERS_JSON_BYTES = 512 * 1024
const MAX_BOARD_JSONL_BYTES = 2 * 1024 * 1024
const TRANSCRIPT_TAIL_BYTES = 64 * 1024
const DEFAULT_POLL_MS = 750
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RawRosterMember {
  conversation_id?: unknown
  model?: unknown
  role?: unknown
  wake_mode?: unknown
  wait_since?: unknown
  last_read_seq?: unknown
  killed?: unknown
  channels?: unknown
  workspace?: unknown
}

interface RawRoster {
  title?: unknown
  members?: unknown
  channels?: unknown
}

interface TranscriptSummary {
  stepCount: number
  status: SwarmMemberStatus | null
  activity?: string
  failed?: boolean
  lastError?: string
  lastActiveAt?: number
}

function isSafePathSegment(seg: string): boolean {
  return (
    seg.length > 0 &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0')
  )
}

/**
 * Walk every path component under `rootDir` rejecting symlinks at EVERY level
 * (root, intermediate directories, and leaf). Returns the verified path and
 * lstat result for a regular file, or null on any symlink/traversal/missing node.
 */
function resolveRegularFileWithinRoot(
  rootDir: string,
  segments: readonly string[],
): { fullPath: string; stat: Stats } | null {
  if (segments.length === 0) return null
  try {
    const rootStat = lstatSync(rootDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    let cur = rootDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!
      if (!isSafePathSegment(seg)) return null
      cur = join(cur, seg)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const leaf = segments[segments.length - 1]!
    if (!isSafePathSegment(leaf)) return null
    const fullPath = join(cur, leaf)
    const leafStat = lstatSync(fullPath)
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null
    return { fullPath, stat: leafStat }
  } catch {
    return null
  }
}

function statSignatureWithinRoot(rootDir: string, segments: readonly string[]): string {
  const resolved = resolveRegularFileWithinRoot(rootDir, segments)
  if (!resolved) return '-'
  const st = resolved.stat
  return `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`
}

function readBoundedFileWithinRoot(
  rootDir: string,
  segments: readonly string[],
  maxBytes: number,
): string | null {
  const resolved = resolveRegularFileWithinRoot(rootDir, segments)
  if (!resolved) return null
  let fd: number | null = null
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
      (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
    fd = openSync(resolved.fullPath, flags)
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== resolved.stat.dev || st.ino !== resolved.stat.ino || st.size <= 0) {
      return null
    }
    // Defense-in-depth containment verification against realpath of trusted rootDir.
    const realRoot = realpathSync(rootDir)
    const realFile = realpathSync(resolved.fullPath)
    if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
      return null
    }
    const size = Math.min(st.size, maxBytes)
    const startOffset = st.size > maxBytes ? st.size - maxBytes : 0
    const buf = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, startOffset + offset)
      if (n <= 0) break
      offset += n
    }
    const text = buf.subarray(0, offset).toString('utf8')
    if (startOffset > 0) {
      const firstNewline = text.indexOf('\n')
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return text
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
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

function shortFileTarget(args: Record<string, unknown> | null): string {
  if (!args) return ''
  const raw =
    asStr(args.Path) ||
    asStr(args.AbsolutePath) ||
    asStr(args.TargetFile) ||
    asStr(args.file_path) ||
    asStr(args.path)
  if (!raw) return ''
  return basename(raw) || raw
}

function describeToolActivity(toolName: string, args: Record<string, unknown> | null): string {
  const name = toolName.trim()
  const target = shortFileTarget(args)
  switch (name) {
    case 'read_file':
    case 'view_file':
      return target ? `阅读 ${target}` : '阅读文件'
    case 'write_file':
    case 'write_to_file':
      return target ? `写入 ${target}` : '写入文件'
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
      return target ? `编辑 ${target}` : '编辑文件'
    case 'run_command':
    case 'mcp_openclaude-memory_oc_bash':
      return '运行命令'
    case 'grep_search':
    case 'mcp_openclaude-memory_oc_grep':
      return '检索代码'
    case 'find_by_name':
    case 'list_dir':
    case 'mcp_openclaude-memory_oc_glob':
      return '浏览目录'
    case 'search_web':
      return '联网检索'
    case 'read_url_content':
      return '抓取网页'
    case 'post_message':
      return '发送讨论消息'
    case 'read_board':
      return '查看讨论板'
    case 'swarm_wait':
      return '等待讨论板消息'
    case 'swarm': {
      const action = args ? asStr(args.action) : ''
      if (action === 'add') return '招募蜂群成员'
      if (action === 'status') return '检查蜂群状态'
      if (action === 'kill') return '回收蜂群成员'
      return '调度蜂群'
    }
    default:
      if (name.startsWith('mcp_')) return `调用 ${name.split('_').slice(-1)[0] || name}`
      return name ? `执行 ${name}` : '处理中…'
  }
}

function recordOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Inspect a member's compact `transcript.jsonl` tail to determine its live
 * status, step count, current activity, and error state (mirrors Antigravity
 * CLI `board.StateOf`).
 */
export function parseMemberTranscriptTail(text: string | null): TranscriptSummary {
  if (!text) return { stepCount: 0, status: null }
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { stepCount: 0, status: null }

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
  if (steps.length === 0) return { stepCount: 0, status: null }

  let maxStepIndex = steps.length
  let lastActiveAt: number | undefined
  for (const step of steps) {
    if (typeof step.step_index === 'number' && Number.isFinite(step.step_index)) {
      maxStepIndex = Math.max(maxStepIndex, Math.floor(step.step_index) + 1)
    }
    const createdAt = asStr(step.created_at)
    if (createdAt) {
      const parsedTs = Date.parse(createdAt)
      if (Number.isFinite(parsedTs)) lastActiveAt = parsedTs
    }
  }

  // Locate the latest meaningful turn boundary (USER_INPUT) to inspect current turn only.
  let turnStart = 0
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const t = asStr(steps[i]?.type).toUpperCase()
    if (t === 'USER_INPUT') {
      turnStart = i
      break
    }
  }
  const turnSteps = steps.slice(turnStart)
  const last = turnSteps[turnSteps.length - 1]!
  const lastType = asStr(last.type).toUpperCase()
  const lastStatus = asStr(last.status).toUpperCase()

  if (lastStatus === 'ERROR' || lastType === 'ERROR_MESSAGE') {
    const errText = clampText(asStr(last.content) || asStr(last.error) || '执行出错', 160)
    return {
      stepCount: maxStepIndex,
      status: 'waiting',
      activity: '步骤异常',
      failed: true,
      lastError: errText,
      lastActiveAt,
    }
  }

  // Find the most recent planner step in the current turn.
  let lastPlanner: Record<string, unknown> | null = null
  for (let i = turnSteps.length - 1; i >= 0; i -= 1) {
    const t = asStr(turnSteps[i]?.type).toUpperCase()
    if (t === 'PLANNER_RESPONSE') {
      lastPlanner = turnSteps[i]!
      break
    }
  }

  if (lastType === 'PLANNER_RESPONSE') {
    const calls = Array.isArray(last.tool_calls) ? last.tool_calls : []
    if (lastStatus === 'DONE' && calls.length === 0) {
      return {
        stepCount: maxStepIndex,
        status: 'waiting',
        activity: '已完成本轮思考',
        lastActiveAt,
      }
    }
    if (calls.length > 0) {
      const firstCall = recordOf(calls[calls.length - 1])
      const callName = asStr(firstCall?.name)
      const callArgs = recordOf(firstCall?.arguments ?? firstCall?.args)
      return {
        stepCount: maxStepIndex,
        status: 'working',
        activity: describeToolActivity(callName, callArgs),
        lastActiveAt,
      }
    }
    return {
      stepCount: maxStepIndex,
      status: 'working',
      activity: '思考与规划中…',
      lastActiveAt,
    }
  }

  // Check if a tool batch ended with `swarm_wait` DONE (member parked itself).
  const isSwarmWaitDone = turnSteps.slice(-6).some((step) => {
    const name = asStr(step.tool_name || step.name).toLowerCase()
    const st = asStr(step.status).toUpperCase()
    return name === 'swarm_wait' && st === 'DONE'
  })
  if (isSwarmWaitDone && lastStatus === 'DONE') {
    return {
      stepCount: maxStepIndex,
      status: 'waiting',
      activity: '等待讨论板消息',
      lastActiveAt,
    }
  }

  // Otherwise inspect the active tool or latest planner call.
  const directTool = asStr(last.tool_name || last.name)
  if (directTool) {
    return {
      stepCount: maxStepIndex,
      status: lastStatus === 'RUNNING' || lastStatus === 'PENDING' ? 'working' : 'working',
      activity: describeToolActivity(directTool, recordOf(last.arguments ?? last.args)),
      lastActiveAt,
    }
  }
  if (lastPlanner && Array.isArray(lastPlanner.tool_calls) && lastPlanner.tool_calls.length > 0) {
    const latestCall = recordOf(lastPlanner.tool_calls[lastPlanner.tool_calls.length - 1])
    return {
      stepCount: maxStepIndex,
      status: 'working',
      activity: describeToolActivity(asStr(latestCall?.name), recordOf(latestCall?.arguments ?? latestCall?.args)),
      lastActiveAt,
    }
  }
  return {
    stepCount: maxStepIndex,
    status: lastType === 'USER_INPUT' ? 'working' : 'waiting',
    activity: lastType === 'USER_INPUT' ? '启动处理中…' : '待命中',
    lastActiveAt,
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

function parseBoardPosts(text: string | null): { posts: SwarmBoardPost[]; totalPosts: number; headSeq: number } {
  if (!text) return { posts: [], totalPosts: 0, headSeq: 0 }
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
  const totalPosts = all.length
  const posts = totalPosts > SWARM_MAX_POSTS ? all.slice(totalPosts - SWARM_MAX_POSTS) : all
  return { posts, totalPosts, headSeq }
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
  const { posts, totalPosts, headSeq } = parseBoardPosts(boardRaw)

  const lastPostByAgent = new Map<string, number>()
  const postCountByChannel = new Map<string, number>()
  for (const post of posts) {
    lastPostByAgent.set(post.agent.toLowerCase(), post.seq)
    const ch = post.channel || 'main'
    postCountByChannel.set(ch, (postCountByChannel.get(ch) ?? 0) + 1)
  }

  const rawMembersObj = recordOf(roster.members) ?? {}
  const channelMeta = parseChannelsMeta(roster.channels)
  const memberCountByChannel = new Map<string, number>()
  const members: SwarmMemberSnapshot[] = []

  const entries = Object.entries(rawMembersObj).slice(0, SWARM_MAX_MEMBERS)
  for (const [name, rawVal] of entries) {
    const m = (recordOf(rawVal) ?? {}) as RawRosterMember
    const killed = m.killed === true
    const memberConvId = asStr(m.conversation_id)
    if (memberConvId && CONVERSATION_ID_RE.test(memberConvId)) {
      opts.outMemberConvIds?.push(memberConvId)
    }
    const transcriptText =
      memberConvId && CONVERSATION_ID_RE.test(memberConvId)
        ? readBoundedFileWithinRoot(
            opts.brainDir,
            [memberConvId, '.system_generated', 'logs', 'transcript.jsonl'],
            TRANSCRIPT_TAIL_BYTES,
          )
        : null
    const transcript = parseMemberTranscriptTail(transcriptText)
    const wakeMode = asStr(m.wake_mode) || undefined
    let status: SwarmMemberStatus
    if (killed) {
      status = 'killed'
    } else if (opts.phase === 'completed' || opts.phase === 'interrupted' || opts.phase === 'error') {
      status = transcript.status === 'killed' ? 'killed' : 'waiting'
    } else if (transcript.status) {
      status = transcript.status
    } else if (wakeMode) {
      status = 'waiting'
    } else {
      status = 'working'
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
    const activity =
      killed
        ? '已回收'
        : transcript.activity || (wakeMode === 'mentions' ? '等待 @提及' : status === 'waiting' ? '待命中' : '工作中…')

    members.push({
      name,
      role: inferRole(name, m.role),
      status,
      ...(asStr(m.model) ? { model: asStr(m.model) } : {}),
      ...(memberChannels.length > 0 ? { channels: memberChannels } : {}),
      ...(asStr(m.workspace) ? { workspace: asStr(m.workspace) } : {}),
      ...(wakeMode ? { wakeMode } : {}),
      stepCount: transcript.stepCount,
      activity,
      ...(transcript.failed ? { failed: true } : {}),
      ...(transcript.lastError ? { lastError: transcript.lastError } : {}),
      unreadCount,
      ...(lastPostSeq !== undefined ? { lastPostSeq } : {}),
      ...(transcript.lastActiveAt !== undefined ? { lastActiveAt: transcript.lastActiveAt } : {}),
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

function snapshotFingerprint(snap: SwarmSnapshot): string {
  const { revision: _r, updatedAt: _u, startedAt: _s, ...rest } = snap
  return createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex')
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
        : m,
    ),
  }
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
}

export interface AntigravitySwarmWatcherOptions {
  brainDir: string
  conversationId: string
  pollMs?: number
  /**
   * When true (resumed native conversations), an already-existing swarm directory
   * at turn start is recorded purely as a baseline without emitting or marking
   * this turn as swarm-active until either disk state changes or the turn executes
   * an explicit native swarm tool (`activateTurnSwarm()`).
   */
  seedBaselineOnStart?: boolean
  onSnapshot: (snapshot: SwarmSnapshot) => void
}

export function settleSwarmSnapshotTerminal(snap: SwarmSnapshot, phase: SwarmPhase): SwarmSnapshot {
  return {
    ...structuredClone(snap),
    phase,
    revision: snap.revision + 1,
    updatedAt: Date.now(),
    members: snap.members.map((m) => ({
      ...m,
      status: m.status === 'killed' ? 'killed' : 'waiting',
    })),
  }
}

/**
 * Per-turn lifecycle watcher. Starts polling once `conversationId` is bound;
 * emits only when swarm state actually exists and changes during this turn.
 */
export class AntigravitySwarmWatcher {
  private readonly brainDir: string
  private readonly conversationId: string
  private readonly pollMs: number
  private readonly seedBaselineOnStart: boolean
  private readonly onSnapshot: (snapshot: SwarmSnapshot) => void
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private revision = 0
  private startedAt: number | undefined
  private lastHash: string | null = null
  private baselineActivationHash: string | null = null
  private lastStatSignature: string | null = null
  private trackedMemberConvIds: string[] = []
  private lastSnapshot: SwarmSnapshot | null = null
  private emittedInTurn = false
  private turnActive = false

  constructor(opts: AntigravitySwarmWatcherOptions) {
    this.brainDir = opts.brainDir
    this.conversationId = opts.conversationId
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS
    this.seedBaselineOnStart = opts.seedBaselineOnStart === true
    this.onSnapshot = opts.onSnapshot
  }

  start(): void {
    if (this.stopped || this.timer) return
    if (this.seedBaselineOnStart) {
      this.captureBaseline()
    } else {
      this.pollOnce(true)
    }
    this.timer = setInterval(() => {
      this.pollOnce(false)
    }, this.pollMs)
    this.timer.unref()
  }

  /** Trigger an immediate poll (e.g., right after a `swarm` / `post_message` tool step). */
  kick(): void {
    if (this.stopped) return
    this.pollOnce(true)
  }

  /**
   * Mark this turn as actively engaging the swarm (e.g. an own native swarm tool
   * executed in this turn). If a baseline board already exists and has not yet
   * been emitted for this turn, emit it immediately and refresh from disk.
   */
  activateTurnSwarm(): void {
    if (this.stopped) return
    this.turnActive = true
    if (!this.emittedInTurn && this.lastSnapshot) {
      const nextRev = this.revision + 1
      const snap: SwarmSnapshot = {
        ...structuredClone(this.lastSnapshot),
        phase: 'running',
        revision: nextRev,
        updatedAt: Date.now(),
      }
      this.revision = nextRev
      this.lastSnapshot = snap
      this.emitSafe(snap)
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

  private setTrackedMembers(ids: string[]): void {
    const uniq = Array.from(new Set(ids.filter((id) => CONVERSATION_ID_RE.test(id)))).sort()
    this.trackedMemberConvIds = uniq
  }

  private captureBaseline(): void {
    const statSig = this.computeStatSignature()
    this.lastStatSignature = statSig
    const memberConvIds: string[] = []
    const snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase: 'running',
      revision: 0,
      outMemberConvIds: memberConvIds,
    })
    if (!snap) return
    this.setTrackedMembers(memberConvIds)
    this.lastStatSignature = this.computeStatSignature()
    this.lastHash = snapshotFingerprint(snap)
    this.baselineActivationHash = swarmActivationFingerprint(snap)
    this.lastSnapshot = snap
  }

  private emitSafe(snap: SwarmSnapshot): void {
    this.emittedInTurn = true
    try {
      this.onSnapshot(structuredClone(snap))
    } catch {
      // Observer errors must never crash the adapter timer loop.
    }
  }

  private pollOnce(force: boolean): void {
    if (this.stopped) return
    const statSig = this.computeStatSignature()
    if (!force && this.lastStatSignature !== null && statSig === this.lastStatSignature) {
      return
    }
    this.lastStatSignature = statSig
    const nextRev = this.revision + 1
    const memberConvIds: string[] = []
    const snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase: 'running',
      revision: nextRev,
      startedAt: this.startedAt,
      outMemberConvIds: memberConvIds,
    })
    if (!snap) return
    this.setTrackedMembers(memberConvIds)
    this.lastStatSignature = this.computeStatSignature()
    const hash = snapshotFingerprint(snap)
    if (!this.turnActive && this.seedBaselineOnStart && this.baselineActivationHash !== null) {
      const actHash = swarmActivationFingerprint(snap)
      if (actHash === this.baselineActivationHash) {
        // Coordinator-only transcript advance on an ordinary resumed turn:
        // keep baseline fresh without activating or emitting the historical board.
        this.lastHash = hash
        this.lastSnapshot = snap
        return
      }
    }
    if (this.startedAt === undefined) {
      this.startedAt = snap.updatedAt
      snap.startedAt = this.startedAt
    }
    if (hash === this.lastHash) return
    this.turnActive = true
    this.revision = nextRev
    this.lastHash = hash
    this.lastSnapshot = snap
    this.emitSafe(snap)
  }

  /** Stop polling and capture one final authoritative snapshot with terminal phase.
   *  Returns null if this turn never created, modified, or explicitly engaged a swarm. */
  stopAndReadFinal(phase: SwarmPhase): SwarmSnapshot | null {
    this.stop()
    if (!this.turnActive) return null
    const nextRev = this.revision + 1
    const snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase,
      revision: nextRev,
      startedAt: this.startedAt,
    })
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
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/** Concise one-line status text for the live turn_status working bar. */
export function formatSwarmWorkingDetail(snap: SwarmSnapshot): string {
  const working = snap.members.filter((m) => m.status === 'working' && m.role !== 'monitor' && m.role !== 'narrator').length
  const live = snap.members.filter((m) => m.status !== 'killed').length
  const parts: string[] = [`蜂群「${snap.title}」`]
  if (working > 0) parts.push(`${working} 成员运行中`)
  else parts.push(`${live} 成员协作中`)
  if (snap.totalPosts > 0) parts.push(`${snap.totalPosts} 条讨论`)
  return parts.join(' · ')
}

export interface DurableSwarmBoardInput {
  swarmId: string
  title: string
  phase: SwarmPhase
  snapshot: SwarmSnapshot
}

function durableEnvelopeFor(snapshot: SwarmSnapshot): DurableSwarmBoardInput {
  return {
    swarmId: snapshot.swarmId,
    title: snapshot.title,
    phase: snapshot.phase,
    snapshot,
  }
}

/**
 * Produce a UTF-8 byte-bounded copy of a SwarmSnapshot whose COMPLETE
 * `{ swarmId, title, phase, snapshot }` envelope fits safely inside
 * `ToolEntrySchema.inputJson` (16 KB server-authored durability cap).
 */
export function compactSwarmSnapshotForPersistence(
  snap: SwarmSnapshot,
  maxBytes: number = 13_000,
): SwarmSnapshot {
  const fit = (candidate: SwarmSnapshot): boolean =>
    Buffer.byteLength(JSON.stringify(durableEnvelopeFor(candidate)), 'utf8') <= maxBytes

  if (fit(snap)) return structuredClone(snap)

  const baseMembers = snap.members.map((m) => ({
    ...m,
    ...(m.activity ? { activity: clampText(m.activity, 80) } : {}),
    ...(m.lastError ? { lastError: clampText(m.lastError, 120) } : {}),
  }))
  const baseChannels = snap.channels.map((c) => ({
    ...c,
    ...(c.topic ? { topic: clampText(c.topic, 80) } : {}),
  }))

  for (const [maxPosts, maxPostText] of [
    [40, 320],
    [24, 220],
    [12, 160],
    [6, 120],
    [0, 0],
  ] as const) {
    const posts = maxPosts === 0
      ? []
      : snap.posts.slice(-maxPosts).map((p) => ({
          ...p,
          text: clampText(p.text, maxPostText),
        }))
    const truncatedPosts = snap.totalPosts > posts.length ? snap.totalPosts - posts.length : undefined
    const candidate: SwarmSnapshot = {
      ...snap,
      title: clampText(snap.title, 120),
      members: baseMembers,
      channels: baseChannels,
      posts,
      ...(truncatedPosts ? { truncatedPosts } : {}),
    }
    if (fit(candidate)) return candidate
  }

  // Final defensive fallback: shrink members & channels until the FULL UTF-8 envelope fits.
  const minimalMembers = baseMembers.map((m) => ({
    name: clampText(m.name, 40),
    role: m.role,
    status: m.status,
    stepCount: m.stepCount,
    unreadCount: m.unreadCount,
    ...(m.failed ? { failed: true } : {}),
  }))
  const minimalChannels = baseChannels.map((c) => ({
    name: clampText(c.name, 32),
    memberCount: c.memberCount,
    postCount: c.postCount,
  }))
  for (const [mCap, cCap] of [
    [16, 8],
    [8, 4],
    [4, 2],
    [0, 0],
  ] as const) {
    const candidate: SwarmSnapshot = {
      swarmId: snap.swarmId,
      title: clampText(snap.title, 80),
      phase: snap.phase,
      revision: snap.revision,
      updatedAt: snap.updatedAt,
      ...(snap.startedAt !== undefined ? { startedAt: snap.startedAt } : {}),
      members: minimalMembers.slice(0, mCap),
      channels: minimalChannels.slice(0, cCap),
      posts: [],
      totalPosts: snap.totalPosts,
      ...(snap.totalPosts > 0 ? { truncatedPosts: snap.totalPosts } : {}),
    }
    if (fit(candidate)) return candidate
  }
  return {
    swarmId: snap.swarmId,
    title: clampText(snap.title, 32),
    phase: snap.phase,
    revision: snap.revision,
    updatedAt: snap.updatedAt,
    members: [],
    channels: [],
    posts: [],
    totalPosts: snap.totalPosts,
    ...(snap.totalPosts > 0 ? { truncatedPosts: snap.totalPosts } : {}),
  }
}

export function buildDurableSwarmBoardInput(
  snap: SwarmSnapshot,
  maxBytes: number = 13_000,
): DurableSwarmBoardInput {
  return durableEnvelopeFor(compactSwarmSnapshotForPersistence(snap, maxBytes))
}
