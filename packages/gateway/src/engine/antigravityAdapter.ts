import { renewAntigravityRouteLease } from '../delegateAntigravityRoute.js'
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
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import {
  ANTIGRAVITY_RELAY_PREFIX,
  SWARM_BOARD_TOOL_NAME,
  antigravityCliModelId,
  mergeSwarmSnapshots,
  TOOL_FAILED_EMPTY_SENTINEL,
  type GoalStateSnapshot,
  type OutboundContentBlock,
  type SwarmPhase,
  type SwarmSnapshot,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type { EngineAdapter, EngineCapabilities, EngineTurnRun, TurnParams } from './engineAdapter.js'
import type { EngineExternalBillingEvent, PartialSnapshot, PhantomSignals, SegmentRecord, TurnSummary, TurnToolEntry } from './engineEvents.js'
import { SubprocessRunner } from '../subprocessRunner.js'
import { type EngineCreateOpts, registerEngine, registerEngineRemoteContext } from './registry.js'
import { BINARY_BLOCK_OMITTED_NOTICE, countBinaryInputBlocks, isBinaryInputBlock } from './promptInput.js'
import { buildCodexEnv } from './codexShared.js'
import { createLogger } from '../logger.js'
import { probeEnvFacts } from '../envProbe.js'
import { detachChildStdio, killProcessGroup, shutdownTimeoutMs, waitForCloseWithin } from '../processGroupShutdown.js'
import { decideEngineCwd } from '../engineCwd.js'
import { persistRunContextSnapshot } from '../runContextPersist.js'
import { buildPromptContext, memoryInstructionsFingerprint } from '../promptSlots.js'
import { prepareBoundedPrompt } from './boundedPrompt.js'
import { renderCcbGoalPrompt } from '../goalPrompt.js'
import { bindRouteTrace } from '../relayTrace.js'
import {
  ANTIGRAVITY_PREAMBLE,
  antigravityRoot,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
  type AntigravityPlatformProjection,
} from './antigravityPlatform.js'
import {
  buildAntigravityPromptInputsKey,
  clearAntigravityPromptState,
  decideAntigravityPromptElision,
  writeAntigravityPromptState,
} from './antigravityPromptState.js'
import { antigravityProductToolInput, antigravityProductToolName, antigravityToolOutput } from './antigravityToolNormalize.js'
import { AntigravityToolBackfiller, isBackfillableAntigravityFileTool } from './antigravityToolBackfill.js'
import {
  AntigravitySwarmWatcher,
  buildDurableSwarmBoardInput,
  formatSwarmWorkingDetail,
  settleSwarmSnapshotTerminal,
} from './antigravitySwarmWatcher.js'
import {
  prepareAntigravityNativeTrajectory,
  recoverAntigravityNativeTrajectory,
  type AntigravityNativeBinding,
} from './antigravityNativeTrajectory.js'

export interface AntigravityDeliveryDependencies {
  nativeTrajectory?: {
    prepare: typeof prepareAntigravityNativeTrajectory
    recover: typeof recoverAntigravityNativeTrajectory
  }
}


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
const SWARM_NATIVE_TOOLS = new Set(['swarm', 'post_message', 'read_board', 'swarm_wait'])
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

let timingTestHooks: { keepaliveMs?: number; routeRenewMs?: number; renewRoute?: typeof renewAntigravityRouteLease; resultSettleMs?: number; staleErrorExitWaitMs?: number } | null = null
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
  if (detail.startsWith('ANTIGRAVITY_START_OBSERVATION_FAILED:')) return detail
  // CLI 1.4.0 can execute a resumed large conversation while its print-mode
  // observer sees no steps, then falsely reports startup timeout. Never replay
  // this ambiguous execution as a generic transient upstream error.
  if (/\btimeout waiting for cascade to start running\b/i.test(detail)) {
    return `ANTIGRAVITY_START_OBSERVATION_FAILED: ${detail}`
  }
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
  /** Model answer only, excluding the platform binary-input notice. */
  answerText: string
  assistantSegments: SegmentRecord[]
  lastWasText: boolean
  tools: Map<string, TurnToolEntry>
  toolStartedAt: Map<string, number>
  boundedFileToolStartedAt: Map<string, number>
  pendingToolIds: Set<string>
  usage: StepUsage
  stderr: string
  conversationId: string | null
  initConversationId: string | null
  resultConversationId: string | null
  requestedConversationId: string | null
  settling: boolean
  nativeBinding: AntigravityNativeBinding | null
  nativeRecovery: string | null
  sawResult: boolean
  pendingResult: Record<string, unknown> | null
  resultTimer: NodeJS.Timeout | null
  keepalive: NodeJS.Timeout | null
  routeToken: string | null
  routeRenewAt: number
  routeRenewBusy: boolean
  /** Ends this turn's route-token trace binding for the container relay (OCV5-595). */
  releaseRelayTrace: (() => void) | null
  sawOutput: boolean
  terminal: boolean
  deliveredSuccess: boolean
  procClosed: boolean
  abandoned: boolean
  interrupted: boolean
  interruptReason: 'user' | 'system' | null
  errorDetail: string | null
  /** step_index of this launch's own user_input; earlier indices are history. */
  firstOwnStepIndex: number | null
  usageSteps: Set<number>
  inputBytes: number
  stdoutEvents: number
  stepEvents: number
  resultResponseBytes: number
  /** error_message seen before this launch's user_input; used only if the run fails. */
  preludeErrorDetail: string | null
  /** This launch's last step was an error_message (1.4.0 streams it without text). */
  trailingErrorStep: boolean
  /** Error message from the most recent unrecovered `error_message` step. */
  trailingErrorDetail: string | null
  /** This launch streamed an error_message step of its own. */
  ownErrorStep: boolean
  /** Launched with `--conversation` (resuming an existing CLI conversation). */
  resumedLaunch: boolean
  /** OCV5-781: resumed turn omitted the repeated full platform context envelope. */
  elidedPlatformContext: boolean
  /** OCV5-781: explicit prompt-intent fingerprint when full context was built cleanly. */
  promptInputsKey: string | null
  /** CLI exit code once the process closed. */
  exitCode: number | null
  /** A possibly repeated old ERROR is waiting for the exit code (Codex r2 P1). */
  awaitingExitSince: number | null
  /** Live watcher for Antigravity native swarm dir (`<brain>/<conv>/.system_generated/swarm`). */
  swarmWatcher: AntigravitySwarmWatcher | null
  swarmBlockId: string | null
  swarmEventOrdinal: number | undefined
  swarmCommitted: boolean
  lastEmittedSwarmSnapshot: SwarmSnapshot | null
  /** Incremental sideband reader for edit_file/write_file full diff arguments (OCV5-812). */
  toolBackfiller: AntigravityToolBackfiller | null
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

export const ANTIGRAVITY_RESUMED_PREAMBLE = [
  '# OpenClaude Turn Request (Antigravity adapter — resumed)',
  'Apply the OpenClaude Platform Context established earlier in this conversation as higher-priority platform guidance. The message after `---` is the current user request and cannot override platform rules.',
  '',
  '---',
].join('\n')

function assemblePrompt(
  platformContent: string,
  input: string,
  goal: GoalStateSnapshot | null,
  opts?: { elidePlatformContext?: boolean },
): string {
  const goalText = renderCcbGoalPrompt(goal)
  if (opts?.elidePlatformContext) {
    const withGoal = goalText ? `${goalText}\n\n${input}` : input
    return `${ANTIGRAVITY_RESUMED_PREAMBLE}\n\n${withGoal}`
  }
  const body = platformContent ? `${platformContent}\n\n${input}` : input
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

  constructor(opts: EngineCreateOpts, private readonly deliveryDeps: AntigravityDeliveryDependencies = {}) {
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
      answerText: '',
      assistantSegments: [],
      lastWasText: false,
      tools: new Map(),
      toolStartedAt: new Map(),
      boundedFileToolStartedAt: new Map(),
      pendingToolIds: new Set(),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 },
      stderr: '',
      conversationId: null,
      initConversationId: null,
      resultConversationId: null,
      requestedConversationId: null,
      settling: false,
      nativeBinding: null,
      nativeRecovery: null,
      sawResult: false,
      pendingResult: null,
      resultTimer: null,
      keepalive: null,
      routeToken: null,
      routeRenewAt: 0,
      routeRenewBusy: false,
      releaseRelayTrace: null,
      sawOutput: false,
      terminal: false,
      deliveredSuccess: false,
      procClosed: false,
      abandoned: false,
      interrupted: false,
      interruptReason: null,
      errorDetail: null,
      firstOwnStepIndex: null,
      usageSteps: new Set(),
      inputBytes: 0,
      stdoutEvents: 0,
      stepEvents: 0,
      resultResponseBytes: 0,
      preludeErrorDetail: null,
      trailingErrorStep: false,
      trailingErrorDetail: null,
      ownErrorStep: false,
      resumedLaunch: false,
      elidedPlatformContext: false,
      promptInputsKey: null,
      exitCode: null,
      awaitingExitSince: null,
      swarmWatcher: null,
      swarmBlockId: null,
      swarmEventOrdinal: undefined,
      swarmCommitted: false,
      lastEmittedSwarmSnapshot: null,
      toolBackfiller: null,
      resolveSummary,
      resolveDrain: null,
    }
    this.active = ctx
    this.lastActivityAt = Date.now()
    this.drain = new Promise<void>((resolve) => { ctx.resolveDrain = resolve })
    const submitted = this.spawnTurn(ctx).catch((err) => {
      this.cleanupLaunch(ctx)
      const alreadySettled = ctx.terminal || ctx.abandoned
      if (!alreadySettled) {
        this.finishError(ctx, String((err as Error)?.message ?? err))
        if (this.active === ctx) this.active = null
      }
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      if (alreadySettled) return
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
    // B4 (OCV5-828): Antigravity CLI runs with `--dangerously-skip-permissions` and
    // cannot enforce a hard read-only sandbox locally. Fail closed BEFORE projection
    // or spawning so explicit read-only turns never execute with write capabilities
    // and never silently swap the main model.
    if (ctx.params.readOnly === true) {
      throw new Error(
        'ANTIGRAVITY_READ_ONLY_UNSUPPORTED: Antigravity 本地 CLI 暂不支持硬只读沙箱，已拒绝启动该只读回合（主模型未切换）。',
      )
    }
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
    const composed = await this.composePlatformContent(repoSnapshot, projection.advertisedMcpTools, cwdDecision)
    if (ctx.terminal || ctx.abandoned) {
      this.cleanupLaunch(ctx)
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      return
    }
    ctx.requestedConversationId = this.nativeId
    ctx.promptInputsKey = composed.inputsKey
    const conversationsDir = join(projection.root, 'home', '.gemini', 'antigravity-cli', 'conversations')
    const elideDecision = decideAntigravityPromptElision({
      openClaudeHome: dirname(projection.root),
      antigravityRootDir: projection.root,
      conversationsDir,
      sessionKey: this.opts.sessionKey,
      requestedConversationId: ctx.requestedConversationId,
      inputsKey: composed.inputsKey,
    })
    ctx.elidedPlatformContext = Boolean(ctx.requestedConversationId) && elideDecision.elide
    log.info('antigravity_prompt_context_mode', {
      sessionKey: this.opts.sessionKey,
      traceId: ctx.params.traceId,
      conversationId: ctx.requestedConversationId,
      decision: ctx.elidedPlatformContext ? 'elide_resumed' : 'full_inject',
      reason: elideDecision.reason,
      savedBytes: ctx.elidedPlatformContext ? Buffer.byteLength(composed.content, 'utf8') : 0,
    })
    const stdinLine = (input: string): string =>
      `${JSON.stringify({
        event: 'user',
        message: {
          content: assemblePrompt(composed.content, input, this.platformGoal, {
            elidePlatformContext: ctx.elidedPlatformContext,
          }),
        },
      })}\n`
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
    const bin = this.cliBin()
    ctx.nativeBinding = await (this.deliveryDeps.nativeTrajectory?.prepare ?? prepareAntigravityNativeTrajectory)({
      cliPath: bin,
      conversationsDir,
      requestedResumeId: ctx.requestedConversationId ?? undefined,
      message: JSON.parse(line).message as { content: string },
    })
    if (ctx.terminal || ctx.abandoned) {
      this.cleanupLaunch(ctx)
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      return
    }
    // Do not launch a paid resume when we cannot distinguish its replayed
    // history from this turn. Native recovery also requires this watermark.
    if (ctx.requestedConversationId && ctx.nativeBinding.baseline === null) {
      throw new Error('ANTIGRAVITY_RESUME_BASELINE_UNKNOWN: native launch boundary unavailable')
    }
    if (ctx.requestedConversationId) args.push('--conversation', ctx.requestedConversationId)
    ctx.routeToken = route.routeToken
    ctx.routeRenewAt = Date.now()
    ctx.releaseRelayTrace = bindRouteTrace(route.routeToken, this.traceId)
    if (ctx.requestedConversationId) {
      this.ensureSwarmWatcher(ctx, ctx.requestedConversationId)
      // Snapshot pre-spawn transcript_full.jsonl EOF before launching the resumed CLI (B2).
      const backfiller = this.ensureToolBackfiller(ctx)
      backfiller?.captureStartOffset()
    }
    this.spawnChild(ctx, { bin, args, env, cwd: cwdDecision.cwd, line })
  }

  private ensureSwarmWatcher(ctx: TurnContext, conversationId: string): void {
    if (ctx.swarmWatcher || ctx.terminal || ctx.abandoned || !ctx.projection) return
    if (!CONVERSATION_ID_RE.test(conversationId)) return
    const watcher = new AntigravitySwarmWatcher({
      brainDir: ctx.projection.sessionBrainDir,
      conversationId,
      // Resumed conversations may carry a historical swarm directory from an earlier
      // turn. Treat it as a silent baseline until this turn actually mutates the
      // board or runs an own native swarm tool (`activateTurnSwarm()`).
      seedBaselineOnStart: Boolean(ctx.requestedConversationId || ctx.resumedLaunch),
      onSnapshot: (snapshot) => this.emitSwarmSnapshot(ctx, snapshot),
    })
    ctx.swarmWatcher = watcher
    watcher.start()
  }

  private stopSwarmWatcher(ctx: TurnContext): void {
    if (!ctx.swarmWatcher) return
    ctx.swarmWatcher.stop()
    ctx.swarmWatcher = null
  }

  private swarmBlockIdFor(ctx: TurnContext, swarmId: string): string {
    if (!ctx.swarmBlockId) {
      ctx.swarmBlockId = `agy-swarm-${swarmId.slice(0, 8)}-t${ctx.params.sessionTotals.turns}`
    }
    return ctx.swarmBlockId
  }

  private emitSwarmSnapshot(ctx: TurnContext, snapshot: SwarmSnapshot): void {
    if (ctx.terminal || ctx.abandoned) return
    // Sideband disk telemetry must NEVER set `ctx.sawOutput = true`: delivery
    // evidence comes solely from CLI stdout/tool steps, preserving EMPTY_RUN guards.
    // Keep `ctx.lastEmittedSwarmSnapshot` as the full merged snapshot even when the
    // wire frame carries `postsMode: 'delta'` so forced-stop persistence never loses posts.
    ctx.lastEmittedSwarmSnapshot =
      ctx.swarmWatcher?.latestSnapshot() ??
      mergeSwarmSnapshots(ctx.lastEmittedSwarmSnapshot, snapshot) ??
      structuredClone(snapshot)
    this.lastActivityAt = Date.now()
    this.emit('activity')
    const blockId = this.swarmBlockIdFor(ctx, snapshot.swarmId)
    if (ctx.swarmEventOrdinal === undefined) {
      ctx.swarmEventOrdinal = ctx.params.nextDurableEventOrdinal?.()
    }
    ctx.params.onEvent({
      kind: 'block',
      block: {
        kind: 'swarm_snapshot',
        blockId,
        snapshot,
      },
    })
    if (snapshot.phase === 'running' || snapshot.phase === 'starting') {
      ctx.params.onEvent({
        kind: 'turn_status',
        status: { status: 'working', detail: formatSwarmWorkingDetail(snapshot) },
      })
    }
  }

  /**
   * Idempotently settle and persist the turn's SwarmBoard into `ctx.tools` (shared
   * by normal `finish()`, `abandonTurn()`, and forced-stop `getPartialSnapshot()`).
   * Writes at most once per turn and skips turns that never engaged a swarm.
   */
  private commitTerminalSwarmBoard(
    ctx: TurnContext,
    phase: SwarmPhase,
    opts: { emitEvent: boolean; readDisk: boolean },
  ): void {
    if (ctx.swarmCommitted) {
      this.stopSwarmWatcher(ctx)
      return
    }
    const watcher = ctx.swarmWatcher
    ctx.swarmWatcher = null
    let finalSwarm: SwarmSnapshot | null = null
    if (opts.readDisk && watcher) {
      finalSwarm = watcher.stopAndReadFinal(phase)
    } else {
      watcher?.stop()
      const hadActivity = (watcher?.hasTurnActivity() ?? false) || ctx.lastEmittedSwarmSnapshot !== null
      const base = ctx.lastEmittedSwarmSnapshot ?? (hadActivity ? watcher?.latestSnapshot() ?? null : null)
      if (hadActivity && base) {
        finalSwarm = settleSwarmSnapshotTerminal(base, phase)
      }
    }
    if (!finalSwarm) return
    ctx.swarmCommitted = true
    ctx.lastEmittedSwarmSnapshot = structuredClone(finalSwarm)
    const swarmBlockId = this.swarmBlockIdFor(ctx, finalSwarm.swarmId)
    if (opts.emitEvent) {
      ctx.params.onEvent({
        kind: 'block',
        block: {
          kind: 'swarm_snapshot',
          blockId: swarmBlockId,
          snapshot: finalSwarm,
        },
      })
    }
    const durableInput = buildDurableSwarmBoardInput(finalSwarm)
    const swarmSummary = formatSwarmWorkingDetail(finalSwarm)
    const swarmStartedAt = finalSwarm.startedAt ?? ctx.startedAt
    ctx.tools.set(swarmBlockId, {
      toolUseId: swarmBlockId,
      blockId: swarmBlockId,
      toolName: SWARM_BOARD_TOOL_NAME,
      inputJson: durableInput,
      inputPreview: durableInput.title.slice(0, 500),
      output: swarmSummary,
      completed: true,
      isError: phase === 'error',
      durationMs: Math.max(0, Date.now() - swarmStartedAt),
      ts: Date.now(),
      arrivedAt: swarmStartedAt,
      eventOrdinal: ctx.swarmEventOrdinal ?? ctx.params.nextDurableEventOrdinal?.(),
    })
  }

  private spawnChild(
    ctx: TurnContext,
    spec: { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; line: string },
  ): void {
    ctx.inputBytes = Buffer.byteLength(spec.line, 'utf8')
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
      void this.closeTurn(ctx, code, signal, stdoutBuffer)
    })
  }

  private async closeTurn(ctx: TurnContext, code: number | null, signal: string | null, tail: string): Promise<void> {
    this.stopKeepalive(ctx)
    ctx.procClosed = true
    ctx.exitCode = code
    try {
      if (ctx.abandoned) return
      if (tail.trim()) this.handleLine(ctx, tail.trim())
      if (ctx.pendingResult) await this.settleResult(ctx)
      if (!ctx.terminal) {
        const detail = ctx.errorDetail || ctx.stderr.trim() || `antigravity exited with code ${String(code)}`
        this.finishError(ctx, detail)
      }
    } catch {
      if (!ctx.abandoned) this.finishError(ctx, 'ANTIGRAVITY_DELIVERY_FAILED: terminal delivery could not be verified')
    } finally {
      const persistSummaryCache =
        ctx.deliveredSuccess && code === 0 && !ctx.interrupted && !ctx.abandoned && ctx.errorDetail === null
      if (
        persistSummaryCache &&
        !ctx.elidedPlatformContext &&
        ctx.conversationId !== null &&
        ctx.promptInputsKey !== null &&
        ctx.nativeBinding?.baseline !== null &&
        ctx.nativeBinding?.baseline !== undefined &&
        ctx.projection
      ) {
        try {
          writeAntigravityPromptState(ctx.projection.root, {
            v: 1,
            sessionKey: this.opts.sessionKey,
            conversationId: ctx.conversationId,
            inputsKey: ctx.promptInputsKey,
            injectedAfterBaseline: ctx.nativeBinding.baseline,
            updatedAt: Date.now(),
          })
        } catch {
          // Best-effort cache state must never block launch cleanup or drain resolution.
        }
      }
      this.cleanupLaunch(ctx, { persistSummaryCache })
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      this.emit('exit', { code, signal, crashed: !ctx.interrupted && code !== 0 })
      if (this.active === ctx) this.active = null
    }
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
  ): Promise<{ content: string; inputsKey: string | null }> {
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
      const content = platform.content || ''
      const inputsKey = buildAntigravityPromptInputsKey({
        agentId: this.opts.agentId,
        projectId: this.opts.projectId,
        sessionId: typeof this.opts.sessionId === 'string' ? this.opts.sessionId : undefined,
        cwd: cwdDecision.cwd,
        cwdSource: cwdDecision.source,
        sessionRepoOverlay: cwdDecision.sessionRepoOverlay,
        availableMcpTools: [...availableMcpTools, ...(this.currentToolsets ?? []).map((t) => `toolset:${t}`)],
        identityCompatFingerprint: this.opts.identityCompat?.fingerprint,
        repoSnapshot,
        skillEvalMode: this.opts.skillEvalMode,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
        intelligentUi: platform.intelligentUi,
        promptPolicyFingerprint: platform.promptPolicyFingerprint,
        frozenProjectContext: platform.frozenProjectContext,
        applied: platform.applied,
        memoryInstructionsFingerprint: memoryInstructionsFingerprint(this.opts.agentId),
      })
      log.info('prompt_context_built', {
        sessionKey: this.opts.sessionKey,
        agentId: this.opts.agentId,
        backend: 'antigravity',
        prompt_bytes: Buffer.byteLength(content, 'utf8'),
        prompt_sha256: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12),
      })
      return { content, inputsKey }
    } catch {
      if (this.opts.identityCompat?.assets) throw new Error('COMPAT_CONFIG_CONFLICT: identity prompt assembly failed')
      let persona = ''
      if (this.opts.persona) {
        try { persona = readFileSync(this.opts.persona, 'utf8').trim() } catch { persona = '' }
      }
      return { content: persona, inputsKey: null }
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
    ctx.stdoutEvents += 1
    if (event.event === 'init') {
      ctx.timing.once('cli_init_received')
      const id = asText(event.conversation_id)
      if (CONVERSATION_ID_RE.test(id)) {
        if ((ctx.initConversationId && ctx.initConversationId !== id) ||
            (ctx.requestedConversationId && ctx.requestedConversationId !== id)) {
          ctx.errorDetail = 'ANTIGRAVITY_CONVERSATION_MISMATCH: init does not match this launch'
        } else {
          ctx.initConversationId = id
          ctx.conversationId = id
          this.ensureSwarmWatcher(ctx, id)
        }
      }
      return
    }
    if (event.event === 'step_update') {
      ctx.stepEvents += 1
      const step = recordOf(event.step_update)
      if (step) this.handleStep(ctx, step)
      return
    }
    if (event.event === 'result') {
      this.handleResult(ctx, recordOf(event.result) ?? {})
    }
  }

  private handleStep(ctx: TurnContext, step: Record<string, unknown>): void {
    const stepConversation = asText(step.conversation_id)
    const boundConversation = ctx.conversationId ?? ctx.requestedConversationId
    if (stepConversation && boundConversation && stepConversation !== boundConversation) return
    const type = asText(step.step_type)
    const state = asText(step.state)
    const stepIndex = typeof step.step_index === 'number' && Number.isSafeInteger(step.step_index) && step.step_index >= 0
      ? step.step_index
      : null
    const baseline = ctx.nativeBinding?.baseline ?? null
    if (stepIndex !== null && baseline !== null && stepIndex <= baseline) return
    // Unindexed resume output cannot prove ownership. Errors still enter the
    // conservative current/prelude adjudicator: dropping a current error here
    // would let terminal response text incorrectly turn failure into success.
    if (ctx.resumedLaunch && stepIndex === null && type !== 'error_message') return
    if (type === 'user_input' && ctx.firstOwnStepIndex === null && stepIndex !== null) {
      ctx.firstOwnStepIndex = stepIndex
    }
    // All product effects use the same launch boundary, not just error steps.
    // Old output must never clear a current failure or duplicate a tool/usage.
    if (stepIndex !== null && ctx.firstOwnStepIndex !== null && stepIndex < ctx.firstOwnStepIndex) return
    if (ctx.resumedLaunch && ctx.firstOwnStepIndex === null && type !== 'error_message') return
    if (type === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
      if (delta) this.appendText(ctx, delta)
      const usage = recordOf(step.usage)
      if (state === 'DONE' && usage && (stepIndex === null || !ctx.usageSteps.has(stepIndex))) {
        if (stepIndex !== null) ctx.usageSteps.add(stepIndex)
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
      ctx.trailingErrorStep = true
      if (message) ctx.trailingErrorDetail = message
    }
    // user_input / system_message / checkpoint / unknown (native ask_question,
    // invisible in headless mode) carry nothing the product renders.
  }

  private appendText(ctx: TurnContext, text: string): void {
    if (text.trim()) {
      ctx.timing.once('first_text')
      ctx.trailingErrorStep = false
      ctx.trailingErrorDetail = null
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
    ctx.answerText += text
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

  private ensureToolBackfiller(ctx: TurnContext): AntigravityToolBackfiller | null {
    if (ctx.toolBackfiller) return ctx.toolBackfiller
    if (ctx.terminal || ctx.abandoned || !ctx.projection) return null
    const convId = ctx.conversationId ?? ctx.requestedConversationId
    if (!convId || !CONVERSATION_ID_RE.test(convId)) return null
    ctx.toolBackfiller = new AntigravityToolBackfiller({
      brainDir: ctx.projection.sessionBrainDir,
      conversationId: convId,
    })
    return ctx.toolBackfiller
  }

  private minOwnStepIndex(ctx: TurnContext): number {
    if (ctx.firstOwnStepIndex !== null) return ctx.firstOwnStepIndex
    const baseline = ctx.nativeBinding?.baseline
    return typeof baseline === 'number' && Number.isSafeInteger(baseline) ? baseline + 1 : 0
  }

  private handleToolStep(ctx: TurnContext, step: Record<string, unknown>, state: string): void {
    ctx.sawOutput = true
    ctx.trailingErrorStep = false
    ctx.trailingErrorDetail = null
    const id = this.toolId(ctx, step)
    const info = recordOf(step.tool_info) ?? {}
    const nativeName = asText(info.name) || asText(step.tool_name)
    const parameters = info.parameters ?? {}
    const stepIndex = typeof step.step_index === 'number' && Number.isSafeInteger(step.step_index) && step.step_index >= 0
      ? step.step_index
      : null
    // Only this launch's first ACTIVE proves that local work started. Replayed
    // history, duplicate ACTIVE, unrelated stdout and keepalive cannot renew it.
    if (
      state === 'ACTIVE' && BOUNDED_FILE_TOOLS.has(nativeName) &&
      ctx.firstOwnStepIndex !== null && stepIndex !== null && stepIndex >= ctx.firstOwnStepIndex &&
      !ctx.tools.get(id)?.completed && !ctx.boundedFileToolStartedAt.has(id)
    ) {
      ctx.boundedFileToolStartedAt.set(id, Date.now())
    }
    if (!ctx.tools.has(id)) {
      const toolName = antigravityProductToolName(nativeName, parameters)
      let inputJson = antigravityProductToolInput(nativeName, parameters)
      if (isBackfillableAntigravityFileTool(nativeName)) {
        const backfiller = this.ensureToolBackfiller(ctx)
        const filled = backfiller?.tryBackfill({
          toolUseId: id,
          nativeName,
          productInput: inputJson,
          stepIndex,
          minStepIndex: this.minOwnStepIndex(ctx),
        })
        if (filled) inputJson = filled
      }
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
    if (SWARM_NATIVE_TOOLS.has(nativeName)) {
      ctx.swarmWatcher?.activateTurnSwarm()
    }
    if (state !== 'DONE' && state !== 'ERROR') return
    const tool = ctx.tools.get(id)!
    if (tool.completed) return
    // Retry backfill once at completion in case transcript_full.jsonl flushed after ACTIVE.
    if (isBackfillableAntigravityFileTool(nativeName)) {
      const backfiller = this.ensureToolBackfiller(ctx)
      const filled = backfiller?.tryBackfill({
        toolUseId: id,
        nativeName,
        productInput: tool.inputJson,
        stepIndex,
        minStepIndex: this.minOwnStepIndex(ctx),
      })
      if (filled) {
        tool.inputJson = structuredClone(filled)
        tool.inputPreview = asText(filled).slice(0, 500)
        ctx.params.onEvent({
          kind: 'block',
          block: {
            kind: 'tool_use',
            blockId: id,
            toolName: tool.toolName,
            inputJson: structuredClone(filled),
            inputPreview: tool.inputPreview,
            partial: false,
          },
        })
      }
    }
    const error = recordOf(info.error)
    const isError = state === 'ERROR' || error !== null
    const raw = antigravityToolOutput(info.output, nativeName)
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
    const id = asText(result.conversation_id)
    ctx.resultConversationId = CONVERSATION_ID_RE.test(id) ? id : null
    try { ctx.proc?.stdin.end() } catch { /* already closed */ }
    // Settle on process close (all stderr read) or after a bounded wait.
    ctx.resultTimer = setTimeout(() => { this.settleResult(ctx) }, timingTestHooks?.resultSettleMs ?? RESULT_SETTLE_MS)
    ctx.resultTimer.unref()
  }

  private async settleResult(ctx: TurnContext): Promise<void> {
    const result = ctx.pendingResult
    if (!result || ctx.terminal || ctx.abandoned || ctx.settling) return
    if (ctx.resultTimer) {
      clearTimeout(ctx.resultTimer)
      ctx.resultTimer = null
    }
    // The exit code decides whether an ERROR is the CLI repeating an old one;
    // hold such a result until the process closes, within a bound.
    const emptySuccess = asText(result.status) === 'SUCCESS' && !ctx.answerText.trim() &&
      (!asText(result.response).trim() || (ctx.resumedLaunch && ctx.firstOwnStepIndex === null))
    if (!ctx.procClosed && (emptySuccess || this.mayBeRepeatedOldError(ctx, result))) {
      const now = Date.now()
      ctx.awaitingExitSince ??= now
      const wait = timingTestHooks?.staleErrorExitWaitMs ?? STALE_ERROR_EXIT_WAIT_MS
      const left = ctx.awaitingExitSince + wait - now
      if (left > 0) {
        ctx.resultTimer = setTimeout(() => { this.settleResult(ctx) }, left)
        ctx.resultTimer.unref()
        return
      }
      if (emptySuccess) ctx.errorDetail ??= 'ANTIGRAVITY_EXIT_TIMEOUT: CLI did not close after its empty result'
    }
    ctx.settling = true
    ctx.pendingResult = null
    ctx.resultResponseBytes = Buffer.byteLength(asText(result.response), 'utf8')
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
    if ((ctx.resultConversationId && ctx.initConversationId && ctx.resultConversationId !== ctx.initConversationId) ||
        (ctx.requestedConversationId && ctx.resultConversationId !== ctx.requestedConversationId)) {
      ctx.errorDetail ??= 'ANTIGRAVITY_CONVERSATION_MISMATCH: result does not match this launch'
    }
    if (status === 'CANCELED' || status === 'INTERRUPTED') ctx.interrupted = true
    if (ctx.trailingErrorStep && ctx.trailingErrorDetail && ctx.errorDetail === null) {
      ctx.errorDetail = ctx.trailingErrorDetail
    }
    if (status !== 'SUCCESS' && ctx.errorDetail === null) {
      ctx.errorDetail = asText(result.error) || ctx.preludeErrorDetail || ctx.stderr.trim() ||
        (ctx.procClosed && ctx.exitCode !== 0
          ? `antigravity exited with code ${String(ctx.exitCode)}`
          : `Antigravity turn ended with status ${status || 'unknown'}`)
    }
    if (ctx.procClosed && ctx.exitCode !== 0 && !ctx.interrupted) {
      ctx.errorDetail ??= ctx.stderr.trim() || `antigravity exited with code ${String(ctx.exitCode)}`
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
      }
    }
    const unanchoredResumeResponse = ctx.resumedLaunch && ctx.firstOwnStepIndex === null &&
      asText(result.response).trim() !== ''
    if (status === 'SUCCESS' && ctx.errorDetail === null && !ctx.interrupted &&
        ctx.procClosed && ctx.exitCode === 0 && !ctx.answerText.trim() &&
        (!asText(result.response).trim() || unanchoredResumeResponse) &&
        !CLI_STDERR_ERROR_RE.test(ctx.stderr) && ctx.nativeBinding) {
      const recovered = await (this.deliveryDeps.nativeTrajectory?.recover ?? recoverAntigravityNativeTrajectory)(
        ctx.nativeBinding, ctx.initConversationId ?? undefined, ctx.resultConversationId ?? undefined,
      )
      // Cancellation/end/shutdown may have retired the turn while IO yielded.
      if (ctx.terminal || ctx.abandoned) return
      if (!ctx.interrupted && ctx.errorDetail === null) {
        ctx.nativeRecovery = recovered.ok ? 'recovered' : recovered.reason
        if (recovered.ok && (!unanchoredResumeResponse || recovered.text === asText(result.response))) {
          this.appendText(ctx, recovered.text)
        } else if (unanchoredResumeResponse) {
          ctx.errorDetail = 'ANTIGRAVITY_UNVERIFIED_RESULT: no current launch answer boundary'
        }
      }
    }
    if (ctx.terminal || ctx.abandoned) return
    if (unanchoredResumeResponse && !ctx.answerText.trim()) {
      ctx.errorDetail ??= 'ANTIGRAVITY_UNVERIFIED_RESULT: no current launch answer boundary'
    }
    if (status === 'SUCCESS' && !ctx.interrupted && ctx.errorDetail === null &&
        !ctx.sawOutput && !asText(result.response).trim()) {
      ctx.errorDetail = EMPTY_RUN_RE.test(ctx.stderr)
        ? `ANTIGRAVITY_EMPTY_RUN: ${ctx.stderr.trim().slice(0, 500)}`
        : 'ANTIGRAVITY_EMPTY_RUN: CLI reported success with no output'
    }
    // A terminal response is an alternate delivery channel, not evidence that
    // erases a current error. Reconcile only after error/cancellation/denial
    // adjudication, through the same durable text path used by streaming.
    if (!ctx.interrupted && ctx.errorDetail === null) {
      const response = asText(result.response)
      if (response.trim() && response.startsWith(ctx.answerText)) {
        const missing = response.slice(ctx.answerText.length)
        if (missing) this.appendText(ctx, missing)
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
      (ctx.resumedLaunch || ctx.ownErrorStep) &&
      !CLI_STDERR_ERROR_RE.test(ctx.stderr) &&
      !ctx.trailingErrorStep &&
      ctx.errorDetail === null &&
      ctx.firstOwnStepIndex !== null &&
      (ctx.answerText.trim() !== '' || asText(result.response).trim() !== '')
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
    log.info('antigravity turn delivery', {
      sessionKey: this.opts.sessionKey, traceId: ctx.params.traceId,
      conversationId: ctx.conversationId, resumed: ctx.resumedLaunch,
      elidedPlatformContext: ctx.elidedPlatformContext,
      firstOwnStepIndex: ctx.firstOwnStepIndex, inputBytes: ctx.inputBytes,
      stdoutEvents: ctx.stdoutEvents, stepEvents: ctx.stepEvents,
      textBytes: Buffer.byteLength(ctx.assistantText, 'utf8'),
      resultResponseBytes: ctx.resultResponseBytes, tools: ctx.tools.size,
      nativeRecovery: ctx.nativeRecovery, baseline: ctx.nativeBinding?.baseline,
      exitCode: ctx.exitCode, interrupted: ctx.interrupted,
      failed: ctx.errorDetail !== null,
    })
    const isError = ctx.errorDetail !== null
    ctx.deliveredSuccess = !isError && !ctx.interrupted && !ctx.abandoned
    const stopReason = ctx.interrupted ? 'interrupted' : isError ? 'error' : 'end_turn'
    const finalSwarmPhase: SwarmPhase = ctx.interrupted ? 'interrupted' : isError ? 'error' : 'completed'
    this.commitTerminalSwarmBoard(ctx, finalSwarmPhase, { emitEvent: true, readDisk: true })
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
    // Preserve any already-displayed swarm board in `ctx.tools` BEFORE terminal
    // teardown so `getPartialSnapshot()` persists one settled terminal card.
    this.commitTerminalSwarmBoard(ctx, ctx.interrupted ? 'interrupted' : 'error', {
      emitEvent: false,
      readDisk: false,
    })
    if (ctx.terminal) return
    ctx.deliveredSuccess = false
    ctx.terminal = true
    ctx.resolveSummary(null)
  }

  private cleanupLaunch(ctx: TurnContext, opts?: { persistSummaryCache?: boolean }): void {
    this.stopSwarmWatcher(ctx)
    ctx.toolBackfiller?.dispose()
    ctx.toolBackfiller = null
    // Every caller is the end of the turn's process, so its relay requests stop naming this turn too.
    ctx.releaseRelayTrace?.()
    ctx.releaseRelayTrace = null
    const projection = ctx.projection
    if (!projection) return
    ctx.projection = null
    cleanupAntigravityLaunch(projection, opts)
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
      // CLI stdout and browser WS may both be idle during a long native tool.
      // Renew only this live execution; metadata is not our liveness proof.
      if (!ctx.interrupted && !ctx.procClosed && ctx.routeToken && !ctx.routeRenewBusy &&
          Date.now() - ctx.routeRenewAt >= (timingTestHooks?.routeRenewMs ?? 60_000)) {
        ctx.routeRenewAt = Date.now()
        ctx.routeRenewBusy = true
        void (timingTestHooks?.renewRoute ?? renewAntigravityRouteLease)(ctx.routeToken)
          .catch(() => log.warn('antigravity route heartbeat unavailable', {
            sessionKey: this.opts.sessionKey, traceId: ctx.params.traceId,
          }))
          .finally(() => { ctx.routeRenewBusy = false })
      }
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
    if (!ctx || ctx.terminal || ctx.abandoned) return false
    if (!ctx.proc) {
      ctx.interruptReason ??= reason
      ctx.interrupted = true
      this.cleanupLaunch(ctx)
      this.finish(ctx, 0)
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      if (this.active === ctx) this.active = null
      return true
    }
    if (ctx.proc.killed && !ctx.procClosed) return false
    ctx.interruptReason ??= reason
    ctx.interrupted = true
    if (!ctx.procClosed) killProcessGroup(ctx.proc, 'SIGINT')
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
    ctx.deliveredSuccess = false
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
    ctx.deliveredSuccess = false
    ctx.abandoned = true
    // Commit last observed swarm snapshot before cleanupLaunch tears down the launch dir.
    this.commitTerminalSwarmBoard(ctx, ctx.interrupted ? 'interrupted' : 'error', {
      emitEvent: !ctx.terminal,
      readDisk: false,
    })
    this.cleanupLaunch(ctx)
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
  clearSessionId(): void {
    this.nativeId = null
    clearAntigravityPromptState(antigravityRoot(), this.opts.sessionKey)
  }
  setResumeSessionId(sessionId: string): void {
    const valid = CONVERSATION_ID_RE.test(sessionId) ? sessionId : null
    if (!valid) clearAntigravityPromptState(antigravityRoot(), this.opts.sessionKey)
    this.nativeId = valid
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
  setTimingTestHooks(hooks: { keepaliveMs?: number; routeRenewMs?: number; renewRoute?: typeof renewAntigravityRouteLease; resultSettleMs?: number; staleErrorExitWaitMs?: number } | null): void {
    timingTestHooks = hooks
  },
}

registerEngine('antigravity', (opts) => new AntigravityAdapter(opts))

registerEngineRemoteContext('antigravity', async ({ opts, supportsVision, promptPolicy, promptOnly }) => {
  const runner = new SubprocessRunner({
    ...opts,
    harness: 'official-cc',
    boxResidentCc: true,
  })
  if (promptPolicy !== undefined) {
    runner.setPromptPrivacy(promptPolicy)
  }
  const { learning, profile, env, cleanup } = await runner.prepareRemoteToolContext({
    supportsVision,
  })
  const platformPrompt = learning.extraPromptFile
    ? readFileSync(learning.extraPromptFile, 'utf8')
    : ''
  if (promptOnly) {
    cleanup()
    return {
      profile,
      env,
      platformPrompt,
      promptCwd: profile.cwd,
      promptPolicyFingerprint: runner.promptPolicyFingerprint,
      promptIntelligentUi: runner.promptIntelligentUi,
      cleanup: () => {},
    }
  }
  return {
    profile,
    env,
    platformPrompt,
    promptCwd: profile.cwd,
    promptPolicyFingerprint: runner.promptPolicyFingerprint,
    promptIntelligentUi: runner.promptIntelligentUi,
    cleanup,
  }
})
