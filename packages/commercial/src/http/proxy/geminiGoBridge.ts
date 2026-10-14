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
    thinkingConfig: { thinkingLevel: 'LOW' },
  }
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p
  if (Array.isArray(body.stop_sequences)) generationConfig.stopSequences = body.stop_sequences
  const result: Obj = { contents, generationConfig }
  const system = [...(body.system === undefined ? [] : systemParts(body.system)), ...inlineSystem]
  if (system.length) result.systemInstruction = { parts: system }
  if (Array.isArray(body.tools) && body.tools.length) {
    result.tools = [
      {
        functionDeclarations: body.tools.map((raw) => {
          const t = obj(raw)
          if (typeof t.name !== 'string' || t.input_schema === undefined)
            throw new Error('unsupported Gemini tool declaration')
          return {
            name: t.name,
            ...(typeof t.description === 'string' && { description: t.description }),
            parametersJsonSchema: obj(t.input_schema),
          }
        }),
      },
    ]
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
    result.toolConfig = {
      functionCallingConfig: {
        mode,
        ...(choice.type === 'tool' && { allowedFunctionNames: [choice.name] }),
      },
    }
  }
  return result
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
): AsyncGenerator<Uint8Array> {
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
    try {
      if (typeof init?.body !== 'string') throw new Error('Gemini bridge requires a JSON body')
      body = anthropicToGemini(obj(JSON.parse(init.body)))
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
    const events = anthropicEvents(reader, GEMINI_GO_MODEL)
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
