/** OpenCode Go's Google-only model, behind the existing billed Anthropic proxy.
 * No process-local signature cache: opaque tool IDs carry replay metadata.
 */
import { randomUUID } from 'node:crypto'

export const GEMINI_GO_MODEL = 'gemini-4-argon-contributor'
export const GEMINI_GO_ENDPOINT = `https://opencode.ai/inference/go/v1/models/${GEMINI_GO_MODEL}:streamGenerateContent?alt=sse`
const TOOL_PREFIX = 'toolu_g4_'
const MAX_ENVELOPE = 128 * 1024
const MAX_EVENT = 2 * 1024 * 1024
type Obj = Record<string, unknown>
function obj(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('invalid Gemini bridge object')
  return v as Obj
}
function blocks(v: unknown): Obj[] {
  if (typeof v === 'string') return [{ type: 'text', text: v }]
  if (!Array.isArray(v)) throw new Error('invalid Gemini bridge content')
  return v.map(obj)
}

export function encodeGeminiToolId(call: Obj, signature?: unknown): string {
  if (
    (call.id !== undefined && typeof call.id !== 'string') ||
    (signature !== undefined && typeof signature !== 'string')
  )
    throw new Error('invalid Gemini tool signature or id')
  const envelope = JSON.stringify({ nonce: randomUUID(), id: call.id, signature })
  if (envelope.length > MAX_ENVELOPE) throw new Error('Gemini tool signature exceeds replay budget')
  return TOOL_PREFIX + Buffer.from(envelope).toString('base64url')
}
export function decodeGeminiToolId(id: string): Obj {
  if (!id.startsWith(TOOL_PREFIX) || id.length > MAX_ENVELOPE * 2) {
    throw new Error(
      'Gemini cannot replay tool history from another model; start a new conversation',
    )
  }
  const e = obj(JSON.parse(Buffer.from(id.slice(TOOL_PREFIX.length), 'base64url').toString()))
  if (
    typeof e.nonce !== 'string' ||
    (e.id !== undefined && typeof e.id !== 'string') ||
    (e.signature !== undefined && typeof e.signature !== 'string')
  )
    throw new Error('invalid Gemini tool replay envelope')
  return e
}

function systemParts(v: unknown): Obj[] {
  return blocks(v).map((b) => {
    if (b.type !== 'text' || typeof b.text !== 'string')
      throw new Error('unsupported Gemini system content')
    return { text: b.text }
  })
}

/** Prior web_search_tool_result → plain text the model can cite in follow-ups
 * (Codex r1 P1: the bridge must accept its own search output as history). */
function webSearchResultText(content: unknown): string {
  if (!Array.isArray(content)) {
    const code =
      content && typeof content === 'object' && typeof (content as Obj).error_code === 'string'
        ? (content as Obj).error_code
        : 'unknown'
    return `[Web search failed: ${String(code)}]`
  }
  const lines = content
    .filter((r): r is Obj => !!r && typeof r === 'object' && typeof (r as Obj).url === 'string')
    .map((r) => `- ${typeof r.title === 'string' && r.title ? r.title : r.url}: ${r.url}`)
  return lines.length
    ? `[Web search results]\n${lines.join('\n')}`
    : '[Web search returned no results]'
}

/**
 * Platform effort → Gemini thinkingLevel (OCV5-425). The proxy has already narrowed
 * `output_config` to `{effort}` from the spec's model-scoped list (low/medium/high; upstream
 * rejects MINIMAL). No effort keeps the previous fixed LOW.
 */
export function geminiThinkingLevel(outputConfig: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
  const effort =
    outputConfig !== null && typeof outputConfig === 'object' && !Array.isArray(outputConfig)
      ? (outputConfig as Obj).effort
      : undefined
  return effort === 'high' ? 'HIGH' : effort === 'medium' ? 'MEDIUM' : 'LOW'
}

export function anthropicToGemini(body: Obj): Obj {
  const contents: Obj[] = []
  const calls = new Map<string, { name: string; nativeId?: string }>()
  // CCB sends platform context as role:"system" messages inside `messages`
  // (OCV5-423 live 400: every real platform turn carried one). Google has no
  // system role in contents, so they join systemInstruction in order, after
  // the top-level system — the same folding boxMessagesMapper applies.
  const inlineSystem: Obj[] = []
  if (!Array.isArray(body.messages)) throw new Error('Gemini requires messages')
  for (const raw of body.messages) {
    const m = obj(raw)
    if (m.role === 'system') {
      inlineSystem.push(...systemParts(m.content))
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant')
      throw new Error('unsupported Gemini message role')
    const parts: Obj[] = []
    for (const b of blocks(m.content)) {
      if (b.type === 'text') {
        if (typeof b.text !== 'string') throw new Error('invalid Gemini text')
        if (b.text) parts.push({ text: b.text })
      } else if (b.type === 'tool_use' && m.role === 'assistant') {
        if (typeof b.id !== 'string' || typeof b.name !== 'string')
          throw new Error('invalid Gemini tool use')
        const e = decodeGeminiToolId(b.id)
        const nativeId = e.id as string | undefined
        calls.set(b.id, { name: b.name, nativeId })
        parts.push({
          functionCall: { name: b.name, args: obj(b.input), ...(nativeId && { id: nativeId }) },
          ...(e.signature !== undefined && { thoughtSignature: e.signature }),
        })
      } else if (b.type === 'tool_result' && m.role === 'user') {
        const call = typeof b.tool_use_id === 'string' ? calls.get(b.tool_use_id) : undefined
        if (!call) throw new Error('Gemini tool result has no matching tool call')
        const text =
          b.content === undefined
            ? ''
            : blocks(b.content)
                .map((c) => {
                  if (c.type !== 'text' || typeof c.text !== 'string')
                    throw new Error('Gemini Go supports text tool results only')
                  return c.text
                })
                .join('\n')
        parts.push({
          functionResponse: {
            name: call.name,
            ...(call.nativeId && { id: call.nativeId }),
            response: b.is_error ? { error: text } : { output: text },
          },
        })
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        // Foreign thought blocks are not Google signatures. They are not tools.
      } else if (b.type === 'server_tool_use' && m.role === 'assistant') {
        // A finished grounded search (ours or replayed): Google re-runs search
        // only when asked; the results block below carries what was found.
      } else if (b.type === 'web_search_tool_result' && m.role === 'assistant') {
        parts.push({ text: webSearchResultText(b.content) })
      } else throw new Error(`unsupported Gemini Go block: ${String(b.type)}`)
    }
    if (!parts.length) continue
    const role = m.role === 'assistant' ? 'model' : 'user'
    const previous = contents.at(-1)
    if (previous?.role === role) (previous.parts as Obj[]).push(...parts)
    else contents.push({ role, parts })
  }
  if (!contents.length) throw new Error('Gemini requires nonempty content')
  const generationConfig: Obj = {
    maxOutputTokens: Math.min(65536, typeof body.max_tokens === 'number' ? body.max_tokens : 32000),
    thinkingConfig: { thinkingLevel: geminiThinkingLevel(body.output_config) },
  }
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p
  if (Array.isArray(body.stop_sequences)) generationConfig.stopSequences = body.stop_sequences
  const result: Obj = { contents, generationConfig }
  const system = [...(body.system === undefined ? [] : systemParts(body.system)), ...inlineSystem]
  if (system.length) result.systemInstruction = { parts: system }
  const search = webSearchSpec(body)
  const functionTools = Array.isArray(body.tools)
    ? body.tools.map(obj).filter((t) => !isWebSearchServerTool(t))
    : []
  if (search) result.tools = [{ googleSearch: {} }]
  if (functionTools.length) {
    ;(result.tools = (result.tools as Obj[] | undefined) ?? []).push({
      functionDeclarations: functionTools.map((t) => {
        if (typeof t.name !== 'string' || t.input_schema === undefined)
          throw new Error('unsupported Gemini tool declaration')
        return {
          name: t.name,
          ...(typeof t.description === 'string' && { description: t.description }),
          parametersJsonSchema: obj(t.input_schema),
        }
      }),
    })
    const choice = body.tool_choice === undefined ? { type: 'auto' } : obj(body.tool_choice)
    const mode =
      choice.type === 'auto'
        ? 'AUTO'
        : choice.type === 'none'
          ? 'NONE'
          : choice.type === 'any' || choice.type === 'tool'
            ? 'ANY'
            : null
    if (!mode) throw new Error('unsupported Gemini tool choice')
    // A forced server web_search is satisfied by Google grounding, not a function call.
    if (!(search && choice.type === 'tool' && choice.name === search.name)) {
      result.toolConfig = {
        functionCallingConfig: {
          mode,
          ...(choice.type === 'tool' && { allowedFunctionNames: [choice.name] }),
        },
      }
    }
  }
  return result
}

/**
 * Anthropic server-side web search (`{type:"web_search_YYYYMMDD", name}`): the
 * official Claude Code WebSearch tool sends it in a side request. Gemini Go has
 * no such server tool, so it maps to Google Search grounding and the grounding
 * metadata is returned as server_tool_use + web_search_tool_result blocks.
 */
export interface GeminiWebSearchSpec {
  name: string
  allowedDomains: string[]
  blockedDomains: string[]
}
function isWebSearchServerTool(t: Obj): boolean {
  return typeof t.type === 'string' && t.type.startsWith('web_search_')
}
function domains(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((d): d is string => typeof d === 'string' && d.length > 0)
        .map((d) => d.toLowerCase())
    : []
}
export function webSearchSpec(body: Obj): GeminiWebSearchSpec | null {
  if (!Array.isArray(body.tools)) return null
  const tool = body.tools.map(obj).find(isWebSearchServerTool)
  if (!tool) return null
  return {
    name: typeof tool.name === 'string' ? tool.name : 'web_search',
    allowedDomains: domains(tool.allowed_domains),
    blockedDomains: domains(tool.blocked_domains),
  }
}
const GROUNDING_REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/'
const REDIRECT_TIMEOUT_MS = 3000
const MAX_SEARCH_RESULTS = 20
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}
/** Google grounding chunks → web_search_result items. Redirect links are
 * resolved to the real URL when possible (short timeout, never fatal). */
export async function groundingResults(
  grounding: Obj,
  spec: GeminiWebSearchSpec,
  fetchImpl: typeof fetch,
): Promise<Obj[]> {
  const chunks = Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []
  const webs = chunks
    .map((c) => (c && typeof c === 'object' ? (c as Obj).web : undefined))
    .filter((w): w is Obj => !!w && typeof w === 'object' && typeof (w as Obj).uri === 'string')
    .slice(0, MAX_SEARCH_RESULTS)
  const resolved = await Promise.all(
    webs.map(async (w) => {
      const uri = w.uri as string
      if (!uri.startsWith(GROUNDING_REDIRECT)) return uri
      try {
        const r = await fetchImpl(uri, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
        })
        const location = r.headers.get('location')
        return location && /^https?:\/\//.test(location) ? location : uri
      } catch {
        return uri
      }
    }),
  )
  const out: Obj[] = []
  webs.forEach((w, i) => {
    const url = resolved[i] as string
    const title = typeof w.title === 'string' && w.title ? w.title : url
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      /* keep empty */
    }
    // An unresolved redirect hides the host; Google puts the site domain in title.
    const site = host && !url.startsWith(GROUNDING_REDIRECT) ? host : title.toLowerCase()
    if (spec.allowedDomains.length && !spec.allowedDomains.some((d) => hostMatches(site, d))) return
    if (spec.blockedDomains.some((d) => hostMatches(site, d))) return
    out.push({ type: 'web_search_result', title, url, encrypted_content: '', page_age: null })
  })
  return out
}

function count(v: unknown): number {
  if (v === undefined) return 0
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('invalid Gemini token usage')
  return v
}
export function geminiUsage(v: unknown): Obj {
  const u = obj(v)
  const cached = count(u.cachedContentTokenCount)
  const prompt = count(u.promptTokenCount)
  if (cached > prompt) throw new Error('Gemini cached usage exceeds input')
  return {
    input_tokens: prompt - cached,
    output_tokens: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  }
}
function frame(type: string, fields: Obj): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
  )
}

/** Events are parsed before conversion; an unfinished stream is never successful. */
async function* googleEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Obj> {
  const decoder = new TextDecoder()
  let buffer = ''
  function parse(raw: string): Obj | null {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    return data ? obj(JSON.parse(data)) : null
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let match: RegExpMatchArray | null
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const index = match.index as number
        if (index > MAX_EVENT) throw new Error('Gemini SSE event exceeds budget')
        const event = parse(buffer.slice(0, index))
        buffer = buffer.slice(index + match[0].length)
        if (event) yield event
      }
      if (buffer.length > MAX_EVENT) throw new Error('Gemini SSE event exceeds budget')
      if (done) {
        if (buffer.trim()) {
          const event = parse(buffer)
          if (event) yield event
        }
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function* anthropicEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  model: string,
  search: { spec: GeminiWebSearchSpec; fetchImpl: typeof fetch } | null = null,
): AsyncGenerator<Uint8Array> {
  let grounding: Obj | undefined
  let usage: Obj | undefined
  let finish: string | undefined
  let index = 0
  let hasTool = false
  let openText = false
  let hasContent = false
  let started = false
  const messageId = `msg_g4_${randomUUID().replaceAll('-', '')}`
  try {
    for await (const e of googleEvents(reader)) {
      if (e.usageMetadata !== undefined) usage = geminiUsage(e.usageMetadata)
      if (!started) {
        started = true
        yield frame('message_start', {
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              ...(usage ?? {
                input_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              }),
              output_tokens: 0,
            },
          },
        })
      }
      if (e.error) throw new Error('Gemini returned an error event')
      if (e.promptFeedback && obj(e.promptFeedback).blockReason)
        throw new Error('Gemini blocked the prompt')
      const candidates = e.candidates === undefined ? [] : e.candidates
      if (!Array.isArray(candidates) || candidates.length > 1)
        throw new Error('invalid Gemini candidates')
      for (const raw of candidates) {
        const c = obj(raw)
        if (search && c.groundingMetadata !== undefined) grounding = obj(c.groundingMetadata)
        if (typeof c.finishReason === 'string') finish = c.finishReason
        const content = c.content === undefined ? undefined : obj(c.content)
        if (content?.parts !== undefined && !Array.isArray(content.parts))
          throw new Error('invalid Gemini parts')
        for (const rawPart of (content?.parts as unknown[] | undefined) ?? []) {
          const p = obj(rawPart)
          // Visible thoughts are not requested. Count any thought usage but do not
          // synthesize an Anthropic thinking signature from Google text metadata.
          if (p.thought === true) continue
          if (p.functionCall !== undefined) {
            if (openText) {
              yield frame('content_block_stop', { index })
              index++
              openText = false
            }
            const call = obj(p.functionCall)
            if (typeof call.name !== 'string') throw new Error('invalid Gemini function name')
            const args = call.args === undefined ? {} : obj(call.args)
            const id = encodeGeminiToolId(call, p.thoughtSignature)
            yield frame('content_block_start', {
              index,
              content_block: { type: 'tool_use', id, name: call.name, input: {} },
            })
            yield frame('content_block_delta', {
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
            })
            yield frame('content_block_stop', { index })
            index++
            hasTool = true
            hasContent = true
          } else if (typeof p.text === 'string') {
            // Google may attach a final signature to an empty text part.
            if (!p.text) continue
            if (!openText) {
              yield frame('content_block_start', {
                index,
                content_block: { type: 'text', text: '' },
              })
              openText = true
            }
            yield frame('content_block_delta', {
              index,
              delta: { type: 'text_delta', text: p.text },
            })
            hasContent = true
          } else if (Object.keys(p).some((k) => k !== 'thoughtSignature'))
            throw new Error('unsupported Gemini response part')
        }
      }
      // CCB settles each message_delta, so success must emit exactly ONE.
      // On a broken stream the catch below emits the latest partial usage once.
    }
    if (search && grounding) {
      const queries = Array.isArray(grounding.webSearchQueries)
        ? grounding.webSearchQueries.filter((q): q is string => typeof q === 'string' && !!q)
        : []
      if (queries.length) {
        if (openText) {
          yield frame('content_block_stop', { index })
          index++
          openText = false
        }
        const results = await groundingResults(grounding, search.spec, search.fetchImpl)
        const id = `srvtoolu_g4_${randomUUID().replaceAll('-', '')}`
        yield frame('content_block_start', {
          index,
          content_block: { type: 'server_tool_use', id, name: search.spec.name, input: {} },
        })
        yield frame('content_block_delta', {
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ query: queries.join(' | ') }),
          },
        })
        yield frame('content_block_stop', { index })
        index++
        yield frame('content_block_start', {
          index,
          content_block: { type: 'web_search_tool_result', tool_use_id: id, content: results },
        })
        yield frame('content_block_stop', { index })
        index++
        hasContent = true
      }
    }
    if (!hasContent || !usage || (finish !== 'STOP' && finish !== 'MAX_TOKENS')) {
      throw new Error('Gemini stream ended without a successful complete response')
    }
    if (openText) yield frame('content_block_stop', { index })
    yield frame('message_delta', {
      delta: {
        stop_reason: finish === 'MAX_TOKENS' ? 'max_tokens' : hasTool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage,
    })
    yield frame('message_stop', {})
  } catch (error) {
    // Yield the observed usage BEFORE throwing on a later pull. error() in the
    // same pull as enqueue() discards queued usage and breaks partial accounting.
    if (started && usage) yield frame('message_delta', { delta: {}, usage })
    throw error
  }
}

export function createGeminiGoFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (_input, init) => {
    let body: Obj
    let search: GeminiWebSearchSpec | null
    try {
      if (typeof init?.body !== 'string') throw new Error('Gemini bridge requires a JSON body')
      const anthropic = obj(JSON.parse(init.body))
      search = webSearchSpec(anthropic)
      body = anthropicToGemini(anthropic)
    } catch (error) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: error instanceof Error ? error.message : 'invalid Gemini request',
          },
        }),
        { status: 400 },
      )
    }
    const headers = new Headers(init?.headers)
    const key = headers.get('x-api-key')
    if (!key) throw new Error('Gemini bridge is missing the OpenCode Go key')
    headers.delete('x-api-key')
    headers.delete('anthropic-version')
    headers.delete('anthropic-beta')
    headers.set('authorization', `Bearer ${key}`)
    headers.set('content-type', 'application/json')
    headers.set('user-agent', 'OpenClaude/5 GeminiGo')
    const raw = await fetchImpl(GEMINI_GO_ENDPOINT, {
      ...init,
      headers,
      body: JSON.stringify(body),
    })
    if (!raw.ok) {
      let message = 'Gemini Go upstream request failed'
      try {
        const data = obj(await raw.json())
        if (data.error) {
          const detail = obj(data.error)
          if (typeof detail.message === 'string')
            message = detail.message.replaceAll(key, '[redacted]').slice(0, 2000)
        }
      } catch {
        /* do not echo arbitrary upstream HTML or credentials */
      }
      const invalid = raw.status === 400
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: invalid ? 'invalid_request_error' : 'api_error', message },
        }),
        {
          status: raw.status,
          headers: {
            'content-type': 'application/json',
            ...(raw.headers.get('retry-after') && {
              'retry-after': raw.headers.get('retry-after') as string,
            }),
          },
        },
      )
    }
    if (!raw.body) throw new Error('Gemini returned no stream body')
    const reader = raw.body.getReader()
    const events = anthropicEvents(
      reader,
      GEMINI_GO_MODEL,
      search ? { spec: search, fetchImpl } : null,
    )
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
        async cancel(reason) {
          await reader.cancel(reason).catch(() => {})
          await events.return(undefined).catch(() => {})
          try {
            reader.releaseLock()
          } catch {
            /* generator already released it */
          }
        },
      },
      { highWaterMark: 0 },
    )
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
}
