import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReceiptCandidateLifecycle, type ReceiptCandidateScope } from '../receiptCandidateLifecycle.js'

function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'receipt-deletion-'))
  const store = new ReceiptCandidateLifecycle(join(dir, 'control'))
  const scope: ReceiptCandidateScope = { partition: 'a'.repeat(64), userId: 'u1', clientSessionId: 'same-session',
    agentId: 'main', sessionKey: 'parent', owner: { adapterInstanceId: 'a', parentOwnerEpoch: 'e', turnKey: 't', nativeSessionId: 'n' } }
  const ref = { userId: scope.userId, clientSessionId: scope.clientSessionId! }
  return { dir, store, scope, ref, data: join(store.root, 'data', scope.partition) }
}

test('exact deleted tenant retires all current namespaces, preserves foreign tenant and rejects new partitions after restart', async () => {
  const f = fixture()
  await f.store.register(f.scope, 'one', () => {})
  const foreign = { ...f.scope, userId: 'u2', partition: 'b'.repeat(64) }
  const other = { ...f.scope, partition: 'c'.repeat(64) }
  const foreignPath = await f.store.register(foreign, 'foreign', () => {})
  // This namespace was not in the caller snapshot, but must be retired under the lock.
  const oldSnapshot = f.store.snapshots(); assert.equal(oldSnapshot.length, 2)
  const otherPath = await f.store.register(other, 'two', () => {})
  assert.deepEqual(await f.store.fenceDeleted([f.ref]), { pending: 0 })
  assert.equal(fs.existsSync(f.data), false); assert.equal(fs.existsSync(otherPath), false)
  assert.equal(fs.existsSync(foreignPath), true)
  const fresh = new ReceiptCandidateLifecycle(f.store.root)
  await assert.rejects(fresh.register({ ...f.scope, partition: 'd'.repeat(64) }, 'new', () => {}), /deleted/)
  await assert.rejects(fresh.withActive(f.scope.partition, () => assert.fail('late writer')))
  assert.deepEqual(await fresh.fenceDeleted([f.ref]), { pending: 0 })
  assert.equal(fs.existsSync(foreignPath), true)
})

test('authoritative deletion with no job or namespace fences later registration', async () => {
  const f = fixture()
  assert.deepEqual(await f.store.fenceDeleted([f.ref]), { pending: 0 })
  await assert.rejects(f.store.register(f.scope, 'never', () => {}), /deleted/)
  assert.equal(fs.existsSync(f.data), false)
  assert.deepEqual(f.store.snapshots(), [])
})

test('one unknown inode remains pending with identity while other deleted candidates still retire', async () => {
  const f = fixture(); await f.store.register(f.scope, 'one', () => {})
  const other = { ...f.scope, partition: 'b'.repeat(64) }
  const otherPath = await f.store.register(other, 'two', () => {})
  const victim = join(f.dir, 'outside'); fs.writeFileSync(victim, 'KEEP')
  fs.symlinkSync(victim, join(f.data, 'cache', 'unknown'))
  assert.deepEqual(await f.store.fenceDeleted([f.ref]), { pending: 1 })
  assert.equal(fs.existsSync(otherPath), false); assert.equal(fs.readFileSync(victim, 'utf8'), 'KEEP')
  const snapshot = f.store.snapshots().find(m => m.partition === f.scope.partition)!
  assert.equal(snapshot.state, 'retired')
  if (snapshot.state === 'retired') assert.deepEqual(snapshot.deletionRef, f.ref)
  await assert.rejects(f.store.withActive(f.scope.partition, () => assert.fail('late unknown writer')))
  assert.deepEqual(await new ReceiptCandidateLifecycle(f.store.root).fenceDeleted([f.ref]), { pending: 1 })
})

test('deletion fence directory fsync failure cannot GC; fresh retry reproves visible fence before cleanup', async () => {
  const f = fixture(); await f.store.register(f.scope, 'one', () => {})
  const original = fs.fsyncSync
  let failed = false
  fs.fsyncSync = fd => {
    if (!failed && fs.readlinkSync(`/proc/self/fd/${fd}`) === join(f.store.root, 'deleted')) {
      failed = true; throw new Error('actual deletion directory sync failure')
    }
    original(fd)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.store.fenceDeleted([f.ref]), /actual deletion directory sync/)
    assert.equal(failed, true); assert.equal(fs.existsSync(f.data), true)
  } finally { fs.fsyncSync = original; syncBuiltinESMExports() }
  assert.deepEqual(await new ReceiptCandidateLifecycle(f.store.root).fenceDeleted([f.ref]), { pending: 0 })
  assert.equal(fs.existsSync(f.data), false)
})
