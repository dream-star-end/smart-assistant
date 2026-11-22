/**
 * OCV5-73: `cron-origin-inject` 遇 Master 权威证明未执行的 `503 PREVIOUSLY_FAILED_UNEXECUTED`
 * 时，容器以 delivery-token 围栏原子 CAS 有限次 bump `callback_epoch` 铸造新 `clientMessageId`
 * 重发；泛化 503 (`executed_error`/恢复占位/有账/旧版 Master)、409 `in_flight`、200 `delivered`/
 * `deduplicated`/`accepted` 绝不 bump；达上限原子 CAS 熔断；flag-off `send_to_agent` 正常调度重试。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronOriginPreviouslyFailedEpochBump.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  CRON_ORIGIN_INJECT_PATH,
  type JobTerminal,
  delegateCallbackMessageId,
  delegateNotifyId,
} from '@openclaude/protocol'

import {
  ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE,
  buildCronContinuationEnvelope,
} from '../cronOriginSession.js'
import {
  _ensureDurableSendToAgentCallback,
  _queueSendToAgentCallback,
} from '../delegateCallbacks.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import {
  DelegateJobStore,
  NOTIFY_ABANDON_AFTER_TERMINAL_MS,
  NOTIFY_ABANDON_MIN_ATTEMPTS,
  NOTIFY_CLAIM_LEASE_MS,
  NOTIFY_MAX_CALLBACK_EPOCH,
  nextNotifyBackoffMs,
} from '../delegateJobs.js'
import { dispatchJobTerminalNotify, retryPendingNotifies } from '../delegateNotifyDispatch.js'
import { resolveDelegateCallbackOwner } from '../delegateSmFlag.js'
import {
  handedOffDelegateRetryDelay,
  retryHandedOffDelegateNotifies,
} from '../delegateWaitHandoff.js'
import { DefaultEngineNotifier } from '../engineNotifier.js'
import { _armNotifyRetryScheduler } from '../gatewayLifecycle.js'
import { runBoundedOriginInjectBackoff } from '../originInjectBackoff.js'
import { sendToAgentCallbackClientMessageId } from '../sendToAgentCallback.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
} from '../sendToAgentIntentStore.js'
import { Gateway } from '../server.js'
import {
  CRON_ORIGIN_PREVIOUSLY_FAILED_UNEXECUTED_CODE,
  CRON_ORIGIN_SESSION_GONE_CODE,
} from '../v3CronOriginInject.js'

const ORIGIN_KEY = 'agent:main:webchat:dm:webocv573origin01'
const ENV_KEYS = [
  'OPENCLAUDE_V3_MASTER_BASE_URL',
  'OPENCLAUDE_V3_CONTAINER_TOKEN',
  'OC_DELEGATE_SM',
  'OC_DELEGATE_DURABLE',
  'OC_DELEGATE_NOTIFIER',
  'OC_DELEGATE_CALLBACK_OWNER',
  'OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR',
] as const
const savedEnv: Record<string, string | undefined> = {}

type MasterReply = {
  status: number
  body: unknown
}

const UNEXECUTED_503_REPLY: MasterReply = {
  status: 503,
  body: {
    error: {
      code: CRON_ORIGIN_PREVIOUSLY_FAILED_UNEXECUTED_CODE,
      message: 'previously_failed_unexecuted',
      request_id: 'req-pf-unexecuted',
    },
    userError: { code: 'unknown', message: 'error' },
  },
}

let server: Server
let receivedIds: string[] = []
let masterResponder: (clientMessageId: string, body: any) => MasterReply = () => ({
  status: 200,
  body: { ok: true, requestId: 'req-ok' },
})

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      assert.equal(req.url, CRON_ORIGIN_INJECT_PATH)
      const parsed = JSON.parse(raw)
      receivedIds.push(parsed.clientMessageId)
      const reply = masterResponder(parsed.clientMessageId, parsed)
      res.statusCode = reply.status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${port}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.7.test-secret'
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function makeGatewayForOriginInject(): Gateway {
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._runtimeRecycleDrainUntil = 0
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.sessions = { getByKey: () => undefined }
  return gw
}

function makeNotifier(gw: Gateway): DefaultEngineNotifier {
  const host = gw as any
  return new DefaultEngineNotifier({
    resumeInject: {
      inject: async (event: JobTerminal) => {
        const result =
          event.callback === 'cron-origin-inject'
            ? await host.injectCronOriginFromTerminal(event)
            : await host.injectSendToAgentCallback({
                parentSessionKey: event.parentSessionKey,
                jobId: event.jobId,
                agentId: event.agentId || 'main',
                goal: event.goal || 'test goal',
                output: event.resultRef || 'done',
                userId: event.callbackOriginUserId,
                clientMessageId: delegateCallbackMessageId(event.jobId, event.callbackEpoch),
                once: true,
              })
        if (result.kind === 'injected') return { ok: true }
        if (
          result.kind === 'retryable_failure' &&
          result.code === ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE
        ) {
          return { ok: false, failureClass: 'transport' as const, previouslyFailed: true }
        }
        if (result.kind === 'retryable_failure' && result.code === 'ORIGIN_SESSION_BUSY') {
          return { ok: false, failureClass: 'internal' as const, busy: true }
        }
        if (result.kind === 'fallback') {
          return { ok: false, failureClass: 'transport' as const, gone: true }
        }
        return { ok: false, failureClass: 'transport' as const }
      },
    },
  })
}

function createTerminalCronOriginJob(store: DelegateJobStore): string {
  const created = store.create('main', {
    queued: true,
    kind: 'cron',
    callback: 'cron-origin-inject',
    parentSessionKey: ORIGIN_KEY,
    callbackOriginSessionKey: ORIGIN_KEY,
    callbackOriginUserId: '3',
    parentEngine: 'cursor',
  })
  assert.ok('jobId' in created)
  const claimed = store.claimQueued(created.jobId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) throw new Error('claim failed')
  const envelope = buildCronContinuationEnvelope({
    id: 'remind-ocv573',
    prompt: '核验发布结果',
    label: '定时巡检',
    sourceUserId: '3',
    sourceSessionKey: ORIGIN_KEY,
  })
  assert.equal(
    store.complete(
      created.jobId,
      {
        httpStatus: 200,
        body: { ok: true, output: envelope.resumeText, cronContinuation: envelope },
      },
      claimed,
    ),
    true,
  )
  return created.jobId
}

function createTerminalSendToAgentJob(store: DelegateJobStore): {
  jobId: string
  claimToken: string
  fencingEpoch: number
} {
  const created = store.create('research-assistant', {
    queued: true,
    kind: 'send_to_agent',
    callback: 'origin-inject',
    parentSessionKey: ORIGIN_KEY,
    callbackOriginSessionKey: ORIGIN_KEY,
    callbackOriginUserId: '3',
    parentEngine: 'cursor',
  })
  assert.ok('jobId' in created)
  const claimed = store.claimQueued(created.jobId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) throw new Error('claim failed')
  assert.equal(
    store.complete(
      created.jobId,
      { httpStatus: 200, body: { ok: true, output: '结论正文' } },
      claimed,
    ),
    true,
  )
  return {
    jobId: created.jobId,
    claimToken: claimed.claimToken,
    fencingEpoch: claimed.fencingEpoch,
  }
}

describe('OCV5-73: cron-origin-inject previously_failed bounded callback_epoch bump', () => {
  it('bumps callback_epoch on 503 PREVIOUSLY_FAILED_UNEXECUTED, enforces backoff, and succeeds with fresh clientMessageId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-bump-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_000_000
    receivedIds = []
    try {
      const store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalCronOriginJob(store)
      const gw = makeGatewayForOriginInject()
      const notifier = makeNotifier(gw)

      masterResponder = (clientMessageId) =>
        clientMessageId === delegateCallbackMessageId(jobId, 1)
          ? UNEXECUTED_503_REPLY
          : { status: 200, body: { ok: true, requestId: 'req-ok-epoch2' } }

      const first = await dispatchJobTerminalNotify(store, store.snapshotOf(jobId)!, notifier)
      assert.equal('ok' in first && first.ok, false)

      const afterFirst = store.snapshotOf(jobId)!
      assert.equal(afterFirst.callbackState, 'pending')
      assert.equal(afterFirst.callbackEpoch, 2)
      assert.equal(afterFirst.notifyId, delegateNotifyId(jobId, 2))
      assert.equal(afterFirst.notifyAttempt, 1)
      assert.equal(afterFirst.notifyRetryAt, now + nextNotifyBackoffMs(0))

      // Before backoff expires: dueOnly must NOT fire (no tight loop!)
      assert.equal(store.listDueNotify(now).length, 0)
      const early = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
      assert.equal(early.scanned, 0)
      assert.deepEqual(receivedIds, [delegateCallbackMessageId(jobId, 1)])

      // Advance clock past backoff → Attempt 2 sends fresh dlgcb-{jobId}-2 and succeeds!
      now += nextNotifyBackoffMs(0)
      const retry = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
      assert.equal(retry.delivered, 1)
      assert.deepEqual(receivedIds, [
        delegateCallbackMessageId(jobId, 1),
        delegateCallbackMessageId(jobId, 2),
      ])

      const finalSnap = store.snapshotOf(jobId)!
      assert.equal(finalSnap.callbackState, 'delivered')
      assert.equal(finalSnap.callbackEpoch, 2)
      assert.equal(store.listPendingNotify().length, 0)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists bumped callback_epoch across container restart (SQLite durability)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-restart-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_100_000
    receivedIds = []
    try {
      const store1 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalCronOriginJob(store1)
      const gw = makeGatewayForOriginInject()

      masterResponder = (clientMessageId) =>
        clientMessageId === delegateCallbackMessageId(jobId, 1)
          ? UNEXECUTED_503_REPLY
          : { status: 200, body: { ok: true, requestId: 'r2' } }

      await dispatchJobTerminalNotify(store1, store1.snapshotOf(jobId)!, makeNotifier(gw))
      assert.equal(store1.snapshotOf(jobId)?.callbackEpoch, 2)
      store1.close()

      now += nextNotifyBackoffMs(0)
      const store2 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const recovered = store2.snapshotOf(jobId)!
      assert.equal(recovered.callbackEpoch, 2)
      assert.equal(recovered.callbackState, 'pending')
      assert.equal(recovered.notifyId, delegateNotifyId(jobId, 2))

      const summary = await retryPendingNotifies(store2, makeNotifier(gw), {}, { dueOnly: true })
      assert.equal(summary.delivered, 1)
      assert.deepEqual(receivedIds, [
        delegateCallbackMessageId(jobId, 1),
        delegateCallbackMessageId(jobId, 2),
      ])
      assert.equal(store2.snapshotOf(jobId)?.callbackState, 'delivered')
      store2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never bumps callback_epoch for generic 503 previously_failed (executed_error/recovery/billed), 409 in_flight, NO_TRANSPORT, delivery_unknown, manual_hold, or 200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-idem-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_200_000
    receivedIds = []
    try {
      const store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalCronOriginJob(store)
      const gw = makeGatewayForOriginInject()
      const notifier = makeNotifier(gw)

      const sequence: MasterReply[] = [
        // Generic 503 INJECT_FAILED / previously_failed (executed_error, provisional recovery sentinel, or billed) → MUST NOT bump!
        {
          status: 503,
          body: { error: { code: 'INJECT_FAILED', message: 'previously_failed', request_id: 'r-exec' } },
        },
        // 409 TURN_IN_FLIGHT (and even 409 carrying PREVIOUSLY_FAILED_UNEXECUTED) → MUST NOT bump!
        {
          status: 409,
          body: { error: { code: 'TURN_IN_FLIGHT', message: 'origin session has another open turn' } },
        },
        {
          status: 409,
          body: { error: { code: CRON_ORIGIN_PREVIOUSLY_FAILED_UNEXECUTED_CODE, message: 'previously_failed_unexecuted' } },
        },
        // 503 NO_TRANSPORT / delivery_unknown / manual_hold → MUST NOT bump!
        {
          status: 503,
          body: { error: { code: 'NO_TRANSPORT', message: 'no attested container bridge' } },
        },
        {
          status: 503,
          body: { error: { code: 'INJECT_FAILED', message: 'delivery_unknown' } },
        },
        {
          status: 503,
          body: { error: { code: 'INJECT_FAILED', message: 'manual_hold' } },
        },
        // 200 (master deduplicated or accepted for the same epoch-1 id → delivered!)
        {
          status: 200,
          body: { ok: true, requestId: 'req-dedup-200' },
        },
      ]
      masterResponder = () => sequence.shift() ?? { status: 200, body: { ok: true } }

      for (let i = 0; i < 6; i += 1) {
        const res = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
        assert.equal(res.failed, 1)
        const snap = store.snapshotOf(jobId)!
        assert.equal(snap.callbackEpoch, 1, `attempt ${i + 1} must NOT bump epoch`)
        assert.equal(snap.callbackState, 'pending')
        now = (snap.notifyRetryAt ?? now) + 1
      }

      const done = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
      assert.equal(done.delivered, 1)
      assert.equal(store.snapshotOf(jobId)?.callbackState, 'delivered')
      assert.equal(store.snapshotOf(jobId)?.callbackEpoch, 1)

      const expectedId = delegateCallbackMessageId(jobId, 1)
      assert.deepEqual(receivedIds, Array(7).fill(expectedId))

      const replay = await dispatchJobTerminalNotify(store, store.snapshotOf(jobId)!, notifier)
      assert.equal('ok' in replay && replay.ok, true)
      assert.equal(receivedIds.length, 7)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caps callback_epoch bumps at NOTIFY_MAX_CALLBACK_EPOCH and atomically abandons permanent unexecuted failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-cap-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_300_000
    receivedIds = []
    let onDeliveredCalls = 0
    try {
      const store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalCronOriginJob(store)
      const gw = makeGatewayForOriginInject()
      const notifier = makeNotifier(gw)

      masterResponder = () => UNEXECUTED_503_REPLY

      const hooks = {
        onDelivered: () => {
          onDeliveredCalls += 1
        },
      }

      for (let attempt = 1; attempt <= NOTIFY_MAX_CALLBACK_EPOCH; attempt += 1) {
        const res = await retryPendingNotifies(store, notifier, hooks, { dueOnly: true })
        const snap = store.snapshotOf(jobId)!
        if (attempt < NOTIFY_MAX_CALLBACK_EPOCH) {
          assert.equal(res.failed, 1)
          assert.equal(snap.callbackState, 'pending')
          assert.equal(snap.callbackEpoch, attempt + 1)
          assert.ok(snap.notifyRetryAt != null && snap.notifyRetryAt > now)
          now = snap.notifyRetryAt
        } else {
          assert.equal(snap.callbackState, 'abandoned')
          assert.equal(snap.callbackEpoch, NOTIFY_MAX_CALLBACK_EPOCH)
          assert.equal(snap.notifyRetryAt, null)
        }
      }

      const expectedIds = Array.from({ length: NOTIFY_MAX_CALLBACK_EPOCH }, (_, idx) =>
        delegateCallbackMessageId(jobId, idx + 1),
      )
      assert.deepEqual(receivedIds, expectedIds)
      assert.equal(onDeliveredCalls, 1)
      assert.equal(store.listPendingNotify().length, 0)
      assert.equal(store.listDueNotify(now + 100_000).length, 0)

      const extra = await retryPendingNotifies(store, notifier, hooks, { dueOnly: true })
      assert.equal(extra.scanned, 0)
      assert.equal(receivedIds.length, NOTIFY_MAX_CALLBACK_EPOCH)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('Blocker 2 (2-connection SQLite CAS): stale worker A at epoch cap cannot abandon or clear worker B valid claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-dual-cas-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_400_000
    try {
      const storeA = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const storeB = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalCronOriginJob(storeA)
      const initial = storeA.snapshotOf(jobId)!
      const fence = { claimToken: initial.claimToken!, fencingEpoch: initial.fencingEpoch }

      // Drive job durably from epoch 1 to NOTIFY_MAX_CALLBACK_EPOCH (5)
      for (let epoch = 1; epoch < NOTIFY_MAX_CALLBACK_EPOCH; epoch += 1) {
        const claim = storeA.claimNotifyDelivery(jobId, fence)
        assert.equal(claim.ok, true)
        if (!claim.ok) throw new Error('claim failed')
        assert.equal(
          storeA.releaseNotifyClaimWithEpochBump(jobId, claim.token, fence),
          'bumped',
        )
        now = (storeA.snapshotOf(jobId)?.notifyRetryAt ?? now) + 1
      }
      assert.equal(storeA.snapshotOf(jobId)?.callbackEpoch, NOTIFY_MAX_CALLBACK_EPOCH)

      // Worker A claims epoch 5 delivery
      const claimA = storeA.claimNotifyDelivery(jobId, fence)
      assert.equal(claimA.ok, true)
      if (!claimA.ok) throw new Error('claimA failed')

      // Worker A stalls past claim lease expiry → Worker B reclaims with fresh tokenB
      now += NOTIFY_CLAIM_LEASE_MS + 1_000
      const claimB = storeB.claimNotifyDelivery(jobId, fence)
      assert.equal(claimB.ok, true)
      if (!claimB.ok) throw new Error('claimB failed')
      assert.notEqual(claimB.token, claimA.token)

      // Stale Worker A hits epoch cap and tries to abandon with its stale tokenA:
      // MUST return 'stale' and MUST NOT abandon or clear Worker B's claim!
      const staleCapOutcome = storeA.releaseNotifyClaimWithEpochBump(jobId, claimA.token, fence)
      assert.equal(staleCapOutcome, 'stale')
      const liveAfterStaleA = storeB.snapshotOf(jobId)!
      assert.equal(liveAfterStaleA.callbackState, 'injecting')
      assert.equal(liveAfterStaleA.notifyDeliveryToken, claimB.token)

      // Worker B completes delivery with valid tokenB → succeeds!
      assert.equal(storeB.completeNotifyDelivery(jobId, claimB.token, fence), true)
      assert.equal(storeB.snapshotOf(jobId)?.callbackState, 'delivered')

      storeA.close()
      storeB.close()

      // Reopen fresh SQLite connection (restart proof): delivered, NOT abandoned
      const storeAfterRestart = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      assert.equal(storeAfterRestart.snapshotOf(jobId)?.callbackState, 'delivered')
      assert.equal(storeAfterRestart.snapshotOf(jobId)?.callbackEpoch, NOTIFY_MAX_CALLBACK_EPOCH)
      storeAfterRestart.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('Blocker 2 (dispatchJobTerminalNotify race): stale worker A returning previouslyFailed at epoch cap does NOT invoke onDelivered cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-dispatch-race-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_500_000
    let onDeliveredA = 0
    try {
      const storeA = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const storeB = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalCronOriginJob(storeA)
      const initial = storeA.snapshotOf(jobId)!
      const fence = { claimToken: initial.claimToken!, fencingEpoch: initial.fencingEpoch }

      // Drive to epoch 5
      for (let epoch = 1; epoch < NOTIFY_MAX_CALLBACK_EPOCH; epoch += 1) {
        const c = storeA.claimNotifyDelivery(jobId, fence)
        assert.equal(c.ok, true)
        if (!c.ok) throw new Error('claim failed')
        assert.equal(storeA.releaseNotifyClaimWithEpochBump(jobId, c.token, fence), 'bumped')
        now = (storeA.snapshotOf(jobId)?.notifyRetryAt ?? now) + 1
      }

      let tokenB: string | undefined
      const slowNotifierA = new DefaultEngineNotifier({
        resumeInject: {
          inject: async () => {
            // While A is awaiting master, its lease expires and Worker B reclaims!
            now += NOTIFY_CLAIM_LEASE_MS + 1_000
            const claimB = storeB.claimNotifyDelivery(jobId, fence)
            assert.equal(claimB.ok, true)
            if (claimB.ok) tokenB = claimB.token
            return { ok: false, failureClass: 'transport', previouslyFailed: true }
          },
        },
      })

      const resA = await dispatchJobTerminalNotify(
        storeA,
        storeA.snapshotOf(jobId)!,
        slowNotifierA,
        {
          onDelivered: () => {
            onDeliveredA += 1
          },
        },
      )
      assert.equal('ok' in resA && resA.ok, false)
      assert.equal(onDeliveredA, 0, 'stale worker A must not trigger onDelivered/intent cleanup')
      assert.ok(tokenB)
      assert.equal(storeB.snapshotOf(jobId)?.callbackState, 'injecting')
      assert.equal(storeB.completeNotifyDelivery(jobId, tokenB!, fence), true)
      assert.equal(storeB.snapshotOf(jobId)?.callbackState, 'delivered')

      storeA.close()
      storeB.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('Blocker 3 (flag-off kind=send_to_agent): bumps epoch 1→2, arms real retry timer, and delivers epoch 2 without restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-flagoff-sta-'))
    const dbPath = join(dir, 'delegate.db')
    const intentDir = join(dir, 'intents')
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OC_DELEGATE_NOTIFIER = '0'
    process.env.OC_DELEGATE_CALLBACK_OWNER = 'job'
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    receivedIds = []
    let store: DelegateJobStore | undefined
    let host: any
    try {
      store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
      })
      const { jobId, claimToken, fencingEpoch } = createTerminalSendToAgentJob(store)
      assert.equal(store.snapshotOf(jobId)?.kind, 'send_to_agent')

      const gw = makeGatewayForOriginInject() as any
      host = {
        _delegateJobs: store,
        _activeSendToAgentCallbacks: new Map([
          [
            jobId,
            {
              v: 1,
              jobId,
              originSessionKey: ORIGIN_KEY,
              userId: '3',
              agentId: 'research-assistant',
              goal: '查资料',
              createdAt: Date.now(),
            },
          ],
        ]),
        _notifyRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        _drainFlagOffCronOriginNotifies: async () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw.injectSendToAgentCallback.bind(gw),
      }
      host._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host)
      host._armNotifyRetryScheduler = _armNotifyRetryScheduler.bind(host)

      masterResponder = (clientMessageId) =>
        clientMessageId === delegateCallbackMessageId(jobId, 1)
          ? UNEXECUTED_503_REPLY
          : { status: 200, body: { ok: true, requestId: 'req-sta-epoch2' } }

      // Trigger real flag-off completion callback path for kind='send_to_agent'
      _queueSendToAgentCallback.call(
        host,
        {
          callbackOnComplete: 'origin-inject',
          parentSessionKey: ORIGIN_KEY,
          callbackOriginSessionKey: ORIGIN_KEY,
          callbackOriginUserId: '3',
          claimToken,
          fencingEpoch,
        } as any,
        {
          jobId,
          agentId: 'research-assistant',
          goal: '查资料',
          output: '结论正文',
        },
      )

      // Wait for Attempt 1 (epoch 1 → 503 PREVIOUSLY_FAILED_UNEXECUTED → bumped to epoch 2 & timer armed)
      for (let i = 0; i < 100 && store.snapshotOf(jobId)?.callbackEpoch !== 2; i += 1) {
        await delay(20)
      }
      const afterFirst = store.snapshotOf(jobId)!
      assert.equal(afterFirst.callbackEpoch, 2)
      assert.equal(afterFirst.callbackState, 'pending')
      assert.notEqual(
        handedOffDelegateRetryDelay(store),
        undefined,
        'flag-off scheduler must see kind=send_to_agent epoch 2 pending row',
      )
      assert.ok(host._notifyRetryTimer, 'flag-off retry timer must be armed')
      assert.deepEqual(receivedIds, [delegateCallbackMessageId(jobId, 1)])

      // Without restarting, wait for the armed 1s backoff timer to fire and deliver epoch 2!
      for (
        let i = 0;
        i < 150 &&
        (store.snapshotOf(jobId)?.callbackState !== 'delivered' ||
          host._activeSendToAgentCallbacks.size > 0);
        i += 1
      ) {
        await delay(30)
      }
      const finalSnap = store.snapshotOf(jobId)!
      assert.equal(finalSnap.callbackState, 'delivered')
      assert.equal(finalSnap.callbackEpoch, 2)
      assert.equal(host._notifyRetryTimer, undefined)
      assert.deepEqual(receivedIds, [
        delegateCallbackMessageId(jobId, 1),
        delegateCallbackMessageId(jobId, 2),
      ])
    } finally {
      if (host) host._shuttingDown = true
      if (host?._notifyRetryTimer) clearTimeout(host._notifyRetryTimer)
      store?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('R2 Critical (CALLBACK_OWNER=intent + NOTIFIER=0): first 200 clears intent and restart never redelivers via dlgcb id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-intent-restart-'))
    const dbPath = join(dir, 'delegate.db')
    const intentDir = join(dir, 'intents')
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OC_DELEGATE_NOTIFIER = '0'
    process.env.OC_DELEGATE_CALLBACK_OWNER = 'intent'
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    receivedIds = []
    let store1: DelegateJobStore | undefined
    let store2: DelegateJobStore | undefined
    let host1: any
    let host2: any
    try {
      store1 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
      })
      const { jobId, claimToken, fencingEpoch } = createTerminalSendToAgentJob(store1)
      const savedIntent = {
        v: 1 as const,
        jobId,
        originSessionKey: ORIGIN_KEY,
        userId: '3',
        agentId: 'research-assistant',
        goal: '查资料',
        createdAt: Date.now(),
      }
      await persistSendToAgentIntent(savedIntent)

      const gw1 = makeGatewayForOriginInject() as any
      host1 = {
        _shuttingDown: false,
        _delegateJobs: store1,
        _activeSendToAgentCallbacks: new Map([[jobId, savedIntent]]),
        _notifyRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        _drainFlagOffCronOriginNotifies: async () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw1.injectSendToAgentCallback.bind(gw1),
      }
      host1._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host1)
      host1._armNotifyRetryScheduler = _armNotifyRetryScheduler.bind(host1)

      masterResponder = () => ({ status: 200, body: { ok: true, requestId: 'req-intent-200' } })

      // 1) First completion under CALLBACK_OWNER=intent + NOTIFIER=0 delivers via legacy sta-cb-{jobId}
      //    and removes the intent file while leaving delegate_jobs.callbackState='pending'.
      _queueSendToAgentCallback.call(
        host1,
        {
          callbackOnComplete: 'origin-inject',
          parentSessionKey: ORIGIN_KEY,
          callbackOriginSessionKey: ORIGIN_KEY,
          callbackOriginUserId: '3',
          claimToken,
          fencingEpoch,
        } as any,
        {
          jobId,
          agentId: 'research-assistant',
          goal: '查资料',
          output: '结论正文',
        },
      )

      for (let i = 0; i < 100 && host1._activeSendToAgentCallbacks.size > 0; i += 1) {
        await delay(20)
      }
      await delay(20)
      assert.deepEqual(receivedIds, [sendToAgentCallbackClientMessageId(jobId)])
      assert.deepEqual(await readdir(intentDir), [])
      assert.equal(store1.snapshotOf(jobId)?.callbackState, 'pending')

      // Live scheduler/retry must NOT touch intent-owned send_to_agent rows
      assert.equal(handedOffDelegateRetryDelay(store1), undefined)
      host1._armNotifyRetryScheduler()
      assert.equal(host1._notifyRetryTimer, undefined)
      await retryHandedOffDelegateNotifies(host1)
      assert.equal(receivedIds.length, 1)

      host1._shuttingDown = true
      store1.close()
      store1 = undefined

      // 2) Simulate container restart reopening the same durable SQLite DB:
      //    boot recovery + flag-off retry scheduler + direct _ensureDurableSendToAgentCallback
      //    must NEVER re-inject with dlgcb-{jobId}-1!
      store2 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
      })
      const gw2 = makeGatewayForOriginInject() as any
      host2 = {
        _shuttingDown: false,
        _delegateJobs: store2,
        _activeSendToAgentCallbacks: new Map(),
        _notifyRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        _drainFlagOffCronOriginNotifies: async () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw2.injectSendToAgentCallback.bind(gw2),
      }
      host2._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host2)
      host2._armNotifyRetryScheduler = _armNotifyRetryScheduler.bind(host2)

      const recovery = await recoverInterruptedSendToAgentIntents(
        async () => {
          throw new Error('intent was already removed on first 200; interrupt notice must not run')
        },
        process.env,
        {
          callbackOwner: resolveDelegateCallbackOwner(),
          resolveJob: (id) => store2!.snapshotOf(id),
          ensureCallback: (job, intent) => host2._ensureDurableSendToAgentCallback(job, intent),
        },
      )
      assert.equal(recovery.recovered, 0)
      assert.equal(recovery.retained, 0)
      assert.equal(handedOffDelegateRetryDelay(store2), undefined)
      host2._armNotifyRetryScheduler()
      assert.equal(host2._notifyRetryTimer, undefined)
      await retryHandedOffDelegateNotifies(host2)
      assert.equal(
        await host2._ensureDurableSendToAgentCallback(store2.snapshotOf(jobId), savedIntent),
        false,
      )
      assert.deepEqual(
        receivedIds,
        [sendToAgentCallbackClientMessageId(jobId)],
        'restart must not redeliver an intent-owned callback with a new dlgcb-* id',
      )
    } finally {
      if (host1) host1._shuttingDown = true
      if (host2) host2._shuttingDown = true
      if (host1?._notifyRetryTimer) clearTimeout(host1._notifyRetryTimer)
      if (host2?._notifyRetryTimer) clearTimeout(host2._notifyRetryTimer)
      store1?.close()
      store2?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('R2 Warning (owner=job, NOTIFIER=0): Master 404 SESSION_GONE terminates row with current delivery token and stops retrying', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-404-flagoff-'))
    const dbPath = join(dir, 'delegate.db')
    const intentDir = join(dir, 'intents')
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OC_DELEGATE_NOTIFIER = '0'
    process.env.OC_DELEGATE_CALLBACK_OWNER = 'job'
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    receivedIds = []
    let store: DelegateJobStore | undefined
    let reopened: DelegateJobStore | undefined
    let host: any
    try {
      store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
      })
      const { jobId } = createTerminalSendToAgentJob(store)
      const savedIntent = {
        v: 1 as const,
        jobId,
        originSessionKey: ORIGIN_KEY,
        userId: '3',
        agentId: 'research-assistant',
        goal: '查资料',
        createdAt: Date.now(),
      }
      await persistSendToAgentIntent(savedIntent)

      const gw = makeGatewayForOriginInject() as any
      host = {
        _shuttingDown: false,
        _delegateJobs: store,
        _activeSendToAgentCallbacks: new Map([[jobId, savedIntent]]),
        _notifyRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        _drainFlagOffCronOriginNotifies: async () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw.injectSendToAgentCallback.bind(gw),
      }
      host._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host)
      host._armNotifyRetryScheduler = _armNotifyRetryScheduler.bind(host)

      masterResponder = () => ({
        status: 404,
        body: {
          error: {
            code: CRON_ORIGIN_SESSION_GONE_CODE,
            message: 'origin session missing or deleted',
            request_id: 'req-404-gone',
          },
        },
      })

      const ok = await host._ensureDurableSendToAgentCallback(store.snapshotOf(jobId), savedIntent)
      assert.equal(ok, true, '404 SESSION_GONE terminates callback cleanly')
      assert.deepEqual(receivedIds, [delegateCallbackMessageId(jobId, 1)])
      const snap = store.snapshotOf(jobId)!
      assert.equal(snap.callbackState, 'abandoned')
      assert.equal(snap.notifyRetryAt, null)
      assert.equal(snap.notifyDeliveryToken, undefined)
      assert.equal(host._activeSendToAgentCallbacks.size, 0)
      assert.deepEqual(await readdir(intentDir), [])
      assert.equal(host._notifyRetryTimer, undefined)
      assert.equal(handedOffDelegateRetryDelay(store), undefined)

      // Retry pass and restart must never contact master again
      await retryHandedOffDelegateNotifies(host)
      assert.equal(receivedIds.length, 1)
      host._shuttingDown = true
      store.close()
      store = undefined

      reopened = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
      })
      assert.equal(reopened.snapshotOf(jobId)?.callbackState, 'abandoned')
      assert.equal(reopened.listPendingNotify().length, 0)
      assert.equal(handedOffDelegateRetryDelay(reopened), undefined)
    } finally {
      if (host) host._shuttingDown = true
      if (host?._notifyRetryTimer) clearTimeout(host._notifyRetryTimer)
      store?.close()
      reopened?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('R2 Warning (owner=job, NOTIFIER=1 + stale token race): Master 404 SESSION_GONE terminates immediately with delivery-token fence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-404-notifier-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_600_000
    receivedIds = []
    let onDeliveredCount = 0
    try {
      const store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalSendToAgentJob(store).jobId
      const gw = makeGatewayForOriginInject()
      const notifier = makeNotifier(gw)

      masterResponder = () => ({
        status: 404,
        body: {
          error: {
            code: CRON_ORIGIN_SESSION_GONE_CODE,
            message: 'origin session missing or deleted',
            request_id: 'req-404-nfy',
          },
        },
      })

      // Fresh terminal job (attempt 0, 0ms elapsed): 404 SESSION_GONE must abandon immediately
      const res = await dispatchJobTerminalNotify(store, store.snapshotOf(jobId)!, notifier, {
        onDelivered: () => {
          onDeliveredCount += 1
        },
      })
      assert.equal('ok' in res && res.ok, true)
      assert.equal(onDeliveredCount, 1)
      assert.deepEqual(receivedIds, [delegateCallbackMessageId(jobId, 1)])
      const snap = store.snapshotOf(jobId)!
      assert.equal(snap.callbackState, 'abandoned')
      assert.equal(snap.notifyRetryAt, null)
      assert.equal(store.listPendingNotify().length, 0)

      // Stale delivery-token race: Worker A gets 404 after Worker B reclaimed → must NOT abandon Worker B!
      const jobId2 = createTerminalSendToAgentJob(store).jobId
      const storeB = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const snap2 = store.snapshotOf(jobId2)!
      const fence2 = { claimToken: snap2.claimToken!, fencingEpoch: snap2.fencingEpoch }
      let tokenB: string | undefined
      let staleOnDelivered = 0
      const slowGoneNotifier = new DefaultEngineNotifier({
        resumeInject: {
          inject: async () => {
            now += NOTIFY_CLAIM_LEASE_MS + 1_000
            const claimB = storeB.claimNotifyDelivery(jobId2, fence2)
            assert.equal(claimB.ok, true)
            if (claimB.ok) tokenB = claimB.token
            return { ok: false, failureClass: 'transport', gone: true }
          },
        },
      })
      const staleRes = await dispatchJobTerminalNotify(store, snap2, slowGoneNotifier, {
        onDelivered: () => {
          staleOnDelivered += 1
        },
      })
      assert.equal('ok' in staleRes && staleRes.ok, false)
      assert.equal(staleOnDelivered, 0)
      assert.equal(storeB.snapshotOf(jobId2)?.callbackState, 'injecting')
      assert.equal(storeB.snapshotOf(jobId2)?.notifyDeliveryToken, tokenB)
      assert.equal(storeB.completeNotifyDelivery(jobId2, tokenB!, fence2), true)
      assert.equal(storeB.snapshotOf(jobId2)?.callbackState, 'delivered')

      storeB.close()
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('R2 Warning (transient 5xx/network retry budget): enforces NOTIFY_ABANDON_MIN_ATTEMPTS + 24h ceiling in both flag-off and notifier paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-transient-budget-'))
    const dbPath = join(dir, 'delegate.db')
    const intentDir = join(dir, 'intents')
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OC_DELEGATE_NOTIFIER = '0'
    process.env.OC_DELEGATE_CALLBACK_OWNER = 'job'
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    let now = 1_700_000_700_000
    receivedIds = []
    let store: DelegateJobStore | undefined
    let host: any
    try {
      store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const { jobId, claimToken, fencingEpoch } = createTerminalSendToAgentJob(store)
      const fence = { claimToken, fencingEpoch }
      const savedIntent = {
        v: 1 as const,
        jobId,
        originSessionKey: ORIGIN_KEY,
        userId: '3',
        agentId: 'research-assistant',
        goal: '查资料',
        createdAt: now,
      }
      await persistSendToAgentIntent(savedIntent)

      const gw = makeGatewayForOriginInject() as any
      host = {
        _shuttingDown: false,
        _delegateJobs: store,
        _activeSendToAgentCallbacks: new Map([[jobId, savedIntent]]),
        _notifyRetryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        _armNotifyRetryScheduler: () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw.injectSendToAgentCallback.bind(gw),
      }
      host._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host)

      masterResponder = () => ({
        status: 503,
        body: { error: { code: 'NO_TRANSPORT', message: 'no attested container bridge' } },
      })

      // 1) Under budget (attempt 1, < 24h): must stay pending with backoff, never abandon or bump epoch
      const firstOk = await host._ensureDurableSendToAgentCallback(store.snapshotOf(jobId), savedIntent)
      assert.equal(firstOk, false)
      const afterFirst = store.snapshotOf(jobId)!
      assert.equal(afterFirst.callbackState, 'pending')
      assert.equal(afterFirst.callbackEpoch, 1)
      assert.equal(afterFirst.notifyAttempt, 1)
      assert.ok(afterFirst.notifyRetryAt != null && afterFirst.notifyRetryAt > now)
      assert.equal(host._activeSendToAgentCallbacks.size, 1)

      // 2) Advance attempts to NOTIFY_ABANDON_MIN_ATTEMPTS - 2 (46) while still < 24h:
      //    47th attempt (even past 24h) is still below 48 → stays pending
      for (let i = afterFirst.notifyAttempt ?? 0; i < NOTIFY_ABANDON_MIN_ATTEMPTS - 2; i += 1) {
        assert.equal(store.deferPendingNotify(jobId, fence), true)
      }
      now = (store.snapshotOf(jobId)?.terminalCommittedAt ?? now) + NOTIFY_ABANDON_AFTER_TERMINAL_MS + 1_000
      const attempt47Ok = await host._ensureDurableSendToAgentCallback(store.snapshotOf(jobId), savedIntent)
      assert.equal(attempt47Ok, false)
      const after47 = store.snapshotOf(jobId)!
      assert.equal(after47.callbackState, 'pending')
      assert.equal(after47.notifyAttempt, NOTIFY_ABANDON_MIN_ATTEMPTS - 1)

      // 3) Attempt 48 (meets BOTH >= 48 attempts AND >= 24h terminal age):
      //    atomically abandons with current delivery token and clears intent!
      now = (after47.notifyRetryAt ?? now) + 1
      const attempt48Ok = await host._ensureDurableSendToAgentCallback(store.snapshotOf(jobId), savedIntent)
      assert.equal(attempt48Ok, true)
      const abandoned = store.snapshotOf(jobId)!
      assert.equal(abandoned.callbackState, 'abandoned')
      assert.equal(abandoned.callbackEpoch, 1)
      assert.equal(abandoned.notifyRetryAt, null)
      assert.equal(host._activeSendToAgentCallbacks.size, 0)
      assert.deepEqual(await readdir(intentDir), [])
      assert.equal(store.listPendingNotify().length, 0)
      // All transient retries kept epoch 1 (no spurious epoch bumps)
      assert.deepEqual(receivedIds, Array(3).fill(delegateCallbackMessageId(jobId, 1)))
    } finally {
      if (host) host._shuttingDown = true
      store?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('T2 P1 (owner=job, NOTIFIER=0): restart restores persisted intent goal so retry preserves identical text/requestHash without immutable_conflict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-restart-goal-'))
    const dbPath = join(dir, 'delegate.db')
    const intentDir = join(dir, 'intents')
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OC_DELEGATE_NOTIFIER = '0'
    process.env.OC_DELEGATE_CALLBACK_OWNER = 'job'
    process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = intentDir
    let now = 1_700_000_800_000
    receivedIds = []
    const receivedTexts: string[] = []
    const expectedTextById = new Map<string, string>()
    let store1: DelegateJobStore | undefined
    let store2: DelegateJobStore | undefined
    let host1: any
    let host2: any
    try {
      store1 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const { jobId } = createTerminalSendToAgentJob(store1)
      const originalGoal = '核验重启后目标正文与请求哈希一致'
      const savedIntent = {
        v: 1 as const,
        jobId,
        originSessionKey: ORIGIN_KEY,
        userId: '3',
        agentId: 'research-assistant',
        goal: originalGoal,
        createdAt: now,
      }
      await persistSendToAgentIntent(savedIntent)

      const gw1 = makeGatewayForOriginInject() as any
      host1 = {
        _shuttingDown: false,
        _delegateJobs: store1,
        _activeSendToAgentCallbacks: new Map([[jobId, savedIntent]]),
        _armNotifyRetryScheduler: () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw1.injectSendToAgentCallback.bind(gw1),
      }
      host1._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host1)

      let epoch1Calls = 0
      masterResponder = (clientMessageId, body) => {
        receivedTexts.push(body.text)
        const prev = expectedTextById.get(clientMessageId)
        if (prev !== undefined && prev !== body.text) {
          return {
            status: 503,
            body: {
              error: {
                code: 'INJECT_FAILED',
                message: 'immutable_conflict',
                request_id: 'req-immutable-conflict',
              },
            },
          }
        }
        expectedTextById.set(clientMessageId, body.text)
        if (clientMessageId === delegateCallbackMessageId(jobId, 1)) {
          epoch1Calls += 1
          return epoch1Calls === 1
            ? { status: 503, body: { error: { code: 'NO_TRANSPORT', message: 'bridge down' } } }
            : UNEXECUTED_503_REPLY
        }
        return { status: 200, body: { ok: true, requestId: 'req-epoch2-ok' } }
      }

      // 1) Pre-restart attempt 1 (epoch 1) fails transiently with NO_TRANSPORT
      const ok1 = await host1._ensureDurableSendToAgentCallback(store1.snapshotOf(jobId), savedIntent)
      assert.equal(ok1, false)
      assert.equal(store1.snapshotOf(jobId)?.callbackEpoch, 1)
      assert.equal(store1.snapshotOf(jobId)?.callbackState, 'pending')
      assert.ok(receivedTexts[0]!.includes(originalGoal))
      host1._shuttingDown = true
      store1.close()
      store1 = undefined

      // 2) Restart: empty in-memory _activeSendToAgentCallbacks; advance past backoff and run timer retry
      now += nextNotifyBackoffMs(0) + 1
      store2 = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const gw2 = makeGatewayForOriginInject() as any
      host2 = {
        _shuttingDown: false,
        _delegateJobs: store2,
        _activeSendToAgentCallbacks: new Map(), // empty after restart!
        _armNotifyRetryScheduler: () => {},
        sessions: { getByKey: () => ({ userId: '3' }) },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        injectSendToAgentCallback: gw2.injectSendToAgentCallback.bind(gw2),
      }
      host2._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host2)

      // Post-restart retry on epoch 1: must reconstruct byte-identical text (no immutable_conflict!),
      // receive PREVIOUSLY_FAILED_UNEXECUTED, and bump epoch 1 -> 2.
      await retryHandedOffDelegateNotifies(host2)
      assert.equal(receivedTexts.length, 2)
      assert.equal(
        receivedTexts[1],
        receivedTexts[0],
        'post-restart retry must preserve exact goal/text so requestHash matches epoch 1',
      )
      assert.equal(store2.snapshotOf(jobId)?.callbackEpoch, 2)
      assert.equal(store2.snapshotOf(jobId)?.callbackState, 'pending')

      // Advance past epoch 2 backoff -> delivers epoch 2 with the exact same goal text!
      now = (store2.snapshotOf(jobId)?.notifyRetryAt ?? now) + 1
      await retryHandedOffDelegateNotifies(host2)
      assert.equal(receivedTexts.length, 3)
      assert.equal(receivedTexts[2], receivedTexts[0])
      assert.equal(store2.snapshotOf(jobId)?.callbackState, 'delivered')
      assert.equal(store2.snapshotOf(jobId)?.callbackEpoch, 2)
      assert.deepEqual(await readdir(intentDir), [])
      assert.deepEqual(receivedIds, [
        delegateCallbackMessageId(jobId, 1),
        delegateCallbackMessageId(jobId, 1),
        delegateCallbackMessageId(jobId, 2),
      ])
    } finally {
      if (host1) host1._shuttingDown = true
      if (host2) host2._shuttingDown = true
      store1?.close()
      store2?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runBoundedOriginInjectBackoff exits immediately on ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE', async () => {
    let tries = 0
    let sleeps = 0
    const res = await runBoundedOriginInjectBackoff({
      tryOnce: async () => {
        tries += 1
        return { kind: 'retryable_failure', code: ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE }
      },
      sleep: async () => {
        sleeps += 1
      },
    })
    assert.deepEqual(res, {
      kind: 'retryable_failure',
      code: ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE,
    })
    assert.equal(tries, 1)
    assert.equal(sleeps, 0)
  })
})
