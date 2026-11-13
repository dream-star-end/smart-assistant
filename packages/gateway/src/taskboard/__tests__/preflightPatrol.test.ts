import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openTaskboardDb } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { createPipeline, createStage, updateStage } from '../db/pipelines.js'
import { createTicket } from '../db/tickets.js'
import { listRuns } from '../db/runs.js'
import { getUsage } from '../db/settings.js'
import { PatrolSlotCounter, IdleBackoffState } from '../guardrails.js'
import { PatrolEngine, resetSharedPatrolState } from '../patrol.js'
import type { TaskboardPreflight } from '../stagePreflight.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-task-preflight-'))
  const db = openTaskboardDb(join(dir, 'taskboard.db'))
  const project = createProject(db, { key: 'PREF', name: 'Preflight' })
  const create = (helper: string, ordinal: number) => {
    const pipeline = createPipeline(db, {
      projectId: project.id,
      name: `Pipeline ${ordinal}`,
      ticketType: 'feature',
      isDefault: ordinal === 0,
    })
    const stage = createStage(db, {
      pipelineId: pipeline.id,
      name: '执行',
      ordinal: 0,
      kind: 'ai',
      agentId: helper,
      model: 'glm-5.2',
      promptTemplate: '执行 {{ticket.title}}',
      patrolEnabled: true,
      patrolCron: '* * * * *',
      quietHoursStart: 0,
      quietHoursEnd: 0,
      onSuccess: 'wait_human',
    })
    const ticket = createTicket(db, {
      projectId: project.id,
      pipelineId: pipeline.id,
      stageId: stage.id,
      title: `Preflight ${ordinal}`,
      type: 'feature',
      reporter: 'user:765',
      status: 'ready',
    })
    return { stage, ticket }
  }
  const calls: string[] = []
  const slots = new PatrolSlotCounter(2)
  const engine = (preflightStages?: TaskboardPreflight) =>
    new PatrolEngine({
      getDb: () => db,
      preflightStages,
      now: () => Date.parse('2026-08-17T02:00:00Z'),
      slots,
      idle: new IdleBackoffState(),
      delegate: async (input) => {
        calls.push(input.agentId)
        return { ok: true, output: 'done', tokensIn: 1, tokensOut: 1, costUsd: 0.01 }
      },
      lookupUsage: async () => null,
      usageBackfillDelayMs: 0,
    })
  return {
    db,
    create,
    calls,
    engine,
    close: () => {
      resetSharedPatrolState()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('one invalid stage cannot consume a run or prevent another validated stage from running', async () => {
  const f = fixture()
  try {
    const bad = f.create('absent-helper', 0)
    const good = f.create('installed-helper', 1)
    let batches = 0
    await f
      .engine(async (stages) => {
        batches += 1
        return stages.map((stage) =>
          stage.agentId === 'absent-helper'
            ? { code: 'stage_agent_unavailable', status: 422, message: '请重新选择助手' }
            : null,
        )
      })
      .tick()
    assert.equal(batches, 1)
    assert.deepEqual(f.calls, ['installed-helper'])
    assert.equal(listRuns(f.db, { ticketId: bad.ticket.id }).items.length, 0)
    assert.equal(listRuns(f.db, { ticketId: good.ticket.id }).items.length, 1)
    assert.equal(getUsage(f.db).activeRuns, 0)
  } finally {
    f.close()
  }
})

test('changing a stage while its preflight waits prevents claim and slot consumption', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let ticking: Promise<unknown> | undefined
  try {
    const { stage, ticket } = f.create('installed-helper', 0)
    ticking = f
      .engine(async (stages) => {
        entered()
        await gate
        return stages.map(() => null)
      })
      .tick()
    await started
    updateStage(f.db, stage.id, { agentId: 'replacement-helper', model: 'deepseek-v4-pro' })
    release()
    await ticking
    assert.deepEqual(f.calls, [])
    assert.equal(listRuns(f.db, { ticketId: ticket.id }).items.length, 0)
    assert.equal(getUsage(f.db).activeRuns, 0)
  } finally {
    release()
    await ticking
    f.close()
  }
})
