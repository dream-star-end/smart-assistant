/**
 * Loopback-only container hop for the official Antigravity CLI (OCV5-415).
 *
 * The CLI calls `CLOUD_CODE_URL/v1internal:*` with the limited Google token it
 * was given. That token is dropped here; the request goes to master/egress
 * with the container token, where internalAntigravityRelay injects the
 * account's full-scope token.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { ANTIGRAVITY_RELAY_PREFIX, TRACE_ID_HEADER } from '@openclaude/protocol'
import { routeRelayTrace } from './relayTrace.js'
import { isLoopbackRemoteAddress } from './v3CodexRelay.js'

export const V5_ANTIGRAVITY_RELAY_PREFIX = ANTIGRAVITY_RELAY_PREFIX

export interface V5AntigravityRelayConfig {
  masterBaseUrl: string
  containerToken: string
}

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
  opts: { fetchImpl?: FetchLike } = {},
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
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  res.once('close', abort)
  try {
    const upstream = await (opts.fetchImpl ?? (fetch as FetchLike))(
      `${cfg.masterBaseUrl}${parsed.pathname}${parsed.search}`,
      {
        method: req.method ?? 'GET',
        headers: headersFor(req, cfg.containerToken, parsed.pathname),
        body:
          req.method === 'GET' || req.method === 'HEAD' ? undefined : (req as unknown as BodyInit),
        duplex: 'half',
        signal: controller.signal,
      },
    )
    res.statusCode = upstream.status
    upstream.headers.forEach((value, rawKey) => {
      const key = rawKey.toLowerCase()
      // fetch already decoded the body; a stale content-encoding would corrupt it.
      if (!HOP.has(key) && key !== 'content-length' && key !== 'content-encoding')
        res.setHeader(rawKey, value)
    })
    if (!upstream.body) {
      res.end()
      return
    }
    await new Promise<void>((resolve, reject) => {
      const body = Readable.fromWeb(upstream.body as any)
      body.on('error', reject)
      res.on('error', reject)
      res.on('finish', resolve)
      body.pipe(res)
    })
  } catch (err) {
    if (controller.signal.aborted) return
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : undefined)
      return
    }
    sendJson(res, 502, {
      error: {
        code: 'ANTIGRAVITY_RELAY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    })
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}
