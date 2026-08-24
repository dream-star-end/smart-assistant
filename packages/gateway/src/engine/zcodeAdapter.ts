/**
 * Experimental community ZCode CLI adapter (zcode.cjs 0.16.3).
 * Not an official standalone CLI. Adapter never reads or logs the Coding Plan
 * key; hosted turns receive a short-lived loopback relay URL + opaque token.
 */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { closeSync, constants, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
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
  TurnToolEntry,
  TurnSummary,
} from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { classifyRunError } from '../errorClassify.js'
import { createLogger } from '../logger.js'
import { detachChildStdio, killProcessGroup, shutdownTimeoutMs, waitForCloseWithin } from '../processGroupShutdown.js'
import { decideEngineCwd } from '../engineCwd.js'
import { buildPromptContext } from '../promptSlots.js'
import {
  cleanupZcodePlatformArtifacts,
  createZcodePlatformArtifacts,
  readZcodeContentSnapshot,
  type ZcodeContentPart,
  type ZcodePlatformArtifacts,
} from './zcodePlatform.js'

const log = createLogger({ module: 'zcodeAdapter' })
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const ZCODE_SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const ZCODE_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000
const ZCODE_HOOK_POLL_MS = 100
const ZCODE_RELAY_POLL_MS = 100
const ZCODE_RELAY_POLL_TIMEOUT_MS = 2_000
const ZCODE_CONTENT_POLL_MS = 200
const ZCODE_FINAL_CONTENT_DRAIN_ATTEMPTS = 4
const ZCODE_FINAL_CONTENT_DRAIN_DELAY_MS = 25
const ZCODE_HOOK_MAX_JOURNAL_BYTES = 16 * 1024 * 1024
const ZCODE_THINKING_MAX_CHARS = 256 * 1024
const ZCODE_ASSISTANT_MAX_CHARS = 4 * 1024 * 1024
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
  thinkingText: string
  assistantSegments: SegmentRecord[]
  thinkingSegments: SegmentRecord[]
  tools: Map<string, { entry: TurnToolEntry; startedAt: number }>
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
  artifacts: ZcodePlatformArtifacts | null
  hookOffset: number
  hookCarry: string
  hookTimer: NodeJS.Timeout | null
  contentTimer: NodeJS.Timeout | null
  relayTimer: NodeJS.Timeout | null
  relayPolling: boolean
  relayAfter: number
  relaySawContent: boolean
  relayLastKind: 'reasoning' | 'text' | null
  relayBaseUrl: string | null
  zcodeSessionId: string | null
  contentParts: Map<string, {
    kind: ZcodeContentPart['kind']
    segmentIndex: number
    liveText: string
    drifted: boolean
  }>
  pendingHookRecords: Map<string, ZcodeHookRecord[]>
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
    thinkingText: ctx.thinkingText,
    completedTools: [...ctx.tools.values()].map(({ entry }) => ({ ...entry })),
    assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
    thinkingSegments: ctx.thinkingSegments.map((segment) => ({ ...segment })),
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

interface ZcodeHookRecord {
  hookEventName: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  sessionId?: string
  toolCallId: string
  toolName: string
  toolInput: unknown
  inputTruncated: boolean
  toolResponse: unknown
  outputTruncated: boolean
  toolResultPreview: string
  error: unknown
  isInterrupt: boolean
  timestamp: string
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseHookRecord(line: string): ZcodeHookRecord | null {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return null }
  const obj = objectRecord(raw)
  if (!obj) return null
  const hookEventName = obj.hookEventName
  if (hookEventName !== 'PreToolUse' && hookEventName !== 'PostToolUse' && hookEventName !== 'PostToolUseFailure') return null
  if (typeof obj.toolCallId !== 'string' || typeof obj.toolName !== 'string') return null
  return {
    hookEventName,
    ...(typeof obj.sessionId === 'string' && obj.sessionId.startsWith('sess_')
      ? { sessionId: obj.sessionId }
      : {}),
    toolCallId: obj.toolCallId,
    toolName: obj.toolName,
    toolInput: obj.toolInput,
    inputTruncated: obj.inputTruncated === true,
    toolResponse: obj.toolResponse,
    outputTruncated: obj.outputTruncated === true,
    toolResultPreview: typeof obj.toolResultPreview === 'string' ? obj.toolResultPreview : '',
    error: obj.error,
    isInterrupt: obj.isInterrupt === true,
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
  }
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function inputObject(value: unknown): Record<string, any> {
  const obj = objectRecord(value)
  return obj ? structuredClone(obj) as Record<string, any> : {}
}

function inputPreview(value: unknown): string {
  return jsonText(value).slice(0, 500)
}

function eventTimestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function suffixPrefixOverlap(existing: string, incoming: string): number {
  if (!existing || !incoming) return 0
  const lps = new Uint32Array(incoming.length)
  for (let i = 1, matched = 0; i < incoming.length;) {
    if (incoming.charCodeAt(i) === incoming.charCodeAt(matched)) {
      lps[i++] = ++matched
    } else if (matched > 0) {
      matched = lps[matched - 1] ?? 0
    } else {
      lps[i++] = 0
    }
  }
  let matched = 0
  const start = Math.max(0, existing.length - incoming.length)
  for (let i = start; i < existing.length; i++) {
    const code = existing.charCodeAt(i)
    while (matched > 0 && code !== incoming.charCodeAt(matched)) {
      matched = lps[matched - 1] ?? 0
    }
    if (code === incoming.charCodeAt(matched)) matched++
    if (matched === incoming.length && i + 1 < existing.length) {
      matched = lps[matched - 1] ?? 0
    }
  }
  return matched
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
  private currentEffort: string | undefined
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
    this.currentEffort = opts.effortLevel
    this.currentToolsets = opts.agentToolsets
  }

  start(): Promise<void> { return Promise.resolve() }

  get nativeSessionId(): string | null { return this.nativeId }
  clearSessionId(): void { this.nativeId = null }

  setModel(model: string | undefined): void { this.currentModel = model }
  get model(): string | undefined { return this.currentModel }
  // 0.16.3 hosted path has no effort flag, but the generic runner mutator must
  // still retain the requested value so model switches cannot be silently lost.
  setEffortLevel(level: string | undefined): void { this.currentEffort = level }
  get effortLevel(): string | undefined { return this.currentEffort }
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
  get pendingToolCalls(): number {
    return this.active ? [...this.active.tools.values()].filter(({ entry }) => entry.completed === false).length : 0
  }
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
      thinkingText: '',
      assistantSegments: [],
      thinkingSegments: [],
      tools: new Map(),
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
      artifacts: null,
      hookOffset: 0,
      hookCarry: '',
      hookTimer: null,
      contentTimer: null,
      relayTimer: null,
      relayPolling: false,
      relayAfter: 0,
      relaySawContent: false,
      relayLastKind: null,
      relayBaseUrl: null,
      zcodeSessionId: null,
      contentParts: new Map(),
      pendingHookRecords: new Map(),
    }
    this.active = ctx
    this.lastActivityAt = Date.now()
    const submitted = this.spawnTurn(ctx).catch((err) => {
      if (ctx.abandoned) return
      this.finishError(ctx, String(err))
      this.cleanupArtifacts(ctx)
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
      get pendingToolCalls() {
        return [...ctx.tools.values()].filter(({ entry }) => entry.completed === false).length
      },
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

  private async composePrompt(
    params: TurnParams,
    cwd: string,
    availableMcpTools: string[],
  ): Promise<string> {
    const input = promptText(params.input)
    try {
      const platform = await buildPromptContext({
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        persona: this.opts.persona,
        provider: 'zcode',
        model: this.currentModel,
        availableMcpTools,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
        sessionId: typeof this.opts.sessionId === 'string' ? this.opts.sessionId : undefined,
        projectId: this.opts.projectId,
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

  private cleanupArtifacts(ctx: ZcodeTurnContext): void {
    if (ctx.hookTimer) {
      clearInterval(ctx.hookTimer)
      ctx.hookTimer = null
    }
    if (ctx.contentTimer) {
      clearInterval(ctx.contentTimer)
      ctx.contentTimer = null
    }
    if (ctx.relayTimer) {
      clearInterval(ctx.relayTimer)
      ctx.relayTimer = null
    }
    cleanupZcodePlatformArtifacts(ctx.artifacts)
    ctx.artifacts = null
    ctx.hookOffset = 0
    ctx.hookCarry = ''
    ctx.zcodeSessionId = null
    ctx.pendingHookRecords.clear()
  }

  private startHookDrain(ctx: ZcodeTurnContext): void {
    if (!ctx.artifacts?.hookJournalFile || ctx.hookTimer) return
    ctx.hookTimer = setInterval(() => {
      try { this.drainHookJournal(ctx) } catch { /* observability must not affect the turn */ }
    }, ZCODE_HOOK_POLL_MS)
    ctx.hookTimer.unref()
  }

  private startContentDrain(ctx: ZcodeTurnContext): void {
    if (!ctx.artifacts?.databaseFile || ctx.contentTimer) return
    ctx.contentTimer = setInterval(() => {
      try { this.drainContentSnapshot(ctx) } catch { /* observability must not affect the turn */ }
    }, ZCODE_CONTENT_POLL_MS)
    ctx.contentTimer.unref()
  }

  private acceptRelayDelta(
    ctx: ZcodeTurnContext,
    event: { seq: number; kind: 'thinking' | 'text'; text: string },
  ): void {
    const partKind: ZcodeContentPart['kind'] = event.kind === 'thinking' ? 'reasoning' : 'text'
    const segments = partKind === 'reasoning' ? ctx.thinkingSegments : ctx.assistantSegments
    const maxChars = partKind === 'reasoning' ? ZCODE_THINKING_MAX_CHARS : ZCODE_ASSISTANT_MAX_CHARS
    const used = segments.reduce((sum, segment) => sum + segment.text.length, 0)
    const text = event.text.slice(0, Math.max(0, maxChars - used))
    if (!text) return
    let segment = ctx.relayLastKind === partKind ? segments.at(-1) : undefined
    if (!segment) {
      segment = {
        index: segments.length,
        text: '',
        ts: Date.now(),
        eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
      }
      segments.push(segment)
    }
    segment.text += text
    ctx.relayLastKind = partKind
    ctx.relaySawContent = true
    this.refreshAggregates(ctx)
    this.emitContentDelta(ctx, {
      id: `relay-${event.seq}`,
      kind: partKind,
      text,
      ts: segment.ts,
      truncated: false,
    }, text, segment.index)
  }

  private async pollRelayEvents(ctx: ZcodeTurnContext): Promise<void> {
    if (ctx.relayPolling || ctx.terminal || !ctx.relayBaseUrl) return
    const containerToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!containerToken || !/^oc-v3\.\d+\.[0-9a-f]{64}$/.test(containerToken)) return
    ctx.relayPolling = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ZCODE_RELAY_POLL_TIMEOUT_MS)
    try {
      const response = await fetch(
        `${ctx.relayBaseUrl}/events?after=${ctx.relayAfter}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${containerToken}` },
          signal: controller.signal,
        },
      )
      if (!response.ok) return
      const body = await response.json() as {
        events?: unknown
        next?: unknown
      }
      if (Array.isArray(body.events)) {
        for (const raw of body.events) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
          const event = raw as Record<string, unknown>
          if (
            typeof event.seq !== 'number' ||
            !Number.isSafeInteger(event.seq) ||
            event.seq <= ctx.relayAfter ||
            (event.kind !== 'thinking' && event.kind !== 'text') ||
            typeof event.text !== 'string'
          ) continue
          this.acceptRelayDelta(ctx, {
            seq: event.seq,
            kind: event.kind,
            text: event.text,
          })
          ctx.relayAfter = event.seq
        }
      }
      if (
        typeof body.next === 'number' &&
        Number.isSafeInteger(body.next) &&
        body.next > ctx.relayAfter
      ) ctx.relayAfter = body.next
    } catch {
      // Relay streaming is an optional live projection. SQLite/final JSON remain authoritative.
    } finally {
      clearTimeout(timeout)
      ctx.relayPolling = false
    }
  }

  private startRelayDrain(ctx: ZcodeTurnContext): void {
    if (ctx.relayTimer || !this.route?.baseUrl) return
    ctx.relayBaseUrl = this.route.baseUrl.replace(/\/+$/, '')
    void this.pollRelayEvents(ctx)
    ctx.relayTimer = setInterval(() => { void this.pollRelayEvents(ctx) }, ZCODE_RELAY_POLL_MS)
    ctx.relayTimer.unref()
  }

  private drainHookJournal(ctx: ZcodeTurnContext): void {
    const journal = ctx.artifacts?.hookJournalFile
    if (!journal || !existsSync(journal)) return
    const size = statSync(journal).size
    if (size < ctx.hookOffset || size > ZCODE_HOOK_MAX_JOURNAL_BYTES) return
    if (size === ctx.hookOffset) return
    const length = size - ctx.hookOffset
    const buf = Buffer.allocUnsafe(length)
    const fd = openSync(journal, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      let read = 0
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, ctx.hookOffset + read)
        if (n <= 0) break
        read += n
      }
      ctx.hookOffset += read
      const text = ctx.hookCarry + buf.subarray(0, read).toString('utf8')
      const lines = text.split('\n')
      ctx.hookCarry = lines.pop() ?? ''
      for (const line of lines) {
        const record = parseHookRecord(line)
        if (record) this.acceptHookRecord(ctx, record)
      }
    } finally {
      closeSync(fd)
    }
  }

  private emitContentDelta(
    ctx: ZcodeTurnContext,
    part: ZcodeContentPart,
    delta: string,
    segmentIndex: number,
  ): void {
    if (!delta) return
    this.lastActivityAt = Date.now()
    this.emit('activity')
    const kind = part.kind === 'reasoning' ? 'thinking' : 'text'
    const messageIdBase = part.kind === 'reasoning'
      ? ctx.params.thinkingMessageId
      : ctx.params.assistantMessageId
    ctx.params.onEvent({
      kind: 'block',
      block: {
        kind,
        text: delta,
        ...(messageIdBase ? { messageId: `${messageIdBase}-s${segmentIndex}` } : {}),
      },
    })
  }

  private refreshAggregates(ctx: ZcodeTurnContext): void {
    ctx.thinkingText = ctx.thinkingSegments.map((segment) => segment.text).join('')
    ctx.assistantText = ctx.assistantSegments.map((segment) => segment.text).join('')
  }

  private acceptContentPart(ctx: ZcodeTurnContext, part: ZcodeContentPart): void {
    const segments = part.kind === 'reasoning' ? ctx.thinkingSegments : ctx.assistantSegments
    const maxChars = part.kind === 'reasoning' ? ZCODE_THINKING_MAX_CHARS : ZCODE_ASSISTANT_MAX_CHARS
    let state = ctx.contentParts.get(part.id)
    if (!state) {
      const used = segments.reduce((sum, segment) => sum + segment.text.length, 0)
      const text = part.text.slice(0, Math.max(0, maxChars - used))
      if (!text) return
      const segmentIndex = segments.length
      segments.push({
        index: segmentIndex,
        text,
        ts: part.ts,
        eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
      })
      state = { kind: part.kind, segmentIndex, liveText: text, drifted: false }
      ctx.contentParts.set(part.id, state)
      this.refreshAggregates(ctx)
      this.emitContentDelta(ctx, part, text, segmentIndex)
      return
    }
    if (state.kind !== part.kind) return
    const segment = segments[state.segmentIndex]
    if (!segment) return
    const otherUsed = segments.reduce(
      (sum, current, index) => sum + (index === state!.segmentIndex ? 0 : current.text.length),
      0,
    )
    const text = part.text.slice(0, Math.max(0, maxChars - otherUsed))
    if (!text.startsWith(state.liveText)) {
      state.drifted = true
      segment.text = text
      this.refreshAggregates(ctx)
      return
    }
    segment.text = text
    this.refreshAggregates(ctx)
    if (state.drifted) return
    const delta = text.slice(state.liveText.length)
    state.liveText = text
    this.emitContentDelta(ctx, part, delta, state.segmentIndex)
  }

  private drainContentSnapshot(ctx: ZcodeTurnContext): string | null {
    if (ctx.relaySawContent) return null
    const databaseFile = ctx.artifacts?.databaseFile
    const sessionId = ctx.zcodeSessionId
    if (!databaseFile || !sessionId) return null
    const snapshot = readZcodeContentSnapshot({ databaseFile, sessionId, startedAt: ctx.startedAt })
    if (!snapshot.available) return null
    for (const part of snapshot.parts) this.acceptContentPart(ctx, part)
    return JSON.stringify(snapshot.parts.map((part) => [part.id, part.kind, part.text]))
  }

  private reconcileContentSnapshot(ctx: ZcodeTurnContext): string | null {
    const databaseFile = ctx.artifacts?.databaseFile
    const sessionId = ctx.zcodeSessionId
    if (!databaseFile || !sessionId) return null
    const snapshot = readZcodeContentSnapshot({ databaseFile, sessionId, startedAt: ctx.startedAt })
    if (!snapshot.available) return null
    const rebuild = (
      kind: ZcodeContentPart['kind'],
      existing: SegmentRecord[],
    ): SegmentRecord[] => snapshot.parts
      .filter((part) => part.kind === kind)
      .map((part, index) => ({
        index,
        text: part.text,
        ts: part.ts,
        eventOrdinal: existing[index]?.eventOrdinal ?? ctx.params.nextDurableEventOrdinal?.(),
      }))
    const thinking = rebuild('reasoning', ctx.thinkingSegments)
    const assistant = rebuild('text', ctx.assistantSegments)
    if (thinking.length > 0) ctx.thinkingSegments = thinking
    if (assistant.length > 0) ctx.assistantSegments = assistant
    this.refreshAggregates(ctx)
    return JSON.stringify(snapshot.parts.map((part) => [part.id, part.kind, part.text]))
  }

  private async drainContentStable(ctx: ZcodeTurnContext): Promise<void> {
    let previous: string | null = null
    for (let attempt = 0; attempt < ZCODE_FINAL_CONTENT_DRAIN_ATTEMPTS; attempt++) {
      const current = ctx.relaySawContent
        ? this.reconcileContentSnapshot(ctx)
        : this.drainContentSnapshot(ctx)
      if (current !== null && current === previous) return
      previous = current
      if (attempt + 1 < ZCODE_FINAL_CONTENT_DRAIN_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, ZCODE_FINAL_CONTENT_DRAIN_DELAY_MS))
      }
    }
  }

  private ensureToolStart(ctx: ZcodeTurnContext, record: ZcodeHookRecord): void {
    if (ctx.tools.has(record.toolCallId)) return
    ctx.relayLastKind = null
    const input = inputObject(record.toolInput)
    const arrivedAt = eventTimestamp(record.timestamp)
    const entry: TurnToolEntry = {
      toolUseId: record.toolCallId,
      blockId: record.toolCallId,
      toolName: record.toolName,
      inputJson: structuredClone(record.toolInput),
      inputPreview: inputPreview(record.toolInput),
      output: '',
      completed: false,
      isError: false,
      durationMs: 0,
      ts: arrivedAt,
      arrivedAt,
      eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
      inputTruncated: record.inputTruncated,
    }
    ctx.tools.set(record.toolCallId, { entry, startedAt: arrivedAt })
    ctx.params.toolUseIdToName.set(record.toolCallId, record.toolName)
    ctx.params.onEvent({
      kind: 'block',
      block: {
        kind: 'tool_use',
        blockId: record.toolCallId,
        toolName: record.toolName,
        inputJson: structuredClone(record.toolInput),
        inputPreview: entry.inputPreview,
        partial: false,
      },
    })
    ctx.params.onEvent({
      kind: 'tool_use_detected',
      tool: { name: record.toolName, id: record.toolCallId, input },
    })
  }

  private completeTool(ctx: ZcodeTurnContext, record: ZcodeHookRecord): void {
    this.ensureToolStart(ctx, record)
    const state = ctx.tools.get(record.toolCallId)
    if (!state || state.entry.completed === true) return
    const isError = record.hookEventName === 'PostToolUseFailure'
    const outputJson = isError ? record.error : record.toolResponse
    const output = isError
      ? jsonText(record.error) || 'Tool failed'
      : jsonText(record.toolResponse)
    const preview = record.toolResultPreview || output.slice(0, 500)
    const now = eventTimestamp(record.timestamp)
    state.entry = {
      ...state.entry,
      output,
      outputJson: structuredClone(outputJson),
      completed: true,
      isError,
      durationMs: Math.max(0, now - state.startedAt),
      ts: now,
      outputTruncated: record.outputTruncated,
    }
    ctx.tools.set(record.toolCallId, state)
    ctx.params.onEvent({
      kind: 'block',
      block: {
        kind: 'tool_result',
        toolUseBlockId: record.toolCallId,
        toolName: record.toolName,
        isError,
        output,
        outputJson: structuredClone(outputJson),
        preview: preview.slice(0, 500),
      },
    })
    ctx.params.onEvent({
      kind: 'tool_result_detected',
      result: {
        toolUseId: record.toolCallId,
        toolName: record.toolName,
        preview: preview.slice(0, 500),
        isError,
        durationMs: state.entry.durationMs,
        inputPreview: state.entry.inputPreview,
      },
    })
  }

  private applyHookRecord(ctx: ZcodeTurnContext, record: ZcodeHookRecord): void {
    if (record.hookEventName === 'PreToolUse') {
      this.drainContentSnapshot(ctx)
      this.ensureToolStart(ctx, record)
      return
    }
    this.completeTool(ctx, record)
  }

  private bindZcodeSession(ctx: ZcodeTurnContext, sessionId: string): void {
    if (!sessionId.startsWith('sess_')) return
    if (ctx.zcodeSessionId && ctx.zcodeSessionId !== sessionId) return
    ctx.zcodeSessionId = sessionId
    const pending = ctx.pendingHookRecords.get(sessionId) ?? []
    ctx.pendingHookRecords.clear()
    for (const record of pending) this.applyHookRecord(ctx, record)
  }

  private acceptHookRecord(ctx: ZcodeTurnContext, record: ZcodeHookRecord): void {
    if (!record.sessionId) return
    if (!ctx.zcodeSessionId) {
      const pending = ctx.pendingHookRecords.get(record.sessionId) ?? []
      pending.push(record)
      ctx.pendingHookRecords.set(record.sessionId, pending)
      return
    }
    if (ctx.zcodeSessionId !== record.sessionId) return
    this.applyHookRecord(ctx, record)
  }

  private async spawnTurn(ctx: ZcodeTurnContext): Promise<void> {
    const upstream = this.resolveUpstream()
    const snapshot =
      this.opts.sessionId && this.opts.getRepoSnapshot
        ? this.opts.getRepoSnapshot(this.opts.sessionId)
        : null
    const cwd = decideEngineCwd({
      agentBaseDir: this.opts.agentBaseDir,
      repoSnapshot: snapshot,
      projectBound: Boolean(this.opts.projectId),
    }).cwd
    this.cleanupArtifacts(ctx)
    try {
      ctx.artifacts = createZcodePlatformArtifacts({
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        gatewayPort: this.opts.config.gateway.port,
        gatewayToken: this.opts.config.gateway.accessToken ?? '',
        delegationDepth: this.opts.delegationDepth ?? 0,
        claudeCodePath: this.opts.config.auth.claudeCodePath,
        skillEvalMode: this.opts.skillEvalMode,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
        skillTrainRunId: this.opts.skillTrainRunId,
      })
    } catch (err) {
      log.warn('zcode platform artifacts unavailable; continuing without MCP/hooks', {
        sessionKey: this.opts.sessionKey,
        err: err instanceof Error ? err.message : String(err),
      })
      ctx.artifacts = null
    }
    const prompt = await this.composePrompt(
      ctx.params,
      cwd,
      ctx.artifacts?.advertisedMcpTools ?? [],
    )
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
    ctx.zcodeSessionId = this.nativeId
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
      ...(ctx.artifacts?.platformConfigFile
        ? { OC_ZCODE_PLATFORM_CONFIG_FILE: ctx.artifacts.platformConfigFile }
        : {}),
      ...(process.env.OPENCLAUDE_HOME ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME } : {}),
    }
    const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    ctx.proc = proc
    this.startHookDrain(ctx)
    this.startContentDrain(ctx)
    this.startRelayDrain(ctx)
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
      this.cleanupArtifacts(ctx)
      this.emit('error', err)
    })
    proc.once('close', (code, signal) => {
      void (async () => {
        let retrying = false
        try {
          if (ctx.abandoned) return
          this.drainHookJournal(ctx)
          const stderrText = ctx.stderr.trim()
          const stale = isZcodeStaleResumeError(stderrText)
          if (
            !ctx.terminal &&
            !ctx.interrupted &&
            ctx.spawnedWithResume &&
            !ctx.staleResumeRetried &&
            stale
          ) {
            retrying = true
            ctx.staleResumeRetried = true
            this.nativeId = null
            ctx.stdout = ''
            ctx.stderr = ''
            ctx.proc = null
            ctx.procClosed = false
            this.cleanupArtifacts(ctx)
            void this.spawnTurn(ctx).catch((err) => {
              if (ctx.abandoned) return
              this.finishError(ctx, String(err))
              this.cleanupArtifacts(ctx)
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
              await this.drainContentStable(ctx)
              this.finishError(ctx, ctx.stderr.trim() || 'CLI reported Error on stderr')
            } else if (code === 0) {
              await this.finishSuccess(ctx)
            } else {
              await this.drainContentStable(ctx)
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
          if (!retrying) this.cleanupArtifacts(ctx)
          if (this.active === ctx && (ctx.terminal || ctx.procClosed)) this.active = null
        }
      })()
    })
  }

  private async finishSuccess(ctx: ZcodeTurnContext): Promise<void> {
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
      if (ctx.zcodeSessionId && ctx.zcodeSessionId !== sessionId) {
        if (ctx.contentParts.size > 0 || ctx.tools.size > 0) {
          this.finishError(ctx, 'ZCODE_SESSION_MISMATCH')
          return
        }
        ctx.zcodeSessionId = null
      }
      this.nativeId = sessionId
      this.emit('session_id', sessionId)
      this.bindZcodeSession(ctx, sessionId)
      await this.pollRelayEvents(ctx)
      await this.drainContentStable(ctx)
    }
    ctx.lastUsage = parseUsage(parsed.usage)
    const response = typeof parsed.response === 'string' ? parsed.response : asText(parsed.response)
    if (response) {
      const overlap = suffixPrefixOverlap(ctx.assistantText, response)
      const delta = response.slice(overlap)
      const last = ctx.assistantSegments.at(-1)
      if (delta && last && overlap > 0) {
        last.text += delta
        ctx.params.onEvent({
          kind: 'block',
          block: {
            kind: 'text',
            text: delta,
            ...(ctx.params.assistantMessageId
              ? { messageId: `${ctx.params.assistantMessageId}-s${last.index}` }
              : {}),
          },
        })
      } else if (delta) {
        const index = ctx.assistantSegments.length
        ctx.assistantSegments.push({
          index,
          text: delta,
          ts: Date.now(),
          eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
        })
        ctx.params.onEvent({
          kind: 'block',
          block: {
            kind: 'text',
            text: delta,
            ...(ctx.params.assistantMessageId
              ? { messageId: `${ctx.params.assistantMessageId}-s${index}` }
              : {}),
          },
        })
      }
      this.refreshAggregates(ctx)
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
      thinkingText: ctx.thinkingText,
      assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
      thinkingSegments: ctx.thinkingSegments.map((segment) => ({ ...segment })),
      tools: [...ctx.tools.values()].map(({ entry }) => ({ ...entry })),
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
      try { this.drainHookJournal(ctx) } catch {}
      await this.waitForOutputDrain()
      this.cleanupArtifacts(ctx)
      return
    }
    const grace = shutdownTimeoutMs('OPENCLAUDE_ZCODE_SHUTDOWN_GRACE_MS', ZCODE_SHUTDOWN_GRACE_DEFAULT_MS)
    if (!ctx.proc) {
      ctx.abandoned = true
      this.forceEnd(ctx)
      this.cleanupArtifacts(ctx)
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
    try { this.drainHookJournal(ctx) } catch {}
    this.cleanupArtifacts(ctx)
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
  parseHookRecord,
  suffixPrefixOverlap,
  ZCODE_HOTCFG_WRAPPER_BIN,
  ZCODE_IMAGE_WRAPPER_BIN,
}
