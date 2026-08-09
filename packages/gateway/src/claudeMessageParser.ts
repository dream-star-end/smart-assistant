/**
 * ClaudeMessageParser — parses stream-json output from the official `claude`
 * subprocess (and OpenClaude-native plan/goal blocks synthesized by the Codex
 * app-server runner) and emits structured SessionStreamEvent events.
 *
 * Extracted from SessionManager._runOneTurn to separate stream-json message
 * parsing from session orchestration concerns.
 */
import { performance } from 'node:perf_hooks'
import type { OutboundContentBlock } from '@openclaude/protocol'
import type { SdkMessage } from './subprocessRunner.js'

/** Permission request from claude (via stdio control_request protocol) */
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
  | { kind: 'turn_status'; status: 'compacting' | null }
  // Background-workflow progress side-channel (ultracode). claude emits these as
  // `system/task_started|task_progress|task_updated` rows carrying a structured
  // `workflow_progress` array (phases + parallel agents). Forwarded out-of-band
  // so the web can render a live workflow card without polluting chat history.
  | {
      kind: 'workflow_progress'
      taskId: string
      stage: 'started' | 'progress' | 'updated'
      workflowName?: string
      toolUseId?: string
      description?: string
      summary?: string
      lastTool?: string
      usage?: { totalTokens?: number; toolUses?: number; durationMs?: number }
      /** Parsed `workflow_progress` items: {type:'workflow_phase',...} | {type:'workflow_agent',...} */
      items?: Array<Record<string, unknown>>
      /** task_updated patch status, e.g. 'completed'. */
      status?: string
    }
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
        /** True when the runner's authoritative result row reports failure. */
        isError?: boolean
        /** Anthropic API stop_reason, extracted from claude result row.
         *  Values: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
         *  | 'pause_turn' | 'refusal'. Used by sessionManager for phantom
         *  judgment and by frontend for empty-turn notice text. */
        stopReason?: string
        usageStatus?: 'observed' | 'unavailable'
        costStatus?: 'observed' | 'unavailable'
      }
    }
  | { kind: 'error'; error: string }
  | { kind: 'permission_request'; request: PermissionRequest }

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

/** Accumulated turn result stats */
export interface TurnResult {
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  assistantText: string
  /** True if claude marked the result as an error (e.g. API failure) */
  isError: boolean
  /** Anthropic API stop_reason from claude's result row; null if claude didn't
   *  populate it (pre-termination crash). Used for three-state
   *  phantom judgment and for precise empty-turn UI notices. */
  stopReason: string | null
  /** num_turns from claude result row, for diagnostics. null when absent. */
  numTurns: number | null
  usageStatus: 'observed' | 'unavailable'
  costStatus: 'observed' | 'unavailable'
}

/**
 * Stateful parser for one claude turn.
 * Create a new instance per turn; call `parse(msg)` for each SdkMessage.
 */
export class ClaudeMessageParser {
  /** tool_use id → name mapping (persists across turns, passed in from session) */
  private toolUseIdToName: Map<string, string>
  /** Streaming tool_use state within this turn */
  private streamingToolUses = new Map<
    string,
    { name: string; partialJson: string; done: boolean }
  >()
  /** content_block index → tool_use id (for routing input_json_delta) */
  private indexToToolId = new Map<number, string>()
  /** Anthropic message id from the current `message_start` (stream_event). Used
   *  to build stable per-block ids for text/thinking blocks (`${messageId}:${index}`);
   *  the gateway prefixes the turnId so the web side can upsert by a stable key
   *  instead of the easily-lost _streamingAssistant pointer. Empty until
   *  message_start arrives; the turnId prefix guarantees cross-turn uniqueness
   *  even if claude were to reuse a message id. */
  private currentAnthropicMsgId = ''
  /** tool_use id → timing/preview captured at finalization (for tool.called metrics) */
  private toolUseMeta = new Map<string, { startAt: number; inputPreview?: string }>()
  /** De-duplicate emitted tool_results within a turn */
  private emittedToolResultIds = new Set<string>()
  /** Count of tool_use blocks sent but not yet matched by a tool_result */
  public pendingToolCalls = 0
  /** True while claude reports it is compacting conversation context. */
  public isCompacting = false
  /** Assistant text accumulated in this turn */
  public assistantBuf = ''
  /** Whether this turn has been finalized */
  public finalized = false
  /** Accumulated turn result (set when finalized) */
  public turnResult: TurnResult | null = null

  private onEvent: (e: SessionStreamEvent) => void
  private onToolUse?: (tool: DetectedToolUse) => void
  private onToolResult?: (result: DetectedToolResult) => void
  private onFinish: (result: TurnResult | null) => void

  constructor(opts: {
    toolUseIdToName: Map<string, string>
    onEvent: (e: SessionStreamEvent) => void
    onToolUse?: (tool: DetectedToolUse) => void
    onToolResult?: (result: DetectedToolResult) => void
    onFinish: (result: TurnResult | null) => void
    /** Running totals from session (for computing totalCost in final meta).
     *  - totalCostUSD: gateway-side per-session cumulative cost (we mutate +=delta)
     *  - turns: gateway-side per-session turn counter (we mutate +=1)
     *  - _lastCcbCumulativeCost: last value of claude's `total_cost_usd` we observed.
     *    claude reports session-cumulative cost (not per-turn), so per-turn cost
     *    is computed as `cumulative - _lastCcbCumulativeCost`. Reset detection
     *    (claude process restart) is handled in `_handleResult`. */
    sessionTotals: {
      totalCostUSD: number
      turns: number
      _lastCcbCumulativeCost: number
    }
  }) {
    this.toolUseIdToName = opts.toolUseIdToName
    this.onEvent = opts.onEvent
    this.onToolUse = opts.onToolUse
    this.onToolResult = opts.onToolResult
    this.onFinish = opts.onFinish
    this._sessionTotals = opts.sessionTotals
  }

  private _sessionTotals: {
    totalCostUSD: number
    turns: number
    _lastCcbCumulativeCost: number
  }

  /**
   * Parse a single SdkMessage. Call this for each 'message' event
   * from SubprocessRunner.
   */
  parse(msg: SdkMessage): void {
    // Once the turn is finalized (a `result` row arrived) nothing more is
    // emitted. The old in-repo fork streamed `system/bash_output_tail` keepalives
    // past the result; official Claude Code has no such side-channel, so we
    // simply drop post-finalize messages.
    if (this.finalized) return
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
    // Claude Code stamps every SDK message with parent_tool_use_id. Non-null
    // means this message was produced by a subagent spawned via the Agent tool.
    // We forward it untouched on every emitted block so the frontend can
    // route subagent content into the owning Agent card instead of the
    // main stream. Main-agent messages carry null/undefined and flow to
    // the main stream as before.
    const raw = msg as any
    const parentToolUseId: string | undefined =
      typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0
        ? raw.parent_tool_use_id
        : undefined

    // Codex app-server emits OpenClaude-native plan blocks, because claude's
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

    // Codex app-server thread goals are session/thread state, not assistant
    // prose. Surface them as first-class goal blocks without polluting the
    // assistant text buffer used for transcript persistence.
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
      if (typeof goal.createdAt === 'number') block.createdAt = goal.createdAt
      if (typeof goal.updatedAt === 'number') block.updatedAt = goal.updatedAt
      if (typeof goal.cleared === 'boolean') block.cleared = goal.cleared
      if (parentToolUseId) block.parentToolUseId = parentToolUseId
      this.onEvent({ kind: 'block', block: block as OutboundContentBlock })
      return
    }

    // ── system messages ──
    // Most system subtypes (init / success / error / task_*) are ignored by
    // the gateway; claude emits them for SDK consumers that listen on stdout
    // directly.
    //
    // The meaningful signal for OpenClaude is status=compacting: claude is
    // spending time compressing context before the next model call. Track it
    // so SessionManager does not count that silent phase against the ordinary
    // 5-minute "no output" liveness budget, and emit a turn_status side-channel
    // so the web UI can show a separate "正在压缩上下文" state without polluting
    // chat history.
    //
    // (The old in-repo fork also emitted `system/bash_output_tail` — a 1 Hz tail of
    // long-running Bash, implemented as a source patch to its BashTool. Official
    // Claude Code has no such side-channel in headless stream-json mode, so live
    // bash tail is no longer surfaced; the final tool_result still arrives.)
    if (msg.type === 'system') {
      if (raw.subtype === 'status') {
        const mapped: 'compacting' | null = raw.status === 'compacting' ? 'compacting' : null
        this.isCompacting = mapped === 'compacting'
        this.onEvent({ kind: 'turn_status', status: mapped })
        return
      }
      if (raw.subtype === 'compact_boundary') {
        this.isCompacting = false
        this.onEvent({ kind: 'turn_status', status: null })
        return
      }
      // Background-workflow (ultracode) progress side-channel. claude streams
      // task_started / task_progress / task_updated rows while a `Workflow` tool
      // runs in the background. Surface them as workflow_progress events so the
      // web can render a live phase/agent card. Side-channel only — never a chat
      // block, never finalizes the turn.
      const wf = this._parseWorkflowSystem(raw)
      if (wf) this.onEvent(wf)
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

    // ── control_request: permission prompt from claude stdio protocol ──
    if (msg.type === 'control_request') {
      this._handleControlRequest(msg)
      return
    }
    // assistant_error / status / etc: ignore
    // tool_progress: intentionally ignored. claude emits this as a granular
    // heartbeat for long-running Bash/PowerShell runs and (per claude core
    // schemas) carries its own parent_tool_use_id. Out of scope for the
    // subagent-visibility routing — we define "subagent-attributable content"
    // as text / thinking / tool_use / tool_result only. Progress ticks
    // produce no user-visible artifact here today, so surfacing them would
    // require matching protocol + frontend rendering work. Revisit if we
    // add a dedicated bash-progress visualization.
  }

  /** Map a `system/task_*` row to a workflow_progress event, or null if it isn't
   *  a recognised background-workflow row. Tolerant of object-or-JSON-string
   *  shapes for `usage` / `workflow_progress` / `patch`. */
  private _parseWorkflowSystem(raw: any): SessionStreamEvent | null {
    const sub = raw?.subtype
    const taskId = typeof raw?.task_id === 'string' ? raw.task_id : undefined
    if (!taskId) return null
    const asObj = (v: unknown): any => {
      if (v && typeof v === 'object') return v
      if (typeof v === 'string') {
        try {
          return JSON.parse(v)
        } catch {
          return undefined
        }
      }
      return undefined
    }
    if (sub === 'task_started') {
      return {
        kind: 'workflow_progress',
        taskId,
        stage: 'started',
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
        workflowName: typeof raw.workflow_name === 'string' ? raw.workflow_name : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      }
    }
    if (sub === 'task_progress') {
      const usage = asObj(raw.usage)
      const items = asObj(raw.workflow_progress)
      return {
        kind: 'workflow_progress',
        taskId,
        stage: 'progress',
        toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        summary: typeof raw.summary === 'string' ? raw.summary : undefined,
        lastTool: typeof raw.last_tool_name === 'string' ? raw.last_tool_name : undefined,
        usage: usage
          ? {
              totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
              toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
              durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
            }
          : undefined,
        items: Array.isArray(items) ? items : undefined,
      }
    }
    if (sub === 'task_updated') {
      const patch = asObj(raw.patch)
      return {
        kind: 'workflow_progress',
        taskId,
        stage: 'updated',
        status: typeof patch?.status === 'string' ? patch.status : undefined,
      }
    }
    return null
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

    if (ev.type === 'content_block_start') {
      const cb = ev.content_block
      if (cb?.type === 'tool_use' && cb.id && cb.name) {
        this.toolUseIdToName.set(cb.id, cb.name)
        this.streamingToolUses.set(cb.id, { name: cb.name, partialJson: '', done: false })
        if (typeof ev.index === 'number') this.indexToToolId.set(ev.index, cb.id)
        this.onEvent({
          kind: 'block',
          block: withParent({
            kind: 'tool_use',
            blockId: cb.id,
            toolName: cb.name,
            inputPreview: '',
            partial: true,
          }),
        })
      }
      return
    }

    if (ev.type === 'content_block_delta') {
      const delta = ev.delta
      if (!delta) return
      if (delta.type === 'text_delta' && delta.text) {
        // Defensive: ensure text is always a string (claude may send nested objects)
        const textStr = typeof delta.text === 'string' ? delta.text : JSON.stringify(delta.text)
        // Only accumulate main-agent text into assistantBuf; subagent text
        // must not pollute the parent turn's stored assistant message.
        if (!parentToolUseId) this.assistantBuf += textStr
        this.onEvent({
          kind: 'block',
          block: withParent({
            kind: 'text',
            text: textStr,
            blockId: `${this.currentAnthropicMsgId}:${typeof ev.index === 'number' ? ev.index : 0}`,
          }),
        })
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        const thinkStr =
          typeof delta.thinking === 'string' ? delta.thinking : JSON.stringify(delta.thinking)
        this.onEvent({
          kind: 'block',
          block: withParent({
            kind: 'thinking',
            text: thinkStr,
            blockId: `${this.currentAnthropicMsgId}:${typeof ev.index === 'number' ? ev.index : 0}`,
          }),
        })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolId = this.indexToToolId.get(ev.index as number)
        const tool = toolId ? this.streamingToolUses.get(toolId) : undefined
        if (tool) {
          tool.partialJson += delta.partial_json
          this.onEvent({
            kind: 'block',
            block: withParent({
              kind: 'tool_use',
              blockId: toolId!,
              toolName: tool.name,
              inputPreview: tool.partialJson.slice(0, 400),
              partial: true,
            }),
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
    if (ev.type === 'message_start') {
      // Record the Anthropic message id so text/thinking blocks can carry a
      // stable `${messageId}:${index}` blockId (gateway adds the turnId prefix).
      const id = (ev as any).message?.id
      if (typeof id === 'string' && id) this.currentAnthropicMsgId = id
      return
    }
    // message_delta / message_stop: ignore
  }

  private _handleAssistant(msg: SdkMessage, parentToolUseId?: string): void {
    const content = (msg as any).message?.content
    if (!Array.isArray(content)) return
    // Synthetic API-error assistant messages (claude's getAssistantMessageFromError)
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
    const snapshotMsgId =
      typeof rawMsg.message?.id === 'string' && rawMsg.message.id
        ? rawMsg.message.id
        : this.currentAnthropicMsgId
    for (const [ci, c] of content.entries()) {
      if (c?.type === 'tool_use' && c.id) {
        this.toolUseIdToName.set(c.id, c.name ?? 'unknown')
        const inputRaw = c.input ?? {}
        const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(inputRaw)
        const inputPreview = inputStr.slice(0, 400)

        // Notify about detected tool_use for bridging. Only main-agent
        // tool_use events should trigger host-side bridging (CronCreate,
        // Agent→send_to_agent, etc.) — subagent-issued tools already run
        // inside the subagent's own claude process and must not double-fire
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
        const streamed = this.streamingToolUses.get(c.id)
        const block: Record<string, unknown> = {
          kind: 'tool_use',
          blockId: c.id,
          toolName: c.name ?? 'unknown',
          inputPreview,
          // Preview is intentionally short, but the durable frame keeps the
          // exact tool input. The web client materializes large values lazily.
          inputJson: inputRaw,
          partial: false,
        }
        if (parentToolUseId) block.parentToolUseId = parentToolUseId
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
        const textBlock: Record<string, unknown> = {
          kind: 'text',
          text: c.text,
          blockId: `${snapshotMsgId}:${ci}`,
        }
        if (parentToolUseId) textBlock.parentToolUseId = parentToolUseId
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
          outputJson: previewRaw,
        }
        if (parentToolUseId) block.parentToolUseId = parentToolUseId
        this.onEvent({ kind: 'block', block: block as any })
        // Notify about completed tool results for bridging + metrics.
        // Subagent tool_results must not fire host bridges or record
        // main-agent metrics — same reasoning as _handleAssistant.
        if (!parentToolUseId && this.onToolResult && useId) {
          const meta = this.toolUseMeta.get(useId)
          // Monotonic-clock diff; round to int ms for clean histogram buckets.
          // 0 when meta is missing (stale result / cross-turn tool_use unseen by this parser).
          const durationMs = meta ? Math.max(0, Math.round(performance.now() - meta.startAt)) : 0
          if (meta) this.toolUseMeta.delete(useId)
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

  private _handleResult(msg: SdkMessage): void {
    const usage = (msg as any).usage ?? {}
    // claude's `total_cost_usd` is the **process-cumulative** cost from
    // `getTotalCost()` (cost-tracker.ts), not a per-turn delta. Compute the
    // per-turn cost ourselves from the cumulative. If the cumulative dropped
    // (e.g. claude subprocess was respawned and started fresh at 0), treat the
    // new cumulative as this turn's cost — that's the most we can attribute
    // safely without losing track of new charges. Long-term cost telemetry
    // will be slightly low in that case but never inflated.
    const cumulativeCost = (msg as any).total_cost_usd ?? 0
    let turnCost = cumulativeCost - this._sessionTotals._lastCcbCumulativeCost
    if (turnCost < 0) turnCost = cumulativeCost
    this._sessionTotals._lastCcbCumulativeCost = cumulativeCost
    this._sessionTotals.totalCostUSD += turnCost
    this._sessionTotals.turns += 1

    // claude result row already carries `stop_reason` (end_turn / max_tokens /
    // tool_use / pause_turn / stop_sequence / refusal) — read it so Gateway
    // has authoritative termination info instead of re-guessing via the
    // 9-AND phantom heuristic.
    const stopReason =
      typeof (msg as any).stop_reason === 'string' ? ((msg as any).stop_reason as string) : null
    const numTurns =
      typeof (msg as any).num_turns === 'number' ? ((msg as any).num_turns as number) : null

    this.turnResult = {
      cost: turnCost,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      assistantText: this.assistantBuf,
      isError: !!(msg as any).is_error,
      stopReason,
      numTurns,
      usageStatus: (msg as any).usage_status === 'unavailable' ? 'unavailable' : 'observed',
      costStatus: (msg as any).cost_status === 'unavailable' ? 'unavailable' : 'observed',
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
        isError: this.turnResult.isError,
        ...(stopReason !== null ? { stopReason } : {}),
        usageStatus: this.turnResult.usageStatus,
        costStatus: this.turnResult.costStatus,
      },
    })
    this.onFinish(this.turnResult)
  }
}
