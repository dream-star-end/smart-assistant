import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { paths } from '@openclaude/storage'
import { _sanitizeThreadId, buildCodexEnv, copyImagePathsToPublicDir } from './codexRunner.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'codexAppServerRunner' })

// ───────────────────────────────────────────────
// CodexAppServerRunner
//
// Drop-in replacement for the legacy CodexRunner that talks to a long-lived
// `codex app-server --listen stdio://` JSON-RPC subprocess instead of spawning
// `codex exec` per turn. Wins over CodexRunner:
//   1. Token-level streaming via `item/agentMessage/delta` notifications, so
//      the web client can render assistant text as it arrives instead of
//      waiting for `item.completed agent_message` at end of turn.
//   2. Native `imageGeneration` thread item with `savedPath` field, removing
//      the directory-baseline-diff dance the exec runner relied on (codex
//      `--json` exec stream omits image_gen events).
//
// Emits the same SubprocessRunner-shaped events sessionManager subscribes to:
//   session_id, spawn, exit, message, error, telemetry, parse_error
// Exposes the same public surface (start/submit/shutdown/interrupt/
// updateConfig/setEffortLevel/sendPermissionResponse, isRunning getter,
// lastActivityAt + effortLevel fields) so it slots in via the existing
// `as unknown as SubprocessRunner` cast in sessionManager.
//
// Protocol notes (codex app-server v2 — verified against schemas at
// /tmp/codex-protocol/v2 and live spike on 2026-04-30):
//   - Line-delimited JSON-RPC 2.0 over stdio, bidirectional (server can issue
//     requests too — we always reply -32601 method-not-found because there is
//     no UI back-channel for permission/approval prompts in OpenClaude).
//   - Handshake: `initialize { clientInfo: { name, version } }` once per proc.
//   - Thread create: `thread/start { approvalPolicy: 'never', sandbox: 'danger-full-access', cwd, model? }`.
//     Resume: `thread/resume { threadId, approvalPolicy, sandbox, cwd?, model? }`.
//   - Turn: `turn/start { threadId, input: [{type:'text', text}] }` returns
//     `{ turn: { id, status:'inProgress' } }`. Turn id captured for filtering
//     and `turn/interrupt`.
//   - Notifications during a turn:
//       item/started / item/completed { threadId, turnId, item }
//       item/agentMessage/delta       { threadId, turnId, itemId, delta }
//       turn/completed                { threadId, turn: { id, status, durationMs, error? } }
//     status enum: completed | interrupted | failed | inProgress.
// ───────────────────────────────────────────────

export interface CodexAppServerRunnerOpts {
  sessionKey: string
  agentId: string
  cwd: string
  /** Previously captured codex thread_id — continue the conversation. Caller
   *  must ensure this is a codex thread_id, not a CCB session id; sessionManager
   *  enforces this via provider-tagged resume map. */
  resumeSessionId?: string
  /** Agent model id from agents.yaml (e.g. `gpt-5-codex`). Forwarded to
   *  thread/start/resume so codex picks the right model. */
  model?: string
}

interface QueuedTurn {
  prompt: string
  resolve: () => void
  reject: (err: Error) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
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
  event?: unknown
}

type JsonRpcLine =
  | {
      kind: 'response'
      id: number | string
      result?: unknown
      error?: { code: number; message: string }
    }
  | { kind: 'server-request'; id: number | string; method: string; params?: unknown }
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'unknown' }

/**
 * Classify a JSON-RPC line. Codex app-server uses bidirectional JSON-RPC 2.0:
 *   - Response: { id, result } or { id, error } — reply to one of our requests.
 *   - Server request: { id, method, params } — server expects a response.
 *   - Notification: { method, params } — fire-and-forget event.
 * Anything else (including non-JSON) is `unknown` and surfaced via parse_error.
 */
export function _classifyJsonRpcLine(line: string): JsonRpcLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'unknown' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unknown' }
  const m = parsed as Record<string, unknown>
  if (typeof m.method === 'string') {
    if ('id' in m && (typeof m.id === 'number' || typeof m.id === 'string')) {
      return {
        kind: 'server-request',
        id: m.id as number | string,
        method: m.method,
        params: m.params,
      }
    }
    return { kind: 'notification', method: m.method, params: m.params }
  }
  if (
    'id' in m &&
    (typeof m.id === 'number' || typeof m.id === 'string') &&
    ('result' in m || 'error' in m)
  ) {
    return {
      kind: 'response',
      id: m.id as number | string,
      result: m.result,
      error: m.error as { code: number; message: string } | undefined,
    }
  }
  return { kind: 'unknown' }
}

export class CodexAppServerRunner extends EventEmitter {
  private threadId: string | null
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 0
  private pending = new Map<number, PendingRequest>()
  private queue: QueuedTurn[] = []
  private processing = false
  private shuttingDown = false
  private spawnEmitted = false
  private initialized = false
  /** True iff the *current* app-server proc has done thread/start or
   *  thread/resume for this.threadId. Cleared when the proc dies. Distinct
   *  from `initialized` (which tracks the JSON-RPC handshake) — re-spawning
   *  the proc requires re-attaching even when threadId is known. */
  private attached = false
  private activeTurnId: string | null = null
  /** Promise wired into `turn/completed` notification handling. Set by runTurn
   *  before sending `turn/start`, resolved by handleNotification on
   *  `turn/completed` for the matching turnId. */
  private currentTurnCompleter: {
    resolve: (turn: { status?: string; durationMs?: number; error?: { message?: string } }) => void
    reject: (err: Error) => void
  } | null = null
  private stdoutBuf = ''
  /** Accumulated assistant text for the current turn — used to dedupe
   *  imageGeneration savedPath emissions against text the model already
   *  surfaced via deltas. */
  private currentAssistantBuf = ''

  // ── SubprocessRunner interface parity (referenced by sessionManager.ts) ──
  public lastActivityAt: number = Date.now()
  public effortLevel: string | undefined = undefined

  get isRunning(): boolean {
    return this.proc != null || this.processing
  }

  updateConfig(_config: unknown): void {
    // codex doesn't read gateway config; no-op.
  }

  setEffortLevel(_level: string | undefined): void {
    // We could pass `effort` on turn/start but there's no immediate caller
    // for that path in codex-native — keep parity with CodexRunner no-op.
  }

  sendPermissionResponse(_requestId: string, _response: unknown): boolean {
    // Same rationale as CodexRunner: app-server is launched with
    // approvalPolicy=never + sandbox=danger-full-access, so it never asks for
    // approval. If future codex versions emit a request anyway, the
    // server-request branch in handleLine answers method-not-found.
    return false
  }

  interrupt(): boolean {
    if (!this.proc || this.proc.killed) return false
    if (!this.threadId || !this.activeTurnId) return false
    void this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    }).catch((err) => {
      // Common case: the turn already completed between us deciding to
      // interrupt and the request landing. Codex returns -32602/etc — we
      // log at warn and move on; runTurn will settle via turn/completed
      // (status=completed) anyway.
      log.warn('turn/interrupt failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
    })
    return true
  }

  constructor(private opts: CodexAppServerRunnerOpts) {
    super()
    this.threadId = opts.resumeSessionId ?? null
    // attached is intentionally false on construction even if we have a
    // resumed threadId — the first turn must explicitly thread/resume into
    // the freshly spawned proc.
  }

  async start(): Promise<void> {
    // Subprocess is lazily spawned on first turn (matches CodexRunner
    // semantics — sessionManager polls isRunning and wires up runner.on()
    // listeners between start and submit, so emitting spawn synchronously is
    // expected). The actual `codex app-server` proc starts on first runTurn.
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
    // Same transient-shutdown semantics as CodexRunner: kill the current
    // proc, drain queue, but allow subsequent submit() to respawn. effort
    // switching and auth-token refresh paths rely on this.
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
    for (const q of pending) q.reject(new Error('CodexAppServerRunner shutdown'))
    // Reject any in-flight JSON-RPC requests so callers don't hang forever.
    for (const [, p] of this.pending) {
      p.reject(new Error('CodexAppServerRunner shutdown'))
    }
    this.pending.clear()
    // Reject the in-flight turn (if any) so runTurn's await-completer doesn't
    // wedge — the proc.close handler also does this, but shutdown can be
    // called before the close event fires (race).
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error('CodexAppServerRunner shutdown'))
      this.currentTurnCompleter = null
    }
    this.activeTurnId = null
    this.initialized = false
    this.attached = false
    this.proc = null
    this.stdoutBuf = ''
    this.emit('exit', { code: 0, signal: null, crashed: false })
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

  private async ensureSpawned(): Promise<void> {
    if (this.proc && !this.proc.killed && this.initialized) return
    if (this.proc && !this.proc.killed && !this.initialized) {
      // Spawn happened but initialize is in flight — caller will await.
      return
    }
    // Clear any partial-line residue from a prior proc (Codex review
    // #019dde20 BLOCKER round 3): stdoutBuf is runner-scoped, so without
    // this, a fragment like '{"jsonrpc":"2.0",' left by the old proc would
    // get prepended to the new proc's first stdout chunk and corrupt the
    // initialize response.
    this.stdoutBuf = ''
    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCodexEnv(),
    })
    this.proc = proc
    proc.stdout.on('data', (chunk: Buffer) => {
      // Identity guard (Codex review #019dde20 BLOCKER round 2): a stale
      // stdout frame from a discarded proc must NOT be parsed against the new
      // runner state. Without this, an old proc's queued `item/agentMessage/
      // delta` could land while a fresh `turn/start` is in flight and the
      // early-adopt path would attribute the old turn's text to the new turn.
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now()
      this.stdoutBuf += chunk.toString('utf8')
      let nl = this.stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = this.stdoutBuf.slice(0, nl).trim()
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
        if (line) this.handleLine(line)
        nl = this.stdoutBuf.indexOf('\n')
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      // Same identity guard rationale as stdout — stderr is just structured
      // log, but mis-attributing an old proc's stderr to the current session
      // is misleading in the journal.
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now()
      // Codex app-server logs structured errors to stderr; surface them at
      // warn level so the journal has them but they don't fail the turn —
      // the JSON-RPC error response is the source of truth for failures.
      log.warn('codex app-server stderr', {
        sessionKey: this.opts.sessionKey,
        line: chunk.toString('utf8').trim().slice(0, 1024),
      })
    })
    proc.on('error', (err) => {
      // Identity check: a delayed error from a discarded proc must not corrupt
      // a freshly spawned one. shutdown() (or a previous close) may have already
      // re-pointed `this.proc` at a new child by the time this fires.
      if (this.proc !== proc) {
        log.info('codex app-server stale proc error ignored', {
          sessionKey: this.opts.sessionKey,
          err: err.message,
        })
        return
      }
      log.error('codex app-server proc error', { err: err.message })
      this.emit('error', err)
      this.failAllPending(`codex app-server process error: ${err.message}`)
      this.proc = null
      this.initialized = false
      this.attached = false
      // stdoutBuf cleared so any partial-line residue doesn't poison the
      // next proc's first response (see ensureSpawned for fuller comment).
      this.stdoutBuf = ''
    })
    proc.on('close', (code, signal) => {
      // Identity check: see the `error` handler comment. Without this, the
      // sequence shutdown → submit → respawn → old-proc-close-fires would
      // null out the new proc and reject its pending requests.
      if (this.proc !== proc) {
        log.info('codex app-server stale proc close ignored', {
          sessionKey: this.opts.sessionKey,
          code,
          signal,
        })
        return
      }
      log.info('codex app-server proc close', {
        sessionKey: this.opts.sessionKey,
        code,
        signal,
      })
      const wasShutdown = this.shuttingDown
      // Reject any remaining pending JSON-RPC requests AND the in-flight turn
      // promise so callers don't hang. emitResult is the responsibility of
      // runTurn's catch — we just unwedge promises here.
      if (!wasShutdown) {
        this.failAllPending(`codex app-server exited code=${code} signal=${signal ?? ''}`)
      }
      this.proc = null
      this.initialized = false
      this.attached = false
      this.activeTurnId = null
      // Clear stdoutBuf so the next proc's first response isn't prepended
      // with a partial line residue from this dying proc.
      this.stdoutBuf = ''
      this.emit('exit', {
        code: code ?? 0,
        signal,
        crashed: code != null && code !== 0 && !wasShutdown,
      })
    })

    // JSON-RPC handshake. Codex schema lists `clientInfo: { name, version }`
    // (verified by spike). We call the proc fresh-spawned so writes won't
    // EPIPE.
    await this.sendRequest('initialize', {
      clientInfo: { name: 'openclaude-gateway', version: '1.0' },
    })
    this.initialized = true
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(reason))
    }
    this.pending.clear()
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error(reason))
      this.currentTurnCompleter = null
    }
  }

  private writeRaw(line: string): void {
    if (!this.proc || this.proc.killed) return
    try {
      this.proc.stdin.write(`${line}\n`)
    } catch (err) {
      // EPIPE if proc died between our check and write — fail pending so
      // callers settle.
      log.warn('codex app-server stdin write failed', {
        err: (err as Error).message,
      })
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private handleLine(line: string): void {
    const msg = _classifyJsonRpcLine(line)
    if (msg.kind === 'unknown') {
      this.emit('parse_error', { line, error: 'unknown JSON-RPC shape' })
      return
    }
    if (msg.kind === 'response') {
      const numId = typeof msg.id === 'number' ? msg.id : Number(msg.id)
      const p = this.pending.get(numId)
      if (!p) {
        log.warn('orphan JSON-RPC response', {
          sessionKey: this.opts.sessionKey,
          id: msg.id,
        })
        return
      }
      this.pending.delete(numId)
      if (msg.error) {
        p.reject(new Error(`${p.method} -> ${msg.error.code}: ${msg.error.message}`))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (msg.kind === 'server-request') {
      // Server-initiated requests (e.g. permission prompts, MCP elicitations)
      // are not handled because we run with approvalPolicy=never. Reply
      // method-not-found per JSON-RPC spec so codex doesn't hang.
      this.writeRaw(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32601,
            message: `method '${msg.method}' not implemented by openclaude-gateway`,
          },
        }),
      )
      return
    }
    if (msg.kind === 'notification') {
      this.handleNotification(msg.method, msg.params)
      return
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return
    const p = params as Record<string, unknown>
    const turnId = typeof p.turnId === 'string' ? p.turnId : undefined

    // Filter turn-scoped notifications. codex may emit notifications for
    // system-internal turns (compaction, hooks) that the client should ignore.
    //
    // Subtle ordering issue (Codex review #019dde20 MAJOR 3): turn/start is a
    // request whose Promise resolution is a microtask, but stdout `data`
    // events deliver subsequent notifications synchronously inside the same
    // chunk. So a notification carrying the turnId can arrive (and run
    // through handleNotification) BEFORE runTurn assigns activeTurnId from
    // the resolved request. To avoid dropping early tokens/items, when a turn
    // is in flight (`currentTurnCompleter` set) and `activeTurnId` is still
    // null, we adopt the first turnId we see.
    if (turnId) {
      if (this.activeTurnId === null) {
        if (this.currentTurnCompleter) {
          this.activeTurnId = turnId
        } else {
          // No turn in flight → server-internal turn we don't track. Drop.
          return
        }
      } else if (turnId !== this.activeTurnId) {
        return
      }
    }

    if (method === 'item/agentMessage/delta') {
      const delta = typeof p.delta === 'string' ? p.delta : ''
      if (!delta) return
      this.currentAssistantBuf += delta
      this.emit('message', {
        type: 'stream_event',
        session_id: this.threadId,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta },
        },
      } as unknown as RunnerMessage)
      return
    }
    if (method === 'item/started') {
      this.handleItemStarted(p.item)
      return
    }
    if (method === 'item/completed') {
      void this.handleItemCompleted(p.item)
      return
    }
    if (method === 'turn/completed') {
      // Per schema: { threadId, turn: { id, status, durationMs, error? } }
      const turn = p.turn as Record<string, unknown> | undefined
      if (!turn) return
      // Defensive: even though we already filtered turnId above (via top-level
      // p.turnId), turn.id is the authoritative id on this notification —
      // re-check.
      const tid = typeof turn.id === 'string' ? turn.id : undefined
      if (tid && this.activeTurnId && tid !== this.activeTurnId) return
      if (this.currentTurnCompleter) {
        this.currentTurnCompleter.resolve(
          turn as Parameters<typeof this.currentTurnCompleter.resolve>[0],
        )
        this.currentTurnCompleter = null
      }
      return
    }
    // Other notifications (turn/started, plan/delta, config-warning, etc.)
    // are dropped — they are observability/UI hints that don't gate the
    // turn lifecycle.
  }

  private handleItemStarted(itemUnk: unknown): void {
    if (!itemUnk || typeof itemUnk !== 'object') return
    const item = itemUnk as Record<string, unknown>
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type
    if (itemType === 'commandExecution') {
      const cmd = typeof item.command === 'string' ? item.command : ''
      this.emitAssistantToolUse(itemId, 'Bash', {
        command: stripShellWrapper(cmd),
        description: 'codex commandExecution',
      })
      return
    }
    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
      const first = (changes[0] ?? {}) as Record<string, unknown>
      const kind = (first.kind as { type?: string } | undefined)?.type
      const name = kind === 'add' ? 'Write' : 'Edit'
      this.emitAssistantToolUse(itemId, name, {
        file_path: typeof first.path === 'string' ? first.path : '',
        kind,
        changes,
      })
      return
    }
    // agentMessage / reasoning are streamed via deltas; nothing to surface
    // here. Other types (mcpToolCall, webSearch, imageGeneration, ...)
    // surface as generic tool_use so the user sees something happened —
    // keeps parity with CodexRunner.
    if (
      itemType &&
      itemType !== 'agentMessage' &&
      itemType !== 'reasoning' &&
      typeof itemType === 'string'
    ) {
      this.emitAssistantToolUse(itemId, `Codex:${itemType}`, item)
    }
  }

  private async handleItemCompleted(itemUnk: unknown): Promise<void> {
    if (!itemUnk || typeof itemUnk !== 'object') return
    const item = itemUnk as Record<string, unknown>
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type
    if (itemType === 'commandExecution') {
      const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
      const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined
      this.emitToolResult(itemId, out, exit != null && exit !== 0)
      return
    }
    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
      const summary = changes
        .map((c) => {
          const o = c as Record<string, unknown>
          const k = (o.kind as { type?: string } | undefined)?.type
          return `${k ?? 'change'}: ${o.path ?? ''}`
        })
        .join('\n')
      this.emitToolResult(itemId, summary || 'file changes applied', false)
      return
    }
    if (itemType === 'imageGeneration') {
      // codex's image_gen tool: schema gives savedPath as an absolute path
      // (AbsolutePathBuf). Copy into FILE_ALLOWED_DIRS-allowed public dir,
      // then emit the public path as a text_delta so frontend renders it.
      // This replaces the old fs-baseline-diff trick from CodexRunner.
      const saved = typeof item.savedPath === 'string' ? item.savedPath : ''
      if (!saved || !this.threadId) {
        this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
        return
      }
      try {
        const { copied, failedNames } = await copyImagePathsToPublicDir(
          this.threadId,
          [saved],
          paths.generatedDir,
        )
        const newEmits = copied
          .filter(({ publicPath }) => !this.currentAssistantBuf.includes(publicPath))
          .map((c) => c.publicPath)
        if (newEmits.length > 0) {
          // Surrounding blank lines so frontend's "absolute path on its own
          // line → render attachment" recognizer matches each path.
          const text = `\n\n${newEmits.join('\n')}\n`
          this.currentAssistantBuf += text
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            },
          } as unknown as RunnerMessage)
        }
        if (failedNames.length > 0) {
          const note = `\n\n[image copy failed: ${failedNames.join(', ')}]\n`
          this.currentAssistantBuf += note
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: note },
            },
          } as unknown as RunnerMessage)
        }
      } catch (err) {
        log.warn('codex app-server image copy failed', {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        })
      }
      // Also emit the original tool_result for the imageGeneration card so
      // the UI's tool-call panel reflects the call.
      this.emitToolResult(itemId, `imageGeneration → ${saved}`, false)
      return
    }
    if (itemType === 'agentMessage' || itemType === 'reasoning') {
      // Already streamed via deltas; no separate tool_result needed.
      return
    }
    // Generic completion for unknown item types
    this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
  }

  private async runTurn(prompt: string): Promise<void> {
    const startedAt = Date.now()
    log.info('codex app-server turn start', {
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      promptChars: prompt.length,
    })
    this.currentAssistantBuf = ''

    try {
      await this.ensureSpawned()

      // Each fresh app-server proc must explicitly attach a thread before
      // turn/start. `attached` is per-proc (cleared on close/error), so this
      // fires correctly on:
      //   1. first turn after construction (no threadId → thread/start)
      //   2. first turn after construction with resumeSessionId (thread/resume)
      //   3. first turn after proc respawn (shutdown / crash) — re-attach via
      //      thread/resume against the captured threadId.
      if (!this.attached) {
        if (!this.threadId) {
          const res = (await this.sendRequest('thread/start', {
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            cwd: this.opts.cwd,
            ...(this.opts.model ? { model: this.opts.model } : {}),
          })) as { thread?: { id?: string } } | undefined
          const tid = res?.thread?.id
          if (typeof tid !== 'string' || !tid) {
            throw new Error('thread/start did not return thread.id')
          }
          this.threadId = tid
          this.emit('session_id', tid)
        } else {
          await this.sendRequest('thread/resume', {
            threadId: this.threadId,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            cwd: this.opts.cwd,
            ...(this.opts.model ? { model: this.opts.model } : {}),
          })
        }
        this.attached = true
      }

      // Set up the completion box BEFORE turn/start so a fast turn/completed
      // notification (rare but possible) doesn't slip past us.
      const completed = new Promise<{
        status?: string
        durationMs?: number
        error?: { message?: string }
      }>((resolve, reject) => {
        this.currentTurnCompleter = { resolve, reject }
      })

      const tres = (await this.sendRequest('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt }],
      })) as { turn?: { id?: string } } | undefined
      const turnId = tres?.turn?.id
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('turn/start did not return turn.id')
      }
      this.activeTurnId = turnId

      const turn = await completed
      this.activeTurnId = null

      const durationMs = Date.now() - startedAt
      const status = turn?.status
      log.info('codex app-server turn end', {
        sessionKey: this.opts.sessionKey,
        status,
        durationMs,
        assistantChars: this.currentAssistantBuf.length,
      })

      if (status === 'completed') {
        this.emitResult({
          durationMs,
          ok: true,
          text: this.currentAssistantBuf,
        })
      } else if (status === 'failed') {
        const errMsg = turn?.error?.message ?? 'codex turn failed'
        // Surface error in the stream so the UI shows something — without
        // this, a failed turn after deltas would leave the user wondering.
        this.emit('message', {
          type: 'stream_event',
          session_id: this.threadId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `\n\n[turn failed: ${errMsg}]\n` },
          },
        } as unknown as RunnerMessage)
        this.emitResult({ durationMs, ok: false, error: errMsg })
      } else if (status === 'interrupted') {
        this.emitResult({ durationMs, ok: false, error: 'codex turn interrupted' })
      } else {
        this.emitResult({
          durationMs,
          ok: false,
          error: `codex turn unexpected status=${status ?? 'unknown'}`,
        })
      }
    } catch (err) {
      this.activeTurnId = null
      this.currentTurnCompleter = null
      const durationMs = Date.now() - startedAt
      log.error('codex app-server turn failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      this.emitResult({
        durationMs,
        ok: false,
        error: `codex app-server: ${(err as Error).message}`,
      })
      // Do NOT re-throw — drain() catches and rejects the queue entry, but
      // upstream sessionManager handles errors via the result message above.
    }
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

/**
 * Codex wraps every shell command in `/bin/bash -lc '...'`. Strip that wrapper
 * for a cleaner display — the ccb Bash tool card shows the raw user command.
 */
function stripShellWrapper(cmd: string): string {
  const m = cmd.match(/^\/bin\/bash\s+-lc\s+'([\s\S]*)'$/)
  if (m) return m[1].replace(/'\\''/g, "'")
  return cmd
}

// Re-export internal helpers for the test harness — the test patches
// `_classifyJsonRpcLine` to feed synthetic JSON-RPC frames.
export { _sanitizeThreadId }
