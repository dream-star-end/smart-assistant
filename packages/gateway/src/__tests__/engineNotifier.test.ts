/**
 * OCV5-22 R0/R1 EngineNotifier + JobTerminal dispatch.
 * No real grok / engine processes; ports are test doubles.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/engineNotifier.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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
import { cutoverFreezeHolder } from '../delegateCutover.js'
import { DelegateJobStore, nextNotifyBackoffMs, NOTIFY_CLAIM_LEASE_MS } from '../delegateJobs.js'
import { SubprocessRunner } from '../subprocessRunner.js'
import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import {
  delayUntilNextNotifyRetry,
  dispatchJobTerminalNotify,
  retryPendingNotifies,
} from '../delegateNotifyDispatch.js'
import {
  DefaultEngineNotifier,
  buildCcbInlinePushUserLine,
  buildCodexDelegateTerminalNotification,
  notifyClaimFenceOf,
  tryWriteInlinePush,
  writeInlinePushForSession,
} from '../engineNotifier.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { CodexAdapter } from '../engine/codexAdapter.js'
import {
  buildJobTerminalFromSnapshot,
  formatJobTerminalMarkdown,
  injectPayloadFromJobTerminal,
  isJobTerminalFailure,
} from '../jobTerminal.js'
import {
  buildCronContinuationEnvelope,
  buildCronOriginResumeText,
  cronOriginClientMessageId,
  cronOriginIdempotencyKey,
  CRON_CALLBACK_LEGACY_LANE,
  decideCronOriginDispatchAfterPersist,
  isCronOriginInjectAcked,
  parseOriginWebchatSessionKey,
  resolveCronOriginInjectPayload,
} from '../cronOriginSession.js'
import { enqueueCronOccurrenceJob, settleCronDelegateJob } from '../delegateCronIdempotency.js'
import {
  persistSendToAgentIntent,
  recoverInterruptedSendToAgentIntents,
} from '../sendToAgentIntentStore.js'
import {
  isDelegateNotifierEffective,
  isDelegateDurableEffective,
  isDelegateInlinePushCcbEnabled,
  isDelegateInlinePushCodexEnabled,
  isDelegateInlinePushEnabled,
} from '../delegateSmFlag.js'
import { parentTapeHasNotifyId } from '../delegateNotifyTape.js'

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

describe('OC_DELEGATE_INLINE_PUSH_* flags', () => {
  it('defaults off; each engine is independent; cursor never enables', () => {
    assert.equal(isDelegateInlinePushCcbEnabled({}), false)
    assert.equal(isDelegateInlinePushCodexEnabled({}), false)
    assert.equal(isDelegateInlinePushEnabled('ccb', {}), false)
    assert.equal(isDelegateInlinePushEnabled('codex', {}), false)
    assert.equal(isDelegateInlinePushEnabled('cursor', { OC_DELEGATE_INLINE_PUSH_CCB: '1' }), false)
    assert.equal(isDelegateInlinePushEnabled('ccb', { OC_DELEGATE_INLINE_PUSH_CCB: '1' }), true)
    assert.equal(isDelegateInlinePushEnabled('codex', { OC_DELEGATE_INLINE_PUSH_CCB: '1' }), false)
    assert.equal(isDelegateInlinePushEnabled('codex', { OC_DELEGATE_INLINE_PUSH_CODEX: 'true' }), true)
    assert.equal(isDelegateInlinePushEnabled('ccb', { OC_DELEGATE_INLINE_PUSH_CODEX: '1' }), false)
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

  // Flag-off path: duck-type probe, equivalent to 653ef6339. Production adapters
  // still hide proc/writeRaw; live 档 A is writeDelegateTerminal behind the flags.
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

  it('flag-off writeInlinePushForSession keeps the duck-type path', async () => {
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
    const result = await writeInlinePushForSession(session, event, formatJobTerminalMarkdown(event), {})
    assert.equal(result.ok, true)
    assert.equal(chunks.length, 1)
  })

  it('flag-on does not use duck-type stdin even when proc is writable', async () => {
    const duck: string[] = []
    const session = {
      runner: {
        engineId: 'ccb',
        isRunning: true,
        proc: {
          stdin: {
            writable: true,
            write(chunk: string, cb?: (err?: Error | null) => void) {
              duck.push(chunk)
              cb?.(null)
              return true
            },
          },
        },
      },
    }
    const result = await writeInlinePushForSession(
      session,
      terminalEvent(),
      'BODY',
      { OC_DELEGATE_INLINE_PUSH_CCB: '1' },
    )
    assert.equal(result.ok, false)
    assert.equal(result.processAlive, true)
    assert.deepEqual(duck, [])
  })

  it('CCB flag-on adapter success is lane A; second notify is not a second write', async () => {
    const writes: string[] = []
    let resumes = 0
    const session = {
      runner: {
        engineId: 'ccb',
        isRunning: true,
        writeDelegateTerminal: async (_event: JobTerminal, body: string) => {
          writes.push(body)
          return { ok: true, processAlive: true }
        },
      },
    }
    const env = { OC_DELEGATE_INLINE_PUSH_CCB: '1' }
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: (event) => writeInlinePushForSession(session, event, formatJobTerminalMarkdown(event), env),
      },
      resumeInject: {
        inject: async () => {
          resumes += 1
          throw new Error('must not resume-inject on A success')
        },
      },
    })
    const event = terminalEvent({ parentEngine: 'ccb' })
    const first = await notifier.notify(event)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.lane, 'inline-push')
    assert.equal(first.notifyId, delegateNotifyId(event.jobId, event.callbackEpoch))
    const second = await notifier.notify(event)
    assert.equal(second.ok, true)
    assert.equal(writes.length, 1)
    assert.equal(resumes, 0)
    assert.match(writes[0]!, /<delegate-terminal jobId=dlgjob-n1/)
  })

  it('CCB flag-on adapter failure degrades to B with the same notifyId and does not double-send', async () => {
    const resumes: string[] = []
    const session = {
      runner: {
        engineId: 'ccb',
        isRunning: false,
        writeDelegateTerminal: async () => ({ ok: false, processAlive: false }),
      },
    }
    const env = { OC_DELEGATE_INLINE_PUSH_CCB: '1' }
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: (event) => writeInlinePushForSession(session, event, 'BODY', env),
      },
      resumeInject: {
        inject: async (event) => {
          resumes.push(delegateNotifyId(event.jobId, event.callbackEpoch))
          return { ok: true }
        },
      },
    })
    const result = await notifier.notify(terminalEvent({ parentEngine: 'ccb' }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.lane, 'resume-inject')
    assert.equal(result.notifyId, 'dlgnfy.dlgjob-n1.1')
    assert.deepEqual(resumes, ['dlgnfy.dlgjob-n1.1'])
  })

  it('Codex flag-on writes delegate/terminal JSON-RPC and keeps notifyId', async () => {
    const lines: string[] = []
    const session = {
      runner: {
        engineId: 'codex',
        isRunning: true,
        writeDelegateTerminal: async (event: JobTerminal, body: string) => {
          lines.push(buildCodexDelegateTerminalNotification(event, body))
          return { ok: true, processAlive: true }
        },
      },
    }
    const env = { OC_DELEGATE_INLINE_PUSH_CODEX: '1' }
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: (event) => writeInlinePushForSession(session, event, 'BODY', env),
      },
      resumeInject: {
        inject: async () => {
          throw new Error('must not resume-inject on Codex A success')
        },
      },
    })
    const event = terminalEvent({ parentEngine: 'codex' })
    const result = await notifier.notify(event)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.lane, 'inline-push')
    assert.equal(result.notifyId, 'dlgnfy.dlgjob-n1.1')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0]!) as {
      jsonrpc: string
      method: string
      params: { jobId: string; notifyId: string; state: string }
    }
    assert.equal(parsed.jsonrpc, '2.0')
    assert.equal(parsed.method, 'delegate/terminal')
    assert.equal(parsed.params.jobId, 'dlgjob-n1')
    assert.equal(parsed.params.notifyId, 'dlgnfy.dlgjob-n1.1')
    assert.equal(parsed.params.state, 'completed')
  })

  it('flag quadrant: CCB on / Codex off does not share a write port', async () => {
    const ccbWrites: string[] = []
    const duck: string[] = []
    const ccbSession = {
      runner: {
        engineId: 'ccb',
        isRunning: true,
        writeDelegateTerminal: async (_e: JobTerminal, body: string) => {
          ccbWrites.push(body)
          return { ok: true, processAlive: true }
        },
      },
    }
    const codexSession = {
      runner: {
        engineId: 'codex',
        writeRaw: async (line: string) => {
          duck.push(line)
        },
      },
    }
    const env = { OC_DELEGATE_INLINE_PUSH_CCB: '1' }
    const ccb = await writeInlinePushForSession(ccbSession, terminalEvent({ parentEngine: 'ccb' }), 'CCB', env)
    const codex = await writeInlinePushForSession(
      codexSession,
      terminalEvent({ parentEngine: 'codex' }),
      'CODEX',
      env,
    )
    assert.equal(ccb.ok, true)
    assert.deepEqual(ccbWrites, ['CCB'])
    assert.equal(codex.ok, true)
    assert.equal(duck.length, 1)
    assert.match(duck[0]!, /delegate\/terminal/)
  })

  it('all flags on without a freeze window still uses lane A', async () => {
    let adapterCalls = 0
    const session = {
      runner: {
        engineId: 'ccb',
        isRunning: true,
        writeDelegateTerminal: async () => {
          adapterCalls += 1
          return { ok: true, processAlive: true }
        },
      },
    }
    const env = {
      OC_DELEGATE_SM: '1',
      OC_DELEGATE_DURABLE: '1',
      OC_DELEGATE_NOTIFIER: '1',
      OC_DELEGATE_CUTOVER: '1',
      OC_DELEGATE_INLINE_PUSH_CCB: '1',
    }
    const pushed = await writeInlinePushForSession(session, terminalEvent(), 'BODY', env)
    assert.equal(pushed.ok, true)
    assert.equal(adapterCalls, 1)
    const resumes: string[] = []
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: (event) => writeInlinePushForSession(session, event, 'BODY', env),
      },
      resumeInject: {
        inject: async (event) => {
          resumes.push(delegateNotifyId(event.jobId, event.callbackEpoch))
          return { ok: true }
        },
      },
    })
    const result = await notifier.notify(terminalEvent())
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.lane, 'inline-push')
    assert.equal(result.notifyId, 'dlgnfy.dlgjob-n1.1')
    assert.deepEqual(resumes, [])
    assert.equal(adapterCalls, 2)
  })

  it('active cutover freeze window forces degrade to B with the same notifyId', async () => {
    let adapterCalls = 0
    const session = {
      runner: {
        engineId: 'ccb',
        isRunning: true,
        writeDelegateTerminal: async () => {
          adapterCalls += 1
          return { ok: true, processAlive: true }
        },
      },
    }
    const env = {
      OC_DELEGATE_SM: '1',
      OC_DELEGATE_DURABLE: '1',
      OC_DELEGATE_NOTIFIER: '1',
      OC_DELEGATE_CUTOVER: '1',
      OC_DELEGATE_INLINE_PUSH_CCB: '1',
    }
    const runtime = { isCutoverWindowActive: () => true }
    const pushed = await writeInlinePushForSession(session, terminalEvent(), 'BODY', env, runtime)
    assert.equal(pushed.ok, false)
    assert.equal(pushed.processAlive, true)
    assert.equal(adapterCalls, 0)
    const resumes: string[] = []
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: (event) => writeInlinePushForSession(session, event, 'BODY', env, runtime),
      },
      resumeInject: {
        inject: async (event) => {
          resumes.push(delegateNotifyId(event.jobId, event.callbackEpoch))
          return { ok: true }
        },
      },
    })
    const result = await notifier.notify(terminalEvent())
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.lane, 'resume-inject')
    assert.equal(result.notifyId, 'dlgnfy.dlgjob-n1.1')
    assert.deepEqual(resumes, ['dlgnfy.dlgjob-n1.1'])
  })

  it('thawed cutover window restores lane A', async () => {
    const store = new DelegateJobStore({ sm: true, ttlMs: 60_000, leaseMs: 1_000 })
    store.freezeDispatch(cutoverFreezeHolder(7))
    assert.equal(store.hasActiveCutoverWindow(), true)
    assert.equal(store.isDispatchFrozen(), true)
    let adapterCalls = 0
    const session = {
      runner: {
        engineId: 'ccb',
        isRunning: true,
        writeDelegateTerminal: async () => {
          adapterCalls += 1
          return { ok: true, processAlive: true }
        },
      },
    }
    const env = {
      OC_DELEGATE_SM: '1',
      OC_DELEGATE_DURABLE: '1',
      OC_DELEGATE_NOTIFIER: '1',
      OC_DELEGATE_CUTOVER: '1',
      OC_DELEGATE_INLINE_PUSH_CCB: '1',
    }
    const runtime = { isCutoverWindowActive: () => store.hasActiveCutoverWindow() }
    const frozen = await writeInlinePushForSession(session, terminalEvent(), 'BODY', env, runtime)
    assert.equal(frozen.ok, false)
    assert.equal(adapterCalls, 0)
    store.thawDispatch(cutoverFreezeHolder(7))
    assert.equal(store.hasActiveCutoverWindow(), false)
    const thawed = await writeInlinePushForSession(session, terminalEvent(), 'BODY', env, runtime)
    assert.equal(thawed.ok, true)
    assert.equal(adapterCalls, 1)
    store.close()
  })

  it('buildCcbInlinePushUserLine uses structured text blocks, not a raw string', () => {
    const line = buildCcbInlinePushUserLine('hello <delegate-terminal jobId=x>')
    const parsed = JSON.parse(line.trim()) as {
      type: string
      message: { role: string; content: Array<{ type: string; text: string }> }
    }
    assert.equal(parsed.type, 'user')
    assert.equal(parsed.message.role, 'user')
    assert.equal(parsed.message.content[0]?.type, 'text')
    assert.match(parsed.message.content[0]!.text, /delegate-terminal/)
  })

  it('CcbAdapter only writes after parent submit succeeds; Codex writes delegate/terminal', async () => {
    const dummyOpts = {
      sessionKey: 'agent:main:webchat:dm:r3',
      agentId: 'main',
      agentBaseDir: '/tmp',
      config: {} as never,
    }
    class FakeCcbRunner extends EventEmitter {
      isRunning = true
      writes: string[] = []
      async submit() {
        return
      }
      async writeDelegateUserMessage(content: string) {
        this.writes.push(content)
        return { ok: true as const, processAlive: true as const }
      }
    }
    const ccbRunner = new FakeCcbRunner()
    const ccb = new CcbAdapter(dummyOpts, ccbRunner as never)
    const idle = await ccb.writeDelegateTerminal!(terminalEvent(), 'BODY')
    assert.equal(idle.ok, false)
    assert.equal(idle.processAlive, true)
    assert.deepEqual(ccbRunner.writes, [])
    const turn = ccb.submitTurn({
      input: 'parent input',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await turn.submitted
    const live = await ccb.writeDelegateTerminal!(terminalEvent(), 'BODY')
    assert.equal(live.ok, true)
    assert.deepEqual(ccbRunner.writes, ['BODY'])
    turn.end()

    class FakeCodexKernel extends EventEmitter {
      isRunning = true
      hasIngestedParentTurn = true
      lines: string[] = []
      submit() {
        return Promise.resolve()
      }
      writeDelegateTerminalNotification(line: string) {
        this.lines.push(line)
        return { ok: true as const, processAlive: true as const }
      }
    }
    const kernel = new FakeCodexKernel()
    const codex = new CodexAdapter(dummyOpts, kernel as never)
    const codexIdle = await codex.writeDelegateTerminal!(terminalEvent({ parentEngine: 'codex' }), 'BODY')
    assert.equal(codexIdle.ok, false)
    assert.equal(codexIdle.processAlive, true)
    const codexTurn = codex.submitTurn({
      input: 'parent input',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await Promise.resolve()
    const codexLive = await codex.writeDelegateTerminal!(terminalEvent({ parentEngine: 'codex' }), 'BODY')
    assert.equal(codexLive.ok, true)
    assert.equal(kernel.lines.length, 1)
    const parsed = JSON.parse(kernel.lines[0]!) as { method: string; params: { notifyId: string } }
    assert.equal(parsed.method, 'delegate/terminal')
    assert.equal(parsed.params.notifyId, 'dlgnfy.dlgjob-n1.1')
    codexTurn.end()
  })
})

describe('R3 blocker regressions', () => {
  function openStoreAt(dir: string, now: () => number, bootId: string) {
    return new DelegateJobStore({
      sm: true,
      ttlMs: 60_000,
      leaseMs: 1_000,
      durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
      bootId,
      now,
    })
  }

  it('crash window: A write stamps delivered so restart cannot fire B', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'r3-crash-window-'))
    let now = 1_000
    const clock = () => now
    let aWrites = 0
    let bWrites = 0
    try {
      const s1 = openStoreAt(dir, clock, 'gw:a')
      const seeded = await seededTerminal(s1, { parentEngine: 'ccb' })
      const n1 = new DefaultEngineNotifier({
        inlinePush: {
          write: async () => {
            aWrites += 1
            s1.injectDurableWriteFailure()
            return { ok: true, processAlive: true }
          },
        },
        resumeInject: {
          inject: async () => {
            throw new Error('lane B must not run after A write')
          },
        },
      })
      const first = await dispatchJobTerminalNotify(s1, seeded.snap, n1)
      assert.ok(!('skipped' in first) && first.ok)
      assert.equal(s1.snapshotOf(seeded.jobId)?.callbackState, 'delivered')
      s1.close()

      now += NOTIFY_CLAIM_LEASE_MS + 1
      const s2 = openStoreAt(dir, clock, 'gw:b')
      s2.hydrateFromDurable()
      const n2 = new DefaultEngineNotifier({
        inlinePush: { write: async () => ({ ok: false, processAlive: false }) },
        resumeInject: {
          inject: async () => {
            bWrites += 1
            return { ok: true }
          },
        },
      })
      const live = s2.snapshotOf(seeded.jobId)
      assert.ok(live)
      const result = await dispatchJobTerminalNotify(s2, live, n2)
      assert.ok(!('skipped' in result) && result.ok)
      assert.deepEqual(
        { aWrites, bWrites, callbackState: s2.snapshotOf(seeded.jobId)?.callbackState },
        { aWrites: 1, bWrites: 0, callbackState: 'delivered' },
      )
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('slow A vs expired claim: fence aborts A write so B is the only settle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'r3-slow-race-'))
    let now = 10_000
    const clock = () => now
    let releaseA!: () => void
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let aWrites = 0
    let bWrites = 0
    try {
      const s1 = openStoreAt(dir, clock, 'gw:a')
      const s2 = openStoreAt(dir, clock, 'gw:b')
      const seeded = await seededTerminal(s1, { parentEngine: 'ccb' })
      s2.hydrateFromDurable()
      const n1 = new DefaultEngineNotifier({
        inlinePush: {
          write: async (event) => {
            await aGate
            const fence = notifyClaimFenceOf(event)
            if (fence && !fence.isLive()) {
              return { ok: false, processAlive: true }
            }
            aWrites += 1
            return { ok: true, processAlive: true }
          },
        },
        resumeInject: {
          inject: async () => {
            throw new Error('slow A must not degrade to B after losing the claim')
          },
        },
      })
      const pA = dispatchJobTerminalNotify(s1, seeded.snap, n1)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(s1.snapshotOf(seeded.jobId)?.callbackState, 'injecting')

      now += NOTIFY_CLAIM_LEASE_MS + 1
      const n2 = new DefaultEngineNotifier({
        inlinePush: { write: async () => ({ ok: false, processAlive: false }) },
        resumeInject: {
          inject: async () => {
            bWrites += 1
            return { ok: true }
          },
        },
      })
      const live = s2.snapshotOf(seeded.jobId)
      assert.ok(live)
      const resultB = await dispatchJobTerminalNotify(s2, live, n2)
      assert.ok(!('skipped' in resultB) && resultB.ok)
      releaseA()
      const resultA = await pA
      assert.ok(!('skipped' in resultA) && resultA.ok)
      assert.deepEqual(
        { aWrites, bWrites, callbackState: s2.snapshotOf(seeded.jobId)?.callbackState },
        { aWrites: 0, bWrites: 1, callbackState: 'delivered' },
      )
      s1.close()
      s2.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('CCB death window after write callback is A failure not a false success', async () => {
    const ccb = new SubprocessRunner({ resumeSessionId: undefined } as never)
    const ccbProc: {
      killed: boolean
      exitCode: number | null
      stdin: { writable: boolean; write: (chunk: string, cb: (err?: Error | null) => void) => boolean }
    } = {
      killed: false,
      exitCode: null,
      stdin: {
        writable: true,
        write(_chunk: string, cb: (err?: Error | null) => void) {
          ccbProc.killed = true
          ccbProc.exitCode = 1
          cb(null)
          return true
        },
      },
    }
    ;(ccb as unknown as { proc: typeof ccbProc }).proc = ccbProc
    ;(ccb as unknown as { closed: boolean }).closed = false
    const ccbResult = await ccb.writeDelegateUserMessage('x')
    assert.deepEqual(ccbResult, { ok: false, processAlive: false })
  })

  it('Codex writeRaw rejects dead/backpressure and swallows async EPIPE', async () => {
    const codex = new CodexAppServerRunner({} as never)
    ;(codex as unknown as { proc: object }).proc = {
      killed: false,
      exitCode: 1,
      signalCode: null,
      stdin: { writable: false, destroyed: false, write: () => false },
    }
    const codexResult = await codex.writeDelegateTerminalNotification('{"jsonrpc":"2.0"}')
    assert.deepEqual(codexResult, { ok: false, processAlive: false })

    const pressure = new CodexAppServerRunner({} as never)
    ;(pressure as unknown as { proc: object }).proc = {
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: {
        writable: true,
        destroyed: false,
        write: (_chunk: string, cb?: (err?: Error | null) => void) => {
          cb?.(new Error('backpressure'))
          return false
        },
      },
    }
    const pressureResult = await pressure.writeDelegateTerminalNotification('{"jsonrpc":"2.0"}')
    assert.equal(pressureResult.ok, false)

    const asyncCodex = new CodexAppServerRunner({} as never)
    const asyncStdin = new EventEmitter() as EventEmitter & {
      writable: boolean
      destroyed: boolean
      write: (_chunk: string, cb?: (err?: Error | null) => void) => boolean
    }
    asyncStdin.writable = true
    asyncStdin.destroyed = false
    asyncStdin.write = (_chunk, cb) => {
      queueMicrotask(() => {
        const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
        asyncStdin.emit('error', error)
        cb?.(error)
      })
      return true
    }
    ;(asyncCodex as unknown as { proc: object }).proc = {
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: asyncStdin,
    }
    let uncaughtCode: string | undefined
    const onUncaught = (error: NodeJS.ErrnoException) => {
      uncaughtCode = error.code
    }
    process.once('uncaughtException', onUncaught)
    const asyncCodexResult = await asyncCodex.writeDelegateTerminalNotification('{"jsonrpc":"2.0"}')
    await new Promise((resolve) => setImmediate(resolve))
    process.off('uncaughtException', onUncaught)
    assert.equal(asyncCodexResult.ok, false)
    assert.equal(uncaughtCode, undefined)
  })

  it('parent submit rejection does not write an orphan InlinePush turn', async () => {
    class FakeRunner extends EventEmitter {
      isRunning = true
      lastActivityAt = Date.now()
      writes = 0
      submit(): Promise<void> {
        return Promise.reject(new Error('submit rejected before user line'))
      }
      writeDelegateUserMessage(): Promise<{ ok: boolean; processAlive: boolean }> {
        this.writes += 1
        return Promise.resolve({ ok: true, processAlive: true })
      }
    }
    const fake = new FakeRunner()
    const adapter = new CcbAdapter({} as never, fake as never)
    const turn = adapter.submitTurn({
      input: 'parent input',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    const pushed = await adapter.writeDelegateTerminal!(terminalEvent(), 'delegate terminal')
    await assert.rejects(turn.submitted)
    assert.deepEqual(
      { pushed, writes: fake.writes },
      { pushed: { ok: false, processAlive: true }, writes: 0 },
    )
    turn.end()
  })

  it('parentTapeHasNotifyId matches notifyId in id, text, or dlgcb clientMessageId', () => {
    const notifyId = 'dlgnfy.dlgjob-n1.1'
    const clientMessageId = delegateCallbackMessageId('dlgjob-n1', 1)
    assert.equal(parentTapeHasNotifyId([], notifyId), false)
    assert.equal(parentTapeHasNotifyId([{ id: notifyId, text: 'x' }], notifyId), true)
    assert.equal(parentTapeHasNotifyId([{ id: clientMessageId, text: 'x' }], notifyId, clientMessageId), true)
    assert.equal(
      parentTapeHasNotifyId([{ id: 'other', text: `see ${notifyId} here` }], notifyId),
      true,
    )
    assert.equal(
      parentTapeHasNotifyId(
        [{ id: 'other', content: [{ type: 'text', text: `<delegate-terminal notifyId=${notifyId}>` }] }],
        notifyId,
      ),
      true,
    )
    assert.equal(parentTapeHasNotifyId([{ id: 'other', text: 'nope' }], notifyId, clientMessageId), false)
  })

  it('reclaim after a_attempted without receipt: B iff tape lacks notifyId', async () => {
    async function run(tapeHas: boolean): Promise<{ aWrites: number; bWrites: number; state: string | undefined }> {
      const dir = await mkdtemp(join(tmpdir(), 'r3-tape-reclaim-'))
      let now = 2_000
      const clock = () => now
      let aWrites = 0
      let bWrites = 0
      try {
        const s1 = openStoreAt(dir, clock, 'gw:a')
        const seeded = await seededTerminal(s1, { parentEngine: 'ccb' })
        const n1 = new DefaultEngineNotifier({
          inlinePush: {
            write: async () => {
              aWrites += 1
              throw new Error('simulated gateway SIGKILL after A write')
            },
          },
          resumeInject: {
            inject: async () => {
              throw new Error('crashing generation must not start B')
            },
          },
          hasParentTapeIngested: async () => false,
        })
        const first = await dispatchJobTerminalNotify(s1, seeded.snap, n1)
        assert.ok(!('skipped' in first) && !first.ok)
        assert.equal(s1.hasNotifyAAttempted(seeded.jobId), true)
        assert.equal(s1.snapshotOf(seeded.jobId)?.callbackState, 'pending')
        s1.close()

        now += NOTIFY_CLAIM_LEASE_MS + 1
        const s2 = openStoreAt(dir, clock, 'gw:b')
        s2.hydrateFromDurable()
        const notifyId = delegateNotifyId(seeded.jobId, 1)
        const n2 = new DefaultEngineNotifier({
          inlinePush: {
            write: async () => {
              aWrites += 1
              return { ok: true, processAlive: true }
            },
          },
          resumeInject: {
            inject: async () => {
              bWrites += 1
              return { ok: true }
            },
          },
          hasParentTapeIngested: async (id) => tapeHas && id === notifyId,
        })
        const live = s2.snapshotOf(seeded.jobId)
        assert.ok(live)
        const result = await dispatchJobTerminalNotify(s2, live, n2)
        assert.ok(!('skipped' in result) && result.ok)
        const state = s2.snapshotOf(seeded.jobId)?.callbackState
        s2.close()
        return { aWrites, bWrites, state }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    assert.deepEqual(await run(false), { aWrites: 1, bWrites: 1, state: 'delivered' })
    assert.deepEqual(await run(true), { aWrites: 1, bWrites: 0, state: 'delivered' })
  })

  it('CCB death after write: B iff tape lacks notifyId', async () => {
    async function run(tapeHas: boolean): Promise<{ aWrites: number; bWrites: number }> {
      let aWrites = 0
      let bWrites = 0
      const notifier = new DefaultEngineNotifier({
        inlinePush: {
          write: async () => {
            aWrites += 1
            return { ok: false, processAlive: false }
          },
        },
        resumeInject: {
          inject: async () => {
            bWrites += 1
            return { ok: true }
          },
        },
        hasParentTapeIngested: async () => tapeHas,
      })
      const result = await notifier.notify(terminalEvent({ parentEngine: 'ccb' }))
      assert.equal(result.ok, true)
      return { aWrites, bWrites }
    }
    assert.deepEqual(await run(false), { aWrites: 1, bWrites: 1 })
    assert.deepEqual(await run(true), { aWrites: 1, bWrites: 0 })
  })

  it('Codex backpressure write()===false waits for callback and does not degrade to B', async () => {
    let aWrites = 0
    let bWrites = 0
    const notifier = new DefaultEngineNotifier({
      inlinePush: {
        write: async () => {
          const runner = new CodexAppServerRunner({} as never)
          const stdin = new EventEmitter() as EventEmitter & {
            writable: boolean
            destroyed: boolean
            write: (_chunk: string, cb?: (err?: Error | null) => void) => boolean
          }
          stdin.writable = true
          stdin.destroyed = false
          stdin.write = (_chunk, cb) => {
            setTimeout(() => cb?.(null), 20)
            return false
          }
          ;(runner as unknown as { proc: object }).proc = {
            killed: false,
            exitCode: null,
            signalCode: null,
            stdin,
            once: () => runner,
            off: () => runner,
          }
          const result = await runner.writeDelegateTerminalNotification('{"jsonrpc":"2.0"}')
          if (result.ok) aWrites += 1
          return result
        },
      },
      resumeInject: {
        inject: async () => {
          bWrites += 1
          return { ok: true }
        },
      },
    })
    const result = await notifier.notify(terminalEvent({ parentEngine: 'codex' }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.lane, 'inline-push')
    assert.deepEqual({ aWrites, bWrites }, { aWrites: 1, bWrites: 0 })
  })

  it('Codex hasIngestedParentTurn is only turn/start ACK, not queue/processing', () => {
    const kernel = new CodexAppServerRunner({} as never)
    const box = kernel as unknown as {
      queue: unknown[]
      processing: boolean
      currentTurnCompleter: object | null
      activeTurnId: string | null
    }
    box.queue = [{}]
    box.processing = true
    box.currentTurnCompleter = { resolve() {}, reject() {} }
    box.activeTurnId = null
    assert.equal(kernel.hasIngestedParentTurn, false)
    box.activeTurnId = 'turn-1'
    assert.equal(kernel.hasIngestedParentTurn, true)
  })

  it('Codex submit reject before turn/start ACK does not write an orphan notification', async () => {
    class FakeCodexKernel extends EventEmitter {
      isRunning = true
      hasIngestedParentTurn = false
      writes = 0
      submit(): Promise<void> {
        return Promise.reject(new Error('turn/start rejected before ingest'))
      }
      writeDelegateTerminalNotification(): Promise<{ ok: boolean; processAlive: boolean }> {
        this.writes += 1
        return Promise.resolve({ ok: true, processAlive: true })
      }
    }
    const kernel = new FakeCodexKernel()
    const adapter = new CodexAdapter({
      sessionKey: 'agent:main:webchat:dm:r3',
      agentId: 'main',
      agentBaseDir: '/tmp',
      config: {} as never,
    }, kernel as never)
    const turn = adapter.submitTurn({
      input: 'parent input',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await Promise.resolve()
    const pushed = await adapter.writeDelegateTerminal!(
      terminalEvent({ parentEngine: 'codex' }),
      'delegate terminal',
    )
    await assert.rejects(turn.submitted)
    assert.deepEqual(
      { pushed, writes: kernel.writes },
      { pushed: { ok: false, processAlive: true }, writes: 0 },
    )
    turn.end()
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

describe('stage 2: Completer hands cron + BUSY + killed notify to EngineNotifier', () => {
  it('cron-origin-inject with webchat origin delivers through exclusive claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-cron-ok-'))
    try {
      const store = openStore(dir)
      const { snap } = await seededTerminal(store, {
        parentEngine: 'cursor',
        callback: 'cron-origin-inject',
      })
      let injected = 0
      const result = await dispatchJobTerminalNotify(
        store,
        snap,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async (ev) => {
              injected += 1
              assert.equal(ev.callback, 'cron-origin-inject')
              assert.equal(ev.parentSessionKey, 'agent:main:webchat:dm:p1')
              return { ok: true }
            },
          },
        }),
      )
      assert.equal('ok' in result && result.ok, true)
      assert.equal(injected, 1)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('isolated cron-origin-inject (no origin session) is skipped_silent, not retried', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-cron-iso-'))
    try {
      const store = openStore(dir)
      const created = store.create('main', {
        queued: true,
        kind: 'cron',
        callback: 'cron-origin-inject',
        sessionKey: 'agent:main:cron:dm:hb:deliv',
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      assert.equal(
        store.complete(created.jobId, { httpStatus: 200, body: { ok: true, output: 'done' } }, claimed),
        true,
      )
      const snap = store.snapshotOf(created.jobId)!
      assert.equal(snap.callbackState, 'pending')
      let injected = 0
      const result = await dispatchJobTerminalNotify(
        store,
        snap,
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
      if (!('ok' in result) || !result.ok) return
      assert.equal(result.lane, 'skipped_silent')
      assert.equal(injected, 0)
      assert.equal(store.snapshotOf(created.jobId)?.callbackState, 'skipped_silent')
      assert.equal(store.listPendingNotify().length, 0)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cron-origin-inject failure releases claim and retries to delivered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-cron-fail-'))
    try {
      let now = 1_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable,
        bootId: 'gw:cron-fail',
        now: () => now,
      })
      const { snap } = await seededTerminal(store, {
        parentEngine: 'cursor',
        callback: 'cron-origin-inject',
      })
      await dispatchJobTerminalNotify(
        store,
        snap,
        new DefaultEngineNotifier({
          resumeInject: { inject: async () => ({ ok: false, failureClass: 'transport' }) },
        }),
      )
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'pending')
      assert.ok((after.notifyRetryAt ?? 0) > now)
      now = after.notifyRetryAt!
      let injected = 0
      const summary = await retryPendingNotifies(
        store,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async () => {
              injected += 1
              return { ok: true }
            },
          },
        }),
        {},
        { dueOnly: true },
      )
      assert.equal(summary.delivered, 1)
      assert.equal(injected, 1)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('BUSY returns callback pending and retry scheduler delivers later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-busy-'))
    try {
      let now = 5_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable,
        bootId: 'gw:busy',
        now: () => now,
      })
      const { snap } = await seededTerminal(store, { parentEngine: 'cursor' })
      const busy = new DefaultEngineNotifier({
        resumeInject: { inject: async () => ({ ok: false, busy: true, failureClass: 'internal' }) },
      })
      const first = await dispatchJobTerminalNotify(store, snap, busy)
      assert.equal('ok' in first && first.ok, false)
      const after = store.snapshotOf(snap.id)!
      assert.equal(after.state, 'completed')
      assert.equal(after.callbackState, 'pending')
      assert.ok((after.notifyRetryAt ?? 0) > now)
      now = after.notifyRetryAt!
      let injected = 0
      const summary = await retryPendingNotifies(
        store,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async () => {
              injected += 1
              return { ok: true }
            },
          },
        }),
        {},
        { dueOnly: true },
      )
      assert.equal(summary.delivered, 1)
      assert.equal(injected, 1)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('adoptOrKill terminal writes terminalCommittedAt + pending and notifier can deliver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-kill-'))
    try {
      let now = 1_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 100,
        durable,
        bootId: 'gw:g1',
        now: () => now,
      })
      const created = store.create('coding-assistant', {
        ownerInstanceId: 'gw:g0',
        callback: 'origin-inject',
        parentSessionKey: 'agent:main:webchat:dm:p1',
        callbackOriginSessionKey: 'agent:main:webchat:dm:p1',
        parentEngine: 'cursor',
      })
      assert.ok('jobId' in created)
      const before = store.snapshotOf(created.jobId)!
      assert.equal(before.callbackState, 'none')
      now = 1_200
      const adopted = store.adoptOrKill(created.jobId, before.fencingEpoch, 'killed_by_cutover')
      assert.equal(adopted?.state, 'killed_by_cutover')
      assert.equal(adopted?.terminalCommittedAt, 1_200)
      assert.equal(adopted?.callbackState, 'pending')
      assert.equal(adopted?.callbackEpoch, 1)
      const samples: number[] = []
      let injected = 0
      const result = await dispatchJobTerminalNotify(
        store,
        adopted!,
        new DefaultEngineNotifier({
          now: () => 5_000,
          onSample: (sample) => samples.push(sample.latencyMs),
          resumeInject: {
            inject: async (ev) => {
              injected += 1
              assert.equal(ev.state, 'killed_by_cutover')
              assert.equal(ev.terminalCommittedAt, 1_200)
              return { ok: true }
            },
          },
        }),
      )
      assert.equal('ok' in result && result.ok, true)
      assert.equal(injected, 1)
      assert.equal(store.snapshotOf(created.jobId)?.callbackState, 'delivered')
      assert.deepEqual(samples, [3_800])
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cron-origin-inject two stores consume a pending notify once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-cron-dual-'))
    try {
      const path = join(dir, 'delegate-jobs.db')
      const d1 = new DelegateDurableDb(path)
      const s1 = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable: d1,
        bootId: 'gw:a',
      })
      const { snap } = await seededTerminal(s1, {
        parentEngine: 'cursor',
        callback: 'cron-origin-inject',
      })
      const d2 = new DelegateDurableDb(path)
      const s2 = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable: d2,
        bootId: 'gw:b',
      })
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
})

describe('stage 2 review blockers: cron generation migration + continuation', () => {
  const originKey = 'agent:main:webchat:dm:p1'

  async function seedCronTerminal(
    store: DelegateJobStore,
    extra: {
      output?: string
      continuation?: ReturnType<typeof buildCronContinuationEnvelope>
      callbackState?: 'pending' | 'delivered'
      notifyLane?: string
      originUserId?: string
    } = {},
  ) {
    const created = store.create('main', {
      queued: true,
      kind: 'cron',
      callback: 'cron-origin-inject',
      parentSessionKey: originKey,
      callbackOriginSessionKey: originKey,
      callbackOriginUserId: extra.originUserId ?? 'user-42',
      parentEngine: 'cursor',
    })
    assert.ok('jobId' in created)
    const claimed = store.claimQueued(created.jobId)
    assert.equal(claimed.ok, true)
    if (!claimed.ok) throw new Error('claim failed')
    const prompt = extra.output ?? 'continue the launch'
    const continuation =
      extra.continuation ??
      buildCronContinuationEnvelope({
        id: 'remind-origin',
        prompt,
        label: '续跑',
        sourceUserId: extra.originUserId ?? 'user-42',
        sourceSessionKey: originKey,
        projectMode: 'fixed',
        boardProjectId: 'proj-fixed-1',
      })
    assert.equal(
      store.complete(
        created.jobId,
        {
          httpStatus: 200,
          body: {
            ok: true,
            output: continuation.resumeText,
            cronContinuation: continuation,
          },
        },
        claimed,
        extra.callbackState ? { callbackState: extra.callbackState } : undefined,
      ),
      true,
    )
    if (extra.notifyLane) {
      assert.equal(
        store.patchNotifyIntent(
          created.jobId,
          { notifyLane: extra.notifyLane, notifyId: delegateNotifyId(created.jobId, 1) },
          claimed,
        ),
        true,
      )
    }
    const snap = store.snapshotOf(created.jobId)
    assert.ok(snap)
    return { jobId: created.jobId, fence: claimed, snap }
  }

  it('blocker1 off→on: flag-off delivered job is not dlgcb-replayed after Notifier boot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-gen-offon-'))
    try {
      const store = openStore(dir)
      const { snap } = await seedCronTerminal(store, { callbackState: 'delivered' })
      assert.equal(snap.callbackState, 'delivered')
      assert.equal(store.listPendingNotify().length, 0)
      store.close()

      const boot = openStore(dir, { bootId: 'gw:on' })
      let injected = 0
      const summary = await retryPendingNotifies(
        boot,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async () => {
              injected += 1
              return { ok: true }
            },
          },
        }),
      )
      assert.equal(summary.scanned, 0)
      assert.equal(injected, 0)
      assert.equal(boot.snapshotOf(snap.id)?.callbackState, 'delivered')
      boot.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 crash-window off→on: pending + legacy-completer is ACK without inject', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-gen-crash-offon-'))
    try {
      const store = openStore(dir)
      const { snap } = await seedCronTerminal(store, { notifyLane: CRON_CALLBACK_LEGACY_LANE })
      assert.equal(snap.callbackState, 'pending')
      assert.equal(snap.notifyLane, CRON_CALLBACK_LEGACY_LANE)
      let injected = 0
      const result = await dispatchJobTerminalNotify(
        store,
        snap,
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
      assert.equal(injected, 0)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 on→off: BUSY pending is drained with dlgcb.* not cron-origin-*', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-gen-onoff-'))
    try {
      const store = openStore(dir)
      const { snap } = await seedCronTerminal(store)
      const busy = new DefaultEngineNotifier({
        resumeInject: { inject: async () => ({ ok: false, busy: true, failureClass: 'internal' }) },
      })
      await dispatchJobTerminalNotify(store, snap, busy)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'pending')
      store.close()

      const boot = openStore(dir, { bootId: 'gw:off' })
      const ids: string[] = []
      const drain = new DefaultEngineNotifier({
        resumeInject: {
          inject: async (ev) => {
            ids.push(delegateCallbackMessageId(ev.jobId, ev.callbackEpoch))
            return { ok: true }
          },
        },
      })
      const summary = await retryPendingNotifies(boot, drain, {}, { callbacks: ['cron-origin-inject'] })
      assert.equal(summary.delivered, 1)
      assert.deepEqual(ids, [delegateCallbackMessageId(snap.id, 1)])
      assert.match(ids[0]!, /^dlgcb\./)
      assert.equal(boot.snapshotOf(snap.id)?.callbackState, 'delivered')
      boot.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 crash-window on→off: pending without legacy lane still drains once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-gen-crash-onoff-'))
    try {
      const store = openStore(dir)
      const { snap } = await seedCronTerminal(store)
      assert.equal(snap.callbackState, 'pending')
      let injected = 0
      const summary = await retryPendingNotifies(
        store,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async () => {
              injected += 1
              return { ok: true }
            },
          },
        }),
        {},
        { callbacks: ['cron-origin-inject'] },
      )
      assert.equal(summary.delivered, 1)
      assert.equal(injected, 1)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'delivered')
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function runCronOriginCrashWindow(args: {
    dir: string
    cronJobId: string
    notifierOn: boolean
    inject: (jobId: string, store: DelegateJobStore) => Promise<{ kind: 'injected' } | never>
    onMarkSubmitStarted?: (store: DelegateJobStore, jobId: string) => Promise<void>
  }) {
    const prev = {
      sm: process.env.OC_DELEGATE_SM,
      durable: process.env.OC_DELEGATE_DURABLE,
      notifier: process.env.OC_DELEGATE_NOTIFIER,
      home: process.env.OPENCLAUDE_HOME,
    }
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    process.env.OC_DELEGATE_NOTIFIER = args.notifierOn ? '1' : '0'
    process.env.OPENCLAUDE_HOME = args.dir
    const { CronScheduler } = await import('../cron.js')
    const dbPath = join(args.dir, 'delegate-jobs.db')
    const store = new DelegateJobStore({
      sm: true,
      durable: new DelegateDurableDb(dbPath),
      bootId: args.notifierOn ? 'gw:on' : 'gw:off',
      ttlMs: 60_000,
      leaseMs: 1_000,
    })
    const originKey = 'agent:main:webchat:dm:crash-window-parent'
    const dueMinuteKey = 123
    const enq = enqueueCronOccurrenceJob(store, {
      cronJobId: args.cronJobId,
      dueMinuteKey,
      agentId: 'main',
      parentSessionKey: originKey,
      callbackOriginSessionKey: originKey,
      callbackOriginUserId: 'uid-crash',
      parentEngine: 'cursor',
    })
    assert.ok('jobId' in enq)
    const scheduler = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      { getOrCreate: async () => ({}), submit: async () => {}, destroySession: async () => {} } as any,
      () => {},
      async () => args.inject(enq.jobId, store),
    )
    scheduler.delegateJobs = store
    const job = {
      id: args.cronJobId,
      schedule: '* * * * *',
      agent: 'main',
      prompt: 'continue exactly once',
      resume: 'origin-session',
      sourceSessionKey: originKey,
      sourceUserId: 'uid-crash',
      projectMode: 'follow_session',
      enabled: true,
    } as any
    const agent = { id: 'main', model: 'glm-5.2' } as any
    const delivery = { dueMinuteKey, deliveryId: `cron.${args.cronJobId}.${dueMinuteKey}` }
    const outcome = await (scheduler as any).runJob(job, agent, {
      consumeOccurrence: async () => {},
      markSubmitStarted: async () => {
        if (args.onMarkSubmitStarted) {
          await args.onMarkSubmitStarted(store, enq.jobId)
          return
        }
        throw new Error('simulated crash before markSubmitStarted')
      },
      markCompleted: async () => {},
      markDelivered: async () => {},
    }, delivery)
    const snap = store.snapshotOf(enq.jobId)!
    return { store, job, enq, outcome, snap, dbPath, prev, originKey }
  }

  function restoreDelegateFlags(prev: {
    sm: string | undefined
    durable: string | undefined
    notifier: string | undefined
    home: string | undefined
  }) {
    if (prev.sm === undefined) delete process.env.OC_DELEGATE_SM
    else process.env.OC_DELEGATE_SM = prev.sm
    if (prev.durable === undefined) delete process.env.OC_DELEGATE_DURABLE
    else process.env.OC_DELEGATE_DURABLE = prev.durable
    if (prev.notifier === undefined) delete process.env.OC_DELEGATE_NOTIFIER
    else process.env.OC_DELEGATE_NOTIFIER = prev.notifier
    if (prev.home === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = prev.home
  }

  async function settleThenDispatch(store: DelegateJobStore, jobId: string, job: { prompt: string; id: string }) {
    const live = store.snapshotOf(jobId)!
    let fence =
      live.claimToken
        ? { claimToken: live.claimToken, fencingEpoch: live.fencingEpoch }
        : undefined
    if (!fence) {
      const claimed = store.claimQueued(jobId)
      assert.equal(claimed.ok, true)
      if (claimed.ok) fence = claimed
    }
    const continuation = buildCronContinuationEnvelope({
      id: job.id,
      prompt: job.prompt,
      sourceUserId: 'uid-crash',
      sourceSessionKey: live.callbackOriginSessionKey ?? live.parentSessionKey,
    })
    assert.equal(
      settleCronDelegateJob(
        store,
        jobId,
        'completed',
        fence,
        undefined,
        { output: buildCronOriginResumeText(job), cronContinuation: continuation },
      ),
      true,
    )
    const dlgcbIds: string[] = []
    const snap = store.snapshotOf(jobId)!
    const result = await dispatchJobTerminalNotify(
      store,
      snap,
      new DefaultEngineNotifier({
        resumeInject: {
          inject: async (event) => {
            dlgcbIds.push(delegateCallbackMessageId(event.jobId, event.callbackEpoch))
            return { ok: true }
          },
        },
      }),
    )
    return { result, dlgcbIds, snap: store.snapshotOf(jobId)! }
  }

  it('blocker1 marker-free off→on: inject success then crash before claim is ACK not dlgcb-replayed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-mf-offon-inject-'))
    let prev: Parameters<typeof restoreDelegateFlags>[0] | undefined
    try {
      let legacyInjects = 0
      const first = await runCronOriginCrashWindow({
        dir,
        cronJobId: 'remind-crash-inject-then-claim',
        notifierOn: false,
        inject: async () => {
          legacyInjects += 1
          return { kind: 'injected' }
        },
      })
      prev = first.prev
      assert.equal(legacyInjects, 1)
      assert.equal(first.snap.state, 'queued')
      assert.equal(first.snap.callbackState, 'delivered')
      assert.equal(first.snap.notifyLane, CRON_CALLBACK_LEGACY_LANE)
      assert.equal(isCronOriginInjectAcked(first.snap.callbackState), true)
      first.store.close()

      process.env.OC_DELEGATE_NOTIFIER = '1'
      const boot = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(first.dbPath),
        bootId: 'gw:on',
        ttlMs: 60_000,
        leaseMs: 1_000,
      })
      assert.equal(boot.snapshotOf(first.enq.jobId)?.notifyLane, CRON_CALLBACK_LEGACY_LANE)
      assert.equal(boot.snapshotOf(first.enq.jobId)?.callbackState, 'delivered')
      const { CronScheduler } = await import('../cron.js')
      const scheduler = new CronScheduler(
        { defaults: { model: 'glm-5.2' } } as any,
        { getOrCreate: async () => ({}), submit: async () => {}, destroySession: async () => {} } as any,
        () => {},
        async () => {
          legacyInjects += 1
          return { kind: 'injected' as const }
        },
      )
      scheduler.delegateJobs = boot
      const delivery = { dueMinuteKey: 123, deliveryId: `cron.${first.job.id}.123` }
      const second = await (scheduler as any).runJob(first.job, { id: 'main', model: 'glm-5.2' }, {
        consumeOccurrence: async () => {},
        markSubmitStarted: async () => {
          const claimed = boot.claimQueued(first.enq.jobId)
          assert.equal(claimed.ok, true)
          throw new Error('simulated crash after skip-inject claim')
        },
        markCompleted: async () => {},
        markDelivered: async () => {},
      }, delivery)
      assert.equal(second.kind, 'retryable_failure')
      assert.equal(legacyInjects, 1)
      const dispatched = await settleThenDispatch(boot, first.enq.jobId, first.job)
      assert.equal('ok' in dispatched.result && dispatched.result.ok, true)
      assert.equal(dispatched.dlgcbIds.length, 0)
      assert.equal(dispatched.snap.callbackState, 'delivered')
      assert.equal(legacyInjects, 1)
      boot.close()
    } finally {
      if (prev) restoreDelegateFlags(prev)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 marker-free off→on: stamp then crash before inject retries Completer key not dlgcb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-mf-offon-stamp-'))
    let prev: Parameters<typeof restoreDelegateFlags>[0] | undefined
    try {
      let legacyInjects = 0
      const first = await runCronOriginCrashWindow({
        dir,
        cronJobId: 'remind-crash-stamp-then-inject',
        notifierOn: false,
        inject: async (jobId, store) => {
          assert.equal(store.snapshotOf(jobId)?.notifyLane, CRON_CALLBACK_LEGACY_LANE)
          throw new Error('simulated crash after generation lock before inject')
        },
      })
      prev = first.prev
      assert.equal(legacyInjects, 0)
      assert.equal(first.snap.state, 'queued')
      assert.equal(first.snap.callbackState, 'none')
      assert.equal(isCronOriginInjectAcked(first.snap.callbackState), false)
      assert.equal(first.snap.notifyLane, CRON_CALLBACK_LEGACY_LANE)
      first.store.close()

      process.env.OC_DELEGATE_NOTIFIER = '1'
      const boot = new DelegateJobStore({
        sm: true,
        durable: new DelegateDurableDb(first.dbPath),
        bootId: 'gw:on',
        ttlMs: 60_000,
        leaseMs: 1_000,
      })
      const { CronScheduler } = await import('../cron.js')
      const scheduler = new CronScheduler(
        { defaults: { model: 'glm-5.2' } } as any,
        { getOrCreate: async () => ({}), submit: async () => {}, destroySession: async () => {} } as any,
        () => {},
        async () => {
          legacyInjects += 1
          return { kind: 'injected' as const }
        },
      )
      scheduler.delegateJobs = boot
      const delivery = { dueMinuteKey: 123, deliveryId: `cron.${first.job.id}.123` }
      const second = await (scheduler as any).runJob(first.job, { id: 'main', model: 'glm-5.2' }, {
        consumeOccurrence: async () => {},
        markSubmitStarted: async () => {
          throw new Error('simulated crash before markSubmitStarted')
        },
        markCompleted: async () => {},
        markDelivered: async () => {},
      }, delivery)
      assert.equal(second.kind, 'retryable_failure')
      assert.equal(legacyInjects, 1)
      const dispatched = await settleThenDispatch(boot, first.enq.jobId, first.job)
      assert.equal('ok' in dispatched.result && dispatched.result.ok, true)
      assert.equal(dispatched.dlgcbIds.length, 0)
      assert.equal(dispatched.snap.callbackState, 'delivered')
      boot.close()
    } finally {
      if (prev) restoreDelegateFlags(prev)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 marker-free on→off: inject success then crash before notify-complete drains once with dlgcb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-mf-onoff-inject-'))
    try {
      let now = 1_700_000_000_000
      const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable,
        bootId: 'gw:on',
        now: () => now,
      })
      const { snap, fence } = await seedCronTerminal(store)
      const claimed = store.claimNotifyDelivery(snap.id, fence)
      assert.equal(claimed.ok, true)
      const ids: string[] = []
      const notifier = new DefaultEngineNotifier({
        resumeInject: {
          inject: async (event) => {
            ids.push(delegateCallbackMessageId(event.jobId, event.callbackEpoch))
            return { ok: true }
          },
        },
      })
      const event = buildJobTerminalFromSnapshot(store.snapshotOf(snap.id)!, { parentEngine: 'cursor' })
      assert.ok(event)
      const injected = await notifier.notify(event)
      assert.equal(injected.ok, true)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'injecting')
      assert.deepEqual(ids, [delegateCallbackMessageId(snap.id, 1)])
      store.close()

      now += NOTIFY_CLAIM_LEASE_MS + 1
      const boot = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:off',
        now: () => now,
      })
      const summary = await retryPendingNotifies(
        boot,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async (event) => {
              ids.push(delegateCallbackMessageId(event.jobId, event.callbackEpoch))
              return { ok: true }
            },
          },
        }),
        {},
        { callbacks: ['cron-origin-inject'] },
      )
      assert.equal(summary.delivered, 1)
      assert.equal(ids.length, 2)
      assert.deepEqual(new Set(ids), new Set([delegateCallbackMessageId(snap.id, 1)]))
      assert.match(ids[0]!, /^dlgcb\./)
      assert.equal(boot.snapshotOf(snap.id)?.callbackState, 'delivered')
      boot.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 marker-free on→off: notify-claim then crash before inject drains once with dlgcb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-mf-onoff-claim-'))
    try {
      let now = 1_700_000_000_000
      const store = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:on',
        now: () => now,
      })
      const { snap, fence } = await seedCronTerminal(store)
      const claimed = store.claimNotifyDelivery(snap.id, fence)
      assert.equal(claimed.ok, true)
      assert.equal(store.snapshotOf(snap.id)?.callbackState, 'injecting')
      store.close()

      now += NOTIFY_CLAIM_LEASE_MS + 1
      const boot = new DelegateJobStore({
        sm: true,
        ttlMs: 60_000,
        leaseMs: 1_000,
        durable: new DelegateDurableDb(join(dir, 'delegate-jobs.db')),
        bootId: 'gw:off',
        now: () => now,
      })
      const ids: string[] = []
      const summary = await retryPendingNotifies(
        boot,
        new DefaultEngineNotifier({
          resumeInject: {
            inject: async (event) => {
              ids.push(delegateCallbackMessageId(event.jobId, event.callbackEpoch))
              return { ok: true }
            },
          },
        }),
        {},
        { callbacks: ['cron-origin-inject'] },
      )
      assert.equal(summary.delivered, 1)
      assert.deepEqual(ids, [delegateCallbackMessageId(snap.id, 1)])
      assert.match(ids[0]!, /^dlgcb\./)
      assert.equal(boot.snapshotOf(snap.id)?.callbackState, 'delivered')
      boot.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker1 local already_exists across restart ACKs without dispatch', () => {
    const durableMessages = new Set<string>()
    const dispatches: string[] = []
    const deliveryId = 'cron.remind-local-restart.123'
    const clientMessageId = cronOriginClientMessageId(deliveryId)
    const idempotencyKey = cronOriginIdempotencyKey('remind-local-restart', deliveryId)

    function persistOnce(): { applied: boolean; reason?: string } {
      if (durableMessages.has(clientMessageId)) {
        return { applied: false, reason: 'already_exists' }
      }
      durableMessages.add(clientMessageId)
      return { applied: true }
    }

    function injectOnce(processSeen: Set<string>): 'dispatch' | 'ack_injected' | 'fallback' | 'retry_persist' {
      const persist = persistOnce()
      const decision = decideCronOriginDispatchAfterPersist(persist)
      if (decision === 'dispatch') {
        if (!processSeen.has(idempotencyKey)) {
          processSeen.add(idempotencyKey)
          dispatches.push(idempotencyKey)
        }
      }
      return decision
    }

    const proc1 = new Set<string>()
    assert.equal(injectOnce(proc1), 'dispatch')
    assert.equal(dispatches.length, 1)

    const proc2 = new Set<string>()
    assert.equal(injectOnce(proc2), 'ack_injected')
    assert.equal(dispatches.length, 1)
    assert.equal(decideCronOriginDispatchAfterPersist({ applied: true }), 'dispatch')
    assert.equal(
      decideCronOriginDispatchAfterPersist({ applied: false, reason: 'session_deleted' }),
      'fallback',
    )
    assert.equal(
      decideCronOriginDispatchAfterPersist({ applied: false, reason: 'malformed' }),
      'retry_persist',
    )
  })

  it('blocker2: >8K resume text keeps UNIQUE_SUFFIX; resultRef stays display-truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-trunc-'))
    try {
      const store = openStore(dir)
      const prompt = `${'A'.repeat(8_980)}UNIQUE_SUFFIX`
      const { snap } = await seedCronTerminal(store, { output: prompt })
      const event = buildJobTerminalFromSnapshot(snap, { parentEngine: 'cursor' })
      assert.ok(event)
      assert.equal((event.resultRef ?? '').length, 8_000)
      assert.equal(event.resultRef?.includes('UNIQUE_SUFFIX'), false)
      assert.ok(event.cronContinuation?.resumeText.includes('UNIQUE_SUFFIX'))
      assert.ok(event.cronContinuation!.resumeText.length > 8_000)
      const payload = resolveCronOriginInjectPayload(event)
      assert.ok(payload)
      assert.ok(payload.override.text.includes('UNIQUE_SUFFIX'))
      assert.equal(payload.override.clientMessageId, delegateCallbackMessageId(snap.id, 1))
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocker2: continuation keeps sourceUserId and fixed project across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-ctx-'))
    try {
      const store = openStore(dir)
      const { snap } = await seedCronTerminal(store, { originUserId: 'uid-7' })
      store.close()

      const boot = openStore(dir, { bootId: 'gw:reopen' })
      const restored = boot.snapshotOf(snap.id)
      assert.ok(restored)
      const event = buildJobTerminalFromSnapshot(restored, { parentEngine: 'cursor' })
      assert.ok(event)
      assert.equal(event.callbackOriginUserId, 'uid-7')
      assert.equal(event.cronContinuation?.sourceUserId, 'uid-7')
      assert.equal(event.cronContinuation?.projectMode, 'fixed')
      assert.equal(event.cronContinuation?.boardProjectId, 'proj-fixed-1')
      const payload = resolveCronOriginInjectPayload(event)
      assert.ok(payload)
      assert.equal(payload.job.sourceUserId, 'uid-7')
      assert.equal(payload.job.projectMode, 'fixed')
      assert.equal(payload.job.boardProjectId, 'proj-fixed-1')
      assert.equal(payload.job.sourceSessionKey, originKey)
      boot.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('settleCronDelegateJob flag-off writes continuation and delivered in one fence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-nfy-settle-legacy-'))
    try {
      const output = buildCronOriginResumeText({ label: '续跑', prompt: 'do it' })
      const continuation = buildCronContinuationEnvelope({
        id: 'remind-x',
        prompt: 'do it',
        label: '续跑',
        sourceUserId: 'uid-9',
        sourceSessionKey: originKey,
        projectMode: 'follow_session',
      })
      const store = openStore(dir)
      const created = store.create('main', {
        queued: true,
        kind: 'cron',
        callback: 'cron-origin-inject',
        parentSessionKey: originKey,
        callbackOriginSessionKey: originKey,
        parentEngine: 'cursor',
      })
      assert.ok('jobId' in created)
      const claimed = store.claimQueued(created.jobId)
      assert.equal(claimed.ok, true)
      if (!claimed.ok) throw new Error('claim failed')
      assert.equal(
        settleCronDelegateJob(
          store,
          created.jobId,
          'completed',
          claimed,
          undefined,
          { output, cronContinuation: continuation },
          { callbackState: 'delivered' },
        ),
        true,
      )
      const snap = store.snapshotOf(created.jobId)!
      assert.equal(snap.callbackState, 'delivered')
      assert.equal(snap.result?.body.output, output)
      assert.deepEqual(snap.result?.body.cronContinuation, continuation)
      store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

