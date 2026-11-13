import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentRemoteRequest,
  agentRemoteOperationKey,
  agentRemotePayloadHash,
  requiredRemoteCapabilities,
  verifyRemoteRequest,
} from './agentRemote.js'

function request(): AgentRemoteRequest {
  const semantic = {
    protocolVersion: 1 as const,
    binding: {
      principalId: 'u1',
      sessionId: 's1',
      bindingRevision: 1,
      workerId: 'w1',
      workerInstanceId: 'wi1',
      environmentId: 'e1',
      environmentGeneration: 1,
    },
    operationId: 'op1',
    deadlineAtMs: 10000,
    command: {
      kind: 'process.exec' as const,
      command: 'printf 中文🌏',
      cwd: '/workspace',
      timeoutMs: 1000,
    },
  }
  return {
    ...semantic,
    lease: { ownerInstanceId: 'wi1', epoch: 1 },
    payloadHash: agentRemotePayloadHash(semantic),
  }
}
test('hash is canonical, domain scoped, and excludes transport lease', () => {
  const original = request()
  const retry = { ...original, lease: { ownerInstanceId: 'wi2', epoch: 2 } }
  verifyRemoteRequest(original)
  verifyRemoteRequest(retry)
  const { payloadHash, lease: _lease, ...semantic } = original
  const reordered = Object.fromEntries(Object.entries(semantic).reverse()) as typeof semantic
  assert.equal(agentRemotePayloadHash(reordered), payloadHash)
  assert.equal(
    agentRemoteOperationKey(original.binding, 'op1'),
    agentRemoteOperationKey(retry.binding, 'op1'),
  )
  assert.notEqual(
    agentRemoteOperationKey(original.binding, 'op1'),
    agentRemoteOperationKey({ ...original.binding, environmentGeneration: 2 }, 'op1'),
  )
})
test('changed operation semantics cannot retain the same hash', () => {
  const input = request()
  input.command = { kind: 'process.exec', command: 'different', cwd: '/workspace', timeoutMs: 1000 }
  assert.throws(() => verifyRemoteRequest(input), /payload-hash-mismatch/)
})
test('unknown version, fields, capabilities and invalid numeric identity fail closed', () => {
  const input = request()
  for (const bad of [
    { ...input, protocolVersion: 2 },
    { ...input, endpoint: 'local' },
    { ...input, lease: { ...input.lease, epoch: Number.NaN } },
    { ...input, lease: { ...input.lease, epoch: 1.1 } },
    { ...input, lease: { ...input.lease, epoch: Number.MAX_SAFE_INTEGER + 1 } },
    { ...input, command: { ...input.command, kind: 'local.fallback' } },
  ])
    assert.throws(() => verifyRemoteRequest(bad), /bad-shape/)
})
test('conditional mutations and tree stop require explicit capabilities', () => {
  assert.deepEqual(
    requiredRemoteCapabilities({
      kind: 'file.edit',
      path: '/a',
      oldText: 'a',
      newText: 'b',
      expectedSha256: 'a'.repeat(64),
    }),
    ['file.edit', 'file.cas'],
  )
  assert.deepEqual(
    requiredRemoteCapabilities({
      kind: 'process.stop',
      jobId: 'j',
      sourceOperationId: 'op',
      scope: 'process-tree',
    }),
    ['process.stop', 'process.stop-tree'],
  )
})
