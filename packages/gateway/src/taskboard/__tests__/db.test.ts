/**
 * Taskboard DAO 单测。覆盖 identifier 并发不重号、乐观锁、lease 互斥与过期
 * 抢占、relation 防环与禁跨项目。库文件落在 os.tmpdir(),跑完删除,
 * 绝不碰真实 ~/.openclaude。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/db.test.ts
 */
import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { createActivity, listActivities } from '../db/activity.js'
import { createComment, listComments } from '../db/comments.js'
import {
  TASKBOARD_DDL_V1,
  TASKBOARD_SCHEMA_VERSION,
  TaskboardCrossProjectError,
  TaskboardCycleError,
  type TaskboardDb,
  TaskboardLeaseHeld,
  TaskboardSingleParentError,
  TaskboardVersionConflict,
  getSchemaVersion,
  migrate,
  openTaskboardDb,
} from '../db/index.js'
import { createPipeline, getPipeline, updatePipeline } from '../db/pipelines.js'
import { archiveProject, createProject, getProject, updateProject } from '../db/projects.js'
import { addRelation, listRelations } from '../db/relations.js'
import { acquireLease, getActiveLease, reapExpiredLeases, releaseLease } from '../db/runs.js'
import {
  createTicket,
  getTicket,
  getTicketByIdentifier,
  listTickets,
  updateTicket,
} from '../db/tickets.js'
import { GUARDRAIL_DEFAULTS } from '../domain.js'

const dirs: string[] = []

function freshDb(): { dir: string; db: TaskboardDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-dao-'))
  dirs.push(dir)
  const path = join(dir, 'taskboard.db')
  const db = openTaskboardDb(path)
  return { dir, db, path }
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('schema / migrate', () => {
  it('建表后 user_version=2,重复 migrate 不报错不改版本', () => {
    const { db } = freshDb()
    assert.equal(getSchemaVersion(db), TASKBOARD_SCHEMA_VERSION)
    migrate(db)
    migrate(db)
    assert.equal(getSchemaVersion(db), TASKBOARD_SCHEMA_VERSION)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tb_%'`)
      .all() as { name: string }[]
    const names = tables.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'tb_pipeline',
      'tb_pipeline_stage',
      'tb_pipeline_template',
      'tb_project',
      'tb_settings',
      'tb_ticket',
      'tb_ticket_activity',
      'tb_ticket_comment',
      'tb_ticket_relation',
      'tb_ticket_run',
    ])
    db.close()
  })

  it('必要索引存在', () => {
    const { db } = freshDb()
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tb_%'`)
      .all() as { name: string }[]
    const names = new Set(idx.map((i) => i.name))
    assert.ok(names.has('idx_tb_ticket_status_stage'))
    assert.ok(names.has('idx_tb_ticket_project'))
    assert.ok(names.has('idx_tb_ticket_run_ticket_created'))
    assert.ok(names.has('idx_tb_ticket_run_stage_status'))
    assert.ok(names.has('idx_tb_ticket_activity_ticket_created'))
    db.close()
  })

  it('v1 库 migrate 到 v2 只加模板表,已有项目行保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-tb-v1-'))
    dirs.push(dir)
    const path = join(dir, 'taskboard.db')
    const raw = new Database(path)
    raw.pragma('foreign_keys = ON')
    raw.exec(TASKBOARD_DDL_V1)
    raw.pragma('user_version = 1')
    raw
      .prepare(
        `INSERT INTO tb_project (id, key, name, description, workspace, labels, archived_at, created_at, updated_at, next_ticket_seq)
         VALUES ('p1', 'OLD', '旧项目', NULL, NULL, '[]', NULL, 1, 1, 0)`,
      )
      .run()
    raw.close()
    const db = openTaskboardDb(path)
    assert.equal(getSchemaVersion(db), 2)
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'tb_pipeline_template'`,
      )
      .all() as { name: string }[]
    assert.equal(tables.length, 1)
    const project = db.prepare(`SELECT key FROM tb_project WHERE id = 'p1'`).get() as {
      key: string
    }
    assert.equal(project.key, 'OLD')
    db.close()
  })
})

describe('project + JSON 列', () => {
  it('labels 出库是 string[],不是 JSON 文本;key 自动大写', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'ocv5', name: 'V5', labels: ['core', 'selfhost'] })
    assert.equal(p.key, 'OCV5')
    assert.deepEqual(p.labels, ['core', 'selfhost'])
    const again = getProject(db, p.id)
    assert.deepEqual(again?.labels, ['core', 'selfhost'])
    const archived = archiveProject(db, p.id)
    assert.ok(archived.archivedAt !== null)
    const renamed = updateProject(db, p.id, { name: 'V5-renamed' })
    assert.equal(renamed.name, 'V5-renamed')
    assert.equal(renamed.key, 'OCV5')
    db.close()
  })
})

describe('identifier 分配', () => {
  it('形如 KEY-n,单调不重号,createTicket 不接受 identifier', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const seen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      const t = createTicket(db, {
        projectId: p.id,
        type: 'chore',
        title: `t${i}`,
        reporter: 'user:test',
      })
      assert.equal(t.identifier, `OCV5-${i + 1}`)
      assert.equal(t.version, 1)
      assert.ok(!seen.has(t.identifier))
      seen.add(t.identifier)
    }
    assert.equal(getTicketByIdentifier(db, 'OCV5-5')?.title, 't4')
    db.close()
  })

  it('identifier 列有 UNIQUE 约束兜底', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    createTicket(db, { projectId: p.id, type: 'bug', title: 'a', reporter: 'u' })
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO tb_ticket (
               id, identifier, project_id, type, title, body, status, priority,
               labels, reporter, source, version, stage_loop_count, created_at, updated_at
             ) VALUES ('x','OCV5-1',?,?, 'dup','', 'backlog','P2','[]','u','manual',1,0,1,1)`,
          )
          .run(p.id, 'bug'),
      /UNIQUE/i,
    )
    db.close()
  })

  it('多进程并发建单不重号', async () => {
    const { db, path, dir } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    db.close()

    const indexHref = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), '../db/index.ts'),
    ).href
    const workers = 4
    const per = 8
    const jobs = Array.from({ length: workers }, (_, wid) => {
      const childFile = join(dir, `ident-child-${wid}.ts`)
      writeFileSync(
        childFile,
        `
import { createTicket, openTaskboardDb } from ${JSON.stringify(indexHref)}
const db = openTaskboardDb(${JSON.stringify(path)})
const ids: string[] = []
for (let i = 0; i < ${per}; i++) {
  const t = createTicket(db, {
    projectId: ${JSON.stringify(p.id)},
    type: 'chore',
    title: 'w-${wid}-' + i,
    reporter: 'worker',
  })
  ids.push(t.identifier)
}
process.stdout.write(JSON.stringify(ids))
db.close()
`,
      )
      return new Promise<string[]>((resolve, reject) => {
        const child = spawn('npx', ['tsx', childFile], {
          cwd: process.cwd(),
          env: process.env,
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
          out += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          err += String(chunk)
        })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(err || `child ${wid} exit ${code}`))
            return
          }
          resolve(JSON.parse(out) as string[])
        })
      })
    })

    const batches = await Promise.all(jobs)
    const all = batches.flat()
    assert.equal(all.length, workers * per)
    assert.equal(new Set(all).size, workers * per)
    const nums = all.map((id) => Number(id.slice('OCV5-'.length))).sort((a, b) => a - b)
    assert.deepEqual(
      nums,
      Array.from({ length: workers * per }, (_, i) => i + 1),
    )
  })
})

describe('乐观锁', () => {
  it('版本不匹配抛 TaskboardVersionConflict,成功则 version+1', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const t = createTicket(db, { projectId: p.id, type: 'bug', title: 'x', reporter: 'u' })
    assert.equal(t.version, 1)
    const t2 = updateTicket(db, t.id, 1, { title: 'y' })
    assert.equal(t2.version, 2)
    assert.equal(t2.title, 'y')
    assert.ok(t2.updatedAt >= t.updatedAt)
    assert.throws(
      () => updateTicket(db, t.id, 1, { title: 'z' }),
      (err: unknown) => {
        assert.ok(err instanceof TaskboardVersionConflict)
        assert.equal(err.code, 'version_conflict')
        assert.equal(err.expectedVersion, 1)
        assert.equal(err.actualVersion, 2)
        return true
      },
    )
    assert.equal(getTicket(db, t.id)?.title, 'y')
    db.close()
  })
})

describe('lease', () => {
  it('互斥:未过期不可再抢;默认 TTL 为 50 分钟', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const t = createTicket(db, { projectId: p.id, type: 'bug', title: 'x', reporter: 'u' })
    const now = 1_700_000_000_000
    const run = acquireLease(db, t.id, 'stage-a', 'tick-1', undefined, { now })
    assert.equal(run.status, 'running')
    assert.equal(run.leaseOwner, 'tick-1')
    assert.equal(run.leaseExpiresAt, now + GUARDRAIL_DEFAULTS.leaseTtlMs)
    assert.equal(GUARDRAIL_DEFAULTS.leaseTtlMs, 50 * 60 * 1000)
    assert.throws(
      () => acquireLease(db, t.id, 'stage-a', 'tick-2', undefined, { now: now + 1000 }),
      (err: unknown) => err instanceof TaskboardLeaseHeld,
    )
    const held = getActiveLease(db, t.id, now + 1000)
    assert.equal(held?.id, run.id)
    const released = releaseLease(db, run.id, 'tick-1')
    assert.equal(released.leaseOwner, null)
    const again = acquireLease(db, t.id, 'stage-a', 'tick-2', 60_000, { now: now + 2000 })
    assert.equal(again.leaseOwner, 'tick-2')
    assert.notEqual(again.id, run.id)
    db.close()
  })

  it('过期 lease 可被抢占,reapExpiredLeases 标 timeout', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const t = createTicket(db, { projectId: p.id, type: 'bug', title: 'x', reporter: 'u' })
    const now = 1_000_000
    const first = acquireLease(db, t.id, 'stage-a', 'owner-a', 5_000, { now })
    const reaped = reapExpiredLeases(db, now + 6_000)
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].id, first.id)
    assert.equal(reaped[0].status, 'timeout')
    assert.equal(reaped[0].leaseOwner, null)
    const second = acquireLease(db, t.id, 'stage-b', 'owner-b', 5_000, { now: now + 6_000 })
    assert.equal(second.leaseOwner, 'owner-b')
    assert.notEqual(second.id, first.id)
    db.close()
  })
})

describe('relation', () => {
  it('parent 单父、防环;blocks 防环;related 归一化去重;禁跨项目', () => {
    const { db } = freshDb()
    const a = createProject(db, { key: 'AAA', name: 'A' })
    const b = createProject(db, { key: 'BBB', name: 'B' })
    const t1 = createTicket(db, { projectId: a.id, type: 'bug', title: '1', reporter: 'u' })
    const t2 = createTicket(db, { projectId: a.id, type: 'bug', title: '2', reporter: 'u' })
    const t3 = createTicket(db, { projectId: a.id, type: 'bug', title: '3', reporter: 'u' })
    const other = createTicket(db, { projectId: b.id, type: 'bug', title: 'x', reporter: 'u' })

    addRelation(db, { fromTicketId: t1.id, toTicketId: t2.id, kind: 'parent' })
    assert.throws(
      () => addRelation(db, { fromTicketId: t1.id, toTicketId: t3.id, kind: 'parent' }),
      (err: unknown) => err instanceof TaskboardSingleParentError,
    )
    assert.throws(
      () => addRelation(db, { fromTicketId: t2.id, toTicketId: t1.id, kind: 'parent' }),
      (err: unknown) => err instanceof TaskboardCycleError,
    )
    addRelation(db, { fromTicketId: t2.id, toTicketId: t3.id, kind: 'parent' })
    assert.throws(
      () => addRelation(db, { fromTicketId: t3.id, toTicketId: t1.id, kind: 'parent' }),
      (err: unknown) => err instanceof TaskboardCycleError,
    )

    addRelation(db, { fromTicketId: t1.id, toTicketId: t2.id, kind: 'blocks' })
    addRelation(db, { fromTicketId: t2.id, toTicketId: t3.id, kind: 'blocks' })
    assert.throws(
      () => addRelation(db, { fromTicketId: t3.id, toTicketId: t1.id, kind: 'blocks' }),
      (err: unknown) => err instanceof TaskboardCycleError,
    )

    const rel = addRelation(db, { fromTicketId: t2.id, toTicketId: t1.id, kind: 'related' })
    const [lo, hi] = t1.id < t2.id ? [t1.id, t2.id] : [t2.id, t1.id]
    assert.equal(rel.fromTicketId, lo)
    assert.equal(rel.toTicketId, hi)
    assert.throws(
      () => addRelation(db, { fromTicketId: t1.id, toTicketId: t2.id, kind: 'related' }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'duplicate_relation')
        return true
      },
    )
    assert.equal(listRelations(db, t1.id).length, 3)

    assert.throws(
      () => addRelation(db, { fromTicketId: t1.id, toTicketId: other.id, kind: 'related' }),
      (err: unknown) => err instanceof TaskboardCrossProjectError,
    )
    db.close()
  })
})

describe('comment / activity / list', () => {
  it('评论与活动可写可读;列表筛选生效', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const t = createTicket(db, {
      projectId: p.id,
      type: 'feature',
      title: 'hello',
      reporter: 'user:1',
      labels: ['ui'],
    })
    createComment(db, {
      ticketId: t.id,
      authorKind: 'human',
      author: 'user:1',
      body: '先看一眼',
    })
    createActivity(db, {
      ticketId: t.id,
      actor: 'human',
      actorId: 'user:1',
      action: 'field_updated',
      field: 'title',
      fromValue: 'hello',
      toValue: 'hello',
    })
    assert.equal(listComments(db, t.id).length, 1)
    assert.equal(listActivities(db, t.id).length, 1)
    const listed = listTickets(db, { projectId: p.id, type: 'feature', q: 'hello' })
    assert.equal(listed.total, 1)
    assert.deepEqual(listed.items[0].labels, ['ui'])
    db.close()
  })
})

describe('pipeline isDefault 互斥', () => {
  it('同项目同类型连设两条默认,先设的那条自动变 false', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const first = createPipeline(db, {
      projectId: p.id,
      name: 'bug-a',
      ticketType: 'bug',
      isDefault: true,
    })
    const second = createPipeline(db, {
      projectId: p.id,
      name: 'bug-b',
      ticketType: 'bug',
      isDefault: true,
    })
    assert.equal(second.isDefault, true)
    assert.equal(getPipeline(db, first.id)?.isDefault, false)
    assert.equal(getPipeline(db, second.id)?.isDefault, true)
    db.close()
  })

  it('updatePipeline 把另一条设为默认,原默认被降', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const first = createPipeline(db, {
      projectId: p.id,
      name: 'feat-a',
      ticketType: 'feature',
      isDefault: true,
    })
    const second = createPipeline(db, {
      projectId: p.id,
      name: 'feat-b',
      ticketType: 'feature',
      isDefault: false,
    })
    const updated = updatePipeline(db, second.id, { isDefault: true })
    assert.equal(updated.isDefault, true)
    assert.equal(getPipeline(db, first.id)?.isDefault, false)
    db.close()
  })

  it('ticketType=null 的通用兜底线同样互斥;不同类型互不影响', () => {
    const { db } = freshDb()
    const p = createProject(db, { key: 'OCV5', name: 'V5' })
    const fallbackA = createPipeline(db, {
      projectId: p.id,
      name: 'generic-a',
      ticketType: null,
      isDefault: true,
    })
    const fallbackB = createPipeline(db, {
      projectId: p.id,
      name: 'generic-b',
      ticketType: null,
      isDefault: true,
    })
    const bug = createPipeline(db, {
      projectId: p.id,
      name: 'bug-default',
      ticketType: 'bug',
      isDefault: true,
    })
    assert.equal(getPipeline(db, fallbackA.id)?.isDefault, false)
    assert.equal(getPipeline(db, fallbackB.id)?.isDefault, true)
    assert.equal(bug.isDefault, true)
    db.close()
  })
})
