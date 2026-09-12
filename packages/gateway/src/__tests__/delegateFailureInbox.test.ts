import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb, DELEGATE_DURABLE_SCHEMA_VERSION, type DelegateFailureCursor } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { DelegateInflightSurfaceStore } from '../delegateInflightSurface.js'
import { effectiveDelegateOutcome } from '../delegateOutcome.js'

const parent = 'agent:main:webchat:dm:inbox-test'
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-206-inbox-'))
  const db = new DelegateDurableDb(join(dir, 'jobs.db'))
  const surface = new DelegateInflightSurfaceStore({ dbPath: join(dir, 'surface.db'), now: () => 1000 })
  const store = new DelegateJobStore({ durable: db, sm: true, failureInbox: true, now: () => 1000,
    ttlMs: 100, onTerminal: job => surface.projectJob(job) })
  t.after(() => { store.close(); surface.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, db, surface, store }
}
function create(store: DelegateJobStore, user = '3') {
  const created = store.create('worker', {
    parentSessionKey: parent, callbackOriginUserId: user, sessionKey: 'agent:worker:child-test',
  })
  assert.ok('jobId' in created)
  const snap = store.snapshotOf(created.jobId)!
  assert.ok(snap.claimToken)
  return { id: created.jobId, fence: { claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch } }
}
const failure = { httpStatus: 200, body: { ok: false, error: 'secret=should-not-enter-inbox' } }

test('actual terminal commit projects child_error as failed without rewriting authoritative state', t => {
  const { store, surface, db } = fixture(t)
  const { id, fence } = create(store)
  assert.equal(store.complete(id, failure, fence), true)
  assert.equal(store.snapshotOf(id)?.state, 'completed', 'legacy settlement remains unchanged')
  assert.equal(surface.get(id)?.state, 'failed', 'user-visible terminal must not say success')
  assert.equal(surface.get(id)?.foldedGroup?.status, 'failed')
  const row = db.listUnacknowledgedFailures('3').items[0]
  assert.equal(row.jobId, id)
  assert.equal(row.childSession, 'agent:worker:child-test')
  assert.equal(row.summaryText, '子任务失败，可展开详情')
  assert.equal(JSON.stringify(row).includes('secret'), false)
  surface.foldTerminal({ jobId: id, state: 'completed', group: {
    runId: 'late', agentId: 'worker', goal: '', status: 'ok', resultSummary: 'late success', completedAt: 2000,
  } })
  assert.equal(surface.get(id)?.state, 'failed', 'late runner fold cannot overwrite authority')
})

test('only structured failure changes effective outcome; nonterminal/cancel remain distinct', () => {
  assert.equal(effectiveDelegateOutcome({ state: 'completed', result: { body: { output: 'error: discussed' } } }), 'completed')
  assert.equal(effectiveDelegateOutcome({ state: 'completed', result: { body: { ok: false } } }), 'failed')
  assert.equal(effectiveDelegateOutcome({ state: 'running', failureClass: 'child_error' }), 'running')
  assert.equal(effectiveDelegateOutcome({ state: 'cancelled', failureClass: 'child_error' }), 'cancelled')
})

test('inbox insert failure rolls back actual terminal CAS and does not publish a terminal', t => {
  const { dir, store, db, surface } = fixture(t)
  const { id, fence } = create(store)
  const observer = new Database(join(dir, 'jobs.db'))
  t.after(() => observer.close())
  observer.exec(`CREATE TRIGGER reject_inbox BEFORE INSERT ON delegate_failure_inbox
    BEGIN SELECT RAISE(ABORT, 'injected inbox write failure'); END`)
  assert.throws(() => store.complete(id, failure, fence), /injected inbox write failure/)
  assert.equal(store.snapshotOf(id)?.state, 'running')
  assert.equal((observer.prepare('SELECT state FROM delegate_jobs WHERE job_id=?').get(id) as { state: string }).state, 'running')
  assert.equal(db.listUnacknowledgedFailures('3').count, 0)
  assert.equal(surface.get(id), undefined)
  observer.exec('DROP TRIGGER reject_inbox')
  assert.equal(store.complete(id, failure, fence), true)
  assert.equal(db.listUnacknowledgedFailures('3').count, 1)
  assert.equal(store.complete(id, failure, fence), false)
  assert.equal(db.listUnacknowledgedFailures('3').count, 1)
})

test('unread failures survive runtime retirement, ledger pruning and a real new process', t => {
  const { dir, store, db } = fixture(t)
  const { id, fence } = create(store)
  store.complete(id, failure, fence)
  assert.equal(store.sweep(1200), 1)
  assert.equal(db.prunePastRetention({ cutoff: 2000, keepRows: 0 }), 1)
  assert.equal(db.ledgerStats().total, 0)
  assert.equal(db.listUnacknowledgedFailures('3').count, 1)
  const mod = fileURLToPath(new URL('../delegateDurable.ts', import.meta.url))
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { DelegateDurableDb } from ${JSON.stringify(mod)};
    const db = new DelegateDurableDb(${JSON.stringify(join(dir, 'jobs.db'))});
    const before = db.listUnacknowledgedFailures('3');
    const foreignAck = db.acknowledgeFailure('9', ${JSON.stringify(id)}, 0, 2000);
    const ack1 = db.acknowledgeFailure('3', ${JSON.stringify(id)}, 0, 2000);
    const ack2 = db.acknowledgeFailure('3', ${JSON.stringify(id)}, 0, 3000);
    console.log(JSON.stringify({before, foreignAck, ack1, ack2, after:db.listUnacknowledgedFailures('3')}));
    db.close();`], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  const out = JSON.parse(child.stdout)
  assert.equal(out.before.count, 1)
  assert.equal(out.foreignAck, false)
  assert.equal(out.ack1, true)
  assert.equal(out.ack2, true)
  assert.equal(out.after.count, 0)
  const verify = new Database(join(dir, 'jobs.db'), { readonly: true })
  try { assert.equal((verify.prepare('SELECT ack_at FROM delegate_failure_inbox').get() as {ack_at: number}).ack_at, 2000) }
  finally { verify.close() }
})

test('indexed keyset pagination retains more than 50 failures and isolates users', t => {
  const { store, db } = fixture(t)
  const expected = new Set<string>()
  for (let i = 0; i < 73; i++) {
    const { id, fence } = create(store)
    store.complete(id, failure, fence)
    expected.add(id)
  }
  const foreign = create(store, '4')
  store.complete(foreign.id, failure, foreign.fence)
  assert.equal(db.listUnacknowledgedFailures('4').count, 1)
  assert.equal(db.listUnacknowledgedFailures('5').count, 0)
  const seen = new Set<string>()
  let before: DelegateFailureCursor | undefined
  do {
    const page = db.listUnacknowledgedFailures('3', { limit: 999, before })
    assert.equal(page.count, 73)
    assert.ok(page.items.length <= 50)
    for (const item of page.items) { assert.ok(!seen.has(item.jobId)); seen.add(item.jobId) }
    before = page.nextCursor ?? undefined
  } while (before)
  assert.deepEqual(seen, expected)
})

test('new admission is off by default, but previously enrolled jobs survive a disabled restart', t => {
  const { dir, store, db } = fixture(t)
  const enrolled = create(store)
  store.close()
  const reopenedDb = new DelegateDurableDb(join(dir, 'jobs.db'))
  const reopened = new DelegateJobStore({ sm: true, durable: reopenedDb, now: () => 1000 })
  t.after(() => reopened.close())
  assert.equal(reopened.complete(enrolled.id, failure, enrolled.fence), true)
  const legacy = create(reopened)
  assert.equal(reopened.complete(legacy.id, failure, legacy.fence), true)
  assert.equal(reopenedDb.listUnacknowledgedFailures('3').count, 1)
  assert.equal(reopenedDb.listUnacknowledgedFailures('3').items[0].jobId, enrolled.id)
  assert.equal(reopened.snapshotOf(legacy.id)?.callbackState, 'skipped_silent')
  assert.throws(() => new DelegateJobStore({ sm: true, failureInbox: true }), /requires durable/)
})

test('enabled admission refuses an unowned job without inserting anything', t => {
  const { store, db } = fixture(t)
  assert.throws(() => store.create('worker'), /requires verified owner/)
  assert.equal(db.ledgerStats().total, 0)
  assert.equal(store.size(), 0)
})

test('cursor extra fields cannot override trusted user scope or page limit', t => {
  const { store, db } = fixture(t)
  const own = create(store)
  const foreign = create(store, '4')
  store.complete(own.id, failure, own.fence)
  store.complete(foreign.id, failure, foreign.fence)
  const forged = { failedAt: 2000, jobId: 'zzz', generation: 0, userId: '4', limit: 0 }
  const result = db.listUnacknowledgedFailures('3', { before: forged, limit: 1 })
  assert.equal(result.count, 1)
  assert.deepEqual(result.items.map(item => [item.userId, item.jobId]), [['3', own.id]])
})

test('multiple real processes opening the same v4 database converge on one migration', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-206-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'jobs.db')
  new DelegateDurableDb(path).close()
  const v4 = new Database(path)
  v4.exec('DROP TABLE delegate_delivery_receipt; ALTER TABLE delegate_jobs DROP COLUMN delivery_receipt_context; DROP TABLE delegate_failure_inbox; ALTER TABLE delegate_jobs DROP COLUMN failure_inbox_enabled; PRAGMA user_version=4;')
  v4.close()
  const mod = fileURLToPath(new URL('../delegateDurable.ts', import.meta.url))
  const tasks = Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { DelegateDurableDb } from ${JSON.stringify(mod)};
      process.stdin.once('data', () => {
        const db = new DelegateDurableDb(${JSON.stringify(path)});
        if(db.listUnacknowledgedFailures('3').count !== 0) throw Error('unexpected inbox');
        db.close();
      });
      console.log('ready');`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.once('data', () => { child.stdin.end('open') })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.once('error', err => { clearTimeout(timeout); reject(err) })
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)) })
  }))
  // allSettled ensures every owned process has exited before fixture cleanup.
  const results = await Promise.allSettled(tasks)
  for (const result of results) if (result.status === 'rejected') throw result.reason
  const inspect = new Database(path, { readonly: true })
  try {
    assert.equal(inspect.pragma('user_version', { simple: true }), DELEGATE_DURABLE_SCHEMA_VERSION)
    assert.equal((inspect.prepare('PRAGMA table_info(delegate_jobs)').all() as Array<{name: string}>).filter(x => x.name === 'failure_inbox_enabled').length, 1)
  } finally { inspect.close() }
})

test('v4 upgrade keeps existing jobs and never backfills old failures', t => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-206-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'jobs.db')
  const store = new DelegateJobStore({ sm: true, durable: new DelegateDurableDb(path) })
  const { id, fence } = create(store)
  store.complete(id, failure, fence)
  store.close()
  const legacy = new Database(path)
  legacy.exec('DROP TABLE delegate_delivery_receipt; ALTER TABLE delegate_jobs DROP COLUMN delivery_receipt_context; DROP TABLE delegate_failure_inbox; ALTER TABLE delegate_jobs DROP COLUMN failure_inbox_enabled; PRAGMA user_version=4;')
  const before = legacy.prepare('SELECT * FROM delegate_jobs').get() as Record<string, unknown>
  legacy.close()
  const upgraded = new DelegateDurableDb(path)
  try {
    assert.equal(upgraded.get(id)?.state, 'completed')
    assert.equal(upgraded.listUnacknowledgedFailures('3').count, 0)
    const connection = new Database(path, { readonly: true })
    try {
      const { failure_inbox_enabled, delivery_receipt_context, ...after } = connection.prepare('SELECT * FROM delegate_jobs').get() as Record<string, unknown>
      assert.equal(failure_inbox_enabled, 0)
      assert.equal(delivery_receipt_context, null)
      assert.deepEqual(after, before)
      assert.equal(connection.pragma('user_version', { simple: true }), DELEGATE_DURABLE_SCHEMA_VERSION)
    } finally { connection.close() }
  } finally { upgraded.close() }
})
