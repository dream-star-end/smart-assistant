/** Byte transport for the original interactive host. Never synthesizes model frames. */
import { createHash, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { AuthorityKeyring } from '@openclaude/protocol'
import {
  CC5_BRIDGE_MAX_FRAME_BYTES,
  CC5_RELAY_SOCKET,
  type Cc5BridgeBinding,
  cc5ControlRequest,
  readCc5AuthorityKeyring,
  readCc5Binding,
} from './cc5BridgePort.js'
import { Cc5ToolObservation } from './cc5ToolObservation.js'
import { runCc5ToolPump } from './cc5ToolPump.js'
import { privateDir, syncDir } from './cc5FixedTool.js'
import { Cc5ToolHost } from './cc5ToolHost.js'

export async function runCc5StdioBridge(input: {
  binding: Readonly<Cc5BridgeBinding>
  sessionKey: string
  stdin: Readable
  stdout: Writable
  socketPath?: string
  signal?: AbortSignal
  /** Production entry always supplies the supervisor-owned keyring. */
  tools?: { keyring: AuthorityKeyring; executionRoot?: string;
    /** In-process fixtures only; production always constructs the fixed supervisor. */
    hostFactory?: (root: string, lifecycleId: string) => Pick<Cc5ToolHost, 'execute' | 'close'> }
}): Promise<void> {
  const scope = {
    capability: input.binding.capability,
    uid: input.binding.uid,
    containerDbId: input.binding.containerDbId,
    dockerId: input.binding.dockerId,
    operationId: input.binding.operationId,
    sessionKey: input.sessionKey,
  }
  const socketPath = input.socketPath ?? CC5_RELAY_SOCKET
  const observation = input.tools ? new Cc5ToolObservation(input.binding.operationId) : undefined
  const toolAbort = new AbortController()
  let toolRun: Promise<unknown> | undefined
  let seq = 0
  let toolHost: Pick<Cc5ToolHost, 'execute' | 'close'> | undefined
  const lifecycleId = randomUUID()
  const executionRoot = input.tools?.executionRoot ?? '/home/agent/.openclaude/.cc5-native-tools'
  const lifecycleRoot = join(executionRoot, `host-${lifecycleId}`)
  if (input.tools) {
    privateDir(executionRoot)
    privateDir(lifecycleRoot)
    syncDir(executionRoot)
    const registered = await cc5ControlRequest('/tool/register', { ...scope, lifecycleId }, socketPath)
    if (registered.lifecycleId !== lifecycleId) throw new Error('CC5_TOOLHOST_REGISTRATION_UNKNOWN')
  }
  let ready = false
  let stopping = false
  let ended = false
  let failure: Error | undefined
  let pending: string[] = []
  let pendingBytes = 0
  let req!: ReturnType<typeof request>
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopping = true
    toolAbort.abort()
    pending = []
    stopPromise = Promise.resolve().then(async () => {
      let localFailure: unknown
      try {
        await toolHost?.close()
        if (input.tools) {
          const stopped = await cc5ControlRequest('/tool/stopped', { ...scope, lifecycleId, localStopped: true }, socketPath)
          if (stopped.lifecycleId !== lifecycleId) throw new Error('CC5_TOOLHOST_STOP_ACK_UNKNOWN')
        }
      } catch (error) {
        localFailure = error
      }
      // A failed local proof still revokes/stops the remote Worker; it never
      // becomes a successful combined stop or permission for another turn.
      const result = await cc5ControlRequest('/stop', scope, socketPath)
      if (localFailure) throw new Error('CC5_TOOLHOST_STOP_UNPROVEN')
      return result
    })
      .then((result) => {
        if (result.remoteStopped !== true) throw new Error('CC5_REMOTE_STOP_UNPROVEN')
      })
      .finally(() => {
        req?.destroy()
      })
    return stopPromise
  }
  const fail = (code: string): void => {
    failure ??= new Error(code)
    void stop().catch(() => {
      failure = new Error('CC5_REMOTE_STOP_UNPROVEN')
    })
  }
  const send = (line: string): void => {
    if (stopping) return
    try {
      const frame = JSON.parse(line) as {
        type?: string
        request?: { subtype?: string }
        message?: { role?: string; content?: unknown }
      }
      if (frame.type === 'user') {
        const content = frame.message?.content
        const textOnly =
          typeof content === 'string' ||
          (Array.isArray(content) &&
            content.every((b) => b && b.type === 'text' && typeof b.text === 'string'))
        if (frame.message?.role !== 'user' || !textOnly) {
          throw new Error('CC5_INPUT_REJECTED')
        }
      } else if (frame.type !== 'control_request' || frame.request?.subtype !== 'interrupt') {
        throw new Error('CC5_INPUT_REJECTED')
      }
      const bytes = Buffer.from(`${line}\n`)
      const envelope = `${JSON.stringify({
        seq: ++seq,
        hash: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.toString('base64'),
      })}\n`
      if (ready) {
        if (!req.write(envelope)) input.stdin.pause()
      } else {
        pendingBytes += Buffer.byteLength(envelope)
        if (pendingBytes > CC5_BRIDGE_MAX_FRAME_BYTES * 2) throw new Error('CC5_INPUT_LIMIT')
        pending.push(envelope)
      }
    } catch {
      fail('CC5_INPUT_REJECTED')
    }
  }
  const decoder = new StringDecoder('utf8')
  let buf = ''
  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (Buffer.byteLength(buf) > CC5_BRIDGE_MAX_FRAME_BYTES) {
      fail('CC5_INPUT_LIMIT')
      return
    }
    let split: number
    while ((split = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, split)
      buf = buf.slice(split + 1)
      if (line) send(line)
    }
  }
  const onEnd = (): void => {
    ended = true
    if (buf || decoder.end()) failure ??= new Error('CC5_INPUT_TRUNCATED')
    void stop().catch(() => {
      failure = new Error('CC5_REMOTE_STOP_UNPROVEN')
    })
  }
  const onAbort = (): void => {
    void stop().catch(() => {
      failure = new Error('CC5_REMOTE_STOP_UNPROVEN')
    })
  }
  const onInputError = (): void => fail('CC5_INPUT_FAILED')
  try {
    await new Promise<void>((resolveDone, reject) => {
      req = request(
        {
          socketPath,
          method: 'POST',
          path: '/session/open',
          headers: {
            'content-type': 'application/x-ndjson',
          },
        },
        (res) => {
          if (res.statusCode !== 200 || res.headers['x-cc5-interactive-ready'] !== '1') {
            fail('CC5_INTERACTIVE_NOT_READY')
            res.resume()
            return
          }
          ready = true
          if (input.tools && observation) {
            toolRun = runCc5ToolPump({
              binding: input.binding,
              sessionKey: input.sessionKey,
              keyring: input.tools.keyring,
              observation,
              signal: toolAbort.signal,
              socketPath,
              executionRoot: input.tools.executionRoot,
              executeTool: async (request) => {
                if (stopping) throw new Error('CC5_TOOLHOST_CLOSED')
                toolHost ??= input.tools?.hostFactory?.(lifecycleRoot, lifecycleId) ?? new Cc5ToolHost(lifecycleRoot, lifecycleId)
                return toolHost.execute(request.name, request.arguments, request)
              },
            }).catch(() => {
              if (!stopping) fail('CC5_FIXED_TOOL_FAILED_OR_UNKNOWN')
            })
          }
          clearTimeout(readyTimer)
          for (const line of pending) req.write(line)
          pending = []
          pendingBytes = 0
          input.stdin.resume()
          res.on('data', (chunk: Buffer) => {
            try {
              observation?.ingest(chunk)
            } catch {
              fail('CC5_ORIGINAL_TOOL_OBSERVATION_INVALID')
              return
            }
            // Exact original authenticated host bytes. No screen scraping or replacement result.
            if (!input.stdout.write(chunk)) res.pause()
          })
          const onDrain = (): void => {
            res.resume()
          }
          input.stdout.on('drain', onDrain)
          res.once('close', () => {
            input.stdout.removeListener('drain', onDrain)
          })
          res.once('aborted', () => {
            if (!stopping) fail('CC5_OUTPUT_DELIVERY_UNKNOWN')
          })
          res.once('error', () => {
            if (!stopping) fail('CC5_OUTPUT_FAILED')
          })
          res.once('end', () => {
            if (!stopping) failure ??= new Error('CC5_REMOTE_OUTPUT_ENDED')
            void stop().catch(() => {
              failure = new Error('CC5_REMOTE_STOP_UNPROVEN')
            })
          })
        },
      )
      req.on('drain', () => {
        if (ready) input.stdin.resume()
      })
      req.once('error', () => {
        if (!stopping) failure ??= new Error('CC5_TRANSPORT_DELIVERY_UNKNOWN')
        void stop().catch(() => {
          failure = new Error('CC5_REMOTE_STOP_UNPROVEN')
        })
      })
      req.once('close', () => {
        const finish = async (): Promise<void> => {
          try {
            await stop()
          } catch {
            failure = new Error('CC5_REMOTE_STOP_UNPROVEN')
          }
          if (failure) reject(failure)
          else if (!ended && !input.signal?.aborted) reject(new Error('CC5_TRANSPORT_CLOSED'))
          else resolveDone()
        }
        void finish()
      })
      readyTimer = setTimeout(() => fail('CC5_INTERACTIVE_READY_TIMEOUT'), 90000)
      req.write(`${JSON.stringify({ type: 'open', ...scope })}\n`)
      input.stdin.on('data', onData)
      input.stdin.once('end', onEnd)
      input.stdin.once('error', onInputError)
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.signal?.aborted) onAbort()
    })
  } finally {
    toolAbort.abort()
    try {
      observation?.finish()
    } catch {}
    await toolRun
    clearTimeout(readyTimer)
    input.stdin.removeListener('data', onData)
    input.stdin.removeListener('end', onEnd)
    input.stdin.removeListener('error', onInputError)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  Promise.resolve()
    .then(() =>
      runCc5StdioBridge({
        binding: readCc5Binding(),
        tools: { keyring: readCc5AuthorityKeyring() },
        sessionKey: process.argv[2] ?? '',
        stdin: process.stdin,
        stdout: process.stdout,
        signal: controller.signal,
      }),
    )
    .catch(() => {
      process.stderr.write('CC5_INTERACTIVE_BRIDGE_FAILED\n')
      process.exitCode = 1
    })
}
