import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DelegateResumeRegistry } from '../delegateResume.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'
import { _setPlatformPricingLookupForTests } from '../usageCost.js'
import { openTaskboardDb } from '../taskboard/db/index.js'
import { createPipeline, createStage } from '../taskboard/db/pipelines.js'
import { createProject } from '../taskboard/db/projects.js'
import { getActiveLease, getRun, listRuns, reapExpiredLeases } from '../taskboard/db/runs.js'
import { createTicket, getTicket } from '../taskboard/db/tickets.js'
import { PatrolSlotCounter, IdleBackoffState } from '../taskboard/guardrails.js'
import { handleTaskboardApi } from '../taskboard/http.js'
import { PatrolEngine, resetSharedPatrolState } from '../taskboard/patrol.js'
import { taskboardRunControls } from '../taskboard/runControl.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitPoint(point: ReturnType<typeof deferred>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      point.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runtime fixture did not reach ${label}`)), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Only runner/SessionManager boundaries are simulated. Gateway wrapper/core,
// cancellation, descendant finally, resume claims and Patrol settlement are real.
function fixture(runTurn: (session: any, emit: (event: any) => void) => Promise<void>) {
  const gw = Object.create(Gateway.prototype) as any
  Object.assign(gw, {
    _shuttingDown: false,
    clientsByPeer: new Map(),
    lastActiveChannel: new Map(),
    _seenIdempotencyKeys: new Map(),
    _activeDelegations: 0,
    _activeDelegationsByParent: new Map(),
    _hiddenDelegateGuard: new PerTurnDelegationGuard(),
    _delegateResume: new DelegateResumeRegistry(),
    _readDelegateMemoryPressure: () => null,
    rateLimiter: { check: () => true },
    _isIdempotencyDuplicate: () => false,
    _markIdempotencyKey: () => {},
    _runLog: { start: () => ({}), complete: () => {} },
    deliver: () => {},
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    _delegateEngineBilling: {
      admit: async () => ({
        requestId: 'ab'.repeat(16),
        engineSessionId: `oceng-${'b'.repeat(48)}`,
      }),
      settle: async () => {},
      abandon: async () => {},
    },
    deps: {
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 'fixture' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/fixture-ccb' },
        defaults: { model: 'glm-5.2', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      },
    },
    _getAgentsConfig: async () => ({
      default: 'coding-assistant',
      agents: [
        { id: 'coding-assistant', model: 'glm-5.2' },
        { id: 'worker', model: 'glm-5.2' },
      ],
    }),
  })
  const live = new Map<string, any>()
  const resumed = new Map<string, Record<string, unknown>>()
  const hooks = { destroy: async (_key: string) => {}, retire: async (_key: string) => {} }
  gw.sessions = {
    getByKey: (key: string) => live.get(key),
    hasLiveSession: (key: string) => live.has(key),
    beginClientTurn() {},
    endClientTurn() {},
    flushSessionTailFolding: async () => {},
    bufferPendingAgentGroup: () => true,
    forgetResume: (key: string) => resumed.delete(key),
    getOrCreate: async (opts: any) => {
      if (live.has(opts.sessionKey)) return live.get(opts.sessionKey)
      let session: any
      const runner: any = new EventEmitter()
      runner.model = opts.model ?? opts.agent.model
      runner.engineId = 'ccb'
      runner.interrupt = () => session.stop?.() ?? false
      runner.shutdown = async () => {
        session.stop?.()
      }
      runner.waitForOutputDrain = async () => {}
      runner.sendPermissionResponse = () => {}
      session = {
        sessionKey: opts.sessionKey,
        agentId: opts.agent.id,
        channel: opts.channel ?? 'delegate',
        peerId: opts.peerId,
        repoSessionId: opts.repoSessionId ?? opts.peerId,
        parentSessionKey: opts.parentSessionKey,
        projectId: opts.projectId,
        workspaceCwd: opts.workspaceCwd,
        model: runner.model,
        providerTag: 'ccb',
        runner,
        currentTurnStatus: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUSD: 0,
        costImprecise: false,
        ...resumed.get(opts.sessionKey),
      }
      live.set(opts.sessionKey, session)
      return session
    },
    submit: async (session: any, _prompt: string, emit: (event: any) => void) => {
      session.currentTurnStatus = 'running'
      try {
        await runTurn(session, emit)
      } finally {
        session.currentTurnStatus = null
        session.stop = undefined
      }
    },
    interrupt: (key: string) => live.get(key)?.stop?.() ?? false,
    destroySession: async (key: string) => {
      await hooks.destroy(key)
      live.delete(key)
    },
    retireKeepResume: async (key: string) => {
      await hooks.retire(key)
      const session = live.get(key)
      if (session)
        resumed.set(key, {
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          totalCostUSD: session.totalCostUSD,
          costImprecise: session.costImprecise,
        })
      live.delete(key)
    },
  }
  sandbox.trackGateway(gw)
  const db = openTaskboardDb(join(sandbox.root, 'taskboard.db'))
  const project = createProject(db, { key: 'REAL', name: 'Runtime fixture' })
  const pipeline = createPipeline(db, {
    projectId: project.id,
    name: 'One stage',
    ticketType: 'feature',
    isDefault: true,
  })
  const stage = createStage(db, {
    pipelineId: pipeline.id,
    ordinal: 0,
    name: 'Execute',
    kind: 'ai',
    agentId: 'coding-assistant',
    promptTemplate: '执行 {{ticket.title}}',
    patrolEnabled: true,
    patrolCron: '* * * * *',
    quietHoursStart: 0,
    quietHoursEnd: 0,
    onSuccess: 'wait_human',
    onFailure: 'retry',
    model: 'glm-5.2',
  })
  const ticket = createTicket(db, {
    projectId: project.id,
    type: 'feature',
    title: 'Real runtime',
    reporter: 'user:765',
    pipelineId: pipeline.id,
    stageId: stage.id,
    status: 'ready',
  })
  let now = Date.now()
  let lookups = 0
  const slots = new PatrolSlotCounter(2)
  const engine = new PatrolEngine({
    getDb: () => db,
    delegate: gw._runTaskboardDelegate.bind(gw),
    preflightStages: async (stages) => stages.map(() => null),
    now: () => now,
    slots,
    idle: new IdleBackoffState(),
    lookupUsage: async () => {
      lookups += 1
      return { tokensIn: 100, tokensOut: 20, costUsd: 0.01 }
    },
    usageBackfillDelayMs: 10,
  })
  return {
    gw,
    db,
    stage,
    ticket,
    engine,
    hooks,
    slots,
    live,
    resumed,
    setNow: (value: number) => {
      now = value
    },
    getLookups: () => lookups,
  }
}

function output(
  session: any,
  emit: (event: any) => void,
  text: string,
  tokens: number,
  cost: number,
) {
  session.totalInputTokens += tokens
  session.totalOutputTokens += tokens
  session.totalCostUSD += cost
  emit({ kind: 'block', block: { kind: 'text', text } })
}
function cancellable(session: any, emit: (event: any) => void, gate: ReturnType<typeof deferred>) {
  let stopped = false
  session.stop = () => {
    if (stopped) return false
    stopped = true
    emit({ kind: 'error', error: 'USER_CANCELLED: stopped', errorCode: 'user_cancelled' })
    gate.resolve()
    return true
  }
}
async function stop(f: ReturnType<typeof fixture>, run: NonNullable<ReturnType<typeof getRun>>) {
  const server = createServer((req, res) => {
    void handleTaskboardApi(req, res, { db: f.db, actor: 'human' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/api/board/tickets/${f.ticket.id}/stop`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: getTicket(f.db, f.ticket.id)!.version,
          runId: run.id,
        }),
      },
    )
    assert.equal(response.status, 202, await response.text())
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

for (const rootFinishesFirst of [false, true])
  test(
    `real core joins child cleanup when stop follows root completion=${rootFinishesFirst}`,
    { timeout: 15_000 },
    async () => {
      const rootGate = deferred()
      const childGate = deferred()
      const rootStarted = deferred()
      const childStarted = deferred()
      const cleanupEntered = deferred()
      const cleanupGate = deferred()
      const rootText = `ROOT_BEGIN${'完整主结果'.repeat(2000)}ROOT_END`
      const childText = `CHILD_BEGIN${'完整子结果'.repeat(2000)}CHILD_END`
      let rootKey = ''
      const f = fixture(async (session, emit) => {
        const root = session.channel === 'taskboard'
        output(session, emit, root ? rootText : childText, root ? 10 : 3, root ? 0.1 : 0.03)
        const gate = root ? rootGate : childGate
        cancellable(session, emit, gate)
        if (root) {
          rootKey = session.sessionKey
          rootStarted.resolve()
        } else childStarted.resolve()
        await gate.promise
        emit({ kind: 'final', meta: { turn: 1 } })
      })
      let settled = false
      const ticking = f.engine.tick().then((value) => {
        settled = true
        return value
      })
      let child: Promise<any> | undefined
      try {
        await waitPoint(rootStarted, 'rootStarted')
        const childKey = `agent:worker:delegate:runtime-child:${f.ticket.id}`
        f.hooks.destroy = async (key) => {
          if (key === childKey) {
            cleanupEntered.resolve()
            await cleanupGate.promise
          }
        }
        child = f.gw._runDelegateTask({
          targetAgentId: 'worker',
          sourceAgent: 'coding-assistant',
          parentSessionKey: rootKey,
          sessionKey: childKey,
          goal: 'child',
          depth: 1,
        })
        await waitPoint(childStarted, 'childStarted')
        if (rootFinishesFirst) rootGate.resolve()
        childGate.resolve()
        await waitPoint(cleanupEntered, 'cleanupEntered')
        const run = listRuns(f.db, { ticketId: f.ticket.id }).items[0]!
        await stop(f, run)
        assert.equal(settled, false)
        assert.equal(getRun(f.db, run.id)!.status, 'running')
        assert.ok(getActiveLease(f.db, f.ticket.id, Date.now()))
        cleanupGate.resolve()
        await child
        await ticking
        const archived = getRun(f.db, run.id)!
        assert.ok(archived.outputMd?.includes(rootText))
        assert.ok(archived.outputMd?.includes(childText))
        assert.equal(archived.tokensIn, 13)
        assert.ok(Math.abs(archived.costUsd! - 0.13) < 1e-9)
        if (!rootFinishesFirst) assert.match(archived.error!, /^USER_CANCELLED:/)
        assert.equal(getTicket(f.db, f.ticket.id)!.status, 'blocked')
      } finally {
        rootGate.resolve()
        childGate.resolve()
        cleanupGate.resolve()
        await Promise.allSettled([ticking, ...(child ? [child] : [])])
        resetSharedPatrolState()
        f.db.close()
      }
    },
  )

test(
  'real resumable core records cumulative 3 then 5 as execution deltas 3 plus 2',
  { timeout: 15_000 },
  async () => {
    const rootGate = deferred()
    const rootStarted = deferred()
    const retirementEntered = deferred()
    const retirementGate = deferred()
    let rootKey = ''
    let turns = 0
    const f = fixture(async (session, emit) => {
      if (session.channel === 'taskboard') {
        rootKey = session.sessionKey
        output(session, emit, 'ROOT_FINAL', 10, 0.1)
        rootStarted.resolve()
        await rootGate.promise
      } else {
        turns += 1
        output(
          session,
          emit,
          `CHILD_EXECUTION_${turns}_END`,
          turns === 1 ? 3 : 2,
          turns === 1 ? 0.03 : 0.02,
        )
      }
      emit({ kind: 'final', meta: { turn: 1 } })
    })
    const ticking = f.engine.tick()
    try {
      await waitPoint(rootStarted, 'rootStarted')
      const tuple = {
        parentSessionKey: rootKey,
        targetAgentId: 'worker',
        sourceAgent: 'coding-assistant',
      }
      const claim = f.gw._delegateResume.preflight({ ...tuple, idempotencyKey: 'resume-1' })
      assert.equal(claim.ok, true)
      f.hooks.retire = async (key) => {
        if (key === claim.sessionKey && turns === 1) {
          retirementEntered.resolve()
          await retirementGate.promise
        }
      }
      const first = f.gw._runDelegateTask({
        ...tuple,
        goal: 'first',
        depth: 1,
        resumable: true,
        sessionKey: claim.sessionKey,
        resumeMinted: claim.minted,
      })
      await waitPoint(retirementEntered, 'retirementEntered')
      assert.equal(
        f.gw._delegateResume.preflight({
          ...tuple,
          resumeSessionKey: claim.sessionKey,
          idempotencyKey: 'too-early',
        }).ok,
        false,
      )
      retirementGate.resolve()
      const one = await first
      assert.equal(one.kind, 'completed')
      assert.equal(one.tokensIn, 3)
      assert.ok(Math.abs(one.costUsd - 0.03) < 1e-9)
      const resumed = f.gw._delegateResume.preflight({
        ...tuple,
        resumeSessionKey: claim.sessionKey,
        idempotencyKey: 'resume-2',
      })
      assert.equal(resumed.ok, true)
      const two = await f.gw._runDelegateTask({
        ...tuple,
        goal: 'second',
        depth: 1,
        resumable: true,
        sessionKey: resumed.sessionKey,
        resumeMinted: resumed.minted,
      })
      assert.equal(two.kind, 'completed')
      assert.equal(two.tokensIn, 2)
      assert.ok(Math.abs(two.costUsd - 0.02) < 1e-9)
      assert.equal(f.resumed.get(claim.sessionKey)?.totalInputTokens, 5)
      rootGate.resolve()
      await ticking
      const run = listRuns(f.db, { ticketId: f.ticket.id }).items[0]!
      assert.equal(run.tokensIn, 15)
      assert.ok(Math.abs(run.costUsd! - 0.15) < 1e-9)
      assert.equal(run.outputMd!.split('CHILD_EXECUTION_1_END').length - 1, 1)
      assert.equal(run.outputMd!.split('CHILD_EXECUTION_2_END').length - 1, 1)
    } finally {
      rootGate.resolve()
      retirementGate.resolve()
      await Promise.allSettled([ticking])
      resetSharedPatrolState()
      f.db.close()
    }
  },
)

test(
  'real descendant unknown reference usage never receives root-only immediate or delayed backfill',
  { timeout: 15_000 },
  async () => {
    const rootGate = deferred()
    const rootStarted = deferred()
    let rootKey = ''
    _setPlatformPricingLookupForTests(async () => null)
    const f = fixture(async (session, emit) => {
      if (session.channel === 'taskboard') {
        rootKey = session.sessionKey
        output(session, emit, 'ROOT_KNOWN', 100, 0.01)
        session.totalOutputTokens = 20
        rootStarted.resolve()
        await rootGate.promise
      } else {
        output(session, emit, 'CHILD_UNKNOWN_COST', 0, 0)
        session.totalOutputTokens = 2
      }
      emit({ kind: 'final', meta: { turn: 1 } })
    })
    const ticking = f.engine.tick()
    try {
      await waitPoint(rootStarted, 'rootStarted')
      const child = await f.gw._runDelegateTask({
        targetAgentId: 'worker',
        sourceAgent: 'coding-assistant',
        parentSessionKey: rootKey,
        sessionKey: 'agent:worker:delegate:unknown-child',
        goal: 'child',
        depth: 1,
      })
      assert.equal(child.kind, 'completed')
      assert.equal(child.costUsd, null)
      rootGate.resolve()
      await ticking
      await delay(30)
      const run = listRuns(f.db, { ticketId: f.ticket.id }).items[0]!
      assert.equal(run.tokensIn, null)
      assert.equal(run.tokensOut, 22)
      assert.equal(run.costUsd, null)
      assert.equal(run.costImprecise, true)
      assert.equal(f.getLookups(), 0)
    } finally {
      rootGate.resolve()
      await Promise.allSettled([ticking])
      resetSharedPatrolState()
      f.db.close()
      _setPlatformPricingLookupForTests(null)
    }
  },
)

test(
  'real paid output stays reachable on its expired old run without reviving authority',
  { timeout: 15_000 },
  async () => {
    const rootGate = deferred()
    const rootStarted = deferred()
    const full = `PAID_BEGIN${'长结果'.repeat(2000)}PAID_END`
    const f = fixture(async (session, emit) => {
      output(session, emit, full, 2, 0.02)
      rootStarted.resolve()
      await rootGate.promise
      emit({ kind: 'final', meta: { turn: 1 } })
    })
    const ticking = f.engine.tick()
    try {
      await waitPoint(rootStarted, 'rootStarted')
      const old = listRuns(f.db, { ticketId: f.ticket.id }).items[0]!
      f.setNow(old.leaseExpiresAt! + 1)
      reapExpiredLeases(f.db, old.leaseExpiresAt! + 1)
      const fenced = getRun(f.db, old.id)!
      rootGate.resolve()
      await ticking
      const after = getRun(f.db, old.id)!
      assert.deepEqual({ ...after, outputMd: null }, fenced)
      assert.equal(after.outputMd, full)
      assert.equal(after.status, 'timeout')
      assert.equal(after.leaseOwner, null)
      assert.equal(f.getLookups(), 0)
    } finally {
      rootGate.resolve()
      await Promise.allSettled([ticking])
      resetSharedPatrolState()
      f.db.close()
    }
  },
)

test(
  'the ninth independent taskboard run starts without consuming prior runs delegation budgets',
  { timeout: 15_000 },
  async () => {
    let submits = 0
    const f = fixture(async (session, emit) => {
      submits += 1
      output(session, emit, `TASK_${submits}_END`, 1, 0.01)
      emit({ kind: 'final', meta: { turn: 1 } })
    })
    try {
      for (let index = 0; index < 9; index += 1) {
        if (index > 0)
          createTicket(f.db, {
            projectId: f.ticket.projectId,
            type: 'feature',
            title: `Independent task ${index}`,
            reporter: 'user:765',
            pipelineId: f.ticket.pipelineId,
            stageId: f.stage.id,
            status: 'ready',
          })
        await f.engine.tick()
      }
      assert.equal(submits, 9)
      const runs = listRuns(f.db, { limit: 100 }).items
      assert.equal(runs.length, 9)
      assert.ok(runs.every((run) => run.status === 'succeeded'))
      assert.equal(new Set(runs.map((run) => run.sessionKey)).size, 9)
    } finally {
      resetSharedPatrolState()
      f.db.close()
    }
  },
)

test(
  'one live taskboard root retains the existing eight-member turn limit',
  { timeout: 15_000 },
  async () => {
    const rootStarted = deferred()
    const rootGate = deferred()
    let rootKey = ''
    const f = fixture(async (session, emit) => {
      output(session, emit, 'LIMIT_PROOF_OUTPUT', 1, 0.01)
      if (session.channel === 'taskboard') {
        rootKey = session.sessionKey
        rootStarted.resolve()
        await rootGate.promise
      }
      emit({ kind: 'final', meta: { turn: 1 } })
    })
    const ticking = f.engine.tick()
    try {
      await waitPoint(rootStarted, 'rootStarted')
      for (let index = 0; index < 9; index += 1) {
        const result = await f.gw._runDelegateTask({
          targetAgentId: 'worker',
          sourceAgent: 'coding-assistant',
          parentSessionKey: rootKey,
          sessionKey: `agent:worker:delegate:limit:${f.ticket.id}:${index}`,
          goal: `member ${index}`,
          depth: 1,
        })
        if (index < 8) assert.equal(result.kind, 'completed', JSON.stringify(result))
        else {
          assert.equal(result.kind, 'rejected')
          assert.equal(result.httpStatus, 429)
          assert.match(result.message, /上限/)
        }
      }
      rootGate.resolve()
      await ticking
      assert.equal(listRuns(f.db, { ticketId: f.ticket.id }).items[0]!.tokensIn, 9)
    } finally {
      rootGate.resolve()
      await Promise.allSettled([ticking])
      resetSharedPatrolState()
      f.db.close()
    }
  },
)
