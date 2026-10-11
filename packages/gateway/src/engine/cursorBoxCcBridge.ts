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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boxCcSpawnFifo,
  boxCcStopExec,
  boxCcWriteExecs,
  encodeExecRequest,
  execExitCode,
  parseExecFrames,
  type BoxCcControl,
  type BoxCcExecRequest,
} from './cursorBoxCcExec.js'
import {
  BoxLoginUnavailableError,
  reportBoxLoginSignals,
  requestBoxLogin,
} from './boxLoginClient.js'
import {
  boxCcInteractiveAbandonExec,
  boxCcInteractiveLaunchExec,
  boxCcRunnerFromEnv,
  loadBoxBridgeMod,
  remoteInteractiveClaudeArgs,
  type BoxBridgeMod,
  type BoxCcRunner,
} from './cursorBoxCcInteractive.js'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

// Both must fit inside the runner's 3s shutdown grace.
const STOP_EXEC_TIMEOUT_MS = 2_000
const STOP_STREAM_GRACE_MS = 300

function readControl(path: string): BoxCcControl {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BoxCcControl>
  if (!parsed || typeof parsed.execUrl !== 'string' || typeof parsed.execToken !== 'string'
    || typeof parsed.networkToken !== 'string' || typeof parsed.remoteClaude !== 'string'
    || typeof parsed.fifo !== 'string' || typeof parsed.cwd !== 'string') {
    throw new Error('BOX_CC_CONTROL_INVALID')
  }
  if (!parsed.execUrl.startsWith('https://') || !parsed.fifo.startsWith('/tmp/oc-box-cc-')) {
    throw new Error('BOX_CC_CONTROL_INVALID')
  }
  if (parsed.accountId !== undefined
    && (typeof parsed.accountId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(parsed.accountId))) {
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
  env?: NodeJS.ProcessEnv
  /** Box login choice and reports (tests); default: the master's egress. */
  login?: BoxLoginPort
}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const env = opts.env ?? process.env
  const login: BoxLoginPort = opts.login ?? {
    choose: (accountId) => requestBoxLogin({ accountId }, { env }),
    report: (input) => reportBoxLoginSignals(input, { env }),
  }
  if ((opts.runner ?? 'interactive') !== 'interactive') {
    opts.stderr.write(`BOX_CC_RUNNER_REFUSED ${String(opts.runner)}\n`)
    return 1
  }
  let profile: string
  try {
    const chosen = await login.choose(opts.control.accountId)
    profile = chosen.profile
    opts.stderr.write(`BOX_INTERACTIVE_LOGIN ${profile} ${chosen.source}\n`)
  } catch (err) {
    opts.stderr.write(`${err instanceof BoxLoginUnavailableError ? err.message : 'BOX_LOGIN_UNAVAILABLE'}\n`)
    return 1
  }
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  opts.signal?.addEventListener('abort', onAbort)
  const freshControl = (): BoxCcControl => ({
    ...opts.control,
    fifo: boxCcSpawnFifo(opts.control.fifo, randomBytes(8).toString('hex')),
  })
  const control = freshControl()
  let launch: BoxCcExecRequest
  try {
    launch = boxCcInteractiveLaunchExec(control, remoteInteractiveClaudeArgs(opts.args),
      opts.bridgeMod ?? loadBoxBridgeMod(), profile)
  } catch (err) {
    opts.stderr.write(`BOX_INTERACTIVE_NOT_READY ${err instanceof Error ? err.message : 'BOX_INTERACTIVE_LAUNCH_FAILED'}\n`)
    return 1
  }

  // Two phases, so no turn can run twice or vanish:
  // - until this bridge has seen the host report READY, it sends the host
  //   nothing and holds every line here; if the host ends first (a dialog,
  //   the ready timeout, a crash, held input over the cap, a refused login),
  //   the bridge fails without running anything;
  // - once READY is seen, the held lines go out first; a failed write or a
  //   dead host ends the bridge, and the next turn resumes.
  let held: string[] | null = []
  let heldBytes = 0
  const holdMax = positiveInt(env.OC_BOX_INTERACTIVE_HOLD_MAX_BYTES) ?? 64 * 1024 * 1024
  let readySeen = false
  let abandoned: string | null = null
  let hostStreamEnded = false
  let sawStdout = false
  let hostErr = ''
  let gate: Promise<void> = Promise.resolve()
  // What the output says about the login: collected per turn, reported at its result.
  const signals = new BoxLoginSignalTap()
  const flushSignals = (): void => {
    const lines = signals.take()
    if (lines.length > 0) void login.report({ accountId: opts.control.accountId, profile, lines }).catch(() => false)
  }

  let exitCode = 1
  let sawExit = false
  // The write runs as its own exec in the box. A request whose response the
  // transport lost is sent once more: the box script never writes a numbered
  // line twice. An exec that ran and did not exit 0 did not deliver the line,
  // so the bridge stops instead of waiting for an answer.
  const writeExec = async (body: BoxCcExecRequest): Promise<void> => {
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      if (abort.signal.aborted) return
      const writer = new AbortController()
      const timer = setTimeout(() => writer.abort(), 20_000)
      let code: number | null
      try {
        const response = await postExec(control, body, fetchImpl, writer.signal)
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
  let lineSeq = 0
  const writeLine = async (line: string): Promise<void> => {
    try {
      for (const body of boxCcWriteExecs(control, line, ++lineSeq)) await writeExec(body)
    } catch (err) {
      if (abort.signal.aborted) return
      const message = err instanceof Error ? err.message : 'BOX_CC_WRITE_FAILED'
      opts.stderr.write(`BOX_CC_WRITE_FAILED ${message}\n`)
      // The interactive host would otherwise keep its tmux session until this
      // chat's next launch reaps it; end it now (best effort, as stopRemote).
      const stopper = new AbortController()
      setTimeout(() => stopper.abort(), STOP_EXEC_TIMEOUT_MS).unref?.()
      void postExec(control, boxCcStopExec(control), fetchImpl, stopper.signal)
        .then((response) => response.arrayBuffer())
        .catch(() => undefined)
      abort.abort()
    }
  }
  /** Ends a host that is not ready yet. The launch may not have started it,
   * so the abandon exec repeats until its stream has ended; the bridge then
   * fails the turn below. */
  const abandonInteractive = (why: string): void => {
    if (abandoned || readySeen) return
    abandoned = why
    opts.stderr.write(`BOX_INTERACTIVE_ABANDON ${why}\n`)
    const hostControl = control
    void (async () => {
      for (let attempt = 0; attempt < 30 && !hostStreamEnded && !abort.signal.aborted; attempt++) {
        const stopper = new AbortController()
        const timer = setTimeout(() => stopper.abort(), STOP_EXEC_TIMEOUT_MS)
        try {
          const response = await postExec(hostControl, boxCcInteractiveAbandonExec(hostControl), fetchImpl, stopper.signal)
          await response.arrayBuffer()
        } catch {
          // Tried again below while the host's stream is open.
        } finally {
          clearTimeout(timer)
        }
        if (!hostStreamEnded) await new Promise((r) => setTimeout(r, 1_000))
      }
    })()
  }
  const deliverLine = async (line: string): Promise<void> => {
    await gate
    if (abort.signal.aborted) return
    if (held) {
      held.push(line)
      heldBytes += Buffer.byteLength(line)
      if (heldBytes > holdMax) abandonInteractive('held_overflow')
      return
    }
    await writeLine(line)
  }
  /** Sends `lines` first; later lines wait behind them. */
  const flushFirst = (lines: string[]): Promise<void> => {
    let release!: () => void
    gate = new Promise((resolveGate) => { release = resolveGate })
    return (async () => {
      try {
        for (const line of lines) {
          if (abort.signal.aborted) break
          await writeLine(line)
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
  // retires a session whose login turned out unusable, after its result.
  let stopRequested = false
  const stopRemote = async (): Promise<void> => {
    if (abort.signal.aborted) return
    stopRequested = true
    const stopper = new AbortController()
    const timer = setTimeout(() => stopper.abort(), STOP_EXEC_TIMEOUT_MS)
    try {
      const response = await postExec(control, boxCcStopExec(control), fetchImpl, stopper.signal)
      await response.arrayBuffer()
    } catch {
      // The next launch for this session ends whatever is left.
    } finally {
      clearTimeout(timer)
    }
    // The launch stream normally ends by itself once Claude is gone.
    const cut = setTimeout(() => abort.abort(), STOP_STREAM_GRACE_MS)
    cut.unref?.()
  }
  const streamLaunch = async (request: BoxCcExecRequest): Promise<void> => {
    const response = await postExec(control, request, fetchImpl, abort.signal)
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
          sawStdout = true
          opts.stdout.write(event.data)
          for (const end of signals.push(event.data)) {
            flushSignals()
            if (end.rotate && !stopRequested) {
              opts.stderr.write(`BOX_LOGIN_ROTATE ${profile} ${end.rotate}\n`)
              void stopRemote()
            }
          }
        } else if (event.kind === 'stderr' && event.data) {
          opts.stderr.write(event.data)
          if (held && !abandoned) {
            hostErr = (hostErr + event.data).slice(-4096)
            if (hostErr.includes('BOX_INTERACTIVE_READY')) {
              readySeen = true
              const lines = held
              held = null
              heldBytes = 0
              void flushFirst(lines)
            }
          }
        } else if (event.kind === 'exit') {
          sawExit = true
          exitCode = event.code ?? 0
        }
      }
    }
  }
  const pending = bufferLines(opts.stdin, async (line) => {
    if (abort.signal.aborted) return
    await deliverLine(line)
  }).then(stopRemote)
  let failedBeforeReady = false
  try {
    await streamLaunch(launch)
    hostStreamEnded = true
    if (!readySeen && !sawStdout && !stopRequested && !abort.signal.aborted) {
      // The host never got a line, so nothing ran: the turn fails here. There is
      // no `-p` to hand it to. A login the Box refused is benched by the master.
      failedBeforeReady = true
      opts.stderr.write(`BOX_INTERACTIVE_NOT_READY_NO_FALLBACK ${abandoned ?? 'not_ready'}\n`)
      if (/BOX_INTERACTIVE_NOT_READY profile_unsafe/.test(hostErr)) {
        await login.report({ accountId: opts.control.accountId, profile, lines: [], unsafe: true }).catch(() => false)
      }
    }
  } catch (error) {
    if (!stopRequested) throw error
  } finally {
    abort.abort()
    opts.signal?.removeEventListener('abort', onAbort)
    if ('destroy' in opts.stdin && typeof opts.stdin.destroy === 'function') {
      opts.stdin.destroy()
    }
    await pending.catch(() => undefined)
    flushSignals()
  }
  if (failedBeforeReady) return 1
  if (stopRequested) return 0
  return sawExit ? exitCode : 1
}

export interface BoxLoginPort {
  choose(accountId: string | undefined): Promise<{ profile: string; source: 'master' | 'fallback' }>
  report(input: { accountId: string | undefined; profile: string; lines: readonly string[]; unsafe?: boolean }):
    Promise<unknown>
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
        if (line.length <= MAX_SIGNAL_LINE && this.turn.length < MAX_TURN_SIGNALS) this.turn.push(line)
        this.rotate ??= rotateReason(line)
      } else if (type === 'result') {
        ends.push({ rotate: this.rotate })
        this.rotate = null
      }
    }
    // A line longer than any signal is not one; do not hold it.
    if (this.buf.length > MAX_SIGNAL_LINE * 4) this.buf = ''
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
  try { record = JSON.parse(line) } catch { return null }
  const top = record as { type?: unknown; rate_limit_info?: { status?: unknown }; message?: { model?: unknown; content?: unknown } }
  if (top?.type === 'rate_limit_event') return top.rate_limit_info?.status === 'rejected' ? 'quota' : null
  if (top?.type === 'assistant' && top.message?.model === '<synthetic>' && Array.isArray(top.message.content)) {
    for (const block of top.message.content as Array<{ text?: unknown }>) {
      if (typeof block?.text === 'string' && /^Not logged in\b/.test(block.text)) return 'login'
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
    const fail = (error: unknown): void => reject(error instanceof Error ? error : new Error(String(error)))
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

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

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
  }).then((code) => {
    process.exit(code)
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'BOX_CC_BRIDGE_FAILED'
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
