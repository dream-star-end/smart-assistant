/**
 * POST /api/board/tickets/:id/move + board 增强 + 权限收紧。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/moveHttp.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { listActivities } from '../db/activity.js'
import { listComments } from '../db/comments.js'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { listPipelines, listStages } from '../db/pipelines.js'
import { addRelation } from '../db/relations.js'
import { acquireLease, getActiveLease } from '../db/runs.js'
import { getTicket, updateTicket } from '../db/tickets.js'
import { type TaskboardHttpContext, handleTaskboardApi } from '../http.js'
import { renderPrompt } from '../promptRender.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-move-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface JsonRes {
  status: number
  body: Record<string, unknown>
}

async function withServer(
  ctx: TaskboardHttpContext,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    handleTaskboardApi(req, res, ctx)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'not found', code: 'not_found' }))
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal error', message: String(err) }))
        }
        void err
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<JsonRes> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  if (text) parsed = JSON.parse(text) as Record<string, unknown>
  return { status: res.status, body: parsed }
}

function humanCtx(db: TaskboardDb): TaskboardHttpContext {
  return { db, actor: 'human', listAgents: async () => [] }
}
function agentCtx(db: TaskboardDb): TaskboardHttpContext {
  return { ...humanCtx(db), actor: 'agent' }
}

type TicketJson = {
  id: string
  identifier: string
  status: string
  stageId: string | null
  pipelineId: string | null
  version: number
  type: string
  allowedMoves?: Array<{
    toStageId: string | null
    action: string
    label: string
    requiresReason: boolean
    requiresConfirm: boolean
    warning?: string
  }>
}

async function setup(base: string, db: TaskboardDb) {
  const created = await call(base, 'POST', '/api/board/projects', { key: 'OCV5', name: 'V5' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const projectId = (created.body.project as { id: string }).id
  const ticketRes = await call(base, 'POST', '/api/board/tickets', {
    projectId,
    type: 'bug',
    title: '登录 500',
  })
  assert.equal(ticketRes.status, 201, JSON.stringify(ticketRes.body))
  const ticket = ticketRes.body.ticket as TicketJson
  const bug = listPipelines(db, projectId).find((p) => p.ticketType === 'bug')
  assert.ok(bug)
  const stages = listStages(db, bug.id)
  return { projectId, ticket, stages }
}

function movePath(id: string): string {
  return `/api/board/tickets/${id}/move`
}

describe('POST /move 动作落库', () => {
  it('promote: backlog → 第一站,写评论+activity,status=ready', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const res = await call(base, 'POST', movePath(ticket.identifier), {
        toStageId: stages[0]!.id,
        expectedVersion: ticket.version,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const move = res.body.move as { action: string; commentId: string }
      assert.equal(move.action, 'promote')
      const updated = res.body.ticket as TicketJson
      assert.equal(updated.status, 'ready')
      assert.equal(updated.stageId, stages[0]!.id)
      const comments = listComments(db, ticket.id)
      assert.ok(comments.some((c) => c.authorKind === 'human' && /批准开工/.test(c.body)))
      assert.ok(comments.every((c) => c.author !== 'agent:unknown'))
      const acts = listActivities(db, ticket.id)
      assert.ok(acts.some((a) => a.action === 'move:promote' && a.actor === 'human'))
    })
    db.close()
  })

  it('promote_at_stage 无确认 → 422 confirm_required;有确认则跳站并写免做评论', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const target = stages.find((s) => s.name === '修复') ?? stages[2]!
      const denied = await call(base, 'POST', movePath(ticket.id), {
        toStageId: target.id,
        expectedVersion: ticket.version,
      })
      assert.equal(denied.status, 422)
      assert.equal(denied.body.code, 'confirm_required')

      const ok = await call(base, 'POST', movePath(ticket.id), {
        toStageId: target.id,
        expectedVersion: ticket.version,
        confirmSkippedStages: true,
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      const move = ok.body.move as { action: string; skippedStages: { name: string }[] }
      assert.equal(move.action, 'promote_at_stage')
      assert.ok(move.skippedStages.length > 0)
      const comments = listComments(db, ticket.id)
      assert.ok(comments.some((c) => /人工判定免做/.test(c.body)))
    })
    db.close()
  })

  it('ack_advance 等价于确认过站,落到下一站 ready', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const waiting = updateTicket(db, ticket.id, ticket.version, {
        status: 'waiting_human',
        stageId: stages[0]!.id,
      })
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[1]!.id,
        expectedVersion: waiting.version,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const move = res.body.move as { action: string }
      assert.equal(move.action, 'ack_advance')
      const updated = res.body.ticket as TicketJson
      assert.equal(updated.status, 'ready')
      assert.equal(updated.stageId, stages[1]!.id)
    })
    db.close()
  })

  it('skip_forward 需确认;落到 human 站 → waiting_human', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const ready = updateTicket(db, ticket.id, ticket.version, {
        status: 'ready',
        stageId: stages[0]!.id,
      })
      const humanStage = stages.find((s) => s.kind === 'human')
      assert.ok(humanStage)
      const denied = await call(base, 'POST', movePath(ticket.id), {
        toStageId: humanStage.id,
        expectedVersion: ready.version,
      })
      assert.equal(denied.status, 422)
      assert.equal(denied.body.code, 'confirm_required')
      const deniedDetail = denied.body.detail as {
        skippedStages: { name: string }[]
        abandonedStage: { id: string; name: string } | null
      }
      assert.equal(deniedDetail.abandonedStage?.id, stages[0]!.id)
      assert.ok(deniedDetail.skippedStages.length > 0)

      const ok = await call(base, 'POST', movePath(ticket.id), {
        toStageId: humanStage.id,
        expectedVersion: ready.version,
        confirmSkippedStages: true,
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      const move = ok.body.move as {
        action: string
        skippedStages: { name: string }[]
        abandonedStage: { name: string } | null
      }
      assert.equal(move.action, 'skip_forward')
      assert.equal(move.abandonedStage?.name, stages[0]!.name)
      assert.equal((ok.body.ticket as TicketJson).status, 'waiting_human')
      assert.equal((ok.body.ticket as TicketJson).stageId, humanStage.id)
      const comments = listComments(db, ticket.id)
      assert.ok(comments.some((c) => /工作由人工判定不需要/.test(c.body)))
    })
    db.close()
  })

  it('ready 拖到下一站无 confirm → 422,detail 区分 abandonedStage 与 skippedStages', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const ready = updateTicket(db, ticket.id, ticket.version, {
        status: 'ready',
        stageId: stages[0]!.id,
      })
      const denied = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[1]!.id,
        expectedVersion: ready.version,
      })
      assert.equal(denied.status, 422)
      assert.equal(denied.body.code, 'confirm_required')
      const detail = denied.body.detail as {
        action: string
        skippedStages: { name: string }[]
        abandonedStage: { id: string; name: string } | null
      }
      assert.equal(detail.action, 'skip_forward')
      assert.deepEqual(detail.skippedStages, [])
      assert.equal(detail.abandonedStage?.id, stages[0]!.id)
      assert.equal(detail.abandonedStage?.name, stages[0]!.name)
      assert.match(String(denied.body.error), /放弃当前站/)

      const ok = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[1]!.id,
        expectedVersion: ready.version,
        confirmSkippedStages: true,
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      const move = ok.body.move as {
        action: string
        skippedStages: unknown[]
        abandonedStage: { name: string } | null
      }
      assert.equal(move.action, 'skip_forward')
      assert.deepEqual(move.skippedStages, [])
      assert.equal(move.abandonedStage?.name, stages[0]!.name)
      const comments = listComments(db, ticket.id)
      assert.ok(
        comments.some((c) =>
          new RegExp(`「${stages[0]!.name}」站的工作由人工判定不需要`).test(c.body),
        ),
      )
      assert.ok(!comments.some((c) => /被跳过的站/.test(c.body)))
    })
    db.close()
  })

  it('send_back 无理由 → 422;有理由则打回且理由进评论', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const waiting = updateTicket(db, ticket.id, ticket.version, {
        status: 'waiting_human',
        stageId: stages[3]!.id,
      })
      const denied = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[2]!.id,
        expectedVersion: waiting.version,
      })
      assert.equal(denied.status, 422)
      assert.equal(denied.body.code, 'reason_required')

      const ok = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[2]!.id,
        expectedVersion: waiting.version,
        reason: '复现步骤没过,请补最小步骤',
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      assert.equal((ok.body.move as { action: string }).action, 'send_back')
      const updated = ok.body.ticket as TicketJson
      assert.equal(updated.status, 'ready')
      assert.equal(updated.stageId, stages[2]!.id)
      const comments = listComments(db, ticket.id)
      assert.ok(comments.some((c) => /打回重做/.test(c.body) && /复现步骤没过/.test(c.body)))
    })
    db.close()
  })

  it('return_to_backlog: status→backlog', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const ready = updateTicket(db, ticket.id, ticket.version, {
        status: 'ready',
        stageId: stages[0]!.id,
      })
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: null,
        expectedVersion: ready.version,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal((res.body.move as { action: string }).action, 'return_to_backlog')
      assert.equal((res.body.ticket as TicketJson).status, 'backlog')
      assert.equal((res.body.ticket as TicketJson).stageId, stages[0]!.id)
    })
    db.close()
  })

  it('reopen: 终态拖到站,需确认', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const done = updateTicket(db, ticket.id, ticket.version, {
        status: 'done',
        stageId: stages[5]?.id ?? stages.at(-1)!.id,
        closedAt: Date.now(),
      })
      const denied = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[0]!.id,
        expectedVersion: done.version,
      })
      assert.equal(denied.status, 422)
      assert.equal(denied.body.code, 'confirm_required')

      const ok = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[0]!.id,
        expectedVersion: done.version,
        confirmSkippedStages: true,
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      assert.equal((ok.body.move as { action: string }).action, 'reopen')
      assert.equal((ok.body.ticket as TicketJson).status, 'ready')
    })
    db.close()
  })

  it('目标=当前站 → 200 noop,version 不变', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const ready = updateTicket(db, ticket.id, ticket.version, {
        status: 'ready',
        stageId: stages[1]!.id,
      })
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[1]!.id,
        expectedVersion: ready.version,
      })
      assert.equal(res.status, 200)
      assert.equal((res.body.move as { action: string }).action, 'noop')
      assert.equal((res.body.ticket as TicketJson).version, ready.version)
    })
    db.close()
  })
})

describe('POST /move 拒绝分支', () => {
  it('agent 身份 → 403,不信 body.actor', async () => {
    const db = freshDb()
    let ident = ''
    let version = 0
    let stageId = ''
    await withServer(humanCtx(db), async (base) => {
      const seeded = await setup(base, db)
      ident = seeded.ticket.identifier
      version = seeded.ticket.version
      stageId = seeded.stages[0]!.id
    })
    await withServer(agentCtx(db), async (base) => {
      const res = await call(base, 'POST', movePath(ident), {
        toStageId: stageId,
        expectedVersion: version,
        actor: 'human',
      })
      assert.equal(res.status, 403)
      assert.equal(res.body.code, 'forbidden')
    })
    db.close()
  })

  it('running 未给 cancelRunningRun → 409 running_run_active,detail.runId', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const running = updateTicket(db, ticket.id, ticket.version, {
        status: 'running',
        stageId: stages[0]!.id,
      })
      const run = acquireLease(
        db,
        ticket.id,
        stages[0]!.id,
        'agent:coding-assistant',
        50 * 60 * 1000,
        {
          agentId: 'coding-assistant',
          trigger: 'manual',
        },
      )
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: null,
        expectedVersion: running.version,
      })
      assert.equal(res.status, 409)
      assert.equal(res.body.code, 'running_run_active')
      const detail = res.body.detail as { runId: string }
      assert.equal(detail.runId, run.id)
      assert.equal(getTicket(db, ticket.id)?.status, 'running')
    })
    db.close()
  })

  it('cancelRunningRun=true 时先释放 lease 再退回积压', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const running = updateTicket(db, ticket.id, ticket.version, {
        status: 'running',
        stageId: stages[0]!.id,
      })
      acquireLease(db, ticket.id, stages[0]!.id, 'agent:coding-assistant', 50 * 60 * 1000, {
        agentId: 'coding-assistant',
        trigger: 'manual',
      })
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: null,
        expectedVersion: running.version,
        cancelRunningRun: true,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal((res.body.ticket as TicketJson).status, 'backlog')
      assert.equal(getActiveLease(db, ticket.id), null)
    })
    db.close()
  })

  it('blocked 且有未解除依赖、往后续站 → 422 blocked_dependency', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { projectId, ticket, stages } = await setup(base, db)
      const blockerRes = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'bug',
        title: '挡路的单',
      })
      const blocker = blockerRes.body.ticket as TicketJson
      addRelation(db, {
        fromTicketId: blocker.id,
        toTicketId: ticket.id,
        kind: 'blocks',
      })
      const blocked = updateTicket(db, ticket.id, ticket.version, {
        status: 'blocked',
        stageId: stages[0]!.id,
        blockedReason: '被挡住',
      })
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[2]!.id,
        expectedVersion: blocked.version,
        confirmSkippedStages: true,
      })
      assert.equal(res.status, 422)
      assert.equal(res.body.code, 'blocked_dependency')
      const detail = res.body.detail as { blockers: { identifier: string }[] }
      assert.equal(detail.blockers[0]?.identifier, blocker.identifier)
    })
    db.close()
  })

  it('目标 stage 属于别的流水线 → 422 stage_pipeline_mismatch', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { projectId, ticket } = await setup(base, db)
      const feat = listPipelines(db, projectId).find((p) => p.ticketType === 'feature')
      assert.ok(feat)
      const other = listStages(db, feat.id)[0]
      assert.ok(other)
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: other.id,
        expectedVersion: ticket.version,
        confirmSkippedStages: true,
      })
      assert.equal(res.status, 422)
      assert.equal(res.body.code, 'stage_pipeline_mismatch')
    })
    db.close()
  })

  it('expectedVersion 不匹配 → 409 version_conflict', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: stages[0]!.id,
        expectedVersion: 0,
      })
      assert.equal(res.status, 409)
      assert.equal(res.body.code, 'version_conflict')
    })
    db.close()
  })
})

describe('打回理由进入目标站 agent prompt', () => {
  it('send_back 的 reason 出现在 renderPrompt 的 {{comments}} 里', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { ticket, stages } = await setup(base, db)
      const from = stages.find((s) => s.name === '自验') ?? stages[3]!
      const to = stages.find((s) => s.name === '修复') ?? stages[2]!
      const waiting = updateTicket(db, ticket.id, ticket.version, {
        status: 'waiting_human',
        stageId: from.id,
      })
      const reason = '复现步骤没过,请补最小步骤再送审'
      const res = await call(base, 'POST', movePath(ticket.id), {
        toStageId: to.id,
        expectedVersion: waiting.version,
        reason,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const comments = listComments(db, ticket.id)
      const rendered = renderPrompt({
        template: to.promptTemplate,
        ticket: { identifier: ticket.identifier, title: '登录 500', body: 'x' },
        stage: { name: to.name, exitChecklist: to.exitChecklist },
        comments,
      })
      assert.match(rendered.prompt, /复现步骤没过/)
      assert.match(rendered.prompt, /打回重做/)
      assert.match(rendered.prompt, /\[human\/user:default\]/)
    })
    db.close()
  })
})

describe('stage PATCH 运维/内容字段拒绝 agent', () => {
  it('agent 改 patrolCron / promptTemplate / toolsets → 403;改 name 可以', async () => {
    const db = freshDb()
    let stageId = ''
    await withServer(humanCtx(db), async (base) => {
      const { stages } = await setup(base, db)
      stageId = stages[0]!.id
    })
    await withServer(agentCtx(db), async (base) => {
      for (const body of [
        { patrolCron: '0 9 * * *' },
        { patrolEnabled: false },
        { circuitBreakerThreshold: 99 },
        { autoClose: true },
        { promptTemplate: 'agent 试图削弱后续审查' },
        { toolsets: ['shell'] },
      ]) {
        const res = await call(base, 'PATCH', `/api/board/stages/${stageId}`, body)
        assert.equal(res.status, 403, JSON.stringify({ body, res: res.body }))
        assert.equal(res.body.code, 'forbidden')
      }
      const name = await call(base, 'PATCH', `/api/board/stages/${stageId}`, {
        name: 'agent 仍可改站名',
      })
      assert.equal(name.status, 200, JSON.stringify(name.body))
    })
    db.close()
  })

  it('human 仍可改 promptTemplate / toolsets', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { stages } = await setup(base, db)
      const res = await call(base, 'PATCH', `/api/board/stages/${stages[0]!.id}`, {
        promptTemplate: '人改的提示词 {{ticket.title}}',
        toolsets: ['filesystem'],
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const stage = res.body.stage as { promptTemplate: string; toolsets: string[] }
      assert.equal(stage.promptTemplate, '人改的提示词 {{ticket.title}}')
      assert.deepEqual(stage.toolsets, ['filesystem'])
    })
    db.close()
  })
})

describe('board 响应 allowedMoves / backlog / 默认 ticketType', () => {
  it('backlog 票在顶层 backlog,不在 columns;每张卡带 allowedMoves', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const { projectId, ticket, stages } = await setup(base, db)
      const board = await call(base, 'GET', `/api/board/projects/${projectId}/board`)
      assert.equal(board.status, 200, JSON.stringify(board.body))
      const backlog = board.body.backlog as { tickets: TicketJson[] }
      assert.ok(backlog.tickets.some((t) => t.id === ticket.id))
      const columns = board.body.columns as { stage: { id: string }; tickets: TicketJson[] }[]
      for (const col of columns) {
        assert.ok(!col.tickets.some((t) => t.id === ticket.id), 'backlog 票不得出现在 columns')
      }
      const card = backlog.tickets.find((t) => t.id === ticket.id)
      assert.ok(
        card?.allowedMoves?.some((m) => m.action === 'promote' && m.toStageId === stages[0]!.id),
      )
      assert.ok(card?.allowedMoves?.some((m) => m.action === 'promote_at_stage'))
    })
    db.close()
  })

  it('未指定 ticketType 时选非终态最多的 type;显式指定仍尊重', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const created = await call(base, 'POST', '/api/board/projects', { key: 'OCV5', name: 'V5' })
      const projectId = (created.body.project as { id: string }).id
      const feat = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'feature',
        title: '唯一需求',
      })
      assert.equal(feat.status, 201)
      const auto = await call(base, 'GET', `/api/board/projects/${projectId}/board`)
      assert.equal(auto.body.ticketType, 'feature', JSON.stringify(auto.body))
      const backlog = auto.body.backlog as { tickets: TicketJson[] }
      assert.equal(backlog.tickets.length, 1)
      assert.equal(backlog.tickets[0]?.type, 'feature')

      const forced = await call(
        base,
        'GET',
        `/api/board/projects/${projectId}/board?ticketType=bug`,
      )
      assert.equal(forced.body.ticketType, 'bug')
      const bugBacklog = forced.body.backlog as { tickets: TicketJson[] }
      assert.equal(bugBacklog.tickets.length, 0)
    })
    db.close()
  })
})

describe('新建单据 status', () => {
  it('默认 backlog;human 可显式 ready;agent 显式 ready → 403', async () => {
    const db = freshDb()
    await withServer(humanCtx(db), async (base) => {
      const created = await call(base, 'POST', '/api/board/projects', { key: 'OCV5', name: 'V5' })
      const projectId = (created.body.project as { id: string }).id
      const def = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'bug',
        title: '默认积压',
      })
      assert.equal((def.body.ticket as TicketJson).status, 'backlog')
      const ready = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'bug',
        title: '直接开工',
        status: 'ready',
      })
      assert.equal(ready.status, 201, JSON.stringify(ready.body))
      assert.equal((ready.body.ticket as TicketJson).status, 'ready')
    })
    await withServer(agentCtx(db), async (base) => {
      const projects = await call(base, 'GET', '/api/board/projects')
      const projectId = (projects.body.items as { id: string }[])[0]!.id
      const res = await call(base, 'POST', '/api/board/tickets', {
        projectId,
        type: 'bug',
        title: 'AI 想自己开工',
        status: 'ready',
      })
      assert.equal(res.status, 403)
    })
    db.close()
  })
})
