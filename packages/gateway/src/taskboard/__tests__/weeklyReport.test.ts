/**
 * 周报:单据流转、阶段耗时、成本/token、阻塞与失败。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/weeklyReport.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createActivity } from '../db/activity.js'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { createPipeline, createStage } from '../db/pipelines.js'
import { createProject } from '../db/projects.js'
import { insertRun, updateRun } from '../db/runs.js'
import { createTicket, updateTicket } from '../db/tickets.js'
import {
  buildWeeklyReport,
  currentWeekPeriod,
  isoWeekLabel,
  periodFromIsoWeek,
  shanghaiMondayYmd,
} from '../db/weeklyReport.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-week-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('周期计算', () => {
  it('上海周一到周日,ISO 周标签稳定', () => {
    // 2026-08-17 是周一。
    const monday = shanghaiMondayYmd(new Date('2026-08-19T04:00:00.000Z'))
    assert.equal(monday, '2026-08-17')
    assert.equal(isoWeekLabel(monday), '2026-W34')
    const period = periodFromIsoWeek('2026-W34')
    assert.ok(period)
    assert.equal(period.fromYmd, '2026-08-17')
    assert.equal(period.toYmd, '2026-08-23')
  })
})

describe('buildWeeklyReport', () => {
  it('汇总本周新建/完成/状态转移/阶段耗时/缺单价成本/受阻与失败', () => {
    const db = freshDb()
    const period = currentWeekPeriod(new Date('2026-08-18T04:00:00.000Z'))
    const project = createProject(db, { key: 'WK', name: '周报' })
    const pipeline = createPipeline(db, {
      projectId: project.id,
      name: '线',
      ticketType: 'bug',
      isDefault: true,
    })
    const stage = createStage(db, {
      pipelineId: pipeline.id,
      ordinal: 0,
      name: '修复',
      kind: 'ai',
      agentId: 'coding-assistant',
    })
    const t1 = createTicket(db, {
      projectId: project.id,
      type: 'bug',
      title: '本周新建',
      reporter: 'user:default',
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: 'waiting_human',
    })
    db.prepare('UPDATE tb_ticket SET created_at = ? WHERE id = ?').run(period.fromMs + 1000, t1.id)
    const done = createTicket(db, {
      projectId: project.id,
      type: 'chore',
      title: '本周完成',
      reporter: 'user:default',
      status: 'done',
    })
    updateTicket(db, done.id, done.version, { closedAt: period.fromMs + 2000 })
    db.prepare('UPDATE tb_ticket SET created_at = ? WHERE id = ?').run(
      period.fromMs - 86_400_000,
      done.id,
    )
    const blocked = createTicket(db, {
      projectId: project.id,
      type: 'feature',
      title: '卡住',
      reporter: 'user:default',
      status: 'blocked',
    })
    updateTicket(db, blocked.id, blocked.version, { blockedReason: '被依赖挡住' })
    db.prepare('UPDATE tb_ticket SET created_at = ? WHERE id = ?').run(
      period.fromMs - 86_400_000,
      blocked.id,
    )
    createActivity(db, {
      ticketId: t1.id,
      actor: 'human',
      actorId: 'user:default',
      action: 'status_changed',
      field: 'status',
      fromValue: 'backlog',
      toValue: 'ready',
    })
    db.prepare('UPDATE tb_ticket_activity SET created_at = ? WHERE ticket_id = ?').run(
      period.fromMs + 1500,
      t1.id,
    )

    const ok = insertRun(db, {
      ticketId: t1.id,
      stageId: stage.id,
      trigger: 'patrol',
      status: 'queued',
    })
    updateRun(db, ok.id, {
      status: 'succeeded',
      durationMs: 4000,
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.12,
    })
    db.prepare('UPDATE tb_ticket_run SET created_at = ? WHERE id = ?').run(
      period.fromMs + 3000,
      ok.id,
    )

    const fail = insertRun(db, {
      ticketId: t1.id,
      stageId: stage.id,
      trigger: 'patrol',
      status: 'queued',
    })
    updateRun(db, fail.id, {
      status: 'failed',
      durationMs: 1000,
      tokensIn: 50,
      tokensOut: 5,
      costUsd: 0,
      error: 'upstream 502',
    })
    db.prepare('UPDATE tb_ticket_run SET created_at = ? WHERE id = ?').run(
      period.fromMs + 4000,
      fail.id,
    )

    const report = buildWeeklyReport(db, {
      fromMs: period.fromMs,
      toMs: period.toMs,
      fromYmd: period.fromYmd,
      toYmd: period.toYmd,
      week: period.week,
      projectId: project.id,
    })
    assert.equal(report.flow.created, 1)
    assert.equal(report.flow.completed, 1)
    assert.equal(report.flow.waitingHuman, 1)
    assert.equal(report.flow.blockedNow, 1)
    assert.ok(report.flow.statusTransitions.some((t) => t.from === 'backlog' && t.to === 'ready'))
    assert.equal(report.stages.length, 1)
    assert.equal(report.stages[0].stageName, '修复')
    assert.equal(report.stages[0].runCount, 2)
    assert.equal(report.stages[0].totalDurationMs, 5000)
    assert.equal(report.cost.coverage, 'partial')
    assert.equal(report.cost.costUsd, 0.12)
    assert.equal(report.cost.unpriced.runCount, 1)
    assert.equal(report.blocked.length, 1)
    assert.equal(report.blocked[0].identifier, blocked.identifier)
    assert.equal(report.failedRuns.length, 1)
    assert.match(report.failedRuns[0].error ?? '', /502/)
    db.close()
  })
})
