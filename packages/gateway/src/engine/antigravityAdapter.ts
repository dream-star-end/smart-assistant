import { systemHelpEnvironment } from '../systemHelpEnvironment.js'
import { PassiveStageTiming } from '../passiveStageTiming.js'
import { identityCompatEnvironment } from '@openclaude/storage'
/**
 * Official Google Antigravity CLI adapter (OCV5-415, experimental, hidden).
 *
 * One `antigravity` process per turn in headless stream-json mode. The prompt
 * goes in on stdin as one `{"event":"user",...}` NDJSON line (argv is capped
 * near 128 KB and visible in `ps`); stdin stays open until the `result`
 * event, then closes so the CLI exits.
 *
 * The CLI runs in Google-account mode against a Google AI subscription
 * account that only master holds (OCV5-415 P2). Per turn, master supplies a
 * loopback relay route plus a limited (openid/userinfo) token: the token goes
 * into the launch HOME's token file for the CLI's startup eligibility check,
 * and `CLOUD_CODE_URL=<route>` sends every `/v1internal:*` call through the
 * relay, which swaps in the account's real token. Without a valid route the
 * turn fails closed before spawning.
 *
 * Billing is external and relay-metered: master sums the relay's per-call
 * usageMetadata rows. The CLI's own `result.usage` omits the title-generation
 * call and is cumulative across a resumed conversation, so it is only used
 * for display here, summed from per-step usage. The adapter's external_billing
 * event carries status only.
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
  ANTIGRAVITY_RELAY_PREFIX,
  antigravityCliModelId,
  TOOL_FAILED_EMPTY_SENTINEL,
  type GoalStateSnapshot,
  type OutboundContentBlock,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { EngineAdapter, EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { EngineExternalBillingEvent, PartialSnapshot, PhantomSignals, SegmentRecord, TurnSummary, TurnToolEntry } from './engineEvents.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { BINARY_BLOCK_OMITTED_NOTICE, countBinaryInputBlocks, isBinaryInputBlock } from './promptInput.js'
import { buildCodexEnv } from './codexShared.js'
import { createLogger } from '../logger.js'
import { probeEnvFacts } from '../envProbe.js'
import { detachChildStdio, killProcessGroup, shutdownTimeoutMs, waitForCloseWithin } from '../processGroupShutdown.js'
import { decideEngineCwd } from '../engineCwd.js'
import { persistRunContextSnapshot } from '../runContextPersist.js'
import { buildPromptContext } from '../promptSlots.js'
import { prepareBoundedPrompt } from './boundedPrompt.js'
import { renderCcbGoalPrompt } from '../goalPrompt.js'
import { bindRouteTrace } from '../relayTrace.js'
import {
  ANTIGRAVITY_PREAMBLE,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
  type AntigravityPlatformProjection,
} from './antigravityPlatform.js'
import { antigravityProductToolInput, antigravityProductToolName, antigravityToolOutput } from './antigravityToolNormalize.js'

const log = createLogger({ module: 'antigravityAdapter' })

const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
export const ANTIGRAVITY_RELAY_PATH_PREFIX = `${ANTIGRAVITY_RELAY_PREFIX}/route/`
/** 350 KB stdin prompts were verified; a 1.1 MB one made 1.3.4 report
 * SUCCESS with an empty response. Stay well under the verified size. */
export const ANTIGRAVITY_MAX_PROMPT_BYTES = 300 * 1024
const SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000
const KEEPALIVE_INTERVAL_MS = 30_000
/** Native file operations have no model-generation phase after ACTIVE.
 * Reuse the gateway's existing idle budget from that observed start; do not
 * apply it to commands, MCP, subagents, or the preceding high-effort thought. */
const BOUNDED_FILE_TOOLS = new Set([
  'view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file',
])
/** After `result`, wait this long for the process to exit so trailing
 * stderr (soft-deny / empty-run notices) is read before the turn settles. */
const RESULT_SETTLE_MS = 5_000
/** How long a possibly repeated old ERROR waits for the exit code before it fails. */
const STALE_ERROR_EXIT_WAIT_MS = 30_000

/** Sandboxed resolution set; user-writable PATH entries stay out. */
const ANTIGRAVITY_SPAWN_PATH = '/run/oc/platform/current/bin:/usr/local/bin:/usr/bin:/bin'

/**
 * Selfhost keeps the host wrapper in the persistent agent home, outside the
 * sandboxed PATH. The projection links just that wrapper into a private launch
 * dir, so `host 'cmd'` resolves without trusting ~/.local/bin (OCV5-530).
 */
function antigravitySpawnPath(hostPathDir: string | null): string {
  return hostPathDir ? `${hostPathDir}:${ANTIGRAVITY_SPAWN_PATH}` : ANTIGRAVITY_SPAWN_PATH
}

let timingTestHooks: { keepaliveMs?: number; resultSettleMs?: number; staleErrorExitWaitMs?: number } | null = null
const STDERR_MAX_CHARS = 64 * 1024
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 1.3.4 without usable credentials prints an OAuth URL and blocks for 60 s. */
const AUTH_PROMPT_RE = /Authentication required|Waiting for authentication|authentication failed or timed out/i
/** Headless soft-deny: tool step reports DONE with no output, exit 0. */
const SOFT_DENY_RE = /auto-denied/i
const EMPTY_RUN_RE = /run ended with no output/i
/** Go oauth2 refusing the CLI token file locally (OCV5-556). */
/** What the CLI prints to stderr when a launch fails (`error: …`, `AGY_ERROR: {…}`). */
const CLI_STDERR_ERROR_RE = /^(?:error:|AGY_ERROR:)/m
/** CLI ended SUCCESS right after one of this launch's own error steps. */
export const ANTIGRAVITY_ERROR_STEP = 'ANTIGRAVITY_ERROR_STEP'
const CLI_CREDENTIAL_EXPIRED_RE = /oauth2: token expired|refresh token is not set/i

/**
 * The CLI token file is platform-owned: a turn that dies on it is a platform
 * credential fault, not an upstream outage. Tag it so errorClassify routes it
 * to `platform_credential_expired` (no automatic recovery, precise copy).
 */
export function normalizeAntigravityErrorDetail(detail: string): string {
  if (detail.startsWith('ANTIGRAVITY_CREDENTIAL_EXPIRED:')) return detail
  return CLI_CREDENTIAL_EXPIRED_RE.test(detail) ? `ANTIGRAVITY_CREDENTIAL_EXPIRED: ${detail}` : detail
}

const EMPTY_SIGNALS: Readonly<PhantomSignals> = Object.freeze({ apiState: 'unknown', skipReason: null })

export interface AntigravityRouteOverride {
  baseUrl: string
  routeToken: string
  /** openid/userinfo-only Google token for the CLI token file. */
  accessToken: string
  accessTokenExpiresAt: string
  idToken?: string
}

const REQUEST_ID_RE = /^[0-9a-f]{32}$/
/** Relay refusals that mean the turn ran out of budget, not that it failed. */
const BUDGET_EXHAUSTED_RE = /ANTIGRAVITY_BUDGET_EXHAUSTED|\b402\b/
const QUOTA_RE = /RESOURCE_EXHAUSTED|\b429\b|quota/i

interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
}

type AgyLine = Record<string, unknown> & { event?: unknown }

interface TurnContext {
  timing: PassiveStageTiming
  params: TurnParams
  startedAt: number
  proc: ChildProcessByStdio<Writable, Readable, Readable> | null
  projection: AntigravityPlatformProjection | null
  assistantText: string
  assistantSegments: SegmentRecord[]
  lastWasText: boolean
  tools: Map<string, TurnToolEntry>
  toolStartedAt: Map<string, number>
  boundedFileToolStartedAt: Map<string, number>
  pendingToolIds: Set<string>
  usage: StepUsage
  stderr: string
  conversationId: string | null
  sawResult: boolean
  pendingResult: Record<string, unknown> | null
  resultTimer: NodeJS.Timeout | null
  keepalive: NodeJS.Timeout | null
  /** Ends this turn's route-token trace binding for the container relay (OCV5-595). */
  releaseRelayTrace: (() => void) | null
  sawOutput: boolean
  terminal: boolean
  procClosed: boolean
  abandoned: boolean
  interrupted: boolean
  interruptReason: 'user' | 'system' | null
  errorDetail: string | null
  /** step_index of this launch's own user_input; earlier indices are history. */
  firstOwnStepIndex: number | null
  /** error_message seen before this launch's user_input; used only if the run fails. */
  preludeErrorDetail: string | null
  /** This launch's last step was an error_message (1.4.0 streams it without text). */
  trailingErrorStep: boolean
  /** This launch streamed an error_message step of its own. */
  ownErrorStep: boolean
  /** Launched with `--conversation` (resuming an existing CLI conversation). */
  resumedLaunch: boolean
  /** CLI exit code once the process closed. */
  exitCode: number | null
  /** A possibly repeated old ERROR is waiting for the exit code (Codex r2 P1). */
  awaitingExitSince: number | null
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
  if (!route || !ROUTE_TOKEN_RE.test(route.routeToken) || !route.accessToken || !route.accessTokenExpiresAt) {
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
      timing: new PassiveStageTiming({ engine: 'antigravity', generation: 1, traceId: params.traceId,
        sessionKey: this.opts.sessionKey, model: this.currentModel },
        (fields) => log.info('engine_turn_timing', { ...fields })),
      params,
      startedAt: Date.now(),
      proc: null,
      projection: null,
      assistantText: '',
      assistantSegments: [],
      lastWasText: false,
      tools: new Map(),
      toolStartedAt: new Map(),
      boundedFileToolStartedAt: new Map(),
      pendingToolIds: new Set(),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 },
      stderr: '',
      conversationId: null,
      sawResult: false,
      pendingResult: null,
      resultTimer: null,
      keepalive: null,
      releaseRelayTrace: null,
      sawOutput: false,
      terminal: false,
      procClosed: false,
      abandoned: false,
      interrupted: false,
      interruptReason: null,
      errorDetail: null,
      firstOwnStepIndex: null,
      preludeErrorDetail: null,
      trailingErrorStep: false,
      ownErrorStep: false,
      resumedLaunch: false,
      exitCode: null,
      awaitingExitSince: null,
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
        systemHelpContextFile: this.opts.systemHelpContextFile,
      credential: {
        accessToken: route.accessToken,
        accessTokenExpiresAt: route.accessTokenExpiresAt,
        ...(route.idToken ? { idToken: route.idToken } : {}),
      },
      identityCompat: this.opts.identityCompat,
      agentId: this.opts.agentId,
      projectId: this.opts.projectId,
      sessionKey: this.opts.sessionKey,
      traceId: ctx.params.traceId,
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
      hostBin: probeEnvFacts().hostBin,
    })
    ctx.projection = projection
    log.info('antigravity CLI credential projected', {
      sessionKey: this.opts.sessionKey,
      traceId: ctx.params.traceId,
      admittedTokenExpiresAt: route.accessTokenExpiresAt,
      cliTokenFileExpiry: projection.cliTokenFileExpiry,
    })
    const platformContent = await this.composePlatformContent(repoSnapshot, projection.advertisedMcpTools, cwdDecision)
    const stdinLine = (input: string): string =>
      `${JSON.stringify({ event: 'user', message: { content: assemblePrompt(platformContent, input, this.platformGoal) } })}\n`
    const input = promptText(ctx.params.input)
    const line = await prepareBoundedPrompt({
      input,
      serialize: stdinLine,
      maxBytes: ANTIGRAVITY_MAX_PROMPT_BYTES,
      cwd: cwdDecision.cwd,
      engine: this.engineId,
      onEvent: (event) => { if (!ctx.terminal) ctx.params.onEvent(event) },
    })
    // Context-file IO can outlive the logical turn. Never launch a paid CLI
    // after end()/shutdown has already retired this turn during preparation.
    if (ctx.terminal || ctx.abandoned) {
      this.cleanupLaunch(ctx)
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      return
    }

    const isolatedEnv = buildCodexEnv()
    for (const key of Object.keys(isolatedEnv)) {
      if (key.startsWith('GEMINI_') || key.startsWith('GOOGLE_') || key.startsWith('AGY_') || key.startsWith('CODEX_')) {
        delete isolatedEnv[key]
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...systemHelpEnvironment(this.opts.systemHelpContextFile, this.opts.config.gateway.port),
      ...isolatedEnv,
      PATH: antigravitySpawnPath(projection.hostPathDir),
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
      CLOUD_CODE_URL: route.baseUrl,
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
    ctx.releaseRelayTrace = bindRouteTrace(route.routeToken, this.traceId)
    this.spawnChild(ctx, { bin: this.cliBin(), args, env, cwd: cwdDecision.cwd, line })
  }

  private spawnChild(
    ctx: TurnContext,
    spec: { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; line: string },
  ): void {
    ctx.timing.once('spawn_requested')
    ctx.resumedLaunch = spec.args.includes('--conversation')
    const proc = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    ctx.timing.once('spawned')
    ctx.proc = proc
    this.emit('spawn', { resumed: spec.args.includes('--conversation'), argv: [...spec.args] })
    this.ensureKeepalive(ctx)
    proc.stdin.on('error', () => { /* EPIPE after an early exit is reported via close */ })
    proc.stdin.write(spec.line)

    let stdoutBuffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (ctx.abandoned) return
      if (chunk.length > 0) ctx.timing.once('first_stdout')
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
      this.stopKeepalive(ctx)
      this.cleanupLaunch(ctx)
      if (ctx.abandoned) return
      if (!ctx.terminal) this.finishError(ctx, String(err))
      this.emit('error', err)
    })
    proc.once('close', (code, signal) => {
      this.stopKeepalive(ctx)
      this.cleanupLaunch(ctx)
      if (ctx.abandoned) return
      ctx.procClosed = true
      ctx.exitCode = code
      if (stdoutBuffer.trim()) this.handleLine(ctx, stdoutBuffer.trim())
      if (ctx.pendingResult) this.settleResult(ctx)
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      const crashed = !ctx.interrupted && code !== 0
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

  private async composePlatformContent(
    repoSnapshot: ReturnType<NonNullable<EngineCreateOpts['getRepoSnapshot']>> | null,
    availableMcpTools: string[],
    cwdDecision: ReturnType<typeof decideEngineCwd>,
  ): Promise<string> {
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
      return platform.content || ''
    } catch {
      if (this.opts.identityCompat?.assets) throw new Error('COMPAT_CONFIG_CONFLICT: identity prompt assembly failed')
      let persona = ''
      if (this.opts.persona) {
        try { persona = readFileSync(this.opts.persona, 'utf8').trim() } catch { persona = '' }
      }
      return persona
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
      ctx.timing.once('cli_init_received')
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
    const stepIndex = typeof step.step_index === 'number' && Number.isSafeInteger(step.step_index)
      ? step.step_index
      : null
    if (type === 'user_input' && ctx.firstOwnStepIndex === null && stepIndex !== null) {
      ctx.firstOwnStepIndex = stepIndex
    }
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
      // OCV5-556: a `--conversation` resume streamed an earlier launch's error
      // step (old relay route, long-expired token) after this launch's own
      // steps had succeeded, failing four good turns in a row. Steps before
      // this launch's user_input belong to earlier launches.
      if (ctx.firstOwnStepIndex === null) {
        if (message) ctx.preludeErrorDetail = message
        return
      }
      if (stepIndex !== null && stepIndex < ctx.firstOwnStepIndex) {
        if (!message) return
        log.warn('antigravity ignored error step from an earlier launch of the conversation', {
          sessionKey: this.opts.sessionKey,
          stepIndex,
          firstOwnStepIndex: ctx.firstOwnStepIndex,
        })
        return
      }
      // OCV5-556: 1.4.0 streams this launch's own error steps with no text and
      // can still end the run SUCCESS (a relay ROUTE_EXPIRED 60 minutes into a
      // turn ended as a "success" with no reply). Remember it; settleResult
      // fails the turn unless a later tool or reply step shows the run went on.
      ctx.ownErrorStep = true
      if (message) ctx.errorDetail = message
      else ctx.trailingErrorStep = true
    }
    // user_input / system_message / checkpoint / unknown (native ask_question,
    // invisible in headless mode) carry nothing the product renders.
  }

  private appendText(ctx: TurnContext, text: string): void {
    if (text.trim()) {
      ctx.timing.once('first_text')
      ctx.trailingErrorStep = false
    }
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
    ctx.trailingErrorStep = false
    const id = this.toolId(ctx, step)
    const info = recordOf(step.tool_info) ?? {}
    const nativeName = asText(info.name) || asText(step.tool_name)
    const parameters = info.parameters ?? {}
    // Only this launch's first ACTIVE proves that local work started. Replayed
    // history, duplicate ACTIVE, unrelated stdout and keepalive cannot renew it.
    if (
      state === 'ACTIVE' && BOUNDED_FILE_TOOLS.has(nativeName) &&
      ctx.firstOwnStepIndex !== null && typeof step.step_index === 'number' &&
      Number.isSafeInteger(step.step_index) && step.step_index >= ctx.firstOwnStepIndex &&
      !ctx.tools.get(id)?.completed && !ctx.boundedFileToolStartedAt.has(id)
    ) {
      ctx.boundedFileToolStartedAt.set(id, Date.now())
    }
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
    ctx.boundedFileToolStartedAt.delete(id)
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
    if (ctx.sawResult) return
    ctx.sawResult = true
    ctx.pendingResult = result
    try { ctx.proc?.stdin.end() } catch { /* already closed */ }
    // Settle on process close (all stderr read) or after a bounded wait.
    ctx.resultTimer = setTimeout(() => { this.settleResult(ctx) }, timingTestHooks?.resultSettleMs ?? RESULT_SETTLE_MS)
    ctx.resultTimer.unref()
  }

  private settleResult(ctx: TurnContext): void {
    const result = ctx.pendingResult
    if (!result || ctx.terminal || ctx.abandoned) return
    if (ctx.resultTimer) {
      clearTimeout(ctx.resultTimer)
      ctx.resultTimer = null
    }
    // The exit code decides whether an ERROR is the CLI repeating an old one;
    // hold such a result until the process closes, within a bound.
    if (!ctx.procClosed && this.mayBeRepeatedOldError(ctx, result)) {
      const now = Date.now()
      ctx.awaitingExitSince ??= now
      const wait = timingTestHooks?.staleErrorExitWaitMs ?? STALE_ERROR_EXIT_WAIT_MS
      const left = ctx.awaitingExitSince + wait - now
      if (left > 0) {
        ctx.resultTimer = setTimeout(() => { this.settleResult(ctx) }, left)
        ctx.resultTimer.unref()
        return
      }
    }
    ctx.pendingResult = null
    let status = asText(result.status)
    // OCV5-556: once a launch of a conversation failed (e.g. relay
    // ROUTE_EXPIRED), 1.4.0 ends every later `--conversation` launch with
    // status ERROR and that old error, even when the launch answered normally
    // (exit 0, empty stderr). The recovery and the next messages then "failed"
    // until the retry circuit opened. Such a launch resumed a conversation,
    // started, answered, streamed no error step of its own, exited 0 and wrote
    // no error to stderr; a launch that really failed (even after a partial
    // reply) exits non-zero and prints the error (Codex r1 P1).
    if (ctx.procClosed && ctx.exitCode === 0 && this.mayBeRepeatedOldError(ctx, result)) {
      log.warn('antigravity CLI repeated an earlier launch error on a run that answered', {
        sessionKey: this.opts.sessionKey,
        error: asText(result.error).slice(0, 300),
      })
      status = 'SUCCESS'
    }
    const id = asText(result.conversation_id)
    if (CONVERSATION_ID_RE.test(id)) ctx.conversationId = id
    if (status === 'CANCELED' || status === 'INTERRUPTED') ctx.interrupted = true
    if (status !== 'SUCCESS' && ctx.errorDetail === null) {
      ctx.errorDetail = asText(result.error) || ctx.preludeErrorDetail ||
        `Antigravity turn ended with status ${status || 'unknown'}`
    }
    if (status === 'SUCCESS' && ctx.errorDetail === null) {
      // 1.3.4 reports SUCCESS for runs that produced nothing (oversized input)
      // and for headless soft-denied tools. Both are failures for the user.
      const denied = Array.isArray(result.denied_actions) ? result.denied_actions : []
      if (ctx.trailingErrorStep) {
        const why = asText(result.error) || ctx.stderr.trim().slice(-500) || 'CLI reported success after an error step'
        ctx.errorDetail = `${ANTIGRAVITY_ERROR_STEP}: ${why}`
      } else if (denied.length > 0 || SOFT_DENY_RE.test(ctx.stderr)) {
        const actions = denied.map((d) => asText(recordOf(d)?.action) || asText(d)).filter(Boolean)
        ctx.errorDetail = `ANTIGRAVITY_TOOL_DENIED: ${actions.length > 0 ? actions.join(',') : ctx.stderr.trim().slice(0, 500)}`
      } else if (!ctx.sawOutput && !asText(result.response)) {
        ctx.errorDetail = EMPTY_RUN_RE.test(ctx.stderr)
          ? `ANTIGRAVITY_EMPTY_RUN: ${ctx.stderr.trim().slice(0, 500)}`
          : 'ANTIGRAVITY_EMPTY_RUN: CLI reported success with no output'
      }
    }
    // Commit only a conversation whose turn landed. On failure or cancel the
    // last committed id stays: SessionManager's resume map still holds it and
    // decides history replay from it, so the adapter must not diverge.
    if (!ctx.interrupted && ctx.errorDetail === null && ctx.conversationId !== null) {
      this.nativeId = ctx.conversationId
      this.emit('session_id', ctx.conversationId)
    }
    this.finish(ctx, typeof result.num_turns === 'number' ? count(result.num_turns) : 1)
  }

  /** Everything but the exit code that marks an ERROR as the repeated old one. */
  private mayBeRepeatedOldError(ctx: TurnContext, result: Record<string, unknown>): boolean {
    return asText(result.status) === 'ERROR' &&
      ctx.resumedLaunch &&
      !CLI_STDERR_ERROR_RE.test(ctx.stderr) &&
      !ctx.ownErrorStep &&
      ctx.firstOwnStepIndex !== null &&
      (ctx.assistantText.trim() !== '' || asText(result.response).trim() !== '')
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
    this.stopKeepalive(ctx)
    if (ctx.resultTimer) {
      clearTimeout(ctx.resultTimer)
      ctx.resultTimer = null
    }
    if (ctx.terminal) return
    ctx.terminal = true
    if (ctx.interrupted && ctx.errorDetail === null) {
      ctx.errorDetail = ctx.interruptReason === 'user'
        ? 'Antigravity turn cancelled' : 'Antigravity turn interrupted by system'
    }
    if (ctx.errorDetail !== null) ctx.errorDetail = normalizeAntigravityErrorDetail(ctx.errorDetail)
    const isError = ctx.errorDetail !== null
    const stopReason = ctx.interrupted ? 'interrupted' : isError ? 'error' : 'end_turn'
    ctx.params.sessionTotals.turns += 1
    if (isError) ctx.params.onEvent({ kind: 'error', error: ctx.errorDetail! })
    // 1.3.4 never streams thought text (only thinking_tokens), so the
    // thinking channel stays empty.
    const usage = this.usageSnapshot(ctx)
    this.emitExternalBilling(ctx, isError)
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

  /** Status-only sideband: master settles from the relay's usage rows. */
  private emitExternalBilling(ctx: TurnContext, isError: boolean): void {
    const requestId = ctx.params.requestId
    if (!requestId || !REQUEST_ID_RE.test(requestId)) return
    const detail = ctx.errorDetail ?? ''
    // The relay refuses new calls past the admission budget; the tokens used
    // up to there were consumed, so settle them (master clamps to balance).
    const budgetStop = isError && !ctx.interrupted && BUDGET_EXHAUSTED_RE.test(detail)
    const cls = !isError || ctx.interrupted || budgetStop ? null
      : authError(detail) ? 'auth' as const
      : QUOTA_RE.test(detail) ? 'quota' as const
      : null
    const status: EngineExternalBillingEvent['status'] = budgetStop || !isError ? 'success'
      : cls ? 'unavailable' : 'error'
    const terminalCode: EngineExternalBillingEvent['terminalCode'] = budgetStop || !isError ? undefined
      : ctx.interruptReason === 'user' ? 'USER_CANCELLED'
      : cls === 'auth' ? 'AUTH_UNAVAILABLE'
      : cls === 'quota' ? 'QUOTA_UNAVAILABLE'
      : 'ENGINE_ERROR'
    this.emit('external_billing', {
      requestId,
      engine: 'antigravity',
      status,
      durationMs: Date.now() - ctx.startedAt,
      ...(terminalCode ? { terminalCode } : {}),
    } satisfies EngineExternalBillingEvent)
  }

  private finishError(ctx: TurnContext, detail: string): void {
    if (ctx.terminal) return
    if (ctx.errorDetail === null) ctx.errorDetail = detail
    this.finish(ctx, 1)
  }

  private forceEnd(ctx: TurnContext): void {
    this.stopKeepalive(ctx)
    if (ctx.terminal) return
    ctx.terminal = true
    ctx.resolveSummary(null)
  }

  private cleanupLaunch(ctx: TurnContext): void {
    // Every caller is the end of the turn's process, so its relay requests stop naming this turn too.
    ctx.releaseRelayTrace?.()
    ctx.releaseRelayTrace = null
    const projection = ctx.projection
    if (!projection) return
    ctx.projection = null
    cleanupAntigravityLaunch(projection)
  }

  /** Per-turn timer: an earlier turn's late `close` must not stop the
   * liveness signal of the turn that replaced it. */
  private ensureKeepalive(ctx: TurnContext): void {
    if (ctx.keepalive) return
    // The CLI can think for minutes with no stdout; a live process keeps the
    // session's idle watchdog from killing it.
    ctx.keepalive = setInterval(() => {
      if (this.active !== ctx || ctx.terminal || ctx.abandoned || !ctx.proc || ctx.proc.exitCode !== null) {
        this.stopKeepalive(ctx)
        return
      }
      this.lastActivityAt = Date.now()
      this.emit('activity')
    }, timingTestHooks?.keepaliveMs ?? KEEPALIVE_INTERVAL_MS)
    ctx.keepalive.unref()
  }

  private stopKeepalive(ctx: TurnContext): void {
    if (!ctx.keepalive) return
    clearInterval(ctx.keepalive)
    ctx.keepalive = null
  }

  interrupt(reason: 'user' | 'system' = 'system'): boolean {
    const ctx = this.active
    if (!ctx?.proc || ctx.proc.killed || ctx.terminal || ctx.sawResult) return false
    ctx.interruptReason ??= reason
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
    this.stopKeepalive(ctx)
    this.cleanupLaunch(ctx)
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
  get idleWatchdogActivityAt(): number {
    const ctx = this.active
    let at = this.lastActivityAt
    if (ctx && !ctx.terminal && !ctx.abandoned && !ctx.sawResult) {
      for (const startedAt of ctx.boundedFileToolStartedAt.values()) at = Math.min(at, startedAt)
    }
    return at
  }
  get isRunning(): boolean { return !!this.active?.proc && !this.active.proc.killed && !this.active.terminal }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null { return null }
}

export const _internals = {
  promptText,
  assemblePrompt,
  setTimingTestHooks(hooks: { keepaliveMs?: number; resultSettleMs?: number; staleErrorExitWaitMs?: number } | null): void {
    timingTestHooks = hooks
  },
}

registerEngine('antigravity', (opts) => new AntigravityAdapter(opts))
