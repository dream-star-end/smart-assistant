import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { McpServerConfig, OpenClaudeConfig } from '@openclaude/storage'
import { resolveOfficialClaudePath } from './claudeCli.js'
import { resolveMcpMemoryEntry } from './codexLaunchOverrides.js'
import { createLogger } from './logger.js'
import { buildPromptContext } from './promptSlots.js'
import { PROXY_ENV_KEYS } from './proxyEnv.js'
import { type TerminalBackend, createBackend } from './terminalBackend.js'

const runnerLog = createLogger({ module: 'subprocessRunner' })

// ───────────────────────────────────────────────
// SubprocessRunner
//
// 给单个 sessionKey 长驻一个官方 Claude Code 子进程(`claude`)。
// 命令行:
//   claude -p \
//     --input-format=stream-json \
//     --output-format=stream-json \
//     --include-partial-messages \
//     --permission-prompt-tool stdio \
//     [--model <model>] [--effort <level>] \
//     [--resume <sessionId>] \
//     [--append-system-prompt-file <persona>] \
//     [--mcp-config <file>] [--permission-mode <mode>] \
//     [--add-dir <cwd>]   (variadic — kept last)
//
// 我们写入 stdin 一行 JSON(SDK user message),从 stdout 读流式 JSONL(SDK 消息流)。
// 官方 claude 自己处理 auth(订阅 OAuth / API key)、工具循环、压缩、CLAUDE.md。
// 权限走 stdio control 协议:claude 在 stdout 发 control_request(can_use_tool),
// gateway 桥接到前端审批 UI 后,经 stdin 回 control_response(参见 sendPermissionResponse)。
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
  // Optional effort level passed via the official `--effort <level>` flag.
  // When undefined, no flag is set and claude falls back to its model-default
  // effort. Only set values claude recognises — 'low'|'medium'|'high'|'xhigh'|'max'.
  effortLevel?: string
  /**
   * Effective egress proxy URL for this claude subprocess (per-agent override
   * resolved against the global config in `sessionManager`).
   *
   * Non-empty → 4 PROXY env keys (HTTPS_PROXY/HTTP_PROXY + lowercase) are
   * injected over whatever the gateway process env carries. Empty / undefined
   * → no override; claude inherits the gateway's own env (typically the systemd
   * `HTTPS_PROXY`). This is the deliberate asymmetry with codex runners —
   * see `OpenClaudeConfig.proxyUrl` docstring in storage/config.ts for the
   * rationale (codex stays explicit-only, the chat engine keeps its historical
   * inherit behaviour so the operator's systemd carve-outs / NO_PROXY remain
   * in effect).
   *
   * Caller is responsible for normalising whitespace / empty values
   * (`normalizeProxyUrl` in `proxyEnv.ts`).
   */
  proxyUrl?: string
}

// 官方 claude 输出的 SDK message 类型(简化):兼容 stream-json 输出
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

/** Permission response from the user (sent back to claude as control_response) */
export type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }

/**
 * Inputs for `buildClaudeCliArgs`. Everything that influences the subprocess's
 * CLI argv lives here so the argv construction is a pure function — trivially
 * unit-testable, no side effects, no file I/O.
 */
export interface ClaudeCliArgsInput {
  model?: string
  /** Effort level → official `--effort <level>` flag ('low'|'medium'|'high'|'xhigh'|'max'). */
  effortLevel?: string
  permissionMode?: string
  extraPromptFile?: string
  mcpConfigFile?: string
  addDir?: string
  resumeSessionId?: string | null
}

/**
 * Build the argv array that we pass to the official `claude` subprocess.
 *
 * IMPORTANT invariant: `--permission-prompt-tool stdio` is always present,
 * regardless of `permissionMode`. Interactive tools (AskUserQuestion,
 * ExitPlanMode, …) stay ask-immune even under bypassPermissions; the stdio
 * permission-prompt channel is how claude emits `can_use_tool` control_requests
 * on stdout that the gateway bridges to the web frontend. Without it those asks
 * have no responder and surface as tool errors.
 */
export function buildClaudeCliArgs(input: ClaudeCliArgsInput): string[] {
  const {
    model,
    effortLevel,
    permissionMode,
    extraPromptFile,
    mcpConfigFile,
    addDir,
    resumeSessionId,
  } = input
  const args: string[] = [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
  ]
  if (model) args.push('--model', model)
  // Effort moved from CCB's CLAUDE_CODE_EFFORT_LEVEL env to the official
  // `--effort` flag. Omitted → claude uses its model-default effort.
  if (effortLevel) args.push('--effort', effortLevel)
  if (permissionMode) {
    args.push('--permission-mode', permissionMode)
    // bypassPermissions 需要配合 --dangerously-skip-permissions 才真正放行所有工具
    if (permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    }
  }
  // See function JSDoc: stdio prompting must be enabled in ALL modes so claude
  // emits `can_use_tool` control_requests on stdout that the gateway bridges
  // to the web frontend. Required even under bypassPermissions for
  // interactive tools like AskUserQuestion.
  args.push('--permission-prompt-tool', 'stdio')
  // Single merged prompt file: persona + identity + platform + skills + memory
  // (Cannot pass --append-system-prompt-file twice; Commander takes last value only)
  if (extraPromptFile) args.push('--append-system-prompt-file', extraPromptFile)
  // Wire up MCP memory/skills/search server
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  // --add-dir LAST: official claude declares it variadic (`<directories...>`),
  // so it must not be followed by stray tokens or they're swallowed as extra
  // dirs. (The old CCB fork also took a trailing '' prompt placeholder; official
  // claude reads the prompt from stdin in stream-json mode and needs none — a
  // trailing '' would be eaten by --add-dir as an empty path and warned on.)
  if (addDir) args.push('--add-dir', addDir)
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

  /** Current model (used by sessionManager.submit to detect a per-session model
   *  override before deciding whether to recycle the subprocess). */
  get model(): string | undefined {
    return this.opts.model
  }

  /** Update the model. Like effort, the new value only takes effect on the next
   *  spawn (buildClaudeCliArgs reads opts.model at start()), so the caller must
   *  shutdown() the current subprocess; the next submit() auto-respawns with it. */
  setModel(model: string | undefined): void {
    this.opts.model = model
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
      // Resolve the official `claude` binary. Config override wins, else the
      // shared resolver (same authority the interactive PTY uses). Only
      // sanity-check absolute paths; a bare `claude` is resolved via PATH at
      // spawn time.
      const claudeBin = config.auth.claudeCliPath?.trim() || resolveOfficialClaudePath()
      if (isAbsolute(claudeBin) && !existsSync(claudeBin)) {
        this.starting = false
        throw new Error(
          `Official Claude Code binary not found: ${claudeBin}. Install it (see onboard) or set OPENCLAUDE_OFFICIAL_CLAUDE_PATH.`,
        )
      }

      // ─── L1/L2/L3: prepare learning-loop context for the subprocess ───
      let learningContext: Awaited<ReturnType<typeof this.buildLearningContext>>
      try {
        learningContext = await this.buildLearningContext()
      } catch (err) {
        this.starting = false
        throw err
      }

      // ── Provider-aware auth injection ──
      // claude auth priority: ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN >
      // ~/.claude/.credentials.json / settings.json. We inject the right env per
      // provider so claude routes to the correct API.
      const providerEnv: Record<string, string> = {}
      const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

      if (effectiveProvider === 'claude-subscription') {
        // Claude subscription: inject OAuth token, route to Anthropic API.
        if (this.opts.config.auth.claudeOAuth?.accessToken) {
          // Official claude reads CLAUDE_CODE_OAUTH_TOKEN from env. A gateway-side
          // token refresh is materialised into config; a running subprocess keeps
          // its spawn-time token until it restarts — the 401/AUTH_ERROR retry path
          // (sessionManager) recycles it when the old token expires mid-turn.
          // (We no longer ship the CCB-only OPENCLAUDE_CLAUDE_OAUTH_TOKEN_FILE
          // hot-reload sidecar; a token refresh costs at most one 401 round-trip.)
          providerEnv.CLAUDE_CODE_OAUTH_TOKEN = this.opts.config.auth.claudeOAuth.accessToken
        }
        // Clear any inherited provider vars so nothing redirects Claude requests
        // away from Anthropic. Provider isolation relies on (a) this env clearing
        // and (b) the host's ~/.claude/settings.json carrying no provider `env`
        // block. (We previously passed `--setting-sources project,local` to mimic
        // CCB's PROVIDER_MANAGED_BY_HOST, but that both excluded legitimate user
        // settings AND collapsed to a no-op when the agent cwd equals $HOME — so
        // project settings == user settings. Dropped as a fragile half-measure.)
        providerEnv.ANTHROPIC_BASE_URL = ''
        providerEnv.ANTHROPIC_AUTH_TOKEN = ''
        providerEnv.ANTHROPIC_MODEL = ''
      } else if (effectiveProvider === 'codex' || effectiveProvider === 'openai') {
        // OpenAI/Codex: use Codex OAuth token via an Anthropic-compatible proxy.
        if (this.opts.config.auth.codexOAuth?.accessToken) {
          providerEnv.ANTHROPIC_AUTH_TOKEN = this.opts.config.auth.codexOAuth.accessToken
          // Leave ANTHROPIC_BASE_URL unset to let settings.json / env provide it.
        }
        // Don't inject Claude OAuth — that would override the Codex token.
      } else {
        // MiniMax / DeepSeek / custom provider: DON'T inject any OAuth token.
        // Let claude fall through to ~/.claude/.credentials.json / settings.json,
        // which carry the active subscription (or a provider's
        // Anthropic-compatible ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN).
        // This is the "default" path — credentials/settings control routing.
      }

      const args = buildClaudeCliArgs({
        model: this.opts.model,
        effortLevel: this.opts.effortLevel,
        permissionMode: this.opts.permissionMode,
        extraPromptFile: learningContext.extraPromptFile,
        mcpConfigFile: learningContext.mcpConfigFile,
        addDir: this.opts.cwd,
        resumeSessionId: this.currentSessionId,
      })

      // Per-agent / global egress proxy override. Non-empty wins over any
      // inherited process.env. Empty / undefined → no override, claude inherits
      // whatever the gateway process env carries (typically systemd
      // HTTPS_PROXY). All four common spellings are set in lockstep so Rust
      // reqwest / Node undici / shelled-out tools all see the same value.
      const proxyEnv: Record<string, string> = {}
      if (this.opts.proxyUrl) {
        for (const key of PROXY_ENV_KEYS) proxyEnv[key] = this.opts.proxyUrl
      }

      // Fail fast on the Docker terminal backend: its volume-mount + command
      // semantics were designed around the vendored CCB install dir (mounting the
      // source tree at /opt/ccb and running `bun`/`node` against it). The official
      // `claude` binary isn't present in that container layout, so spawning it via
      // DockerBackend would silently break. Local backend is the supported path;
      // re-enable Docker only once the mount/command semantics are redefined for
      // the official binary.
      if (this.opts.config.terminal?.type === 'docker') {
        this.starting = false
        throw new Error(
          'Docker terminal backend is not supported with the official Claude Code engine yet ' +
            "(its /opt/ccb mount assumed the removed in-repo fork). Use terminal.type 'local'.",
        )
      }

      let proc: ReturnType<TerminalBackend['spawn']>
      try {
        const backend: TerminalBackend = createBackend(this.opts.config.terminal)
        proc = backend.spawn({
          command: claudeBin,
          args,
          // Run in the agent's real working directory: official claude is a
          // self-contained binary, so (unlike the old vendored fork that had to
          // run from its own source dir) we let it discover CLAUDE.md / relative
          // paths from the agent's cwd. `--add-dir` still grants access.
          cwd: this.opts.cwd,
          agentCwd: this.opts.cwd, // agent's real working directory (for Docker volume mount)
          env: {
            ...process.env,
            ...providerEnv,
            ...proxyEnv,
            OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
            OPENCLAUDE_AGENT_ID: this.opts.agentId,
            // Effort is passed via the official `--effort` flag now (see
            // buildClaudeCliArgs). Blank out any inherited CLAUDE_CODE_EFFORT_LEVEL
            // so a gateway-process env can't silently override the flag.
            CLAUDE_CODE_EFFORT_LEVEL: '',
            IS_SANDBOX: '1',
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
    if (this._lastStartAt > 0 && now - this._lastStartAt >= SubprocessRunner.STABLE_UPTIME_MS) {
      this._consecutiveCrashes = 0
    }
    this._consecutiveCrashes++
    const expBackoff = SubprocessRunner.BACKOFF_BASE_MS * 2 ** (this._consecutiveCrashes - 1)
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
      const lineBytes = (firstLineConsumesBuf ? this.stdoutBufBytes : 0) + tailBytes
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
          // Always update session ID (claude may report a new one after --resume)
          if (msg.session_id && msg.session_id !== this.currentSessionId) {
            this.currentSessionId = msg.session_id
            this.emit('session_id', this.currentSessionId)
          }
          this.emit('message', msg)
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
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          proc?.kill('SIGKILL')
        }
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
      const promptResult = await buildPromptContext({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: this.opts.agentProvider ?? this.opts.config.provider,
        model: this.opts.model,
        // 把当前 effort 传进 slot builder 决定是否注入"科研模式守则"。
        // effort 切换本就会 recycle subprocess,新 runner 启动时会重建 extra-prompt.md。
        effortLevel: this.opts.effortLevel,
      })
      if (promptResult.content) {
        const path = resolve(sessionDir, 'extra-prompt.md')
        writeFileSync(path, promptResult.content)
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
      // Resolution shared with codex runners via `resolveMcpMemoryEntry()` so
      // both backends always agree on which bundled mcp-memory to spawn.
      const mcpEntry = resolveMcpMemoryEntry(this.opts.config.auth.claudeCodePath)
      if (mcpEntry) {
        mcpServers['openclaude-memory'] = {
          type: 'stdio',
          command: 'npx',
          args: ['tsx', mcpEntry],
          env: {
            OPENCLAUDE_AGENT_ID: this.opts.agentId,
            OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME ?? '',
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

  // 发送 interrupt control request — claude 会中止当前 turn
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
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch {}
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
