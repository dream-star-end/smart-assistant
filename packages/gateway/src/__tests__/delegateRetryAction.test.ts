/** Original store/SQLite acceptance, claims, terminal and reconciliation.
 * Does not claim HTTP authorization/native attach/model or notifier E2E. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { reconcileDelegateJobsOnBoot } from '../delegateReconciler.js'
import type { DelegateRetrySource } from '../delegateRetrySource.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'delegate-action-')), path = join(dir, 'jobs.db')
  const db = new DelegateDurableDb(path), sql = new Database(path)
  let now = 10000
  const jobs = new DelegateJobStore({ sm: true, durable: db, ttlMs: 10, maxJobs: 4, now: () => now })
  const source: DelegateRetrySource = { version: 1, userId: 'c:71', parentSessionKey: 'agent:main:webchat:dm:private',
    parentClientSessionId: 'private', originSessionKey: 'agent:main:webchat:dm:private', childSessionKey: 'agent:child:delegate:main:private',
    targetAgentId: 'child', sourceAgentId: 'main', depth: 0, model: 'gpt-6-astra' }
  const made = jobs.create('child', { queued: true, callback: 'stdout-wait', parentSessionKey: source.parentSessionKey,
    callbackOriginUserId: source.userId, sessionKey: source.childSessionKey, retrySource: source })
  assert.ok('jobId' in made)
  assert.equal(jobs.fail(made.jobId, { failureClass: 'internal', detail: 'private original failure', httpStatus: 503 }), true)
  const key = { userId: source.userId, sourceJobId: made.jobId, generation: 0, actionId: 'private-action-00001' }
  const counts = () => ['delegate_jobs', 'delegate_retry_source', 'delegate_retry_action'].map(t => (sql.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n)
  return { dir, path, db, sql, jobs, source, key, counts, advance() { now += 1000 },
    close() { jobs.close(); sql.close() } }
}

test('action target/source/identity commit together; replay/foreign/change/busy never dispatch or ACK', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.jobs.acceptRetryAction({ ...f.key, userId: 'c:72' }, f.source), { error: 'source_unavailable' })
    assert.deepEqual(f.jobs.acceptRetryAction(f.key, { ...f.source, depth: 1 }), { error: 'source_changed' })
    const a = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in a); assert.equal(a.kind, 'accepted')
    assert.deepEqual(f.counts(), [2, 2, 1]); assert.equal(a.target?.state, 'queued'); assert.equal(a.target?.attemptNo, 0)
    assert.equal(a.target?.callback, 'origin-inject'); assert.equal(a.target?.sessionKey, f.source.childSessionKey)
    assert.equal(f.db.hasDeliveryReceiptEnrollment(a.action.targetJobId), false)
    const replay = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in replay)
    assert.equal(replay.kind, 'replay'); assert.equal(replay.action.targetJobId, a.action.targetJobId)
    assert.deepEqual(f.jobs.acceptRetryAction({ ...f.key, actionId: 'private-action-00002' }, f.source), { error: 'child_busy' })
    assert.equal(f.jobs.userFailureInbox(f.key.userId).count, 1, 'acceptance does not ACK the original failure')
    assert.deepEqual(f.counts(), [2, 2, 1])
  } finally { f.close() }
})

test('late action INSERT failure rolls target/source back; claim and terminal update actions atomically', () => {
  const f = fixture()
  try {
    f.sql.exec(`CREATE TRIGGER private_action_fault BEFORE INSERT ON delegate_retry_action BEGIN SELECT RAISE(ABORT,'action fault'); END`)
    assert.throws(() => f.jobs.acceptRetryAction(f.key, f.source), /action fault/); assert.deepEqual(f.counts(), [1, 1, 0])
    f.sql.exec('DROP TRIGGER private_action_fault')
    const a = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in a)
    f.sql.exec(`CREATE TRIGGER private_dispatch_fault BEFORE UPDATE ON delegate_retry_action
      WHEN NEW.state='dispatched' BEGIN SELECT RAISE(ABORT,'dispatch fault'); END`)
    assert.throws(() => f.jobs.claimQueued(a.action.targetJobId), /dispatch fault/)
    assert.equal(f.db.get(a.action.targetJobId)?.state, 'queued'); assert.equal(f.db.getRetryAction(f.key)?.state, 'accepted')
    f.sql.exec('DROP TRIGGER private_dispatch_fault')
    const claim = f.jobs.claimQueued(a.action.targetJobId); assert.equal(claim.ok, true); assert.ok(claim.ok)
    assert.equal(f.db.getRetryAction(f.key)?.state, 'dispatched'); assert.equal(f.db.getRetryAction(f.key)?.dispatchedAt, 10000)
    assert.equal(f.jobs.claimQueued(a.action.targetJobId).ok, false)
    assert.equal(f.jobs.fail(a.action.targetJobId, { ...claim, failureClass: 'internal', detail: 'private target failure', httpStatus: 503 }), true)
    assert.equal(f.db.getRetryAction(f.key)?.state, 'terminal'); assert.equal(f.jobs.userFailureInbox(f.key.userId).count, 2)
  } finally { f.close() }
})

test('pending callback survives TTL; replay retains target after exact runtime-row removal and source deletion', () => {
  const f = fixture()
  try {
    const a = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in a)
    assert.equal(f.jobs.fail(a.action.targetJobId, { failureClass: 'internal', detail: 'preclaim unavailable', httpStatus: 409 }), true)
    f.advance(); f.jobs.sweep(); f.jobs.pruneRetiredLedger({ retentionMs: 0, now: 100000, keepRows: 0 })
    const retained = f.db.get(a.action.targetJobId)!
    assert.equal(retained.callbackState, 'pending', 'TTL correctly retains an unacknowledged original notification')
    // Storage removal is explicit here, not forged notification ACK or a claim
    // that the pending job was naturally TTL-pruned. Tests no-FK replay identity.
    assert.equal(f.db.casDelete({ jobId: retained.id, state: retained.state, fencingEpoch: retained.fencingEpoch,
      claimToken: retained.claimToken }), true)
    assert.equal(f.db.get(a.action.targetJobId), undefined)
    const freshDb = new DelegateDurableDb(f.path), fresh = new DelegateJobStore({ sm: true, durable: freshDb })
    try {
      const replay = fresh.acceptRetryAction(f.key, f.source); assert.ok('kind' in replay)
      assert.equal(replay.kind, 'replay'); assert.equal(replay.action.targetJobId, a.action.targetJobId); assert.equal(replay.target, undefined)
      fresh.fenceDeletedRetryParent({ userId: f.source.userId, clientSessionId: f.source.parentClientSessionId })
      const deleted = fresh.acceptRetryAction(f.key, f.source); assert.ok('kind' in deleted); assert.equal(deleted.action.state, 'source_deleted')
      assert.deepEqual(fresh.acceptRetryAction({ ...f.key, actionId: 'private-action-00003' }, f.source), { error: 'source_unavailable' })
      assert.equal(f.counts()[0], 0)
    } finally { fresh.close() }
  } finally { f.close() }
})

test('deleted source prevents queued claim; accepted crash remains same target; dispatched death uses original reconciler', () => {
  const f = fixture()
  try {
    const a = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in a)
    const fresh = new DelegateJobStore({ sm: true, durable: new DelegateDurableDb(f.path), bootId: 'fresh-owner', now: () => 10000 })
    try {
      reconcileDelegateJobsOnBoot(fresh, { now: () => 10000, isChildAlive: () => false })
      assert.equal(fresh.snapshotOf(a.action.targetJobId)?.state, 'queued')
      const claim = fresh.claimQueued(a.action.targetJobId); assert.ok(claim.ok)
      const afterCrash = new DelegateJobStore({ sm: true, durable: new DelegateDurableDb(f.path), bootId: 'after-owner-death', now: () => 10000 })
      try {
        reconcileDelegateJobsOnBoot(afterCrash, { now: () => 10000, isChildAlive: () => false })
        assert.equal(afterCrash.snapshotOf(a.action.targetJobId)?.state, 'killed_by_cutover')
        assert.equal(afterCrash.getRetryAction(f.key)?.state, 'terminal'); assert.equal(afterCrash.claimQueued(a.action.targetJobId).ok, false)
      } finally { afterCrash.close() }
      const b = fresh.acceptRetryAction({ ...f.key, actionId: 'private-action-00004' }, f.source); assert.ok('kind' in b)
      fresh.fenceDeletedRetryParent({ userId: f.source.userId, clientSessionId: f.source.parentClientSessionId })
      assert.equal(fresh.claimQueued(b.action.targetJobId).ok, false)
      assert.equal(fresh.getRetryAction({ ...f.key, actionId: 'private-action-00004' })?.state, 'source_deleted')
    } finally { fresh.close() }
  } finally { f.close() }
})

test('two real Node processes race one action; one accepted target, original claim and synthetic child invocation', { timeout: 20000 }, async () => {
  const f = fixture(), fixturePath = fileURLToPath(new URL('./fixtures/delegateRetryAction.fixture.ts', import.meta.url))
  const output = join(f.dir, 'executions.txt'), children: Array<ReturnType<typeof spawn>> = []
  const closed: Array<Promise<unknown[]>> = [], ready: Array<Promise<void>> = []
  const logs: string[] = [], errors: string[] = []
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, f.path, JSON.stringify(f.key), JSON.stringify(f.source), output],
        { env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: f.dir }, stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child); closed.push(once(child, 'close')); logs[i] = ''; errors[i] = ''
      ready.push(new Promise((resolve, reject) => {
        child.stdout!.on('data', bytes => { logs[i] += bytes; if (logs[i].includes('READY\n')) resolve() })
        child.stderr!.on('data', bytes => { errors[i] += bytes })
        child.once('close', () => { if (!logs[i].includes('READY\n')) reject(new Error(errors[i])) })
      }))
    }
    deadline = setTimeout(() => children.forEach(c => c.kill('SIGKILL')), 16000)
    await Promise.all(ready); children.forEach(c => c.stdin!.end('GO\n'))
    const ends = await Promise.all(closed); ends.forEach((e, i) => assert.equal(e[0], 0, errors[i]))
    const rows = logs.map(log => JSON.parse(log.split('\n').find(l => l.startsWith('{'))!))
    assert.equal(rows.filter(r => r.kind === 'accepted').length, 1); assert.equal(rows.filter(r => r.kind === 'replay').length, 1)
    assert.equal(rows[0].target, rows[1].target)
    assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [rows[0].target])
    assert.equal(f.db.getRetryAction(f.key)?.state, 'terminal'); assert.deepEqual(f.counts(), [2, 2, 1])
  } finally { clearTimeout(deadline); children.forEach(c => c.kill('SIGKILL')); await Promise.all(closed); f.close() }
})

test('shared original execution wrapper preserves accepted retry failure instead of dropping its queued target', async () => {
  const f = fixture(), previousHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = f.dir
  try {
    const { Gateway } = await import('../server.js')
    const a = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in a)
    const gateway: any = Object.create(Gateway.prototype)
    gateway._runDelegateTask = async () => ({ kind: 'rejected', status: 429, failureClass: 'capacity_queue_full', message: 'private queue refusal' })
    gateway._dropDelegateInflightSurface = () => { throw new Error('accepted action must not lose its original queued target') }
    let callbacks = 0
    const settled = new Promise<void>(resolve => { gateway._queueSendToAgentCallback = () => { callbacks++; resolve() } })
    gateway._executeAcceptedDelegateJob({}, f.jobs, a.action.targetJobId, 'private fixed continuation', 'child', true)
    await settled
    assert.equal(f.db.get(a.action.targetJobId)?.state, 'failed')
    assert.equal(f.db.getRetryAction(f.key)?.state, 'terminal'); assert.equal(f.db.getRetryAction(f.key)?.terminalCode, 'capacity_queue_full')
    assert.equal(f.jobs.userFailureInbox(f.key.userId).count, 2); assert.equal(callbacks, 1)
    const replay = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in replay); assert.equal(replay.kind, 'replay')
    assert.equal(replay.action.targetJobId, a.action.targetJobId)
  } finally { if (previousHome === undefined) delete process.env.OPENCLAUDE_HOME; else process.env.OPENCLAUDE_HOME = previousHome; f.close() }
})

for (const phase of ['accepted', 'dispatched'] as const) test(`real SIGKILL after ${phase} keeps action target and original recovery never blind reexecutes`, { timeout: 20000 }, async () => {
  const f = fixture(), fixturePath = fileURLToPath(new URL('./fixtures/delegateRetryAction.fixture.ts', import.meta.url))
  const output = join(f.dir, 'executions.txt')
  const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, f.path, JSON.stringify(f.key), JSON.stringify(f.source), output, phase],
    { env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: f.dir }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close'); let stdout = '', stderr = ''
  const deadline = setTimeout(() => child.kill('SIGKILL'), 16000)
  try {
    const held = new Promise<{ held: string; target: string }>((resolve, reject) => {
      child.stdout!.on('data', bytes => {
        stdout += bytes
        if (stdout.includes('READY\n') && !child.stdin!.writableEnded) child.stdin!.end('GO\n')
        for (const line of stdout.split('\n')) {
          try { const row = JSON.parse(line); if (row.held) resolve(row) } catch { /* fragmented JSON */ }
        }
      })
      child.stderr!.on('data', bytes => { stderr += bytes })
      child.once('close', () => { if (!stdout.includes('"held"')) reject(new Error(stderr || 'no durable hold point')) })
    })
    const evidence = await held
    assert.equal(evidence.held, phase); assert.equal(f.db.getRetryAction(f.key)?.state, phase)
    child.kill('SIGKILL'); const [code, signal] = await closed
    assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.equal(existsSync(output), false)
    const fresh = new DelegateJobStore({ sm: true, durable: new DelegateDurableDb(f.path), bootId: 'verified-after-sigkill' })
    try {
      const replay = fresh.acceptRetryAction(f.key, f.source); assert.ok('kind' in replay)
      assert.equal(replay.kind, 'replay'); assert.equal(replay.action.targetJobId, evidence.target)
      reconcileDelegateJobsOnBoot(fresh, { isChildAlive: () => false })
      if (phase === 'accepted') {
        assert.equal(fresh.snapshotOf(evidence.target)?.state, 'queued')
        assert.equal(fresh.getRetryAction(f.key)?.state, 'accepted')
        const claim = fresh.claimQueued(evidence.target); assert.ok(claim.ok)
        assert.equal(fresh.claimQueued(evidence.target).ok, false)
      } else {
        assert.equal(fresh.snapshotOf(evidence.target)?.state, 'killed_by_cutover')
        assert.equal(fresh.getRetryAction(f.key)?.state, 'terminal')
        assert.equal(fresh.claimQueued(evidence.target).ok, false)
      }
      assert.equal(existsSync(output), false, 'original reconciliation is not an executor')
    } finally { fresh.close() }
  } finally { clearTimeout(deadline); child.kill('SIGKILL'); await closed; f.close() }
})

test('capacity rejection leaves no accepted action or target/source; later identical action remains valid', () => {
  const f = fixture(), busy: string[] = []
  try {
    for (let i = 0; i < 4; i++) {
      const made = f.jobs.create('busy', { queued: true, sessionKey: 'private-busy-' + i }); assert.ok('jobId' in made); busy.push(made.jobId)
    }
    const before = f.counts()
    assert.deepEqual(f.jobs.acceptRetryAction(f.key, f.source), { error: 'capacity' }); assert.deepEqual(f.counts(), before)
    assert.equal(f.jobs.getRetryAction(f.key), undefined)
    f.jobs.fail(busy[0]!, { failureClass: 'internal', detail: 'private release capacity', httpStatus: 503 })
    const accepted = f.jobs.acceptRetryAction(f.key, f.source); assert.ok('kind' in accepted); assert.equal(accepted.kind, 'accepted')
  } finally { f.close() }
})
