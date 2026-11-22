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
import { StringDecoder } from 'node:string_decoder'
import {
  SWARM_MAX_CHANNELS,
  SWARM_MAX_MEMBERS,
  SWARM_MAX_POSTS,
  SWARM_MAX_POST_CHARS,
  compactSwarmSnapshotToByteBudget,
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
  SwarmStallMonitor,
  type SwarmStallAlert,
  type SwarmStallMonitorOptions,
} from './swarmStallMonitor.js'

const MAX_MEMBERS_JSON_BYTES = 512 * 1024
const MAX_BOARD_JSONL_BYTES = 2 * 1024 * 1024
const TRANSCRIPT_TAIL_BYTES = 64 * 1024
/** Max bytes parsed per member per tick by the incremental telemetry scanner so large bursts never block the event loop. */
const MAX_TELEMETRY_DELTA_BYTES = 128 * 1024
/** Max total bytes drained per member during terminal `stopAndReadFinal` before marking `telemetryPartial: true`. */
const MAX_TELEMETRY_DRAIN_BYTES = 16 * 1024 * 1024
const MAX_TELEMETRY_REMAINDER_BYTES = 256 * 1024
const DEFAULT_POLL_MS = 750
/** Minimum interval between activity-only (`stepCount`/`activity`/`unreadCount`) emissions.
 * Structural changes (new posts, member status/role/error changes, channels, terminal phase)
 * still emit with 0ms delay (OCV5-819). */
export const SWARM_ACTIVITY_THROTTLE_MS = 2_500
/** Force a periodic full-posts keyframe when new posts accumulated since the last full frame
 *  so partial replays self-heal without bloating live_frames on activity-only churn (OCV5-837). */
export const SWARM_FULL_KEYFRAME_INTERVAL_EMITS = 120
export const SWARM_FULL_KEYFRAME_INTERVAL_MS = 300_000
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RawRosterMember {
  conversation_id?: unknown
  model?: unknown
  role?: unknown
  phase?: unknown
  wake_mode?: unknown
  wait_since?: unknown
  last_read_seq?: unknown
  killed?: unknown
  channels?: unknown
  workspace?: unknown
  workspace_mode?: unknown
  desired_state?: unknown
  desired_model?: unknown
  applied_model?: unknown
  last_nudged_seq?: unknown
  last_park_blocked_seq?: unknown
  added_by?: unknown
  runtime?: unknown
}

interface RawRoster {
  title?: unknown
  runtime?: unknown
  members?: unknown
  channels?: unknown
}

interface TranscriptSummary {
  stepCount: number
  status: SwarmMemberStatus | null
  activity?: string
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

export interface MemberTelemetrySnapshot {
  firstStepAt?: number
  lastActiveAt?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  toolCalls: number
  /** True when unread bytes remain (`byteOffset < fileSize`) or an oversized line/budget cap prevented complete counting. */
  partial?: boolean
  hasBacklog?: boolean
}

interface TelemetryCursor extends MemberTelemetrySnapshot {
  dev: number
  ino: number
  byteOffset: number
  lastSeenSize: number
  remainder: string
  decoder: StringDecoder
  droppedOversizedLine: boolean
  hadMalformedLine: boolean
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

function firstNonNegInt(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      return Math.floor(c)
    }
  }
  return 0
}

/** Extract token usage and tool-call counts from a single transcript JSONL step. */
export function extractStepTelemetry(step: Record<string, unknown>): {
  ts?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  toolCalls: number
} {
  let ts: number | undefined
  const createdAt = asStr(step.created_at)
  if (createdAt) {
    const parsedTs = Date.parse(createdAt)
    if (Number.isFinite(parsedTs)) ts = parsedTs
  }

  const meta = recordOf(step.metadata)
  const usage =
    recordOf(step.usage) ??
    recordOf(step.token_usage) ??
    recordOf(step.metrics) ??
    recordOf(meta?.usage) ??
    recordOf(meta?.token_usage)

  const inputTokens = firstNonNegInt(
    usage?.input_tokens,
    usage?.inputTokens,
    usage?.prompt_tokens,
    usage?.promptTokens,
    usage?.promptTokenCount,
    step.input_tokens,
    step.inputTokens,
  )
  const outputTokens = firstNonNegInt(
    usage?.output_tokens,
    usage?.outputTokens,
    usage?.completion_tokens,
    usage?.completionTokens,
    usage?.candidatesTokenCount,
    step.output_tokens,
    step.outputTokens,
  )
  const cacheReadTokens = firstNonNegInt(
    usage?.cache_read_tokens,
    usage?.cacheReadTokens,
    usage?.cached_content_token_count,
    usage?.cachedContentTokenCount,
    step.cache_read_tokens,
    step.cacheReadTokens,
  )
  const thinkingTokens = firstNonNegInt(
    usage?.thinking_tokens,
    usage?.thinkingTokens,
    usage?.thoughts_tokens,
    usage?.thoughtsTokens,
    usage?.thoughts_token_count,
    usage?.thoughtsTokenCount,
    step.thinking_tokens,
    step.thinkingTokens,
    step.thoughts_tokens,
    step.thoughtsTokens,
  )

  let toolCalls = 0
  const stepType = asStr(step.type).toUpperCase()
  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
    toolCalls = step.tool_calls.length
  } else if (stepType === 'TOOL_CALL' || stepType === 'TOOL_USE') {
    toolCalls = 1
  }

  return { ts, inputTokens, outputTokens, cacheReadTokens, thinkingTokens, toolCalls }
}

function applyTelemetryLine(cursor: MemberTelemetrySnapshot, line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  try {
    const obj = recordOf(JSON.parse(trimmed))
    if (!obj) return false
    const delta = extractStepTelemetry(obj)
    if (delta.ts !== undefined) {
      if (cursor.firstStepAt === undefined || delta.ts < cursor.firstStepAt) {
        cursor.firstStepAt = delta.ts
      }
      if (cursor.lastActiveAt === undefined || delta.ts > cursor.lastActiveAt) {
        cursor.lastActiveAt = delta.ts
      }
    }
    cursor.inputTokens += delta.inputTokens
    cursor.outputTokens += delta.outputTokens
    cursor.cacheReadTokens += delta.cacheReadTokens
    cursor.thinkingTokens += delta.thinkingTokens
    cursor.toolCalls += delta.toolCalls
    return true
  } catch {
    return false
  }
}

/**
 * Incremental byte-offset telemetry scanner for member `transcript.jsonl` files (B7).
 *
 * - Uses per-member `StringDecoder('utf8')` so multi-byte UTF-8 characters split across
 *   chunk boundaries never corrupt into U+FFFD replacement characters.
 * - Tracks `hasBacklog` (`byteOffset < fileSize`) and `partial` (unread backlog or oversized
 *   line drop), so callers continue draining quiet large logs across ticks and NEVER emit a
 *   partial count disguised as an exact terminal total.
 */
export class IncrementalTranscriptTelemetryCache {
  private readonly cursors = new Map<string, TelemetryCursor>()
  private readonly maxChunkBytes: number
  private readonly maxDrainBytes: number

  constructor(maxChunkBytes = MAX_TELEMETRY_DELTA_BYTES, maxDrainBytes = MAX_TELEMETRY_DRAIN_BYTES) {
    this.maxChunkBytes = Math.max(4096, maxChunkBytes)
    this.maxDrainBytes = Math.max(this.maxChunkBytes, maxDrainBytes)
  }

  hasAnyBacklog(): boolean {
    for (const c of this.cursors.values()) {
      if (c.hasBacklog) return true
    }
    return false
  }

  private createCursor(st: Stats): TelemetryCursor {
    return {
      dev: st.dev,
      ino: st.ino,
      byteOffset: 0,
      lastSeenSize: st.size,
      remainder: '',
      decoder: new StringDecoder('utf8'),
      droppedOversizedLine: false,
      hadMalformedLine: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      toolCalls: 0,
      hasBacklog: st.size > 0,
      partial: st.size > 0,
    }
  }

  private computePartial(c: TelemetryCursor): boolean {
    // B7: 区分“读到物理 EOF”与“最后一条记录完整”——只要仍有未闭合/不可解析尾行或损坏行，
    // 必须诚实标记 partial=true，绝不将已解析小计伪装为完整总计。
    return Boolean(
      c.hasBacklog ||
        c.droppedOversizedLine ||
        c.hadMalformedLine ||
        c.remainder.trim().length > 0,
    )
  }

  private consumeTextChunk(cursor: TelemetryCursor, decoded: string, atEof: boolean): void {
    const combined = cursor.remainder + decoded
    const lastNewline = combined.lastIndexOf('\n')
    if (lastNewline >= 0) {
      const completePart = combined.slice(0, lastNewline)
      const trailing = combined.slice(lastNewline + 1)
      for (const line of completePart.split('\n')) {
        if (!applyTelemetryLine(cursor, line)) {
          cursor.hadMalformedLine = true
        }
      }
      if (trailing.length > MAX_TELEMETRY_REMAINDER_BYTES) {
        cursor.remainder = ''
        cursor.droppedOversizedLine = true
      } else {
        cursor.remainder = trailing
      }
    } else if (combined.length > MAX_TELEMETRY_REMAINDER_BYTES) {
      cursor.remainder = ''
      cursor.droppedOversizedLine = true
    } else {
      cursor.remainder = combined
    }

    // Only attempt to parse a trailing line without newline when we have reached EOF
    // and the trailing text is a complete JSON object (avoiding premature truncation mid-chunk).
    if (atEof && cursor.remainder.trim().endsWith('}')) {
      if (applyTelemetryLine(cursor, cursor.remainder)) {
        cursor.remainder = ''
      }
    }
  }

  scan(
    brainDir: string,
    memberConvId: string,
    opts?: { drainAll?: boolean; maxBytesBudget?: number },
  ): MemberTelemetrySnapshot | null {
    if (!CONVERSATION_ID_RE.test(memberConvId)) return null
    const resolved = resolveRegularFileWithinRoot(brainDir, [
      memberConvId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    ])
    if (!resolved) {
      this.cursors.delete(memberConvId)
      return null
    }

    const st = resolved.stat
    let cursor = this.cursors.get(memberConvId)
    const rotated =
      !cursor ||
      cursor.dev !== st.dev ||
      cursor.ino !== st.ino ||
      st.size < cursor.byteOffset
    if (rotated) {
      cursor = this.createCursor(st)
      this.cursors.set(memberConvId, cursor)
    }
    const c = cursor!
    c.lastSeenSize = st.size

    if (st.size === c.byteOffset) {
      c.hasBacklog = false
      c.partial = this.computePartial(c)
      return {
        firstStepAt: c.firstStepAt,
        lastActiveAt: c.lastActiveAt,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens,
        thinkingTokens: c.thinkingTokens,
        toolCalls: c.toolCalls,
        hasBacklog: false,
        partial: c.partial,
      }
    }

    let fd: number | null = null
    try {
      const flags =
        fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
        (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
      fd = openSync(resolved.fullPath, flags)
      const fst = fstatSync(fd)
      if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
        return null
      }
      const realRoot = realpathSync(brainDir)
      const realFile = realpathSync(resolved.fullPath)
      if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
        return null
      }
      c.lastSeenSize = fst.size

      const budget = opts?.drainAll
        ? Math.max(this.maxChunkBytes, opts.maxBytesBudget ?? this.maxDrainBytes)
        : Math.max(4096, opts?.maxBytesBudget ?? this.maxChunkBytes)
      let bytesBudgetLeft = budget

      while (c.byteOffset < fst.size && bytesBudgetLeft > 0) {
        const toRead = Math.min(fst.size - c.byteOffset, this.maxChunkBytes, bytesBudgetLeft)
        if (toRead <= 0) break
        const buf = Buffer.allocUnsafe(toRead)
        let readTotal = 0
        while (readTotal < toRead) {
          const n = readSync(fd, buf, readTotal, toRead - readTotal, c.byteOffset + readTotal)
          if (n <= 0) break
          readTotal += n
        }
        if (readTotal <= 0) break
        c.byteOffset += readTotal
        bytesBudgetLeft -= readTotal
        const atEof = c.byteOffset >= fst.size
        const decoded = c.decoder.write(buf.subarray(0, readTotal))
        this.consumeTextChunk(c, decoded, atEof)
      }

      if (opts?.drainAll && c.byteOffset >= fst.size) {
        const flushed = c.decoder.end()
        if (flushed) {
          this.consumeTextChunk(c, flushed, true)
        }
        // Re-initialize fresh decoder in case more bytes are appended later.
        c.decoder = new StringDecoder('utf8')
      }

      c.hasBacklog = c.byteOffset < fst.size
      c.partial = this.computePartial(c)
    } catch {
      return null
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }

    return {
      firstStepAt: c.firstStepAt,
      lastActiveAt: c.lastActiveAt,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cacheReadTokens: c.cacheReadTokens,
      thinkingTokens: c.thinkingTokens,
      toolCalls: c.toolCalls,
      hasBacklog: c.hasBacklog,
      partial: c.partial,
    }
  }

  prune(activeMemberConvIds: ReadonlySet<string>): void {
    for (const key of this.cursors.keys()) {
      if (!activeMemberConvIds.has(key)) this.cursors.delete(key)
    }
  }
}

function hasSwarmWaitCall(calls: readonly unknown[]): boolean {
  return calls.some((c) => asStr(recordOf(c)?.name).toLowerCase() === 'swarm_wait')
}

/**
 * Inspect a member's compact `transcript.jsonl` tail to determine its live
 * status, step count, current activity, error state, and lightweight telemetry
 * (mirrors Antigravity CLI `board.StateOf`).
 */
export function parseMemberTranscriptTail(text: string | null): TranscriptSummary {
  const empty: TranscriptSummary = {
    stepCount: 0,
    status: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    toolCalls: 0,
  }
  if (!text) return empty
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return empty

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
  if (steps.length === 0) return empty

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
  const telBase = {
    ...(firstStepAt !== undefined ? { firstStepAt } : {}),
    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingTokens,
    toolCalls,
  }

  // Locate the latest meaningful turn boundary (USER_INPUT or SYSTEM_MESSAGE) to inspect current turn only.
  // Native Antigravity CLI workers wake on SYSTEM_MESSAGE nudges and never have USER_INPUT steps.
  let turnStart = 0
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const t = asStr(steps[i]?.type).toUpperCase()
    if (t === 'USER_INPUT' || t === 'SYSTEM_MESSAGE') {
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
      ...telBase,
      stepCount: maxStepIndex,
      status: 'waiting',
      activity: '步骤异常',
      failed: true,
      lastError: errText,
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
        ...telBase,
        stepCount: maxStepIndex,
        status: 'waiting',
        activity: '已完成本轮思考',
      }
    }
    if (calls.length > 0) {
      if (hasSwarmWaitCall(calls)) {
        return {
          ...telBase,
          stepCount: maxStepIndex,
          status: lastStatus === 'DONE' ? 'waiting' : 'working',
          activity: '等待讨论板消息',
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
  const lastPlannerCalls =
    lastPlanner && Array.isArray(lastPlanner.tool_calls) ? lastPlanner.tool_calls : []
  const isSwarmWaitDone =
    turnSteps.slice(-6).some((step) => {
      const name = asStr(step.tool_name || step.name).toLowerCase()
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
    }
  }

  // Otherwise inspect the active tool or latest planner call (handles both native
  // tool steps and RemoteSwarm `TOOL_CALL` records that store `tool_calls[]`).
  const directTool = asStr(last.tool_name || last.name)
  if (directTool) {
    return {
      ...telBase,
      stepCount: maxStepIndex,
      status: 'working',
      activity: describeToolActivity(directTool, recordOf(last.arguments ?? last.args)),
    }
  }
  if ((lastType === 'TOOL_CALL' || lastType === 'TOOL_USE') && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    if (hasSwarmWaitCall(last.tool_calls)) {
      return {
        ...telBase,
        stepCount: maxStepIndex,
        status: lastStatus === 'DONE' ? 'waiting' : 'working',
        activity: '等待讨论板消息',
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
  const wsStr = asStr(m.workspace) || asStr(m.workspace_mode) || undefined
  return wsStr ? { workspace: wsStr } : {}
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
  const totalPosts = all.length
  const posts = totalPosts > SWARM_MAX_POSTS ? all.slice(totalPosts - SWARM_MAX_POSTS) : all
  return { posts, totalPosts, headSeq, lastPostByAgent, postCountByChannel }
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
  const { posts, totalPosts, headSeq, lastPostByAgent, postCountByChannel } = parseBoardPosts(boardRaw)

  const rawMembersObj = recordOf(roster.members) ?? {}
  const remoteRoster = isRemoteSwarmRoster(roster, rawMembersObj)
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
    const incTelemetry =
      opts.telemetryCache && memberConvId && CONVERSATION_ID_RE.test(memberConvId)
        ? opts.telemetryCache.scan(opts.brainDir, memberConvId, { drainAll: opts.drainTelemetry })
        : null
    const wakeMode = asStr(m.wake_mode) || undefined
    const wakeModeLower = wakeMode?.toLowerCase()
    const rawPhase = asStr(m.phase).toUpperCase()
    let status: SwarmMemberStatus
    if (killed || rawPhase === 'KILLED') {
      status = 'killed'
    } else if (opts.phase === 'completed' || opts.phase === 'interrupted' || opts.phase === 'error') {
      status = transcript.status === 'killed' ? 'killed' : 'waiting'
    } else if (rawPhase === 'WAITING') {
      status = 'waiting'
    } else if (rawPhase === 'STOPPED') {
      status = 'stopped'
    } else if (remoteRoster) {
      // RemoteSwarm runtime authoritatively tracks in-flight execution in `phase`
      // even before a slow first tool call flushes transcript steps.
      if (rawPhase === 'RUNNING') {
        status = transcript.failed ? 'waiting' : 'working'
      } else if (transcript.status) {
        status = transcript.status
      } else if (wakeMode) {
        status = 'waiting'
      } else {
        status = 'working'
      }
    } else if (wakeModeLower === 'mentions' || wakeModeLower === 'all') {
      // Native CLI 1.5.8 keeps `phase: "RUNNING"` while parked in `swarm_wait`;
      // `wake_mode` ("mentions" | "all") is the authoritative sleeping signal.
      status = 'waiting'
    } else if (wakeModeLower === 'working' || (!wakeMode && rawPhase === 'RUNNING')) {
      status = transcript.failed ? 'waiting' : 'working'
    } else if (transcript.status) {
      status = transcript.status
    } else if (wakeMode) {
      status = 'waiting'
    } else {
      status = 'working'
    }

    const firstStepAt = incTelemetry?.firstStepAt ?? transcript.firstStepAt
    const lastActiveAt = incTelemetry?.lastActiveAt ?? transcript.lastActiveAt
    // When incremental cache is active, use its monotonic byte-0..offset counts directly (never Math.max with tail).
    const inputTokens = incTelemetry ? incTelemetry.inputTokens : transcript.inputTokens
    const outputTokens = incTelemetry ? incTelemetry.outputTokens : transcript.outputTokens
    const cacheReadTokens = incTelemetry ? incTelemetry.cacheReadTokens : transcript.cacheReadTokens
    const thinkingTokens = incTelemetry ? incTelemetry.thinkingTokens : transcript.thinkingTokens
    const toolCalls = incTelemetry ? incTelemetry.toolCalls : transcript.toolCalls
    const telemetryPartial = incTelemetry?.partial === true
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
    const activity =
      killed
        ? '已回收'
        : transcript.activity || (wakeModeLower === 'mentions' ? '等待 @提及' : status === 'waiting' ? '待命中' : '工作中…')

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
  /** Optional zero-token deterministic stall monitor configuration (enabled when `onStallDetected` is provided). */
  stallMonitor?: SwarmStallMonitorOptions
  /** Invoked when every live core member stays parked past the stall threshold without `[done]`. */
  onStallDetected?: (alert: SwarmStallAlert) => void
}

export function settleSwarmSnapshotTerminal(snap: SwarmSnapshot, phase: SwarmPhase): SwarmSnapshot {
  const { postsMode: _pm, deltaBaseSeq: _dbs, ...clean } = structuredClone(snap)
  return {
    ...clean,
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
  private revision = 0
  private startedAt: number | undefined
  private lastHash: string | null = null
  private lastStructuralHash: string | null = null
  private baselineActivationHash: string | null = null
  private lastStatSignature: string | null = null
  private trackedMemberConvIds: string[] = []
  private readonly telemetryCache = new IncrementalTranscriptTelemetryCache()
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
    this.stallMonitor = opts.onStallDetected ? new SwarmStallMonitor(opts.stallMonitor) : null
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
        this.pollOnce(false)
      }
    }, 15)
    this.backlogTimer.unref()
  }

  private evaluateStall(snap: SwarmSnapshot, now: number): void {
    if (this.stopped || !this.turnActive || !this.stallMonitor || !this.onStallDetected) return
    const alert = this.stallMonitor.evaluate(snap, now)
    if (!alert) return
    try {
      this.onStallDetected(alert)
    } catch {
      // Observer errors must never crash the adapter timer loop.
    }
  }

  private pollOnce(force: boolean): void {
    if (this.stopped) return
    const isDormantBaseline =
      !this.turnActive && this.seedBaselineOnStart && this.baselineActivationHash !== null
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
    this.lastStatSignature = statSig
    const nextRev = this.revision + 1
    const memberConvIds: string[] = []
    const ts = this.now()
    let snap = readAntigravitySwarmSnapshot({
      brainDir: this.brainDir,
      conversationId: this.conversationId,
      phase: 'running',
      revision: nextRev,
      startedAt: this.startedAt,
      now: ts,
      outMemberConvIds: memberConvIds,
      ...(isDormantBaseline ? {} : { telemetryCache: this.telemetryCache }),
    })
    if (!snap) return
    this.setTrackedMembers(memberConvIds)
    this.lastStatSignature = this.computeStatSignature()
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
      const activeMemberConvIds: string[] = []
      const activeSnap = readAntigravitySwarmSnapshot({
        brainDir: this.brainDir,
        conversationId: this.conversationId,
        phase: 'running',
        revision: nextRev,
        startedAt: this.startedAt,
        now: ts,
        outMemberConvIds: activeMemberConvIds,
        telemetryCache: this.telemetryCache,
      })
      if (activeSnap) {
        snap = activeSnap
        this.setTrackedMembers(activeMemberConvIds)
        this.lastStatSignature = this.computeStatSignature()
      }
    }
    if (this.telemetryCache.hasAnyBacklog()) {
      this.scheduleBacklogCatchup()
    }
    const hash = snapshotFingerprint(snap)
    const structHash = structuralFingerprint(snap)
    if (this.startedAt === undefined) {
      this.startedAt = snap.updatedAt
      snap.startedAt = this.startedAt
    }
    if (hash === this.lastHash) {
      if (this.turnActive) this.evaluateStall(snap, ts)
      return
    }
    const isStructuralChange = !this.emittedInTurn || structHash !== this.lastStructuralHash
    this.turnActive = true
    this.lastHash = hash
    this.lastStructuralHash = structHash

    if (!isStructuralChange && this.activityThrottleMs > 0) {
      const elapsed = ts - this.lastEmitAt
      if (elapsed < this.activityThrottleMs) {
        // Keep `lastSnapshot` fresh (without advancing wire revision yet) and coalesce
        // trailing activity update so UI stays responsive without flooding PG/WS.
        this.lastSnapshot = { ...snap, revision: this.revision }
        this.scheduleThrottledActivityEmit(snap, this.activityThrottleMs - elapsed)
        this.evaluateStall(snap, ts)
        return
      }
    }

    this.revision = nextRev
    this.lastSnapshot = snap
    this.emitWireSnapshot(snap, false)
    this.evaluateStall(snap, ts)
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
      now: this.now(),
      telemetryCache: this.telemetryCache,
      drainTelemetry: true,
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
  return structuredClone(compactSwarmSnapshotToByteBudget(snap, maxBytes))
}

export function buildDurableSwarmBoardInput(
  snap: SwarmSnapshot,
  maxBytes: number = 13_000,
): DurableSwarmBoardInput {
  return durableEnvelopeFor(compactSwarmSnapshotForPersistence(snap, maxBytes))
}
