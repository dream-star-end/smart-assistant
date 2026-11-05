import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  type Cc5BridgeBinding,
  cc5ControlRequest,
  createCc5FreshContainerRuntime,
} from '@openclaude/gateway/cc5-container-runtime'
import type { Cc5FinanceFactory } from '@openclaude/gateway/cc5-finance'
import {
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityPayload,
  type TurnLease,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
} from '@openclaude/protocol'

const financeFactory: Cc5FinanceFactory = () => ({ async admit(info) { return {
  async beforeHostStart() {}, async beforeDispatch() {}, async stop() {},
  async terminal() { return { state: 'proven', requestId: info?.authority?.billingRequestId ?? 'fixture-only-request' } },
} } })
const env = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }
function fixture(failStop = false, attachable = false) {
  const root = mkdtempSync(join(tmpdir(), 'cc5-cr-'))
  const baseRoot = `/proc/${process.pid}/cwd/${relative(process.cwd(), join(root, 'r'))}`
  const key = generateKeyPairSync('ed25519')
  const x = (key.publicKey.export({ format: 'jwk' }) as { x: string }).x
  const publicKeyring = `fixture-key:${x}`
  let starts = 0
  let attaches = 0
  let stops = 0
  let factories = 0
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  input.on('data', (b: Buffer) => written.push(b))
  const options = {
    baseRoot,
    profile: { operationId: randomUUID(), runId: randomUUID() },
    scope: { sessionKey: 'agent:main:webchat:dm:fixture_chat1', canonicalModel: 'box-claude-sonnet-5' as const },
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
          if (starts > 0) {
            throw new Error('task-lifecycle-already-used')
          }
          starts++
          return { stdin: input, stdout: output, ready: Promise.resolve() }
        },
        ...(attachable
          ? {
              attach() {
                attaches++
                return { stdin: input, stdout: output, ready: Promise.resolve() }
              },
            }
          : {}),
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
    financeFactory,
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
    input,
    output,
    written,
    get starts() {
      return starts
    },
    get attaches() {
      return attaches
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
function envelopes(
  key: ReturnType<typeof generateKeyPairSync>,
  b: Cc5BridgeBinding,
  overrides?: { authorityTurnId?: string; billingRequestId?: string; turnKey?: string },
) {
  const now = Date.now()
  const authorityTurnId = overrides?.authorityTurnId ?? 'a'.repeat(32)
  const billingRequestId = overrides?.billingRequestId ?? 'fixture-only-request'
  const turnKey = overrides?.turnKey ?? 'fixture-billing-turn'
  const a: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: 'fixture-key',
    uid: 912,
    containerId: 91,
    authorityTurnId,
    billingRequestId,
    connectionChallenge: 'fixture-connection',
    canonicalModel: 'box-claude-sonnet-5',
    engine: 'ccb',
    executionBackend: { kind: 'cc5-interactive-v1', sessionKey: b.sessionKey, operationId: b.operationId },
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
    sessionKey: b.sessionKey,
    turnKey,
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
        financeFactory,
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
    await assert.rejects(
      f.runtime.prepare({
        uid: 912,
        containerDbId: '92',
        local: true,
        publicKeyring: f.publicKeyring,
      }),
    )
    await assert.rejects(async () => f.runtime.activate(handle, 'b'.repeat(64)))
    assert.equal(f.factories, 0)
    await f.runtime.release('91', 'a'.repeat(64))
    await assert.rejects(async () => f.runtime.activate(handle, 'a'.repeat(64)))
    assert.equal(f.starts, 0)
    // Same containerDbId cannot be prepared again, but a fresh containerDbId after clean release succeeds.
    await assert.rejects(
      f.runtime.prepare({
        uid: 912,
        containerDbId: '91',
        local: true,
        publicKeyring: f.publicKeyring,
      }),
    )
    const nextHandle = await f.runtime.prepare({
      uid: 912,
      containerDbId: '92',
      local: true,
      publicKeyring: f.publicKeyring,
    })
    assert.ok(nextHandle)
    await f.runtime.release('92')
    const restartedRuntime = createCc5FreshContainerRuntime({
      selfhost: true,
      env,
      configuration: () => f.options,
      financeFactory,
    })
    assert.ok(restartedRuntime)
  } finally {
    await f.cleanup()
  }
})

test('backend selection is read-only, pins one existing account/new chat and requires the committed active binding', async () => {
  const f = fixture()
  const query = { uid: 912, containerId: 91, sessionKey: f.options.scope.sessionKey,
    canonicalModel: f.options.scope.canonicalModel, engine: 'ccb' }
  try {
    assert.equal(f.runtime.selectBackend({ ...query, uid: 913 }), undefined)
    assert.equal(f.runtime.selectBackend({ ...query, sessionKey: 'agent:main:webchat:dm:ordinary_chat1' }), undefined)
    assert.throws(() => f.runtime.selectBackend(query))
    const handle = (await f.prepare())!
    assert.throws(() => f.runtime.selectBackend(query))
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    assert.throws(() => f.runtime.selectBackend(query))
    await f.runtime.activate(handle, 'a'.repeat(64))
    assert.deepEqual(f.runtime.selectBackend(query), { kind: 'cc5-interactive-v1',
      sessionKey: query.sessionKey, operationId: f.options.profile.operationId })
    assert.throws(() => f.runtime.selectBackend({ ...query, containerId: 92 }))
    assert.throws(() => f.runtime.selectBackend({ ...query, canonicalModel: 'other-model' }))
    assert.throws(() => f.runtime.selectBackend({ ...query, engine: 'cursor' }))
    assert.equal(f.starts, 0)
    await f.runtime.release('91', 'a'.repeat(64))
    assert.throws(() => f.runtime.selectBackend(query))
  } finally { await f.cleanup() }
})

test('production runtime cannot activate without an injected financial port', async () => {
  const f = fixture()
  try {
    const handle = (await f.prepare())!
    // Factory absence is rejected before even creating a new runtime directory.
    assert.throws(() => createCc5FreshContainerRuntime({ selfhost: true, env,
      configuration: () => ({ ...f.options, baseRoot: join(f.root, 'unused-runtime') }),
      financeFactory: undefined as unknown as Cc5FinanceFactory }))
    assert.equal(existsSync(join(f.root, 'unused-runtime')), false)
    assert.equal(f.starts, 0)
    assert.equal(existsSync(join(handle.mountSource, 'relay.sock')), false)
  } finally { await f.cleanup() }
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

test('strict umask still permits a real UID1000 process to read the protected binding and public ring', async () => {
  const f = fixture()
  try {
    const old = process.umask(0o077)
    let preparing: ReturnType<typeof f.prepare>
    try {
      preparing = f.prepare()
    } finally {
      process.umask(old)
    }
    const handle = (await preparing)!
    const previous = process.umask(0o077)
    let binding: Promise<void>
    try {
      binding = f.runtime.bindCreated(handle, 'a'.repeat(64))
    } finally {
      process.umask(previous)
    }
    await binding
    assert.equal(lstatSync(handle.mountSource).mode & 0o777, 0o750)
    const check =
      "const fs=require('node:fs');process.chdir(process.argv[1]);process.setgid(1000);process.setuid(1000);" +
      "if(JSON.parse(fs.readFileSync('binding.json')).uid!=='912'||!JSON.parse(fs.readFileSync('authority-public.json')).keyring)process.exit(2);process.stdout.write('READ_OK')"
    assert.equal(
      execFileSync(process.execPath, ['-e', check, handle.mountSource], { encoding: 'utf8' }),
      'READ_OK',
    )
  } finally {
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
      createCc5FreshContainerRuntime({ selfhost: true, env, configuration: () => f.options, financeFactory }),
    )
  } finally {
    await f.cleanup()
  }
})

test('24h sliding lease propagates to finance/disk and recovered attachable runtime completes multi-turn continuation (seq=2) without re-launching lifecycle (B3)', async () => {
  const realNow = Date.now
  const f = fixture(false, true)
  let req1: ReturnType<typeof request> | undefined
  let req2: ReturnType<typeof request> | undefined
  try {
    const before = realNow()
    const handle = (await f.prepare())!
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    const initialBinding = JSON.parse(
      readFileSync(join(handle.mountSource, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    assert.ok(initialBinding.expiresAt >= before + 24 * 60 * 60 * 1000 - 5000)
    await f.runtime.activate(handle, initialBinding.dockerId)

    // Advance clock by 12 hours and complete a full Turn 1 (admission -> open -> seq=1 -> init + result -> terminal-proven.json)
    Date.now = () => before + 12 * 60 * 60 * 1000
    const socket = join(handle.mountSource, 'relay.sock')
    const turn1Scope = envelopes(f.key, initialBinding, {
      authorityTurnId: 'a'.repeat(32),
      billingRequestId: 'fixture-only-request',
      turnKey: 'fixture-turn-key-1',
    })
    const admitted1 = await cc5ControlRequest('/admit', turn1Scope, socket)
    assert.equal(admitted1.ready, true)
    assert.equal(f.starts, 1)
    assert.equal(f.attaches, 0)
    const extendedBinding = JSON.parse(
      readFileSync(join(handle.mountSource, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    assert.ok(extendedBinding.expiresAt > initialBinding.expiresAt)

    req1 = request({ socketPath: socket, method: 'POST', path: '/session/open' })
    req1.on('error', () => {})
    req1.write(`${JSON.stringify({ ...extendedBinding, type: 'open', sessionKey: turn1Scope.sessionKey, generation: 1 })}\n`)
    const [res1] = await once(req1, 'response')
    res1.on('error', () => {})
    res1.resume()

    const turn1Bytes = Buffer.from(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'turn 1 user frame' } })}\n`,
    )
    const turn1Hash = createHash('sha256').update(turn1Bytes).digest('hex')
    req1.write(`${JSON.stringify({ seq: 1, bytes: turn1Bytes.toString('base64'), hash: turn1Hash })}\n`)

    const wait1 = realNow() + 2000
    while (f.written.length === 0) {
      assert.ok(realNow() < wait1)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const nativeSid = '11111111-1111-4111-8111-111111111111'
    f.output.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: nativeSid, model: 'claude-sonnet-5' })}\n` +
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: nativeSid,
          uuid: 'ocb-11111111-m00001-1',
          usage: {
            input_tokens: 12,
            output_tokens: 34,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        })}\n`,
    )

    const turn1ProvenPath = join(dirname(handle.mountSource), 'journal', 'a'.repeat(32), 'terminal-proven.json')
    const waitProven1 = realNow() + 2000
    while (!existsSync(turn1ProvenPath)) {
      assert.ok(realNow() < waitProven1)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    // Close the old process's relay socket listeners before simulating process restart at +25h
    req1.destroy()
    const origRecord = (f.runtime as any).records.get('91')
    for (const srv of [origRecord?.relay?.controlServer, origRecord?.relay?.toolServer]) {
      if (srv) {
        srv.closeAllConnections()
        await new Promise<void>((r) => srv.close(() => r()))
      }
    }

    Date.now = () => before + 25 * 60 * 60 * 1000

    let financeAdmittedExpiresAt = 0
    const checkingFinanceFactory: Cc5FinanceFactory = () => ({
      async admit(info) {
        assert.ok(info.binding.expiresAt > Date.now(), 'finance must receive extended binding expiry')
        financeAdmittedExpiresAt = info.binding.expiresAt
        return {
          async beforeHostStart() {},
          async beforeDispatch() {},
          async stop() {},
          async terminal() {
            return { state: 'proven', requestId: 'fixture-request-turn-2' }
          },
        }
      },
    })

    const restarted = createCc5FreshContainerRuntime({
      selfhost: true,
      env,
      configuration: () => f.options,
      financeFactory: checkingFinanceFactory,
    })!
    // Recovery attached to existing lifecycle without calling start() a second time
    assert.equal(f.starts, 1)
    assert.equal(f.attaches, 1)
    assert.deepEqual(
      restarted.selectBackend({
        uid: 912,
        containerId: 91,
        sessionKey: f.options.scope.sessionKey,
        canonicalModel: f.options.scope.canonicalModel,
        engine: 'ccb',
      }),
      {
        kind: 'cc5-interactive-v1',
        sessionKey: f.options.scope.sessionKey,
        operationId: f.options.profile.operationId,
      },
    )

    // Complete a real Turn 2 (seq=2) on the recovered runtime using the same operationId and nativeSessionId
    const turn2Scope = envelopes(f.key, extendedBinding, {
      authorityTurnId: 'b'.repeat(32),
      billingRequestId: 'fixture-request-turn-2',
      turnKey: 'fixture-turn-key-2',
    })
    const admittedAfterRestart = await cc5ControlRequest('/admit', turn2Scope, socket)
    assert.equal(admittedAfterRestart.ready, true)
    assert.equal(f.starts, 1)
    assert.ok(financeAdmittedExpiresAt >= extendedBinding.expiresAt)

    req2 = request({ socketPath: socket, method: 'POST', path: '/session/open' })
    req2.on('error', () => {})
    req2.write(
      `${JSON.stringify({
        ...extendedBinding,
        type: 'open',
        sessionKey: turn2Scope.sessionKey,
        generation: 1,
      })}\n`,
    )
    const [res2] = await once(req2, 'response')
    res2.on('error', () => {})
    res2.resume()

    const turn2Bytes = Buffer.from(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'turn 2 user frame after recovery' } })}\n`,
    )
    const turn2Hash = createHash('sha256').update(turn2Bytes).digest('hex')
    const writtenBeforeTurn2 = f.written.length
    req2.write(`${JSON.stringify({ seq: 2, bytes: turn2Bytes.toString('base64'), hash: turn2Hash })}\n`)

    const wait2 = realNow() + 2000
    while (f.written.length <= writtenBeforeTurn2) {
      assert.ok(realNow() < wait2)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    f.output.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: nativeSid,
        uuid: 'ocb-11111111-m00002-2',
        usage: {
          input_tokens: 18,
          output_tokens: 42,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 0,
        },
      })}\n`,
    )

    const turn2ProvenPath = join(dirname(handle.mountSource), 'journal', 'b'.repeat(32), 'terminal-proven.json')
    const waitProven2 = realNow() + 2000
    while (!existsSync(turn2ProvenPath)) {
      assert.ok(realNow() < waitProven2)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    // Release on recovered runtime proves remote stop via host.stop()
    const stopsBefore = f.stops
    await restarted.release('91', extendedBinding.dockerId)
    assert.equal(f.stops, stopsBefore + 1)
    assert.equal(existsSync(join(dirname(handle.mountSource), 'released.json')), true)
  } finally {
    req1?.destroy()
    req2?.destroy()
    Date.now = realNow
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('recovering a launched lifecycle with a one-shot host lacking attach() fails closed and fences UNKNOWN.json (B3)', async () => {
  const f = fixture(false, false)
  try {
    const handle = (await f.prepare())!
    await f.runtime.bindCreated(handle, 'a'.repeat(64))
    const b = JSON.parse(readFileSync(join(handle.mountSource, 'binding.json'), 'utf8')) as Cc5BridgeBinding
    await f.runtime.activate(handle, b.dockerId)
    const socket = join(handle.mountSource, 'relay.sock')
    await cc5ControlRequest(
      '/tool/register',
      {
        ...b,
        sessionKey: f.options.scope.sessionKey,
        lifecycleId: randomUUID(),
      },
      socket,
    )
    await cc5ControlRequest('/admit', envelopes(f.key, b), socket)
    assert.equal(f.starts, 1)

    const origRecord = (f.runtime as any).records.get('91')
    for (const srv of [origRecord?.relay?.controlServer, origRecord?.relay?.toolServer]) {
      if (srv) {
        srv.closeAllConnections()
        await new Promise<void>((r) => srv.close(() => r()))
      }
    }

    // Remove the incomplete turn dir so only local-registered.json remains, proving even with clean turn dirs,
    // a used lifecycle cannot be marked active if the host port cannot attach() to the existing remote process.
    rmSync(join(dirname(handle.mountSource), 'journal', 'a'.repeat(32)), {
      recursive: true,
      force: true,
    })

    assert.throws(() =>
      createCc5FreshContainerRuntime({
        selfhost: true,
        env,
        configuration: () => f.options,
        financeFactory,
      }),
    )
    const unknownPath = join(dirname(handle.mountSource), 'UNKNOWN.json')
    assert.equal(existsSync(unknownPath), true)
    const unknown = JSON.parse(readFileSync(unknownPath, 'utf8')) as { reason: string }
    assert.equal(unknown.reason, 'recovery-unproved')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
