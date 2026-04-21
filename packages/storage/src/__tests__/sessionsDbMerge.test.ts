import * as assert from 'node:assert/strict'
/**
 * Tests for the pure merge helpers that back client-session persistence.
 *
 * These helpers (`mergePreservingServerAuthored`, `appendServerAuthoredPure`)
 * enforce the Phase 0.1 durability contract for mobile stream resumption:
 * once gateway writes an assistant message with `_source: 'server'`, no
 * client PUT is allowed to silently drop or overwrite it.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsDbMerge.test.ts
 */
import { describe, it } from 'node:test'
import {
  appendServerAuthoredPure,
  mergePreservingServerAuthored,
  type MessageLike,
} from '../sessionsDb.js'

type Msg = MessageLike & { id: string; role?: string; text?: string }

const srv = (id: string, ts: number, text = ''): Msg => ({
  id,
  role: 'assistant',
  text,
  ts,
  _source: 'server',
})

const cli = (id: string, ts: number, role = 'user', text = ''): Msg => ({
  id,
  role,
  text,
  ts,
})

describe('mergePreservingServerAuthored', () => {
  it('returns client reference verbatim when server side has no server-authored messages', () => {
    const server: Msg[] = [cli('u1', 100), cli('u2', 200)]
    const client: Msg[] = [cli('u1', 100), cli('u2', 200), cli('u3', 300)]
    const out = mergePreservingServerAuthored(server, client)
    assert.equal(out, client, 'should return the same array reference (fast path)')
  })

  it('returns client reference even when server is empty', () => {
    const client: Msg[] = [cli('u1', 100)]
    const out = mergePreservingServerAuthored([] as Msg[], client)
    assert.equal(out, client)
  })

  it('re-inserts a server-authored message the client dropped', () => {
    const server: Msg[] = [cli('u1', 100), srv('srv-1', 200, 'server said'), cli('u2', 300)]
    // Client PUT forgot the server-authored message (e.g. mobile backgrounded
    // before WS delivered the final frame and IndexedDB never saw it).
    const client: Msg[] = [cli('u1', 100), cli('u2', 300), cli('u3', 400)]
    const out = mergePreservingServerAuthored(server, client) as Msg[]

    const ids = out.map((m) => m.id)
    assert.deepEqual(ids, ['u1', 'srv-1', 'u2', 'u3'], 'server-authored re-inserted and sorted by ts')
    const recovered = out.find((m) => m.id === 'srv-1')!
    assert.equal(recovered.text, 'server said')
    assert.equal(recovered._source, 'server')
  })

  it('replaces a client-supplied same-id entry with the server version (server wins)', () => {
    const server: Msg[] = [srv('srv-1', 200, 'full server text')]
    // Client has an entry with the same id but truncated content (mobile
    // only received partial streamed text before backgrounding).
    const client: Msg[] = [
      cli('u1', 100),
      { id: 'srv-1', role: 'assistant', text: 'partial...', ts: 200 },
      cli('u2', 300),
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]

    const found = out.find((m) => m.id === 'srv-1')!
    assert.equal(found.text, 'full server text', 'server version wins')
    assert.equal(found._source, 'server')
    assert.equal(out.length, 3, 'no duplication')
  })

  it('handles multiple server-authored messages interleaved with client messages', () => {
    const server: Msg[] = [
      cli('u1', 100),
      srv('srv-1', 150),
      cli('u2', 200),
      srv('srv-2', 250),
      cli('u3', 300),
    ]
    // Client dropped both server-authored entries
    const client: Msg[] = [cli('u1', 100), cli('u2', 200), cli('u3', 300), cli('u4', 400)]
    const out = mergePreservingServerAuthored(server, client) as Msg[]

    assert.deepEqual(
      out.map((m) => m.id),
      ['u1', 'srv-1', 'u2', 'srv-2', 'u3', 'u4'],
      'both server-authored re-inserted and correctly ordered by ts',
    )
  })

  it('is stable for messages with equal ts (preserves client insertion order among ties)', () => {
    const server: Msg[] = [srv('srv-1', 100)]
    const client: Msg[] = [
      { id: 'a', ts: 100, role: 'user' },
      { id: 'b', ts: 100, role: 'user' },
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    // All three have ts=100; insertion order: client a, client b, then srv-1 appended.
    assert.deepEqual(
      out.map((m) => m.id),
      ['a', 'b', 'srv-1'],
    )
  })

  it('ignores server entries without an id (defensive)', () => {
    const server = [
      { ts: 100, _source: 'server', role: 'assistant' }, // no id
      srv('srv-1', 200),
    ] as Msg[]
    const client: Msg[] = [cli('u1', 50)]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u1', 'srv-1'],
      'id-less server entry is dropped (nothing to dedupe against)',
    )
  })

  it('does not treat client-echoed messages marked _source=server but not on the server side', () => {
    // This guards against a client malicious/bug scenario where someone sets
    // `_source:'server'` in their own payload. The merge ONLY protects
    // entries the server already had.
    const server: Msg[] = []
    const client: Msg[] = [
      { id: 'c1', ts: 100, role: 'assistant', _source: 'server' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client)
    // Fast path: server has 0 server-authored, so client returned verbatim.
    assert.equal(out, client)
  })

  it('does not mutate input arrays', () => {
    const server: Msg[] = [srv('srv-1', 200)]
    const client: Msg[] = [cli('u1', 100)]
    const serverSnap = JSON.stringify(server)
    const clientSnap = JSON.stringify(client)
    mergePreservingServerAuthored(server, client)
    assert.equal(JSON.stringify(server), serverSnap)
    assert.equal(JSON.stringify(client), clientSnap)
  })

  // ── P0-3: phantom-assistant dedupe ──────────────────────────────────────
  // Client uses `m-*` ids (from msgId()), server writes `srv-${peerId}-t*`.
  // After a mobile-background recovery the merge can land with BOTH entries
  // for the same turn and the user would see duplicate assistant bubbles.

  it('P0-3: drops client phantom when server-authored lands at a later ts (typical)', () => {
    // User asked, client saw partial stream and stamped m-1 with ts during
    // the stream; server finalised the turn later and stamped srv-1 at turn
    // completion. Adjacency order after sort: [m-1, srv-1].
    const server: Msg[] = [
      cli('u-ask', 100, 'user', 'hello'),
      srv('srv-1', 200, 'full server text'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user', 'hello'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'partial...' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1'],
      'client phantom m-1 dropped, server srv-1 kept',
    )
    const srvEntry = out.find((m) => m.id === 'srv-1')!
    assert.equal(srvEntry.text, 'full server text')
    assert.equal(srvEntry._source, 'server')
  })

  it('P0-3: drops client phantom when server-authored lands at an EARLIER ts (clock drift)', () => {
    // Client's wallclock is ahead of server's — client m-1 ts=250 vs srv-1
    // ts=200. Sorted adjacency becomes [srv-1, m-1] (reverse of typical).
    // Dedupe must still drop m-1.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srv('srv-1', 200, 'server text'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-1', ts: 250, role: 'assistant', text: 'partial' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1'],
      'client phantom m-1 dropped despite being sorted after srv-1',
    )
  })

  it('P0-3: does not drop legitimate adjacent assistant from a different turn', () => {
    // Two separate turns, each with its own user+assistant. The first turn's
    // assistant is server-authored (recovery after background), the second
    // turn's assistant is client-only (the user is mid-new-turn). Client's
    // m-2 must NOT be dropped — it's in a different turn, separated by u-2.
    const server: Msg[] = [
      cli('u-1', 100, 'user'),
      srv('srv-1', 200, 'turn1 server'),
    ]
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      cli('u-2', 300, 'user'),
      { id: 'm-2', ts: 400, role: 'assistant', text: 'turn2 client-only' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-1', 'u-2', 'm-2'],
      'client m-2 preserved — it is in a different turn (u-2 separates it)',
    )
  })

  it('P0-3: dedupe preserves idempotency — replaying the merge yields same result', () => {
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srv('srv-1', 200, 'server text'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'partial' } as Msg,
    ]
    const once = mergePreservingServerAuthored(server, client) as Msg[]
    const twice = mergePreservingServerAuthored(server, once) as Msg[]
    assert.deepEqual(
      twice.map((m) => m.id),
      once.map((m) => m.id),
      'second merge is a no-op on the deduped output',
    )
  })

  it('P0-3: tool-use turn — drops ALL client assistant segments, keeps tool/tool_result', () => {
    // Tool-use turn: the frontend splits assistant output at each tool_use
    // boundary (websocket.js sets `_streamingAssistant = null` on tool_use /
    // tool_result blocks). Server writes ONE aggregated srv-* assistant for
    // the whole turn. Pair-wise adjacency dedupe would leave the earlier
    // client segments orphaned; partition-wise dedupe drops them all.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srv('srv-1', 400, 'pre-tool text\nTOOL_CALL\npost-tool text'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-asst-1', ts: 150, role: 'assistant', text: 'pre-tool text' } as Msg,
      { id: 'm-tool-1', ts: 200, role: 'tool', toolName: 'Read' } as Msg,
      { id: 'm-result-1', ts: 250, role: 'tool_result', text: 'file contents' } as Msg,
      { id: 'm-asst-2', ts: 350, role: 'assistant', text: 'post-tool text' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'm-tool-1', 'm-result-1', 'srv-1'],
      'both client assistant segments dropped, tool/result preserved, srv-1 kept',
    )
  })

  it('P0-3: multi-turn history with server-authoritative first turn only', () => {
    // Turn 1: recovered via server (srv-1), client phantom m-asst-1.
    // Turn 2: client-only (server hadn't persisted yet; e.g. still live).
    const server: Msg[] = [
      cli('u-1', 100, 'user'),
      srv('srv-1', 200, 'turn1 server'),
      cli('u-2', 300, 'user'),
    ]
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-asst-1', ts: 150, role: 'assistant', text: 'turn1 client phantom' } as Msg,
      cli('u-2', 300, 'user'),
      { id: 'm-asst-2', ts: 400, role: 'assistant', text: 'turn2 in-progress' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-1', 'u-2', 'm-asst-2'],
      'turn1 phantom dropped, turn2 client assistant preserved (no server rival)',
    )
  })

  it('P0-3: does not touch adjacent assistants that are both non-server (client-only history)', () => {
    // Pure client history with no server-authored entries hits the fast path
    // (returns clientMsgs verbatim). Even if two assistant entries are
    // adjacent client-side, dedupe must not run.
    const server: Msg[] = [cli('u1', 100, 'user')]
    const client: Msg[] = [
      cli('u1', 100, 'user'),
      { id: 'a1', ts: 200, role: 'assistant', text: 'one' } as Msg,
      { id: 'a2', ts: 300, role: 'assistant', text: 'two' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client)
    assert.equal(out, client, 'fast path: identical reference, no dedupe')
  })
})

describe('appendServerAuthoredPure', () => {
  it('appends a new message, stamps _source, and sorts by ts', () => {
    const existing: Msg[] = [cli('u1', 100), cli('u2', 300)]
    const msg: Msg = { id: 'srv-1', role: 'assistant', text: 'hi', ts: 200 }
    const result = appendServerAuthoredPure(existing, msg)

    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u1', 'srv-1', 'u2'],
    )
    const stamped = result.messages.find((m) => m.id === 'srv-1')!
    assert.equal(stamped._source, 'server')
    assert.equal(stamped.text, 'hi')
  })

  it('is idempotent: returns already_exists when id is already present', () => {
    const existing: Msg[] = [cli('u1', 100), srv('srv-1', 200)]
    const msg: Msg = { id: 'srv-1', role: 'assistant', text: 'again', ts: 999 }
    const result = appendServerAuthoredPure(existing, msg)

    assert.equal(result.applied, false)
    if (result.applied) return
    assert.equal(result.reason, 'already_exists')
  })

  it('defaults ts to `now` when not supplied', () => {
    const existing: Msg[] = [cli('u1', 100)]
    const msg = { id: 'srv-1', role: 'assistant' as const, text: '' } as Msg
    const fakeNow = 12345
    const result = appendServerAuthoredPure(existing, msg, fakeNow)

    assert.equal(result.applied, true)
    if (!result.applied) return
    const appended = result.messages.find((m) => m.id === 'srv-1')!
    assert.equal(appended.ts, fakeNow)
  })

  it('does not mutate the existing array', () => {
    const existing: Msg[] = [cli('u1', 100)]
    const snap = JSON.stringify(existing)
    appendServerAuthoredPure(existing, { id: 'srv-1', role: 'assistant', ts: 200 } as Msg)
    assert.equal(JSON.stringify(existing), snap)
    assert.equal(existing.length, 1, 'existing still length 1')
  })

  it('stamps _source=server even if caller passes a different _source', () => {
    const existing: Msg[] = []
    const msg = { id: 'srv-1', role: 'assistant', ts: 100, _source: 'client' } as Msg
    const result = appendServerAuthoredPure(existing, msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.equal(result.messages[0]._source, 'server', 'overrides caller-provided _source')
  })

  it('appends when ts places the message at the tail', () => {
    const existing: Msg[] = [cli('u1', 100), cli('u2', 200)]
    const msg: Msg = { id: 'srv-1', role: 'assistant', ts: 999 }
    const result = appendServerAuthoredPure(existing, msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u1', 'u2', 'srv-1'],
    )
  })

  it('appends when ts places the message at the head', () => {
    const existing: Msg[] = [cli('u1', 500), cli('u2', 600)]
    const msg: Msg = { id: 'srv-1', role: 'assistant', ts: 100 }
    const result = appendServerAuthoredPure(existing, msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['srv-1', 'u1', 'u2'],
    )
  })
})
