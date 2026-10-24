import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { SystemActionExecution } from '@openclaude/storage'
import { sessionMetadataOperations } from '../system-assistant/sessionMetadataOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import { SessionMetadataConflict } from '../db/sessionMetadataApproval.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-origin', agentId: 'main' }
function fixture(pgSessionsReady = true) {
  let allowed = true
  let conflict = false
  const reads: unknown[] = []
  const writes: unknown[] = []
  const runner = { query: async () => { throw new Error('unexpected direct unit query') } }
  const registry = new SystemOperationRegistry(sessionMetadataOperations({
    pgSessionsReady,
    authorize: async a => { assert.equal(a.userId, '765'); if (!allowed) throw new SystemOperationRejected('FORBIDDEN') },
    snapshot: async (owner, id) => { reads.push({ owner, id }); return { id, title: 'Original', pinned: false, updatedAt: 100, version: '12' } },
    effect: async (a, e, work) => { assert.equal(a.sessionId, 'synthetic-origin'); assert.equal(e.sessionId, 'synthetic-origin'); return work(runner) },
    write: async (used, id, owner, patch, version) => { assert.equal(used, runner); if (conflict) throw new SessionMetadataConflict(); writes.push({ id, owner, patch, version }); return { ok: true, updatedAt: 101, version: '13' } },
  }))
  async function execution(raw: unknown) {
    const { prepared } = await registry.prepare(actor, 'sessions.metadata.update', raw)
    return { ...prepared, id: randomUUID(), userId: '765', sessionId: actor.sessionId, agentId: actor.agentId, operationId: 'sessions.metadata.update', operationVersion: 1,
      executionNonce: 'synthetic', requestHash: 'a'.repeat(64), inputHash: 'b'.repeat(64) } as unknown as SystemActionExecution
  }
  return { registry, reads, writes, execution, revoke: () => { allowed = false }, conflict: () => { conflict = true } }
}
test('metadata schema rejects owner, runtime/model/project actions, empty patches and invalid title/pinned before reading', async () => {
  const f = fixture()
  for (const raw of [{ sessionId: 'target', patch: {} }, { sessionId: 'target', userId: '766', patch: { title: 'name' } }, { sessionId: 'target', patch: { modelId: 'other' } }, { sessionId: 'target', patch: { pinned: 1 } }, { sessionId: 'target', patch: { title: ' '.repeat(3) } }, { sessionId: 'target', patch: { title: 'x'.repeat(121) } }]) await assert.rejects(f.execution(raw))
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.writes, [])
})
test('prepare snapshots only the owner namespace and freezes trimmed target values without writing', async () => {
  const f = fixture()
  const e = await f.execution({ sessionId: 'target', patch: { title: '  Approved  ', pinned: true } })
  assert.deepEqual(f.reads, [{ owner: 'c:765', id: 'target' }])
  assert.deepEqual(e.args, { sessionId: 'target', patch: { title: 'Approved', pinned: true }, before: { title: 'Original', pinned: false }, version: '12' })
  assert.equal(e.resourceKey, 'session-metadata:765:target')
  assert.deepEqual(f.writes, [])
})
test('execution uses the exact frozen target/version, original requesting session and one receipt runner', async () => {
  const f = fixture()
  const e = await f.execution({ sessionId: 'different-target', patch: { pinned: true } })
  const result = await f.registry.execute(actor, e)
  assert.deepEqual(f.writes, [{ id: 'different-target', owner: 'c:765', patch: { pinned: true }, version: '12' }])
  assert.equal(result.effectReference, 'session:different-target')
  assert.equal(result.completion, 'done')
})
test('revoked authorization and frozen version tampering cannot execute', async () => {
  const f = fixture()
  const e = await f.execution({ sessionId: 'target', patch: { title: 'Approved' } })
  await assert.rejects(f.registry.execute(actor, { ...e, expectedVersion: '11' }))
  f.revoke()
  await assert.rejects(f.registry.execute(actor, e), error => error instanceof SystemOperationRejected && error.code === 'FORBIDDEN')
  assert.deepEqual(f.writes, [])
})
test('business version conflict remains a known no-effect conflict', async () => {
  const f = fixture()
  const e = await f.execution({ sessionId: 'target', patch: { title: 'Approved' } })
  f.conflict()
  await assert.rejects(f.registry.execute(actor, e), error => error instanceof SystemOperationRejected && error.code === 'CONFLICT')
})

test('missing PG session authority refuses preparation before a stale PG snapshot can be used', async () => {
  const f = fixture(false)
  await assert.rejects(f.execution({ sessionId: 'target', patch: { title: 'Must not change' } }), error => error instanceof SystemOperationRejected && error.code === 'UNAVAILABLE')
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, [])
})
