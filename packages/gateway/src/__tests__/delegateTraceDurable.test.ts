import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'

const parentTraceId = 'a'.repeat(32)
const traceId = 'b'.repeat(32)

test('SQLite v4 upgrade adds only nullable identities; legacy writes keep working and preserve new identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-605-schema-'))
  try {
    const seedPath = join(dir, 'seed.db')
    const seed = new DelegateDurableDb(seedPath)
    seed.close()
    const shape = new Database(seedPath)
    const table = (
      shape.prepare("SELECT sql FROM sqlite_master WHERE name='delegate_jobs'").get() as {
        sql: string
      }
    ).sql
    shape.close()
    const oldPath = join(dir, 'v4.db')
    const legacy = new Database(oldPath)
    legacy.exec(table.replace(/\s*trace_id TEXT,/, '').replace(/\s*parent_trace_id TEXT,/, ''))
    legacy.pragma('user_version=4')
    const insert = legacy.prepare(
      "INSERT INTO delegate_jobs(job_id,agent_id,state,kind,created_at,updated_at,last_activity_at) VALUES(?, 'coding-assistant','queued','delegate',1,1,1)",
    )
    insert.run('old-before')
    legacy.close()
    const current = new DelegateDurableDb(oldPath)
    assert.equal(current.get('old-before')?.traceId, undefined)
    assert.equal(current.get('old-before')?.parentTraceId, undefined)
    const oldWriter = new Database(oldPath)
    oldWriter
      .prepare(
        "INSERT INTO delegate_jobs(job_id,agent_id,state,kind,created_at,updated_at,last_activity_at) VALUES('old-after','coding-assistant','queued','delegate',1,1,1)",
      )
      .run()
    assert.equal(current.get('old-after')?.traceId, undefined)
    oldWriter
      .prepare('UPDATE delegate_jobs SET trace_id=?,parent_trace_id=? WHERE job_id=?')
      .run(traceId, parentTraceId, 'old-before')
    oldWriter.prepare("UPDATE delegate_jobs SET state='running' WHERE job_id='old-before'").run()
    assert.equal(current.get('old-before')?.traceId, traceId)
    assert.equal(current.get('old-before')?.parentTraceId, parentTraceId)
    assert.equal(oldWriter.pragma('user_version', { simple: true }), 5)
    oldWriter.close()
    current.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bound child survives restart, idempotent replay and adopted attempt; stale fence cannot replace it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-605-ledger-'))
  try {
    const file = join(dir, 'jobs.db')
    const first = new DelegateJobStore({
      sm: true,
      durable: new DelegateDurableDb(file),
      bootId: 'first',
    })
    const created = first.create('coding-assistant', {
      queued: true,
      parentTraceId,
      idempotencyKey: 'proof-idempotency',
    })
    assert.ok('jobId' in created)
    const fence = first.claimQueued(created.jobId)
    assert.ok(fence.ok)
    assert.equal(
      first.bindTrace(
        created.jobId,
        { traceId, parentTraceId },
        { ...fence, fencingEpoch: fence.fencingEpoch + 1 },
      ),
      false,
    )
    assert.equal(first.bindTrace(created.jobId, { traceId, parentTraceId }, fence), true)
    first.close()
    const second = new DelegateJobStore({
      sm: true,
      durable: new DelegateDurableDb(file),
      bootId: 'second',
    })
    const before = second.snapshotOf(created.jobId)!
    assert.equal(before.traceId, traceId)
    assert.equal(before.parentTraceId, parentTraceId)
    const adopted = second.adoptOrKill(created.jobId, before.fencingEpoch, 'running')!
    assert.equal(adopted.attemptNo, before.attemptNo + 1)
    assert.equal(adopted.traceId, traceId)
    assert.equal(adopted.parentTraceId, parentTraceId)
    assert.equal(
      second.bindTrace(created.jobId, { traceId: 'c'.repeat(32), parentTraceId }, fence),
      false,
    )
    const replay = second.create('coding-assistant', {
      queued: true,
      parentTraceId: 'd'.repeat(32),
      idempotencyKey: 'proof-idempotency',
    })
    assert.ok('jobId' in replay)
    assert.equal(replay.jobId, created.jobId)
    assert.equal(second.snapshotOf(created.jobId)?.parentTraceId, parentTraceId)
    const json = second.snapshotsForPersist()[0]!
    assert.equal(json.traceId, traceId)
    assert.equal(json.parentTraceId, parentTraceId)
    second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
