/**
 * Tests for the usage-aggregation single-writer design that pairs
 * `appendServerAuthoredMessageForRequest` with `appendCostCredits` (and the
 * `sweepUsageAggregationGc` cleanup helper).
 *
 * This covers plan §五 T3-T7c. Plus a minimal smoke test on the existing
 * `appendServerAuthoredMessage` path to make sure the refactor didn't
 * regress it.
 *
 * Why a fresh tmpdir + dynamic import: `paths.sessionsDb` is captured when
 * sessionsDb.ts is loaded; we MUST set OPENCLAUDE_HOME first.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/usageAggregation.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-usage-agg-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendCostCredits,
  appendServerAuthoredMessage,
  appendServerAuthoredMessageForRequest,
  appendServerAuthoredMessageDrainByUser,
  getSessionsDb,
  sweepUsageAggregationGc,
  upsertClientSession,
} = await import('../sessionsDb.js')

const SESSION_ID = 'sess-test01'

interface SessionRow {
  messages: string
  next_seq: number | null
}

interface PendingRow {
  request_id: string
  user_id: string
  cost_credits: string
  created_at: number
}

interface MapRow {
  request_id: string
  user_id: string
  session_id: string
  msg_id: string
  written_at: number
}

interface MessageRow {
  id?: string
  ts?: number
  _source?: string
  _seq?: number
  text?: string
  role?: string
  status?: string
  usage?: { costCredits?: string; inputTokens?: number; [k: string]: unknown }
  [k: string]: unknown
}

async function getSessRow(sessId: string, userId: string): Promise<SessionRow | undefined> {
  const db = await getSessionsDb()
  return db
    .prepare(
      'SELECT messages, next_seq FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(sessId, userId) as SessionRow | undefined
}

async function getMessages(sessId: string, userId: string): Promise<MessageRow[]> {
  const row = await getSessRow(sessId, userId)
  if (!row) return []
  return JSON.parse(row.messages) as MessageRow[]
}

async function getPendingRow(
  requestId: string,
  userId: string,
): Promise<PendingRow | undefined> {
  const db = await getSessionsDb()
  return db
    .prepare(
      'SELECT request_id, user_id, cost_credits, created_at FROM pending_usage_patches WHERE request_id = ? AND user_id = ?',
    )
    .get(requestId, userId) as PendingRow | undefined
}

async function getMapRow(
  requestId: string,
  userId: string,
): Promise<MapRow | undefined> {
  const db = await getSessionsDb()
  return db
    .prepare(
      'SELECT request_id, user_id, session_id, msg_id, written_at FROM server_authored_request_map WHERE request_id = ? AND user_id = ?',
    )
    .get(requestId, userId) as MapRow | undefined
}

async function getMapAllForRequest(requestId: string): Promise<MapRow[]> {
  const db = await getSessionsDb()
  return db
    .prepare(
      'SELECT request_id, user_id, session_id, msg_id, written_at FROM server_authored_request_map WHERE request_id = ?',
    )
    .all(requestId) as MapRow[]
}

async function getPendingAllForRequest(requestId: string): Promise<PendingRow[]> {
  const db = await getSessionsDb()
  return db
    .prepare(
      'SELECT request_id, user_id, cost_credits, created_at FROM pending_usage_patches WHERE request_id = ?',
    )
    .all(requestId) as PendingRow[]
}

async function ensureSession(userId: string, sessId: string = SESSION_ID): Promise<void> {
  await upsertClientSession({
    id: sessId,
    userId,
    agentId: 'main',
    title: 'test',
    pinned: false,
    createdAt: 1,
    lastAt: 1,
    messages: [],
    updatedAt: 1,
  })
}

async function insertPendingWithCreatedAt(
  requestId: string,
  userId: string,
  costCredits: string,
  createdAt: number,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    `INSERT INTO pending_usage_patches (request_id, user_id, session_id, cost_credits, created_at)
     VALUES (?, ?, NULL, ?, ?)`,
  ).run(requestId, userId, costCredits, createdAt)
}

async function insertMapWithWrittenAt(
  requestId: string,
  userId: string,
  sessId: string,
  msgId: string,
  writtenAt: number,
): Promise<void> {
  const db = await getSessionsDb()
  db.prepare(
    `INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id, written_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(requestId, userId, sessId, msgId, writtenAt)
}

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM server_authored_request_map')
  db.exec('DELETE FROM pending_usage_patches')
}

describe('usage aggregation: B-then-A path (sink first, commit later)', () => {
  before(async () => {
    await clearTables()
  })

  it('T3 patch in-place when message already written + map populated', async () => {
    const userId = 'u-T3'
    const requestId = 'req-T3'
    await ensureSession(userId)

    const r1 = await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, {
      id: 'srv-T3-t1',
      role: 'assistant' as const,
      text: 'hello world',
      ts: 1000,
      status: 'completed',
      usage: { inputTokens: 13178, outputTokens: 15, cacheReadTokens: 11648 },
    })
    assert.deepEqual(r1, { applied: true })

    // appendCostCredits comes after — should hit the map and patch in-place.
    const r2 = await appendCostCredits(requestId, userId, '8')
    assert.deepEqual(r2, { applied: 'patched' })

    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].id, 'srv-T3-t1')
    assert.equal(messages[0]._source, 'server')
    assert.equal(messages[0].usage?.costCredits, '8')
    assert.equal(messages[0].usage?.inputTokens, 13178, 'inputTokens preserved')
    assert.equal(messages[0].usage?.outputTokens, 15, 'outputTokens preserved')

    const sess = await getSessRow(SESSION_ID, userId)
    assert.ok(sess && (sess.next_seq ?? 0) >= 3, 'patch must bump next_seq above prior 2')
  })
})

describe('usage aggregation: A-then-B path (commit first, sink later)', () => {
  before(async () => {
    await clearTables()
  })

  it('T4 commit early → pending row then drained on sink POST', async () => {
    const userId = 'u-T4'
    const requestId = 'req-T4'
    await ensureSession(userId)

    // appendCostCredits arrives first — should park in pending.
    const r1 = await appendCostCredits(requestId, userId, '8')
    assert.deepEqual(r1, { applied: 'pending' })

    const pending = await getPendingRow(requestId, userId)
    assert.ok(pending, 'pending row written')
    assert.equal(pending!.cost_credits, '8')
    assert.equal(pending!.user_id, userId)

    // appendServerAuthoredMessageForRequest arrives second — drains pending,
    // merges costCredits into usage, deletes pending.
    const r2 = await appendServerAuthoredMessageForRequest(
      requestId,
      SESSION_ID,
      userId,
      {
        id: 'srv-T4-t1',
        role: 'assistant' as const,
        text: 'late hello',
        ts: 2000,
        status: 'completed',
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    )
    assert.deepEqual(r2, { applied: true })

    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].usage?.costCredits, '8', 'pending costCredits drained into usage')
    assert.equal(messages[0].usage?.inputTokens, 100, 'inputTokens kept from sink payload')

    assert.equal(await getPendingRow(requestId, userId), undefined, 'pending cleared')
    assert.ok(await getMapRow(requestId, userId), 'map row inserted')
  })
})

describe('usage aggregation: drain-by-user path (ccb-spawn, no per-turn requestId)', () => {
  before(async () => {
    await clearTables()
  })

  it('T-ccb: 多笔 pending(同 user、不同 requestId)在助手落库时求和合入 usage + 清空', async () => {
    const userId = 'c:777'
    await ensureSession(userId)

    // anthropicProxy 给本轮多次 LLM 调用各 park 一笔(ccb 不回流 requestId → 都进 pending)。
    assert.deepEqual(await appendCostCredits('req-ccb-1', userId, '8'), { applied: 'pending' })
    assert.deepEqual(await appendCostCredits('req-ccb-2', userId, '3'), { applied: 'pending' })

    // ccb 助手落库走 drain-by-user:求和(8+3=11)合入这条消息的 usage.costCredits、删两条 pending。
    const r = await appendServerAuthoredMessageDrainByUser(SESSION_ID, userId, {
      id: 'srv-ccb-t1',
      role: 'assistant' as const,
      text: 'hi from ccb',
      ts: 3000,
      status: 'completed',
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    assert.deepEqual(r, { applied: true })

    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].usage?.costCredits, '11', '多笔 pending 求和合入 usage.costCredits')
    assert.equal(messages[0].usage?.inputTokens, 100, 'inputTokens 保留自 sink payload')

    assert.equal(await getPendingRow('req-ccb-1', userId), undefined, 'pending 1 清空')
    assert.equal(await getPendingRow('req-ccb-2', userId), undefined, 'pending 2 清空')
    // drain-by-user 不写 map(无单一 requestId);不应误写。
    assert.equal(await getMapRow('req-ccb-1', userId), undefined, 'drain-by-user 不写 map')
  })

  it('T-ccb2: 无 pending 时助手正常落库,usage.costCredits 不被臆造', async () => {
    await clearTables()
    const userId = 'c:778'
    await ensureSession(userId)
    const r = await appendServerAuthoredMessageDrainByUser(SESSION_ID, userId, {
      id: 'srv-ccb2-t1',
      role: 'assistant' as const,
      text: 'no cost',
      ts: 4000,
      status: 'completed',
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    assert.deepEqual(r, { applied: true })
    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].usage?.costCredits, undefined, '无 pending → 不写 costCredits')
  })

  it('T-ccb3: 给 agentSessionId 时按 session 精确排空,不碰同 user 其它 session', async () => {
    await clearTables()
    const userId = 'c:999'
    await ensureSession(userId)
    // 同一 user、两个 agent session 各 park 一笔(proxy 以 LLM metadata.session_id 为 key)。
    await appendCostCredits('req-s-a1', userId, '4', 'sessA')
    await appendCostCredits('req-s-b1', userId, '7', 'sessB')
    // ccb 助手落库带 agentSessionId=sessA → 只收 sessA 的 4,sessB 不动。
    const r = await appendServerAuthoredMessageDrainByUser(SESSION_ID, userId, {
      id: 'srv-sa-t1', role: 'assistant' as const, text: 'a', ts: 5000, status: 'completed', usage: {},
    }, 'sessA')
    assert.deepEqual(r, { applied: true })
    const msg = (await getMessages(SESSION_ID, userId)).find((m) => m.id === 'srv-sa-t1')
    assert.equal(msg?.usage?.costCredits, '4', '只合入本 session(sessA)的成本')
    assert.equal(await getPendingRow('req-s-a1', userId), undefined, 'sessA pending 已清')
    assert.ok(await getPendingRow('req-s-b1', userId), 'sessB pending 保留(跨会话不归并)')
  })
})

describe('usage aggregation: idempotency', () => {
  before(async () => {
    await clearTables()
  })

  it('T5 appendCostCredits same value → noop, no _seq bump', async () => {
    const userId = 'u-T5'
    const requestId = 'req-T5'
    await ensureSession(userId)
    await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, {
      id: 'srv-T5-t1',
      role: 'assistant' as const,
      text: 'a',
      ts: 1000,
      status: 'completed',
    })
    const first = await appendCostCredits(requestId, userId, '5')
    assert.deepEqual(first, { applied: 'patched' })
    const sessAfterFirst = await getSessRow(SESSION_ID, userId)

    // Retry with same costCredits — should be noop, no _seq bump.
    const second = await appendCostCredits(requestId, userId, '5')
    assert.deepEqual(second, { applied: 'noop' })
    const sessAfterSecond = await getSessRow(SESSION_ID, userId)
    assert.equal(
      sessAfterSecond?.next_seq,
      sessAfterFirst?.next_seq,
      'noop must NOT bump next_seq',
    )

    // Retry with a different value — should patch and bump _seq.
    const third = await appendCostCredits(requestId, userId, '7')
    assert.deepEqual(third, { applied: 'patched' })
    const sessAfterThird = await getSessRow(SESSION_ID, userId)
    assert.ok(
      (sessAfterThird?.next_seq ?? 0) > (sessAfterSecond?.next_seq ?? 0),
      'distinct value MUST bump next_seq',
    )
    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages[0].usage?.costCredits, '7')
  })
})

describe('usage aggregation: cross-user requestId collision defense (Codex R4)', () => {
  before(async () => {
    await clearTables()
  })

  it('T6a appendCostCredits from different user does NOT patch original user’s message', async () => {
    const userX = 'u-T6a-X'
    const userY = 'u-T6a-Y'
    const requestId = 'req-T6a'
    await ensureSession(userX)
    await ensureSession(userY)
    await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userX, {
      id: 'srv-T6a-t1',
      role: 'assistant' as const,
      text: 'X message',
      ts: 100,
      status: 'completed',
    })

    // Y attempts to commit cost on the same requestId — should land in Y's
    // pending bucket, NOT touch X's message.
    const r = await appendCostCredits(requestId, userY, '99')
    assert.deepEqual(r, { applied: 'pending' })

    const xMessages = await getMessages(SESSION_ID, userX)
    assert.equal(xMessages[0].usage?.costCredits, undefined, 'X usage untouched')

    const yPending = await getPendingRow(requestId, userY)
    assert.ok(yPending, 'Y pending row written under Y user_id')
    assert.equal(yPending!.cost_credits, '99')
    // X did not have a pending row.
    assert.equal(await getPendingRow(requestId, userX), undefined)
  })

  it('T6b two users land pending under same requestId — independent rows, no overwrite', async () => {
    await clearTables()
    const userX = 'u-T6b-X'
    const userY = 'u-T6b-Y'
    const requestId = 'req-T6b'

    const r1 = await appendCostCredits(requestId, userX, '5')
    assert.deepEqual(r1, { applied: 'pending' })
    const r2 = await appendCostCredits(requestId, userY, '8')
    assert.deepEqual(r2, { applied: 'pending' })

    const xRow = await getPendingRow(requestId, userX)
    const yRow = await getPendingRow(requestId, userY)
    assert.ok(xRow && yRow, 'both rows present')
    assert.equal(xRow!.cost_credits, '5', 'X cost untouched by Y write')
    assert.equal(yRow!.cost_credits, '8')

    const all = await getPendingAllForRequest(requestId)
    assert.equal(all.length, 2)
  })

  it('T6c two users write server_authored_request_map under same requestId — independent rows', async () => {
    await clearTables()
    const userX = 'u-T6c-X'
    const userY = 'u-T6c-Y'
    const sessX = 'sess-T6c-X'
    const sessY = 'sess-T6c-Y'
    const requestId = 'req-T6c'
    // Distinct sessionIds because client_sessions.id is globally unique;
    // the cross-user defense we're testing is on the requestId space, not
    // sessionId. In production each user has their own sessionId namespace.
    await ensureSession(userX, sessX)
    await ensureSession(userY, sessY)

    await appendServerAuthoredMessageForRequest(requestId, sessX, userX, {
      id: 'srv-T6c-t1-X',
      role: 'assistant' as const,
      text: 'X msg',
      ts: 100,
      status: 'completed',
    })
    await appendServerAuthoredMessageForRequest(requestId, sessY, userY, {
      id: 'srv-T6c-t1-Y',
      role: 'assistant' as const,
      text: 'Y msg',
      ts: 200,
      status: 'completed',
    })

    const allMap = await getMapAllForRequest(requestId)
    assert.equal(allMap.length, 2, 'both users have a map row')
    const userIds = allMap.map((r) => r.user_id).sort()
    assert.deepEqual(userIds, [userX, userY].sort())

    // Each user's later commit must hit its own map row, not the other's.
    const rX = await appendCostCredits(requestId, userX, '11')
    assert.deepEqual(rX, { applied: 'patched' })
    const rY = await appendCostCredits(requestId, userY, '22')
    assert.deepEqual(rY, { applied: 'patched' })

    const xMessages = await getMessages(sessX, userX)
    const yMessages = await getMessages(sessY, userY)
    assert.equal(xMessages[0].usage?.costCredits, '11')
    assert.equal(yMessages[0].usage?.costCredits, '22')
  })
})

describe('usage aggregation: appendServerAuthoredMessageForRequest idempotency', () => {
  before(async () => {
    await clearTables()
  })

  it('T7 same (requestId, sessId, msgId) replayed → already_exists, no duplicate append', async () => {
    const userId = 'u-T7'
    const requestId = 'req-T7'
    await ensureSession(userId)
    const r1 = await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, {
      id: 'srv-T7-t1',
      role: 'assistant' as const,
      text: 'a',
      ts: 100,
      status: 'completed',
    })
    assert.deepEqual(r1, { applied: true })

    const r2 = await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, {
      id: 'srv-T7-t1',
      role: 'assistant' as const,
      text: 'a',
      ts: 100,
      status: 'completed',
    })
    assert.deepEqual(r2, { applied: false, reason: 'already_exists' })

    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages.length, 1, 'no duplicate append')
  })
})

describe('usage aggregation: appendForRequest 不可重映射(MAJOR-1,与 pgSessionsBackend 对齐)', () => {
  before(async () => {
    await clearTables()
  })

  it('R1 map 已存在但 (session,msg) 不一致 → fail-closed 抛 /拒绝重映射/,不改动已有映射', async () => {
    const userId = 'u-remap'
    const requestId = 'req-remap'
    await ensureSession(userId)
    // 首次映射到 srv-remap-a。
    const r1 = await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, {
      id: 'srv-remap-a',
      role: 'assistant' as const,
      text: 'first',
      ts: 100,
      status: 'completed',
    })
    assert.deepEqual(r1, { applied: true })

    // 同 (requestId,userId) 复用到不同 msgId → 抛错(SQLite 现在与 PG 一样严,不再 DO NOTHING 静默吞)。
    await assert.rejects(
      () =>
        appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, {
          id: 'srv-remap-b',
          role: 'assistant' as const,
          text: 'second',
          ts: 200,
          status: 'completed',
        }),
      /拒绝重映射/,
    )

    // map 仍指向原消息;srv-remap-b 未写入(事务回滚)。
    const mapRow = await getMapRow(requestId, userId)
    assert.equal(mapRow?.msg_id, 'srv-remap-a', 'map 仍映射到原消息')
    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages.length, 1, 'srv-remap-b 未写入')
    assert.equal(messages[0].id, 'srv-remap-a')
  })

  it('R2 一致重放 → already_exists 幂等,map 不重插、不重复 append', async () => {
    await clearTables()
    const userId = 'u-remap2'
    const requestId = 'req-remap2'
    await ensureSession(userId)
    const msg = {
      id: 'srv-remap2-a',
      role: 'assistant' as const,
      text: 'x',
      ts: 100,
      status: 'completed',
    }
    assert.deepEqual(await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, msg), {
      applied: true,
    })
    const mapBefore = await getMapRow(requestId, userId)
    // 一致重放:已存在且 (session,msg) 一致 → 幂等 already_exists,map 不变。
    assert.deepEqual(await appendServerAuthoredMessageForRequest(requestId, SESSION_ID, userId, msg), {
      applied: false,
      reason: 'already_exists',
    })
    const mapAfter = await getMapRow(requestId, userId)
    assert.equal(mapAfter?.written_at, mapBefore?.written_at, 'map 行未被重插(written_at 不变)')
    assert.equal((await getMessages(SESSION_ID, userId)).length, 1, '无重复 append')
  })
})

describe('usage aggregation: GC sweep windows (Codex R3)', () => {
  before(async () => {
    await clearTables()
  })

  it('T7c pending 25h → expired; pending 1.5h → aging only; map 8d → expired', async () => {
    const NOW = 1_000_000_000_000
    const HOUR = 60 * 60_000
    const DAY = 24 * HOUR

    // Inject 3 pending rows: 25h old, 1.5h old, 30m old.
    await insertPendingWithCreatedAt('req-pending-old', 'u-A', '1', NOW - 25 * HOUR)
    await insertPendingWithCreatedAt('req-pending-aging', 'u-B', '2', NOW - Math.floor(1.5 * HOUR))
    await insertPendingWithCreatedAt('req-pending-fresh', 'u-C', '3', NOW - 30 * 60_000)

    // Inject 2 map rows: 8d old, 2d old.
    await insertMapWithWrittenAt('req-map-old', 'u-D', SESSION_ID, 'srv-x', NOW - 8 * DAY)
    await insertMapWithWrittenAt('req-map-fresh', 'u-E', SESSION_ID, 'srv-y', NOW - 2 * DAY)

    const stats = await sweepUsageAggregationGc(NOW)
    assert.equal(stats.pendingExpired, 1, '25h pending hard-deleted')
    assert.equal(stats.pendingAging, 1, '1.5h pending counted as aging only')
    assert.equal(stats.mapExpired, 1, '8d map hard-deleted')

    // 30m pending and 2d map must still be present.
    assert.ok(await getPendingRow('req-pending-fresh', 'u-C'), 'fresh pending kept')
    assert.equal(await getPendingRow('req-pending-old', 'u-A'), undefined, '25h pending deleted')
    assert.ok(await getPendingRow('req-pending-aging', 'u-B'), 'aging pending NOT deleted yet')
    assert.ok(await getMapRow('req-map-fresh', 'u-E'), 'fresh map kept')
    assert.equal(await getMapRow('req-map-old', 'u-D'), undefined, '8d map deleted')
  })
})

describe('appendServerAuthoredMessage smoke (refactor regression check)', () => {
  before(async () => {
    await clearTables()
  })

  it('still appends a thinking-only message and bumps next_seq', async () => {
    const userId = 'u-smoke'
    await ensureSession(userId)
    const r = await appendServerAuthoredMessage(SESSION_ID, userId, {
      id: 'srv-smoke-t1-thinking',
      role: 'thinking' as const,
      text: 'reasoning',
      ts: 100,
    })
    assert.deepEqual(r, { applied: true })
    const messages = await getMessages(SESSION_ID, userId)
    assert.equal(messages[0]._source, 'server')
    assert.equal(messages[0].role, 'thinking')
  })
})
