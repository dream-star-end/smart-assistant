/** First-class adapter for the pinned official Cursor Agent CLI.
 * Authentication remains exclusively inside the account-scoped oc-cursor
 * launcher; this adapter neither reads nor transports credentials. */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import {
  CURSOR_ENGINE_MODELS,
  DEFAULT_CURSOR_ENGINE_MODEL,
  type GoalStateSnapshot,
  type OutboundContentBlock,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { EngineAdapter, EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { EngineExternalBillingEvent, PartialSnapshot, PhantomSignals, SegmentRecord, TurnSummary, TurnToolEntry } from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { classifyRunError } from '../errorClassify.js'

const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const EMPTY_SIGNALS: PhantomSignals = { apiState: 'unknown', skipReason: null }
export const CURSOR_MAX_PROMPT_BYTES = 96 * 1024

type CursorEvent = Record<string, unknown> & { type?: unknown }
type ReportedUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
interface TurnCtx {
  params: TurnParams; startedAt: number; proc: ChildProcessByStdio<null, Readable, Readable> | null
  assistantText: string; thinkingText: string; assistantSegments: SegmentRecord[]; thinkingSegments: SegmentRecord[]
  tools: Map<string, TurnToolEntry>; pending: Set<string>; startedTools: Map<string, number>
  stderr: string; terminal: boolean; interrupted: boolean; error: string | null; usage?: ReportedUsage
  assistantPartialText: string; pendingAssistantText: string | null
  assistantSegmentClosed: boolean; thinkingSegmentClosed: boolean
  rawToSafeToolId: Map<string, string>; safeToRawToolId: Map<string, string>; fallbackToolSequence: number
  resolve: (value: TurnSummary | null) => void
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}
function promptOf(input: TurnParams['input']): string {
  return typeof input === 'string' ? input : input.map((v) => v.type === 'text' ? textOf(v.text) : textOf(v)).filter(Boolean).join('\n')
}
function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function assistantTextOf(event: CursorEvent): string {
  if (typeof event.text === 'string') return event.text
  if (typeof event.content === 'string') return event.content
  if (typeof event.delta === 'string') return event.delta
  if (typeof event.message === 'string') return event.message
  const message = recordOf(event.message)
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.map((block) => {
    const item = recordOf(block)
    return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
  }).join('')
}
function usageOf(event: CursorEvent): ReportedUsage | undefined {
  const raw = recordOf(event.usage)
  if (!raw) return undefined
  const input = nonnegative(raw.input_tokens ?? raw.inputTokens)
  const output = nonnegative(raw.output_tokens ?? raw.outputTokens)
  const cacheRead = nonnegative(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? raw.cacheReadTokens)
  const cacheCreation = nonnegative(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? raw.cacheWriteTokens)
  const usage: ReportedUsage = {
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cache_creation_input_tokens: cacheCreation } : {}),
  }
  return Object.keys(usage).length ? usage : undefined
}
function finalUsageMeta(usage: ReportedUsage | undefined): Record<string, number> {
  if (!usage) return {}
  return {
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens !== undefined ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
  }
}
function unavailable(detail: string): 'auth' | 'quota' | null {
  if (/auth|credential|unauthorized|forbidden|api.?key|not logged in|\b401\b|\b403\b/i.test(detail)) return 'auth'
  if (/quota|rate.?limit|usage limit|subscription|credits? exhausted|\b429\b/i.test(detail)) return 'quota'
  return null
}
function snapshot(ctx: TurnCtx | null): PartialSnapshot {
  return ctx ? { assistantText: ctx.assistantText, thinkingText: ctx.thinkingText,
    completedTools: [...ctx.tools.values()].map((v) => structuredClone(v)),
    assistantSegments: ctx.assistantSegments.map((v) => ({ ...v })), thinkingSegments: ctx.thinkingSegments.map((v) => ({ ...v })), runtimeEvents: [] }
    : { assistantText: '', thinkingText: '', completedTools: [], assistantSegments: [], thinkingSegments: [], runtimeEvents: [] }
}
function toolCallOf(event: CursorEvent): Record<string, unknown> | null {
  return recordOf(event.tool_call ?? event.toolCall)
}
function toolVariantOf(event: CursorEvent): { key: string; value: Record<string, unknown> } | null {
  const call = toolCallOf(event)
  if (!call) return null
  for (const [key, value] of Object.entries(call)) {
    const variant = recordOf(value)
    if (/ToolCall$/.test(key) && variant) return { key, value: variant }
  }
  return null
}
function rawToolIdOf(event: CursorEvent): string {
  const call = toolCallOf(event)
  return textOf(
    event.call_id ?? event.tool_call_id ?? event.toolCallId ?? event.id ??
    call?.call_id ?? call?.tool_call_id ?? call?.toolCallId,
  )
}
function cursorToolKindOf(event: CursorEvent): string {
  const direct = event.tool_name ?? event.toolName ?? event.name
  if (typeof direct === 'string' && direct) return direct
  const variant = toolVariantOf(event)
  if (variant) return variant.key
  const call = toolCallOf(event)
  const nestedTool = recordOf(call?.tool)
  for (const candidate of [call?.name, call?.tool_name, call?.toolName, call?.type, nestedTool?.case]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return 'CursorTool'
}
function toolNameOf(event: CursorEvent): string {
  const kind = cursorToolKindOf(event)
  if (kind === 'shellToolCall') return 'Bash'
  if (kind === 'readToolCall') return 'Read'
  if (kind === 'globToolCall') return 'Glob'
  return 'CursorTool'
}
function toolInputOf(event: CursorEvent): unknown {
  const call = toolCallOf(event)
  const variant = toolVariantOf(event)
  const source = variant?.value ?? call ?? {}
  const args = recordOf(source.args) ?? source
  const kind = cursorToolKindOf(event)
  if (kind === 'shellToolCall') {
    return { command: textOf(args.command ?? call?.command ?? event.input) }
  }
  if (kind === 'readToolCall') {
    const filePath = textOf(args.path ?? args.file_path ?? call?.path)
    return {
      file_path: filePath,
      ...(nonnegative(args.offset) !== undefined ? { offset: nonnegative(args.offset) } : {}),
      ...(nonnegative(args.limit) !== undefined ? { limit: nonnegative(args.limit) } : {}),
    }
  }
  if (kind === 'globToolCall') {
    return {
      pattern: textOf(args.globPattern ?? args.pattern ?? call?.globPattern),
      path: textOf(args.targetDirectory ?? args.path ?? call?.targetDirectory),
    }
  }
  return event.input ?? event.rawInput ?? event.arguments ?? variant?.value ?? call ?? {}
}
function toolResultValueOf(event: CursorEvent): unknown {
  const call = toolCallOf(event)
  const variant = toolVariantOf(event)
  return event.output ?? event.rawOutput ?? variant?.value.result ?? call?.result ?? event.result ?? event.content ?? call ?? ''
}
function failureValueOf(value: unknown): unknown {
  const result = recordOf(value)
  if (!result) return undefined
  return result.error ?? result.failure ?? result.rejected
}
function toolFailed(event: CursorEvent): boolean {
  const call = toolCallOf(event)
  const variant = toolVariantOf(event)
  const resultValue = toolResultValueOf(event)
  const result = recordOf(resultValue)
  const statuses = [
    event.status,
    event.subtype,
    call?.status,
    variant?.value.status,
    result?.case,
    result?.status,
  ].map((value) => textOf(value).toLowerCase())
  return event.is_error === true ||
    failureValueOf(resultValue) !== undefined ||
    failureValueOf(variant?.value.result) !== undefined ||
    failureValueOf(call?.result) !== undefined ||
    statuses.some((status) => ['error', 'failed', 'failure', 'rejected'].includes(status))
}
function toolOutputOf(event: CursorEvent): { output: string; outputJson: unknown } {
  const call = toolCallOf(event)
  const variant = toolVariantOf(event)
  const rawResult = toolResultValueOf(event)
  const result = recordOf(rawResult)
  const failed =
    failureValueOf(rawResult) ??
    failureValueOf(variant?.value.result) ??
    failureValueOf(call?.result) ??
    failureValueOf(event.result)
  if (failed !== undefined) return { output: textOf(failed), outputJson: structuredClone(failed) }
  const success = recordOf(result?.success) ?? result
  const source = success ?? variant?.value ?? call ?? {}
  const kind = cursorToolKindOf(event)
  if (kind === 'shellToolCall') {
    const stdout = textOf(source.stdout ?? variant?.value.stdout ?? call?.stdout)
    const stderr = textOf(source.stderr ?? variant?.value.stderr ?? call?.stderr)
    const output = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '')
    const outputJson = { ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) }
    return { output: output || textOf(rawResult), outputJson }
  }
  if (kind === 'readToolCall') {
    const content = source.content ?? variant?.value.content ?? call?.content ?? rawResult
    return { output: textOf(content), outputJson: structuredClone(content) }
  }
  if (kind === 'globToolCall') {
    const files = source.files ?? variant?.value.files ?? call?.files ?? rawResult
    return {
      output: Array.isArray(files) ? files.map(textOf).join('\n') : textOf(files),
      outputJson: structuredClone(files),
    }
  }
  return { output: textOf(rawResult), outputJson: structuredClone(rawResult) }
}

export class CursorAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'cursor'
  readonly capabilities: EngineCapabilities = {
    billingMode: 'external',
    supportsEffort: false,
    resumeKind: 'cursor-session',
    needsServerRequestId: true,
    historyMode: 'stateless-replay',
    maxPromptBytes: CURSOR_MAX_PROMPT_BYTES,
  }
  private readonly opts: EngineCreateOpts
  private active: TurnCtx | null = null
  private currentModel: string | undefined
  private currentToolsets: string[] | undefined
  private target: ExecutionTarget = { kind: 'local' }
  private drain: Promise<void> = Promise.resolve()
  private resolveDrain: (() => void) | null = null
  lastActivityAt = 0

  constructor(opts: EngineCreateOpts) { super(); this.opts = { ...opts }; this.setModel(opts.model); this.currentToolsets = opts.agentToolsets }
  start(): Promise<void> { return Promise.resolve() }
  submitTurn(params: TurnParams): EngineTurnRun {
    let resolve!: (value: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((r) => { resolve = r })
    const ctx: TurnCtx = { params, startedAt: Date.now(), proc: null, assistantText: '', thinkingText: '', assistantSegments: [], thinkingSegments: [], tools: new Map(), pending: new Set(), startedTools: new Map(), stderr: '', terminal: false, interrupted: false, error: null, assistantPartialText: '', pendingAssistantText: null, assistantSegmentClosed: false, thinkingSegmentClosed: false, rawToSafeToolId: new Map(), safeToRawToolId: new Map(), fallbackToolSequence: 0, resolve }
    this.active = ctx; this.lastActivityAt = Date.now(); this.drain = new Promise((r) => { this.resolveDrain = r })
    const submitted = this.spawnTurn(ctx).catch((err) => { if (!ctx.terminal) this.finish(ctx, String(err)); this.resolveDrain?.(); this.resolveDrain = null; if (this.active === ctx) this.active = null; throw err })
    return { submitted, summary, end: () => this.forceEnd(ctx), getPartialSnapshot: () => snapshot(ctx), getPhantomSignals: () => ({ ...EMPTY_SIGNALS }), get finalized() { return ctx.terminal }, get pendingToolCalls() { return ctx.pending.size } }
  }
  private async spawnTurn(ctx: TurnCtx): Promise<void> {
    let cwd = this.opts.agentBaseDir
    if (this.opts.sessionId && this.opts.getRepoSnapshot) { const s = this.opts.getRepoSnapshot(this.opts.sessionId); if (s?.status === 'ready' && s.workspaceDir) cwd = s.workspaceDir }
    const bin = process.env.OC_CURSOR_WRAPPER_BIN?.trim() || '/usr/local/bin/oc-cursor'
    const selected = CURSOR_ENGINE_MODELS.find((model) => model.id === this.currentModel)
    if (!selected) throw new Error(`Cursor model '${String(this.currentModel)}' is not allowlisted`)
    const prompt = promptOf(ctx.params.input)
    if (Buffer.byteLength(prompt, 'utf8') > CURSOR_MAX_PROMPT_BYTES) {
      throw new Error('PROMPT_TOO_LONG: engine prompt transport limit exceeded')
    }
    const args = [
      ...(selected.upstreamModel === null ? [] : ['--model', selected.upstreamModel]),
      '--mode', 'ask', '--', prompt,
    ]
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('CURSOR_')) delete env[key]
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env })
    ctx.proc = proc; this.emit('spawn', { resumed: false })
    let buffer = ''
    proc.stdout.setEncoding('utf8'); proc.stdout.on('data', (chunk: string) => { this.lastActivityAt = Date.now(); this.emit('activity'); buffer += chunk; for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (line) this.handleLine(ctx, line) } })
    proc.stderr.setEncoding('utf8'); proc.stderr.on('data', (chunk: string) => { this.lastActivityAt = Date.now(); this.emit('activity'); if (ctx.stderr.length < 32768) ctx.stderr += chunk.slice(0, 32768 - ctx.stderr.length) })
    proc.once('error', (err) => { if (!ctx.terminal) this.finish(ctx, String(err)); this.emit('error', err) })
    proc.once('close', (code, signal) => { if (buffer.trim()) this.handleLine(ctx, buffer.trim()); this.flushPendingAssistant(ctx, false); this.resolveDrain?.(); this.resolveDrain = null; if (!ctx.terminal) this.finish(ctx, ctx.stderr.trim() || `Cursor CLI exited with code ${String(code)}`); this.emit('exit', { code, signal, crashed: !ctx.interrupted && code !== 0 }); if (this.active === ctx) this.active = null })
  }
  private emitText(ctx: TurnCtx, kind: 'text' | 'thinking', value: unknown): void {
    const valueText = textOf(value); if (!valueText) return
    const segments = kind === 'text' ? ctx.assistantSegments : ctx.thinkingSegments
    const segmentClosed = kind === 'text' ? ctx.assistantSegmentClosed : ctx.thinkingSegmentClosed
    if (!segments.at(-1) || segmentClosed) {
      segments.push({ index: segments.length, text: '', ts: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() })
      if (kind === 'text') ctx.assistantSegmentClosed = false
      else ctx.thinkingSegmentClosed = false
    }
    const segment = segments.at(-1)!
    segment.text += valueText
    if (kind === 'text') ctx.assistantText += valueText; else ctx.thinkingText += valueText
    const messageIdBase = kind === 'text' ? ctx.params.assistantMessageId : ctx.params.thinkingMessageId
    ctx.params.onEvent({ kind: 'block', block: { kind, text: valueText, ...(messageIdBase ? { messageId: `${messageIdBase}-s${segment.index}` } : {}) } })
  }
  private handleLine(ctx: TurnCtx, line: string): void {
    let event: CursorEvent
    try { event = JSON.parse(line) as CursorEvent } catch (err) { this.emit('parse_error', { line, err }); return }
    const type = textOf(event.type).toLowerCase()
    const aggregateBoundary = type === 'retry'
      || (type === 'interaction_query' && textOf(event.subtype).toLowerCase() === 'request')
    this.flushPendingAssistant(ctx, aggregateBoundary)
    if (type === 'assistant') {
      const value = assistantTextOf(event); if (!value) return
      const officialNested = recordOf(event.message) !== null
      const partialDelta = officialNested && typeof event.timestamp_ms === 'number' && event.model_call_id === undefined
      if (partialDelta && value === ctx.assistantPartialText && ctx.assistantPartialText) ctx.pendingAssistantText = value
      else if (partialDelta) { ctx.assistantPartialText += value; this.emitText(ctx, 'text', value) }
      else { if (value !== ctx.assistantPartialText) this.emitText(ctx, 'text', value); ctx.assistantPartialText = '' }
      return
    }
    if (type === 'text' || type === 'assistant_delta') { this.emitText(ctx, 'text', event.text ?? event.content ?? event.delta); return }
    if (type === 'thinking' || type === 'thought' || type === 'thinking_delta') { this.emitText(ctx, 'thinking', event.text ?? event.message ?? event.content ?? event.delta); return }
    if (type === 'tool_call') {
      if (textOf(event.subtype).toLowerCase() === 'completed') this.toolResult(ctx, event)
      else this.toolStart(ctx, event)
      return
    }
    if (type === 'tool_use' || type === 'tool_start') { this.toolStart(ctx, event); return }
    if (type === 'tool_result' || type === 'tool_call_update' || type === 'tool_end') { this.toolResult(ctx, event); return }
    const reported = usageOf(event); if (reported) ctx.usage = reported
    if (type === 'error') { ctx.error = textOf(event.message ?? event.error ?? event.data) || 'Cursor CLI error'; return }
    if (type === 'result') {
      const failed = event.is_error === true || ['error', 'failed', 'failure'].includes(textOf(event.subtype).toLowerCase())
      this.finish(ctx, failed ? textOf(event.error ?? event.result ?? event.message) || ctx.error || 'Cursor CLI error' : ctx.error)
    }
  }
  private flushPendingAssistant(ctx: TurnCtx, aggregateBoundary: boolean): void {
    const value = ctx.pendingAssistantText; if (value === null) return
    ctx.pendingAssistantText = null
    if (aggregateBoundary) { ctx.assistantPartialText = ''; return }
    ctx.assistantPartialText += value; this.emitText(ctx, 'text', value)
  }
  private safeToolId(ctx: TurnCtx, rawId: string): string {
    const existing = ctx.rawToSafeToolId.get(rawId)
    if (existing) return existing
    for (let counter = 0; ; counter += 1) {
      const digest = createHash('sha256')
        .update(`openclaude:cursor-tool-id:v1:${counter}:${rawId}`)
        .digest('hex')
      const candidate = `cursor-tool-${digest}`
      const owner = ctx.safeToRawToolId.get(candidate)
      if (owner !== undefined && owner !== rawId) continue
      ctx.rawToSafeToolId.set(rawId, candidate)
      ctx.safeToRawToolId.set(candidate, rawId)
      return candidate
    }
  }
  private nextFallbackToolId(ctx: TurnCtx): string {
    ctx.fallbackToolSequence += 1
    return `generated:${ctx.fallbackToolSequence}`
  }
  private closeContentSegments(ctx: TurnCtx): void {
    ctx.assistantPartialText = ''
    ctx.pendingAssistantText = null
    ctx.assistantSegmentClosed = ctx.assistantSegments.length > 0
    ctx.thinkingSegmentClosed = ctx.thinkingSegments.length > 0
  }
  private toolStart(ctx: TurnCtx, event: CursorEvent, rawIdOverride?: string): void {
    const rawId = rawIdOverride ?? (rawToolIdOf(event) || this.nextFallbackToolId(ctx))
    const id = this.safeToolId(ctx, rawId)
    const name = toolNameOf(event); const input = toolInputOf(event)
    if (ctx.tools.has(id)) return
    this.flushPendingAssistant(ctx, false)
    this.closeContentSegments(ctx)
    const tool: TurnToolEntry = { toolUseId: id, blockId: id, toolName: name, inputJson: structuredClone(input), inputPreview: textOf(input).slice(0, 500), output: '', completed: false, isError: false, durationMs: 0, ts: Date.now(), arrivedAt: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() }
    ctx.tools.set(id, tool); ctx.pending.add(id); ctx.startedTools.set(id, Date.now()); ctx.params.toolUseIdToName.set(id, name)
    const block: OutboundContentBlock = { kind: 'tool_use', blockId: id, toolName: name, inputJson: structuredClone(input), inputPreview: tool.inputPreview, partial: false }
    ctx.params.onEvent({ kind: 'block', block }); ctx.params.onEvent({ kind: 'tool_use_detected', tool: { name, id, input: input && typeof input === 'object' ? structuredClone(input) as Record<string, any> : {} } })
  }
  private toolResult(ctx: TurnCtx, event: CursorEvent): void {
    const rawId = rawToolIdOf(event) || this.nextFallbackToolId(ctx)
    const id = this.safeToolId(ctx, rawId)
    if (!ctx.tools.has(id)) this.toolStart(ctx, event, rawId)
    const tool = ctx.tools.get(id)!; if (tool.completed) return
    const { output, outputJson } = toolOutputOf(event); const isError = toolFailed(event)
    Object.assign(tool, { output, outputJson: structuredClone(outputJson), completed: true, isError, durationMs: Date.now() - (ctx.startedTools.get(id) ?? Date.now()), ts: Date.now() }); ctx.pending.delete(id)
    ctx.params.onEvent({ kind: 'block', block: { kind: 'tool_result', toolUseBlockId: id, toolName: tool.toolName, isError, output, outputJson: structuredClone(outputJson), preview: output.slice(0, 500) } }); ctx.params.onEvent({ kind: 'tool_result_detected', result: { toolUseId: id, toolName: tool.toolName, preview: output.slice(0, 500), isError, durationMs: tool.durationMs, inputPreview: tool.inputPreview } })
  }
  private finish(ctx: TurnCtx, detail: string | null): void {
    if (ctx.terminal) return; ctx.terminal = true; const cls = detail ? unavailable(detail) : null
    const safeDetail = detail === null ? null : ctx.interrupted ? 'Cursor turn cancelled' : cls === 'auth' ? 'Cursor authentication unavailable' : cls === 'quota' ? 'Cursor quota unavailable' : 'Cursor CLI failed'
    const status: EngineExternalBillingEvent['status'] = cls ? 'unavailable' : detail ? 'error' : 'success'
    if (ctx.params.requestId && REQUEST_ID_RE.test(ctx.params.requestId)) this.emit('external_billing', { requestId: ctx.params.requestId, engine: 'cursor', status, durationMs: Date.now() - ctx.startedAt, ...(ctx.usage ? { usage: ctx.usage } : {}), ...(ctx.interrupted ? { terminalCode: 'USER_CANCELLED' } : cls === 'auth' ? { terminalCode: 'AUTH_UNAVAILABLE' } : cls === 'quota' ? { terminalCode: 'QUOTA_UNAVAILABLE' } : detail ? { terminalCode: 'ENGINE_ERROR' } : {}) } satisfies EngineExternalBillingEvent)
    const errorClass = detail ? classifyRunError(detail).code : undefined
    if (detail) ctx.params.onEvent({ kind: 'error', error: safeDetail!, errorClass, ...(ctx.interrupted ? { errorCode: 'user_cancelled' as const } : {}) })
    if (ctx.usage) ctx.params.onEvent({ kind: 'usage', usage: { inputTokens: ctx.usage.input_tokens ?? 0, outputTokens: ctx.usage.output_tokens ?? 0, cacheReadTokens: ctx.usage.cache_read_input_tokens ?? 0, cacheCreationTokens: ctx.usage.cache_creation_input_tokens ?? 0, totalTokens: Object.values(ctx.usage).reduce((a, b) => a + (b ?? 0), 0) } })
    ctx.params.onEvent({ kind: 'final', meta: { ...finalUsageMeta(ctx.usage), ...(ctx.interrupted ? { stopReason: 'interrupted' } : {}) } })
    ctx.params.sessionTotals.turns += 1
    const u = ctx.usage; ctx.resolve({ usage: { cost: 0, inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheCreationTokens: u?.cache_creation_input_tokens ?? 0, totalTokens: u ? Object.values(u).reduce((a, b) => a + (b ?? 0), 0) : 0 }, assistantText: ctx.assistantText, thinkingText: ctx.thinkingText, assistantSegments: ctx.assistantSegments.map((v) => ({ ...v })), thinkingSegments: ctx.thinkingSegments.map((v) => ({ ...v })), tools: [...ctx.tools.values()].map((v) => structuredClone(v)), runtimeEvents: [], stopReason: ctx.interrupted ? 'interrupted' : null, numTurns: 1, isError: !!detail, ...(detail ? { errorKind: 'other' as const, errorClass, errorDetail: safeDetail! } : {}), staleResumeId: false, phantomSignals: { ...EMPTY_SIGNALS } })
  }
  private forceEnd(ctx: TurnCtx): void { if (!ctx.terminal) { ctx.terminal = true; ctx.resolve(null) } }
  interrupt(): boolean { const c = this.active; if (!c?.proc || c.proc.killed) return false; c.interrupted = true; try { process.kill(-c.proc.pid!, 'SIGINT') } catch { c.proc.kill('SIGINT') }; return true }
  async shutdown(): Promise<void> { const c = this.active; if (c?.proc && !c.proc.killed) { try { process.kill(-c.proc.pid!, 'SIGTERM') } catch { c.proc.kill('SIGTERM') } }; await this.waitForOutputDrain() }
  waitForOutputDrain(): Promise<void> { return this.drain }
  get nativeSessionId(): null { return null }
  clearSessionId(): void {}
  setModel(model: string | undefined): void {
    const selected = model ?? DEFAULT_CURSOR_ENGINE_MODEL
    if (!CURSOR_ENGINE_MODELS.some((entry) => entry.id === selected)) {
      throw new Error(`Cursor model '${selected}' is not allowlisted`)
    }
    this.currentModel = selected
  }
  get model(): string | undefined { return this.currentModel }
  setEffortLevel(level: string | undefined): void { if (level !== undefined) throw new Error('Cursor engine does not expose reasoning effort') }
  get effortLevel(): undefined { return undefined }
  setTraceId(_traceId: string | undefined): void {}
  setGoalState(_goal: GoalStateSnapshot | null): Promise<void> { return Promise.resolve() }
  updateConfig(config: OpenClaudeConfig): void { this.opts.config = config }
  setToolsets(toolsets: string[] | undefined): void { this.currentToolsets = toolsets }
  get toolsets(): string[] | undefined { return this.currentToolsets }
  setExecutionTarget(target: ExecutionTarget): void { if (target.kind !== 'local') throw new Error('Cursor engine supports local execution only'); this.target = target }
  get executionTarget(): ExecutionTarget { return this.target }
  sendPermissionResponse(): boolean { return false }
  getPartialSnapshot(): PartialSnapshot { return snapshot(this.active) }
  get pendingToolCalls(): number { return this.active?.pending.size ?? 0 }
  get isRunning(): boolean { return !!this.active?.proc && !this.active.proc.killed && !this.active.terminal }
  getBoundRepoBinding(): null { return null }
}

registerEngine('cursor', (opts) => new CursorAdapter(opts))
