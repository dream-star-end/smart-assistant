import { installDelegateSandbox } from '../../packages/gateway/src/__tests__/helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

/** Real Python/SQLite classifier only: not a deploy/cutover/master ACK test. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb } from '../../packages/gateway/src/delegateDurable.js'
import { DelegateJobStore } from '../../packages/gateway/src/delegateJobs.js'
import type { DelegateRetrySource } from '../../packages/gateway/src/delegateRetrySource.js'

const script = fileURLToPath(new URL('../delegate-consumer-compat.py', import.meta.url))
const cap = 'delegate-receipt-consumer-v2'
const parent = 'agent:main:webchat:dm:private-consumer'
const receipt = { parentTurnKey: 'private-turn', nativeToolUseId: 'private-tool',
  receiptNonceHash: createHash('sha256').update('private-secret-nonce').digest('hex') }
type Snapshot = { schema: number | null; required: number; absent: boolean; counts?: Record<string, number> }
type Verdict = { status: string; required?: number; databases?: Snapshot[]; reason?: string }

for (const mode of ['existing', 'absent'] as const) {
  test(`two readonly scans cannot fence an independent ${mode} database first writer`, { timeout: 60_000 }, async t => {
    const path = join(sandbox.root, `first-write-${mode}.db`)
    const legacy = metadata(`first-write-${mode}-legacy.json`)
    const worker = fileURLToPath(new URL('./fixtures/delegateCompatFirstWrite.fixture.ts', import.meta.url))
    const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))
    const child = spawn(process.execPath, ['--import', loader, worker, path, mode], {
      env: { PATH: process.env.PATH, HOME: sandbox.root, OPENCLAUDE_HOME: sandbox.root, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += chunk })
    const closed = once(child, 'close')
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    })
    assert.deepEqual(await once(child, 'message', { signal: AbortSignal.timeout(20_000) }), ['ready', undefined])
    const before = [run([path], legacy), run([path], legacy)]
    for (const result of before) {
      assert.equal(result.code, 0)
      assert.equal(result.verdict.required, 1)
      assert.equal(result.verdict.databases?.[0]?.absent, mode === 'absent')
    }
    const sealed = once(child, 'message', { signal: AbortSignal.timeout(20_000) })
    child.send('seal')
    assert.deepEqual(await sealed, ['sealed', undefined])
    const [code, signal] = await closed
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    assert.equal(stderr, '')
    const after = run([path], legacy)
    assert.equal(after.code, 1)
    assert.equal(after.verdict.required, 2)
    // This proves snapshot instability, not an implemented deployment barrier.
    assert.equal(after.verdict.databases?.[0]?.schema, 12)
  })
}

function metadata(name: string, capabilities: unknown = []) {
  const path = join(sandbox.root, name)
  writeFileSync(path, JSON.stringify({ capabilities }))
  return path
}
function run(paths: string[], runtime: string, master = runtime, extra: string[] = []) {
  const child = spawnSync('python3', [script, ...paths.flatMap(path => ['--database', path]),
    '--runtime-manifest', runtime, '--master-metadata', master, ...extra], {
    encoding: 'utf8', timeout: 35000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: sandbox.root, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  assert.equal(child.stderr, '')
  assert.ok([0, 1, 2].includes(child.status!), `unexpected classifier exit ${child.status}`)
  assert.ok(!child.stdout.includes(sandbox.root) && !child.stdout.includes('private-secret'))
  const verdict = JSON.parse(child.stdout) as Verdict
  assert.equal(verdict.status, ['compatible', 'incompatible', 'unknown'][child.status!])
  return { code: child.status, verdict }
}
function current(t: TestContext, name = 'current.db') {
  const path = join(sandbox.root, name), db = new DelegateDurableDb(path)
  const store = new DelegateJobStore({ durable: db, sm: true, deliveryReceipts: true })
  t.after(() => store.close())
  return { path, db, store }
}
function failed(f: ReturnType<typeof current>) {
  const job = f.store.create('child', { queued: true, parentSessionKey: parent,
    callbackOriginUserId: 'private-secret-user', callback: 'stdout-wait', deliveryReceipt: receipt })
  assert.ok('jobId' in job)
  const claim = f.store.claimQueued(job.jobId); assert.ok(claim.ok)
  assert.equal(f.store.fail(job.jobId, { ...claim, failureClass: 'internal',
    detail: 'private-secret-result', httpStatus: 500 }), true)
  return job.jobId
}

// Explicit reader SHAPE fixtures, not a historical runtime or real migration.
// Current original DDL supplies column definitions; only private user_version is set.
function oldShape(t: TestContext, version: number, name = 'old.db') {
  const path = join(sandbox.root, name), db = new Database(path)
  const source = readFileSync(new URL('../../packages/gateway/src/delegateDurable.ts', import.meta.url), 'utf8')
  const ddl = (n: number) => {
    const match = source.match(new RegExp('const DDL_V' + n + ' = `([\\s\\S]*?)`'))
    assert.ok(match, `original DDL ${n}`)
    return match[1]!
  }
  if (version > 0) db.exec(ddl(1))
  if (version >= 4) db.exec('ALTER TABLE delegate_jobs ADD COLUMN retired_at INTEGER')
  for (const n of [5, 6, 7, 9]) if (version >= n) db.exec(ddl(n))
  db.pragma(`user_version=${version}`)
  t.after(() => db.close())
  return { path, db }
}

test('original offered/unacked inventory refuses legacy and admits only paired C0; no ACK or payload write', t => {
  const f = current(t), id = failed(f), old = metadata('old.json'), modern = metadata('c0.json', [cap])
  const before = f.db.getDeliveryReceipt(id, 0)
  assert.equal(before?.state, 'offered')
  assert.equal(f.db.userSummary('private-secret-user').unacknowledgedFailures, 1)
  assert.equal(run([f.path], old).code, 1)
  assert.equal(run([f.path], modern, old).code, 1)
  assert.equal(run([f.path], old, modern).code, 1)
  const result = run([f.path], modern)
  assert.equal(result.code, 0)
  assert.equal(result.verdict.databases?.[0]?.counts?.receipts, 1)
  assert.equal(result.verdict.databases?.[0]?.counts?.unacknowledged, 1)
  assert.deepEqual(f.db.getDeliveryReceipt(id, 0), before)
  assert.equal(f.db.userSummary('private-secret-user').unacknowledgedFailures, 1)
})

test('real sealed C0 empty still fences old writer; running enrollment visible before terminal', t => {
  const f = current(t), old = metadata('old.json'), modern = metadata('c0.json', [cap])
  assert.equal(run([f.path], old).code, 1)
  assert.equal(run([f.path], modern).verdict.databases?.[0]?.schema, 12)
  const job = f.store.create('child', { queued: true, parentSessionKey: parent,
    callbackOriginUserId: 'private-secret-user', callback: 'stdout-wait', deliveryReceipt: receipt })
  assert.ok('jobId' in job); assert.ok(f.store.claimQueued(job.jobId).ok)
  const counts = run([f.path], modern).verdict.databases?.[0]?.counts
  assert.equal(counts?.enrolled, 1); assert.equal(counts?.receipts, 0)
  assert.equal(f.db.get(job.jobId)?.state, 'running')
})

test('original source/action accepted transaction and terminal remain visible to kernel', t => {
  const f = current(t), modern = metadata('c0.json', [cap])
  const source: DelegateRetrySource = { version: 1, userId: 'c:71', storageUserId: 'default',
    parentSessionKey: parent, parentClientSessionId: 'private-consumer', originSessionKey: parent,
    childSessionKey: 'agent:child:delegate:main:private', targetAgentId: 'child', sourceAgentId: 'main',
    depth: 0, model: 'gpt-6-astra' }
  const job = f.store.create('child', { queued: true, parentSessionKey: parent,
    callbackOriginUserId: 'default', sessionKey: source.childSessionKey, retrySource: source })
  assert.ok('jobId' in job)
  const claim = f.store.claimQueued(job.jobId); assert.ok(claim.ok)
  assert.equal(f.store.fail(job.jobId, { ...claim, failureClass: 'internal', detail: 'failed', httpStatus: 500 }), true)
  const key = { userId: source.userId, sourceJobId: job.jobId, generation: 0, actionId: 'private-consumer-action-001' }
  const accepted = f.store.acceptRetryAction(key, source); assert.ok('kind' in accepted)
  const result = run([f.path], modern)
  assert.equal(result.code, 0); assert.equal(result.verdict.databases?.[0]?.counts?.actions, 1)
  assert.equal(result.verdict.databases?.[0]?.counts?.sources, 2)
  assert.equal(f.db.getRetryAction(key)?.state, 'accepted')
  f.store.fenceDeletedRetryParent({ userId: source.storageUserId!, clientSessionId: source.parentClientSessionId })
  assert.equal(f.db.getRetryAction(key)?.state, 'source_deleted')
  assert.equal(run([f.path], modern).code, 0, 'original source_deleted is a supported durable tombstone, not unknown')
})

test('all known receipt states including ingested/notified require v2 in v7 reader fixture', t => {
  const f = oldShape(t, 7), old = metadata('old.json'), modern = metadata('c0.json', [cap])
  assert.equal(run([f.path], old).code, 0)
  // Raw state rows only exercise the reader: not proof of native consumption/ACK.
  f.db.prepare(`INSERT INTO delegate_delivery_receipt(job_id,generation,user_id,parent_session,parent_turn_key,
    native_tool_use_id,receipt_nonce_hash,result_digest,state,created_at,updated_at)
    VALUES('private',0,'private-user',?,?,?,?,?,'offered',1,1)`)
    .run(parent, 'turn', 'tool', receipt.receiptNonceHash, 'digest')
  for (const state of ['offered', 'ingest_claimed', 'ingested', 'notify_pending', 'notify_claimed', 'notified']) {
    f.db.prepare('UPDATE delegate_delivery_receipt SET state=?').run(state)
    assert.equal(run([f.path], old).code, 1, state)
    assert.equal(run([f.path], modern).code, 0, state)
  }
  f.db.pragma('ignore_check_constraints=ON')
  f.db.exec("UPDATE delegate_delivery_receipt SET state='future-state'")
  assert.equal(run([f.path], modern).code, 2)
})

test('committed WAL remains visible while original writer stays open; acknowledged old inbox is not pending', t => {
  const f = oldShape(t, 5), old = metadata('old.json')
  f.db.pragma('journal_mode=WAL'); f.db.pragma('wal_autocheckpoint=0'); f.db.pragma('wal_checkpoint(TRUNCATE)')
  assert.equal(run([f.path], old).code, 0)
  f.db.prepare(`INSERT INTO delegate_failure_inbox VALUES('private',0,'private-user',?,NULL,'failed','text',1,NULL)`).run(parent)
  assert.ok(statSync(f.path + '-wal').size > 32)
  assert.equal(run([f.path], old).code, 1, 'must see committed WAL without closing/checkpointing writer')
  f.db.exec('UPDATE delegate_failure_inbox SET ack_at=2')
  assert.equal(run([f.path], old).code, 0)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM delegate_failure_inbox').get() as { n: number }).n, 1)
  assert.equal(f.db.open, true)
})

test('versions 0..9 old empty shapes and valid absence do not migrate; mixed sealed C0 raises floor', t => {
  const old = metadata('old.json'), modern = metadata('c0.json', [cap])
  for (let version = 0; version <= 9; version++) {
    const f = oldShape(t, version, `v${version}.db`)
    assert.equal(run([f.path], old).code, 0, `empty reader shape v${version}`)
    assert.equal(f.db.pragma('user_version', { simple: true }), version)
  }
  const missing = join(sandbox.root, 'absent.db')
  assert.equal(run([missing], old).code, 0)
  const modernDb = current(t)
  assert.equal(run([missing, modernDb.path], old).code, 1)
  assert.equal(run([missing, modernDb.path], modern).code, 0)
})

test('unknown paths/shapes/schema defeat even modern capabilities and never become absence', t => {
  const modern = metadata('c0.json', [cap]), f = current(t), old = oldShape(t, 7)
  const corrupt = join(sandbox.root, 'corrupt.db'); writeFileSync(corrupt, 'not SQLite')
  const link = join(sandbox.root, 'link.db'); symlinkSync(f.path, link)
  const dir = join(sandbox.root, 'dir'); mkdirSync(dir)
  const linkDir = join(sandbox.root, 'dirlink'); symlinkSync(dir, linkDir)
  for (const path of [corrupt, link, dir, join(sandbox.root, 'missing-parent', 'db'), join(linkDir, 'db')]) {
    assert.equal(run([f.path, path], modern).code, 2)
  }
  old.db.exec('ALTER TABLE delegate_delivery_receipt RENAME COLUMN input_proof TO wrong_column')
  assert.equal(run([old.path], modern).code, 2)
  const future = oldShape(t, 0, 'future.db'); future.db.pragma('user_version=12')
  assert.equal(run([future.path], modern).code, 2)
  const mismatch = oldShape(t, 0, 'mismatch.db'); mismatch.db.exec('CREATE TABLE unexpected(x)')
  assert.equal(run([mismatch.path], modern).code, 2)
  const sidecar = join(sandbox.root, 'absent.db-wal'); symlinkSync(corrupt, sidecar)
  assert.equal(run([join(sandbox.root, 'absent.db')], modern).code, 2)
})

test('candidate unknown/oversize/link/missing JSON never falls back; mixed pair refuses even empty inventory', () => {
  const db = join(sandbox.root, 'absent.db'), modern = metadata('c0.json', [cap]), old = metadata('old.json')
  const bad = metadata('bad.json', {}), future = metadata('future.json', [cap, 'delegate-receipt-consumer-v3'])
  const json = join(sandbox.root, 'invalid.json'); writeFileSync(json, '{')
  const big = join(sandbox.root, 'big.json'); writeFileSync(big, ' '.repeat(1024 * 1024 + 1))
  const link = join(sandbox.root, 'link.json'); symlinkSync(modern, link)
  for (const path of [bad, future, json, big, link, join(sandbox.root, 'missing.json')]) {
    assert.equal(run([db], path, modern).code, 2)
    assert.equal(run([db], modern, path).code, 2)
  }
  assert.equal(run([db], modern, old).code, 1)
  assert.equal(run([db], old, modern).code, 1)
  assert.equal(run(Array.from({ length: 4097 }, () => db), modern).code, 2)
})

test('real SQLite exclusive lock and total read deadline return unknown, never partial compatible', t => {
  const f = oldShape(t, 1), old = metadata('old.json')
  f.db.exec('BEGIN EXCLUSIVE')
  const started = Date.now()
  try {
    const result = run([join(sandbox.root, 'absent.db'), f.path], old, old, ['--budget-ms', '30'])
    assert.equal(result.code, 2); assert.equal(result.verdict.reason, 'budget_exhausted')
    assert.ok(Date.now() - started < 5000)
  } finally { f.db.exec('ROLLBACK') }
  assert.equal(run([f.path], old).code, 0)
})

test('v9 source, action and deletion fence independently retain consumer floor; unknown action refuses C0', t => {
  const f = oldShape(t, 9), old = metadata('old.json'), modern = metadata('c0.json', [cap])
  // Raw historical reader shapes: not real source authorization or dispatch.
  f.db.exec(`INSERT INTO delegate_retry_source(job_id,generation,user_id,created_at)
    VALUES('private',0,'private-user',1)`)
  assert.equal(run([f.path], old).code, 1)
  f.db.exec(`DELETE FROM delegate_retry_source;
    INSERT INTO delegate_retry_action(user_id,source_job_id,generation,action_id,target_job_id,state,created_at)
    VALUES('private-user','private',0,'action','target','accepted',1)`)
  for (const state of ['accepted', 'dispatched', 'terminal']) {
    f.db.prepare('UPDATE delegate_retry_action SET state=?').run(state)
    assert.equal(run([f.path], old).code, 1)
    assert.equal(run([f.path], modern).code, 0)
  }
  f.db.exec("UPDATE delegate_retry_action SET state='unknown'")
  assert.equal(run([f.path], modern).code, 2)
  f.db.exec(`DELETE FROM delegate_retry_action;
    INSERT INTO delegate_retry_parent_fence VALUES('private-user','private-client',1)`)
  assert.equal(run([f.path], old).code, 1)
})
