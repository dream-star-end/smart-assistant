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
  dropPhantomClientAssistants,
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

  it('strips client-forged _source=server for ids the server has NOT authored', () => {
    // Round 3 defense: merge must not let a client PUT plant a fake
    // authoritative row by stamping `_source: 'server'` on its own payload.
    // Only ids the server actually has in `serverSideMsgs` retain the flag.
    const server: Msg[] = []
    const client: Msg[] = [
      { id: 'c1', ts: 100, role: 'assistant', _source: 'server' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'c1')
    assert.equal((out[0] as MessageLike)._source, undefined,
      'spoofed _source scrubbed from client entry')
  })

  it('fast path returns client reference verbatim when nothing needs scrubbing', () => {
    // Same fast path, sanity-checking the no-scrub common case still avoids
    // an unnecessary allocation (callers like upsertClientSession rely on
    // reference equality to skip a JSON.stringify write).
    const server: Msg[] = []
    const client: Msg[] = [cli('u1', 100), cli('u2', 200)]
    const out = mergePreservingServerAuthored(server, client)
    assert.equal(out, client, 'reference preserved when no _source forgery present')
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

  // ── Phantom cleanup on direct append ────────────────────────────────────
  // Reproduces the DB-observed bug: a client PUT lands BEFORE gateway's
  // turn.completed handler writes the srv-* record, so `mergePreservingServerAuthored`
  // takes its "no server-authored anywhere" fast path and leaves the client
  // phantom in place. Then appendServerAuthoredPure appends the srv-* entry
  // — which used to skip phantom dedupe. If the client never PUTs again
  // (mobile backgrounded, tab closed, session switched), the phantom lives
  // forever and shows up as a duplicate assistant on reload.

  it('phantom cleanup: drops client m-* assistant when srv-* is appended to the same turn', () => {
    // Pre-append state: client had earlier PUT with its own streaming `m-1`.
    // No server-authored entry existed yet, so merge took the fast path and
    // left m-1 alone.
    const existing: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'client partial' } as Msg,
    ]
    // Gateway finishes the turn and appends the authoritative srv-1.
    const result = appendServerAuthoredPure(existing, {
      id: 'srv-1',
      role: 'assistant',
      ts: 200,
      text: 'full server text',
    } as Msg)

    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u-ask', 'srv-1'],
      'phantom m-1 dropped; srv-1 kept',
    )
    const srvEntry = result.messages.find((m) => m.id === 'srv-1')!
    assert.equal(srvEntry.text, 'full server text')
    assert.equal(srvEntry._source, 'server')
  })

  it('phantom cleanup: drops all client assistant segments of a tool-use turn', () => {
    // Tool-use turn: frontend split assistant output around tool/tool_result
    // (websocket.js clears _streamingAssistant on tool boundaries). Server
    // then writes ONE aggregated srv-*. All m-* assistants in that turn are
    // phantoms; tool/tool_result rows are never dropped.
    const existing: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-a1', ts: 150, role: 'assistant', text: 'pre-tool' } as Msg,
      { id: 'm-tool', ts: 200, role: 'tool', toolName: 'Read' } as Msg,
      { id: 'm-res', ts: 250, role: 'tool_result', text: 'contents' } as Msg,
      { id: 'm-a2', ts: 300, role: 'assistant', text: 'post-tool' } as Msg,
    ]
    const result = appendServerAuthoredPure(existing, {
      id: 'srv-1',
      role: 'assistant',
      ts: 400,
      text: 'aggregated',
    } as Msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u-ask', 'm-tool', 'm-res', 'srv-1'],
      'both client assistant segments dropped; tool/result kept; srv-1 kept',
    )
  })

  it('phantom cleanup: does NOT drop assistants from other turns', () => {
    // Two separate turns. Appending srv-1 to turn 1 must not touch turn 2's
    // client-only assistant (user is still mid-turn-2; server hasn't authored
    // it yet).
    const existing: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-asst-1', ts: 150, role: 'assistant', text: 'turn1 phantom' } as Msg,
      cli('u-2', 200, 'user'),
      { id: 'm-asst-2', ts: 250, role: 'assistant', text: 'turn2 live' } as Msg,
    ]
    const result = appendServerAuthoredPure(existing, {
      id: 'srv-1',
      role: 'assistant',
      ts: 180,
      text: 'turn1 server',
    } as Msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u-1', 'srv-1', 'u-2', 'm-asst-2'],
      'turn1 phantom dropped; turn2 client assistant preserved',
    )
  })

  it('phantom cleanup: tolerates client ts later than server (clock drift)', () => {
    // Client's wallclock runs ahead — m-1 ts > srv-1 ts. Sorted adjacency
    // flips to [srv-1, m-1] but dedupe runs on the partition so m-1 still drops.
    const existing: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-1', ts: 500, role: 'assistant', text: 'client phantom' } as Msg,
    ]
    const result = appendServerAuthoredPure(existing, {
      id: 'srv-1',
      role: 'assistant',
      ts: 200,
      text: 'server',
    } as Msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u-ask', 'srv-1'],
      'phantom m-1 dropped even when sorted after srv-1',
    )
  })

  it('phantom cleanup: no-op when there are no client assistants to drop', () => {
    // Clean history (only user messages and non-assistant rows). Append must
    // not perturb ordering beyond inserting srv-1 at its ts position.
    const existing: Msg[] = [
      cli('u-1', 100, 'user'),
      cli('u-2', 200, 'user'),
      { id: 'm-tool', ts: 300, role: 'tool', toolName: 'Bash' } as Msg,
    ]
    const result = appendServerAuthoredPure(existing, {
      id: 'srv-1',
      role: 'assistant',
      ts: 250,
    } as Msg)
    assert.equal(result.applied, true)
    if (!result.applied) return
    assert.deepEqual(
      result.messages.map((m) => m.id),
      ['u-1', 'u-2', 'srv-1', 'm-tool'],
    )
  })

  it('phantom cleanup: idempotent on replay (re-sending the same id is already_exists)', () => {
    // First append drops the phantom. Second attempt hits the id-guard and
    // reports already_exists — we never re-enter the dedupe path for the
    // same message, which is what guarantees replay safety from the outbox
    // and from concurrent gateway writes.
    const existing: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'phantom' } as Msg,
    ]
    const first = appendServerAuthoredPure(existing, {
      id: 'srv-1',
      role: 'assistant',
      ts: 200,
    } as Msg)
    assert.equal(first.applied, true)
    if (!first.applied) return

    const second = appendServerAuthoredPure(first.messages, {
      id: 'srv-1',
      role: 'assistant',
      ts: 999,
      text: 'rewrite',
    } as Msg)
    assert.equal(second.applied, false)
    if (second.applied) return
    assert.equal(second.reason, 'already_exists')
  })
})

describe('dropPhantomClientAssistants', () => {
  it('returns input reference verbatim when no server-authored assistant exists (fast path)', () => {
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-a1', ts: 200, role: 'assistant', text: 'client only' } as Msg,
      { id: 'm-a2', ts: 300, role: 'assistant', text: 'another' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs)
    assert.equal(out, msgs, 'fast-path identity return preserves allocation contract')
  })

  it('drops phantoms in the partition containing the server-authored entry', () => {
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'phantom' } as Msg,
      srv('srv-1', 200, 'server'),
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(out.map((m) => m.id), ['u-1', 'srv-1'])
  })

  it('drops nothing when every partition either has no server-authored or no phantom', () => {
    // Turn 1: server-authored, no client phantom.
    // Turn 2: client-only assistant, no server rival.
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      srv('srv-1', 150, 'server'),
      cli('u-2', 200, 'user'),
      { id: 'm-2', ts: 250, role: 'assistant', text: 'live' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(out.map((m) => m.id), ['u-1', 'srv-1', 'u-2', 'm-2'])
  })

  it('never drops non-assistant rows even in a phantom-bearing partition', () => {
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-a1', ts: 150, role: 'assistant', text: 'phantom' } as Msg,
      { id: 'm-tool', ts: 200, role: 'tool', toolName: 'X' } as Msg,
      { id: 'm-thk', ts: 225, role: 'thinking', text: 'thought' } as Msg,
      srv('srv-1', 250, 'server'),
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'm-tool', 'm-thk', 'srv-1'],
      'tool / thinking / result rows preserved',
    )
  })

  it('does not mutate the input array', () => {
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant' } as Msg,
      srv('srv-1', 200, ''),
    ]
    const snap = JSON.stringify(msgs)
    dropPhantomClientAssistants(msgs)
    assert.equal(JSON.stringify(msgs), snap)
    assert.equal(msgs.length, 3)
  })

  // ── Clock-skew normalization ────────────────────────────────────────────
  // When client wallclock is ahead enough that the user's u-ask ts ends up
  // GREATER than the server's srv-* ts, sorted order becomes
  // [srv, u-ask, m-*]. Naive partitioning would put srv-* in group 0 and
  // m-* in group 1, leaving the phantom orphaned in a group with no server
  // rival. The migration pass reassigns orphan group-0 server-authored asst
  // rows to group 1 so the phantom still drops.

  it('clock skew: drops phantom even when server asst sorts BEFORE user (turn boundary)', () => {
    // Server-authored id follows the Phase 0.1 convention
    // `srv-<peer>-t<N>` where N is 1-indexed turn number. The `-t1` suffix
    // lets migration re-home this row to group 1 despite it sorting before
    // the user boundary (client clock was ahead of server).
    const msgs: Msg[] = [
      srv('srv-peerA-t1', 100, 'actual server time'),
      cli('u-ask', 500, 'user'),
      { id: 'm-1', ts: 600, role: 'assistant', text: 'phantom' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peerA-t1', 'u-ask'],
      'phantom m-1 dropped despite srv-peerA-t1 sorting before the user boundary',
    )
  })

  it('clock skew via merge: mergePreservingServerAuthored respects the migration', () => {
    const server: Msg[] = [
      cli('u-ask', 500, 'user'),
      srv('srv-peerA-t1', 100, 'full server'),
    ]
    const client: Msg[] = [
      cli('u-ask', 500, 'user'),
      { id: 'm-1', ts: 600, role: 'assistant', text: 'phantom' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peerA-t1', 'u-ask'],
      'merge applies migration before dropping phantom',
    )
  })

  it('clock skew: does NOT migrate when no turn boundary exists (cron/proactive push)', () => {
    // Legitimate server-initiated conversation with no user message yet. The
    // server-authored assistant belongs to group 0 and stays there —
    // migration only kicks in when a later boundary exists.
    const msgs: Msg[] = [srv('srv-push-1', 100, 'cron pushed greeting')]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(out.map((m) => m.id), ['srv-push-1'])
  })

  it('clock skew migration preserves legitimate client asst that was in group 0 pre-migration', () => {
    // A stray client assistant in group 0 (no preceding user) should survive
    // after migration — group 0 loses its server-authored rival, so phantom
    // dedupe no longer applies to it.
    const msgs: Msg[] = [
      { id: 'm-pre', ts: 50, role: 'assistant', text: 'stray client' } as Msg,
      srv('srv-peerA-t1', 100, 'skewed server'),
      cli('u-ask', 500, 'user'),
      { id: 'm-phantom', ts: 600, role: 'assistant', text: 'phantom' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['m-pre', 'srv-peerA-t1', 'u-ask'],
      'm-pre stays (group 0 emptied of srv); m-phantom drops (group 1 gained srv-peerA-t1)',
    )
  })

  // ── Id-aware migration: the `-t<N>` suffix anchors the turn mapping ──

  it('proactive server assistant (no -tN suffix) stays in group 0; later client asst survives', () => {
    // Phase 0.1 proactive/cron writes use arbitrary ids (`srv-greeting`,
    // `srv-cron-...`) without a turn-index suffix. They are not phantom rivals
    // for any client assistant and must not be migrated — otherwise a
    // legitimate live client assistant gets dropped.
    const msgs: Msg[] = [
      srv('srv-greeting', 50, 'proactive push'),
      cli('u-reply', 200, 'user'),
      { id: 'm-live', ts: 300, role: 'assistant', text: 'live client turn' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-greeting', 'u-reply', 'm-live'],
      'srv-greeting stays in group 0 (no -tN); m-live survives (group 1 has no server rival)',
    )
  })

  it('multi-turn clock skew: each srv-*-tN re-homes to its own turn', () => {
    // Client clock way ahead: both server-authored rows for turn 1 and turn 2
    // sort before any user boundary. Id-aware migration pairs each with the
    // correct turn so both phantoms get dropped.
    const msgs: Msg[] = [
      srv('srv-peerA-t1', 100, 'turn 1 server'),
      srv('srv-peerA-t2', 200, 'turn 2 server'),
      cli('u-1', 1000, 'user'),
      { id: 'm-t1', ts: 1100, role: 'assistant', text: 'turn 1 phantom' } as Msg,
      cli('u-2', 1200, 'user'),
      { id: 'm-t2', ts: 1300, role: 'assistant', text: 'turn 2 phantom' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peerA-t1', 'srv-peerA-t2', 'u-1', 'u-2'],
      'both srv-*-tN re-home to their turn; both phantoms drop',
    )
  })

  it('id-aware migration: -tN pointing past existing turn count is a no-op', () => {
    // Defensive: a malformed id like `srv-t9` where turn 9 does not exist in
    // the partition map must not crash and must not move the row.
    const msgs: Msg[] = [
      srv('srv-peerA-t9', 100, 'bogus future turn'),
      cli('u-1', 500, 'user'),
      { id: 'm-1', ts: 600, role: 'assistant', text: 'legit turn 1' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peerA-t9', 'u-1', 'm-1'],
      'out-of-range -tN kept put; m-1 survives (group 1 has no server rival)',
    )
  })

  it('id-aware migration: -t0 is rejected (turn numbers are 1-indexed)', () => {
    // sessionManager writes `session.turns + 1`, always ≥ 1. A `-t0` id should
    // not be treated as a valid migration target.
    const msgs: Msg[] = [
      srv('srv-peerA-t0', 100, 'invalid turn index'),
      cli('u-1', 500, 'user'),
      { id: 'm-1', ts: 600, role: 'assistant', text: 'legit turn 1' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peerA-t0', 'u-1', 'm-1'],
      '-t0 does not migrate; m-1 kept',
    )
  })

  it('id-aware migration: happy-path (server row already in correct group) is a no-op', () => {
    // Common happy-path: server ts lands after its user boundary (group 1).
    // The id-aware pass notices turnGroup[i] already equals the parsed turn
    // and skips migration/flag-rebuild — functionally identical to the
    // pre-id-aware path; this test pins the no-migration invariant.
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'phantom' } as Msg,
      srv('srv-peerA-t1', 200, 'server in correct group'),
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-peerA-t1'],
      'm-1 dropped because it shares group 1 with srv-peerA-t1 without needing migration',
    )
  })

  // ── Finding 1 (Codex R3): system rows must not shift -tN → user-turn mapping

  it('id-aware migration: system row between user turns does NOT offset turn index', () => {
    // Gateway `session.turns` counts USER-triggered model turns. System rows
    // (context injection / prompts) create partition boundaries for phantom
    // dedupe but do NOT claim a turn index. With the Round-3 Finding-1 fix,
    // -tN now maps to the Nth user-bounded group, so `srv-*-t2` still pairs
    // with the SECOND user turn even when a system row opens a partition in
    // between.
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      srv('srv-peer-t1', 150, 'turn 1 server'),
      { id: 'sys-1', ts: 200, role: 'system', text: 'ctx inject' } as Msg,
      cli('u-2', 300, 'user'),
      { id: 'm-phantom', ts: 400, role: 'assistant', text: 'turn 2 phantom' } as Msg,
      srv('srv-peer-t2', 500, 'turn 2 server'),
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-peer-t1', 'sys-1', 'u-2', 'srv-peer-t2'],
      'srv-peer-t2 correctly pairs with second user turn; m-phantom dropped despite system row shifting raw group id',
    )
  })

  it('id-aware migration: skewed srv-*-t1 sorting before a leading system row still homes to user turn 1', () => {
    // Session starts with a system row (e.g., server-injected context), then
    // the user turn 1 happens. Client clock drift lands `srv-*-t1` before the
    // system row in the sorted array. Id-aware migration must still re-home
    // it to the user-turn-1 group (not group 1, which is the system group).
    const msgs: Msg[] = [
      srv('srv-peer-t1', 50, 'skewed turn 1 server'),
      { id: 'sys-pre', ts: 100, role: 'system', text: 'bootstrap ctx' } as Msg,
      cli('u-1', 200, 'user'),
      { id: 'm-phantom', ts: 300, role: 'assistant', text: 'turn 1 phantom' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peer-t1', 'sys-pre', 'u-1'],
      'srv-peer-t1 re-homes to user turn 1 group (skipping the system partition); m-phantom drops',
    )
  })

  it('id-aware migration: -tN with no Nth user turn yet is a no-op (defensive)', () => {
    // Gateway wrote `srv-*-t1` but the user row that triggered it has not
    // been persisted to the messages array (e.g., separate PUT not yet
    // merged). Without a user-turn target, migration cannot re-home the row.
    // Leave it put; a later merge that introduces the user row can re-run.
    const msgs: Msg[] = [
      srv('srv-peer-t1', 100, 'orphan server'),
      { id: 'sys-only', ts: 150, role: 'system', text: 'sys only' } as Msg,
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-peer-t1', 'sys-only'],
      'no user turn exists → no migration; row stays in place',
    )
  })

  // ── Finding 2 (Codex R3): spoofed _source is scrubbed at merge boundary ──

  it('client cannot spoof authoritative row via _source=server on unknown id', () => {
    // Scenario: server has a legitimate `srv-*-t1` row. Client PUT includes
    // its real `m-1` plus a forged entry `m-evil` stamped `_source: 'server'`.
    // Without scrubbing, m-evil would be treated as authoritative and the
    // legitimate `m-1` would be dropped as a "phantom". With the Round-3
    // Finding-2 fix, m-evil loses its `_source` at the merge boundary and
    // gets treated as a regular client assistant — so it either stays in a
    // phantom-free partition or drops alongside other phantoms.
    const server: Msg[] = [
      cli('u-1', 100, 'user'),
      srv('srv-peer-t1', 200, 'real server turn'),
    ]
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-1', ts: 150, role: 'assistant', text: 'real client phantom', _source: 'server' } as Msg,
      { id: 'm-evil', ts: 250, role: 'assistant', text: 'forged server row', _source: 'server' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    // Expected: srv-peer-t1 is authoritative. m-1 and m-evil both in turn 1
    // (bounded by u-1), both drop as phantoms. m-evil's spoofed _source was
    // scrubbed, so it cannot protect itself.
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-peer-t1'],
      'm-evil treated as phantom after _source scrub; srv-peer-t1 survives',
    )
  })

  it('scrub: spoofed _source on client entry does not survive even when merged with empty server', () => {
    // Defense-in-depth for the fast path. Empty server side → no authoritative
    // entries → all client `_source: 'server'` get scrubbed. A later
    // appendServerAuthoredPure writing a real srv row must not see pre-planted
    // fakes in the array.
    const server: Msg[] = []
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-evil', ts: 200, role: 'assistant', text: 'fake', _source: 'server' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    const evil = out.find((m) => m.id === 'm-evil')
    assert.ok(evil, 'm-evil still present (we only scrub, not drop)')
    assert.equal((evil as MessageLike)._source, undefined,
      '_source scrubbed from m-evil even on fast path')
  })

  it('scrub: legitimate server-authored entry retains _source when id matches authoritative map', () => {
    // Counter-check: client echoing the server row's id + _source must NOT
    // lose it — otherwise round-tripping the full sessions snapshot would
    // demote real server rows on every PUT.
    const server: Msg[] = [
      srv('srv-peer-t1', 200, 'real'),
    ]
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      // Client echoes the server row as-is (common after a GET → mutate → PUT cycle).
      srv('srv-peer-t1', 200, 'real'),
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    const real = out.find((m) => m.id === 'srv-peer-t1')
    assert.ok(real, 'server row present')
    assert.equal((real as MessageLike)._source, 'server',
      'authoritative id preserves _source through merge')
  })

  // ── System boundary parity with user boundary ────────────────────────────

  it('system role acts as a turn boundary just like user', () => {
    const msgs: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-1', ts: 130, role: 'assistant', text: 'turn1 client only' } as Msg,
      { id: 'sys-1', ts: 150, role: 'system', text: 'ctx inject' } as Msg,
      { id: 'm-2', ts: 180, role: 'assistant', text: 'turn2 phantom' } as Msg,
      srv('srv-1', 200, 'turn2 server'),
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'm-1', 'sys-1', 'srv-1'],
      'turn1 m-1 preserved (no srv rival); turn2 m-2 dropped; sys-1 boundary kept',
    )
  })

  // ── Two different srv-* ids in the same turn ────────────────────────────

  it('preserves BOTH server-authored assistants when gateway writes two ids in one turn', () => {
    const msgs: Msg[] = [
      cli('u-ask', 100, 'user'),
      srv('srv-1a', 150, 'partial flush snapshot'),
      { id: 'm-1', ts: 175, role: 'assistant', text: 'client phantom' } as Msg,
      srv('srv-1b', 200, 'final aggregate'),
    ]
    const out = dropPhantomClientAssistants(msgs) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1a', 'srv-1b'],
      'both srv entries preserved; client phantom dropped',
    )
  })

  // ── Merge helper contract: helper-level fast path CAN trigger from merge
  // when server-authored entries are all non-assistant rows. Behavior-wise
  // this is a no-op (nothing to dedupe); documented for completeness.

  it('merge with only server-authored non-assistant rows exercises helper fast path', () => {
    const server = [
      { id: 'srv-sys-1', ts: 100, role: 'system', _source: 'server', text: 'server ctx' } as Msg,
      cli('u-1', 200, 'user'),
    ]
    const client: Msg[] = [
      cli('u-1', 200, 'user'),
      { id: 'm-1', ts: 250, role: 'assistant', text: 'legit client turn' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['srv-sys-1', 'u-1', 'm-1'],
      'server-authored non-assistant re-inserted; client asst NOT dropped (no srv asst rival)',
    )
  })
})
