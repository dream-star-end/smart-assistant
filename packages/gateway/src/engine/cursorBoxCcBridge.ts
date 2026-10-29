/** Local stdio bridge. The gateway speaks stream-json to this process.
 * This process runs official `claude` inside the selected account's Grok Bot
 * box and copies stdout back. It does not call the model itself.
 *
 * Box Claude runs only as the interactive session (tmux + oc-bridge mod), never
 * as `claude -p` (operator rule 2026-10-11): a session that cannot come up
 * fails the turn. Before launching, the bridge asks the master which Box login
 * to run under; after each turn it reports what the output said about that
 * login, and a login that turned out exhausted or logged out ends the session
 * after its result, so the next message relaunches (--resume) on another. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BoxLoginUnavailableError,
  reportBoxLoginSignals,
  requestBoxLogin,
} from './boxLoginClient.js'
import {
  type BoxCcControl,
  type BoxCcExecRequest,
  boxCcSpawnFifo,
  boxCcStopExec,
  boxCcWriteExecs,
  encodeExecRequest,
  execExitCode,
  parseExecFrames,
} from './cursorBoxCcExec.js'
import {
  type BoxBridgeMod,
  type BoxCcRunner,
  boxCcInteractiveAbandonExec,
  boxCcInteractiveLaunchExec,
  boxCcRunnerFromEnv,
  loadBoxBridgeMod,
  remoteInteractiveClaudeArgs,
} from './cursorBoxCcInteractive.js'
import {
  type BoxGptWebMod,
  boxGptWebInteractiveLaunchExec,
  inlineGptWebAttachmentsInUserLine,
  isBoxGptWebModelArgv,
  loadBoxGptWebMod,
  materializeGptWebOutputAttachmentsInStdoutLine,
  remoteInteractiveGptWebArgs,
  stampGptWebTurnIdInUserLine,
} from './cursorBoxGptWeb.js'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

// Both must fit inside the runner's 3s shutdown grace.
const STOP_EXEC_TIMEOUT_MS = 2_000
const STOP_STREAM_GRACE_MS = 300

function readControl(path: string): BoxCcControl {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BoxCcControl>
  if (
    !parsed ||
    typeof parsed.execUrl !== 'string' ||
    typeof parsed.execToken !== 'string' ||
    typeof parsed.networkToken !== 'string' ||
    typeof parsed.remoteClaude !== 'string' ||
    typeof parsed.fifo !== 'string' ||
    typeof parsed.cwd !== 'string'
  ) {
    throw new Error('BOX_CC_CONTROL_INVALID')
  }
  if (!parsed.execUrl.startsWith('https://') || !parsed.fifo.startsWith('/tmp/oc-box-cc-')) {
    throw new Error('BOX_CC_CONTROL_INVALID')
  }
  if (
    parsed.accountId !== undefined &&
    (typeof parsed.accountId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(parsed.accountId))
  ) {
    throw new Error('BOX_CC_CONTROL_INVALID')
  }
  return parsed as BoxCcControl
}

async function postExec(
  control: BoxCcControl,
  body: BoxCcExecRequest,
  fetchImpl: FetchFn,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetchImpl(control.execUrl, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      authorization: `Bearer ${control.execToken}`,
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      'x-anyrun-network-token': control.networkToken,
    },
    // Node fetch accepts Uint8Array; Buffer's generic type currently differs
    // from the DOM BodyInit declaration even though the wire bytes are same.
    body: Uint8Array.from(encodeExecRequest(body)),
  })
  if (!response.ok || !response.body) throw new Error(`BOX_CC_EXEC_FAILED_${response.status}`)
  return response
}

/** What a user sees when a Box Claude turn cannot be served. Never names a quota, a window or an
 * account (the platform's rule for end users); the ops detail stays on stderr. */
export const BOX_TURN_UNAVAILABLE_TEXT = 'Claude 暂时繁忙，这条消息没有完成，请稍后再发一次。'
/** Interactive launches a turn may take before it is reported as failed: the first, and one
 * transparent retry when nothing ran (a host that did not come up, a login the Box refused). */
const LAUNCH_ATTEMPTS = 2
/** A login this close to its window ends the chat's session after the turn (when the master said
 * another login is usable), so the next message moves before a turn is refused. */
const NEAR_LIMIT = 0.98

type SessionOutcome =
  | { kind: 'not_ready'; why: string; unsafe: boolean; retryable: boolean; held: string[] }
  | { kind: 'ended'; code: number }

export async function runBoxCcBridge(opts: {
  control: BoxCcControl
  args: readonly string[]
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  fetchImpl?: FetchFn
  signal?: AbortSignal
  /** Must be `interactive` (the default); anything else is refused. */
  runner?: BoxCcRunner
  bridgeMod?: BoxBridgeMod
  gptWebMod?: BoxGptWebMod
  env?: NodeJS.ProcessEnv
  /** Box login choice and reports (tests); default: the master's egress. */
  login?: BoxLoginPort
  /** Where this container remembers each chat's last login (tests). */
  loginStateDir?: string
}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const env = opts.env ?? process.env
  const isGptWeb = isBoxGptWebModelArgv(opts.args)
  const login: BoxLoginPort =
    opts.login ??
    (isGptWeb
      ? {
          choose: async () => ({
            profile: env.OC_BOX_GPT_WEB_PROFILE || 'default',
            source: 'fallback' as const,
            alternatives: 0,
          }),
          report: async () => true,
        }
      : {
          choose: (accountId, sticky) => requestBoxLogin({ accountId, ...sticky }, { env }),
          report: (input) => reportBoxLoginSignals(input, { env }),
        })
  if ((opts.runner ?? 'interactive') !== 'interactive') {
    opts.stderr.write(`BOX_CC_RUNNER_REFUSED ${String(opts.runner)}\n`)
    return 1
  }
  const accountId = opts.control.accountId
  // A chat keeps its login across bridge restarts when it can: --resume then lands on the login
  // that holds its prompt cache. The master has the last word (benched or deselected logins move).
  const memory = new BoxLoginMemory(
    opts.loginStateDir ?? join(tmpdir(), 'oc-box-cc'),
    opts.control.fifo,
  )
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  opts.signal?.addEventListener('abort', onAbort)
  const holdMax = positiveInt(env.OC_BOX_INTERACTIVE_HOLD_MAX_BYTES) ?? 64 * 1024 * 1024
  const out = new StdoutLines(opts.stdout, env, isGptWeb)
  const maxAttempts = isGptWeb ? 4 : LAUNCH_ATTEMPTS

  // stdin -> the current session; lines that arrive between sessions wait in `carry`.
  let current: BoxSession | null = null
  let carry: string[] = []
  let stdinEnded = false
  const pending = bufferLines(opts.stdin, async (line) => {
    if (abort.signal.aborted) return
    if (current) await current.deliver(line)
    else carry.push(line)
  }).then(async () => {
    stdinEnded = true
    await current?.stop()
  })

  let code = 1
  try {
    for (let attempt = 1; ; attempt++) {
      let profile: string
      let alternatives = 0
      try {
        const prefer = memory.read()
        const chosen = await login.choose(accountId, {
          ...(memory.session ? { session: memory.session } : {}),
          ...(prefer ? { prefer } : {}),
        })
        profile = chosen.profile
        alternatives = chosen.alternatives ?? 0
        memory.write(profile)
        opts.stderr.write(
          `BOX_INTERACTIVE_LOGIN ${profile} ${chosen.source}${prefer && prefer !== profile ? ` moved_from=${prefer}` : ''}\n`,
        )
      } catch (err) {
        opts.stderr.write(
          `${err instanceof BoxLoginUnavailableError ? err.message : 'BOX_LOGIN_UNAVAILABLE'}\n`,
        )
        // Not even the default login is usable; the waiting turn ends plainly.
        out.unavailable(sessionIdOf(opts.args))
        code = 0
        break
      }
      const session = new BoxSession({
        control: {
          ...opts.control,
          fifo: boxCcSpawnFifo(opts.control.fifo, randomBytes(8).toString('hex')),
        },
        args: opts.args,
        profile,
        alternatives,
        accountId,
        bridgeMod: opts.bridgeMod,
        gptWebMod: opts.gptWebMod,
        env,
        held: carry,
        holdMax,
        fetchImpl,
        abort,
        stderr: opts.stderr,
        out,
        login,
        memory,
        // A line that reaches a session after it gave up (nothing ran) belongs to the next attempt.
        late: (line) => {
          carry.push(line)
        },
      })
      if (stdinEnded) {
        code = 0
        break
      } // the gateway retired this process meanwhile
      carry = []
      current = session
      const outcome = await session.run()
      current = null
      if (outcome.kind === 'ended') {
        code = outcome.code
        break
      }
      // Nothing ran on this attempt: its lines are still ours.
      carry = [...outcome.held, ...carry]
      if (outcome.unsafe) {
        // The master benches the login before the retry asks again; this chat stops preferring it.
        await login.report({ accountId, profile, lines: [], unsafe: true }).catch(() => false)
        memory.forget()
      }
      if (outcome.retryable && attempt < maxAttempts && !stdinEnded && !abort.signal.aborted) {
        opts.stderr.write(`BOX_INTERACTIVE_RETRY ${outcome.why}\n`)
        continue
      }
      // There is no `-p` to hand the turn to. The user gets a plain failure for the waiting turn;
      // the bridge is spawned for a turn, so its line is at most a moment away.
      opts.stderr.write(`BOX_INTERACTIVE_NOT_READY_NO_FALLBACK ${outcome.why}\n`)
      const waiting = (): boolean => carry.some((line) => TOP_TYPE.exec(line)?.[1] === 'user')
      for (let i = 0; i < 20 && !waiting() && !stdinEnded && !abort.signal.aborted; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (waiting()) {
        out.unavailable(sessionIdOf(opts.args))
        code = 0
      } else code = 1
      break
    }
  } finally {
    abort.abort()
    opts.signal?.removeEventListener('abort', onAbort)
    if ('destroy' in opts.stdin && typeof opts.stdin.destroy === 'function') {
      opts.stdin.destroy()
    }
    await pending.catch(() => undefined)
    out.flush()
  }
  return code
}

function sessionIdOf(args: readonly string[]): string {
  const at = args.indexOf('--resume')
  return at >= 0 && typeof args[at + 1] === 'string' ? args[at + 1]! : ''
}

/** Whole stream-json lines to the gateway. A line the CLI synthesized about a quota or a login
 * (shown to the user as assistant text, or as a failed result's text) is reworded neutrally. */
class StdoutLines {
  private buf = ''
  private rawDeliveredTurnText = ''
  private deliveredTurnText = ''
  constructor(
    private readonly stdout: NodeJS.WritableStream,
    private readonly env?: NodeJS.ProcessEnv,
    private readonly isGptWeb = false,
  ) {}
  getRawDeliveredTurnText(): string {
    return this.rawDeliveredTurnText
  }
  discardIncompleteLine(): void {
    this.buf = ''
  }
  private transformLine(line: string): string {
    if (!line) return line
    if (this.isGptWeb && line.startsWith('{')) {
      try {
        const rawObj = JSON.parse(line) as Record<string, any>
        if (
          rawObj?.type === 'stream_event' &&
          rawObj.event?.type === 'content_block_delta' &&
          rawObj.event.delta?.type === 'text_delta' &&
          typeof rawObj.event.delta.text === 'string'
        ) {
          this.rawDeliveredTurnText += rawObj.event.delta.text
        }
      } catch {}
    }
    const transformed = materializeGptWebOutputAttachmentsInStdoutLine(neutralLine(line), {
      env: this.env,
    })
    if (this.isGptWeb && transformed.startsWith('{')) {
      try {
        const obj = JSON.parse(transformed) as Record<string, any>
        if (
          obj?.type === 'stream_event' &&
          obj.event?.type === 'content_block_delta' &&
          obj.event.delta?.type === 'text_delta' &&
          typeof obj.event.delta.text === 'string'
        ) {
          this.deliveredTurnText += obj.event.delta.text
        } else if (obj?.type === 'assistant' && Array.isArray(obj.message?.content)) {
          const textBlock = obj.message.content.find(
            (b: Record<string, unknown>) => b?.type === 'text' && typeof b.text === 'string',
          )
          const fullText = typeof textBlock?.text === 'string' ? textBlock.text : ''
          if (
            fullText.length > this.deliveredTurnText.length &&
            fullText.startsWith(this.deliveredTurnText)
          ) {
            const missingSuffix = fullText.slice(this.deliveredTurnText.length)
            this.deliveredTurnText = fullText
            const backfillDelta = JSON.stringify({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text: missingSuffix,
                },
              },
            })
            return `${backfillDelta}\n${transformed}`
          }
        } else if (obj?.type === 'result') {
          this.rawDeliveredTurnText = ''
          this.deliveredTurnText = ''
        }
      } catch {}
    }
    return transformed
  }
  write(data: string): void {
    this.buf += data
    const cut = this.buf.lastIndexOf('\n')
    if (cut < 0) return
    const whole = this.buf.slice(0, cut + 1)
    this.buf = this.buf.slice(cut + 1)
    this.stdout.write(
      whole
        .split('\n')
        .map((l) => this.transformLine(l))
        .join('\n'),
    )
  }
  flush(): void {
    if (this.buf) this.stdout.write(this.transformLine(this.buf))
    this.buf = ''
  }
  /** A failed result for the waiting turn, in the CLI's own result shape (the parser finalizes it). */
  unavailable(sessionId: string): void {
    this.flush()
    this.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 0,
        result: BOX_TURN_UNAVAILABLE_TEXT,
        stop_reason: null,
        session_id: sessionId,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        permission_denials: [],
        errors: ['BOX_INTERACTIVE_UNAVAILABLE'],
      })}\n`,
    )
  }
}

const QUOTA_OR_LOGIN =
  /hit your .*limit|usage limit|rate limit|limit reached|Not logged in|Please run \/login|resets? (at )?\d/i

function neutralLine(line: string): string {
  if (line.includes('[box-gpt-6-astra-pro]')) return line
  const type = TOP_TYPE.exec(line)?.[1]
  if (type !== 'assistant' && type !== 'result') return line
  if (!QUOTA_OR_LOGIN.test(line)) return line
  let record: Record<string, any>
  try {
    record = JSON.parse(line) as Record<string, any>
  } catch {
    return line
  }
  if (
    type === 'assistant' &&
    record.message?.model === '<synthetic>' &&
    Array.isArray(record.message.content)
  ) {
    record.message.content = record.message.content.map((block: Record<string, unknown>) =>
      typeof block?.text === 'string' && QUOTA_OR_LOGIN.test(block.text)
        ? { ...block, text: BOX_TURN_UNAVAILABLE_TEXT }
        : block,
    )
    return JSON.stringify(record)
  }
  if (
    type === 'result' &&
    record.is_error === true &&
    typeof record.result === 'string' &&
    QUOTA_OR_LOGIN.test(record.result)
  ) {
    record.result = BOX_TURN_UNAVAILABLE_TEXT
    return JSON.stringify(record)
  }
  return line
}

/** One interactive Box session: launch under one login, hold the gateway's lines until the host is
 * READY (so a session that never came up ran nothing and can be retried or failed cleanly), then
 * write each line, read stdout, and stop on request. */
class BoxSession {
  private held: string[] | null
  private heldBytes = 0
  private readySeen = false
  private abandoned: string | null = null
  private hostStreamEnded = false
  private sawStdout = false
  private hostErr = ''
  private gate: Promise<void> = Promise.resolve()
  private lineSeq = 0
  private exitCode = 1
  private sawExit = false
  private stopRequested = false
  private failedWriteCleanup: Promise<void> | undefined
  private writeFailed = false
  private closing = false
  private writing: Promise<void> = Promise.resolve()
  private readonly signals = new BoxLoginSignalTap()
  private readonly abort = new AbortController()
  /** Set once the session gave up before READY: later lines go back to the bridge. */
  private gaveUp = false
  /** In-flight user turn line for box-gpt-6-astra-pro so mid-turn stream disconnects can reconnect and resume. */
  private activeGptWebUserLine: string | null = null

  constructor(
    private readonly o: {
      control: BoxCcControl
      args: readonly string[]
      profile: string
      alternatives: number
      accountId: string | undefined
      bridgeMod?: BoxBridgeMod
      gptWebMod?: BoxGptWebMod
      env?: NodeJS.ProcessEnv
      held: string[]
      holdMax: number
      fetchImpl: FetchFn
      abort: AbortController
      stderr: NodeJS.WritableStream
      out: StdoutLines
      login: BoxLoginPort
      memory: BoxLoginMemory
      late: (line: string) => void
    },
  ) {
    this.held = [...o.held]
    for (const line of this.held) this.heldBytes += Buffer.byteLength(line)
    const parent = (): void => this.abort.abort()
    if (o.abort.signal.aborted) parent()
    else o.abort.signal.addEventListener('abort', parent, { once: true })
  }

  private get control(): BoxCcControl {
    return this.o.control
  }

  // The write runs as its own exec in the box. A request whose response the
  // transport lost is sent once more: the box script never writes a numbered
  // line twice. An exec that ran and did not exit 0 did not deliver the line,
  // so the bridge stops instead of waiting for an answer.
  private async writeExec(body: BoxCcExecRequest): Promise<void> {
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.abort.signal.aborted) return
      const writer = new AbortController()
      const timer = setTimeout(() => writer.abort(), 20_000)
      let code: number | null
      try {
        const response = await postExec(this.control, body, this.o.fetchImpl, writer.signal)
        code = execExitCode(Buffer.from(await response.arrayBuffer()))
      } catch (err) {
        last = err
        continue
      } finally {
        clearTimeout(timer)
      }
      if (code === 0) return
      throw new Error(`BOX_CC_WRITE_EXIT_${code ?? 'MISSING'}`)
    }
    throw last instanceof Error ? last : new Error('BOX_CC_WRITE_FAILED')
  }

  private writeLine(line: string): Promise<void> {
    this.writing = this.sendLine(line)
    return this.writing
  }

  private async sendLine(line: string): Promise<void> {
    try {
      const isGptWeb = isBoxGptWebModelArgv(this.o.args)
      const stampedLine =
        isGptWeb && TOP_TYPE.exec(line)?.[1] === 'user'
          ? stampGptWebTurnIdInUserLine(line)
          : line
      const payload = isGptWeb
        ? inlineGptWebAttachmentsInUserLine(stampedLine, { env: this.o.env })
        : stampedLine
      for (const body of boxCcWriteExecs(this.control, payload, ++this.lineSeq))
        await this.writeExec(body)
      if (isGptWeb && TOP_TYPE.exec(stampedLine)?.[1] === 'user') {
        this.activeGptWebUserLine = stampedLine
      }
    } catch (err) {
      if (this.writeFailed) return
      this.writeFailed = true
      const message = err instanceof Error ? err.message : 'BOX_CC_WRITE_FAILED'
      this.o.stderr.write(`BOX_CC_WRITE_FAILED ${message}\n`)
      // The interactive host would otherwise keep its tmux session until this
      // chat's next launch reaps it; end it now (best effort, as stop()).
      const stopper = new AbortController()
      const timer = setTimeout(() => stopper.abort(), STOP_EXEC_TIMEOUT_MS)
      timer.unref?.()
      this.failedWriteCleanup = postExec(
        this.control,
        boxCcStopExec(this.control),
        this.o.fetchImpl,
        stopper.signal,
      )
        .then(async (response) => {
          await response.arrayBuffer()
        })
        .catch(() => undefined)
        .finally(() => clearTimeout(timer))
      this.abort.abort()
    }
  }

  /** Ends a host that is not ready yet. The launch may not have started it, so
   * the abandon exec repeats until its stream has ended. */
  private abandon(why: string): void {
    if (this.abandoned || this.readySeen) return
    this.abandoned = why
    this.o.stderr.write(`BOX_INTERACTIVE_ABANDON ${why}\n`)
    void (async () => {
      for (
        let attempt = 0;
        attempt < 30 && !this.hostStreamEnded && !this.abort.signal.aborted;
        attempt++
      ) {
        const stopper = new AbortController()
        const timer = setTimeout(() => stopper.abort(), STOP_EXEC_TIMEOUT_MS)
        try {
          const response = await postExec(
            this.control,
            boxCcInteractiveAbandonExec(this.control),
            this.o.fetchImpl,
            stopper.signal,
          )
          await response.arrayBuffer()
        } catch {
          // Tried again below while the host's stream is open.
        } finally {
          clearTimeout(timer)
        }
        if (!this.hostStreamEnded) await new Promise((r) => setTimeout(r, 1_000))
      }
    })()
  }

  async deliver(line: string): Promise<void> {
    await this.gate
    if (this.gaveUp) {
      this.o.late(line)
      return
    }
    if (this.closing) {
      this.o.late(line)
      return
    }
    if (this.abort.signal.aborted) return
    if (this.held) {
      this.held.push(line)
      this.heldBytes += Buffer.byteLength(line)
      if (this.heldBytes > this.o.holdMax) this.abandon('held_overflow')
      return
    }
    await this.writeLine(line)
  }

  /** Sends `lines` first; later lines wait behind them. */
  private flushFirst(lines: string[]): Promise<void> {
    let release!: () => void
    this.gate = new Promise((resolveGate) => {
      release = resolveGate
    })
    return (async () => {
      try {
        for (const line of lines) {
          if (this.closing || this.abort.signal.aborted) break
          await this.writeLine(line)
        }
      } finally {
        release()
      }
    })()
  }

  // Closed stdin is the gateway retiring this process (shutdown, model switch,
  // idle recycle). Claude in the box cannot see that EOF, so end it there and
  // report a clean exit; otherwise the runner has to SIGKILL this bridge and
  // the box Claude lives on, still attached to the session. The same clean end
  // retires a session whose login should not take the chat's next message.
  async stop(): Promise<void> {
    if (this.abort.signal.aborted || this.stopRequested) return
    this.stopRequested = true
    const stopper = new AbortController()
    const timer = setTimeout(() => stopper.abort(), STOP_EXEC_TIMEOUT_MS)
    try {
      const response = await postExec(
        this.control,
        boxCcStopExec(this.control),
        this.o.fetchImpl,
        stopper.signal,
      )
      await response.arrayBuffer()
    } catch {
      // The next launch for this session ends whatever is left.
    } finally {
      clearTimeout(timer)
    }
    // The launch stream normally ends by itself once Claude is gone.
    const cut = setTimeout(() => this.abort.abort(), STOP_STREAM_GRACE_MS)
    cut.unref?.()
  }

  private async onTurnEnd(rotate: string | null): Promise<void> {
    const lines = this.signals.take()
    const retire =
      rotate === 'quota' ||
      rotate === 'login' ||
      (rotate === 'near_limit' && this.o.alternatives > 0)
    if (!retire || this.stopRequested) {
      if (lines.length > 0)
        void this.o.login
          .report({ accountId: this.o.accountId, profile: this.o.profile, lines })
          .catch(() => false)
      return
    }
    // The master must know before this chat's next launch asks, or it could hand out the same
    // login again; and this container stops preferring it. The next message relaunches (--resume).
    await this.o.login
      .report({ accountId: this.o.accountId, profile: this.o.profile, lines })
      .catch(() => false)
    this.o.memory.forget()
    this.o.stderr.write(`BOX_LOGIN_ROTATE ${this.o.profile} ${rotate}\n`)
    void this.stop()
  }

  /** Nothing ran: hand back every line this session holds, and every later one. */
  private giveUp(o: { why: string; unsafe: boolean; retryable: boolean }): SessionOutcome {
    this.gaveUp = true
    const held = this.held ?? []
    this.held = []
    return { kind: 'not_ready', ...o, held }
  }

  /** Close admission before joining writes; the reader must not choose a successful
   * outcome while an already-started write or its stop response is still pending. */
  private async finishWrites(): Promise<void> {
    this.closing = true
    await this.gate
    await this.writing
    this.abort.abort()
    if (this.failedWriteCleanup) await this.failedWriteCleanup
  }

  async run(): Promise<SessionOutcome> {
    let launch: BoxCcExecRequest
    try {
      launch = isBoxGptWebModelArgv(this.o.args)
        ? boxGptWebInteractiveLaunchExec(
            this.control,
            remoteInteractiveGptWebArgs(this.o.args),
            this.o.gptWebMod ?? loadBoxGptWebMod(),
            this.o.profile,
            this.o.env,
          )
        : boxCcInteractiveLaunchExec(
            this.control,
            remoteInteractiveClaudeArgs(this.o.args),
            this.o.bridgeMod ?? loadBoxBridgeMod(),
            this.o.profile,
          )
    } catch (err) {
      const why = err instanceof Error ? err.message : 'BOX_INTERACTIVE_LAUNCH_FAILED'
      this.o.stderr.write(`BOX_INTERACTIVE_NOT_READY ${why}\n`)
      return this.giveUp({ why, unsafe: false, retryable: false })
    }
    try {
      const response = await postExec(this.control, launch, this.o.fetchImpl, this.abort.signal)
      const reader = response.body!.getReader()
      let pendingBytes = Buffer.alloc(0)
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        pendingBytes = Buffer.concat([pendingBytes, Buffer.from(chunk.value)])
        const parsed = parseExecFrames(pendingBytes)
        pendingBytes = Buffer.from(parsed.rest)
        for (const event of parsed.events) {
          if (event.kind === 'stdout' && event.data) {
            this.sawStdout = true
            this.o.out.write(event.data)
            const ends = this.signals.push(event.data)
            if (ends.length > 0) {
              this.activeGptWebUserLine = null
            }
            for (const end of ends) await this.onTurnEnd(end.rotate)
          } else if (event.kind === 'stderr' && event.data) {
            this.o.stderr.write(event.data)
            if (this.held && !this.abandoned) {
              this.hostErr = (this.hostErr + event.data).slice(-4096)
              if (this.hostErr.includes('BOX_INTERACTIVE_READY')) {
                this.readySeen = true
                const lines = this.held
                this.held = null
                this.heldBytes = 0
                void this.flushFirst(lines)
              }
            }
          } else if (event.kind === 'exit') {
            this.sawExit = true
            this.exitCode = event.code ?? 0
          }
        }
      }
      this.hostStreamEnded = true
    } catch (error) {
      this.hostStreamEnded = true
      await this.finishWrites()
      if (this.writeFailed) throw error
      if (!this.stopRequested && !this.o.abort.signal.aborted) {
        if (isBoxGptWebModelArgv(this.o.args) && this.activeGptWebUserLine !== null) {
          this.o.out.discardIncompleteLine()
          const resumeLine = stampGptWebTurnIdInUserLine(this.activeGptWebUserLine, {
            deliveredText: this.o.out.getRawDeliveredTurnText(),
          })
          this.activeGptWebUserLine = null
          this.gaveUp = true
          return {
            kind: 'not_ready',
            why: 'gpt_web_stream_disconnected_mid_turn',
            unsafe: false,
            retryable: true,
            held: [resumeLine, ...(this.held ?? [])],
          }
        }
        if (this.readySeen || this.sawStdout) throw error
        // The launch itself failed before anything ran (an exec error): like a host that never came up.
        const why = error instanceof Error ? error.message : 'launch_failed'
        return this.giveUp({ why, unsafe: false, retryable: true })
      }
    } finally {
      await this.finishWrites()
    }
    if (this.writeFailed) return { kind: 'ended', code: 1 }
    if (!this.readySeen && !this.sawStdout && !this.stopRequested && !this.o.abort.signal.aborted) {
      // The host never got a line, so nothing ran.
      const unsafe = /BOX_INTERACTIVE_NOT_READY profile_unsafe/.test(this.hostErr)
      return this.giveUp({
        why: this.abandoned ?? (unsafe ? 'profile_unsafe' : 'not_ready'),
        unsafe,
        retryable: this.abandoned !== 'held_overflow',
      })
    }
    if (
      isBoxGptWebModelArgv(this.o.args) &&
      this.activeGptWebUserLine !== null &&
      !this.stopRequested &&
      !this.o.abort.signal.aborted &&
      (!this.sawExit || this.exitCode !== 0)
    ) {
      this.o.out.discardIncompleteLine()
      const resumeLine = stampGptWebTurnIdInUserLine(this.activeGptWebUserLine, {
        deliveredText: this.o.out.getRawDeliveredTurnText(),
      })
      this.activeGptWebUserLine = null
      this.gaveUp = true
      return {
        kind: 'not_ready',
        why: 'gpt_web_stream_ended_mid_turn',
        unsafe: false,
        retryable: true,
        held: [resumeLine, ...(this.held ?? [])],
      }
    }
    const rest = this.signals.take()
    if (rest.length > 0)
      void this.o.login
        .report({ accountId: this.o.accountId, profile: this.o.profile, lines: rest })
        .catch(() => false)
    if (this.stopRequested) return { kind: 'ended', code: 0 }
    return { kind: 'ended', code: this.sawExit ? this.exitCode : 1 }
  }
}

/** This container's record of the login each chat last launched under, keyed by the session hash
 * in the chat's fifo name (stable across bridge restarts). Lost with the container: the master
 * also remembers it, and otherwise per-user affinity usually lands on the same login. */
class BoxLoginMemory {
  readonly session: string | null
  private readonly path: string | null
  constructor(dir: string, fifo: string) {
    this.session = /^\/tmp\/oc-box-cc-([a-f0-9]{16})\.fifo$/.exec(fifo)?.[1] ?? null
    this.path = this.session ? join(dir, `login-${this.session}`) : null
    if (this.path) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch {
        /* reading fails below; only a cost */
      }
    }
  }
  read(): string | null {
    if (!this.path) return null
    try {
      const value = readFileSync(this.path, 'utf8').trim()
      return /^(default|[a-z0-9][a-z0-9-]{0,31})$/.test(value) ? value : null
    } catch {
      return null
    }
  }
  write(profile: string): void {
    if (!this.path) return
    try {
      writeFileSync(this.path, profile, { mode: 0o600 })
    } catch {
      /* only a cost */
    }
  }
  forget(): void {
    if (!this.path) return
    try {
      rmSync(this.path, { force: true })
    } catch {
      /* only a cost */
    }
  }
}

export interface BoxLoginPort {
  choose(
    accountId: string | undefined,
    sticky?: { session?: string; prefer?: string },
  ): Promise<{ profile: string; source: 'master' | 'fallback'; alternatives?: number }>
  report(input: {
    accountId: string | undefined
    profile: string
    lines: readonly string[]
    unsafe?: boolean
  }): Promise<unknown>
}

const MAX_TURN_SIGNALS = 16
const MAX_SIGNAL_LINE = 65_536
/** The stream-json line's own `type` (always its first key), read without parsing the line. */
const TOP_TYPE = /^\{"type":\s*"([a-z_]+)"/

/** Reads the session's stdout for what it says about the login: the plan-window line
 * (`rate_limit_event`) and the CLI's synthetic notices. A turn's lines are handed over at its
 * `result`, with whether the login must be rotated out: a rejected window (exhausted) or a
 * "Not logged in" notice. Everything else passes through untouched by this reader. */
export class BoxLoginSignalTap {
  private buf = ''
  private turn: string[] = []
  private rotate: string | null = null

  push(chunk: string): Array<{ rotate: string | null }> {
    this.buf += chunk
    const ends: Array<{ rotate: string | null }> = []
    for (let nl = this.buf.indexOf('\n'); nl >= 0; nl = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      const type = TOP_TYPE.exec(line)?.[1]
      if (type === 'rate_limit_event' || (type === 'assistant' && line.includes('"<synthetic>"'))) {
        if (line.length <= MAX_SIGNAL_LINE && this.turn.length < MAX_TURN_SIGNALS)
          this.turn.push(line)
        const reason = rotateReason(line)
        // A refusal or a logged-out login outranks "near the limit" within the same turn.
        if (reason && (this.rotate === null || this.rotate === 'near_limit')) this.rotate = reason
      } else if (type === 'result') {
        ends.push({ rotate: this.rotate })
        this.rotate = null
      }
    }
    // A line longer than any signal is not one; do not hold its bulk in memory,
    // but keep its leading `{"type":"..."}` prefix so when its trailing `\n`
    // arrives in a later chunk (e.g. a >256KiB `result` frame carrying base64
    // outputAttachments), `TOP_TYPE` still recognizes `"result"`.
    if (this.buf.length > MAX_SIGNAL_LINE * 4) this.buf = this.buf.slice(0, 64)
    return ends
  }

  take(): string[] {
    const lines = this.turn
    this.turn = []
    return lines
  }
}

function rotateReason(line: string): string | null {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  const top = record as {
    type?: unknown
    rate_limit_info?: Record<string, unknown>
    message?: { model?: unknown; content?: unknown }
  }
  if (top?.type === 'rate_limit_event') {
    const info = (top.rate_limit_info ?? {}) as {
      status?: unknown
      utilization?: unknown
      unifiedWindows?: unknown
    }
    if (info.status === 'rejected') return 'quota'
    const used = [
      info.utilization,
      ...Object.values(
        (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown }>,
      ).map((w) => w?.utilization),
    ].filter((u): u is number => typeof u === 'number' && Number.isFinite(u))
    return used.some((u) => u >= NEAR_LIMIT) ? 'near_limit' : null
  }
  if (
    top?.type === 'assistant' &&
    top.message?.model === '<synthetic>' &&
    Array.isArray(top.message.content)
  ) {
    for (const block of top.message.content as Array<{ text?: unknown }>) {
      if (typeof block?.text === 'string' && /^(?:Not logged in|Login expired|OAuth token revoked)\b/.test(block.text))
        return 'login'
      if (typeof block?.text === 'string' && /hit your .*limit|usage limit/i.test(block.text))
        return 'quota'
    }
  }
  return null
}

function positiveInt(raw: string | undefined): number | undefined {
  return raw && /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined
}

function bufferLines(
  input: NodeJS.ReadableStream,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  let buf = ''
  let chain = Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const fail = (error: unknown): void =>
      reject(error instanceof Error ? error : new Error(String(error)))
    input.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl + 1)
        buf = buf.slice(nl + 1)
        chain = chain.then(() => onLine(line)).catch(fail)
        nl = buf.indexOf('\n')
      }
    })
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      chain.then(() => resolvePromise()).catch(fail)
    }
    input.on('end', finish)
    input.on('close', finish)
    input.on('error', () => finish())
  })
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const controlPath = process.env.OC_BOX_CC_CONTROL
  if (!controlPath) {
    process.stderr.write('BOX_CC_CONTROL_REQUIRED\n')
    process.exit(1)
  }
  runBoxCcBridge({
    control: readControl(controlPath),
    args: process.argv.slice(2),
    runner: boxCcRunnerFromEnv(process.env),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((code) => {
      process.exit(code)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'BOX_CC_BRIDGE_FAILED'
      process.stderr.write(`${message}\n`)
      process.exit(1)
    })
}
