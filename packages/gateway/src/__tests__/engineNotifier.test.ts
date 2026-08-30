/**
 * OCV5-22 R0/R1 EngineNotifier + JobTerminal dispatch.
 * No real grok / engine processes; ports are test doubles.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/engineNotifier.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  classifyNotifyLane,
  delegateCallbackMessageId,
  delegateNotifyId,
  type JobTerminal,
} from '@openclaude/protocol'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import {
  dispatchJobTerminalNotify,
  retryPendingNotifies,
} from '../delegateNotifyDispatch.js'
import { DefaultEngineNotifier, tryWriteInlinePush } from '../engineNotifier.js'
import { formatJobTerminalMarkdown } from '../jobTerminal.js'
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
