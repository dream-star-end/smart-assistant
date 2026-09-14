import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { DelegateDurableDb as LegacyV4 } from './fixtures/delegateLegacyV4.fixture.js'
import { DelegateDurableDb, type DurableJobRecord } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { readDelegateConsumerProfile } from '@openclaude/storage/delegateConsumerProfile'
import { ReceiptDeliveryCoordinator } from '@openclaude/storage/receiptDeliveryCoordinator'

function record(id: string): DurableJobRecord {
  return { id, agentId: 'child', state: 'queued', kind: 'delegate', generation: 0,
    attemptNo: 0, fencingEpoch: 0, checkpointKind: 'none', callback: 'none', callbackState: 'none',
    callbackEpoch: 0, createdAt: 1, updatedAt: 1, lastActivityAt: 1 }
}
function fixture(t: TestContext) {
  const path = join(sandbox.root, 'profile.db'), old = new LegacyV4(path)
  old.upsert(record('ordinary-before'))
  const modern = new DelegateDurableDb(path), sql = new Database(path)
  t.after(() => { modern.close(); old.close(); sql.close() })
  return { path, old, modern, sql }
}

test('real original v4 pre-opened and fresh writers survive default C0 boot; deletion does not activate v2', t => {
  const f = fixture(t)
  assert.equal(f.modern.minimumConsumer, 1)
  assert.equal(f.sql.pragma('user_version', { simple: true }), 12)
  f.old.upsert(record('ordinary-after'))
  assert.ok(f.old.get('ordinary-after'))
  const reopened = new LegacyV4(f.path)
  try { reopened.upsert(record('fresh-original')); assert.ok(reopened.get('fresh-original')) }
  finally { reopened.close() }
  const c0 = new DelegateJobStore({ durable: f.modern, sm: true })
  assert.equal(c0.acceptsNewFailureSources, false)
  assert.equal(c0.acceptsDeliveryReceipts, false)
  const job = c0.create('child', { queued: true }); assert.ok('jobId' in job)
  c0.fenceDeletedRetryParent({ userId: 'private', clientSessionId: 'private-deleted' })
  assert.equal(f.modern.minimumConsumer, 1)
  assert.equal((f.sql.prepare('SELECT count(*) AS n FROM delegate_retry_parent_fence').get() as { n: number }).n, 0)
})

test('admission seals before capability is observable and rejects both old prepared and fresh writers', t => {
  const f = fixture(t), store = new DelegateJobStore({ durable: f.modern, sm: true, deliveryReceipts: true })
  assert.equal(store.acceptsNewFailureSources, true)
  assert.equal(store.acceptsDeliveryReceipts, true)
  assert.equal(f.modern.minimumConsumer, 2)
  assert.throws(() => f.old.upsert(record('forbidden-old')), /oc_delegate_schema10/)
  let reopened: LegacyV4 | undefined
  try {
    assert.throws(() => { reopened = new LegacyV4(f.path); reopened.upsert(record('forbidden-fresh')) }, /oc_delegate_schema10/)
  } finally { reopened?.close() }
  assert.equal(f.modern.get('forbidden-old'), undefined)
  assert.equal(f.modern.get('forbidden-fresh'), undefined)
  store.fenceDeletedRetryParent({ userId: 'private', clientSessionId: 'after-admission' })
  assert.equal((f.sql.prepare('SELECT count(*) AS n FROM delegate_retry_parent_fence').get() as { n: number }).n, 1)
  assert.equal(f.modern.minimumConsumer, 2)
})

test('direct first v2 insert seals in the original transaction and rolls profile/guards back on failure', t => {
  const f = fixture(t)
  const receipt = { parentTurnKey: 'private-turn', nativeToolUseId: 'private-tool',
    receiptNonceHash: createHash('sha256').update('private-nonce').digest('hex') }
  const item = { ...record('first-v2'), callback: 'stdout-wait' as const,
    callbackOriginUserId: 'private', parentSessionKey: 'agent:main:webchat:dm:private' }
  f.sql.exec("CREATE TRIGGER private_insert_fault BEFORE INSERT ON delegate_jobs BEGIN SELECT RAISE(ABORT,'private write fault'); END")
  assert.throws(() => f.modern.insertCreate(item, 10, { deliveryReceipt: receipt }), /private write fault/)
  assert.equal(f.modern.minimumConsumer, 1)
  assert.equal(f.modern.get(item.id), undefined)
  f.sql.exec('DROP TRIGGER private_insert_fault')
  f.old.upsert(record('old-still-works'))
  assert.deepEqual(f.modern.insertCreate(item, 10, { deliveryReceipt: receipt }), { ok: true })
  assert.equal(f.modern.minimumConsumer, 2)
  assert.equal(f.modern.hasDeliveryReceiptEnrollment(item.id), true)
  assert.throws(() => f.old.upsert(record('old-now-refused')), /oc_delegate_schema10/)
})

test('profile and guard corruption never become legacy; ordinary raw connections cannot write new tables', t => {
  const f = fixture(t)
  assert.throws(() => f.sql.exec("INSERT INTO delegate_retry_parent_fence VALUES('private','client',1)"), /v2 profile required/)
  assert.throws(() => f.sql.exec("UPDATE delegate_jobs SET failure_inbox_enabled=1"), /v2 enrollment requires profile/)
  assert.throws(() => f.sql.exec('DELETE FROM delegate_consumer_profile'), /cannot be deleted/)
  assert.throws(() => f.sql.exec('INSERT OR REPLACE INTO delegate_consumer_profile VALUES(1,2)'), /already initialized/)
  assert.throws(() => f.sql.exec('UPDATE delegate_consumer_profile SET min_consumer=2'), /oc_delegate_schema10/)
  f.sql.exec('DROP TRIGGER delegate_profile_no_delete')
  assert.throws(() => readDelegateConsumerProfile(f.sql), /invalid delegate consumer guard/)
  assert.throws(() => new DelegateDurableDb(f.path), /invalid delegate consumer guard/)
})

test('sealed profile cannot decrease, and a C0 store still reads preexisting state without new admission', t => {
  const f = fixture(t)
  f.modern.sealConsumerV2()
  f.sql.function('oc_delegate_schema10', () => 10)
  assert.throws(() => f.sql.exec('UPDATE delegate_consumer_profile SET min_consumer=1'), /cannot decrease/)
  const c0 = new DelegateJobStore({ durable: f.modern, sm: true })
  assert.equal(c0.acceptsNewFailureSources, false)
  assert.equal(c0.hasDurableUserSurface, true)
  const reader = new ReceiptDeliveryCoordinator(f.path, path => new Database(path))
  reader.close()
  assert.equal(f.modern.minimumConsumer, 2)
})
