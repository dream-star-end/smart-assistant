// turn dispatch inbox — 验签消费 / reconcile 决策输入 / boot recovery 故障注入
// (RFC-v5-durable-turn-dispatch §3/§4/§7)。全部行为断言,禁 regex 源码断言。
//
// §7 kill 用状态注入模拟:构造 inbox 行初态 + 跑 boot recovery + 断言终态。

import * as assert from 'node:assert/strict'
import { sign as edSign, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import type { MasterTapeStateResult } from '../turnDispatchInbox.js'

const testHome = await mkdtemp(join(tmpdir(), 'oc-gw-turn-dispatch-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  computeDispatchRequestHash,
  dispatchAuthoritySigningInput,
  encodeDispatchAuthorityEnvelope,
} = await import('@openclaude/protocol')
const {
  casTurnDispatchState,
  closeSessionsDb,
  getTurnDispatchByLogicalKey,
  insertQueuedTurnDispatch,
  recordTurnDispatchRunning,
} = await import('@openclaude/storage')
const {
  DispatchAuthorityConsumer,
  DispatchRejected,
  TurnDispatchNotAcceptedError,
  admitTurnDispatch,
  buildSyntheticCrashedTapePayload,
  buildTurnDispatchReceiptFrame,
  buildTurnDispatchStateResponse,
  durableTurnDispatchCapabilities,
  failClosedOnRunningCasMiss,
  getTurnDispatchState,
  getTurnDispatchStateByDispatch,
  inboxSinkStaged,
  inboxTerminal,
  normalizeDispatchUserId,
  recoverTurnDispatchInboxOnBoot,
  rejectTurnDispatchIfAbsent,
  resolveInboxTerminalAck,
} = await import('../turnDispatchInbox.js')
const { lookupRecentTerminal, recordRecentTerminal } = await import('../sessionManager.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

// ── 签名工具:构造 master 侧签发的 __oc_dispatch envelope ─────────────────────
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPub = new Uint8Array(
  Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url'),
)
const KEY_ID = 'dak1_test'
const keyring = new Map([[KEY_ID, rawPub]])

const UID = 'u1'
const CID = 'c1'
const CHALLENGE = 'chal-abc'

function signDispatch(over: Record<string, unknown>): string {
  const payload = {
    v: 1 as const,
    keyId: KEY_ID,
    uid: UID,
    containerId: CID,
    sessionId: 'web-1',
    clientMessageId: 'cm-1',
    dispatchId: 'd-1',
    attemptNo: 1,
    payloadHash: computeDispatchRequestHash({ text: 'hi' }),
    billingRequestId: 'a'.repeat(32),
    connectionChallenge: CHALLENGE,
    issuedAt: 1000,
    expiresAt: 999_999_999_999,
    ...over,
  }
  const sig = edSign(null, dispatchAuthoritySigningInput(payload as never), privateKey)
  return encodeDispatchAuthorityEnvelope(payload as never, new Uint8Array(sig))
}

function frameWith(envelope: string, over?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'inbound.message',
    channel: 'webchat',
    peer: { id: 'web-1', kind: 'dm' },
    clientMessageId: 'cm-1',
    content: { text: 'hi' },
    __oc_dispatch: envelope,
    ...over,
  }
}

/** 捕获 DispatchRejected(assert.throws 不返回抛出的错误)。 */
function expectReject(fn: () => unknown, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof DispatchRejected, `expected DispatchRejected, got ${String(caught)}`)
  assert.equal((caught as InstanceType<typeof DispatchRejected>).code, code)
}

describe('dispatch authority consumer', () => {
  const consumer = new DispatchAuthorityConsumer({ keyring, uid: UID, containerId: CID })

  test('enabled + capability 广播', () => {
    assert.equal(consumer.enabled, true)
    assert.deepEqual(consumer.capabilities(), ['durable-turn-dispatch-v1'])
    const bad = new DispatchAuthorityConsumer({ keyring: new Map(), uid: UID, containerId: CID })
    assert.equal(bad.enabled, false)
    assert.deepEqual(bad.capabilities(), [])
  })

  test('happy path:验签 + 全断言通过 → 产出 ctx', () => {
    const ctx = consumer.consume(frameWith(signDispatch({})), CHALLENGE, { text: 'hi' }, { now: 2000 })
    assert.equal(ctx.uid, UID)
    assert.equal(ctx.sessionId, 'web-1')
    assert.equal(ctx.clientMessageId, 'cm-1')
    assert.equal(ctx.dispatchId, 'd-1')
    assert.equal(ctx.attemptNo, 1)
  })

  test('payloadHash 与帧体不符 → payload_hash_mismatch', () => {
    // envelope 签的是 text:'hi' 的 hash;传入不同 content。
    expectReject(
      () =>
        consumer.consume(frameWith(signDispatch({})), CHALLENGE, { text: 'TAMPERED' }, { now: 2000 }),
      'payload_hash_mismatch',
    )
  })

  test('connectionChallenge 不符 → challenge_mismatch', () => {
    expectReject(
      () => consumer.consume(frameWith(signDispatch({})), 'WRONG-CHAL', { text: 'hi' }, { now: 2000 }),
      'challenge_mismatch',
    )
  })

  test('容器身份不符 → identity_mismatch', () => {
    const other = new DispatchAuthorityConsumer({ keyring, uid: 'uX', containerId: CID })
    expectReject(
      () => other.consume(frameWith(signDispatch({})), CHALLENGE, { text: 'hi' }, { now: 2000 }),
      'identity_mismatch',
    )
  })

  test('clientMessageId 与帧不符 → client_message_id_mismatch', () => {
    const env = signDispatch({ clientMessageId: 'cm-signed' })
    expectReject(
      () =>
        consumer.consume(
          frameWith(env, { clientMessageId: 'cm-frame' }),
          CHALLENGE,
          { text: 'hi' },
          { now: 2000 },
        ),
      'client_message_id_mismatch',
    )
  })

  test('sessionId 与 frame.peer.id 不符 → session_mismatch(B9)', () => {
    // envelope 签的 sessionId='web-1';frame.peer.id 换成别的会话 → 准入键与实际会话分裂。
    expectReject(
      () =>
        consumer.consume(
          frameWith(signDispatch({}), { peer: { id: 'web-OTHER', kind: 'dm' } }),
          CHALLENGE,
          { text: 'hi' },
          { now: 2000 },
        ),
      'session_mismatch',
    )
  })

  test('model-authority billingRequestId 交叉核对(B9):不一致拒 / 一致放行 / 缺省不校验', () => {
    const signedBilling = 'a'.repeat(32) // signDispatch 默认 billingRequestId
    // 不一致 → billing_request_id_mismatch。
    expectReject(
      () =>
        consumer.consume(frameWith(signDispatch({})), CHALLENGE, { text: 'hi' }, {
          now: 2000,
          modelAuthorityBillingRequestId: 'b'.repeat(32),
        }),
      'billing_request_id_mismatch',
    )
    // 一致 → 通过。
    const ok = consumer.consume(frameWith(signDispatch({})), CHALLENGE, { text: 'hi' }, {
      now: 2000,
      modelAuthorityBillingRequestId: signedBilling,
    })
    assert.equal(ok.billingRequestId, signedBilling)
    // 取不到 model authority(不传)→ 按现状不校验(census 混跑期兼容)。
    const legacy = consumer.consume(frameWith(signDispatch({})), CHALLENGE, { text: 'hi' }, { now: 2000 })
    assert.equal(legacy.billingRequestId, signedBilling)
  })

  test('伪造签名(错 key)→ verify_fail', () => {
    const otherPair = generateKeyPairSync('ed25519')
    const payload = {
      v: 1,
      keyId: KEY_ID,
      uid: UID,
      containerId: CID,
      sessionId: 'web-1',
      clientMessageId: 'cm-1',
      dispatchId: 'd-1',
      attemptNo: 1,
      payloadHash: computeDispatchRequestHash({ text: 'hi' }),
      billingRequestId: 'a'.repeat(32),
      connectionChallenge: CHALLENGE,
      issuedAt: 1000,
      expiresAt: 999_999_999_999,
    }
    const forgedSig = edSign(
      null,
      dispatchAuthoritySigningInput(payload as never),
      otherPair.privateKey,
    )
    const env = encodeDispatchAuthorityEnvelope(payload as never, new Uint8Array(forgedSig))
    expectReject(
      () => consumer.consume(frameWith(env), CHALLENGE, { text: 'hi' }, { now: 2000 }),
      'verify_fail',
    )
  })
})

describe('reconcile 身份对账 ring(§4 决策表输入)', () => {
  test('recordRecentTerminal / lookupRecentTerminal 四行为:completed/中断/未知 + cap 8', () => {
    const session = {} as Parameters<typeof recordRecentTerminal>[0]
    recordRecentTerminal(session, 'cm-a', 'completed')
    recordRecentTerminal(session, 'cm-b', 'interrupted')
    recordRecentTerminal(session, 'cm-c', 'crashed')
    // completed → turn_completed 分支
    assert.equal(lookupRecentTerminal(session, 'cm-a'), 'completed')
    // 中断类 → interrupted 分支
    assert.equal(lookupRecentTerminal(session, 'cm-b'), 'interrupted')
    assert.equal(lookupRecentTerminal(session, 'cm-c'), 'crashed')
    // 未知身份 → turn_state_unknown 分支
    assert.equal(lookupRecentTerminal(session, 'cm-never'), undefined)

    // cap 8 淘汰最老;同 id 覆盖不占新槽。
    for (let i = 0; i < 10; i++) recordRecentTerminal(session, `x-${i}`, 'completed')
    assert.equal(lookupRecentTerminal(session, 'x-0'), undefined, '超 cap 淘汰最老')
    assert.equal(lookupRecentTerminal(session, 'x-9'), 'completed')
    recordRecentTerminal(session, 'x-9', 'interrupted')
    assert.equal(lookupRecentTerminal(session, 'x-9'), 'interrupted', '同 id 覆盖')
  })
})

describe('admission — 重复到达单执行(§7-6)', () => {
  test('同逻辑键 admit 两次:第二次 inserted=false 返回现有行(不二次执行)', async () => {
    const ctx = {
      uid: 'u1',
      sessionId: 'web-dup',
      clientMessageId: 'cm-dup',
      dispatchId: 'd-dup',
      attemptNo: 1,
      payloadHash: 'h',
      billingRequestId: 'b',
    }
    const first = await admitTurnDispatch({ ctx })
    assert.equal(first.inserted, true)
    assert.equal(first.row?.state, 'queued')
    const second = await admitTurnDispatch({ ctx })
    assert.equal(second.inserted, false, '重复帧不再插入 → 调用方不二次执行')
    assert.equal(second.row?.state, 'queued')
  })
})

describe('端点核心行为', () => {
  test('reject-if-absent:无行插 rejected;有行返状态', async () => {
    const r = await rejectTurnDispatchIfAbsent({
      userId: 'u1',
      sessionId: 'web-ep',
      clientMessageId: 'cm-ep',
      dispatchId: 'd-ep',
      attemptNo: 1,
    })
    assert.equal(r.inserted, true)
    assert.equal(r.state, 'rejected')
    assert.equal(r.outcome, 'not_accepted')
    const again = await rejectTurnDispatchIfAbsent({
      userId: 'u1',
      sessionId: 'web-ep',
      clientMessageId: 'cm-ep',
      dispatchId: 'd-ep',
      attemptNo: 1,
    })
    assert.equal(again.inserted, false)
    assert.equal(again.state, 'rejected')
  })

  test('dispatch-state:命中返回行,未命中 null', async () => {
    const found = await getTurnDispatchState({
      userId: 'u1',
      sessionId: 'web-ep',
      clientMessageId: 'cm-ep',
    })
    assert.equal(found?.state, 'rejected')
    const missing = await getTurnDispatchState({
      userId: 'u1',
      sessionId: 'web-nope',
      clientMessageId: 'cm-nope',
    })
    assert.equal(missing, null)
  })
})

describe('boot recovery 故障注入(§7 1/2/3/4/8)', () => {
  async function seedRunning(sessionId: string, cm: string, dispatchId: string): Promise<void> {
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      dispatchId,
      attemptNo: 1,
      payloadHash: 'h',
    })
    await recordTurnDispatchRunning({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      agentId: 'main',
      turnIndex: 2,
      turnKey: `tk-${dispatchId}`,
      requestId: `req-${dispatchId}`,
      createdAt: 5555,
    })
  }

  test('全场景一次 boot:queued→rejected;①→sink_staged 无重复 tape;三态收敛', async () => {
    // §7-1 fsync 后 enqueue 前 kill:queued 行。
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId: 'web-q',
      clientMessageId: 'cm-q',
      dispatchId: 'd-queued',
      attemptNo: 1,
      payloadHash: 'h',
    })
    // §7-3 retry entry fsync 后 sink_staged 前 kill:running + 本地 retry entry 存在 → ①路径。
    await seedRunning('web-r', 'cm-r', 'd-retry')
    // §7-4 master ACK 后 local terminal 前 kill:running + master finalized。
    await seedRunning('web-f', 'cm-f', 'd-finalized')
    // §7-8 partial tape + 本地 queue entry 丢失:running + master partial。
    await seedRunning('web-p', 'cm-p', 'd-partial')
    // §7-2 running 后模型返回前 kill + master none → synthetic crashed tape。
    await seedRunning('web-n', 'cm-n', 'd-none')
    // §7-2 不可达:保持 recovery_pending 重试(禁止推断)。
    await seedRunning('web-u', 'cm-u', 'd-unreachable')

    const stagedFor = new Set<string>()
    const manualFor = new Map<string, string>()
    const tapeState: Record<string, MasterTapeStateResult> = {
      'd-finalized': { state: 'finalized' },
      'd-partial': { state: 'partial' },
      'd-none': { state: 'none' },
      'd-unreachable': { state: 'unreachable' },
    }

    const stats = await recoverTurnDispatchInboxOnBoot({
      retryQueueHasDispatch: async (dispatchId) => dispatchId === 'd-retry',
      queryMasterTapeState: async (dispatchId) => tapeState[dispatchId] ?? { state: 'unreachable' },
      stageSyntheticCrashedTape: async (row) => {
        stagedFor.add(row.dispatchId)
      },
      onManualReconcile: (row, reason) => {
        manualFor.set(row.dispatchId, reason)
      },
    })

    const state = async (sessionId: string, cm: string) =>
      await getTurnDispatchByLogicalKey('u1', sessionId, cm)

    // §7-1 queued → rejected(not_accepted)→ fail-visible。
    const q = await state('web-q', 'cm-q')
    assert.equal(q?.state, 'rejected')
    assert.equal(q?.outcome, 'not_accepted')

    // §7-3 ①本地 retry entry 存在 → sink_staged,**不**生成 synthetic tape。
    assert.equal((await state('web-r', 'cm-r'))?.state, 'sink_staged')
    assert.equal(stagedFor.has('d-retry'), false, '① 路径不生成重复 tape')

    // §7-4 master finalized → terminal。
    const f = await state('web-f', 'cm-f')
    assert.equal(f?.state, 'terminal')

    // §7-8 partial → sink_stage_failed + manual,**无异 hash tape**。
    assert.equal((await state('web-p', 'cm-p'))?.state, 'sink_stage_failed')
    assert.equal(manualFor.get('d-partial'), 'partial_tape_on_boot')
    assert.equal(stagedFor.has('d-partial'), false, 'partial 不生成 synthetic tape')

    // §7-2 none → synthetic crashed tape staged → sink_staged。
    assert.equal((await state('web-n', 'cm-n'))?.state, 'sink_staged')
    assert.equal(stagedFor.has('d-none'), true, 'none 分支生成确定性 synthetic tape')

    // §7-2 unreachable → 保持 recovery_pending(禁止推断)。
    assert.equal((await state('web-u', 'cm-u'))?.state, 'recovery_pending')

    assert.ok(stats.rejected >= 1, 'queued 行至少收敛一条为 rejected')
    assert.equal(stats.terminal, 1)
    assert.equal(stats.sinkStageFailed, 1)
    assert.equal(stats.recoveryPending, 1)
    // sink_staged 计 ①(d-retry)+ none(d-none)= 2。
    assert.equal(stats.sinkStaged, 2)
  })

  test('synthetic crashed tape 确定性:同 inbox 行 → 同 payload(严禁 Date.now())', async () => {
    const row = await getTurnDispatchByLogicalKey('u1', 'web-n', 'cm-n')
    assert.ok(row)
    const a = buildSyntheticCrashedTapePayload(row!)
    const b = buildSyntheticCrashedTapePayload(row!)
    assert.deepEqual(a, b)
    assert.equal(a.status, 'crashed')
    assert.equal(a.text, '')
    assert.equal(a.errorCode, 'SERVICE_RESTART')
    assert.equal(a.createdAt, 5555, 'createdAt 取 inbox 持久化值,确定性')
    assert.equal(a.turnKey, 'tk-d-none')
    assert.equal(a.dispatchId, 'd-none')
  })
})

describe('M1 — finalized outcome 按 master tapeStatus 映射(不再固定 completed)', () => {
  async function seedRunningRow(sessionId: string, cm: string, dispatchId: string): Promise<void> {
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      dispatchId,
      attemptNo: 1,
      payloadHash: 'h',
    })
    await recordTurnDispatchRunning({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      agentId: 'main',
      turnIndex: 1,
      turnKey: `tk-${dispatchId}`,
      requestId: null,
      createdAt: 1,
    })
  }

  test('finalized+interrupted / finalized+crashed / 旧 master(无 status)→ completed', async () => {
    await seedRunningRow('web-m-i', 'cm-m-i', 'd-m-interrupted')
    await seedRunningRow('web-m-c', 'cm-m-c', 'd-m-crashed')
    await seedRunningRow('web-m-o', 'cm-m-o', 'd-m-oldmaster')

    const results: Record<string, MasterTapeStateResult> = {
      'd-m-interrupted': { state: 'finalized', tapeStatus: 'interrupted' },
      'd-m-crashed': { state: 'finalized', tapeStatus: 'crashed' },
      'd-m-oldmaster': { state: 'finalized' }, // 旧 master 不带 status
    }
    const stats = await recoverTurnDispatchInboxOnBoot({
      retryQueueHasDispatch: async () => false,
      queryMasterTapeState: async (dispatchId) => results[dispatchId] ?? { state: 'unreachable' },
      stageSyntheticCrashedTape: async () => {},
    })
    assert.equal(stats.terminal, 3)

    const i = await getTurnDispatchByLogicalKey('u1', 'web-m-i', 'cm-m-i')
    assert.equal(i?.state, 'terminal')
    assert.equal(i?.outcome, 'interrupted', 'finalized+interrupted → outcome=interrupted')
    const c = await getTurnDispatchByLogicalKey('u1', 'web-m-c', 'cm-m-c')
    assert.equal(c?.outcome, 'crashed', 'finalized+crashed → outcome=crashed')
    const o = await getTurnDispatchByLogicalKey('u1', 'web-m-o', 'cm-m-o')
    assert.equal(o?.outcome, 'completed', '旧 master 无 status → 保守 completed')
  })
})

describe('B4 — 周期 recovery 把 unreachable 行最终收敛(多轮重试)', () => {
  test('第一轮 unreachable → recovery_pending;第二轮 finalized → terminal', async () => {
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId: 'web-b4',
      clientMessageId: 'cm-b4',
      dispatchId: 'd-b4',
      attemptNo: 1,
      payloadHash: 'h',
    })
    await recordTurnDispatchRunning({
      userId: 'u1',
      sessionId: 'web-b4',
      clientMessageId: 'cm-b4',
      agentId: 'main',
      turnIndex: 1,
      turnKey: 'tk-b4',
      requestId: null,
      createdAt: 1,
    })

    // 第一轮:master 不可达 → 保持 recovery_pending(禁止推断)。deps 只对 d-b4 应答
    // (共享测试库里其它测试留下的 open 行不干扰本行的收敛断言)。断言落在**本行 state**,
    // 不用聚合计数(共享库计数受残留行影响)。
    let reachable = false
    const deps = {
      retryQueueHasDispatch: async () => false,
      queryMasterTapeState: async (dispatchId: string): Promise<MasterTapeStateResult> =>
        dispatchId === 'd-b4'
          ? reachable
            ? { state: 'finalized', tapeStatus: 'completed' }
            : { state: 'unreachable' }
          : { state: 'unreachable' },
      stageSyntheticCrashedTape: async () => {},
    }
    await recoverTurnDispatchInboxOnBoot(deps)
    assert.equal(
      (await getTurnDispatchByLogicalKey('u1', 'web-b4', 'cm-b4'))?.state,
      'recovery_pending',
      '首轮不可达 → recovery_pending,未被推断为任何终态',
    )

    // 第二轮(周期重试):master 恢复 → finalized → terminal。同一 recovery 协议对
    // recovery_pending 行继续跑(recoverOneRow 对 running/recovery_pending 都走②路径)。
    reachable = true
    await recoverTurnDispatchInboxOnBoot(deps)
    const final = await getTurnDispatchByLogicalKey('u1', 'web-b4', 'cm-b4')
    assert.equal(final?.state, 'terminal', '次轮 master 可达 finalized → terminal(最终收敛)')
    assert.equal(final?.outcome, 'completed')
  })
})

describe('B3 — running CAS fail-closed helper', () => {
  test('queued 行 running CAS 未确认 → 落 rejected(not_accepted)墓碑 + 抛 TurnDispatchNotAcceptedError', async () => {
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId: 'web-b3',
      clientMessageId: 'cm-b3',
      dispatchId: 'd-b3',
      attemptNo: 1,
      payloadHash: 'h',
    })
    // 模拟 recordTurnDispatchRunning 返回 null / 抛异常后的 fail-closed。
    let threw: unknown
    try {
      await failClosedOnRunningCasMiss({
        userId: 'u1',
        sessionId: 'web-b3',
        clientMessageId: 'cm-b3',
        dispatchId: 'd-b3',
      })
    } catch (e) {
      threw = e
    }
    assert.ok(
      threw instanceof TurnDispatchNotAcceptedError,
      '必抛 TurnDispatchNotAcceptedError 以阻断模型调用',
    )
    const row = await getTurnDispatchByLogicalKey('u1', 'web-b3', 'cm-b3')
    assert.equal(row?.state, 'rejected', '行 CAS 为 rejected(negative proof)')
    assert.equal(row?.outcome, 'not_accepted')
  })

  test('行已非 queued(已终态)时仍必抛,不回退终态', async () => {
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId: 'web-b3b',
      clientMessageId: 'cm-b3b',
      dispatchId: 'd-b3b',
      attemptNo: 1,
      payloadHash: 'h',
    })
    // 推进到 running 再 sink_staged(模拟"行已非 queued")。
    await recordTurnDispatchRunning({
      userId: 'u1',
      sessionId: 'web-b3b',
      clientMessageId: 'cm-b3b',
      agentId: 'main',
      turnIndex: 1,
      turnKey: 'tk',
      requestId: null,
      createdAt: 1,
    })
    await casTurnDispatchState({
      userId: 'u1',
      sessionId: 'web-b3b',
      clientMessageId: 'cm-b3b',
      fromStates: ['running'],
      toState: 'sink_staged',
    })
    let threw = false
    try {
      await failClosedOnRunningCasMiss({
        userId: 'u1',
        sessionId: 'web-b3b',
        clientMessageId: 'cm-b3b',
        dispatchId: 'd-b3b',
      })
    } catch {
      threw = true
    }
    assert.equal(threw, true, 'CAS 落空仍必抛(阻断模型调用)')
    assert.equal(
      (await getTurnDispatchByLogicalKey('u1', 'web-b3b', 'cm-b3b'))?.state,
      'sink_staged',
      'rejected CAS(from queued)不回退非 queued 终态',
    )
  })
})

describe('B1 — inbox user_id 归一裸 uid', () => {
  test('normalizeDispatchUserId:剥 c: 前缀,裸形态原样', () => {
    assert.equal(normalizeDispatchUserId('c:42'), '42')
    assert.equal(normalizeDispatchUserId('42'), '42')
    assert.equal(normalizeDispatchUserId('c:'), '')
  })

  test('裸 uid 插入 → 同 uid reject-if-absent 命中现状(不插 tombstone)', async () => {
    // 以裸 uid 插一条 running 行(descriptor.uid 同源形态)。
    await insertQueuedTurnDispatch({
      userId: '77',
      sessionId: 'web-b1',
      clientMessageId: 'cm-b1',
      dispatchId: 'd-b1',
      attemptNo: 1,
      payloadHash: 'h',
    })
    await recordTurnDispatchRunning({
      userId: '77',
      sessionId: 'web-b1',
      clientMessageId: 'cm-b1',
      agentId: 'main',
      turnIndex: 1,
      turnKey: 'tk-b1',
      requestId: null,
      createdAt: 1,
    })
    // 端点侧收到 c:77(旧 master 形态)→ normalize 后按裸 77 查 → 命中 running,不插墓碑。
    const r = await rejectTurnDispatchIfAbsent({
      userId: normalizeDispatchUserId('c:77'),
      sessionId: 'web-b1',
      clientMessageId: 'cm-b1',
      dispatchId: 'd-b1',
      attemptNo: 1,
    })
    assert.equal(r.inserted, false, '命中裸 uid 现有行 → 不插 tombstone')
    assert.equal(r.state, 'running', '返回现状,negative proof 不成立')
  })
})

describe('B2 — turn_dispatch_receipt 首次受理即回执', () => {
  test('新插 queued 行 → receipt state=queued(bridge 据此 CAS accepted)', async () => {
    const ctx = {
      uid: 'u1',
      sessionId: 'web-b2',
      clientMessageId: 'cm-b2',
      dispatchId: 'd-b2',
      attemptNo: 1,
      payloadHash: 'h',
      billingRequestId: 'b',
    }
    const admitted = await admitTurnDispatch({ ctx })
    assert.equal(admitted.inserted, true)
    const frame = buildTurnDispatchReceiptFrame(
      { dispatchId: ctx.dispatchId, attemptNo: ctx.attemptNo, sessionId: ctx.sessionId, clientMessageId: ctx.clientMessageId },
      admitted.row,
      12345,
    )
    assert.equal(frame.type, 'outbound.control.turn_dispatch_receipt')
    assert.equal(frame.state, 'queued', '首次受理回执 state=queued')
    assert.equal(frame.outcome, null)
    assert.equal(frame.dispatchId, 'd-b2')
    assert.equal(frame.clientMessageId, 'cm-b2')
    assert.equal(frame.ts, 12345, 'ts 由调用方注入(纯函数可断言)')
  })

  test('无行(row=null)→ receipt state=null', () => {
    const frame = buildTurnDispatchReceiptFrame(
      { dispatchId: 'd', attemptNo: 1, sessionId: 's', clientMessageId: 'c' },
      null,
      1,
    )
    assert.equal(frame.state, null)
    assert.equal(frame.outcome, null)
  })
})

describe('B5 — capability 绑定完整 readiness', () => {
  test('sink 未装配(ready=false)→ 不广播;enabled+ready → 广播', () => {
    assert.deepEqual(durableTurnDispatchCapabilities(true, false), [], 'ready=false → 不申报')
    assert.deepEqual(durableTurnDispatchCapabilities(false, true), [], 'enabled=false → 不申报')
    assert.deepEqual(durableTurnDispatchCapabilities(false, false), [])
    assert.deepEqual(durableTurnDispatchCapabilities(true, true), ['durable-turn-dispatch-v1'])
  })
})

describe('M-R1-1 ② — 周期 sweep 兜底:sink_staged 行按 master 三态收敛', () => {
  async function seedSinkStaged(sessionId: string, cm: string, dispatchId: string): Promise<void> {
    await insertQueuedTurnDispatch({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      dispatchId,
      attemptNo: 1,
      payloadHash: 'h',
    })
    await recordTurnDispatchRunning({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      agentId: 'main',
      turnIndex: 1,
      turnKey: `tk-${dispatchId}`,
      requestId: null,
      createdAt: 1,
    })
    // running → sink_staged(模型终态、tape stage 成功后的可恢复态)。
    await casTurnDispatchState({
      userId: 'u1',
      sessionId,
      clientMessageId: cm,
      fromStates: ['running'],
      toState: 'sink_staged',
    })
  }

  test('sink_staged + master finalized → 本地 terminal(按 tapeStatus 映射 outcome)', async () => {
    // 模拟 M-R1-1 主 bug 残留:tape 已 finalize 到 master,但本地行永停 sink_staged(旧序
    // ack 已删 retry entry / 终态 CAS 曾写失败)。周期 sweep 查 master → finalized → 收敛。
    await seedSinkStaged('web-ss-c', 'cm-ss-c', 'd-ss-completed')
    await seedSinkStaged('web-ss-i', 'cm-ss-i', 'd-ss-interrupted')
    await seedSinkStaged('web-ss-o', 'cm-ss-o', 'd-ss-oldmaster')

    const results: Record<string, MasterTapeStateResult> = {
      'd-ss-completed': { state: 'finalized', tapeStatus: 'completed' },
      'd-ss-interrupted': { state: 'finalized', tapeStatus: 'interrupted' },
      'd-ss-oldmaster': { state: 'finalized' }, // 旧 master 无 status → 保守 completed
    }
    await recoverTurnDispatchInboxOnBoot({
      // ① 路径关闭:强制走 ② master 三态查询(本用例专测 sink_staged 兜底)。
      retryQueueHasDispatch: async () => false,
      queryMasterTapeState: async (dispatchId) => results[dispatchId] ?? { state: 'unreachable' },
      stageSyntheticCrashedTape: async () => {},
    })

    const c = await getTurnDispatchByLogicalKey('u1', 'web-ss-c', 'cm-ss-c')
    assert.equal(c?.state, 'terminal', 'finalized → terminal')
    assert.equal(c?.outcome, 'completed')
    const i = await getTurnDispatchByLogicalKey('u1', 'web-ss-i', 'cm-ss-i')
    assert.equal(i?.state, 'terminal')
    assert.equal(i?.outcome, 'interrupted', '按精确 tapeStatus 映射 outcome')
    const o = await getTurnDispatchByLogicalKey('u1', 'web-ss-o', 'cm-ss-o')
    assert.equal(o?.state, 'terminal')
    assert.equal(o?.outcome, 'completed', '旧 master 无 status → 保守 completed')
  })

  test('sink_staged + master 非 finalized(none/partial/unreachable)→ 保持 sink_staged 不动', async () => {
    await seedSinkStaged('web-ss-n', 'cm-ss-n', 'd-ss-none')
    await seedSinkStaged('web-ss-p', 'cm-ss-p', 'd-ss-partial')
    await seedSinkStaged('web-ss-u', 'cm-ss-u', 'd-ss-unreachable')

    const results: Record<string, MasterTapeStateResult> = {
      'd-ss-none': { state: 'none' },
      'd-ss-partial': { state: 'partial' },
      // d-ss-unreachable → 默认 unreachable
    }
    await recoverTurnDispatchInboxOnBoot({
      retryQueueHasDispatch: async () => false,
      queryMasterTapeState: async (dispatchId) => results[dispatchId] ?? { state: 'unreachable' },
      stageSyntheticCrashedTape: async () => {},
    })

    // 非 finalized 一律不动:retry queue 仍在送(none),不合成异 hash tape(partial),
    // fail-closed 禁把不可达当 none(unreachable)。绝不推断终态。
    assert.equal(
      (await getTurnDispatchByLogicalKey('u1', 'web-ss-n', 'cm-ss-n'))?.state,
      'sink_staged',
      'none → 不动(retry queue 仍在送)',
    )
    assert.equal(
      (await getTurnDispatchByLogicalKey('u1', 'web-ss-p', 'cm-ss-p'))?.state,
      'sink_staged',
      'partial → 不动(不合成异 hash tape)',
    )
    assert.equal(
      (await getTurnDispatchByLogicalKey('u1', 'web-ss-u', 'cm-ss-u'))?.state,
      'sink_staged',
      'unreachable → 不动(fail-closed 禁推断)',
    )
  })
})

// ── M5(R3):resolveInboxTerminalAck — master ACK 落 terminal 的去重安全收口 ──────────────
describe('M5 resolveInboxTerminalAck(CAS null 不删 entry)', () => {
  async function seedSinkStaged(sessionId: string, cm: string, dispatchId: string): Promise<void> {
    await insertQueuedTurnDispatch({ userId: 'u1', sessionId, clientMessageId: cm, dispatchId, attemptNo: 1, payloadHash: 'h' })
    await recordTurnDispatchRunning({
      userId: 'u1', sessionId, clientMessageId: cm, agentId: 'main', turnIndex: 1,
      turnKey: `tk-${dispatchId}`, requestId: `req-${dispatchId}`, createdAt: 1,
    })
    await inboxSinkStaged({ userId: 'u1', sessionId, clientMessageId: cm })
  }

  test('sink_staged → CAS 成功 terminal → true', async () => {
    await seedSinkStaged('web-m5a', 'cm-m5a', 'd-m5a')
    assert.equal(await resolveInboxTerminalAck('d-m5a', 1, 'completed'), true, 'CAS 成功 → true')
    assert.equal((await getTurnDispatchStateByDispatch('d-m5a', 1))?.state, 'terminal')
  })

  test('已终态同 outcome → CAS null 但幂等成功 true', async () => {
    await seedSinkStaged('web-m5b', 'cm-m5b', 'd-m5b')
    await inboxTerminal({ userId: 'u1', sessionId: 'web-m5b', clientMessageId: 'cm-m5b' }, 'completed')
    // 第二次 ACK 同 outcome:inboxTerminal CAS 从 terminal 不再迁移 → null;回读幂等 → true。
    assert.equal(await resolveInboxTerminalAck('d-m5b', 1, 'completed'), true, '已终态同 outcome → 幂等 true')
  })

  test('queued 行(非 from-state)→ CAS null 且非终态 → false,entry 保留', async () => {
    // §7-1 类:INSERT queued 后未进 running。ACK 落空(queued 不在 sink_staged/running/recovery_pending)。
    await insertQueuedTurnDispatch({ userId: 'u1', sessionId: 'web-m5c', clientMessageId: 'cm-m5c', dispatchId: 'd-m5c', attemptNo: 1, payloadHash: 'h' })
    assert.equal(await resolveInboxTerminalAck('d-m5c', 1, 'completed'), false, 'CAS 落空且非目标终态 → false(保留 entry)')
    assert.equal((await getTurnDispatchStateByDispatch('d-m5c', 1))?.state, 'queued', '行仍 queued(未被误 terminal)')
  })

  test('行缺失 → false,entry 保留', async () => {
    assert.equal(await resolveInboxTerminalAck('d-m5-missing', 1, 'completed'), false, '无行 → false')
  })

  test('已终态但异 outcome → false(绝不幂等冒充)', async () => {
    await seedSinkStaged('web-m5e', 'cm-m5e', 'd-m5e')
    await inboxTerminal({ userId: 'u1', sessionId: 'web-m5e', clientMessageId: 'cm-m5e' }, 'completed')
    assert.equal(await resolveInboxTerminalAck('d-m5e', 1, 'crashed'), false, '已终态 completed vs ACK crashed → false')
    assert.equal((await getTurnDispatchStateByDispatch('d-m5e', 1))?.outcome, 'completed', 'outcome 未被改')
  })
})

// ── B4(R3):buildTurnDispatchStateResponse — 行缺失 → state:'absent' 单一权威 ──────────
describe('B4 buildTurnDispatchStateResponse(缺行 → absent)', () => {
  test('row=null → found:false + state:absent(非 null)', () => {
    assert.deepEqual(buildTurnDispatchStateResponse(null), {
      found: false, state: 'absent', outcome: null, dispatchId: null, attemptNo: null,
    })
  })

  test('row 存在 → found:true + 透传 state/outcome/身份(纯函数)', () => {
    // buildTurnDispatchStateResponse 是纯函数;用 literal row 断言透传,避开共享 sqlite 的跨测试污染。
    const row = {
      userId: 'u1', sessionId: 'web-b4', clientMessageId: 'cm-b4',
      dispatchId: 'd-b4', attemptNo: 1, state: 'sink_staged', outcome: null,
    } as unknown as Parameters<typeof buildTurnDispatchStateResponse>[0]
    assert.deepEqual(buildTurnDispatchStateResponse(row), {
      found: true, state: 'sink_staged', outcome: null, dispatchId: 'd-b4', attemptNo: 1,
    })
  })
})
