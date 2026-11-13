import assert from 'node:assert/strict'
import test from 'node:test'
import { makeAuthorizeSystemActor } from '../system-assistant/assemble.js'
import { SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import type { QueryRunner } from '../db/queries.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
test('composition authorization only reads current active nondeleted identity and refuses stale roles', async () => {
  let role: string | undefined = 'user'
  let calls = 0
  const runner: QueryRunner = { async query(sql, params) {
    calls++; assert.ok(sql.startsWith('SELECT ')); assert.ok(sql.includes("status='active'")); assert.ok(sql.includes('deleted_at IS NULL')); assert.deepEqual(params, ['765'])
    return { rows: role ? [{ role }] : [] } as never
  } }
  const authorize = makeAuthorizeSystemActor(runner)
  await authorize(actor)
  role = 'admin'
  await assert.rejects(authorize(actor), e => e instanceof SystemOperationRejected && e.code === 'FORBIDDEN')
  await authorize({ ...actor, role: 'admin' })
  role = undefined
  await assert.rejects(authorize(actor))
  const before = calls
  await assert.rejects(authorize({ ...actor, userId: '765 OR 1=1' }))
  assert.equal(calls, before)
})
