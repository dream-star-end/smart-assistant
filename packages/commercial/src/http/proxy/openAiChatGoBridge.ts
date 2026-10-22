import { randomUUID } from 'node:crypto'

import {
  type GoBridgeOptions,
  WebSearchError,
  isWebSearchServerTool,
  webSearchResponse,
  webSearchToolSpec,
} from './webSearchServerTool.js'

/**
 * OCV5-425 phase 2: Anthropic Messages ↔ OpenAI chat completions for the OpenCode Go models that
 * only answer on /chat/completions (GLM, Kimi K2.x, MiMo, LongCat, Hy, Step). Same shape as
 * geminiGoBridge: convert the request, stream the answer back as Anthropic SSE, and map usage so
 * the proxy meters it. Reasoning is billed (completion_tokens include it) but not surfaced as
 * Anthropic thinking: there is no signature to give it.
 *
 * Server-side web search is not offered by the upstream. The official Claude Code WebSearch side
 * request is fulfilled by the platform search proxies (see webSearchServerTool.ts); a mixed
 * request keeps only its function tools so it reaches the model instead of failing with 400.
 */

export type Obj = Record<string, unknown>
export const OPENAI_CHAT_GO_ENDPOINT = 'https://opencode.ai/inference/go/v1/chat/completions'
const TOOL_PREFIX = 'toolu_oc_'
const MAX_EVENT = 2 * 1024 * 1024
/** Requests ask for at most this many output tokens (CCB may send 64K; Go models cap lower). */
export const OPENAI_CHAT_GO_MAX_TOKENS = 32_000

export function obj(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected object')
  return v as Obj
}

export function blocks(v: unknown): Obj[] {
  if (typeof v === 'string') return v ? [{ type: 'text', text: v }] : []
  if (!Array.isArray(v)) throw new Error('expected content blocks')
  return v.map(obj)
}

/** OpenAI call ids → Anthropic tool_use ids (`^[A-Za-z0-9_-]+$`), reversibly. */
export function encodeChatToolId(id: string): string {
  return `${TOOL_PREFIX}${Buffer.from(id, 'utf8').toString('base64url')}`
}

export function decodeChatToolId(id: string): string {
  if (!id.startsWith(TOOL_PREFIX)) return id
  const decoded = Buffer.from(id.slice(TOOL_PREFIX.length), 'base64url').toString('utf8')
  if (!decoded) throw new Error('invalid OpenCode Go tool id')
  return decoded
}

export function systemTexts(v: unknown): string[] {
  return blocks(v).map((b) => {
    if (b.type !== 'text' || typeof b.text !== 'string')
      throw new Error('OpenCode Go supports text system prompts only')
    return b.text
  })
}

export function webSearchResultText(content: unknown): string {
  if (!Array.isArray(content)) return 'Web search failed.'
  const lines = content
    .map(obj)
    .map((r, i) => `${i + 1}. ${String(r.title ?? '')} — ${String(r.url ?? '')}`)
  return lines.length
    ? `Web search results:\n${lines.join('\n')}`
    : 'Web search returned no results.'
}

export function imageUrlFromAnthropic(block: Obj): string {
  if (block.type !== 'image') throw new Error('expected an image block')
  const source = obj(block.source)
  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return `data:${source.media_type};base64,${source.data}`
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url) return source.url
  throw new Error('invalid OpenCode Go image source')
}

export type GoContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }

export function toolResultParts(b: Obj): { text: string; parts: GoContentPart[] } {
  if (b.content === undefined) return { text: '', parts: [] }
  const parts: GoContentPart[] = []
  for (const c of blocks(b.content)) {
    if (c.type === 'text') {
      if (typeof c.text !== 'string') throw new Error('invalid OpenCode Go text')
      parts.push({ type: 'text', text: c.text })
    } else if (c.type === 'image') {
      parts.push({ type: 'image', url: imageUrlFromAnthropic(c) })
    } else {
      throw new Error('OpenCode Go supports text and image tool results only')
    }
  }
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  if (b.is_error !== true) return { text, parts }
  let prefixed = false
  const errorParts = parts.map((p) => {
    if (!prefixed && p.type === 'text') {
      prefixed = true
      return { ...p, text: `Error: ${p.text}` }
    }
    return p
  })
  if (!prefixed) errorParts.unshift({ type: 'text', text: 'Error' })
  return { text: text ? `Error: ${text}` : 'Error', parts: errorParts }
}

export function toolResultContent(b: Obj): { text: string; images: string[] } {
  const result = toolResultParts(b)
  return {
    text: result.text,
    images: result.parts.filter((p) => p.type === 'image').map((p) => p.url),
  }
}

export function toolResultText(b: Obj): string {
  return toolResultContent(b).text
}

export function isServerTool(t: Obj): boolean {
  return t.input_schema === undefined && typeof t.type === 'string' && t.type !== 'custom'
}

/** Platform effort (already narrowed by the proxy) → OpenAI `reasoning_effort`. */
export function chatReasoningEffort(outputConfig: unknown): string | undefined {
  if (!outputConfig || typeof outputConfig !== 'object' || Array.isArray(outputConfig))
    return undefined
  const effort = (outputConfig as Obj).effort
  return typeof effort === 'string' ? effort : undefined
}

export function anthropicToOpenAIChat(body: Obj): Obj {
  if (typeof body.model !== 'string' || !body.model) throw new Error('OpenCode Go requires a model')
  if (!Array.isArray(body.messages)) throw new Error('OpenCode Go requires messages')
  const system: string[] = body.system === undefined ? [] : systemTexts(body.system)
  const messages: Obj[] = []
  const issued = new Set<string>()
  const pendingToolCalls = new Set<string>()
  const deferredUserMessages: Obj[] = []
  const flushDeferred = () => {
    if (pendingToolCalls.size === 0 && deferredUserMessages.length) {
      messages.push(...deferredUserMessages.splice(0))
    }
  }
  // OCV5-432: CCB sends platform context as role:"system" messages. Only the preamble (before
  // the first assistant message) folds into the leading system message; later ones (the
  // per-turn `<total_tokens>…`) stay in place so the prompt-cache prefix never changes.
  let afterAssistant = false
  for (const raw of body.messages) {
    const m = obj(raw)
    if (m.role === 'system') {
      if (!afterAssistant) system.push(...systemTexts(m.content))
      else {
        const texts = systemTexts(m.content)
        if (texts.length) messages.push({ role: 'system', content: texts.join('\n\n') })
      }
      continue
    }
    if (m.role === 'user') {
      const parts: Obj[] = []
      const toolImages: string[] = []
      for (const b of blocks(m.content)) {
        if (b.type === 'text') {
          if (typeof b.text !== 'string') throw new Error('invalid OpenCode Go text')
          if (b.text) parts.push({ type: 'text', text: b.text })
        } else if (b.type === 'image') {
          parts.push({ type: 'image_url', image_url: { url: imageUrlFromAnthropic(b) } })
        } else if (b.type === 'tool_result') {
          if (typeof b.tool_use_id !== 'string' || !issued.has(b.tool_use_id))
            throw new Error('OpenCode Go tool result has no matching tool call')
          pendingToolCalls.delete(b.tool_use_id)
          const result = toolResultContent(b)
          messages.push({
            role: 'tool',
            tool_call_id: decodeChatToolId(b.tool_use_id),
            content: result.text || (result.images.length ? 'Tool returned an image.' : ''),
          })
          toolImages.push(...result.images)
        } else throw new Error(`unsupported OpenCode Go user block: ${String(b.type)}`)
      }
      const userMessage: Obj | null = parts.length
        ? {
            role: 'user',
            content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
          }
        : null
      // Chat tool messages cannot carry images; append a user message the model can see.
      const imageMessage: Obj | null = toolImages.length
        ? {
            role: 'user',
            content: toolImages.map((url) => ({ type: 'image_url', image_url: { url } })),
          }
        : null
      flushDeferred()
      for (const msg of [userMessage, imageMessage]) {
        if (!msg) continue
        if (pendingToolCalls.size) deferredUserMessages.push(msg)
        else messages.push(msg)
      }
      continue
    }
    if (m.role !== 'assistant') throw new Error('unsupported OpenCode Go message role')
    afterAssistant = true
    const texts: string[] = []
    const calls: Obj[] = []
    for (const b of blocks(m.content)) {
      if (b.type === 'text') {
        if (typeof b.text !== 'string') throw new Error('invalid OpenCode Go text')
        if (b.text) texts.push(b.text)
      } else if (b.type === 'tool_use') {
        if (typeof b.id !== 'string' || typeof b.name !== 'string')
          throw new Error('invalid OpenCode Go tool use')
        issued.add(b.id)
        pendingToolCalls.add(b.id)
        calls.push({
          id: decodeChatToolId(b.id),
          type: 'function',
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input === undefined ? {} : obj(b.input)),
          },
        })
      } else if (
        b.type === 'thinking' ||
        b.type === 'redacted_thinking' ||
        b.type === 'server_tool_use'
      ) {
        // Not replayable here: foreign thinking has no meaning upstream; a finished server
        // search is represented by its result block below.
      } else if (b.type === 'web_search_tool_result') {
        texts.push(webSearchResultText(b.content))
      } else throw new Error(`unsupported OpenCode Go assistant block: ${String(b.type)}`)
    }
    if (!texts.length && !calls.length) continue
    messages.push({
      role: 'assistant',
      content: texts.length ? texts.join('\n\n') : null,
      ...(calls.length && { tool_calls: calls }),
    })
  }
  flushDeferred()
  if (pendingToolCalls.size) throw new Error('OpenCode Go history has unanswered tool calls')
  if (!messages.length) throw new Error('OpenCode Go requires nonempty content')
  if (system.length) messages.unshift({ role: 'system', content: system.join('\n\n') })
  const out: Obj = {
    model: body.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.min(
      OPENAI_CHAT_GO_MAX_TOKENS,
      typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : OPENAI_CHAT_GO_MAX_TOKENS,
    ),
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
    out.stop = body.stop_sequences
  const effort = chatReasoningEffort(body.output_config)
  if (effort) out.reasoning_effort = effort
  const tools = Array.isArray(body.tools) ? body.tools.map(obj) : []
  const searchNames = new Set(
    tools.filter(isWebSearchServerTool).map((t) => (typeof t.name === 'string' ? t.name : '')),
  )
  const functionTools = tools.filter((t) => !isWebSearchServerTool(t))
  if (functionTools.some(isServerTool))
    throw new Error('OpenCode Go chat models do not offer server tools (web search)')
  if (functionTools.length) {
    out.tools = functionTools.map((t) => {
      if (typeof t.name !== 'string' || t.input_schema === undefined)
        throw new Error('unsupported OpenCode Go tool declaration')
      return {
        type: 'function',
        function: {
          name: t.name,
          ...(typeof t.description === 'string' && { description: t.description }),
          parameters: obj(t.input_schema),
        },
      }
    })
    const choice = body.tool_choice === undefined ? { type: 'auto' } : obj(body.tool_choice)
    // A force-search choice points at the stripped server tool; the remaining
    // function tools decide for themselves.
    const forcedSearch =
      choice.type === 'tool' && typeof choice.name === 'string' && searchNames.has(choice.name)
    out.tool_choice = forcedSearch
      ? 'auto'
      : choice.type === 'auto'
        ? 'auto'
        : choice.type === 'none'
          ? 'none'
          : choice.type === 'any'
            ? 'required'
            : choice.type === 'tool' && typeof choice.name === 'string'
              ? { type: 'function', function: { name: choice.name } }
              : (() => {
                  throw new Error('unsupported OpenCode Go tool choice')
                })()
  }
  return out
}

function count(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('invalid OpenCode Go token usage')
  return v
}

/**
 * OpenAI usage → Anthropic usage. prompt_tokens include cached reads (probed 2026-10-15: prompt
 * stays constant while cached grows). OpenCode Go publishes no cache-write price for these
 * models, so cache writes stay billed as input.
 */
export function chatUsage(v: unknown): Obj {
  const u = obj(v)
  const prompt = count(u.prompt_tokens)
  const details =
    u.prompt_tokens_details === undefined || u.prompt_tokens_details === null
      ? {}
      : obj(u.prompt_tokens_details)
  const cached = count(details.cached_tokens)
  if (cached > prompt) throw new Error('OpenCode Go cached usage exceeds input')
  return {
    input_tokens: prompt - cached,
    output_tokens: count(u.completion_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  }
}

function frame(type: string, fields: Obj): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
  )
}

/** SSE `data:` chunks; `[DONE]` ends the stream. An unfinished stream is never successful. */
async function* chatChunks(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Obj> {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  function* parse(raw: string): Generator<Obj> {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      if (data === '[DONE]') {
        done = true
        return
      }
      yield obj(JSON.parse(data))
    }
  }
  try {
    while (!done) {
      const { value, done: eof } = await reader.read()
      buffer += eof ? decoder.decode() : decoder.decode(value, { stream: true })
      let match: RegExpMatchArray | null
      while (!done && (match = buffer.match(/\r?\n\r?\n/))) {
        const index = match.index as number
        if (index > MAX_EVENT) throw new Error('OpenCode Go SSE event exceeds budget')
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + match[0].length)
        yield* parse(raw)
      }
      if (buffer.length > MAX_EVENT) throw new Error('OpenCode Go SSE event exceeds budget')
      if (eof) {
        if (!done && buffer.trim()) yield* parse(buffer)
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

interface PendingCall {
  id: string
  name: string
  args: string
}

export async function* chatToAnthropicEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  model: string,
): AsyncGenerator<Uint8Array> {
  let usage: Obj | undefined
  let finish: string | undefined
  let index = 0
  let openText = false
  let hasText = false
  let started = false
  const calls = new Map<number, PendingCall>()
  const messageId = `msg_oc_${randomUUID().replaceAll('-', '')}`
  try {
    for await (const chunk of chatChunks(reader)) {
      if (chunk.error !== undefined) throw new Error('OpenCode Go returned an error event')
      if (chunk.usage !== undefined && chunk.usage !== null) usage = chatUsage(chunk.usage)
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
              input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 0,
            },
          },
        })
      }
      const choices = chunk.choices === undefined ? [] : chunk.choices
      if (!Array.isArray(choices) || choices.length > 1)
        throw new Error('invalid OpenCode Go choices')
      for (const rawChoice of choices) {
        const choice = obj(rawChoice)
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
        const delta = choice.delta === undefined || choice.delta === null ? {} : obj(choice.delta)
        // A refusal is the model's answer: stream it as text like content.
        for (const piece of [delta.content, delta.refusal]) {
          if (typeof piece !== 'string' || !piece) continue
          if (!openText) {
            yield frame('content_block_start', { index, content_block: { type: 'text', text: '' } })
            openText = true
          }
          yield frame('content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
          hasText = true
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
          if (!Array.isArray(delta.tool_calls)) throw new Error('invalid OpenCode Go tool calls')
          for (const rawCall of delta.tool_calls) {
            const call = obj(rawCall)
            const at = typeof call.index === 'number' ? call.index : 0
            const pending = calls.get(at) ?? { id: '', name: '', args: '' }
            if (typeof call.id === 'string' && call.id) pending.id = call.id
            const fn =
              call.function === undefined || call.function === null ? {} : obj(call.function)
            if (typeof fn.name === 'string' && fn.name && !pending.name) pending.name = fn.name
            if (typeof fn.arguments === 'string') pending.args += fn.arguments
            calls.set(at, pending)
          }
        }
      }
    }
    const complete = finish === 'stop' || finish === 'length' || finish === 'tool_calls'
    if (!started || !usage || !complete || (!hasText && !calls.size))
      throw new Error('OpenCode Go stream ended without a successful complete response')
    if (openText) {
      yield frame('content_block_stop', { index })
      index++
    }
    for (const at of [...calls.keys()].sort((a, b) => a - b)) {
      const call = calls.get(at) as PendingCall
      if (!call.id || !call.name) throw new Error('OpenCode Go tool call without id or name')
      const input = call.args.trim() ? JSON.parse(call.args) : {}
      obj(input)
      yield frame('content_block_start', {
        index,
        content_block: {
          type: 'tool_use',
          id: encodeChatToolId(call.id),
          name: call.name,
          input: {},
        },
      })
      yield frame('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      })
      yield frame('content_block_stop', { index })
      index++
    }
    yield frame('message_delta', {
      delta: {
        stop_reason: finish === 'length' ? 'max_tokens' : calls.size ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage,
    })
    yield frame('message_stop', {})
  } catch (error) {
    // Same rule as geminiGoBridge: emit the observed usage once before failing the stream.
    if (started && usage) yield frame('message_delta', { delta: {}, usage })
    throw error
  }
}

export function createOpenAIChatGoFetch(
  fetchImpl: typeof fetch,
  options?: GoBridgeOptions,
): typeof fetch {
  return async (_input, init) => {
    let body: Obj
    let model: string
    try {
      if (typeof init?.body !== 'string') throw new Error('OpenCode Go bridge requires a JSON body')
      const anthropic = obj(JSON.parse(init.body))
      if (typeof anthropic.model !== 'string' || !anthropic.model)
        throw new Error('OpenCode Go requires a model')
      const search = webSearchToolSpec(anthropic)
      if (search) {
        options?.onLocalFulfillment?.()
        return webSearchResponse({
          model: anthropic.model,
          spec: search,
          // No executor = this route has no platform search. Say so explicitly
          // instead of spending a model call whose answer the WebSearch adapter
          // would discard.
          search:
            options?.webSearch ??
            (async () => {
              throw new WebSearchError('unavailable', 'web search is not configured for this route')
            }),
        })
      }
      body = anthropicToOpenAIChat(anthropic)
      model = body.model as string
    } catch (error) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: error instanceof Error ? error.message : 'invalid OpenCode Go request',
          },
        }),
        { status: 400 },
      )
    }
    const headers = new Headers(init?.headers)
    const key = headers.get('x-api-key')
    if (!key) throw new Error('OpenCode Go bridge is missing the OpenCode Go key')
    headers.delete('x-api-key')
    headers.delete('anthropic-version')
    headers.delete('anthropic-beta')
    headers.set('authorization', `Bearer ${key}`)
    headers.set('content-type', 'application/json')
    headers.set('user-agent', 'OpenClaude/5 OpenCodeGoChat')
    const raw = await fetchImpl(OPENAI_CHAT_GO_ENDPOINT, {
      ...init,
      headers,
      body: JSON.stringify(body),
    })
    if (!raw.ok) {
      let message = 'OpenCode Go upstream request failed'
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
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: raw.status === 400 ? 'invalid_request_error' : 'api_error', message },
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
    if (!raw.body) throw new Error('OpenCode Go returned no stream body')
    const reader = raw.body.getReader()
    const events = chatToAnthropicEvents(reader, model)
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
