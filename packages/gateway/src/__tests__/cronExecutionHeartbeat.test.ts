/**
 * OCV5-188 C / D1: cron execution-scope heartbeat.
 *
 * Layer 2: real CronScheduler tick → claim → runJob → submit (not mocked).
 * Isolated HOME + real SQLite. Injected clock, no commercial model calls.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronExecutionHeartbeat.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { stringify as stringifyYaml } from 'yaml'

const ORIGINAL_HOME = process.env.OPENCLAUDE_HOME
const ORIGINAL_SM = process.env.OC_DELEGATE_SM
const ORIGINAL_SEED = process.env.OC_SEED_DEFAULT_CRON
const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-cron-exec-hb-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
process.env.OC_SEED_DEFAULT_CRON = '0'
process.env.OC_DELEGATE_SM = '1'

const { CronScheduler } = await import('../cron.js')
const { paths } = await import('@openclaude/storage')
const {
  DelegateJobStore,
  DELEGATE_LEASE_HEARTBEAT_MS,
} = await import('../delegateJobs.js')
const { DelegateDurableDb } = await import('../delegateDurable.js')
const { IDLE_TIMEOUT_TOOL_MS, SessionManager } = await import('../sessionManager.js')
const { CcbAdapter } = await import('../engine/ccbAdapter.js')
const { AUTHORITY_TURN_MAX_LIFETIME_MS } = await import('@openclaude/protocol')

const INTERVAL = DELEGATE_LEASE_HEARTBEAT_MS
const BEATS_PAST_OLD_CAP = 481

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function createManualClock(getNow: () => number, setNow: (value: number) => void) {
  let nextId = 1
  const timers = new Map<number, () => void>()
  return {
    setInterval(fn: () => void) {
      const id = nextId++
      timers.set(id, fn)
      return Object.assign(id, { unref() {} }) as unknown as ReturnType<typeof setInterval>
    },
    clearInterval(handle: ReturnType<typeof setInterval>) {
      timers.delete(handle as unknown as number)
    },
    beats(n: number, intervalMs: number = INTERVAL) {
      for (let i = 0; i < n; i++) {
        setNow(getNow() + intervalMs)
        for (const fn of [...timers.values()]) fn()
      }
    },
    captureCallback() {
      return [...timers.values()][0]
    },
    get pending() {
      return timers.size
    },
  }
}

function openStore(
  dir: string,
  opts: { bootId?: string; now?: () => number; hydrate?: boolean } = {},
) {
  const durable = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
  return new DelegateJobStore({
    sm: true,
    ttlMs: 60_000,
    leaseMs: 1_000,
    durable,
    bootId: opts.bootId ?? 'gw:cron-hb',
    now: opts.now,
    hydrate: opts.hydrate,
  })
}

function reportContract(
  contractId: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
) {
  console.log(JSON.stringify({ contractId, expected, actual }))
}

function writeDueJob(over: Record<string, unknown> = {}) {
  mkdirSync(join(TEST_HOME, 'cron'), { recursive: true })
  mkdirSync(paths.cronOutputsDir, { recursive: true })
  writeFileSync(
    paths.cronYaml,
    stringifyYaml({
      jobs: [
        {
          id: 'live-1',
          schedule: '* * * * *',
          agent: 'main',
          prompt: 'write a substantive cron result for the user',
          deliver: 'local',
          enabled: true,
          ...over,
        },
      ],
    }),
  )
}

function writeTwoDueJobs() {
  mkdirSync(join(TEST_HOME, 'cron'), { recursive: true })
  mkdirSync(paths.cronOutputsDir, { recursive: true })
  writeFileSync(
    paths.cronYaml,
    stringifyYaml({
      jobs: [
        {
          id: 'live-1',
          schedule: '* * * * *',
          agent: 'main',
          prompt: 'first due job',
          deliver: 'local',
          enabled: true,
        },
        {
          id: 'live-2',
          schedule: '* * * * *',
          agent: 'main',
          prompt: 'second due job',
          deliver: 'local',
          enabled: true,
        },
      ],
    }),
  )
}

function resetCronHome() {
  for (const p of [
    paths.cronYaml,
    join(TEST_HOME, 'cron', 'last-run.json'),
    join(TEST_HOME, 'cron', 'retry-state.json'),
    paths.agentsYaml,
  ]) {
    if (existsSync(p)) unlinkSync(p)
  }
}

describe('OCV5-188 cron execution heartbeat — scheduler lifecycle', () => {
  before(() => {
    assert.ok(paths.cronYaml.startsWith(TEST_HOME), `paths.cronYaml=${paths.cronYaml}`)
  })

  beforeEach(() => {
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_SEED_DEFAULT_CRON = '0'
    resetCronHome()
  })

  after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = ORIGINAL_HOME
    if (ORIGINAL_SM === undefined) delete process.env.OC_DELEGATE_SM
    else process.env.OC_DELEGATE_SM = ORIGINAL_SM
    if (ORIGINAL_SEED === undefined) delete process.env.OC_SEED_DEFAULT_CRON
    else process.env.OC_SEED_DEFAULT_CRON = ORIGINAL_SEED
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('tick→claim→submit keeps a healthy occurrence alive across 481 injected 15s beats', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-481-'))
    let now = 1_000_000
    const clock = createManualClock(
      () => now,
      (value) => {
        now = value
      },
    )
    const store = openStore(dir, { now: () => now })
    writeDueJob()
    const submitGate = deferred()
    const submitted = deferred()
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async (_session: unknown, _prompt: unknown, cb: (e: any) => void) => {
          submitted.resolve()
          await submitGate.promise
          cb({ kind: 'block', block: { kind: 'text', text: 'cron job completed with real output' } })
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      } as any,
      async () => {},
    )
    sched.delegateJobs = store
    sched.delegateHeartbeatMs = INTERVAL
    sched.heartbeatSetInterval = clock.setInterval as typeof setInterval
    sched.heartbeatClearInterval = clock.clearInterval as typeof clearInterval

    const tickP = (sched as any).tick() as Promise<void>
    await submitted.promise
    const running = store.listRunning()
    assert.equal(running.length, 1, 'claim must have produced a running row before submit')
    const jobId = running[0]!.id
    const claimedAt = running[0]!.lastActivityAt
    assert.equal(typeof claimedAt, 'number')
    assert.equal(sched.activeExecutionHeartbeatCount, 1)

    clock.beats(BEATS_PAST_OLD_CAP)
    const live = store.snapshotOf(jobId)!
    const elapsedMs = now - claimedAt!
    const actual = {
      interrupts: interrupted.length,
      elapsedMs,
      activityBefore: claimedAt,
      activityAfter: live.lastActivityAt,
      activityAdvancedMs: live.lastActivityAt! - claimedAt!,
      state: live.state,
      fenceEpoch: live.fencingEpoch,
      submits: 1,
      logicalTime: now,
    }
    const expected = {
      interrupts: 0,
      elapsedMs: BEATS_PAST_OLD_CAP * INTERVAL,
      activityAdvancedMs: BEATS_PAST_OLD_CAP * INTERVAL,
      state: 'running',
    }
    reportContract('C-481-submit', expected, actual)
    assert.equal(interrupted.length, 0)
    assert.equal(live.state, 'running')
    assert.equal(live.lastActivityAt, now)
    assert.equal(now - claimedAt!, BEATS_PAST_OLD_CAP * INTERVAL)
    assert.ok(now - claimedAt! > 2 * 60 * 60_000)
    assert.deepEqual(store.reapStaleRunning({ timeoutMs: 30 * 60_000 }), [])

    submitGate.resolve()
    await tickP
    assert.equal(sched.activeExecutionHeartbeatCount, 0)
    assert.equal(interrupted.length, 0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('waiting submit (real SessionManager waitingForUserInput) is not cron-killed across 481 beats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-wait-'))
    let now = 1_000_000
    const clock = createManualClock(
      () => now,
      (value) => {
        now = value
      },
    )
    const store = openStore(dir, { now: () => now })
    writeDueJob({ id: 'live-wait' })
    const submitGate = deferred()
    const submitted = deferred()
    const runner = new HangRunner()
    const session = makeCcbSession(runner)
    Object.defineProperty(session.runner, 'waitingForUserInput', {
      get: () => true,
      configurable: true,
    })
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async () => session,
        submit: async (_session: unknown, _prompt: unknown, cb: (e: any) => void) => {
          submitted.resolve()
          await submitGate.promise
          cb({ kind: 'block', block: { kind: 'text', text: 'waiting cron finished after input' } })
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return session.runner.interrupt()
        },
      } as any,
      async () => {},
    )
    sched.delegateJobs = store
    sched.delegateHeartbeatMs = INTERVAL
    sched.heartbeatSetInterval = clock.setInterval as typeof setInterval
    sched.heartbeatClearInterval = clock.clearInterval as typeof clearInterval

    const tickP = (sched as any).tick() as Promise<void>
    await submitted.promise
    assert.equal(session.runner.waitingForUserInput, true, 'watchdog must see a real waiting flag')
    clock.beats(BEATS_PAST_OLD_CAP)
    const waitRow = store.listRunning()[0]
    const waitActual = {
      layer: 'injected-waiting-getter',
      notRealModel: true,
      schedulerSubmitIsSynthetic: true,
      state: waitRow?.state,
      interrupts: interrupted.length,
      logicalTime: now,
    }
    reportContract(
      'C-481-waiting-getter',
      { interrupts: 0, state: 'running', layer: 'injected-waiting-getter' },
      waitActual,
    )
    assert.equal(store.listRunning()[0]?.state, 'running')
    assert.deepEqual(store.reapStaleRunning({ timeoutMs: 30 * 60_000 }), [])
    assert.equal(interrupted.length, 0)
    submitGate.resolve()
    await tickP
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('pre-submit persist pending does not renew the lease and stop refuses the late submit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-persist-'))
    let now = 1_000_000
    const clock = createManualClock(
      () => now,
      (value) => {
        now = value
      },
    )
    const store = openStore(dir, { now: () => now })
    writeDueJob()
    let submits = 0
    const persistStarted = deferred()
    const persistGate = deferred()
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async () => {
          submits++
        },
        destroySession: async () => {},
        interrupt: () => true,
      } as any,
      async () => {},
    )
    try {
      sched.delegateJobs = store
      sched.delegateHeartbeatMs = INTERVAL
      sched.heartbeatSetInterval = clock.setInterval as typeof setInterval
      sched.heartbeatClearInterval = clock.clearInterval as typeof clearInterval
      const origPersist = (sched as any).persistLastRun.bind(sched)
      ;(sched as any).persistLastRun = async (value: Record<string, number>) => {
        persistStarted.resolve()
        await persistGate.promise
        return origPersist(value)
      }

      const tickP = (sched as any).tick() as Promise<void>
      await persistStarted.promise
      const running = store.listRunning()
      assert.equal(running.length, 1, 'claim happens before persistLastRun')
      const frozen = running[0]!.lastActivityAt
      assert.equal(sched.activeExecutionHeartbeatCount, 0, 'heartbeat must not start during persist')
      clock.beats(8)
      assert.equal(store.snapshotOf(running[0]!.id)!.lastActivityAt, frozen)
      assert.equal(submits, 0)

      sched.stop()
      persistGate.resolve()
      await tickP
      const actual = {
        submits,
        heartbeats: sched.activeExecutionHeartbeatCount,
        activityBefore: frozen,
        activityAfter: store.snapshotOf(running[0]!.id)?.lastActivityAt,
        logicalTime: now,
      }
      reportContract('C-persist-pending-stop', { submits: 0, heartbeats: 0 }, actual)
      assert.equal(submits, 0, 'stopped scheduler must not enter sessions.submit')
      assert.equal(sched.activeExecutionHeartbeatCount, 0)
    } finally {
      persistGate.resolve()
      sched.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persistLastRun barrier then second-store adopt must not submit as the old owner', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-takeover-'))
    let now = 1_000_000
    const storeA = openStore(dir, { bootId: 'gw:owner-a', now: () => now })
    let storeB: ReturnType<typeof openStore> | undefined
    const persistStarted = deferred()
    const persistGate = deferred()
    let submits = 0
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async () => {
          submits++
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      } as any,
      async () => {},
    )
    try {
      writeDueJob()
      sched.delegateJobs = storeA
      const origPersist = (sched as any).persistLastRun.bind(sched)
      ;(sched as any).persistLastRun = async (value: Record<string, number>) => {
        persistStarted.resolve()
        await persistGate.promise
        return origPersist(value)
      }
      const tickP = (sched as any).tick() as Promise<void>
      await persistStarted.promise
      const original = storeA.listRunning()[0]
      assert.ok(original, 'actual scheduler must claim before pending persistence')
      const activityBefore = original.lastActivityAt
      now += 5_000
      storeB = openStore(dir, { bootId: 'gw:owner-b', now: () => now, hydrate: true })
      const adopted = storeB.adoptOrKill(original.id, original.fencingEpoch, 'running')
      assert.ok(adopted, 'real SQLite takeover must succeed')
      persistGate.resolve()
      await tickP
      const after = storeB.snapshotOf(original.id)
      const actual = {
        submits,
        adopted: Boolean(adopted),
        oldEpoch: original.fencingEpoch,
        newEpoch: adopted.fencingEpoch,
        interrupts: interrupted.length,
        currentState: after?.state,
        activityBefore,
        activityAfter: after?.lastActivityAt,
        logicalTime: now,
        oldToken: original.claimToken,
        newToken: after?.claimToken,
      }
      const expected = { submits: 0, oldEpoch: 1, newEpoch: 2, interrupts: 0 }
      reportContract('C-persist-resume-after-fence-takeover', expected, actual)
      assert.equal(actual.submits, 0, 'stale owner must not start submit after pending persistence resolves')
      assert.equal(actual.oldEpoch, 1)
      assert.equal(actual.newEpoch, 2)
      assert.notEqual(after?.claimToken, original.claimToken)
      assert.equal(interrupted.length, 0, 'old owner must not interrupt the new owner session')
    } finally {
      persistGate.resolve()
      sched.stop()
      storeA.close()
      storeB?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persistLastRun barrier then reaper closeout must not submit', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-reap-'))
    let now = 1_000_000
    const store = openStore(dir, { now: () => now })
    const persistStarted = deferred()
    const persistGate = deferred()
    let submits = 0
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async () => {
          submits++
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      } as any,
      async () => {},
    )
    try {
      writeDueJob()
      sched.delegateJobs = store
      const origPersist = (sched as any).persistLastRun.bind(sched)
      ;(sched as any).persistLastRun = async (value: Record<string, number>) => {
        persistStarted.resolve()
        await persistGate.promise
        return origPersist(value)
      }
      const tickP = (sched as any).tick() as Promise<void>
      await persistStarted.promise
      const original = store.listRunning()[0]
      assert.ok(original)
      const activityBefore = original.lastActivityAt
      now += 31 * 60_000
      const reaped = store.reapStaleRunning({ timeoutMs: 30 * 60_000 })
      persistGate.resolve()
      await tickP
      const after = store.snapshotOf(original.id)
      const actual = {
        submits,
        interrupts: interrupted.length,
        reaped: reaped.length,
        failureClass: reaped[0]?.job.failureClass,
        currentState: after?.state,
        activityBefore,
        activityAfter: after?.lastActivityAt,
        logicalTime: now,
        fenceEpoch: original.fencingEpoch,
      }
      reportContract(
        'C-persist-resume-after-reaper',
        { submits: 0, reaped: 1, failureClass: 'heartbeat_timeout' },
        actual,
      )
      assert.equal(actual.submits, 0)
      assert.equal(actual.reaped, 1)
      assert.equal(actual.failureClass, 'heartbeat_timeout')
    } finally {
      persistGate.resolve()
      sched.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('execution-boundary sqlite error must not start submit or look like a fence reject', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-dberr-'))
    let now = 1_000_000
    const store = openStore(dir, { now: () => now })
    const persistStarted = deferred()
    const persistGate = deferred()
    let submits = 0
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async () => {
          submits++
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      } as any,
      async () => {},
    )
    try {
      writeDueJob()
      sched.delegateJobs = store
      const origPersist = (sched as any).persistLastRun.bind(sched)
      ;(sched as any).persistLastRun = async (value: Record<string, number>) => {
        persistStarted.resolve()
        await persistGate.promise
        return origPersist(value)
      }
      const tickP = (sched as any).tick() as Promise<void>
      await persistStarted.promise
      const original = store.listRunning()[0]
      assert.ok(original)
      const activityBefore = original.lastActivityAt
      store.injectDurableWriteFailure()
      persistGate.resolve()
      await tickP
      const after = store.snapshotOf(original.id)
      const actual = {
        submits,
        interrupts: interrupted.length,
        currentState: after?.state,
        activityBefore,
        activityAfter: after?.lastActivityAt,
        fenceEpoch: after?.fencingEpoch,
        logicalTime: now,
      }
      reportContract(
        'C-persist-resume-sqlite-error',
        { submits: 0, interrupts: 0, stolen: false },
        actual,
      )
      assert.equal(actual.submits, 0, 'sqlite throw at submit boundary must not start the model')
      assert.equal(actual.interrupts, 0, 'sqlite throw is not a fence reject')
      assert.equal(after?.claimToken, original.claimToken, 'must not re-claim or steal the fence')
    } finally {
      persistGate.resolve()
      sched.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('submit success then hung destroy does not keep renewing', async () => {
    await assertDestroyBarrier('success', async (_session, _prompt, cb) => {
      cb({ kind: 'block', block: { kind: 'text', text: 'cron job completed with real output' } })
    })
  })

  it('submit throw then hung destroy does not keep renewing', async () => {
    await assertDestroyBarrier('throw', async () => {
      throw new Error('upstream failed after tools')
    })
  })

  it('submit cancel then hung destroy does not keep renewing', async () => {
    await assertDestroyBarrier('cancel', async () => {
      const err = Object.assign(new Error('interrupted'), { code: 'TURN_INTERRUPTED' })
      throw err
    })
  })

  it('origin-session inject/ACK pending archive creates no local heartbeat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-origin-'))
    let now = 1_000_000
    const clock = createManualClock(
      () => now,
      (value) => {
        now = value
      },
    )
    const store = openStore(dir, { now: () => now })
    writeDueJob({
      id: 'live-origin',
      resume: 'origin-session',
      sourceSessionKey: 'agent:main:webchat:dm:sess-origin',
    })
    const claimed = deferred()
    const archiveGate = deferred()
    let submits = 0
    let injects = 0
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async () => {
          submits++
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      } as any,
      async () => {},
      async () => {
        injects++
        return { kind: 'injected' }
      },
    )
    sched.delegateJobs = store
    sched.delegateHeartbeatMs = INTERVAL
    sched.heartbeatSetInterval = clock.setInterval as typeof setInterval
    sched.heartbeatClearInterval = clock.clearInterval as typeof clearInterval
    sched.afterOriginClaim = async () => {
      claimed.resolve()
      await archiveGate.promise
    }

    const tickP = (sched as any).tick() as Promise<void>
    try {
      await claimed.promise
      assert.equal(submits, 0)
      assert.equal(sched.activeExecutionHeartbeatCount, 0)
      const running = store.listRunning()
      assert.equal(running.length, 1)
      const frozen = running[0]!.lastActivityAt
      clock.beats(12)
      assert.equal(store.snapshotOf(running[0]!.id)!.lastActivityAt, frozen)
      assert.equal(interrupted.length, 0)
      archiveGate.resolve()
      await tickP
      reportContract(
        'C-origin-no-local-hb',
        { submits: 0, heartbeats: 0, interrupts: 0 },
        {
          submits,
          injects,
          heartbeats: sched.activeExecutionHeartbeatCount,
          interrupts: interrupted.length,
          activityBefore: frozen,
          activityAfter: store.snapshotOf(running[0]!.id)?.lastActivityAt,
          logicalTime: now,
        },
      )
      assert.equal(submits, 0)
      assert.equal(sched.activeExecutionHeartbeatCount, 0)
    } finally {
      archiveGate.resolve()
      sched.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop during submit stops renewal; queued callback and the next due job cannot start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-stop-'))
    let now = 1_000_000
    const clock = createManualClock(
      () => now,
      (value) => {
        now = value
      },
    )
    const store = openStore(dir, { now: () => now })
    writeTwoDueJobs()
    const submitted = deferred()
    const submitGate = deferred()
    let submits = 0
    const interrupted: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        submit: async (_s: unknown, _p: unknown, cb: (e: any) => void) => {
          submits++
          submitted.resolve()
          await submitGate.promise
          cb({ kind: 'block', block: { kind: 'text', text: 'cron job completed with real output' } })
        },
        destroySession: async () => {},
        interrupt: (key: string) => {
          interrupted.push(key)
          return true
        },
      } as any,
      async () => {},
    )
    sched.delegateJobs = store
    sched.delegateHeartbeatMs = INTERVAL
    sched.heartbeatSetInterval = clock.setInterval as typeof setInterval
    sched.heartbeatClearInterval = clock.clearInterval as typeof clearInterval

    const tickP = (sched as any).tick() as Promise<void>
    await submitted.promise
    assert.equal(submits, 1)
    clock.beats(3)
    const jobId = store.listRunning()[0]!.id
    const beforeStop = store.snapshotOf(jobId)!.lastActivityAt!
    const queued = clock.captureCallback()
    sched.stop()
    assert.equal(sched.activeExecutionHeartbeatCount, 0)
    clock.beats(6)
    if (queued) queued()
    assert.equal(store.snapshotOf(jobId)!.lastActivityAt, beforeStop)
    submitGate.resolve()
    await tickP
    assert.equal(submits, 1, 'second due job must not submit after stop')
    assert.equal(interrupted.length, 0)
    const lateTick = (sched as any).tick() as Promise<void>
    await lateTick
    reportContract(
      'C-stop-next-job',
      { submits: 1, interrupts: 0 },
      {
        submits,
        interrupts: interrupted.length,
        activityBefore: beforeStop,
        activityAfter: store.snapshotOf(jobId)?.lastActivityAt,
        logicalTime: now,
      },
    )
    assert.equal(submits, 1, 'a tick queued after stop must not start work')
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

async function assertDestroyBarrier(
  _label: string,
  submitImpl: (session: unknown, prompt: unknown, cb: (e: any) => void) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cron-sched-destroy-'))
  let now = 1_000_000
  const clock = createManualClock(
    () => now,
    (value) => {
      now = value
    },
  )
  const store = openStore(dir, { now: () => now })
  writeDueJob()
  const destroyStarted = deferred()
  const destroyGate = deferred()
  const interrupted: string[] = []
  const sched = new CronScheduler(
    { defaults: { model: 'glm-5.2' } } as any,
    {
      getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
      submit: submitImpl,
      destroySession: async () => {
        destroyStarted.resolve()
        await destroyGate.promise
      },
      interrupt: (key: string) => {
        interrupted.push(key)
        return true
      },
    } as any,
    async () => {},
  )
  sched.delegateJobs = store
  sched.delegateHeartbeatMs = INTERVAL
  sched.heartbeatSetInterval = clock.setInterval as typeof setInterval
  sched.heartbeatClearInterval = clock.clearInterval as typeof clearInterval

  const tickP = (sched as any).tick() as Promise<void>
  try {
    await destroyStarted.promise
    assert.equal(sched.activeExecutionHeartbeatCount, 0, 'heartbeat must stop before destroy')
    const row = store.listNonTerminal()[0]
    assert.ok(row, 'row still exists while destroy is pending')
    const frozen = row.lastActivityAt
    clock.beats(10)
    const after = store.snapshotOf(row.id)
    reportContract(
      `C-destroy-barrier-${_label}`,
      { heartbeats: 0, interrupts: 0 },
      {
        heartbeats: sched.activeExecutionHeartbeatCount,
        interrupts: interrupted.length,
        activityBefore: frozen,
        activityAfter: after?.lastActivityAt,
        logicalTime: now,
      },
    )
    assert.equal(after?.lastActivityAt, frozen, 'destroy barrier must not be covered by heartbeat writes')
    assert.equal(interrupted.length, 0)
    destroyGate.resolve()
    await tickP
  } finally {
    destroyGate.resolve()
    sched.stop()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

class HangRunner extends EventEmitter {
  lastActivityAt = Date.now()
  isRunning = true
  pendingToolCalls = 0

  async start() {
    this.isRunning = true
  }
  interrupt() {
    this.emit('message', {
      type: 'result',
      total_cost_usd: 0,
      usage: {},
      is_error: false,
      stop_reason: 'end_turn',
    })
    return true
  }
  async shutdown() {}
  clearSessionId() {}
  async waitForOutputDrain() {}
  async submit() {
    // Return immediately so SessionManager can arm the 15s liveness timer.
    // The turn stays open until a result event or interrupt.
  }
}

function makeCcbSession(runner: HangRunner, sessionKey = 'agent:main:cron:dm:live-wait:test') {
  const adapter = new CcbAdapter({} as any, runner as any)
  return {
    sessionKey,
    agentId: 'main',
    channel: 'cron',
    peerId: 'live-wait',
    title: '[cron] live-wait',
    startedAt: Date.now(),
    runner: adapter,
    ccbSessionId: 'ccb-cron-wait',
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    // Non-zero skips getMaxTurnIdx FTS (same seam as sessionManagerCodexBillingGuard).
    turns: 3,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' },
    providerTag: 'ccb',
    agentProvider: undefined,
  } as any
}

async function waitForLivenessTimer(
  timers: Array<{ id: number; fn: () => void; ms: number }>,
  pending: Promise<unknown>,
) {
  for (let i = 0; i < 80; i++) {
    const hit = timers.find((t) => t.ms === 15_000)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 25))
  }
  const settled = await Promise.race([
    pending.then(
      () => 'resolved',
      (err) => `rejected:${String(err)}`,
    ),
    new Promise<string>((r) => setTimeout(() => r('still-pending'), 0)),
  ])
  throw new assert.AssertionError({
    message: `submit must arm the 15s liveness timer (submit=${settled}, timers=${timers.map((t) => t.ms).join(',')})`,
    expected: true,
    actual: false,
  })
}

describe('OCV5-188 SessionManager idle / 12h wiring still owns the deadline', () => {
  it('non-waiting silence trips idle; waiting skips idle at 2h; 12h hard limit still fires', { timeout: 15_000 }, async () => {
    const origNow = Date.now
    const origSetInterval = globalThis.setInterval
    const origClearInterval = globalThis.clearInterval
    let now = 5_000_000
    const timers: Array<{ id: number; fn: () => void; ms: number }> = []
    let nextId = 1
    Date.now = () => now
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = nextId++
      timers.push({ id, fn, ms: Number(ms) || 0 })
      return Object.assign(id, { unref() {} }) as unknown as NodeJS.Timeout
    }) as typeof setInterval
    globalThis.clearInterval = ((handle: NodeJS.Timeout) => {
      const idx = timers.findIndex((t) => t.id === (handle as unknown as number))
      if (idx >= 0) timers.splice(idx, 1)
    }) as typeof clearInterval

    try {
      const idleEvents: string[] = []
      const smIdle = new SessionManager({
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: '' },
      } as any)
      ;(smIdle as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
      const idleRunner = new HangRunner()
      idleRunner.lastActivityAt = now
      const idleSession = makeCcbSession(idleRunner, 'agent:main:cron:dm:idle-wd:test')
      const idleP = smIdle.submit(idleSession, 'silent work', (e: any) => {
        if (e?.kind === 'error') idleEvents.push(String(e.error))
      })
      const idleTimer = await waitForLivenessTimer(timers, idleP)
      now += IDLE_TIMEOUT_TOOL_MS + 1
      idleTimer.fn()
      await idleP
      assert.ok(
        idleEvents.some((msg) => msg.includes('无输出') || msg.includes('免单')),
        `idle watchdog must fire through submit, got ${JSON.stringify(idleEvents)}`,
      )

      timers.length = 0
      const waitEvents: string[] = []
      const smWait = new SessionManager({
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: '' },
      } as any)
      ;(smWait as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}
      const waitRunner = new HangRunner()
      waitRunner.lastActivityAt = now
      const waitSession = makeCcbSession(waitRunner, 'agent:main:cron:dm:wait-wd:test')
      Object.defineProperty(waitSession.runner, 'waitingForUserInput', {
        get: () => true,
        configurable: true,
      })
      let waitSettled = false
      const waitP = smWait
        .submit(waitSession, 'need user', (e: any) => {
          if (e?.kind === 'error') waitEvents.push(String(e.error))
        })
        .finally(() => {
          waitSettled = true
        })
      const waitTimer = await waitForLivenessTimer(timers, waitP)
      const started = now
      now += 2 * 60 * 60_000
      waitTimer.fn()
      await new Promise((r) => setImmediate(r))
      const waitingSettledAfter2h = waitSettled
      assert.equal(waitSettled, false, 'waiting turn must not idle-timeout at 2h')
      assert.equal(waitEvents.length, 0)
      now = started + AUTHORITY_TURN_MAX_LIFETIME_MS
      waitTimer.fn()
      await waitP
      assert.ok(
        waitEvents.some((msg) => msg.includes('12 小时') || msg.includes('上限')),
        `12h hard limit must still fire while waiting, got ${JSON.stringify(waitEvents)}`,
      )
      reportContract(
        'C-sm-idle-12h',
        { layer: 'session-manager-submit', idleTripped: true, waitingSkips2h: true, hardLimitAt12h: true },
        {
          layer: 'session-manager-submit',
          notCronSchedulerSubmit: true,
          idleEvents,
          waitEvents,
          waitingSettledAfter2h,
        },
      )
    } finally {
      Date.now = origNow
      globalThis.setInterval = origSetInterval
      globalThis.clearInterval = origClearInterval
    }
  })
})

