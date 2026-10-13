import { identityCompatEnvironment } from '@openclaude/storage'
/**
 * Official Google Antigravity CLI adapter (OCV5-415, experimental, hidden).
 *
 * One `antigravity` process per turn in headless stream-json mode. The prompt
 * goes in on stdin as one `{"event":"user",...}` NDJSON line (argv is capped
 * near 128 KB and visible in `ps`); stdin stays open until the `result`
 * event, then closes so the CLI exits.
 *
 * Credentials never enter the user container. The master supplies a one-turn
 * loopback relay route; the adapter passes the opaque route token as
 * GEMINI_API_KEY and the route as GOOGLE_GEMINI_BASE_URL (1.3.4 appends
 * `/v1beta/models/<m>:streamGenerateContent`). Without a valid route the turn
 * fails closed before spawning. The relay and its metering are not part of
 * this commit, so nothing routes here yet: there is no catalog row and the
 * model ids are not in ALLOWED_INBOUND_MODELS.
 *
 * Billing is external (relay-metered): the CLI's own `result.usage` omits the
 * title-generation call and is cumulative across a resumed conversation, so
 * it is only used for display here, summed from per-step usage.
 *
 * Probe evidence for every behaviour below: docs/ocv5-415-antigravity-cli.md
 * and the fixtures under __tests__/fixtures/antigravity/.
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import {
  antigravityCliModelId,
  TOOL_FAILED_EMPTY_SENTINEL,
  type GoalStateSnapshot,
  type OutboundContentBlock,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { EngineAdapter, EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { PartialSnapshot, PhantomSignals, SegmentRecord, TurnSummary, TurnToolEntry } from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { BINARY_BLOCK_OMITTED_NOTICE, countBinaryInputBlocks, isBinaryInputBlock } from './promptInput.js'
import { buildCodexEnv } from './codexShared.js'
import { createLogger } from '../logger.js'
import { detachChildStdio, killProcessGroup, shutdownTimeoutMs, waitForCloseWithin } from '../processGroupShutdown.js'
import { decideEngineCwd } from '../engineCwd.js'
import { persistRunContextSnapshot } from '../runContextPersist.js'
import { buildPromptContext } from '../promptSlots.js'
import { renderCcbGoalPrompt } from '../goalPrompt.js'
import {
  ANTIGRAVITY_PREAMBLE,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
  type AntigravityPlatformProjection,
} from './antigravityPlatform.js'
import { antigravityProductToolInput, antigravityProductToolName, antigravityToolOutput } from './antigravityToolNormalize.js'

const log = createLogger({ module: 'antigravityAdapter' })

const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
export const ANTIGRAVITY_RELAY_PATH_PREFIX = '/internal/v5/antigravity-relay/route/'
/** 350 KB stdin prompts were verified; a 1.1 MB one made 1.3.4 report
 * SUCCESS with an empty response. Stay well under the verified size. */
export const ANTIGRAVITY_MAX_PROMPT_BYTES = 300 * 1024
const SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000
const KEEPALIVE_INTERVAL_MS = 30_000
const STDERR_MAX_CHARS = 64 * 1024
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 1.3.4 without usable credentials prints an OAuth URL and blocks for 60 s. */
const AUTH_PROMPT_RE = /Authentication required|Waiting for authentication|authentication failed or timed out/i
/** Headless soft-deny: tool step reports DONE with no output, exit 0. */
const SOFT_DENY_RE = /auto-denied/i
const EMPTY_RUN_RE = /run ended with no output/i

const EMPTY_SIGNALS: Readonly<PhantomSignals> = Object.freeze({ apiState: 'unknown', skipReason: null })

export interface AntigravityRouteOverride {
  baseUrl: string
  routeToken: string
}

interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
}

type AgyLine = Record<string, unknown> & { event?: unknown }

interface TurnContext {
  params: TurnParams
  startedAt: number
  proc: ChildProcessByStdio<Writable, Readable, Readable> | null
  projection: AntigravityPlatformProjection | null
  assistantText: string
  assistantSegments: SegmentRecord[]
  lastWasText: boolean
  tools: Map<string, TurnToolEntry>
  toolStartedAt: Map<string, number>
  pendingToolIds: Set<string>
  usage: StepUsage
  stderr: string
  conversationId: string | null
  sawResult: boolean
  sawOutput: boolean
  terminal: boolean
  procClosed: boolean
  abandoned: boolean
  interrupted: boolean
  errorDetail: string | null
  resolveSummary: (summary: TurnSummary | null) => void
  resolveDrain: (() => void) | null
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function promptText(input: TurnParams['input']): string {
  if (typeof input === 'string') return input
  return input
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (isBinaryInputBlock(block)) return BINARY_BLOCK_OMITTED_NOTICE
      return asText(block)
    })
    .filter(Boolean)
    .join('\n')
}

function assemblePrompt(platformContent: string, input: string, goal: GoalStateSnapshot | null): string {
  const body = platformContent ? `${platformContent}\n\n${input}` : input
  const goalText = renderCcbGoalPrompt(goal)
  const withGoal = goalText ? `${goalText}\n\n${body}` : body
  return `${ANTIGRAVITY_PREAMBLE}\n${withGoal}`
}

/** Throws unless the route is the token-bound loopback relay. */
export function validateAntigravityRoute(route: AntigravityRouteOverride | null): AntigravityRouteOverride {
  if (!route || !ROUTE_TOKEN_RE.test(route.routeToken)) {
    throw new Error('ANTIGRAVITY_ROUTE_REQUIRED: missing master-owned Antigravity relay route')
  }
  let parsed: URL
  try {
    parsed = new URL(route.baseUrl)
  } catch {
    throw new Error('ANTIGRAVITY_ROUTE_INVALID: malformed relay base URL')
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.pathname !== `${ANTIGRAVITY_RELAY_PATH_PREFIX}${route.routeToken}` ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('ANTIGRAVITY_ROUTE_INVALID: relay must be token-bound loopback')
  }
  return route
}

function snapshotOf(ctx: TurnContext | null): PartialSnapshot {
  return {
    assistantText: ctx?.assistantText ?? '',
    thinkingText: '',
    completedTools: ctx ? [...ctx.tools.values()].map((tool) => structuredClone(tool)) : [],
    assistantSegments: ctx ? ctx.assistantSegments.map((segment) => ({ ...segment })) : [],
    thinkingSegments: [],
    runtimeEvents: [],
  }
}

function authError(detail: string): boolean {
  return AUTH_PROMPT_RE.test(detail) || /ANTIGRAVITY_AUTH_REQUIRED|UNAUTHENTICATED|\b401\b|API key not valid|PERMISSION_DENIED/i.test(detail)
}

export class AntigravityAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'antigravity'
  readonly capabilities: EngineCapabilities = {
    // The relay meters every upstream call (including title generation).
    billingMode: 'external',
    supportsEffort: true,
    resumeKind: 'antigravity-session',
    needsServerRequestId: true,
    historyMode: 'native-resume',
    maxPromptBytes: ANTIGRAVITY_MAX_PROMPT_BYTES,
    // Driven with --dangerously-skip-permissions: headless 1.3.4 otherwise
    // soft-denies every gated tool and still exits 0.
    permissionModel: 'forced-unattended',
    emitsCallUsage: false,
    emitsToolInputDeltas: false,
    supportsNativeCompact: false,
    multimodalInput: 'text-only',
  }

  private readonly opts: EngineCreateOpts
  private route: AntigravityRouteOverride | null = null
  private active: TurnContext | null = null
  private nativeId: string | null
  private currentModel: string | undefined
  private currentEffort: string | undefined
  private currentToolsets: string[] | undefined
  private currentTarget: ExecutionTarget = { kind: 'local' }
  private traceId: string | undefined
  private drain: Promise<void> = Promise.resolve()
  private keepaliveTimer: NodeJS.Timeout | null = null
  private platformGoal: GoalStateSnapshot | null = null
  lastActivityAt = 0

  constructor(opts: EngineCreateOpts) {
    super()
    this.opts = { ...opts }
    this.nativeId = opts.resumeSessionId && CONVERSATION_ID_RE.test(opts.resumeSessionId) ? opts.resumeSessionId : null
    this.currentModel = opts.model
    this.currentEffort = opts.effortLevel
    this.currentToolsets = opts.agentToolsets
    if (opts.permissionMode && opts.permissionMode !== 'bypassPermissions') {
      log.warn('antigravity engine is forced-unattended; requested permissionMode is ignored', {
        sessionKey: opts.sessionKey,
        permissionMode: opts.permissionMode,
      })
    }
  }

  start(): Promise<void> {
    return Promise.resolve()
  }

  setAntigravityRoute(route: AntigravityRouteOverride | null | undefined): void {
    this.route = route ? { ...route } : null
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    let resolveSummary!: (summary: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((resolve) => { resolveSummary = resolve })
    const ctx: TurnContext = {
      params,
      startedAt: Date.now(),
      proc: null,
      projection: null,
      assistantText: '',
      assistantSegments: [],
      lastWasText: false,
      tools: new Map(),
      toolStartedAt: new Map(),
      pendingToolIds: new Set(),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 },
      stderr: '',
      conversationId: null,
      sawResult: false,
      sawOutput: false,
      terminal: false,
      procClosed: false,
      abandoned: false,
      interrupted: false,
      errorDetail: null,
      resolveSummary,
      resolveDrain: null,
    }
    this.active = ctx
    this.lastActivityAt = Date.now()
    this.drain = new Promise<void>((resolve) => { ctx.resolveDrain = resolve })
    const submitted = this.spawnTurn(ctx).catch((err) => {
      this.cleanupLaunch(ctx)
      if (!ctx.abandoned) {
        this.finishError(ctx, String((err as Error)?.message ?? err))
        if (this.active === ctx) this.active = null
      }
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
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

  private cliBin(): string {
    const override = process.env.OC_ANTIGRAVITY_CLI_BIN?.trim()
    if (override) return override
    return existsSync('/usr/local/bin/antigravity') ? '/usr/local/bin/antigravity' : 'antigravity'
  }

  private async spawnTurn(ctx: TurnContext): Promise<void> {
    const route = validateAntigravityRoute(this.route)
    const cliModel = antigravityCliModelId(this.currentModel, this.currentEffort)
    if (!cliModel) {
      throw new Error(`ANTIGRAVITY_MODEL_UNSUPPORTED: ${String(this.currentModel)}`)
    }
    this.emitOmittedBinaryNotice(ctx)

    let repoSnapshot = null
    if (this.opts.sessionId && this.opts.getRepoSnapshot) {
      repoSnapshot = this.opts.getRepoSnapshot(this.opts.sessionId)
    }
    const cwdDecision = decideEngineCwd({
      agentBaseDir: this.opts.agentBaseDir,
      repoSnapshot,
      projectBound: Boolean(this.opts.projectId),
    })
    const projection = projectAntigravityPlatform({
      identityCompat: this.opts.identityCompat,
      agentId: this.opts.agentId,
      projectId: this.opts.projectId,
      sessionKey: this.opts.sessionKey,
      gatewayPort: this.opts.config.gateway.port,
      gatewayToken: this.opts.config.gateway.accessToken ?? '',
      delegationDepth: this.opts.delegationDepth ?? 0,
      ...(ctx.params.consultTurn && ctx.params.turnKey
        ? {
            consultTurn: {
              turnKey: ctx.params.turnKey,
              turnIndex: ctx.params.consultTurn.turnIndex,
              configVersion: ctx.params.consultTurn.configVersion,
            },
          }
        : {}),
      claudeCodePath: this.opts.config.auth.claudeCodePath,
      skillEvalMode: this.opts.skillEvalMode,
      skillEvalExclude: this.opts.skillEvalExclude,
      skillEvalDraft: this.opts.skillEvalDraft,
      skillTrainRunId: this.opts.skillTrainRunId,
    })
    ctx.projection = projection
    const prompt = await this.composePrompt(ctx.params, repoSnapshot, projection.advertisedMcpTools, cwdDecision)
    const line = `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
    if (Buffer.byteLength(line, 'utf8') > ANTIGRAVITY_MAX_PROMPT_BYTES) {
      throw new Error(`ANTIGRAVITY_PROMPT_TOO_LARGE: ${Buffer.byteLength(line, 'utf8')} bytes > ${ANTIGRAVITY_MAX_PROMPT_BYTES}`)
    }

    const isolatedEnv = buildCodexEnv()
    for (const key of Object.keys(isolatedEnv)) {
      if (key.startsWith('GEMINI_') || key.startsWith('GOOGLE_') || key.startsWith('AGY_') || key.startsWith('CODEX_')) {
        delete isolatedEnv[key]
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...isolatedEnv,
      PATH: '/run/oc/platform/current/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: projection.launchHome,
      XDG_CACHE_HOME: projection.cacheDir,
      OC_AGENT_ID: this.opts.agentId,
      OPENCLAUDE_AGENT_ID: this.opts.agentId,
      ...identityCompatEnvironment(this.opts.identityCompat),
      OC_SESSION_KEY: this.opts.sessionKey,
      OPENCLAUDE_ENGINE: 'antigravity',
      ...(process.env.OPENCLAUDE_HOME?.trim() ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME.trim() } : {}),
      ...(projection.delegateContextFile
        ? {
            OPENCLAUDE_GATEWAY_PORT: String(this.opts.config.gateway.port),
            OPENCLAUDE_DELEGATE_CONTEXT_FILE: projection.delegateContextFile,
          }
        : {}),
      GEMINI_API_KEY: route.routeToken,
      GOOGLE_GEMINI_BASE_URL: route.baseUrl,
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      ...(this.traceId ? { OPENCLAUDE_TRACE_ID: this.traceId } : {}),
    }
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', cliModel,
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
    ]
    if (this.nativeId) args.push('--conversation', this.nativeId)
    if (ctx.abandoned) {
      this.cleanupLaunch(ctx)
      return
    }
    this.spawnChild(ctx, { bin: this.cliBin(), args, env, cwd: cwdDecision.cwd, line })
  }

  private spawnChild(
    ctx: TurnContext,
    spec: { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; line: string },
  ): void {
    const proc = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    ctx.proc = proc
    this.emit('spawn', { resumed: spec.args.includes('--conversation'), argv: [...spec.args] })
    this.ensureKeepalive()
    proc.stdin.on('error', () => { /* EPIPE after an early exit is reported via close */ })
    proc.stdin.write(spec.line)

    let stdoutBuffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (ctx.abandoned) return
      this.lastActivityAt = Date.now()
      this.emit('activity')
      stdoutBuffer += chunk
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        const text = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (text) this.handleLine(ctx, text)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      if (ctx.abandoned) return
      if (ctx.stderr.length < STDERR_MAX_CHARS) ctx.stderr += chunk.slice(0, STDERR_MAX_CHARS - ctx.stderr.length)
      // Fail fast instead of waiting out the CLI's 60 s OAuth prompt.
      if (!ctx.terminal && AUTH_PROMPT_RE.test(ctx.stderr)) {
        ctx.errorDetail = 'ANTIGRAVITY_AUTH_REQUIRED: CLI fell back to interactive Google sign-in'
        killProcessGroup(proc, 'SIGKILL')
      }
    })
    proc.once('error', (err) => {
      this.stopKeepalive()
      this.cleanupLaunch(ctx)
      if (ctx.abandoned) return
      if (!ctx.terminal) this.finishError(ctx, String(err))
      this.emit('error', err)
    })
    proc.once('close', (code, signal) => {
      this.stopKeepalive()
      this.cleanupLaunch(ctx)
      if (ctx.abandoned) return
      ctx.procClosed = true
      if (stdoutBuffer.trim()) this.handleLine(ctx, stdoutBuffer.trim())
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      const crashed = !ctx.interrupted && code !== 0
      // No result line: the conversation db may hold a half-written turn.
      if (!ctx.sawResult) this.nativeId = null
      if (!ctx.terminal) {
        const detail = ctx.errorDetail || ctx.stderr.trim() || `antigravity exited with code ${String(code)}`
        this.finishError(ctx, detail)
      }
      this.emit('exit', { code, signal, crashed })
      if (this.active === ctx) this.active = null
    })
  }

  private emitOmittedBinaryNotice(ctx: TurnContext): void {
    const omitted = countBinaryInputBlocks(ctx.params.input)
    if (omitted === 0) return
    const text = `${BINARY_BLOCK_OMITTED_NOTICE}\n\n`
    const segment: SegmentRecord = {
      index: ctx.assistantSegments.length,
      text,
      ts: Date.now(),
      eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
    }
    ctx.assistantSegments.push(segment)
    ctx.assistantText += text
    const messageIdBase = ctx.params.assistantMessageId
    ctx.params.onEvent({
      kind: 'block',
      block: { kind: 'text', text, ...(messageIdBase ? { messageId: `${messageIdBase}-s${segment.index}` } : {}) },
    })
  }

  private async composePrompt(
    params: TurnParams,
    repoSnapshot: ReturnType<NonNullable<EngineCreateOpts['getRepoSnapshot']>> | null,
    availableMcpTools: string[],
    cwdDecision: ReturnType<typeof decideEngineCwd>,
  ): Promise<string> {
    const input = promptText(params.input)
    try {
      const platform = await buildPromptContext({
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        persona: this.opts.persona,
        identityCompat: this.opts.identityCompat?.assets,
        provider: 'antigravity',
        model: this.currentModel,
        repoSnapshot: repoSnapshot ?? undefined,
        availableMcpTools,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
        sessionId: typeof this.opts.sessionId === 'string' ? this.opts.sessionId : undefined,
        projectId: this.opts.projectId,
      })
      await persistRunContextSnapshot({
        descriptor: this.opts.runContext,
        applied: platform.applied,
        promptContentSha256: platform.contentSha256,
        frozen: platform.frozenProjectContext,
        cwd: cwdDecision.cwd,
        cwdSource: cwdDecision.source,
        sessionRepoOverlay: cwdDecision.sessionRepoOverlay,
      })
      log.info('prompt_context_built', {
        sessionKey: this.opts.sessionKey,
        agentId: this.opts.agentId,
        backend: 'antigravity',
        prompt_bytes: Buffer.byteLength(platform.content || '', 'utf8'),
        prompt_sha256: createHash('sha256').update(platform.content || '', 'utf8').digest('hex').slice(0, 12),
      })
      return assemblePrompt(platform.content || '', input, this.platformGoal)
    } catch {
      if (this.opts.identityCompat?.assets) throw new Error('COMPAT_CONFIG_CONFLICT: identity prompt assembly failed')
      let persona = ''
      if (this.opts.persona) {
        try { persona = readFileSync(this.opts.persona, 'utf8').trim() } catch { persona = '' }
      }
      return assemblePrompt(persona, input, this.platformGoal)
    }
  }

  private handleLine(ctx: TurnContext, line: string): void {
    let event: AgyLine
    try {
      event = JSON.parse(line) as AgyLine
    } catch (err) {
      this.emit('parse_error', { line, err })
      return
    }
    if (ctx.terminal) return
    if (event.event === 'init') {
      const id = asText(event.conversation_id)
      if (CONVERSATION_ID_RE.test(id)) ctx.conversationId = id
      return
    }
    if (event.event === 'step_update') {
      const step = recordOf(event.step_update)
      if (step) this.handleStep(ctx, step)
      return
    }
    if (event.event === 'result') {
      this.handleResult(ctx, recordOf(event.result) ?? {})
    }
  }

  private handleStep(ctx: TurnContext, step: Record<string, unknown>): void {
    const type = asText(step.step_type)
    const state = asText(step.state)
    if (type === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
      if (delta) this.appendText(ctx, delta)
      const usage = recordOf(step.usage)
      if (state === 'DONE' && usage) {
        // Per-call usage. result.usage is cumulative across --conversation.
        ctx.usage.inputTokens += count(usage.input_tokens)
        ctx.usage.outputTokens += count(usage.output_tokens)
        ctx.usage.cacheReadTokens += count(usage.cache_read_tokens)
        ctx.usage.thinkingTokens += count(usage.thinking_tokens)
        ctx.params.onEvent({ kind: 'usage', usage: this.usageSnapshot(ctx) })
      }
      return
    }
    ctx.lastWasText = false
    if (type === 'tool') {
      this.handleToolStep(ctx, step, state)
      return
    }
    if (type === 'error_message') {
      const info = recordOf(step.error)
      const message = info ? asText(info.message) : asText(step.error)
      if (message) ctx.errorDetail = message
    }
    // user_input / system_message / checkpoint / unknown (native ask_question,
    // invisible in headless mode) carry nothing the product renders.
  }

  private appendText(ctx: TurnContext, text: string): void {
    ctx.sawOutput = true
    if (!ctx.lastWasText) {
      ctx.assistantSegments.push({
        index: ctx.assistantSegments.length,
        text: '',
        ts: Date.now(),
        eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
      })
    }
    ctx.lastWasText = true
    ctx.assistantText += text
    const segment = ctx.assistantSegments.at(-1)!
    segment.text += text
    const messageIdBase = ctx.params.assistantMessageId
    ctx.params.onEvent({
      kind: 'block',
      block: { kind: 'text', text, ...(messageIdBase ? { messageId: `${messageIdBase}-s${segment.index}` } : {}) },
    })
  }

  private toolId(ctx: TurnContext, step: Record<string, unknown>): string {
    const conv = (ctx.conversationId ?? 'turn').slice(0, 8)
    return `agy-${conv}-${count(step.step_index)}`
  }

  private handleToolStep(ctx: TurnContext, step: Record<string, unknown>, state: string): void {
    ctx.sawOutput = true
    const id = this.toolId(ctx, step)
    const info = recordOf(step.tool_info) ?? {}
    const nativeName = asText(info.name) || asText(step.tool_name)
    const parameters = info.parameters ?? {}
    if (!ctx.tools.has(id)) {
      const toolName = antigravityProductToolName(nativeName, parameters)
      const inputJson = antigravityProductToolInput(nativeName, parameters)
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
      const block: OutboundContentBlock = {
        kind: 'tool_use',
        blockId: id,
        toolName,
        inputJson: structuredClone(inputJson),
        inputPreview: tool.inputPreview,
        partial: false,
      }
      ctx.params.onEvent({ kind: 'block', block })
      ctx.params.onEvent({
        kind: 'tool_use_detected',
        tool: {
          name: toolName,
          id,
          input: recordOf(inputJson) ? structuredClone(inputJson) as Record<string, any> : {},
        },
      })
    }
    if (state !== 'DONE' && state !== 'ERROR') return
    const tool = ctx.tools.get(id)!
    if (tool.completed) return
    const error = recordOf(info.error)
    const isError = state === 'ERROR' || error !== null
    const raw = antigravityToolOutput(info.output)
    const output = isError
      ? (asText(error?.message) || raw || TOOL_FAILED_EMPTY_SENTINEL)
      : raw
    tool.output = output
    tool.completed = true
    tool.isError = isError
    tool.durationMs = Date.now() - (ctx.toolStartedAt.get(id) ?? Date.now())
    tool.ts = Date.now()
    ctx.pendingToolIds.delete(id)
    ctx.params.onEvent({
      kind: 'block',
      block: { kind: 'tool_result', toolUseBlockId: id, toolName: tool.toolName, isError, output, preview: output.slice(0, 500) },
    })
    ctx.params.onEvent({
      kind: 'tool_result_detected',
      result: {
        toolUseId: id,
        toolName: tool.toolName,
        preview: output.slice(0, 500),
        isError,
        durationMs: tool.durationMs,
        inputPreview: tool.inputPreview,
        ...(isError ? { terminationReason: 'tool_error' as const } : {}),
      },
    })
  }

  private handleResult(ctx: TurnContext, result: Record<string, unknown>): void {
    ctx.sawResult = true
    try { ctx.proc?.stdin.end() } catch { /* already closed */ }
    const status = asText(result.status)
    const id = asText(result.conversation_id)
    if (CONVERSATION_ID_RE.test(id)) ctx.conversationId = id
    if (status === 'CANCELED' || status === 'INTERRUPTED') ctx.interrupted = true
    if (status !== 'SUCCESS' && ctx.errorDetail === null) {
      ctx.errorDetail = asText(result.error) || `Antigravity turn ended with status ${status || 'unknown'}`
    }
    if (status === 'SUCCESS' && ctx.errorDetail === null) {
      // 1.3.4 reports SUCCESS for runs that produced nothing (oversized input)
      // and for headless soft-denied tools. Both are failures for the user.
      if (SOFT_DENY_RE.test(ctx.stderr)) {
        ctx.errorDetail = `ANTIGRAVITY_TOOL_DENIED: ${ctx.stderr.trim().slice(0, 500)}`
      } else if (!ctx.sawOutput && !asText(result.response)) {
        ctx.errorDetail = EMPTY_RUN_RE.test(ctx.stderr)
          ? `ANTIGRAVITY_EMPTY_RUN: ${ctx.stderr.trim().slice(0, 500)}`
          : 'ANTIGRAVITY_EMPTY_RUN: CLI reported success with no output'
      }
    }
    const committed = !ctx.interrupted && ctx.errorDetail === null && ctx.conversationId !== null
    if (committed) {
      this.nativeId = ctx.conversationId
      this.emit('session_id', ctx.conversationId)
    } else if (!this.nativeId || ctx.interrupted) {
      // Never pin later turns to a conversation whose last turn did not land.
      this.nativeId = null
    }
    this.finish(ctx, typeof result.num_turns === 'number' ? count(result.num_turns) : 1)
  }

  private usageSnapshot(ctx: TurnContext) {
    const u = ctx.usage
    return {
      totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: 0,
    }
  }

  private finish(ctx: TurnContext, numTurns: number): void {
    this.stopKeepalive()
    if (ctx.terminal) return
    ctx.terminal = true
    if (ctx.interrupted && ctx.errorDetail === null) ctx.errorDetail = 'Antigravity turn cancelled'
    const isError = ctx.errorDetail !== null
    const stopReason = ctx.interrupted ? 'interrupted' : isError ? 'error' : 'end_turn'
    ctx.params.sessionTotals.turns += 1
    if (isError) ctx.params.onEvent({ kind: 'error', error: ctx.errorDetail! })
    // 1.3.4 never streams thought text (only thinking_tokens), so the
    // thinking channel stays empty.
    const usage = this.usageSnapshot(ctx)
    ctx.params.onEvent({ kind: 'final', meta: { ...usage, stopReason, cost: 0 } })
    ctx.resolveSummary({
      usage: { cost: 0, ...usage },
      assistantText: ctx.assistantText,
      thinkingText: '',
      assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
      thinkingSegments: [],
      tools: [...ctx.tools.values()].map((tool) => structuredClone(tool)),
      runtimeEvents: [],
      stopReason,
      numTurns,
      isError,
      ...(isError
        ? { errorKind: authError(ctx.errorDetail!) ? 'auth' as const : 'other' as const, errorDetail: ctx.errorDetail! }
        : {}),
      staleResumeId: false,
      phantomSignals: { ...EMPTY_SIGNALS },
    })
  }

  private finishError(ctx: TurnContext, detail: string): void {
    if (ctx.terminal) return
    if (ctx.errorDetail === null) ctx.errorDetail = detail
    this.finish(ctx, 1)
  }

  private forceEnd(ctx: TurnContext): void {
    this.stopKeepalive()
    if (ctx.terminal) return
    ctx.terminal = true
    ctx.resolveSummary(null)
  }

  private cleanupLaunch(ctx: TurnContext): void {
    const projection = ctx.projection
    if (!projection) return
    ctx.projection = null
    cleanupAntigravityLaunch(projection)
  }

  private ensureKeepalive(): void {
    if (this.keepaliveTimer) return
    // The CLI can think for minutes with no stdout; a live process keeps the
    // session's idle watchdog from killing it.
    this.keepaliveTimer = setInterval(() => {
      const ctx = this.active
      if (!ctx || ctx.terminal || ctx.abandoned || !ctx.proc || ctx.proc.exitCode !== null) {
        this.stopKeepalive()
        return
      }
      this.lastActivityAt = Date.now()
      this.emit('activity')
    }, KEEPALIVE_INTERVAL_MS)
    this.keepaliveTimer.unref()
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) return
    clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  interrupt(): boolean {
    const ctx = this.active
    if (!ctx?.proc || ctx.proc.killed || ctx.terminal) return false
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
    const grace = shutdownTimeoutMs('OPENCLAUDE_ANTIGRAVITY_SHUTDOWN_GRACE_MS', SHUTDOWN_GRACE_DEFAULT_MS)
    const barrier = this.drain
    let proc = ctx.proc
    if (!proc) {
      if (await waitForCloseWithin(barrier, grace)) return
      proc = ctx.proc
      if (!proc) {
        this.abandonTurn(ctx, null, 'antigravity never started')
        return
      }
    }
    killProcessGroup(proc, 'SIGTERM')
    let closed = await waitForCloseWithin(barrier, grace)
    if (!closed) {
      killProcessGroup(proc, 'SIGKILL')
      closed = await waitForCloseWithin(
        barrier,
        shutdownTimeoutMs('OPENCLAUDE_ANTIGRAVITY_SHUTDOWN_FINAL_DRAIN_MS', SHUTDOWN_FINAL_DRAIN_DEFAULT_MS),
      )
    }
    if (closed) return
    log.error('antigravity stdout never closed after process-group SIGKILL', { sessionKey: this.opts.sessionKey, pid: proc.pid })
    this.abandonTurn(ctx, proc, 'antigravity did not exit after SIGKILL')
  }

  private abandonTurn(
    ctx: TurnContext,
    proc: ChildProcessByStdio<Writable, Readable, Readable> | null,
    detail: string,
  ): void {
    this.stopKeepalive()
    this.cleanupLaunch(ctx)
    if (!ctx.sawResult) this.nativeId = null
    ctx.abandoned = true
    if (proc) detachChildStdio(proc)
    if (!ctx.terminal) this.finishError(ctx, detail)
    ctx.resolveDrain?.()
    ctx.resolveDrain = null
    if (this.active === ctx) this.active = null
    if (proc) {
      try { proc.unref() } catch { /* already detached */ }
    }
  }

  waitForOutputDrain(): Promise<void> { return this.drain }
  get nativeSessionId(): string | null { return this.nativeId }
  isResumeIdCompatible(sessionId: string): boolean { return CONVERSATION_ID_RE.test(sessionId) }
  clearSessionId(): void { this.nativeId = null }
  setResumeSessionId(sessionId: string): void {
    this.nativeId = CONVERSATION_ID_RE.test(sessionId) ? sessionId : null
  }
  setModel(model: string | undefined): void { this.currentModel = model }
  get model(): string | undefined { return this.currentModel }
  setEffortLevel(level: string | undefined): void { this.currentEffort = level }
  get effortLevel(): string | undefined { return this.currentEffort }
  setTraceId(traceId: string | undefined): void { this.traceId = traceId }
  setGoalState(goal: GoalStateSnapshot | null): Promise<void> {
    this.platformGoal = goal ? structuredClone(goal) : null
    return Promise.resolve()
  }
  updateConfig(config: OpenClaudeConfig): void { this.opts.config = config }
  setToolsets(toolsets: string[] | undefined): void { this.currentToolsets = toolsets }
  get toolsets(): string[] | undefined { return this.currentToolsets }
  setExecutionTarget(target: ExecutionTarget): void {
    if (target.kind !== 'local') throw new Error('Antigravity engine supports local execution only')
    this.currentTarget = target
  }
  get executionTarget(): ExecutionTarget { return this.currentTarget }
  sendPermissionResponse(_requestId: string, _response: unknown): boolean { return false }
  getPartialSnapshot(): PartialSnapshot { return snapshotOf(this.active) }
  get pendingToolCalls(): number { return this.active?.pendingToolIds.size ?? 0 }
  get isRunning(): boolean { return !!this.active?.proc && !this.active.proc.killed && !this.active.terminal }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null { return null }
}

export const _internals = {
  promptText,
  assemblePrompt,
}

registerEngine('antigravity', (opts) => new AntigravityAdapter(opts))
