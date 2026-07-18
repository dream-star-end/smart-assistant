// turn_dispatch_inbox CRUD 行为断言(RFC-v5-durable-turn-dispatch §3)。
// 禁 regex 源码断言:全部构造行 → 调 API → 断言返回行/终态。

import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-turn-dispatch-inbox-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  closeSessionsDb,
  getSessionsDb,
  casTurnDispatchState,
  deleteClientSession,
  getTurnDispatchByDispatchId,
  getTurnDispatchByLogicalKey,
  insertQueuedTurnDispatch,
  insertRejectedTombstoneIfAbsent,
  recordTurnDispatchRunning,
  scanOpenTurnDispatches,
  turnDispatchInboxStats,
} = await import('../sessionsDb.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

function key(n: number) {
  return {
    userId: 'u1',
    sessionId: `web-${n}`,
    clientMessageId: `cm-${n}`,
    dispatchId: `d-${n}`,
    attemptNo: 1,
    payloadHash: `h-${n}`,
  }
}

test('insert-if-absent: 首次插 queued;重复到达返回现有行且不覆盖', async () => {
  const k = key(1)
  const first = await insertQueuedTurnDispatch(k)
  assert.equal(first.inserted, true)
  assert.equal(first.row?.state, 'queued')

  // 把行推进到 running(带 finalize 元数据)。
  const running = await recordTurnDispatchRunning({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    agentId: 'main',
    turnIndex: 3,
    turnKey: 'turnkey-1',
    requestId: 'req-1',
    createdAt: 111,
  })
  assert.equal(running?.state, 'running')

  // 同逻辑键第二次 INSERT(重复到达 / higher attempt)→ 不插、不覆盖,返回现有 running 行。
  const dup = await insertQueuedTurnDispatch({ ...k, attemptNo: 2, payloadHash: 'h-other' })
  assert.equal(dup.inserted, false)
  assert.equal(dup.row?.state, 'running', 'running 行永不被后到覆盖')
  assert.equal(dup.row?.attemptNo, 1, 'attempt 不被覆盖')
  assert.equal(dup.row?.turnKey, 'turnkey-1')
})

test('recordTurnDispatchRunning 落 finalize 元数据 + 覆写 created_at 为规范值', async () => {
  const k = key(2)
  await insertQueuedTurnDispatch({ ...k, now: 1000 })
  const row = await recordTurnDispatchRunning({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    agentId: 'codex',
    turnIndex: 7,
    turnKey: 'tk-2',
    requestId: 'r-2',
    createdAt: 424242,
  })
  assert.equal(row?.state, 'running')
  assert.equal(row?.agentId, 'codex')
  assert.equal(row?.turnIndex, 7)
  assert.equal(row?.turnKey, 'tk-2')
  assert.equal(row?.requestId, 'r-2')
  assert.equal(row?.createdAt, 424242, 'created_at 覆写为该 turn 规范 createdAt(确定性 tape)')

  // queued 之外的 from-state 再 record running → CAS 落空(null)。
  const again = await recordTurnDispatchRunning({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    agentId: 'x',
    turnIndex: 9,
    turnKey: 'tk-x',
    requestId: null,
    createdAt: 1,
  })
  assert.equal(again, null, '非 queued 的 record running 不生效')
})

test('CAS 状态迁移:from-state 守卫命中/落空', async () => {
  const k = key(3)
  await insertQueuedTurnDispatch(k)
  await recordTurnDispatchRunning({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    agentId: 'main',
    turnIndex: 1,
    turnKey: 'tk-3',
    requestId: null,
    createdAt: 5,
  })
  const staged = await casTurnDispatchState({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    fromStates: ['running'],
    toState: 'sink_staged',
  })
  assert.equal(staged?.state, 'sink_staged')

  const terminal = await casTurnDispatchState({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    fromStates: ['sink_staged', 'running'],
    toState: 'terminal',
    outcome: 'completed',
  })
  assert.equal(terminal?.state, 'terminal')
  assert.equal(terminal?.outcome, 'completed')

  // 已 terminal,再从 running CAS → 落空。
  const miss = await casTurnDispatchState({
    userId: k.userId,
    sessionId: k.sessionId,
    clientMessageId: k.clientMessageId,
    fromStates: ['running'],
    toState: 'rejected',
    outcome: 'not_accepted',
  })
  assert.equal(miss, null, '终态不被 CAS 回退')
})

test('reject-if-absent:无行插 rejected 墓碑;有行返现有状态不覆盖', async () => {
  const k = key(4)
  // 无行 → 插 rejected tombstone。
  const first = await insertRejectedTombstoneIfAbsent(k)
  assert.equal(first.inserted, true)
  assert.equal(first.row?.state, 'rejected')
  assert.equal(first.row?.outcome, 'not_accepted')

  // 再调 → 有行,返回现有 rejected(不重复插、不覆盖)。
  const again = await insertRejectedTombstoneIfAbsent(k)
  assert.equal(again.inserted, false)
  assert.equal(again.row?.state, 'rejected')

  // 有 running 行时 reject-if-absent → 返回 running,绝不改写(negative proof 不成立)。
  const k2 = key(5)
  await insertQueuedTurnDispatch(k2)
  await recordTurnDispatchRunning({
    userId: k2.userId,
    sessionId: k2.sessionId,
    clientMessageId: k2.clientMessageId,
    agentId: 'main',
    turnIndex: 1,
    turnKey: 'tk-5',
    requestId: null,
    createdAt: 5,
  })
  const onRunning = await insertRejectedTombstoneIfAbsent(k2)
  assert.equal(onRunning.inserted, false)
  assert.equal(onRunning.row?.state, 'running', 'running 行不被 reject-if-absent 改写')
})

test('MINOR ①:dispatch_id 撞别的逻辑键 → reject-if-absent 返回明确 conflict(不谎报 inserted)', async () => {
  // 逻辑键 K1(web-c1/cm-c1)占用 dispatch d-conflict/attempt 1。
  await insertQueuedTurnDispatch({
    userId: 'u1',
    sessionId: 'web-c1',
    clientMessageId: 'cm-c1',
    dispatchId: 'd-conflict',
    attemptNo: 1,
    payloadHash: 'h',
  })
  // 用**另一个**逻辑键 K2(web-c2/cm-c2)但同 dispatch d-conflict/attempt 1 调 reject-if-absent:
  // 逻辑键不存在,但 (dispatch_id, attempt_no) UNIQUE 撞了 K1 → 明确 conflict。
  const r = await insertRejectedTombstoneIfAbsent({
    userId: 'u1',
    sessionId: 'web-c2',
    clientMessageId: 'cm-c2',
    dispatchId: 'd-conflict',
    attemptNo: 1,
    payloadHash: '',
  })
  assert.equal(r.inserted, false, '不再谎报 inserted:true')
  assert.equal(r.row, null)
  assert.equal(r.conflict, true, '明确 conflict 结果')
  // K2 逻辑键仍无行(墓碑没插进去)。
  assert.equal(await getTurnDispatchByLogicalKey('u1', 'web-c2', 'cm-c2'), null, 'conflict 未落任何行')
  // K1 行不受影响(仍 queued,dispatch d-conflict)。
  const k1 = await getTurnDispatchByLogicalKey('u1', 'web-c1', 'cm-c1')
  assert.equal(k1?.state, 'queued')
  assert.equal(k1?.dispatchId, 'd-conflict')
  // 正常路径仍工作:新逻辑键 + 新 dispatch → 正常插墓碑,conflict 缺省 falsy。
  const ok = await insertRejectedTombstoneIfAbsent({
    userId: 'u1',
    sessionId: 'web-c3',
    clientMessageId: 'cm-c3',
    dispatchId: 'd-fresh',
    attemptNo: 1,
    payloadHash: '',
  })
  assert.equal(ok.inserted, true)
  assert.equal(ok.conflict ?? false, false)
  assert.equal(ok.row?.state, 'rejected')
})

test('scanOpenTurnDispatches 只返回未落终态的行', async () => {
  // 已有前面测试造的多种行。断言 terminal/rejected 不在扫描结果,open 行在。
  const rows = await scanOpenTurnDispatches()
  const states = new Set(rows.map((r) => r.state))
  assert.equal(states.has('terminal'), false, 'terminal 不入 boot 扫描')
  assert.equal(states.has('rejected'), false, 'rejected 不入 boot 扫描')
  // key(5) 是 running,应在。
  const running5 = rows.find((r) => r.dispatchId === 'd-5')
  assert.equal(running5?.state, 'running')
})

test('按 dispatchId 查行 + healthz gauge open-job 计数', async () => {
  const byDispatch = await getTurnDispatchByDispatchId('d-5', 1)
  assert.equal(byDispatch?.clientMessageId, 'cm-5')

  const stats = await turnDispatchInboxStats()
  assert.ok(stats.openJobs >= 1, 'open-job 计数覆盖 running 行')
  assert.ok(stats.bytes > 0, '字节 gauge 非零')
})

test('session 硬删级联清 inbox 行', async () => {
  const db = await getSessionsDb()
  const sessionId = 'web-cascade'
  // 造一条 client_session + 一条 inbox 行同 session_id。
  db.prepare(
    `INSERT INTO client_sessions (id, user_id, agent_id, title, created_at, last_at, messages, updated_at)
     VALUES (?, 'u1', 'main', 't', 1, 1, '[]', 1)`,
  ).run(sessionId)
  await insertQueuedTurnDispatch({
    userId: 'u1',
    sessionId,
    clientMessageId: 'cm-cascade',
    dispatchId: 'd-cascade',
    attemptNo: 1,
    payloadHash: 'h',
  })
  assert.ok(
    (await getTurnDispatchByLogicalKey('u1', sessionId, 'cm-cascade')) !== null,
    '级联前 inbox 行在',
  )
  const deleted = await deleteClientSession(sessionId, 'u1')
  assert.equal(deleted, true)
  assert.equal(
    await getTurnDispatchByLogicalKey('u1', sessionId, 'cm-cascade'),
    null,
    'session 软删级联清 inbox 行',
  )
})
