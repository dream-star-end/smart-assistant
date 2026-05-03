/**
 * Unit tests for sync.js incremental GET helpers (Plan v3).
 *
 * Covers:
 *   - _computeSinceSeqForFetch: produces a valid `since` cursor only when
 *     incremental GET is safe (no _liveStreamBroken / _dirty / legacy msgs)
 *   - _mergePartialTail: appends tail with same-id replacement, returns null
 *     on count or maxSeq mismatch (caller must fall back to full GET)
 *
 * Uses the same source-extract + new Function() pattern as
 * syncConflictMerge.test.ts to avoid pulling in browser-only globals.
 *
 * Run: npx tsx --test packages/web/__tests__/syncIncremental.test.ts
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

const _combined =
  extractTopLevelFn(SYNC_SRC, '_computeSinceSeqForFetch') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_mergePartialTail')

const _helpers = new Function(
  `${_combined}; return { _computeSinceSeqForFetch, _mergePartialTail };`,
)() as {
  _computeSinceSeqForFetch: (sess: any) => number
  _mergePartialTail: (
    local: any[],
    tail: any[],
    expectedCount: number,
    expectedMaxSeq: number,
  ) => any[] | null
}
const _computeSinceSeqForFetch = _helpers._computeSinceSeqForFetch
const _mergePartialTail = _helpers._mergePartialTail

const m = (id: string, seq: number, extra: Record<string, unknown> = {}) => ({
  id,
  role: 'user',
  text: '',
  ts: 1000 + seq,
  _seq: seq,
  ...extra,
})

// ═══════════════════════════════════════════════════════════════════
// _computeSinceSeqForFetch
// ═══════════════════════════════════════════════════════════════════

describe('_computeSinceSeqForFetch', () => {
  it('returns 0 for null session', () => {
    assert.equal(_computeSinceSeqForFetch(null), 0)
    assert.equal(_computeSinceSeqForFetch(undefined), 0)
  })

  it('returns 0 when messages is empty', () => {
    assert.equal(_computeSinceSeqForFetch({ messages: [] }), 0)
  })

  it('returns 0 for _liveStreamBroken session (force-fetch must see whole tape)', () => {
    assert.equal(
      _computeSinceSeqForFetch({
        _liveStreamBroken: true,
        messages: [m('a', 1), m('b', 2)],
      }),
      0,
    )
  })

  it('returns 0 for _dirty session (defensive — should not reach fetch path)', () => {
    assert.equal(
      _computeSinceSeqForFetch({
        _dirty: true,
        messages: [m('a', 1), m('b', 2)],
      }),
      0,
    )
  })

  it('returns 0 when ANY message lacks _seq (legacy row)', () => {
    assert.equal(
      _computeSinceSeqForFetch({
        messages: [m('a', 1), { id: 'b', role: 'user', text: '', ts: 200 }],
      }),
      0,
    )
  })

  it('returns max _seq when all messages have valid _seq', () => {
    assert.equal(
      _computeSinceSeqForFetch({
        messages: [m('a', 3), m('b', 1), m('c', 7), m('d', 2)],
      }),
      7,
    )
  })

  it('rejects non-finite _seq values', () => {
    assert.equal(
      _computeSinceSeqForFetch({
        messages: [m('a', 1), { id: 'b', _seq: NaN, role: 'user', text: '', ts: 100 }],
      }),
      0,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════
// _mergePartialTail
// ═══════════════════════════════════════════════════════════════════

describe('_mergePartialTail', () => {
  it('appends new messages from tail and passes sanity', () => {
    const local = [m('a', 1), m('b', 2)]
    const tail = [m('c', 3), m('d', 4)]
    const merged = _mergePartialTail(local, tail, 4, 4)
    assert.notEqual(merged, null)
    assert.deepEqual(
      merged!.map((x: any) => x.id),
      ['a', 'b', 'c', 'd'],
    )
  })

  it('returns null when count mismatches (hole or extra)', () => {
    const local = [m('a', 1), m('b', 2)]
    const tail = [m('c', 3)]
    // Server claims totalMessageCount=4 but we only have 3 after merge
    assert.equal(_mergePartialTail(local, tail, 4, 3), null)
  })

  it('returns null when maxSeq mismatches', () => {
    const local = [m('a', 1)]
    const tail = [m('b', 2)]
    // Server claims maxSeq=99 but merged max is 2
    assert.equal(_mergePartialTail(local, tail, 2, 99), null)
  })

  it('replaces same-id message in place when server reallocated _seq (Codex caveat)', () => {
    // Power case: a message originally at _seq=2 had its content rewritten
    // by server (e.g., turn.completed substituted authoritative server text).
    // Server reassigned it to _seq=5, and the tail-only response carries
    // ONLY that replacement — local length stays the same, but maxSeq advances.
    const local = [m('a', 1), m('b', 2, { text: 'partial' })]
    const tail = [m('b', 5, { text: 'full server text', _source: 'server' })]
    const merged = _mergePartialTail(local, tail, 2, 5)
    assert.notEqual(merged, null, 'sanity passes: count=2, maxSeq=5')
    assert.equal(merged!.length, 2)
    assert.equal(merged![0].id, 'a')
    assert.equal(merged![1].id, 'b')
    assert.equal(merged![1].text, 'full server text', 'replaced with server version')
    assert.equal(merged![1]._seq, 5, '_seq advanced')
  })

  it('handles empty tail (nothing to apply, just sanity check)', () => {
    const local = [m('a', 1), m('b', 2)]
    const merged = _mergePartialTail(local, [], 2, 2)
    assert.notEqual(merged, null)
    assert.equal(merged!.length, 2)
  })

  it('returns null on empty tail when sanity disagrees', () => {
    const local = [m('a', 1)]
    // Server says total=2 but we have 1 and tail is empty
    assert.equal(_mergePartialTail(local, [], 2, 2), null)
  })

  it('skips tail entries without id (defensive)', () => {
    const local = [m('a', 1)]
    const tail = [{ role: 'user', text: 'noid' }, m('b', 2)]
    const merged = _mergePartialTail(local, tail, 2, 2)
    assert.notEqual(merged, null)
    assert.equal(merged!.length, 2)
    assert.deepEqual(merged!.map((x: any) => x.id), ['a', 'b'])
  })

  it('non-array local treated as empty', () => {
    const tail = [m('a', 1), m('b', 2)]
    const merged = _mergePartialTail(null as any, tail, 2, 2)
    assert.notEqual(merged, null)
    assert.equal(merged!.length, 2)
  })
})
