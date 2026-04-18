/**
 * CcbMessageParser — parses stream-json output from CCB subprocess
 * and emits structured SessionStreamEvent events.
 *
 * Extracted from SessionManager._runOneTurn to separate CCB-specific
 * message parsing from session orchestration concerns.
 */
import { performance } from 'node:perf_hooks'
import type { OutboundContentBlock } from '@openclaude/protocol'
import type { SdkMessage } from './subprocessRunner.js'

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
  /** True if CCB marked the result as an error (e.g. API failure) */
  isError: boolean
  /** Anthropic API stop_reason from CCB's result row; null if CCB didn't
   *  populate it (older CCB or pre-termination crash). Used for three-state
   *  phantom judgment and for precise empty-turn UI notices. */
  stopReason: string | null
  /** num_turns from CCB result row, for diagnostics. null when absent. */
  numTurns: number | null
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
  /** De-duplicate emitted tool_results within a turn */
  private emittedToolResultIds = new Set<string>()
  /** Count of tool_use blocks sent but not yet matched by a tool_result */
  public pendingToolCalls = 0
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
     *  - _lastCcbCumulativeCost: last value of CCB's `total_cost_usd` we observed.
     *    CCB reports session-cumulative cost (not per-turn), so per-turn cost
     *    is computed as `cumulative - _lastCcbCumulativeCost`. Reset detection
     *    (CCB process restart) is handled in `_handleResult`. */
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
   * Parse a single CCB SdkMessage. Call this for each 'message' event
   * from SubprocessRunner.
   */
  parse(msg: SdkMessage): void {
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
    // ── system:init ──
    if (msg.type === 'system') return

    // CCB stamps every SDK message with parent_tool_use_id. Non-null means
    // this message was produced by a subagent spawned via the Agent tool.
    // We forward it untouched on every emitted block so the frontend can
    // route subagent content into the owning Agent card instead of the
    // main stream. Main-agent messages carry null/undefined and flow to
    // the main stream as before.
    const raw = msg as any
    const parentToolUseId: string | undefined =
      typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id.length > 0
        ? raw.parent_tool_use_id
        : undefined

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
        // Defensive: ensure text is always a string (CCB may send nested objects)
        const textStr = typeof delta.text === 'string' ? delta.text : JSON.stringify(delta.text)
        // Only accumulate main-agent text into assistantBuf; subagent text
        // must not pollute the parent turn's stored assistant message.
        if (!parentToolUseId) this.assistantBuf += textStr
        this.onEvent({ kind: 'block', block: withParent({ kind: 'text', text: textStr }) })
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        const thinkStr =
          typeof delta.thinking === 'string' ? delta.thinking : JSON.stringify(delta.thinking)
        this.onEvent({ kind: 'block', block: withParent({ kind: 'thinking', text: thinkStr }) })
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
