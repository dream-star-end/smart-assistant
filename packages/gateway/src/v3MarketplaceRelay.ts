/**
 * v3/v5 commercial container-local marketplace relay.
 *
 * Codex subprocesses intentionally do not inherit OPENCLAUDE_* secrets. The
 * `oc-market` CLI therefore cannot call the master marketplace endpoint
 * directly from a scrubbed Codex env. This loopback-only gateway endpoint keeps
 * the secret in the long-lived container gateway process, authenticates to
 * master with the container token, and exposes only the marketplace agent API to
 * local tools.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import {
  MARKETPLACE_AGENT_PREFIX,
  MARKETPLACE_LOCAL_RELAY_PREFIX,
} from '@openclaude/protocol'
import { isLoopbackRemoteAddress } from './v3CodexRelay.js'

export const V3_MARKETPLACE_LOCAL_RELAY_PREFIX = MARKETPLACE_LOCAL_RELAY_PREFIX
export const V3_MARKETPLACE_MASTER_AGENT_PREFIX = MARKETPLACE_AGENT_PREFIX

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

export interface V3MarketplaceRelayConfig {
  masterBaseUrl: string
  containerToken: string
}

type FetchLike = (
  input: string,
  init: RequestInit & { duplex?: 'half' },
) => Promise<Response>

export function readV3MarketplaceRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3MarketplaceRelayConfig | null {
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return null
  return {
    masterBaseUrl: base.replace(/\/+$/, ''),
    containerToken: token,
  }
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
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (key === 'host' || key === 'content-length') continue
    if (key === 'authorization') continue
    appendHeader(headers, rawKey, rawValue)
  }
  headers.set('authorization', `Bearer ${containerToken}`)
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

function targetPathFor(localPathname: string): string | null {
  if (localPathname !== V3_MARKETPLACE_LOCAL_RELAY_PREFIX
    && !localPathname.startsWith(`${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/`)) {
    return null
  }
  const op = localPathname.slice(V3_MARKETPLACE_LOCAL_RELAY_PREFIX.length).replace(/^\/+/, '')
  if (!op) return null
  return `${V3_MARKETPLACE_MASTER_AGENT_PREFIX}${op}`
}

export async function handleV3MarketplaceRelayLocal(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: V3MarketplaceRelayConfig,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'marketplace relay is loopback-only' } })
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'marketplace relay only supports GET/POST' } })
    return
  }

  const rawUrl = req.url ?? '/'
  const parsed = new URL(rawUrl, 'http://local')
  const targetPath = targetPathFor(parsed.pathname)
  if (!targetPath) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown marketplace relay path' } })
    return
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  res.once('close', abort)

  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  const target = `${cfg.masterBaseUrl}${targetPath}${parsed.search}`
  try {
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers: buildForwardHeaders(req, cfg.containerToken),
      body: req.method === 'GET' ? undefined : (req as unknown as BodyInit),
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
        code: 'MARKETPLACE_RELAY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    })
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}
