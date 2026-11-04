/**
 * Loopback-only container hop for the official Antigravity CLI (OCV5-415).
 *
 * The CLI calls `CLOUD_CODE_URL/v1internal:*` with the limited Google token it
 * was given. That token is dropped here; the request goes to master/egress
 * with the container token, where internalAntigravityRelay injects the
 * account's full-scope token.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { ANTIGRAVITY_RELAY_PREFIX, TRACE_ID_HEADER } from '@openclaude/protocol'
import { createLogger, type Logger } from './logger.js'
import { routeRelayTrace } from './relayTrace.js'
import { isLoopbackRemoteAddress } from './v3CodexRelay.js'

export const V5_ANTIGRAVITY_RELAY_PREFIX = ANTIGRAVITY_RELAY_PREFIX

export interface V5AntigravityRelayConfig {
  masterBaseUrl: string
  containerToken: string
}

const relayLogger = createLogger({ module: 'v5AntigravityRelay' })
// A queued stream error after terminal cleanup must not become uncaught.
function ignoreLateStreamError(): void {}

type FetchLike = (input: string, init: RequestInit & { duplex?: 'half' }) => Promise<Response>
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** Never forwarded: CLI credentials and anything that would change encoding. */
const DROP = new Set([
  'host',
  'content-length',
  'authorization',
  'x-goog-api-key',
  'cookie',
  'accept-encoding',
  // The turn trace comes only from the route token's running turn (OCV5-595), never from the caller.
  TRACE_ID_HEADER,
])

export function readV5AntigravityRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): V5AntigravityRelayConfig | null {
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  return base && token ? { masterBaseUrl: base.replace(/\/+$/, ''), containerToken: token } : null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('connection', 'close')
  res.end(JSON.stringify(body))
}

function headersFor(req: IncomingMessage, token: string, pathname: string): Headers {
  const headers = new Headers()
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP.has(key) || DROP.has(key)) continue
    if (rawValue === undefined) continue
    if (Array.isArray(rawValue)) rawValue.forEach((value) => headers.append(rawKey, value))
    else headers.set(rawKey, rawValue)
  }
  headers.set('authorization', `Bearer ${token}`)
  const traceId = routeRelayTrace(pathname)
  if (traceId) headers.set(TRACE_ID_HEADER, traceId)
  return headers
}

export async function handleV5AntigravityRelayLocal(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: V5AntigravityRelayConfig,
  opts: { fetchImpl?: FetchLike; logger?: Pick<Logger, 'info'> } = {},
): Promise<void> {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, {
      error: { code: 'FORBIDDEN', message: 'antigravity relay is loopback-only' },
    })
    return
  }
  const parsed = new URL(req.url ?? '/', 'http://local')
  if (!parsed.pathname.startsWith(`${V5_ANTIGRAVITY_RELAY_PREFIX}/route/`)) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown antigravity relay path' } })
    return
  }
  const requestId = randomUUID()
  const traceId = routeRelayTrace(parsed.pathname)
  const rpc = /\/v1internal:([A-Za-z]{1,64})$/.exec(parsed.pathname)?.[1] ?? 'unknown'
  const startedAt = performance.now()
  const stage = (name: string, statusCode?: number): void => {
    try {
      (opts.logger ?? relayLogger).info('antigravity_local_relay', {
        requestId, traceId, rpc, stage: name, elapsedMs: performance.now() - startedAt,
        ...(traceId === undefined ? { traceIdMissing: 'relay-without-trace' } : {}),
        ...(statusCode === undefined ? {} : { statusCode }),
      })
    } catch { /* Diagnostics cannot change delivery. No URL, body or error text. */ }
  }
  res.setHeader('x-request-id', requestId)
  const controller = new AbortController()
  const onAborted = (): void => { stage('request_aborted'); controller.abort() }
  const onClose = (): void => {
    if (!res.writableFinished) stage('downstream_closed')
    controller.abort()
  }
  req.once('aborted', onAborted)
  res.once('close', onClose)
  stage('request_received')
  try {
    if (req.destroyed || req.aborted || res.destroyed) {
      stage('downstream_closed')
      return
    }
    const headers = headersFor(req, cfg.containerToken, parsed.pathname)
    headers.set('x-request-id', requestId)
    stage('fetch_started')
    const upstream = await (opts.fetchImpl ?? (fetch as FetchLike))(
      `${cfg.masterBaseUrl}${parsed.pathname}${parsed.search}`,
      {
        method: req.method ?? 'GET',
        headers,
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            // Fetch cancels its upload iterator on an early upstream rejection.
            // Do not let iterator.return() destroy the CLI socket before its 413.
            : (req.iterator({ destroyOnReturn: false }) as unknown as BodyInit),
        duplex: 'half',
        signal: controller.signal,
      },
    )
    stage('headers_received', upstream.status)
    if (res.destroyed) {
      await upstream.body?.cancel()
      return
    }
    res.statusCode = upstream.status
    // Loopback hop only: closing after each response prevents Go's net/http pool
    // from holding an idle socket across a 5s+ tool execution window and racing
    // Node's keepAliveTimeout (`read: connection reset by peer`).
    res.setHeader('connection', 'close')
    upstream.headers.forEach((value, rawKey) => {
      const key = rawKey.toLowerCase()
      // fetch already decoded the body; a stale content-encoding would corrupt it.
      if (!HOP.has(key) && key !== 'content-length' && key !== 'content-encoding')
        res.setHeader(rawKey, value)
    })
    if (!upstream.body) {
      res.end()
      stage('response_complete', upstream.status)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const body = Readable.fromWeb(upstream.body as any)
      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        body.unpipe(res)
        body.off('error', onError)
        res.off('error', onError)
        res.off('finish', onFinish)
        res.off('close', onClosed)
        body.on('error', ignoreLateStreamError)
        res.on('error', ignoreLateStreamError)
        if (!body.readableEnded) body.destroy()
        if (err) reject(err)
        else resolve()
      }
      const onError = (err: Error): void => settle(err)
      const onFinish = (): void => { stage('response_complete', upstream.status); settle() }
      const onClosed = (): void => settle()
      body.once('error', onError)
      res.once('error', onError)
      res.once('finish', onFinish)
      res.once('close', onClosed)
      if (res.destroyed) settle()
      else body.pipe(res)
    })
  } catch (err) {
    if (controller.signal.aborted) return
    stage('relay_failed')
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : undefined)
      return
    }
    sendJson(res, 502, {
      error: {
        code: 'ANTIGRAVITY_RELAY_FAILED',
        message: 'antigravity relay transport failed',
      },
    })
  } finally {
    req.off('aborted', onAborted)
    res.off('close', onClose)
    // Also release an unfinished upload after an early response. The preserved
    // request iterator leaves the client connection to ServerResponse to close.
    controller.abort()
  }
}
