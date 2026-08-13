/** First-class adapter for the pinned official Cursor Agent CLI.
 * Authentication remains exclusively inside the account-scoped oc-cursor
 * launcher; this adapter neither reads nor transports credentials. */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { GoalStateSnapshot, OutboundContentBlock } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { EngineAdapter, EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { EngineExternalBillingEvent, PartialSnapshot, PhantomSignals, SegmentRecord, TurnSummary, TurnToolEntry } from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { classifyRunError } from '../errorClassify.js'

const CURSOR_MODEL = 'cursor-auto'
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const EMPTY_SIGNALS: PhantomSignals = { apiState: 'unknown', skipReason: null }

type CursorEvent = Record<string, unknown> & { type?: unknown }
type ReportedUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
interface TurnCtx {
  params: TurnParams; startedAt: number; proc: ChildProcessByStdio<null, Readable, Readable> | null
  assistantText: string; thinkingText: string; assistantSegments: SegmentRecord[]; thinkingSegments: SegmentRecord[]
  tools: Map<string, TurnToolEntry>; pending: Set<string>; startedTools: Map<string, number>
  stderr: string; terminal: boolean; interrupted: boolean; error: string | null; usage?: ReportedUsage
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
function usageOf(event: CursorEvent): ReportedUsage | undefined {
  const raw = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : null
  if (!raw) return undefined
  const usage: ReportedUsage = {
    input_tokens: nonnegative(raw.input_tokens ?? raw.inputTokens),
    output_tokens: nonnegative(raw.output_tokens ?? raw.outputTokens),
    cache_read_input_tokens: nonnegative(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens),
    cache_creation_input_tokens: nonnegative(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens),
  }
  for (const key of Object.keys(usage) as (keyof ReportedUsage)[]) if (usage[key] === undefined) delete usage[key]
  return Object.keys(usage).length ? usage : undefined
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

export class CursorAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'cursor'
  readonly capabilities: EngineCapabilities = { billingMode: 'external', supportsEffort: false, resumeKind: 'cursor-session', needsServerRequestId: true }
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
    const ctx: TurnCtx = { params, startedAt: Date.now(), proc: null, assistantText: '', thinkingText: '', assistantSegments: [], thinkingSegments: [], tools: new Map(), pending: new Set(), startedTools: new Map(), stderr: '', terminal: false, interrupted: false, error: null, resolve }
    this.active = ctx; this.lastActivityAt = Date.now(); this.drain = new Promise((r) => { this.resolveDrain = r })
    const submitted = this.spawnTurn(ctx).catch((err) => { if (!ctx.terminal) this.finish(ctx, String(err)); this.resolveDrain?.(); this.resolveDrain = null; if (this.active === ctx) this.active = null; throw err })
    return { submitted, summary, end: () => this.forceEnd(ctx), getPartialSnapshot: () => snapshot(ctx), getPhantomSignals: () => ({ ...EMPTY_SIGNALS }), get finalized() { return ctx.terminal }, get pendingToolCalls() { return ctx.pending.size } }
  }
  private async spawnTurn(ctx: TurnCtx): Promise<void> {
    let cwd = this.opts.agentBaseDir
    if (this.opts.sessionId && this.opts.getRepoSnapshot) { const s = this.opts.getRepoSnapshot(this.opts.sessionId); if (s?.status === 'ready' && s.workspaceDir) cwd = s.workspaceDir }
    const bin = process.env.OC_CURSOR_WRAPPER_BIN?.trim() || '/usr/local/bin/oc-cursor'
    const args = ['--mode', 'ask', '--', promptOf(ctx.params.input)]
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('CURSOR_')) delete env[key]
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env })
    ctx.proc = proc; this.emit('spawn', { resumed: false })
    let buffer = ''
    proc.stdout.setEncoding('utf8'); proc.stdout.on('data', (chunk: string) => { this.lastActivityAt = Date.now(); this.emit('activity'); buffer += chunk; for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (line) this.handleLine(ctx, line) } })
    proc.stderr.setEncoding('utf8'); proc.stderr.on('data', (chunk: string) => { this.lastActivityAt = Date.now(); this.emit('activity'); if (ctx.stderr.length < 32768) ctx.stderr += chunk.slice(0, 32768 - ctx.stderr.length) })
    proc.once('error', (err) => { if (!ctx.terminal) this.finish(ctx, String(err)); this.emit('error', err) })
    proc.once('close', (code, signal) => { if (buffer.trim()) this.handleLine(ctx, buffer.trim()); this.resolveDrain?.(); this.resolveDrain = null; if (!ctx.terminal) this.finish(ctx, ctx.stderr.trim() || `Cursor CLI exited with code ${String(code)}`); this.emit('exit', { code, signal, crashed: !ctx.interrupted && code !== 0 }); if (this.active === ctx) this.active = null })
  }
  private emitText(ctx: TurnCtx, kind: 'text' | 'thinking', value: unknown): void {
    const valueText = textOf(value); if (!valueText) return
    const segments = kind === 'text' ? ctx.assistantSegments : ctx.thinkingSegments
    const current = segments.at(-1); if (!current) segments.push({ index: 0, text: '', ts: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() })
    segments.at(-1)!.text += valueText
    if (kind === 'text') ctx.assistantText += valueText; else ctx.thinkingText += valueText
    ctx.params.onEvent({ kind: 'block', block: { kind, text: valueText, ...(kind === 'text' && ctx.params.assistantMessageId ? { messageId: ctx.params.assistantMessageId } : {}), ...(kind === 'thinking' && ctx.params.thinkingMessageId ? { messageId: ctx.params.thinkingMessageId } : {}) } })
  }
  private handleLine(ctx: TurnCtx, line: string): void {
    let event: CursorEvent
    try { event = JSON.parse(line) as CursorEvent } catch (err) { this.emit('parse_error', { line, err }); return }
    const type = textOf(event.type).toLowerCase()
    if (type === 'assistant' || type === 'text' || type === 'assistant_delta') { this.emitText(ctx, 'text', event.text ?? event.message ?? event.content ?? event.delta); return }
    if (type === 'thinking' || type === 'thought' || type === 'thinking_delta') { this.emitText(ctx, 'thinking', event.text ?? event.message ?? event.content ?? event.delta); return }
    if (type === 'tool_call' || type === 'tool_use' || type === 'tool_start') { this.toolStart(ctx, event); return }
    if (type === 'tool_result' || type === 'tool_call_update' || type === 'tool_end') { this.toolResult(ctx, event); return }
    const reported = usageOf(event); if (reported) ctx.usage = reported
    if (type === 'error') { ctx.error = textOf(event.message ?? event.error ?? event.data) || 'Cursor CLI error'; return }
    if (type === 'result') this.finish(ctx, ctx.error)
  }
  private toolStart(ctx: TurnCtx, event: CursorEvent): void {
    const id = textOf(event.tool_call_id ?? event.toolCallId ?? event.id) || `cursor-tool-${ctx.tools.size + 1}`
    const name = textOf(event.tool_name ?? event.toolName ?? event.name) || 'CursorTool'; const input = event.input ?? event.rawInput ?? event.arguments ?? {}
    if (ctx.tools.has(id)) return
    const tool: TurnToolEntry = { toolUseId: id, blockId: id, toolName: name, inputJson: structuredClone(input), inputPreview: textOf(input).slice(0, 500), output: '', completed: false, isError: false, durationMs: 0, ts: Date.now(), arrivedAt: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() }
    ctx.tools.set(id, tool); ctx.pending.add(id); ctx.startedTools.set(id, Date.now()); ctx.params.toolUseIdToName.set(id, name)
    const block: OutboundContentBlock = { kind: 'tool_use', blockId: id, toolName: name, inputJson: structuredClone(input), inputPreview: tool.inputPreview, partial: false }
    ctx.params.onEvent({ kind: 'block', block }); ctx.params.onEvent({ kind: 'tool_use_detected', tool: { name, id, input: input && typeof input === 'object' ? structuredClone(input) as Record<string, any> : {} } })
  }
  private toolResult(ctx: TurnCtx, event: CursorEvent): void {
    const id = textOf(event.tool_call_id ?? event.toolCallId ?? event.id); if (!id) return
    if (!ctx.tools.has(id)) this.toolStart(ctx, event)
    const tool = ctx.tools.get(id)!; if (tool.completed) return
    const outputJson = event.output ?? event.rawOutput ?? event.result ?? event.content ?? ''; const output = textOf(outputJson); const status = textOf(event.status).toLowerCase(); const isError = event.is_error === true || ['error', 'failed'].includes(status)
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
    ctx.params.onEvent({ kind: 'final', meta: { ...(ctx.usage ? { inputTokens: ctx.usage.input_tokens, outputTokens: ctx.usage.output_tokens, cacheReadTokens: ctx.usage.cache_read_input_tokens, cacheCreationTokens: ctx.usage.cache_creation_input_tokens } : {}), stopReason: ctx.interrupted ? 'interrupted' : undefined } })
    ctx.params.sessionTotals.turns += 1
    const u = ctx.usage; ctx.resolve({ usage: { cost: 0, inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheCreationTokens: u?.cache_creation_input_tokens ?? 0, totalTokens: u ? Object.values(u).reduce((a, b) => a + (b ?? 0), 0) : 0 }, assistantText: ctx.assistantText, thinkingText: ctx.thinkingText, assistantSegments: ctx.assistantSegments.map((v) => ({ ...v })), thinkingSegments: ctx.thinkingSegments.map((v) => ({ ...v })), tools: [...ctx.tools.values()].map((v) => structuredClone(v)), runtimeEvents: [], stopReason: ctx.interrupted ? 'interrupted' : null, numTurns: 1, isError: !!detail, ...(detail ? { errorKind: 'other' as const, errorClass, errorDetail: safeDetail! } : {}), staleResumeId: false, phantomSignals: { ...EMPTY_SIGNALS } })
  }
  private forceEnd(ctx: TurnCtx): void { if (!ctx.terminal) { ctx.terminal = true; ctx.resolve(null) } }
  interrupt(): boolean { const c = this.active; if (!c?.proc || c.proc.killed) return false; c.interrupted = true; try { process.kill(-c.proc.pid!, 'SIGINT') } catch { c.proc.kill('SIGINT') }; return true }
  async shutdown(): Promise<void> { const c = this.active; if (c?.proc && !c.proc.killed) { try { process.kill(-c.proc.pid!, 'SIGTERM') } catch { c.proc.kill('SIGTERM') } }; await this.waitForOutputDrain() }
  waitForOutputDrain(): Promise<void> { return this.drain }
  get nativeSessionId(): null { return null }
  clearSessionId(): void {}
  setModel(model: string | undefined): void { if (model !== undefined && model !== CURSOR_MODEL) throw new Error(`Cursor model '${model}' is not allowlisted`); this.currentModel = model }
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
