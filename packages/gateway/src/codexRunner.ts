import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
// Test-only override of the spawn used to launch `codex exec`. Production
// always reads the binding through `_spawnFn` so a test can inject a stub
// that captures args without forking a real subprocess. `__setCodexSpawnForTests`
// is the documented hook; calling it with `null` restores the default. Never
// call this from production code.
let _spawnFn: typeof spawn = spawn
export function __setCodexSpawnForTests(fn: typeof spawn | null): void {
  _spawnFn = fn ?? spawn
}
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { type CodexLaunchOverrides, buildCodexLaunchOverrides } from './codexLaunchOverrides.js'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'codexRunner' })

/**
 * Per-thread directory where codex CLI persists images created via the built-in
 * `image_gen` skill. threadId is sanitized: codex thread_ids are ULID-like
 * (alphanumeric + hyphens) but we sanitize defensively so future format drift
 * cannot escape the dir.
 *
 * Exported so codexAppServerRunner (and tests) can construct expected paths
 * consistently.
 */
export function _sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '')
}

/**
 * Copy a list of absolute image paths into OpenClaude's public generated/ dir.
 * Module-level helper so both the legacy exec runner (which scans a per-thread
 * dir) and the app-server runner (which gets `savedPath` directly on the
 * `imageGeneration` thread item) can use the same copy + naming strategy.
 *
 * Naming: `codex-${sanitizedThreadId}-${basename(srcPath)}` — the basename is
 * already a content-addressable hash from codex (`ig_<hash>.png`), and the
 * thread id prefix prevents cross-thread collisions in the shared public dir.
 *
 * Caller is expected to pre-resolve `srcPaths` to absolute filesystem paths.
 * Failures (ENOENT, EACCES, EROFS) are logged once at warn and surfaced via
 * `failedNames` so the caller can render an "image copy failed" line.
 */
export async function copyImagePathsToPublicDir(
  threadId: string,
  srcPaths: string[],
  dstDir: string,
): Promise<{
  copied: Array<{ srcPath: string; publicPath: string }>
  failedNames: string[]
}> {
  const safeThread = _sanitizeThreadId(threadId)
  try {
    await mkdir(dstDir, { recursive: true })
  } catch (err) {
    log.warn('codex image public dir mkdir failed', {
      dstDir,
      err: (err as Error).message,
    })
  }
  const copied: Array<{ srcPath: string; publicPath: string }> = []
  const failedNames: string[] = []
  for (const src of srcPaths) {
    const name = basename(src)
    const dst = join(dstDir, `codex-${safeThread}-${name}`)
    try {
      await copyFile(src, dst)
      copied.push({ srcPath: src, publicPath: dst })
    } catch (err) {
      log.warn('codex image copy failed', {
        src,
        dst,
        err: (err as Error).message,
      })
      failedNames.push(name)
    }
  }
  return { copied, failedNames }
}

// ───────────────────────────────────────────────
// CodexRunner
//
// Drop-in replacement for SubprocessRunner that routes an OpenClaude agent
// to OpenAI's codex CLI instead of CCB/Claude. One turn spawns one short
// `codex exec [resume] --json` process; between turns we keep the codex
// `thread_id` so multi-turn conversations preserve context.
//
// Emits the subset of SubprocessRunner events that sessionManager listens to:
//   session_id, spawn, exit, message.
// Telemetry/parse_error are emitted best-effort.
//
// Codex --json event types handled:
//   thread.started                → emit session_id
//   item.started  agent_message   → (ignore, wait for completed)
//   item.completed agent_message  → emit assistant text
//   item.started  command_execution → emit tool_use name=Bash
//   item.completed command_execution → emit tool_result
//   item.started  file_change      → emit tool_use name=Write/Edit
//   item.completed file_change     → emit tool_result
//   turn.completed                → emit result with usage
//
// Unknown item types are surfaced as generic tool_use with name="Codex:<type>"
// so the UI at least shows that *something* happened.
// ───────────────────────────────────────────────

export interface CodexRunnerOpts {
  sessionKey: string
  agentId: string
  cwd: string
  /** Previously captured codex thread_id — continue the conversation.
   *  IMPORTANT: caller must ensure this is a codex thread_id, not a CCB
   *  session_id. See `_codexResumeMap` in sessionManager.ts which is the
   *  provider-segregated store feeding this. */
  resumeSessionId?: string
  /** Agent model id from agents.yaml (e.g. `gpt-5-codex`). When set, added
   *  as `--model` to codex argv so the agent config is honored. */
  model?: string
  // ── Platform context injection (parity with SubprocessRunner / ccb) ──
  // When `config` is provided, the runner builds an `extra-prompt.md` from
  // `buildPromptContext()` and an mcp-memory MCP server entry, then passes
  // them to codex via `-c model_instructions_file=...` and
  // `-c mcp_servers.openclaude_memory.*=...`. Omit `config` to keep the
  // legacy "naked codex" launch (no platform context) — used by tests.
  /** Path to agent's persona file (CLAUDE.md / SOUL.md). */
  persona?: string
  /** Effective provider for `buildPromptContext` provider-keyed slot logic. */
  agentProvider?: string
  /** Initial effort level for the RESEARCH slot activation. */
  effortLevel?: string
  /** Gateway config; required for platform context injection. */
  config?: OpenClaudeConfig
  /** Forwarded to mcp-memory env so delegate_task can enforce recursion caps. */
  delegationDepth?: number
  /** V3 S12e CG8 telemetry — turn-level trace id stash,parity with
   *  SubprocessRunnerOpts.traceId。CodexRunner 是 per-turn `codex exec` spawn,
   *  但当前出于 env scrub(`ENV_SCRUB_PREFIXES` 阻挡 `OPENCLAUDE_*`)+ codex CLI
   *  没有 trace id 协议槽位的原因,这个值不透传给子进程;仅用于满足
   *  `sessionManager.submit()` 调 `runner.setTraceId(traceId)` 的 contract,
   *  避免 codex 路径 `TypeError: setTraceId is not a function`。getter 让
   *  调用方/单测能回读最近一次 stash 的 trace。 */
  traceId?: string
  // ── Phase 5 GitHub session repo workspace integration ──
  /** Session id (peerId)。和 SubprocessRunner.opts.sessionId 同语义,被 runner 作为 key
   *  反查 `getRepoSnapshot()`,得到当前 turn 应该绑定的 repo workspace。Legacy caller
   *  不传 → 整个 repo 绑定能力关闭。 */
  sessionId?: string
  /** snapshot provider — 由 SessionManager 注入(`this._getRepoSnapshot`)。 */
  getRepoSnapshot?: (sessionId: string) => RepoSnapshot | null
}

/**
 * Build codex `exec` argv. Module-level export so tests / overrides can drive
 * the same builder the runner uses internally without poking at private
 * `buildArgs`. v3 keeps `--full-auto` + `-c approval_policy="never"` (codex
 * resume rejects bare `--sandbox`); platform context overrides are sliced in
 * BEFORE the trailing positional (`threadId` / `-`) so codex's clap parser
 * still sees the stdin sentinel last.
 */
export function buildCodexCliArgs(opts: {
  model?: string
  threadId?: string | null
  /** Extra `-c key=value` argv pairs from `buildCodexLaunchOverrides()`. */
  extraConfig?: string[]
}): string[] {
  const base = [
    '--json',
    '--skip-git-repo-check',
    '--full-auto',
    '-c',
    'approval_policy="never"',
  ]
  if (opts.model) base.push('--model', opts.model)
  const extra = opts.extraConfig ?? []
  if (opts.threadId) {
    return ['exec', 'resume', ...base, ...extra, opts.threadId, '-']
  }
  return ['exec', ...base, ...extra, '-']
}

/** Max stderr we keep per turn. Codex CLI normally logs only on error, but
 *  if it goes haywire we don't want to balloon memory. */
const STDERR_CAP = 64 * 1024 // 64 KB

/** Env keys scrubbed from the codex subprocess environment.
 *  Rationale: codex CLI uses ChatGPT oauth from ~/.codex/auth.json — it has
 *  no need for Anthropic / CCB / gateway auth tokens, and passing them
 *  through would silently leak secrets to a different provider's process.
 *  Matched as exact keys OR as prefixes (for the _TOKEN/_KEY families). */
const ENV_SCRUB_KEYS = new Set<string>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'OPENCLAUDE_GATEWAY_TOKEN',
  'OPENCLAUDE_ACCESS_TOKEN',
  'GATEWAY_AUTH_TOKEN',
  'MINIMAX_API_KEY',
  'DEEPSEEK_API_KEY',
])
const ENV_SCRUB_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENCLAUDE_']

/**
 * Build the env passed to a codex subprocess. Exported so the app-server runner
 * (which spawns `codex app-server` instead of `codex exec`) can share the same
 * scrubbing rules — both subprocesses are codex's own CLI and have identical
 * env exposure concerns.
 */
export function buildCodexEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (ENV_SCRUB_KEYS.has(k)) continue
    if (ENV_SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}

/** Runner message shape used by sessionManager.ts (subset of SdkMessage). */
interface RunnerMessage {
  type: string
  subtype?: string
  session_id?: string | null
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: string | unknown
      is_error?: boolean
    }>
  }
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface QueuedTurn {
  prompt: string
  resolve: () => void
  reject: (err: Error) => void
}

export class CodexRunner extends EventEmitter {
  private threadId: string | null
  private proc: ChildProcessWithoutNullStreams | null = null
  private processing = false
  private shuttingDown = false
  private queue: QueuedTurn[] = []
  private spawnEmitted = false

  /** mkdtempSync'd dir holding the per-spawn `extra-prompt.md`. Created lazily
   *  on the first turn that needs platform context, cleaned in `shutdown()`.
   *  Null when overrides have never been built (no config) or were just
   *  cleaned and not yet rebuilt. */
  private sessionDir: string | null = null
  /** Cached overrides for the current session lifetime. Cleared in `shutdown()`
   *  alongside `sessionDir` so the next post-shutdown spawn rebuilds against a
   *  fresh dir — re-using a stale entry would point codex at a deleted file. */
  private cachedOverrides: CodexLaunchOverrides | null = null

  // ── Phase 5 GitHub session repo binding (parity with SubprocessRunner) ──
  /** ready 时记录 selectionVersion+workspaceDir;recyclePeerForRepoChange 据此版本对比。
   *  非 ready / 无 binding / 无 sessionId = null。 */
  private _boundRepoBinding: { selectionVersion: number; workspaceDir: string } | null = null

  // ── Interface parity with SubprocessRunner ──
  // These are referenced by sessionManager / server and must exist even if
  // they are no-ops for the codex backend.
  public lastActivityAt: number = Date.now()
  public effortLevel: string | undefined = undefined

  get isRunning(): boolean {
    return this.proc != null || this.processing
  }

  updateConfig(config: OpenClaudeConfig): void {
    // codex itself doesn't read gateway config, but the platform-context
    // injection path does (gateway port/token, claudeCodePath). Accept the
    // new config and invalidate the cached overrides so the NEXT spawn
    // rebuilds with the new values. A long-lived spawned mcp-memory child
    // has the old token baked into its env at spawn time — config rotation
    // only fully propagates after the codex proc respawns.
    this.opts = { ...this.opts, config }
    this.cachedOverrides = null
    // Hygiene: if the runner is idle (no active proc, no in-flight turn),
    // proactively rmSync the old sessionDir so the stale 0600 gateway-token
    // file does not linger on disk longer than necessary after a token
    // rotation. The next ensureLaunchOverrides() will mkdtemp afresh. We do
    // NOT rmSync while a proc is running because mcp-memory still holds the
    // file open through the env path it captured at spawn time.
    if (!this.proc && !this.processing && this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex updateConfig sessionDir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
  }

  setEffortLevel(level: string | undefined): void {
    // codex CLI manages its own effort flag; we don't pass it through to the
    // codex argv. But we DO record it on the runner so a subsequent
    // ensureLaunchOverrides() (after shutdown clears the cache) reflects the
    // new value when buildPromptContext renders the RESEARCH slot.
    this.effortLevel = level
  }

  // ── model getter / setter (parity with SubprocessRunner; 2026-04-26) ──
  // sessionManager.submit 现在会调 runner.setModel,即便商用版当前不用 codex,
  // 接口仍要存在,否则 cast 后 NPE。codexRunner 的 buildArgs() 已读 this.opts.model
  // 渲染 `--model` 参数,setModel 后下次 spawn 自动用新值。
  get model(): string | undefined {
    return this.opts.model
  }
  setModel(model: string | undefined): void {
    this.opts.model = model
  }

  // ── traceId getter / setter (parity with SubprocessRunner; V3 S12e CG8) ──
  // sessionManager.submit() L1131 在 traceId 非空时硬调 `runner.setTraceId(traceId)`。
  // 缺方法 → TypeError → turn 永不 complete → 用户卡 "思考中"(2026-05-11 v1.0.123 复现)。
  // 这是 setModel 同型 bug 第二次踩坑;若再加第三个 sessionManager-side 必调 mutator,
  // runnerContractParity.test.ts 会先把谁漏 parity 暴露出来。
  // CodexRunner 是 per-turn `codex exec` spawn;trace id 仍不透传子进程
  // (ENV_SCRUB_PREFIXES 拦 OPENCLAUDE_* + codex CLI 无 trace 协议槽位),只做 opts stash。
  get traceId(): string | undefined {
    return this.opts.traceId
  }
  setTraceId(traceId: string | undefined): void {
    this.opts.traceId = traceId
  }

  // ── Phase 5 GitHub session repo binding (parity with SubprocessRunner) ──

  /** Public getter consumed by sessionManager.recyclePeerForRepoChange。 */
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null {
    return this._boundRepoBinding
  }

  /** Forget per-thread / per-spawn cached state so the next turn rebuilds
   *  from scratch。Used by sessionManager.recyclePeerForRepoChange when repo
   *  binding version changes;recycle 在 isRunning=false 的 per-turn idle 窗口
   *  (turn 间隔)不会调 shutdown(),所以这里必须自带"把缓存的 launch overrides
   *  也作废"的语义,否则:
   *    - threadId 清了,但 cachedOverrides 仍是旧 repo 的 instructions 文件,
   *      ensureLaunchOverrides() 命中缓存直接返,新 turn 的 spawn cwd 切到新
   *      repo,但 -c model_instructions_file 还是旧 repo 的 REPO slot。
   *      物理 cwd 与系统提示里的 REPO 又分裂(本次修复要根治的就是这个)。
   *
   *  清理动作(对齐 CodexAppServerRunner.clearSessionId):
   *    - threadId(下次 buildArgs 走 fresh `codex exec`,不带 `resume` 子命令)
   *    - sessionDir + cachedOverrides(下次 ensureLaunchOverrides() rebuild
   *      against 当前 repo snapshot)
   *
   *  注意:CodexRunner 没有 token-usage baseline 状态(per-turn exec 不维护
   *  cumulative),所以 vs CodexAppServerRunner.clearSessionId 少 3 个 baseline
   *  字段重置。 */
  clearSessionId(): void {
    this.threadId = null
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex clearSessionId sessionDir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    this.cachedOverrides = null
  }

  /** 读当前 session 的 repo snapshot(turn 顶部一次取,贯穿 spawn cwd / launch overrides
   *  REPO slot 两个消费点)。 */
  private _currentRepoSnapshot(): RepoSnapshot | null {
    if (!this.opts.sessionId || !this.opts.getRepoSnapshot) return null
    try {
      return this.opts.getRepoSnapshot(this.opts.sessionId)
    } catch (err) {
      log.warn('getRepoSnapshot threw; treating as no-bind', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      return null
    }
  }

  /** 同 codexAppServerRunner 同名方法。ready+workspaceDir → 用 workspaceDir + 记 binding;
   *  否则回退 opts.cwd + binding=null。 */
  private _applyRepoBindingFromSnapshot(snap: RepoSnapshot | null): string {
    if (snap?.status === 'ready' && snap.workspaceDir) {
      this._boundRepoBinding = {
        selectionVersion: snap.selectionVersion,
        workspaceDir: snap.workspaceDir,
      }
      return snap.workspaceDir
    }
    this._boundRepoBinding = null
    return this.opts.cwd
  }

  sendPermissionResponse(_requestId: string, _response: unknown): boolean {
    // codex has its own sandbox approval flow (workspace-write) — gateway
    // permission prompts are never emitted by this runner, so nothing to
    // respond to.
    return false
  }

  interrupt(): boolean {
    if (!this.proc || this.proc.killed) return false
    try {
      this.proc.kill('SIGTERM')
    } catch {
      return false
    }
    return true
  }

  constructor(private opts: CodexRunnerOpts) {
    super()
    this.threadId = opts.resumeSessionId ?? null
    this.effortLevel = opts.effortLevel
  }

  /** Lazy-build codex launch overrides (instructions file + mcp-memory config)
   *  and cache the result for the lifetime of the current proc. Cleared in
   *  `shutdown()` and `updateConfig()` so the next spawn rebuilds. Returns
   *  null when `opts.config` is not provided (legacy "naked codex" path).
   *
   *  `repoSnap` 由 caller(`runTurn`)从 turn 顶部的单一 snapshot 透传过来,贯穿
   *  spawn cwd 与 REPO slot 两个消费点。 */
  private async ensureLaunchOverrides(
    repoSnap: RepoSnapshot | null,
  ): Promise<CodexLaunchOverrides | null> {
    if (!this.opts.config) return null
    if (this.cachedOverrides && this.sessionDir) return this.cachedOverrides
    // Cache miss with an existing sessionDir means updateConfig (or some other
    // invalidator) cleared `cachedOverrides` while the dir was still bound.
    // CodexRunner queue is serial so by the time we re-run the previous turn's
    // proc has exited; clean before mkdtemp v2 to avoid orphan tmp dirs on
    // token rotation / config swaps.
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex stale sessionDir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    const dir = mkdtempSync(join(tmpdir(), 'oc-codex-'))
    try {
      const overrides = await buildCodexLaunchOverrides({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: this.opts.agentProvider,
        model: this.opts.model,
        effortLevel: this.effortLevel,
        sessionDir: dir,
        claudeCodePath: this.opts.config.auth.claudeCodePath,
        gatewayPort: this.opts.config.gateway.port,
        gatewayToken: this.opts.config.gateway.accessToken,
        delegationDepth: this.opts.delegationDepth,
        // Phase 5:repoSnap 透传 → buildPromptContext 的 REPO slot,系统提示带仓库元信息。
        repoSnapshot: repoSnap,
      })
      writeFileSync(overrides.instructionsFile, overrides.instructionsContent, 'utf8')
      // v3 hardening: write the gateway token to a 0600 file in sessionDir so
      // mcp-memory can read it via OPENCLAUDE_GATEWAY_TOKEN_FILE without ever
      // having the token literal in codex argv (`ps -ef` exposed). The file
      // dies with the dir on shutdown / cache invalidation.
      if (overrides.tokenFile && overrides.tokenContent !== null) {
        writeFileSync(overrides.tokenFile, overrides.tokenContent, { mode: 0o600 })
      }
      this.sessionDir = dir
      this.cachedOverrides = overrides
      return overrides
    } catch (err) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* swallow — primary error is what we care about */
      }
      throw err
    }
  }

  async start(): Promise<void> {
    // Codex runs per-turn; there's no long-lived child. We still emit `spawn`
    // synchronously so sessionManager resets its per-session cost baseline
    // before any turn completes. `resumed` reflects whether we have a
    // persisted thread_id to continue.
    this.emit('spawn', { resumed: this.threadId != null })
  }

  // PR2 v1.0.66 — `_requestId` 形参为兼容 sessionManager.submit 的统一签名;legacy
  // CodexRunner(`codex exec` 路径)不参与真扣费链路,真扣费走 CodexAppServerRunner。
  async submit(
    textOrBlocks: string | Array<{ type: string; text?: string }>,
    _requestId?: string,
  ): Promise<void> {
    this.lastActivityAt = Date.now()
    if (!this.spawnEmitted) {
      this.spawnEmitted = true
      this.emit('spawn', { resumed: this.threadId != null })
    }
    const prompt = normalisePrompt(textOrBlocks)
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject })
      void this.drain()
    })
  }

  async shutdown(): Promise<void> {
    // SubprocessRunner 语义: shutdown 只是"把当前子进程干掉",下一次 submit()
    // 会自动重开 —— 这是 effort 切换、auth token 刷新等路径依赖的约定。
    // 之前版本这里把 shuttingDown 设 true 后永不复位,导致 effort 切换后
    // drain() 永久早退、提交的 turn 永远排在队列里。改为 transient:
    //   - 正在跑的 turn:SIGTERM → 3s SIGKILL(由 proc.close 触发下游 result)
    //   - queue 里等待的 turn:只 reject 那个"被 shutdown 打断的"turn,
    //     但新进来的 submit 照常入队并开新 proc。
    this.shuttingDown = true
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      const p = this.proc
      setTimeout(() => {
        if (p && !p.killed) {
          try {
            p.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 3000)
    }
    const pending = this.queue
    this.queue = []
    for (const q of pending) q.reject(new Error('CodexRunner shutdown'))
    // Tear down the lazy-built launch overrides so the next post-shutdown
    // submit() lazy-rebuilds against a fresh sessionDir. Re-using a stale
    // overrides reference after we rmSync the dir would point codex at a
    // deleted file. force:true tolerates the dir already missing.
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex session dir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    this.cachedOverrides = null
    this.emit('exit', { code: 0, signal: null, crashed: false })
    // 允许后续 submit 再次拉起 proc。SessionManager 在 shutdown() 完成后
    // (effort 切换分支)会继续 submit —— 我们必须在这里开闸。
    this.shuttingDown = false
  }

  // ─── internals ────────────────────────────────

  private async drain(): Promise<void> {
    if (this.processing || this.shuttingDown) return
    const turn = this.queue.shift()
    if (!turn) return
    this.processing = true
    try {
      await this.runTurn(turn.prompt)
      turn.resolve()
    } catch (err) {
      turn.reject(err as Error)
    } finally {
      this.processing = false
      void this.drain()
    }
  }

  private buildArgs(extraConfig?: string[]): string[] {
    // approval_policy=never prevents codex from ever asking for approval
    // (we have no UI path to answer — sendPermissionResponse is a no-op).
    // --full-auto is codex's alias for `--sandbox workspace-write` AND is
    // the only sandbox-setting flag accepted by both `codex exec` and
    // `codex exec resume` (resume rejects `--sandbox` outright, which
    // silently broke every multi-turn codex conversation with code=2).
    // Platform context overrides are sliced before the trailing positional.
    return buildCodexCliArgs({
      model: this.opts.model,
      threadId: this.threadId,
      extraConfig,
    })
  }

  private async runTurn(prompt: string): Promise<void> {
    const startedAt = Date.now()
    // Phase 5:turn 顶部一次取 snapshot,贯穿 spawn cwd 与 launch overrides REPO slot
    // 两个消费点。任何中途取的写法都会出现撕裂窗口。
    const repoSnap = this._currentRepoSnapshot()
    const effectiveCwd = this._applyRepoBindingFromSnapshot(repoSnap)
    // Build platform context overrides BEFORE spawn so the codex process sees
    // model_instructions_file + mcp-memory from its first interaction. If
    // override generation fails (mcp-memory entry resolution etc.) we still
    // proceed without overrides — same graceful-degradation stance as
    // subprocessRunner's "skip built-in MCP, log warn" branch.
    let argvOverrides: string[] = []
    try {
      const overrides = await this.ensureLaunchOverrides(repoSnap)
      if (overrides) argvOverrides = overrides.argvOverrides
    } catch (err) {
      log.warn('codex launch overrides build failed; spawning without platform context', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
    }
    const args = this.buildArgs(argvOverrides)
    log.info('codex turn start', {
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      promptChars: prompt.length,
      hasOverrides: argvOverrides.length > 0,
      effectiveCwd,
      repoBound: this._boundRepoBinding != null,
    })

    return new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }

      let proc: ChildProcessWithoutNullStreams
      try {
        proc = _spawnFn('codex', args, {
          cwd: effectiveCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildCodexEnv(),
        }) as ChildProcessWithoutNullStreams
      } catch (err) {
        // Sync spawn failure (rare — e.g. invalid args). Node throws rather
        // than emitting 'error' for some errno classes. ENOENT itself
        // usually comes via the async 'error' event, handled below.
        this.emitResult({
          durationMs: Date.now() - startedAt,
          ok: false,
          error: `codex spawn failed: ${(err as Error).message}`,
        })
        settle()
        return
      }
      this.proc = proc

      try {
        proc.stdin.write(prompt)
        proc.stdin.end()
      } catch (err) {
        // stdin may already be closed if the process errored before we got
        // here (EPIPE / ECONNRESET). The 'error' or 'close' handler will
        // settle the turn; don't force-settle here.
        log.warn('codex stdin write failed', { err: (err as Error).message })
      }

      let stdoutBuf = ''
      let stderrBytes = 0
      let stderrBuf = ''
      let stderrOverflowed = false
      let lastAssistantText = ''
      let usage: { input_tokens?: number; output_tokens?: number } | undefined

      proc.stdout.on('data', (chunk: Buffer) => {
        // Refresh activity baseline on every stdout chunk so the 5/15-min
        // idle timer in sessionManager measures "silence", not "silence
        // since turn start".
        this.lastActivityAt = Date.now()
        stdoutBuf += chunk.toString('utf8')
        let nl: number
        // biome-ignore lint/suspicious/noAssignInExpressions: line-splitter idiom
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim()
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (!line) continue
          let ev: unknown
          try {
            ev = JSON.parse(line)
          } catch (err) {
            this.emit('parse_error', { line, error: err })
            continue
          }
          const handled = this.translateAndEmit(ev)
          if (handled.assistantText) lastAssistantText = handled.assistantText
          if (handled.usage) usage = handled.usage
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        // Stderr counts as activity too — a stuck codex that only complains
        // on stderr is still "alive" enough for the liveness timer.
        this.lastActivityAt = Date.now()
        if (stderrBytes < STDERR_CAP) {
          const s = chunk.toString('utf8')
          const remaining = STDERR_CAP - stderrBytes
          stderrBuf += s.length > remaining ? s.slice(0, remaining) : s
          stderrBytes += s.length
        } else if (!stderrOverflowed) {
          stderrOverflowed = true
          log.warn('codex stderr overflowed cap', {
            sessionKey: this.opts.sessionKey,
            cap: STDERR_CAP,
          })
        }
      })

      proc.on('error', (err) => {
        // Async spawn failures land here (ENOENT when codex CLI missing is
        // the common one). Previously this was only logged; now propagate
        // as a runner-level error so sessionManager can fail the turn fast
        // instead of waiting for an idle timeout.
        log.error('codex proc error', { err: err.message })
        this.emit('error', err)
        this.proc = null
        this.emitResult({
          durationMs: Date.now() - startedAt,
          ok: false,
          error: `codex process error: ${err.message}`,
        })
        settle()
      })

      proc.on('close', (code, signal) => {
        this.proc = null
        const durationMs = Date.now() - startedAt
        log.info('codex turn end', {
          sessionKey: this.opts.sessionKey,
          code,
          signal,
          durationMs,
          assistantChars: lastAssistantText.length,
        })
        if (code === 0) {
          this.emitResult({
            durationMs,
            ok: true,
            text: lastAssistantText,
            usage,
          })
        } else {
          const errMsg =
            stderrBuf.trim().slice(-2000) ||
            `codex exec exited code=${code} signal=${signal ?? ''}`
          this.emitResult({
            durationMs,
            ok: false,
            error: errMsg,
          })
        }
        settle()
      })
    })
  }

  /**
   * Translate one codex JSONL event to zero or more runner `message` events
   * and return accumulator updates (last assistant text, turn usage).
   */
  private translateAndEmit(ev: unknown): {
    assistantText?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  } {
    if (!ev || typeof ev !== 'object') return {}
    const obj = ev as Record<string, unknown>
    const type = obj.type

    // thread.started — first turn, capture thread_id for resume
    if (type === 'thread.started') {
      const tid = obj.thread_id
      if (typeof tid === 'string' && tid && this.threadId !== tid) {
        this.threadId = tid
        this.emit('session_id', tid)
      }
      return {}
    }

    // turn.started — no-op (UI already knows a turn started from user submit)
    if (type === 'turn.started') return {}

    // turn.completed — usage totals; the result message is emitted in runTurn's
    // close handler so we include durationMs and success/error state together.
    if (type === 'turn.completed') {
      const u = obj.usage as Record<string, unknown> | undefined
      if (u) {
        return {
          usage: {
            input_tokens: num(u.input_tokens),
            output_tokens: num(u.output_tokens),
          },
        }
      }
      return {}
    }

    // item.* events carry the actual work done
    const item = obj.item as Record<string, unknown> | undefined
    if (!item) return {}
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type

    if (type === 'item.started') {
      if (itemType === 'command_execution') {
        const cmd = typeof item.command === 'string' ? item.command : ''
        this.emitAssistantToolUse(itemId, 'Bash', {
          command: stripShellWrapper(cmd),
          description: 'codex command_execution',
        })
      } else if (itemType === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : []
        const first = (changes[0] ?? {}) as Record<string, unknown>
        const name = first.kind === 'add' ? 'Write' : 'Edit'
        this.emitAssistantToolUse(itemId, name, {
          file_path: typeof first.path === 'string' ? first.path : '',
          kind: first.kind,
          changes,
        })
      } else if (itemType && itemType !== 'agent_message' && itemType !== 'reasoning') {
        // Surface other item types generically so the user knows something happened
        this.emitAssistantToolUse(itemId, `Codex:${String(itemType)}`, item)
      }
      return {}
    }

    if (type === 'item.completed') {
      if (itemType === 'agent_message') {
        const text = typeof item.text === 'string' ? item.text : ''
        if (text) {
          // CcbMessageParser 约定正常 assistant 文本走 stream_event.text_delta
          // 路径(assistant 快照只带 tool_use,text 会被 _handleAssistant 丢弃)。
          // 我们把 codex 的一次性 agent_message 以一个完整 delta 送进去,
          // 由 _handleStreamEvent 正常累加到 assistantBuf 并 emit block。
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            },
          } as unknown as RunnerMessage)
          return { assistantText: text }
        }
        return {}
      }
      if (itemType === 'command_execution') {
        const out = typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
        const exit = num(item.exit_code)
        this.emitToolResult(itemId, out, exit != null && exit !== 0)
        return {}
      }
      if (itemType === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : []
        const summary = changes
          .map((c) => {
            const obj = c as Record<string, unknown>
            return `${obj.kind ?? 'change'}: ${obj.path ?? ''}`
          })
          .join('\n')
        this.emitToolResult(itemId, summary || 'file changes applied', false)
        return {}
      }
      if (itemType === 'reasoning') {
        // skip (can be surfaced later as thinking-blocks if we extend schema)
        return {}
      }
      // Generic completion for unknown item types
      this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
      return {}
    }

    return {}
  }

  private emitAssistantToolUse(id: string, name: string, input: unknown): void {
    this.emit('message', {
      type: 'assistant',
      session_id: this.threadId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    } satisfies RunnerMessage)
  }

  private emitToolResult(toolUseId: string, content: string, isError: boolean): void {
    this.emit('message', {
      type: 'user',
      session_id: this.threadId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
            is_error: isError,
          },
        ],
      },
    } satisfies RunnerMessage)
  }

  private emitResult(opts: {
    durationMs: number
    ok: boolean
    text?: string
    error?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }): void {
    const msg: RunnerMessage = {
      type: 'result',
      subtype: opts.ok ? 'success' : 'error_during_execution',
      session_id: this.threadId,
      total_cost_usd: 0,
      duration_ms: opts.durationMs,
      is_error: !opts.ok,
      result: opts.ok ? opts.text ?? '' : opts.error ?? 'codex error',
      usage: opts.usage,
    }
    this.emit('message', msg)
  }
}

function normalisePrompt(input: string | Array<{ type: string; text?: string }>): string {
  if (typeof input === 'string') return input
  const parts: string[] = []
  for (const b of input) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Codex wraps every shell command in `/bin/bash -lc '...'`. Strip that wrapper
 * for a cleaner display — the ccb Bash tool card shows the raw user command.
 */
function stripShellWrapper(cmd: string): string {
  const m = cmd.match(/^\/bin\/bash\s+-lc\s+'([\s\S]*)'$/)
  if (m) return m[1].replace(/'\\''/g, "'")
  return cmd
}
