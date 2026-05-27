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

const srvThinking = (id: string, ts: number, text = ''): Msg => ({
  id,
  role: 'thinking',
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

const plan = (
  id: string,
  ts: number,
  blockId: string,
  statuses: string[],
  extra: Record<string, unknown> = {},
): Msg => ({
  id,
  role: 'plan',
  ts,
  blockId,
  steps: statuses.map((status, idx) => ({ step: `step-${idx + 1}`, status })),
  ...extra,
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

  it('dedupes duplicate client plan rows with the same blockId inside one turn even without server-authored rows', () => {
    const client: Msg[] = [
      cli('u1', 100),
      plan('p-partial', 210, 'codex-plan-t1', ['completed', 'pending'], {
        _partial: true,
        completedAt: 210,
      }),
      plan('p-final', 200, 'codex-plan-t1', ['completed', 'completed'], {
        _partial: false,
        completedAt: 300,
      }),
    ]

    const out = mergePreservingServerAuthored([] as Msg[], client) as Msg[]
    assert.notEqual(out, client, 'duplicate plan cleanup must bypass the no-copy fast path')
    assert.deepEqual(out.map((m) => m.id), ['u1', 'p-final'])
  })

  it('preserves same legacy plan blockId across different user turns', () => {
    const client: Msg[] = [
      cli('u1', 100),
      plan('p-turn-1', 200, 'codex-plan', ['completed']),
      cli('u2', 300),
      plan('p-turn-2', 400, 'codex-plan', ['pending']),
    ]

    const out = mergePreservingServerAuthored([] as Msg[], client)
    assert.equal(out, client, 'cross-turn legacy blockIds are not duplicates')
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

  // ── Phase 0.4: thinking phantom dedupe ──────────────────────────────────
  // Sonnet 4.6 emits thinking blocks before the assistant text. Server
  // persists thinking and assistant as two separate rows (role='thinking'
  // ts=baseTs-1; role='assistant' ts=baseTs). Mobile-bg can leave the
  // client with phantom thinking-only entries that must be dropped when
  // the server's thinking row arrives.

  it('Phase 0.4: drops client phantom thinking when server thinking lands', () => {
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvThinking('srv-1-thinking', 199, 'server reasoning'),
      srv('srv-1', 200, 'server answer'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-think-1', ts: 150, role: 'thinking', text: 'partial thinking' } as Msg,
      { id: 'm-asst-1', ts: 180, role: 'assistant', text: 'partial answer' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1-thinking', 'srv-1'],
      'both phantom thinking + phantom assistant dropped, server pair kept',
    )
  })

  it('Phase 0.4: independent role flags — drops phantom thinking but keeps client assistant when server has thinking-only', () => {
    // Edge case: server persisted thinking but assistant write threw and
    // sink dropped the assistant frame (extreme storage failure). Client
    // assistant phantom must be preserved (no server rival), thinking
    // phantom must be dropped.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvThinking('srv-1-thinking', 199, 'server reasoning'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-think-1', ts: 150, role: 'thinking', text: 'partial thinking' } as Msg,
      { id: 'm-asst-1', ts: 200, role: 'assistant', text: 'client answer' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1-thinking', 'm-asst-1'],
      'phantom thinking dropped, client assistant preserved (no server rival)',
    )
  })

  it('Phase 0.4: independent role flags — drops phantom assistant but keeps client thinking when server has assistant-only', () => {
    // Server-authored assistant only (no thinking emitted by model).
    // Client got a phantom from a different code path (e.g. tool-use
    // reflection that landed as role=thinking). Symmetry test for the
    // independent-flag design.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srv('srv-1', 200, 'server answer'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'm-think-1', ts: 150, role: 'thinking', text: 'client thinking' } as Msg,
      { id: 'm-asst-1', ts: 180, role: 'assistant', text: 'partial' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'm-think-1', 'srv-1'],
      'phantom assistant dropped, client thinking preserved (no server rival)',
    )
  })

  it('Phase 0.4: thinking dedupe stays within turn group — different turns are independent', () => {
    // Turn 1 has server-authored thinking → drop client phantom thinking.
    // Turn 2 has only client thinking (still in-progress) → preserve it.
    const server: Msg[] = [
      cli('u-1', 100, 'user'),
      srvThinking('srv-1-thinking', 199, 'turn1 reasoning'),
      srv('srv-1', 200, 'turn1 answer'),
      cli('u-2', 300, 'user'),
    ]
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      { id: 'm-think-1', ts: 150, role: 'thinking', text: 'turn1 partial' } as Msg,
      cli('u-2', 300, 'user'),
      { id: 'm-think-2', ts: 350, role: 'thinking', text: 'turn2 thinking' } as Msg,
      { id: 'm-asst-2', ts: 400, role: 'assistant', text: 'turn2 answer' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-1-thinking', 'srv-1', 'u-2', 'm-think-2', 'm-asst-2'],
      'turn1 phantom thinking dropped, turn2 client thinking preserved',
    )
  })

  it('Phase 0.4: replaces client thinking with server thinking when ids match', () => {
    // Mobile-bg may have streamed partial thinking and stored it under the
    // server's id (reconnection raced with server frame). Server-wins:
    // server's full text replaces the client truncated text.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvThinking('srv-1-thinking', 199, 'full server reasoning'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      { id: 'srv-1-thinking', ts: 199, role: 'thinking', text: 'truncated' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    const found = out.find((m) => m.id === 'srv-1-thinking')!
    assert.equal(found.text, 'full server reasoning', 'server text replaces client truncated')
    assert.equal(found._source, 'server')
  })

  // ── Phase 1: tool phantom dedupe (rule 6) ───────────────────────────────
  // Server's v3 sink writes one `_source:'server'` row per completed top-level
  // tool call with stable id `srv-${sessionId}-t${turnIndex}-tool-${blockId}`.
  // Client's `m-*` tool rows share the same `blockId` but different ids, so
  // id-based dedupe (rule 1) doesn't catch them. Rule 6 dedupes by blockId
  // within the same turn group.

  const srvTool = (id: string, ts: number, blockId: string, toolName: string, output = ''): Msg => ({
    id,
    role: 'tool',
    text: output,
    ts,
    _source: 'server',
    blockId,
    toolName,
    output,
    _completed: true,
  } as Msg)

  const cliTool = (id: string, ts: number, blockId: string, toolName: string): Msg => ({
    id,
    role: 'tool',
    text: toolName,
    ts,
    blockId,
    toolName,
  } as Msg)

  it('Phase 1: drops client tool when server tool with same blockId exists in same turn group', () => {
    // After turn-end the sink wrote rich srv tool row; client's bare m-* tool
    // row (post-PUT-strip) is still in IDB. Same blockId → dedupe.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvTool('srv-1-tool-blk-A', 198, 'blk-A', 'Bash', 'hello\n'),
      srv('srv-1', 200, 'all done'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      cliTool('m-tool-1', 150, 'blk-A', 'Bash'),
      { id: 'm-asst-1', ts: 180, role: 'assistant', text: 'partial' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1-tool-blk-A', 'srv-1'],
      'client phantom tool dropped, server tool kept; phantom assistant also dropped (rule 3)',
    )
    const tool = out.find((m) => m.id === 'srv-1-tool-blk-A')!
    assert.equal(tool.output, 'hello\n')
    assert.equal(tool._source, 'server')
    assert.equal(tool._completed, true)
  })

  it('Phase 1: keeps client tool when server tool has different blockId (different call)', () => {
    // Two tool calls in same turn; server only persisted blk-A but blk-B
    // somehow lacks a server row (race / cap drop). Client tool blk-B must
    // survive — it is the only record of that call. Output is ts-sorted, so
    // m-tool-B (ts=160) precedes the later server row (ts=198).
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvTool('srv-1-tool-blk-A', 198, 'blk-A', 'Bash', 'A out'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      cliTool('m-tool-A', 150, 'blk-A', 'Bash'),
      cliTool('m-tool-B', 160, 'blk-B', 'Read'),
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'm-tool-B', 'srv-1-tool-blk-A'],
      'blk-A client tool deduped; blk-B client tool preserved (no server rival)',
    )
  })

  it('Phase 1: dedupe stays within turn group — same blockId in different turns is independent', () => {
    // Pathological but defendable: same blockId reused across turns. Server
    // only wrote blk-A in turn 1; turn 2 client tool with blk-A must be kept.
    const server: Msg[] = [
      cli('u-1', 100, 'user'),
      srvTool('srv-1-tool-blk-A', 198, 'blk-A', 'Bash', 'turn1 out'),
      srv('srv-1', 200, 'turn1 done'),
      cli('u-2', 300, 'user'),
    ]
    const client: Msg[] = [
      cli('u-1', 100, 'user'),
      cliTool('m-tool-1', 150, 'blk-A', 'Bash'),
      cli('u-2', 300, 'user'),
      cliTool('m-tool-2', 350, 'blk-A', 'Bash'),
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-1', 'srv-1-tool-blk-A', 'srv-1', 'u-2', 'm-tool-2'],
      'turn1 client tool deduped; turn2 client tool preserved (different group)',
    )
  })

  it('Phase 1: keeps client tool with no blockId (legacy / pre-allowlist row)', () => {
    // Pre-Phase-1 PUTs stripped blockId, so legacy IDB rows lack it. We can't
    // dedupe these — better to render a doubled card on rare legacy data
    // than to silently drop user-visible content wholesale. ts-sorted output
    // places legacy (ts=150) before the server row (ts=198).
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvTool('srv-1-tool-blk-A', 198, 'blk-A', 'Bash', 'out'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      // Legacy row: no blockId field
      { id: 'm-legacy', ts: 150, role: 'tool', text: 'Bash', toolName: 'Bash' } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'm-legacy', 'srv-1-tool-blk-A'],
      'legacy client tool preserved (no blockId to match)',
    )
  })

  it('Phase 1: never drops a server-authored tool entry', () => {
    // Defensive: even if there's a (theoretically impossible) duplicate
    // server-authored tool in the same group, both stay. Server is
    // authoritative — the merge must never silently lose its data.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvTool('srv-1-tool-A1', 197, 'blk-A', 'Bash', 'first'),
      srvTool('srv-1-tool-A2', 198, 'blk-A', 'Bash', 'second'),
    ]
    const client: Msg[] = [cli('u-ask', 100, 'user')]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1-tool-A1', 'srv-1-tool-A2'],
      'both server tool entries preserved (rule 1 wins; rule 6 only drops client)',
    )
  })

  it('Phase 1: dedupe is idempotent (replay yields same result)', () => {
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      srvTool('srv-1-tool-blk-A', 198, 'blk-A', 'Bash', 'out'),
      srv('srv-1', 200, 'done'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      cliTool('m-tool-1', 150, 'blk-A', 'Bash'),
      { id: 'm-asst-1', ts: 180, role: 'assistant', text: 'partial' } as Msg,
    ]
    const once = mergePreservingServerAuthored(server, client) as Msg[]
    const twice = mergePreservingServerAuthored(server, once) as Msg[]
    assert.deepEqual(twice.map((m) => m.id), once.map((m) => m.id))
  })

  it('Phase 1: server tool wins over client tool with conflicting status (server is authoritative)', () => {
    // Real-world conflict: client recorded tool as failed (status='error',
    // isError-style ephemeral) before tool_result arrived; server's durable
    // copy carries the actual outcome (success). Rule 6 must drop the
    // client row regardless of status field, so the user sees the
    // server-authoritative outcome on refresh — not a stale failure.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      // Server's durable: success
      srvTool('srv-1-tool-blk-A', 198, 'blk-A', 'Bash', 'success output'),
      srv('srv-1', 200, 'done'),
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      // Client's optimistic row: marked as failed
      {
        id: 'm-tool-A',
        ts: 150,
        role: 'tool',
        text: 'Bash',
        blockId: 'blk-A',
        toolName: 'Bash',
        status: 'error',
        error: 'transient client view',
      } as Msg,
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    assert.deepEqual(
      out.map((m) => m.id),
      ['u-ask', 'srv-1-tool-blk-A', 'srv-1'],
      'client error-status row deduped; server success row authoritative',
    )
    const tool = out.find((m) => m.id === 'srv-1-tool-blk-A')!
    assert.equal(tool.output, 'success output')
    assert.equal(tool._source, 'server')
    // Client's status='error' must NOT leak onto the server row
    assert.equal((tool as Msg & { status?: string }).status, undefined)
    assert.equal((tool as Msg & { error?: string }).error, undefined)
  })

  it('Phase 1: ignores server tool entries with empty/non-string blockId (defensive)', () => {
    // Pathological server data (corrupt blob, future schema). The dedupe
    // key registration tolerates this and falls through — affected client
    // tools render normally.
    const server: Msg[] = [
      cli('u-ask', 100, 'user'),
      // empty blockId
      { id: 'srv-bad-1', role: 'tool', text: '', ts: 198, _source: 'server', blockId: '' } as Msg,
      // non-string blockId
      { id: 'srv-bad-2', role: 'tool', text: '', ts: 199, _source: 'server', blockId: 42 } as Msg,
    ]
    const client: Msg[] = [
      cli('u-ask', 100, 'user'),
      cliTool('m-tool-1', 150, '', 'Bash'),
      cliTool('m-tool-2', 160, 'blk-B', 'Read'),
    ]
    const out = mergePreservingServerAuthored(server, client) as Msg[]
    // Server entries always win (rule 1). Client tools survive because
    // server has no matchable blockId for them.
    const ids = out.map((m) => m.id)
    assert.ok(ids.includes('srv-bad-1'))
    assert.ok(ids.includes('srv-bad-2'))
    assert.ok(ids.includes('m-tool-1'))
    assert.ok(ids.includes('m-tool-2'))
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

  // ── v7 takeover overlay (2026-05-12) ──
  // Same-id collision with a client-placeholder row (no `_source: 'server'`)
  // must REPLACE the placeholder at its position with the server-authored
  // version. Pre-v7 this branch returned `already_exists` (which still applies
  // for true server-authored idempotent replays).

  it('TAKEOVER: replaces client-placeholder row at same id with server-authored version', () => {
    // Client streaming placeholder PUT'd to client_sessions before turn-end
    // takeover lands. Same canonical srv-* id, but no _source flag and
    // partial text.
    const placeholder: Msg = {
      id: 'srv-peer1-t1',
      role: 'assistant',
      text: 'streaming…',
      ts: 200,
    }
    const existing: Msg[] = [cli('u1', 100), placeholder]
    const takeover: Msg = {
      id: 'srv-peer1-t1',
      role: 'assistant',
      text: 'final canonical text',
      ts: 200,
    }
    const result = appendServerAuthoredPure(existing, takeover)
    assert.equal(result.applied, true, 'applied (not already_exists)')
    if (!result.applied) return
    assert.equal(result.messages.length, 2, 'no duplicate row')
    const replaced = result.messages.find((m) => m.id === 'srv-peer1-t1')!
    assert.equal(replaced._source, 'server', 'stamped with server _source')
    assert.equal(replaced.text, 'final canonical text', 'text replaced by takeover')
  })

  it('TAKEOVER: preserves placeholder ts when takeover ts is missing', () => {
    // Server-authored message lacks ts (e.g. defaulted). Stamping logic
    // should fall back to existing placeholder ts so the canonical row
    // stays in its original chronological position.
    const placeholder: Msg = {
      id: 'srv-peer1-t2',
      role: 'assistant',
      text: 'placeholder',
      ts: 333,
    }
    const existing: Msg[] = [cli('u1', 100), placeholder, cli('u2', 500)]
    const takeover = { id: 'srv-peer1-t2', role: 'assistant', text: 'final' } as Msg
    const result = appendServerAuthoredPure(existing, takeover, /* now */ 999_999)
    assert.equal(result.applied, true)
    if (!result.applied) return
    const replaced = result.messages.find((m) => m.id === 'srv-peer1-t2')!
    assert.equal(replaced.ts, 333, 'inherited placeholder ts (not now)')
    // Order maintained: u1 (100), srv-... (333), u2 (500)
    assert.deepEqual(result.messages.map((m) => m.id), ['u1', 'srv-peer1-t2', 'u2'])
  })

  it('TAKEOVER: still idempotent against true server-authored same-id row', () => {
    // Distinguishing case: existing row IS server-authored. Treat as
    // already_exists (no clobber of canonical authoritative content).
    const existing: Msg[] = [cli('u1', 100), srv('srv-peer1-t1', 200, 'canonical')]
    const replay: Msg = {
      id: 'srv-peer1-t1',
      role: 'assistant',
      text: 'duplicate write attempt',
      ts: 999,
    }
    const result = appendServerAuthoredPure(existing, replay)
    assert.equal(result.applied, false, 'still rejects true server-authored duplicate')
    if (result.applied) return
    assert.equal(result.reason, 'already_exists')
  })

  it('TAKEOVER: does not mutate existing array on overlay path', () => {
    const placeholder: Msg = {
      id: 'srv-peer1-t1',
      role: 'assistant',
      text: 'streaming',
      ts: 200,
    }
    const existing: Msg[] = [cli('u1', 100), placeholder]
    const snap = JSON.stringify(existing)
    appendServerAuthoredPure(existing, {
      id: 'srv-peer1-t1', role: 'assistant', text: 'final', ts: 200,
    } as Msg)
    assert.equal(JSON.stringify(existing), snap, 'existing untouched')
    assert.equal(existing[1].text, 'streaming', 'placeholder unchanged in place')
  })
})
