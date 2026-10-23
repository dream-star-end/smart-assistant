import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import { sendWithBoxContextTransport } from './boxContextTransport.js'

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
    baseURL: 'http://g607.invalid/' + randomUUID(),
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
