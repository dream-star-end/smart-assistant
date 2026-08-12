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
    // Pass `now` close to the stored ts so the P1-2 age-prune on read
    // doesn't evict the synthetic test frames (default maxAgeMs = 10min).
    const rep = r.peekReplay('s1', 2, 1005)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [3, 4, 5])
    assert.equal(rep.to, 5)
  })

  it('P1-3: fromSeq=0 + currentLast>0 with populated ring reports no_buffer (not full replay)', () => {
    // Regression: the gateway previously full-replayed the ring whenever
    // fromSeq=0, even when the server had already emitted frames. That made
    // a client whose _lastFrameSeq had been reset (cold tab / state loss /
    // prior resume_failed) receive every buffered assistant delta a second
    // time and silently append a duplicate assistant bubble (text blocks
    // carry no blockId, so client-side frame-level dedup is the only defense).
    // peekReplay must escalate to no_buffer here so the client runs a REST
    // authoritative sync instead.
    const r = new OutboundRingBuffer()
    for (let i = 1; i <= 3; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    const rep = r.peekReplay('s1', 0, 1003)
    assert.equal(rep.ok, false, 'fromSeq=0 must not ring-replay when currentLast>0')
    if (rep.ok) return
    assert.equal(rep.reason, 'no_buffer')
    assert.equal(rep.to, 3)
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
    const rep = r.peekReplay('s1', 42, 1000)
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
    const rep = r.peekReplay('s1', 2, 1006)
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
    const rep = r.peekReplay('s1', 2, 1005)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [3, 4, 5])
  })

  it('P1-2 (tightened): fromSeq=0 + currentLast>0 + empty ring reports no_buffer', () => {
    // Scenario: client has cursor 0 (fresh / state-reset), server has
    // assigned frames (lastFrameSeq > 0) but ring pruned empty. Returning
    // ok/[] would silently lie — the client would think it's caught up
    // when in reality it missed everything. Force a no_buffer escalation
    // so the client REST-syncs authoritative state.
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    for (let i = 1; i <= 3; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    // Prune-on-read at now=2000 evicts everything (cutoff = 2000-100 = 1900).
    const rep = r.peekReplay('s1', 0, 2000)
    assert.equal(rep.ok, false)
    if (rep.ok) return
    assert.equal(rep.reason, 'no_buffer', 'must flag no_buffer even though fromSeq=0')
    assert.equal(rep.to, 3, 'lastFrameSeq preserved')
  })

  it('P1-2: idle session with stale frames prunes on peekReplay read', () => {
    // Short maxAge so the scenario is easy to construct without Date.now fiddling.
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    for (let i = 1; i <= 3; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    assert.equal(r.size('s1'), 3, 'all frames present after store')

    // Simulate a long-idle reconnect: client had cursor=2, server's ring has
    // gone stale (all ts < cutoff), nothing new has been stored to trigger a
    // prune. Without P1-2 the server would happily replay frame 3 from a
    // months-old buffer; with P1-2 it evicts on read and returns no_buffer.
    const rep = r.peekReplay('s1', 2, 2000)
    assert.equal(r.size('s1'), 0, 'stale frames evicted on read, not only on next store()')
    // Client cursor 2 + empty ring + lastFrameSeq=3 → no_buffer (can't
    // distinguish this from server-restart; client escalates to REST sync).
    assert.equal(rep.ok, false)
    if (rep.ok) return
    assert.equal(rep.reason, 'no_buffer')
    assert.equal(rep.to, 3, 'lastFrameSeq preserved (only ring evicted)')
  })
})

describe('OutboundRingBuffer active-turn cold replay', () => {
  it('protects only current-turn content from age and reclaims old/progress frames behind it', () => {
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    const old = r.nextSeq('s1'); r.store('s1', old, 0, frame(old))
    r.beginActiveTurn('s1', 'm-user-1')
    const content = r.nextSeq('s1'); r.store('s1', content, 10, frame(content))
    const progress = r.nextSeq('s1'); r.store('s1', progress, 20, frame(progress), 'progress')

    const replay = r.peekActiveTurnReplay('s1', 'm-user-1', 1000)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.deepEqual(replay.sent.map((entry) => entry.seq), [content])
    assert.equal(replay.evicted.age, 2, 'previous-turn content and expired progress are reclaimed')
    assert.equal(r.size('s1'), 1)
  })

  it('fails the whole active replay after an absolute hard cap drops current content', () => {
    const r = new OutboundRingBuffer({ maxEntries: 1, maxAgeMs: 1e9, maxBytes: 1e9 })
    r.beginActiveTurn('s1', 'm-user-1')
    const first = r.nextSeq('s1'); r.store('s1', first, 1, frame(first))
    const second = r.nextSeq('s1'); r.store('s1', second, 2, frame(second))

    const replay = r.peekActiveTurnReplay('s1', 'm-user-1', 2)
    assert.equal(replay.ok, false)
    if (replay.ok) return
    assert.equal(replay.reason, 'buffer_miss')
    assert.deepEqual(replay.sent, [])
  })

  it('keeps progress-only age loss replay-safe across pruneAll and later content', () => {
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    r.beginActiveTurn('s1', 'm-user-1')
    const progress = r.nextSeq('s1'); r.store('s1', progress, 0, frame(progress), 'progress')

    assert.equal(r.pruneAll(1000).age, 1)
    assert.equal(r.size('s1'), 0)
    const emptyReplay = r.peekActiveTurnReplay('s1', 'm-user-1', 1000)
    assert.equal(emptyReplay.ok, true)
    if (!emptyReplay.ok) return
    assert.deepEqual(emptyReplay.sent, [])

    const content = r.nextSeq('s1'); r.store('s1', content, 1001, frame(content))
    const replay = r.peekActiveTurnReplay('s1', 'm-user-1', 1001)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.deepEqual(replay.sent.map((entry) => entry.seq), [content])
  })

  it('requires exact identity and clears protection only for the matching owner', () => {
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    r.beginActiveTurn('s1', 'm-user-1')
    const seq = r.nextSeq('s1'); r.store('s1', seq, 0, frame(seq))

    const wrongReplay = r.peekActiveTurnReplay('s1', 'm-user-2', 1000)
    assert.equal(wrongReplay.ok, false)
    if (!wrongReplay.ok) assert.equal(wrongReplay.reason, 'no_buffer')
    r.endActiveTurn('s1', 'm-user-2', 1000)
    assert.equal(r.activeTurnClientMessageId('s1'), 'm-user-1')

    const evicted = r.endActiveTurn('s1', 'm-user-1', 1000)
    assert.equal(evicted.age, 1)
    assert.equal(r.activeTurnClientMessageId('s1'), undefined)
    assert.equal(r.size('s1'), 0)
  })

  it('supports an active lock owner before its first output and clear() removes the marker', () => {
    const r = new OutboundRingBuffer()
    r.beginActiveTurn('s1', 'm-user-1')
    const replay = r.peekActiveTurnReplay('s1', 'm-user-1')
    assert.equal(replay.ok, true)
    if (replay.ok) assert.deepEqual(replay.sent, [])
    r.clear('s1')
    assert.equal(r.activeTurnClientMessageId('s1'), undefined)
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
    // Read at now=150 with a non-zero cursor that predates the surviving frame:
    // cutoff=50, frame2 (ts=150) survives the age prune, but client's cursor=1
    // means it needs frame 2 onward — which the ring does have → replay frame 2.
    // (We intentionally use fromSeq=1 rather than fromSeq=0 here: under P1-3,
    //  fromSeq=0+currentLast>0 is treated as a cursor-reset and returns
    //  no_buffer regardless of ring contents, so testing "age-prune leaves a
    //  replayable tail" requires a non-zero cursor.)
    const rep = r.peekReplay('s1', 1, 150)
    assert.equal(rep.ok, true, 'ring still has frame 2 after age prune → replayable')
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [2])
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

  it('clear() drops replay state but keeps frameSeq monotonic across a fresh session', () => {
    const r = new OutboundRingBuffer()
    const s = r.nextSeq('s1'); r.store('s1', s, 1000, frame(s))
    r.clear('s1')
    assert.equal(r.size('s1'), 0)
    assert.equal(r.lastFrameSeq('s1'), 1)
    assert.equal(r.nextSeq('s1'), 2)
  })
})

describe('OutboundRingBuffer eviction stats', () => {
  it('store() reports `entries` cause when ring exceeds maxEntries', () => {
    const r = new OutboundRingBuffer({ maxEntries: 2, maxAgeMs: 1e9, maxBytes: 1e9 })
    const s1 = r.nextSeq('s1'); assert.deepEqual(r.store('s1', s1, 1000, frame(s1)), { entries: 0, age: 0, bytes: 0 })
    const s2 = r.nextSeq('s1'); assert.deepEqual(r.store('s1', s2, 1001, frame(s2)), { entries: 0, age: 0, bytes: 0 })
    // Third frame triggers entry eviction (drops one frame).
    const s3 = r.nextSeq('s1'); const ev = r.store('s1', s3, 1002, frame(s3))
    assert.equal(ev.entries, 1, 'one frame evicted by entries cap')
    assert.equal(ev.age, 0)
    assert.equal(ev.bytes, 0)
  })

  it('store() reports `bytes` cause when ring exceeds maxBytes', () => {
    // Set bytes cap so storing later frames forces eviction.
    const r = new OutboundRingBuffer({ maxEntries: 100, maxAgeMs: 1e9, maxBytes: 80 })
    let totalEvictions = 0
    for (let i = 1; i <= 5; i++) {
      const s = r.nextSeq('s1')
      const ev = r.store('s1', s, 1000 + i, frame(s))
      totalEvictions += ev.bytes
      assert.equal(ev.entries, 0, 'entries cap untouched')
      assert.equal(ev.age, 0, 'age cutoff untouched')
    }
    assert.ok(totalEvictions > 0, 'bytes evictions accumulated across stores')
    assert.ok(r.bytes('s1') <= 80)
  })

  it('peekReplay() reports `age` cause when read-path prune evicts stale frames', () => {
    const r = new OutboundRingBuffer({ maxEntries: 10, maxAgeMs: 100, maxBytes: 1e9 })
    for (let i = 1; i <= 3; i++) {
      const s = r.nextSeq('s1'); r.store('s1', s, 1000 + i, frame(s))
    }
    // Long idle: peekReplay at now=2000 evicts all 3 (cutoff 1900 > all ts).
    const rep = r.peekReplay('s1', 0, 2000)
    assert.equal(rep.ok, false)
    assert.equal(rep.evicted.age, 3, 'all three frames evicted by age on read')
    assert.equal(rep.evicted.entries, 0)
    assert.equal(rep.evicted.bytes, 0)
  })

  it('totalBytes() sums across all sessions', () => {
    const r = new OutboundRingBuffer()
    const a = r.nextSeq('s1'); r.store('s1', a, 1000, frame(a))
    const b = r.nextSeq('s2'); r.store('s2', b, 1000, frame(b))
    assert.equal(r.totalBytes(), r.bytes('s1') + r.bytes('s2'))
  })

  it('happy-path store() returns zero evictions', () => {
    const r = new OutboundRingBuffer()
    const s = r.nextSeq('s1')
    assert.deepEqual(r.store('s1', s, 1000, frame(s)), { entries: 0, age: 0, bytes: 0 })
  })
})

describe('OutboundRingBuffer.storeStamped', () => {
  // storeStamped is the v3 commercial bridge entry point: containers stamp
  // frameSeq inside the embedded gateway's deliver() call, and the bridge can
  // only observe + persist the already-stamped value (re-stamping would
  // diverge from the client cursor expectation). Coverage focus:
  //   1. monotonic accept (happy path)
  //   2. multi-bridge fan-out idempotency (same seq twice → second call is no-op)
  //   3. stale retransmit silently rejected (seq < lastSeq)
  //   4. lastSeq is preserved (not demoted) across rejected writes
  //   5. cross-key independence (containerId namespace isolation)
  //   6. mixed with peekReplay → replay continues to behave correctly
  it('accepts the first stamped seq and bumps lastSeq', () => {
    const r = new OutboundRingBuffer()
    const ev = r.storeStamped('s1', 5, 1000, frame(5))
    assert.deepEqual(ev, { entries: 0, age: 0, bytes: 0 })
    assert.equal(r.lastFrameSeq('s1'), 5, 'lastSeq jumps to stamped value (no nextSeq pre-call needed)')
    assert.equal(r.size('s1'), 1)
  })

  it('accepts strictly-increasing stamped seqs', () => {
    const r = new OutboundRingBuffer()
    r.storeStamped('s1', 5, 1000, frame(5))
    r.storeStamped('s1', 6, 1001, frame(6))
    r.storeStamped('s1', 10, 1002, frame(10))
    assert.equal(r.lastFrameSeq('s1'), 10)
    assert.equal(r.size('s1'), 3)
  })

  it('idempotent on duplicate seq (multi-tab fan-out): same (key, seq) pair is a no-op', () => {
    // Production scenario: container.deliver() iterates clientsByPeer and
    // broadcasts the same stamped frame down each open WS. Each connected
    // bridge instance sees the frame and calls storeStamped on the shared
    // process-singleton ring. Without idempotency the second call would
    // either falsely "reset" or duplicate-append.
    const r = new OutboundRingBuffer()
    r.storeStamped('s1', 7, 1000, frame(7))
    assert.equal(r.size('s1'), 1)
    assert.equal(r.lastFrameSeq('s1'), 7)
    const ev2 = r.storeStamped('s1', 7, 1001, frame(7))
    assert.deepEqual(ev2, { entries: 0, age: 0, bytes: 0 }, 'duplicate is a silent no-op, no eviction')
    assert.equal(r.size('s1'), 1, 'no extra frame appended on duplicate')
    assert.equal(r.lastFrameSeq('s1'), 7, 'lastSeq unchanged')
  })

  it('drops stale-retransmit (seq < lastSeq) without demoting lastSeq', () => {
    // Production scenario: out-of-order delivery / upstream retry in which
    // the bridge sees seq=3 after already accepting seq=10. Must NOT demote
    // lastSeq=10 back to 3 (would break monotonic invariant assumed by
    // peekReplay sequence_mismatch detection).
    const r = new OutboundRingBuffer()
    r.storeStamped('s1', 10, 1000, frame(10))
    const ev = r.storeStamped('s1', 3, 1001, frame(3))
    assert.deepEqual(ev, { entries: 0, age: 0, bytes: 0 })
    assert.equal(r.lastFrameSeq('s1'), 10, 'lastSeq must not be demoted by a stale write')
    assert.equal(r.size('s1'), 1, 'late frame not appended (would re-order the ring)')
  })

  it('does not pollute nextSeq() callers — the two paths are independent', () => {
    // The nextSeq path is for personal-master deliver() (allocates server-side).
    // storeStamped is for v3-commercial bridge (caller already owns the seq).
    // Both update the SAME lastSeq map (so peekReplay sees the right
    // currentLast no matter which path stamped) — but mixing must not
    // corrupt either side.
    const r = new OutboundRingBuffer()
    r.storeStamped('s1', 100, 1000, frame(100))
    // Subsequent nextSeq must continue from 101, not from 1.
    assert.equal(r.nextSeq('s1'), 101, 'nextSeq picks up after stamped lastSeq')
  })

  it('storeKey namespace isolation: separate keys do not interfere', () => {
    // Production scenario: containerId discriminator. After a container
    // recycle, supervisor returns a fresh containerId; bridge writes under
    // a fresh storeKey (`uid:containerId':sessionKey`). Old key's seq=120
    // and new key's seq=1 must be independent.
    const r = new OutboundRingBuffer()
    r.storeStamped('1:cA:k', 120, 1000, frame(120))
    r.storeStamped('1:cB:k', 1, 1001, frame(1))
    assert.equal(r.lastFrameSeq('1:cA:k'), 120)
    assert.equal(r.lastFrameSeq('1:cB:k'), 1)
    assert.equal(r.size('1:cA:k'), 1)
    assert.equal(r.size('1:cB:k'), 1)
  })

  it('peekReplay over a storeStamped-populated ring serves the right tail', () => {
    // End-to-end: stamped writes then a hello-style cursor query — the
    // bridge's main runtime path. Use ts close to `now` so the read-side
    // age prune (defaults to 10min) doesn't evict the test frames.
    const r = new OutboundRingBuffer()
    r.storeStamped('s1', 50, 1000, frame(50))
    r.storeStamped('s1', 51, 1001, frame(51))
    r.storeStamped('s1', 52, 1002, frame(52))
    const rep = r.peekReplay('s1', 50, 1002)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [51, 52])
    assert.equal(rep.to, 52)
  })
})

describe('OutboundRingBuffer.pruneAll', () => {
  it('age-prunes every ring and drops empty SessionRing structs from rings Map', () => {
    // 验证 v3 commercial 兜底语义:周期 prune 释放过期 frames + 释放空 ring 容器,
    // 防止 containerId 切换后 stale storeKey 永久驻留 rings Map。
    const r = new OutboundRingBuffer({
      maxEntries: 2000,
      maxAgeMs: 1000,         // 1s age window
      maxBytes: 5 * 1024 * 1024,
    })
    const s1 = r.nextSeq('uid:cid_old:k1'); r.store('uid:cid_old:k1', s1, 0, frame(s1))
    const s2 = r.nextSeq('uid:cid_old:k2'); r.store('uid:cid_old:k2', s2, 0, frame(s2))
    const s3 = r.nextSeq('uid:cid_new:k1'); r.store('uid:cid_new:k1', s3, 0, frame(s3))
    assert.equal(r.size('uid:cid_old:k1'), 1)
    assert.equal(r.size('uid:cid_old:k2'), 1)
    assert.equal(r.size('uid:cid_new:k1'), 1)

    // Advance "now" past the age window for all three. pruneAll should evict
    // every frame and drop the SessionRing entries from the internal rings Map.
    const stats = r.pruneAll(5_000)
    assert.equal(stats.age, 3, 'all three frames attributed to age cause')
    assert.equal(stats.entries, 0)
    assert.equal(stats.bytes, 0)

    // Per-key probes: rings should report 0 size (and bytes=0), reflecting empty.
    assert.equal(r.size('uid:cid_old:k1'), 0)
    assert.equal(r.size('uid:cid_old:k2'), 0)
    assert.equal(r.size('uid:cid_new:k1'), 0)
  })

  it('preserves lastSeq across pruneAll so cursor=0 still escalates to no_buffer (not silent ok+[])', () => {
    // 关键不变量:pruneAll 必须保留 lastSeq。
    //
    // 反例(若误删 lastSeq):一个真实跑过帧的 session 在 idle 老化后,client 用
    // cursor=0(冷 tab / state reset)hello,会落到 fromSeq===currentLast===0
    // 的 ok+[] 分支 —— 静默丢帧。保留 lastSeq=N>0 后,fromSeq=0+currentLast>0
    // 的 guard 把它升级为 no_buffer,client 触发 REST 强同步。
    const r = new OutboundRingBuffer({
      maxEntries: 2000,
      maxAgeMs: 1000,
      maxBytes: 5 * 1024 * 1024,
    })
    const s = r.nextSeq('s1'); r.store('s1', s, 0, frame(s))
    assert.equal(r.lastFrameSeq('s1'), 1)

    // pruneAll 在远未来执行,把唯一一帧老化掉
    const stats = r.pruneAll(5_000)
    assert.equal(stats.age, 1)
    assert.equal(r.size('s1'), 0)

    // lastSeq 必须存活
    assert.equal(r.lastFrameSeq('s1'), 1)

    // 关键断言:cursor=0 + currentLast=1 → no_buffer(若 lastSeq 被删则会 ok+[])
    const repZero = r.peekReplay('s1', 0, 6_000)
    assert.equal(repZero.ok, false, 'expected resume_failed, not silent ok')
    if (repZero.ok) return
    assert.equal(repZero.reason, 'no_buffer')
  })

  it('returns zero stats and no-op when there are no rings', () => {
    const r = new OutboundRingBuffer()
    const stats = r.pruneAll(10_000)
    assert.deepEqual(stats, { entries: 0, age: 0, bytes: 0 })
  })

  it('leaves still-fresh frames intact and only sweeps idle stale rings', () => {
    // 多 ring 混合:一个 idle stale(过期未被 store 重新 prune),一个 fresh。
    // pruneAll 应只动 stale ring,保留 fresh ring 的 frame 与 lastSeq。
    const r = new OutboundRingBuffer({
      maxEntries: 2000,
      maxAgeMs: 1000,
      maxBytes: 5 * 1024 * 1024,
    })
    // s1: 一帧 ts=0,之后 idle —— store 路径不会再触发它的 prune。
    const sStale = r.nextSeq('s1'); r.store('s1', sStale, 0, frame(sStale))
    // s2: 两帧都在 ts=5000(在 prune 时仍在 age window 内,cutoff=4500)。
    const sFresh1 = r.nextSeq('s2'); r.store('s2', sFresh1, 5_000, frame(sFresh1))
    const sFresh2 = r.nextSeq('s2'); r.store('s2', sFresh2, 5_000, frame(sFresh2))

    const stats = r.pruneAll(5_500)
    assert.equal(stats.age, 1, 'stale s1 frame evicted')
    assert.equal(r.size('s1'), 0, 's1 ring emptied & dropped from rings Map')
    assert.equal(r.size('s2'), 2, 's2 fresh frames survive')
    assert.equal(r.lastFrameSeq('s2'), 2, 's2 lastSeq intact')

    // s2 cursor=1 → 仍可 replay frame 2(验证 frame data 完整保留)
    const rep = r.peekReplay('s2', 1, 5_500)
    assert.equal(rep.ok, true)
    if (!rep.ok) return
    assert.deepEqual(rep.sent.map((f) => f.seq), [2])
  })
})

// ── team-durability(2026-07-07):帧分级淘汰 + content 丢失水位线 ──

describe('OutboundRingBuffer frame-class tiering', () => {
  const store = (
    r: OutboundRingBuffer,
    key: string,
    cls: 'content' | 'progress',
    ts = 1000,
  ) => {
    const seq = r.nextSeq(key)
    r.store(key, seq, ts, frame(seq), cls)
    return seq
  }

  it('evicts oldest progress frames before any content frame under entries pressure', () => {
    const r = new OutboundRingBuffer({ maxEntries: 4, maxAgeMs: 60_000, maxBytes: 1 << 20 })
    store(r, 's1', 'content')   // seq 1
    store(r, 's1', 'progress')  // seq 2
    store(r, 's1', 'progress')  // seq 3
    store(r, 's1', 'content')   // seq 4
    store(r, 's1', 'content')   // seq 5 → 超限,应淘 seq2(最老 progress),content 全保
    const rep = r.peekReplay('s1', 1, 1000)
    assert.equal(rep.ok, true, 'content 无损 → 游标 1 可回放')
    assert.deepEqual(
      rep.sent.map((f) => f.seq),
      [3, 4, 5],
      'seq2(progress)被淘,剩余帧带空洞照常回放',
    )
  })

  it('replays across progress-only gaps but misses once a content frame is lost', () => {
    const r = new OutboundRingBuffer({ maxEntries: 3, maxAgeMs: 60_000, maxBytes: 1 << 20 })
    store(r, 's1', 'progress')  // 1
    store(r, 's1', 'progress')  // 2
    store(r, 's1', 'content')   // 3
    store(r, 's1', 'content')   // 4 → 淘 seq1(progress)
    store(r, 's1', 'content')   // 5 → 淘 seq2(progress);ring=[3,4,5] 全 content
    let rep = r.peekReplay('s1', 0 + 1, 1000) // 游标1:丢的只有 progress(1..2 中 >1 的是 2)
    assert.equal(rep.ok, true)
    assert.deepEqual(rep.sent.map((f) => f.seq), [3, 4, 5])
    store(r, 's1', 'content')   // 6 → 无 progress 可淘 → 淘 seq3(content),水位线=3
    rep = r.peekReplay('s1', 1, 1000)
    assert.equal(rep.ok, false, '游标 1 < 水位线 3 → content 有损必须 miss')
    assert.equal(rep.ok === false && rep.reason, 'buffer_miss')
    const repOk = r.peekReplay('s1', 3, 1000)
    assert.equal(repOk.ok, true, '游标 ≥ 水位线 → 剩余帧可回放')
    assert.deepEqual(repOk.sent.map((f) => f.seq), [4, 5, 6])
  })

  it('age eviction of a content frame also advances the loss watermark', () => {
    const r = new OutboundRingBuffer({ maxEntries: 100, maxAgeMs: 1_000, maxBytes: 1 << 20 })
    store(r, 's1', 'content', 1000)   // 1
    store(r, 's1', 'progress', 1000)  // 2
    store(r, 's1', 'content', 5000)   // 3 → 淘龄:1、2 都过期(头部起),水位线=1... 淘完 1、2
    const rep = r.peekReplay('s1', 0 + 0, 5000)
    // 游标 0 + currentLast>0 → no_buffer(既有 P1-3 语义,与分级无关)
    assert.equal(rep.ok, false)
    const rep2 = r.peekReplay('s1', 1, 5000)
    assert.equal(rep2.ok, true, '游标 1 ≥ 水位线 1(seq1 content 被淘)→ 可回放')
    assert.deepEqual(rep2.sent.map((f) => f.seq), [3])
    const rep3 = r.peekReplay('s1', 2, 5000)
    assert.equal(rep3.ok, true)
  })

  it('ring struct recreation after pruneAll keeps the conservative watermark', () => {
    const r = new OutboundRingBuffer({ maxEntries: 100, maxAgeMs: 1_000, maxBytes: 1 << 20 })
    store(r, 's1', 'content', 1000)  // 1
    store(r, 's1', 'content', 1000)  // 2
    r.pruneAll(10_000)               // 全部过期 → ring struct 被回收
    assert.equal(r.size('s1'), 0)
    store(r, 's1', 'content', 10_000) // 3 → 重建 ring,水位线保守=seq-1=2
    const rep = r.peekReplay('s1', 1, 10_000)
    assert.equal(rep.ok, false, '重建前的 content 丢失不可静默跳过')
    assert.equal(rep.ok === false && rep.reason, 'buffer_miss')
    const repOk = r.peekReplay('s1', 2, 10_000)
    assert.equal(repOk.ok, true)
    assert.deepEqual(repOk.sent.map((f) => f.seq), [3])
  })

  it('store() defaults to content class (callers without cls keep old strictness)', () => {
    const r = new OutboundRingBuffer({ maxEntries: 2, maxAgeMs: 60_000, maxBytes: 1 << 20 })
    for (let i = 0; i < 4; i++) {
      const seq = r.nextSeq('s1')
      r.store('s1', seq, 1000, frame(seq)) // 无 cls → content
    }
    const rep = r.peekReplay('s1', 1, 1000)
    assert.equal(rep.ok, false, '默认 content:淘汰即有损,游标落后必 miss')
  })
})
