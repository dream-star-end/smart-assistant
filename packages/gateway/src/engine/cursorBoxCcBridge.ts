/** Local stdio bridge. The gateway speaks stream-json to this process.
 * This process runs official `claude` inside the selected account's Grok Bot
 * box and copies stdout back. It does not call the model itself. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boxCcLaunchExec,
  boxCcSpawnFifo,
  boxCcStopExec,
  boxCcWriteExecs,
  encodeExecRequest,
  execExitCode,
  parseExecFrames,
  remoteClaudeArgs,
  type BoxCcControl,
  type BoxCcExecRequest,
} from './cursorBoxCcExec.js'

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
}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  opts.signal?.addEventListener('abort', onAbort)
  const control: BoxCcControl = {
    ...opts.control,
    fifo: boxCcSpawnFifo(opts.control.fifo, randomBytes(8).toString('hex')),
  }
  const launch = boxCcLaunchExec(control, remoteClaudeArgs(opts.args))
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
  const deliverLine = async (line: string): Promise<void> => {
    try {
      for (const body of boxCcWriteExecs(control, line, ++lineSeq)) await writeExec(body)
    } catch (err) {
      if (abort.signal.aborted) return
      const message = err instanceof Error ? err.message : 'BOX_CC_WRITE_FAILED'
      opts.stderr.write(`BOX_CC_WRITE_FAILED ${message}\n`)
      abort.abort()
    }
  }
  // Closed stdin is the gateway retiring this process (shutdown, model switch,
  // idle recycle). Claude in the box cannot see that EOF, so end it there and
  // report a clean exit; otherwise the runner has to SIGKILL this bridge and
  // the box Claude lives on, still attached to the session.
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
  const pending = bufferLines(opts.stdin, async (line) => {
    if (abort.signal.aborted) return
    await deliverLine(line)
  }).then(stopRemote)
  try {
    const response = await postExec(control, launch, fetchImpl, abort.signal)
    const reader = response.body!.getReader()
    let pendingBytes = Buffer.alloc(0)
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      pendingBytes = Buffer.concat([pendingBytes, Buffer.from(chunk.value)])
      const parsed = parseExecFrames(pendingBytes)
      pendingBytes = Buffer.from(parsed.rest)
      for (const event of parsed.events) {
        if (event.kind === 'stdout' && event.data) opts.stdout.write(event.data)
        else if (event.kind === 'stderr' && event.data) opts.stderr.write(event.data)
        else if (event.kind === 'exit') {
          sawExit = true
          exitCode = event.code ?? 0
        }
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
  }
  if (stopRequested) return 0
  return sawExit ? exitCode : 1
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
