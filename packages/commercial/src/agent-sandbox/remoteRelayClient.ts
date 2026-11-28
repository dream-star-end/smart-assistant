/**
 * AF_UNIX HTTP RPC client for the standalone blue-green `remote-relay` daemon.
 *
 * Architecture guardrail: L2 `remote-relay-client` (`authorities: ["net"]`).
 * - Must NOT read `process.env` directly (all configuration passed via options).
 * - Must NOT call `node:crypto` primitives directly.
 * - Retries ONLY connect-level `ENOENT`/`ECONNREFUSED` BEFORE the socket connects
 *   (handling atomic blue-green `remote-relay-active.sock` symlink flip); NEVER retries
 *   after a request has been transmitted over a connected socket.
 */
import { request as httpRequest } from 'node:http'
import type {
  Cc5PreparedContainer,
  RemoteLaneRequest,
  RemoteLaneRuntimePort,
} from '@openclaude/gateway/cc5-container-runtime'
import type { RemoteExecutionBackend } from '@openclaude/protocol'
import {
  DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET,
  REMOTE_RELAY_HOP_HEADER,
  REMOTE_RELAY_PATHS,
  REMOTE_RELAY_SECRET_HEADER,
  type ReleaseSessionIfIdleResult,
  type ReleaseSessionKeyResult,
  type RemoteRelayHealthStatus,
  type RemoteRelayRuntimeState,
  type RemoteRelaySlot,
  deserializeRpcError,
  isRemoteRelayHealthStatus,
} from '../remoteRelay/protocol.js'

export {
  DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET,
  type ReleaseSessionIfIdleResult,
  type ReleaseSessionKeyResult,
  type RemoteRelayHealthStatus,
  type RemoteRelayRuntimeState,
  type RemoteRelaySlot,
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000
const DEFAULT_PEER_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 256 * 1024
const CONNECT_RETRY_DELAYS_MS: readonly number[] = [50, 150]
const RETRYABLE_CONNECT_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED'])

export interface RemoteRelayClientOptions {
  readonly socketPath: string
  readonly secret: string
  readonly requestTimeoutMs?: number
  readonly healthTimeoutMs?: number
}

export interface ExternalRemoteLaneRuntimePort extends RemoteLaneRuntimePort {
  readonly remoteRelayMode: 'external'
  readonly socketPath: string
  probeHealth(timeoutMs?: number): Promise<RemoteRelayHealthStatus | null>
  releaseSessionIfIdle?(
    sessionKey: string,
    opts?: { operationId?: string },
  ): Promise<ReleaseSessionIfIdleResult>
}

export interface RemoteRelayPeerClientOptions {
  readonly socketPath: string
  readonly secret: string
  readonly timeoutMs?: number
}

export interface RemoteRelayPeerClient {
  readonly socketPath: string
  releaseSessionKey(
    uid: number,
    sessionKey: string,
    opts?: { containerDbId?: string; operationId?: string; generation?: string },
  ): Promise<ReleaseSessionKeyResult | null>
  releaseSessionIfIdle(
    sessionKey: string,
    opts?: { operationId?: string },
  ): Promise<ReleaseSessionIfIdleResult | null>
  releaseChat(uid: number, chatId: string): Promise<boolean>
  release(containerDbId: string, dockerId?: string): Promise<boolean>
  probeHealth(timeoutMs?: number): Promise<RemoteRelayHealthStatus | null>
}

export function isExternalRemoteLaneRuntime(
  rt: RemoteLaneRuntimePort | undefined,
): rt is ExternalRemoteLaneRuntimePort {
  return (
    typeof rt === 'object' &&
    rt !== null &&
    (rt as Partial<ExternalRemoteLaneRuntimePort>).remoteRelayMode === 'external' &&
    typeof (rt as Partial<ExternalRemoteLaneRuntimePort>).probeHealth === 'function'
  )
}

interface RawUnixHttpResponse {
  readonly statusCode: number
  readonly body: unknown
}

class PreConnectRetryableError extends Error {
  readonly errnoCode: string
  constructor(cause: unknown, errnoCode: string) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.errnoCode = errnoCode
    this.cause = cause
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function sendUnixHttpOnce(args: {
  readonly socketPath: string
  readonly secret: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
  readonly timeoutMs: number
  readonly extraHeaders?: Readonly<Record<string, string>>
}): Promise<RawUnixHttpResponse> {
  return new Promise<RawUnixHttpResponse>((resolve, reject) => {
    const payload = args.body !== undefined ? JSON.stringify(args.body) : undefined
    const payloadBytes = payload !== undefined ? Buffer.byteLength(payload, 'utf8') : 0

    let settled = false
    let connected = false

    const finishResolve = (res: RawUnixHttpResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }

    const finishReject = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }

    const headers: Record<string, string | number> = {
      [REMOTE_RELAY_SECRET_HEADER]: args.secret,
      ...(args.extraHeaders ?? {}),
    }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payloadBytes
    }

    const req = httpRequest(
      {
        socketPath: args.socketPath,
        path: args.path,
        method: args.method,
        headers,
        // Never pool keep-alive sockets across AF_UNIX paths: blue-green cutover flips
        // `remote-relay-active.sock` atomically via symlink rename, so each call must
        // resolve the current symlink target rather than reusing an old slot's fd.
        agent: false,
      },
      (res) => {
        connected = true
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
          total += buf.length
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy()
            finishReject(new Error('REMOTE_RELAY_RESPONSE_TOO_LARGE'))
            return
          }
          chunks.push(buf)
        })
        res.on('end', () => {
          const raw = total === 0 ? '' : Buffer.concat(chunks, total).toString('utf8')
          let parsed: unknown = undefined
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw)
            } catch {
              finishReject(new Error('REMOTE_RELAY_INVALID_JSON_RESPONSE'))
              return
            }
          }
          finishResolve({ statusCode: res.statusCode ?? 0, body: parsed })
        })
        res.on('error', (err) => {
          finishReject(err instanceof Error ? err : new Error(String(err)))
        })
      },
    )

    req.on('socket', (sock) => {
      if (sock.connecting === false && !sock.destroyed) {
        connected = true
      } else {
        sock.once('connect', () => {
          connected = true
        })
      }
    })

    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (!connected && typeof code === 'string' && RETRYABLE_CONNECT_ERRNOS.has(code)) {
        finishReject(new PreConnectRetryableError(err, code))
        return
      }
      finishReject(err instanceof Error ? err : new Error(String(err)))
    })

    const timer = setTimeout(() => {
      req.destroy()
      finishReject(new Error('REMOTE_RELAY_RPC_TIMEOUT'))
    }, Math.max(50, Math.floor(args.timeoutMs)))
    timer.unref?.()

    if (payload !== undefined) {
      req.end(payload)
    } else {
      req.end()
    }
  })
}

async function sendUnixHttpWithConnectRetry(args: {
  readonly socketPath: string
  readonly secret: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
  readonly timeoutMs: number
  readonly retryOnConnect: boolean
  readonly extraHeaders?: Readonly<Record<string, string>>
}): Promise<RawUnixHttpResponse> {
  const maxRetries = args.retryOnConnect ? CONNECT_RETRY_DELAYS_MS.length : 0
  let attempt = 0
  while (true) {
    try {
      return await sendUnixHttpOnce(args)
    } catch (err) {
      if (err instanceof PreConnectRetryableError && attempt < maxRetries) {
        const delayMs = CONNECT_RETRY_DELAYS_MS[attempt]!
        attempt += 1
        await sleep(delayMs)
        continue
      }
      if (err instanceof PreConnectRetryableError) {
        const out = new Error('REMOTE_LANE_UNAVAILABLE') as Error & { code?: string; cause?: unknown }
        out.code = 'REMOTE_LANE_UNAVAILABLE'
        out.cause = err.cause
        throw out
      }
      throw err
    }
  }
}

function assertPreparedContainer(raw: unknown): Cc5PreparedContainer | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('REMOTE_RELAY_INVALID_RESPONSE')
  }
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.mountSource !== 'string' ||
    obj.mountSource.length === 0 ||
    typeof obj.containerDbId !== 'string' ||
    obj.containerDbId.length === 0
  ) {
    throw new Error('REMOTE_RELAY_INVALID_RESPONSE')
  }
  return Object.freeze({
    mountSource: obj.mountSource,
    containerDbId: obj.containerDbId,
  })
}

function assertReleaseSessionKeyResult(raw: unknown): ReleaseSessionKeyResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('REMOTE_RELAY_INVALID_RESPONSE')
  }
  const obj = raw as Record<string, unknown>
  const state = obj.state
  if (
    typeof obj.released !== 'boolean' ||
    (state !== 'released' && state !== 'not_found' && state !== 'mismatch' && state !== 'unknown')
  ) {
    throw new Error('REMOTE_RELAY_INVALID_RESPONSE')
  }
  return { released: obj.released, state }
}

function assertReleaseSessionIfIdleResult(raw: unknown): ReleaseSessionIfIdleResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('REMOTE_RELAY_INVALID_RESPONSE')
  }
  const obj = raw as Record<string, unknown>
  const status = obj.status
  if (status !== 'released' && status !== 'busy' && status !== 'not_found' && status !== 'unknown') {
    throw new Error('REMOTE_RELAY_INVALID_RESPONSE')
  }
  return { status }
}

function buildEnsureLanePayload(request: RemoteLaneRequest): Record<string, unknown> {
  return {
    uid: request.uid,
    containerDbId: request.containerDbId,
    sessionKey: request.sessionKey,
    canonicalModel: request.canonicalModel,
    ...(request.engine !== undefined ? { engine: request.engine } : {}),
    ...(request.allowStickyFailover === true ? { allowStickyFailover: true } : {}),
    ...(request.requiredCapabilities !== undefined ? { requiredCapabilities: request.requiredCapabilities } : {}),
    ...(request.systemPromptSha256 !== undefined ? { systemPromptSha256: request.systemPromptSha256 } : {}),
  }
}

export function createRemoteRelayClient(
  options: RemoteRelayClientOptions,
): ExternalRemoteLaneRuntimePort {
  const socketPath = options.socketPath.trim()
  const secret = options.secret
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const defaultHealthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS

  if (!socketPath) {
    throw new Error('REMOTE_RELAY_SOCKET_REQUIRED')
  }
  if (!secret) {
    throw new Error('REMOTE_RELAY_SECRET_REQUIRED')
  }

  async function callRpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await sendUnixHttpWithConnectRetry({
      socketPath,
      secret,
      method: 'POST',
      path,
      body,
      timeoutMs: requestTimeoutMs,
      retryOnConnect: true,
    })
    const obj =
      res.body && typeof res.body === 'object' && !Array.isArray(res.body)
        ? (res.body as Record<string, unknown>)
        : undefined
    if (res.statusCode < 200 || res.statusCode >= 300 || obj?.ok !== true) {
      throw deserializeRpcError(res.body ?? { code: `REMOTE_RELAY_HTTP_${res.statusCode}` })
    }
    return obj.result as T
  }

  return {
    remoteRelayMode: 'external',
    socketPath,

    async probeHealth(timeoutMs?: number): Promise<RemoteRelayHealthStatus | null> {
      const budget = Math.max(50, Math.floor(timeoutMs ?? defaultHealthTimeoutMs))
      try {
        const res = await sendUnixHttpWithConnectRetry({
          socketPath,
          secret,
          method: 'GET',
          path: REMOTE_RELAY_PATHS.healthz,
          timeoutMs: budget,
          retryOnConnect: budget >= 400,
        })
        if (res.statusCode !== 200) return null
        return isRemoteRelayHealthStatus(res.body) ? res.body : null
      } catch {
        return null
      }
    },

    async prepare(input: {
      uid: number
      containerDbId: string
      local: boolean
      publicKeyring: string
    }): Promise<Cc5PreparedContainer | null> {
      const raw = await callRpc<unknown>(REMOTE_RELAY_PATHS.prepare, {
        uid: input.uid,
        containerDbId: input.containerDbId,
        local: input.local,
        publicKeyring: input.publicKeyring,
      })
      return assertPreparedContainer(raw)
    },

    async bindCreated(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
      await callRpc<unknown>(REMOTE_RELAY_PATHS.bindCreated, {
        handle: { mountSource: handle.mountSource, containerDbId: handle.containerDbId },
        dockerId,
      })
    },

    async activate(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
      await callRpc<unknown>(REMOTE_RELAY_PATHS.activate, {
        handle: { mountSource: handle.mountSource, containerDbId: handle.containerDbId },
        dockerId,
      })
    },

    async release(containerDbId: string, dockerId?: string): Promise<void> {
      await callRpc<unknown>(REMOTE_RELAY_PATHS.release, {
        containerDbId,
        ...(dockerId !== undefined ? { dockerId } : {}),
      })
    },

    async ensureLane(request: RemoteLaneRequest): Promise<RemoteExecutionBackend> {
      const result = await callRpc<RemoteExecutionBackend>(
        REMOTE_RELAY_PATHS.ensureLane,
        buildEnsureLanePayload(request),
      )
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('REMOTE_LANE_UNAVAILABLE')
      }
      return result
    },

    async releaseChat(uid: number, chatId: string): Promise<void> {
      await callRpc<unknown>(REMOTE_RELAY_PATHS.releaseChat, { uid, chatId })
    },

    async releaseSessionKey(
      uid: number,
      sessionKey: string,
      opts?: { containerDbId?: string; operationId?: string; generation?: string },
    ): Promise<ReleaseSessionKeyResult> {
      const res = await sendUnixHttpWithConnectRetry({
        socketPath,
        secret,
        method: 'POST',
        path: REMOTE_RELAY_PATHS.releaseSessionKey,
        body: {
          uid,
          sessionKey,
          ...(opts ? { opts } : {}),
        },
        timeoutMs: requestTimeoutMs,
        retryOnConnect: true,
      })
      const obj =
        res.body && typeof res.body === 'object' && !Array.isArray(res.body)
          ? (res.body as Record<string, unknown>)
          : undefined
      if (res.statusCode >= 200 && res.statusCode < 300 && obj?.ok === true) {
        return assertReleaseSessionKeyResult(obj.result)
      }
      // B8: Server returns HTTP 503 with `{ result: { released: false, state: 'unknown' } }`
      // whenever peer forwarding is inconclusive; preserve `state: 'unknown'` so callers retry
      // rather than misclassifying or swallowing an unproven release.
      if (res.statusCode === 503 && obj && obj.result !== undefined) {
        const parsed = assertReleaseSessionKeyResult(obj.result)
        if (parsed.state === 'unknown') {
          return { released: false, state: 'unknown' }
        }
      }
      throw deserializeRpcError(res.body ?? { code: `REMOTE_RELAY_HTTP_${res.statusCode}` })
    },

    async releaseSessionIfIdle(
      sessionKey: string,
      opts?: { operationId?: string },
    ): Promise<ReleaseSessionIfIdleResult> {
      const raw = await callRpc<unknown>(REMOTE_RELAY_PATHS.releaseSessionIfIdle, {
        sessionKey,
        ...(opts ? { opts } : {}),
      })
      return assertReleaseSessionIfIdleResult(raw)
    },
  }
}

/**
 * Short-timeout, single-hop peer client used by `remote-relay` Slot A <-> Slot B
 * for transparent release forwarding and idle-session handover without retry loops.
 */
export function createRemoteRelayPeerClient(
  options: RemoteRelayPeerClientOptions,
): RemoteRelayPeerClient {
  const socketPath = options.socketPath.trim()
  const secret = options.secret
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS))
  const hopHeaders = Object.freeze({ [REMOTE_RELAY_HOP_HEADER]: '1' })

  return {
    socketPath,

    async releaseSessionKey(
      uid: number,
      sessionKey: string,
      opts?: { containerDbId?: string; operationId?: string; generation?: string },
    ): Promise<ReleaseSessionKeyResult | null> {
      try {
        const res = await sendUnixHttpWithConnectRetry({
          socketPath,
          secret,
          method: 'POST',
          path: REMOTE_RELAY_PATHS.releaseSessionKey,
          body: { uid, sessionKey, ...(opts ? { opts } : {}) },
          timeoutMs,
          retryOnConnect: false,
          extraHeaders: hopHeaders,
        })
        if (res.statusCode !== 200 || !res.body || typeof res.body !== 'object') return null
        const obj = res.body as Record<string, unknown>
        if (obj.ok !== true) return null
        return assertReleaseSessionKeyResult(obj.result)
      } catch {
        return null
      }
    },

    async releaseSessionIfIdle(
      sessionKey: string,
      opts?: { operationId?: string },
    ): Promise<ReleaseSessionIfIdleResult | null> {
      try {
        const res = await sendUnixHttpWithConnectRetry({
          socketPath,
          secret,
          method: 'POST',
          path: REMOTE_RELAY_PATHS.releaseSessionIfIdle,
          body: { sessionKey, ...(opts ? { opts } : {}) },
          timeoutMs,
          retryOnConnect: false,
          extraHeaders: hopHeaders,
        })
        if (res.statusCode !== 200 || !res.body || typeof res.body !== 'object') return null
        const obj = res.body as Record<string, unknown>
        if (obj.ok !== true) return null
        return assertReleaseSessionIfIdleResult(obj.result)
      } catch {
        return null
      }
    },

    async releaseChat(uid: number, chatId: string): Promise<boolean> {
      try {
        const res = await sendUnixHttpWithConnectRetry({
          socketPath,
          secret,
          method: 'POST',
          path: REMOTE_RELAY_PATHS.releaseChat,
          body: { uid, chatId },
          timeoutMs,
          retryOnConnect: false,
          extraHeaders: hopHeaders,
        })
        return res.statusCode === 200
      } catch {
        return false
      }
    },

    async release(containerDbId: string, dockerId?: string): Promise<boolean> {
      try {
        const res = await sendUnixHttpWithConnectRetry({
          socketPath,
          secret,
          method: 'POST',
          path: REMOTE_RELAY_PATHS.release,
          body: { containerDbId, ...(dockerId !== undefined ? { dockerId } : {}) },
          timeoutMs,
          retryOnConnect: false,
          extraHeaders: hopHeaders,
        })
        return res.statusCode === 200
      } catch {
        return false
      }
    },

    async probeHealth(customTimeoutMs?: number): Promise<RemoteRelayHealthStatus | null> {
      try {
        const res = await sendUnixHttpWithConnectRetry({
          socketPath,
          secret,
          method: 'GET',
          path: REMOTE_RELAY_PATHS.healthz,
          timeoutMs: Math.max(50, Math.floor(customTimeoutMs ?? timeoutMs)),
          retryOnConnect: false,
          extraHeaders: hopHeaders,
        })
        if (res.statusCode !== 200) return null
        return isRemoteRelayHealthStatus(res.body) ? res.body : null
      } catch {
        return null
      }
    },
  }
}
