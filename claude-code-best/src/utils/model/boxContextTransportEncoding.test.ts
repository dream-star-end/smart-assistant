import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { boxContextMessageSnapshot } from './boxContextTransport.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('canonical layout matches independent whole-array prefix hashes and exact UTF8 suffix sizes', () => {
  const sparse = new Array<unknown>(3)
  sparse[0] = undefined
  sparse[2] = null
  const keyed = { toJSON(key: string) { return { role: 'user', content: [key, undefined, null, sparse] } } }
  const messages: unknown[] = [
    { role: 'user', content: '\u03a9\u2028\ud800\\\"[,]{}' },
    undefined,
    { z: 'last inserted', a: { '10': 'ten', '2': 'two', b: -0, a: 1e-7 } },
    keyed,
    [true, false, 1e21, null, ['nested', '\\\"', '\\\\', '"[,]{}\\']],
    'top level string with \\"[,]{}',
    42,
    null,
    { role: 'assistant', content: 'tail' },
  ]
  const full = JSON.stringify(messages)
  const canonical = JSON.parse(full) as unknown[]
  const snapshot = boxContextMessageSnapshot(full, messages.length)
  for (let end = 0; end <= messages.length; end++) {
    // Independent reference: native whole-array JSON and a fresh hash,
    // rather than the production incremental SHA and suffix sum.
    expect(snapshot.prefixDigests[end]).toBe(digest(messages.slice(0, end)))
    expect(snapshot.suffixBytes[end]).toBe(Buffer.byteLength(JSON.stringify(canonical.slice(end)), 'utf8'))
  }
  for (let index = 0; index < canonical.length; index++) {
    expect(snapshot.messageBytes[index]).toBe(Buffer.byteLength(JSON.stringify(canonical[index]), 'utf8'))
  }
  expect((canonical[3] as { content: unknown[] }).content[0]).toBe('3')
  expect(JSON.stringify(messages)).toBe(full)
  expect(typeof keyed.toJSON).toBe('function')
  for (const tiny of [[], [null], ['\\"[,]{}'], [[1, { nested: [true] }]]]) {
    const actual = boxContextMessageSnapshot(JSON.stringify(tiny), tiny.length)
    for (let end = 0; end <= tiny.length; end++) {
      expect(actual.prefixDigests[end]).toBe(digest(tiny.slice(0, end)))
      expect(actual.suffixBytes[end]).toBe(Buffer.byteLength(JSON.stringify(tiny.slice(end)), 'utf8'))
    }
  }
  expect(() => boxContextMessageSnapshot(JSON.stringify(messages), messages.length - 1)).toThrow()
  for (const invalid of ['{}', '[', '[,]', '[[]', '[]]', '[][1]']) {
    expect(() => boxContextMessageSnapshot(invalid, messages.length)).toThrow()
  }
})

test('a fresh snapshot rechecks in-place old bytes on the same message objects', () => {
  const first = { role: 'user', content: 'original old byte' }
  const messages = [first, { role: 'assistant', content: 'tail retained' }]
  const before = boxContextMessageSnapshot(JSON.stringify(messages), messages.length)
  first.content = 'changed old byte with \u03a9'
  const after = boxContextMessageSnapshot(JSON.stringify(messages), messages.length)
  expect(messages[0]).toBe(first)
  expect(after.prefixDigests[1]).not.toBe(before.prefixDigests[1])
  expect(after.prefixDigests[1]).toBe(digest(messages.slice(0, 1)))
  expect(after.prefixDigests[2]).toBe(digest(messages))
  expect(after.messageBytes[0]).toBe(Buffer.byteLength(JSON.stringify(first), 'utf8'))
  expect(after.suffixBytes[0]).toBe(Buffer.byteLength(JSON.stringify(messages), 'utf8'))
  expect(after.messageBytes[1]).toBe(before.messageBytes[1])
})
