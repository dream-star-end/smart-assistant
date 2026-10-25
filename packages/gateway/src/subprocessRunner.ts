import { PassiveStageTiming } from './passiveStageTiming.js'
import { fastServiceTierRoute } from '@openclaude/protocol'
import {
  identityCompatEnvironment,
  isProjectSearchEnabled,
} from '@openclaude/storage'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { type OpenClaudeConfig } from '@openclaude/storage'
import { createLogger } from './logger.js'
import { boxCcBridgePath, stripBoxCcParentAuth } from './engine/cursorBoxCc.js'
import { ccbStdinUserContent } from './ccbNativeCompaction.js'
import { atomicWriteJsonFile, buildCcbEfficiencySettings } from './efficiencyHookConfig.js'
import { isV3ContainerRuntime } from './hostStaticProviders.js'
import type { GoalStateSnapshot, ServiceTier } from '@openclaude/protocol'
import { renderCcbGoalPrompt } from './goalPrompt.js'
import { modelHintAppliedTotal } from './metrics.js'
import {
  killProcessGroup as killRunnerProcessGroup,
  shutdownTimeoutMs as runnerShutdownTimeoutMs,
  waitForCloseWithin,
} from './processGroupShutdown.js'
import { decideEngineCwd, resolveDesktopWorkspaceDir } from './engineCwd.js'
import { relocateCcbJsonlToCwd } from './engine/ccbTranscriptRelocate.js'
import { persistRunContextSnapshot } from './runContextPersist.js'
import { projectCcbMcpAvailability } from './ccbMcpAvailability.js'
import { buildPromptContext, type IntelligentUiApplied } from './promptSlots.js'
import { resolveMcpMemoryLaunch } from './mcpMemoryEntry.js'
import type { ExecutionTarget } from './remoteTarget.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { type SpawnOpts, type TerminalBackend, createBackend } from './terminalBackend.js'
import { issueConsultTurnToken, issueDelegateContextToken } from './delegateContext.js'
import {
  CCB_ADVISOR_HERMETIC_ENV,
} from './advisorMode.js'
import {
  _officialCcProxyLane,
  buildRemoteTargetEnv,
  _buildCcbServiceTierEnv,
  _buildCcbSpawnTraceEnv,
  _buildCcbUsageAttributionEnv,
  finalizeCcbSpawnEnv,
  MODEL_EXECUTION_DESCRIPTOR_ENV,
  BOX_NATIVE_CONTEXT_OWNER,
  type CcbExecutionDescriptor,
  shouldRecycleForVisionCapability,
  type TurnModelAuthority,
  type TurnUpstreamHeaders,
  _buildAnthropicCustomHeadersEnv,
  _ccbUpstreamIsEgress,
  _buildUpdateEnvStdinLine,
  renewTurnHeaderBundle,
  resolveTurnRuntime,
  assertCcbAdvisorCatalogLock,
  type HostSpawnProviderEnv,
  buildHostSpawnProviderEnv,
  type SubprocessRunnerOpts,
  type SdkMessage,
  type PermissionResponse,
  isOfficialClaudeCursorSandLoopbackEnv,
  usesStaticFirstPromptLayout,
  resolveCcbHarness,
  BoxNativeHarnessError,
  applyBoxNativeHarness,
  assertOfficialCcSpawnPreconditions,
  buildOfficialCcProxySpawnEnv,
  officialCcProxySpawnFingerprint,
  resolveClaudeCodeLaunch,
  buildCcbCliArgs,
  buildOfficialClaudeCliArgs,
  MAX_STDERR_BUF_BYTES,
  appendCrashStderrTail,
  redactCrashStderrTail,
} from './subprocessSpawnConfig.js'
export {
  _officialCcProxyLane,
  _buildCcbServiceTierEnv,
  _buildCcbSpawnTraceEnv,
  _buildCcbUsageAttributionEnv,
  DEFAULT_SECONDARY_UTILITY_MODEL,
  DEFAULT_CCB_SUBAGENT_MODEL,
  isCcbRoutableSubagentModel,
  resolveCcbSubagentModel,
  resolveSecondaryUtilityModel,
  _buildSecondaryUtilityModelEnv,
  CCB_SUBAGENT_MODEL_ENV,
  _buildCcbSubagentModelEnv,
  buildCcbSpawnProcessEnv,
  finalizeCcbSpawnEnv,
  MODEL_EXECUTION_DESCRIPTOR_ENV,
  BOX_NATIVE_CONTEXT_OWNER,
  BOX_NATIVE_CONTEXT_MODEL,
  shouldRecycleForVisionCapability,
  AuthorityHeaderRejected,
  _buildAnthropicCustomHeadersEnv,
  _buildUpdateEnvStdinLine,
  AdvisorExecutionLockError,
  assertCcbAdvisorCatalogLock,
  buildHostSpawnProviderEnv,
  CCB_PLATFORM_DISALLOWED_TOOLS,
  OFFICIAL_CC_PLATFORM_DISALLOWED_TOOLS,
  isOfficialClaudeCursorSandLoopbackEnv,
  ccbOfficialCcEnabled,
  usesStaticFirstPromptLayout,
  resolveCcbHarness,
  BoxNativeHarnessError,
  projectCcbExecutionDescriptor,
  applyBoxNativeHarness,
  assertOfficialCcSpawnPreconditions,
  buildOfficialCcProxySpawnEnv,
  officialCcProxySpawnFingerprint,
  resolveClaudeCodeLaunch,
  buildCcbCliArgs,
  buildOfficialClaudeCliArgs,
  appendCrashStderrTail,
  redactCrashStderrTail,
} from './subprocessSpawnConfig.js'
export type {
  UsageAttributionTag,
  CcbExecutionDescriptor,
  TurnModelAuthority,
  TurnUpstreamHeaders,
  HostSpawnProviderEnvInput,
  HostSpawnProviderEnv,
  SubprocessRunnerOpts,
  SdkMessage,
  PermissionResponse,
  CcbCliArgsInput,
  OfficialClaudeCliArgsInput,
} from './subprocessSpawnConfig.js'

/**
 * OCV5-556: CCB deletes transcripts older than `cleanupPeriodDays` (default
 * 30) from the persisted projects volume, so a conversation resumed after a
 * month failed with STALE_RESUME_ID. Keep them longer than the resume-map TTL
 * (RESUME_MAP_INACTIVE_TTL_MS, 90 days).
 */
export const CCB_TRANSCRIPT_RETENTION_DAYS = 120

/** Per-session `--settings` for CCB: transcript retention plus the efficiency hooks, if any. */
export function buildCcbSessionSettings(efficiency: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(efficiency ?? {}), cleanupPeriodDays: CCB_TRANSCRIPT_RETENTION_DAYS }
}

export { renderCcbGoalPrompt }

const runnerLog = createLogger({ module: 'subprocessRunner' })

export type CcbSpawnForTests = (opts: SpawnOpts) => ChildProcessWithoutNullStreams
let ccbSpawnForTests: CcbSpawnForTests | null = null
export function __setCcbSpawnForTests(fn: CcbSpawnForTests | null): void {
  ccbSpawnForTests = fn
}

export function isCcbAdvisorHermeticProfile(opts: {
  hermeticNoTools?: boolean
  agentId?: string
}): boolean {
  return Boolean(opts.hermeticNoTools && opts.agentId === 'advisor')
}

const guardedStdin = new WeakSet<object>()
function guardStdinErrors(stdin: { on?: (event: 'error', fn: (err: Error) => void) => unknown } | null | undefined): void {
  if (!stdin || typeof stdin.on !== 'function') return
  if (guardedStdin.has(stdin)) return
  guardedStdin.add(stdin)
  stdin.on('error', () => {
    /* swallow async EPIPE so a settled write cannot become uncaughtException */
  })
}

const RUNNER_SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const RUNNER_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000

type RunnerExitInfo = {
  code: number | null
  signal: NodeJS.Signals | null
  crashed: boolean
}

/** Exact official Claude Code 2.1.x cooperative-Stop terminal shape. Keep the
 * predicate narrow: only this frame may turn its following exit(1) into an
 * expected recycle. */
export function _isOfficialClaudeAbortResult(msg: SdkMessage): boolean {
  const result = msg as SdkMessage & {
    terminal_reason?: string
    stop_reason?: string | null
  }
  return result.type === 'result'
    && result.is_error === true
    && result.subtype === 'error_during_execution'
    && result.terminal_reason === 'aborted_streaming'
    && (result.stop_reason === null || result.stop_reason === undefined)
}

/** Compact caller chain for `shutdown()` diagnostics: strip the Error header
 * and this module's own frames, keep the next few `at …` lines as
 * `fn (file:line)` tokens. Pure; exported for tests. */
export function _shutdownOriginFrames(stack: string | undefined, max = 6): string[] {
  if (!stack) return []
  const out: string[] = []
  for (const raw of stack.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line.startsWith('at ')) continue
    if (/subprocessRunner\.[cm]?[jt]s/.test(line)) continue
    const m = /^at (?:async )?(.*?) \(?(?:file:\/\/)?([^()]*?):(\d+):\d+\)?$/.exec(line)
    const token = m
      ? `${m[1] || '<anonymous>'} (${m[2].split('/').slice(-2).join('/')}:${m[3]})`
      : line.slice(3)
    out.push(token)
    if (out.length >= max) break
  }
  return out
}

export function _isExpectedOfficialClaudeAbortExit(args: {
  harness: 'ccb' | 'official-cc'
  code: number | null
  signal: NodeJS.Signals | null
  abortResultObserved: boolean
}): boolean {
  return args.harness === 'official-cc'
    && args.code === 1
    && args.signal == null
    && args.abortResultObserved
}

/** Box-resident official Claude is one-shot print mode: a finished answer
 * exits 0. That must not feed the crash-loop gate. The session layer still
 * sees the exit so a turn with no result can finalize. */
export function _boxCcOneShotExitSkipsCrashLoop(args: {
  boxResidentCc: boolean
  code: number | null
  signal: NodeJS.Signals | null
}): boolean {
  return args.boxResidentCc && args.code === 0 && args.signal == null
}

export class SubprocessRunner extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  /** 本 turn 解析后的 descriptor；首次 spawn 也必须看到，不能等 stdin 才补。 */
  private currentExecutionDescriptorEnv = ''
  private currentExecutionDescriptor: CcbExecutionDescriptor | undefined
  /** Header bundle last written for the current turn. Cleared on shutdown. */
  private currentTurnHeaders: TurnUpstreamHeaders | undefined
  /** OCV5-570: the running CCB's ANTHROPIC_BASE_URL is the gateway's egress (set at spawn). */
  private spawnedUpstreamIsEgress = false
  private spawnedExecutionDescriptor: CcbExecutionDescriptor | undefined
  private spawnGeneration = 0
  private processTiming: PassiveStageTiming | undefined
  private stdoutBuf = ''
  /** Running byte count for stderr within a single "line" window — caps runaway stderr. */
  private stderrBufBytes = 0
  /** Whole-line raw stderr tail of this generation, for the crash log only. */
  private stderrTail = ''
  private currentSessionId: string | null = null
  /**
   * Count of `_oc_telemetry` lines silently dropped because their `session_id`
   * field was missing or empty. Design rule: telemetry session_id is runtime
   * expected but implementation tolerates absence (drop + count, don't error).
   * See docs/ccb-telemetry-refactor-plan.md §3.1 + §5.1.
   */
  private missingSessionIdCount = 0
  private starting = false
  private closed = false
  private shuttingDown = false
  /** Current process generation's stdout-close barrier. A bounded shutdown
   * may return while an escaped descendant still owns the pipe; persistence
   * awaits this promise so those late paid bytes remain part of the turn. */
  private outputDrainPromise: Promise<void> = Promise.resolve()
  private resolveOutputDrain: (() => void) | null = null
  // ── Crash-loop supervision (exponential backoff) ──
  // Every time the subprocess exits unexpectedly (or start() throws before a
  // successful spawn) we increment _consecutiveCrashes and push _backoffUntil
  // forward. Subsequent start() calls refuse until the backoff window expires,
  // protecting the host from runaway fork/spawn storms when a config is broken
  // or CCB immediately segfaults. The counter resets to 0 when the process
  // either shuts down cleanly OR stayed up long enough to be considered stable
  // (STABLE_UPTIME_MS), so isolated crashes after a long run don't immediately
  // trigger seconds-long backoffs.
  private _consecutiveCrashes = 0
  private _backoffUntil = 0
  private _lastStartAt = 0
  private static BACKOFF_BASE_MS = 500
  private static BACKOFF_MAX_MS = 30_000
  private static STABLE_UPTIME_MS = 5 * 60_000
  /** True once we force-killed due to stderr overflow; prevents double-kill. */
  private overflowKilled = false
  private sessionDir: string | null = null
  private advisorHomeDir: string | null = null
  private advisorConfigDir: string | null = null
  /** Stable path inherited by MCP + Bash; contents are re-minted every turn. */
  private delegateContextFile: string | null = null
  private platformGoal: GoalStateSnapshot | null = null
  /** Intelligent UI(OCV5-361):本次 spawn 的 extra-prompt 里 INTELLIGENT_UI 段的指纹(没有 = false)。
   *  undefined = 还没组装过 / 组装失败;sessionManager 用它判断开关切换后是否需要重启。 */
  private _promptIntelligentUi: IntelligentUiApplied | undefined = undefined
  /** Exact stock-CLI abort result observed for the current process. Official
   * Claude Code exits 1 after emitting it; that is an expected recycle, not a
   * process crash. Reset on every spawn. */
  private boxCcControlPath: string | null = null
  private officialAbortResultObserved = false
  /** engine=ccb official-cc: headers applied at next spawn (stock CLI cannot
   * hot-update env). Cursor Sand official-cc leaves this unset. */
  private pendingOfficialSpawnEnv: Record<string, string> | null = null
  private spawnedOfficialHeaderFingerprint: string | undefined
  /** Timestamp of last stdout activity — used for liveness detection */
  public lastActivityAt: number = Date.now()

  /** Explicit ccb harness for a not-yet-spawned runner that carries the signed token. */
  pinBoxNativeHarness(descriptor: CcbExecutionDescriptor | undefined): 'ccb' | 'official-cc' {
    const next = applyBoxNativeHarness({
      model: this.opts.model,
      descriptor,
      harness: this.opts.harness,
      spawned: this.proc !== null,
    })
    if (descriptor?.contextOwner === BOX_NATIVE_CONTEXT_OWNER) {
      if (next !== 'ccb') throw new BoxNativeHarnessError('BOX_NATIVE_CONTEXT_MISMATCH')
      this.opts.harness = 'ccb'
    }
    return resolveCcbHarness(this.opts.harness)
  }

  constructor(private opts: SubprocessRunnerOpts) {
    super()
    this.currentSessionId = opts.resumeSessionId ?? null
  }

  get sessionId(): string | null {
    return this.currentSessionId
  }

  /** Forget the cached CCB session id. Next start() will NOT pass --resume,
   *  forcing CCB to allocate a fresh session. Used by sessionManager when a
   *  previous run failed with "No conversation found with session ID: ..." —
   *  without this, the runner keeps re-requesting the same dead id every
   *  restart and perpetually crashes. */
  clearSessionId(): void {
    this.currentSessionId = null
  }

  /** Steer the next spawn's `--resume` at a known-durable prior id. */
  setResumeSessionId(sessionId: string): void {
    this.currentSessionId = sessionId
  }

  /** Update config (e.g. after OAuth token refresh). Takes effect on next start(). */
  updateConfig(config: OpenClaudeConfig): void {
    this.opts.config = config
  }

  /** Current effort level (used by sessionManager.getOrCreate to detect changes
   *  before deciding whether to recycle the subprocess). */
  get effortLevel(): string | undefined {
    return this.opts.effortLevel
  }

  get promptIntelligentUi(): IntelligentUiApplied | undefined {
    return this._promptIntelligentUi
  }

  /** Update effort level. Caller is responsible for restarting the subprocess
   *  (via shutdown(); next submit() auto-restarts) for the new value to take
   *  effect — env vars are only read at process startup. */
  setEffortLevel(level: string | undefined): void {
    this.opts.effortLevel = level
  }

  /** OCV5-434 GPT Fast for OpenCode Go /responses models: carried as
   *  CLAUDE_CODE_EXTRA_BODY={"service_tier":"priority"} (read once at spawn, like effort).
   *  Any other model keeps standard. */
  private _serviceTier: ServiceTier | null = null
  get serviceTier(): ServiceTier | null {
    return this._serviceTier
  }

  /** Returns 'restart' when a running subprocess must be recycled for the new value to apply
   *  (the caller folds it into its single shutdown, like setEffortLevel). `model` is the
   *  turn's effective canonical model. */
  setServiceTier(tier: ServiceTier | null, model: string | undefined): 'restart' | 'applied' | 'unchanged' {
    const next: ServiceTier | null =
      tier === 'fast' && fastServiceTierRoute(model) === 'opencode-responses' ? 'fast' : null
    if (next === this._serviceTier) return 'unchanged'
    this._serviceTier = next
    return this.isRunning ? 'restart' : 'applied'
  }

  /** Current model id (used by sessionManager.submit to detect changes
   *  before deciding whether to recycle the subprocess). 2026-04-26 v1.0.4
   *  起新增,配合 InboundMessage.model 让用户在前端 pill 切模型生效。 */
  get model(): string | undefined {
    return this.opts.model
  }

  /** Update model. Caller is responsible for restarting the subprocess
   *  (via shutdown(); next submit() auto-restarts) for the new value to take
   *  effect — model is only passed as `--model` cli arg at spawn time. */
  setModel(model: string | undefined): void {
    this.opts.model = model
  }

  /** Current resolved toolsets. Toolsets are consumed only when writing the
   *  MCP config before subprocess spawn, so callers must restart the runner
   *  after changing this value. */
  get toolsets(): string[] | undefined {
    return this.opts.agentToolsets
  }

  /** Update resolved toolsets for the next spawn. Pure opts mutator, parallel
   *  to setModel / setEffortLevel; no subprocess side effects. */
  setToolsets(toolsets: string[] | undefined): void {
    this.opts.agentToolsets = toolsets
  }

  /** Current execution target (used by sessionManager to detect changes). */
  get executionTarget(): ExecutionTarget {
    return this.opts.executionTarget ?? { kind: 'local' }
  }

  /** Update execution target. Caller must restart the subprocess (shutdown()
   *  + next submit() auto-restarts) for OC_REMOTE_* env to be re-read. */
  setExecutionTarget(target: ExecutionTarget): void {
    this.opts.executionTarget = target
  }

  /** V3 S12e CG8 — current trace id stash(opts-only, no in-flight effect).
   *  See SubprocessRunnerOpts.traceId JSDoc for lifecycle. */
  get traceId(): string | undefined {
    return this.opts.traceId
  }

  /** V3 S12e CG8 — update trace id stash. Caller is responsible for the
   *  restart-on-effort/model-change path; on its own this is a pure mutator
   *  with NO subprocess side effects(parallel to setEffortLevel / setModel).
   *  The new value will land in `OPENCLAUDE_TRACE_ID` env at the *next* spawn
   *  (or re-spawn triggered elsewhere in this submit's lock). */
  setTraceId(traceId: string | undefined): void {
    this.opts.traceId = traceId
  }

  /** Platform-owned session goal. CCB consumes it only through the existing
   * merged extra-prompt file on the next process spawn. */
  setGoalState(goal: GoalStateSnapshot | null): boolean {
    const next = goal ? structuredClone(goal) : null
    if (JSON.stringify(this.platformGoal) === JSON.stringify(next)) return false
    this.platformGoal = next
    return true
  }

  /** Phase 5:本进程启动时是否绑定到 ready repo workspace。
   *  null = 未 ready-bound(未绑 / cloning / failed / 还没 start);
   *  非 null = 本 runner 当前活跃进程在 spawn 时拿到的 ready snapshot,
   *  recycle 决策(sessionManager.recyclePeerForRepoChange)用此字段比版本。 */
  private _boundRepoBinding: { selectionVersion: number; workspaceDir: string } | null = null

  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this._boundRepoBinding
  }

  /** True if the subprocess is currently alive or being started */
  get isRunning(): boolean {
    return (this.proc !== null && !this.closed) || this.starting
  }

  /** Shared in-flight spawn so concurrent callers (session preheat + submit)
   * await the SAME start instead of the second caller returning early while
   * `starting` is still true and then throwing on `!this.proc`. */
  private _startPromise: Promise<void> | null = null
  /** Bumped by shutdown() so a late _startInternal cannot publish a proc after abort. */
  private _startEpoch = 0

  async start(): Promise<void> {
    if (this.proc) return
    const inflight = this._startPromise
    if (inflight) return inflight
    const started = this._startInternal()
    this._startPromise = started
    try {
      await started
    } finally {
      if (this._startPromise === started) this._startPromise = null
    }
  }

  private async _startInternal(): Promise<void> {
    const epoch = this._startEpoch
    if (this.proc || this.starting) return
    // ── Crash-loop gate ──
    // If the previous crash(es) pushed _backoffUntil into the future, refuse to
    // spawn until the window passes. This prevents fork storms when CCB is
    // wedged on a broken config / immediate segfault. The window only exists
    // after _recordCrash() has set it, so normal startup is unaffected.
    const gateNow = Date.now()
    if (gateNow < this._backoffUntil) {
      const waitSeconds = Math.ceil((this._backoffUntil - gateNow) / 1000)
      throw new Error(
        `CCB subprocess is crash-looping; please wait ${waitSeconds}s before retrying (${this._consecutiveCrashes} consecutive crashes)`,
      )
    }

    const timing = new PassiveStageTiming({ engine: 'ccb', traceId: this.opts.traceId,
      sessionKey: this.opts.sessionKey, model: this.opts.model, generation: ++this.spawnGeneration },
      (fields) => runnerLog.info('engine_process_timing', { ...fields }))
    timing.once('prepare_started')
    this.starting = true
    this.closed = false
    this.officialAbortResultObserved = false
    this.overflowKilled = false
    this.stdoutBuf = ''
    this.stderrBufBytes = 0
    this.stderrTail = ''

    // Wrap the entire setup in try/catch so ANY pre-spawn failure (config
    // resolution, buildLearningContext, backend.spawn, …) records a crash and
    // triggers backoff. Without this, a start() that throws before `this.proc`
    // is assigned would never bump _consecutiveCrashes, and the caller could
    // retry immediately and re-throw, burning CPU.
    try {
    if (this.opts.boxResidentCc && !this.boxCcControlPath) {
      if (!this.opts.prepareBoxCc) {
        this.starting = false
        throw new Error('BOX_CC_CONTROL_REQUIRED')
      }
      this.boxCcControlPath = await this.opts.prepareBoxCc()
    }
    const { config } = this.opts
    const harness = resolveCcbHarness(this.opts.harness)
    let binaryDir: string
    let command: string
    let ccbEntry: string | undefined
    let ccbRuntime: string | undefined
    if (this.opts.boxResidentCc) {
      const bridge = boxCcBridgePath()
      if (!existsSync(bridge)) {
        this.starting = false
        throw new Error('BOX_CC_BRIDGE_MISSING')
      }
      command = process.execPath
      binaryDir = dirname(bridge)
    } else if (harness === 'official-cc') {
      try {
        assertOfficialCcSpawnPreconditions(this.opts)
      } catch (err) {
        this.starting = false
        throw err
      }
      command = process.env.OPENCLAUDE_OFFICIAL_CLAUDE_PATH?.trim() || '/usr/local/bin/claude'
      if (!isAbsolute(command)) {
        this.starting = false
        throw new Error('Official Claude Code binary path must be absolute')
      }
      if (!existsSync(command)) {
        this.starting = false
        throw new Error(`Official Claude Code binary not found: ${command}`)
      }
      binaryDir = dirname(command)
    } else {
      try {
        const launch = resolveClaudeCodeLaunch(config)
        binaryDir = launch.binaryDir
        ccbEntry = launch.entry
        ccbRuntime = launch.runtime
        command = ccbRuntime
      } catch (err) {
        this.starting = false
        throw err
      }
      if (!existsSync(binaryDir)) {
        this.starting = false
        throw new Error(
          `Claude Code path not found: ${binaryDir}. Set auth.claudeCodePath in ~/.openclaude/openclaude.json or OPENCLAUDE_CLAUDE_CODE_PATH`,
        )
      }
    }

    // ─── Phase 5: read repo snapshot ONCE before learning context + spawn args ──
    // ready 时切到 repo workspaceDir,其它情况(null / cloning / failed)fall-back agentBaseDir。
    // _boundRepoBinding 只在 ready 时记录,recycle 决策(sessionManager.recyclePeerForRepoChange)
    // 据此判断是否 cwd-version 错位。
    let repoSnapshot: RepoSnapshot | null = null
    if (!this.opts.hermeticNoTools && this.opts.sessionId && this.opts.getRepoSnapshot) {
      try {
        repoSnapshot = this.opts.getRepoSnapshot(this.opts.sessionId)
      } catch (err) {
        runnerLog.warn(
          'getRepoSnapshot threw; treating as no-bind',
          { sessionKey: this.opts.sessionKey },
          err,
        )
        repoSnapshot = null
      }
    }
    const desktopWorkspaceDir = resolveDesktopWorkspaceDir()
    const effectiveAddDir =
      repoSnapshot?.status === 'ready' && repoSnapshot.workspaceDir
        ? repoSnapshot.workspaceDir
        : desktopWorkspaceDir || this.opts.agentBaseDir
    if (repoSnapshot?.status === 'ready' && repoSnapshot.workspaceDir) {
      this._boundRepoBinding = {
        selectionVersion: repoSnapshot.selectionVersion,
        workspaceDir: repoSnapshot.workspaceDir,
      }
    } else {
      this._boundRepoBinding = null
    }

    // ─── L1/L2/L3: prepare learning-loop context for the subprocess ───
    let learningContext: {
      extraPromptFile?: string
      mcpConfigFile?: string
      settingsFile?: string
      workingDir?: string
    }
    try {
      learningContext = await this.buildLearningContext(repoSnapshot)
    } catch (err) {
      this.starting = false
      // _boundRepoBinding 已在 439-444 落字段;start() 抛错没真正 spawn,清掉
      // 避免 isRunning=false + binding!=null 的不变量割裂。
      this._boundRepoBinding = null
      throw err
    }

    const restrictedMemorySources = isV3ContainerRuntime()
    // Claude Code resolves `--resume <uuid>` ONLY under
    // `$CLAUDE_CONFIG_DIR/projects/<sanitize(cwd)>/`. Our resume-map probe
    // (`ccbJsonlArtifact`) scans every project dir, so the two disagree the
    // moment a session's spawn cwd changes between turns (isolated_v1 unbound
    // first turn → project-bound follow-up; repo clone becoming ready; desktop
    // OPENCLAUDE_ENGINE_CWD). Make the transcript visible where CCB will look
    // before we hand it the id, otherwise CCB exits 1 with "No conversation
    // found" and the gateway loops on STALE_RESUME_ID (2026-09-07 incident).
    // Docker backend pins cwd to /workspace inside the container; the host
    // projection would be meaningless there, so only the local backend runs it.
    const spawnCwd = learningContext.workingDir ?? effectiveAddDir
    const backendType = this.opts.config.terminal?.type ?? 'local'
    if (this.currentSessionId && !this.opts.hermeticNoTools && backendType === 'local') {
      const relocation = relocateCcbJsonlToCwd({ innerId: this.currentSessionId, cwd: spawnCwd })
      if (relocation?.relocated) {
        runnerLog.info('resume transcript relocated for spawn cwd', {
          sessionKey: this.opts.sessionKey,
          resumeId: this.currentSessionId,
          from: relocation.from,
          cwd: spawnCwd,
        })
      }
    }
    let args = harness === 'official-cc'
      ? buildOfficialClaudeCliArgs({
          model: this.opts.model,
          permissionMode: this.opts.permissionMode,
          extraPromptFile: learningContext.extraPromptFile,
          mcpConfigFile: learningContext.mcpConfigFile,
          settingsFile: learningContext.settingsFile,
          addDir: effectiveAddDir,
          resumeSessionId: this.currentSessionId,
          restrictedMemorySources,
        })
      : buildCcbCliArgs({
          runtime: ccbRuntime!,
          entry: ccbEntry!,
          model: this.opts.model,
          permissionMode: this.opts.permissionMode,
          extraPromptFile: learningContext.extraPromptFile,
          mcpConfigFile: learningContext.mcpConfigFile,
          addDir: effectiveAddDir,
          resumeSessionId: this.currentSessionId,
          // v3 商业版用户容器判定 —— 双信号 OR 兜底,单一权威已收口
          // hostStaticProviders.isV3ContainerRuntime(注释/语义见该函数 JSDoc)。
          restrictedMemorySources,
          workload: this.opts.workload,
          hermeticNoTools: this.opts.hermeticNoTools,
          settingsFile: learningContext.settingsFile,
          structuredOutputSchema: this.opts.structuredOutputSchema,
        })
    if (this.opts.boxResidentCc) args = [boxCcBridgePath(), ...args]

    // ── Provider-aware auth injection ──
    // CCB auth priority: ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN > settings.json
    // provider 路由 env 决策收口到 buildHostSpawnProviderEnv(单一权威,便于单测对称性):
    //   host 静态直连(优先)> claude-subscription OAuth direct-Anthropic > settings.json 默认;
    //   secondary utility model 也在内一并按 routing 决定(host-static 同 provider 兜底,不跨打错)。
    //   本函数决策与 resolveSyntheticTurnModel 的 isHostRoutableStaticModel 自检严格对称:
    //   helper 判可降级到静态模型 ⟺ 这里 routing==='host-static',spawn 必按静态路由起。
    // key 缺失 → resolveHostStaticProviderEnv throw → 在此 spawn 前 fail-closed + 清理
    //   starting/binding(语义同上方 buildLearningContext 的 catch)。
    const providerEnv: Record<string, string> = {}
    let hostSpawnRouting: HostSpawnProviderEnv
    try {
      hostSpawnRouting = buildHostSpawnProviderEnv({
        model: this.opts.model,
        effectiveProvider: this.opts.agentProvider ?? this.opts.config.provider,
        claudeOAuthAccessToken: this.opts.config.auth.claudeOAuth?.accessToken,
      })
    } catch (err) {
      this.starting = false
      this._boundRepoBinding = null
      throw err
    }
    Object.assign(providerEnv, hostSpawnRouting.env)
    if (hostSpawnRouting.routing === 'host-static') {
      runnerLog.info('host static provider direct routing injected', {
        sessionKey: this.opts.sessionKey,
        model: this.opts.model,
        provider: hostSpawnRouting.providerId,
      })
    }
    const finalizedProviderEnv = finalizeCcbSpawnEnv({
      providerEnv,
      routing: hostSpawnRouting.routing,
    })
    if (this.opts.providerEnvOverride) {
      Object.assign(finalizedProviderEnv, this.opts.providerEnvOverride)
    }
    if (harness === 'official-cc' && this.opts.authorityEngine === 'cursor' && !this.opts.boxResidentCc) {
      if (!isOfficialClaudeCursorSandLoopbackEnv(finalizedProviderEnv)) {
        this.starting = false
        this._boundRepoBinding = null
        throw new Error('OFFICIAL_CC_CURSOR_SAND_LOOPBACK_BINDING_INVALID')
      }
    }
    if (isCcbAdvisorHermeticProfile(this.opts)) {
      try {
        await assertCcbAdvisorCatalogLock({
          lock: this.opts.advisorExecutionLock,
          model: this.opts.model,
        })
      } catch (err) {
        this.starting = false
        this._boundRepoBinding = null
        throw err
      }
    }

    let proc: ReturnType<TerminalBackend['spawn']>
    try {
      const spawnOpts: SpawnOpts = {
          command,
          args,
          ccbBinaryDir: binaryDir,
        // Docker /workspace mount + Local --add-dir 内容统一用 effectiveAddDir;
        // ready 时是 repo workspaceDir,其它情况 = agentBaseDir。
        workspaceHostDir: learningContext.workingDir ?? effectiveAddDir,
        // Phase 5:Local 模式子进程的真 cwd。Docker 模式 backend 忽略此字段
        // (容器 cwd 由 -w /workspace 控制,与 workspaceHostDir 同源)。
        // 这样 CCB 启动后 process.cwd() 就直接指向项目目录,STATE.cwd
        // 与 Bash 工具的 working directory 都跟系统提示对齐。
        subprocessCwd: learningContext.workingDir ?? effectiveAddDir,
        env: {
          ...finalizedProviderEnv,
          OC_SESSION_KEY: this.opts.sessionKey,
          OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
          OPENCLAUDE_AGENT_ID: this.opts.agentId,
          OC_AGENT_ID: this.opts.agentId,
          ...identityCompatEnvironment(this.opts.identityCompat),
          ...(this.delegateContextFile
            ? { OPENCLAUDE_DELEGATE_CONTEXT_FILE: this.delegateContextFile }
            : {}),
          // Per-session effort level (xhigh / max from chat-mode pills, or
          // undefined to let CCB use its model-default — Opus 4.7 → high).
          // Empty string deletes any inherited CLAUDE_CODE_EFFORT_LEVEL so a
          // gateway-process env doesn't bleed into spawned CCBs.
          CLAUDE_CODE_EFFORT_LEVEL: this.opts.effortLevel ?? '',
          // OCV5-434: OpenCode Go GPT Fast (see _buildCcbServiceTierEnv).
          ..._buildCcbServiceTierEnv(this._serviceTier),
          ...(this.opts.hermeticNoTools ? { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } : {}),
          // Note: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS used to be set to '1'
          // here to strip run_in_background from Bash/Agent/PowerShell tool
          // schemas (visibility band-aid for Opus 4.7 over-using background
          // mode). Removed once CCB started streaming bash_output_tail
          // SDK events at 1 Hz — the underlying UX problem (background
          // commands looking idle) is now solved end-to-end (CCB
          // sdkEventQueue → gateway ccbMessageParser → web tool_output_tail
          // block), so the model can pick run_in_background:true again.
          IS_SANDBOX: '1',
          ...(harness === 'ccb' ? { FEATURE_VERIFICATION_AGENT: '1' } : {}),
          // 禁用 CCB 自带 Kairos cron 工具(CronList/CronCreate/CronDelete)。它们操作
          // CCB 进程内的第二调度器(内存/scheduled_tasks.json),与 gateway cron.yaml
          // (管理中心/create_reminder 的权威源)天然分裂:面板建的任务 CronList 看不到,
          // 只有 CronCreate→gateway 的单向镜像桥。定时任务的唯一权威 = gateway cron,
          // agent 侧读写走 openclaude-memory MCP 的 reminder 工具族(list/create/
          // update/delete,同一 /api/cron)。
          CLAUDE_CODE_DISABLE_CRON: '1',
          // OCV5-383: CCB places the static half of extra-prompt.md before its own
          // per-session sections (see buildPromptContext cacheLayout). Same gate as below.
          OPENCLAUDE_PROMPT_LAYOUT: usesStaticFirstPromptLayout(harness, this.opts.boxResidentCc)
            ? '2'
            : '',
          ...(harness === 'official-cc'
            ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
            : {}),
          // memdir 范式:平台记忆的唯一权威是 MEMORY.md 索引 + memory/<slug>.md 文件,
          // 由模型用原生 Write/Edit 直写(指令常驻在 # Memory 段)。CCB 自带的
          // 「自动记忆」写入器会另起一份私有 memory store,与平台记忆分裂 → 关掉它。
          // gate = isV3ContainerRuntime()(与上方 restrictedMemorySources 同一权威),
          // 个人版(宿主单进程)行为不动。
          ...(isV3ContainerRuntime() ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
          // 远程执行目标:kind='remote' 时让 CCB RemoteExecutor 启用 ssh mux 分支。
          // 空串 = 本地执行(默认);OC_REMOTE_* 其余变量仅在 remote 分支设。
          // 容器里 ctl.sock 的真实路径是宿主侧 /run/ccb-ssh/u<uid>/h<hid>/ctl.sock,
          // bind 进容器后去掉 u<uid> 前缀 → /run/ccb-ssh/h<hid>/ctl.sock;
          // 因此这里把 hostMeta.controlPath/knownHostsPath 的 `/u<uid>` 部分
          // 剥掉后注入(substitute 宿主路径为容器内视图)。
          ...buildRemoteTargetEnv(this.opts.executionTarget),
          // delegate 计费归因 → CCB metadata.user_id JSON(仅 delegate 会话非空;
          // 空串 = 未设置,同 trace env 的"覆盖继承"语义)。见
          // `_buildCcbUsageAttributionEnv` JSDoc。
          ...(harness === 'ccb'
            ? _buildCcbUsageAttributionEnv(this.opts.usageAttribution)
            : { CLAUDE_CODE_EXTRA_METADATA: '' }),
          // V3 S12e CG8 — contract C 段 trace env(best-effort,放最末永远覆盖
          // process.env 继承)。空串 = "本 spawn 无 trace stash",见
          // `_buildCcbSpawnTraceEnv` JSDoc。
          ..._buildCcbSpawnTraceEnv(this.opts.traceId),
          [MODEL_EXECUTION_DESCRIPTOR_ENV]: this.currentExecutionDescriptorEnv,
          ...(isCcbAdvisorHermeticProfile(this.opts)
            ? {
                ...(this.advisorHomeDir ? { HOME: this.advisorHomeDir } : {}),
                ...(this.advisorConfigDir ? { CLAUDE_CONFIG_DIR: this.advisorConfigDir } : {}),
                ...(this.advisorHomeDir
                  ? {
                      XDG_CONFIG_HOME: resolve(this.advisorHomeDir, '.config'),
                      XDG_CACHE_HOME: resolve(this.advisorHomeDir, '.cache'),
                    }
                  : {}),
                [CCB_ADVISOR_HERMETIC_ENV]: '1',
                CLAUDE_CODE_UNATTENDED_RETRY: '0',
              }
            : {}),
          ...(harness === 'official-cc' && !this.opts.boxResidentCc && this.pendingOfficialSpawnEnv
            ? this.pendingOfficialSpawnEnv
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
        detached: true, // create process group so shutdown() can kill all children
      }
      if (this.opts.boxResidentCc) {
        if (!this.boxCcControlPath) {
          this.starting = false
          throw new Error('BOX_CC_CONTROL_REQUIRED')
        }
        spawnOpts.env = stripBoxCcParentAuth(
          spawnOpts.env as Record<string, string>,
          this.boxCcControlPath,
        )
      }
      // OCV5-570: only a CCB whose upstream is egress gets the turn's internal trace header.
      this.spawnedUpstreamIsEgress = _ccbUpstreamIsEgress(spawnOpts.env as NodeJS.ProcessEnv)
      const backend: TerminalBackend = createBackend(this.opts.config.terminal)
      timing.once('spawn_requested')
      proc = ccbSpawnForTests ? ccbSpawnForTests(spawnOpts) : backend.spawn(spawnOpts)
      timing.once('spawned')
    } catch (err) {
      this.starting = false
      // 见 449 catch 同理:spawn 抛错时 binding 字段已置位,清掉保不变量。
      this._boundRepoBinding = null
      throw err
    }

    if (epoch !== this._startEpoch) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* best-effort: start was aborted by shutdown */
      }
      this.starting = false
      return
    }
    this.processTiming = timing
    this.proc = proc as unknown as ChildProcessWithoutNullStreams
    // Capture the resolver by value: a retired generation (official-cc abort
    // recycle) may close stdout after a newer process already owns the shared
    // field, and must not settle the newer barrier.
    let resolveThisDrain!: () => void
    this.outputDrainPromise = new Promise<void>((resolve) => {
      resolveThisDrain = resolve
    })
    this.resolveOutputDrain = resolveThisDrain
    this.spawnedExecutionDescriptor = this.currentExecutionDescriptor
    if (resolveCcbHarness(this.opts.harness) === 'official-cc' && this.pendingOfficialSpawnEnv) {
      this.spawnedOfficialHeaderFingerprint = officialCcProxySpawnFingerprint(
        this.pendingOfficialSpawnEnv,
      )
    }
    // Emit BEFORE any stdout listener is attached, so subscribers (e.g. session
    // manager's per-CCB cost-tracker reset) run strictly before any 'message'
    // or 'session_id' event of the new process can arrive.
    //
    // `resumed` tells consumers whether CCB will restore historical state on
    // start. When --resume is passed CCB calls restoreCostStateForSession
    // which sets STATE.totalCostUSD back to the persisted cumulative — so the
    // gateway's per-session cost-delta baseline must NOT be reset to 0.
    this.emit('spawn', { resumed: !!this.currentSessionId })

    // The OS process 'exit' event can precede delivery of bytes already in
    // its stdout pipe. Forward the runner-level exit only after stdout closes,
    // which is Node's guarantee that every preceding data chunk was emitted.
    // Crash persistence can then snapshot a closed stream rather than guess
    // with a timer and risk omitting a paid final JSONL frame.
    let pendingExitInfo: RunnerExitInfo | null = null
    let stdoutClosed = false
    let exitForwarded = false
    const forwardDrainedExit = () => {
      if (exitForwarded || !stdoutClosed || !pendingExitInfo) return
      exitForwarded = true
      // The direct child may exit before a descendant releases stdout. If a
      // bounded shutdown detaches it, the eventual stdout-close callback must
      // not finalize a newly spawned turn.
      this._forwardDrainedExitForProcess(proc, pendingExitInfo)
    }

    proc.stdin.on('error', (err) =>
      runnerLog.warn('stdin error', { sessionKey: this.opts.sessionKey }, err),
    )
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => {
      // A terminal shutdown deadline can detach an old proc whose escaped
      // descendant still owns stdout. Never parse those late bytes against a
      // newly spawned runner state.
      if (this.proc !== proc) return
      if (chunk.length > 0) timing.once('first_stdout')
      this.handleStdout(chunk, timing)
    })
    proc.stdout.once('close', () => {
      // A process killed immediately after writing a complete JSON object may
      // omit the conventional trailing newline. Feed one delimiter through
      // the normal parser before declaring the stream drained.
      if (this.proc === proc && this.stdoutBuf.length > 0) this.handleStdout('\n', timing)
      stdoutClosed = true
      resolveThisDrain()
      if (this.resolveOutputDrain === resolveThisDrain) this.resolveOutputDrain = null
      forwardDrainedExit()
    })

    proc.stderr.setEncoding('utf-8')
    this.stderrBufBytes = 0
    proc.stderr.on('data', (chunk: string) => {
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now() // stderr activity also counts as "alive"
      this.stderrTail = appendCrashStderrTail(this.stderrTail, chunk)
      this.stderrBufBytes += Buffer.byteLength(chunk, 'utf8')
      // If stderr goes pathological (single burst > cap), kill to avoid RSS
      // blow-up from downstream listeners that might buffer all of it.
      if (this.stderrBufBytes > MAX_STDERR_BUF_BYTES) {
        this.handleStderrOverflow(this.stderrBufBytes)
        this.stderrBufBytes = 0
        return
      }
      // Reset counter on newline — stderr is usually line-oriented log output.
      if (chunk.includes('\n')) this.stderrBufBytes = 0
      this.emit('stderr', chunk)
    })

    proc.on('exit', (code, signal) => {
      // shutdown() may have reached its terminal post-SIGKILL deadline and a
      // later submit may already own a new proc. A delayed exit from the old
      // process must not mark the new turn crashed or reset its binding.
      if (this.proc !== proc) {
        runnerLog.info('stale subprocess exit ignored', {
          sessionKey: this.opts.sessionKey,
          code,
          signal,
        })
        return
      }
      this.spawnedExecutionDescriptor = undefined
      this.closed = true
      // Phase 5:进程死了,清 binding。下次 start 会按当时 repo state 重新评估。
      // 哪怕本次是 graceful (recycle),session.lock 已经在 caller 那边持有,
      // 不存在 stale binding 被中间状态读到的窗口;但写下来语义更对称。
      this._boundRepoBinding = null
      // Use explicit shuttingDown flag (set by shutdown()) to distinguish
      // graceful shutdown from crash. Exit code alone is unreliable:
      // - SIGSEGV/SIGKILL → code=null but NOT graceful
      // - CCB may exit with non-0 code on normal termination
      const expectedOfficialAbortExit = _isExpectedOfficialClaudeAbortExit({
        harness: this.opts.harness ?? 'ccb',
        code,
        signal,
        abortResultObserved: this.officialAbortResultObserved,
      })
      const skipCrashLoop = _boxCcOneShotExitSkipsCrashLoop({
        boxResidentCc: this.opts.boxResidentCc === true,
        code,
        signal,
      })
      const crashed = !this.shuttingDown && !expectedOfficialAbortExit
      if (crashed && !skipCrashLoop) {
        this._recordCrash({ code, signal })
      } else {
        // Keep `shuttingDown` true until the stdout-drained `close` boundary.
        // A descendant can retain the pipe after the direct child exits; if
        // we clear this flag here, a new submit may replace `this.proc` and
        // the identity guard will discard those late paid bytes.
        // Graceful shutdown wipes any accumulated backoff — the operator is
        // in control, not a crash-loop, so the next start() should not be gated.
        // Also zero _lastStartAt so a post-restart crash can't consult a stale
        // "stable uptime" timestamp from this now-dead subprocess.
        this._consecutiveCrashes = 0
        this._backoffUntil = 0
        this._lastStartAt = 0
      }
      pendingExitInfo = { code, signal, crashed }
      forwardDrainedExit()
    })

    proc.on('error', (err) => {
      if (this.proc !== proc) {
        runnerLog.info('stale subprocess error ignored', {
          sessionKey: this.opts.sessionKey,
          err: err.message,
        })
        return
      }
      this.emit('error', err)
    })

    // Spawn succeeded — record timestamp for STABLE_UPTIME_MS check. A crash
    // more than STABLE_UPTIME_MS after this point is treated as a fresh failure
    // (counter resets) rather than compounding on past crashes.
    this._lastStartAt = Date.now()
    this.starting = false
    } catch (err) {
      // Any failure between backoff-gate-pass and spawn-succeeded is a "start
      // failed" crash. Record it so the gate fires on the next call.
      this.starting = false
      this._recordCrash({ startError: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  /**
   * Bump the crash counter and compute the next backoff window.
   * Called from the exit handler (crashed=true) and the start() catch block.
   *
   * Backoff = BASE * 2^(n-1), clamped to MAX. First crash → 500ms, second →
   * 1s, third → 2s, … up to 30s. Counters reset on graceful shutdown (see
   * exit handler) or when the previous run was stable for STABLE_UPTIME_MS.
   */
  private _recordCrash(
    detail: { code?: number | null; signal?: NodeJS.Signals | null; startError?: string } = {},
  ): void {
    const now = Date.now()
    // If we had a long-lived stable run before this crash, don't punish it —
    // reset the counter so an isolated crash after hours of uptime starts
    // fresh at 500ms instead of compounding on a counter from yesterday.
    if (
      this._lastStartAt > 0 &&
      now - this._lastStartAt >= SubprocessRunner.STABLE_UPTIME_MS
    ) {
      this._consecutiveCrashes = 0
    }
    this._consecutiveCrashes++
    const expBackoff =
      SubprocessRunner.BACKOFF_BASE_MS * 2 ** (this._consecutiveCrashes - 1)
    const backoff = Math.min(expBackoff, SubprocessRunner.BACKOFF_MAX_MS)
    this._backoffUntil = now + backoff
    // Consume the stable-uptime window: _lastStartAt is only meaningful for
    // one "this crash happened after a long stable run" check. If we kept it
    // after recording the crash, repeated pre-spawn failures would all see
    // the same old timestamp, reset the counter each time, and the exponential
    // backoff would never escalate past 500ms. Only a successful spawn should
    // re-arm the window.
    this._lastStartAt = 0
    runnerLog.warn('ccb.crash — scheduling exponential backoff', {
      sessionKey: this.opts.sessionKey,
      consecutiveCrashes: this._consecutiveCrashes,
      backoffMs: backoff,
      ...(detail.code !== undefined ? { exitCode: detail.code } : {}),
      ...(detail.signal ? { signal: detail.signal } : {}),
      ...(detail.startError ? { startError: redactCrashStderrTail(detail.startError).slice(0, 500) } : {}),
      ...(this.stderrTail ? { stderrTail: redactCrashStderrTail(this.stderrTail) } : {}),
    })
  }

  private handleStdout(chunk: string, timing = this.processTiming): void {
    this.lastActivityAt = Date.now()

    // Scan `chunk` in place rather than first concatenating the entire chunk
    // onto stdoutBuf. Complete lines are parsed one by one and only the final
    // unterminated suffix remains buffered. There is deliberately no semantic
    // byte ceiling: a valid line may itself be an arbitrarily large paid tool
    // result, and killing/dropping it would violate lossless persistence.
    let offset = 0
    let firstLineConsumesBuf = this.stdoutBuf.length > 0
    while (true) {
      const nlIdx = chunk.indexOf('\n', offset)
      if (nlIdx < 0) break

      const tail = chunk.slice(offset, nlIdx)
      // Materialize the complete JSON line, then immediately release it after
      // parsing/emitting. Physical host memory is the only unavoidable bound.
      let fullLine: string
      if (firstLineConsumesBuf) {
        fullLine = this.stdoutBuf + tail
        this.stdoutBuf = ''
        firstLineConsumesBuf = false
      } else {
        fullLine = tail
      }
      const trimmed = fullLine.trim()
      if (trimmed) {
        try {
          const msg = JSON.parse(trimmed) as SdkMessage
          if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
            timing?.once('sdk_init_received')
          }
          // OpenClaude telemetry side-channel: `_oc_telemetry` lines are
          // observability events, not SDK messages. Route them to the
          // dedicated 'telemetry' listener and skip the normal pipeline:
          //   - NEVER update currentSessionId from a telemetry line
          //     (Gateway session tracking must stay driven by real SDK
          //     messages only)
          //   - NEVER emit 'message' (parser would crash on unknown type)
          //
          // session_id on telemetry is required-but-tolerated: if missing
          // we silently drop and bump missingSessionIdCount so anomalies
          // show up in diagnostics instead of crashing.
          // Design doc: ccb-telemetry-refactor-plan.md §3.1 + §5.1.
          if ((msg as { type?: string }).type === '_oc_telemetry') {
            const telemetryMsg = msg as SdkMessage & {
              type: '_oc_telemetry'
              session_id?: string
            }
            if (
              typeof telemetryMsg.session_id !== 'string' ||
              telemetryMsg.session_id.length === 0
            ) {
              this.missingSessionIdCount++
            } else {
              this.emit('telemetry', telemetryMsg)
            }
          } else {
            if (this.opts.harness === 'official-cc' && _isOfficialClaudeAbortResult(msg)) {
              this.officialAbortResultObserved = true
              // Official Claude Code exits 1 a few seconds after this frame; a
              // user turn submitted in that window would be written into a
              // process that is already dying and surface as RUNNER_CRASHED.
              // Retire the process generation now so the next submit() spawns
              // a fresh one (--resume keeps the transcript), and so the
              // trailing exit(1) is classified as an expected recycle.
              this.retireOfficialAbortedProcess()
            }
            // Always update session ID (CCB may report a new one after --resume)
            if (msg.session_id && msg.session_id !== this.currentSessionId) {
              this.currentSessionId = msg.session_id
              this.emit('session_id', this.currentSessionId)
            }
            this.emit('message', msg)
          }
        } catch (err) {
          this.emit('parse_error', { line: trimmed, err })
        }
      }

      offset = nlIdx + 1
    }

    // Trailing partial (no newline) — retain it until the next stdout chunk.
    if (offset < chunk.length) {
      const trailing = offset === 0 ? chunk : chunk.slice(offset)
      this.stdoutBuf += trailing
    }
  }

  /**
   * Called when non-user-visible stderr accumulates beyond its line guard.
   * Emits an `overflow` event with details and kills the subprocess group.
   * Idempotent — a second trigger during the same kill window is a no-op.
   */
  private handleStderrOverflow(size: number): void {
    if (this.overflowKilled || this.closed) return
    this.overflowKilled = true
    const proc = this.proc
    const pid = proc?.pid
    const info = { stream: 'stderr' as const, size, cap: MAX_STDERR_BUF_BYTES, pid, sessionKey: this.opts.sessionKey }
    runnerLog.error('ccb.stderr_overflow — force-killing subprocess', info)
    this.emit('overflow', info)
    // Trigger an exit path: force-kill the process group so MCP children die too.
    try {
      if (proc) {
        killRunnerProcessGroup(proc, 'SIGKILL')
      }
    } catch (err) {
      runnerLog.warn('overflow kill failed', { sessionKey: this.opts.sessionKey }, err)
    }
  }

  // 发送一条 user message。CCB stream-json 输入格式:每行一个 SDK user message JSON
  // content 可以是单个字符串(全文本),也可以是完整的 Anthropic content block 数组(支持图片/多模态)
  //
  // PR2 v1.0.66 — `_requestId` 形参为兼容 sessionManager.submit 的统一签名而存在
  // (CodexAppServerRunner 才真用)。CCB 路径不消费,纯 noop;打前缀下划线表明
  // 参数有意忽略,不报 unused warning。
  //
  // 模型权威批次 §4 —— **每个 turn 先写 `update_environment_variables`,再写 user message**:
  //   · 同一条 stdin、按行顺序处理 ⇒ 本 turn 的第一个 `/v1/messages` 必带本 turn 的凭据 header;
  //   · CCB 每请求现读该 env ⇒ turn 内的重试 / 工具循环 / compact 全部复用同一张 lease,
  //     不需要每请求重签;
  //   · 无凭据的 turn 写**空串**清位 —— 上一 turn 的 envelope 绝不允许泄漏到下一 turn。
  // 凭据解析失败(header 值非法 / 本地 catalog 取不到)→ **不发本 turn**(fail-closed)。
  async submit(
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
    _requestId?: string,
    authority?: TurnModelAuthority,
    turnKey?: string,
    traceId?: string | null,
  ): Promise<void> {
    const turnTraceId = traceId === null ? undefined : traceId ?? this.opts.traceId
    const turnTiming = new PassiveStageTiming({ engine: 'ccb', traceId: turnTraceId,
      sessionKey: this.opts.sessionKey, model: this.opts.model },
      (fields) => runnerLog.info('engine_submit_timing', { ...fields, generation: this.spawnGeneration }))
    turnTiming.once('submit_received')
    // 先解析 + 校验凭据:抛在这里 = 一行都没写 = 本 turn 没发出去(fail-closed)。
    // 也保证下方两次 write 之间**没有 await**(不给交叠 turn 插队的窗口)。
    const runtime = await resolveTurnRuntime(
      authority,
      this.opts.model,
      process.env,
      this.opts.authorityEngine ?? 'ccb',
    )
    turnTiming.once('runtime_resolved')
    this.pinBoxNativeHarness(runtime.descriptor)
    if (isCcbAdvisorHermeticProfile(this.opts)) {
      await assertCcbAdvisorCatalogLock({
        lock: this.opts.advisorExecutionLock,
        model: this.opts.model,
      })
    }
    if (
      this.proc &&
      shouldRecycleForVisionCapability(this.spawnedExecutionDescriptor, runtime.descriptor)
    ) {
      // vision 决定 spawn-time prompt/upload fallback；长驻进程不能只靠 stdin env 热改。
      await this.shutdown()
    }
    if (this.pendingConsultRespawn) {
      this.pendingConsultRespawn = false
      await this.shutdown()
    }
    this.currentExecutionDescriptor = runtime.descriptor
    this.currentExecutionDescriptorEnv = runtime.descriptor
      ? JSON.stringify(runtime.descriptor)
      : ''
    const harness = resolveCcbHarness(this.opts.harness)
    const officialCcProxyLane = _officialCcProxyLane({
      harness,
      authorityEngine: this.opts.authorityEngine,
      boxResidentCc: this.opts.boxResidentCc === true,
    })
    if (officialCcProxyLane) {
      const spawnEnv = buildOfficialCcProxySpawnEnv({
        headers: runtime.headers,
        usageAttribution: this.opts.usageAttribution,
        turnKey,
        executionDescriptorEnv: this.currentExecutionDescriptorEnv,
      })
      const fingerprint = officialCcProxySpawnFingerprint(spawnEnv)
      if (this.proc && this.spawnedOfficialHeaderFingerprint !== fingerprint) {
        await this.shutdown()
      }
      this.pendingOfficialSpawnEnv = spawnEnv
    }
    this.currentTurnHeaders = runtime.headers
    // Built here so a bad authority header still fails the turn before any spawn; the custom-header
    // value is rebuilt with the turn trace once the process (and so its upstream) is known (OCV5-570).
    const envUpdateVars = harness === 'ccb'
      ? (
          {
            ..._buildAnthropicCustomHeadersEnv(runtime.headers),
            ..._buildCcbUsageAttributionEnv(this.opts.usageAttribution, turnKey),
            [MODEL_EXECUTION_DESCRIPTOR_ENV]: this.currentExecutionDescriptorEnv,
            // SessionManager owns the one global 1..10 retry budget. CCB's native
            // withRetry loop is per API call, so leaving it enabled can exceed the
            // remaining turn budget after tools or a browser recovery hop.
            CLAUDE_CODE_MAX_RETRIES: '0',
            ...(isCcbAdvisorHermeticProfile(this.opts)
              ? { CLAUDE_CODE_UNATTENDED_RETRY: '0', [CCB_ADVISOR_HERMETIC_ENV]: '1' }
              : {}),
          }
        )
      : null

    turnTiming.once('recycle_complete')
    if (!this.proc) await this.start()
    turnTiming.once('process_available')
    if (!this.proc) throw new Error('failed to start agent subprocess')
    this.refreshDelegateContext(turnTraceId)
    const envUpdateLine = envUpdateVars
      ? _buildUpdateEnvStdinLine({
          ...envUpdateVars,
          ..._buildAnthropicCustomHeadersEnv(runtime.headers, this.egressTraceId()),
        })
      : null
    const content = ccbStdinUserContent(userTextOrBlocks)
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }
    // Writable.write 的失败大多经 callback 异步报告，try/catch 只能抓同步 throw。
    // CCB 两行逐一等 callback。Official CC 2.1.259 does not implement CCB's
    // private update_environment_variables control line; its only allowed
    // deployment is the credential-bound Cursor loopback relay, which does not
    // consume the authority headers. We still resolved runtime above on every
    // turn (fail-closed), but do not pretend descriptor/headers/attribution are
    // hot-updated in the stock process.
    if (envUpdateLine) await this.writeTurnLineOrDestroy(envUpdateLine, 'authority_env')
    await this.writeTurnLineOrDestroy(`${JSON.stringify(userMsg)}\n`, 'user_message')
    turnTiming.once('user_stdin_written')
  }

  /**
   * Replace only the current turn's rolling lease while CCB is running.
   * StructuredIO applies update_environment_variables concurrently with a
   * live query and every subsequent `/v1/messages` call reads the new header.
   */
  async updateTurnLease(leaseEnvelope: string): Promise<void> {
    if (resolveCcbHarness(this.opts.harness) === 'official-cc') {
      if (
        this.opts.authorityEngine === 'cursor'
        && this.opts.providerEnvOverride
        && isOfficialClaudeCursorSandLoopbackEnv(this.opts.providerEnvOverride)
      ) {
        // CcbAdapter still renews the master lease to prove control-plane
        // liveness. The stock CLI cannot hot-apply env changes, and the bound
        // loopback Cursor relay does not consume this header, so there is no
        // subprocess write in this narrowly-scoped lane.
        void leaseEnvelope
        return
      }
      if (this.opts.authorityEngine === 'cursor') {
        throw new Error('OFFICIAL_CC_LEASE_NOOP_OUTSIDE_CURSOR_SAND')
      }
      if (this.opts.boxResidentCc) {
        // The box CLI never sees these headers. Marking the process stale here
        // would only make the next turn kill a healthy box process.
        void leaseEnvelope
        return
      }
      // engine=ccb official-cc: stock CLI cannot hot-apply. Stash the renewed
      // bundle and invalidate the spawn fingerprint so the next submit recycles.
      // Box keeps the same-turn authority; every other turn stays lease-only.
      const renewed = renewTurnHeaderBundle(this.currentTurnHeaders, leaseEnvelope)
      this.currentTurnHeaders = renewed
      const headerEnv = _buildAnthropicCustomHeadersEnv(renewed)
      this.pendingOfficialSpawnEnv = {
        ...(this.pendingOfficialSpawnEnv ?? {}),
        ...headerEnv,
      }
      this.spawnedOfficialHeaderFingerprint = undefined
      return
    }
    const renewed = renewTurnHeaderBundle(this.currentTurnHeaders, leaseEnvelope)
    this.currentTurnHeaders = renewed
    const envUpdateLine = _buildUpdateEnvStdinLine(
      _buildAnthropicCustomHeadersEnv(renewed, this.egressTraceId()),
    )
    if (!this.proc) throw new Error('cannot renew turn lease without a running CCB subprocess')
    await this.writeTurnLineOrDestroy(envUpdateLine, 'authority_env')
  }

  /** The turn trace for CCB's egress requests (OCV5-570), or undefined when CCB's upstream is not egress. */
  private egressTraceId(): string | undefined {
    return this.spawnedUpstreamIsEgress ? this.opts.traceId : undefined
  }

  private async writeTurnLineOrDestroy(
    line: string,
    phase: 'authority_env' | 'user_message',
  ): Promise<void> {
    const proc = this.proc
    if (!proc) throw new Error('CCB subprocess disappeared before stdin write')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error | null): void => {
        if (settled) return
        settled = true
        if (!err) {
          resolve()
          return
        }
        runnerLog.error(
          'CCB stdin write failed — destroying subprocess and refusing turn',
          { sessionKey: this.opts.sessionKey, phase },
          err,
        )
        try { proc.stdin.destroy(err) } catch { /* best effort */ }
        try { proc.kill('SIGKILL') } catch { /* exit handler/next submit will recover */ }
        reject(err)
      }
      try {
        proc.stdin.write(line, done)
      } catch (err) {
        done(err as Error)
      }
    })
  }

  /**
   * R3 档 A: write a CCB stdin `type:user` line without starting SessionManager
   * submit() and without destroying the process on failure. Caller (CcbAdapter
   * / EngineNotifier) degrades to ResumeInject when this returns ok:false.
   */
  async writeDelegateUserMessage(
    content: string,
  ): Promise<{ ok: boolean; processAlive: boolean; unknown?: boolean }> {
    const proc = this.proc
    if (!this.isInlinePushProcLive(proc) || !proc) return { ok: false, processAlive: false }
    const stdin = proc.stdin
    if (!stdin || stdin.writable === false || stdin.destroyed) {
      return { ok: false, processAlive: true }
    }
    guardStdinErrors(stdin)
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content: ccbStdinUserContent(content),
      },
      parent_tool_use_id: null,
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => finish(new Error('ccb stdin write timeout')), 2_000)
        timer.unref?.()
        const finish = (err?: Error | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (typeof proc.off === 'function') proc.off('close', onClose)
          if (typeof stdin.off === 'function') stdin.off('error', onError)
          if (err) reject(err)
          else resolve()
        }
        const onClose = (): void => finish(new Error('ccb process closed during inline push'))
        const onError = (err: Error): void => finish(err)
        if (typeof proc.once === 'function') proc.once('close', onClose)
        if (typeof stdin.once === 'function') stdin.once('error', onError)
        try {
          // write()===false is backpressure: the chunk is already in the
          // buffer. Wait for the callback/error; do not treat false as failure.
          stdin.write(`${JSON.stringify(userMsg)}\n`, (err) => finish(err))
        } catch (err) {
          finish(err as Error)
        }
      })
      if (!this.isInlinePushProcLive(proc) || this.proc !== proc) {
        return { ok: false, processAlive: false }
      }
      return { ok: true, processAlive: true }
    } catch (err) {
      const live = this.isInlinePushProcLive(this.proc)
      const message = err instanceof Error ? err.message : ''
      if (live && message.includes('stdin write timeout')) {
        return { ok: false, processAlive: true, unknown: true }
      }
      return { ok: false, processAlive: live }
    }
  }

  private isInlinePushProcLive(proc: ChildProcessWithoutNullStreams | null): boolean {
    if (!proc || this.proc !== proc || this.closed) return false
    if (proc.killed || proc.exitCode != null) return false
    if (proc.signalCode != null) return false
    return true
  }

  // ─── Build per-session learning-loop context files ───
  // Writes temp files under /tmp/openclaude-<sessionKey>-XXXXXX/:
  //   extra-prompt.md   — USER.md content + skill metadata digest
  //   mcp-config.json   — MCP server pointing at @openclaude/mcp-memory
  private async buildLearningContext(repoSnapshot: RepoSnapshot | null = null): Promise<{
    extraPromptFile?: string
    mcpConfigFile?: string
    settingsFile?: string
    workingDir?: string
  }> {
    const out: {
      extraPromptFile?: string
      mcpConfigFile?: string
      settingsFile?: string
      workingDir?: string
    } = {}
    // Use mkdtempSync for a unique per-run directory: prevents a restarted runner
    // for the same sessionKey from racing with the old runner's shutdown cleanup.
    // Clean up any previous session directory before creating a new one
    // (guards against crash/retry scenarios where start() is called again).
    this.cleanupSessionDir()
    const safeDirName = this.opts.sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionDir = mkdtempSync(resolve(tmpdir(), `openclaude-${safeDirName}-`))
    this.sessionDir = sessionDir

    if (this.opts.hermeticNoTools) {
      const mcpPath = resolve(sessionDir, 'mcp-config.json')
      const settingsPath = resolve(sessionDir, 'settings.json')
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 })
      // --bare deliberately ignores ANTHROPIC_AUTH_TOKEN as an auth source.
      // Restore the existing commercial bearer through an explicit flag
      // setting without copying its value into argv or onto disk.
      writeFileSync(
        settingsPath,
        JSON.stringify({ apiKeyHelper: `printf '%s' "$ANTHROPIC_AUTH_TOKEN"` }),
        { mode: 0o600 },
      )
      if (isCcbAdvisorHermeticProfile(this.opts)) {
        const homeDir = resolve(sessionDir, 'home')
        const configDir = resolve(sessionDir, 'claude-config')
        mkdirSync(homeDir, { recursive: true, mode: 0o700 })
        mkdirSync(configDir, { recursive: true, mode: 0o700 })
        mkdirSync(resolve(homeDir, '.config'), { recursive: true, mode: 0o700 })
        mkdirSync(resolve(homeDir, '.cache'), { recursive: true, mode: 0o700 })
        this.advisorHomeDir = homeDir
        this.advisorConfigDir = configDir
      } else {
        this.advisorHomeDir = null
        this.advisorConfigDir = null
      }
      return {
        mcpConfigFile: mcpPath,
        settingsFile: settingsPath,
        workingDir: sessionDir,
      }
    }

    // Resolve provider/toolset-scoped MCP availability before building the
    // prompt, so provider hints only mention tools that will really exist.
    const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider
    const toolsetDefs = this.opts.config.toolsets
    const agentToolsets = this.opts.agentToolsets
    let allowedMcpIds: Set<string> | null = null // null = no filtering (all allowed)
    if (agentToolsets && agentToolsets.length > 0 && toolsetDefs) {
      allowedMcpIds = new Set<string>()
      for (const ts of agentToolsets) {
        const ids = toolsetDefs[ts]
        if (ids) for (const id of ids) allowedMcpIds.add(id)
      }
      // Built-in 平台 MCP **总是豁免 toolset 过滤**(各自有独立 gating):
      //   - openclaude-memory:总开。
      // (vision MCP 与 oc-vision CLI 均已在 OCV5-547 下线,不再作为内置 MCP 注入。)
      allowedMcpIds.add('openclaude-memory')
    }
    const availableMcpTools = new Set<string>()
    const addAvailableTools = (tools?: readonly string[]) => {
      for (const tool of tools ?? []) availableMcpTools.add(tool)
    }
    for (const srv of this.opts.config.mcpServers ?? []) {
      if (srv.enabled === false) continue
      if (srv.provider && srv.provider !== effectiveProvider) continue
      if (allowedMcpIds && !allowedMcpIds.has(srv.id)) continue
      addAvailableTools(srv.tools)
    }
    for (const srv of this.opts.agentMcpServers ?? []) {
      if (srv.enabled === false) continue
      addAvailableTools(srv.tools)
    }

    // Built-in openclaude-memory is registered later into mcp-config.json, not
    // via config.mcpServers. Resolve the launch once here so the prompt
    // advertises its tools, then reuse the same result when writing mcp-config.
    // Fail-soft: resolveMcpMemoryLaunch calls process.cwd() and can throw
    // ENOENT: uv_cwd when the working directory has been deleted.
    let mcpLaunch: ReturnType<typeof resolveMcpMemoryLaunch> = null
    try {
      mcpLaunch = resolveMcpMemoryLaunch(this.opts.config.auth.claudeCodePath, {
        fallback: 'npx-tsx',
      })
    } catch (err) {
      runnerLog.warn(
        'failed to resolve built-in mcp-memory launch',
        { sessionKey: this.opts.sessionKey, agentId: this.opts.agentId },
        err,
      )
    }
    const projectedMcpTools = projectCcbMcpAvailability({
      configuredTools: [...availableMcpTools],
      mcpLaunch,
      skillEvalMode: this.opts.skillEvalMode,
      skillTrainRunId: this.opts.skillTrainRunId,
      projectSearchEnabled: isProjectSearchEnabled(process.env),
    })

    // (Marketplace skills/agents are reconciled deterministically in
    //  dispatchInbound BEFORE agent resolution — earlier in the same turn than
    //  this spawn — so the hub overlay is already fresh here. mcp-memory also kicks
    //  a background sync on startup. All call the same idempotent reconcile.)

    // Build merged extra system prompt via structured prompt slots
    this._promptIntelligentUi = undefined
    try {
      const promptResult = await buildPromptContext({
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        persona: this.opts.persona,
        identityCompat: this.opts.identityCompat?.assets,
        // CCB extra-prompt is this runner only. Force a CCB provider so ENV
        // slot user_tz follows OPENCLAUDE_CCB_TZ, not OC_USER_TZ=Asia/Shanghai.
        provider: effectiveProvider === 'claude-subscription' ? 'claude-subscription' : 'ccb',
        model: this.opts.model,
        modelSupportsVision: this.currentExecutionDescriptor?.supportsVision,
        availableMcpTools: projectedMcpTools,
        // 把当前 effort 传进 slot builder 决定是否注入"科研模式守则"。
        // effort 切换本就会 recycle subprocess,新 runner 启动时会重建 extra-prompt.md。
        effortLevel: this.opts.effortLevel,
        // Phase 5:GitHub repo 当前快照(none / cloning / ready / failed) — 决定是否注入 REPO slot。
        repoSnapshot,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
        sessionId: this.opts.sessionId,
        projectId: this.opts.projectId,
        cacheLayout: usesStaticFirstPromptLayout(resolveCcbHarness(this.opts.harness), this.opts.boxResidentCc)
          ? 'static-first'
          : 'legacy',
      })
      const cwdDecision = decideEngineCwd({
        agentBaseDir: this.opts.agentBaseDir,
        repoSnapshot,
        projectBound: Boolean(this.opts.projectId),
        desktopWorkspaceDir: resolveDesktopWorkspaceDir(),
      })
      await persistRunContextSnapshot({
        descriptor: this.opts.runContext,
        applied: promptResult.applied,
        promptContentSha256: promptResult.contentSha256,
        frozen: promptResult.frozenProjectContext,
        cwd: cwdDecision.cwd,
        cwdSource: cwdDecision.source,
        sessionRepoOverlay: cwdDecision.sessionRepoOverlay,
      })
      this._promptIntelligentUi = promptResult.intelligentUi ?? false
      const goalPrompt = renderCcbGoalPrompt(this.platformGoal)
      const mergedPrompt = [promptResult.content, goalPrompt].filter(Boolean).join('\n\n')
      if (mergedPrompt) {
        const path = resolve(sessionDir, 'extra-prompt.md')
        writeFileSync(path, mergedPrompt)
        out.extraPromptFile = path
      }
      const mergedPromptSha256 = createHash('sha256').update(mergedPrompt).digest('hex')
      runnerLog.info('prompt_context_built', {
        sessionKey: this.opts.sessionKey,
        agentId: this.opts.agentId,
        backend: 'ccb',
        prompt_bytes: Buffer.byteLength(mergedPrompt, 'utf8'),
        prompt_sha256: mergedPromptSha256.slice(0, 12),
        board_project_id: this.opts.runContext?.boardProjectId ?? this.opts.projectId ?? null,
      })
      // observability:MODEL_HINT 命中(per-model 行为补丁注入)→ structured log + prom counter。
      // 不打 prompt 原文(可能含敏感引导),只记 sha256[:8] + bytes。
      // 关键安全约束:label 与 log 字段都只用 hint.meta.model_id(provider 已 canonicalize),
      // 不携带 spawn 入参的 raw model — 后者外部可控,用作 label 会撑爆 Prom counter
      // cardinality(观测面 DoS),作为日志字段同样会污染按字段建索引的日志后端。
      // 需要 raw → canonical 的对应关系时,用 sessionKey/agentId 与上下文 launch log 关联。
      const hint = promptResult.applied.find((s) => s.name === 'MODEL_HINT')
      const canonicalModelId = hint?.meta?.model_id
      if (hint && canonicalModelId) {
        runnerLog.info('model_hint_applied', {
          sessionKey: this.opts.sessionKey,
          agentId: this.opts.agentId,
          model_id: canonicalModelId,
          backend: 'ccb',
          hint_bytes: hint.bytes,
          hint_sha256: hint.sha256.slice(0, 8),
        })
        modelHintAppliedTotal.inc({ model_id: canonicalModelId, backend: 'ccb' })
      }
    } catch (err) {
      if (this.opts.identityCompat?.assets) throw err
      runnerLog.warn(
        'failed to build extra prompt',
        { sessionKey: this.opts.sessionKey, agentId: this.opts.agentId },
        err,
      )
    }

    // Write MCP config pointing at the mcp-memory stdio server
    // and any user-configured MCP servers (vision / search / image-gen / …).
    try {
      const mcpServers: Record<string, any> = {}

      // ── Built-in: openclaude-memory (L1/L2/L3 learning loop) ──
      // Path resolution shared with codexLaunchOverrides so ccb / codex / app-server
      // all launch the same bundled server (prebuilt CJS when the release built
      // it, historical npx+tsx otherwise). Note: env construction below
      // is intentionally NOT shared (v3 subprocessRunner has tighter
      // OPENCLAUDE_HOME semantics — only forward when host process actually
      // set it; codex side passes empty-string default).
      // mcpLaunch was resolved above so availableMcpTools matches this config.
      if (mcpLaunch) {
        const delegateContextFile = resolve(sessionDir, 'delegate-context')
        writeFileSync(
          delegateContextFile,
          `${issueDelegateContextToken({
            agentId: this.opts.agentId,
            sessionKey: this.opts.sessionKey,
            depth: this.opts.delegationDepth ?? 0,
          })}\n`,
          { mode: 0o600 },
        )
        this.delegateContextFile = delegateContextFile
        mcpServers['openclaude-memory'] = {
          type: 'stdio',
          command: mcpLaunch.command,
          args: mcpLaunch.args,
          env: {
            OPENCLAUDE_AGENT_ID: this.opts.agentId,
          OC_AGENT_ID: this.opts.agentId,
          ...identityCompatEnvironment(this.opts.identityCompat),
            ...(this.opts.projectId ? { OPENCLAUDE_PROJECT_ID: this.opts.projectId } : {}),
            // P5a: project_search is listed only when both flags are on; pass them
            // explicitly so the MCP list matches the prompt's tool projection.
            ...(isProjectSearchEnabled(process.env)
              ? { OC_PROJECT_CONTEXT: '1', OC_P5_PROJECT_SEARCH: '1' }
              : {}),
            // 2026-04-22: 只在 host 进程里确实 set 了 OPENCLAUDE_HOME 时才向下传 —— 空串
            // 会被 mcp-memory 的 paths.ts 当成"有值",与 `??` 语义冲突,让所有 memory/skill
            // 路径退化为相对 cwd 的路径,跨容器串。v3 容器由 entrypoint.ts 显式注入
            // `/home/agent/.openclaude`,个人版本机通常用默认 `~/.openclaude` 就行,
            // 传 undefined 让下游 `??` 正确兜底到 homedir。
            ...(process.env.OPENCLAUDE_HOME
              ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME }
              : {}),
            OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
            OPENCLAUDE_GATEWAY_PORT: String(this.opts.config.gateway.port),
            OPENCLAUDE_GATEWAY_TOKEN: this.opts.config.gateway.accessToken,
            OPENCLAUDE_DELEGATE_CONTEXT_FILE: delegateContextFile,
            OPENCLAUDE_DELEGATION_DEPTH: String(this.opts.delegationDepth ?? 0),
            ...(process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
              ? {
                  OPENCLAUDE_BASELINE_SKILLS_DIR:
                    process.env.OPENCLAUDE_BASELINE_SKILLS_DIR,
                }
              : {}),
            // SkillOpt training: expose the draft-only skill_propose tool bound to
            // this run. Only set for training sessions, so normal sessions never see it.
            ...(this.opts.skillEvalMode ? { OPENCLAUDE_SKILL_EVAL_MODE: '1' } : {}),
            ...(this.opts.skillEvalExclude
              ? { OPENCLAUDE_SKILL_EVAL_EXCLUDE: this.opts.skillEvalExclude }
              : {}),
            ...(this.opts.skillEvalDraft
              ? {
                  OPENCLAUDE_SKILL_EVAL_DRAFT_NAME: this.opts.skillEvalDraft.name,
                  OPENCLAUDE_SKILL_EVAL_DRAFT_DIR: this.opts.skillEvalDraft.dir,
                }
              : {}),
            ...(this.opts.skillTrainRunId
              ? { OPENCLAUDE_SKILL_TRAIN_RUN_ID: this.opts.skillTrainRunId }
              : {}),
          },
        }
      } else {
        runnerLog.warn('mcp-memory entry not found, skipping built-in MCP', {
          sessionKey: this.opts.sessionKey,
        })
      }

      // ── MCP servers: three-layer merge + toolset filtering ──
      // Layer 1: System shared tools (no provider field) — always included
      // Layer 2: Global provider-scoped MCPs (filtered by effectiveProvider)
      // Layer 3: Agent-specific MCPs (override same-id globals)
      // Toolset filter: if agent has toolsets configured, only include MCPs
      // whose id appears in at least one of the agent's toolset definitions.

      // Layer 1 + 2: Global MCPs
      for (const srv of this.opts.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== effectiveProvider) continue
        if (allowedMcpIds && !allowedMcpIds.has(srv.id)) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      // Layer 3: Agent-specific MCPs (override same id, bypass toolset filter)
      for (const srv of this.opts.agentMcpServers ?? []) {
        if (srv.enabled === false) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      // Browser is no longer an MCP. The oc-browser launcher isolates the
      // official Playwright CLI registry/profile per Agent.

      if (Object.keys(mcpServers).length > 0) {
        const mcpPath = resolve(sessionDir, 'mcp-config.json')
        writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2))
        out.mcpConfigFile = mcpPath
      }
    } catch (err) {
      runnerLog.warn(
        'failed to write mcp config',
        { sessionKey: this.opts.sessionKey, agentId: this.opts.agentId },
        err,
      )
    }

    try {
      const settingsPath = resolve(sessionDir, 'settings.json')
      atomicWriteJsonFile(settingsPath, buildCcbSessionSettings(buildCcbEfficiencySettings()), 0o600)
      out.settingsFile = settingsPath
    } catch (err) {
      runnerLog.warn(
        'failed to write CCB session settings',
        { sessionKey: this.opts.sessionKey, agentId: this.opts.agentId },
        err,
      )
    }

    return out
  }

  // 发送权限审批响应 — CCB 在 stdio 模式下等待 control_response
  sendPermissionResponse(requestId: string, response: PermissionResponse): boolean {
    if (!this.proc) return false
    try {
      const msg = {
        type: 'control_response',
        response: {
          request_id: requestId,
          subtype: 'success',
          response,
        },
      }
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** Read-only snapshot of telemetry drop diagnostics. */
  getTelemetryDiagnostics(): { missingSessionIdCount: number } {
    return { missingSessionIdCount: this.missingSessionIdCount }
  }

  // 发送 interrupt control request — CCB 会中止当前 turn
  interrupt(): boolean {
    if (!this.proc) return false
    try {
      const req = {
        type: 'control_request',
        request_id: `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        request: { subtype: 'interrupt' },
      }
      this.proc.stdin.write(`${JSON.stringify(req)}\n`)
      return true
    } catch {
      return false
    }
  }

  /**
   * Official Claude Code (`official-cc` harness) answers a cooperative Stop
   * with one `aborted_streaming` result and then exits 1 on its own a few
   * seconds later. Between those two points the process is still alive, so a
   * follow-up submit() would happily write into it and then observe the
   * exit(1) as a RUNNER_CRASHED terminal for the new turn.
   *
   * Detach the current process generation right away: `this.proc` is dropped
   * so `isRunning` reports false and the next submit() spawns a fresh CLI
   * (--resume keeps the transcript). The old process keeps its stdout listener
   * (identity-guarded) and gets its own bounded reaper so a CLI that never
   * exits cannot leak. The trailing exit is already classified as an expected
   * recycle by `_isExpectedOfficialClaudeAbortExit`; because `this.proc` no
   * longer points at it, that exit is also not forwarded as a runner 'exit'.
   */
  private retireOfficialAbortedProcess(): void {
    const proc = this.proc
    if (!proc) return
    runnerLog.info('official-cc abort result observed; retiring process generation', {
      sessionKey: this.opts.sessionKey,
      pid: proc.pid,
    })
    // The exit handler and the stdout-close handler both bail on
    // `this.proc !== proc`; the stdout-close handler still resolves the drain
    // barrier captured for this generation.
    this.proc = null
    this.spawnedExecutionDescriptor = undefined
    this._boundRepoBinding = null
    this.closed = true
    try { proc.stdin.end() } catch {}
    const reaper = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        runnerLog.warn('official-cc did not exit after abort result; killing process group', {
          sessionKey: this.opts.sessionKey,
          pid: proc.pid,
        })
        killRunnerProcessGroup(proc, 'SIGKILL')
      }
    }, runnerShutdownTimeoutMs(
      'OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS',
      RUNNER_SHUTDOWN_GRACE_DEFAULT_MS,
    ))
    reaper.unref?.()
    proc.once('exit', () => clearTimeout(reaper))
  }

  /** Remove the session's temp directory (extra-prompt.md, mcp-config.json, …). */
  private cleanupSessionDir(): void {
    if (this.sessionDir) {
      try { rmSync(this.sessionDir, { recursive: true, force: true }) } catch {}
      this.sessionDir = null
      this.advisorHomeDir = null
      this.advisorConfigDir = null
    }
    this.delegateContextFile = null
  }

  private consultTurnBinding:
    | { turnKey: string; turnIndex: number; configVersion: string }
    | undefined
  private pendingConsultRespawn = false

  setConsultTurn(
    binding: { turnKey: string; turnIndex: number; configVersion: string } | undefined,
  ): void {
    const prev = this.consultTurnBinding?.turnKey
    this.consultTurnBinding = binding
    if (binding && prev && prev !== binding.turnKey && this.proc) {
      this.pendingConsultRespawn = true
    }
  }

  /** Refresh caller binding at the actual turn boundary, not process spawn. */
  private refreshDelegateContext(traceId?: string): void {
    if (!this.delegateContextFile) return
    const consult = this.consultTurnBinding
    const token = consult
      ? issueConsultTurnToken({
          agentId: this.opts.agentId,
          sessionKey: this.opts.sessionKey,
          depth: this.opts.delegationDepth ?? 0,
          traceId,
          turnKey: consult.turnKey,
          turnIndex: consult.turnIndex,
          collabMode: 'advisor',
          configVersion: consult.configVersion,
        })
      : issueDelegateContextToken({
          agentId: this.opts.agentId,
          sessionKey: this.opts.sessionKey,
          depth: this.opts.delegationDepth ?? 0,
          traceId,
        })
    writeFileSync(this.delegateContextFile, `${token}\n`, { mode: 0o600 })
  }

  /** Forward a fully-drained child exit only while that exact child still owns
   * runner state. Kept as one method so the late-exit race is directly
   * regression-testable without spawning a real CCB process. */
  private _forwardDrainedExitForProcess(
    proc: ChildProcessWithoutNullStreams,
    info: RunnerExitInfo,
  ): boolean {
    if (this.proc !== proc) {
      runnerLog.info('stale drained subprocess exit ignored', {
        sessionKey: this.opts.sessionKey,
        code: info.code,
        signal: info.signal,
      })
      return false
    }
    this.emit('exit', info)
    if (this.proc === proc) this.proc = null
    return true
  }

  async shutdown(): Promise<void> {
    this.currentTurnHeaders = undefined
    // Drop shared in-flight start so a hung preheat cannot be reused by submit().
    this._startEpoch += 1
    this._startPromise = null
    this.starting = false
    // Always clean up the session directory, even if there is no live process
    // (failed starts, already-exited runners, crash paths).
    if (!this.proc) {
      // Phase 5:无活进程,binding 也跟着清。否则 start 在 starting 中 throw 后留下
      // stale binding,下次 isRunning=false 但 binding 还在,sessionManager 决策表会读错。
      this._boundRepoBinding = null
      this.cleanupSessionDir()
      return
    }
    this.shuttingDown = true
    // Who is recycling a live engine process is the single most useful fact
    // when a turn later terminates as `子进程被信号 SIGKILL 终止`; the caller
    // chain is otherwise invisible in production logs.
    runnerLog.info('subprocess shutdown requested', {
      sessionKey: this.opts.sessionKey,
      pid: this.proc.pid,
      harness: this.opts.harness ?? 'ccb',
      origin: _shutdownOriginFrames(new Error().stack),
    })
    try {
      this.proc.stdin.end()
    } catch {}
    const proc = this.proc
    // ChildProcess 'close' is emitted only after every stdio stream closes.
    // Waiting for 'exit' used to let shutdown resolve while paid stdout bytes
    // were still queued in Node, allowing callers to freeze a partial tape.
    // The wait must also be terminal: a descendant can otherwise retain the
    // pipe forever even after the direct child exits.
    let resolveClose!: () => void
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve })
    const onClose = () => resolveClose()
    proc.once('close', onClose)
    let closed = await waitForCloseWithin(
      closePromise,
      runnerShutdownTimeoutMs(
        'OPENCLAUDE_RUNNER_SHUTDOWN_GRACE_MS',
        RUNNER_SHUTDOWN_GRACE_DEFAULT_MS,
      ),
    )
    if (!closed) {
      killRunnerProcessGroup(proc, 'SIGKILL')
      closed = await waitForCloseWithin(
        closePromise,
        runnerShutdownTimeoutMs(
          'OPENCLAUDE_RUNNER_SHUTDOWN_FINAL_DRAIN_MS',
          RUNNER_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS,
        ),
      )
    }
    if (!closed) {
      proc.removeListener('close', onClose)
      runnerLog.error('subprocess close did not arrive after process-group SIGKILL', {
        sessionKey: this.opts.sessionKey,
        pid: proc.pid,
      })
      // Preserve process ownership and the stdout parser until the real close
      // boundary. Late bytes from a descendant holding the pipe remain part of
      // this turn; the existing stdout-close handler will forward the terminal
      // event only after they have all been parsed. Do cleanup in the
      // background instead of detaching and losing them.
      proc.once('close', () => {
        if (this.proc === proc) this.proc = null
        this.spawnedExecutionDescriptor = undefined
        this.spawnedOfficialHeaderFingerprint = undefined
        this.closed = true
        this.shuttingDown = false
        this._boundRepoBinding = null
        this.cleanupSessionDir()
      })
      return
    }
    if (this.proc === proc) this.proc = null
    this.spawnedExecutionDescriptor = undefined
    this.spawnedOfficialHeaderFingerprint = undefined
    this.closed = true
    this.shuttingDown = false
    // Phase 5:本进程已死,清掉 ready binding。下次 start() 会按当时 repo state 重新评估。
    this._boundRepoBinding = null
    this.cleanupSessionDir()
  }

  /** Capture-by-value barrier for the current process generation. */
  waitForOutputDrain(): Promise<void> {
    return this.outputDrainPromise
  }
}
