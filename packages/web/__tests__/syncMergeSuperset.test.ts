/**
 * Unit tests for the symmetric server/local message merger added in
 * 2026-05-12 to fix the mobile streaming-tail flash + doubled-final-response
 * bug (boss session mp2n3df0-pymb4uzl, post v1.0.132 regression).
 *
 * Covers:
 *   - _overlayServerAuthoritative: ref preservation on no-change /
 *     fresh object on change semantics (load-bearing for WeakMap-keyed
 *     DOM reconcile)
 *   - _mergeServerAuthoredIntoLocal: the canonical merger used by sync.js's
 *     full-fetch / partial-fetch / 409 local-dominates / 409 server-wins
 *     paths. Mirrors server-side mergePreservingServerAuthored
 *     (sessionsDb.ts:756) so client + server converge on identical shapes.
 *   - _rebuildBlockMaps: tool/agent-group lazy-map eager rebuild after a
 *     sync replaces sess.messages
 *
 * Run: npx tsx --test packages/web/__tests__/syncMergeSuperset.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

// Manually inlined module-level constants the helpers reference. Kept in
// lock-step with sync.js — when these change there, change here too.
// (sync.js's constants are not `export`ed and live outside any function
// so extractTopLevelFn can't reach them.)
const _SERVER_AUTH_KEYS_DECL =
  "const _SERVER_AUTH_KEYS = ['_seq', '_source', 'usage', '_truncated', '_errorCode', '_errorDetail'];"

const _combined =
  _SERVER_AUTH_KEYS_DECL +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_stableStringify') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_overlayServerAuthoritative') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_mergeServerAuthoredIntoLocal') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_rebuildBlockMaps')

const _helpers = new Function(
  `${_combined}; return {
    _overlayServerAuthoritative,
    _mergeServerAuthoredIntoLocal,
    _rebuildBlockMaps,
    _localMessageSupersedes,
  };`,
)() as {
  _overlayServerAuthoritative: (l: any, s: any) => any
  _mergeServerAuthoredIntoLocal: (s: any[], l: any[]) => any[]
  _rebuildBlockMaps: (sess: any) => void
  _localMessageSupersedes: (l: any, s: any) => boolean
}
const {
  _overlayServerAuthoritative,
  _mergeServerAuthoredIntoLocal,
  _rebuildBlockMaps,
} = _helpers

// ═══════════════════════════════════════════════════════════════════
// _overlayServerAuthoritative
// ═══════════════════════════════════════════════════════════════════

describe('_overlayServerAuthoritative', () => {
  it('returns SAME ref when no server-auth field differs (WeakMap fast path)', () => {
    const local = { id: 'a', role: 'assistant', text: 'hi', _seq: 5, usage: { in: 1 } }
    const server = { id: 'a', role: 'assistant', text: 'hi', _seq: 5, usage: { in: 1 } }
    // usage is a different object but its outer ref equality is checked
    // via `!==` — since they're different object instances the overlay
    // SHOULD trigger. This documents that nested-equality is NOT done.
    const result = _overlayServerAuthoritative(local, server)
    assert.notEqual(result, local, 'object-typed fields compared by ref → overlay applies')
    assert.equal(result.usage, server.usage)
  })

  it('returns SAME ref when truly nothing differs', () => {
    const local = { id: 'a', role: 'assistant', text: 'hi', _seq: 5 }
    const server = { id: 'a', role: 'assistant', text: 'hi', _seq: 5 }
    const result = _overlayServerAuthoritative(local, server)
    assert.equal(result, local, 'no diff → same reference')
  })

  it('returns fresh object when _seq differs', () => {
    const local = { id: 'a', role: 'assistant', text: 'longer text', _seq: 3 }
    const server = { id: 'a', role: 'assistant', text: 'longer', _seq: 5 }
    const result = _overlayServerAuthoritative(local, server)
    assert.notEqual(result, local, 'changed → fresh object')
    assert.equal(result._seq, 5)
    assert.equal(result.text, 'longer text', 'local text preserved')
  })

  it('overlays status only when server is server-authored', () => {
    const local = { id: 'a', role: 'assistant', status: undefined, _source: 'client' }
    const server = { id: 'a', role: 'assistant', status: 'completed', _source: 'server' }
    const result = _overlayServerAuthoritative(local, server)
    assert.equal(result.status, 'completed')
  })

  it('does NOT overlay status when server lacks _source==="server"', () => {
    const local = { id: 'a', role: 'user', status: 'sent' }
    const server = { id: 'a', role: 'user', status: 'read' } // no _source
    const result = _overlayServerAuthoritative(local, server)
    assert.equal(result, local, 'client status protected — no overlay')
    assert.equal(result.status, 'sent')
  })

  it('handles missing local / server gracefully', () => {
    assert.equal(_overlayServerAuthoritative(null, { id: 'a' }), null)
    const l = { id: 'a' }
    assert.equal(_overlayServerAuthoritative(l, null), l)
  })
})

// ═══════════════════════════════════════════════════════════════════
// _mergeServerAuthoredIntoLocal
// ═══════════════════════════════════════════════════════════════════

const M = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  role,
  text,
  ts: 1_700_000_000_000,
  ...extra,
})

describe('_mergeServerAuthoredIntoLocal', () => {
  // Common timestamps used to control ts-sort order. Higher = later.
  const T0 = 1_700_000_000_000
  const T1 = T0 + 100
  const T2 = T0 + 200
  const T3 = T0 + 300
  const T4 = T0 + 400

  it('returns server-only timeline when local is empty', () => {
    const server = [M('a', 'user', 'hi', { ts: T0 }), M('b', 'assistant', 'hello', { ts: T1, _source: 'server' })]
    const merged = _mergeServerAuthoredIntoLocal(server, [])
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['a', 'b'],
    )
    // Server rows are kept as-is (same refs)
    assert.equal(merged[0], server[0])
  })

  it('FAST PATH: empty server returns slice of local without reorder', () => {
    // Codex v5 constraint 1: server.length === 0 must NOT reorder local
    // (a caller may have just appended an id-less message with no ts).
    const local = [
      { id: 'b', role: 'assistant', text: 'y', ts: T2 },
      { id: 'a', role: 'user', text: 'x', ts: T0 },  // out-of-order on purpose
    ]
    const merged = _mergeServerAuthoredIntoLocal([], local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['b', 'a'],
      'order preserved (no ts-sort on empty-server fast path)',
    )
    assert.notEqual(merged, local, 'returns a fresh slice (callers can mutate)')
  })

  it('keeps local ref when text is identical (WeakMap fast path)', () => {
    const local = [M('a', 'user', 'hi', { _seq: 1, ts: T0 })]
    const server = [M('a', 'user', 'hi', { _seq: 1, ts: T0 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged[0], local[0], 'no-change → same local ref preserved')
  })

  it('keeps local with streaming extension (assistant text longer than server)', () => {
    const local = [M('a', 'assistant', 'hello world streaming…', { _seq: 5, ts: T1 })]
    const server = [M('a', 'assistant', 'hello world', { _seq: 5, ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // local supersedes (prefix match) → keep local text, overlay server-auth
    assert.equal(merged[0].text, 'hello world streaming…')
  })

  it('overlays server-authoritative fields onto local-supersede winner', () => {
    const local = [M('a', 'assistant', 'streaming text', { _seq: 3, ts: T1 })]
    const server = [M('a', 'assistant', 'streaming text', { _seq: 5, usage: { in: 10 }, ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.notEqual(merged[0], local[0], '_seq diff → fresh object')
    assert.equal(merged[0]._seq, 5)
    assert.equal(merged[0].usage.in, 10)
    assert.equal(merged[0].text, 'streaming text')
  })

  it('server wins when local does not supersede (e.g. server text longer)', () => {
    const local = [M('a', 'assistant', 'short', { _seq: 1, ts: T1 })]
    const server = [M('a', 'assistant', 'short and then some more', { _seq: 2, ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged[0], server[0])
    assert.equal(merged[0].text, 'short and then some more')
  })

  // ── In-flight streaming preservation ──
  // The primary case the merger must handle: server tape hasn't yet
  // authored a Phase 0.1 takeover row for an in-flight assistant message.
  // Client `m-…` should remain visible until the takeover lands.

  it('IN-FLIGHT: preserves local-only assistant when server has no takeover', () => {
    const local = [
      M('u1', 'user', 'question', { ts: T0 }),
      M('m-stream', 'assistant', 'partial reply…', { ts: T1 }),
    ]
    // Server has only the user message — Phase 0.1 takeover not yet fired.
    const server = [M('u1', 'user', 'question', { ts: T0 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'm-stream'],
    )
    assert.equal(merged[1], local[1], 'in-flight tail preserved by ref')
  })

  it('IN-FLIGHT: preserves multiple client-only rows (thinking + assistant)', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-think', 'thinking', 'thinking…', { ts: T1 }),
      M('m-asst', 'assistant', 'replying…', { ts: T2 }),
    ]
    const server = [M('u1', 'user', 'q', { ts: T0 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'm-think', 'm-asst'],
    )
  })

  // ── Phase 0.1 takeover convergence ──
  // When server mints `srv-…` row with different id from client `m-…`,
  // step 1 doesn't catch the substitution. Turn-group dedupe (step 4)
  // drops the client phantom.

  it('TAKEOVER: drops client assistant phantom when server takeover exists in same turn', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-asst', 'assistant', 'partial', { ts: T1 }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-asst', 'assistant', 'final canonical text', { ts: T2, _source: 'server', _seq: 1 }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'srv-asst'],
      'client m-asst phantom dropped, server srv-asst kept',
    )
    assert.equal(merged[1].text, 'final canonical text')
  })

  it('TAKEOVER: drops client thinking phantom when server takeover exists', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-think', 'thinking', 'partial thinking', { ts: T1 }),
      M('m-asst', 'assistant', 'partial', { ts: T2 }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-think', 'thinking', 'full thinking', { ts: T3, _source: 'server' }),
      M('srv-asst', 'assistant', 'final', { ts: T4, _source: 'server' }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'srv-think', 'srv-asst'],
    )
  })

  it('TAKEOVER: drops client tool phantom only when server tool has matching blockId', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool', 'tool', 'output', { ts: T1, blockId: 'tool-block-1' }),
      M('m-tool2', 'tool', 'other output', { ts: T2, blockId: 'tool-block-2' }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      // Server takeover only covers tool-block-1
      M('srv-tool-1', 'tool', 'server output', { ts: T3, _source: 'server', blockId: 'tool-block-1' }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // m-tool dropped (matching blockId server takeover), m-tool2 retained
    assert.deepEqual(
      merged.map((m: any) => m.id).sort(),
      ['m-tool2', 'srv-tool-1', 'u1'].sort(),
    )
  })

  it('TAKEOVER: tool without blockId is preserved (legacy / pre-allowlist-strip rows)', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool-legacy', 'tool', 'output', { ts: T1 }),  // NO blockId
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-tool', 'tool', 'srv output', { ts: T2, _source: 'server', blockId: 'tool-b' }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // Legacy client tool kept (no blockId → can't match server's blockId)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'm-tool-legacy', 'srv-tool'],
    )
  })

  // ── Cross-tab user messages ──
  // Codex v5 constraint: server has user message from another tab AND no
  // server-authored asst yet — server's user-X must NOT be dropped just
  // because it lacks `_source==='server'`.

  it('CROSS-TAB: brings in server-only user message (lacks _source==="server")', () => {
    const local = [
      M('u1', 'user', 'first', { ts: T0 }),
      M('m-asst', 'assistant', 'replying…', { ts: T1 }),
    ]
    const server = [
      M('u1', 'user', 'first', { ts: T0 }),
      M('u2-other-tab', 'user', 'cross-tab message', { ts: T2 }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // u1, m-asst (preserved local-only between u1 and u2), u2-other-tab.
    // Turn-group dedupe: group 1 (after u1, before u2) has client m-asst
    // and no server asst → m-asst kept. group 2 (after u2-other-tab) empty.
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'm-asst', 'u2-other-tab'],
    )
  })

  // ── Ordering / sort ──

  it('SORT: cross-tab user b inserts between a and m-asst → m-asst keeps anchor=a, NOT dropped', () => {
    // v6 fix for Codex round 2 HIGH 2: positional turn-group dedupe in v5
    // incorrectly attributed `m-asst` to turn `b-other-tab` after ts-sort,
    // dropping it. v6 uses ANCHOR-AWARE dedupe via id-membership:
    //   - m-asst is local-only → local anchor (preceding user in LOCAL) = `a`
    //   - srv-asst-b is server-known → server anchor (preceding user in SERVER)
    //     = `b-other-tab`
    //   - Different anchors → m-asst NOT deduped.
    const local = [
      M('a', 'user', 'q1', { ts: T0 }),
      M('m-asst', 'assistant', 'partial-a', { ts: T2 }),  // no _seq (in-flight)
    ]
    const server = [
      M('a', 'user', 'q1', { ts: T0 }),
      M('b-other-tab', 'user', 'q2', { ts: T1 }),  // INSERTED between a and m-asst (ts-wise)
      M('srv-asst-b', 'assistant', 'reply-b', { ts: T3, _source: 'server' }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // ts-sort: a(T0), b-other-tab(T1), m-asst(T2), srv-asst-b(T3)
    // m-asst preserved because its turn affinity (anchor=a) differs from
    // srv-asst-b's anchor (b-other-tab). The client phantom for turn `a`
    // will be cleaned up later when server's Phase 0.1 takeover for turn a
    // lands and the server-authored asst at anchor=a triggers dedupe.
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['a', 'b-other-tab', 'm-asst', 'srv-asst-b'],
    )
  })

  // ── Cross-tab DELETE discriminator (v6) ──
  // Codex round 2 HIGH 1: v5 unconditionally preserved every local-only row,
  // resurrecting rows another tab had deleted (splice() + PUT). v6 uses
  // `_seq` as the "previously server-confirmed" discriminator.

  it('CROSS-TAB DELETE: drops local-only row with _seq that vanished from server', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0, _seq: 1 }),
      // Has _seq → server confirmed this row at some earlier sync.
      // Now absent from server response → another tab deleted it.
      M('a-deleted', 'assistant', 'was confirmed, now gone', { ts: T1, _seq: 2 }),
    ]
    const server = [M('u1', 'user', 'q', { ts: T0, _seq: 1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1'],
      'previously-confirmed row gone from server → drop (cross-tab delete)',
    )
  })

  it('CROSS-TAB DELETE: keeps local-only row WITHOUT _seq even when absent from server', () => {
    // The discriminator: no `_seq` means the row has never been server-
    // confirmed (still streaming / not yet PUT'd). Server's silence on it
    // is the EXPECTED state — preserve so UI doesn't flash mid-stream.
    const local = [
      M('u1', 'user', 'q', { ts: T0, _seq: 1 }),
      M('m-streaming', 'assistant', 'partial…', { ts: T1 }),  // no _seq
    ]
    const server = [M('u1', 'user', 'q', { ts: T0, _seq: 1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'm-streaming'],
      'no-_seq row preserved as in-flight (NOT a delete)',
    )
  })

  it('CROSS-TAB DELETE: keeps no-_seq tail even when server has its own newer turn', () => {
    // Mixed scenario: local has confirmed u1 + streaming m-asst (no _seq).
    // Cross-tab deleted u1's prior asst (which had _seq) AND added u2/srv-asst.
    // m-asst (no _seq) must still be preserved as a local-only in-flight tail.
    const local = [
      M('u1', 'user', 'q1', { ts: T0, _seq: 1 }),
      M('a-was-confirmed', 'assistant', 'gone now', { ts: T1, _seq: 2 }),  // deleted cross-tab
      M('m-asst', 'assistant', 'still streaming…', { ts: T4 }),  // no _seq, in-flight
    ]
    const server = [
      M('u1', 'user', 'q1', { ts: T0, _seq: 1 }),
      M('u2', 'user', 'q2', { ts: T2, _seq: 3 }),
      M('srv-asst-2', 'assistant', 'reply-2', { ts: T3, _seq: 4, _source: 'server' }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // a-was-confirmed dropped (had _seq, vanished). m-asst preserved (no _seq).
    // m-asst's anchor is u1 (local-side) — but server's srv-asst-2 anchor is
    // u2, so different anchors → not deduped.
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'u2', 'srv-asst-2', 'm-asst'],
    )
  })

  // ── Anchor-aware dedupe (v6) ──

  it('ANCHOR: server-authored takeover at same local anchor drops client phantom', () => {
    // Client and server agree on turn structure. The local m-asst's anchor
    // (u1) is computed from LOCAL side; the srv-asst's anchor is computed
    // from SERVER side. Both resolve to u1 → dedupe drops m-asst.
    const local = [
      M('u1', 'user', 'q', { ts: T0, _seq: 1 }),
      M('m-asst', 'assistant', 'partial', { ts: T1 }),  // no _seq, anchor=u1 local
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0, _seq: 1 }),
      M('srv-asst', 'assistant', 'final', { ts: T2, _seq: 2, _source: 'server' }),  // anchor=u1 server
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'srv-asst'],
      'same anchor → client phantom deduped',
    )
  })

  // ── Tool cross-anchor blockId (Codex v6 corner case 4) ──

  it('TOOL: same blockId across DIFFERENT anchors NOT deduped', () => {
    // Edge case where two distinct turns reference identical blockId
    // (degenerate but possible across cross-tab merges). Anchor-keyed
    // dedupe ensures the client tool at anchor=u1 is not collapsed by
    // a server tool at anchor=u2.
    const local = [
      M('u1', 'user', 'q1', { ts: T0, _seq: 1 }),
      M('m-tool', 'tool', 'local output', { ts: T1, blockId: 'shared-bid' }),  // anchor=u1
      M('u2', 'user', 'q2', { ts: T2, _seq: 2 }),
    ]
    const server = [
      M('u1', 'user', 'q1', { ts: T0, _seq: 1 }),
      M('u2', 'user', 'q2', { ts: T2, _seq: 2 }),
      M('srv-tool', 'tool', 'srv output', { ts: T3, _seq: 3, _source: 'server', blockId: 'shared-bid' }),  // anchor=u2
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // Both tools kept — different anchors despite identical blockId.
    const ids = merged.map((m: any) => m.id)
    assert.ok(ids.includes('m-tool'), 'client m-tool at anchor=u1 preserved')
    assert.ok(ids.includes('srv-tool'), 'server srv-tool at anchor=u2 kept')
  })

  // ── Defensive ──

  it('handles non-array inputs defensively', () => {
    assert.deepEqual(_mergeServerAuthoredIntoLocal(null as any, null as any), [])
    assert.deepEqual(
      _mergeServerAuthoredIntoLocal([M('a', 'user', 'x', { ts: T0 })], null as any).map((m: any) => m.id),
      ['a'],
    )
  })

  it('skips server entries without id (defensive — should not occur per invariant)', () => {
    // Documented invariant: all PERSISTED server messages have string id.
    // Defensive: id-less server rows skipped entirely (Codex v5 constraint 2).
    const server = [{ role: 'user', text: 'no id', ts: T0 }, M('a', 'user', 'has id', { ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server as any, [])
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['a'],
    )
  })

  it('passes through local id-less rows (transient mid-frame state)', () => {
    // Same invariant on local side. Local rows without id are passed through
    // (caller may have just appended a row before id assignment).
    const local = [{ role: 'assistant', text: 'no-id', ts: T0 }]
    const server = [M('a', 'user', 'with id', { ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged.length, 2, 'local id-less row preserved + server row appended')
  })

  it('does NOT reorder local-only when server is empty (fast path)', () => {
    // Even with mixed ts values local should be returned slice (no sort).
    const local = [
      { id: 'b', role: 'assistant', text: 'y', ts: T2 },
      { id: 'a', role: 'user', text: 'x', ts: T0 },
    ]
    const merged = _mergeServerAuthoredIntoLocal([], local)
    assert.deepEqual(merged.map((m: any) => m.id), ['b', 'a'])
  })
})

// ═══════════════════════════════════════════════════════════════════
// _rebuildBlockMaps
// ═══════════════════════════════════════════════════════════════════

describe('_rebuildBlockMaps', () => {
  it('indexes blockId → msgId from sess.messages', () => {
    const sess = {
      messages: [
        { id: 'm1', role: 'assistant', blockId: 'b1' },
        { id: 'm2', role: 'tool', blockId: 'b2' },
      ],
    } as any
    _rebuildBlockMaps(sess)
    assert.equal(sess._blockIdToMsgId.get('b1'), 'm1')
    assert.equal(sess._blockIdToMsgId.get('b2'), 'm2')
  })

  it('indexes agent-group blockIds in _agentGroups', () => {
    const sess = {
      messages: [{ id: 'g1', role: 'agent-group', blockId: 'ag1' }],
    } as any
    _rebuildBlockMaps(sess)
    assert.equal(sess._agentGroups.get('ag1'), 'g1')
  })

  it('indexes subagent grand-children (Agent tool_use inside childBlocks)', () => {
    const sess = {
      messages: [
        {
          id: 'g1',
          role: 'agent-group',
          blockId: 'ag1',
          childBlocks: [
            { kind: 'tool_use', blockId: 'sub1', toolName: 'Agent' },
            { kind: 'tool_use', blockId: 'sub2', toolName: 'Bash' }, // not an Agent
          ],
        },
      ],
    } as any
    _rebuildBlockMaps(sess)
    assert.equal(sess._agentGroups.get('sub1'), 'g1', 'Agent child indexed to group')
    assert.equal(sess._agentGroups.get('sub2'), undefined, 'non-Agent child NOT indexed')
  })

  it('resets prior map state on rebuild (no stale carryover)', () => {
    const sess = {
      _blockIdToMsgId: new Map([['stale', 'gone']]),
      _agentGroups: new Map([['stale', 'gone']]),
      messages: [{ id: 'm1', role: 'assistant', blockId: 'b1' }],
    } as any
    _rebuildBlockMaps(sess)
    assert.equal(sess._blockIdToMsgId.get('stale'), undefined)
    assert.equal(sess._blockIdToMsgId.get('b1'), 'm1')
    assert.equal(sess._agentGroups.get('stale'), undefined)
  })

  it('tolerates missing / non-array messages', () => {
    const sess = {} as any
    _rebuildBlockMaps(sess)
    assert.equal(sess._blockIdToMsgId.size, 0)
    assert.equal(sess._agentGroups.size, 0)
  })
})
