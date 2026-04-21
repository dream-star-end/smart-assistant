import * as assert from 'node:assert/strict'
/**
 * Tests for {@link OutboundRingBuffer} — the per-session short-term replay
 * cache behind Phase 0.3 `hello.lastFrameSeq` cursor resume.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/outboundRing.test.ts
 */
import { describe, it } from 'node:test'
import { OutboundRingBuffer } from '../outboundRing.js'

const frame = (seq: number) => JSON.stringify({ type: 'outbound.message', frameSeq: seq })

describe('OutboundRingBuffer.nextSeq / store', () => {
  it('assigns monotonically increasing seq starting at 1', () => {
    const r = new OutboundRingBuffer()
    assert.equal(r.nextSeq('s1'), 1)
    assert.equal(r.nextSeq('s1'), 2)
    assert.equal(r.nextSeq('s1'), 3)
  })

  it('tracks seq independently per sessionKey', () => {
    const r = new OutboundRingBuffer()
    assert.equal(r.nextSeq('s1'), 1)
    assert.equal(r.nextSeq('s2'), 1, 'different sessions reset')
    assert.equal(r.nextSeq('s1'), 2)
    assert.equal(r.nextSeq('s2'), 2)
  })

  it('store() puts the frame in the ring and bumps totalBytes', () => {
    const r = new OutboundRingBuffer()
    const seq = r.nextSeq('s1')
    const data = frame(seq)
    r.store('s1', seq, 1000, data)
    assert.equal(r.size('s1'), 1)
    assert.equal(r.bytes('s1'), Buffer.byteLength(data, 'utf8'))
    assert.equal(r.lastFrameSeq('s1'), 1)
  })
})

describe('OutboundRingBuffer.peekReplay', () => {
  it('returns no-op success when client is caught up', () => {
    const r = new OutboundRingBuffer()
    const s = r.nextSeq('s1'); r.store('s1', s, 1000, frame(s))
    const rep = r.peekReplay('s1', 1)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.equal(rep.sent.length, 0)
    assert.equal(rep.to, 1)
  })

  it('replays all frames after cursor', () => {
    const r = new OutboundRingBuffer()
    for (let i = 1; i <= 5; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    const rep = r.peekReplay('s1', 2)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [3, 4, 5])
    assert.equal(rep.to, 5)
  })

  it('fromSeq=0 returns the whole buffer (full replay)', () => {
    const r = new OutboundRingBuffer()
    for (let i = 1; i <= 3; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    const rep = r.peekReplay('s1', 0)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [1, 2, 3])
  })

  it('no_buffer: session never had frames + non-zero cursor = miss', () => {
    const r = new OutboundRingBuffer()
    const rep = r.peekReplay('ghost', 5)
    assert.equal(rep.ok, false)
    if (rep.ok) return
    assert.equal(rep.reason, 'no_buffer')
    assert.equal(rep.to, 0)
  })

  it('no_buffer with fromSeq=0 is treated as success (client never saw anything)', () => {
    const r = new OutboundRingBuffer()
    const rep = r.peekReplay('ghost', 0)
    assert.equal(rep.ok, true)
  })

  it('sequence_mismatch: client cursor ahead of server last', () => {
    const r = new OutboundRingBuffer()
    const s = r.nextSeq('s1'); r.store('s1', s, 1000, frame(s))
    const rep = r.peekReplay('s1', 42)
    assert.equal(rep.ok, false)
    if (rep.ok) return
    assert.equal(rep.reason, 'sequence_mismatch')
    assert.equal(rep.to, 1)
  })

  it('buffer_miss: frames pruned out below cursor+1', () => {
    const r = new OutboundRingBuffer({ maxEntries: 3, maxAgeMs: 1e9, maxBytes: 1e9 })
    // Push 6 frames — ring can only hold 3, so seqs 1/2/3 are pruned.
    for (let i = 1; i <= 6; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    assert.equal(r.size('s1'), 3, 'ring capped at 3')
    assert.equal(r.lastFrameSeq('s1'), 6)

    // Client is at seq 2 — needs 3,4,5,6 but ring starts at 4 → buffer_miss.
    const rep = r.peekReplay('s1', 2)
    assert.equal(rep.ok, false)
    if (rep.ok) return
    assert.equal(rep.reason, 'buffer_miss')
    assert.equal(rep.to, 6)
  })

  it('cursor exactly at ring-earliest minus 1 is ok (no gap)', () => {
    const r = new OutboundRingBuffer({ maxEntries: 3, maxAgeMs: 1e9, maxBytes: 1e9 })
    for (let i = 1; i <= 5; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    // Ring holds seqs 3,4,5; client at 2 should be replayable (3,4,5 fresh).
    const rep = r.peekReplay('s1', 2)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [3, 4, 5])
  })
})

describe('OutboundRingBuffer pruning', () => {
  it('prunes by maxEntries', () => {
    const r = new OutboundRingBuffer({ maxEntries: 2, maxAgeMs: 1e9, maxBytes: 1e9 })
    for (let i = 1; i <= 5; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    assert.equal(r.size('s1'), 2)
    assert.equal(r.lastFrameSeq('s1'), 5, 'lastSeq not affected by prune')
  })

  it('prunes by maxAgeMs', () => {
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    const s1 = r.nextSeq('s1'); r.store('s1', s1, 0,   frame(s1))
    const s2 = r.nextSeq('s1'); r.store('s1', s2, 150, frame(s2)) // cutoff = 150-100 = 50 → frame1 (ts=0) evicted
    assert.equal(r.size('s1'), 1)
    const rep = r.peekReplay('s1', 0)
    assert.equal(rep.ok, false, 'fromSeq=0 past the earliest still-buffered frame (2) → buffer_miss')
    if (rep.ok) return
    assert.equal(rep.reason, 'buffer_miss')
    assert.equal(rep.to, 2)
  })

  it('prunes by maxBytes', () => {
    // Each frame is ~25+ bytes — set cap so only the last 2 fit.
    const r = new OutboundRingBuffer({ maxEntries: 100, maxAgeMs: 1e9, maxBytes: 80 })
    for (let i = 1; i <= 5; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    assert.ok(r.size('s1') < 5, `ring should be pruned, got ${r.size('s1')}`)
    assert.ok(r.bytes('s1') <= 80, `totalBytes should respect cap, got ${r.bytes('s1')}`)
  })

  it('clear() drops both ring and lastSeq (enables fresh session)', () => {
    const r = new OutboundRingBuffer()
    const s = r.nextSeq('s1'); r.store('s1', s, 1000, frame(s))
    r.clear('s1')
    assert.equal(r.size('s1'), 0)
    assert.equal(r.lastFrameSeq('s1'), 0)
    // Post-clear, nextSeq starts from 1 again.
    assert.equal(r.nextSeq('s1'), 1)
  })
})
