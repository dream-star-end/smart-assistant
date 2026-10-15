import { randomUUID } from 'node:crypto'

import {
  type Obj,
  blocks,
  isServerTool,
  obj,
  systemTexts,
  toolResultText,
  webSearchResultText,
} from './openAiChatGoBridge.js'

/**
 * OCV5-425 phase 3: Anthropic Messages ↔ OpenAI Responses for the OpenCode Go models that only
 * answer on /responses (Grok 4.6/4.7, GPT-5.6/6 Luna, Muse Spark 1.2/1.3). Same contract as the
 * chat bridge: stateless (`store: false`, full history each call — probed 2026-10-15, tool loops
 * work without replaying reasoning items), text streamed live, function calls emitted as complete
 * tool_use blocks, usage mapped for the proxy meter. Reasoning (summaries and encrypted items) is
 * billed through output_tokens but not surfaced as Anthropic thinking.
 */

export const OPENAI_RESPONSES_GO_ENDPOINT = 'https://opencode.ai/inference/go/v1/responses'
const TOOL_PREFIX = 'toolu_or_'
const MAX_EVENT = 2 * 1024 * 1024
export const OPENAI_RESPONSES_GO_MAX_TOKENS = 32_000

export function encodeResponsesToolId(callId: string): string {
  return `${TOOL_PREFIX}${Buffer.from(callId, 'utf8').toString('base64url')}`
}

export function decodeResponsesToolId(id: string): string {
  if (!id.startsWith(TOOL_PREFIX)) return id
  const decoded = Buffer.from(id.slice(TOOL_PREFIX.length), 'base64url').toString('utf8')
  if (!decoded) throw new Error('invalid OpenCode Go tool id')
  return decoded
}

export function responsesReasoningEffort(outputConfig: unknown): string | undefined {
  if (!outputConfig || typeof outputConfig !== 'object' || Array.isArray(outputConfig))
    return undefined
  const effort = (outputConfig as Obj).effort
  return typeof effort === 'string' ? effort : undefined
}

export function anthropicToOpenAIResponses(body: Obj): Obj {
  if (typeof body.model !== 'string' || !body.model) throw new Error('OpenCode Go requires a model')
  if (!Array.isArray(body.messages)) throw new Error('OpenCode Go requires messages')
  const system: string[] = body.system === undefined ? [] : systemTexts(body.system)
  const input: Obj[] = []
  const issued = new Set<string>()
  for (const raw of body.messages) {
    const m = obj(raw)
    if (m.role === 'system') {
      system.push(...systemTexts(m.content))
      continue
    }
    if (m.role === 'user') {
      const texts: string[] = []
      for (const b of blocks(m.content)) {
        if (b.type === 'text') {
          if (typeof b.text !== 'string') throw new Error('invalid OpenCode Go text')
          if (b.text) texts.push(b.text)
        } else if (b.type === 'tool_result') {
          if (typeof b.tool_use_id !== 'string' || !issued.has(b.tool_use_id))
            throw new Error('OpenCode Go tool result has no matching tool call')
          input.push({
            type: 'function_call_output',
            call_id: decodeResponsesToolId(b.tool_use_id),
            output: toolResultText(b),
          })
        } else throw new Error(`unsupported OpenCode Go user block: ${String(b.type)}`)
      }
      if (texts.length) input.push({ role: 'user', content: texts.join('\n\n') })
      continue
    }
    if (m.role !== 'assistant') throw new Error('unsupported OpenCode Go message role')
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
        calls.push({
          type: 'function_call',
          call_id: decodeResponsesToolId(b.id),
          name: b.name,
          arguments: JSON.stringify(b.input === undefined ? {} : obj(b.input)),
        })
      } else if (
        b.type === 'thinking' ||
        b.type === 'redacted_thinking' ||
        b.type === 'server_tool_use'
      ) {
        // Not replayable upstream (see openAiChatGoBridge).
      } else if (b.type === 'web_search_tool_result') {
        texts.push(webSearchResultText(b.content))
      } else throw new Error(`unsupported OpenCode Go assistant block: ${String(b.type)}`)
    }
    // Text first, then the calls it led to — the order the model produced them.
    if (texts.length) input.push({ role: 'assistant', content: texts.join('\n\n') })
    input.push(...calls)
  }
  if (!input.length) throw new Error('OpenCode Go requires nonempty content')
  const out: Obj = {
    model: body.model,
    input,
    stream: true,
    store: false,
    max_output_tokens: Math.min(
      OPENAI_RESPONSES_GO_MAX_TOKENS,
      typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : OPENAI_RESPONSES_GO_MAX_TOKENS,
    ),
  }
  if (system.length) out.instructions = system.join('\n\n')
  if (typeof body.temperature === 'number') out.temperature = body.temperature
  if (typeof body.top_p === 'number') out.top_p = body.top_p
  const effort = responsesReasoningEffort(body.output_config)
  if (effort) out.reasoning = { effort }
  const tools = Array.isArray(body.tools) ? body.tools.map(obj) : []
  if (tools.some(isServerTool))
    throw new Error('OpenCode Go responses models do not offer server tools (web search)')
  if (tools.length) {
    out.tools = tools.map((t) => {
      if (typeof t.name !== 'string' || t.input_schema === undefined)
        throw new Error('unsupported OpenCode Go tool declaration')
      return {
        type: 'function',
        name: t.name,
        ...(typeof t.description === 'string' && { description: t.description }),
        parameters: obj(t.input_schema),
      }
    })
    const choice = body.tool_choice === undefined ? { type: 'auto' } : obj(body.tool_choice)
    out.tool_choice =
      choice.type === 'auto'
        ? 'auto'
        : choice.type === 'none'
          ? 'none'
          : choice.type === 'any'
            ? 'required'
            : choice.type === 'tool' && typeof choice.name === 'string'
              ? { type: 'function', name: choice.name }
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
 * Responses usage → Anthropic usage. input_tokens include cached reads AND cache writes (probed
 * 2026-10-15: GPT Luna round 1 input 6817 = 3 + 6814 written, round 2 read 6814), so both come out
 * of input; writes are billed at the cache-write price the Luna rows carry. Output includes reasoning.
 */
export function responsesUsage(v: unknown): Obj {
  const u = obj(v)
  const input = count(u.input_tokens)
  const details =
    u.input_tokens_details === undefined || u.input_tokens_details === null
      ? {}
      : obj(u.input_tokens_details)
  const cached = count(details.cached_tokens)
  const written = count(details.cache_write_tokens)
  if (cached + written > input) throw new Error('OpenCode Go cached usage exceeds input')
  return {
    input_tokens: input - cached - written,
    output_tokens: count(u.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  }
}

function frame(type: string, fields: Obj): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
  )
}

async function* responsesEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Obj> {
  const decoder = new TextDecoder()
  let buffer = ''
  function* parse(raw: string): Generator<Obj> {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim()
    if (data && data !== '[DONE]') yield obj(JSON.parse(data))
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let match: RegExpMatchArray | null
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const index = match.index as number
        if (index > MAX_EVENT) throw new Error('OpenCode Go SSE event exceeds budget')
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + match[0].length)
        yield* parse(raw)
      }
      if (buffer.length > MAX_EVENT) throw new Error('OpenCode Go SSE event exceeds budget')
      if (done) {
        if (buffer.trim()) yield* parse(buffer)
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function* responsesToAnthropicEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  model: string,
): AsyncGenerator<Uint8Array> {
  let usage: Obj | undefined
  let index = 0
  let openText = false
  let hasText = false
  let started = false
  let final: Obj | undefined
  const calls: Array<{ callId: string; name: string; args: string }> = []
  const messageId = `msg_or_${randomUUID().replaceAll('-', '')}`
  try {
    for await (const e of responsesEvents(reader)) {
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
      if (e.type === 'error' || e.type === 'response.failed')
        throw new Error('OpenCode Go returned an error event')
      if (e.type === 'response.output_text.delta' && typeof e.delta === 'string' && e.delta) {
        if (!openText) {
          yield frame('content_block_start', { index, content_block: { type: 'text', text: '' } })
          openText = true
        }
        yield frame('content_block_delta', { index, delta: { type: 'text_delta', text: e.delta } })
        hasText = true
      } else if (e.type === 'response.output_item.done') {
        const item = e.item === undefined ? {} : obj(e.item)
        if (item.type === 'function_call') {
          if (
            typeof item.call_id !== 'string' ||
            !item.call_id ||
            typeof item.name !== 'string' ||
            !item.name
          )
            throw new Error('OpenCode Go function call without call_id or name')
          calls.push({
            callId: item.call_id,
            name: item.name,
            args: typeof item.arguments === 'string' ? item.arguments : '',
          })
        }
      } else if (e.type === 'response.completed' || e.type === 'response.incomplete') {
        final = e.response === undefined ? {} : obj(e.response)
        if (final.usage !== undefined && final.usage !== null) usage = responsesUsage(final.usage)
      }
    }
    const incomplete = final?.status === 'incomplete'
    const reason =
      final?.incomplete_details && typeof final.incomplete_details === 'object'
        ? (final.incomplete_details as Obj).reason
        : undefined
    const complete = final?.status === 'completed' || (incomplete && reason === 'max_output_tokens')
    if (!started || !usage || !complete || (!hasText && !calls.length))
      throw new Error('OpenCode Go stream ended without a successful complete response')
    if (openText) {
      yield frame('content_block_stop', { index })
      index++
    }
    for (const call of calls) {
      const input = call.args.trim() ? JSON.parse(call.args) : {}
      obj(input)
      yield frame('content_block_start', {
        index,
        content_block: {
          type: 'tool_use',
          id: encodeResponsesToolId(call.callId),
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
        stop_reason: incomplete ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage,
    })
    yield frame('message_stop', {})
  } catch (error) {
    if (started && usage) yield frame('message_delta', { delta: {}, usage })
    throw error
  }
}

export function createOpenAIResponsesGoFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (_input, init) => {
    let body: Obj
    let model: string
    try {
      if (typeof init?.body !== 'string') throw new Error('OpenCode Go bridge requires a JSON body')
      body = anthropicToOpenAIResponses(obj(JSON.parse(init.body)))
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
    headers.set('user-agent', 'OpenClaude/5 OpenCodeGoResponses')
    const raw = await fetchImpl(OPENAI_RESPONSES_GO_ENDPOINT, {
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
    const events = responsesToAnthropicEvents(reader, model)
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
