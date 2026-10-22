/**
 * Egress-side executor for Anthropic server-side web search on the OpenCode Go
 * bridges.
 *
 * The platform search proxies already live on the master
 * (`/internal/v3/minimax-search`, then `/internal/v3/grok-search`) so the
 * subscription keys never leave it. The egress process forwards those paths for
 * containers; for a WebSearch side request it forwards the same way using the
 * caller's container bearer and the original container IP (the master control
 * listener trusts `x-v5-egress-peer-ip` only because the egress forwarder sets
 * it). Nothing is duplicated key-side.
 */

import { request as httpRequest } from 'node:http'

import { GROK_SEARCH_PATH, MINIMAX_SEARCH_PATH } from '@openclaude/protocol'

import {
  type WebSearchAuthContext,
  WebSearchError,
  type WebSearchExecutor,
  type WebSearchHit,
  type WebSearchToolSpec,
} from '../http/proxy/webSearchServerTool.js'
import { type Logger, rootLogger } from '../logging/logger.js'

/** MiniMax is the primary (same order as the CCB adapter); Grok is the fallback. */
export const MASTER_WEB_SEARCH_PATHS = [MINIMAX_SEARCH_PATH, GROK_SEARCH_PATH] as const
const ATTEMPT_TIMEOUT_MS = 12_000
const MAX_RESULTS = 10

export interface SearchHttpResponse {
  status: number
  text: string
}

export type SearchRequestFn = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
    timeoutMs: number
  },
) => Promise<SearchHttpResponse>

export interface MasterWebSearchDeps {
  /** master control listener, e.g. http://127.0.0.1:18894 */
  controlBaseUrl: string
  logger?: Logger
  requestFn?: SearchRequestFn
  timeoutMs?: number
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

/** Loopback HTTP, never through the global egress proxy. */
const defaultRequestFn: SearchRequestFn = (url, init) =>
  new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new Error('web search aborted'))
      return
    }
    const parsed = new URL(url)
    const req = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        method: init.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          ...init.headers,
          'content-length': Buffer.byteLength(init.body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)),
        )
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error('web search request timed out')))
    const onAbort = () => req.destroy(new Error('web search aborted'))
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort))
    req.on('error', reject)
    req.end(init.body)
  })

/** One proxy response → hits. Non-array `organic` is a protocol failure, [] is "no hits". */
export function hitsFromSearchResponse(text: string): WebSearchHit[] {
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new WebSearchError('unavailable', 'web search proxy returned invalid JSON')
  }
  if (!isObj(json) || !Array.isArray(json.organic))
    throw new WebSearchError('unavailable', 'web search proxy returned no organic results')
  const hits: WebSearchHit[] = []
  for (const raw of json.organic) {
    if (hits.length >= MAX_RESULTS) break
    if (!isObj(raw) || typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url)) continue
    hits.push({
      title: typeof raw.title === 'string' && raw.title ? raw.title : raw.url,
      url: raw.url,
      pageAge: typeof raw.date === 'string' && raw.date ? raw.date : null,
    })
  }
  return hits
}

function statusError(status: number, path: string): WebSearchError {
  if (status === 429)
    return new WebSearchError('too_many_requests', `web search rate limited (${path})`)
  if (status === 400)
    return new WebSearchError('invalid_tool_input', `web search rejected the query (${path})`)
  return new WebSearchError('unavailable', `web search proxy returned ${status} (${path})`)
}

export function makeMasterWebSearch(deps: MasterWebSearchDeps): WebSearchExecutor {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'egressWebSearch' })
  const requestFn = deps.requestFn ?? defaultRequestFn
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const base = deps.controlBaseUrl.replace(/\/+$/, '')

  return async (input: WebSearchToolSpec, ctx: WebSearchAuthContext) => {
    if (!ctx.authorization)
      throw new WebSearchError('unavailable', 'web search requires container authentication')
    let lastError: WebSearchError | null = null
    for (const path of MASTER_WEB_SEARCH_PATHS) {
      if (ctx.signal?.aborted) throw new WebSearchError('unavailable', 'web search aborted')
      try {
        const response = await requestFn(`${base}${path}`, {
          method: 'POST',
          headers: {
            authorization: ctx.authorization,
            accept: 'application/json',
            'content-type': 'application/json',
            // The master control listener uses this instead of the loopback
            // socket peer; only the egress forwarder is trusted to set it.
            'x-v5-egress-peer-ip': ctx.boundIp,
          },
          body: JSON.stringify({ q: input.query }),
          signal: ctx.signal,
          timeoutMs,
        })
        if (response.status !== 200) throw statusError(response.status, path)
        return hitsFromSearchResponse(response.text)
      } catch (error) {
        lastError =
          error instanceof WebSearchError
            ? error
            : new WebSearchError(
                'unavailable',
                error instanceof Error ? error.message : 'web search failed',
              )
        if (ctx.signal?.aborted) break
        log.warn('web_search_attempt_failed', { path, code: lastError.code })
      }
    }
    throw lastError ?? new WebSearchError('unavailable', 'web search failed')
  }
}
