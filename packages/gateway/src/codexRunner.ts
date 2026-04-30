import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { paths } from '@openclaude/storage'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'codexRunner' })

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

/** Image extensions produced by codex's built-in image_gen tool. We scan the
 *  per-thread generated_images directory after each turn for new files matching
 *  these so we can surface them to the web client (codex's image_gen does NOT
 *  emit item.* events on the JSON stream — see scanForNewImages docstring). */
const IMAGE_EXTS = ['.png', '.webp', '.jpg', '.jpeg']

/**
 * Per-thread directory where codex CLI persists images created via the built-in
 * `image_gen` skill. Path mirrors what we observed in the codex 0.125 install
 * at `~/.codex/generated_images/<thread_id>/ig_<hash>.png`.
 *
 * threadId is sanitized: codex thread_ids are ULID-like (alphanumeric + hyphens)
 * but we sanitize defensively so future format drift cannot escape the dir.
 *
 * Exported only so tests can construct expected paths consistently.
 */
export function _sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '')
}

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

function buildCodexEnv(): NodeJS.ProcessEnv {
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

/**
 * Pure argv builder for `codex exec [resume]`. Exported for unit tests.
 *
 * Permission stance: `--dangerously-bypass-approvals-and-sandbox` is a single
 * flag that sets `sandbox_mode=danger-full-access` AND `approval_policy=never`
 * in one go. We use it because:
 *   - OpenClaude's personal instance treats codex with the same trust as ccb
 *     (bypassPermissions). Restricting codex to workspace-write while ccb runs
 *     unrestricted on the same machine is incoherent.
 *   - Approvals can never be answered: `sendPermissionResponse` is a no-op
 *     (codex has no UI back-channel through OpenClaude).
 *   - Verified against codex 0.125.0: this flag is accepted by both
 *     `codex exec` and `codex exec resume`. (Earlier versions rejected
 *     `--sandbox` on resume with code=2 — that's why this code historically
 *     used `--full-auto` instead. The bypass flag has no such asymmetry.)
 *
 * Do NOT combine with `--full-auto` or `-c approval_policy=...` — they are
 * either redundant or conflicting once bypass is set.
 */
export function buildCodexCliArgs(opts: {
  model?: string
  threadId?: string | null
}): string[] {
  const base = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']
  if (opts.model) base.push('--model', opts.model)
  if (opts.threadId) {
    return ['exec', 'resume', ...base, opts.threadId, '-']
  }
  return ['exec', ...base, '-']
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

  sendPermissionResponse(_requestId: string, _response: unknown): boolean {
    // codex doesn't route approvals through OpenClaude (we run it with
    // --dangerously-bypass-approvals-and-sandbox + approval=never), so this
    // runner never emits permission prompts and there's nothing to respond to.
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

  /** Per-thread codex image dir. Overridable in tests via subclass / patch. */
  protected getCodexImageDir(threadId: string): string {
    return join(homedir(), '.codex', 'generated_images', _sanitizeThreadId(threadId))
  }

  /** OpenClaude public generated/ dir. Overridable in tests. */
  protected getPublicGeneratedDir(): string {
    return paths.generatedDir
  }

  /**
   * List image filenames in a codex thread image dir, swallowing ENOENT/etc.
   * Returns an empty set when threadId is null or the directory doesn't exist
   * yet (fresh thread before its first image_gen call).
   */
  protected async readImageDirSafe(threadId: string | null): Promise<Set<string>> {
    if (!threadId) return new Set()
    try {
      const entries = await readdir(this.getCodexImageDir(threadId), {
        withFileTypes: true,
      })
      const out = new Set<string>()
      for (const e of entries) {
        if (!e.isFile()) continue
        const lower = e.name.toLowerCase()
        if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) out.add(e.name)
      }
      return out
    } catch {
      // ENOENT, EACCES → "no images" from our perspective.
      return new Set()
    }
  }

  /**
   * Copy newly-generated codex images into OpenClaude's public generated/ dir
   * (which is in `FILE_ALLOWED_DIRS` — the gateway `/api/file` allowlist).
   *
   * Codex's native dir `~/.codex/generated_images/` is NOT in the allowlist, so
   * surfacing those raw paths to the web client would result in 403 from
   * `/api/file?path=...`. By copying we keep the allowlist surface narrow.
   *
   * Returns successfully copied entries (with both source and public paths so
   * caller can dedupe against either) plus a list of names that failed to copy.
   * Per Codex review: failures are NOT downgraded to "use source path" because
   * that path is unreachable from the web client anyway.
   */
  protected async copyImagesToPublicDir(
    threadId: string,
    filenames: string[],
  ): Promise<{
    copied: Array<{ srcName: string; srcPath: string; publicPath: string }>
    failedNames: string[]
  }> {
    const safeThread = _sanitizeThreadId(threadId)
    const srcDir = this.getCodexImageDir(threadId)
    const dstDir = this.getPublicGeneratedDir()
    // paths.generatedDir is created on demand elsewhere (uploads, MCP media);
    // on a fresh OpenClaude install with no prior media, it may not exist yet.
    // mkdir recursive is idempotent — cheaper than a stat+create dance.
    try {
      await mkdir(dstDir, { recursive: true })
    } catch (err) {
      // If we can't create the dir, every copyFile below will ENOENT and we'll
      // surface "image copy failed" to the user. Log once here so the root
      // cause is in the journal.
      log.warn('codex image public dir mkdir failed', {
        dstDir,
        err: (err as Error).message,
      })
    }
    const copied: Array<{ srcName: string; srcPath: string; publicPath: string }> = []
    const failedNames: string[] = []
    for (const name of filenames) {
      const src = join(srcDir, name)
      // codex-${threadId}-${basename} prevents cross-thread or repeat-copy
      // collisions in the shared public dir. The basename itself is already a
      // 32+ hex hash from codex (`ig_<hash>.png`).
      const dst = join(dstDir, `codex-${safeThread}-${basename(name)}`)
      try {
        await copyFile(src, dst)
        copied.push({ srcName: name, srcPath: src, publicPath: dst })
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

  async start(): Promise<void> {
    // Codex runs per-turn; there's no long-lived child. We still emit `spawn`
    // synchronously so sessionManager resets its per-session cost baseline
    // before any turn completes. `resumed` reflects whether we have a
    // persisted thread_id to continue.
    this.emit('spawn', { resumed: this.threadId != null })
  }

  async submit(textOrBlocks: string | Array<{ type: string; text?: string }>): Promise<void> {
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
    return buildCodexCliArgs({ model: this.opts.model, threadId: this.threadId })
  }

  private async runTurn(prompt: string): Promise<void> {
    const startedAt = Date.now()
    const args = this.buildArgs()
    log.info('codex turn start', {
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      promptChars: prompt.length,
    })

    // Baseline scan of codex's per-thread image dir so we can identify which
    // files are NEW after this turn. For resume turns we have threadId already;
    // for fresh turns (no resume id) the dir typically doesn't exist yet — we
    // re-scan in the close handler with this.threadId, and any pre-existing
    // file would have to predate `thread.started`, which is impossible in
    // practice (dir is created by codex when it persists the first image of
    // that thread). Fresh-turn baseline is therefore safely empty.
    const baselineFiles = await this.readImageDirSafe(this.threadId)

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
        // Hand off to async finalizer. We deliberately do NOT await inside the
        // 'close' callback (Node EventEmitter ignores the returned promise);
        // instead the helper owns try/catch and end-of-turn ordering:
        //   image scan → image copy → text_delta emit → emitResult → settle.
        // Any throw is caught and downgraded to log+result so we never leave
        // a turn unsettled.
        void this.finalizeTurn({
          code,
          signal,
          startedAt,
          baselineFiles,
          stderrBuf,
          getLastAssistantText: () => lastAssistantText,
          setLastAssistantText: (v: string) => {
            lastAssistantText = v
          },
          usage,
          settled: () => settled,
          settle,
        })
      })
    })
  }

  /**
   * Finalize a turn after the codex child process has closed: scan for newly
   * generated `image_gen` files, copy them into the public `generated/` dir,
   * inject their absolute paths as a `text_delta` so the web client renders
   * them, then emit the `result` event and settle.
   *
   * Why this exists: codex's built-in `image_gen` tool persists images at
   * `~/.codex/generated_images/<thread_id>/ig_<hash>.png` but does NOT emit
   * any `item.started`/`item.completed` event for the image_gen call itself
   * on the `--json` exec stream. Without this finalizer, an image-only turn
   * looks like an empty `agent_message` to upstream (assistantChars=0) and
   * the web client reports "no content".
   */
  private async finalizeTurn(args: {
    code: number | null
    signal: NodeJS.Signals | null
    startedAt: number
    baselineFiles: Set<string>
    stderrBuf: string
    getLastAssistantText: () => string
    setLastAssistantText: (v: string) => void
    usage: { input_tokens?: number; output_tokens?: number } | undefined
    settled: () => boolean
    settle: () => void
  }): Promise<void> {
    const { code, signal, startedAt, baselineFiles, stderrBuf, settled, settle } = args
    this.proc = null
    if (settled()) return // 'error' handler already settled; nothing to do.

    // Wrap the entire body in try/catch/finally so that even if logging or
    // an emitResult listener throws synchronously, settle() still fires (from
    // finally) and the catch downgrades the throw to a logged error — without
    // this, the close handler's `void this.finalizeTurn(...)` would surface
    // as an unhandled promise rejection.
    try {
      const durationMs = Date.now() - startedAt
      let imageFiles = 0

      // Only scan on success — a non-zero exit means we have nothing meaningful
      // to surface; the user gets the stderr-derived error instead.
      if (code === 0 && this.threadId) {
        try {
          const allFiles = await this.readImageDirSafe(this.threadId)
          const newNames = [...allFiles].filter((f) => !baselineFiles.has(f)).sort()
          imageFiles = newNames.length
          if (newNames.length > 0) {
            const { copied, failedNames } = await this.copyImagesToPublicDir(
              this.threadId,
              newNames,
            )
            // Dedupe only against the public path. We deliberately do NOT skip
            // when codex already mentioned the source path or bare basename:
            // - source path (~/.codex/generated_images/...) is unreachable from
            //   the web client (not in `/api/file` allowlist), so emitting our
            //   public copy alongside is what makes the image actually visible
            // - bare basename in model prose ("saved as ig_x.png") is not a
            //   renderable path, so suppressing the public path emit would
            //   regress to the original "no image visible" bug.
            const currentText = args.getLastAssistantText()
            const toEmit = copied
              .filter(({ publicPath }) => !currentText.includes(publicPath))
              .map((c) => c.publicPath)
            if (toEmit.length > 0) {
              // Surrounding blank lines ensure the frontend's "absolute path on
              // its own line → render attachment" recognizer matches each path.
              const imgText = `\n\n${toEmit.join('\n')}\n`
              this.emit('message', {
                type: 'stream_event',
                session_id: this.threadId,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: imgText },
                },
              } as unknown as RunnerMessage)
              args.setLastAssistantText(currentText + imgText)
            }
            if (failedNames.length > 0) {
              // Per Codex review: don't emit unreachable source paths. Just tell
              // the user copy failed so the absence of an attachment is
              // explained — a UI "silent drop" is worse than an error line.
              const note = `\n\n[image copy failed: ${failedNames.join(', ')}]\n`
              this.emit('message', {
                type: 'stream_event',
                session_id: this.threadId,
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: note },
                },
              } as unknown as RunnerMessage)
              args.setLastAssistantText(args.getLastAssistantText() + note)
            }
          }
        } catch (err) {
          // Image surfacing must never block the turn from settling. Worst case
          // the user sees the (possibly empty) original assistant text.
          log.warn('codex image scan/copy failed', {
            sessionKey: this.opts.sessionKey,
            err: (err as Error).message,
          })
        }
      }

      const finalAssistantText = args.getLastAssistantText()
      log.info('codex turn end', {
        sessionKey: this.opts.sessionKey,
        code,
        signal,
        durationMs,
        assistantChars: finalAssistantText.length,
        imageFiles,
      })

      if (code === 0) {
        this.emitResult({
          durationMs,
          ok: true,
          text: finalAssistantText,
          usage: args.usage,
        })
      } else {
        const errMsg =
          stderrBuf.trim().slice(-2000) || `codex exec exited code=${code} signal=${signal ?? ''}`
        this.emitResult({
          durationMs,
          ok: false,
          error: errMsg,
        })
      }
    } catch (err) {
      // Synchronous throws from this.emit / emitResult / log.* would otherwise
      // become unhandled promise rejections (close handler calls us via
      // `void this.finalizeTurn(...)`). settle() still fires from finally.
      log.error('codex turn finalize failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
    } finally {
      settle()
    }
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
      result: opts.ok ? (opts.text ?? '') : (opts.error ?? 'codex error'),
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
