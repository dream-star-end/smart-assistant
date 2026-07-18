/**
 * CcbMessageParser — parses stream-json output from CCB subprocess
 * and emits structured SessionStreamEvent events.
 *
 * Extracted from SessionManager._runOneTurn to separate CCB-specific
 * message parsing from session orchestration concerns.
 */
import { performance } from 'node:perf_hooks'
import {
  type OutboundContentBlock,
  isToolExitCode,
  isToolTerminationReason,
} from '@openclaude/protocol'
import type {
  DetectedToolResult,
  DetectedToolUse,
  DurableRuntimeEvent,
  SegmentRecord,
  SessionStreamEvent,
  TurnToolEntry,
} from './engine/engineEvents.js'
import type { ClassifiedErrorCode } from './errorClassify.js'
import type { SdkMessage } from './subprocessRunner.js'

function bashOutputTailBlock(raw: Record<string, any>): OutboundContentBlock | null {
  const toolUseId = raw.tool_use_id
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null
  const block: Record<string, unknown> = {
    kind: 'tool_output_tail',
    toolUseBlockId: toolUseId,
    tail: typeof raw.tail === 'string' ? raw.tail : '',
    totalBytes: typeof raw.total_bytes === 'number' ? raw.total_bytes : 0,
    truncatedHead: !!raw.truncated_head,
  }
  if (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0) {
    block.parentToolUseId = raw.parent_tool_use_id
  }
  return block as OutboundContentBlock
}

// M0 engine 适配层:事件/工具快照类型的权威源迁至 engine/engineEvents.ts(engine
// 中立模块);此处 re-export 兼容存量 import(server/v3MasterSink/commercial/测试)。
export type {
  DetectedToolResult,
  DetectedToolUse,
  PermissionRequest,
  SegmentRecord,
  SessionStreamEvent,
  TurnToolEntry,
} from './engine/engineEvents.js'

/**
 * 自动重试侧信道载荷 —— 仅 turn_status='retrying' 携带。不进 tape、不持久化,
 * 断线重连由 retryAt(下一次尝试的绝对 epoch ms)重算倒计时。字段语义与
 * protocol frames.ts OutboundTurnStatus 的 retrying 分支逐字段对齐。
 */
export interface TurnRetryMeta {
  attempt: number
  max: number
  delayMs: number
  retryAt: number
}

/**
 * gateway 侧 turn 非流式阶段态。
 *
 * `'compacting'` / `null` 是 engine 中立事件(EngineContentEvent.turn_status)的
 * 原生取值;`{status:'retrying', retry}` 是 gateway 上层对底座 fake-SDK retrying
 * 状态的语义加宽 —— engine 事件类型仍只认 `'compacting'|null`,retrying 形态经
 * 受控 cast 跨 engine/ 类型边界(adapter 的 onEvent 直通透传保真,server 侧按本
 * 类型 narrow 消费,session cache 也以此建模)。
 */
export type GatewayTurnPhase = 'compacting' | null | { status: 'retrying'; retry: TurnRetryMeta }

/**
 * gateway 上层实际流经 onLeaderEvent 的事件模型 —— 在 engine 中立
 * SessionStreamEvent 基础上加宽两处:error 事件可携带 runner 预分类的
 * errorClass;turn_status 的 status 可为 retrying 形态。engine/ 的类型不在本包
 * 所有权内,故用本地加宽类型 + 边界 cast,而不改 engine 事件契约。
 *
 * SessionStreamEvent ⊆ GatewayStreamEvent(errorClass 可选、GatewayTurnPhase ⊇
 * 'compacting'|null),因此接受 GatewayStreamEvent 的 handler 可安全下传给要求
 * SessionStreamEvent handler 的 submit()(函数参数逆变)。
 */
export type GatewayStreamEvent =
  | Exclude<SessionStreamEvent, { kind: 'error' } | { kind: 'turn_status' }>
  | { kind: 'error'; error: string; errorClass?: ClassifiedErrorCode }
  | { kind: 'turn_status'; status: GatewayTurnPhase }

/** 校验底座 fake-SDK retrying 状态携带的 retry 载荷;形状非法返回 null(调用方
 *  据此降级为 status:null,不把畸形侧信道透给前端)。 */
function normalizeTurnRetry(raw: unknown): TurnRetryMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const { attempt, max, delayMs, retryAt } = r
  if (
    typeof attempt !== 'number' || !Number.isFinite(attempt) || attempt < 1 ||
    typeof max !== 'number' || !Number.isFinite(max) || max < 1 ||
    typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0 ||
    typeof retryAt !== 'number' || !Number.isFinite(retryAt) || retryAt < 0
  ) {
    return null
  }
  return {
    attempt: Math.floor(attempt),
    max: Math.floor(max),
    delayMs: Math.floor(delayMs),
    retryAt: Math.floor(retryAt),
  }
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
   *  events without semantic truncation. Empty string when the
   *  model didn't emit any thinking blocks (most non-Sonnet/non-extended-
   *  thinking turns). Subagent thinking is excluded — same rule as
   *  assistantText. Used by sessionManager.persistServerAuthoredTurn to
   *  pass thinking through the v3 sink so it survives mobile-bg recovery
   *  and server-wins overwrites. */
  thinkingText: string
  /** True if CCB marked the result as an error (e.g. API failure) */
  isError: boolean
  errorDetail?: string
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
  /** Fix B — per-segment row id support. One entry per
   *  text content-block group between tool_use boundaries. Empty array if
   *  the turn produced no main-agent text. The web row id for segment N is
   *  `${assistantMessageId}-s${index}`; segments[N].ts is the wall-clock
   *  first-token arrival time of that segment, used by master to write each
   *  segment as a distinct server-authored row with its own ts so ts-sort
   *  interleaves correctly with tool rows. See docs/wip/fixb-per-segment-row-id-PLAN.md. */
  assistantSegments: SegmentRecord[]
  /** Same as `assistantSegments` for thinking. */
  thinkingSegments: SegmentRecord[]
  /** Exact ordered engine/protocol messages observed during this turn. */
  runtimeEvents: DurableRuntimeEvent[]
}

/** Full-authority durable tool snapshot. UI preview fields may be short, but
 * inputJson/output are the exact model-visible values and are never cut. */
function _snapshotToolEntry(raw: {
  toolUseId: string
  blockId: string
  toolName: string
  inputJson: unknown
  inputPreview: string
  output: string
  outputJson?: unknown
  partialInputJson?: string
  completed?: boolean
  isError: boolean
  durationMs: number
  ts: number
  arrivedAt: number
  eventOrdinal?: number
}): TurnToolEntry {
  return {
    toolUseId: raw.toolUseId,
    blockId: raw.blockId,
    toolName: raw.toolName,
    inputJson: raw.inputJson,
    inputPreview: raw.inputPreview,
    output: raw.output,
    ...(raw.outputJson !== undefined ? { outputJson: raw.outputJson } : {}),
    ...(raw.partialInputJson !== undefined ? { partialInputJson: raw.partialInputJson } : {}),
    ...(raw.completed !== undefined ? { completed: raw.completed } : {}),
    isError: raw.isError,
    durationMs: raw.durationMs,
    ts: raw.ts,
    arrivedAt: raw.arrivedAt,
    ...(raw.eventOrdinal !== undefined ? { eventOrdinal: raw.eventOrdinal } : {}),
  }
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
    { toolName: string; inputJson: unknown; inputPreview: string }
  >()
  /** Top-level tools that have completed (both tool_use and tool_result seen)
   *  within this turn, in arrival order of the tool_result. Surfaced in the
   *  TurnResult.tools field at turn end so SessionManager can persist them
   *  via the v3 sink. Public so the interrupt/crash path in SessionManager
   *  can flush whatever completed before CCB died. */
  public completedTools: TurnToolEntry[] = []

  /**
   * Durable snapshot of every top-level tool call observed so far. Completed
   * entries retain their exact input/result. Unmatched entries retain the
   * exact raw input_json_delta prefix (which may be incomplete JSON) plus any
   * final structured input snapshot already received. This is used by normal
   * error results and crash/interrupt persistence; previews remain derived UI
   * fields and are never the authority.
   */
  public snapshotToolsForPersistence(): TurnToolEntry[] {
    const snapshots = this.completedTools.map((tool) => ({ ...tool }))
    const completedIds = new Set(snapshots.map((tool) => tool.toolUseId))
    const pendingIds = new Set([
      ...this.streamingToolUses.keys(),
      ...this.pendingToolUses.keys(),
    ])
    for (const toolUseId of pendingIds) {
      if (completedIds.has(toolUseId)) continue
      const streamed = this.streamingToolUses.get(toolUseId)
      const pending = this.pendingToolUses.get(toolUseId)
      const toolName = pending?.toolName ?? streamed?.name ?? this.toolUseIdToName.get(toolUseId) ?? 'unknown'
      const partialInputJson = streamed?.partialJson
      const meta = this.toolUseMeta.get(toolUseId)
      snapshots.push(_snapshotToolEntry({
        toolUseId,
        blockId: toolUseId,
        toolName,
        inputJson: pending?.inputJson ?? null,
        inputPreview:
          pending?.inputPreview ?? (partialInputJson === undefined ? '' : partialInputJson.slice(0, 500)),
        output: '',
        isError: false,
        durationMs: meta ? Math.max(0, Math.round(performance.now() - meta.startAt)) : 0,
        ts: Date.now(),
        arrivedAt: this.toolArrivedAt.get(toolUseId) ?? Date.now(),
        eventOrdinal: this.toolEventOrdinal.get(toolUseId),
        ...(partialInputJson !== undefined ? { partialInputJson } : {}),
        completed: false,
      }))
    }
    return snapshots
  }
  /** De-duplicate emitted tool_results within a turn */
  private emittedToolResultIds = new Set<string>()
  /** Count of tool_use blocks sent but not yet matched by a tool_result */
  public pendingToolCalls = 0
  /** Assistant text accumulated in this turn */
  public assistantBuf = ''
  /** Main-agent thinking text accumulated in this turn from thinking_delta
   *  events without semantic truncation.
   *  Subagent thinking (parentToolUseId set) is excluded — it lives inside
   *  child block rendering, not in the parent turn's authoritative buffer. */
  public thinkingBuf = ''
  /** Whether this turn has been finalized */
  public finalized = false
  /** Accumulated turn result (set when finalized) */
  public turnResult: TurnResult | null = null

  // ── Fix B per-segment state ────────────────────────────────────────
  /** One record per text segment in this turn. Pushed lazily on first
   *  text_delta of the segment; ts is captured at that moment. */
  public assistantSegments: SegmentRecord[] = []
  public thinkingSegments: SegmentRecord[] = []
  /** Current segment counter — index of the segment that the NEXT text_delta
   *  will land in. Starts at 0; bumped on consume of pending flag. */
  private currentTextSegmentIndex = 0
  private currentThinkingSegmentIndex = 0
  /** When a tool_use boundary is observed AND at least one segment of the
   *  same kind already exists, this flag is set; the NEXT text/thinking
   *  delta consumes it (increments the counter, clears the flag). Two
   *  consecutive tool_use boundaries set the same flag idempotently — the
   *  counter only advances once until consumed. tool-first turns (no
   *  preceding segment) skip setting the flag so the first text lands in s0
   *  instead of s1. */
  private pendingTextSegmentBumpOnNextText = false
  private pendingThinkingSegmentBumpOnNextThinking = false
  /** Tool ARRIVAL time keyed by tool_use_id. Stamped at first observation
   *  of the tool_use block (whichever comes first: content_block_start in
   *  the Anthropic streaming path, or _handleAssistant snapshot for both
   *  Anthropic-finalized + Codex runner emit paths). Reused later when
   *  tool_result arrives and we push to completedTools — gives us tool
   *  CARD APPEARANCE time, not tool COMPLETION time, so parallel tools
   *  that finish out of order still sort by their start position. */
  private toolArrivedAt = new Map<string, number>()
  /** Tool card first-appearance order, sharing the turn-wide sequence. */
  private toolEventOrdinal = new Map<string, number>()

  /** Exact raw messages retained without projection or size/count limits. */
  public runtimeEvents: DurableRuntimeEvent[] = []
  private readonly nextDurableEventOrdinal: () => number

  private onEvent: (e: SessionStreamEvent) => void
  private onToolUse?: (tool: DetectedToolUse) => void
  private onToolResult?: (result: DetectedToolResult) => void
  /** F5 — 每观测到一个 **Bash** tool_use(**含子 agent**,parentToolUseId 与否都触发)
   *  就回调一次,仅供归属登记(tool_use_id → 发起 turn),不触发任何 host bridge。
   *  与 onToolUse(主 agent-only、驱动 CronCreate/委派等桥接)分离,避免子 agent 工具
   *  重复触发桥接;又保证子 agent bg bash 的 tail 能被路由层正确归位(否则 fail-closed
   *  会把活跃 turn 内的子 agent bash tail 也误丢)。 */
  private onBashToolObserved?: (toolUseId: string) => void
  private onPostFinalRuntimeEvent?: (
    event: DurableRuntimeEvent,
    block: OutboundContentBlock,
  ) => void
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
    /** F5 — 见字段级注释:所有 Bash tool_use(含子 agent)的归属登记回调。 */
    onBashToolObserved?: (toolUseId: string) => void
    onPostFinalRuntimeEvent?: (
      event: DurableRuntimeEvent,
      block: OutboundContentBlock,
    ) => void
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
    nextDurableEventOrdinal?: () => number
  }) {
    this.toolUseIdToName = opts.toolUseIdToName
    this.onEvent = opts.onEvent
    this.onToolUse = opts.onToolUse
    this.onToolResult = opts.onToolResult
    this.onBashToolObserved = opts.onBashToolObserved
    this.onPostFinalRuntimeEvent = opts.onPostFinalRuntimeEvent
    this.onFinish = opts.onFinish
    this._sessionTotals = opts.sessionTotals
    this.assistantMessageId = opts.assistantMessageId
    this.thinkingMessageId = opts.thinkingMessageId
    this.toolMessageIdFactory = opts.toolMessageIdFactory
    let localOrdinal = 0
    this.nextDurableEventOrdinal = opts.nextDurableEventOrdinal ?? (() => localOrdinal++)
  }

  private _sessionTotals: {
    totalCostUSD: number
    turns: number
    _lastCcbCumulativeCost: number
  }

  /** Capture an opaque runtime/protocol event without routing it through the
   * SDK projection parser. Codex app-server uses a dedicated side channel so
   * adding lossless retention cannot perturb legacy `message` consumers. */
  captureRuntimeEvent(
    payload: unknown,
    source: DurableRuntimeEvent['source'] = 'ccb',
  ): void {
    if (this.finalized) return
    this.runtimeEvents.push({
      ordinal: this.nextDurableEventOrdinal(),
      observedAt: Date.now(),
      source,
      payload: structuredClone(payload),
    })
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
          const block = bashOutputTailBlock(msg as Record<string, any>)
          if (!block) return
          if (this.onPostFinalRuntimeEvent) {
            this.onPostFinalRuntimeEvent({
              ordinal: this.nextDurableEventOrdinal(),
              observedAt: Date.now(),
              source: 'ccb',
              payload: structuredClone(msg),
            }, block)
          } else {
            this.onEvent({ kind: 'block', block })
          }
        } catch (err) {
          this.onEvent({ kind: 'error', error: String(err) })
        }
      }
      return
    }
    try {
      this.captureRuntimeEvent(msg)
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

    // Codex app-server emits OpenClaude-native plan blocks because CCB's
    // stream-json protocol has no plan-table equivalent. Keep this adapter
    // local to the parser so the rest of sessionManager continues to deal in
    // SessionStreamEvent blocks only.
    if (raw.type === 'openclaude_plan') {
      const plan = raw.plan && typeof raw.plan === 'object' ? raw.plan : {}
      const block: Record<string, unknown> = { kind: 'plan' }
      if (typeof plan.blockId === 'string') block.blockId = plan.blockId
      if (typeof plan.text === 'string') block.text = plan.text
      if (typeof plan.explanation === 'string') block.explanation = plan.explanation
      if (Array.isArray(plan.steps)) {
        block.steps = plan.steps
          .map((s: unknown) => {
            const stepObj = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
            const step = typeof stepObj.step === 'string' ? stepObj.step : ''
            const status = stepObj.status
            if (!step) return null
            return {
              step,
              status:
                status === 'inProgress' || status === 'completed' || status === 'pending'
                  ? status
                  : 'pending',
            }
          })
          .filter(Boolean)
      }
      if (typeof plan.partial === 'boolean') block.partial = plan.partial
      if (parentToolUseId) block.parentToolUseId = parentToolUseId
      this.onEvent({ kind: 'block', block: block as OutboundContentBlock })
      return
    }

    if (raw.type === 'openclaude_goal') {
      const goal = raw.goal && typeof raw.goal === 'object' ? raw.goal : {}
      const block: Record<string, unknown> = { kind: 'goal' }
      if (typeof goal.blockId === 'string') block.blockId = goal.blockId
      if (typeof goal.objective === 'string') block.objective = goal.objective
      if (typeof goal.status === 'string') block.status = goal.status
      if (typeof goal.tokenBudget === 'number' || goal.tokenBudget === null) {
        block.tokenBudget = goal.tokenBudget
      }
      if (typeof goal.tokensUsed === 'number') block.tokensUsed = goal.tokensUsed
      if (typeof goal.timeUsedSeconds === 'number') block.timeUsedSeconds = goal.timeUsedSeconds
      if (typeof goal.updatedAt === 'number') block.updatedAt = goal.updatedAt
      if (typeof goal.cleared === 'boolean') block.cleared = goal.cleared
      // These two fields bind an advisory Codex notification to the exact
      // platform-owned GoalState generation. Dropping them here would make
      // the master unable to reject stale engine diagnostics.
      if (typeof goal.platformGoalId === 'string') block.platformGoalId = goal.platformGoalId
      if (typeof goal.platformStateRevision === 'number') {
        block.platformStateRevision = goal.platformStateRevision
      }
      if (parentToolUseId) block.parentToolUseId = parentToolUseId
      this.onEvent({ kind: 'block', block: block as OutboundContentBlock })
      return
    }

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
        const block = bashOutputTailBlock(raw)
        if (block) this.onEvent({ kind: 'block', block })
      } else if (raw.subtype === 'status') {
        // 受控枚举:CCB SDKStatus 有 'compacting' | null(coreSchemas.ts:1268);
        // codex runner 另注入 fake-SDK `status:'retrying'` + retry 载荷(自动重试
        // 侧信道)。除这两类显式识别的形态外,任何其它值 normalize 到 null ——
        // 防止未来底座加新 status 字面量时,gateway 没有显式 mapping 就把未审过
        // 的字符串塞给前端。
        if (raw.status === 'compacting') {
          this.onEvent({ kind: 'turn_status', status: 'compacting' })
        } else if (raw.status === 'retrying') {
          const retry = normalizeTurnRetry(raw.retry)
          if (retry) {
            // retrying 形态经受控加宽跨 engine/ 边界:engine 事件类型只认
            // 'compacting'|null,这里对底座自动重试状态做 gateway 侧语义扩展
            // (adapter onEvent 直通透传,server 侧按 GatewayTurnPhase 消费)。
            this.onEvent({
              kind: 'turn_status',
              status: { status: 'retrying', retry },
            } as unknown as SessionStreamEvent)
          } else {
            this.onEvent({ kind: 'turn_status', status: null })
          }
        } else {
          this.onEvent({ kind: 'turn_status', status: null })
        }
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
    // Every unprojected message (assistant_error, tool_progress, future system
    // task events, etc.) is already in runtimeEvents. Surface assistant_error
    // to the live UI as well; the opaque raw object remains the durable source.
    if (raw.type === 'assistant_error') {
      const detail =
        typeof raw.error === 'string'
          ? raw.error
          : typeof raw.message === 'string'
            ? raw.message
            : JSON.stringify(raw)
      this.onEvent({ kind: 'error', error: detail })
    }
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

  /** Fix B — common code for the two main-agent tool_use observation sites
   *  (`_handleStreamEvent.content_block_start` and `_handleAssistant`):
   *  - first-observation-wins stamp of `toolArrivedAt[blockId]` for use
   *    later as the tool row's `ts` (tool CARD appearance time, not tool
   *    COMPLETION time);
   *  - set pending-bump flag on each text/thinking kind whose segments[]
   *    is non-empty so the NEXT delta of that kind opens a new segment.
   *  Callers must already have verified `!parentToolUseId`. */
  private _markToolBoundary(blockId: string): void {
    if (!this.toolArrivedAt.has(blockId)) {
      this.toolArrivedAt.set(blockId, Date.now())
      this.toolEventOrdinal.set(blockId, this.nextDurableEventOrdinal())
    }
    if (this.assistantSegments.length > 0) {
      this.pendingTextSegmentBumpOnNextText = true
    }
    if (this.thinkingSegments.length > 0) {
      this.pendingThinkingSegmentBumpOnNextThinking = true
    }
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
        // F5:Bash tool_use 归属登记(含子 agent,parentToolUseId 不论);幂等,
        // _handleAssistant 快照点会再登记一次(非流式路径的兜底),Set/map 去重无害。
        if (cb.name === 'Bash') this.onBashToolObserved?.(cb.id)
        // Fix B: tool boundary triggers segment bump IFF the corresponding
        // text/thinking kind already has at least one segment. Skipping the
        // bump on empty segments keeps tool-first turns (tool → text₁ → text₂)
        // in s0 and lets back-to-back tools share a single pending bump.
        if (!parentToolUseId) {
          this._markToolBoundary(cb.id)
        }
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
        if (!parentToolUseId) {
          // Fix B: consume pending bump (set by a prior tool_use boundary
          // when a prior segment already existed) BEFORE picking the segment.
          if (this.pendingTextSegmentBumpOnNextText) {
            this.currentTextSegmentIndex++
            this.pendingTextSegmentBumpOnNextText = false
          }
          this.assistantBuf += textStr // legacy total — local-only after Fix B
          // Append into the current segment, creating a record on first hit.
          let cur = this.assistantSegments[this.assistantSegments.length - 1]
          if (!cur || cur.index !== this.currentTextSegmentIndex) {
            cur = {
              index: this.currentTextSegmentIndex,
              text: '',
              ts: Date.now(),
              eventOrdinal: this.nextDurableEventOrdinal(),
            }
            this.assistantSegments.push(cur)
          }
          cur.text += textStr
        }
        this.onEvent({
          kind: 'block',
          block: stampMainAgentId(
            withParent({ kind: 'text', text: textStr }),
            this.assistantMessageId
              ? `${this.assistantMessageId}-s${this.currentTextSegmentIndex}`
              : undefined,
          ),
        })
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        const thinkStr =
          typeof delta.thinking === 'string' ? delta.thinking : JSON.stringify(delta.thinking)
        // Fix B: same pending-bump consume rule for thinking.
        if (!parentToolUseId && this.pendingThinkingSegmentBumpOnNextThinking) {
          this.currentThinkingSegmentIndex++
          this.pendingThinkingSegmentBumpOnNextThinking = false
        }
        // Full-authority persistence keeps every main-agent reasoning delta.
        // Subagent thinking is retained by its DurableAgentGroup transcript.
        if (!parentToolUseId) {
          this.thinkingBuf += thinkStr
          if (thinkStr.length > 0) {
            let cur = this.thinkingSegments[this.thinkingSegments.length - 1]
            if (!cur || cur.index !== this.currentThinkingSegmentIndex) {
              cur = {
                index: this.currentThinkingSegmentIndex,
                text: '',
                ts: Date.now(),
                eventOrdinal: this.nextDurableEventOrdinal(),
              }
              this.thinkingSegments.push(cur)
            }
            cur.text += thinkStr
          }
        }
        this.onEvent({
          kind: 'block',
          block: stampMainAgentId(
            withParent({ kind: 'thinking', text: thinkStr }),
            this.thinkingMessageId
              ? `${this.thinkingMessageId}-s${this.currentThinkingSegmentIndex}`
              : undefined,
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

        // F5:Bash tool_use 归属登记(含子 agent,parentToolUseId 不论)。与下方
        // 主 agent-only 的 onToolUse 桥接分离,子 agent bg bash 的 tail 才能被路由层
        // 正确归位(活跃 turn → 进 Agent 卡;post-terminal → 归 origin turn)。
        if (c.name === 'Bash') this.onBashToolObserved?.(c.id)

        // Notify about detected tool_use for bridging. Only main-agent
        // tool_use events should trigger host-side bridging (CronCreate,
        // Agent→send_to_agent, etc.) — subagent-issued tools already run
        // inside the subagent's own CCB process and must not double-fire
        // host bridges.
        if (!parentToolUseId && this.onToolUse && c.name) {
          this.onToolUse({ name: c.name, id: c.id, input: inputRaw as Record<string, any> })
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
            inputJson: inputRaw,
            inputPreview: inputStr.slice(0, 500),
          })
        }
        const streamed = this.streamingToolUses.get(c.id)
        const block: Record<string, unknown> = {
          kind: 'tool_use',
          blockId: c.id,
          toolName: c.name ?? 'unknown',
          inputPreview,
          inputJson: inputRaw,
          partial: false,
        }
        if (parentToolUseId) block.parentToolUseId = parentToolUseId
        // V3 v7.1 — stamp canonical tool row id on main-agent finalized
        // snapshot. Same gating as `stampToolUseId` in _handleStreamEvent:
        // skip when subagent or factory absent.
        else if (this.toolMessageIdFactory && c.id) {
          block.messageId = this.toolMessageIdFactory(c.id)
        }
        // Fix B: tool boundary — stamp arrival time and set pending bump.
        // First observation wins; if content_block_start already fired for
        // this id (Anthropic streaming), don't overwrite arrivedAt.
        if (!parentToolUseId) {
          this._markToolBoundary(c.id)
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
        if (!parentToolUseId) {
          // Fix B: consume pending bump before picking the segment, mirror
          // append into the current segment with its own first-token ts.
          if (this.pendingTextSegmentBumpOnNextText) {
            this.currentTextSegmentIndex++
            this.pendingTextSegmentBumpOnNextText = false
          }
          this.assistantBuf += c.text
          let cur = this.assistantSegments[this.assistantSegments.length - 1]
          if (!cur || cur.index !== this.currentTextSegmentIndex) {
            cur = {
              index: this.currentTextSegmentIndex,
              text: '',
              ts: Date.now(),
              eventOrdinal: this.nextDurableEventOrdinal(),
            }
            this.assistantSegments.push(cur)
          }
          cur.text += c.text
        }
        const textBlock: Record<string, unknown> = { kind: 'text', text: c.text }
        if (parentToolUseId) textBlock.parentToolUseId = parentToolUseId
        // V3 v7 — stamp canonical id on main-agent text (synthetic-error
        // path included; client treats it as part of the same row that
        // streaming text would have populated).
        else if (this.assistantMessageId) {
          textBlock.messageId = `${this.assistantMessageId}-s${this.currentTextSegmentIndex}`
        }
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
        const fullOutput = preview
        if (preview.length > 3000) preview = `${preview.slice(0, 3000)}…`
        const block: Record<string, unknown> = {
          kind: 'tool_result',
          blockId: useId ? `${useId}:result` : undefined,
          toolUseBlockId: useId || undefined,
          toolName,
          isError: !!c.is_error,
          preview,
          output: fullOutput,
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
          // TOOL snapshot. The web client renders Agent tools as
          // `role: 'agent-group'` cards owning a `childBlocks` tree (subagent
          // text / thinking / tool_use), not a flat `role: 'tool'` row.
          // Persisting them as `srv-*-tool-*` rows server-side would (a)
          // duplicate the agent card after refresh (server tool row coexists
          // with client `m-* agent-group`), (b) fight back through the id-level
          // takeover (role mismatch → server wins, blowing away the childBlocks
          // tree — the 2c73030d incident). This exclusion STAYS.
          //
          // P2 债A (team-card server-authored化) does NOT change this: team
          // cards get their own dedicated durable channel — a `role:
          // 'agent-group'` server row written by master from the
          // `V3MasterSinkWirePayload.agentGroups[]`载荷 (generated at
          // handleDelegateTask 收尾, buffered on the leader session, drained by
          // persistServerAuthoredTurn). That row uses a distinct
          // `srv-*-agentgroup-${runId}` id and merges **local-wins** by
          // `_delegateRunId` (storage mergePreservingServerAuthored), so it
          // never collides with, nor swallows the childBlocks of, the client
          // `m-*` agent-group row. Routing Agent tools through THIS tool
          // snapshot would reintroduce the exact 2c73030d double-card / tree-
          // swallow fault, hence the exclusion is intentional and permanent.
          // Regex match is case-insensitive to mirror the web side's
          // `/^Agent$/i.test(...)` discriminator and stay aligned if CCB
          // ever varies the casing.
          if (!/^Agent$/i.test(toolName || '')) {
            // Fix B (2026-05-25): preserve `ts` as tool_result completion
            // time (legacy semantic — existing master schema treats it as
            // a free-form field and ignores it for tool row ts decisions),
            // and emit a NEW `arrivedAt` field for the tool CARD APPEARANCE
            // time stamped in `_markToolBoundary`. Master priority chain
            // `arrivedAt ?? offset` then uses arrivedAt when present,
            // falling back to the historical computed offset when absent
            // (pre-Fix-B gateway). Plan §3.5.4.
            const arrivedAt = this.toolArrivedAt.get(useId) ?? Date.now()
            this.completedTools.push(
              _snapshotToolEntry({
                toolUseId: useId,
                blockId: useId,
                toolName,
                inputJson: pending?.inputJson ?? {},
                inputPreview: pending?.inputPreview ?? '',
                output: fullOutput,
                outputJson: previewRaw,
                isError: !!c.is_error,
                durationMs,
                ts: Date.now(),
                arrivedAt,
                eventOrdinal: this.toolEventOrdinal.get(useId),
              }),
            )
          }
          if (this.onToolResult) {
            const exitCode = isToolExitCode(c.exit_code) ? c.exit_code : undefined
            const terminationReason = isToolTerminationReason(c.termination_reason)
              ? c.termination_reason
              : undefined
            this.onToolResult({
              toolUseId: useId,
              toolName,
              preview,
              isError: !!c.is_error,
              durationMs,
              inputPreview: meta?.inputPreview,
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(terminationReason !== undefined ? { terminationReason } : {}),
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
    const isError = !!(msg as any).is_error
    const errorDetail = isError
      ? JSON.stringify({
          subtype: (msg as any).subtype,
          result: (msg as any).result,
          errors: errorsField,
        })
      : undefined
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
      isError,
      ...(errorDetail !== undefined ? { errorDetail } : {}),
      stopReason,
      numTurns,
      staleResumeId,
      tools: this.snapshotToolsForPersistence(),
      // Fix B: shallow-clone the per-segment arrays so downstream consumers
      // (sessionManager → v3MasterSink → master HTTP body) get a stable
      // snapshot; the parser may be retained after onFinish for diagnostics.
      assistantSegments: this.assistantSegments.map((s) => ({ ...s })),
      thinkingSegments: this.thinkingSegments.map((s) => ({ ...s })),
      runtimeEvents: this.runtimeEvents.map((event) => structuredClone(event)),
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
