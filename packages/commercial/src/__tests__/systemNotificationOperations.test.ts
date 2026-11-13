/** Pure actor/schema/frozen-range tests. No product account, DB, login or model request. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { SystemActionExecution } from '@openclaude/storage'
import { notificationOperations } from '../system-assistant/notificationOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import { InboxApprovalConflict } from '../inbox/readApproval.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
const messages = [{ id: '19', version: '12' }, { id: '20', version: '13' }]
function fixture() {
  let authorized = true
  const snapshots: Array<[string, string | null]> = []
  const writes: unknown[] = []
  const runner = { query: async () => { throw new Error('unexpected direct query in unit fixture') } }
  let writeFailure = false
  const registry = new SystemOperationRegistry(notificationOperations({
    authorize: async a => { assert.equal(a.userId, '765'); if (!authorized) throw new SystemOperationRejected('FORBIDDEN') },
    snapshot: async (uid, id) => { snapshots.push([uid, id]); return { messages: id ? messages.slice(0, 1) : messages, title: 'Synthetic\nnotification' } },
    effect: async (_a, _e, work) => work(runner),
    write: async (uid, refs, used) => { assert.equal(used, runner); writes.push({ uid, refs }); if (writeFailure) throw new InboxApprovalConflict(); return { inserted: refs.length } },
  }))
  async function execution(operationId: string, raw: unknown) {
    const { prepared } = await registry.prepare(actor, operationId, raw)
    return { ...prepared, id: randomUUID(), userId: actor.userId, sessionId: actor.sessionId, agentId: actor.agentId, operationId, operationVersion: 1,
      executionNonce: 'synthetic-executor', previewHash: 'synthetic-preview', requestHash: 'a'.repeat(64), inputHash: 'b'.repeat(64) } as unknown as SystemActionExecution
  }
  return { registry, snapshots, writes, execution, revoke: () => { authorized = false }, conflict: () => { writeFailure = true } }
}
test('notification public schemas reject model-supplied uid, arbitrary URLs, ids and execution parameters', async () => {
  const f = fixture()
  for (const raw of [{ userId: '766' }, { url: 'https://invalid.example/' }, { messages }, { messageId: '0' }, { messageId: '9223372036854775808' }]) {
    await assert.rejects(f.registry.prepare(actor, 'notifications.mark-read', raw))
  }
  await assert.rejects(f.registry.prepare(actor, 'notifications.read-all', { messageId: '19' }))
  assert.deepEqual(f.snapshots, [])
})
test('prepare freezes server-side IDs and sanitizes the own-account title without performing a write', async () => {
  const f = fixture()
  const e = await f.execution('notifications.mark-read', { messageId: '19' })
  assert.deepEqual(f.snapshots, [['765', '19']])
  assert.deepEqual(e.args, { messages: [messages[0]], title: 'Synthetic notification' })
  assert.deepEqual(f.writes, [])
})
test('read-all preview and execution use only the prepared set with the same receipt runner', async () => {
  const f = fixture()
  const e = await f.execution('notifications.read-all', {})
  const result = await f.registry.execute(actor, e)
  assert.equal(result.completion, 'done')
  assert.deepEqual(f.writes, [{ uid: '765', refs: messages }])
  assert.deepEqual(f.snapshots, [['765', null]]) // No re-query expanding all at execution time.
})
test('fresh account authorization prevents execution after prepare', async () => {
  const f = fixture()
  const e = await f.execution('notifications.read-all', {})
  f.revoke(); await assert.rejects(f.registry.execute(actor, e), e => e instanceof SystemOperationRejected && e.code === 'FORBIDDEN')
  assert.deepEqual(f.writes, [])
})
test('frozen version drift and malformed shapes cannot execute', async () => {
  const f = fixture()
  const e = await f.execution('notifications.read-all', {})
  await assert.rejects(f.registry.execute(actor, { ...e, expectedVersion: 'different' }))
  await assert.rejects(f.registry.execute(actor, { ...e, args: { messages, url: 'https://invalid.example/' } }))
  assert.deepEqual(f.writes, [])
})
test('business snapshot conflict remains a known no-effect conflict for the receipt transaction', async () => {
  const f = fixture()
  const e = await f.execution('notifications.read-all', {})
  f.conflict(); await assert.rejects(f.registry.execute(actor, e), error => error instanceof SystemOperationRejected && error.code === 'CONFLICT')
})
