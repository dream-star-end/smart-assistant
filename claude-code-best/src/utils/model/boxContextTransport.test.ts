import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import { sendWithBoxContextTransport } from './boxContextTransport.js'
import { stripExcessMediaItems } from '../../services/api/mediaItems.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Body = { model: string; max_tokens: number; metadata: { session_id: string }; messages: unknown[] }
const large = (session = randomUUID()): Body => ({
  model: 'box-api-claude-opus-5-5', max_tokens: 32, metadata: { session_id: session },
  messages: Array.from({ length: 91 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: [{ type: 'image', source: {
      type: 'base64', media_type: 'image/jpeg', data: Buffer.alloc(146_000, i).toString('base64'),
    } }] })),
})
function server() {
  const stored = new Map<string, unknown[]>()
  const staged: Array<{ path: string; body: Record<string, any> }> = []
  let stages = 0
  const client = {
    baseURL: `http://g607.invalid/${randomUUID()}`,
    async post<R>(path: string, options: { body: unknown }): Promise<R> {
      expect(path).toBe('/v1/messages/context')
      const body = options.body as Record<string, any>
      staged.push({ path, body })
      expect(body.stream).toBe(false)
      expect((options as any).timeout).toBeGreaterThan(0)
      expect((options as any).timeout).toBeLessThanOrEqual(120_000)
      expect('betas' in body).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(body.messages))).toBeLessThan(16 * 1024 * 1024)
      const ref = body.oc_context_transport.reference
      if (ref && !stored.has(ref)) {
        throw { status: 409, error: { code: 'BOX_CONTEXT_REF_EXPIRED' } }
      }
      const full = [...(ref ? stored.get(ref)! : []), ...body.messages]
      const reference = (++stages).toString(16).padStart(64, '0')
      stored.set(reference, full)
      return { version: 1, reference, message_count: full.length,
        messages_sha256: digest(full), expires_at: Date.now() + 3600_000 } as R
    },
  }
  const hydrate = (wire: Record<string, any>) =>
    [...stored.get(wire.oc_context_transport.reference)!, ...wire.messages]
  return { client, staged, stored, hydrate }
}

describe('Box lossless context transport', () => {
  test('a 17 MiB, 91 image history arrives byte for byte and the original stays intact', async () => {
    const params = large()
    const original = JSON.stringify(params)
    expect(Buffer.byteLength(JSON.stringify(params.messages))).toBeGreaterThan(16 * 1024 * 1024)
    const s = server()
    let paid = 0
    const answer = await sendWithBoxContextTransport(s.client, params, new AbortController().signal,
      async wire => {
        paid++
        expect(Buffer.byteLength(JSON.stringify(wire.messages))).toBeLessThan(16 * 1024 * 1024)
        expect(JSON.stringify(s.hydrate(wire))).toBe(JSON.stringify(params.messages))
        return 'tail image retained'
      })
    expect(answer).toBe('tail image retained')
    expect(paid).toBe(1)
    expect(s.staged.length).toBeGreaterThan(1)
    expect(JSON.stringify(params)).toBe(original)
  })

  test('small and unrelated model requests never stage and retain the same params object', async () => {
    const s = server()
    const small = { ...large(), messages: [{ role: 'user', content: 'small' }] }
    await sendWithBoxContextTransport(s.client, small, new AbortController().signal, async wire => {
      expect(wire).toBe(small)
    })
    const other = { ...large(), model: 'unrelated-model' }
    await sendWithBoxContextTransport(s.client, other, new AbortController().signal, async wire => {
      expect(wire).toBe(other)
    })
    expect(s.staged.length).toBe(0)
  })

  test('exact prior prefixes reuse references and altered old bytes are re-staged', async () => {
    const s = server()
    const params = large()
    const signal = new AbortController().signal
    await sendWithBoxContextTransport(s.client, params, signal, async wire => {
      expect(JSON.stringify(s.hydrate(wire))).toBe(JSON.stringify(params.messages))
    })
    const count = s.staged.length
    const next = { ...params, messages: [...params.messages,
      { role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' }] }
    await sendWithBoxContextTransport(s.client, next, signal, async wire => {
      expect(JSON.stringify(s.hydrate(wire))).toBe(JSON.stringify(next.messages))
    })
    expect(s.staged.length).toBe(count)
    const edited = { ...next, messages: [{ role: 'user', content: 'changed prefix' },
      ...next.messages.slice(1)] }
    await sendWithBoxContextTransport(s.client, edited, signal, async wire => {
      expect(JSON.stringify(s.hydrate(wire))).toBe(JSON.stringify(edited.messages))
    })
    expect(s.staged.length).toBeGreaterThan(count)
  })

  test('only an explicit pre-dispatch ref miss rebuilds once, never a started stream', async () => {
    const s = server()
    const params = large()
    const signal = new AbortController().signal
    await sendWithBoxContextTransport(s.client, params, signal, async () => 'first')
    s.stored.clear()
    let sent = 0
    const answer = await sendWithBoxContextTransport(s.client, params, signal, async wire => {
      sent++
      if (!s.stored.has(wire.oc_context_transport!.reference)) {
        throw { status: 409, error: { error: { code: 'BOX_CONTEXT_REF_EXPIRED' } } }
      }
      expect(JSON.stringify(s.hydrate(wire))).toBe(JSON.stringify(params.messages))
      return 'complete'
    })
    expect(answer).toBe('complete')
    expect(sent).toBe(2)
    let attempts = 0
    await expect(sendWithBoxContextTransport(s.client, params, signal, async () => {
      attempts++
      throw { status: 502, error: { code: 'UPSTREAM_ERROR' } }
    })).rejects.toMatchObject({ status: 502 })
    expect(attempts).toBe(1)
  })

  test('bad stage digests and cancellation cannot reach the paid endpoint', async () => {
    const params = large()
    const s = server()
    let paid = 0
    const bad = { ...s.client, async post<R>(): Promise<R> {
      return { version: 1, reference: 'a'.repeat(64), message_count: 20,
        messages_sha256: '0'.repeat(64), expires_at: Date.now() + 3600_000 } as R
    } }
    await expect(sendWithBoxContextTransport(bad, params, new AbortController().signal,
      async () => { paid++ })).rejects.toThrow('完整资料传输校验未通过')
    const abort = new AbortController()
    abort.abort()
    await expect(sendWithBoxContextTransport(s.client, params, abort.signal,
      async () => { paid++ })).rejects.toThrow()
    expect(paid).toBe(0)
  })

  test('stage mirrors SDK beta output format conversion without mutating full params', async () => {
    const s = server()
    const params = { ...large(), betas: ['test-beta'], output_format: { type: 'json_schema' } }
    await sendWithBoxContextTransport(s.client, params, new AbortController().signal, async () => 'ok')
    expect(s.staged[0]!.body.output_config.format).toEqual(params.output_format)
    expect('output_format' in s.staged[0]!.body).toBe(false)
    expect(params.output_format).toEqual({ type: 'json_schema' })
  })
})



test('15.5 MiB requests accepted by the previous envelope never need a new server endpoint', async () => {
  const params = { ...large(), messages: [
    { role: 'user', content: 'x'.repeat(15.5 * 1024 * 1024) },
    { role: 'assistant', content: 'unchanged' },
  ] }
  const s = server()
  const old = { ...s.client, async post<R>(): Promise<R> { throw new Error('old endpoint 404') } }
  let paid = 0
  await sendWithBoxContextTransport(old, params, new AbortController().signal, async wire => {
    paid++
    expect(wire).toBe(params)
  })
  expect(paid).toBe(1)
  expect(s.staged.length).toBe(0)
})

test('nonstream fallback total deadline includes preparation and bounds every stage request', async () => {
  const params = large()
  const s = server()
  let paid = 0
  const slow = { ...s.client, async post<R>(path: string, options: any): Promise<R> {
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout).toBeLessThanOrEqual(200)
    await new Promise(resolve => setTimeout(resolve, 210))
    return await s.client.post<R>(path, options)
  } }
  await expect(sendWithBoxContextTransport(slow, params, new AbortController().signal,
    async () => { paid++ }, { timeoutMs: 200 })).rejects.toBeInstanceOf(APIConnectionTimeoutError)
  expect(paid).toBe(0)
  await sendWithBoxContextTransport(s.client, { ...params, metadata: { session_id: randomUUID() } },
    new AbortController().signal, async (_wire, remaining) => {
      expect(remaining).toBeGreaterThan(0)
      expect(remaining).toBeLessThan(5000)
    }, { timeoutMs: 5000 })
})

describe('media trimming preserves tool results', () => {
  const image = (id: number) => ({ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: Buffer.from(`image-${id}`).toString('base64'),
  } })
  const document = { type: 'document', source: {
    type: 'base64', media_type: 'application/pdf', data: 'cGRm',
  } }
  const message = (content: unknown): any => ({ type: 'user', message: { role: 'user', content } })
  const result = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content })
  const tail = (count: number) => message(Array.from({ length: count }, (_, i) => image(i + 10)))
  const removed = [{ type: 'text', text:
    '[Historical media removed to fit the request media limit. Re-read the source if needed.]' }]
  const contents = (messages: ReturnType<typeof stripExcessMediaItems>): any[] =>
    messages.map(item => item.message!.content)

  test('zero, 99 and exactly 100 media items retain the original request', () => {
    for (const count of [0, 99, 100]) {
      const messages = [message([result('toolu_keep', [
        { type: 'text', text: 'keep every byte\nα' },
        ...Array.from({ length: count }, (_, i) => image(i)),
      ])])]
      expect(stripExcessMediaItems(messages, 100)).toBe(messages)
    }
  })

  test('101 items replace only the oldest emptied result and retain the latest 100', () => {
    const newest = tail(100)
    const messages = [message([result('toolu_old', [image(0)])]), newest]
    const out = stripExcessMediaItems(messages, 100)
    expect(contents(out)[0]).toEqual([result('toolu_old', removed)])
    expect(out[1]).toBe(newest)
    expect(messages[0].message.content[0].content).toEqual([image(0)])
  })

  test('two adjacent emptied image and document results keep their pairing and error fields', () => {
    const first = { ...result('toolu_first', [image(0)]), is_error: true, marker: 'preserve' }
    const second = result('toolu_second', [document])
    const messages = [message([first, second]), tail(100)]
    expect(contents(stripExcessMediaItems(messages, 100))[0]).toEqual([
      { ...first, content: removed }, { ...second, content: removed },
    ])
  })

  test('partial trimming preserves remaining media order and the document data', () => {
    const remaining = [document, image(2)]
    const messages = [message([result('toolu_partial', [image(0), ...remaining])]), tail(98)]
    expect(contents(stripExcessMediaItems(messages, 100))[0]).toEqual([
      result('toolu_partial', remaining),
    ])
  })

  test('mixed text and media keeps exact text without inserting a replacement', () => {
    const text = { type: 'text', text: 'source: /original file\nretain α\tbytes  ' }
    const messages = [message([result('toolu_mixed', [image(0), text, document])]), tail(100)]
    expect(contents(stripExcessMediaItems(messages, 100))[0]).toEqual([
      result('toolu_mixed', [text]),
    ])
  })

  test('top-level and nested media share the same budget without changing other blocks', () => {
    const text = { type: 'text', text: 'keep this top-level text' }
    const messages = [message([text, result('toolu_nested', [image(0)]), document]), tail(99)]
    const out = stripExcessMediaItems(messages, 100)
    expect(contents(out)[0]).toEqual([text, result('toolu_nested', removed), document])
    expect(out[1]).toBe(messages[1])
  })

  test('frozen history is untouched and retries or replays do not accumulate replacements', () => {
    const messages = [message([result('toolu_old', [image(0)])]), tail(100)]
    const before = JSON.stringify(messages)
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
      }
    }
    freeze(messages)
    const out = stripExcessMediaItems(messages, 100)
    expect(stripExcessMediaItems(out, 100)).toBe(out)
    expect(stripExcessMediaItems(messages, 100)).toEqual(out)
    expect(JSON.stringify(messages)).toBe(before)
  })

  test('pre-existing empty results, strings and unknown blocks are not repaired or hidden', () => {
    const empty = result('toolu_empty', [])
    const string = result('toolu_string', 'actual upstream error')
    const unknown = { type: 'unsupported', original: true }
    const mixed = result('toolu_unknown', [image(0), unknown])
    const messages = [message([empty, string, mixed]), tail(100)]
    const out = contents(stripExcessMediaItems(messages, 100))[0]
    expect(out).toEqual([empty, string, result('toolu_unknown', [unknown])])
    expect(out[0]).toBe(empty)
    expect(out[1]).toBe(string)
    expect(out[2].content[0]).toBe(unknown)
  })
})
