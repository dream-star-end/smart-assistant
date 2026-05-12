/**
 * Unit tests for the server/local message merger added in 2026-05-12 to
 * fix the mobile streaming-tail flash-and-loss bug.
 *
 * Covers:
 *   - _overlayServerAuthoritative: ref preservation on no-change /
 *     fresh object on change semantics (load-bearing for WeakMap-keyed
 *     DOM reconcile)
 *   - _isStreamingTail: role + content + grace-window predicate
 *   - _mergeServerWithLocalSuperset: the actual merger used by sync.js's
 *     three convergence paths (regular fetch, partial fetch, 409 resolution)
 *   - _rebuildBlockMaps: tool/agent-group lazy-map eager rebuild after a
 *     sync replaces sess.messages
 *   - _mergePartialTail: STEP 3 streaming-tail preservation (new behavior
 *     not covered by syncIncremental.test.ts; that file tests steps 1-2)
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
const _GRACE_DECL = 'const STREAMING_TAIL_GRACE_MS = 5000;'

const _combined =
  _SERVER_AUTH_KEYS_DECL +
  '\n' +
  _GRACE_DECL +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_stableStringify') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_overlayServerAuthoritative') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_isStreamingTail') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_mergeServerWithLocalSuperset') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_rebuildBlockMaps') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_overlayServerOntoLocalDominant')

const _helpers = new Function(
  `${_combined}; return {
    _overlayServerAuthoritative,
    _isStreamingTail,
    _mergeServerWithLocalSuperset,
    _rebuildBlockMaps,
    _overlayServerOntoLocalDominant,
    _localMessageSupersedes,
  };`,
)() as {
  _overlayServerAuthoritative: (l: any, s: any) => any
  _isStreamingTail: (m: any, now: number) => boolean
  _mergeServerWithLocalSuperset: (s: any[], l: any[], now?: number) => any[]
  _rebuildBlockMaps: (sess: any) => void
  _overlayServerOntoLocalDominant: (l: any[], s: any[]) => any[]
  _localMessageSupersedes: (l: any, s: any) => boolean
}
const {
  _overlayServerAuthoritative,
  _isStreamingTail,
  _mergeServerWithLocalSuperset,
  _rebuildBlockMaps,
  _overlayServerOntoLocalDominant,
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
// _isStreamingTail
// ═══════════════════════════════════════════════════════════════════

describe('_isStreamingTail', () => {
  const now = 1_700_000_000_000

  it('true for fresh assistant with text', () => {
    const m = { role: 'assistant', text: 'hello', completedAt: now - 1000 }
    assert.equal(_isStreamingTail(m, now), true)
  })

  it('true for fresh thinking with text', () => {
    const m = { role: 'thinking', text: 'thinking…', ts: now - 500 }
    assert.equal(_isStreamingTail(m, now), true)
  })

  it('false for stale assistant beyond grace window', () => {
    const m = { role: 'assistant', text: 'old', completedAt: now - 10_000 }
    assert.equal(_isStreamingTail(m, now), false)
  })

  it('false for user role even if fresh and non-empty', () => {
    const m = { role: 'user', text: 'hi', ts: now }
    assert.equal(_isStreamingTail(m, now), false)
  })

  it('false for tool role', () => {
    const m = { role: 'tool', text: 'output', ts: now }
    assert.equal(_isStreamingTail(m, now), false)
  })

  it('false for assistant with empty text and no childBlocks', () => {
    const m = { role: 'assistant', text: '', ts: now }
    assert.equal(_isStreamingTail(m, now), false)
  })

  it('true for assistant with childBlocks even if text is empty', () => {
    const m = { role: 'assistant', text: '', childBlocks: [{ kind: 'tool_use' }], ts: now }
    assert.equal(_isStreamingTail(m, now), true)
  })

  it('uses completedAt over ts when both present', () => {
    // Stale ts but fresh completedAt → still tail
    const m = { role: 'assistant', text: 'x', ts: 0, completedAt: now - 100 }
    assert.equal(_isStreamingTail(m, now), true)
  })

  it('false on null / undefined / no-content', () => {
    assert.equal(_isStreamingTail(null, now), false)
    assert.equal(_isStreamingTail(undefined, now), false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// _mergeServerWithLocalSuperset
// ═══════════════════════════════════════════════════════════════════

const M = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  role,
  text,
  ts: 1_700_000_000_000,
  ...extra,
})

describe('_mergeServerWithLocalSuperset', () => {
  const NOW = 1_700_000_000_000

  it('returns server-only timeline when local is empty', () => {
    const server = [M('a', 'user', 'hi'), M('b', 'assistant', 'hello')]
    const merged = _mergeServerWithLocalSuperset(server, [], NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['a', 'b'],
    )
    // Server rows are kept as-is (same refs)
    assert.equal(merged[0], server[0])
  })

  it('keeps local ref when text is identical (WeakMap fast path)', () => {
    const local = [M('a', 'user', 'hi', { _seq: 1 })]
    const server = [M('a', 'user', 'hi', { _seq: 1 })]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.equal(merged[0], local[0], 'no-change → same local ref preserved')
  })

  it('keeps local with streaming extension (assistant text longer than server)', () => {
    const local = [M('a', 'assistant', 'hello world streaming…', { _seq: 5 })]
    const server = [M('a', 'assistant', 'hello world', { _seq: 5 })]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    // local supersedes (prefix match) → keep local text, overlay server-auth
    assert.equal(merged[0].text, 'hello world streaming…')
  })

  it('overlays server-authoritative fields onto local-supersede winner', () => {
    const local = [M('a', 'assistant', 'streaming text', { _seq: 3 })]
    const server = [M('a', 'assistant', 'streaming text', { _seq: 5, usage: { in: 10 } })]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.notEqual(merged[0], local[0], '_seq diff → fresh object')
    assert.equal(merged[0]._seq, 5)
    assert.equal(merged[0].usage.in, 10)
    assert.equal(merged[0].text, 'streaming text')
  })

  it('server wins when local does not supersede (e.g. server text longer)', () => {
    const local = [M('a', 'assistant', 'short', { _seq: 1 })]
    const server = [M('a', 'assistant', 'short and then some more', { _seq: 2 })]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.equal(merged[0], server[0])
    assert.equal(merged[0].text, 'short and then some more')
  })

  it('PRESERVES fresh trailing local-only streaming tail (the bug fix)', () => {
    const local = [
      M('u1', 'user', 'question'),
      M('a1', 'assistant', 'partial reply…', { completedAt: NOW - 1000 }),
    ]
    // Server has only the user message — assistant tape not flushed yet.
    const server = [M('u1', 'user', 'question')]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'a1'],
    )
    assert.equal(merged[1], local[1], 'fresh tail preserved by ref')
  })

  it('DROPS stale trailing local-only assistant (page-reload revived stale tail)', () => {
    const local = [
      M('u1', 'user', 'question'),
      M('a1', 'assistant', 'stale partial', { completedAt: NOW - 60_000 }),
    ]
    const server = [M('u1', 'user', 'question')]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1'],
    )
  })

  it('DROPS mid-array local-only row (cross-device delete wins)', () => {
    const local = [
      M('u1', 'user', 'q1'),
      M('a1', 'assistant', 'old', { completedAt: NOW - 1000 }),
      M('u2', 'user', 'q2'),
    ]
    // Server deleted the middle assistant from another device.
    const server = [M('u1', 'user', 'q1'), M('u2', 'user', 'q2')]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'u2'],
    )
  })

  it('DROPS trailing local-only tool row (only assistant/thinking pass grace)', () => {
    const local = [M('u1', 'user', 'q'), M('t1', 'tool', 'output', { completedAt: NOW - 1000 })]
    const server = [M('u1', 'user', 'q')]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1'],
    )
  })

  it('appends multiple fresh trailing local-only rows in order', () => {
    const local = [
      M('u1', 'user', 'q'),
      M('th1', 'thinking', 'thinking…', { completedAt: NOW - 500 }),
      M('a1', 'assistant', 'replying…', { completedAt: NOW - 200 }),
    ]
    const server = [M('u1', 'user', 'q')]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'th1', 'a1'],
    )
  })

  it('handles non-array inputs defensively', () => {
    assert.deepEqual(_mergeServerWithLocalSuperset(null as any, null as any, NOW), [])
    assert.deepEqual(
      _mergeServerWithLocalSuperset([M('a', 'user', 'x')], null as any, NOW).map((m) => m.id),
      ['a'],
    )
  })

  it('skips server entries without id', () => {
    const server = [{ role: 'user', text: 'no id' }, M('a', 'user', 'has id')]
    const merged = _mergeServerWithLocalSuperset(server as any, [], NOW)
    assert.deepEqual(
      merged.map((m) => m.id),
      ['a'],
    )
  })

  it('stops grace-walk on first row that fails predicate (preserves only contiguous tail)', () => {
    // local has [stale assistant, fresh assistant] AFTER server's last id.
    // The trailing fresh one passes; we should NOT include the stale one
    // even though it's local-only — the contiguous-tail rule stops at it.
    const local = [
      M('u1', 'user', 'q'),
      M('a_old', 'assistant', 'old', { completedAt: NOW - 60_000 }),
      M('a_new', 'assistant', 'new', { completedAt: NOW - 100 }),
    ]
    const server = [M('u1', 'user', 'q')]
    const merged = _mergeServerWithLocalSuperset(server, local, NOW)
    // Walking from end: a_new passes grace → include. a_old fails grace → stop.
    // u1 is in server → loop break.
    assert.deepEqual(
      merged.map((m) => m.id),
      ['u1', 'a_new'],
    )
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

// ═══════════════════════════════════════════════════════════════════
// _overlayServerOntoLocalDominant
//
// Regression coverage for Codex round-1 finding: the 409 local-dominates
// branch used to call _mergeServerWithLocalSuperset by mistake, which
// would drop any local suffix row that isn't a fresh streaming tail
// (user messages, tool rows, old assistant rows). _overlayServerOntoLocalDominant
// preserves the FULL local suffix and only overlays server-auth metadata
// on the matching prefix.
// ═══════════════════════════════════════════════════════════════════

describe('_overlayServerOntoLocalDominant', () => {
  it('preserves full local suffix including non-streaming roles (THE BUG)', () => {
    // The exact scenario Codex flagged: local has a user message and a
    // tool row beyond server's last index — both must survive intact.
    const local = [
      { id: 'u1', role: 'user', text: 'first', _seq: 1 },
      { id: 'a1', role: 'assistant', text: 'reply', _seq: 2 },
      { id: 'u2', role: 'user', text: 'follow-up', _source: 'client' }, // local-only
      { id: 't1', role: 'tool', text: 'output', _source: 'client' },    // local-only
    ]
    const server = [
      { id: 'u1', role: 'user', text: 'first', _seq: 1 },
      { id: 'a1', role: 'assistant', text: 'reply', _seq: 2, usage: { in: 10, out: 20 } },
    ]
    const result = _overlayServerOntoLocalDominant(local, server)
    assert.equal(result.length, 4, 'all 4 local rows preserved')
    assert.deepEqual(
      result.map((m: any) => m.id),
      ['u1', 'a1', 'u2', 't1'],
    )
    // Prefix overlay: a1 got server.usage
    assert.deepEqual(result[1].usage, { in: 10, out: 20 })
    // Suffix preserved as-is (same refs)
    assert.equal(result[2], local[2], 'u2 ref preserved')
    assert.equal(result[3], local[3], 't1 ref preserved')
  })

  it('preserves ref on prefix rows when no server-auth field differs', () => {
    const local = [
      { id: 'u1', role: 'user', text: 'hi', _seq: 1 },
      { id: 'a1', role: 'assistant', text: 'yo', _seq: 2 },
    ]
    const server = [
      { id: 'u1', role: 'user', text: 'hi', _seq: 1 },
      { id: 'a1', role: 'assistant', text: 'yo', _seq: 2 },
    ]
    const result = _overlayServerOntoLocalDominant(local, server)
    assert.equal(result[0], local[0], 'u1 ref preserved (WeakMap fast path)')
    assert.equal(result[1], local[1], 'a1 ref preserved')
  })

  it('returns fresh ref on prefix rows when server-auth field differs', () => {
    const local = [
      { id: 'a1', role: 'assistant', text: 'partial', _seq: 0, usage: null },
    ]
    const server = [
      { id: 'a1', role: 'assistant', text: 'partial', _seq: 5, usage: { in: 1 } },
    ]
    const result = _overlayServerOntoLocalDominant(local, server)
    assert.notEqual(result[0], local[0], 'fresh ref so reconcile picks up change')
    assert.equal(result[0]._seq, 5)
    assert.deepEqual(result[0].usage, { in: 1 })
    // Local fields preserved beyond the overlay
    assert.equal(result[0].text, 'partial')
  })

  it('handles empty server (everything is local suffix)', () => {
    const local = [
      { id: 'u1', role: 'user', text: 'first', _source: 'client' },
      { id: 'u2', role: 'user', text: 'second', _source: 'client' },
    ]
    const result = _overlayServerOntoLocalDominant(local, [])
    assert.equal(result.length, 2)
    assert.equal(result[0], local[0])
    assert.equal(result[1], local[1])
  })

  it('returns empty when local is empty (contract: _localDominates ensures server.length <= local.length)', () => {
    // _localDominates(server, []) with non-empty server returns false →
    // we never enter the local-dominates branch with this shape. The
    // helper's contract is "overlay onto local"; if local is empty there
    // is nothing to overlay onto and the only safe answer is []. Returning
    // server.slice() here would silently swap to server-wins semantics
    // without rebindStreamingPointers / retry bookkeeping → a worse bug.
    const result = _overlayServerOntoLocalDominant([], [{ id: 's1', role: 'assistant' }])
    assert.deepEqual(result, [])
  })

  it('handles non-array local (defensive)', () => {
    const result = _overlayServerOntoLocalDominant(null as any, [{ id: 's1', role: 'user' }])
    assert.equal(result.length, 1)
  })

  it('handles both empty', () => {
    assert.deepEqual(_overlayServerOntoLocalDominant([], []), [])
  })

  it('skips overlay when ids mismatch at same position (defensive — should not occur post-_localDominates)', () => {
    // If _localDominates ever drifts and lets this through, helper falls
    // back to keeping the local row rather than corrupting it with a
    // mismatched server overlay.
    const local = [{ id: 'a', role: 'user', text: 'A' }]
    const server = [{ id: 'b', role: 'user', text: 'B', _seq: 99 }]
    const result = _overlayServerOntoLocalDominant(local, server)
    assert.equal(result[0], local[0], 'mismatched id → keep local')
    assert.equal(result[0]._seq, undefined, 'no server-auth overlay applied')
  })

  it('preserves order of long local suffix beyond a multi-row server prefix', () => {
    const local = [
      { id: 'u1', role: 'user', text: 'a' },
      { id: 'a1', role: 'assistant', text: 'b' },
      { id: 'u2', role: 'user', text: 'c' },
      { id: 'a2', role: 'assistant', text: 'd' },
      { id: 'u3', role: 'user', text: 'e' },
      { id: 't1', role: 'tool', text: 'f' },
    ]
    const server = [
      { id: 'u1', role: 'user', text: 'a', _seq: 1 },
      { id: 'a1', role: 'assistant', text: 'b', _seq: 2 },
      { id: 'u2', role: 'user', text: 'c', _seq: 3 },
    ]
    const result = _overlayServerOntoLocalDominant(local, server)
    assert.deepEqual(
      result.map((m: any) => m.id),
      ['u1', 'a1', 'u2', 'a2', 'u3', 't1'],
    )
  })
})
