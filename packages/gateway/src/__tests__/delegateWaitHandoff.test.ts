import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DelegateJobStore } from '../delegateJobs.js'
import { DELEGATE_CONTEXT_HEADER, issueDelegateContextToken } from '../delegateContext.js'
import { handoffDelegateWait } from '../delegateWaitHandoff.js'
import { handleDelegateWait } from '../delegateRuntime.js'
import { _ensureDurableSendToAgentCallback, _queueSendToAgentCallback } from '../delegateCallbacks.js'
import { persistSendToAgentIntent } from '../sendToAgentIntentStore.js'
import { DefaultEngineNotifier } from '../engineNotifier.js'
import { isDelegateNotifierEffective } from '../delegateSmFlag.js'
import { delegateCallbackMessageId } from '../delegateCompleter.js'
import { _armNotifyRetryScheduler } from '../gatewayLifecycle.js'

const PARENT = 'agent:main:webchat:dm:handoff-test'

function fixture() {
  const calls: Array<Record<string, unknown>> = []
  const store = new DelegateJobStore({ ttlMs: 60_000, sleep: async () => {} })
  const notifier = new DefaultEngineNotifier({
    resumeInject: { inject: async (event) => { calls.push({ event }); return { ok: true } } },
  })
  const host: any = {
    _delegateJobs: store,
    _delegateReconcileReady: true,
    _activeSendToAgentCallbacks: new Map(),
    _persistSendToAgentIntent: persistSendToAgentIntent,
    _resolveDelegateParentEngine: () => 'grok',
    _ensureDelegateJobStore: () => store,
    _ensureEngineNotifier: () => notifier,
    _armNotifyRetryScheduler: () => {},
    _drainFlagOffCronOriginNotifies: async () => {},
    sessions: { getByKey: () => ({ userId: 'u1' }) },
    log: { warn() {}, info() {}, debug() {}, error() {} },
    injectSendToAgentCallback: async (args: Record<string, unknown>) => { calls.push(args); return { kind: 'injected' } },
  }
  host._ensureDurableSendToAgentCallback = _ensureDurableSendToAgentCallback.bind(host)
  sandbox.trackGateway(host)
  const create = (parent = PARENT) => {
    const job = store.create('coding-assistant', { parentSessionKey: parent, callback: 'stdout-wait' })
    assert.ok('jobId' in job)
    return job.jobId
  }
  const request = (sessionKey = PARENT, agentId = 'main') => ({
    headers: { [DELEGATE_CONTEXT_HEADER]: issueDelegateContextToken({ sessionKey, agentId, depth: 0 }) },
  }) as any
  const intent = (jobId: string) => ({ v: 1 as const, jobId, originSessionKey: PARENT, userId: 'u1', agentId: 'coding-assistant', goal: 'task', createdAt: 1 })
  const complete = (jobId: string, failed = false) => {
    const owner = store.snapshotOf(jobId)!
    if (failed) assert.equal(store.fail(jobId, {
      failureClass: 'child_error', detail: 'child failed', httpStatus: 500,
      claimToken: owner.claimToken, fencingEpoch: owner.fencingEpoch,
    }), true)
    else assert.equal(store.complete(jobId, { httpStatus: 200, body: { output: 'final output' } }), true)
    const snap = store.snapshotOf(jobId)!
    if (isDelegateNotifierEffective()) void host._ensureDurableSendToAgentCallback(snap, intent(jobId))
    _queueSendToAgentCallback.call(host, { parentSessionKey: PARENT } as any, { jobId, agentId: 'coding-assistant', goal: 'task' })
  }
  return { host, store, calls, create, request, complete, intent }
}

async function settled(store: DelegateJobStore, jobId: string) {
  for (let i = 0; i < 500 && store.snapshotOf(jobId)?.callbackState !== 'delivered'; i++) await delay(10)
  assert.equal(store.snapshotOf(jobId)?.callbackState, 'delivered')
  // Callback cleanup removes a shadow asynchronously after the state CAS.
  await delay(2)
}

async function waitRoute(f: ReturnType<typeof fixture>, jobId: string, opts: { handoff?: boolean; destroyed?: boolean; request?: any } = {}) {
  let result: any
  f.host.readBody = async () => JSON.stringify({ jobId, waitMs: 250, ...(opts.handoff ? { handoffOnRunning: true, goal: 'task' } : {}) })
  f.host.sendJson = (_res: unknown, status: number, body: unknown) => { result = { status, body } }
  f.host.sendError = (_res: unknown, status: number, error: string) => { result = { status, body: { error } } }
  await handleDelegateWait.call(f.host, { ...opts.request ?? f.request(), method: 'POST' }, { destroyed: opts.destroyed } as any)
  return result
}

describe('MCP deadline handoff', () => {
  for (const notifier of [false, true]) {
    for (const failed of [false, true]) {
      it(`delivers one ${failed ? 'failure' : 'success'} callback with notifier ${notifier ? 'on' : 'off'}`, async () => {
        if (notifier) Object.assign(process.env, { OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1', OC_DELEGATE_NOTIFIER: '1' })
        const f = fixture()
        const id = f.create()
        const sibling = f.create()
        const response = await waitRoute(f, id, { handoff: true })
        assert.equal(response.body.status, 'deferred')
        assert.equal(f.store.snapshotOf(sibling)?.callback, 'stdout-wait')
        assert.equal(f.store.snapshotOf(id)?.state, 'running')
        f.complete(id, failed)
        await settled(f.store, id)
        assert.equal(f.calls.length, 1)
        assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), true)
        assert.equal(f.calls.length, 1)
        assert.equal(f.store.snapshotOf(id)?.callbackEpoch, 1)
        if (!notifier) {
          assert.equal(f.calls[0].clientMessageId, delegateCallbackMessageId(id, 1))
          assert.equal(f.calls[0][failed ? 'error' : 'output'], failed ? 'child failed' : 'final output')
        }
      })
    }
  }

  it('terminal before handoff returns stdout once and cannot be adopted', async () => {
    const f = fixture()
    const id = f.create()
    f.store.complete(id, { httpStatus: 200, body: { output: 'already done' } })
    const response = await waitRoute(f, id, { handoff: true })
    assert.equal(response.body.status, 'done')
    assert.equal(f.store.snapshotOf(id)?.callbackState, 'skipped_silent')
    assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), false)
    assert.equal(f.calls.length, 0)
  })

  for (const failed of [false, true]) {
    it(`catches ${failed ? 'failure' : 'success'} completed while persisting the handoff`, async () => {
      const f = fixture()
      const id = f.create()
      f.host._persistSendToAgentIntent = async (intent: any) => {
        await persistSendToAgentIntent(intent)
        f.complete(id, failed)
      }
      assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), true)
      await settled(f.store, id)
      assert.equal(f.calls.length, 1)
    })
  }

  it('callback completion and terminal catch-up compete for one claim, including intent owner', async () => {
    process.env.OC_DELEGATE_CALLBACK_OWNER = 'intent'
    const f = fixture()
    const id = f.create()
    assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), true)
    f.complete(id)
    await Promise.all([
      f.host._ensureDurableSendToAgentCallback(f.store.snapshotOf(id), f.intent(id)),
      f.host._ensureDurableSendToAgentCallback(f.store.snapshotOf(id), f.intent(id)),
    ])
    await settled(f.store, id)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].clientMessageId, delegateCallbackMessageId(id, 1))
  })

  it('concurrent handoff requests retain the same durable intent and notify epoch', async () => {
    const f = fixture()
    const id = f.create()
    assert.deepEqual(await Promise.all([
      handoffDelegateWait(f.host, f.request(), id, 'task'),
      handoffDelegateWait(f.host, f.request(), id, 'task'),
    ]), [true, true])
    const persisted = JSON.parse(await readFile(join(process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR!, `${id}.json`), 'utf8'))
    assert.equal(persisted.jobId, id)
    f.complete(id)
    await settled(f.store, id)
    assert.equal(f.calls.length, 1)
  })

  it('a disconnected old waiter cannot consume a callback-owned result', async () => {
    const f = fixture()
    const id = f.create()
    f.store.complete(id, { httpStatus: 200, body: { output: 'done' } })
    assert.equal(await waitRoute(f, id, { destroyed: true }), undefined)
    assert.equal(f.store.snapshotOf(id)?.callbackState, 'none')
    assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), true)
    await settled(f.store, id)
    const late = await waitRoute(f, id)
    assert.equal(late.body.status, 'deferred')
    assert.equal(f.calls.length, 1)
  })

  it('missing/foreign identity, non-webchat parent and unready recovery cannot take ownership', async () => {
    const f = fixture()
    const id = f.create()
    for (const request of [
      { headers: {} },
      f.request('agent:main:webchat:dm:other'),
      f.request(PARENT, 'other-agent'),
    ]) assert.equal(await handoffDelegateWait(f.host, request as any, id, 'task'), false)
    const nonWeb = 'agent:main:telegram:dm:peer'
    assert.equal(await handoffDelegateWait(f.host, f.request(nonWeb), f.create(nonWeb), 'task'), false)
    f.host._delegateReconcileReady = false
    assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), false)
    assert.equal(f.store.snapshotOf(id)?.callback, 'stdout-wait')
  })

  it('persistence failure leaves a live job and returns no fake deferred status', async () => {
    const f = fixture()
    const id = f.create()
    f.host._persistSendToAgentIntent = async () => { throw new Error('disk unavailable') }
    const response = await waitRoute(f, id, { handoff: true })
    assert.equal(response.body.status, 'running')
    assert.equal(f.store.snapshotOf(id)?.state, 'running')
    assert.equal(f.store.snapshotOf(id)?.callback, 'stdout-wait')
    assert.equal(f.calls.length, 0)
  })

  for (const failure of ['ORIGIN_SESSION_BUSY', 'NO_TRANSPORT']) {
    it(`retries after exhausted ${failure} delivery through the existing timer with all flags off`, async () => {
      const f = fixture()
      const id = f.create()
      let attempts = 0
      let delivered = 0
      f.host._armNotifyRetryScheduler = _armNotifyRetryScheduler.bind(f.host)
      f.host.injectSendToAgentCallback = async () => {
        if (++attempts === 1) return { kind: 'retryable_failure', code: failure }
        delivered++
        return { kind: 'injected' }
      }
      assert.equal(await handoffDelegateWait(f.host, f.request(), id, 'task'), true)
      f.complete(id)
      await delay(10)
      assert.equal(f.store.snapshotOf(id)?.callbackState, 'pending')
      assert.ok(f.host._notifyRetryTimer)
      await settled(f.store, id)
      assert.equal(attempts, 2)
      assert.equal(delivered, 1)
      assert.equal(f.host._notifyRetryTimer, undefined)
    })
  }
})
