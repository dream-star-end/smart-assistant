import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveHttpByteRange } from '../server.js'

describe('timeline payload byte ranges', () => {
  it('supports bounded, open-ended, and suffix ranges', () => {
    assert.deepEqual(resolveHttpByteRange('bytes=2-5', 10), { start: 2, end: 5 })
    assert.deepEqual(resolveHttpByteRange('bytes=7-', 10), { start: 7, end: 9 })
    assert.deepEqual(resolveHttpByteRange('bytes=-3', 10), { start: 7, end: 9 })
    assert.deepEqual(resolveHttpByteRange('bytes=2-99', 10), { start: 2, end: 9 })
  })

  it('rejects malformed or unsatisfiable ranges', () => {
    assert.equal(resolveHttpByteRange('items=0-1', 10), null)
    assert.equal(resolveHttpByteRange('bytes=-0', 10), null)
    assert.equal(resolveHttpByteRange('bytes=10-', 10), null)
    assert.equal(resolveHttpByteRange('bytes=7-2', 10), null)
  })
})
