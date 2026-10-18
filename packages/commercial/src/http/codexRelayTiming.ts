import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { estimateModelHistoryTokens } from '@openclaude/protocol'

export type TimingFields = Record<string, number | string | null>
export type TimingObserver = (fields: TimingFields) => void
const REQUEST_LIMIT = 2 * 1024 * 1024
const EVENT_LIMIT = 256 * 1024

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function tokens(value: unknown): number {
  return value === undefined ? 0 : estimateModelHistoryTokens(
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function emit(observer: TimingObserver, fields: TimingFields): void {
  // Observation must never change transport success or retry/billing semantics.
  try { observer(fields) } catch { /* logger failure is not a model failure */ }
}

/** Observe a bounded copy in memory; every original byte is forwarded unchanged. */
export function codexRequestTiming(
  observe: TimingObserver,
  now: () => number = () => performance.now(),
  startedAt = now(),
  limit = REQUEST_LIMIT,
): Transform {
  let chunks: Buffer[] = []
  let size = 0
  let skipped = false
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (!skipped && size <= limit) chunks.push(Buffer.from(chunk))
      else { skipped = true; chunks = [] }
      callback(null, chunk)
    },
    flush(callback) {
      try {
        if (skipped) emit(observe, { stage: 'request_context_skipped', elapsedMs: now() - startedAt })
        else {
          const request = obj(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          const input = Array.isArray(request.input) ? request.input : []
          const fields: TimingFields = {
            stage: 'request_context', elapsedMs: now() - startedAt,
            instructionsTokensEstimate: tokens(request.instructions),
            toolsTokensEstimate: tokens(request.tools),
            toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
            inputItemCount: input.length,
          }
          for (const role of ['system', 'developer', 'user', 'assistant', 'tool', 'other']) {
            fields[`${role}TokensEstimate`] = 0
          }
          for (const item of input) {
            const value = obj(item)
            const rawRole = value.role
            const role = typeof rawRole === 'string' && ['system', 'developer', 'user', 'assistant'].includes(rawRole)
              ? rawRole : value.type === 'function_call_output' ? 'tool' : 'other'
            fields[`${role}TokensEstimate`] = Number(fields[`${role}TokensEstimate`]) + tokens(item)
          }
          emit(observe, fields)
        }
      } catch { emit(observe, { stage: 'request_context_unavailable', elapsedMs: now() - startedAt }) }
      chunks = []
      callback()
    },
  })
}

/** Passive SSE tap. Headers/keepalive/items are never counted as content deltas. */
export function codexResponseTiming(
  observe: TimingObserver,
  now: () => number = () => performance.now(),
  startedAt = now(),
  limit = EVENT_LIMIT,
): Transform {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let skipping = false
  const seen = new Set<string>()
  const once = (stage: string): void => {
    if (seen.has(stage)) return
    seen.add(stage)
    emit(observe, { stage, elapsedMs: now() - startedAt })
  }
  const event = (block: string): void => {
    try {
      const data = block.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') return
      const value = obj(JSON.parse(data))
      if (typeof value.delta === 'string' && value.delta.trim().length > 0) {
        if (value.type === 'response.output_text.delta') once('first_text_delta')
        if (value.type === 'response.reasoning_text.delta' || value.type === 'response.reasoning_summary_text.delta') {
          once('first_reasoning_delta')
        }
      }
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(value.type))) {
        const response = obj(value.response)
        const usage = obj(response.usage)
        const input = obj(usage.input_tokens_details)
        const output = obj(usage.output_tokens_details)
        const fields = obj(obj(usage.attribution).request_fields)
        emit(observe, {
          stage: 'usage', elapsedMs: now() - startedAt,
          inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
          cachedInputTokens: count(input.cached_tokens), cacheWriteTokens: count(input.cache_write_tokens),
          reasoningTokens: count(output.reasoning_tokens),
          instructionsTokens: count(obj(fields.instructions).input_tokens),
          toolsTokens: count(obj(fields.tools).input_tokens),
        })
      }
    } catch { /* malformed/oversize events do not affect the original stream */ }
  }
  const consume = (text: string): void => {
    buffer += text
    let separator: RegExpExecArray | null
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, separator.index)
      if (!skipping && Buffer.byteLength(block) <= limit) event(block)
      buffer = buffer.slice(separator.index + separator[0].length)
      skipping = false
    }
    if (Buffer.byteLength(buffer) > limit) {
      // Retain separator lookbehind, never a partial content event.
      buffer = buffer.slice(-3)
      skipping = true
      once('sse_observation_skipped')
    }
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length) once('first_body')
      try { consume(decoder.write(chunk)) } catch { once('sse_observation_unavailable') }
      callback(null, chunk)
    },
    flush(callback) {
      try { consume(decoder.end()); if (buffer && !skipping) event(buffer) } catch {}
      buffer = ''
      callback()
    },
  })
}

/** Metadata-only tap for model directory bodies; never parses or logs their contents. */
export function codexBodyTiming(
  observe: TimingObserver, now: () => number = () => performance.now(), startedAt = now(),
): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!bytes && chunk.length) emit(observe, { stage: 'first_body', elapsedMs: now() - startedAt })
      bytes += chunk.length
      callback(null, chunk)
    },
    flush(callback) {
      emit(observe, { stage: 'body_complete', elapsedMs: now() - startedAt, bodyBytes: bytes })
      callback()
    },
  })
}
