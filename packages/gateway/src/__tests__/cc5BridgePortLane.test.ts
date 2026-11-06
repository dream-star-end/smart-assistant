/** A container port follows its chat's replaced lane, and only that chat's. Relay calls are recorded. */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { type Cc5BridgeBinding, UnixCc5BridgePort } from '../cc5BridgePort.js'
import type { TurnModelAuthority } from '../subprocessSpawnConfig.js'

const lane = (over: Partial<Cc5BridgeBinding> = {}): Cc5BridgeBinding => ({
  version: 2, backendKind: 'cc5-interactive-v1', canonicalModel: 'claude-opus-5-5-remote',
  sessionKey: 'agent:main:webchat:dm:chat_a1b2c3d4', runId: '22222222-2222-4222-8222-222222222222',
  uid: '3', containerDbId: '91', dockerId: 'd'.repeat(64),
  operationId: '11111111-1111-4111-8111-111111111111', capability: 'a'.repeat(64),
  expiresAt: Date.now() + 3_600_000, ...over,
})
const authority = (b: Cc5BridgeBinding) => ({
  authorityEnvelope: 'authority', leaseEnvelope: 'lease',
  executionDescriptor: { canonicalModel: b.canonicalModel,
    executionBackend: { kind: b.backendKind, sessionKey: b.sessionKey, operationId: b.operationId } },
}) as unknown as TurnModelAuthority

async function prepare(port: UnixCc5BridgePort): Promise<void> {
  // The stdio bridge entry exists only in a built release; the lane refresh happens first.
  await port.prepare({ cwd: tmpdir() }).catch((error: Error) => assert.equal(error.message, 'CC5_BRIDGE_MISSING'))
}

test('after its runner shut down, the port reopens on the chat replacement lane and admits with its capability', async () => {
  const first = lane()
  let current: Cc5BridgeBinding = first
  const calls: Array<{ path: string; capability: unknown }> = []
  const port = new UnixCc5BridgePort(first, first.sessionKey, async (path, body) => {
    calls.push({ path, capability: body.capability })
    return path === '/admit'
      ? { ok: true, ready: true, admissionHash: 'b5b2f0ee0f1e3e2b0c0b8d0f4a9a4e1b2c3d4e5f60718293a4b5c6d7e8f90a1b' }
      : { ok: true, remoteStopped: true }
  }, () => current)
  await prepare(port)
  await port.admit({ authority: authority(first), turnKey: 't1', model: first.canonicalModel }).catch(() => {})
  await port.close() // The remote CLI died: the runner shut down and stopped its lane.
  current = lane({ capability: 'b'.repeat(64), expiresAt: Date.now() + 7_200_000 })
  await prepare(port)
  await port.admit({ authority: authority(current), turnKey: 't2', model: current.canonicalModel }).catch(() => {})
  assert.deepEqual(calls.map((c) => [c.path, c.capability]), [
    ['/admit', 'a'.repeat(64)], ['/stop', 'a'.repeat(64)], ['/admit', 'b'.repeat(64)]])
})

test('a binding for another model, chat or container is never adopted', async () => {
  for (const other of [lane({ capability: 'c'.repeat(64), canonicalModel: 'claude-haiku-5-5-remote' }),
    lane({ capability: 'c'.repeat(64), containerDbId: '92' }),
    lane({ capability: 'c'.repeat(64), runId: '33333333-3333-4333-8333-333333333333' })]) {
    const port = new UnixCc5BridgePort(lane(), lane().sessionKey,
      async () => ({ ok: true, remoteStopped: true }), () => other)
    await port.close()
    await assert.rejects(port.prepare(), /CC5_BRIDGE_BINDING_INVALID/)
  }
})

test('a lane that is gone keeps the closed port closed', async () => {
  const port = new UnixCc5BridgePort(lane(), lane().sessionKey,
    async () => ({ ok: true, remoteStopped: true }), () => { throw new Error('no binding') })
  await port.close()
  await assert.rejects(port.prepare(), /CC5_BRIDGE_BINDING_INVALID/)
})
