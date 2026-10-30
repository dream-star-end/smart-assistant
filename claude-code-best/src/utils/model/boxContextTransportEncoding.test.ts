import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { sendWithBoxContextTransport } from './boxContextTransport.js'

const json = (value: unknown) => JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex')
function fixture() {
  const stored = new Map<string, unknown[]>()
  let stages = 0
  const client = {
    baseURL: `http://encoding.invalid/${randomUUID()}`,
    async post<R>(_path: string, options: { body: unknown }): Promise<R> {
      // Real HTTP serialization evaluates original objects, rather than storing
      // the original references and accidentally hiding serialization changes.
      const body = JSON.parse(json(options.body))
      const prior = body.oc_context_transport.reference
      const messages = [...(prior ? stored.get(prior)! : []), ...body.messages]
      const reference = (++stages).toString(16).padStart(64, '0')
      stored.set(reference, messages)
      expect(Buffer.byteLength(json(body.messages))).toBeLessThan(4 * 1024 * 1024)
      return { version: 1, reference, message_count: messages.length,
        messages_sha256: digest(messages), expires_at: Date.now() + 60_000 } as R
    },
  }
  return { client, stages: () => stages, hydrate: (wire: {
    messages: readonly unknown[]; oc_context_transport?: { reference: string }
  }) => [
    ...stored.get(wire.oc_context_transport!.reference)!, ...JSON.parse(json(wire.messages)),
  ] }
}
function params(messages: unknown[]) {
  return { model: 'box-api-claude-opus-5-5', max_tokens: 32,
    metadata: { session_id: randomUUID() }, messages }
}
function padding() {
  return Array.from({ length: 69 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: `${i}:${'x'.repeat(256 * 1024)}` }))
}

test('canonical prefix digests preserve array nulls, escapes, ordering and original toJSON keys', async () => {
  const sparse = new Array<unknown>(3)
  sparse[0] = undefined
  sparse[2] = null
  const first = { toJSON(key: string) { return { role: 'user', content: [
    { z: '\u03a9\u2028\ud800\\\"', a: { '10': 'ten', '2': 'two', b: -0, a: 1e-7 } },
    key, undefined, null, sparse,
  ] } } }
  const input = params([first, ...padding()])
  const expected = json(input.messages)
  expect(Buffer.byteLength(expected)).toBeGreaterThan(16 * 1024 * 1024)
  const server = fixture()
  await sendWithBoxContextTransport(server.client, input, new AbortController().signal, async wire => {
    expect(json(server.hydrate(wire))).toBe(expected)
    return 'ok'
  })
  expect(server.stages()).toBeGreaterThan(1)
  expect(input.messages[0]).toBe(first)
  expect(json(input.messages)).toBe(expected)
})

test('in-place old message edits invalidate a cached reference on the next invocation', async () => {
  const messages = padding()
  const input = params(messages)
  const server = fixture()
  const send = async (wire: Parameters<typeof server.hydrate>[0]) =>
    expect(json(server.hydrate(wire))).toBe(json(messages))
  await sendWithBoxContextTransport(server.client, input, new AbortController().signal, send)
  const before = server.stages()
  await sendWithBoxContextTransport(server.client, input, new AbortController().signal, send)
  expect(server.stages()).toBe(before)
  messages[0]!.content = `edited in place: ${messages[0]!.content}`
  await sendWithBoxContextTransport(server.client, input, new AbortController().signal, send)
  expect(server.stages()).toBeGreaterThan(before)
})
