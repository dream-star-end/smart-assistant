// Tape history and immutable payload reads are normal conversation loading,
// not an abuse-only endpoint. They deliberately share the authenticated
// session route boundary instead of adding a small request-count ceiling that
// can interrupt an otherwise valid long conversation.

import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

describe('direct tape reads do not impose a conversation-length rate ceiling', () => {
  test('record pages and exact payload streaming have no tape-specific token bucket', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

    assert.doesNotMatch(source, /tapeRecordsRateLimiter/)
    assert.doesNotMatch(source, /tapeRecordChunkRateLimiter/)
    assert.equal(source.includes('records\\/([0-9]+)\\/payload$'), true)
    assert.equal(source.includes('records$'), true)
    assert.match(source, /readTapeRecordPayloadChunk/)
  })
})
