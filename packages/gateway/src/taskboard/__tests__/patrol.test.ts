/**
 * 巡检 tick 引擎。验收:建需求单 → 批准 → mock delegate 驱动 tick →
 * 自动走完多个 stage 到 waiting_human。库落 os.tmpdir(),不碰 ~/.openclaude,
 * 不真调模型。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/patrol.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createActivity } from '../db/activity.js'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import {
  createPipeline,
  createStage,
  getDefaultPipeline,
  listStages,
  updateStage,
} from '../db/pipelines.js'
import { createProject } from '../db/projects.js'
import { addRelation } from '../db/relations.js'
import { acquireLease, listRuns } from '../db/runs.js'
import { seedDefaultPipelines } from '../db/seed.js'
import { getSettings, getUsage, updateSettings } from '../db/settings.js'
import { createTicket, getTicket, updateTicket } from '../db/tickets.js'
import { type GuardrailAlertHandler, IdleBackoffState, PatrolSlotCounter } from '../guardrails.js'
import {
  type PatrolDelegateFn,
  type PatrolDelegateResult,
  PatrolEngine,
  type RunUsageLookup,
  resetSharedPatrolState,
} from '../patrol.js'
import { assertTransition } from '../stateMachine.js'

const dirs: string[] = []

// 上海周一 10:00。种子 cron 是每 30 分钟、工作日 9-19;本测试会改成每分钟。
const WORK = new Date('2026-08-17T02:00:00.000Z')
// 上海周一 00:00,落在默认静默 23:00-08:00。
const QUIET = new Date('2026-08-16T16:00:00.000Z')

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-patrol-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  resetSharedPatrolState()
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function okDelegate(output = '本阶段已完成。对照 checklist 均有证据。'): PatrolDelegateFn {
  return async (input) => {
    assert.match(input.sessionKey, /^agent:[^:]+:taskboard:/)
    return { ok: true, output }
  }
}

function failDelegate(error = 'boom'): PatrolDelegateFn {
  return async () => ({ ok: false, output: '', error })
}

function engine(
  db: TaskboardDb,
  delegate: PatrolDelegateFn,
  over: {
    slots?: PatrolSlotCounter
    idle?: IdleBackoffState
    now?: () => number
    lookupUsage?: RunUsageLookup
    usageBackfillDelayMs?: number
    onAlert?: GuardrailAlertHandler
    log?: (msg: string, extra?: Record<string, unknown>) => void
  } = {},
): PatrolEngine {
  return new PatrolEngine({
    getDb: () => db,
    delegate,
    now: over.now ?? (() => WORK.getTime()),
    slots: over.slots ?? new PatrolSlotCounter(2),
    idle: over.idle ?? new IdleBackoffState(),
    // 测试禁止打真实 sessions.db;延迟回填默认关掉,避免 setTimeout 挂住进程。
    lookupUsage: over.lookupUsage ?? (async () => null),
    usageBackfillDelayMs: over.usageBackfillDelayMs ?? 0,
    onAlert: over.onAlert,
    log: over.log,
  })
}

function approve(db: TaskboardDb, ticketId: string): void {
  const t = getTicket(db, ticketId)
  if (!t) throw new Error('missing ticket')
  assertTransition({ from: t.status, to: 'ready', actor: 'human' })
  updateTicket(db, t.id, t.version, { status: 'ready' })
}

function makeStagesAlwaysDue(db: TaskboardDb, pipelineId: string): void {
  for (const s of listStages(db, pipelineId)) {
    if (s.kind !== 'ai') continue
    updateStage(db, s.id, {
      patrolCron: '* * * * *',
      quietHoursStart: 0,
      quietHoursEnd: 0,
      patrolEnabled: true,
    })
  }
}

describe('端到端:需求单无人干预走到 waiting_human', () => {
  it('建单 → 批准 → 两轮 tick 自动推进需求澄清与方案设计', async () => {
    const db = freshDb()
    const project = createProject(db, { key: 'OCV5', name: 'V5 自用' })
    seedDefaultPipelines(db, project.id)
    const pipeline = getDefaultPipeline(db, project.id, 'feature')
    assert.ok(pipeline)
    const stages = listStages(db, pipeline.id)
    makeStagesAlwaysDue(db, pipeline.id)
    const ticket = createTicket(db, {
      projectId: project.id,
      type: 'feature',
      title: '任务面板巡检引擎',
      body: '让一张单自动走到等我确认。',
      reporter: 'user:default',
      pipelineId: pipeline.id,
      stageId: stages[0].id,
    })
    approve(db, ticket.id)

    const calls: string[] = []
    const delegate: PatrolDelegateFn = async (input) => {
      calls.push(input.sessionKey)
      // stage 种子 id 含 `::`,不能按冒号切段;前缀与 isPatrolSessionKey 才是契约。
      assert.ok(input.sessionKey.startsWith(`agent:${input.agentId}:taskboard:${ticket.id}:`))
      assert.match(input.goal, /exit checklist/)
      assert.match(input.goal, /产出格式要求/)
      return { ok: true, output: `已完成「${calls.length}」站。\n\n证据: mock。` }
    }

    const eng = engine(db, delegate)
    const first = await eng.tick(WORK)
    assert.equal(first.started, 1, JSON.stringify(first))
    assert.equal(first.settled, 1)
    const afterFirst = getTicket(db, ticket.id)
    assert.ok(afterFirst)
    assert.equal(afterFirst.status, 'ready')
    const design = stages.find((s) => s.name === '方案设计')
    assert.equal(afterFirst.stageId, design?.id)

    const second = await eng.tick(WORK)
    assert.equal(second.started, 1, JSON.stringify(second))
    const afterSecond = getTicket(db, ticket.id)
    assert.ok(afterSecond)
    assert.equal(afterSecond.status, 'waiting_human')
    assert.equal(calls.length, 2)

    const runs = listRuns(db, { ticketId: ticket.id, limit: 20, offset: 0 })
    const succeeded = runs.items.filter((r) => r.status === 'succeeded')
    assert.equal(succeeded.length, 2)
    for (const run of succeeded) {
      assert.ok(run.sessionKey && /^agent:[^:]+:taskboard:/.test(run.sessionKey))
      assert.ok(run.summary)
      assert.ok(run.outputMd)
    }
    db.close()
  })
})

describe('lease 互斥', () => {
  it('已有未过期 lease 时本轮不双跑,只落一条 lease_held skipped', async () => {
    const db = freshDb()
    const { ticket, stage } = seedReadyAi(db)
    acquireLease(db, ticket.id, stage.id, 'agent:other', 50 * 60 * 1000, {
      agentId: stage.agentId,
      trigger: 'manual',
      now: WORK.getTime(),
    })
    let ran = 0
    const eng = engine(db, async () => {
      ran += 1
      return { ok: true, output: 'should not run' }
    })
    const report = await eng.tick(WORK)
    assert.equal(ran, 0)
    assert.equal(report.started, 0)
    const skipped = listRuns(db, { ticketId: ticket.id, status: 'skipped' }).items
    assert.ok(skipped.some((r) => r.skipReason === 'lease_held'))
    await eng.tick(WORK)
    const skippedAgain = listRuns(db, { ticketId: ticket.id, status: 'skipped' }).items
    assert.equal(skippedAgain.filter((r) => r.skipReason === 'lease_held').length, 1)
    db.close()
  })
})

describe('失败重试与熔断', () => {
  it('连续失败达阈值后关掉 stage.patrolEnabled', async () => {
    const db = freshDb()
    const { ticket, stage } = seedReadyAi(db, { circuitBreakerThreshold: 3, onFailure: 'retry' })
    const alerts: string[] = []
    const eng = new PatrolEngine({
      getDb: () => db,
      delegate: failDelegate('定位失败'),
      now: () => WORK.getTime(),
      slots: new PatrolSlotCounter(2),
      idle: new IdleBackoffState(),
      onAlert: (a) => alerts.push(a.kind),
      lookupUsage: async () => null,
      usageBackfillDelayMs: 0,
    })
    await eng.tick(WORK)
    await eng.tick(WORK)
    const mid = listStages(db, stage.pipelineId).find((s) => s.id === stage.id)
    assert.equal(mid?.patrolEnabled, true)
    await eng.tick(WORK)
    const after = listStages(db, stage.pipelineId).find((s) => s.id === stage.id)
    assert.equal(after?.patrolEnabled, false)
    assert.ok(alerts.includes('circuit_open'))
    const t = getTicket(db, ticket.id)
    assert.ok(t)
    assert.ok(t.status === 'ready' || t.status === 'blocked')
    db.close()
  })
})

describe('循环检测强制 blocked', () => {
  it('同一 stage 反复 running→ready 超过 maxStageLoops → blocked', async () => {
    const db = freshDb()
    updateSettings(db, { maxStageLoops: 2 })
    const { ticket } = seedReadyAi(db, { onSuccess: 'stay', onFailure: 'retry' })
    const eng = engine(db, okDelegate())
    await eng.tick(WORK)
    await eng.tick(WORK)
    const mid = getTicket(db, ticket.id)
    assert.ok(mid)
    assert.ok(mid.stageLoopCount >= 1)
    await eng.tick(WORK)
    const after = getTicket(db, ticket.id)
    assert.ok(after)
    assert.equal(after.status, 'blocked')
    db.close()
  })
})

describe('静默时段不跑', () => {
  it('落在 23–08 时 shouldPatrol 为 false,不建 run', async () => {
    const db = freshDb()
    const { ticket, stage } = seedReadyAi(db, {
      patrolCron: '* * * * *',
      quietHoursStart: 23,
      quietHoursEnd: 8,
    })
    let ran = 0
    const eng = engine(db, async () => {
      ran += 1
      return { ok: true, output: 'nope' }
    })
    const report = await eng.tick(QUIET)
    assert.equal(ran, 0)
    assert.equal(report.started, 0)
    const runs = listRuns(db, { ticketId: ticket.id }).items
    assert.equal(runs.length, 0)
    void stage
    db.close()
  })
})

describe('并发槽满时跳过', () => {
  it('槽位占满则写 concurrency_full skipped,不调 delegate', async () => {
    const db = freshDb()
    const { ticket } = seedReadyAi(db)
    const slots = new PatrolSlotCounter(2)
    slots.tryAcquire()
    slots.tryAcquire()
    let ran = 0
    const eng = engine(
      db,
      async () => {
        ran += 1
        return { ok: true, output: 'nope' }
      },
      { slots },
    )
    const report = await eng.tick(WORK)
    assert.equal(ran, 0)
    assert.equal(report.started, 0)
    const skipped = listRuns(db, { ticketId: ticket.id, status: 'skipped' }).items
    assert.ok(skipped.some((r) => r.skipReason === 'concurrency_full'))
    db.close()
  })
})

describe('patrolPaused 急停', () => {
  it('打开后 tick 直接空转,不碰 ready 票', async () => {
    const db = freshDb()
    const { ticket } = seedReadyAi(db)
    updateSettings(db, { patrolPaused: true })
    assert.equal(getSettings(db).patrolPaused, true)
    let ran = 0
    const eng = engine(db, async () => {
      ran += 1
      return { ok: true, output: 'nope' }
    })
    const report = await eng.tick(WORK)
    assert.equal(report.paused, true)
    assert.equal(ran, 0)
    assert.equal(getTicket(db, ticket.id)?.status, 'ready')
    db.close()
  })
})

describe('依赖 / 日配额 / 准入', () => {
  it('未完成 blocks 依赖 → skipped blocked_by_dependency', async () => {
    const db = freshDb()
    const { ticket, projectId, pipelineId, stage } = seedReadyAi(db)
    const blocker = createTicket(db, {
      projectId,
      type: 'feature',
      title: '挡路的单',
      reporter: 'user:default',
      pipelineId,
      stageId: stage.id,
      status: 'ready',
    })
    addRelation(db, { fromTicketId: blocker.id, toTicketId: ticket.id, kind: 'blocks' })
    const eng = engine(db, okDelegate())
    await eng.tick(WORK)
    const skipped = listRuns(db, { ticketId: ticket.id, status: 'skipped' }).items
    assert.ok(skipped.some((r) => r.skipReason === 'blocked_by_dependency'))
    db.close()
  })
})

describe('成本回填', () => {
  it('lookupUsage 成功时 tb_run 写入 tokensIn / tokensOut / costUsd', async () => {
    const db = freshDb()
    const { ticket } = seedReadyAi(db)
    const seenKeys: string[] = []
    const eng = engine(db, async () => ({ ok: true, output: '已完成,无用量字段。' }), {
      lookupUsage: async (sessionKey) => {
        seenKeys.push(sessionKey)
        return { tokensIn: 1200, tokensOut: 340, costUsd: 0.042 }
      },
    })
    const report = await eng.tick(WORK)
    assert.equal(report.settled, 1)
    const run = listRuns(db, { ticketId: ticket.id }).items.find((r) => r.status === 'succeeded')
    assert.ok(run)
    assert.equal(run.tokensIn, 1200)
    assert.equal(run.tokensOut, 340)
    assert.equal(run.costUsd, 0.042)
    assert.equal(seenKeys.length, 1)
    assert.equal(seenKeys[0], run.sessionKey)
    db.close()
  })

  it('delegate 已带回用量时不再问 lookup,0 也是合法值', async () => {
    const db = freshDb()
    const { ticket } = seedReadyAi(db)
    let looked = 0
    const eng = engine(
      db,
      async () => ({
        ok: true,
        output: 'ok',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
      {
        lookupUsage: async () => {
          looked += 1
          throw new Error('should not lookup')
        },
      },
    )
    await eng.tick(WORK)
    const run = listRuns(db, { ticketId: ticket.id }).items.find((r) => r.status === 'succeeded')
    assert.ok(run)
    assert.equal(run.tokensIn, 0)
    assert.equal(run.tokensOut, 0)
    assert.equal(run.costUsd, 0)
    assert.equal(looked, 0)
    db.close()
  })

  it('用量源抛异常时 run 仍正常收尾,字段留 null', async () => {
    const db = freshDb()
    const { ticket } = seedReadyAi(db)
    const logs: string[] = []
    const eng = engine(db, async () => ({ ok: true, output: '做完了。' }), {
      lookupUsage: async () => {
        throw new Error('usage_log down')
      },
      log: (msg) => logs.push(msg),
    })
    const report = await eng.tick(WORK)
    assert.equal(report.settled, 1)
    const t = getTicket(db, ticket.id)
    assert.ok(t)
    assert.equal(t.status, 'waiting_human')
    const run = listRuns(db, { ticketId: ticket.id }).items.find((r) => r.status === 'succeeded')
    assert.ok(run)
    assert.equal(run.tokensIn, null)
    assert.equal(run.tokensOut, null)
    assert.equal(run.costUsd, null)
    assert.ok(logs.some((m) => m.includes('usage lookup failed')))
    db.close()
  })
})

describe('每日预算护栏读回填成本', () => {
  it('累计 costUsd 超过 maxCostPerDayUsd 后下一轮 tick 暂停巡检', async () => {
    const db = freshDb()
    updateSettings(db, { maxCostPerDayUsd: 1, maxRunsPerDay: 200, maxStageLoops: 20 })
    const { ticket } = seedReadyAi(db, { onSuccess: 'stay' })
    const alerts: string[] = []
    let ran = 0
    const eng = engine(
      db,
      async () => {
        ran += 1
        return { ok: true, output: '本站完成。', tokensIn: 800, tokensOut: 200, costUsd: 1.25 }
      },
      { onAlert: (a) => alerts.push(a.kind) },
    )

    const first = await eng.tick(WORK)
    assert.equal(first.started, 1)
    assert.equal(first.settled, 1)
    assert.equal(first.paused, false)
    const afterFirst = getTicket(db, ticket.id)
    assert.ok(afterFirst)
    assert.equal(afterFirst.status, 'ready')
    const run = listRuns(db, { ticketId: ticket.id }).items.find((r) => r.status === 'succeeded')
    assert.ok(run)
    assert.equal(run.costUsd, 1.25)
    const usage = getUsage(db, WORK.getTime())
    assert.ok(usage.costTodayUsd >= 1.25)
    assert.equal(getSettings(db).patrolPaused, false)

    const second = await eng.tick(WORK)
    assert.equal(second.paused, true)
    assert.equal(second.started, 0)
    assert.equal(ran, 1)
    assert.ok(alerts.includes('budget_exhausted'))
    assert.equal(getSettings(db).patrolPaused, true)
    assert.equal(getTicket(db, ticket.id)?.status, 'ready')
    db.close()
  })
})

describe('sessionKey 形状', () => {
  it('delegate 入参与落库 run 都是 agent:<id>:taskboard:...', async () => {
    const db = freshDb()
    const { ticket } = seedReadyAi(db)
    let seen = ''
    const eng = engine(db, async (input) => {
      seen = input.sessionKey
      return { ok: true, output: 'ok' } satisfies PatrolDelegateResult
    })
    await eng.tick(WORK)
    assert.match(seen, /^agent:[^:]+:taskboard:/)
    assert.ok(seen.includes(`:taskboard:${ticket.id}:`))
    const run = listRuns(db, { ticketId: ticket.id }).items.find((r) => r.status === 'succeeded')
    assert.equal(run?.sessionKey, seen)
    db.close()
  })
})

function seedReadyAi(
  db: TaskboardDb,
  stageOver: {
    circuitBreakerThreshold?: number
    onFailure?: 'retry' | 'block' | 'wait_human'
    onSuccess?: 'advance' | 'stay' | 'wait_human'
    patrolCron?: string
    quietHoursStart?: number
    quietHoursEnd?: number
  } = {},
): {
  ticket: ReturnType<typeof createTicket>
  stage: ReturnType<typeof listStages>[number]
  projectId: string
  pipelineId: string
} {
  const project = createProject(db, { key: 'TST', name: '测' })
  const pipeline = createPipeline(db, {
    projectId: project.id,
    name: '单站',
    ticketType: 'feature',
    isDefault: true,
  })
  const stage = createStage(db, {
    pipelineId: pipeline.id,
    ordinal: 0,
    name: '执行',
    kind: 'ai',
    agentId: 'coding-assistant',
    promptTemplate: '做 {{ticket.identifier}} {{ticket.title}}',
    exitChecklist: '做完',
    patrolCron: stageOver.patrolCron ?? '* * * * *',
    patrolEnabled: true,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: stageOver.quietHoursStart ?? 0,
    quietHoursEnd: stageOver.quietHoursEnd ?? 0,
    maxRunsPerDay: 20,
    circuitBreakerThreshold: stageOver.circuitBreakerThreshold ?? 3,
    onSuccess: stageOver.onSuccess ?? 'wait_human',
    onFailure: stageOver.onFailure ?? 'retry',
  })
  const ticket = createTicket(db, {
    projectId: project.id,
    type: 'feature',
    title: '测巡检',
    body: 'body',
    reporter: 'user:default',
    pipelineId: pipeline.id,
    stageId: stage.id,
    status: 'ready',
  })
  createActivity(db, {
    ticketId: ticket.id,
    actor: 'human',
    actorId: 'user:default',
    action: 'status_changed',
    field: 'status',
    fromValue: 'backlog',
    toValue: 'ready',
  })
  return { ticket, stage, projectId: project.id, pipelineId: pipeline.id }
}
