/**
 * Shared master → user-container authenticated internal HTTP client.
 *
 * Used by:
 *   - `containerOfficePreviewProxy.ts` (`/internal/office-preview`, `/internal/office-preview/page`)
 *   - `containerSwarmCommandProxy.ts` (`/internal/swarm/command`)
 *   - `pendingDecisionsBootstrap.ts` (container taskboard adapter `/api/board/tickets*`)
 *
 * Security invariants:
 *   - Looks up container strictly by authenticated numeric `uid` (`getV3ContainerStatus`).
 *   - Enforces channel-aware docker bridge IP allowlist (`isPlatformContainerIp`) + `V3_CONTAINER_PORT`.
 *   - Signs per-container HMAC bridge nonce (`HMAC-SHA256(bridgeSecret, containerId)`).
 *   - Supports both local docker bridge HTTP and remote compute-pool mTLS tunnel (denies revoked hosts).
 */

import { createHmac } from 'node:crypto'
import { request as defaultHttpRequest } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { buildSignedInternalBridgeHeaders } from '@openclaude/gateway'
import {
  V3_CONTAINER_PORT,
  getV3ContainerStatus,
  type V3ContainerStatus,
  type V3SupervisorDeps,
} from '../agent-sandbox/v3supervisor.js'
import { dialTunnelSocket as defaultTunnelDial, hostRowToTarget } from '../compute-pool/nodeAgentClient.js'
import { getHostById as defaultGetHostById } from '../compute-pool/queries.js'
import type { ComputeHostRow } from '../compute-pool/types.js'
import { isPlatformContainerIp } from '../containerNet.js'
import {
  readBodyByContentLength,
  readBodyCapped,
  readBodyChunked,
  readResponseHead,
} from './tunnelHttpReader.js'

const DEFAULT_CONNECT_MS = 3_000
const DEFAULT_IDLE_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 18 * 1024 * 1024 // 18 MiB (covers 16 MiB PNG page images + JSON)
const MAX_HEADER_BYTES = 64 * 1024

export class ContainerInternalRequestError extends Error {
  readonly code:
    | 'BAD_UID'
    | 'CONTAINER_NOT_RUNNING'
    | 'BAD_ENDPOINT'
    | 'HOST_REVOKED'
    | 'BAD_GATEWAY'
    | 'GATEWAY_TIMEOUT'
    | 'UPSTREAM_TOO_LARGE'
  readonly httpStatus: number

  constructor(
    code: ContainerInternalRequestError['code'],
    httpStatus: number,
    message: string,
  ) {
    super(message)
    this.name = 'ContainerInternalRequestError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface ContainerInternalClientDeps {
  v3: V3SupervisorDeps
  bridgeSecret: string
  selfHostId?: string
  getStatus?: (uid: number) => Promise<V3ContainerStatus | null>
  getHostById?: (id: string) => Promise<ComputeHostRow | null>
  tunnelDial?: typeof defaultTunnelDial
  rowToTarget?: typeof hostRowToTarget
  httpRequestImpl?: typeof defaultHttpRequest
  /** Test seam ONLY: override container IP/port allowlist for 127.0.0.1 ephemeral servers. */
  isEndpointAllowed?: (status: V3ContainerStatus) => boolean
}

export interface ContainerInternalRequestInput {
  uid: bigint
  method: 'GET' | 'POST'
  pathAndQuery: string
  body?: Buffer | string | null
  headers?: Record<string, string>
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  maxResponseBytes?: number
}

export interface ContainerInternalResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function defaultIsEndpointAllowed(status: V3ContainerStatus): boolean {
  return isPlatformContainerIp(status.boundIp) && status.port === V3_CONTAINER_PORT
}

export function buildContainerBridgeHeaders(
  containerId: number,
  bridgeSecret: string,
  extraHeaders?: Record<string, string>,
  body: Buffer | number = 0,
  signing?: { method: string; pathAndQuery: string; nowMs?: number; reqNonce?: string },
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) continue
      headers[k] = v
    }
  }
  const bridgeNonce = createHmac('sha256', bridgeSecret)
    .update(String(containerId))
    .digest('hex')
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
  const bodyLen = Buffer.isBuffer(body) ? body.length : body

  if (signing) {
    Object.assign(
      headers,
      buildSignedInternalBridgeHeaders({
        containerId,
        bridgeNonce,
        method: signing.method,
        pathAndQuery: signing.pathAndQuery,
        body: bodyBuf,
        nowMs: signing.nowMs,
        reqNonce: signing.reqNonce,
      }),
    )
  } else {
    headers['X-OpenClaude-Container-Id'] = String(containerId)
    headers['X-OpenClaude-Bridge-Nonce'] = bridgeNonce
  }
  headers['Accept-Encoding'] = 'identity'
  if (bodyLen > 0) {
    headers['Content-Length'] = String(bodyLen)
  }
  return headers
}

async function readTunnelResponseBody(
  socket: TLSSocket,
  head: NonNullable<Awaited<ReturnType<typeof readResponseHead>>>,
  idleMs: number,
  maxBytes: number,
): Promise<Buffer | null> {
  const te = (head.headers['transfer-encoding'] ?? '').toLowerCase()
  const cl = head.headers['content-length']
  if (te.includes('chunked')) {
    return await readBodyChunked(socket, head.leftover, idleMs, maxBytes)
  }
  if (cl !== undefined) {
    const expected = Number.parseInt(cl, 10)
    if (!Number.isFinite(expected) || expected < 0 || expected > maxBytes) return null
    return await readBodyByContentLength(socket, head.leftover, expected, idleMs)
  }
  return await readBodyCapped(socket, head.leftover, idleMs, maxBytes)
}

async function sendLocalRequest(
  status: V3ContainerStatus,
  input: ContainerInternalRequestInput,
  headers: Record<string, string>,
  bodyBuf: Buffer,
  deps: ContainerInternalClientDeps,
): Promise<ContainerInternalResponse> {
  const connectMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_MS
  const idleMs = input.idleTimeoutMs ?? DEFAULT_IDLE_MS
  const maxBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const requestImpl = deps.httpRequestImpl ?? defaultHttpRequest

  return await new Promise<ContainerInternalResponse>((resolve, reject) => {
    const upstream = requestImpl({
      host: status.boundIp,
      port: status.port,
      method: input.method,
      path: input.pathAndQuery,
      headers,
      family: 4,
      timeout: connectMs,
    })
    let settled = false
    const finishOk = (resp: ContainerInternalResponse) => {
      if (settled) return
      settled = true
      resolve(resp)
    }
    const finishErr = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }

    upstream.on('socket', (sock) => {
      const promoteTimeout = () => {
        if (typeof upstream.setTimeout === 'function') upstream.setTimeout(idleMs)
      }
      if (sock?.connecting) sock.once('connect', promoteTimeout)
      else promoteTimeout()
    })
    upstream.on('timeout', () => {
      upstream.destroy(
        new ContainerInternalRequestError('GATEWAY_TIMEOUT', 504, 'container upstream timeout'),
      )
    })
    upstream.on('error', (err) => {
      if (err instanceof ContainerInternalRequestError) {
        finishErr(err)
        return
      }
      finishErr(
        new ContainerInternalRequestError(
          'BAD_GATEWAY',
          502,
          `container upstream error: ${(err as Error)?.message ?? String(err)}`,
        ),
      )
    })
    upstream.on('response', (r) => {
      r.socket?.setTimeout(idleMs)
      const chunks: Buffer[] = []
      let total = 0
      let tooLarge = false
      r.on('data', (chunk: Buffer) => {
        if (tooLarge) return
        total += chunk.length
        if (total > maxBytes) {
          tooLarge = true
          finishErr(
            new ContainerInternalRequestError(
              'UPSTREAM_TOO_LARGE',
              502,
              'container upstream response exceeded size cap',
            ),
          )
          try {
            r.destroy()
            upstream.destroy()
          } catch {}
          return
        }
        chunks.push(chunk)
      })
      r.on('end', () => {
        if (tooLarge) {
          finishErr(
            new ContainerInternalRequestError(
              'UPSTREAM_TOO_LARGE',
              502,
              'container upstream response exceeded size cap',
            ),
          )
          return
        }
        const outHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(r.headers)) {
          if (typeof v === 'string') outHeaders[k.toLowerCase()] = v
          else if (Array.isArray(v) && v.length > 0) outHeaders[k.toLowerCase()] = v.join(', ')
        }
        finishOk({
          status: r.statusCode ?? 502,
          headers: outHeaders,
          body: Buffer.concat(chunks, total),
        })
      })
      r.on('error', (err) => {
        finishErr(
          new ContainerInternalRequestError(
            'BAD_GATEWAY',
            502,
            `container response error: ${(err as Error)?.message ?? String(err)}`,
          ),
        )
      })
    })
    if (bodyBuf.length > 0) upstream.write(bodyBuf)
    upstream.end()
  })
}

async function sendTunnelRequest(
  status: V3ContainerStatus,
  input: ContainerInternalRequestInput,
  headers: Record<string, string>,
  bodyBuf: Buffer,
  deps: ContainerInternalClientDeps,
): Promise<ContainerInternalResponse> {
  const getHost = deps.getHostById ?? defaultGetHostById
  const tunnelDial = deps.tunnelDial ?? defaultTunnelDial
  if (!status.hostId || !status.dockerContainerId) {
    throw new ContainerInternalRequestError('BAD_GATEWAY', 502, 'remote dispatch unavailable')
  }
  const row = await getHost(status.hostId)
  if (!row) {
    throw new ContainerInternalRequestError('BAD_GATEWAY', 502, 'compute host not found')
  }
  if (row.status === 'revoked') {
    throw new ContainerInternalRequestError('HOST_REVOKED', 502, 'compute host revoked')
  }
  const target = (deps.rowToTarget ?? hostRowToTarget)(row)
  target.requireFingerprint = true
  try {
    const parsed = new URL(input.pathAndQuery, 'http://container.internal')
    const params = new URLSearchParams(parsed.search)
    params.set('port', String(status.port))
    const pathAndQuery = `${parsed.pathname}?${params.toString()}`
    const connectMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_MS
    const idleMs = input.idleTimeoutMs ?? DEFAULT_IDLE_MS
    const maxBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

    let socket: TLSSocket
    try {
      socket = await tunnelDial({
        target,
        method: input.method,
        containerInternalId: status.dockerContainerId,
        pathAndQuery,
        headers,
        connectTimeoutMs: connectMs,
      })
    } catch (err) {
      throw new ContainerInternalRequestError(
        'BAD_GATEWAY',
        502,
        `tunnel dial failed: ${(err as Error)?.message ?? String(err)}`,
      )
    }
    try {
      if (bodyBuf.length > 0) socket.write(bodyBuf)
      const head = await readResponseHead(socket, idleMs, MAX_HEADER_BYTES)
      if (!head) {
        throw new ContainerInternalRequestError('GATEWAY_TIMEOUT', 504, 'upstream head timeout')
      }
      const respBody = await readTunnelResponseBody(socket, head, idleMs, maxBytes)
      if (!respBody) {
        throw new ContainerInternalRequestError('BAD_GATEWAY', 502, 'upstream body unavailable')
      }
      const outHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(head.headers)) {
        outHeaders[k.toLowerCase()] = v
      }
      return {
        status: head.statusCode || 502,
        headers: outHeaders,
        body: respBody,
      }
    } finally {
      try {
        socket.destroy()
      } catch {}
    }
  } finally {
    try {
      target.psk?.fill(0)
    } catch {}
  }
}

/**
 * Issue a bridge-authenticated HTTP request to the caller's own running container.
 */
export async function requestUserContainerInternal(
  deps: ContainerInternalClientDeps,
  input: ContainerInternalRequestInput,
): Promise<ContainerInternalResponse> {
  if (input.uid <= 0n || input.uid > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ContainerInternalRequestError('BAD_UID', 400, 'invalid uid')
  }
  const uidNum = Number(input.uid)
  const status = deps.getStatus
    ? await deps.getStatus(uidNum)
    : await getV3ContainerStatus(deps.v3, uidNum)
  if (!status || status.state !== 'running') {
    throw new ContainerInternalRequestError('CONTAINER_NOT_RUNNING', 503, 'container is not running')
  }
  const allowed = deps.isEndpointAllowed ?? defaultIsEndpointAllowed
  if (!allowed(status)) {
    throw new ContainerInternalRequestError('BAD_ENDPOINT', 502, 'container endpoint rejected')
  }

  const bodyBuf =
    input.body === undefined || input.body === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(input.body)
        ? input.body
        : Buffer.from(input.body, 'utf8')
  const isSignedInternalRoute = input.pathAndQuery.startsWith('/internal/')
  const headers = buildContainerBridgeHeaders(
    status.containerId,
    deps.bridgeSecret,
    input.headers,
    bodyBuf,
    isSignedInternalRoute
      ? {
          method: input.method,
          pathAndQuery: input.pathAndQuery,
        }
      : undefined,
  )

  const selfHostId = deps.selfHostId ?? deps.v3.selfHostId
  const remote = Boolean(status.hostId && selfHostId && status.hostId !== selfHostId)
  if (remote) {
    return await sendTunnelRequest(status, input, headers, bodyBuf, deps)
  }
  return await sendLocalRequest(status, input, headers, bodyBuf, deps)
}
