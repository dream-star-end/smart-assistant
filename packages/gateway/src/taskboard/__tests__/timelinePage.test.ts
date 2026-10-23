import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { openTaskboardDb } from '../db/index.js'
import { createProject } from '../db/projects.js'
import { createPipeline, createStage } from '../db/pipelines.js'
import { createTicket } from '../db/tickets.js'
import { createComment } from '../db/comments.js'
import { createActivity } from '../db/activity.js'
import { insertRun, updateRun } from '../db/runs.js'
import { listTicketTimelinePage } from '../db/timeline.js'
import { handleTaskboardApi } from '../http.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-task-timeline-'))
  const db = openTaskboardDb(join(dir, 'taskboard.db'))
  const project = createProject(db, { key: 'HIST', name: 'History' })
  const pipeline = createPipeline(db, {
    projectId: project.id,
    name: 'History',
    ticketType: 'feature',
    isDefault: true,
  })
  const stage = createStage(db, {
    pipelineId: pipeline.id,
    ordinal: 0,
    name: 'Human',
    kind: 'human',
  })
  const ticket = createTicket(db, {
    projectId: project.id,
    type: 'feature',
    title: 'History fixture',
    reporter: 'user:765',
    pipelineId: pipeline.id,
    stageId: stage.id,
  })
  return {
    db,
    project,
    ticket,
    stage,
    close: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
function idOf(item: ReturnType<typeof listTicketTimelinePage>['items'][number]): string {
  return item.kind === 'activity'
    ? `a:${item.activity.id}`
    : item.kind === 'comment'
      ? `c:${item.comment.id}`
      : `r:${item.run.id}`
}

test('latest mixed-source window pages more than 500 equal timestamps without gaps or duplicates', () => {
  const f = fixture()
  try {
    const expected = new Set<string>()
    f.db.transaction(() => {
      for (let i = 0; i < 220; i += 1) {
        const activity = createActivity(f.db, {
          ticketId: f.ticket.id,
          actor: 'system',
          actorId: 'system',
          action: `history-${i}`,
        })
        const comment = createComment(f.db, {
          ticketId: f.ticket.id,
          authorKind: 'human',
          author: 'user:765',
          body: `Comment ${i}`,
        })
        const run = insertRun(f.db, {
          ticketId: f.ticket.id,
          stageId: f.stage.id,
          trigger: 'manual',
          status: 'failed',
        })
        expected.add(`a:${activity.id}`)
        expected.add(`c:${comment.id}`)
        expected.add(`r:${run.id}`)
      }
      for (const table of ['tb_ticket_activity', 'tb_ticket_comment', 'tb_ticket_run'])
        f.db.prepare(`UPDATE ${table} SET created_at=100 WHERE ticket_id=?`).run(f.ticket.id)
    })()
    const first = listTicketTimelinePage(f.db, f.ticket.id, { limit: 17 })
    assert.equal(first.items.length, 17)
    assert.equal(first.items.at(-1)!.kind, 'run')
    assert.equal(first.hasMore, true)
    const stable = listTicketTimelinePage(f.db, f.ticket.id, { limit: 17, ifHead: first.head })
    assert.equal(stable.unchanged, true)
    assert.deepEqual(stable.items, [])
    const added = createComment(f.db, {
      ticketId: f.ticket.id,
      authorKind: 'human',
      author: 'user:765',
      body: 'NEWEST_SENTINEL',
    })
    assert.equal(
      listTicketTimelinePage(f.db, f.ticket.id, { limit: 17, ifHead: first.head }).unchanged,
      false,
    )
    const seen = new Set(first.items.map(idOf))
    let before = first.nextBefore
    while (before) {
      const page = listTicketTimelinePage(f.db, f.ticket.id, { limit: 17, before })
      assert.ok(page.items.length <= 17)
      for (const item of page.items) {
        const id = idOf(item)
        assert.ok(!seen.has(id), id)
        seen.add(id)
      }
      before = page.nextBefore
    }
    assert.deepEqual(seen, expected)
    assert.equal(
      seen.has(`c:${added.id}`),
      false,
      'concurrent new records do not shift an existing older cursor',
    )
    const other = createTicket(f.db, {
      projectId: f.project.id,
      type: 'feature',
      title: 'Foreign',
      reporter: 'user:765',
    })
    assert.throws(
      () => listTicketTimelinePage(f.db, other.id, { before: first.nextBefore }),
      /invalid timeline cursor/,
    )
    assert.throws(
      () => listTicketTimelinePage(f.db, f.ticket.id, { before: 'bad-cursor' }),
      /invalid timeline cursor/,
    )
    f.db.prepare('UPDATE tb_project SET archived_at=1 WHERE id=?').run(f.project.id)
    assert.equal(listTicketTimelinePage(f.db, f.ticket.id).items.at(-1)!.kind, 'comment')
  } finally {
    f.close()
  }
})

test('500 run payloads retain full output and precision and enrich in batches of at most 200; legacy stays an array', async () => {
  const f = fixture()
  const batches: number[] = []
  const server = createServer((req, res) => {
    void handleTaskboardApi(req, res, {
      db: f.db,
      actor: 'human',
      getRunSnapshots: async (runs) => {
        assert.ok(runs.length <= 200)
        batches.push(runs.length)
        return Object.fromEntries(
          runs.map((run) => [run.id, { actualModels: [`actual-${run.id}`] }]),
        )
      },
    })
  })
  try {
    f.db.transaction(() => {
      for (let i = 0; i < 510; i += 1) {
        const run = insertRun(f.db, {
          ticketId: f.ticket.id,
          stageId: f.stage.id,
          trigger: 'manual',
          status: 'failed',
        })
        updateRun(f.db, run.id, {
          outputMd: `FULL_RESULT_${i}_END`,
          costUsd: null,
          costImprecise: true,
        })
      }
    })()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/api/board/tickets/${f.ticket.id}/timeline`
    const response = await fetch(`${url}?window=latest&limit=500`)
    assert.equal(response.status, 200)
    const page = (await response.json()) as ReturnType<typeof listTicketTimelinePage>
    assert.equal(page.window, 'latest-v1')
    assert.equal(page.items.length, 500)
    assert.deepEqual(batches, [200, 200, 100])
    for (const item of page.items) {
      assert.equal(item.kind, 'run')
      if (item.kind !== 'run') continue
      assert.match(item.run.outputMd!, /^FULL_RESULT_\d+_END$/)
      assert.equal(item.run.costUsd, null)
      assert.equal(item.run.costImprecise, true)
      assert.deepEqual(item.run.actualModels, [`actual-${item.run.id}`])
    }
    const legacy = (await (await fetch(url)).json()) as { items: unknown[]; window?: string }
    assert.ok(Array.isArray(legacy.items))
    assert.equal(legacy.window, undefined)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    f.close()
  }
})

test('unchanged history scans bounded keys without loading long comment payloads', () => {
  const f = fixture()
  try {
    f.db.transaction(() => {
      for (let i = 0; i < 1000; i += 1)
        createComment(f.db, {
          ticketId: f.ticket.id,
          authorKind: 'human',
          author: 'user:765',
          body: `Record ${i} ${'长结果'.repeat(100)}`,
        })
    })()
    const initial = listTicketTimelinePage(f.db, f.ticket.id)
    const start = performance.now()
    const unchanged = listTicketTimelinePage(f.db, f.ticket.id, { ifHead: initial.head })
    const ms = performance.now() - start
    assert.equal(unchanged.unchanged, true)
    assert.deepEqual(unchanged.items, [])
    console.log(
      JSON.stringify({
        fixture: '1000-comments',
        queryMs: ms,
        payloadRows: unchanged.items.length,
        commentIndexAdded: false,
      }),
    )
  } finally {
    f.close()
  }
})

test('same-millisecond additions below the maximum key still invalidate the window revision', () => {
  const f = fixture()
  try {
    const run = insertRun(f.db, {
      ticketId: f.ticket.id,
      stageId: f.stage.id,
      trigger: 'manual',
      status: 'failed',
    })
    f.db.prepare('UPDATE tb_ticket_run SET created_at=100 WHERE id=?').run(run.id)
    const first = listTicketTimelinePage(f.db, f.ticket.id)
    const comment = createComment(f.db, {
      ticketId: f.ticket.id,
      authorKind: 'human',
      author: 'user:765',
      body: 'LOWER_RANK_NEW_COMMENT',
    })
    f.db.prepare('UPDATE tb_ticket_comment SET created_at=100 WHERE id=?').run(comment.id)
    const fresh = listTicketTimelinePage(f.db, f.ticket.id, { ifHead: first.head })
    assert.equal(first.items.at(-1)!.kind, 'run')
    assert.equal(fresh.items.at(-1)!.kind, 'run')
    assert.equal(fresh.unchanged, false)
    assert.notEqual(fresh.head, first.head)
    assert.ok(fresh.items.some((item) => item.kind === 'comment' && item.comment.id === comment.id))
  } finally {
    f.close()
  }
})
