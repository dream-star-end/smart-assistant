import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
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

  // ── Interface parity with SubprocessRunner ──
  // These are referenced by sessionManager / server and must exist even if
  // they are no-ops for the codex backend.
  public lastActivityAt: number = Date.now()
  public effortLevel: string | undefined = undefined

  get isRunning(): boolean {
    return this.proc != null || this.processing
  }

  updateConfig(_config: unknown): void {
    // codex doesn't read gateway config; no-op
  }

  setEffortLevel(_level: string | undefined): void {
    // codex CLI manages its own effort; we don't map CCB effort here
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

  private buildArgs(): string[] {
    // approval_policy=never prevents codex from ever asking for approval
    // (we have no UI path to answer — sendPermissionResponse is a no-op).
    // --full-auto is codex's alias for `--sandbox workspace-write` AND is
    // the only sandbox-setting flag accepted by both `codex exec` and
    // `codex exec resume` (resume rejects `--sandbox` outright, which
    // silently broke every multi-turn codex conversation with code=2).
    // Model comes from agents.yaml.
    const base = [
      '--json',
      '--skip-git-repo-check',
      '--full-auto',
      '-c',
      'approval_policy="never"',
    ]
    if (this.opts.model) base.push('--model', this.opts.model)
    if (this.threadId) {
      return ['exec', 'resume', ...base, this.threadId, '-']
    }
    return ['exec', ...base, '-']
  }

  private runTurn(prompt: string): Promise<void> {
    const startedAt = Date.now()
    const args = this.buildArgs()
    log.info('codex turn start', {
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      promptChars: prompt.length,
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
        proc = spawn('codex', args, {
          cwd: this.opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildCodexEnv(),
        })
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
