/**
 * OCV5-73: `cron-origin-inject` 遇 `previously_failed` (503) 应让容器 bounded bump
 * `callback_epoch` 铸造新 `clientMessageId` 重发，同时保持 `delivered` / `in_flight` /
 * `accepted` / `NO_TRANSPORT` / `delivery_unknown` 同 epoch 幂等去重，且受最大 epoch 上限约束。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronOriginPreviouslyFailedEpochBump.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

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
import { DelegateDurableDb } from '../delegateDurable.js'
import {
  DelegateJobStore,
  NOTIFY_MAX_CALLBACK_EPOCH,
  nextNotifyBackoffMs,
} from '../delegateJobs.js'
import { dispatchJobTerminalNotify, retryPendingNotifies } from '../delegateNotifyDispatch.js'
import { DefaultEngineNotifier } from '../engineNotifier.js'
import { runBoundedOriginInjectBackoff } from '../originInjectBackoff.js'
import { Gateway } from '../server.js'

const ORIGIN_KEY = 'agent:main:webchat:dm:webocv573origin01'
const ENV_KEYS = ['OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN'] as const
const savedEnv: Record<string, string | undefined> = {}

type MasterReply = {
  status: number
  body: unknown
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

function createTerminalSendToAgentJob(store: DelegateJobStore): string {
  const created = store.create('research-assistant', {
    queued: true,
    kind: 'delegate',
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
  return created.jobId
}

describe('OCV5-73: cron-origin-inject previously_failed bounded callback_epoch bump', () => {
  it('bumps callback_epoch on 503 previously_failed, enforces backoff, and succeeds with fresh clientMessageId', async () => {
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

      // Master rejects epoch 1 with exact makeCronOriginInjectHandler 503 previously_failed payload,
      // and accepts epoch 2 cleanly.
      masterResponder = (clientMessageId) => {
        if (clientMessageId === delegateCallbackMessageId(jobId, 1)) {
          return {
            status: 503,
            body: {
              error: {
                code: 'INJECT_FAILED',
                message: 'previously_failed',
                request_id: 'req-pf-epoch1',
              },
              userError: { code: 'unknown', message: 'error' },
            },
          }
        }
        return { status: 200, body: { ok: true, requestId: 'req-ok-epoch2' } }
      }

      // Attempt 1 (epoch 1) → 503 previously_failed → bump to epoch 2 + backoff
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
          ? {
              status: 503,
              body: {
                error: { code: 'INJECT_FAILED', message: 'previously_failed', request_id: 'r1' },
              },
            }
          : { status: 200, body: { ok: true, requestId: 'r2' } }

      await dispatchJobTerminalNotify(store1, store1.snapshotOf(jobId)!, makeNotifier(gw))
      assert.equal(store1.snapshotOf(jobId)?.callbackEpoch, 2)
      store1.close()

      // Simulate restart with fresh SQLite store + fresh EngineNotifier
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

  it('preserves same callback_epoch idempotency for in_flight, transient 503, and delivered/deduplicated/accepted', async () => {
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
        // 409 TURN_IN_FLIGHT (admitted / rejecting / session_busy / already_owned)
        {
          status: 409,
          body: {
            error: { code: 'TURN_IN_FLIGHT', message: 'origin session has another open turn' },
          },
        },
        // 503 NO_TRANSPORT
        {
          status: 503,
          body: { error: { code: 'NO_TRANSPORT', message: 'no attested container bridge' } },
        },
        // 503 delivery_unknown (bytes may be in flight — MUST NOT bump!)
        {
          status: 503,
          body: { error: { code: 'INJECT_FAILED', message: 'delivery_unknown' } },
        },
        // 503 manual_hold (MUST NOT bump!)
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

      for (let i = 0; i < 4; i += 1) {
        const res = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
        assert.equal(res.failed, 1)
        const snap = store.snapshotOf(jobId)!
        assert.equal(
          snap.callbackEpoch,
          1,
          `transient/in_flight attempt ${i + 1} must not bump epoch`,
        )
        assert.equal(snap.callbackState, 'pending')
        now = (snap.notifyRetryAt ?? now) + 1
      }

      // 5th try gets 200 (deduplicated/accepted)
      const done = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
      assert.equal(done.delivered, 1)
      assert.equal(store.snapshotOf(jobId)?.callbackState, 'delivered')
      assert.equal(store.snapshotOf(jobId)?.callbackEpoch, 1)

      // Every single attempt used the EXACT same epoch-1 clientMessageId
      const expectedId = delegateCallbackMessageId(jobId, 1)
      assert.deepEqual(receivedIds, [expectedId, expectedId, expectedId, expectedId, expectedId])

      // Subsequent dispatch on already-delivered row is a no-op with 0 HTTP calls
      const replay = await dispatchJobTerminalNotify(store, store.snapshotOf(jobId)!, notifier)
      assert.equal('ok' in replay && replay.ok, true)
      assert.equal(receivedIds.length, 5)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caps callback_epoch bumps at NOTIFY_MAX_CALLBACK_EPOCH and abandons permanent previously_failed storms', async () => {
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

      // Master permanently returns 503 previously_failed for every epoch
      masterResponder = () => ({
        status: 503,
        body: {
          error: {
            code: 'INJECT_FAILED',
            message: 'previously_failed',
            request_id: 'req-permanent-pf',
          },
        },
      })

      const hooks = {
        onDelivered: () => {
          onDeliveredCalls += 1
        },
      }

      // Drive retries up to the cap (epochs 1..NOTIFY_MAX_CALLBACK_EPOCH)
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
          // Final attempt hit the cap → abandoned, no epoch 6!
          assert.equal(snap.callbackState, 'abandoned')
          assert.equal(snap.callbackEpoch, NOTIFY_MAX_CALLBACK_EPOCH)
          assert.equal(snap.notifyRetryAt, null)
        }
      }

      // Exact epochs 1..NOTIFY_MAX_CALLBACK_EPOCH sent, never beyond cap
      const expectedIds = Array.from({ length: NOTIFY_MAX_CALLBACK_EPOCH }, (_, idx) =>
        delegateCallbackMessageId(jobId, idx + 1),
      )
      assert.deepEqual(receivedIds, expectedIds)
      assert.equal(onDeliveredCalls, 1)
      assert.equal(store.listPendingNotify().length, 0)
      assert.equal(store.listDueNotify(now + 100_000).length, 0)

      // No further HTTP traffic on future ticks
      const extra = await retryPendingNotifies(store, notifier, hooks, { dueOnly: true })
      assert.equal(extra.scanned, 0)
      assert.equal(receivedIds.length, NOTIFY_MAX_CALLBACK_EPOCH)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('also bumps callback_epoch for send_to_agent origin-inject callbacks and rejects stale claim bumps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-73-sta-'))
    const dbPath = join(dir, 'delegate.db')
    let now = 1_700_000_400_000
    receivedIds = []
    try {
      const store = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(dbPath),
        now: () => now,
      })
      const jobId = createTerminalSendToAgentJob(store)
      const gw = makeGatewayForOriginInject()
      const notifier = makeNotifier(gw)

      masterResponder = (clientMessageId) =>
        clientMessageId === delegateCallbackMessageId(jobId, 1)
          ? {
              status: 503,
              body: {
                error: {
                  code: 'INJECT_FAILED',
                  message: 'previously_failed',
                  request_id: 'r-sta1',
                },
              },
            }
          : { status: 200, body: { ok: true, requestId: 'r-sta2' } }

      const first = await dispatchJobTerminalNotify(store, store.snapshotOf(jobId)!, notifier)
      assert.equal('ok' in first && first.ok, false)
      assert.equal(store.snapshotOf(jobId)?.callbackEpoch, 2)

      // Stale token cannot bump or mutate state
      const staleResult = store.releaseNotifyClaimWithEpochBump(jobId, 'wrong-token')
      assert.equal(staleResult, 'stale')
      assert.equal(store.snapshotOf(jobId)?.callbackEpoch, 2)

      now += nextNotifyBackoffMs(0)
      const second = await retryPendingNotifies(store, notifier, {}, { dueOnly: true })
      assert.equal(second.delivered, 1)
      assert.deepEqual(receivedIds, [
        delegateCallbackMessageId(jobId, 1),
        delegateCallbackMessageId(jobId, 2),
      ])

      // Already-delivered job cannot be bumped
      const afterDelivered = store.bumpCallbackEpochForRetry(jobId)
      assert.equal(afterDelivered, 'stale')
      assert.equal(store.snapshotOf(jobId)?.callbackState, 'delivered')
      assert.equal(store.snapshotOf(jobId)?.callbackEpoch, 2)
      store.close()
    } finally {
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
