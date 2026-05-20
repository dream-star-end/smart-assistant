/**
 * CcbMessageParser — parses stream-json output from CCB subprocess
 * and emits structured SessionStreamEvent events.
 *
 * Extracted from SessionManager._runOneTurn to separate CCB-specific
 * message parsing from session orchestration concerns.
 */
import { performance } from 'node:perf_hooks'
import { Buffer } from 'node:buffer'
import type { OutboundContentBlock } from '@openclaude/protocol'
import type { SdkMessage } from './subprocessRunner.js'

/** Hard cap on accumulated main-agent thinking bytes per turn. Sonnet 4.6
 *  adaptive thinking can exceed 100 KB on complex turns; we don't want to
 *  hold that much in process memory or pump it through the v3 sink. 8 KB
 *  is enough for a "what was the model reasoning" snippet and keeps body
 *  well under the 256 KB sink cap when combined with assistant text.
 *
 *  Truncation guarantees:
 *    - UTF-8 code-point safe: we never split a multi-byte sequence (would
 *      produce U+FFFD on decode).
 *    - NOT grapheme-cluster safe: ZWJ family sequences (e.g., 👨‍👩‍👧)
 *      may be truncated mid-cluster, leaving a visually incomplete but
 *      valid Unicode string. Acceptable for a debug snippet.
 *    - Tail marker `…[truncated]` is always within the hard cap because
 *      we manage `MAX_THINKING_CONTENT_BYTES = MAX - tailBytes` separately. */
export const MAX_THINKING_BUFFER_BYTES = 8 * 1024
const THINKING_TRUNCATE_TAIL = '…[truncated]'
const THINKING_TAIL_BYTES = Buffer.byteLength(THINKING_TRUNCATE_TAIL, 'utf8')
const MAX_THINKING_CONTENT_BYTES = MAX_THINKING_BUFFER_BYTES - THINKING_TAIL_BYTES

/** Per-tool budget for the persisted tool snapshot that's piped through the
 *  v3 sink as part of the server-authored turn payload. These caps are
 *  intentionally tight — sink body cap is 256 KB and one turn can have many
 *  tool calls. Output is the most variable (Bash stdout, Grep results, file
 *  reads), inputJson is usually small but Edit/Write can carry large strings,
 *  inputPreview is a debug-friendly truncated string. */
const PARSER_TOOL_OUTPUT_MAX_BYTES = 4 * 1024
const PARSER_TOOL_INPUT_JSON_MAX_BYTES = 8 * 1024
const PARSER_TOOL_INPUT_PREVIEW_MAX_CHARS = 500

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multi-
 * byte sequence. Walks back from the byte budget to the last UTF-8 leading
 * byte (continuation bytes are 0x80-0xBF). Handles 4-byte sequences (emoji,
 * Han Extended) correctly because they're contiguous at the byte level.
 */
function sliceUtf8Safe(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  // buf[end] safely indexable: end < buf.length (since buf.length > maxBytes >= end)
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** Permission request from CCB (via stdio control_request protocol) */
export interface PermissionRequest {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** Suggested permission rules the user can adopt */
  permissionSuggestions?: unknown[]
}

export type SessionStreamEvent =
  | { kind: 'block'; block: OutboundContentBlock }
  | {
      kind: 'final'
      meta?: {
        cost?: number
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
        totalCost?: number
        turn?: number
        /** Anthropic API stop_reason, extracted from CCB result row.
         *  Values: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
         *  | 'pause_turn' | 'refusal'. Used by sessionManager for phantom
         *  judgment and by frontend for empty-turn notice text. */
        stopReason?: string
      }
    }
  | { kind: 'error'; error: string }
  | { kind: 'permission_request'; request: PermissionRequest }
  // 当前 turn 的 backend-side 非流式阶段状态(目前仅 'compacting' / null)。
  // 由 CCB stdout `{type:'system', subtype:'status', status:'compacting'|null}`
  // 触发,gateway 上层包装成 `outbound.turn_status` 帧推给前端。受控枚举,
  // 不透传任意 SDK status —— 防协议被 CCB 内部状态污染。
  | { kind: 'turn_status'; status: 'compacting' | null }
  // PR2 v1.0.66 — codex turn 终态侧信道事件,sessionManager 在收到 codex
  // RunnerMessage{type:'result', requestId} 时**额外**发一帧(parser 仍照常发
  // kind:'final')。server.ts 把这个 kind 路由到 outbound.codex_billing 帧给 master
  // 做真扣费 settle。其它 runner 路径不会发这个 kind。
  | {
      kind: 'codex_billing'
      requestId: string
      status: 'success' | 'error'
      durationMs: number
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
        reasoning_output_tokens?: number
      }
      errorReason?: string
      // Issue A v1.0.108 — codex account/rateLimits/updated 快照,piggy-back 到 billing
      // 终态帧让 master.userChatBridge 落库到 claude_accounts。utilization 0..100,
      // resetsAt ISO8601(runner 已把 epoch sec 转 ISO,bridge 不再二次解析)。
      rateLimits?: {
        util5h?: number
        reset5h?: string
        util7d?: number
        reset7d?: string
      }
    }

/** Detected tool_use that may need bridging (CronCreate, CronDelete, etc.) */
export interface DetectedToolUse {
  name: string
  id: string
  input: Record<string, any>
}

/** Detected tool_result for completed tool calls */
export interface DetectedToolResult {
  toolUseId: string
  toolName: string
  preview: string
  isError: boolean
  /** ms between tool_use finalization and tool_result arrival.
   *  0 if the tool_use was not observed in this parser (e.g. stale result). */
  durationMs: number
  /** Truncated preview of tool input at finalization (<=500 chars). */
  inputPreview?: string
}

/** Snapshot of one completed top-level tool call within a turn. Captured by
 *  the parser so SessionManager can hand it to v3MasterSink, which writes it
 *  as a server-authored 'tool' message — the durable copy that survives
 *  refresh / mobile-bg recovery. Subagent-issued tools (parentToolUseId set)
 *  are intentionally excluded; their durability is owned by the parent
 *  Agent card and tracked separately (Phase 2). */
export interface TurnToolEntry {
  /** Anthropic tool_use_id — also serves as the stable client blockId */
  toolUseId: string
  /** Same value as toolUseId, kept as a separate field so server-authored
   *  payloads can refer to it by an explicit name without overloading
   *  toolUseId across protocol layers. */
  blockId: string
  toolName: string
  /** Possibly-capped tool input. May be a structured object or a JSON-encoded
   *  string when the original exceeded PARSER_TOOL_INPUT_JSON_MAX_BYTES. */
  inputJson: unknown
  /** Truncated string preview of the input for compact rendering */
  inputPreview: string
  /** Tool stdout / textual output, capped to PARSER_TOOL_OUTPUT_MAX_BYTES */
  output: string
  isError: boolean
  /** ms between tool_use finalization and tool_result arrival; 0 if unknown */
  durationMs: number
  /** Wall-clock timestamp (Date.now ms) when the tool_result arrived */
  ts: number
  inputTruncated?: boolean
  outputTruncated?: boolean
}

/** Accumulated turn result stats */
export interface TurnResult {
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  assistantText: string
  /** Main-agent thinking text accumulated this turn from thinking_delta
   *  events, capped at MAX_THINKING_BUFFER_BYTES. Empty string when the
   *  model didn't emit any thinking blocks (most non-Sonnet/non-extended-
   *  thinking turns). Subagent thinking is excluded — same rule as
   *  assistantText. Used by sessionManager.persistServerAuthoredTurn to
   *  pass thinking through the v3 sink so it survives mobile-bg recovery
   *  and server-wins overwrites. */
  thinkingText: string
  /** True if CCB marked the result as an error (e.g. API failure) */
  isError: boolean
  /** Anthropic API stop_reason from CCB's result row; null if CCB didn't
   *  populate it (older CCB or pre-termination crash). Used for three-state
   *  phantom judgment and for precise empty-turn UI notices. */
  stopReason: string | null
  /** num_turns from CCB result row, for diagnostics. null when absent. */
  numTurns: number | null
  /** True when CCB's result row contains an error indicating the --resume
   *  session id no longer exists on disk (e.g. "No conversation found with
   *  session ID: ..."). SessionManager uses this as a signal to strip the
   *  stale entry from resume-map so the next submit() starts a fresh session
   *  instead of perpetually re-requesting the same non-existent conversation. */
  staleResumeId: boolean
  /** Top-level (parentToolUseId-empty) tool calls that completed within this
   *  turn, in order of tool_result arrival. Subagent-issued tools are NOT
   *  included; their durability is the Agent card's responsibility. Empty
   *  array when the turn made no tool calls. SessionManager passes this to
   *  v3MasterSink so the sink can write each as a server-authored 'tool'
   *  message — the durable record that survives refresh. */
  tools: TurnToolEntry[]
}

/** Apply per-tool byte/char caps for the persisted tool snapshot. Mutates a
 *  fresh shallow copy of the entry — caller passes raw values, gets back the
 *  capped version with `inputTruncated` / `outputTruncated` flags set when
 *  truncation actually happened. UTF-8 code-point safe. */
function _capToolEntry(raw: {
  toolUseId: string
  blockId: string
  toolName: string
  inputJson: unknown
  inputPreview: string
  output: string
  isError: boolean
  durationMs: number
  ts: number
}): TurnToolEntry {
  let inputJson = raw.inputJson
  let inputTruncated = false
  // inputJson cap: serialize, measure, if too big keep as truncated string.
  // Avoid mutating user-visible structure beyond the cap — sending the full
  // JSON-encoded string with a sentinel suffix is the simplest way for the
  // frontend to render "this was too big" without per-field heuristics.
  try {
    const serialized = typeof inputJson === 'string' ? inputJson : JSON.stringify(inputJson)
    if (Buffer.byteLength(serialized, 'utf8') > PARSER_TOOL_INPUT_JSON_MAX_BYTES) {
      inputJson = sliceUtf8Safe(serialized, PARSER_TOOL_INPUT_JSON_MAX_BYTES) + '…[truncated]'
      inputTruncated = true
    }
  } catch {
    // Unserializable input (cycles / BigInt) — drop to a sentinel string.
    inputJson = '[unserializable]'
    inputTruncated = true
  }

  let inputPreview = raw.inputPreview
  if (inputPreview.length > PARSER_TOOL_INPUT_PREVIEW_MAX_CHARS) {
    inputPreview = inputPreview.slice(0, PARSER_TOOL_INPUT_PREVIEW_MAX_CHARS) + '…'
  }

  let output = raw.output
  let outputTruncated = false
  if (Buffer.byteLength(output, 'utf8') > PARSER_TOOL_OUTPUT_MAX_BYTES) {
    output = sliceUtf8Safe(output, PARSER_TOOL_OUTPUT_MAX_BYTES) + '…[truncated]'
    outputTruncated = true
  }

  const entry: TurnToolEntry = {
    toolUseId: raw.toolUseId,
    blockId: raw.blockId,
    toolName: raw.toolName,
    inputJson,
    inputPreview,
    output,
    isError: raw.isError,
    durationMs: raw.durationMs,
    ts: raw.ts,
  }
  if (inputTruncated) entry.inputTruncated = true
  if (outputTruncated) entry.outputTruncated = true
  return entry
}

/**
 * Stateful parser for one CCB turn.
 * Create a new instance per turn; call `parse(msg)` for each SdkMessage.
 */
export class CcbMessageParser {
  /** tool_use id → name mapping (persists across turns, passed in from session) */
  private toolUseIdToName: Map<string, string>
  /** Streaming tool_use state within this turn */
  private streamingToolUses = new Map<
    string,
    { name: string; partialJson: string; done: boolean }
  >()
  /** content_block index → tool_use id (for routing input_json_delta) */
  private indexToToolId = new Map<number, string>()
  /** tool_use id → timing/preview captured at finalization (for tool.called metrics) */
  private toolUseMeta = new Map<string, { startAt: number; inputPreview?: string }>()
  /** Top-level tool_use snapshots awaiting their matching tool_result. Keyed
   *  by tool_use id. Populated in `_handleAssistant` only when parentToolUseId
   *  is empty (main agent), drained in `_handleUser` when a tool_result with
   *  the same id arrives. Subagent tools never enter this map. */
  private pendingToolUses = new Map<
    string,
    { toolName: string; inputJson: unknown; inputPreview: string; inputTruncated: boolean }
  >()
  /** Top-level tools that have completed (both tool_use and tool_result seen)
   *  within this turn, in arrival order of the tool_result. Surfaced in the
   *  TurnResult.tools field at turn end so SessionManager can persist them
   *  via the v3 sink. Public so the interrupt/crash path in SessionManager
   *  can flush whatever completed before CCB died. */
  public completedTools: TurnToolEntry[] = []
  /** De-duplicate emitted tool_results within a turn */
  private emittedToolResultIds = new Set<string>()
  /** Count of tool_use blocks sent but not yet matched by a tool_result */
  public pendingToolCalls = 0
  /** Assistant text accumulated in this turn */
  public assistantBuf = ''
  /** Main-agent thinking text accumulated in this turn from thinking_delta
   *  events. Capped at MAX_THINKING_BUFFER_BYTES with a `…[truncated]` tail.
   *  Subagent thinking (parentToolUseId set) is excluded — it lives inside
   *  child block rendering, not in the parent turn's authoritative buffer. */
  public thinkingBuf = ''
  /** Running byte count of the CONTENT in thinkingBuf (excludes the tail
   *  marker). Capped at MAX_THINKING_CONTENT_BYTES so adding the tail later
   *  is guaranteed to fit under the hard cap. */
  private thinkingBufBytes = 0
  /** Once true, all subsequent thinking_delta events for this turn skip
   *  accumulation. The tail marker is appended exactly once on the first
   *  delta that pushes us over the content budget. */
  private thinkingTruncated = false
  /** Whether this turn has been finalized */
  public finalized = false
  /** Accumulated turn result (set when finalized) */
  public turnResult: TurnResult | null = null

  private onEvent: (e: SessionStreamEvent) => void
  private onToolUse?: (tool: DetectedToolUse) => void
  private onToolResult?: (result: DetectedToolResult) => void
  private onFinish: (result: TurnResult | null) => void

  /** V3 v7 — canonical assistant row id for this turn, minted server-side
   *  as `srv-${peerId}-${agentId}-t${turnIndex}` (agentId segment added
   *  2026-05-13 to disambiguate mid-chat model switches; see
   *  sessionManager.runOneTurnWithRetry for the full rationale) and shared
   *  with the Phase 0.1 turn-end takeover. Stamped on every main-agent
   *  text block emitted by this parser (parentToolUseId empty) so client +
   *  server tape agree on row id from the first chunk on. Undefined for
   *  non-v7 callers — client falls back to legacy `m-*` mint. */
  public assistantMessageId?: string
  /** Same as `assistantMessageId` but for thinking rows
   *  (`srv-${peerId}-${agentId}-t${turnIndex}-thinking`). */
  public thinkingMessageId?: string
  /** V3 v7.1 — factory for canonical tool row ids minted server-side:
   *  `srv-${peerId}-${agentId}-t${turnIndex}-tool-${blockId}`. Stamped on every
   *  main-agent top-level tool_use block this parser emits (partial start,
   *  input_json_delta partials, and the finalized snapshot in _handleAssistant).
   *  Matches master's id format in internalServerAuthored.ts so client +
   *  server tape agree on tool row id from frame 1, eliminating the
   *  duplicate-tool-row bug that surfaced after v1.0.134's v7 cutover
   *  (text/thinking aligned but tool rows missed → server-tool ts > client-
   *  tool ts after sort, server tools appeared AFTER assistant text).
   *  Subagent tool_use omits this — subagent content lives inside an
   *  Agent card's childBlocks. Undefined for non-v7 callers (personal /
   *  legacy paths) — block.messageId stays undefined and client falls
   *  back to legacy `m-*` mint. */
  public toolMessageIdFactory?: (blockId: string) => string

  constructor(opts: {
    toolUseIdToName: Map<string, string>
    onEvent: (e: SessionStreamEvent) => void
    onToolUse?: (tool: DetectedToolUse) => void
    onToolResult?: (result: DetectedToolResult) => void
    onFinish: (result: TurnResult | null) => void
    /** Running totals from session (for computing totalCost in final meta).
     *  - totalCostUSD: gateway-side per-session cumulative cost (we mutate +=delta)
     *  - turns: gateway-side per-session turn counter (we mutate +=1)
     *  - _lastCcbCumulativeCost: last value of CCB's `total_cost_usd` we observed.
     *    CCB reports session-cumulative cost (not per-turn), so per-turn cost
     *    is computed as `cumulative - _lastCcbCumulativeCost`. Reset detection
     *    (CCB process restart) is handled in `_handleResult`. */
    sessionTotals: {
      totalCostUSD: number
      turns: number
      _lastCcbCumulativeCost: number
    }
    /** V3 v7 — canonical assistant/thinking message ids minted by caller
     *  (`runOneTurnWithRetry`) once per user turn. See field-level docs. */
    assistantMessageId?: string
    thinkingMessageId?: string
    /** V3 v7.1 — see `toolMessageIdFactory` field-level docs. */
    toolMessageIdFactory?: (blockId: string) => string
  }) {
    this.toolUseIdToName = opts.toolUseIdToName
    this.onEvent = opts.onEvent
    this.onToolUse = opts.onToolUse
    this.onToolResult = opts.onToolResult
    this.onFinish = opts.onFinish
    this._sessionTotals = opts.sessionTotals
    this.assistantMessageId = opts.assistantMessageId
    this.thinkingMessageId = opts.thinkingMessageId
    this.toolMessageIdFactory = opts.toolMessageIdFactory
  }

  private _sessionTotals: {
    totalCostUSD: number
    turns: number
    _lastCcbCumulativeCost: number
  }

  /**
   * Parse a single CCB SdkMessage. Call this for each 'message' event
   * from SubprocessRunner.
   */
  parse(msg: SdkMessage): void {
    if (this.finalized) {
      // bash_output_tail 是 CCB 的后台 bash keepalive 信号:TaskOutput 1Hz
      // poller 在跨 turn 的整个 bash 生命周期内持续 emit。它不修改 parser
      // 任何累积器(没有 totals / buffers / 流式装配),只是把 tail 快照转成
      // tool_output_tail block 派发出去。turn 结束后必须放行,否则前端会
      // 卡在第一行——bg bash 完成时间晚于 agent 回复时是常态。
      if (
        (msg as any)?.type === 'system' &&
        (msg as any)?.subtype === 'bash_output_tail'
      ) {
        try {
          this._parseInner(msg)
        } catch (err) {
          this.onEvent({ kind: 'error', error: String(err) })
        }
      }
      return
    }
    try {
      this._parseInner(msg)
    } catch (err) {
      this.onEvent({ kind: 'error', error: String(err) })
    }
  }

  /** Mark this turn as done (e.g. on error/timeout) */
  finish(): void {
    if (this.finalized) return
    this.finalized = true
    this.onFinish(this.turnResult)
  }

  private _parseInner(msg: SdkMessage): void {
    // CCB stamps every SDK message with parent_tool_use_id. Non-null means
    // this message was produced by a subagent spawned via the Agent tool.
    // We forward it untouched on every emitted block so the frontend can
    // route subagent content into the owning Agent card instead of the
    // main stream. Main-agent messages carry null/undefined and flow to
    // the main stream as before.
    //
    // Extracted BEFORE the system early-return so the bash_output_tail
    // branch below can attach parent routing — subagent Bash tails must
    // land in the Agent card's child Bash tool, not the main stream.
    const raw = msg as any
    const parentToolUseId: string | undefined =
      typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0
        ? raw.parent_tool_use_id
        : undefined

    // ── system messages ──
    // Most system subtypes (init / success / error / task_*) are ignored by
    // the gateway; CCB emits them for SDK consumers like VS Code and Scuttle
    // that listen on stdout directly. We surface a small whitelist:
    //   - `bash_output_tail` — 1 Hz snapshot tail of long-running Bash output,
    //     routed via OutboundContentBlock 'tool_output_tail' (see protocol).
    //   - `status` — coarse non-streaming turn phase (currently only
    //     `'compacting' | null`). Mapped to a controlled enum and surfaced
    //     as `kind: 'turn_status'`; server.ts wraps into `outbound.turn_status`.
    //     CCB raw status string is **not** transparently forwarded — only the
    //     mapped values cross the protocol boundary.
    if (msg.type === 'system') {
      if (raw.subtype === 'bash_output_tail') {
        const toolUseId = raw.tool_use_id
        if (typeof toolUseId === 'string' && toolUseId.length > 0) {
          const block: Record<string, unknown> = {
            kind: 'tool_output_tail',
            toolUseBlockId: toolUseId,
            tail: typeof raw.tail === 'string' ? raw.tail : '',
            totalBytes: typeof raw.total_bytes === 'number' ? raw.total_bytes : 0,
            truncatedHead: !!raw.truncated_head,
          }
          if (parentToolUseId) block.parentToolUseId = parentToolUseId
          this.onEvent({ kind: 'block', block: block as any })
        }
      } else if (raw.subtype === 'status') {
        // CCB SDKStatus 当前只有 'compacting' | null(coreSchemas.ts:1268)。
        // 任何其它值都 normalize 到 null —— 防止未来 CCB 加新 status 字面量
        // 时,gateway 没有显式 mapping 就把未审过的字符串塞给前端。
        const mapped: 'compacting' | null =
          raw.status === 'compacting' ? 'compacting' : null
        this.onEvent({ kind: 'turn_status', status: mapped })
      }
      return
    }

    // ── stream_event: streaming partial deltas ──
    if (msg.type === 'stream_event') {
      this._handleStreamEvent(msg, parentToolUseId)
      return
    }

    // ── assistant snapshot: finalize tool_use with complete input ──
    if (msg.type === 'assistant') {
      this._handleAssistant(msg, parentToolUseId)
      return
    }

    // ── user snapshot: tool_result ──
    if (msg.type === 'user') {
      this._handleUser(msg, parentToolUseId)
      return
    }

    // ── result: turn complete ──
    if (msg.type === 'result') {
      this._handleResult(msg)
      return
    }

    // ── control_request: permission prompt from CCB stdio protocol ──
    if (msg.type === 'control_request') {
      this._handleControlRequest(msg)
      return
    }
    // assistant_error / status / etc: ignore
    // tool_progress: intentionally ignored. CCB emits this as a granular
    // heartbeat for long-running Bash/PowerShell runs and (per CCB core
    // schemas) carries its own parent_tool_use_id. Out of scope for the
    // subagent-visibility routing — we define "subagent-attributable content"
    // as text / thinking / tool_use / tool_result only. Progress ticks
    // produce no user-visible artifact here today, so surfacing them would
    // require matching protocol + frontend rendering work. Revisit if we
    // add a dedicated bash-progress visualization.
  }

  private _handleControlRequest(msg: SdkMessage): void {
    const raw = msg as any
    const request = raw.request
    if (!request || request.subtype !== 'can_use_tool') return

    this.onEvent({
      kind: 'permission_request',
      request: {
        requestId: raw.request_id,
        toolName: request.tool_name ?? 'unknown',
        toolUseId: request.tool_use_id,
        input: request.input ?? {},
        permissionSuggestions: request.permission_suggestions,
      },
    })
  }

  private _handleStreamEvent(msg: SdkMessage, parentToolUseId?: string): void {
    const ev = (msg as any).event
    if (!ev || typeof ev !== 'object') return

    // Helper: only include parentToolUseId in emitted blocks when it exists.
    // Keeps main-agent blocks byte-identical to the pre-change wire format
    // (no extra field = old clients behave as before).
    const withParent = <T extends Record<string, unknown>>(block: T): T =>
      parentToolUseId ? ({ ...block, parentToolUseId } as T) : block

    // V3 v7 — canonical-id stamper for main-agent text/thinking blocks.
    // Returns block unchanged when (a) this is a subagent block, or
    // (b) the parser was constructed without canonical ids (personal-version
    // legacy path) — old client behavior preserved.
    const stampMainAgentId = <T extends Record<string, unknown>>(
      block: T,
      id: string | undefined,
    ): T => (parentToolUseId || !id ? block : ({ ...block, messageId: id } as T))

    // V3 v7.1 — canonical-id stamper for main-agent top-level tool_use blocks.
    // Mirrors `stampMainAgentId` but pulls the id from the factory (parser
    // doesn't know blockId at construction). Same skip conditions: subagent
    // tool_use (parentToolUseId set), no factory configured, or no blockId.
    const stampToolUseId = <T extends Record<string, unknown>>(
      block: T,
      blockId: string | undefined,
    ): T => {
      if (parentToolUseId || !this.toolMessageIdFactory || !blockId) return block
      return { ...block, messageId: this.toolMessageIdFactory(blockId) } as T
    }

    if (ev.type === 'content_block_start') {
      const cb = ev.content_block
      if (cb?.type === 'tool_use' && cb.id && cb.name) {
        this.toolUseIdToName.set(cb.id, cb.name)
        this.streamingToolUses.set(cb.id, { name: cb.name, partialJson: '', done: false })
        if (typeof ev.index === 'number') this.indexToToolId.set(ev.index, cb.id)
        this.onEvent({
          kind: 'block',
          block: stampToolUseId(
            withParent({
              kind: 'tool_use',
              blockId: cb.id,
              toolName: cb.name,
              inputPreview: '',
              partial: true,
            }),
            cb.id,
          ),
        })
      }
      return
    }

    if (ev.type === 'content_block_delta') {
      const delta = ev.delta
      if (!delta) return
      if (delta.type === 'text_delta' && delta.text) {
        // Defensive: ensure text is always a string (CCB may send nested objects)
        const textStr = typeof delta.text === 'string' ? delta.text : JSON.stringify(delta.text)
        // Only accumulate main-agent text into assistantBuf; subagent text
        // must not pollute the parent turn's stored assistant message.
        if (!parentToolUseId) this.assistantBuf += textStr
        this.onEvent({
          kind: 'block',
          block: stampMainAgentId(
            withParent({ kind: 'text', text: textStr }),
            this.assistantMessageId,
          ),
        })
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        const thinkStr =
          typeof delta.thinking === 'string' ? delta.thinking : JSON.stringify(delta.thinking)
        // Accumulate main-agent thinking into thinkingBuf for v3 server-
        // authored persistence. Subagent thinking (parentToolUseId set) is
        // streamed to UI only — never merged into the parent's stored turn.
        // Truncation: hard 8 KB cap with UTF-8 code-point-safe slice + tail
        // marker. UI streams the FULL delta unchanged regardless of cap state;
        // only the persisted buffer is bounded.
        if (!parentToolUseId && !this.thinkingTruncated) {
          const deltaBytes = Buffer.byteLength(thinkStr, 'utf8')
          if (this.thinkingBufBytes + deltaBytes <= MAX_THINKING_CONTENT_BYTES) {
            this.thinkingBuf += thinkStr
            this.thinkingBufBytes += deltaBytes
          } else {
            const remaining = MAX_THINKING_CONTENT_BYTES - this.thinkingBufBytes
            if (remaining > 0) {
              const partial = sliceUtf8Safe(thinkStr, remaining)
              this.thinkingBuf += partial
              this.thinkingBufBytes += Buffer.byteLength(partial, 'utf8')
            }
            // thinkingBufBytes ≤ MAX_THINKING_CONTENT_BYTES guaranteed, so
            // total bytes after appending tail ≤ MAX_THINKING_BUFFER_BYTES.
            this.thinkingBuf += THINKING_TRUNCATE_TAIL
            this.thinkingTruncated = true
          }
        }
        this.onEvent({
          kind: 'block',
          block: stampMainAgentId(
            withParent({ kind: 'thinking', text: thinkStr }),
            this.thinkingMessageId,
          ),
        })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolId = this.indexToToolId.get(ev.index as number)
        const tool = toolId ? this.streamingToolUses.get(toolId) : undefined
        if (tool && delta.partial_json.length > 0) {
          // Delta-based wire protocol: each partial tool_use frame carries
          // ONLY the new chars produced by this one SDK event, plus the
          // offset (length of the accumulator BEFORE this delta). The web
          // side appends gated by `offset === current.length`, so dup /
          // out-of-order / late-join frames degrade cleanly instead of
          // splicing into the wrong position.
          //
          // Bandwidth is O(n) in content size — previously O(n²) because
          // every frame re-sent the cumulative buffer.
          //
          // `tool.partialJson` accumulator is still maintained internally
          // ONLY to compute the inputPreview slice. It is NEVER emitted on
          // the wire. Final tool input ground truth lives in the SDK's
          // assistant snapshot and is emitted via the `partial: false`
          // frame's `inputJson` field in `_handleAssistant`.
          const offsetBefore = tool.partialJson.length
          tool.partialJson += delta.partial_json
          const block: Record<string, unknown> = {
            kind: 'tool_use',
            blockId: toolId!,
            toolName: tool.name,
            inputPreview: tool.partialJson.slice(0, 400),
            partialJsonDelta: delta.partial_json,
            partialJsonOffset: offsetBefore,
            partial: true,
          }
          this.onEvent({
            kind: 'block',
            block: stampToolUseId(withParent(block as any), toolId!),
          })
        }
      }
      return
    }

    if (ev.type === 'content_block_stop') {
      const toolId = this.indexToToolId.get(ev.index as number)
      if (toolId) {
        const tool = this.streamingToolUses.get(toolId)
        if (tool) tool.done = true
      }
      return
    }
    // message_start / message_delta / message_stop: ignore
  }

  private _handleAssistant(msg: SdkMessage, parentToolUseId?: string): void {
    const content = (msg as any).message?.content
    if (!Array.isArray(content)) return
    // Synthetic API-error assistant messages (CCB's getAssistantMessageFromError)
    // mint a local assistant without going through stream_event, so their text
    // blocks would be dropped here (the stream_event path is the only one that
    // normally emits text). Detect via SDKAssistantMessage.error being set —
    // do NOT key on model==='<synthetic>' because local_command_output uses
    // the same sentinel model and would be misclassified as an error.
    //
    // Without this special-case the frontend sees 0 blocks + hardcoded
    // stop_reason='stop_sequence' and falls into the "模型命中停止序列结束本轮"
    // empty-turn notice, AND sessionManager's AUTH_KEYWORDS_RE / AUTH_ERROR_PREFIX_RE
    // match on an empty assistantBuf so the token-refresh path never triggers.
    const rawMsg = msg as any
    const isSyntheticError = typeof rawMsg.error === 'string'
    for (const c of content) {
      if (c?.type === 'tool_use' && c.id) {
        this.toolUseIdToName.set(c.id, c.name ?? 'unknown')
        const inputRaw = c.input ?? {}
        const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(inputRaw)
        const inputPreview = inputStr.slice(0, 400)

        // Notify about detected tool_use for bridging. Only main-agent
        // tool_use events should trigger host-side bridging (CronCreate,
        // Agent→send_to_agent, etc.) — subagent-issued tools already run
        // inside the subagent's own CCB process and must not double-fire
        // host bridges.
        if (!parentToolUseId && this.onToolUse && c.name) {
          this.onToolUse({ name: c.name, id: c.id, input: inputRaw as Record<string, any> })
        }

        // Cap inputJson to avoid sending excessively large payloads to the frontend.
        // For tools with large content fields (Write, Edit), truncate string values.
        let inputJson: unknown = inputRaw
        if (inputStr.length > 8000) {
          const capped: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(inputRaw as Record<string, unknown>)) {
            capped[k] = typeof v === 'string' && v.length > 3000 ? v.slice(0, 3000) + '…' : v
          }
          inputJson = capped
        }

        // Only track pending-tool-calls / tool.called metrics for the main
        // agent turn. pendingToolCalls gates turn completion in SessionManager;
        // counting subagent tools here would leave the counter permanently
        // >0 when the subagent's results come back tagged with parent set.
        if (!parentToolUseId) this.pendingToolCalls++
        // Record finalization time + preview for tool.called metrics.
        // Use monotonic clock (performance.now) to avoid wall-clock jumps.
        // Guard against double-record if the same tool_use id appears twice
        // in one turn (shouldn't happen, but keep first observation authoritative).
        if (!parentToolUseId && !this.toolUseMeta.has(c.id)) {
          this.toolUseMeta.set(c.id, {
            startAt: performance.now(),
            inputPreview: inputStr.slice(0, 500),
          })
        }
        // Snapshot the input for the durable server-authored tool record.
        // Only top-level (main agent) tools are tracked for persistence —
        // subagent tools are owned by their parent Agent card and persisted
        // separately in Phase 2. Skip if id collides with an existing pending
        // entry (defensive — keep first observation as authoritative).
        if (!parentToolUseId && !this.pendingToolUses.has(c.id)) {
          this.pendingToolUses.set(c.id, {
            toolName: c.name ?? 'unknown',
            inputJson,
            inputPreview: inputStr.slice(0, 500),
            inputTruncated: inputStr.length > 8000,
          })
        }
        const streamed = this.streamingToolUses.get(c.id)
        const block: Record<string, unknown> = {
          kind: 'tool_use',
          blockId: c.id,
          toolName: c.name ?? 'unknown',
          inputPreview,
          inputJson,
          partial: false,
        }
        if (parentToolUseId) block.parentToolUseId = parentToolUseId
        // V3 v7.1 — stamp canonical tool row id on main-agent finalized
        // snapshot. Same gating as `stampToolUseId` in _handleStreamEvent:
        // skip when subagent or factory absent.
        else if (this.toolMessageIdFactory && c.id) {
          block.messageId = this.toolMessageIdFactory(c.id)
        }
        this.onEvent({ kind: 'block', block: block as any })
        if (streamed) streamed.done = true
      } else if (
        isSyntheticError &&
        c?.type === 'text' &&
        typeof c.text === 'string' &&
        c.text.length > 0
      ) {
        // Only accumulate into assistantBuf for main-agent turns (mirrors
        // _handleStreamEvent's text_delta rule). Subagent error text is
        // still surfaced to the UI but not merged into the parent's buffer.
        if (!parentToolUseId) this.assistantBuf += c.text
        const textBlock: Record<string, unknown> = { kind: 'text', text: c.text }
        if (parentToolUseId) textBlock.parentToolUseId = parentToolUseId
        // V3 v7 — stamp canonical id on main-agent text (synthetic-error
        // path included; client treats it as part of the same row that
        // streaming text would have populated).
        else if (this.assistantMessageId) textBlock.messageId = this.assistantMessageId
        this.onEvent({ kind: 'block', block: textBlock as any })
      }
      // text / thinking (non-error snapshots): already emitted via stream_event
    }
  }

  private _handleUser(msg: SdkMessage, parentToolUseId?: string): void {
    const content = (msg as any).message?.content
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (c?.type === 'tool_result') {
        const useId = c.tool_use_id
        if (useId && this.emittedToolResultIds.has(useId)) continue
        if (useId) this.emittedToolResultIds.add(useId)
        // Only decrement main-agent pending-tool-calls; subagent tool_results
        // were never incremented (see _handleAssistant guard), so decrementing
        // here would drive the counter negative and could stall turn finalization.
        if (!parentToolUseId && this.pendingToolCalls > 0) this.pendingToolCalls--
        const toolName = useId ? (this.toolUseIdToName.get(useId) ?? 'unknown') : 'unknown'
        const previewRaw = c.content
        let preview: string
        if (typeof previewRaw === 'string') {
          preview = previewRaw
        } else if (Array.isArray(previewRaw)) {
          preview = previewRaw
            .map((b: any) => {
              if (b?.type === 'text' && typeof b.text === 'string') return b.text
              return JSON.stringify(b)
            })
            .join('\n')
        } else {
          preview = JSON.stringify(previewRaw ?? '')
        }
        if (preview.length > 3000) preview = `${preview.slice(0, 3000)}…`
        const block: Record<string, unknown> = {
          kind: 'tool_result',
          blockId: useId ? `${useId}:result` : undefined,
          toolUseBlockId: useId || undefined,
          toolName,
          isError: !!c.is_error,
          preview,
        }
        if (parentToolUseId) block.parentToolUseId = parentToolUseId
        this.onEvent({ kind: 'block', block: block as any })
        // Notify about completed tool results for bridging + metrics.
        // Subagent tool_results must not fire host bridges or record
        // main-agent metrics — same reasoning as _handleAssistant.
        if (!parentToolUseId && useId) {
          const meta = this.toolUseMeta.get(useId)
          // Monotonic-clock diff; round to int ms for clean histogram buckets.
          // 0 when meta is missing (stale result / cross-turn tool_use unseen by this parser).
          const durationMs = meta ? Math.max(0, Math.round(performance.now() - meta.startAt)) : 0
          if (meta) this.toolUseMeta.delete(useId)
          // Finalize the durable tool snapshot. Pull pending input captured
          // from _handleAssistant; if absent (e.g. a tool_result for a
          // tool_use we never saw — stale cross-turn), fall back to empty
          // input. This is rare but we still want to record the result.
          const pending = this.pendingToolUses.get(useId)
          if (pending) this.pendingToolUses.delete(useId)
          // V3 v7.1 — exclude the `Agent` tool from the durable server-authored
          // snapshot. The web client renders Agent tools as `role: 'agent-group'`
          // cards owning a `childBlocks` tree (subagent text / thinking /
          // tool_use), not a flat `role: 'tool'` row. Persisting them as
          // `srv-*-tool-*` rows server-side would (a) duplicate the agent
          // card after refresh (server row coexists with client `m-* agent-group`),
          // (b) fight back through `_localMessageSupersedes` (role mismatch
          // → server wins, blowing away the childBlocks tree). Agent card
          // durability is the client PUT path's responsibility (the full
          // session including `agent-group` rows lands in `client_sessions.messages`).
          // Regex match is case-insensitive to mirror the web side's
          // `/^Agent$/i.test(...)` discriminator and stay aligned if CCB
          // ever varies the casing.
          if (!/^Agent$/i.test(toolName || '')) {
            this.completedTools.push(
              _capToolEntry({
                toolUseId: useId,
                blockId: useId,
                toolName,
                inputJson: pending?.inputJson ?? {},
                inputPreview: pending?.inputPreview ?? '',
                output: preview,
                isError: !!c.is_error,
                durationMs,
                ts: Date.now(),
              }),
            )
          }
          if (this.onToolResult) {
            this.onToolResult({
              toolUseId: useId,
              toolName,
              preview,
              isError: !!c.is_error,
              durationMs,
              inputPreview: meta?.inputPreview,
            })
          }
        }
      }
    }
  }

  private _handleResult(msg: SdkMessage): void {
    const usage = (msg as any).usage ?? {}
    // CCB's `total_cost_usd` is the **process-cumulative** cost from
    // `getTotalCost()` (cost-tracker.ts), not a per-turn delta. Compute the
    // per-turn cost ourselves from the cumulative. If the cumulative dropped
    // (e.g. CCB subprocess was respawned and started fresh at 0), treat the
    // new cumulative as this turn's cost — that's the most we can attribute
    // safely without losing track of new charges. Long-term cost telemetry
    // will be slightly low in that case but never inflated.
    const cumulativeCost = (msg as any).total_cost_usd ?? 0
    let turnCost = cumulativeCost - this._sessionTotals._lastCcbCumulativeCost
    if (turnCost < 0) turnCost = cumulativeCost
    this._sessionTotals._lastCcbCumulativeCost = cumulativeCost
    this._sessionTotals.totalCostUSD += turnCost
    this._sessionTotals.turns += 1

    // CCB result row already carries `stop_reason` (end_turn / max_tokens /
    // tool_use / pause_turn / stop_sequence / refusal) — read it so Gateway
    // has authoritative termination info instead of re-guessing via the
    // 9-AND phantom heuristic. See docs/ccb-telemetry-refactor-plan.md §5.3.
    const stopReason = typeof (msg as any).stop_reason === 'string'
      ? ((msg as any).stop_reason as string)
      : null
    const numTurns = typeof (msg as any).num_turns === 'number'
      ? ((msg as any).num_turns as number)
      : null

    // Detect stale --resume session id. When the gateway spawns CCB with
    // --resume <id> and <id>.jsonl no longer exists (e.g. CCB crashed before
    // the JSONL was persisted, and we still wrote the id to resume-map from
    // the init message), CCB emits an error_during_execution result whose
    // `errors` array contains "No conversation found with session ID: <id>".
    // Left unchecked, every subsequent submit() re-spawns CCB with the same
    // dead id and re-crashes, forming an infinite loop.
    const errorsField = (msg as any).errors
    const staleResumeId =
      Array.isArray(errorsField) &&
      errorsField.some(
        (e) => typeof e === 'string' && e.includes('No conversation found with session ID'),
      )

    this.turnResult = {
      cost: turnCost,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      assistantText: this.assistantBuf,
      thinkingText: this.thinkingBuf,
      isError: !!(msg as any).is_error,
      stopReason,
      numTurns,
      staleResumeId,
      tools: [...this.completedTools],
    }

    this.finalized = true
    this.onEvent({
      kind: 'final',
      meta: {
        cost: turnCost,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
        totalCost: this._sessionTotals.totalCostUSD,
        turn: this._sessionTotals.turns,
        ...(stopReason !== null ? { stopReason } : {}),
      },
    })
    this.onFinish(this.turnResult)
  }
}
