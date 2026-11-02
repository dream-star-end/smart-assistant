import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityPayload,
  type TurnLease,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
} from '@openclaude/protocol'
import { type Cc5BridgeBinding, cc5ControlRequest } from '../cc5BridgePort.js'
import { createCc5FreshContainerRuntime } from '../cc5ContainerRuntime.js'

const env = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }
function fixture(failStop = false) {
  const root = mkdtempSync(join(tmpdir(), 'cc5-cr-'))
  const baseRoot = `/proc/${process.pid}/cwd/${relative(process.cwd(), join(root, 'r'))}`
  const key = generateKeyPairSync('ed25519')
  const x = (key.publicKey.export({ format: 'jwk' }) as { x: string }).x
  const publicKeyring = `fixture-key:${x}`
  let starts = 0
  let stops = 0
  let factories = 0
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  input.on('data', (b: Buffer) => written.push(b))
  const options = {
    baseRoot,
    profile: { operationId: randomUUID(), runId: randomUUID() },
    ssh: {
      user: 'dedicated_cc5',
      taskRoot: '/home/box/oc-agentremote-t1555u-20261102t1400z-fixture',
      privateKeyPath: '/unused/dedicated-key',
      knownHostsPath: '/unused/known-hosts',
      controllerPath: '/unused/controller',
    },
    hostFactory: () => {
      factories++
      return {
        start() {
          starts++
          return { stdin: input, stdout: output, ready: Promise.resolve() }
        },
        async stop(): Promise<{ remoteStopped: true }> {
          stops++
          if (failStop) throw new Error('fixture remote exit remains unknown')
          return { remoteStopped: true }
        },
      }
    },
  }
  const runtime = createCc5FreshContainerRuntime({
    selfhost: true,
    env,
    configuration: () => options,
  })!
  const prepare = () =>
    runtime.prepare({ uid: 912, containerDbId: '91', local: true, publicKeyring })
  return {
    root,
    baseRoot,
    runtime,
    prepare,
    options,
    publicKeyring,
    key,
    written,
    get starts() {
      return starts
    },
    get stops() {
      return stops
    },
    get factories() {
      return factories
    },
    async cleanup() {
      await runtime.release('91').catch(() => {})
      rmSync(root, { recursive: true, force: true })
    },
  }
}
function envelopes(key: ReturnType<typeof generateKeyPairSync>, b: Cc5BridgeBinding) {
  const now = Date.now()
  const a: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: 'fixture-key',
    uid: 912,
    containerId: 91,
    authorityTurnId: 'a'.repeat(32),
    connectionChallenge: 'fixture-connection',
    canonicalModel: 'cc5-remote-t1555u',
    engine: 'cursor',
    securityEpoch: 1,
    executionRevision: 'fixture-r1',
    issuedAt: now,
    expiresAt: now + 60000,
    executionDescriptor: {
      capabilityProfile: {},
      capabilitySchemaVersion: 1,
      contextWindow: 200000,
      supportedEfforts: [],
      supportsVision: false,
    },
  }
  const lease: TurnLease = {
    v: a.v,
    keyId: a.keyId,
    uid: a.uid,
    containerId: a.containerId,
    authorityTurnId: a.authorityTurnId,
    connectionChallenge: a.connectionChallenge,
    canonicalModel: a.canonicalModel,
    securityEpoch: a.securityEpoch,
    issuedAt: now,
    expiresAt: now + 120000,
  }
  return {
    ...b,
    sessionKey: 'fixture-session',
    turnKey: 'fixture-billing-turn',
    authority: encodeAuthorityEnvelope(a, sign(null, authoritySigningInput(a), key.privateKey)),
    lease: encodeTurnLeaseEnvelope(lease, sign(null, turnLeaseSigningInput(lease), key.privateKey)),
  }
}

test('OFF, invalid UID and nonselfhost never read configuration or create a runtime', () => {
  let configurations = 0
  for (const [selfhost, policy] of [
    [true, {}],
    [false, env],
    [true, { ...env, OC_SELFHOST_CC5_T1555U_TEST_UID: 'all' }],
    [true, { ...env, OC_SELFHOST_CC5_T1555U_ENABLED: 'true' }],
  ] as const) {
    assert.equal(
      createCc5FreshContainerRuntime({
        selfhost,
        env: policy,
        configuration: () => {
          configurations++
          throw new Error('must never read deployment configuration')
        },
      }),
      undefined,
    )
  }
  assert.equal(configurations, 0)
})

test('wrong UID/remote placement do no prepare IO; opaque handle and full CID are required before activation', async () => {
  const f = fixture()
  try {
    assert.equal(
      await f.runtime.prepare({ uid: 913, containerDbId: '91', local: true, publicKeyring: '' }),
      null,
    )
    await assert.rejects(
      f.runtime.prepare({
        uid: 912,
        containerDbId: '91',
        local: false,
        publicKeyring: f.publicKeyring,
      }),
    )
    assert.deepEqual(readdirSync(f.baseRoot), [])
    const handle = (await f.prepare())!
    assert.equal(f.factories, 0)
    assert.equal(f.starts, 0)
    assert.equal(existsSync(join(handle.mountSource, 'relay.sock')), false)
    await assert.rejects(f.runtime.bindCreated({ ...handle }, 'a'.repeat(64)))
    await assert.rejects(f.runtime.bindCreated(handle, 'short-id'))
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    await assert.rejects(async () => f.runtime.activate(handle, 'b'.repeat(64)))
    assert.equal(f.factories, 0)
    await f.runtime.release('91', 'a'.repeat(64))
    await assert.rejects(async () => f.runtime.activate(handle, 'a'.repeat(64)))
    assert.equal(f.starts, 0)
    // One strict remote profile is consumed once even after successful cleanup.
    await assert.rejects(
      f.runtime.prepare({
        uid: 912,
        containerDbId: '92',
        local: true,
        publicKeyring: f.publicKeyring,
      }),
    )
  } finally {
    await f.cleanup()
  }
})

test('prepared/bound directory has no relay; activation exposes exact root-owned files then a real signed admission reaches the fake host', async () => {
  const f = fixture()
  let req: ReturnType<typeof request> | undefined
  try {
    const handle = (await f.prepare())!
    const socket = join(handle.mountSource, 'relay.sock')
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    assert.equal(existsSync(socket), false)
    assert.equal(f.factories, 0)
    const b = JSON.parse(
      readFileSync(join(handle.mountSource, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    assert.equal(b.operationId, f.options.profile.operationId)
    for (const name of ['binding.json', 'authority-public.json']) {
      const st = lstatSync(join(handle.mountSource, name))
      assert.equal(st.uid, 0)
      assert.equal(st.gid, 1000)
      assert.equal(st.mode & 0o777, 0o640)
    }
    assert.equal(lstatSync(handle.mountSource).uid, 0)
    await f.runtime.activate(handle, b.dockerId)
    assert.equal(f.factories, 1)
    assert.equal(f.starts, 0)
    assert.equal(lstatSync(socket).uid, 1000)
    assert.equal(lstatSync(socket).mode & 0o777, 0o600)
    const scope = envelopes(f.key, b)
    await assert.rejects(cc5ControlRequest('/admit', { ...scope, uid: '913' }, socket))
    assert.equal(f.starts, 0)
    assert.equal(f.written.length, 0)
    const admitted = await cc5ControlRequest('/admit', scope, socket)
    assert.equal(admitted.ready, true)
    assert.equal(f.starts, 1)
    assert.equal(f.written.length, 0)
    req = request({ socketPath: socket, method: 'POST', path: '/session/open' })
    req.on('error', () => {})
    req.write(`${JSON.stringify({ ...b, type: 'open', sessionKey: scope.sessionKey })}\n`)
    const [res] = await once(req, 'response')
    res.on('error', () => {})
    res.resume()
    const bytes = Buffer.from(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ordinary fixture user frame' } })}\n`,
    )
    req.write(
      `${JSON.stringify({ seq: 1, bytes: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') })}\n`,
    )
    const end = Date.now() + 1000
    while (f.written.length === 0) {
      assert.ok(Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(Buffer.concat(f.written), bytes)
    await f.runtime.release('91', b.dockerId)
    assert.equal(f.stops, 1)
    assert.equal(existsSync(socket), false)
  } finally {
    req?.destroy()
    await f.cleanup()
  }
})

test('release racing activation cannot leave a late control listener or start a host', async () => {
  const f = fixture()
  try {
    const handle = (await f.prepare())!
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    const activated = f.runtime.activate(handle, 'a'.repeat(64))
    const released = f.runtime.release('91', 'a'.repeat(64))
    await assert.rejects(activated)
    await released
    assert.equal(f.starts, 0)
    assert.equal(existsSync(join(handle.mountSource, 'relay.sock')), false)
  } finally {
    await f.cleanup()
  }
})

test('unproved remote exit retains private unknown fence and cannot be replaced/restarted', async () => {
  const f = fixture(true)
  try {
    const handle = (await f.prepare())!
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    await f.runtime.activate(handle, 'a'.repeat(64))
    const b = JSON.parse(
      readFileSync(join(handle.mountSource, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    await cc5ControlRequest('/admit', envelopes(f.key, b), join(handle.mountSource, 'relay.sock'))
    await assert.rejects(f.runtime.release('91', b.dockerId))
    assert.equal(existsSync(join(dirname(handle.mountSource), 'UNKNOWN.json')), true)
    assert.equal(existsSync(join(handle.mountSource, 'relay.sock')), false)
    await assert.rejects(
      f.runtime.prepare({
        uid: 912,
        containerDbId: '92',
        local: true,
        publicKeyring: f.publicKeyring,
      }),
    )
    assert.throws(() =>
      createCc5FreshContainerRuntime({ selfhost: true, env, configuration: () => f.options }),
    )
  } finally {
    await f.cleanup()
  }
})
