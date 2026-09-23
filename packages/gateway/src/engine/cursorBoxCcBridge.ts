/** Local stdio bridge. The gateway speaks stream-json to this process.
 * This process runs official `claude` inside the selected account's Grok Bot
 * box and copies stdout back. It does not call the model itself. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boxCcLaunchExec,
  boxCcWriteExec,
  encodeExecRequest,
  parseExecFrames,
  remoteClaudeArgs,
  type BoxCcControl,
  type BoxCcExecRequest,
} from './cursorBoxCc.js'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

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
    body: encodeExecRequest(body),
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
  const launch = boxCcLaunchExec(opts.control, remoteClaudeArgs(opts.args))
  let exitCode = 1
  let sawExit = false
  const pending = bufferLines(opts.stdin, async (line) => {
    if (abort.signal.aborted) return
    const writer = new AbortController()
    const timer = setTimeout(() => writer.abort(), 20_000)
    try {
      const response = await postExec(opts.control, boxCcWriteExec(opts.control, line), fetchImpl, writer.signal)
      await response.arrayBuffer()
    } finally {
      clearTimeout(timer)
    }
  })
  try {
    const response = await postExec(opts.control, launch, fetchImpl, abort.signal)
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
  } finally {
    abort.abort()
    opts.signal?.removeEventListener('abort', onAbort)
    opts.stdin.destroy?.()
    await pending.catch(() => undefined)
  }
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
