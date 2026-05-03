/**
 * Tests for the `_seq` monotonic cursor invariant introduced for the
 * incremental client-session GET protocol (Plan v3).
 *
 * Invariant: after any write to a `client_sessions` row,
 *   - every message has a positive numeric `_seq`
 *   - `_seq` values within the row are unique
 *   - `next_seq` strictly exceeds max(_seq)
 *   - id+content unchanged → `_seq` inherited from oldMsgs
 *   - id new OR content changed (incl. _source flip) → fresh `_seq`
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsDbSeq.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  _messageContentEqualForSeq,
  normalizeAndAssignSeqs,
  type MessageLike,
} from '../sessionsDb.js'

type Msg = MessageLike & { id: string; role?: string; text?: string; _seq?: number }

const m = (id: string, ts: number, extra: Partial<Msg> = {}): Msg => ({
  id,
  role: 'user',
  text: '',
  ts,
  ...extra,
})

describe('_messageContentEqualForSeq', () => {
  it('treats messages with same content but different _seq as equal', () => {
    assert.equal(
      _messageContentEqualForSeq(
        { id: 'a', role: 'user', text: 'hi', ts: 1, _seq: 5 },
        { id: 'a', role: 'user', text: 'hi', ts: 1, _seq: 99 },
      ),
      true,
    )
  })
  it('treats `status` as ignored (client UI flag)', () => {
    assert.equal(
      _messageContentEqualForSeq(
        { id: 'a', role: 'user', text: 'hi', ts: 1, status: 'sent' },
        { id: 'a', role: 'user', text: 'hi', ts: 1, status: 'read' },
      ),
      true,
    )
  })
  it('treats `_source` flip as content change (server takeover)', () => {
    assert.equal(
      _messageContentEqualForSeq(
        { id: 'a', role: 'assistant', text: 'hi', ts: 1 },
        { id: 'a', role: 'assistant', text: 'hi', ts: 1, _source: 'server' },
      ),
      false,
    )
  })
  it('treats `text` change as content change', () => {
    assert.equal(
      _messageContentEqualForSeq(
        { id: 'a', role: 'assistant', text: 'short', ts: 1 },
        { id: 'a', role: 'assistant', text: 'short...continued', ts: 1 },
      ),
      false,
    )
  })
})

describe('normalizeAndAssignSeqs — happy path', () => {
  it('inherits _seq for unchanged messages, allocates fresh _seq for new ones', () => {
    const oldMsgs: Msg[] = [
      m('a', 100, { _seq: 1 }),
      m('b', 200, { _seq: 2 }),
    ]
    const finalMsgs: Msg[] = [
      m('a', 100, { _seq: 1 }),
      m('b', 200, { _seq: 2 }),
      m('c', 300),  // new message, no _seq
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 3)
    assert.equal(r.messages.length, 3)
    assert.equal((r.messages[0] as Msg)._seq, 1)
    assert.equal((r.messages[1] as Msg)._seq, 2)
    assert.equal((r.messages[2] as Msg)._seq, 3)
    assert.equal(r.nextSeq, 4)
    assert.equal(r.maxSeq, 3)
  })

  it('inherits _seq even when finalMsg lacks _seq (Codex review #4)', () => {
    // Client PUT typically strips client-only fields, may not carry _seq.
    // Server must NOT treat that as "new message, allocate fresh _seq".
    const oldMsgs: Msg[] = [m('a', 100, { _seq: 7 })]
    const finalMsgs: Msg[] = [m('a', 100)]  // same content, no _seq
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 8)
    assert.equal((r.messages[0] as Msg)._seq, 7, '_seq inherited from oldMsgs')
    assert.equal(r.nextSeq, 8, 'nextSeq unchanged when nothing was allocated')
  })

  it('reallocates _seq when same id has different content', () => {
    const oldMsgs: Msg[] = [m('a', 100, { _seq: 1, text: 'short' })]
    const finalMsgs: Msg[] = [m('a', 100, { _seq: 1, text: 'short and longer' })]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 2)
    assert.equal((r.messages[0] as Msg)._seq, 2, 'new _seq for changed content')
    assert.equal(r.nextSeq, 3)
  })

  it('reallocates _seq on server takeover (_source flip)', () => {
    const oldMsgs: Msg[] = [m('a', 100, { _seq: 1, role: 'assistant', text: 'partial' })]
    const finalMsgs: Msg[] = [
      m('a', 100, { _seq: 1, role: 'assistant', text: 'partial', _source: 'server' }),
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 2)
    assert.equal((r.messages[0] as Msg)._seq, 2)
  })

  it('does NOT reallocate when only `status` differs', () => {
    const oldMsgs: Msg[] = [m('a', 100, { _seq: 1, status: 'sent' })]
    const finalMsgs: Msg[] = [m('a', 100, { _seq: 1, status: 'read' })]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 2)
    assert.equal((r.messages[0] as Msg)._seq, 1, '_seq retained — status is client-only')
    assert.equal(r.nextSeq, 2, 'nothing allocated')
  })
})

describe('normalizeAndAssignSeqs — legacy backfill (Codex review #2)', () => {
  it('backfills oldMsgs without _seq before processing finalMsgs', () => {
    // Legacy row: oldMsgs all lack _seq. Migration default is next_seq=1.
    const oldMsgs: Msg[] = [m('a', 100), m('b', 200), m('c', 300)]
    // appendServerAuthoredMessage path: finalMsgs = [...old, newServerMsg]
    const finalMsgs: Msg[] = [
      m('a', 100),
      m('b', 200),
      m('c', 300),
      m('d', 400, { role: 'assistant', text: 'srv', _source: 'server' }),
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 1)
    // Old messages get _seq 1..3, new message gets _seq 4.
    assert.equal((r.messages[0] as Msg)._seq, 1)
    assert.equal((r.messages[1] as Msg)._seq, 2)
    assert.equal((r.messages[2] as Msg)._seq, 3)
    assert.equal((r.messages[3] as Msg)._seq, 4)
    assert.equal(r.nextSeq, 5, 'nextSeq advanced past all assignments — no overlap risk')
    assert.equal(r.maxSeq, 4)
  })

  it('backfills oldMsgs even when finalMsgs has _seq from a stale client', () => {
    // Adversarial: client PUT brings stale _seq values from a much older view;
    // server must trust its OWN backfill (oldById), not client-supplied _seq.
    const oldMsgs: Msg[] = [m('a', 100), m('b', 200)]  // legacy, no _seq
    const finalMsgs: Msg[] = [
      m('a', 100, { _seq: 999 }),   // bogus client _seq
      m('b', 200, { _seq: 998 }),
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 1)
    assert.equal((r.messages[0] as Msg)._seq, 1, 'server-side backfill wins over client _seq')
    assert.equal((r.messages[1] as Msg)._seq, 2)
    assert.equal(r.nextSeq, 3)
  })

  it('handles partial-legacy oldMsgs (some have _seq, some do not)', () => {
    // This shouldn't normally happen, but defensive: if ANY oldMsg lacks
    // _seq, treat the whole row as legacy and reassign in array order.
    const oldMsgs: Msg[] = [
      m('a', 100, { _seq: 5 }),  // claims _seq=5
      m('b', 200),               // no _seq
    ]
    const finalMsgs: Msg[] = [m('a', 100, { _seq: 5 }), m('b', 200)]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 6)
    // Reassigned in order: 1, 2.
    assert.equal((r.messages[0] as Msg)._seq, 1)
    assert.equal((r.messages[1] as Msg)._seq, 2)
    assert.equal(r.nextSeq, 3)
  })
})

describe('normalizeAndAssignSeqs — defensive next_seq correction', () => {
  it('forces nextSeq > max(oldMsgs._seq) when persisted next_seq has drifted', () => {
    // Pathological: row has messages with _seq up to 10 but next_seq=5
    // (e.g., manual SQL edit or a botched migration). Normalize must not
    // produce duplicate _seq.
    const oldMsgs: Msg[] = [m('a', 100, { _seq: 7 }), m('b', 200, { _seq: 10 })]
    const finalMsgs: Msg[] = [
      m('a', 100, { _seq: 7 }),
      m('b', 200, { _seq: 10 }),
      m('c', 300),
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 5)  // bogus low next_seq
    assert.equal((r.messages[2] as Msg)._seq, 11, 'fresh _seq strictly > max(oldMsgs._seq)')
    assert.equal(r.nextSeq, 12)
  })
})

describe('normalizeAndAssignSeqs — maxSeq computation (Codex review #5)', () => {
  it('returns maxSeq from messages array, not from nextSeq-1', () => {
    const oldMsgs: Msg[] = [m('a', 100, { _seq: 3 })]
    const finalMsgs: Msg[] = [m('a', 100, { _seq: 3 })]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 100)  // pretend next_seq is way ahead
    assert.equal(r.maxSeq, 3, 'maxSeq from messages, not nextSeq')
    assert.equal(r.nextSeq, 100, 'nextSeq passes through unchanged when nothing allocated')
  })
})
