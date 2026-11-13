/** A container port follows its chat's replaced lane, and only that chat's. Relay calls are recorded. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { type Cc5BridgeBinding, UnixCc5BridgePort } from '../cc5BridgePort.js'
import { SubprocessRunner, __setCcbSpawnForTests } from '../subprocessRunner.js'

const lane = (over: Partial<Cc5BridgeBinding> = {}): Cc5BridgeBinding => ({
  version: 2, backendKind: 'cc5-interactive-v1', canonicalModel: 'claude-opus-5-5-remote',
  sessionKey: 'agent:main:webchat:dm:chat_a1b2c3d4', runId: '22222222-2222-4222-8222-222222222222',
  uid: '3', containerDbId: '91', dockerId: 'd'.repeat(64),
  operationId: '11111111-1111-4111-8111-111111111111', capability: 'a'.repeat(64),
  expiresAt: Date.now() + 3_600_000, ...over,
})
test('a binding for another model, chat or container is never adopted', async () => {
  for (const other of [lane({ capability: 'c'.repeat(64), canonicalModel: 'claude-haiku-5-5-remote' }),
    lane({ capability: 'c'.repeat(64), containerDbId: '92' }),
    lane({ capability: 'c'.repeat(64), runId: '33333333-3333-4333-8333-333333333333' })]) {
    const port = new UnixCc5BridgePort(lane(), lane().sessionKey,
      async () => ({ ok: true, remoteStopped: true }), () => other)
    await port.close()
    await assert.rejects(port.prepare({ cwd: tmpdir() }), /CC5_BRIDGE_BINDING_INVALID/)
  }
})

test('a lane that is gone keeps the closed port closed', async () => {
  const port = new UnixCc5BridgePort(lane(), lane().sessionKey,
    async () => ({ ok: true, remoteStopped: true }), () => { throw new Error('no binding') })
  await port.close()
  await assert.rejects(port.prepare({ cwd: tmpdir() }), /CC5_BRIDGE_BINDING_INVALID/)
})

/**
 * The real runner order: SubprocessRunner.submit admits first, then (re)starts the bridge.
 * Only the relay transport is a fixture, and it rejects any capability but the current lane's
 * exactly as the relay scope check does; prepare() is overridden only because the bridge entry
 * file exists in built releases alone.
 */

class FakeProc extends EventEmitter {
  pid = 42424243
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(): boolean { this.emit('close', 0, null); return true }
  constructor() { super(); this.stdin.on('finish', () => queueMicrotask(() => this.emit('close', 0, null))) }
}

function runnerRig() {
  const relay = { capability: 'a'.repeat(64) }
  let current = lane()
  const admitted: unknown[] = []
  const call = async (path: string, body: Readonly<Record<string, unknown>>) => {
    if (body.capability !== relay.capability) throw new Error('CC5_CONTROL_REJECTED')
    if (path === '/admit') {
      admitted.push(body.capability)
      return { ok: true, ready: true, admissionHash: createHash('sha256').update(String(body.authority))
        .update('\0').update(String(body.lease)).digest('hex') }
    }
    return { ok: true, remoteStopped: true }
  }
  class Port extends UnixCc5BridgePort {
    override async prepare() {
      return { command: process.execPath, args: ['synthetic-child'], ccbBinaryDir: process.cwd(),
        env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }
    }
  }
  const port = new Port(current, current.sessionKey, call, () => current)
  const procs: FakeProc[] = []
  __setCcbSpawnForTests(() => { const p = new FakeProc(); procs.push(p); return p as never })
  const b = current
  const executionBackend = { kind: b.backendKind, sessionKey: b.sessionKey, operationId: b.operationId }
  const runner = new SubprocessRunner({
    sessionKey: b.sessionKey, executionBackend, agentId: 'main', agentBaseDir: process.cwd(),
    model: b.canonicalModel, config: { auth: {}, gateway: { port: 0, accessToken: 'fixture-token' }, terminal: { type: 'local' } } as never, cc5BridgePort: port,
    harness: 'official-cc', boxResidentCc: true, authorityEngine: 'ccb',
  } as never)
  const turn = (n: number) => runner.submit(`turn ${n}`, undefined, {
    authorityEnvelope: `authority-${n}`, leaseEnvelope: `lease-${n}`,
    executionDescriptor: { canonicalModel: b.canonicalModel, executionBackend, contextOwner: 'box-native-v1',
      contextWindow: 200000, capabilityZero: true, supportsThinking: false, supportsVision: false, supportedEfforts: [] },
  } as never, `turn-key-${n}`)
  const replaceLane = (capability: string) => {
    relay.capability = capability
    current = lane({ capability, expiresAt: Date.now() + 7_200_000 })
  }
  return { runner, turn, replaceLane, admitted, procs }
}

test('the real runner continues a chat whose lane was replaced while its port stayed open', async () => {
  const r = runnerRig()
  try {
    await r.turn(1)
    r.procs.at(-1)!.emit('close', 0, null) // The remote CLI ended; the master rebuilt the lane.
    r.replaceLane('b'.repeat(64))
    await r.turn(2)
    assert.deepEqual(r.admitted, ['a'.repeat(64), 'b'.repeat(64)])
  } finally {
    await r.runner.shutdown().catch(() => {})
    __setCcbSpawnForTests(null)
  }
})

test('the real runner continues a chat whose lane was replaced after its runner shut down', async () => {
  const r = runnerRig()
  try {
    await r.turn(1)
    await r.runner.shutdown() // Closes the port and stops the old lane.
    r.replaceLane('c'.repeat(64))
    await r.turn(2)
    assert.deepEqual(r.admitted, ['a'.repeat(64), 'c'.repeat(64)])
  } finally {
    await r.runner.shutdown().catch(() => {})
    __setCcbSpawnForTests(null)
  }
})
