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
    /** Running totals from session (for computing totalCost in final meta) */
    sessionTotals: { totalCostUSD: number; turns: number }
  }) {
    this.toolUseIdToName = opts.toolUseIdToName
    this.onEvent = opts.onEvent
    this.onToolUse = opts.onToolUse
    this.onToolResult = opts.onToolResult
    this.onFinish = opts.onFinish
    this._sessionTotals = opts.sessionTotals
  }

  private _sessionTotals: { totalCostUSD: number; turns: number }

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

    // ── stream_event: streaming partial deltas ──
    if (msg.type === 'stream_event') {
      this._handleStreamEvent(msg)
      return
    }

    // ── assistant snapshot: finalize tool_use with complete input ──
    if (msg.type === 'assistant') {
      this._handleAssistant(msg)
      return
    }

    // ── user snapshot: tool_result ──
    if (msg.type === 'user') {
      this._handleUser(msg)
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
    // assistant_error / status / tool_progress / etc: ignore
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

  private _handleStreamEvent(msg: SdkMessage): void {
    const ev = (msg as any).event
    if (!ev || typeof ev !== 'object') return

    if (ev.type === 'content_block_start') {
      const cb = ev.content_block
      if (cb?.type === 'tool_use' && cb.id && cb.name) {
        this.toolUseIdToName.set(cb.id, cb.name)
        this.streamingToolUses.set(cb.id, { name: cb.name, partialJson: '', done: false })
        if (typeof ev.index === 'number') this.indexToToolId.set(ev.index, cb.id)
        this.onEvent({
          kind: 'block',
          block: {
            kind: 'tool_use',
            blockId: cb.id,
            toolName: cb.name,
            inputPreview: '',
            partial: true,
          },
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
        this.assistantBuf += textStr
        this.onEvent({ kind: 'block', block: { kind: 'text', text: textStr } })
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        const thinkStr =
          typeof delta.thinking === 'string' ? delta.thinking : JSON.stringify(delta.thinking)
        this.onEvent({ kind: 'block', block: { kind: 'thinking', text: thinkStr } })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolId = this.indexToToolId.get(ev.index as number)
        const tool = toolId ? this.streamingToolUses.get(toolId) : undefined
        if (tool) {
          tool.partialJson += delta.partial_json
          this.onEvent({
            kind: 'block',
            block: {
              kind: 'tool_use',
              blockId: toolId!,
              toolName: tool.name,
              inputPreview: tool.partialJson.slice(0, 400),
              partial: true,
            },
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

  private _handleAssistant(msg: SdkMessage): void {
    const content = (msg as any).message?.content
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (c?.type === 'tool_use' && c.id) {
        this.toolUseIdToName.set(c.id, c.name ?? 'unknown')
        const inputRaw = c.input ?? {}
        const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(inputRaw)
        const inputPreview = inputStr.slice(0, 400)

        // Notify about detected tool_use for bridging
        if (this.onToolUse && c.name) {
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

        this.pendingToolCalls++
        // Record finalization time + preview for tool.called metrics.
        // Use monotonic clock (performance.now) to avoid wall-clock jumps.
        // Guard against double-record if the same tool_use id appears twice
        // in one turn (shouldn't happen, but keep first observation authoritative).
        if (!this.toolUseMeta.has(c.id)) {
          this.toolUseMeta.set(c.id, {
            startAt: performance.now(),
            inputPreview: inputStr.slice(0, 500),
          })
        }
        const streamed = this.streamingToolUses.get(c.id)
        this.onEvent({
          kind: 'block',
          block: {
            kind: 'tool_use',
            blockId: c.id,
            toolName: c.name ?? 'unknown',
            inputPreview,
            inputJson,
            partial: false,
          },
        })
        if (streamed) streamed.done = true
      }
      // text / thinking: already emitted via stream_event
    }
  }

  private _handleUser(msg: SdkMessage): void {
    const content = (msg as any).message?.content
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (c?.type === 'tool_result') {
        const useId = c.tool_use_id
        if (useId && this.emittedToolResultIds.has(useId)) continue
        if (useId) this.emittedToolResultIds.add(useId)
        if (this.pendingToolCalls > 0) this.pendingToolCalls--
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
        this.onEvent({
          kind: 'block',
          block: {
            kind: 'tool_result',
            blockId: useId ? `${useId}:result` : undefined,
            toolUseBlockId: useId || undefined,
            toolName,
            isError: !!c.is_error,
            preview,
          },
        })
        // Notify about completed tool results for bridging + metrics.
        if (this.onToolResult && useId) {
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
    const turnCost = (msg as any).total_cost_usd ?? 0
    this._sessionTotals.totalCostUSD += turnCost
    this._sessionTotals.turns += 1

    this.turnResult = {
      cost: turnCost,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      assistantText: this.assistantBuf,
      isError: !!(msg as any).is_error,
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
      },
    })
    this.onFinish(this.turnResult)
  }
}
