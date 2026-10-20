/**
 * Anthropic server-side web search for the OpenCode Go chat/responses bridges.
 *
 * The official Claude Code WebSearch tool has no local adapter. It sends a side
 * `/v1/messages` request carrying a server tool
 * `{"type":"web_search_20250305","name":"web_search",…}` and expects the answer
 * to contain `server_tool_use` + `web_search_tool_result` blocks. Go upstreams
 * have no such server tool, so the bridge fulfills the side request with the
 * platform search proxies (MiniMax → Grok, keys stay on the master) and speaks
 * the Anthropic protocol back to the client.
 *
 * Requests that mix the server tool with function tools are not search side
 * requests: the server tool is stripped and the normal model call proceeds, so
 * they no longer fail with 400. Only the dedicated side-request shape (the
 * server tool alone plus the "Perform a web search for the query: …" prompt) is
 * answered locally.
 */
import { randomUUID } from 'node:crypto'

export type Obj = Record<string, unknown>

export interface WebSearchToolSpec {
  name: string
  query: string
  allowedDomains: string[]
  blockedDomains: string[]
}

export interface WebSearchHit {
  title: string
  url: string
  pageAge?: string | null
}

/** Per-request identity the platform search proxies authenticate with. */
export interface WebSearchAuthContext {
  authorization?: string
  hostUuid: string
  boundIp: string
  signal?: AbortSignal
}

export type WebSearchExecutor = (
  input: WebSearchToolSpec,
  ctx: WebSearchAuthContext,
) => Promise<WebSearchHit[]>

/** Executor already bound to one incoming request; the signal comes from the proxy. */
export type BoundWebSearch = (
  input: WebSearchToolSpec,
  signal?: AbortSignal,
) => Promise<WebSearchHit[]>

export interface GoBridgeOptions {
  webSearch?: BoundWebSearch
  /**
   * Set when the bridge answers from the platform search proxy without calling
   * the model upstream. The proxy must not report provider/key health from the
   * synthetic 200.
   */
  onLocalFulfillment?: () => void
}

export type WebSearchErrorCode =
  | 'invalid_tool_input'
  | 'unavailable'
  | 'max_uses_exceeded'
  | 'too_many_requests'
  | 'query_too_long'

export class WebSearchError extends Error {
  constructor(
    readonly code: WebSearchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WebSearchError'
  }
}

/** Anthropic and the MiniMax proxy both cap the query at 1000 characters. */
export const MAX_WEB_SEARCH_QUERY_CHARS = 1000
const MAX_ERROR_MESSAGE_CHARS = 200

function obj(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected object')
  return v as Obj
}

export function isWebSearchServerTool(t: Obj): boolean {
  return typeof t.type === 'string' && t.type.startsWith('web_search_')
}

function domains(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((d): d is string => typeof d === 'string' && d.length > 0)
        .map((d) => d.toLowerCase())
    : []
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (!Array.isArray(v)) return ''
  return v
    .filter((b): b is Obj => !!b && typeof b === 'object' && !Array.isArray(b))
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function lastUserText(body: Obj): string | null {
  if (!Array.isArray(body.messages)) return null
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const raw = body.messages[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const m = raw as Obj
    if (m.role !== 'user') continue
    const text = textOf(m.content).trim()
    if (text) return text
  }
  return null
}

/**
 * Query carried by the official WebSearch side request. The adapter prompt is
 * `Perform a web search for the query: <q>`; the dedicated system prompt is a
 * fallback for wording drift, so an arbitrary conversation is never searched.
 */
export function webSearchQuery(body: Obj): string | null {
  const text = lastUserText(body)
  if (!text) return null
  const match = /^perform a web search for the query:\s*([\s\S]+)$/i.exec(text)
  if (match) return match[1]!.trim()
  const system = textOf(body.system)
  return /performing a web search tool use/i.test(system) ? text : null
}

/**
 * Non-null only for the dedicated side request: exactly one web_search server
 * tool, no function tools, and a recognizable query. Mixed requests return null
 * and their conversion strips the server tool before calling the model.
 */
export function webSearchToolSpec(body: Obj): WebSearchToolSpec | null {
  if (!Array.isArray(body.tools)) return null
  const tools = body.tools.map(obj)
  const search = tools.filter(isWebSearchServerTool)
  if (search.length !== 1) return null
  if (tools.some((t) => !isWebSearchServerTool(t))) return null
  const query = webSearchQuery(body)
  if (!query) return null
  const tool = search[0]!
  return {
    name: typeof tool.name === 'string' && tool.name ? tool.name : 'web_search',
    query,
    allowedDomains: domains(tool.allowed_domains),
    blockedDomains: domains(tool.blocked_domains),
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** Anthropic allowed/blocked domains are host suffixes; unparsable URLs are dropped. */
export function filterWebSearchHits(
  hits: WebSearchHit[],
  spec: Pick<WebSearchToolSpec, 'allowedDomains' | 'blockedDomains'>,
): WebSearchHit[] {
  const out: WebSearchHit[] = []
  for (const hit of hits) {
    let parsed: URL
    try {
      parsed = new URL(hit.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    const host = parsed.hostname.toLowerCase()
    if (spec.allowedDomains.length && !spec.allowedDomains.some((d) => hostMatches(host, d)))
      continue
    if (spec.blockedDomains.some((d) => hostMatches(host, d))) continue
    out.push(hit)
  }
  return out
}

function frame(type: string, fields: Obj): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
  )
}

function zeroUsage(): Obj {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'web search failed'
  return (
    raw
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, MAX_ERROR_MESSAGE_CHARS) || 'web search failed'
  )
}

function errorBlock(error: unknown): Obj {
  const code = error instanceof WebSearchError ? error.code : 'unavailable'
  return {
    type: 'web_search_tool_result_error',
    error_code: code,
    error_message: errorMessage(error),
  }
}

/** Result block content: hits, or an explicit Anthropic error object. */
export async function webSearchResultContent(
  spec: WebSearchToolSpec,
  search: BoundWebSearch,
): Promise<Obj | Obj[]> {
  if (spec.query.length > MAX_WEB_SEARCH_QUERY_CHARS) {
    return errorBlock(
      new WebSearchError(
        'query_too_long',
        `web search query exceeds ${MAX_WEB_SEARCH_QUERY_CHARS} characters`,
      ),
    )
  }
  try {
    const hits = await search(spec)
    if (!Array.isArray(hits)) throw new Error('web search executor returned no hits array')
    return filterWebSearchHits(hits, spec).map((hit) => ({
      type: 'web_search_result',
      title: hit.title,
      url: hit.url,
      encrypted_content: '',
      page_age: hit.pageAge ?? null,
    }))
  } catch (error) {
    // Surface the failure as the protocol's error block instead of a 400 or an
    // empty result: the caller can tell a failed search from a search with no hits.
    return errorBlock(error)
  }
}

/**
 * Anthropic SSE for one fulfilled server-side search: message_start,
 * server_tool_use(query), web_search_tool_result(hits|error), message_delta.
 * No upstream model call is made, so usage is zero and nothing is charged.
 */
export async function* webSearchToAnthropicEvents(opts: {
  model: string
  spec: WebSearchToolSpec
  search: BoundWebSearch
}): AsyncGenerator<Uint8Array> {
  const messageId = `msg_ws_${randomUUID().replaceAll('-', '')}`
  const toolUseId = `srvtoolu_ws_${randomUUID().replaceAll('-', '')}`
  yield frame('message_start', {
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        ...zeroUsage(),
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
    },
  })
  yield frame('content_block_start', {
    index: 0,
    content_block: { type: 'server_tool_use', id: toolUseId, name: opts.spec.name, input: {} },
  })
  yield frame('content_block_delta', {
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: opts.spec.query }) },
  })
  yield frame('content_block_stop', { index: 0 })
  yield frame('content_block_start', {
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      content: await webSearchResultContent(opts.spec, opts.search),
    },
  })
  yield frame('content_block_stop', { index: 1 })
  yield frame('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      ...zeroUsage(),
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    },
  })
  yield frame('message_stop', {})
}

/** Wrap the generator in the same zero-buffer stream shape as the other bridges. */
export function webSearchResponse(opts: {
  model: string
  spec: WebSearchToolSpec
  search: BoundWebSearch
}): Response {
  const events = webSearchToAnthropicEvents(opts)
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await events.next()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel() {
        await events.return(undefined).catch(() => {})
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}
