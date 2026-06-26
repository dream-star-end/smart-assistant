/**
 * v3 container API proxy — safely expose selected personal-version APIs to
 * commercial users by forwarding them to the caller's own isolated container.
 *
 * This is intentionally separate from containerFileProxy:
 *   - file proxy streams large media and rewrites Content-Disposition;
 *   - API proxy forwards small JSON/control requests with a strict body cap.
 */

import { createHmac } from 'node:crypto'
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { isIPv4 } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { matchCommercialContainerApiProxy } from '@openclaude/gateway'
import { getRuntimeChannel } from '../runtimeChannel.js'
import type { V3ContainerStatus, V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { V3_CONTAINER_PORT, getV3ContainerStatus } from '../agent-sandbox/v3supervisor.js'
import { type dialTunnelSocket, hostRowToTarget } from '../compute-pool/nodeAgentClient.js'
import type { ComputeHostRow } from '../compute-pool/types.js'
import type { RequestContext } from './handlers.js'
import {
  readBodyByContentLength,
  readBodyCapped,
  readBodyChunked,
  readResponseHead,
} from './tunnelHttpReader.js'

const CONNECT_MS = 3_000
const IDLE_MS = 60_000
const MAX_REQUEST_BODY_BYTES = 512 * 1024
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024

const FORWARD_REQUEST_HEADERS = new Set(['accept', 'content-type', 'user-agent', 'x-request-id'])

const RESPONSE_HEADER_ALLOWLIST = new Set(['content-type', 'etag', 'last-modified'])

export interface ContainerApiProxyDeps {
  v3: V3SupervisorDeps
  bridgeSecret: string
  selfHostId?: string
  getHostById?: (id: string) => Promise<ComputeHostRow | null>
  tunnelDial?: typeof dialTunnelSocket
  rowToTarget?: typeof hostRowToTarget
  getStatus?: (uid: number) => Promise<V3ContainerStatus | null>
  httpRequestImpl?: typeof httpRequest
}

export function matchContainerApiProxyRoute(path: string, method: string): boolean {
  return Boolean(matchCommercialContainerApiProxy(path, method))
}

function isBoundIpAllowed(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const p = ip.split('.').map(Number)
  // channel-aware 网段白名单:v3=172.30/16,v5=172.31/16(同 containerFileProxy)。
  const expectSecond = getRuntimeChannel() === 'v5' ? 31 : 30
  return p[0] === 172 && p[1] === expectSecond
}

async function readRequestBodyCapped(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      const err = new Error(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`)
      ;(err as Error & { code?: string; status?: number }).code = 'PAYLOAD_TOO_LARGE'
      ;(err as Error & { code?: string; status?: number }).status = 413
      throw err
    }
    chunks.push(buf)
  }
  return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total)
}

function buildBridgeHeaders(
  req: IncomingMessage,
  status: Pick<V3ContainerStatus, 'containerId'>,
  bridgeSecret: string,
  body: Buffer,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase()
    if (!FORWARD_REQUEST_HEADERS.has(lower)) continue
    if (v === undefined) continue
    const value = Array.isArray(v) ? v.join(', ') : String(v)
    if (/[\r\n]/.test(value)) continue
    headers[k] = value
  }
  // FORWARD_REQUEST_HEADERS deliberately excludes commercial auth material.
  headers['X-OpenClaude-Container-Id'] = String(status.containerId)
  headers['X-OpenClaude-Bridge-Nonce'] = createHmac('sha256', bridgeSecret)
    .update(String(status.containerId))
    .digest('hex')
  headers['Accept-Encoding'] = 'identity'
  if (body.length > 0) headers['Content-Length'] = String(body.length)
  return headers
}

function responseHeadersFrom(
  upstream: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {
    'Cache-Control': 'no-store',
    Vary: 'Authorization, Cookie',
  }
  for (const [k, v] of Object.entries(upstream)) {
    if (v === undefined) continue
    const lower = k.toLowerCase()
    if (!RESPONSE_HEADER_ALLOWLIST.has(lower)) continue
    out[k] = v
  }
  return out
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify({ error: { code, message, request_id: requestId } }))
}

async function readTunnelBody(
  socket: TLSSocket,
  head: NonNullable<Awaited<ReturnType<typeof readResponseHead>>>,
): Promise<Buffer | null> {
  const te = (head.headers['transfer-encoding'] ?? '').toLowerCase()
  const cl = head.headers['content-length']
  if (te.includes('chunked')) {
    return await readBodyChunked(socket, head.leftover, IDLE_MS, MAX_RESPONSE_BODY_BYTES)
  }
  if (cl !== undefined) {
    const expected = Number.parseInt(cl, 10)
    if (!Number.isFinite(expected) || expected < 0 || expected > MAX_RESPONSE_BODY_BYTES)
      return null
    return await readBodyByContentLength(socket, head.leftover, expected, IDLE_MS)
  }
  // Local Node server usually sends Content-Length for JSON; keep a small fallback.
  return await readBodyCapped(socket, head.leftover, IDLE_MS, MAX_RESPONSE_BODY_BYTES)
}

async function dispatchLocal(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: ContainerApiProxyDeps,
  status: V3ContainerStatus,
  body: Buffer,
): Promise<void> {
  const host = req.headers.host ?? 'x.invalid'
  const reqUrl = new URL(req.url ?? '/', `http://${host}`)
  const headers = buildBridgeHeaders(req, status, deps.bridgeSecret, body)
  const requestImpl = deps.httpRequestImpl ?? httpRequest

  await new Promise<void>((resolve) => {
    const upstream = requestImpl({
      host: status.boundIp,
      port: status.port,
      method: req.method ?? 'GET',
      path: reqUrl.pathname + reqUrl.search,
      headers,
      family: 4,
      timeout: CONNECT_MS,
    })
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    upstream.on('timeout', () => upstream.destroy(new Error('connect_or_idle_timeout')))
    upstream.on('error', (err) => {
      ctx.log.warn('container_api_proxy_upstream_error', {
        error: (err as Error)?.message ?? String(err),
      })
      if (!res.headersSent) sendJsonError(res, 502, 'BAD_GATEWAY', 'upstream error', ctx.requestId)
      else if (!res.writableEnded) res.destroy()
      finish()
    })
    upstream.on('response', (r) => {
      r.socket.setTimeout(IDLE_MS)
      const chunks: Buffer[] = []
      let total = 0
      let tooLarge = false
      r.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_RESPONSE_BODY_BYTES) {
          tooLarge = true
          try {
            r.destroy()
          } catch {}
          return
        }
        chunks.push(chunk)
      })
      r.on('end', () => {
        if (tooLarge) {
          if (!res.headersSent)
            sendJsonError(
              res,
              502,
              'UPSTREAM_TOO_LARGE',
              'upstream response too large',
              ctx.requestId,
            )
          finish()
          return
        }
        const outHeaders = responseHeadersFrom(r.headers)
        const outBody = Buffer.concat(chunks, total)
        outHeaders['Content-Length'] = String(outBody.length)
        res.writeHead(r.statusCode ?? 502, outHeaders)
        res.end(outBody)
        finish()
      })
      r.on('error', () => {
        if (!res.headersSent)
          sendJsonError(res, 502, 'BAD_GATEWAY', 'upstream response error', ctx.requestId)
        else if (!res.writableEnded) res.destroy()
        finish()
      })
    })
    if (body.length > 0) upstream.write(body)
    upstream.end()
  })
}

async function dispatchTunnel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: ContainerApiProxyDeps,
  status: V3ContainerStatus,
  body: Buffer,
): Promise<void> {
  if (!deps.tunnelDial || !deps.getHostById || !status.hostId || !status.dockerContainerId) {
    sendJsonError(res, 502, 'BAD_GATEWAY', 'remote dispatch unavailable', ctx.requestId)
    return
  }
  const row = await deps.getHostById(status.hostId)
  if (!row) {
    sendJsonError(res, 502, 'BAD_GATEWAY', 'host not found', ctx.requestId)
    return
  }
  // A3 — 终态 revoked host 不再走 container API tunnel(deny)。
  if (row.status === 'revoked') {
    sendJsonError(res, 502, 'BAD_GATEWAY', 'host revoked', ctx.requestId)
    return
  }
  const target = (deps.rowToTarget ?? hostRowToTarget)(row)
  target.requireFingerprint = true
  try {
    const host = req.headers.host ?? 'x.invalid'
    const reqUrl = new URL(req.url ?? '/', `http://${host}`)
    const headers = buildBridgeHeaders(req, status, deps.bridgeSecret, body)
    const params = new URLSearchParams(reqUrl.search)
    params.set('port', String(status.port))
    const pathAndQuery = `${reqUrl.pathname}?${params.toString()}`

    let socket: TLSSocket
    try {
      socket = await deps.tunnelDial({
        target,
        method: req.method ?? 'GET',
        containerInternalId: status.dockerContainerId,
        pathAndQuery,
        headers,
        connectTimeoutMs: CONNECT_MS,
      })
    } catch (err) {
      ctx.log.warn('container_api_proxy_tunnel_dial_failed', {
        hostId: status.hostId,
        error: (err as Error)?.message ?? String(err),
      })
      sendJsonError(res, 502, 'BAD_GATEWAY', 'tunnel dial failed', ctx.requestId)
      return
    }
    try {
      if (body.length > 0) socket.write(body)
      const head = await readResponseHead(socket, IDLE_MS, MAX_HEADER_BYTES)
      if (!head) {
        sendJsonError(res, 504, 'GATEWAY_TIMEOUT', 'upstream head timeout', ctx.requestId)
        return
      }
      const respBody = await readTunnelBody(socket, head)
      if (!respBody) {
        sendJsonError(res, 502, 'BAD_GATEWAY', 'upstream body unavailable', ctx.requestId)
        return
      }
      const outHeaders = responseHeadersFrom(head.headers)
      outHeaders['Content-Length'] = String(respBody.length)
      res.writeHead(head.statusCode || 502, outHeaders)
      res.end(respBody)
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

export async function containerApiProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: ContainerApiProxyDeps,
  uid: bigint,
): Promise<void> {
  const method = req.method ?? 'GET'
  const host = req.headers.host ?? 'x.invalid'
  const reqUrl = new URL(req.url ?? '/', `http://${host}`)
  const rule = matchCommercialContainerApiProxy(reqUrl.pathname, method)
  if (!rule) {
    sendJsonError(res, 404, 'NOT_FOUND', 'container api route not allowed', ctx.requestId)
    return
  }
  if (uid <= 0n || uid > BigInt(Number.MAX_SAFE_INTEGER)) {
    sendJsonError(res, 400, 'BAD_UID', 'invalid uid', ctx.requestId)
    return
  }

  let body: Buffer
  try {
    body = await readRequestBodyCapped(req)
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 413
    sendJsonError(res, status, 'PAYLOAD_TOO_LARGE', 'request body too large', ctx.requestId)
    return
  }

  const uidNum = Number(uid)
  const status = deps.getStatus
    ? await deps.getStatus(uidNum)
    : await getV3ContainerStatus(deps.v3, uidNum)
  if (!status || status.state !== 'running') {
    sendJsonError(res, 503, 'CONTAINER_NOT_RUNNING', 'container is not running', ctx.requestId)
    return
  }
  if (!isBoundIpAllowed(status.boundIp) || status.port !== V3_CONTAINER_PORT) {
    ctx.log.warn('container_api_proxy_bad_endpoint', {
      uid: String(uid),
      boundIp: status.boundIp,
      port: status.port,
      route: rule.label,
    })
    sendJsonError(res, 502, 'BAD_GATEWAY', 'container endpoint rejected', ctx.requestId)
    return
  }

  ctx.log.info('container_api_proxy_dispatch', { uid: String(uid), route: rule.label })
  const remote = Boolean(status.hostId && deps.selfHostId && status.hostId !== deps.selfHostId)
  if (remote) {
    await dispatchTunnel(req, res, ctx, deps, status, body)
  } else {
    await dispatchLocal(req, res, ctx, deps, status, body)
  }
}
