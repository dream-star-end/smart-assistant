/**
 * 任务面板通知打通。覆盖三类幂等键、熔断走 createInboxMessage/warning、
 * 微信接管不再推站内信、通知抛错不影响 run 收尾。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/notify.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { createPipeline, createStage } from '../db/pipelines.js'
import { createProject } from '../db/projects.js'
import { listRuns } from '../db/runs.js'
import { updateSettings } from '../db/settings.js'
import { createTicket, getTicket, updateTicket } from '../db/tickets.js'
import { IdleBackoffState, PatrolSlotCounter } from '../guardrails.js'
import {
  type InboxCreateArgs,
  type NotifyTransport,
  TaskboardNotifier,
  type WechatDeliveryResult,
  awaitOutboundId,
  collectDigestStats,
  digestOutboundId,
  fireNotify,
  formatAwaitMessage,
  formatDigestMessage,
  fuseOutboundId,
  zonedYmd,
} from '../notify.js'
import { type PatrolDelegateFn, PatrolEngine, resetSharedPatrolState } from '../patrol.js'

const dirs: string[] = []

/** 上海周一 10:00,不在默认静默 23–08。 */
const WORK = new Date('2026-08-17T02:00:00.000Z')
/** 上海周一 00:00,落在静默。 */
const QUIET = new Date('2026-08-16T16:00:00.000Z')
/** 上海周一 20:00,简报点。 */
const DIGEST_AT = new Date('2026-08-17T12:00:00.000Z')

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-notify-'))
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

interface Capture {
  wechat: { text: string; outboundId: string }[]
  inbox: { title: string; bodyMd: string; deliveryKey: string }[]
  alerts: InboxCreateArgs[]
  wechatResult: WechatDeliveryResult
}

function capture(over: Partial<Capture> = {}): Capture & { transport: NotifyTransport } {
  const c: Capture = {
    wechat: [],
    inbox: [],
    alerts: [],
    wechatResult: over.wechatResult ?? { kind: 'fallback', marked: false },
  }
  const transport: NotifyTransport = {
    sendWechat: async (args) => {
      c.wechat.push(args)
      return c.wechatResult
    },
    postInbox: async (args) => {
      c.inbox.push(args)
    },
    createInboxMessage: async (args) => {
      c.alerts.push(args)
    },
  }
  return { ...c, transport }
}

function seedAwaitReady(db: TaskboardDb): {
  ticket: ReturnType<typeof createTicket>
  stage: ReturnType<typeof createStage>
} {
  const project = createProject(db, { key: 'NTF', name: '通知' })
  const pipeline = createPipeline(db, {
    projectId: project.id,
    name: '单站',
    ticketType: 'feature',
    isDefault: true,
  })
  const stage = createStage(db, {
    pipelineId: pipeline.id,
    ordinal: 0,
    name: '方案设计',
    kind: 'ai',
    agentId: 'coding-assistant',
    promptTemplate: '做 {{ticket.identifier}}',
    exitChecklist: '做完',
    patrolCron: '* * * * *',
    patrolEnabled: true,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: 0,
    quietHoursEnd: 0,
    maxRunsPerDay: 20,
    onSuccess: 'wait_human',
    onFailure: 'retry',
  })
  const ticket = createTicket(db, {
    projectId: project.id,
    type: 'feature',
    title: '通知打通',
    body: 'body',
    reporter: 'user:default',
    pipelineId: pipeline.id,
    stageId: stage.id,
    status: 'ready',
  })
  return { ticket, stage }
}

describe('幂等键形状', () => {
  it('三类通知各自用冻结的稳定键', () => {
    assert.equal(awaitOutboundId('t1', 'r9'), 'taskboard-await:t1:r9')
    assert.equal(fuseOutboundId('stage-a', '2026-08-17'), 'taskboard-fuse:stage-a:2026-08-17')
    assert.equal(digestOutboundId('2026-08-17'), 'taskboard-digest:2026-08-17')
    assert.equal(zonedYmd(WORK), '2026-08-17')
  })
})

describe('熔断告警走 createInboxMessage / warning', () => {
  it('微信未接管时 createInboxMessage 且 level=warning,不走 postInbox', async () => {
    const db = freshDb()
    const cap = capture()
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => WORK.getTime(),
    })
    await n.onGuardrailAlert({
      kind: 'circuit_open',
      outboundId: 'taskboard-fuse:stage-a:2026-08-17',
      message: '阶段 stage-a 连续失败 3 次,已达到熔断阈值 3,巡检已自动关闭。',
      stageId: 'stage-a',
    })
    assert.equal(cap.alerts.length, 1)
    assert.equal(cap.alerts[0].level, 'warning')
    assert.equal(cap.alerts[0].deliveryKey, 'taskboard-fuse:stage-a:2026-08-17')
    assert.equal(cap.inbox.length, 0)
    assert.match(cap.alerts[0].title, /熔断/)
    db.close()
  })

  it('同一 outboundId 再推一次不双发', async () => {
    const db = freshDb()
    const cap = capture()
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => WORK.getTime(),
    })
    const alert = {
      kind: 'circuit_open' as const,
      outboundId: 'taskboard-fuse:stage-a:2026-08-17',
      message: '熔断',
      stageId: 'stage-a',
    }
    await n.onGuardrailAlert(alert)
    await n.onGuardrailAlert(alert)
    assert.equal(cap.alerts.length, 1)
    db.close()
  })

  it('静默时段熔断仍穿透', async () => {
    const db = freshDb()
    updateSettings(db, { quietHoursStart: 23, quietHoursEnd: 8 })
    const cap = capture()
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => QUIET.getTime(),
    })
    await n.onGuardrailAlert({
      kind: 'circuit_open',
      outboundId: 'taskboard-fuse:s1:2026-08-17',
      message: '熔断',
      stageId: 's1',
    })
    assert.equal(cap.alerts.length, 1)
    assert.equal(cap.alerts[0].level, 'warning')
    db.close()
  })
})

describe('微信接管不再推站内信', () => {
  it('wechat delivered → 不调 postInbox / createInboxMessage', async () => {
    const db = freshDb()
    const { ticket, stage } = seedAwaitReady(db)
    const cap = capture({ wechatResult: { kind: 'delivered' } })
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => WORK.getTime(),
    })
    await n.onWaitingHuman({
      ticket,
      run: {
        id: 'run-1',
        ticketId: ticket.id,
        stageId: stage.id,
        agentId: 'coding-assistant',
        trigger: 'patrol',
        sessionKey: null,
        status: 'succeeded',
        skipReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: WORK.getTime(),
        finishedAt: WORK.getTime(),
        durationMs: 1,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        summary: 'ok',
        outputMd: 'ok',
        error: null,
        createdAt: WORK.getTime(),
      },
      stage,
    })
    assert.equal(cap.wechat.length, 1)
    assert.equal(cap.wechat[0].outboundId, awaitOutboundId(ticket.id, 'run-1'))
    assert.equal(cap.inbox.length, 0)
    assert.equal(cap.alerts.length, 0)
    db.close()
  })

  it('熔断微信接管同样不写 warning 站内信', async () => {
    const db = freshDb()
    const cap = capture({ wechatResult: { kind: 'delivered' } })
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => WORK.getTime(),
    })
    await n.onGuardrailAlert({
      kind: 'circuit_open',
      outboundId: 'taskboard-fuse:s1:2026-08-17',
      message: '熔断',
    })
    assert.equal(cap.wechat.length, 1)
    assert.equal(cap.alerts.length, 0)
    assert.equal(cap.inbox.length, 0)
    db.close()
  })
})

describe('待确认提醒', () => {
  it('无微信时回退站内信,键为 taskboard-await:<ticket>:<run>', async () => {
    const db = freshDb()
    const { ticket, stage } = seedAwaitReady(db)
    const cap = capture()
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => WORK.getTime(),
    })
    await n.onWaitingHuman({
      ticket,
      run: {
        id: 'run-9',
        ticketId: ticket.id,
        stageId: stage.id,
        agentId: stage.agentId,
        trigger: 'patrol',
        sessionKey: null,
        status: 'succeeded',
        skipReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: WORK.getTime(),
        finishedAt: WORK.getTime(),
        durationMs: 1,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        summary: 'ok',
        outputMd: 'ok',
        error: null,
        createdAt: WORK.getTime(),
      },
      stage,
    })
    assert.equal(cap.inbox.length, 1)
    assert.equal(cap.inbox[0].deliveryKey, `taskboard-await:${ticket.id}:run-9`)
    assert.match(cap.inbox[0].title, /等你确认/)
    assert.equal(cap.alerts.length, 0)
    const copy = formatAwaitMessage(ticket, stage)
    assert.equal(cap.inbox[0].title, copy.title)
    db.close()
  })

  it('静默时段内不推待确认,出静默后补发', async () => {
    const db = freshDb()
    updateSettings(db, { quietHoursStart: 23, quietHoursEnd: 8 })
    const { ticket, stage } = seedAwaitReady(db)
    updateTicket(db, ticket.id, ticket.version, { status: 'waiting_human' })
    const fresh = getTicket(db, ticket.id)
    assert.ok(fresh)
    const cap = capture()
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => QUIET.getTime(),
    })
    await n.onWaitingHuman({
      ticket: fresh,
      run: {
        id: 'run-q',
        ticketId: ticket.id,
        stageId: stage.id,
        agentId: stage.agentId,
        trigger: 'patrol',
        sessionKey: null,
        status: 'succeeded',
        skipReason: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: QUIET.getTime(),
        finishedAt: QUIET.getTime(),
        durationMs: 1,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        summary: 'ok',
        outputMd: 'ok',
        error: null,
        createdAt: QUIET.getTime(),
      },
      stage,
    })
    assert.equal(cap.inbox.length, 0)
    await n.onDigestTick({
      db,
      at: WORK,
      settings: updateSettings(db, { quietHoursStart: 23, quietHoursEnd: 8 }),
    })
    const flushed = cap.inbox.filter((m) => m.deliveryKey === `taskboard-await:${ticket.id}:run-q`)
    assert.equal(flushed.length, 1)
    db.close()
  })
})

describe('每日简报', () => {
  it('键为 taskboard-digest:<YYYY-MM-DD>,含完成/新建/待确认/受阻/run/成本降级', async () => {
    const db = freshDb()
    const project = createProject(db, { key: 'DIG', name: '简报' })
    const done = createTicket(db, {
      projectId: project.id,
      type: 'chore',
      title: '已完成',
      reporter: 'user:default',
      status: 'done',
    })
    updateTicket(db, done.id, done.version, { closedAt: WORK.getTime() })
    createTicket(db, {
      projectId: project.id,
      type: 'feature',
      title: '等确认',
      reporter: 'user:default',
      status: 'waiting_human',
    })
    createTicket(db, {
      projectId: project.id,
      type: 'bug',
      title: '卡住了',
      reporter: 'user:default',
      status: 'blocked',
    })
    const stats = collectDigestStats(db, '2026-08-17')
    assert.equal(stats.date, '2026-08-17')
    assert.ok(stats.created >= 3)
    assert.equal(stats.waitingHuman, 1)
    assert.equal(stats.blocked.length, 1)
    assert.equal(stats.costUsd, null)
    const copy = formatDigestMessage(stats)
    assert.match(copy.title, /每日简报/)
    assert.match(copy.bodyMd, /待我确认 1/)
    assert.match(copy.bodyMd, /成本未统计/)

    const cap = capture()
    const n = new TaskboardNotifier({
      getDb: () => db,
      transport: cap.transport,
      now: () => DIGEST_AT.getTime(),
    })
    await n.onDigestTick({
      db,
      at: DIGEST_AT,
      settings: updateSettings(db, { quietHoursStart: 23, quietHoursEnd: 8 }),
    })
    assert.equal(cap.inbox.length, 1)
    assert.equal(cap.inbox[0].deliveryKey, 'taskboard-digest:2026-08-17')
    await n.onDigestTick({
      db,
      at: DIGEST_AT,
      settings: updateSettings(db, { quietHoursStart: 23, quietHoursEnd: 8 }),
    })
    assert.equal(cap.inbox.length, 1, '同一天简报幂等')
    db.close()
  })
})

describe('通知抛异常不影响 run 收尾', () => {
  it('onWaitingHuman 抛错时单据仍落到 waiting_human,run 仍 succeeded', async () => {
    const db = freshDb()
    const { ticket } = seedAwaitReady(db)
    const delegate: PatrolDelegateFn = async () => ({ ok: true, output: '本阶段已完成。' })
    const eng = new PatrolEngine({
      getDb: () => db,
      delegate,
      now: () => WORK.getTime(),
      slots: new PatrolSlotCounter(2),
      idle: new IdleBackoffState(),
      notify: {
        onWaitingHuman: () => {
          throw new Error('notify down')
        },
        onDigestTick: () => {
          throw new Error('digest down')
        },
      },
    })
    const report = await eng.tick(WORK)
    assert.equal(report.started, 1)
    assert.equal(report.settled, 1)
    const after = getTicket(db, ticket.id)
    assert.ok(after)
    assert.equal(after.status, 'waiting_human')
    const runs = listRuns(db, { ticketId: ticket.id }).items
    assert.ok(runs.some((r) => r.status === 'succeeded'))
    db.close()
  })

  it('fireNotify 吞掉同步与异步异常', async () => {
    const logs: string[] = []
    fireNotify(
      () => {
        throw new Error('sync')
      },
      (msg) => logs.push(msg),
      'x',
    )
    fireNotify(
      () => Promise.reject(new Error('async')),
      (msg) => logs.push(msg),
      'y',
    )
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(logs.includes('x'))
    assert.ok(logs.includes('y'))
  })
})
