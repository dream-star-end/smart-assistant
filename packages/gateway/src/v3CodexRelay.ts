/**
 * v3 commercial container-local Codex relay.
 *
 * Codex CLI uses Authorization for its upstream OpenAI/Codex token, while the
 * master internal listener uses Authorization for oc-v3 container identity.
 * Therefore the CLI must first call this loopback-only container gateway
 * endpoint.  The container gateway moves the upstream Authorization into a
 * private header and authenticates to master with OPENCLAUDE_V3_CONTAINER_TOKEN.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import { CODEX_RELAY_PREFIX } from '@openclaude/protocol'

export const V3_CODEX_RELAY_PREFIX = CODEX_RELAY_PREFIX
export const V3_CODEX_UPSTREAM_AUTH_HEADER = 'x-openclaude-upstream-authorization'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface V3CodexRelayConfig {
  masterBaseUrl: string
  containerToken: string
}

type FetchLike = (
  input: string,
  init: RequestInit & { duplex?: 'half' },
) => Promise<Response>

export function readV3CodexRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3CodexRelayConfig | null {
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return null
  return {
    masterBaseUrl: base.replace(/\/+$/, ''),
    containerToken: token,
  }
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined | null): boolean {
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function appendHeader(headers: Headers, key: string, value: string | string[] | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    for (const v of value) headers.append(key, v)
    return
  }
  headers.set(key, value)
}

function buildForwardHeaders(req: IncomingMessage, containerToken: string): Headers {
  const headers = new Headers()
  const upstreamAuthorization = req.headers.authorization
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (key === 'host' || key === 'content-length') continue
    if (key === 'authorization') continue
    // Never trust a caller-supplied private header; overwrite it below from
    // the original Authorization value observed on this loopback request.
    if (key === V3_CODEX_UPSTREAM_AUTH_HEADER) continue
    appendHeader(headers, rawKey, rawValue)
  }
  headers.set('authorization', `Bearer ${containerToken}`)
  if (typeof upstreamAuthorization === 'string' && upstreamAuthorization.trim().length > 0) {
    headers.set(V3_CODEX_UPSTREAM_AUTH_HEADER, upstreamAuthorization)
  }
  return headers
}

function copyResponseHeaders(from: Headers, res: ServerResponse): void {
  from.forEach((value, rawKey) => {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) return
    if (key === 'content-length') return
    res.setHeader(rawKey, value)
  })
}

function closeIfHeadersAlreadySent(res: ServerResponse, err: unknown): boolean {
  if (res.writableEnded) return true
  if (!res.headersSent) return false
  res.destroy(err instanceof Error ? err : undefined)
  return true
}

export async function handleV3CodexRelayLocal(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: V3CodexRelayConfig,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'codex relay is loopback-only' } })
    return
  }
  const rawUrl = req.url ?? '/'
  const parsed = new URL(rawUrl, 'http://local')
  if (!parsed.pathname.startsWith(V3_CODEX_RELAY_PREFIX)) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown codex relay path' } })
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  res.once('close', abort)

  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  const target = `${cfg.masterBaseUrl}${parsed.pathname}${parsed.search}`
  try {
    const upstream = await fetchImpl(target, {
      method: req.method ?? 'GET',
      headers: buildForwardHeaders(req, cfg.containerToken),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (req as unknown as BodyInit),
      duplex: 'half',
      signal: controller.signal,
    })
    res.statusCode = upstream.status
    copyResponseHeaders(upstream.headers, res)
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
    if (closeIfHeadersAlreadySent(res, err)) return
    sendJson(res, 502, {
      error: {
        code: 'CODEX_RELAY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    })
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}
