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
  it('freezes _orderSeq while a content patch advances only the _seq version cursor', () => {
    const oldMsgs: Msg[] = [
      m('u1', 100, { role: 'user', _seq: 1, _orderSeq: 1 }),
      m('a1', 200, { role: 'assistant', text: 'draft', _seq: 2, _orderSeq: 2 }),
    ]
    const finalMsgs: Msg[] = [
      m('u1', 100, { role: 'user', _seq: 1 }),
      m('a1', 200, { role: 'assistant', text: 'final', _seq: 2 }),
    ]

    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 3)
    assert.equal((r.messages[0] as Msg)._seq, 1)
    assert.equal(r.messages[0]?._orderSeq, 1)
    assert.equal((r.messages[1] as Msg)._seq, 3)
    assert.equal(r.messages[1]?._orderSeq, 2)
  })

  it('derives legacy _orderSeq once from durable array order and restores it after a client reorder', () => {
    const oldMsgs: Msg[] = [
      m('u1', 100, { role: 'user', _seq: 5 }),
      m('a1', 400, { role: 'assistant', _seq: 13 }),
      m('u2', 300, { role: 'user', _seq: 6 }),
    ]
    const finalMsgs: Msg[] = [oldMsgs[0]!, oldMsgs[2]!, oldMsgs[1]!]

    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 14)
    assert.deepEqual(r.messages.map((row) => row.id), ['u1', 'a1', 'u2'])
    assert.deepEqual(r.messages.map((row) => row._orderSeq), [1, 2, 3])
    assert.deepEqual(r.messages.map((row) => row._seq), [5, 13, 6])
  })

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

  it('partial-legacy oldMsgs: preserves valid seq, backfills only the missing row (tail-flood fix)', () => {
    // 收紧后(tail-flood 根治):任一行已有合法 _seq 就不再整数组按位重编——旧实现会把
    // a 的 _seq 从 5 抹成 1,在并发窗口重排热行。现在 a 保留 5,只有缺号的 b 向后补号。
    const oldMsgs: Msg[] = [
      m('a', 100, { _seq: 5 }),  // 已有合法 _seq=5
      m('b', 200),               // 缺 _seq
    ]
    const finalMsgs: Msg[] = [m('a', 100, { _seq: 5 }), m('b', 200)]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 6)
    // a 保 5;b 从 max(currentNextSeq=6, maxValid+1=6)=6 补号。绝不从 1 整重编。
    assert.equal((r.messages[0] as Msg)._seq, 5)
    assert.equal((r.messages[1] as Msg)._seq, 6)
    assert.equal(r.nextSeq, 7)
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

describe('normalizeAndAssignSeqs — legacy tightening (tail-flood fix)', () => {
  it('1) partial-missing seq + advanced next_seq: keeps valid seq, backfills from max(next_seq, maxValid+1)', () => {
    // 部分行缺 seq、游标已推进:已有 seq 的 a/c 原样不动,只有缺号的 b 补号。
    const oldMsgs: Msg[] = [
      m('a', 100, { _seq: 3 }),
      m('b', 200),               // 缺 seq
      m('c', 300, { _seq: 7 }),
    ]
    const finalMsgs: Msg[] = [
      m('a', 100, { _seq: 3 }),
      m('b', 200),
      m('c', 300, { _seq: 7 }),
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 10)  // next_seq 已推进到 10
    // 已有合法 seq 的 a=3 / c=7 绝不重编;缺号的 b 从 max(10, 7+1)=10 补(此处 next_seq 胜出)。
    assert.equal((r.messages[0] as Msg)._seq, 3)
    assert.equal((r.messages[1] as Msg)._seq, 10)
    assert.equal((r.messages[2] as Msg)._seq, 7)
    assert.equal(r.nextSeq, 11)
    assert.equal(r.maxSeq, 10)
  })

  it('2) all-missing seq + next_seq<=1: still does true-legacy positional renumber from 1', () => {
    // 真 legacy:整行从未有 seq 且游标停在迁移默认值 → 保持既有整数组重编行为(既有用例不许红)。
    const oldMsgs: Msg[] = [m('a', 100), m('b', 200), m('c', 300)]
    const finalMsgs: Msg[] = [m('a', 100), m('b', 200), m('c', 300)]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 1)
    assert.equal((r.messages[0] as Msg)._seq, 1)
    assert.equal((r.messages[1] as Msg)._seq, 2)
    assert.equal((r.messages[2] as Msg)._seq, 3)
    assert.equal(r.nextSeq, 4)
    assert.equal(r.maxSeq, 3)
  })

  it('3) all-missing seq + next_seq>1 (drift): does NOT positional-renumber, backfills from next_seq', () => {
    // 漂移场景:全缺 seq 但游标已推进到 50 —— 若从 1 整重编会与早已发放的 1..49 撞号。
    // 收紧后走补号路径:从 max(50, 0+1)=50 起顺序补,不整重编。
    const oldMsgs: Msg[] = [m('a', 100), m('b', 200)]
    const finalMsgs: Msg[] = [m('a', 100), m('b', 200)]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 50)
    assert.equal((r.messages[0] as Msg)._seq, 50)
    assert.equal((r.messages[1] as Msg)._seq, 51)
    assert.equal(r.nextSeq, 52)
    assert.equal(r.maxSeq, 51)
  })

  it('4) duplicate _seq among oldMsgs: keeps first, reassigns the rest, invariants hold, warns', () => {
    // 旧行间 seq 重复(a 与 b 都是 5):不静默重排——第一条 a 保 5,重复的 b 换新号,
    // 并通过 onWarn 上报;所有不变量仍成立。
    const warnings: string[] = []
    const oldMsgs: Msg[] = [
      m('a', 100, { _seq: 5 }),
      m('b', 200, { _seq: 5 }),  // 与 a 重复
      m('c', 300, { _seq: 8 }),
    ]
    const finalMsgs: Msg[] = [
      m('a', 100, { _seq: 5 }),
      m('b', 200, { _seq: 5 }),
      m('c', 300, { _seq: 8 }),
    ]
    const r = normalizeAndAssignSeqs(oldMsgs, finalMsgs, 6, (msg) => warnings.push(msg))
    const seqs = r.messages.map((mm) => (mm as Msg)._seq as number)
    // 第一条 a 保 5;c 保 8;重复的 b 换新号(严格 > maxValid=8 → 9)。
    assert.equal(seqs[0], 5)
    assert.equal(seqs[2], 8)
    assert.equal(seqs[1], 9, 'duplicate row reassigned strictly above maxValidSeq')
    // 不变量:全为正整数 + 行内唯一 + nextSeq > max(_seq)。
    assert.ok(seqs.every((s) => Number.isInteger(s) && s > 0), 'every _seq is a positive integer')
    assert.equal(new Set(seqs).size, seqs.length, 'seqs unique within the row')
    assert.ok(r.nextSeq > Math.max(...seqs), 'nextSeq strictly greater than max(_seq)')
    // 不静默:重复必须被 onWarn 报告(恰好一条,针对重复的 b)。
    assert.equal(warnings.length, 1, 'duplicate reported via onWarn, not silently reordered')
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
