import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { ReceiptDeliveryStore, type ReceiptInputClaim, type ReceiptRecordOracle } from '@openclaude/storage/receiptDeliveryStore'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { resolve, promise } }
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-206-owner-'))
  const path = join(dir, 'jobs.db')
  const durable = new DelegateDurableDb(path)
  const jobs = new DelegateJobStore({ durable, sm: true, deliveryReceipts: true })
  const made = jobs.create('worker', { callback: 'stdout-wait', callbackOriginUserId: '3', parentSessionKey: 'parent',
    deliveryReceipt: { parentTurnKey: 'turn', nativeToolUseId: 'tool', receiptNonceHash: hash('nonce') } })
  assert.ok('jobId' in made)
  const snap = jobs.snapshotOf(made.jobId)!
  jobs.complete(made.jobId, { httpStatus: 200, body: { ok: false, error: 'failed' } },
    { claimToken: snap.claimToken!, fencingEpoch: snap.fencingEpoch })
  const binding = durable.getDeliveryReceipt(made.jobId, 0)!
  const delivery = new ReceiptDeliveryStore(path)
  const raw = new Database(path)
  const content = JSON.stringify({ receipt: [binding.jobId, binding.generation], digest: binding.resultDigest, input: 'synthetic input, not native CCB' }) + '\n'
  const proof = { nativeSessionId: 'native-test', recordLocator: join(dir, 'input.jsonl'), recordHash: hash(content) }
  const input = { proof, parentOwnerEpoch: 'epoch-1', isCurrentParentOwner: async () => true }
  let writes = 0
  const write = async () => {
    const file = await open(proof.recordLocator, 'wx', 0o600)
    try { await file.writeFile(content); await file.sync(); writes++ } finally { await file.close() }
    const directory = await open(dir, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  const oracle: ReceiptRecordOracle = async claim => {
    try {
      const bytes = await readFile(claim.proof.recordLocator)
      return hash(bytes) === claim.proof.recordHash ? { kind: 'present', proof: claim.proof } : { kind: 'unknown' }
    } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' } }
  }
  const receipt = () => raw.prepare('SELECT * FROM delegate_delivery_receipt').get() as Record<string, unknown>
  const job = () => durable.get(made.jobId)!
  t.after(() => { raw.close(); delivery.close(); jobs.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, path, jobs, durable, delivery, raw, binding, content, proof, input, write, oracle, receipt, job, writes: () => writes }
}

test('real fsynced input plus exact readback is ingested once and never later becomes a notification', async t => {
  const f = fixture(t)
  assert.equal(await f.delivery.ingest(f.binding, f.input, f.write, f.oracle), 'ingested')
  assert.equal(f.writes(), 1)
  assert.equal(f.receipt().state, 'ingested')
  const reopened = new ReceiptDeliveryStore(f.path)
  try {
    assert.equal(await reopened.ingest(f.binding, f.input, f.write, f.oracle), 'already_ingested')
    assert.equal(await reopened.recover(f.binding, async () => { throw Error('later compaction must not reopen delivery') }, async () => 'inactive'), 'already_ingested')
  } finally { reopened.close() }
  assert.equal(f.job().callbackState, 'none')
  assert.equal(f.writes(), 1)
})

test('post-fsync SQL confirmation failure recovers exact existing input without writing it twice', async t => {
  const f = fixture(t)
  f.raw.exec(`CREATE TRIGGER reject_confirmation BEFORE UPDATE OF state ON delegate_delivery_receipt
    WHEN NEW.state='ingested' BEGIN SELECT RAISE(ABORT,'commit failed'); END`)
  await assert.rejects(f.delivery.ingest(f.binding, f.input, f.write, f.oracle), /commit failed/)
  assert.equal(f.receipt().state, 'ingest_claimed')
  assert.equal(f.writes(), 1)
  f.raw.exec('DROP TRIGGER reject_confirmation')
  assert.equal(await f.delivery.recover(f.binding, f.oracle, async () => 'inactive'), 'ingested')
  assert.equal(f.job().callbackState, 'none')
  assert.equal(f.writes(), 1)
})

test('absent record hands one owner to notification atomically; late direct cannot write', async t => {
  const f = fixture(t)
  await assert.rejects(f.delivery.ingest(f.binding, f.input, async () => { throw Error('writer died before append') }, f.oracle), /writer died/)
  assert.equal(await f.delivery.recover(f.binding, f.oracle, async () => 'inactive'), 'notify_ready')
  assert.equal(f.receipt().state, 'notify_pending')
  assert.equal(f.job().callback, 'origin-inject')
  assert.equal(f.job().callbackState, 'pending')
  assert.equal(f.job().callbackEpoch, 1)
  assert.equal(await f.delivery.ingest(f.binding, f.input, f.write, f.oracle), 'notify_owned')
  assert.equal(await f.delivery.recover(f.binding, f.oracle, async () => 'inactive'), 'notify_owned')
  assert.equal(f.writes(), 0)
  assert.equal(f.job().callbackEpoch, 1)
  assert.equal(f.durable.casClaimNotify({ jobId: f.binding.jobId, state: f.job().state, fencingEpoch: f.job().fencingEpoch,
    claimToken: f.job().claimToken, deliveryToken: 'old-notifier', now: Date.now(), claimedUntil: Date.now() + 1000 }), undefined)
})

test('oracle exception, unknown and mismatched proof are never treated as absence', async t => {
  const f = fixture(t)
  await assert.rejects(f.delivery.ingest(f.binding, f.input, async () => { throw Error('stopped') }, f.oracle))
  const before = f.receipt()
  const probes: ReceiptRecordOracle[] = [async () => { throw Error('read failed') }, async () => ({ kind: 'unknown' }),
    async () => ({ kind: 'present', proof: { ...f.proof, recordHash: hash('wrong') } })]
  for (const probe of probes) {
    assert.equal(await f.delivery.recover(f.binding, probe, async () => 'inactive'), 'unknown')
    assert.deepEqual(f.receipt(), before)
    assert.equal(f.job().callbackState, 'none')
  }
})

test('inactive-owner proof is required before notification, even if no input exists', async t => {
  const f = fixture(t)
  for (const parent of ['active', 'unknown'] as const) {
    assert.equal(await f.delivery.recover(f.binding, f.oracle, async () => parent), parent === 'active' ? 'pending' : 'unknown')
    assert.equal(f.receipt().state, 'offered')
  }
  assert.equal(await f.delivery.ingest(f.binding, { ...f.input, isCurrentParentOwner: async () => false }, f.write, f.oracle), 'stale_parent')
  assert.equal(f.writes(), 0)
})

test('notify job-update failure rolls back the receipt owner selection too', async t => {
  const f = fixture(t)
  f.raw.exec(`CREATE TRIGGER reject_notify BEFORE UPDATE OF callback ON delegate_jobs
    BEGIN SELECT RAISE(ABORT,'notify prep failed'); END`)
  await assert.rejects(f.delivery.recover(f.binding, f.oracle, async () => 'inactive'), /notify prep failed/)
  assert.equal(f.receipt().state, 'offered')
  assert.equal(f.receipt().owner_token, null)
  assert.equal(f.job().callbackState, 'none')
  f.raw.exec('DROP TRIGGER reject_notify')
  assert.equal(await f.delivery.recover(f.binding, f.oracle, async () => 'inactive'), 'notify_ready')
})

test('reclaimer keeps the lock across absent observation and owner switch against a late writer', async t => {
  const f = fixture(t)
  await assert.rejects(f.delivery.ingest(f.binding, f.input, async () => { throw Error('stopped') }, f.oracle))
  const observed = latch(), release = latch()
  const reclaimer = f.delivery.recover(f.binding, async () => { observed.resolve(); await release.promise; return { kind: 'absent' } }, async () => 'inactive')
  await observed.promise
  const other = new ReceiptDeliveryStore(f.path)
  const late = other.ingest(f.binding, f.input, f.write, f.oracle)
  try {
    // A separate acquisition times out while the absent oracle is paused.
    await assert.rejects(f.durable.withDeliveryReceiptBarrier(f.binding.jobId, 0, async () => {}, { timeoutMs: 25 }), /flock failed|timed out/)
  } finally { release.resolve() }
  try {
    assert.equal(await reclaimer, 'notify_ready')
    assert.equal(await late, 'notify_owned')
    assert.equal(f.writes(), 0)
  } finally { other.close() }
})

test('trusted binding snapshot and frozen claim prevent callback mutation from retargeting owner confirmation', async t => {
  const f = fixture(t)
  const supplied = { ...f.binding }
  const writer = async (claim: ReceiptInputClaim) => {
    supplied.jobId = 'other'
    assert.throws(() => { claim.proof.recordHash = hash('other') }, TypeError)
    assert.throws(() => { claim.ownerToken = 'other' }, TypeError)
    await f.write()
  }
  assert.equal(await f.delivery.ingest(supplied, f.input, writer, f.oracle), 'ingested')
  assert.equal(f.receipt().state, 'ingested')
})

test('mismatched identity refuses both writer and recovery before side effects', async t => {
  const f = fixture(t)
  let calls = 0
  for (const patch of [{ userId: '4' }, { parentSession: 'foreign' }, { nativeToolUseId: 'other' },
    { parentTurnKey: 'other' }, { receiptNonceHash: hash('other') }, { resultDigest: hash('other') }]) {
    await assert.rejects(f.delivery.ingest({ ...f.binding, ...patch }, f.input, async () => { calls++ }, f.oracle), /binding mismatch/)
    await assert.rejects(f.delivery.recover({ ...f.binding, ...patch }, f.oracle, async () => { calls++; return 'inactive' }), /binding mismatch/)
  }
  assert.equal(calls, 0)
  assert.equal(f.receipt().state, 'offered')
})

test('two coordinator instances competing for input admission produce one real input', async t => {
  const f = fixture(t)
  const other = new ReceiptDeliveryStore(f.path)
  try {
    const outcomes = await Promise.all([
      f.delivery.ingest(f.binding, f.input, f.write, f.oracle),
      other.ingest(f.binding, f.input, f.write, f.oracle),
    ])
    assert.deepEqual(outcomes.sort(), ['already_ingested', 'ingested'])
    assert.equal(f.writes(), 1)
  } finally { other.close() }
})

test('v6 upgrade only adds nullable owner fields; the coordinator refuses a not-yet-migrated DB', t => {
  const f = fixture(t)
  f.raw.exec(`ALTER TABLE delegate_delivery_receipt DROP COLUMN owner_token;
    ALTER TABLE delegate_delivery_receipt DROP COLUMN parent_owner_epoch;
    ALTER TABLE delegate_delivery_receipt DROP COLUMN input_proof; PRAGMA user_version=6;`)
  const before = f.receipt()
  assert.throws(() => new ReceiptDeliveryStore(f.path), /unsupported receipt consumer schema/)
  const upgraded = new DelegateDurableDb(f.path)
  try {
    const { owner_token, parent_owner_epoch, input_proof, ...after } = f.receipt()
    assert.deepEqual(after, before)
    assert.equal(owner_token, null)
    assert.equal(parent_owner_epoch, null)
    assert.equal(input_proof, null)
  } finally { upgraded.close() }
})

for (const afterWrite of [false, true]) {
  test(`actual writer SIGKILL ${afterWrite ? 'after fsync' : 'before append'} resumes through the exact durable proof`, async t => {
    const f = fixture(t)
    const mod = fileURLToPath(new URL('../../../storage/src/receiptDeliveryStore.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { ReceiptDeliveryStore } from ${JSON.stringify(mod)};
      import { open } from 'node:fs/promises';
      const s = new ReceiptDeliveryStore(${JSON.stringify(f.path)});
      await s.ingest(${JSON.stringify(f.binding)}, {parentOwnerEpoch:'epoch-1', proof:${JSON.stringify(f.proof)},isCurrentParentOwner:async()=>true},async()=>{
        if (${afterWrite}) { const f=await open(${JSON.stringify(f.proof.recordLocator)},'wx',0o600);await f.writeFile(${JSON.stringify(f.content)});await f.sync();await f.close();
          const d=await open(${JSON.stringify(f.dir)},'r');await d.sync();await d.close(); }
        process.send('claimed');await new Promise(resolve=>process.once('message',resolve));
      },async()=>({kind:'unknown'}));s.close();
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr?.on('data', b => { stderr += b })
    const exited = new Promise<void>(r => child.once('close', () => r()))
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000)
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());child.once('error', reject)
        child.once('close', () => reject(Error(stderr || 'writer exited before claim')))
      })
      await assert.rejects(f.delivery.recover(f.binding, f.oracle, async () => 'inactive', { timeoutMs: 25 }), /flock failed|timed out/)
      child.kill('SIGKILL'); await exited
      const restarted = new ReceiptDeliveryStore(f.path)
      try { assert.equal(await restarted.recover(f.binding, f.oracle, async () => 'inactive'), afterWrite ? 'ingested' : 'notify_ready') }
      finally { restarted.close() }
      assert.equal(existsSync(f.proof.recordLocator), afterWrite)
      assert.equal(f.job().callbackState, afterWrite ? 'none' : 'pending')
    } finally { clearTimeout(watchdog);child.kill('SIGKILL');await exited }
  })
}
