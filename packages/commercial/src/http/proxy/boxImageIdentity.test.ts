import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deriveBoxImageIdentity } from './boxImageIdentity.js'
import type { ProxyBody } from './shared.js'

const image = (bytes: Buffer) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } })
const body = (content: unknown): Pick<ProxyBody, 'messages'> => ({ messages: [{ role: 'user', content }] } as Pick<ProxyBody, 'messages'>)
const expected = (items: Buffer[]) => createHash('sha256').update('ocv5-box-image-identity-v1\0')
  .update(items.map(bytes => JSON.stringify(['image/jpeg', bytes.length, createHash('sha256').update(bytes).digest('hex')])).sort().join('\n')).digest('hex')

test('private image evidence binds all 91 byte owners, preserves multiplicity and never contains raw metadata', () => {
  const originals = Array.from({ length: 91 }, (_, index) => Buffer.from(`synthetic-image-${index}`))
  const input = body([{ type: 'text', text: 'private-marker-must-not-leave-RAM' }, ...originals.map(image)])
  const snapshot = JSON.stringify(input)
  const digest = deriveBoxImageIdentity(input)
  assert.deepEqual(digest, { version: 1, complete: true, sha256: expected(originals), imageCount: 91, uniqueImageCount: 91, mediaBytes: originals.reduce((n, bytes) => n + bytes.length, 0) })
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(JSON.stringify(digest).includes('private-marker'), false)
  assert.deepEqual(deriveBoxImageIdentity(body([...originals].reverse().map(image))), digest)
  const repeated = deriveBoxImageIdentity(body([...originals, originals[0]!].map(image)))
  assert.ok(repeated.complete); assert.equal(repeated.imageCount, 92); assert.equal(repeated.uniqueImageCount, 91); assert.notEqual(repeated.sha256, digest.complete && digest.sha256)
  const changed = originals.map(bytes => Buffer.from(bytes)); changed[0]![0] ^= 1
  const changedIdentity = deriveBoxImageIdentity(body(changed.map(image)))
  assert.ok(changedIdentity.complete); assert.notEqual(changedIdentity.sha256, digest.complete && digest.sha256)
})

test('nested tool results are images while tool input/text lookalikes remain text; malformed media cannot produce a partial proof', () => {
  const bytes = Buffer.from('synthetic exact bytes')
  const input = body([{ type: 'tool_use', id: 'one', name: 'fixture', input: image(bytes) }, { type: 'tool_result', tool_use_id: 'one', content: [image(bytes)] }, { type: 'text', text: JSON.stringify(image(bytes)) }])
  const result = deriveBoxImageIdentity(input)
  assert.ok(result.complete); assert.equal(result.imageCount, 1); assert.equal(result.sha256, expected([bytes]))
  for (const data of ['%%%=', 'YQ', 'YQ==\n', 'YQ===']) {
    assert.deepEqual(deriveBoxImageIdentity(body([image(bytes), { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }])), { version: 1, complete: false })
  }
  const zero = deriveBoxImageIdentity(body('ordinary text'))
  assert.ok(zero.complete); assert.equal(zero.imageCount, 0); assert.equal(zero.sha256, expected([]))
})
