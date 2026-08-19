/**
 * Experimental community ZCode CLI adapter (zcode.cjs 0.16.3).
 * Not an official standalone CLI. Adapter never reads or logs the Coding Plan
 * key; hosted turns receive a short-lived loopback relay URL + opaque token.
 */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import {
  ZCODE_HOSTED_PERMISSION_MODE,
  zcodeTransportModelId,
  type GoalStateSnapshot,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { EngineAdapter, EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type {
  EngineExternalBillingEvent,
  PartialSnapshot,
  PhantomSignals,
  SegmentRecord,
  TurnSummary,
} from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { classifyRunError } from '../errorClassify.js'
import { createLogger } from '../logger.js'
import { resolveMcpMemoryEntry } from '../mcpMemoryEntry.js'
import { detachChildStdio, killProcessGroup, shutdownTimeoutMs, waitForCloseWithin } from '../processGroupShutdown.js'
import { buildPromptContext } from '../promptSlots.js'

const OPENCLAUDE_MEMORY_MCP_TOOLS = [
  'skill_search',
  'skill_list',
  'skill_view',
  'skill_save',
  'skill_delete',
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'delete_reminder',
  'send_to_agent',
] as const

const log = createLogger({ module: 'zcodeAdapter' })
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const ZCODE_SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const ZCODE_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000
const EMPTY_SIGNALS: PhantomSignals = { apiState: 'unknown', skipReason: null }
const ZCODE_HOTCFG_WRAPPER_BIN = '/run/oc/platform/current/bin/oc-zcode'
const ZCODE_IMAGE_WRAPPER_BIN = '/usr/local/bin/oc-zcode'
const ZCODE_IMAGE_BIN = '/opt/zcode-cli/versions/0.16.3/zcode.cjs'

export interface ZcodeRouteOverride {
  baseUrl: string
  routeToken: string
}

export const ZCODE_MAX_PROMPT_ARG_BYTES = 96 * 1024

interface ZcodeJsonResult {
  sessionId?: unknown
  traceId?: unknown
  turnId?: unknown
  response?: unknown
  usage?: unknown
  eventCount?: unknown
  projection?: unknown
}

interface ZcodeTurnContext {
  params: TurnParams
  startedAt: number
  proc: ChildProcessByStdio<null, Readable, Readable> | null
  stdout: string
  stderr: string
  assistantText: string
  assistantSegments: SegmentRecord[]
  terminal: boolean
  procClosed: boolean
  abandoned: boolean
  interrupted: boolean
  errorDetail: string | null
  resolveDrain: (() => void) | null
  resolveSummary: (summary: TurnSummary | null) => void
  lastUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    totalTokens: number
  }
  spawnedWithResume: boolean
  staleResumeRetried: boolean
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function promptText(input: TurnParams['input']): string {
  if (typeof input === 'string') return input
  return input
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : asText(block)))
    .filter(Boolean)
    .join('\n')
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function parseUsage(raw: unknown): ZcodeTurnContext['lastUsage'] {
  const usage = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const inputTokens = safeCount(usage.inputTokens ?? usage.input_tokens)
  const outputTokens = safeCount(usage.outputTokens ?? usage.output_tokens)
  const cacheReadTokens = safeCount(usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cacheReadInputTokens)
  const cacheWriteTokens = safeCount(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cacheCreationInputTokens)
  const reasoningTokens = safeCount(usage.reasoningTokens ?? usage.reasoning_tokens)
  const reportedTotal = safeCount(usage.totalTokens ?? usage.total_tokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  }
}

function snapshotOf(ctx: ZcodeTurnContext | null): PartialSnapshot {
  if (!ctx) {
    return { assistantText: '', thinkingText: '', completedTools: [], assistantSegments: [], thinkingSegments: [], runtimeEvents: [] }
  }
  return {
    assistantText: ctx.assistantText,
    thinkingText: '',
    completedTools: [],
    assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
    thinkingSegments: [],
    runtimeEvents: [],
  }
}

function resolveZcodeBin(
  wrapperOverride = process.env.OC_ZCODE_WRAPPER_BIN,
  cliOverride = process.env.OC_ZCODE_CLI_BIN,
  hotConfigAvailable = existsSync(ZCODE_HOTCFG_WRAPPER_BIN),
): string {
  const wrapper = wrapperOverride?.trim()
  if (wrapper) return wrapper
  const cli = cliOverride?.trim()
  if (cli) return cli
  if (hotConfigAvailable) return ZCODE_HOTCFG_WRAPPER_BIN
  if (existsSync(ZCODE_IMAGE_WRAPPER_BIN)) return ZCODE_IMAGE_WRAPPER_BIN
  if (existsSync(ZCODE_IMAGE_BIN)) return ZCODE_IMAGE_BIN
  throw new Error('ZCODE_BIN_UNAVAILABLE: experimental community CLI is not installed')
}

function unavailable(detail: string): 'auth' | 'quota' | null {
  if (/model config is missing|auth|credential|unauthorized|forbidden|api.?key|not logged in|\b401\b|\b403\b/i.test(detail)) return 'auth'
  if (/quota|rate.?limit|usage limit|subscription|credits? exhausted|\b429\b/i.test(detail)) return 'quota'
  return null
}

/** CLI 0.16.3 missing-session / stale --resume only. Generic CLI failed
 *  and coerced upstream_failed must not match. */
function isZcodeStaleResumeError(detail: string): boolean {
  if (!detail) return false
  return (
    /Session not found:\s*sess_[A-Za-z0-9_-]+/i.test(detail) ||
    /Persisted child session not found:\s*sess_[A-Za-z0-9_-]+/i.test(detail)
  )
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function validateZcodeJsonResult(raw: unknown): ZcodeJsonResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('stdout must be a single JSON object')
  }
  const obj = raw as Record<string, unknown>
  if (Object.keys(obj).length === 0) throw new Error('stdout object is empty')
  const sessionId = requireString(obj, 'sessionId')
  if (!sessionId.startsWith('sess_')) throw new Error('sessionId must be a sess_… value')
  const response = requireString(obj, 'response')
  if (!isNonNegInt(obj.eventCount)) throw new Error('eventCount must be a non-negative integer')
  if (!obj.usage || typeof obj.usage !== 'object' || Array.isArray(obj.usage)) {
    throw new Error('usage must be an object')
  }
  const usage = obj.usage as Record<string, unknown>
  const inputTokens = usage.inputTokens
  const outputTokens = usage.outputTokens
  const cacheReadTokens = usage.cacheReadTokens
  const cacheWriteTokens = usage.cacheWriteTokens
  if (!isNonNegInt(inputTokens)) throw new Error('usage.inputTokens must be a non-negative integer')
  if (!isNonNegInt(outputTokens)) throw new Error('usage.outputTokens must be a non-negative integer')
  if (!isNonNegInt(cacheReadTokens)) throw new Error('usage.cacheReadTokens must be a non-negative integer')
  if (!isNonNegInt(cacheWriteTokens)) throw new Error('usage.cacheWriteTokens must be a non-negative integer')
  for (const optional of ['reasoningTokens', 'totalTokens', 'modelRequestCount'] as const) {
    if (usage[optional] !== undefined && !isNonNegInt(usage[optional])) {
      throw new Error(`usage.${optional} must be a non-negative integer`)
    }
  }
  if (!obj.projection || typeof obj.projection !== 'object' || Array.isArray(obj.projection)) {
    throw new Error('projection must be an object')
  }
  const projection = obj.projection as Record<string, unknown>
  if (typeof projection.status !== 'string' || projection.status.length === 0) {
    throw new Error('projection.status must be a non-empty string')
  }
  for (const key of ['turnCount', 'totalTokenCount', 'contextUsed', 'contextWindow'] as const) {
    if (!isNonNegInt(projection[key])) throw new Error(`projection.${key} must be a non-negative integer`)
  }
  const reportedTotal = isNonNegInt(usage.totalTokens) ? usage.totalTokens : inputTokens + outputTokens
  if (reportedTotal !== projection.totalTokenCount) {
    throw new Error('usage totals must match projection.totalTokenCount')
  }
  optionalString(obj, 'traceId')
  optionalString(obj, 'turnId')
  return {
    sessionId,
    response,
    usage: obj.usage,
    eventCount: obj.eventCount,
    projection: obj.projection,
    ...(obj.traceId !== undefined ? { traceId: obj.traceId } : {}),
    ...(obj.turnId !== undefined ? { turnId: obj.turnId } : {}),
  }
}

function parseJsonResult(stdout: string): ZcodeJsonResult {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('empty stdout')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('stdout is not a single JSON object')
  }
  return validateZcodeJsonResult(parsed)
}

export class ZcodeAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'zcode'
  readonly capabilities: EngineCapabilities = {
    billingMode: 'external',
    supportsEffort: false,
    resumeKind: 'zcode-session',
    needsServerRequestId: true,
    historyMode: 'native-resume',
    maxPromptBytes: ZCODE_MAX_PROMPT_ARG_BYTES,
  }

  private readonly opts: EngineCreateOpts
  private active: ZcodeTurnContext | null = null
  private nativeId: string | null
  private currentModel: string | undefined
  private currentToolsets: string[] | undefined
  private target: ExecutionTarget = { kind: 'local' }
  private route: ZcodeRouteOverride | null = null
  private drain: Promise<void> = Promise.resolve()
  lastActivityAt = 0

  constructor(opts: EngineCreateOpts) {
    super()
    this.opts = { ...opts }
    this.nativeId = opts.resumeSessionId ?? null
    this.currentModel = opts.model
    this.currentToolsets = opts.agentToolsets
  }

  start(): Promise<void> { return Promise.resolve() }

  get nativeSessionId(): string | null { return this.nativeId }
  clearSessionId(): void { this.nativeId = null }

  setModel(model: string | undefined): void { this.currentModel = model }
  get model(): string | undefined { return this.currentModel }
  setEffortLevel(_level: string | undefined): void { /* 0.16.3 hosted path has no effort flag */ }
  get effortLevel(): string | undefined { return undefined }
  setTraceId(_traceId: string | undefined): void {}
  async setGoalState(_goal: GoalStateSnapshot | null): Promise<void> {}
  updateConfig(config: OpenClaudeConfig): void { this.opts.config = config }
  setToolsets(toolsets: string[] | undefined): void { this.currentToolsets = toolsets }
  get toolsets(): string[] | undefined { return this.currentToolsets }
  setExecutionTarget(target: ExecutionTarget): void { this.target = target }
  get executionTarget(): ExecutionTarget { return this.target }
  setZcodeRoute(route: ZcodeRouteOverride | null | undefined): void {
    this.route = route && typeof route.baseUrl === 'string' && typeof route.routeToken === 'string'
      ? { baseUrl: route.baseUrl, routeToken: route.routeToken }
      : null
  }
  sendPermissionResponse(_requestId: string, _response: unknown): boolean { return false }
  getPartialSnapshot(): PartialSnapshot { return snapshotOf(this.active) }
  get pendingToolCalls(): number { return 0 }
  get isRunning(): boolean { return this.active !== null && !this.active.terminal }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null { return null }

  submitTurn(params: TurnParams): EngineTurnRun {
    let resolveSummary!: (summary: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((resolve) => { resolveSummary = resolve })
    const ctx: ZcodeTurnContext = {
      params,
      startedAt: Date.now(),
      proc: null,
      stdout: '',
      stderr: '',
      assistantText: '',
      assistantSegments: [],
      terminal: false,
      procClosed: false,
      abandoned: false,
      interrupted: false,
      errorDetail: null,
      resolveDrain: null,
      resolveSummary,
      lastUsage: parseUsage({}),
      spawnedWithResume: false,
      staleResumeRetried: false,
    }
    this.active = ctx
    this.lastActivityAt = Date.now()
    const submitted = this.spawnTurn(ctx).catch((err) => {
      if (ctx.abandoned) return
      this.finishError(ctx, String(err))
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      throw err instanceof Error ? err : new Error(String(err))
    })
    return {
      submitted,
      summary,
      end: () => this.forceEnd(ctx),
      getPartialSnapshot: () => snapshotOf(ctx),
      getPhantomSignals: () => ({ ...EMPTY_SIGNALS }),
      get finalized() { return ctx.terminal },
      get pendingToolCalls() { return 0 },
    }
  }

  private resolveUpstream(): string {
    const canonical = this.currentModel
    const upstream = zcodeTransportModelId(canonical)
    if (!upstream) {
      throw new Error('ZCODE_MODEL_REJECTED: canonical model is not a ZCode allowlist id')
    }
    return upstream
  }

  private async composePrompt(params: TurnParams, cwd: string): Promise<string> {
    const input = promptText(params.input)
    const mcpEntry = resolveMcpMemoryEntry(this.opts.config.auth.claudeCodePath)
    try {
      const platform = await buildPromptContext({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: 'zcode',
        model: this.currentModel,
        availableMcpTools: mcpEntry ? [...OPENCLAUDE_MEMORY_MCP_TOOLS] : [],
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
      })
      return platform.content ? `${platform.content}\n\n${input}` : input
    } catch {
      let persona = ''
      if (this.opts.persona) {
        try { persona = readFileSync(this.opts.persona, 'utf8').trim() } catch { persona = '' }
      }
      void cwd
      return persona ? `${persona}\n\n${input}` : input
    }
  }

  private async spawnTurn(ctx: ZcodeTurnContext): Promise<void> {
    const upstream = this.resolveUpstream()
    let cwd = this.opts.agentBaseDir
    if (this.opts.sessionId && this.opts.getRepoSnapshot) {
      const snapshot = this.opts.getRepoSnapshot(this.opts.sessionId)
      if (snapshot?.status === 'ready' && snapshot.workspaceDir) cwd = snapshot.workspaceDir
    }
    const prompt = await this.composePrompt(ctx.params, cwd)
    const usingWrapper = !process.env.OC_ZCODE_CLI_BIN
    if (usingWrapper && !this.route) {
      throw new Error('ZCODE_RELAY_MISSING: hosted zcode turns require an opaque relay route')
    }
    const bin = resolveZcodeBin()
    const args = [
      '--prompt', prompt,
      '--json',
      '--mode', ZCODE_HOSTED_PERMISSION_MODE,
      '--no-color',
      '--cwd', cwd,
    ]
    ctx.spawnedWithResume = Boolean(this.nativeId)
    if (this.nativeId) args.push('--resume', this.nativeId)
    const env: NodeJS.ProcessEnv = {
      PATH: '/run/oc/platform/current/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME,
      TERM: 'dumb',
      OC_ZCODE_UPSTREAM_MODEL: upstream,
      ...(this.route ? {
        OC_ZCODE_RELAY_BASE_URL: this.route.baseUrl,
        OC_ZCODE_RELAY_TOKEN: this.route.routeToken,
      } : {}),
      ...(process.env.OPENCLAUDE_HOME ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME } : {}),
    }
    const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    ctx.proc = proc
    if (ctx.abandoned) {
      killProcessGroup(proc, 'SIGKILL')
      detachChildStdio(proc)
      try { proc.unref() } catch { /* already detached */ }
      return
    }
    this.emit('spawn', { resumed: this.nativeId !== null })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      ctx.stdout += chunk
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      ctx.stderr += chunk
    })
    proc.once('error', (err) => {
      if (ctx.abandoned) return
      if (!ctx.terminal) this.finishError(ctx, String(err))
      this.emit('error', err)
    })
    proc.once('close', (code, signal) => {
      try {
        if (ctx.abandoned) return
        const stderrText = ctx.stderr.trim()
        const stale = isZcodeStaleResumeError(stderrText)
        if (
          !ctx.terminal &&
          !ctx.interrupted &&
          ctx.spawnedWithResume &&
          !ctx.staleResumeRetried &&
          stale
        ) {
          ctx.staleResumeRetried = true
          this.nativeId = null
          ctx.stdout = ''
          ctx.stderr = ''
          ctx.proc = null
          ctx.procClosed = false
          void this.spawnTurn(ctx).catch((err) => {
            if (ctx.abandoned) return
            this.finishError(ctx, String(err))
            this.emit('error', err instanceof Error ? err : new Error(String(err)))
          })
          return
        }
        ctx.procClosed = true
        ctx.resolveDrain?.()
        ctx.resolveDrain = null
        const crashed = !ctx.interrupted && code !== 0
        if (!ctx.terminal) {
          if (code === 0 && /(?:^|\n)\s*Error\b/.test(ctx.stderr)) {
            this.finishError(ctx, ctx.stderr.trim() || 'CLI reported Error on stderr')
          } else if (code === 0) {
            this.finishSuccess(ctx)
          } else {
            this.finishError(ctx, ctx.stderr.trim() || `zcode exited with code ${String(code)}`)
          }
        }
        this.emit('exit', { code, signal, crashed })
      } catch (err) {
        if (!ctx.terminal) {
          this.finishError(ctx, err instanceof Error ? err.message : String(err))
        }
        try {
          this.emit('exit', { code, signal, crashed: true })
        } catch { /* close must never throw into the gateway */ }
      } finally {
        if (this.active === ctx && (ctx.terminal || ctx.procClosed)) this.active = null
      }
    })
  }

  private finishSuccess(ctx: ZcodeTurnContext): void {
    if (ctx.terminal) return
    let parsed: ZcodeJsonResult
    try {
      parsed = parseJsonResult(ctx.stdout)
    } catch (err) {
      this.emit('parse_error', { line: ctx.stdout.trim(), err })
      this.finishError(ctx, 'headless JSON stdout was not a machine-readable object')
      return
    }
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : null
    if (sessionId) {
      this.nativeId = sessionId
      this.emit('session_id', sessionId)
    }
    ctx.lastUsage = parseUsage(parsed.usage)
    const response = typeof parsed.response === 'string' ? parsed.response : asText(parsed.response)
    ctx.assistantText = response
    if (response) {
      ctx.assistantSegments.push({
        index: 0,
        text: response,
        ts: Date.now(),
        eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
      })
      ctx.params.onEvent({
        kind: 'block',
        block: { kind: 'text', text: response, ...(ctx.params.assistantMessageId ? { messageId: ctx.params.assistantMessageId } : {}) },
      })
    }
    ctx.params.onEvent({
      kind: 'usage',
      usage: {
        totalTokens: ctx.lastUsage.totalTokens,
        inputTokens: ctx.lastUsage.inputTokens,
        outputTokens: ctx.lastUsage.outputTokens,
        cacheReadTokens: ctx.lastUsage.cacheReadTokens,
        cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
      },
    })
    this.finalize(ctx, false)
  }

  private finishError(ctx: ZcodeTurnContext, detail: string): void {
    if (ctx.terminal) return
    ctx.errorDetail = detail.replace(/^Error:\s*/, '')
    this.finalize(ctx, true)
  }

  private finalize(ctx: ZcodeTurnContext, isError: boolean): void {
    if (ctx.terminal) return
    ctx.terminal = true
    ctx.params.sessionTotals.turns += 1
    const cls = ctx.errorDetail ? unavailable(ctx.errorDetail) : null
    const errorClass = ctx.errorDetail ? classifyRunError(ctx.errorDetail).code : undefined
    const safeDetail = ctx.interrupted
      ? 'Turn cancelled'
      : cls === 'auth'
        ? 'Authentication unavailable'
        : cls === 'quota'
          ? 'Quota unavailable'
          : ctx.errorDetail
            ? 'CLI failed'
            : null
    this.emitExternalBilling(ctx, isError, cls)
    if (isError) ctx.params.onEvent({ kind: 'error', error: safeDetail ?? 'CLI failed', errorClass })
    ctx.params.onEvent({
      kind: 'final',
      meta: {
        inputTokens: ctx.lastUsage.inputTokens,
        outputTokens: ctx.lastUsage.outputTokens,
        cacheReadTokens: ctx.lastUsage.cacheReadTokens,
        cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
        totalTokens: ctx.lastUsage.totalTokens,
        stopReason: ctx.interrupted ? 'interrupted' : undefined,
        cost: 0,
      },
    })
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
      thinkingText: '',
      assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
      thinkingSegments: [],
      tools: [],
      runtimeEvents: [],
      stopReason: ctx.interrupted ? 'interrupted' : null,
      numTurns: 1,
      isError,
      ...(isError ? { errorKind: 'other' as const, errorClass, errorDetail: safeDetail ?? ctx.errorDetail! } : {}),
      staleResumeId: Boolean(isError && !ctx.interrupted && isZcodeStaleResumeError(ctx.errorDetail ?? '')),
      phantomSignals: { ...EMPTY_SIGNALS },
    })
  }

  private emitExternalBilling(ctx: ZcodeTurnContext, isError: boolean, cls: 'auth' | 'quota' | null): void {
    if (!ctx.params.requestId || !REQUEST_ID_RE.test(ctx.params.requestId)) return
    const status: EngineExternalBillingEvent['status'] = cls ? 'unavailable' : isError ? 'error' : 'success'
    const terminalCode = ctx.interrupted
      ? 'USER_CANCELLED'
      : cls === 'auth'
        ? 'AUTH_UNAVAILABLE'
        : cls === 'quota'
          ? 'QUOTA_UNAVAILABLE'
          : isError
            ? 'ENGINE_ERROR'
            : undefined
    this.emit('external_billing', {
      requestId: ctx.params.requestId,
      engine: 'zcode',
      status,
      durationMs: Date.now() - ctx.startedAt,
      ...(ctx.lastUsage.totalTokens ? {
        usage: {
          input_tokens: ctx.lastUsage.inputTokens,
          output_tokens: ctx.lastUsage.outputTokens,
          cache_read_input_tokens: ctx.lastUsage.cacheReadTokens,
          cache_creation_input_tokens: ctx.lastUsage.cacheWriteTokens,
        },
      } : {}),
      ...(terminalCode ? { terminalCode } : {}),
    } satisfies EngineExternalBillingEvent)
  }

  private forceEnd(ctx: ZcodeTurnContext): void {
    if (ctx.terminal) return
    ctx.terminal = true
    ctx.resolveSummary(null)
  }

  interrupt(): boolean {
    const ctx = this.active
    if (!ctx?.proc || ctx.proc.killed) return false
    ctx.interrupted = true
    killProcessGroup(ctx.proc, 'SIGINT')
    return true
  }

  async shutdown(): Promise<void> {
    const ctx = this.active
    if (!ctx) return
    if (ctx.procClosed) {
      await this.waitForOutputDrain()
      return
    }
    const grace = shutdownTimeoutMs('OPENCLAUDE_ZCODE_SHUTDOWN_GRACE_MS', ZCODE_SHUTDOWN_GRACE_DEFAULT_MS)
    if (!ctx.proc) {
      ctx.abandoned = true
      this.forceEnd(ctx)
      return
    }
    const closeBarrier = this.waitForOutputDrain()
    killProcessGroup(ctx.proc, 'SIGTERM')
    const closed = await waitForCloseWithin(closeBarrier, grace)
    if (!closed) killProcessGroup(ctx.proc, 'SIGKILL')
    const drain = shutdownTimeoutMs('OPENCLAUDE_ZCODE_SHUTDOWN_FINAL_DRAIN_MS', ZCODE_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS)
    await waitForCloseWithin(closeBarrier, drain)
    detachChildStdio(ctx.proc)
    ctx.abandoned = true
    if (!ctx.terminal) this.forceEnd(ctx)
    log.debug('zcode shutdown', { sessionKey: this.opts.sessionKey })
  }

  waitForOutputDrain(): Promise<void> {
    const ctx = this.active
    if (!ctx || ctx.procClosed) return Promise.resolve()
    if (!ctx.resolveDrain) {
      this.drain = new Promise<void>((resolve) => { ctx.resolveDrain = resolve })
    }
    return this.drain
  }
}

registerEngine('zcode', (opts) => new ZcodeAdapter(opts))

export const _internals = {
  resolveZcodeBin,
  unavailable,
  isZcodeStaleResumeError,
  parseJsonResult,
  validateZcodeJsonResult,
  ZCODE_HOTCFG_WRAPPER_BIN,
  ZCODE_IMAGE_WRAPPER_BIN,
}
