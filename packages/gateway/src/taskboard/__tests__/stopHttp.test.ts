import { createTaskboardPreflight } from '../stagePreflight.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openTaskboardDb } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { listPipelines, listStages, updateStage } from '../db/pipelines.js'
import { acquireLease, getActiveLease, getRun, listRuns, settleLeaseRun, updateRun } from '../db/runs.js'
import { seedDefaultPipelines } from '../db/seed.js'
import { createTicket, getTicket, updateTicket } from '../db/tickets.js'
import { buildPatrolSessionKey } from '../domain.js'
import { handleTaskboardApi, type TaskboardHttpContext } from '../http.js'
import { taskboardRunControls } from '../runControl.js'

function fixture() {
  const db = openTaskboardDb(join(mkdtempSync(join(tmpdir(), 'oc-task-stop-')), 'taskboard.db'))
  const project = createProject(db, { key: 'STOP', name: 'Stop fixture' })
  seedDefaultPipelines(db, project.id, ['spike'])
  const pipeline = listPipelines(db, project.id)[0]!
  const stage = updateStage(db, listStages(db, pipeline.id)[0]!.id, { agentId: 'main', onSuccess: 'wait_human' })
  const ticket = createTicket(db, { projectId: project.id, type: 'spike', title: 'Stop fixture', reporter: 'user:765', status: 'ready', pipelineId: pipeline.id, stageId: stage.id })
  const claimed = acquireLease(db, ticket.id, stage.id, 'agent:main', 60_000, { agentId: 'main', trigger: 'manual' })
  const run = updateRun(db, claimed.id, { sessionKey: buildPatrolSessionKey('main', ticket.id, stage.id, claimed.id) })
  const running = updateTicket(db, ticket.id, ticket.version, { status: 'running' })
  const control = taskboardRunControls.begin(run.id, ticket.id, run.leaseOwner!, run.sessionKey!)
  const leave = control.enter(run.sessionKey!)
  return { db, project, stage, ticket: running, run, control, leave }
}

async function serverFor(ctx: TaskboardHttpContext, fn: (base: string) => Promise<void>) {
  const server = createServer((req, res) => { void handleTaskboardApi(req, res, { preflightStages: async (stages) => stages.map(() => null), ...ctx }).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('{}') } }) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await fn(`http://127.0.0.1:${address.port}`)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
}
async function post(base: string, path: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

function settle(f: ReturnType<typeof fixture>) {
  const now = Date.now()
  assert.ok(settleLeaseRun(f.db, f.run.id, f.run.leaseOwner!, { status: 'failed', summary: '用户停止', outputMd: '已付费的完整部分结果', error: 'USER_CANCELLED: stopped by user', finishedAt: now, durationMs: 100, tokensIn: 13, tokensOut: 7, costUsd: 0.02 }, now))
  f.leave(); taskboardRunControls.finish(f.control)
}

test('human stop is exact, idempotent, retains the active lease until worker settlement and preserves paid output', async () => {
  const f = fixture()
  try {
    await serverFor({ db: f.db, actor: 'human' }, async (base) => {
      const path = `/api/board/tickets/${f.ticket.id}/stop`
      const first = await post(base, path, { expectedVersion: f.ticket.version, runId: f.run.id })
      assert.equal(first.status, 202)
      assert.equal(first.body.state, 'stopping')
      assert.equal(f.control.signal.aborted, true)
      assert.equal(getTicket(f.db, f.ticket.id)!.status, 'blocked')
      assert.deepEqual(getActiveLease(f.db, f.ticket.id), f.run)
      const repeat = await post(base, path, { expectedVersion: f.ticket.version, runId: f.run.id })
      assert.equal(repeat.status, 202)
      assert.equal(repeat.body.ticket.version, first.body.ticket.version)
      settle(f)
      const terminal = await post(base, path, { expectedVersion: f.ticket.version, runId: f.run.id })
      assert.equal(terminal.status, 200)
      assert.equal(terminal.body.state, 'terminal')
      assert.equal(getActiveLease(f.db, f.ticket.id), null)
      assert.equal(getRun(f.db, f.run.id)!.outputMd, '已付费的完整部分结果')
      assert.equal(getRun(f.db, f.run.id)!.costUsd, 0.02)
    })
  } finally { if (taskboardRunControls.get(f.run.id, f.ticket.id, f.run.leaseOwner!)) { f.leave(); taskboardRunControls.finish(f.control) } f.db.close() }
})

test('a delayed stop of an old terminal run never interrupts its replacement', async () => {
  const f = fixture()
  settle(f)
  const ready = updateTicket(f.db, f.ticket.id, getTicket(f.db, f.ticket.id)!.version, { status: 'ready' })
  const next = acquireLease(f.db, f.ticket.id, f.stage.id, 'agent:main', 60_000, { agentId: 'main', trigger: 'manual' })
  const key = buildPatrolSessionKey('main', f.ticket.id, f.stage.id, next.id)
  updateRun(f.db, next.id, { sessionKey: key })
  updateTicket(f.db, f.ticket.id, ready.version, { status: 'running' })
  const control = taskboardRunControls.begin(next.id, f.ticket.id, next.leaseOwner!, key)
  const leave = control.enter(key)
  try {
    await serverFor({ db: f.db, actor: 'human' }, async (base) => {
      const result = await post(base, `/api/board/tickets/${f.ticket.id}/stop`, { expectedVersion: f.ticket.version, runId: f.run.id })
      assert.equal(result.status, 200)
      assert.equal(control.signal.aborted, false)
      assert.equal(getActiveLease(f.db, f.ticket.id)!.id, next.id)
    })
  } finally { leave(); taskboardRunControls.finish(control); f.db.close() }
})

test('agent stop cannot impersonate a human; human status writes cannot reopen an active stop lease', async () => {
  const f = fixture()
  try {
    await serverFor({ db: f.db, actor: 'agent' }, async (base) => {
      const result = await post(base, `/api/board/tickets/${f.ticket.id}/stop`, { expectedVersion: f.ticket.version, runId: f.run.id, owner: 'human' })
      assert.equal(result.status, 403)
      assert.equal(f.control.signal.aborted, false)
    })
    const blocked = updateTicket(f.db, f.ticket.id, f.ticket.version, { status: 'blocked', blockedReason: '停止待收尾' })
    await serverFor({ db: f.db, actor: 'human' }, async (base) => {
      for (const action of ['ready', 'claim', 'approve', 'reject', 'advance', 'block', 'done', 'cancel']) {
        const result = await post(base, `/api/board/tickets/${f.ticket.id}/${action}`, { expectedVersion: blocked.version })
        assert.equal(result.status, 409, action)
        assert.equal(result.body.code, 'active_execution', action)
        assert.equal(getTicket(f.db, f.ticket.id)!.version, blocked.version)
        assert.equal(getActiveLease(f.db, f.ticket.id)!.id, f.run.id)
      }
    })
  } finally { f.leave(); taskboardRunControls.finish(f.control); f.db.close() }
})

test('detail, run page and returned timeline all enrich only database-resolved run identities', async () => {
  const f = fixture()
  const seen: string[][] = []
  try {
    await serverFor({ db: f.db, actor: 'human', getRunSnapshots: async (runs) => {
      seen.push(runs.map((run) => run.id))
      return Object.fromEntries(runs.map((run) => [run.id, { actualModels: ['actual-a', 'actual-b'], preview: { text: 'live text', toolNames: ['Read'], lastActivityAt: 123 } }]))
    } }, async (base) => {
      const detail = await (await fetch(`${base}/api/board/tickets/${f.ticket.id}?expand=execution&sessionKey=forged`)).json() as any
      assert.deepEqual(detail.execution.actualModels, ['actual-a', 'actual-b'])
      assert.equal(detail.execution.outputMd, null)
      const runs = await (await fetch(`${base}/api/board/tickets/${f.ticket.id}/runs`)).json() as any
      assert.deepEqual(runs.items[0].actualModels, ['actual-a', 'actual-b'])
      const timeline = await (await fetch(`${base}/api/board/tickets/${f.ticket.id}/timeline`)).json() as any
      assert.deepEqual(timeline.items.find((item: any) => item.kind === 'run').run.actualModels, ['actual-a', 'actual-b'])
      assert.deepEqual(seen, [[f.run.id], [f.run.id], [f.run.id]])
    })
  } finally { f.leave(); taskboardRunControls.finish(f.control); f.db.close() }
})

test('retry waits for old cleanup even after lease expiry and a persisted terminal row', async () => {
  const f = fixture()
  try {
    const blocked = updateTicket(f.db, f.ticket.id, f.ticket.version, { status: 'blocked', blockedReason: '正在停止' })
    updateRun(f.db, f.run.id, { leaseExpiresAt: Date.now() - 1 })
    await serverFor({ db: f.db, actor: 'human' }, async (base) => {
      for (const action of ['ready', 'patrol', 'move']) {
        const result = await post(base, `/api/board/tickets/${f.ticket.id}/${action}`, { expectedVersion: blocked.version, toStageId: f.stage.id })
        assert.equal(result.status, 409, `${action} must wait for the old promise tree`)
        assert.equal(result.body.code, 'active_execution')
      }
      updateRun(f.db, f.run.id, { status: 'timeout', leaseOwner: null, leaseExpiresAt: null, outputMd: '旧执行完整输出' })
      const whileCleaning = await post(base, `/api/board/tickets/${f.ticket.id}/ready`, { expectedVersion: blocked.version })
      assert.equal(whileCleaning.status, 409, 'a reaper terminal row does not complete the local finally')
      f.leave(); taskboardRunControls.finish(f.control)
      const ready = await post(base, `/api/board/tickets/${f.ticket.id}/ready`, { expectedVersion: blocked.version })
      assert.equal(ready.status, 200)
      const retried = await post(base, `/api/board/tickets/${f.ticket.id}/patrol`, { expectedVersion: ready.body.ticket.version })
      assert.equal(retried.status, 202)
      assert.notEqual(retried.body.run.id, f.run.id)
      assert.notEqual(retried.body.run.sessionKey, f.run.sessionKey)
      assert.equal(getRun(f.db, f.run.id)!.outputMd, '旧执行完整输出')
    })
  } finally { if (taskboardRunControls.get(f.run.id, f.ticket.id, f.run.leaseOwner!)) { f.leave(); taskboardRunControls.finish(f.control) } f.db.close() }
})

test('an unfinished expired database run cannot be reopened without settlement', async () => {
  const f = fixture()
  f.leave(); taskboardRunControls.finish(f.control)
  try {
    const blocked = updateTicket(f.db, f.ticket.id, f.ticket.version, { status: 'blocked' })
    updateRun(f.db, f.run.id, { leaseExpiresAt: Date.now() - 1 })
    await serverFor({ db: f.db, actor: 'human' }, async (base) => {
      const pending = await post(base, `/api/board/tickets/${f.ticket.id}/ready`, { expectedVersion: blocked.version })
      assert.equal(pending.status, 409)
      updateRun(f.db, f.run.id, { status: 'timeout', leaseOwner: null, leaseExpiresAt: null })
      const terminal = await post(base, `/api/board/tickets/${f.ticket.id}/ready`, { expectedVersion: blocked.version })
      assert.equal(terminal.status, 200)
    })
  } finally { f.db.close() }
})

test('manual patrol rejects missing preflight and missing installed agents before claiming or counting', async () => {
  const f = fixture()
  settle(f)
  try {
    const ready = updateTicket(f.db, f.ticket.id, getTicket(f.db, f.ticket.id)!.version, { status: 'ready' })
    const before = listRuns(f.db, { ticketId: f.ticket.id }).items.length
    await serverFor({ db: f.db, actor: 'human', preflightStages: undefined }, async (base) => {
      const out = await post(base, `/api/board/tickets/${f.ticket.id}/patrol`, { expectedVersion: ready.version })
      assert.equal(out.status, 503)
    })
    const check = createTaskboardPreflight({ getAgentsConfig: async () => ({ agents: [], routes: [], default: 'main' }), getIdentityProjection: async () => undefined, env: {} })
    await serverFor({ db: f.db, actor: 'human', preflightStages: check }, async (base) => {
      const out = await post(base, `/api/board/tickets/${f.ticket.id}/patrol`, { expectedVersion: ready.version })
      assert.equal(out.status, 422)
      assert.equal(out.body.code, 'stage_agent_unavailable')
    })
    assert.equal(getTicket(f.db, f.ticket.id)!.version, ready.version)
    assert.equal(getTicket(f.db, f.ticket.id)!.stageLoopCount, ready.stageLoopCount)
    assert.equal(listRuns(f.db, { ticketId: f.ticket.id }).items.length, before)
    assert.equal(getActiveLease(f.db, f.ticket.id), null)
  } finally { f.db.close() }
})

test('a stage edited during asynchronous preflight is rechecked in the claim transaction', async () => {
  const f = fixture()
  settle(f)
  let release!: () => void
  let entered!: () => void
  const checking = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  try {
    const ready = updateTicket(f.db, f.ticket.id, getTicket(f.db, f.ticket.id)!.version, { status: 'ready' })
    await serverFor({ db: f.db, actor: 'human', preflightStages: async (stages) => { entered(); await gate; return stages.map(() => null) } }, async (base) => {
      const response = post(base, `/api/board/tickets/${f.ticket.id}/patrol`, { expectedVersion: ready.version })
      await checking
      updateStage(f.db, f.stage.id, { model: 'grok-build' })
      release()
      const out = await response
      assert.equal(out.status, 409)
      assert.equal(out.body.code, 'stage_configuration_changed')
      assert.equal(getActiveLease(f.db, f.ticket.id), null)
      assert.equal(getTicket(f.db, f.ticket.id)!.version, ready.version)
    })
  } finally { release(); f.db.close() }
})
