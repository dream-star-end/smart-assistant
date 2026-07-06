/**
 * Fix A durable — 委派成本按父客户端会话归并(drainDelegateCostForClientSession)的
 * 金钱路径单测。锁死:
 *   - 队长行落库后,N 条 delegate pending(parent_session_id=clientSession)求和累加进队长行;
 *   - codex map patch(requestId 池) 与 client-session drain(parent_session_id 池)**不重复计**;
 *   - ccb by-agent-session drain(session_id 池)与 client-session drain **不重复计**;
 *   - 晚到 delegate pending 由**下一 turn**的队长行 drain 命中;
 *   - 无委派成本 → 零副作用(不 bump next_seq);
 *   - parent_session_id 为 NULL 的既有行(普通/自费)永不被委派 drain 误吞(向后兼容 / 列幂等)。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/delegateCostAggregation.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-delegate-cost-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendCostCredits,
  appendServerAuthoredMessageForRequest,
  appendServerAuthoredMessageDrainByUser,
  drainDelegateCostForClientSession,
  getSessionsDb,
  upsertClientSession,
} = await import('../sessionsDb.js')

const CLIENT_SESSION = 'web-leader-01' // 父客户端会话(= 队长 sink body.sessionId / 委派 parent_session_id)

interface MessageRow {
  id?: string
  _source?: string
  _seq?: number
  usage?: { costCredits?: string; [k: string]: unknown }
  [k: string]: unknown
}
interface SessionRow { messages: string; next_seq: number | null }

async function getSessRow(sessId: string, userId: string): Promise<SessionRow | undefined> {
  const db = await getSessionsDb()
  return db
    .prepare('SELECT messages, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(sessId, userId) as SessionRow | undefined
}
async function getMessages(sessId: string, userId: string): Promise<MessageRow[]> {
  const row = await getSessRow(sessId, userId)
  return row ? (JSON.parse(row.messages) as MessageRow[]) : []
}
async function leaderCost(sessId: string, userId: string, msgId: string): Promise<string | undefined> {
  const m = (await getMessages(sessId, userId)).find((x) => x.id === msgId)
  return m?.usage?.costCredits
}
async function pendingCount(userId: string): Promise<number> {
  const db = await getSessionsDb()
  const r = db.prepare('SELECT COUNT(*) AS n FROM pending_usage_patches WHERE user_id = ?').get(userId) as { n: number }
  return r.n
}
async function delegatePendingCount(userId: string, clientSessionId: string): Promise<number> {
  const db = await getSessionsDb()
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM pending_usage_patches WHERE user_id = ? AND parent_session_id = ?')
    .get(userId, clientSessionId) as { n: number }
  return r.n
}
async function ensureSession(userId: string, sessId: string = CLIENT_SESSION): Promise<void> {
  await upsertClientSession({
    id: sessId, userId, agentId: 'main', title: 't', pinned: false,
    createdAt: 1, lastAt: 1, messages: [], updatedAt: 1,
  })
}
async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM server_authored_request_map')
  db.exec('DELETE FROM pending_usage_patches')
}

describe('delegate cost aggregation — column presence + isolation', () => {
  before(async () => { await clearTables() })

  it('pending_usage_patches 有 parent_session_id 列;NULL-parent 行不被委派 drain 命中', async () => {
    const db = await getSessionsDb()
    const cols = db.pragma('table_info(pending_usage_patches)') as Array<{ name: string }>
    assert.ok(cols.some((c) => c.name === 'parent_session_id'), 'parent_session_id 列存在(DDL/幂等 ADD)')

    const userId = 'c:iso'
    await ensureSession(userId)
    // 队长自费(ccb 口径:只有 session_id,parent_session_id 恒 NULL)。
    await appendCostCredits('req-self', userId, '10', 'engine-leader', null)
    // 委派子会话(parent_session_id = 父客户端会话)。
    await appendCostCredits('req-deleg', userId, '3', 'engine-deleg', CLIENT_SESSION)

    // 委派 drain 目标行还没落库 → 保守不动 pending(msgId 找不到)。
    const r0 = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, 'srv-missing')
    assert.deepEqual(r0, { merged: '0', drained: 0 }, '目标行缺位 → 不排空,零副作用')
    assert.equal(await pendingCount(userId), 2, '两条 pending 都保留')
    assert.equal(await delegatePendingCount(userId, CLIENT_SESSION), 1, '仅 1 条属委派(NULL-parent 不算)')
  })
})

describe('delegate cost aggregation — codex 队长(requestId 池) + 委派(parent 池)不重复计', () => {
  beforeEach(async () => { await clearTables() })

  it('队长行 costCredits = 自费 + Σdelegate;两池 disjoint,二次 drain 幂等', async () => {
    const userId = 'c:codex'
    await ensureSession(userId)
    const leaderMsgId = 'srv-web-leader-01-main-t1'

    // 队长(codex)自费:先落助手行(ForRequest 带 leaderReqId),再 appendCostCredits 按 requestId 补丁。
    const w = await appendServerAuthoredMessageForRequest('req-leader', CLIENT_SESSION, userId, {
      id: leaderMsgId, role: 'assistant' as const, text: '队长综合回答', ts: 1000, status: 'completed',
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    assert.deepEqual(w, { applied: true })
    const p = await appendCostCredits('req-leader', userId, '10') // 命中 map → 队长自费 10
    assert.deepEqual(p, { applied: 'patched' })
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '10', '队长自费 10 先入账')

    // 3 个委派成员各自的 LLM 成本 park(各自 requestId + 引擎会话;parent_session_id=父客户端会话)。
    await appendCostCredits('req-d1', userId, '3', 'engine-d1', CLIENT_SESSION)
    await appendCostCredits('req-d2', userId, '5', 'engine-d2', CLIENT_SESSION)
    await appendCostCredits('req-d3', userId, '2', 'engine-d3', CLIENT_SESSION)
    assert.equal(await delegatePendingCount(userId, CLIENT_SESSION), 3)

    // 队长行落库后的统一委派 drain:Σ=10 累加进队长行(base 10 → 20)。
    const d = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.deepEqual(d, { merged: '10', drained: 3 })
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '20', '10 自费 + 10 委派 = 20(不重复计)')
    assert.equal(await delegatePendingCount(userId, CLIENT_SESSION), 0, '委派 pending 全清')

    // 二次 drain(sink POST 重放 / already_exists):无新委派 pending → 幂等 no-op,不再累加。
    const d2 = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.deepEqual(d2, { merged: '0', drained: 0 })
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '20', '幂等:仍为 20')
  })
})

describe('delegate cost aggregation — ccb 队长(session_id 池) + 委派(parent 池)不重复计', () => {
  beforeEach(async () => { await clearTables() })

  it('by-agent-session drain 只吃自费,委派行留给 client-session drain', async () => {
    const userId = 'c:ccb'
    await ensureSession(userId)
    const leaderMsgId = 'srv-web-leader-01-main-t1'

    // 队长(ccb)自费 park(session_id=队长引擎会话,parent_session_id=NULL)。
    await appendCostCredits('req-leader', userId, '10', 'engine-leader', null)
    // 委派成本 park(session_id=委派引擎会话,parent_session_id=父客户端会话)。
    await appendCostCredits('req-d1', userId, '4', 'engine-d1', CLIENT_SESSION)

    // 队长助手行落库走 drain-by-user 按 agentSessionId=队长引擎会话:只排空自费 10,不碰委派行。
    const w = await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: leaderMsgId, role: 'assistant' as const, text: '队长回答', ts: 2000, status: 'completed', usage: {},
    }, 'engine-leader')
    assert.deepEqual(w, { applied: true })
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '10', '自费 10 合入')
    assert.equal(await delegatePendingCount(userId, CLIENT_SESSION), 1, '委派行未被 by-session drain 吞掉')

    // 统一委派 drain:再累加委派 4 → 14。
    const d = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.deepEqual(d, { merged: '4', drained: 1 })
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '14', '10 自费 + 4 委派 = 14(不重复计)')
    assert.equal(await pendingCount(userId), 0, 'pending 全清')
  })
})

describe('delegate cost aggregation — 晚到 pending 由下一 turn drain', () => {
  beforeEach(async () => { await clearTables() })

  it('本轮 sink 之后到达的委派 pending,归并到下一 turn 的队长行', async () => {
    const userId = 'c:late'
    await ensureSession(userId)
    const t1 = 'srv-web-leader-01-main-t1'
    const t2 = 'srv-web-leader-01-main-t2'

    // turn1 队长行落库 + 委派 3。
    await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: t1, role: 'assistant' as const, text: 'turn1', ts: 1000, status: 'completed', usage: {},
    }, 'engine-leader')
    await appendCostCredits('req-d1', userId, '3', 'engine-d1', CLIENT_SESSION)
    const d1 = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, t1)
    assert.deepEqual(d1, { merged: '3', drained: 1 })
    assert.equal(await leaderCost(CLIENT_SESSION, userId, t1), '3')

    // 晚到的 turn1 委派成本(req-d2)在 turn1 drain 之后才 park —— 归不进 t1。
    await appendCostCredits('req-d2', userId, '7', 'engine-d2', CLIENT_SESSION)
    // t1 再 drain 也能吃到(下一次 sink 重放 / 或 t1 仍是最近队长行):模拟"下一 turn"用 t2。
    await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: t2, role: 'assistant' as const, text: 'turn2', ts: 2000, status: 'completed', usage: {},
    }, 'engine-leader')
    const d2 = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, t2)
    assert.deepEqual(d2, { merged: '7', drained: 1 }, '晚到 pending 由 t2 drain 命中')
    assert.equal(await leaderCost(CLIENT_SESSION, userId, t2), '7')
    assert.equal(await leaderCost(CLIENT_SESSION, userId, t1), '3', 't1 不被二次累加')
  })
})

describe('delegate cost aggregation — 无委派成本零副作用', () => {
  beforeEach(async () => { await clearTables() })

  it('无 parent 匹配 pending → 不写库、不 bump next_seq', async () => {
    const userId = 'c:noop'
    await ensureSession(userId)
    const leaderMsgId = 'srv-web-leader-01-main-t1'
    await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: leaderMsgId, role: 'assistant' as const, text: 'no delegate', ts: 1000, status: 'completed', usage: {},
    }, 'engine-leader')
    const before = await getSessRow(CLIENT_SESSION, userId)

    const d = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.deepEqual(d, { merged: '0', drained: 0 })

    const after = await getSessRow(CLIENT_SESSION, userId)
    assert.equal(after?.next_seq, before?.next_seq, '无委派成本 → 不 bump next_seq(普通 turn 不受影响)')
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), undefined, '不臆造 costCredits')
  })
})

describe('delegate cost aggregation — P2 债D per-delegate 明细(usage.delegates[])', () => {
  beforeEach(async () => { await clearTables() })

  async function leaderDelegates(sessId: string, userId: string, msgId: string) {
    const m = (await getMessages(sessId, userId)).find((x) => x.id === msgId)
    return (m?.usage as { delegates?: Array<{ agentId: string; costCredits: string }> } | undefined)?.delegates
  }

  it('drain 按 delegate_agent_id 分组求和写进队长行 usage.delegates[](确定性排序);总额仍进 costCredits', async () => {
    const userId = 'c:deleg-detail'
    await ensureSession(userId)
    const leaderMsgId = 'srv-web-leader-01-main-t1'
    await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: leaderMsgId, role: 'assistant' as const, text: '队长综合', ts: 1000, status: 'completed', usage: {},
    }, 'engine-leader')

    // 两个 coding-assistant 委派(3+2)+ 一个 hidden-reviewer 审查(4)。第 6 参 = delegateAgentId。
    await appendCostCredits('req-d1', userId, '3', 'engine-d1', CLIENT_SESSION, 'coding-assistant')
    await appendCostCredits('req-d2', userId, '2', 'engine-d2', CLIENT_SESSION, 'coding-assistant')
    await appendCostCredits('req-rev', userId, '4', 'engine-rev', CLIENT_SESSION, 'hidden-reviewer')

    const d = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.equal(d.merged, '9', '3+2+4 = 9 归并总额')
    assert.equal(d.drained, 3)
    // 明细按 agentId 分组求和、agentId 升序:coding-assistant=5, hidden-reviewer=4。
    assert.deepEqual(d.delegates, [
      { agentId: 'coding-assistant', costCredits: '5' },
      { agentId: 'hidden-reviewer', costCredits: '4' },
    ])
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '9', '总额进 costCredits')
    assert.deepEqual(await leaderDelegates(CLIENT_SESSION, userId, leaderMsgId), [
      { agentId: 'coding-assistant', costCredits: '5' },
      { agentId: 'hidden-reviewer', costCredits: '4' },
    ], '明细落队长行 usage.delegates[]')
  })

  it('第二轮委派 drain 累加合并进已有 delegates[](不替换),支持多轮审查', async () => {
    const userId = 'c:deleg-merge'
    await ensureSession(userId)
    const leaderMsgId = 'srv-web-leader-01-main-t1'
    await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: leaderMsgId, role: 'assistant' as const, text: 'x', ts: 1000, status: 'completed', usage: {},
    }, 'engine-leader')

    // 第一轮:reviewer 审查花 4。
    await appendCostCredits('req-rev1', userId, '4', 'engine-rev1', CLIENT_SESSION, 'hidden-reviewer')
    await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.deepEqual(await leaderDelegates(CLIENT_SESSION, userId, leaderMsgId), [
      { agentId: 'hidden-reviewer', costCredits: '4' },
    ])

    // 第二轮(NEEDS_FIX 后再审):reviewer 再花 3 → 累加成 7,不覆盖。
    await appendCostCredits('req-rev2', userId, '3', 'engine-rev2', CLIENT_SESSION, 'hidden-reviewer')
    const d2 = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.equal(d2.merged, '3')
    assert.deepEqual(d2.delegates, [{ agentId: 'hidden-reviewer', costCredits: '7' }], '快照含历史合并')
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '7', 'costCredits 4→7')
    assert.deepEqual(await leaderDelegates(CLIENT_SESSION, userId, leaderMsgId), [
      { agentId: 'hidden-reviewer', costCredits: '7' },
    ], 'delegates[] 累加不替换')
  })

  it('缺 delegate_agent_id 的委派成本仍进总额、但不出现在 delegates[] 明细', async () => {
    const userId = 'c:deleg-null'
    await ensureSession(userId)
    const leaderMsgId = 'srv-web-leader-01-main-t1'
    await appendServerAuthoredMessageDrainByUser(CLIENT_SESSION, userId, {
      id: leaderMsgId, role: 'assistant' as const, text: 'x', ts: 1000, status: 'completed', usage: {},
    }, 'engine-leader')
    // 老 park(5 参,无 agentId)+ 一条带 agentId。
    await appendCostCredits('req-old', userId, '6', 'engine-old', CLIENT_SESSION)
    await appendCostCredits('req-new', userId, '2', 'engine-new', CLIENT_SESSION, 'office-assistant')
    const d = await drainDelegateCostForClientSession(CLIENT_SESSION, userId, leaderMsgId)
    assert.equal(d.merged, '8', '6+2 总额不丢')
    assert.deepEqual(d.delegates, [{ agentId: 'office-assistant', costCredits: '2' }], '仅带 agentId 的进明细')
    assert.equal(await leaderCost(CLIENT_SESSION, userId, leaderMsgId), '8')
  })
})
