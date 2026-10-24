import assert from 'node:assert/strict'
import test from 'node:test'
import type { V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { makeSystemRuntimeStatusRead } from '../system-assistant/runtimeStatusRead.js'
import { SystemOperationRejected } from '../system-assistant/operations.js'
test('runtime read port uses the validated uid and strips host/container positioning data', async () => {
  const deps = {} as V3SupervisorDeps // Synthetic spy only; the actual Docker/SQL reader is not invoked.
  const calls: number[] = []
  const read = makeSystemRuntimeStatusRead(deps, async (used, uid) => { assert.equal(used, deps); calls.push(uid); return { state: 'running', lastWsActivity: null,
    containerId: 19, userId: uid, boundIp: '192.0.2.1', port: 1, dockerContainerId: 'synthetic-private', hostId: null, image: 'synthetic-image', labels: { synthetic: 'private' } } })
  assert.deepEqual(await read('765'), { state: 'running', lastWsActivity: null })
  assert.deepEqual(calls, [765])
})
test('unsafe numeric identities and an absent v3 dependency fail before any inspect call', async () => {
  let calls = 0
  const inspect = async () => { calls++; return null }
  const read = makeSystemRuntimeStatusRead({} as V3SupervisorDeps, inspect)
  for (const uid of ['0','-1','765.0','000765','9007199254740992','9007199254740993','not-a-uid']) await assert.rejects(read(uid), error => error instanceof SystemOperationRejected && error.code === 'UNAVAILABLE')
  await assert.rejects(makeSystemRuntimeStatusRead(undefined, inspect)('765'))
  assert.equal(calls, 0)
})
