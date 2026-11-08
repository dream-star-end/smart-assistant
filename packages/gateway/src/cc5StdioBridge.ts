import { nodeMemoryError } from './remoteNodeMemory.js'
/** Byte transport for the original interactive host. Never synthesizes model frames. */
import { createHash, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { AuthorityKeyring } from '@openclaude/protocol'
import {
  CC5_BRIDGE_MAX_FRAME_BYTES,
  type Cc5BridgeBinding,
  cc5ControlRequest,
  cc5LanePaths,
  readCc5AuthorityKeyring,
  readCc5Binding,
  refreshCc5Binding,
} from './cc5BridgePort.js'
import { Cc5ToolObservation } from './cc5ToolObservation.js'
import { runCc5ToolPump } from './cc5ToolPump.js'
import { privateDir, syncDir } from './cc5FixedTool.js'
import { Cc5ToolHost } from './cc5ToolHost.js'
import { type Cc5HostProfile, type Cc5ToolCatalog, compileCc5ToolCatalog, cc5RemotePrompt } from './cc5ToolCatalog.js'
import { cc5ToolCatalogCacheKey, readCc5ToolCatalogCache, removeCc5ToolCatalogCache,
  writeCc5ToolCatalogCache } from './cc5ToolCatalogCache.js'
import type { Cc5ToolResult } from './cc5NativeTool.js'

/** What the runner prepared for this lane: the same prompt and tool sources a local chat gets. */
export interface Cc5LaneProfile {
  version: 1
  platformPrompt: string
  host: Cc5HostProfile
}
type BridgeToolHost = Pick<Cc5ToolHost, 'execute' | 'close' | 'tools'>

/** Written 0600 by the runner next to its other per-process files; never echoed on failure. */
export function readCc5LaneProfile(path: string): Cc5LaneProfile {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let value: Cc5LaneProfile
    try {
      const meta = fstatSync(fd)
      if (!meta.isFile() || meta.uid !== process.getuid?.() || (meta.mode & 0o077) || meta.size > 1048576) throw new Error()
      value = JSON.parse(readFileSync(fd, 'utf8')) as Cc5LaneProfile
    } finally { closeSync(fd) }
    const host = value?.host
    if (value?.version !== 1 || typeof value.platformPrompt !== 'string' || !host || typeof host !== 'object' ||
        Object.keys(value).sort().join(',') !== 'host,platformPrompt,version' ||
        Object.keys(host).sort().join(',') !== 'cwd,disallowedTools,mcpConfigPath,settingsPath' ||
        typeof host.cwd !== 'string' || !isAbsolute(host.cwd) ||
        [host.mcpConfigPath, host.settingsPath].some((item) => item !== null && (typeof item !== 'string' || !isAbsolute(item))) ||
        !Array.isArray(host.disallowedTools) || host.disallowedTools.some((item) => typeof item !== 'string'))
      throw new Error()
    return value
  } catch {
    throw new Error('CC5_LANE_PROFILE_INVALID')
  }
}

export async function runCc5StdioBridge(input: {
  binding: Readonly<Cc5BridgeBinding>
  sessionKey: string
  stdin: Readable
  stdout: Writable
  socketPath?: string
  signal?: AbortSignal
  /** Production entry always supplies the supervisor-owned keyring. */
  tools?: { keyring: AuthorityKeyring; executionRoot?: string; lane: Cc5LaneProfile
    /** In-process fixtures only; production always constructs the fixed supervisor. */
    hostFactory?: (root: string, lifecycleId: string, profile: Cc5HostProfile,
      onPermission: (request: Record<string, unknown>) => Promise<Record<string, unknown>>) => BridgeToolHost }
}): Promise<void> {
  const scope = {
    capability: input.binding.capability,
    uid: input.binding.uid,
    containerDbId: input.binding.containerDbId,
    dockerId: input.binding.dockerId,
    operationId: input.binding.operationId,
    sessionKey: input.sessionKey,
  }
  const socketPath = input.socketPath ?? cc5LanePaths(input.binding.operationId).socket
  const observation = input.tools ? new Cc5ToolObservation(input.binding.operationId) : undefined
  const toolAbort = new AbortController()
  let toolRun: Promise<unknown> | undefined
  let seq = 0
  let toolHost: BridgeToolHost | undefined
  let toolNames: Readonly<Record<string, string>> = {}
  /** Resolves once the live catalog is known to equal the one the remote was launched with. */
  let toolsVerified: Promise<void> = Promise.resolve()
  // The gateway answers these exactly as for a local CCB: control_request out, control_response in.
  const permissions = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  const askPermission = (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (stopping || typeof request.tool_name !== 'string' || typeof request.tool_use_id !== 'string' ||
        !request.input || typeof request.input !== 'object' || Array.isArray(request.input) || permissions.size >= 16)
      return Promise.reject(new Error('CC5_PERMISSION_REQUEST_REJECTED'))
    const requestId = `cc5-perm-${randomUUID()}`
    return new Promise((resolvePermission, reject) => {
      permissions.set(requestId, { resolve: resolvePermission, reject })
      input.stdout.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: {
        subtype: 'can_use_tool', tool_name: request.tool_name, input: request.input, tool_use_id: request.tool_use_id } })}\n`)
    })
  }
  const lifecycleId = randomUUID()
  const executionRoot = input.tools?.executionRoot ?? '/home/agent/.openclaude/.cc5-native-tools'
  const lifecycleRoot = join(executionRoot, `host-${lifecycleId}`)
  if (input.tools) {
    privateDir(executionRoot)
    privateDir(lifecycleRoot)
    syncDir(executionRoot)
    // The remote CLI launches with this host's catalog, so registration is what starts it.
    const lane = input.tools.lane
    const host = toolHost = input.tools.hostFactory?.(lifecycleRoot, lifecycleId, lane.host, askPermission) ??
      new Cc5ToolHost(lifecycleRoot, lifecycleId, lane.host, askPermission)
    const live = host.tools()
    // Registration must not wait for the boot; this only keeps an early rejection from escaping.
    live.catch(() => {})
    const cacheKey = cc5ToolCatalogCacheKey(lane.host)
    const cached = readCc5ToolCatalogCache(executionRoot, cacheKey)
    const register = (catalog: Cc5ToolCatalog, relaunch: boolean): Promise<Record<string, unknown>> =>
      cc5ControlRequest('/tool/register', { ...scope, lifecycleId,
        ...(relaunch ? { replace: true, relaunch: true } : {}),
        profile: { catalog: catalog.json, catalogSha256: catalog.sha256,
          toolNames: catalog.clientNameByRemoteName,
          prompt: cc5RemotePrompt(lane.platformPrompt, catalog, lane.host.cwd) } }, socketPath)
    const settled = (reply: Record<string, unknown>, catalog: Cc5ToolCatalog): void => {
      if (reply.lifecycleId !== lifecycleId) throw new Error('CC5_TOOLHOST_REGISTRATION_UNKNOWN')
      // A lane launched by an earlier bridge keeps the catalog it was launched with.
      toolNames = reply.toolNames && typeof reply.toolNames === 'object'
        ? reply.toolNames as Record<string, string> : catalog.clientNameByRemoteName
    }
    try {
      if (cached) {
        settled(await register(cached, false), cached)
        toolsVerified = live.then(async (tools) => {
          const fresh = compileCc5ToolCatalog(tools)
          if (fresh.sha256 === cached.sha256) return
          // The key missed an input: the remote is running with the wrong tool set. Drop the entry
          // and have the relay replace it inside this turn, before any tool call is served.
          removeCc5ToolCatalogCache(executionRoot, cacheKey)
          settled(await register(fresh, true), fresh)
          writeCc5ToolCatalogCache(executionRoot, cacheKey, fresh)
        })
      } else {
        const catalog = compileCc5ToolCatalog(await live)
        settled(await register(catalog, false), catalog)
        writeCc5ToolCatalogCache(executionRoot, cacheKey, catalog)
      }
    } catch (error) {
      await host.close().catch(() => {})
      throw error
    }
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
  let generation = 1
  let lastAckedSeq = 0
  let reconnectCount = 0
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopping = true
    toolAbort.abort()
    pending = []
    for (const waiter of permissions.values()) waiter.reject(new Error('CC5_PERMISSION_REQUEST_ABANDONED'))
    permissions.clear()
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
      failure ??= new Error('CC5_REMOTE_STOP_UNPROVEN')
    })
  }
  // A stale catalog that could not be replaced inside the turn is a hard stop, not a retry.
  void toolsVerified.catch((error: unknown) => {
    fail(error instanceof Error && /^CC5_[A-Z_]+$/.test(error.message)
      ? error.message : 'CC5_TOOLHOST_CATALOG_MISMATCH')
  })
  const send = (line: string): void => {
    if (stopping) return
    try {
      const frame = JSON.parse(line) as {
        type?: string
        request?: { subtype?: string }
        message?: { role?: string; content?: unknown }
        response?: { request_id?: unknown; subtype?: unknown; response?: unknown }
      }
      if (frame.type === 'control_response') {
        // Answers stay in this container: only a reply to a prompt this bridge asked is accepted.
        const id = frame.response?.request_id
        const waiter = typeof id === 'string' ? permissions.get(id) : undefined
        if (!waiter) throw new Error('CC5_INPUT_REJECTED')
        permissions.delete(id as string)
        const answer = frame.response?.response
        if (frame.response?.subtype === 'success' && answer && typeof answer === 'object' && !Array.isArray(answer))
          waiter.resolve(answer as Record<string, unknown>)
        else waiter.reject(new Error('CC5_PERMISSION_REQUEST_FAILED'))
        return
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
      failure ??= new Error('CC5_REMOTE_STOP_UNPROVEN')
    })
  }
  const onAbort = (): void => {
    void stop().catch(() => {
      failure ??= new Error('CC5_REMOTE_STOP_UNPROVEN')
    })
  }
  const onInputError = (): void => fail('CC5_INPUT_FAILED')
  try {
    await new Promise<void>((resolveDone, reject) => {
      const finishStream = async (): Promise<void> => {
        try {
          await stop()
        } catch {
          failure ??= new Error('CC5_REMOTE_STOP_UNPROVEN')
        }
        if (failure) reject(failure)
        else if (!ended && !input.signal?.aborted) reject(new Error('CC5_TRANSPORT_CLOSED'))
        else resolveDone()
      }

      const openStream = (gen: number, ackSeq: number): void => {
        ready = false
        let reconnectingThisStream = false
        let connRemainder = Buffer.alloc(0)
        const tryReconnect = (fallbackErrorCode: string): void => {
          if (gen !== generation || reconnectingThisStream) return
          if (stopping || ended || input.signal?.aborted || failure) {
            void finishStream()
            return
          }
          if (reconnectCount < 2) {
            reconnectCount++
            reconnectingThisStream = true
            connRemainder = Buffer.alloc(0)
            clearTimeout(readyTimer)
            try {
              req?.destroy()
            } catch {}
            generation = gen + 1
            openStream(generation, lastAckedSeq)
            return
          }
          failure ??= new Error(fallbackErrorCode)
          void finishStream()
        }

        const currentReq = request(
          {
            socketPath,
            method: 'POST',
            path: '/session/open',
            headers: {
              'content-type': 'application/x-ndjson',
            },
          },
          (res) => {
            if (gen !== generation || reconnectingThisStream) {
              res.resume()
              return
            }
            if (res.statusCode === 503 && res.headers['x-oc-remote-error'] === 'REMOTE_NODE_MEMORY_EXHAUSTED' &&
                typeof res.headers['x-oc-remote-active'] === 'string' && /^[0-9]{1,4}$/.test(res.headers['x-oc-remote-active'])) {
              const memory=nodeMemoryError(Number(res.headers['x-oc-remote-active']))
              failure ??= memory
              fail(memory.message);res.resume();return
            }
            if (res.statusCode === 409) {
              fail('CC5_STREAM_SEQ_GAP')
              res.resume()
              return
            }
            if (res.statusCode !== 200 || res.headers['x-cc5-interactive-ready'] !== '1') {
              fail('CC5_INTERACTIVE_NOT_READY')
              res.resume()
              return
            }
            clearTimeout(readyTimer)
            if (input.tools && observation && !toolRun) {
              const tools = input.tools
              // No roundtrip is served against a catalog the remote was not launched with.
              toolRun = toolsVerified.then(() => runCc5ToolPump({
                binding: input.binding,
                bindingProvider: () => refreshCc5Binding(input.binding, socketPath, Date.now()),
                sessionKey: input.sessionKey,
                keyring: tools.keyring,
                observation,
                signal: toolAbort.signal,
                socketPath,
                executionRoot: tools.executionRoot,
                executeTool: async (request): Promise<Cc5ToolResult> => {
                  if (stopping || !toolHost) throw new Error('CC5_TOOLHOST_CLOSED')
                  await toolsVerified
                  const name = Object.hasOwn(toolNames, request.name) ? toolNames[request.name] : undefined
                  if (!name) return { content: [{ type: 'text', text: `No such tool available: ${request.name}` }], isError: true }
                  return toolHost.execute(name, request.arguments, request)
                },
              })).catch(() => {
                if (!stopping) fail('CC5_FIXED_TOOL_FAILED_OR_UNKNOWN')
              })
            }
            // The user frame reaches the remote only once its catalog is verified: until then a
            // stale-catalog launch can still be replaced inside this turn.
            void toolsVerified.then(() => {
              if (gen !== generation || reconnectingThisStream || stopping || req !== currentReq) return
              ready = true
              for (const line of pending) currentReq.write(line)
              pending = []
              pendingBytes = 0
              input.stdin.resume()
            }, () => {})
            res.on('data', (chunk: Buffer) => {
              if (gen !== generation || reconnectingThisStream || stopping) return
              connRemainder = Buffer.concat([connRemainder, chunk])
              if (connRemainder.length > CC5_BRIDGE_MAX_FRAME_BYTES) {
                fail('CC5_OUTPUT_FRAME_TOO_LARGE')
                return
              }
              let nl: number
              const completePieces: Buffer[] = []
              while ((nl = connRemainder.indexOf(10)) >= 0) {
                const frameBytes = connRemainder.subarray(0, nl + 1)
                connRemainder = connRemainder.subarray(nl + 1)
                lastAckedSeq++
                completePieces.push(frameBytes)
              }
              if (completePieces.length === 0) return
              const forward = Buffer.concat(completePieces)
              try {
                observation?.ingest(forward)
              } catch {
                fail('CC5_ORIGINAL_TOOL_OBSERVATION_INVALID')
                return
              }
              // Exact original authenticated host bytes. No screen scraping or replacement result.
              if (!input.stdout.write(forward)) res.pause()
            })
            const onDrain = (): void => {
              if (gen === generation && !reconnectingThisStream) res.resume()
            }
            input.stdout.on('drain', onDrain)
            res.once('close', () => {
              input.stdout.removeListener('drain', onDrain)
            })
            res.once('aborted', () => {
              if (gen !== generation || reconnectingThisStream || stopping) return
              tryReconnect('CC5_OUTPUT_DELIVERY_UNKNOWN')
            })
            res.once('error', () => {
              if (gen !== generation || reconnectingThisStream || stopping) return
              tryReconnect('CC5_OUTPUT_FAILED')
            })
            res.once('end', () => {
              if (gen !== generation || reconnectingThisStream) return
              if (!stopping && (!ended && !input.signal?.aborted || connRemainder.length > 0)) {
                tryReconnect('CC5_REMOTE_OUTPUT_ENDED')
                return
              }
              void finishStream()
            })
          },
        )
        req = currentReq
        currentReq.on('drain', () => {
          if (ready && gen === generation && req === currentReq) input.stdin.resume()
        })
        currentReq.once('error', () => {
          if (gen !== generation || reconnectingThisStream || stopping) return
          tryReconnect('CC5_TRANSPORT_DELIVERY_UNKNOWN')
        })
        currentReq.once('close', () => {
          if (gen !== generation || reconnectingThisStream || req !== currentReq) return
          void finishStream()
        })
        clearTimeout(readyTimer)
        readyTimer = setTimeout(() => fail('CC5_INTERACTIVE_READY_TIMEOUT'), 90000)
        const latestBinding = refreshCc5Binding(input.binding, socketPath, Date.now())
        currentReq.write(
          `${JSON.stringify({
            type: 'open',
            ...scope,
            capability: latestBinding.capability,
            generation: gen,
            ...(gen > 1 || ackSeq > 0 ? { lastAckedSeq: ackSeq } : {}),
          })}\n`,
        )
      }

      openStream(generation, lastAckedSeq)
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
    // A resumed stdin keeps the bridge process alive while the gateway holds the pipe open.
    input.stdin.pause()
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/** Process entry: the runner treats process exit as the turn's terminal, so a finished
 * bridge must exit even while the gateway still holds its stdin pipe open. */
export async function runCc5StdioBridgeProcess(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    const code = error instanceof Error && /^CC5_[A-Z0-9_]{1,64}$/.test(error.message) ? ` ${error.message}` : ''
    process.stderr.write(`CC5_INTERACTIVE_BRIDGE_FAILED${code}\n`)
    process.exitCode = 1
  } finally {
    process.stdin.destroy()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  void runCc5StdioBridgeProcess(() =>
    runCc5StdioBridge({
      binding: readCc5Binding(cc5LanePaths(process.argv[3] ?? '').binding),
      tools: { keyring: readCc5AuthorityKeyring(), lane: readCc5LaneProfile(process.argv[4] ?? '') },
      sessionKey: process.argv[2] ?? '',
      stdin: process.stdin,
      stdout: process.stdout,
      signal: controller.signal,
    }),
  )
}
