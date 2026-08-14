/**
 * First-class adapter for xAI's official Grok CLI. The CLI runs once per turn
 * in headless streaming-json mode; subscription credentials never enter the
 * user container. Instead the master supplies an opaque, one-turn relay token.
 */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GoalStateSnapshot, OutboundContentBlock } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineTurnRun,
  TurnParams,
} from './engineAdapter.js'
import type {
  EngineBillingEvent,
  EngineEvent,
  PartialSnapshot,
  PhantomSignals,
  SegmentRecord,
  TurnSummary,
  TurnToolEntry,
} from './engineEvents.js'
import { engineSessionId } from './engineSessionId.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { buildCodexEnv } from './codexShared.js'

const GROK_UPSTREAM_MODEL = 'grok-4.6'
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
const EMPTY_SIGNALS: Readonly<PhantomSignals> = Object.freeze({
  apiState: 'unknown',
  skipReason: null,
})
const MANAGED_GROK_CONFIG = '[cli]\nauto_update = false\n\n[features]\ntelemetry = false\nfeedback = false\n\n[shell_environment_policy]\ninherit = "all"\nexclude = ["XAI_*", "GROK_*"]\n'

export interface GrokRouteOverride {
  baseUrl: string
  routeToken: string
}

type GrokEvent = Record<string, unknown> & { type?: unknown }

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function promptText(input: TurnParams['input']): string {
  if (typeof input === 'string') return input
  return input
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return asText(block)
    })
    .filter(Boolean)
    .join('\n')
}

function snapshotOf(ctx: GrokTurnContext | null): PartialSnapshot {
  if (!ctx) {
    return {
      assistantText: '',
      thinkingText: '',
      completedTools: [],
      assistantSegments: [],
      thinkingSegments: [],
      runtimeEvents: [],
    }
  }
  return {
    assistantText: ctx.assistantText,
    thinkingText: ctx.thinkingText,
    completedTools: [...ctx.tools.values()].map((tool) => structuredClone(tool)),
    assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
    thinkingSegments: ctx.thinkingSegments.map((segment) => ({ ...segment })),
    runtimeEvents: [],
  }
}

function grokUsage(event: GrokEvent): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
} {
  const raw = event.usage && typeof event.usage === 'object'
    ? event.usage as Record<string, unknown>
    : {}
  const safe = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0
  const inputTokens = safe(raw.input_tokens ?? raw.inputTokens)
  const outputTokens = safe(raw.output_tokens ?? raw.outputTokens)
  const cacheReadTokens = safe(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens)
  const cacheWriteTokens = safe(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens)
  const reasoningTokens = safe(raw.reasoning_tokens ?? raw.reasoningTokens)
  const reportedTotal = safe(raw.total_tokens ?? raw.totalTokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

function authError(detail: string): boolean {
  return /authenticat|credentials|\b401\b|unauthorized|token (?:is )?(?:expired|invalid|revoked)|not logged in/i.test(detail)
}

interface GrokTurnContext {
  params: TurnParams
  startedAt: number
  proc: ChildProcessByStdio<null, Readable, Readable> | null
  assistantText: string
  thinkingText: string
  assistantSegments: SegmentRecord[]
  thinkingSegments: SegmentRecord[]
  lastContentKind: 'text' | 'thought' | null
  tools: Map<string, TurnToolEntry>
  toolStartedAt: Map<string, number>
  finalizedToolIds: Set<string>
  pendingToolIds: Set<string>
  stderr: string
  terminal: boolean
  interrupted: boolean
  errorDetail: string | null
  lastUsage: ReturnType<typeof grokUsage>
  resolveSummary: (summary: TurnSummary | null) => void
}

export class GrokAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'grok'
  readonly capabilities: EngineCapabilities = {
    billingMode: 'engine-reported',
    supportsEffort: true,
    resumeKind: 'grok-session',
    needsServerRequestId: true,
    historyMode: 'native-resume',
  }

  private readonly opts: EngineCreateOpts
  private readonly stableEngineSessionId: string
  private route: GrokRouteOverride | null = null
  private active: GrokTurnContext | null = null
  private nativeId: string | null
  private currentModel: string | undefined
  private currentEffort: string | undefined
  private currentToolsets: string[] | undefined
  private currentTarget: ExecutionTarget = { kind: 'local' }
  private traceId: string | undefined
  private drain: Promise<void> = Promise.resolve()
  private resolveDrain: (() => void) | null = null
  lastActivityAt = 0

  constructor(opts: EngineCreateOpts) {
    super()
    this.opts = { ...opts }
    this.stableEngineSessionId = engineSessionId(opts.sessionKey)
    this.nativeId = opts.resumeSessionId ?? null
    this.currentModel = opts.model
    this.currentEffort = opts.effortLevel
    this.currentToolsets = opts.agentToolsets
  }

  start(): Promise<void> {
    return Promise.resolve()
  }

  setGrokRoute(route: GrokRouteOverride | null | undefined): void {
    this.route = route ? { ...route } : null
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    let resolveSummary!: (summary: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((resolve) => { resolveSummary = resolve })
    const ctx: GrokTurnContext = {
      params,
      startedAt: Date.now(),
      proc: null,
      assistantText: '',
      thinkingText: '',
      assistantSegments: [],
      thinkingSegments: [],
      lastContentKind: null,
      tools: new Map(),
      toolStartedAt: new Map(),
      finalizedToolIds: new Set(),
      pendingToolIds: new Set(),
      stderr: '',
      terminal: false,
      interrupted: false,
      errorDetail: null,
      lastUsage: grokUsage({}),
      resolveSummary,
    }
    this.active = ctx
    this.lastActivityAt = Date.now()
    this.drain = new Promise<void>((resolve) => { this.resolveDrain = resolve })
    const submitted = this.spawnTurn(ctx).catch((err) => {
      this.forceEnd(ctx)
      this.resolveDrain?.()
      this.resolveDrain = null
      if (this.active === ctx) this.active = null
      throw err
    })
    return {
      submitted,
      summary,
      end: () => this.forceEnd(ctx),
      getPartialSnapshot: () => snapshotOf(ctx),
      getPhantomSignals: () => ({ ...EMPTY_SIGNALS }),
      get finalized() { return ctx.terminal },
      get pendingToolCalls() { return ctx.pendingToolIds.size },
    }
  }

  private async spawnTurn(ctx: GrokTurnContext): Promise<void> {
    const route = this.route
    if (!route || !ROUTE_TOKEN_RE.test(route.routeToken)) {
      throw new Error('GROK_ROUTE_REQUIRED: missing master-owned Grok relay route')
    }
    let parsed: URL
    try {
      parsed = new URL(route.baseUrl)
    } catch {
      throw new Error('GROK_ROUTE_INVALID: malformed relay base URL')
    }
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== `/internal/v5/grok-relay/route/${route.routeToken}/v1` ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('GROK_ROUTE_INVALID: relay must be token-bound loopback')
    }

    let cwd = this.opts.agentBaseDir
    if (this.opts.sessionId && this.opts.getRepoSnapshot) {
      const snapshot = this.opts.getRepoSnapshot(this.opts.sessionId)
      if (snapshot?.status === 'ready' && snapshot.workspaceDir) cwd = snapshot.workspaceDir
    }
    const args = [
      '--agent', 'grok-build',
      '--model', GROK_UPSTREAM_MODEL,
      '-p', this.composePrompt(ctx.params),
      '--output-format', 'streaming-json',
      '--always-approve',
      '--no-subagents',
      '--no-memory',
      '--cwd', cwd,
    ]
    if (this.nativeId) args.push('--resume', this.nativeId)
    if (this.currentEffort && ['low', 'medium', 'high'].includes(this.currentEffort)) {
      args.push('--reasoning-effort', this.currentEffort)
    }
    const isolatedEnv = buildCodexEnv()
    for (const key of Object.keys(isolatedEnv)) {
      if (key.startsWith('XAI_') || key.startsWith('GROK_') || key.startsWith('CODEX_')) {
        delete isolatedEnv[key]
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...isolatedEnv,
      XAI_API_KEY: route.routeToken,
      GROK_XAI_API_BASE_URL: route.baseUrl,
      GROK_CLI_CHAT_PROXY_BASE_URL: route.baseUrl,
      GROK_MODELS_BASE_URL: route.baseUrl,
      GROK_MODELS_LIST_URL: `${route.baseUrl.replace(/\/$/, '')}/models`,
      GROK_CLI_AUTO_UPDATE: 'false',
      GROK_TELEMETRY_ENABLED: 'false',
      GROK_HOME: this.prepareGrokHome(),
      ...(this.traceId ? { OPENCLAUDE_TRACE_ID: this.traceId } : {}),
    }
    const bin = process.env.OC_GROK_CLI_BIN?.trim()
      || (existsSync('/usr/local/bin/grok-native') ? '/usr/local/bin/grok-native' : 'grok')
    const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    ctx.proc = proc
    this.emit('spawn', { resumed: this.nativeId !== null })

    let stdoutBuffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      stdoutBuffer += chunk
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) this.handleLine(ctx, line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      ctx.stderr += chunk
    })
    proc.once('error', (err) => {
      if (!ctx.terminal) this.finishError(ctx, String(err))
      this.emit('error', err)
    })
    proc.once('close', (code, signal) => {
      if (stdoutBuffer.trim()) this.handleLine(ctx, stdoutBuffer.trim())
      this.resolveDrain?.()
      this.resolveDrain = null
      const crashed = !ctx.interrupted && code !== 0
      if (!ctx.terminal) {
        const detail = ctx.errorDetail || ctx.stderr.trim() || `grok exited with code ${String(code)}`
        this.finishError(ctx, detail)
      }
      this.emit('exit', { code, signal, crashed })
      if (this.active === ctx) this.active = null
    })
  }

  private prepareGrokHome(): string {
    const openClaudeHome = process.env.OPENCLAUDE_HOME?.trim() || join(homedir(), '.openclaude')
    const grokHome = join(openClaudeHome, 'grok-build')
    mkdirSync(grokHome, { recursive: true, mode: 0o700 })
    writeFileSync(join(grokHome, 'config.toml'), MANAGED_GROK_CONFIG, { mode: 0o600 })
    return grokHome
  }

  private composePrompt(params: TurnParams): string {
    let persona = ''
    if (this.opts.persona) {
      try { persona = readFileSync(this.opts.persona, 'utf8').trim() } catch { persona = '' }
    }
    const input = promptText(params.input)
    return persona ? `${persona}\n\n${input}` : input
  }

  private handleLine(ctx: GrokTurnContext, line: string): void {
    let event: GrokEvent
    try {
      event = JSON.parse(line) as GrokEvent
    } catch (err) {
      this.emit('parse_error', { line, err })
      return
    }
    const type = event.type
    if (type === 'text') {
      const text = asText(event.data)
      if (!text) return
      if (ctx.lastContentKind !== 'text') {
        ctx.assistantSegments.push({ index: ctx.assistantSegments.length, text: '', ts: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() })
      }
      ctx.lastContentKind = 'text'
      ctx.assistantText += text
      ctx.assistantSegments.at(-1)!.text += text
      ctx.params.onEvent({ kind: 'block', block: { kind: 'text', text, ...(ctx.params.assistantMessageId ? { messageId: ctx.params.assistantMessageId } : {}) } })
      return
    }
    if (type === 'thought') {
      const text = asText(event.data)
      if (!text) return
      if (ctx.lastContentKind !== 'thought') {
        ctx.thinkingSegments.push({ index: ctx.thinkingSegments.length, text: '', ts: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() })
      }
      ctx.lastContentKind = 'thought'
      ctx.thinkingText += text
      ctx.thinkingSegments.at(-1)!.text += text
      ctx.params.onEvent({ kind: 'block', block: { kind: 'thinking', text, ...(ctx.params.thinkingMessageId ? { messageId: ctx.params.thinkingMessageId } : {}) } })
      return
    }
    ctx.lastContentKind = null
    if (type === 'tool_call') {
      this.observeToolCall(ctx, event)
      return
    }
    if (type === 'tool_call_update') {
      this.observeToolUpdate(ctx, event)
      return
    }
    if (type === 'plan') {
      const entries = Array.isArray(event.entries) ? event.entries : []
      const steps = entries.map((entry) => {
        const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const status: 'completed' | 'inProgress' | 'pending' = raw.status === 'completed'
          ? 'completed'
          : raw.status === 'in_progress'
            ? 'inProgress'
            : 'pending'
        return { step: asText(raw.step || raw.title || raw.content), status }
      }).filter((entry) => entry.step)
      ctx.params.onEvent({ kind: 'block', block: { kind: 'plan', steps, partial: false } })
      return
    }
    if (type === 'usage') {
      ctx.lastUsage = grokUsage(event)
      ctx.params.onEvent({ kind: 'usage', usage: {
        totalTokens: ctx.lastUsage.totalTokens,
        inputTokens: ctx.lastUsage.inputTokens,
        outputTokens: ctx.lastUsage.outputTokens,
        cacheReadTokens: ctx.lastUsage.cacheReadTokens,
        cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
      } })
      return
    }
    if (type === 'error') {
      ctx.errorDetail = asText(event.message) || asText(event.data) || 'Grok CLI error'
      if (event.usage && typeof event.usage === 'object') ctx.lastUsage = grokUsage(event)
      return
    }
    if (type === 'end') {
      if (event.usage && typeof event.usage === 'object') ctx.lastUsage = grokUsage(event)
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : null
      if (sessionId) {
        this.nativeId = sessionId
        this.emit('session_id', sessionId)
      }
      this.finish(ctx, event)
    }
  }

  private observeToolCall(ctx: GrokTurnContext, event: GrokEvent): void {
    const id = typeof event.toolCallId === 'string' && event.toolCallId
      ? event.toolCallId
      : `grok-tool-${ctx.tools.size + 1}`
    const toolName = asText(event.toolName || event.kind || event.title) || 'GrokTool'
    const inputJson = event.rawInput ?? null
    const tool: TurnToolEntry = {
      toolUseId: id,
      blockId: id,
      toolName,
      inputJson: structuredClone(inputJson),
      inputPreview: asText(inputJson).slice(0, 500),
      output: '',
      completed: false,
      isError: false,
      durationMs: 0,
      ts: Date.now(),
      arrivedAt: Date.now(),
      eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
    }
    ctx.tools.set(id, tool)
    ctx.toolStartedAt.set(id, Date.now())
    ctx.pendingToolIds.add(id)
    ctx.params.toolUseIdToName.set(id, toolName)
    const block: OutboundContentBlock = { kind: 'tool_use', blockId: id, toolName, inputJson: structuredClone(inputJson), inputPreview: tool.inputPreview, partial: true }
    ctx.params.onEvent({ kind: 'block', block })
    ctx.params.onEvent({ kind: 'tool_use_detected', tool: { name: toolName, id, input: inputJson && typeof inputJson === 'object' ? structuredClone(inputJson) as Record<string, any> : {} } })
  }

  private observeToolUpdate(ctx: GrokTurnContext, event: GrokEvent): void {
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
    if (!id) return
    if (!ctx.tools.has(id)) this.observeToolCall(ctx, { ...event, type: 'tool_call' })
    const tool = ctx.tools.get(id)!
    if (event.rawInput !== undefined) {
      tool.inputJson = structuredClone(event.rawInput)
      tool.inputPreview = asText(event.rawInput).slice(0, 500)
      ctx.params.onEvent({ kind: 'block', block: { kind: 'tool_use', blockId: id, toolName: tool.toolName, inputJson: structuredClone(event.rawInput), inputPreview: tool.inputPreview, partial: false } })
    }
    const status = asText(event.status).toLowerCase()
    if (!['completed', 'complete', 'failed', 'error'].includes(status) || ctx.finalizedToolIds.has(id)) return
    const outputJson = event.rawOutput ?? event.content ?? null
    const output = asText(outputJson)
    const isError = status === 'failed' || status === 'error'
    tool.output = output
    tool.outputJson = structuredClone(outputJson)
    tool.completed = true
    tool.isError = isError
    tool.durationMs = Date.now() - (ctx.toolStartedAt.get(id) ?? Date.now())
    tool.ts = Date.now()
    ctx.finalizedToolIds.add(id)
    ctx.pendingToolIds.delete(id)
    ctx.params.onEvent({ kind: 'block', block: { kind: 'tool_result', toolUseBlockId: id, toolName: tool.toolName, isError, output, outputJson: structuredClone(outputJson), preview: output.slice(0, 500) } })
    ctx.params.onEvent({ kind: 'tool_result_detected', result: { toolUseId: id, toolName: tool.toolName, preview: output.slice(0, 500), isError, durationMs: tool.durationMs, inputPreview: tool.inputPreview } })
  }

  private emitBilling(ctx: GrokTurnContext, status: 'success' | 'error'): void {
    const requestId = ctx.params.requestId
    if (!requestId || !/^[0-9a-f]{32}$/.test(requestId)) return
    const usage = ctx.lastUsage
    // Grok's reasoning_tokens is a subset of output_tokens, while the legacy
    // billing wire expects disjoint output and reasoning counters and folds
    // them together on the commercial master.
    const nonReasoningOutputTokens = Math.max(0, usage.outputTokens - usage.reasoningTokens)
    const billing: EngineBillingEvent = {
      requestId,
      ...(ctx.params.turnKey && /^[0-9a-f]{64}$/.test(ctx.params.turnKey) ? { turnKey: ctx.params.turnKey } : {}),
      ...(ctx.params.usageAttribution?.parentTurnKey ? { parentTurnKey: ctx.params.usageAttribution.parentTurnKey } : {}),
      ...(ctx.params.usageAttribution?.parentSessionId ? { parentSessionId: ctx.params.usageAttribution.parentSessionId } : {}),
      ...(ctx.params.usageAttribution?.delegateAgentId ? { delegateAgentId: ctx.params.usageAttribution.delegateAgentId } : {}),
      engineSessionId: this.stableEngineSessionId,
      status,
      ...(status === 'error' ? { terminalCode: ctx.interrupted ? 'USER_CANCELLED' : 'CODEX_ERROR' } : {}),
      durationMs: Date.now() - ctx.startedAt,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: nonReasoningOutputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheWriteTokens,
        reasoning_output_tokens: usage.reasoningTokens,
      },
    }
    this.emit('billing', billing)
  }

  private finish(ctx: GrokTurnContext, end: GrokEvent | null): void {
    if (ctx.terminal) return
    const upstreamStopReason = typeof end?.stopReason === 'string' ? end.stopReason : null
    if (upstreamStopReason === 'cancelled') ctx.interrupted = true
    if (ctx.interrupted && ctx.errorDetail === null) ctx.errorDetail = 'Grok turn cancelled'
    const stopReason = ctx.interrupted ? 'interrupted' : upstreamStopReason
    ctx.terminal = true
    const isError = ctx.errorDetail !== null
    ctx.params.sessionTotals.turns += 1
    this.emitBilling(ctx, isError ? 'error' : 'success')
    if (isError) ctx.params.onEvent({ kind: 'error', error: ctx.errorDetail! })
    ctx.params.onEvent({ kind: 'final', meta: {
      inputTokens: ctx.lastUsage.inputTokens,
      outputTokens: ctx.lastUsage.outputTokens,
      cacheReadTokens: ctx.lastUsage.cacheReadTokens,
      cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
      totalTokens: ctx.lastUsage.totalTokens,
      stopReason: stopReason ?? undefined,
      cost: 0,
    } })
    ctx.resolveSummary({
      usage: {
        cost: 0,
        inputTokens: ctx.lastUsage.inputTokens,
        outputTokens: ctx.lastUsage.outputTokens,
        cacheReadTokens: ctx.lastUsage.cacheReadTokens,
        cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
        totalTokens: ctx.lastUsage.totalTokens,
      },
      assistantText: ctx.assistantText,
      thinkingText: ctx.thinkingText,
      assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
      thinkingSegments: ctx.thinkingSegments.map((segment) => ({ ...segment })),
      tools: [...ctx.tools.values()].map((tool) => structuredClone(tool)),
      runtimeEvents: [],
      stopReason,
      numTurns: typeof end?.num_turns === 'number' && Number.isFinite(end.num_turns) && end.num_turns >= 0
        ? Math.floor(end.num_turns)
        : 1,
      isError,
      ...(isError ? { errorKind: authError(ctx.errorDetail!) ? 'auth' as const : 'other' as const, errorDetail: ctx.errorDetail! } : {}),
      staleResumeId: false,
      phantomSignals: { ...EMPTY_SIGNALS },
    })
  }

  private finishError(ctx: GrokTurnContext, detail: string): void {
    if (ctx.terminal) return
    ctx.errorDetail = detail
    this.finish(ctx, null)
  }

  private forceEnd(ctx: GrokTurnContext): void {
    if (ctx.terminal) return
    ctx.terminal = true
    ctx.resolveSummary(null)
  }

  interrupt(): boolean {
    const ctx = this.active
    if (!ctx?.proc || ctx.proc.killed) return false
    ctx.interrupted = true
    try { process.kill(-ctx.proc.pid!, 'SIGINT') } catch { ctx.proc.kill('SIGINT') }
    return true
  }

  async shutdown(): Promise<void> {
    const ctx = this.active
    if (ctx?.proc && !ctx.proc.killed) {
      try { process.kill(-ctx.proc.pid!, 'SIGTERM') } catch { ctx.proc.kill('SIGTERM') }
    }
    await this.waitForOutputDrain()
  }

  waitForOutputDrain(): Promise<void> { return this.drain }
  get nativeSessionId(): string | null { return this.nativeId }
  clearSessionId(): void { this.nativeId = null }
  setModel(model: string | undefined): void { this.currentModel = model }
  get model(): string | undefined { return this.currentModel }
  setEffortLevel(level: string | undefined): void { this.currentEffort = level }
  get effortLevel(): string | undefined { return this.currentEffort }
  setTraceId(traceId: string | undefined): void { this.traceId = traceId }
  setGoalState(_goal: GoalStateSnapshot | null): Promise<void> { return Promise.resolve() }
  updateConfig(config: OpenClaudeConfig): void { this.opts.config = config }
  setToolsets(toolsets: string[] | undefined): void { this.currentToolsets = toolsets }
  get toolsets(): string[] | undefined { return this.currentToolsets }
  setExecutionTarget(target: ExecutionTarget): void {
    if (target.kind !== 'local') throw new Error('Grok engine supports local execution only')
    this.currentTarget = target
  }
  get executionTarget(): ExecutionTarget { return this.currentTarget }
  sendPermissionResponse(_requestId: string, _response: unknown): boolean { return false }
  getPartialSnapshot(): PartialSnapshot { return snapshotOf(this.active) }
  get pendingToolCalls(): number { return this.active?.pendingToolIds.size ?? 0 }
  get isRunning(): boolean { return !!this.active?.proc && !this.active.proc.killed && !this.active.terminal }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null { return null }
}

registerEngine('grok', (opts) => new GrokAdapter(opts))
