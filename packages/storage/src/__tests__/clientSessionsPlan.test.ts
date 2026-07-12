// clientSessionsPlan 纯函数单测(引擎中立,零 DB)。
//
// 这些函数是双 backend(SQLite / PG)的共享决策权威(RFC D6b)。此处直测纯决策,
// 与 sessionsArchiveSpill.test.ts(经 SQLite backend 端到端跑 _spillOverflowCore/append)
// 互补:那边守"决策 + 执行"整体行为,这边守"决策本身"在无 DB 下的字节级不变量。

import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AppendServerAuthoredPlan,
  planAppendServerAuthored,
  planSpillOverflow,
} from '../clientSessionsPlan.js'
import {
  MAX_SESSION_BYTES,
  type MessageLike,
  SESSION_TAIL_MIN_MSGS,
  SESSION_TAIL_TARGET_BYTES,
} from '../sessionsDb.js'

type Msg = MessageLike & { id: string; role: string; text: string; ts: number; _seq: number }

function makeMsgs(n: number, bytesEach: number, prefix = 'm'): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${prefix}-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'x'.repeat(bytesEach),
      ts: 1000 + i,
      _seq: i + 1,
    })
  }
  return out
}

describe('planSpillOverflow — no-op 分支', () => {
  it('阈值内:tail 同引用返回,无 chunk,水位=既有', () => {
    const msgs = makeMsgs(10, 1024) // ~10KB « 2.5MB
    const plan = planSpillOverflow(msgs, 0)
    assert.equal(plan.tail, msgs, 'tail 是同一引用(快路径零副作用)')
    assert.equal(plan.chunksToInsert.length, 0)
    assert.equal(plan.idsToInsert.length, 0)
    assert.equal(plan.archivedThroughSeq, 0)
  })

  it('既有水位透传:no-op 时 archivedThroughSeq = 入参水位', () => {
    const plan = planSpillOverflow(makeMsgs(5, 512), 42)
    assert.equal(plan.archivedThroughSeq, 42)
  })

  it('缺 _seq:超阈值也不 spill(安全 no-op,原样返回)', () => {
    const msgs = makeMsgs(300, 11 * 1024) // ~3.3MB 触发
    // 抹掉其中一条的 _seq
    ;(msgs[100] as { _seq?: number })._seq = undefined
    const plan = planSpillOverflow(msgs, 0)
    assert.equal(plan.tail, msgs, '缺 _seq → 原样返回同引用')
    assert.equal(plan.chunksToInsert.length, 0)
  })

  it('总条数 ≤ MIN_MSGS:不搬(保住兜底注入窗口)', () => {
    // 每条 50KB × 64 = 3.2MB 超软阈值,但条数正好 = MIN_MSGS → 不搬。
    const msgs = makeMsgs(SESSION_TAIL_MIN_MSGS, 50 * 1024)
    const plan = planSpillOverflow(msgs, 0)
    assert.equal(plan.tail, msgs)
    assert.equal(plan.chunksToInsert.length, 0)
  })
})

describe('planSpillOverflow — spill 决策', () => {
  it('超阈值:spilled+tail=原集、尾巴≥MIN、水位=max(spilled._seq)、_seq 冻结', () => {
    const N = 300
    const msgs = makeMsgs(N, 11 * 1024) // ~3.3MB
    const plan = planSpillOverflow(msgs, 0)
    const spilledCount = N - plan.tail.length
    assert.ok(spilledCount > 0, '确实搬走了')
    assert.ok(plan.tail.length >= SESSION_TAIL_MIN_MSGS, `尾巴 ≥ ${SESSION_TAIL_MIN_MSGS}`)

    // 尾巴字节 ≤ target + 一条宽容(软目标)
    const tailBytes = Buffer.byteLength(JSON.stringify(plan.tail), 'utf8')
    assert.ok(tailBytes <= SESSION_TAIL_TARGET_BYTES + 12 * 1024, '尾巴字节 ≈ ≤ target')

    // chunk 总条数 = 搬走条数;idsToInsert = spilled 全部 id(按序)
    const sumChunk = plan.chunksToInsert.reduce((a, c) => a + c.messageCount, 0)
    assert.equal(sumChunk, spilledCount, 'chunk 总条数 = 搬走条数')
    assert.deepEqual(
      plan.idsToInsert,
      msgs.slice(0, spilledCount).map((m) => m.id),
      'idsToInsert = spilled 段 id,原序',
    )

    // 搬走的是最老的一段:_seq 1..spilledCount;水位 = spilledCount
    assert.equal(plan.archivedThroughSeq, spilledCount, '水位 = max(spilled._seq)')
    assert.equal((plan.tail[0] as Msg)._seq, spilledCount + 1, '尾巴首条 _seq 冻结')

    // 每条归档消息 _seq 与原值一致(冻结、未重排)
    const byId = new Map(msgs.map((m) => [m.id, m._seq]))
    for (const c of plan.chunksToInsert) {
      for (const m of c.messages) assert.equal((m as Msg)._seq, byId.get(m.id as string))
      // chunk first/last = 段内 _seq min/max
      const seqs = c.messages.map((m) => (m as Msg)._seq)
      assert.equal(c.firstSeq, Math.min(...seqs))
      assert.equal(c.lastSeq, Math.max(...seqs))
    }
  })

  it('尾巴下限优先:溢出集中在最新 64 条,只搬 (N-64) 条', () => {
    const N = 70
    const msgs = makeMsgs(N, 50 * 1024) // ~3.5MB;maxSpill = 70-64 = 6
    const plan = planSpillOverflow(msgs, 0)
    assert.equal(plan.tail.length, SESSION_TAIL_MIN_MSGS, '尾巴被下限钳到 64')
    const spilled = plan.chunksToInsert.reduce((a, c) => a + c.messageCount, 0)
    assert.equal(spilled, N - SESSION_TAIL_MIN_MSGS, '只搬 6 条')
  })

  it('确定性:同输入两次调用产出结构一致(纯函数)', () => {
    const a = planSpillOverflow(makeMsgs(300, 11 * 1024), 0)
    const b = planSpillOverflow(makeMsgs(300, 11 * 1024), 0)
    assert.equal(a.tail.length, b.tail.length)
    assert.equal(a.archivedThroughSeq, b.archivedThroughSeq)
    assert.deepEqual(a.idsToInsert, b.idsToInsert)
    assert.deepEqual(
      a.chunksToInsert.map((c) => [c.firstSeq, c.lastSeq, c.messageCount]),
      b.chunksToInsert.map((c) => [c.firstSeq, c.lastSeq, c.messageCount]),
    )
  })
})

describe('planAppendServerAuthored', () => {
  const newMsg = (id: string, seq?: number): MessageLike & { id: string } => ({
    id,
    role: 'assistant',
    text: 'hi',
    ts: 5000,
    ...(seq != null ? { _seq: seq } : {}),
  })

  it('叠加新 server 行:kind=write,末条盖 _source=server + 新 _seq,nextSeq 递增', () => {
    const existing = makeMsgs(3, 512) // next_seq 应从 4 起
    const plan = planAppendServerAuthored(existing, newMsg('srv-1'), 4, 0)
    assert.equal(plan.kind, 'write')
    if (plan.kind !== 'write') return
    const appended = plan.tail.find((m) => m.id === 'srv-1') as (Msg & { _source?: string }) | undefined
    assert.ok(appended, '新行进 tail')
    assert.equal(appended?._source, 'server', 'appendServerAuthoredPure 盖 _source=server')
    assert.equal(appended?._seq, 4, '新行拿新 _seq=4(currentNextSeq)')
    assert.equal(plan.nextSeq, 5, 'nextSeq 递增到 5')
    assert.equal(plan.chunksToInsert.length, 0, '小会话不 spill')
    assert.equal(plan.finalJson, JSON.stringify(plan.tail), 'finalJson = stringify(tail)')
  })

  it('幂等:已存在同 id 的 server 行 → kind=already_exists', () => {
    const existing: MessageLike[] = [
      ...makeMsgs(2, 256),
      { id: 'srv-dup', role: 'assistant', text: 'done', ts: 6000, _seq: 3, _source: 'server' },
    ]
    const plan = planAppendServerAuthored(existing, newMsg('srv-dup'), 4, 0)
    assert.equal(plan.kind, 'already_exists')
  })

  it('oversized:spill 无法把 tail 降到 MAX 以内(溢出集中在最新 MIN_MSGS 条)→ kind=oversized', () => {
    // 64 条各 ~68KB = ~4.4MB 且都在下限窗口内 → spill 搬无可搬 → tail 仍 > 4MB。
    const existing = makeMsgs(SESSION_TAIL_MIN_MSGS, 68 * 1024)
    // sanity:构造确实 > MAX(否则测不到 oversized 分支)
    assert.ok(
      Buffer.byteLength(JSON.stringify(existing), 'utf8') > MAX_SESSION_BYTES,
      '前置:existing 已 > MAX_SESSION_BYTES',
    )
    const plan: AppendServerAuthoredPlan = planAppendServerAuthored(
      existing,
      newMsg('srv-big'),
      SESSION_TAIL_MIN_MSGS + 1,
      0,
    )
    assert.equal(plan.kind, 'oversized')
  })
})
