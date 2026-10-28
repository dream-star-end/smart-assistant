// Local diagnosis only. No payload strings, identifiers, headers or errors leave this tap.
// This parser is an observer, never an authority for bridge success or billing.
const EVENT_LIMIT = 256 * 1024
const SEQUENCE_LIMIT = 48
const TYPES = new Set([
  'response.created', 'response.in_progress', 'response.queued',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.refusal.delta', 'response.refusal.done',
  'response.reasoning_text.delta', 'response.reasoning_text.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.completed', 'response.incomplete', 'response.failed', 'error',
])
const TERMINALS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error'])
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const label = (v, allowed) => allowed.includes(v) ? v : v == null ? 'absent' : 'other'
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null
const chars = (v) => typeof v === 'string' ? v.length : 0

function terminal(event) {
  const response = obj(event.response)
  const usage = obj(response.usage)
  const input = obj(usage.input_tokens_details)
  const output = Array.isArray(response.output) ? response.output : []
  let textChars = 0
  let toolCalls = 0
  for (const raw of output) {
    const item = obj(raw)
    if (item.type === 'function_call') toolCalls++
    for (const part of Array.isArray(item.content) ? item.content : []) {
      const value = obj(part)
      if (value.type === 'output_text') textChars += chars(value.text)
      if (value.type === 'refusal') textChars += chars(value.refusal)
    }
  }
  return {
    type: event.type,
    status: label(response.status, ['completed', 'incomplete', 'failed', 'in_progress', 'queued', 'cancelled']),
    reason: label(obj(response.incomplete_details).reason, ['max_output_tokens', 'content_filter']),
    hasUsage: response.usage != null,
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(input.cached_tokens), cacheWriteTokens: count(input.cache_write_tokens),
    reasoningTokens: count(obj(usage.output_tokens_details).reasoning_tokens),
    outputItems: output.length, textChars, toolCalls,
  }
}

export function createGoResponsesTrace(now = () => performance.now()) {
  const started = now()
  const decoder = new TextDecoder()
  let buffer = ''
  let skipping = false
  const summary = {
    schema: 1, bytes: 0, frames: 0, malformed: 0, oversized: 0, omittedRuns: 0,
    textDeltaChars: 0, reasoningDeltaChars: 0, toolArgumentDeltaChars: 0,
    trailingFrame: false, terminalCount: 0, terminal: null, sequence: [],
  }
  const record = (type, wire) => {
    const last = summary.sequence.at(-1)
    if (last?.type === type && last.wire === wire) { last.count++; return }
    if (summary.sequence.length === SEQUENCE_LIMIT) {
      // Preserve both the start and tail; terminal metadata has its own slot.
      summary.sequence.splice(SEQUENCE_LIMIT / 2, 1)
      summary.omittedRuns++
    }
    summary.sequence.push({ type, wire, count: 1, atMs: Math.round(now() - started) })
  }
  const frame = (raw) => {
    summary.frames++
    const lines = raw.split(/\r\n|\r|\n/)
    const name = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
    const wire = name === undefined ? 'absent' : TYPES.has(name) ? name : 'other'
    const data = lines.filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, '')).join('\n').trim()
    if (!data || data === '[DONE]') { record(data ? 'done_sentinel' : 'no_data', wire); return }
    let event
    try { event = obj(JSON.parse(data)) } catch { summary.malformed++; record('invalid_json', wire); return }
    const type = TYPES.has(event.type) ? event.type : 'other'
    record(type, wire)
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') summary.textDeltaChars += chars(event.delta)
    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') summary.reasoningDeltaChars += chars(event.delta)
    if (type === 'response.function_call_arguments.delta') summary.toolArgumentDeltaChars += chars(event.delta)
    if (TERMINALS.has(type)) { summary.terminalCount++; summary.terminal = terminal(event) }
  }
  const consume = (text) => {
    buffer += text
    let separator
    while ((separator = /\r?\n\r?\n|\r\r/.exec(buffer))) {
      const block = buffer.slice(0, separator.index)
      if (!skipping && block.length <= EVENT_LIMIT) frame(block)
      else if (!skipping) summary.oversized++
      buffer = buffer.slice(separator.index + separator[0].length)
      skipping = false
    }
    if (buffer.length > EVENT_LIMIT) {
      if (!skipping) summary.oversized++
      skipping = true
      buffer = buffer.slice(-3)
    }
  }
  return {
    push(bytes) {
      summary.bytes += bytes.length
      // Even a single huge transport chunk cannot create an unbounded parser buffer.
      for (let i = 0; i < bytes.length; i += 8192) consume(decoder.decode(bytes.subarray(i, i + 8192), { stream: true }))
    },
    end(ending) {
      consume(decoder.decode())
      summary.trailingFrame = Boolean(buffer.trim()) || skipping
      if (ending === 'eof' && !skipping && buffer.trim()) frame(buffer)
      buffer = ''
      return { ...summary, ending, elapsedMs: Math.round(now() - started) }
    },
  }
}

/** One reader, no tee or eager drain. The sink receives one bounded summary, never bytes. */
export function traceGoResponsesBody(body, observe) {
  const reader = body.getReader()
  const trace = createGoResponsesTrace()
  let ended = false
  const finish = (ending) => {
    if (ended) return
    ended = true
    try { observe(trace.end(ending)) } catch { /* observation cannot change transport */ }
  }
  const release = () => { try { reader.releaseLock() } catch { /* pending cancellation */ } }
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (ended) return
        if (done) { finish('eof'); release(); controller.close(); return }
        try { trace.push(value) } catch { /* observation cannot change transport */ }
        controller.enqueue(value)
      } catch (error) {
        finish('read_error'); release(); controller.error(error)
      }
    },
    async cancel(reason) {
      finish('cancelled')
      try { await reader.cancel(reason) } finally { release() }
    },
  }, { highWaterMark: 0 })
}
