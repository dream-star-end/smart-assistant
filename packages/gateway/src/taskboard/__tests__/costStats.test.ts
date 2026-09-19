/**
 * 成本统计:钉住 priced / unpriced / unknown,美元合计不含缺单价 run。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/costStats.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { classifyRunCost, queryCostStats, ymdRangeMs } from '../db/costStats.js'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { createPipeline, createStage } from '../db/pipelines.js'
import { createProject } from '../db/projects.js'
import { insertRun, updateRun } from '../db/runs.js'
import { getUsage, getUsageWithReferenceCosts } from '../db/settings.js'
import { createTicket } from '../db/tickets.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-cost-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function seedTicket(db: TaskboardDb): {
  ticketId: string
  stageId: string
  projectId: string
} {
  const project = createProject(db, { key: 'CST', name: '成本' })
  const pipeline = createPipeline(db, {
    projectId: project.id,
    name: '线',
    ticketType: 'chore',
    isDefault: true,
  })
  const stage = createStage(db, {
    pipelineId: pipeline.id,
    ordinal: 0,
    name: '执行',
    kind: 'ai',
    agentId: 'explorer',
  })
  const ticket = createTicket(db, {
    projectId: project.id,
    type: 'chore',
    title: '跑一次',
    reporter: 'user:default',
    pipelineId: pipeline.id,
    stageId: stage.id,
  })
  return { ticketId: ticket.id, stageId: stage.id, projectId: project.id }
}

function putRun(
  db: TaskboardDb,
  ticketId: string,
  stageId: string,
  createdAt: number,
  usage: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; costImprecise?: boolean | null },
  status: 'succeeded' | 'failed' | 'skipped' = 'succeeded',
): void {
  const run = insertRun(db, {
    ticketId,
    stageId,
    trigger: 'manual',
    status: 'queued',
  })
  updateRun(db, run.id, {
    status,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    costImprecise: usage.costImprecise,
  })
  db.prepare('UPDATE tb_ticket_run SET created_at = ? WHERE id = ?').run(createdAt, run.id)
}

describe('classifyRunCost', () => {
  it('token>0 且 cost 为 0 或 null → unpriced,不是真 0 花费', () => {
    assert.equal(classifyRunCost(97419, 8532, 0), 'unpriced')
    assert.equal(classifyRunCost(100, 10, null), 'unpriced')
  })

  it('cost>0 → priced; token=0 且 cost=0 → 真的花了 0', () => {
    assert.equal(classifyRunCost(800, 200, 0.354), 'priced')
    assert.equal(classifyRunCost(0, 0, 0), 'priced')
    assert.equal(classifyRunCost(null, null, 0), 'priced')
  })

  it('无 token 且 cost 为 null → unknown', () => {
    assert.equal(classifyRunCost(null, null, null), 'unknown')
    assert.equal(classifyRunCost(0, 0, null), 'unknown')
  })
})

describe('queryCostStats', () => {
  it('glm 有单价计入美元,cursor 写死 0 的 token 进 unpriced,不把缺价当 $0', () => {
    const db = freshDb()
    const { ticketId, stageId } = seedTicket(db)
    const { fromMs, toMs } = ymdRangeMs('2026-08-11', '2026-08-17')
    const mid = fromMs + 3600_000
    putRun(db, ticketId, stageId, mid, { tokensIn: 1000, tokensOut: 200, costUsd: 0.354 })
    putRun(db, ticketId, stageId, mid + 1, { tokensIn: 97419, tokensOut: 8532, costUsd: 0 })
    putRun(db, ticketId, stageId, mid + 2, { tokensIn: null, tokensOut: null, costUsd: null })
    putRun(db, ticketId, stageId, mid + 3, { tokensIn: 10, tokensOut: 1, costUsd: 0.01 }, 'skipped')
    const stats = queryCostStats(db, { fromMs, toMs, groupBy: 'ticket' })
    assert.equal(stats.totals.coverage, 'partial')
    assert.equal(stats.totals.costUsd, 0.354)
    assert.equal(stats.totals.priced.runCount, 1)
    assert.equal(stats.totals.priced.costUsd, 0.354)
    assert.equal(stats.totals.unpriced.runCount, 1)
    assert.equal(stats.totals.unpriced.tokensIn, 97419)
    assert.equal(stats.totals.unpriced.tokensOut, 8532)
    assert.equal(stats.totals.unpriced.costUsd, 0)
    assert.equal(stats.totals.unknownRunCount, 1)
    assert.equal(stats.totals.tokensIn, 1000 + 97419)
    assert.equal(stats.buckets.length, 1)
    assert.equal(stats.buckets[0].coverage, 'partial')
    db.close()
  })

  it('全部缺单价时 coverage=unpriced_only,costUsd=0 且不得被当成没花钱', () => {
    const db = freshDb()
    const { ticketId, stageId } = seedTicket(db)
    const { fromMs, toMs } = ymdRangeMs('2026-08-18', '2026-08-18')
    putRun(db, ticketId, stageId, fromMs + 1, { tokensIn: 10, tokensOut: 2, costUsd: 0 })
    const stats = queryCostStats(db, { fromMs, toMs })
    assert.equal(stats.totals.coverage, 'unpriced_only')
    assert.equal(stats.totals.costUsd, 0)
    assert.equal(stats.totals.unpriced.runCount, 1)
    assert.equal(stats.totals.priced.runCount, 0)
    db.close()
  })
})


describe('OCV5-179 recorded amount provenance', () => {
  it('keeps display aggregation out of guardrail query budget and preserves its counters', () => {
    const db = freshDb()
    try {
      const { ticketId, stageId } = seedTicket(db)
      const now = Date.now()
      putRun(db, ticketId, stageId, now, { tokensIn: 10, tokensOut: 1, costUsd: 2, costImprecise: true })
      const queries: string[] = []
      const measured = { prepare(sql: string) { queries.push(sql); return db.prepare(sql) } } as TaskboardDb
      const counters = getUsage(measured, now)
      assert.equal(queries.length, 2)
      assert.ok(queries.every(sql => !sql.includes('JOIN')))
      assert.equal(counters.referenceCostsToday, undefined)
      queries.length = 0
      const { referenceCostsToday, ...displayCounters } = getUsageWithReferenceCosts(measured, now)
      assert.equal(queries.length, 3)
      assert.deepEqual(displayCounters, counters)
      assert.equal(referenceCostsToday?.amounts.estimated.costUsd, 2)
    } finally { db.close() }
  })

  it('digest distinguishes unpriced usage from wholly unrecorded runs without free zero', async () => {
    const db = freshDb()
    try {
      const { ticketId, stageId } = seedTicket(db)
      const { fromMs } = ymdRangeMs('2026-08-18', '2026-08-18')
      putRun(db, ticketId, stageId, fromMs + 1, { tokensIn: 10, tokensOut: 1, costUsd: 0 })
      putRun(db, ticketId, stageId, fromMs + 2, { tokensIn: null, tokensOut: null, costUsd: null })
      const { collectDigestStats, formatDigestMessage } = await import('../notify.js')
      const message = formatDigestMessage(collectDigestStats(db, '2026-08-18')).bodyMd
      assert.match(message, /1 次有用量但无金额/)
      assert.match(message, /1 次费用未记录/)
      assert.doesNotMatch(message, /\$0/)
    } finally { db.close() }
  })
  it('preserves estimates/unflagged/unknown provenance in every grouping and digest', async () => {
    const db = freshDb()
    try {
      const { ticketId, stageId } = seedTicket(db)
      const { fromMs, toMs } = ymdRangeMs('2026-08-18', '2026-08-18')
      for (const [i, flag] of [true, false, null].entries()) {
        putRun(db, ticketId, stageId, fromMs + 1 + i, { tokensIn: 100, tokensOut: 10, costUsd: i + 1, costImprecise: flag })
      }
      for (const groupBy of ['day', 'project', 'ticket', 'stage'] as const) {
        const stats = queryCostStats(db, { fromMs, toMs, groupBy })
        for (const s of [stats.totals, ...stats.buckets]) {
          assert.equal(s.costUsd, 6)
          assert.equal(s.amounts.estimated.costUsd, 1)
          assert.equal(s.amounts.unflagged.costUsd, 2)
          assert.equal(s.amounts.unverified.costUsd, 3)
          assert.equal(s.coverage, 'full', 'coverage is availability, never proof of settlement')
        }
      }
      const { collectDigestStats, formatDigestMessage } = await import('../notify.js')
      const digest = collectDigestStats(db, '2026-08-18')
      const message = formatDigestMessage(digest).bodyMd
      assert.match(message, /参考费用/)
      assert.match(message, /估算 \$1.0000/)
      assert.match(message, /未标估算 \$2.0000/)
      assert.match(message, /来源未证实 \$3.0000/)
      assert.doesNotMatch(message, /实扣|已结算|精确/)
    } finally { db.close() }
  })

  it('all unknown records are not full cost coverage or a free zero', () => {
    const db = freshDb()
    try {
      const { ticketId, stageId } = seedTicket(db)
      const { fromMs, toMs } = ymdRangeMs('2026-08-18', '2026-08-18')
      putRun(db, ticketId, stageId, fromMs + 1, { tokensIn: null, tokensOut: null, costUsd: null })
      assert.equal(queryCostStats(db, { fromMs, toMs }).totals.coverage, 'none')
    } finally { db.close() }
  })
})
