/**
 * OCV5-22 R0/R1 EngineNotifier + JobTerminal dispatch.
 * No real grok / engine processes; ports are test doubles.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/engineNotifier.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  classifyNotifyLane,
  delegateCallbackMessageId,
  delegateNotifyId,
  type JobTerminal,
} from '@openclaude/protocol'
import { decideSendToAgentIntentRecovery } from '../delegateCallbackOwner.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore, nextNotifyBackoffMs } from '../delegateJobs.js'
import {
  delayUntilNextNotifyRetry,
  dispatchJobTerminalNotify,
  retryPendingNotifies,
} from '../delegateNotifyDispatch.js'
import { DefaultEngineNotifier, tryWriteInlinePush } from '../engineNotifier.js'
import {
  buildJobTerminalFromSnapshot,
  formatJobTerminalMarkdown,
  injectPayloadFromJobTerminal,
  isJobTerminalFailure,
} from '../jobTerminal.js'
import { parseOriginWebchatSessionKey } from '../cronOriginSession.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
} from '../sendToAgentIntentStore.js'
import {
  isDelegateNotifierEffective,
  isDelegateDurableEffective,
} from '../delegateSmFlag.js'

function terminalEvent(over: Partial<JobTerminal> = {}): JobTerminal {
  return {
    jobId: 'dlgjob-n1',
    state: 'completed',
    parentSessionKey: 'agent:main:webchat:dm:p1',
    parentEngine: 'ccb',
    callback: 'origin-inject',
    callbackEpoch: 1,
    parallelPolicy: 'all',
    agentId: 'coding-assistant',
    goal: 'do the thing',
    resultRef: '子任务完成',
    ...over,
  }
}

function openStore(dir: string, opts: { bootId?: string } = {}) {
  const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
  return new DelegateJobStore({
    sm: true,
    ttlMs: 60_000,
    leaseMs: 1_000,
    durable,
    bootId: opts.bootId ?? 'gw:n0',
  })
}

async function seededTerminal(
  store: DelegateJobStore,
  meta: { parentEngine?: string; callback?: 'origin-inject' | 'stdout-wait' | 'cron-origin-inject' | 'none' } = {},
) {
  const created = store.create('coding-assistant', {
    queued: true,
    parentSessionKey: 'agent:main:webchat:dm:p1',
    callback: meta.callback ?? 'origin-inject',
    parentEngine: meta.parentEngine,
  })
  assert.ok('jobId' in created)
  const claimed = store.claimQueued(created.jobId)
  assert.equal(claimed.ok, true)
  if (!claimed.ok) throw new Error('claim failed')
  assert.equal(
    store.complete(created.jobId, { httpStatus: 200, body: { output: 'UNIQUE_OUTPUT' } }, claimed),
    true,
  )
  const snap = store.snapshotOf(created.jobId)
  assert.ok(snap)
  return { jobId: created.jobId, fence: claimed, snap }
}

describe('OC_DELEGATE_NOTIFIER flag', () => {
  it('defaults off and requires SM && DURABLE && NOTIFIER', () => {
    assert.equal(isDelegateNotifierEffective({}), false)
    assert.equal(isDelegateNotifierEffective({ OC_DELEGATE_NOTIFIER: '1' }), false)
    assert.equal(
      isDelegateNotifierEffective({ OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1' }),
      false,
    )
    assert.equal(
      isDelegateNotifierEffective({
        OC_DELEGATE_SM: '1',
        OC_DELEGATE_DURABLE: '1',
        OC_DELEGATE_NOTIFIER: '1',
      }),
      true,
    )
    assert.equal(isDelegateDurableEffective({ OC_DELEGATE_SM: '0', OC_DELEGATE_DURABLE: '1' }), false)
  })
})

describe('档 A InlinePush', () => {
  it('writes stdin and records notifyId; second call is a no-op', async () => {
    const writes: string[] = []
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: async (event) => {
          writes.push(event.jobId)
          return { ok: true, processAlive: true }
        },
      },
      resumeInject: {
        inject: async () => {
          throw new Error('must not resume-inject on A success')
        },
      },
    })
    const first = await notifier.notify(terminalEvent())
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.lane, 'inline-push')
    assert.equal(first.notifyId, delegateNotifyId('dlgjob-n1', 1))
    assert.equal(delegateCallbackMessageId('dlgjob-n1', 1), 'dlgcb.dlgjob-n1.1')
    const second = await notifier.notify(terminalEvent())
    assert.equal(second.ok, true)
    assert.deepEqual(writes, ['dlgjob-n1'])
  })

  it('degrades to ResumeInject on stdin failure and keeps the same notifyId', async () => {
    const resumes: string[] = []
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: async () => ({ ok: false, processAlive: false }),
      },
      resumeInject: {
        inject: async (event) => {
          resumes.push(delegateNotifyId(event.jobId, event.callbackEpoch))
          return { ok: true }
        },
      },
    })
    const result = await notifier.notify(terminalEvent({ parentEngine: 'codex' }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.lane, 'resume-inject')
    assert.equal(result.notifyId, 'dlgnfy.dlgjob-n1.1')
    assert.deepEqual(resumes, ['dlgnfy.dlgjob-n1.1'])
  })

  // Test double only: production CcbAdapter/CodexAdapter hide proc/writeRaw
  // on private inner runners (R3). This duck-type is not a live InlinePush port.
  it('tryWriteInlinePush writes a CCB user JSONL line when stdin is writable', async () => {
    const chunks: string[] = []
    const session = {
      runner: {
        engineId: 'ccb',
        proc: {
          stdin: {
            writable: true,
            write(chunk: string, cb?: (err?: Error | null) => void) {
              chunks.push(chunk)
              cb?.(null)
              return true
            },
          },
        },
      },
    }
    const event = terminalEvent()
    const result = await tryWriteInlinePush(session, event, formatJobTerminalMarkdown(event))
    assert.equal(result.ok, true)
    assert.equal(chunks.length, 1)
    const parsed = JSON.parse(chunks[0]!.trim()) as { type: string; message: { content: string } }
    assert.equal(parsed.type, 'user')
    assert.match(parsed.message.content, /<delegate-terminal jobId=dlgjob-n1/)
  })

  it('tryWriteInlinePush degrades when the parent turn is in flight', async () => {
    const session = {
      _activeTurnCount: 1,
      runner: {
        engineId: 'ccb',
        proc: { stdin: { writable: true, write: () => true } },
      },
    }
    const result = await tryWriteInlinePush(session, terminalEvent(), 'x')
    assert.equal(result.ok, false)
    assert.equal(result.processAlive, true)
  })
})

describe('档 B ResumeInject', () => {
  it('delivers cursor/grok/zcode via resume-inject only', async () => {
    for (const engine of ['cursor', 'grok', 'zcode'] as const) {
      assert.equal(classifyNotifyLane(engine), 'resume-inject')
      let injected = 0
      const notifier = new DefaultEngineNotifier({
        inlinePush: {
          write: async () => {
            throw new Error('档 B must not touch stdin')
          },
        },
        resumeInject: {
          inject: async () => {
            injected += 1
            return { ok: true }
          },
        },
      })
      const result = await notifier.notify(terminalEvent({ parentEngine: engine }))
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.lane, 'resume-inject')
      assert.equal(injected, 1)
    }
  })
})

describe('JobTerminal dispatch + durable columns', () => {
  it('档 A success writes notify_lane/notify_id and marks delivered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-a-'))
    try {
      const store = openStore(dir)
      const { snap } = await seededTerminal(store, { parentEngine: 'ccb' })
      const notifier = new DefaultEngineNotifier({
        inlinePush: { write: async () => ({ ok: true, processAlive: true }) },
        resumeInject: { inject: async () => ({ ok: true }) },
      })
      const result = await dispatchJobTerminalNotify(store, snap, notifier)
      assert.equal('ok' in result && result.ok, true)
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.notifyLane, 'inline-push')
      assert.equal(after.notifyId, delegateNotifyId(snap.id, 1))
      assert.equal(after.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delivery failure does not roll back the job terminal state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-fail-'))
    try {
      const store = openStore(dir)
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor' })
      const notifier = new DefaultEngineNotifier({
        resumeInject: { inject: async () => ({ ok: false, failureClass: 'transport' }) },
      })
      const result = await dispatchJobTerminalNotify(store, snap, notifier)
      assert.equal('ok' in result && result.ok, false)
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'pending')
      assert.equal(after.notifyId, delegateNotifyId(snap.id, 1))
      assert.equal(after.result?.body.output, 'UNIQUE_OUTPUT')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retries pending notify after crash/reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-retry-'))
    try {
      const s1 = openStore(dir, { bootId: 'gw:g0' })
      const { snap } = await seededTerminal(s1, { parentEngine: 'cursor' })
      const failing = new DefaultEngineNotifier({
        resumeInject: { inject: async () => ({ ok: false, failureClass: 'transport' }) },
      })
      await dispatchJobTerminalNotify(s1, snap, failing)
      const mid = s1.snapshotOf(snap.id)!
      assert.equal(mid.state, 'completed')
      assert.equal(mid.callbackState, 'pending')
      s1.close()

      let injected = 0
      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const recovering = new DefaultEngineNotifier({
        resumeInject: {
          inject: async (event) => {
            injected += 1
            assert.equal(delegateNotifyId(event.jobId, event.callbackEpoch), mid.notifyId)
            return { ok: true }
          },
        },
      })
      const summary = await retryPendingNotifies(s2, recovering)
      assert.equal(summary.scanned, 1)
      assert.equal(summary.delivered, 1)
      assert.equal(injected, 1)
      const after = s2.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'delivered')
      assert.equal(after.notifyLane, 'resume-inject')
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flag-off leaves notify columns unset (bypass equivalent)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-off-'))
    try {
      const store = openStore(dir)
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor' })
      assert.equal(snap.notifyId, undefined)
      assert.equal(snap.notifyLane, undefined)
      assert.equal(snap.callbackState, 'pending')
      assert.equal(store.listPendingNotify().length, 1)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lost fence CAS does not overwrite a new owner notify row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-fence-'))
    try {
      const store = openStore(dir)
      const { snap, fence } = await seededTerminal(store, { parentEngine: 'cursor' })
      assert.equal(
        store.patchNotifyIntent(
          snap.id,
          { notifyLane: 'resume-inject', notifyId: 'dlgnfy.x.1', parentEngine: 'cursor' },
          fence,
        ),
        true,
      )
      assert.equal(
        store.patchNotifyIntent(
          snap.id,
          { notifyLane: 'inline-push', notifyId: 'dlgnfy.stolen.1' },
          { claimToken: 'deadbeef', fencingEpoch: fence.fencingEpoch },
        ),
        false,
      )
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.notifyId, 'dlgnfy.x.1')
      assert.equal(after.notifyLane, 'resume-inject')
      assert.equal(after.state, 'completed')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stdout-wait is a no-op lane and does not change callback_state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-wait-'))
    try {
      const store = openStore(dir)
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor', callback: 'stdout-wait' })
      const notifier = new DefaultEngineNotifier({
        resumeInject: {
          inject: async () => {
            throw new Error('stdout-wait must not resume-inject')
          },
        },
      })
      const result = await dispatchJobTerminalNotify(store, snap, notifier)
      assert.equal('ok' in result && result.ok, true)
      if (!('ok' in result) || !result.ok) return
      assert.equal(result.lane, 'stdout-wait')
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'none')
      assert.equal(after.notifyLane, 'stdout-wait')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('review blockers: claim / retry / origin / outcome', () => {
  it('online failure schedules retry without waiting for restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-sched-'))
    try {
      let now = 1_700_000_000_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable,
        bootId: 'gw:sched',
        now: () => now,
      })
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor' })
      const failing = new DefaultEngineNotifier({
        resumeInject: { inject: async () => ({ ok: false, failureClass: 'transport' }) },
      })
      await dispatchJobTerminalNotify(store, snap, failing)
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'pending')
      assert.ok((after.notifyRetryAt ?? 0) > now)
      assert.equal(store.listDueNotify(now).length, 0)
      assert.equal(delayUntilNextNotifyRetry(store, now), nextNotifyBackoffMs(0))
      now = after.notifyRetryAt!
      assert.equal(store.listDueNotify(now).length, 1)
      let injected = 0
      const recovering = new DefaultEngineNotifier({
        resumeInject: {
          inject: async () => {
            injected += 1
            return { ok: true }
          },
        },
      })
      const summary = await retryPendingNotifies(store, recovering, {}, { dueOnly: true })
      assert.equal(summary.delivered, 1)
      assert.equal(injected, 1)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('TTL sweep keeps pending callbacks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-sweep-'))
    try {
      let now = 1_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 100,
        leaseMs: 1_000,
        durable,
        bootId: 'gw:sweep',
        now: () => now,
      })
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor' })
      now = (store.snapshotOf(snap.id)?.expiresAt ?? now) + 1
      assert.equal(store.sweep(now), 0)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'pending')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('notifier throw releases the exclusive claim so a retry can proceed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-throw-'))
    try {
      const store = openStore(dir)
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor' })
      await assert.rejects(
        dispatchJobTerminalNotify(
          store,
          snap,
          { notify: async () => { throw new Error('boom') } },
        ),
        /boom/,
      )
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'pending')
      let injected = 0
      const result = await dispatchJobTerminalNotify(
        store,
        after,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async () => {
              injected += 1
              return { ok: true }
            },
          },
        }),
      )
      assert.equal('ok' in result && result.ok, true)
      assert.equal(injected, 1)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('two stores on one sqlite file consume a pending notify once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-dual-'))
    try {
      const path = join(dir, 'delegate-jobs.db')
      const d1 = new DelegateDurableDb(path)
      const s1 = new DelegateJobStore({ sm: true, ttlMs: 60_000, leaseMs: 1_000, durable: d1, bootId: 'gw:a' })
      const { snap } = await seededTerminal(s1, { parentEngine: 'cursor' })
      const d2 = new DelegateDurableDb(path)
      const s2 = new DelegateJobStore({ sm: true, ttlMs: 60_000, leaseMs: 1_000, durable: d2, bootId: 'gw:b' })
      const snap2 = s2.snapshotOf(snap.id)
      assert.ok(snap2)
      let consumerCalls = 0
      const makeNotifier = () =>
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async () => {
              consumerCalls += 1
              await new Promise((resolve) => setTimeout(resolve, 40))
              return { ok: true }
            },
          },
        })
      const [left, right] = await Promise.all([
        dispatchJobTerminalNotify(s1, snap, makeNotifier()),
        dispatchJobTerminalNotify(s2, snap2, makeNotifier()),
      ])
      const skipped = [left, right].filter((r) => 'skipped' in r && r.skipped)
      const delivered = [left, right].filter((r) => 'ok' in r && r.ok)
      assert.equal(consumerCalls, 1)
      assert.equal(skipped.length, 1)
      assert.equal(delivered.length, 1)
      assert.equal(s1.snapshotOf(snap.id)?.callbackState, 'delivered')
      assert.equal(s2.snapshotOf(snap.id)?.callbackState, 'delivered')
      s1.close()
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delivered + leftover shadow does not call a second consumer on recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-shadow-'))
    const intentDir = await mkdtemp(join(tmpdir(), 'oc-nfy-intent-'))
    try {
      const s1 = openStore(dir)
      const { snap } = await seededTerminal(s1, { parentEngine: 'cursor' })
      const env = { OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: intentDir } as NodeJS.ProcessEnv
      await persistSendToAgentIntent({
        v: 1,
        jobId: snap.id,
        originSessionKey: 'agent:main:webchat:dm:p1',
        agentId: 'coding-assistant',
        goal: 'do the thing',
        createdAt: 1,
      }, env)
      const first = new DefaultEngineNotifier({
        resumeInject: { inject: async () => ({ ok: true }) },
      })
      let shadows = 0
      await dispatchJobTerminalNotify(s1, snap, first, {
        onDelivered: async () => {
          shadows += 1
        },
      })
      assert.equal(s1.snapshotOf(snap.id)?.callbackState, 'delivered')
      s1.close()

      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const delivered = s2.snapshotOf(snap.id)!
      assert.equal(delivered.callbackState, 'delivered')
      assert.deepEqual(
        decideSendToAgentIntentRecovery({
          callbackOwner: 'job',
          job: { jobId: delivered.id, state: delivered.state, callbackState: delivered.callbackState },
        }),
        { action: 'ack_delivered' },
      )
      let secondConsumerCalls = 0
      const summary = await recoverInterruptedSendToAgentIntents(
        async () => true,
        env,
        {
          callbackOwner: 'job',
          resolveJob: (id) => s2.snapshotOf(id),
          ensureCallback: async () => {
            secondConsumerCalls += 1
            return true
          },
        },
      )
      assert.equal(secondConsumerCalls, 0)
      assert.equal(summary.skippedShadow, 1)
      const names = await readdir(intentDir)
      assert.deepEqual(names, [])
      assert.equal(shadows, 1)
      const again = new DefaultEngineNotifier({
        resumeInject: {
          inject: async () => {
            secondConsumerCalls += 1
            return { ok: true }
          },
        },
      })
      const result = await dispatchJobTerminalNotify(s2, delivered, again)
      assert.equal('ok' in result && result.ok, true)
      assert.equal(secondConsumerCalls, 0)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(intentDir, { recursive: true, force: true })
    }
  })

  it('nested send_to_agent persists webchat origin, not the direct delegate parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-origin-'))
    try {
      const store = openStore(dir)
      const parentKey = 'agent:explorer:delegate:main:123:deadbeef'
      const originKey = 'agent:main:webchat:dm:p1'
      assert.equal(parseOriginWebchatSessionKey(parentKey), null)
      assert.ok(parseOriginWebchatSessionKey(originKey))
      const created = store.create('coding-assistant', {
        queued: true,
        parentSessionKey: parentKey,
        callback: 'origin-inject',
        parentEngine: 'cursor',
        callbackOriginSessionKey: originKey,
        callbackOriginUserId: '3',
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      assert.equal(
        store.complete(created.jobId, { httpStatus: 200, body: { output: 'nested-ok' } }, claimed),
        true,
      )
      const snap = store.snapshotOf(created.jobId)!
      assert.equal(snap.parentSessionKey, parentKey)
      assert.equal(snap.callbackOriginSessionKey, originKey)
      const event = buildJobTerminalFromSnapshot(snap, { parentEngine: 'cursor' })
      assert.equal(event?.parentSessionKey, originKey)
      let injectedParent: string | undefined
      const notifier = new DefaultEngineNotifier({
        resumeInject: {
          inject: async (ev) => {
            injectedParent = ev.parentSessionKey
            return { ok: true }
          },
        },
      })
      const result = await dispatchJobTerminalNotify(store, snap, notifier)
      assert.equal('ok' in result && result.ok, true)
      assert.equal(injectedParent, originKey)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('{ok:false,error} is rendered as a failure, not 子任务已完成', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-failbody-'))
    try {
      const store = openStore(dir)
      const created = store.create('coding-assistant', {
        queued: true,
        parentSessionKey: 'agent:main:webchat:dm:p1',
        callback: 'origin-inject',
        parentEngine: 'cursor',
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      assert.equal(
        store.complete(
          created.jobId,
          { httpStatus: 200, body: { ok: false, output: '', error: 'child exploded' } },
          claimed,
        ),
        true,
      )
      const snap = store.snapshotOf(created.jobId)!
      assert.equal(snap.state, 'completed')
      assert.equal(snap.failureClass, 'child_error')
      const event = buildJobTerminalFromSnapshot(snap, { parentEngine: 'cursor' })
      assert.ok(event)
      assert.equal(event.state, 'completed')
      assert.equal(event.resultOk, false)
      assert.equal(isJobTerminalFailure(event), true)
      const md = formatJobTerminalMarkdown(event)
      assert.match(md, /子任务失败/)
      assert.doesNotMatch(md, /子任务已完成/)
      assert.match(md, /child exploded/)
      const payload = injectPayloadFromJobTerminal(event)
      assert.equal(payload.output, undefined)
      assert.equal(payload.error, 'child exploded')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('nested origin survives crash/reopen from the durable job row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-origin-boot-'))
    try {
      const parentKey = 'agent:explorer:delegate:main:123:deadbeef'
      const originKey = 'agent:main:webchat:dm:p1'
      const s1 = openStore(dir)
      const created = s1.create('coding-assistant', {
        queued: true,
        parentSessionKey: parentKey,
        callback: 'origin-inject',
        parentEngine: 'cursor',
        callbackOriginSessionKey: originKey,
      })
      assert.ok('jobId' in created)
      const claimed = s1.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      assert.equal(
        s1.complete(created.jobId, { httpStatus: 200, body: { output: 'nested-ok' } }, claimed),
        true,
      )
      s1.close()

      const s2 = openStore(dir, { bootId: 'gw:g1' })
      const snap = s2.snapshotOf(created.jobId)!
      assert.equal(snap.parentSessionKey, parentKey)
      assert.equal(snap.callbackOriginSessionKey, originKey)
      let injectedParent: string | undefined
      const result = await dispatchJobTerminalNotify(
        s2,
        snap,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async (ev) => {
              injectedParent = ev.parentSessionKey
              return { ok: true }
            },
          },
        }),
      )
      assert.equal('ok' in result && result.ok, true)
      assert.equal(injectedParent, originKey)
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('nested origin flag-off recovery injects the webchat intent, not the delegate parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-origin-flagoff-'))
    const intentDir = await mkdtemp(join(tmpdir(), 'oc-nfy-origin-intent-'))
    try {
      const parentKey = 'agent:explorer:delegate:main:123:deadbeef'
      const originKey = 'agent:main:webchat:dm:p1'
      const store = openStore(dir)
      const created = store.create('coding-assistant', {
        queued: true,
        parentSessionKey: parentKey,
        callback: 'origin-inject',
        parentEngine: 'cursor',
        callbackOriginSessionKey: originKey,
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      assert.equal(
        store.complete(created.jobId, { httpStatus: 200, body: { output: 'nested-ok' } }, claimed),
        true,
      )
      const env = { OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: intentDir } as NodeJS.ProcessEnv
      await persistSendToAgentIntent({
        v: 1,
        jobId: created.jobId,
        originSessionKey: originKey,
        agentId: 'coding-assistant',
        goal: 'nested',
        createdAt: 1,
      }, env)
      const seen: string[] = []
      const summary = await recoverInterruptedSendToAgentIntents(
        async () => {
          throw new Error('legacy interrupt must not run')
        },
        env,
        {
          callbackOwner: 'job',
          resolveJob: (id) => store.snapshotOf(id),
          ensureCallback: async (_job, intent) => {
            seen.push(intent.originSessionKey)
            return true
          },
        },
      )
      assert.deepEqual(seen, [originKey])
      assert.equal(summary.skippedShadow, 1)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(intentDir, { recursive: true, force: true })
    }
  })

  it('notify latency is measured from terminal commit, not notify() start', async () => {
    const committed = 1_700_000_000_000
    const samples: number[] = []
    const notifier = new DefaultEngineNotifier({
      now: () => committed + 25,
      onSample: (sample) => samples.push(sample.latencyMs),
      resumeInject: { inject: async () => ({ ok: true }) },
    })
    await notifier.notify(
      terminalEvent({
        parentEngine: 'cursor',
        terminalCommittedAt: committed,
      }),
    )
    assert.deepEqual(samples, [25])
  })
})
