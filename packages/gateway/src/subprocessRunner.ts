import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { type McpServerConfig, type OpenClaudeConfig, paths } from '@openclaude/storage'
import { createLogger } from './logger.js'
import { buildPromptContext } from './promptSlots.js'
import type { ExecutionTarget } from './remoteTarget.js'
import { type TerminalBackend, createBackend } from './terminalBackend.js'

const runnerLog = createLogger({ module: 'subprocessRunner' })

/**
 * 构造容器侧 OC_REMOTE_* env。
 *
 * 宿主侧 mux 路径:`/run/ccb-ssh/u<uid>/h<hid>/{ctl.sock,known_hosts}`
 * 容器侧挂载:supervisor 把 host `/run/ccb-ssh/u<uid>` bind ro 到容器 `/run/ccb-ssh`
 * 所以容器内可见路径:`/run/ccb-ssh/h<hid>/{ctl.sock,known_hosts}`
 *
 * 这里直接按 hostId 重新拼容器侧绝对路径,不复用 hostMeta.controlPath —— 后者
 * 是宿主路径,容器里不存在。
 */
function buildRemoteTargetEnv(target: ExecutionTarget | undefined): Record<string, string> {
  if (!target || target.kind !== 'remote') {
    // 确保切回 local 时 CCB 看到的是空串 —— 不留 inherit 下来的旧值
    return {
      OC_REMOTE_TARGET: '',
      OC_REMOTE_HOST_ID: '',
      OC_REMOTE_CTL_SOCK: '',
      OC_REMOTE_KNOWN_HOSTS: '',
      OC_REMOTE_USER: '',
      OC_REMOTE_HOST: '',
      OC_REMOTE_PORT: '',
      OC_REMOTE_WORKDIR: '',
    }
  }
  const { hostId, hostMeta } = target
  const containerBase = `/run/ccb-ssh/h${hostId}`
  return {
    OC_REMOTE_TARGET: 'ssh',
    OC_REMOTE_HOST_ID: hostId,
    OC_REMOTE_CTL_SOCK: `${containerBase}/ctl.sock`,
    OC_REMOTE_KNOWN_HOSTS: `${containerBase}/known_hosts`,
    OC_REMOTE_USER: hostMeta.username,
    OC_REMOTE_HOST: hostMeta.host,
    OC_REMOTE_PORT: String(hostMeta.port),
    OC_REMOTE_WORKDIR: hostMeta.remoteWorkdir,
  }
}

// ───────────────────────────────────────────────
// SubprocessRunner
//
// 给单个 sessionKey 长驻一个 CCB 子进程。
// CCB 命令行:
//   <runtime> <ccb-entry> -p \
//     --input-format=stream-json \
//     --output-format=stream-json \
//     --include-partial-messages \
//     [--resume <sessionId>] \
//     [--system-prompt-file <persona>] \
//     [--add-dir <cwd>] \
//     [--permission-mode <mode>]
//
// 我们写入 stdin 一行 JSON(SDK user message),从 stdout 读流式 JSONL(SDK 消息流)。
// CCB 自己处理 auth(订阅 OAuth / API key)、工具循环、压缩、CLAUDE.md。
// ───────────────────────────────────────────────

export interface SubprocessRunnerOpts {
  sessionKey: string
  agentId: string
  cwd: string
  config: OpenClaudeConfig
  persona?: string // 注入 system prompt 的文件
  model?: string
  permissionMode?: string
  resumeSessionId?: string // 续上之前的 CCB session
  // Per-agent overrides
  agentProvider?: string // 覆盖 config.provider
  agentMcpServers?: McpServerConfig[] // agent 专属 MCP servers
  agentToolsets?: string[] // resolved toolsets for this agent (filters MCP servers)
  delegationDepth?: number // current delegation recursion depth (0 = top-level)
  // Optional CCB effort level passed via env (CLAUDE_CODE_EFFORT_LEVEL).
  // When undefined, no env var is set and CCB falls back to its model-default
  // effort (typically "high" on Opus 4.7 per Anthropic API). Only set values
  // CCB recognises in EFFORT_LEVELS — currently 'low'|'medium'|'high'|'xhigh'|'max'.
  // Source-of-truth lives in claude-code-best/src/utils/effort.ts.
  effortLevel?: string
  /**
   * 执行目标。undefined / { kind:'local' } → CCB 所有工具在本地容器里执行(默认)。
   * { kind:'remote', ... } → 下次 spawn 时注入 OC_REMOTE_* env,CCB RemoteExecutor
   * 启用 ssh ControlMaster 分支。env 只在 spawn 时读,调用 setExecutionTarget()
   * 后需要 shutdown() 让下次 submit 触发重启才能生效 —— 与 setEffortLevel 同构。
   */
  executionTarget?: ExecutionTarget
}

// CCB 输出的 SDK message 类型(简化):兼容 stream-json 输出
export interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      is_error?: boolean
    }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
}

/** Permission response from the user (sent back to CCB as control_response) */
export type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }

/**
 * Inputs for `buildCcbCliArgs`. Everything that influences the subprocess's
 * CLI argv lives here so the argv construction is a pure function — trivially
 * unit-testable, no side effects, no file I/O.
 */
export interface CcbCliArgsInput {
  /** e.g. 'bun' or 'node' (maps to `run` vs `--experimental-strip-types`) */
  runtime: string
  /** Entry file path, e.g. src/entrypoints/cli.tsx */
  entry: string
  model?: string
  permissionMode?: string
  extraPromptFile?: string
  mcpConfigFile?: string
  addDir?: string
  resumeSessionId?: string | null
}

/**
 * Build the argv array that we pass to the CCB subprocess.
 *
 * IMPORTANT invariant: `--permission-prompt-tool stdio` is always present,
 * regardless of `permissionMode`. CCB's permissions.ts step 1e keeps
 * `requiresUserInteraction()` tools (AskUserQuestion, ExitPlanMode, …)
 * bypass-immune — they still return `behavior:'ask'` even in
 * bypassPermissions mode. Without a permission-prompt-tool, that ask falls
 * through `getCanUseToolFn`'s fallback branch in CCB's print.ts and
 * toolExecution.ts then treats the unresolved ask as a deny, surfacing the
 * tool's raw ask-message (e.g. "Answer questions?") as the tool error.
 *
 * Non-interactive tools are unaffected — step 2a's bypass-allow in
 * permissions.ts fires before any ask result is ever produced for them.
 */
export function buildCcbCliArgs(input: CcbCliArgsInput): string[] {
  const {
    runtime,
    entry,
    model,
    permissionMode,
    extraPromptFile,
    mcpConfigFile,
    addDir,
    resumeSessionId,
  } = input
  const args: string[] = [
    runtime === 'bun' ? 'run' : '--experimental-strip-types',
    entry,
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
  ]
  if (model) args.push('--model', model)
  if (permissionMode) {
    args.push('--permission-mode', permissionMode)
    // bypassPermissions 需要配合 --dangerously-skip-permissions 才真正放行所有工具
    if (permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
  }
  // See function JSDoc: stdio prompting must be enabled in ALL modes so CCB
  // emits `can_use_tool` control_requests on stdout that the gateway bridges
  // to the web frontend. Required even under bypassPermissions for
  // interactive tools like AskUserQuestion.
  args.push('--permission-prompt-tool', 'stdio')
  // Single merged prompt file: persona + identity + platform + skills + memory
  // (Cannot pass --append-system-prompt-file twice; Commander takes last value only)
  if (extraPromptFile) args.push('--append-system-prompt-file', extraPromptFile)
  // Wire up MCP memory/skills/search server
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile)
  if (addDir) args.push('--add-dir', addDir)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  // 必须给一个 prompt placeholder,CCB stream-json 会从 stdin 接管
  args.push('')
  return args
}

// Cap for in-memory stdout/stderr accumulation per runner. If CCB ever emits
// a chunk without newline (malformed output, corrupt base64, wedged write),
// the buffer can grow unboundedly and eat gigabytes of RSS. When we cross
// the limit we kill the subprocess and log "ccb.overflow".
//
// Configurable via OPENCLAUDE_CCB_MAX_STDOUT_BUF_BYTES (default 8 MiB,
// clamped to [1 MiB, 256 MiB]).
function readStdoutBufCap(): number {
  const raw = Number(process.env.OPENCLAUDE_CCB_MAX_STDOUT_BUF_BYTES)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.max(raw, 1 << 20), 256 << 20)
  }
  return 8 << 20
}
const MAX_STDOUT_BUF_BYTES = readStdoutBufCap()
const MAX_STDERR_BUF_BYTES = MAX_STDOUT_BUF_BYTES // same cap applies to stderr

export class SubprocessRunner extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  /**
   * Cached UTF-8 byte count of `stdoutBuf`. Updated incrementally on append
   * and line-flush so per-chunk cap checks are O(1) instead of O(len).
   */
  private stdoutBufBytes = 0
  /** Running byte count for stderr within a single "line" window — caps runaway stderr. */
  private stderrBufBytes = 0
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
  /** True once we force-killed due to buffer overflow; prevents double-kill. */
  private overflowKilled = false
  private sessionDir: string | null = null
  /** Timestamp of last stdout activity — used for liveness detection */
  public lastActivityAt: number = Date.now()

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

  /** Update config (e.g. after OAuth token refresh). Takes effect on next start(). */
  updateConfig(config: OpenClaudeConfig): void {
    this.opts.config = config
  }

  /** Current effort level (used by sessionManager.getOrCreate to detect changes
   *  before deciding whether to recycle the subprocess). */
  get effortLevel(): string | undefined {
    return this.opts.effortLevel
  }

  /** Update effort level. Caller is responsible for restarting the subprocess
   *  (via shutdown(); next submit() auto-restarts) for the new value to take
   *  effect — env vars are only read at process startup. */
  setEffortLevel(level: string | undefined): void {
    this.opts.effortLevel = level
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

  /** Current execution target (used by sessionManager to detect changes). */
  get executionTarget(): ExecutionTarget {
    return this.opts.executionTarget ?? { kind: 'local' }
  }

  /** Update execution target. Caller must restart the subprocess (shutdown()
   *  + next submit() auto-restarts) for OC_REMOTE_* env to be re-read. */
  setExecutionTarget(target: ExecutionTarget): void {
    this.opts.executionTarget = target
  }

  /** True if the subprocess is currently alive or being started */
  get isRunning(): boolean {
    return (this.proc !== null && !this.closed) || this.starting
  }

  async start(): Promise<void> {
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

    this.starting = true
    this.closed = false
    this.overflowKilled = false
    this.stdoutBuf = ''
    this.stdoutBufBytes = 0
    this.stderrBufBytes = 0

    // Wrap the entire setup in try/catch so ANY pre-spawn failure (config
    // resolution, buildLearningContext, backend.spawn, …) records a crash and
    // triggers backoff. Without this, a start() that throws before `this.proc`
    // is assigned would never bump _consecutiveCrashes, and the caller could
    // retry immediately and re-throw, burning CPU.
    try {
    const { config } = this.opts
    let ccbDir: string
    try {
      ccbDir = resolve(config.auth.claudeCodePath)
    } catch (err) {
      this.starting = false
      throw err
    }
    if (!existsSync(ccbDir)) {
      this.starting = false
      throw new Error(
        `Claude Code path not found: ${ccbDir}. Set auth.claudeCodePath in ~/.openclaude/openclaude.json`,
      )
    }
    const entry = config.auth.claudeCodeEntry ?? 'src/entrypoints/cli.tsx'
    const runtime = config.auth.claudeCodeRuntime ?? 'bun'

    // ─── L1/L2/L3: prepare learning-loop context for the subprocess ───
    let learningContext: Awaited<ReturnType<typeof this.buildLearningContext>>
    try {
      learningContext = await this.buildLearningContext()
    } catch (err) {
      this.starting = false
      throw err
    }

    const args = buildCcbCliArgs({
      runtime,
      entry,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      extraPromptFile: learningContext.extraPromptFile,
      mcpConfigFile: learningContext.mcpConfigFile,
      addDir: this.opts.cwd,
      resumeSessionId: this.currentSessionId,
    })

    // ── Provider-aware auth injection ──
    // CCB auth priority: ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN > settings.json
    // We must inject the right env vars per provider so CCB routes to the correct API.
    const providerEnv: Record<string, string> = {}
    const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

    if (effectiveProvider === 'claude-subscription') {
      // Claude subscription: inject OAuth token, route to Anthropic API
      //
      // CRITICAL: Tell CCB that the host owns provider routing.
      // Without this, CCB's managedEnv.ts will Object.assign settings.json env
      // (ANTHROPIC_BASE_URL=minimax, ANTHROPIC_AUTH_TOKEN=minimax_key) OVER our
      // spawn env, routing Claude requests to MiniMax instead of Anthropic.
      // With this flag, CCB strips provider vars from settings.json during load.
      providerEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      if (this.opts.config.auth.claudeOAuth?.accessToken) {
        providerEnv.CLAUDE_CODE_OAUTH_TOKEN = this.opts.config.auth.claudeOAuth.accessToken
        // Host is injecting its own Claude OAuth for direct Anthropic routing.
        // Wipe any inherited ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN so a user
        // settings.json can't redirect CCB to a Minimax-compatible endpoint and
        // steal OAuth-authed traffic. MANAGED_BY_HOST alone strips these from
        // settings-sourced env, but a stray export in the gateway's own shell
        // env could still bleed through — defense in depth.
        providerEnv.ANTHROPIC_BASE_URL = ''
        providerEnv.ANTHROPIC_AUTH_TOKEN = ''
        providerEnv.ANTHROPIC_MODEL = ''
      }
      // else: no host OAuth to inject — some upstream (e.g. v3 commercial
      // supervisor) has already put ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
      // into process.env at container-boot time, pointing CCB at the internal
      // proxy. Leave those alone; MANAGED_BY_HOST still protects against
      // settings.json overrides.
    } else if (effectiveProvider === 'codex' || effectiveProvider === 'openai') {
      // OpenAI/Codex: use Codex OAuth token via OpenAI-compatible endpoint
      // CCB doesn't natively support OpenAI, but OpenAI provides an Anthropic-compatible
      // proxy at https://api.openai.com/anthropic/ (or use a local proxy like LiteLLM)
      if (this.opts.config.auth.codexOAuth?.accessToken) {
        providerEnv.ANTHROPIC_AUTH_TOKEN = this.opts.config.auth.codexOAuth.accessToken
        // Note: OpenAI doesn't have an Anthropic-compatible endpoint by default.
        // Users need to configure a proxy (LiteLLM/OneAPI) or this won't work.
        // Leave ANTHROPIC_BASE_URL unset to let settings.json or env provide it.
      }
      // Don't inject Claude OAuth — that would override the Codex token
    } else {
      // MiniMax / DeepSeek / custom provider: DON'T inject any OAuth token.
      // Let CCB fall through to settings.json (which has ANTHROPIC_BASE_URL +
      // ANTHROPIC_AUTH_TOKEN pointing to the provider's Anthropic-compatible endpoint).
      // This is the "default" path — settings.json controls routing.
    }

    let proc: ReturnType<TerminalBackend['spawn']>
    try {
      const backend: TerminalBackend = createBackend(this.opts.config.terminal)
      proc = backend.spawn({
        command: runtime,
        args,
        cwd: ccbDir,
        agentCwd: this.opts.cwd, // agent's real working directory (for Docker volume mount)
        env: {
          ...process.env,
          ...providerEnv,
          OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
          OPENCLAUDE_AGENT_ID: this.opts.agentId,
          // Per-session effort level (xhigh / max from chat-mode pills, or
          // undefined to let CCB use its model-default — Opus 4.7 → high).
          // Empty string deletes any inherited CLAUDE_CODE_EFFORT_LEVEL so a
          // gateway-process env doesn't bleed into spawned CCBs.
          CLAUDE_CODE_EFFORT_LEVEL: this.opts.effortLevel ?? '',
          // Force all subagents/Bash runs to foreground so their execution
          // is visible inline in the web UI. Opus 4.7 was aggressively
          // choosing run_in_background=true for long tasks, which hid the
          // subagent's progress behind a single "Noted, continuing to wait"
          // message. This env var makes CCB strip run_in_background from the
          // Agent/Bash/PowerShell tool schemas at module load, so the model
          // can never select background mode.
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
          IS_SANDBOX: '1',
          FEATURE_VERIFICATION_AGENT: '1',
          // 远程执行目标:kind='remote' 时让 CCB RemoteExecutor 启用 ssh mux 分支。
          // 空串 = 本地执行(默认);OC_REMOTE_* 其余变量仅在 remote 分支设。
          // 容器里 ctl.sock 的真实路径是宿主侧 /run/ccb-ssh/u<uid>/h<hid>/ctl.sock,
          // bind 进容器后去掉 u<uid> 前缀 → /run/ccb-ssh/h<hid>/ctl.sock;
          // 因此这里把 hostMeta.controlPath/knownHostsPath 的 `/u<uid>` 部分
          // 剥掉后注入(substitute 宿主路径为容器内视图)。
          ...buildRemoteTargetEnv(this.opts.executionTarget),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // create process group so shutdown() can kill all children
      })
    } catch (err) {
      this.starting = false
      throw err
    }

    this.proc = proc as unknown as ChildProcessWithoutNullStreams
    // Emit BEFORE any stdout listener is attached, so subscribers (e.g. session
    // manager's per-CCB cost-tracker reset) run strictly before any 'message'
    // or 'session_id' event of the new process can arrive.
    //
    // `resumed` tells consumers whether CCB will restore historical state on
    // start. When --resume is passed CCB calls restoreCostStateForSession
    // which sets STATE.totalCostUSD back to the persisted cumulative — so the
    // gateway's per-session cost-delta baseline must NOT be reset to 0.
    this.emit('spawn', { resumed: !!this.currentSessionId })

    proc.stdin.on('error', (err) =>
      runnerLog.warn('stdin error', { sessionKey: this.opts.sessionKey }, err),
    )
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.handleStdout(chunk))

    proc.stderr.setEncoding('utf-8')
    this.stderrBufBytes = 0
    proc.stderr.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now() // stderr activity also counts as "alive"
      this.stderrBufBytes += Buffer.byteLength(chunk, 'utf8')
      // If stderr goes pathological (single burst > cap), kill to avoid RSS
      // blow-up from downstream listeners that might buffer all of it.
      if (this.stderrBufBytes > MAX_STDERR_BUF_BYTES) {
        this.handleBufferOverflow('stderr', this.stderrBufBytes)
        this.stderrBufBytes = 0
        return
      }
      // Reset counter on newline — stderr is usually line-oriented log output.
      if (chunk.includes('\n')) this.stderrBufBytes = 0
      this.emit('stderr', chunk)
    })

    proc.on('exit', (code, signal) => {
      this.proc = null
      this.closed = true
      // Use explicit shuttingDown flag (set by shutdown()) to distinguish
      // graceful shutdown from crash. Exit code alone is unreliable:
      // - SIGSEGV/SIGKILL → code=null but NOT graceful
      // - CCB may exit with non-0 code on normal termination
      const crashed = !this.shuttingDown
      this.shuttingDown = false
      if (crashed) {
        this._recordCrash()
      } else {
        // Graceful shutdown wipes any accumulated backoff — the operator is
        // in control, not a crash-loop, so the next start() should not be gated.
        // Also zero _lastStartAt so a post-restart crash can't consult a stale
        // "stable uptime" timestamp from this now-dead subprocess.
        this._consecutiveCrashes = 0
        this._backoffUntil = 0
        this._lastStartAt = 0
      }
      this.emit('exit', { code, signal, crashed })
    })

    proc.on('error', (err) => {
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
      this._recordCrash()
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
  private _recordCrash(): void {
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
    })
  }

  private handleStdout(chunk: string): void {
    this.lastActivityAt = Date.now()

    // We scan `chunk` in place WITHOUT doing `stdoutBuf += chunk` first.
    // For each complete line formed by `stdoutBuf + chunk[0..nl]` (first line)
    // or `chunk[prev..nl]` (subsequent lines), we check the byte length
    // BEFORE materializing the full line. Only the trailing partial (no
    // newline) is appended to `stdoutBuf`. This guarantees the in-memory
    // working set never exceeds MAX_STDOUT_BUF_BYTES even if the chunk itself
    // contains multiple oversized lines.
    let offset = 0
    let firstLineConsumesBuf = this.stdoutBufBytes > 0
    while (true) {
      const nlIdx = chunk.indexOf('\n', offset)
      if (nlIdx < 0) break

      const tail = chunk.slice(offset, nlIdx)
      const tailBytes = Buffer.byteLength(tail, 'utf8')
      const lineBytes =
        (firstLineConsumesBuf ? this.stdoutBufBytes : 0) + tailBytes
      if (lineBytes > MAX_STDOUT_BUF_BYTES) {
        this.handleBufferOverflow('stdout', lineBytes)
        this.stdoutBuf = ''
        this.stdoutBufBytes = 0
        return
      }

      // Materialize the full line (≤ cap bytes), emit parsed message
      let fullLine: string
      if (firstLineConsumesBuf) {
        fullLine = this.stdoutBuf + tail
        this.stdoutBuf = ''
        this.stdoutBufBytes = 0
        firstLineConsumesBuf = false
      } else {
        fullLine = tail
      }
      const trimmed = fullLine.trim()
      if (trimmed) {
        try {
          const msg = JSON.parse(trimmed) as SdkMessage
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

    // Trailing partial (no newline) — append to stdoutBuf after cap check.
    if (offset < chunk.length) {
      const trailing = offset === 0 ? chunk : chunk.slice(offset)
      const trailingBytes = Buffer.byteLength(trailing, 'utf8')
      const projected = this.stdoutBufBytes + trailingBytes
      if (projected > MAX_STDOUT_BUF_BYTES) {
        this.handleBufferOverflow('stdout', projected)
        this.stdoutBuf = ''
        this.stdoutBufBytes = 0
        return
      }
      this.stdoutBuf += trailing
      this.stdoutBufBytes += trailingBytes
    }
  }

  /**
   * Called when stdout or stderr accumulates beyond the buffer cap.
   * Emits an `overflow` event with details and kills the subprocess group.
   * Idempotent — a second trigger during the same kill window is a no-op.
   */
  private handleBufferOverflow(stream: 'stdout' | 'stderr', size: number): void {
    if (this.overflowKilled || this.closed) return
    this.overflowKilled = true
    const proc = this.proc
    const pid = proc?.pid
    const info = { stream, size, cap: MAX_STDOUT_BUF_BYTES, pid, sessionKey: this.opts.sessionKey }
    runnerLog.error('ccb.overflow — force-killing subprocess', info)
    this.emit('overflow', info)
    // Trigger an exit path: force-kill the process group so MCP children die too.
    try {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL') } catch { proc?.kill('SIGKILL') }
      } else {
        proc?.kill('SIGKILL')
      }
    } catch (err) {
      runnerLog.warn('overflow kill failed', { sessionKey: this.opts.sessionKey }, err)
    }
  }

  // 发送一条 user message。CCB stream-json 输入格式:每行一个 SDK user message JSON
  // content 可以是单个字符串(全文本),也可以是完整的 Anthropic content block 数组(支持图片/多模态)
  async submit(
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
  ): Promise<void> {
    if (!this.proc) await this.start()
    if (!this.proc) throw new Error('failed to start CCB subprocess')
    const content =
      typeof userTextOrBlocks === 'string'
        ? [{ type: 'text', text: userTextOrBlocks }]
        : userTextOrBlocks
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }
    try {
      this.proc.stdin.write(`${JSON.stringify(userMsg)}\n`)
    } catch (err: any) {
      runnerLog.warn('stdin write failed', { sessionKey: this.opts.sessionKey }, err)
    }
  }

  // ─── Build per-session learning-loop context files ───
  // Writes temp files under /tmp/openclaude-<sessionKey>-XXXXXX/:
  //   extra-prompt.md   — USER.md content + skill metadata digest
  //   mcp-config.json   — MCP server pointing at @openclaude/mcp-memory
  private async buildLearningContext(): Promise<{
    extraPromptFile?: string
    mcpConfigFile?: string
  }> {
    const out: { extraPromptFile?: string; mcpConfigFile?: string } = {}
    // Use mkdtempSync for a unique per-run directory: prevents a restarted runner
    // for the same sessionKey from racing with the old runner's shutdown cleanup.
    // Clean up any previous session directory before creating a new one
    // (guards against crash/retry scenarios where start() is called again).
    this.cleanupSessionDir()
    const safeDirName = this.opts.sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const sessionDir = mkdtempSync(resolve(tmpdir(), `openclaude-${safeDirName}-`))
    this.sessionDir = sessionDir

    // Build merged extra system prompt via structured prompt slots
    try {
      const promptContent = await buildPromptContext({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: this.opts.agentProvider ?? this.opts.config.provider,
        model: this.opts.model,
        // 把当前 effort 传进 slot builder 决定是否注入"科研模式守则"。
        // effort 切换本就会 recycle subprocess,新 runner 启动时会重建 extra-prompt.md。
        effortLevel: this.opts.effortLevel,
      })
      if (promptContent) {
        const path = resolve(sessionDir, 'extra-prompt.md')
        writeFileSync(path, promptContent)
        out.extraPromptFile = path
      }
    } catch (err) {
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
      const mcpServerEntry = resolve(
        new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'),
        '../../mcp-memory/src/index.ts',
      )
      const candidates = [
        mcpServerEntry,
        resolve(process.cwd(), 'packages/mcp-memory/src/index.ts'),
        resolve(
          this.opts.config.auth.claudeCodePath,
          '..',
          'openclaude/packages/mcp-memory/src/index.ts',
        ),
      ]
      const mcpEntry = candidates.find((p) => existsSync(p))
      if (mcpEntry) {
        mcpServers['openclaude-memory'] = {
          type: 'stdio',
          command: 'npx',
          args: ['tsx', mcpEntry],
          env: {
            OPENCLAUDE_AGENT_ID: this.opts.agentId,
            // 2026-04-22: 只在 host 进程里确实 set 了 OPENCLAUDE_HOME 时才向下传 —— 空串
            // 会被 mcp-memory 的 paths.ts 当成"有值",与 `??` 语义冲突,让所有 memory/skill
            // 路径退化为相对 cwd 的路径,跨容器串。v3 容器由 entrypoint.ts 显式注入
            // `/home/agent/.openclaude`,个人版本机通常用默认 `~/.openclaude` 就行,
            // 传 undefined 让下游 `??` 正确兜底到 homedir。
            ...(process.env.OPENCLAUDE_HOME
              ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME }
              : {}),
            OPENCLAUDE_GATEWAY_PORT: String(this.opts.config.gateway.port),
            OPENCLAUDE_GATEWAY_TOKEN: this.opts.config.gateway.accessToken,
            OPENCLAUDE_DELEGATION_DEPTH: String(this.opts.delegationDepth ?? 0),
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
      const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

      // Resolve toolset → allowed MCP server IDs
      const toolsetDefs = this.opts.config.toolsets
      const agentToolsets = this.opts.agentToolsets
      let allowedMcpIds: Set<string> | null = null // null = no filtering (all allowed)
      if (agentToolsets && agentToolsets.length > 0 && toolsetDefs) {
        allowedMcpIds = new Set<string>()
        for (const ts of agentToolsets) {
          const ids = toolsetDefs[ts]
          if (ids) for (const id of ids) allowedMcpIds.add(id)
        }
        // Built-in 'openclaude-memory' is always allowed regardless of toolset
        allowedMcpIds.add('openclaude-memory')
      }

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

      // Per-agent browser isolation: give each agent its own Chrome profile
      // to prevent "Browser is already in use" conflicts between agents.
      if (mcpServers.browser) {
        const browserArgs = [...(mcpServers.browser.args || [])]
        const hasUserDataDir = browserArgs.some((a: string) => a.startsWith('--user-data-dir'))
        if (!hasUserDataDir) {
          browserArgs.push('--user-data-dir', `/tmp/openclaude-browser-${this.opts.agentId}`)
          mcpServers.browser.args = browserArgs
        }
      }

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

  /** Remove the session's temp directory (extra-prompt.md, mcp-config.json, …). */
  private cleanupSessionDir(): void {
    if (this.sessionDir) {
      try { rmSync(this.sessionDir, { recursive: true, force: true }) } catch {}
      this.sessionDir = null
    }
  }

  async shutdown(): Promise<void> {
    // Always clean up the session directory, even if there is no live process
    // (failed starts, already-exited runners, crash paths).
    if (!this.proc) {
      this.cleanupSessionDir()
      return
    }
    this.shuttingDown = true
    try {
      this.proc.stdin.end()
    } catch {}
    const proc = this.proc
    const pid = proc.pid
    await new Promise<void>((res) => {
      const timer = setTimeout(() => {
        // Kill entire process group (including MCP subprocesses)
        try {
          if (pid) process.kill(-pid, 'SIGKILL') // negative pid = process group
        } catch {
          try {
            proc.kill('SIGKILL')
          } catch {}
        }
        res()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        res()
      })
    })
    this.proc = null
    this.closed = true
    this.cleanupSessionDir()
  }
}
