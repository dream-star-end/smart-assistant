/**
 * Unit tests for the v7 client-side merger (2026-05-12).
 *
 * v7 fixes the dual-id authority problem (client `m-*` + server `srv-*`
 * for the same logical assistant message) by having gateway mint
 * `srv-${peerId}-t${turnIndex}` once per turn and stamp every outbound
 * text/thinking block with it; client adopts that id as row id from the
 * first frame, and server Phase 0.1 takeover writes the canonical row
 * under the SAME id.
 *
 * With ids aligned on both tapes, the merger collapses to id-based union
 * with server-authored overlay + a legacy IDB migration backstop for
 * pre-v7 `m-*` rows that need to coexist with the new `srv-*` canonical
 * rows during the upgrade window.
 *
 * Covers:
 *   - _overlayServerAuthoritative: ref preservation / fresh-on-change semantics
 *   - _mergeServerAuthoredIntoLocal: v7 id-union + overlay + legacy backstop
 *   - _dropLegacyClientStreamRows: strict-predicate migration backstop
 *   - _rebuildBlockMaps: tool/agent-group lazy-map eager rebuild after sync
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
  extractTopLevelFn(SYNC_SRC, '_dropLegacyClientStreamRows') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_enforceTurnGroupOrder') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_mergeServerAuthoredIntoLocal') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_rebuildBlockMaps')

const _helpers = new Function(
  `${_combined}; return {
    _overlayServerAuthoritative,
    _mergeServerAuthoredIntoLocal,
    _dropLegacyClientStreamRows,
    _enforceTurnGroupOrder,
    _rebuildBlockMaps,
    _localMessageSupersedes,
  };`,
)() as {
  _overlayServerAuthoritative: (l: any, s: any) => any
  _mergeServerAuthoredIntoLocal: (s: any[], l: any[]) => any[]
  _dropLegacyClientStreamRows: (merged: any[]) => any[]
  _enforceTurnGroupOrder: (merged: any[]) => any[]
  _rebuildBlockMaps: (sess: any) => void
  _localMessageSupersedes: (l: any, s: any) => boolean
}
const {
  _overlayServerAuthoritative,
  _mergeServerAuthoredIntoLocal,
  _dropLegacyClientStreamRows,
  _enforceTurnGroupOrder,
  _rebuildBlockMaps,
} = _helpers

// ═══════════════════════════════════════════════════════════════════
// _overlayServerAuthoritative
// ═══════════════════════════════════════════════════════════════════

describe('_overlayServerAuthoritative', () => {
  it('returns SAME ref when no server-auth field differs (WeakMap fast path)', () => {
    const local = { id: 'a', role: 'assistant', text: 'hi', _seq: 5, usage: { in: 1 } }
    const server = { id: 'a', role: 'assistant', text: 'hi', _seq: 5, usage: { in: 1 } }
    // usage outer-ref `!==` check → different object instances trigger overlay.
    // Documents that nested-equality is NOT done.
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
    // v7: overlay does NOT touch text — text comes from whichever side wins
    // at the merger level (here we're testing overlay in isolation, where the
    // caller has decided local should win on text). Local text preserved.
    assert.equal(result.text, 'longer text')
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
// _mergeServerAuthoredIntoLocal (v7 id-union semantics)
// ═══════════════════════════════════════════════════════════════════

const M = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  role,
  text,
  ts: 1_700_000_000_000,
  ...extra,
})

describe('_mergeServerAuthoredIntoLocal (v7 id-union)', () => {
  const T0 = 1_700_000_000_000
  const T1 = T0 + 100
  const T2 = T0 + 200
  const T3 = T0 + 300
  const T4 = T0 + 400

  it('returns server-only timeline when local is empty', () => {
    const server = [M('a', 'user', 'hi', { ts: T0 }), M('b', 'assistant', 'hello', { ts: T1, _source: 'server' })]
    const merged = _mergeServerAuthoredIntoLocal(server, [])
    assert.deepEqual(merged.map((m: any) => m.id), ['a', 'b'])
    assert.equal(merged[0], server[0], 'server rows kept as-is (same ref) when no local match')
  })

  it('FAST PATH: empty server returns slice of local without reorder', () => {
    // Caller may have just appended an id-less message with no ts; must not
    // reorder it via ts-sort on the empty-server fast path.
    const local = [
      { id: 'b', role: 'assistant', text: 'y', ts: T2 },
      { id: 'a', role: 'user', text: 'x', ts: T0 },  // out-of-order on purpose
    ]
    const merged = _mergeServerAuthoredIntoLocal([], local)
    assert.deepEqual(merged.map((m: any) => m.id), ['b', 'a'], 'order preserved')
    assert.notEqual(merged, local, 'returns a fresh slice (callers can mutate)')
  })

  it('keeps local ref when text and server-auth fields are identical', () => {
    // Same-id overlay returns same ref when nothing differs (WeakMap fast path).
    const local = [M('a', 'user', 'hi', { _seq: 1, ts: T0 })]
    const server = [M('a', 'user', 'hi', { _seq: 1, ts: T0 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged[0], local[0], 'no-change → same local ref preserved')
  })

  it('keeps local text + overlays server-auth fields when local supersedes server', () => {
    // v7 behavior: same-id rows go through _overlayServerAuthoritative which
    // overlays _seq / usage / etc from server but leaves text alone. Local's
    // streaming text continues to be visible while server's `_seq` etc. updates.
    const local = [M('a', 'assistant', 'streaming text', { _seq: 3, ts: T1 })]
    const server = [M('a', 'assistant', 'streaming text', { _seq: 5, usage: { in: 10 }, ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.notEqual(merged[0], local[0], '_seq diff → fresh object')
    assert.equal(merged[0]._seq, 5)
    assert.equal(merged[0].usage.in, 10)
    assert.equal(merged[0].text, 'streaming text')
  })

  // ── In-flight streaming preservation (v7) ──
  // v7: client streaming row uses the canonical srv-* id from frame 1, so
  // when server takeover lands the same id is reused — overlay path. While
  // takeover hasn't fired yet, the local row exists with no server peer; we
  // must preserve it (id-union semantics).

  it('IN-FLIGHT: preserves local-only assistant when server has no takeover yet (v7 srv- id)', () => {
    const local = [
      M('u1', 'user', 'question', { ts: T0 }),
      // v7: streaming row already has canonical srv-* id from gateway's
      // messageId stamp on the first text frame.
      M('srv-peer1-t1', 'assistant', 'partial reply…', { ts: T1 }),
    ]
    // Server hasn't completed Phase 0.1 takeover yet.
    const server = [M('u1', 'user', 'question', { ts: T0 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(merged.map((m: any) => m.id), ['u1', 'srv-peer1-t1'])
    assert.equal(merged[1], local[1], 'in-flight tail preserved by ref')
  })

  it('IN-FLIGHT: preserves thinking + assistant streaming pair (v7 srv- ids)', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-thinking', 'thinking', 'thinking…', { ts: T1 }),
      M('srv-peer1-t1', 'assistant', 'replying…', { ts: T2 }),
    ]
    const server = [M('u1', 'user', 'q', { ts: T0 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(merged.map((m: any) => m.id), ['u1', 'srv-peer1-t1-thinking', 'srv-peer1-t1'])
  })

  // ── Phase 0.1 takeover convergence (v7) ──
  // Same-id rows on both sides: server's authoritative version (with final
  // text, _seq, _source='server', usage) overlays the client placeholder.

  it('TAKEOVER: same canonical id → server fields overlay onto local (no duplicate)', () => {
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'partial', { ts: T1 }),  // client placeholder
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'final canonical text', {
        ts: T1, _source: 'server', _seq: 1, usage: { in: 5 },
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged.length, 2, 'no duplicate row — same id collapsed')
    assert.deepEqual(merged.map((m: any) => m.id), ['u1', 'srv-peer1-t1'])
    // local 'partial' is shorter than server's 'final canonical text' AND
    // not a prefix of it → `_localMessageSupersedes` Layer 2 returns false →
    // server-wins branch. v7.2: server content wins but local ts is
    // preserved as the visual sort key (here both sides have ts T1, so
    // the ts value is unchanged; the invariant still applies).
    assert.equal(merged[1].text, 'final canonical text')
    assert.equal(merged[1]._seq, 1)
    assert.equal(merged[1]._source, 'server')
    assert.equal(merged[1].usage.in, 5)
    assert.equal(merged[1].ts, T1, 'local ts (==server ts here) preserved')
  })

  // ── Server-only rows (cross-tab additions) ──

  it('CROSS-TAB: appends server-only user message (lacks _source==="server")', () => {
    const local = [
      M('u1', 'user', 'first', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'replying…', { ts: T1 }),
    ]
    const server = [
      M('u1', 'user', 'first', { ts: T0 }),
      M('u2-other-tab', 'user', 'cross-tab message', { ts: T2 }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // ts-sort: u1(T0), srv-peer1-t1(T1), u2-other-tab(T2)
    assert.deepEqual(merged.map((m: any) => m.id), ['u1', 'srv-peer1-t1', 'u2-other-tab'])
  })

  // ── Cross-tab DELETE (v7 explicit trade-off) ──
  // v7 id-union does NOT discriminate "previously confirmed but now absent"
  // — that would resurrect symptom-patching. Stale tab keeps a ghost row
  // until refresh.

  it('CROSS-TAB DELETE: keeps local-only row even with _seq (v7 explicit trade-off)', () => {
    // Pre-v7 (_seq-based discriminator) would have dropped a-deleted; v7
    // keeps it as a ghost until refresh. This is the documented trade-off
    // (sync.js docstring) — cross-tab delete is rare and reversible;
    // flash-and-loss on streaming is high-frequency. Explicit trade.
    const local = [
      M('u1', 'user', 'q', { ts: T0, _seq: 1 }),
      M('a-deleted', 'assistant', 'was confirmed, now gone', { ts: T1, _seq: 2 }),
    ]
    const server = [M('u1', 'user', 'q', { ts: T0, _seq: 1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(merged.map((m: any) => m.id), ['u1', 'a-deleted'])
  })

  // ── Ordering / sort ──

  it('SORT: cross-tab user b inserts ts-wise between local user a and asst', () => {
    const local = [
      M('a', 'user', 'q1', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'partial-a', { ts: T2 }),
    ]
    const server = [
      M('a', 'user', 'q1', { ts: T0 }),
      M('b-other-tab', 'user', 'q2', { ts: T1 }),
      M('srv-peer1-t2', 'assistant', 'reply-b', { ts: T3, _source: 'server' }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // ts-sort: a(T0), b-other-tab(T1), srv-peer1-t1(T2), srv-peer1-t2(T3)
    // Both assistant rows preserved — distinct ids, distinct turns.
    assert.deepEqual(merged.map((m: any) => m.id),
      ['a', 'b-other-tab', 'srv-peer1-t1', 'srv-peer1-t2'])
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
    const server = [{ role: 'user', text: 'no id', ts: T0 }, M('a', 'user', 'has id', { ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server as any, [])
    assert.deepEqual(merged.map((m: any) => m.id), ['a'])
  })

  it('passes through local id-less rows (transient mid-frame state)', () => {
    const local = [{ role: 'assistant', text: 'no-id', ts: T0 }]
    const server = [M('a', 'user', 'with id', { ts: T1 })]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged.length, 2, 'local id-less row preserved + server row appended')
  })

  it('does NOT reorder local-only when server is empty (fast path)', () => {
    const local = [
      { id: 'b', role: 'assistant', text: 'y', ts: T2 },
      { id: 'a', role: 'user', text: 'x', ts: T0 },
    ]
    const merged = _mergeServerAuthoredIntoLocal([], local)
    assert.deepEqual(merged.map((m: any) => m.id), ['b', 'a'])
  })

  // ── v7.2 (2026-05-13) ts-preservation invariant ──
  // For any row whose id appears on BOTH client (streamed) and server
  // (persisted), local `ts` wins as the visual sort key. Server still wins
  // on CONTENT when `_localMessageSupersedes` is false, but the row's
  // position in the timeline belongs to whoever saw it first. Fixes the
  // v1.0.135 regression where master's post-stream `body.createdAt` ts
  // for tool rows landed AFTER client's assistant ts, sorting tool cards
  // below the assistant text.

  it('v7.2 SAME-ID + server-wins-content: preserves local ts (tool role)', () => {
    // Tool role is NOT in `_localMessageSupersedes` Layer 2 whitelist;
    // Layer 1 deep-equal fails on server's `_seq` / `_source` / `status`
    // → server-wins branch. Without the v7.2 fix, server's late ts would
    // sort the tool below the assistant text.
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-tool-blockA', 'tool', 'Bash', {
        ts: T1,  // client streaming arrival — BEFORE assistant
        toolName: 'Bash',
        blockId: 'blockA',
        _completed: true,
        output: 'tool output',
      }),
      M('srv-peer1-t1', 'assistant', 'response text', { ts: T2 }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-tool-blockA', 'tool', 'Bash', {
        ts: T4,  // server's post-stream baseTs - 1 ≈ persist time, AFTER assistant
        toolName: 'Bash',
        blockId: 'blockA',
        _source: 'server',
        _seq: 2,
        status: 'completed',
        output: 'tool output',
      }),
      M('srv-peer1-t1', 'assistant', 'response text', {
        ts: T2,
        _source: 'server',
        _seq: 3,
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // After fix: tool row has server content (_seq, _source, status) but
    // LOCAL ts T1, so it sorts BETWEEN user (T0) and assistant (T2).
    assert.deepEqual(
      merged.map((m: any) => m.id),
      ['u1', 'srv-peer1-t1-tool-blockA', 'srv-peer1-t1'],
      'tool keeps streaming position (above assistant), not server post-stream position',
    )
    const tool = merged[1]
    assert.equal(tool.ts, T1, 'local ts preserved as visual sort key')
    assert.equal(tool._source, 'server', 'server content fields applied')
    assert.equal(tool._seq, 2)
    assert.equal(tool.status, 'completed')
  })

  it('v7.2 SAME-ID + server-wins-content: preserves local ts (assistant role, role-independent)', () => {
    // Force server-wins on an assistant row by making texts diverge in a
    // way Layer 2 streaming-prefix-extension can't reconcile (server
    // strictly shorter and not a prefix of local — wouldn't normally
    // happen, but documents that the invariant is role-independent and
    // not a tool-only patch).
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'client-diverged text', { ts: T2 }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'authoritative final', {
        ts: T4,  // server's post-stream ts > local ts
        _source: 'server',
        _seq: 5,
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.equal(merged[1].ts, T2, 'local ts kept even when server wins content')
    assert.equal(merged[1].text, 'authoritative final', 'server content applied')
    assert.equal(merged[1]._seq, 5)
  })

  it('v7.2 SERVER-ONLY row (no local counterpart) keeps server ts unchanged', () => {
    // Cross-tab / cross-device addition: client never saw this row stream,
    // server ts is the only source for its position.
    const local = [M('u1', 'user', 'q', { ts: T0 })]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('cross-tab-msg', 'user', 'from other tab', { ts: T3 }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    const crossTab = merged.find((m: any) => m.id === 'cross-tab-msg')
    assert.equal(crossTab.ts, T3, 'server-only row keeps server ts')
  })

  it('v7.2 SAME-ID + server-wins + local.ts undefined → fallback to server.ts (no NaN)', () => {
    // Defensive: a malformed local row missing ts shouldn't poison the
    // sort key. `lm.ts ?? sm.ts` falls back to server's ts.
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      { id: 'srv-peer1-t1-tool-x', role: 'tool', text: 'Bash' },  // no ts
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-tool-x', 'tool', 'Bash', {
        ts: T2,
        _source: 'server',
        _seq: 1,
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    const tool = merged.find((m: any) => m.id === 'srv-peer1-t1-tool-x')
    assert.equal(tool.ts, T2, 'fallback to server ts when local ts missing')
    assert.ok(Number.isFinite(tool.ts), 'no NaN')
  })

  it('v7.2 multi-row turn preserves streaming order across server post-stream ts', () => {
    // The core scenario from the bug report: a turn with thinking + tool +
    // assistant. Client streamed them in order at T1 < T2 < T3. Server
    // persists with baseTs ≈ T4 (post-stream): thinkingTs = T4-2,
    // toolTs = T4-1, assistantTs = T4. Without v7.2, tool gets server ts
    // T4-1 > T3 and renders below assistant.
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-thinking', 'thinking', 'thinking...', { ts: T1 }),
      M('srv-peer1-t1-tool-blockA', 'tool', 'Skill', {
        ts: T2,
        toolName: 'Skill',
        blockId: 'blockA',
        _completed: true,
        output: 'skill result',
      }),
      M('srv-peer1-t1', 'assistant', 'final response', { ts: T3 }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-thinking', 'thinking', 'thinking...', {
        ts: T4 - 2, _source: 'server', _seq: 1,
      }),
      M('srv-peer1-t1-tool-blockA', 'tool', 'Skill', {
        ts: T4 - 1, _source: 'server', _seq: 2,
        toolName: 'Skill', blockId: 'blockA', status: 'completed',
      }),
      M('srv-peer1-t1', 'assistant', 'final response', {
        ts: T4, _source: 'server', _seq: 3,
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    // Visual order: user → thinking → tool → assistant (streaming order).
    assert.deepEqual(
      merged.map((m: any) => m.id),
      [
        'u1',
        'srv-peer1-t1-thinking',
        'srv-peer1-t1-tool-blockA',
        'srv-peer1-t1',
      ],
      'streaming order preserved despite server post-stream ts',
    )
  })

  it('v7.3 preamble-pattern: assistant text streamed BEFORE tool_use → tool still rendered ABOVE assistant', () => {
    // Real-world ccb-agent regression (DeepSeek "Let me check..." → Bash):
    // client receives text delta first (creates assistant row id=srv-X-t1,
    // ts=T2), then tool_use block start (creates tool row id=srv-X-t1-tool-A,
    // ts=T3 > T2). v7.2 alone (preserve client ts) sorts assistant ABOVE
    // tool — wrong. v7.3 _enforceTurnGroupOrder fixes within-turn order by
    // canonical-id kind regardless of arrival ts.
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1-thinking', 'thinking', 'analyzing', { ts: T1 }),
      M('srv-peer1-t1', 'assistant', 'Let me check...', { ts: T2 }),
      M('srv-peer1-t1-tool-blockA', 'tool', 'Bash', { ts: T3, toolName: 'Bash' }),
    ]
    // Server post-stream takeover writes canonical rows with its own ts
    // (master policy: tool ts < assistant ts). _localMessageSupersedes
    // returns false for tool/thinking → server wins on content; v7.2
    // preserves client ts; v7.3 then enforces kind ordering.
    const baseTs = T0 + 1000
    const server = [
      M('u1', 'user', 'q', { ts: T0, _seq: 1 }),
      M('srv-peer1-t1-thinking', 'thinking', 'analyzing', {
        ts: baseTs - 2, _source: 'server', _seq: 2,
      }),
      M('srv-peer1-t1-tool-blockA', 'tool', 'Bash', {
        ts: baseTs - 1, _source: 'server', _seq: 3,
        toolName: 'Bash', output: 'ok', _completed: true,
      }),
      M('srv-peer1-t1', 'assistant', 'Let me check... done.', {
        ts: baseTs, _source: 'server', _seq: 4,
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(
      merged.map((m: any) => m.id),
      [
        'u1',
        'srv-peer1-t1-thinking',
        'srv-peer1-t1-tool-blockA',
        'srv-peer1-t1',
      ],
      'preamble-pattern: tool card rendered ABOVE assistant text',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════
// _dropLegacyClientStreamRows — strict-predicate migration backstop
// ═══════════════════════════════════════════════════════════════════
//
// Scheduled for removal post-v1.0.134 + 14 days. Catches pre-v7 `m-*`
// assistant/thinking rows in IDB that have a `srv-*` server counterpart
// in the same turn group (would otherwise duplicate post-union).

describe('_dropLegacyClientStreamRows (migration backstop)', () => {
  const T0 = 1_700_000_000_000
  const T1 = T0 + 100
  const T2 = T0 + 200
  const T3 = T0 + 300

  it('drops legacy m-assistant row when srv-assistant exists in same turn', () => {
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-asst-legacy', 'assistant', 'old streaming partial', { ts: T1 }),
      M('srv-peer1-t1', 'assistant', 'final', { ts: T2, _source: 'server', _seq: 1 }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id), ['u1', 'srv-peer1-t1'])
  })

  it('drops legacy m-thinking when srv-*-thinking exists in same turn', () => {
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-think-legacy', 'thinking', 'old', { ts: T1 }),
      M('srv-peer1-t1-thinking', 'thinking', 'final', { ts: T2, _source: 'server' }),
      M('srv-peer1-t1', 'assistant', 'reply', { ts: T3, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'srv-peer1-t1-thinking', 'srv-peer1-t1'])
  })

  it('KEEPS legacy m-assistant row when NO srv-assistant counterpart in same turn', () => {
    // Empty-turn notice case: m-* row exists, no srv-* peer → must be kept.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-empty-notice', 'assistant', '⚠️ empty turn', { ts: T1 }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id), ['u1', 'm-empty-notice'])
  })

  it('KEEPS m-assistant when srv-assistant is in a DIFFERENT turn group', () => {
    // m-asst in turn 1 (after u1), srv-asst in turn 2 (after u2). Strict
    // backstop must NOT cross turn boundaries.
    const input = [
      M('u1', 'user', 'q1', { ts: T0 }),
      M('m-asst-turn1', 'assistant', 'reply-1', { ts: T1 }),
      M('u2', 'user', 'q2', { ts: T2 }),
      M('srv-peer1-t2', 'assistant', 'reply-2', { ts: T3, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-asst-turn1', 'u2', 'srv-peer1-t2'],
      'different turn groups → no dedupe')
  })

  it('KEEPS m-thinking when only srv-assistant (not srv-thinking) exists', () => {
    // Predicate is role-specific: srv-assistant does NOT count as a thinking
    // counterpart.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-think-legacy', 'thinking', 'old', { ts: T1 }),
      M('srv-peer1-t1', 'assistant', 'reply', { ts: T2, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-think-legacy', 'srv-peer1-t1'],
      'no srv-thinking → m-thinking preserved')
  })

  it('KEEPS user rows even with m- prefix (predicate role-gated to asst/thinking)', () => {
    // Some user-created sessions may have IDs with m- prefix (defensive).
    const input = [
      M('m-user-msg', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'reply', { ts: T1, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id), ['m-user-msg', 'srv-peer1-t1'])
  })

  // v1.0.135: predicate extended to include tool rows whose blockId matches
  // a server-authored tool peer in the same turn group. The previous "tools
  // out of scope" guarantee is intentionally dropped — keeping the legacy
  // `m-*` tool placeholder caused the post-completion duplicate-card flash
  // boss reported after v1.0.134.
  it('KEEPS m-tool row when NO server-authored tool peer matches blockId', () => {
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool-orphan', 'tool', 'output', { ts: T1, blockId: 'b1' }),
      M('srv-peer1-t1', 'assistant', 'reply', { ts: T2, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-tool-orphan', 'srv-peer1-t1'],
      'no server-tool peer (any blockId) in same group → m-tool preserved')
  })

  it('drops legacy m-tool row when server-authored tool with same blockId exists in same turn', () => {
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool-legacy', 'tool', 'Bash', { ts: T1, blockId: 'tu_xyz' }),
      M('srv-peer1-t1-tool-tu_xyz', 'tool', 'Bash',
        { ts: T2, _source: 'server', _seq: 1, blockId: 'tu_xyz' }),
      M('srv-peer1-t1', 'assistant', 'reply', { ts: T3, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'srv-peer1-t1-tool-tu_xyz', 'srv-peer1-t1'],
      'legacy m-tool deduped against server tool with same blockId')
  })

  it('KEEPS m-tool row when server-authored tool with DIFFERENT blockId exists in same turn', () => {
    // Cross-blockId no-op: the predicate is keyed on blockId equality. A
    // server tool for blockId B does NOT shadow a client m-tool for blockId A.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool-a', 'tool', 'Bash', { ts: T1, blockId: 'A' }),
      M('srv-peer1-t1-tool-B', 'tool', 'Read',
        { ts: T2, _source: 'server', blockId: 'B' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-tool-a', 'srv-peer1-t1-tool-B'],
      'blockId mismatch → both kept')
  })

  it('KEEPS m-tool row when its server-authored peer is in a DIFFERENT turn group', () => {
    // Strict false-negative we accept: if a server tool's ts somehow lands in
    // the NEXT turn group (rare — master writes tool ts ≈ turn-end which is
    // normally before the next user message), the user-boundary partition
    // assigns them different groups and the predicate refuses to dedupe.
    // Preferring a lingering duplicate over an accidental drop is the
    // documented trade-off in the docstring.
    const input = [
      M('u1', 'user', 'q1', { ts: T0 }),
      M('m-tool-turn1', 'tool', 'Bash', { ts: T1, blockId: 'tu_q1' }),
      M('u2', 'user', 'q2', { ts: T2 }),
      M('srv-peer1-t2-tool-tu_q1', 'tool', 'Bash',
        { ts: T3, _source: 'server', blockId: 'tu_q1' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-tool-turn1', 'u2', 'srv-peer1-t2-tool-tu_q1'],
      'cross-group → strict no-dedupe (accepted false-negative)')
  })

  it('KEEPS m-tool row that lacks blockId entirely (predicate guard)', () => {
    // Defensive: m-* rows that somehow miss the blockId field can never be
    // matched against a server peer. The predicate's `typeof blockId ===
    // string && blockId.length > 0` guard prevents accidental drops.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool-no-bid', 'tool', 'output', { ts: T1 }), // no blockId
      M('srv-peer1-t1-tool-X', 'tool', 'Bash',
        { ts: T2, _source: 'server', blockId: 'X' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-tool-no-bid', 'srv-peer1-t1-tool-X'],
      'missing blockId → kept')
  })

  it('KEEPS agent-group row even with matching blockId server tool (role !== tool)', () => {
    // The Agent tool is intentionally NOT persisted server-side (parser filter
    // in ccbMessageParser excludes Agent from completedTools), so a server-
    // authored `role: tool` row with the agent's blockId shouldn't exist. But
    // defense in depth: the predicate is role-gated to `tool`, so any
    // pathological cross-role match is still safe.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-agent-group', 'agent-group', 'Agent',
        { ts: T1, blockId: 'tu_agent', childBlocks: [{ kind: 'text', text: 'sub' }] }),
      // Pathological server tool with matching blockId — must NOT trigger drop.
      M('srv-peer1-t1-tool-tu_agent', 'tool', 'Agent',
        { ts: T2, _source: 'server', blockId: 'tu_agent' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    // m-agent-group preserved because role !== 'tool'. The pathological
    // server tool stays too (predicate doesn't touch _source==='server' rows).
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-agent-group', 'srv-peer1-t1-tool-tu_agent'],
      'role guard protects agent-group')
  })

  it('KEEPS m-tool row when peer carries blockId but _source !== "server" (defensive)', () => {
    // Predicate ONLY counts `_source === 'server'` rows as canonical peers.
    // A client-authored tool row (even with same blockId) shouldn't dedupe
    // another client-authored row.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-tool-a', 'tool', 'Bash', { ts: T1, blockId: 'X' }),
      M('m-tool-b', 'tool', 'Bash', { ts: T2, blockId: 'X' }), // also client
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-tool-a', 'm-tool-b'],
      'no _source: server peer → no dedupe')
  })

  it('KEEPS m-* assistant if it already carries _source==="server" (defensive)', () => {
    // Pathological case: a row with m-* id but _source:'server'. Strictly
    // shouldn't happen, but the predicate excludes _source==='server' to
    // never drop an authoritative row.
    const input = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-asst-weird', 'assistant', 'somehow auth', { ts: T1, _source: 'server' }),
      M('srv-peer1-t1', 'assistant', 'real', { ts: T2, _source: 'server' }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    assert.deepEqual(out.map((m: any) => m.id),
      ['u1', 'm-asst-weird', 'srv-peer1-t1'],
      'auth-marked rows always kept')
  })

  it('handles rows before any user/system row (group 0)', () => {
    // Defensive: messages emitted before the first user msg fall into group 0.
    const input = [
      M('m-asst-orphan', 'assistant', 'orphan', { ts: T0 }),
      M('srv-peer1-t0', 'assistant', 'srv', { ts: T1, _source: 'server' }),
      M('u1', 'user', 'q', { ts: T2 }),
    ]
    const out = _dropLegacyClientStreamRows(input)
    // Both in group 0 → m-asst-orphan deduped against srv-peer1-t0.
    assert.deepEqual(out.map((m: any) => m.id), ['srv-peer1-t0', 'u1'])
  })

  it('integrated through merger: legacy m-asst row in local + srv- counterpart on server', () => {
    // The real upgrade scenario: user upgraded from v1.0.132 with `m-*` rows
    // in IDB; server has already done Phase 0.1 takeover and the canonical
    // `srv-*` row is on the server tape. Merger union surfaces both; backstop
    // drops the legacy m-* row so UI shows exactly one assistant card.
    const local = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('m-asst-legacy', 'assistant', 'old partial in IDB', { ts: T1 }),
    ]
    const server = [
      M('u1', 'user', 'q', { ts: T0 }),
      M('srv-peer1-t1', 'assistant', 'canonical final', {
        ts: T2, _source: 'server', _seq: 1,
      }),
    ]
    const merged = _mergeServerAuthoredIntoLocal(server, local)
    assert.deepEqual(merged.map((m: any) => m.id), ['u1', 'srv-peer1-t1'])
    assert.equal(merged[1].text, 'canonical final')
  })
})

// ═══════════════════════════════════════════════════════════════════
// _rebuildBlockMaps (unchanged from v6 — still required by sync.js)
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
            { kind: 'tool_use', blockId: 'sub2', toolName: 'Bash' },
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

// ═══════════════════════════════════════════════════════════════════
// _enforceTurnGroupOrder (v7.3 — canonical-id within-turn sort)
// ═══════════════════════════════════════════════════════════════════

describe('_enforceTurnGroupOrder (v7.3)', () => {
  const T0 = 1_700_000_000_000

  it('reorders preamble-pattern turn: assistant ts < tool ts → tool above assistant', () => {
    // Bug reproduction: agent emitted text BEFORE tool_use within one turn.
    // Client arrival order (already sorted by ts): user → thinking → asst → tool.
    // Expected after enforce: user → thinking → tool → asst.
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1-thinking', role: 'thinking', text: 'h', ts: T0 + 10 },
      { id: 'srv-s-t1', role: 'assistant', text: 'preamble', ts: T0 + 20 },
      { id: 'srv-s-t1-tool-x', role: 'tool', text: 'Bash', ts: T0 + 30 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1-thinking', 'srv-s-t1-tool-x', 'srv-s-t1'],
    )
  })

  it('leaves natural codex order untouched: thinking → tool → asst already correct', () => {
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1-thinking', role: 'thinking', text: 'h', ts: T0 + 10 },
      { id: 'srv-s-t1-tool-x', role: 'tool', text: 'Bash', ts: T0 + 20 },
      { id: 'srv-s-t1', role: 'assistant', text: 'reply', ts: T0 + 30 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1-thinking', 'srv-s-t1-tool-x', 'srv-s-t1'],
    )
  })

  it('preserves relative order of multiple same-kind rows by ts', () => {
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1-thinking', role: 'thinking', text: 'h', ts: T0 + 10 },
      { id: 'srv-s-t1-tool-a', role: 'tool', text: 'Bash1', ts: T0 + 20 },
      { id: 'srv-s-t1-tool-b', role: 'tool', text: 'Bash2', ts: T0 + 30 },
      { id: 'srv-s-t1', role: 'assistant', text: 'reply', ts: T0 + 40 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1-thinking', 'srv-s-t1-tool-a', 'srv-s-t1-tool-b', 'srv-s-t1'],
    )
  })

  it('does NOT swap srv rows across user/system boundary', () => {
    // Stale/server-only late-arrival case: srv-s-t1 assistant and
    // srv-s-t1-tool-x bracketed by user2. The earlier algorithm would
    // swap them; this version must keep both in their own segments.
    const merged = [
      { id: 'u1', role: 'user', text: 'q1', ts: T0 },
      { id: 'srv-s-t1', role: 'assistant', text: 'preamble', ts: T0 + 100 },
      { id: 'u2', role: 'user', text: 'q2', ts: T0 + 200 },
      { id: 'srv-s-t1-tool-x', role: 'tool', text: 'late tool', ts: T0 + 300 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1', 'u2', 'srv-s-t1-tool-x'],
      'cross-boundary swap forbidden',
    )
  })

  it('reorders each segment independently (multi-turn timeline)', () => {
    const merged = [
      { id: 'u1', role: 'user', text: 'q1', ts: T0 },
      { id: 'srv-s-t1', role: 'assistant', text: 'r1 preamble', ts: T0 + 10 },
      { id: 'srv-s-t1-tool-a', role: 'tool', text: 'B1', ts: T0 + 20 },
      { id: 'u2', role: 'user', text: 'q2', ts: T0 + 100 },
      { id: 'srv-s-t2-thinking', role: 'thinking', text: 'h', ts: T0 + 110 },
      { id: 'srv-s-t2', role: 'assistant', text: 'r2 preamble', ts: T0 + 120 },
      { id: 'srv-s-t2-tool-b', role: 'tool', text: 'B2', ts: T0 + 130 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      [
        'u1',
        'srv-s-t1-tool-a',
        'srv-s-t1',
        'u2',
        'srv-s-t2-thinking',
        'srv-s-t2-tool-b',
        'srv-s-t2',
      ],
    )
  })

  it('leaves agent-group / m-* rows in place (known limitation)', () => {
    // agent-group has m-* id, no canonical turnKey — parser returns null
    // for it, so it is NOT in any turnGroup. The two srv rows are still
    // reordered among themselves at THEIR indices; agent-group stays put.
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1-thinking', role: 'thinking', text: 'h', ts: T0 + 10 },
      { id: 'srv-s-t1', role: 'assistant', text: 'preamble', ts: T0 + 20 },
      { id: 'm-agentgrp', role: 'agent-group', text: 'sub', ts: T0 + 30 },
      { id: 'srv-s-t1-tool-x', role: 'tool', text: 'Bash', ts: T0 + 40 },
    ]
    _enforceTurnGroupOrder(merged)
    // srv rows reorder at their indices 1,2,4 (skipping agent-group at idx 3):
    // sorted by kind → thinking, tool, asst → placed at indices 1, 2, 4.
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1-thinking', 'srv-s-t1-tool-x', 'm-agentgrp', 'srv-s-t1'],
    )
  })

  it('classifies tool id with blockId ending in -thinking as tool (parser defense)', () => {
    // Defensive ordering: a hypothetical blockId ending in "-thinking" must
    // be parsed as tool, not as a thinking row.
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1', role: 'assistant', text: 'p', ts: T0 + 10 },
      { id: 'srv-s-t1-tool-toolu_abc-thinking', role: 'tool', text: 'Bash', ts: T0 + 20 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1-tool-toolu_abc-thinking', 'srv-s-t1'],
      'tool with -thinking-suffixed blockId still classified as tool',
    )
  })

  it('handles single-row turn (no-op)', () => {
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1', role: 'assistant', text: 'r', ts: T0 + 10 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1'],
    )
  })

  it('handles thinking-only turn', () => {
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'srv-s-t1-thinking', role: 'thinking', text: 'h', ts: T0 + 10 },
    ]
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'srv-s-t1-thinking'],
    )
  })

  it('handles empty array', () => {
    const merged: any[] = []
    _enforceTurnGroupOrder(merged)
    assert.deepEqual(merged, [])
  })

  it('handles m-* legacy assistant + srv-* same turn (parser ignores m-*)', () => {
    // m-* row is not in any turnGroup, stays in its ts-sorted position.
    // _dropLegacyClientStreamRows (called after _enforceTurnGroupOrder in
    // the real flow) handles dropping the m-* duplicate; this test isolates
    // the ordering layer.
    const merged = [
      { id: 'u1', role: 'user', text: 'q', ts: T0 },
      { id: 'm-old-a', role: 'assistant', text: 'legacy', ts: T0 + 10 },
      { id: 'srv-s-t1', role: 'assistant', text: 'preamble', ts: T0 + 20 },
      { id: 'srv-s-t1-tool-x', role: 'tool', text: 'Bash', ts: T0 + 30 },
    ]
    _enforceTurnGroupOrder(merged)
    // srv rows at indices 2,3 swap (tool kind=1 < asst kind=2); m-* at idx 1 untouched.
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'm-old-a', 'srv-s-t1-tool-x', 'srv-s-t1'],
    )
  })
})
