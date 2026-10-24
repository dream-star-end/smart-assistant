import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import type { SystemActionPreview } from '@openclaude/protocol'
import { parseProfileControlVersion, profileControlVersion } from '../profileControlVersion.js'
import { SystemActionStore, type PrepareSystemAction } from '../systemActions.js'
const condition = { parentManifestSha256: 'a'.repeat(64), baseProfileVersion: 'b'.repeat(16), targetProfileSha256: 'c'.repeat(64) }
const token = profileControlVersion(condition)
const preview: SystemActionPreview = { title: '更新个人信息', description: '替换已确认内容', scope: '当前账号', before: [], after: [], consequences: [], destructive: false, price: { kind: 'none', label: '无新增费用' } }
function setup() {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'oc-control-lineage-')), 'ledger.db')
  const key = randomBytes(32)
  let clock = 1_000_000
  const create = () => new SystemActionStore({ dbPath, key, now: () => clock })
  const store = create()
  let sequence = 0
  const prepare = (over: Partial<PrepareSystemAction> = {}) => store.prepare({ userId: '765', sessionId: 'fixture-session', agentId: 'main',
    operationId: 'memory.profile.update', operationVersion: 1, operationTitle: '更新个人信息', executor: 'control',
    resourceKey: 'profile', idempotencyKey: `fixture-${++sequence}`, args: { text: 'private-source-must-be-discarded' }, preview,
    expectedVersion: token, requestHash: 'd'.repeat(64), ...over })
  const confirm = (id: string) => {
    const detail = store.detail('765', id)
    const execution = store.confirm('765', id, { nonce: store.issueChallenge('765', id, 'fixture-device', detail.previewHash), deviceId: 'fixture-device', previewHash: detail.previewHash }, 'host-fixture')
    if (!('executionNonce' in execution)) throw new Error('Expected control execution')
    return execution
  }
  const read = (id: string) => { const db = new Database(dbPath, { readonly: true }); try { return db.prepare('SELECT state,sealed,expected_version,approval_hash,grant_hash,execution_hash FROM system_actions WHERE id=?').get(id) } finally { db.close() } }
  return { store, prepare, confirm, read, create, tick: () => { clock += 1000 } }
}
test('profile v1 recovery condition parses exact opaque fields without coercion', () => {
  assert.deepEqual(parseProfileControlVersion(token), condition)
  assert.equal(profileControlVersion(condition), token)
  for (const invalid of [null, 1, {}, token.toUpperCase(), `${token}:extra`, `${token}\n`, token.replace('v1:', 'v2:'), token.replace('b'.repeat(16), 'b'.repeat(15))]) assert.equal(parseProfileControlVersion(invalid), null)
  assert.throws(() => profileControlVersion({ ...condition, baseProfileVersion: { toString: () => 'b'.repeat(16) } } as never))
  assert.equal(Object.isFrozen(parseProfileControlVersion(token)), true)
})
test('control lineage projects only bound immutable metadata, never an execution grant', () => {
  const t = setup()
  try {
    const a = t.prepare(); assert.equal(t.store.controlRecoveryRecord('765', a.id), null)
    const execution = t.confirm(a.id)
    const record = t.store.controlRecoveryRecord('765', a.id)!
    assert.equal(record.state, 'executing'); assert.equal(record.executorId, 'host-fixture'); assert.equal(record.expectedVersion, token)
    assert.deepEqual(record.binding, { id: a.id, userId: '765', sessionId: 'fixture-session', agentId: 'main', operationId: 'memory.profile.update', operationVersion: 1, requestHash: 'd'.repeat(64), inputHash: execution.inputHash })
    assert.deepEqual(Object.keys(record).sort(), ['binding', 'executorId', 'expectedVersion', 'state'])
    assert.equal(JSON.stringify(record).includes('private-source'), false)
    assert.equal(Object.isFrozen(record) && Object.isFrozen(record.binding), true)
    for (const uid of ['766', '0765', '0', '-1', '9223372036854775808', '9'.repeat(100)]) assert.equal(t.store.controlRecoveryRecord(uid, a.id), null)
    assert.equal(t.store.controlRecoveryRecord('765', a.id.toUpperCase()), null)
  } finally { t.store.close() }
})
test('unknown and succeeded retain original condition after all executable material is discarded and reopen', () => {
  for (const state of ['unknown', 'succeeded'] as const) {
    const t = setup(); const a = t.prepare(); const execution = t.confirm(a.id)
    t.store.finish(execution, state, { summary: '结果已记录', completion: 'done' })
    assert.deepEqual(t.read(a.id), { state, sealed: null, expected_version: token, approval_hash: null, grant_hash: null, execution_hash: null })
    t.store.close()
    const reopened = t.create()
    try { const r = reopened.controlRecoveryRecord('765', a.id)!; assert.equal(r.state, state); assert.equal(r.expectedVersion, token); assert.equal(r.binding.inputHash, execution.inputHash) } finally { reopened.close() }
  }
})
test('getter is a pure select and does not expire pending approvals', () => {
  const t = setup()
  try {
    const a = t.prepare({ ttlMs: 10 }); const before = t.read(a.id); t.tick()
    assert.equal(t.store.controlRecoveryRecord('765', a.id), null)
    assert.deepEqual(t.read(a.id), before)
    assert.equal(t.store.controlRecoveryRecord('765', '00000000-0000-0000-0000-000000000000'), null)
  } finally { t.store.close() }
})
test('other operations, versions, executors and malformed/missing recovery conditions cannot become lineage', () => {
  for (const over of [{ operationId: 'preferences.patch' }, { operationVersion: 2 }, { executor: 'master' as const }, { requestHash: undefined }, { expectedVersion: 'legacy-v1' }, { expectedVersion: undefined }]) {
    const t = setup()
    try { const a = t.prepare(over); t.confirm(a.id); assert.equal(t.store.controlRecoveryRecord('765', a.id), null) } finally { t.store.close() }
  }
})
test('denied, expired, failed and waiting browser approvals never become recovery lineage', () => {
  for (const state of ['denied', 'expired', 'failed', 'approved_waiting_browser'] as const) {
    const t = setup()
    try {
      const a = t.prepare({ executor: state === 'approved_waiting_browser' ? 'browser' : 'control', ttlMs: 10 })
      if (state === 'denied') t.store.deny('765', a.id)
      else if (state === 'expired') { t.tick(); t.store.expire() }
      else if (state === 'failed') t.store.finish(t.confirm(a.id), 'failed', { summary: '未写入', completion: 'done' })
      else { const d = t.store.detail('765', a.id); t.store.confirm('765', a.id, { nonce: t.store.issueChallenge('765', a.id, 'fixture-device', d.previewHash), deviceId: 'fixture-device', previewHash: d.previewHash }, 'host-fixture') }
      assert.equal(t.store.controlRecoveryRecord('765', a.id), null)
    } finally { t.store.close() }
  }
})
