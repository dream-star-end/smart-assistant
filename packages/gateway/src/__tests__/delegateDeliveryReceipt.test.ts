import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb, DELEGATE_DURABLE_SCHEMA_VERSION } from '../delegateDurable.js'
import { DelegateJobStore, type DelegateCreateMeta } from '../delegateJobs.js'

const parent = 'agent:main:webchat:dm:receipt-test'
const nonce = 'private-one-time-receipt-nonce'
const receipt = { parentTurnKey: 'turn-1', nativeToolUseId: 'tool-1', receiptNonceHash: hash(nonce) }
const failure = { httpStatus: 200, body: { ok: false, error: 'private-original-result' } }
function hash(value: string) { return createHash('sha256').update(value).digest('hex') }
function fixture(t: TestContext, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-206-receipt-'))
  const path = join(dir, 'jobs.db')
  const db = new DelegateDurableDb(path)
  let terminals = 0
  const store = new DelegateJobStore({ durable: db, sm: true, deliveryReceipts: enabled,
    now: () => 1000, ttlMs: 100, onTerminal: () => { terminals++ } })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, path, db, store, terminals: () => terminals }
}
function create(store: DelegateJobStore, extra: DelegateCreateMeta = {}) {
  const made = store.create('worker', { parentSessionKey: parent, callbackOriginUserId: '3',
    callback: 'stdout-wait', deliveryReceipt: receipt, ...extra })
  assert.ok('jobId' in made)
  const snap = store.snapshotOf(made.jobId)!
  assert.ok(snap.claimToken)
  return { id: made.jobId, fence: { claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch } }
}

test('real completion atomically offers one bound receipt and failure inbox without duplicating the body', t => {
  const f = fixture(t)
  const { id, fence } = create(f.store, { deliveryReceipt: { ...receipt, userId: 'attacker', resultDigest: 'forged' } as typeof receipt })
  assert.equal(f.db.getDeliveryReceipt(id, 0), undefined)
  assert.equal(f.store.complete(id, failure, fence), true)
  assert.equal(f.store.complete(id, failure, fence), false)
  const offered = f.db.getDeliveryReceipt(id, 0)!
  assert.ok(offered, 'winning terminal must create a durable receipt')
  const raw = new Database(f.path, { readonly: true })
  try {
    const row = raw.prepare('SELECT result_json, delivery_receipt_context FROM delegate_jobs').get() as { result_json: string; delivery_receipt_context: string }
    assert.deepEqual(JSON.parse(row.delivery_receipt_context), receipt)
    assert.equal(offered.resultDigest, hash(row.result_json))
    assert.equal(offered.userId, '3')
    assert.equal(offered.parentSession, parent)
    assert.equal(offered.parentTurnKey, 'turn-1')
    assert.equal(offered.nativeToolUseId, 'tool-1')
    assert.equal(offered.receiptNonceHash, hash(nonce))
    assert.equal(offered.state, 'offered')
    assert.equal(JSON.stringify(offered).includes(nonce), false)
    assert.equal(JSON.stringify(offered).includes('private-original-result'), false)
    assert.deepEqual(raw.prepare('SELECT COUNT(*) AS n FROM delegate_delivery_receipt').get(), { n: 1 })
  } finally { raw.close() }
  assert.equal(f.db.listUnacknowledgedFailures('3').count, 1)
  assert.equal(f.store.snapshotOf(id)?.state, 'completed', 'authority/settlement not rewritten')
  assert.equal(f.terminals(), 1)
})

test('receipt insert failure rolls back job terminal and inbox before any observer wakes', t => {
  const f = fixture(t)
  const { id, fence } = create(f.store)
  const raw = new Database(f.path)
  try {
    raw.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON delegate_delivery_receipt
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`)
    assert.throws(() => f.store.complete(id, failure, fence), /injected receipt failure/)
    assert.equal(f.store.snapshotOf(id)?.state, 'running')
    assert.equal(f.db.get(id)?.result, null)
    assert.equal(f.db.getDeliveryReceipt(id, 0), undefined)
    assert.equal(f.db.listUnacknowledgedFailures('3').count, 0)
    assert.equal(f.terminals(), 0)
    raw.exec('DROP TRIGGER reject_receipt')
    assert.equal(f.store.complete(id, failure, fence), true)
    assert.equal(f.terminals(), 1)
  } finally { raw.close() }
})

test('new admission requires opt-in and does not change legacy wait/consume or enroll legacy failures', async t => {
  const f = fixture(t, false)
  assert.throws(() => create(f.store), /admission disabled/)
  assert.throws(() => new DelegateJobStore({ sm: true, deliveryReceipts: true }), /requires durable/)
  const old = create(f.store, { deliveryReceipt: undefined })
  assert.equal(f.store.complete(old.id, failure, old.fence), true)
  assert.equal((await f.store.wait(old.id, 0)).status, 'done')
  assert.equal(f.store.markResultConsumed(old.id), true)
  assert.equal(f.db.listUnacknowledgedFailures('3').count, 0)
  assert.equal(f.db.hasDeliveryReceiptEnrollment(old.id), false)
  const enabled = fixture(t)
  const legacyOn = create(enabled.store, { deliveryReceipt: undefined })
  enabled.store.complete(legacyOn.id, failure, legacyOn.fence)
  assert.equal(enabled.db.listUnacknowledgedFailures('3').count, 0, 'flag alone must not enroll legacy callers')
})

test('reopening in a real process with admission off retains receipt results and fences every legacy consumer', t => {
  const f = fixture(t)
  const { id, fence } = create(f.store)
  f.store.close()
  const moduleDb = fileURLToPath(new URL('../delegateDurable.ts', import.meta.url))
  const moduleStore = fileURLToPath(new URL('../delegateJobs.ts', import.meta.url))
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { DelegateDurableDb } from ${JSON.stringify(moduleDb)};
    import { DelegateJobStore } from ${JSON.stringify(moduleStore)};
    const db = new DelegateDurableDb(${JSON.stringify(f.path)});
    const store = new DelegateJobStore({sm:true,durable:db,now:()=>1000,ttlMs:100});
    const id = ${JSON.stringify(id)};
    assert.equal(store.complete(id, ${JSON.stringify(failure)}, ${JSON.stringify(fence)}), true);
    assert.throws(()=>store.get(id), /requires v2 consumer/);
    await assert.rejects(store.wait(id,0), /requires v2 consumer/);
    assert.equal(store.markResultConsumed(id),false);
    assert.deepEqual(store.adoptOrphanedStdoutWait(${JSON.stringify(parent)}),[]);
    assert.deepEqual(store.listPendingNotify(),[]);
    assert.equal(db.casClaimNotify({jobId:id,state:'completed',${JSON.stringify(fence).slice(1,-1)},deliveryToken:'bad',now:2000,claimedUntil:3000}),undefined);
    assert.equal(store.sweep(100000),0);
    assert.equal(db.prunePastRetention({cutoff:100000,keepRows:0}),0);
    assert.equal(db.getDeliveryReceipt(id,0).state,'offered');
    assert.equal(db.listUnacknowledgedFailures('3').count,1);
    assert.equal(db.get(id).result.body.error,'private-original-result');
    store.close(); console.log('receipt-restart-PASS');
  `], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /receipt-restart-PASS/)
})

test('receipt binding cannot drift before offer or change result after offer, even through fenced store writes', t => {
  const f = fixture(t)
  const { id, fence } = create(f.store)
  let row = f.db.get(id)!
  let expected = { jobId: id, state: row.state, ...fence }
  for (const patch of [{ callbackOriginUserId: '4' }, { parentSessionKey: 'foreign' }, { generation: 1 }, { callback: 'origin-inject' as const }]) {
    assert.equal(f.db.casUpdate(expected, { ...row, ...patch }), undefined)
  }
  assert.throws(() => f.db.upsert(row), /requires fenced update/)
  assert.equal(f.store.complete(id, failure, fence), true)
  row = f.db.get(id)!
  expected = { jobId: id, state: row.state, ...fence }
  assert.throws(() => f.db.casUpdate(expected, { ...row, result: { httpStatus: 200, body: { ok: true } } }), /binding is immutable/)
  assert.deepEqual(f.db.get(id)?.result, failure)
  assert.equal(f.db.casRetire({ ...expected, now: 999999 }), false)
})

test('idempotent create cannot silently reuse a differently bound receipt or mix v1 and v2', t => {
  const f = fixture(t)
  const first = create(f.store, { idempotencyKey: 'same' })
  assert.equal(create(f.store, { idempotencyKey: 'same' }).id, first.id)
  for (const patch of [{ deliveryReceipt: { ...receipt, nativeToolUseId: 'other' } },
    { callbackOriginUserId: '4' }, { deliveryReceipt: undefined }]) {
    assert.throws(() => create(f.store, { idempotencyKey: 'same', ...patch }), /idempotency binding mismatch/)
  }
  create(f.store, { idempotencyKey: 'old', deliveryReceipt: undefined })
  assert.throws(() => create(f.store, { idempotencyKey: 'old' }), /idempotency binding mismatch/)
  assert.equal(f.db.ledgerStats().total, 2)
})

test('invalid receipt metadata is rejected without inserting a job', t => {
  const f = fixture(t)
  for (const patch of [{ receiptNonceHash: nonce }, { nativeToolUseId: '' }, { parentTurnKey: ' '.repeat(2) }]) {
    assert.throws(() => create(f.store, { deliveryReceipt: { ...receipt, ...patch } }), /invalid delegate receipt context/)
  }
  assert.throws(() => create(f.store, { callbackOriginUserId: undefined }), /requires verified owner/)
  assert.throws(() => create(f.store, { callback: 'origin-inject' }), /receipt admission requires/)
  assert.equal(f.db.ledgerStats().total, 0)
})

test('v5 database upgrade keeps old jobs byte-for-byte and never backfills a receipt', t => {
  const f = fixture(t, false)
  const { id, fence } = create(f.store, { deliveryReceipt: undefined })
  f.store.complete(id, failure, fence)
  f.store.close()
  const old = new Database(f.path)
  old.exec('DROP TABLE delegate_delivery_receipt; ALTER TABLE delegate_jobs DROP COLUMN delivery_receipt_context; PRAGMA user_version=5;')
  const before = old.prepare('SELECT * FROM delegate_jobs').get()
  old.close()
  const next = new DelegateDurableDb(f.path)
  try {
    const raw = new Database(f.path, { readonly: true })
    try {
      const { delivery_receipt_context, ...after } = raw.prepare('SELECT * FROM delegate_jobs').get() as Record<string, unknown>
      assert.deepEqual(after, before)
      assert.equal(delivery_receipt_context, null)
      assert.equal(raw.pragma('user_version', { simple: true }), DELEGATE_DURABLE_SCHEMA_VERSION)
      assert.equal(next.getDeliveryReceipt(id, 0), undefined)
    } finally { raw.close() }
  } finally { next.close() }
})

test('persistent DB receipt barrier re-reads the real offered record under the shared lock', async t => {
  const f = fixture(t)
  const { id, fence } = create(f.store)
  f.store.complete(id, failure, fence)
  assert.equal(await f.db.withDeliveryReceiptBarrier(id, 0, async offer => {
    assert.equal(offer.jobId, id)
    const key = hash(JSON.stringify([id, 0]))
    const attempt = spawnSync('/usr/bin/flock', ['-n', join(f.dir, 'delegate-receipt-locks', key + '.lock'), 'true'])
    assert.equal(attempt.status, 1, 'real second process cannot pass the writer barrier')
    return 'verified'
  }), 'verified')
  await assert.rejects(f.db.withDeliveryReceiptBarrier(id, 9, async () => {}), /receipt not found/)
})

test('two paths to the same database cannot create independent receipt barriers', async t => {
  const f = fixture(t)
  const { id, fence } = create(f.store)
  f.store.complete(id, failure, fence)
  mkdirSync(join(f.dir, 'alias'))
  const alias = join(f.dir, 'alias', 'same.db')
  symlinkSync(f.path, alias)
  const other = new DelegateDurableDb(alias)
  try {
    await f.db.withDeliveryReceiptBarrier(id, 0, async () => {
      let calls = 0
      await assert.rejects(other.withDeliveryReceiptBarrier(id, 0, async () => { calls++ }, { timeoutMs: 25 }), /flock failed|timed out/)
      assert.equal(calls, 0)
    })
  } finally { other.close() }
})

for (const nextState of ['failed', 'cancelled', 'killed_by_cutover'] as const) {
  test(`receipt fail commits ${nextState} through the real fenced failure entry without marking it consumed`, t => {
    const f = fixture(t)
    const { id, fence } = create(f.store)
    const args = { ...fence, failureClass: 'child_error' as const, detail: 'child failed', httpStatus: 500, nextState }
    assert.equal(f.store.fail(id, { ...args, claimToken: 'stale' }), false)
    assert.equal(f.store.fail(id, args), true)
    assert.equal(f.store.fail(id, args), false)
    assert.equal(f.db.get(id)?.state, nextState)
    assert.equal(f.db.get(id)?.callbackState, 'none')
    assert.equal(f.db.get(id)?.result?.body.error, 'child failed')
    assert.equal(f.db.getDeliveryReceipt(id, 0)?.state, 'offered')
    assert.equal(f.db.listUnacknowledgedFailures('3').count, nextState === 'cancelled' ? 0 : 1)
    assert.equal(f.terminals(), 1)
    assert.equal(f.store.markResultConsumed(id), false)
  })
}

for (const kind of ['timeout', 'abort'] as const) {
  test(`queued receipt capacity ${kind} really terminates and cannot later be dispatched`, t => {
    const f = fixture(t)
    const made = f.store.create('worker', { queued: true, callback: 'stdout-wait', deliveryReceipt: receipt,
      callbackOriginUserId: '3', parentSessionKey: parent })
    assert.ok('jobId' in made)
    const args = { failureClass: 'capacity_timeout' as const, detail: kind, httpStatus: 429, drop: false,
      nextState: kind === 'abort' ? 'cancelled' as const : 'failed' as const }
    assert.equal(f.store.settleCapacityReject(made.jobId, args), 'failed', 'not falsely claimed/already dispatched')
    assert.equal(f.db.get(made.jobId)?.state, args.nextState)
    assert.equal(f.db.getDeliveryReceipt(made.jobId, 0)?.state, 'offered')
    assert.equal(f.db.listUnacknowledgedFailures('3').count, kind === 'timeout' ? 1 : 0)
    assert.deepEqual(f.store.claimQueued(made.jobId), { ok: false })
    assert.equal(f.terminals(), 1)
  })
}

for (const table of ['delegate_delivery_receipt', 'delegate_failure_inbox']) {
  test(`fail entry rolls back job, receipt, inbox and observers when ${table} insertion fails`, t => {
    const f = fixture(t)
    const { id, fence } = create(f.store)
    const raw = new Database(f.path)
    const args = { ...fence, failureClass: 'child_error' as const, detail: 'upstream failed', httpStatus: 500 }
    try {
      raw.exec(`CREATE TRIGGER reject_aux BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'aux failure'); END`)
      assert.throws(() => f.store.fail(id, args), /aux failure/)
      assert.equal(f.db.get(id)?.state, 'running')
      assert.equal(f.store.snapshotOf(id)?.state, 'running')
      assert.equal(f.db.get(id)?.result, null)
      assert.equal(f.db.getDeliveryReceipt(id, 0), undefined)
      assert.equal(f.db.listUnacknowledgedFailures('3').count, 0)
      assert.equal(f.terminals(), 0)
      raw.exec('DROP TRIGGER reject_aux')
      assert.equal(f.store.fail(id, args), true)
      assert.equal(f.terminals(), 1)
    } finally { raw.close() }
  })
}

test('ordinary v1 fail still preserves its historical skipped_silent callback', t => {
  const f = fixture(t)
  const { id, fence } = create(f.store, { deliveryReceipt: undefined })
  assert.equal(f.store.fail(id, { ...fence, failureClass: 'child_error', detail: 'old fail', httpStatus: 500 }), true)
  assert.equal(f.db.get(id)?.callbackState, 'skipped_silent')
  assert.equal(f.db.getDeliveryReceipt(id, 0), undefined)
  assert.equal(f.db.listUnacknowledgedFailures('3').count, 0)
})
