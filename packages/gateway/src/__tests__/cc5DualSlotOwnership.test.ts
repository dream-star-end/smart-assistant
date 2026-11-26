/**
 * Dual-slot concurrent ownership isolation, dynamic container adoption, cross-process handle
 * compatibility, fail-closed session handover, and slot-scoped lane draining (OCV5-855 slice 1).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
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
import {
  type Cc5BridgeBinding,
  type Cc5PreparedContainer,
  type LaneOwnerMetadata,
  type PeerSessionHandoverInput,
  type PeerSessionHandoverResult,
  REMOTE_LANE_PEER_RELEASE_UNPROVEN,
  type RemoteLaneHooks,
  type RemoteLanePlacement,
  type RemoteLaneRuntimePort,
  __createNonRootRemoteLaneRuntimeForTests,
  cc5ControlRequest,
  createRemoteLaneRuntime,
  isLivePeerOwnedLane,
  isProcessAliveWithStartTicks,
  isUnixSocketListening,
  readLaneOwnerFile,
  readProcessStartTicks,
  writeLaneOwnerFile,
} from '../cc5ContainerRuntime.js'
import type { RemoteFinanceFactory } from '../remoteFinance.js'

const MODEL = 'claude-opus-5-5-remote'
const DOCKER_1 = 'a'.repeat(64)
const DOCKER_2 = 'b'.repeat(64)
const DOCKER_3 = 'c'.repeat(64)
const SESSION_A = 'agent:main:webchat:dm:dual_slot_a'
const SESSION_B = 'agent:main:webchat:dm:dual_slot_b'
const ENV = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }

const financeFactory: RemoteFinanceFactory = () => ({
  async admit() {
    return {
      async beforeHostStart() {},
      async beforeDispatch() {},
      async stop() {},
      async terminal() {
        return { state: 'proven', requestId: 'dual-slot-fixture-req' }
      },
    }
  },
})

function makeKeyring() {
  const key = generateKeyPairSync('ed25519')
  const publicKeyring = `fixture-key:${(key.publicKey.export({ format: 'jwk' }) as { x: string }).x}`
  return { key, publicKeyring }
}

function makeAdmission(key: ReturnType<typeof generateKeyPairSync>, b: Cc5BridgeBinding) {
  const containerId = Number(b.containerDbId)
  const now = Date.now()
  const a: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: 'fixture-key',
    uid: 912,
    containerId,
    authorityTurnId: 'a'.repeat(32),
    billingRequestId: 'dual-slot-fixture-req',
    connectionChallenge: 'dual-slot-conn',
    canonicalModel: b.canonicalModel,
    engine: 'ccb',
    executionBackend: {
      kind: 'cc5-interactive-v1',
      sessionKey: b.sessionKey,
      operationId: b.operationId,
    },
    securityEpoch: 1,
    executionRevision: 'fixture-r1',
    issuedAt: now,
    expiresAt: now + 60_000,
    executionDescriptor: {
      capabilityProfile: {},
      capabilitySchemaVersion: 1,
      contextWindow: 200_000,
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
    expiresAt: now + 120_000,
  }
  return {
    ...b,
    turnKey: 'dual-slot-turn',
    authority: encodeAuthorityEnvelope(a, sign(null, authoritySigningInput(a), key.privateKey)),
    lease: encodeTurnLeaseEnvelope(lease, sign(null, turnLeaseSigningInput(lease), key.privateKey)),
  }
}

interface SlotFixture {
  readonly runtime: RemoteLaneRuntimePort
  readonly places: Array<Record<string, unknown>>
  readonly states: Array<[string, string]>
  readonly events: string[]
  readonly hosts: Array<{ operationId: string; stdout: PassThrough; written: Buffer[] }>
  readonly drainRelays: Map<string, { readonly idle: boolean }>
  readonly lane: (
    sessionKey?: string,
    containerDbId?: string,
  ) => ReturnType<RemoteLaneRuntimePort['ensureLane']>
  readonly container: (
    containerDbId: string,
    dockerId: string,
    publicKeyring: string,
  ) => Promise<Cc5PreparedContainer>
}

function createSlotFixture(options: {
  baseRoot: string
  ownerSlot?: string
  ownerInstanceId?: string
  failStop?: boolean | (() => boolean)
  admitReservationMs?: number
  isProcessAlive?: (pid: number, expectedStartTicks: string | null) => boolean
  isSocketListening?: (sockPath: string) => boolean
  peerSessionHandover?: (input: PeerSessionHandoverInput) => Promise<PeerSessionHandoverResult>
  fixedOperationIds?: Map<string, string>
  placeImpl?: RemoteLaneHooks['place']
  onState?: RemoteLaneHooks['onState']
}): SlotFixture {
  const places: Array<Record<string, unknown>> = []
  const states: Array<[string, string]> = []
  const events: string[] = []
  const hosts: Array<{ operationId: string; stdout: PassThrough; written: Buffer[] }> = []
  const drainRelays = new Map<string, { readonly idle: boolean }>()
  const placements = new Map<string, RemoteLanePlacement>()

  const hooks: RemoteLaneHooks = {
    async place(req) {
      places.push({ ...req })
      if (options.placeImpl) {
        return await options.placeImpl(req)
      }
      let placement = placements.get(req.sessionKey)
      if (!placement) {
        const operationId = options.fixedOperationIds?.get(req.sessionKey) ?? randomUUID()
        placement = {
          target: {
            host: 'node.example',
            port: 22,
            user: 'box',
            keyPath: '/unused',
            knownHostsPath: '/unused',
            controllerSha256: '0'.repeat(64),
            taskRootPrefix: '/home/box/oc-agentremote-',
            upstreamModel: req.canonicalModel.replace(/-remote$/, ''),
          },
          taskRoot: `/home/box/oc-agentremote-c${operationId.replace(/-/g, '').slice(0, 23)}`,
          operationId,
          runId: randomUUID(),
          provisionPacket: Buffer.from('{"fixture":true}'),
          profileId: 'profile-1',
        }
        placements.set(req.sessionKey, placement)
      }
      return placement
    },
    async onState(operationId, state) {
      states.push([operationId, state])
      if (options.onState) {
        await options.onState(operationId, state)
      }
    },
    registerDrainRelay(id, relay) {
      drainRelays.set(id, relay)
      return () => {
        if (drainRelays.get(id) === relay) drainRelays.delete(id)
      }
    },
  }

  const factory =
    process.getuid?.() === 0 ? createRemoteLaneRuntime : __createNonRootRemoteLaneRuntimeForTests

  const runtime = factory({
    selfhost: true,
    env: ENV,
    financeFactory,
    hooks,
    configuration: () => ({
      baseRoot: options.baseRoot,
      controllerPath: '/unused/controller',
      ownerSlot: options.ownerSlot,
      ownerInstanceId: options.ownerInstanceId,
      admitReservationMs: options.admitReservationMs,
      isProcessAlive: options.isProcessAlive,
      isSocketListening: options.isSocketListening,
      peerSessionHandover: options.peerSessionHandover,
      hostFactory: (config) => ({
        async prepareTask() {
          events.push(`prepare:${config.operationId}`)
        },
        start() {
          events.push(`start:${config.operationId}`)
          const stdin = new PassThrough()
          const stdout = new PassThrough()
          const written: Buffer[] = []
          stdin.on('data', (chunk: Buffer) => written.push(chunk))
          hosts.push({ operationId: config.operationId, stdout, written })
          return { stdin, stdout, ready: Promise.resolve() }
        },
        async stop() {
          events.push(`stop:${config.operationId}`)
          const fail = typeof options.failStop === 'function' ? options.failStop() : options.failStop
          if (fail) throw new Error('fixture stop failed')
          return { remoteStopped: true as const }
        },
      }),
    }),
  })!

  return {
    runtime,
    places,
    states,
    events,
    hosts,
    drainRelays,
    async container(containerDbId: string, dockerId: string, publicKeyring: string) {
      const handle = (await runtime.prepare({
        uid: 912,
        containerDbId,
        local: true,
        publicKeyring,
      }))!
      await runtime.bindCreated(handle, dockerId)
      await runtime.activate(handle, dockerId)
      return handle
    },
    async lane(sessionKey = SESSION_A, containerDbId = '91') {
      return runtime.ensureLane({
        uid: 912,
        containerDbId,
        sessionKey,
        canonicalModel: MODEL,
      })
    },
  }
}

test('cc5LaneOwnership: /proc start ticks, PID wrap-around guard, atomic 0o600 owner.json, and live peer detection', async () => {
  const dir = mkdtempSync('/tmp/oc-s1-own-')
  try {
    const myTicks = readProcessStartTicks(process.pid)
    if (process.platform === 'linux') {
      assert.ok(
        myTicks && /^\d+$/.test(myTicks),
        'current process has numeric /proc starttime ticks',
      )
      assert.equal(isProcessAliveWithStartTicks(process.pid, myTicks), true)
      // PID wrap-around: PID exists, but expected start ticks differ -> must return false.
      assert.equal(isProcessAliveWithStartTicks(process.pid, `${myTicks}999`), false)
    }
    assert.equal(isProcessAliveWithStartTicks(process.pid, null), true)
    assert.equal(isProcessAliveWithStartTicks(0, null), false)
    assert.equal(isProcessAliveWithStartTicks(-5, null), false)
    assert.equal(readProcessStartTicks(0), null)
    assert.equal(readProcessStartTicks(-1), null)

    // Spawn a short-lived child and confirm dead PID returns false.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = child.pid!
    await once(child, 'exit')
    assert.equal(isProcessAliveWithStartTicks(deadPid, null), false)

    // Atomic 0o600 write + strict read.
    const meta: LaneOwnerMetadata = {
      version: 1,
      slot: 'blue',
      instanceId: 'blue-inst-1',
      pid: process.pid,
      pidStartTicks: myTicks,
      sessionKey: SESSION_A,
      operationId: randomUUID(),
      generation: '1',
      createdAt: Date.now(),
    }
    writeLaneOwnerFile(dir, meta)
    const ownerPath = join(dir, 'owner.json')
    const st = lstatSync(ownerPath)
    assert.equal(st.mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), ['owner.json'])
    assert.deepEqual(readLaneOwnerFile(dir), meta)

    // Self vs peer vs dead vs PID-recycled detection.
    assert.deepEqual(isLivePeerOwnedLane(dir, 'blue', 'blue-inst-1'), {
      livePeer: false,
      owner: meta,
    })
    assert.deepEqual(isLivePeerOwnedLane(dir, 'green', 'green-inst-1'), {
      livePeer: true,
      owner: meta,
    })
    assert.deepEqual(isLivePeerOwnedLane(dir, 'blue', 'blue-inst-2'), {
      livePeer: true,
      owner: meta,
    })
    assert.deepEqual(
      isLivePeerOwnedLane(dir, 'green', 'green-inst-1', () => false),
      { livePeer: false, owner: meta },
    )

    // PID wrap-around written to owner.json -> dead peer (never blocks cleanup).
    if (process.platform === 'linux' && myTicks) {
      const wrappedDir = join(dir, 'wrapped')
      mkdirSync(wrappedDir, { mode: 0o700 })
      const wrappedMeta: LaneOwnerMetadata = { ...meta, pidStartTicks: `${myTicks}123` }
      writeLaneOwnerFile(wrappedDir, wrappedMeta)
      assert.deepEqual(isLivePeerOwnedLane(wrappedDir, 'green', 'green-inst-1'), {
        livePeer: false,
        owner: wrappedMeta,
      })
    }

    // Corrupt JSON and symlinked owner.json must be rejected safely.
    const badDir = join(dir, 'bad')
    mkdirSync(badDir, { mode: 0o700 })
    writeFileSync(join(badDir, 'owner.json'), '{"version":2}')
    assert.equal(readLaneOwnerFile(badDir), null)
    assert.deepEqual(isLivePeerOwnedLane(badDir, 'green', 'green-inst-1'), {
      livePeer: false,
      owner: null,
    })

    const symDir = join(dir, 'sym')
    mkdirSync(symDir, { mode: 0o700 })
    symlinkSync(ownerPath, join(symDir, 'owner.json'))
    assert.equal(readLaneOwnerFile(symDir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'production createRemoteLaneRuntime keeps strict root-only enforcement when non-root',
  { skip: process.getuid?.() === 0 },
  () => {
    const dir = mkdtempSync('/tmp/oc-s1-noroot-')
    try {
      assert.throws(
        () =>
          createRemoteLaneRuntime({
            selfhost: true,
            env: ENV,
            financeFactory,
            hooks: {
              place: async () => {
                throw new Error('unused')
              },
            },
            configuration: () => ({
              baseRoot: join(dir, 'r'),
              controllerPath: '/unused/controller',
              ownerSlot: 'blue',
            }),
          }),
        /CC5_FRESH_CONTAINER_BINDING_REJECTED/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('dual-slot adopt preserves live peer lanes in view/ and lanes/ while cleaning dead orphans; legacy mode wipes all', async () => {
  const tmp = mkdtempSync('/tmp/s1a-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  try {
    const blue = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-1',
    })
    const handle = await blue.container('91', DOCKER_1, publicKeyring)
    const blueLane = await blue.lane(SESSION_A, '91')
    assert.equal(blueLane.kind, 'cc5-interactive-v1')

    const containerRoot = join(handle.mountSource, '..')
    const blueViewDir = join(handle.mountSource, blueLane.operationId)
    const blueLaneDir = join(containerRoot, 'lanes', blueLane.operationId)

    // Verify 0o600 owner.json written to both view and lanes dir.
    for (const d of [blueViewDir, blueLaneDir]) {
      const owner = readLaneOwnerFile(d)
      assert.ok(owner, `owner.json exists in ${d}`)
      assert.equal(owner.slot, 'blue')
      assert.equal(owner.instanceId, 'blue-1')
      assert.equal(owner.pid, process.pid)
      assert.equal(owner.sessionKey, SESSION_A)
      assert.equal(owner.operationId, blueLane.operationId)
      assert.equal(lstatSync(join(d, 'owner.json')).mode & 0o777, 0o600)
    }

    // Plant dead-peer orphan (recycled/wrong ticks) and legacy no-owner orphan in both view/ and lanes/.
    const deadPeerOp = randomUUID()
    const legacyOrphanOp = randomUUID()
    for (const parent of [handle.mountSource, join(containerRoot, 'lanes')]) {
      mkdirSync(join(parent, deadPeerOp), { recursive: true, mode: 0o700 })
      writeLaneOwnerFile(join(parent, deadPeerOp), {
        version: 1,
        slot: 'blue',
        instanceId: 'blue-old',
        pid: process.pid,
        pidStartTicks: '999999999999', // PID wrap-around mismatch
        sessionKey: 'agent:main:webchat:dm:dead',
        operationId: deadPeerOp,
        generation: '1',
        createdAt: Date.now() - 60_000,
      })
      mkdirSync(join(parent, legacyOrphanOp), { recursive: true, mode: 0o700 })
      writeFileSync(join(parent, legacyOrphanOp, 'stale.txt'), 'orphan')
    }

    // Green boots up sharing baseRoot: live blue lane survives, dead orphans are swept.
    const green = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-1',
    })

    assert.equal(existsSync(blueViewDir), true, 'live peer view lane preserved')
    assert.equal(existsSync(blueLaneDir), true, 'live peer lanes/ dir preserved')
    assert.equal(
      existsSync(join(handle.mountSource, deadPeerOp)),
      false,
      'dead peer view orphan cleaned',
    )
    assert.equal(
      existsSync(join(containerRoot, 'lanes', deadPeerOp)),
      false,
      'dead peer lanes orphan cleaned',
    )
    assert.equal(
      existsSync(join(handle.mountSource, legacyOrphanOp)),
      false,
      'legacy view orphan cleaned',
    )
    assert.equal(
      existsSync(join(containerRoot, 'lanes', legacyOrphanOp)),
      false,
      'legacy lanes orphan cleaned',
    )

    // Green can simultaneously serve another chat on the same shared container without disturbing blue.
    const greenLane = await green.lane(SESSION_B, '91')
    assert.equal(existsSync(blueViewDir), true)
    assert.equal(existsSync(join(handle.mountSource, greenLane.operationId)), true)
    assert.equal(readLaneOwnerFile(join(handle.mountSource, greenLane.operationId))?.slot, 'green')

    await blue.runtime.drainOwnIdleAndOwnedLanes?.({ force: true })
    await green.runtime.drainOwnIdleAndOwnedLanes?.({ force: true })

    // Legacy single-process mode (no ownerSlot): wipes non-authority view entries and lanes/ dir.
    const legacyOp = randomUUID()
    mkdirSync(join(handle.mountSource, legacyOp), { recursive: true, mode: 0o700 })
    writeLaneOwnerFile(join(handle.mountSource, legacyOp), {
      version: 1,
      slot: 'blue',
      instanceId: 'blue-1',
      pid: process.pid,
      pidStartTicks: readProcessStartTicks(process.pid),
      sessionKey: SESSION_A,
      operationId: legacyOp,
      generation: '1',
      createdAt: Date.now(),
    })
    mkdirSync(join(containerRoot, 'lanes', legacyOp), { recursive: true, mode: 0o700 })
    const legacyRuntime = createSlotFixture({ baseRoot })
    assert.deepEqual(readdirSync(handle.mountSource), ['authority-public.json'])
    assert.equal(existsSync(join(containerRoot, 'lanes')), false)
    await legacyRuntime.runtime.release('91')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('cross-process handle value objects, bound.json persistence, and on-demand refreshAdoptedContainers()', async () => {
  const tmp = mkdtempSync('/tmp/s1x-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  try {
    const blue = createSlotFixture({ baseRoot, ownerSlot: 'blue', ownerInstanceId: 'blue-1' })
    const green = createSlotFixture({ baseRoot, ownerSlot: 'green', ownerInstanceId: 'green-1' })

    // 1. Blue prepares container 92; Green receives an RPC-deserialized value object handle and calls bindCreated.
    const handle92 = (await blue.runtime.prepare({
      uid: 912,
      containerDbId: '92',
      local: true,
      publicKeyring,
    }))!
    const rpcHandle92: Cc5PreparedContainer = JSON.parse(JSON.stringify(handle92))

    // Tampered mountSource must still be rejected.
    await assert.rejects(
      green.runtime.bindCreated({ containerDbId: '92', mountSource: '/tmp/evil' }, DOCKER_2),
      /CC5_FRESH_CONTAINER_BINDING_REJECTED/,
    )

    await green.runtime.bindCreated(rpcHandle92, DOCKER_2)
    const boundPath = join(handle92.mountSource, '..', 'bound.json')
    assert.equal(existsSync(boundPath), true, 'bound.json persisted by bindCreated')
    assert.equal(lstatSync(boundPath).mode & 0o777, 0o600)

    // 2. Blue (whose memory only saw state='prepared') activates using original handle -> picks up bound.json.
    await blue.runtime.activate(handle92, DOCKER_2)

    // 3. Green (whose memory only saw state='bound') immediately serves ensureLane -> picks up activated.json.
    const lane92 = await green.lane(SESSION_A, '92')
    assert.equal(lane92.kind, 'cc5-interactive-v1')
    assert.equal(lane92.sessionKey, SESSION_A)

    // 4. Container 93 prepared/bound/activated entirely on Blue AFTER Green already booted ->
    //    Green dynamically adopts via ensureLane refresh without restart.
    await blue.container('93', DOCKER_3, publicKeyring)
    const lane93 = await green.lane(SESSION_B, '93')
    assert.equal(lane93.kind, 'cc5-interactive-v1')
    assert.equal(lane93.sessionKey, SESSION_B)

    await green.runtime.drainOwnIdleAndOwnedLanes?.({ force: true })
    await blue.runtime.release('92')
    await blue.runtime.release('93')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('same-sessionKey cross-slot handover: busy/unavailable/no-callback fail closed; idle hands over cleanly', async () => {
  const tmp = mkdtempSync('/tmp/s1h-')
  const baseRoot = join(tmp, 'r')
  const { key, publicKeyring } = makeKeyring()
  let openReq: ReturnType<typeof request> | undefined
  let shouldFailStop = true
  const runtimesToCleanup: RemoteLaneRuntimePort[] = []
  try {
    const blue = createSlotFixture({ baseRoot, ownerSlot: 'blue', ownerInstanceId: 'blue-1' })
    runtimesToCleanup.push(blue.runtime)
    const handle = await blue.container('91', DOCKER_1, publicKeyring)
    const blueLane = await blue.lane(SESSION_A, '91')
    const blueView = join(handle.mountSource, blueLane.operationId)

    // 1. Without peerSessionHandover callback: fail-closed when peer is alive.
    const greenNoHook = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-no-hook',
    })
    await assert.rejects(greenNoHook.lane(SESSION_A, '91'), /REMOTE_POOL_DRAINING_RETRY_LATER/)
    assert.equal(greenNoHook.places.length, 0, 'never places duplicate lane')
    assert.equal(existsSync(blueView), true, 'blue lane untouched')

    // 2. Make blue's lane BUSY by admitting and opening an active session turn on its real relay socket.
    const binding = JSON.parse(
      readFileSync(join(blueView, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    const sock = join(blueView, 'relay.sock')
    const admitted = await cc5ControlRequest('/admit', makeAdmission(key, binding), sock)
    assert.equal(admitted.ready, true)
    openReq = request({ socketPath: sock, method: 'POST', path: '/session/open' })
    openReq.on('error', () => {})
    openReq.write(`${JSON.stringify({ ...binding, type: 'open', sessionKey: SESSION_A })}\n`)
    const [openRes] = await once(openReq, 'response')
    openRes.on('error', () => {})
    openRes.resume()
    const userBytes = Buffer.from(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'busy turn' } })}\n`,
    )
    openReq.write(
      `${JSON.stringify({ seq: 1, bytes: userBytes.toString('base64'), hash: createHash('sha256').update(userBytes).digest('hex') })}\n`,
    )
    const deadline = Date.now() + 2000
    while ((blue.hosts[0]?.written.length ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok((blue.hosts[0]?.written.length ?? 0) > 0, 'user frame reached host')

    // Confirm releaseSessionIfIdle reports 'busy' directly and 'not_found' on mismatch/unknown.
    assert.deepEqual(await blue.runtime.releaseSessionIfIdle?.('unknown-session'), {
      status: 'not_found',
    })
    assert.deepEqual(
      await blue.runtime.releaseSessionIfIdle?.(SESSION_A, { operationId: randomUUID() }),
      { status: 'not_found' },
    )
    assert.deepEqual(
      await blue.runtime.releaseSessionIfIdle?.(SESSION_A, { operationId: blueLane.operationId }),
      { status: 'busy' },
    )

    // Wire Green's peerSessionHandover directly to Blue's releaseSessionIfIdle.
    const handoverCalls: PeerSessionHandoverInput[] = []
    const handoverStatuses: string[] = []
    const green = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-1',
      peerSessionHandover: async (input) => {
        handoverCalls.push(input)
        const res = await blue.runtime.releaseSessionIfIdle!(input.sessionKey, {
          operationId: input.operationId,
        })
        handoverStatuses.push(res.status)
        if (res.status === 'released') return 'released'
        if (res.status === 'busy') return 'busy'
        return 'unavailable'
      },
    })
    runtimesToCleanup.push(green.runtime)

    // While Blue is busy, Green MUST fail-closed with REMOTE_POOL_DRAINING_RETRY_LATER and never double-open.
    await assert.rejects(green.lane(SESSION_A, '91'), /REMOTE_POOL_DRAINING_RETRY_LATER/)
    assert.equal(handoverCalls.length, 1)
    assert.deepEqual(handoverStatuses, ['busy'])
    assert.deepEqual(handoverCalls[0], {
      sessionKey: SESSION_A,
      operationId: blueLane.operationId,
      ownerSlot: 'blue',
      ownerPid: process.pid,
    })
    assert.equal(green.places.length, 0)
    assert.equal(existsSync(blueView), true)

    // 3. 'unavailable' while peer process is alive MUST also fail-closed.
    const greenUnavailable = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-unavail',
      isProcessAlive: () => true,
      peerSessionHandover: async () => 'unavailable',
    })
    await assert.rejects(greenUnavailable.lane(SESSION_A, '91'), /REMOTE_POOL_DRAINING_RETRY_LATER/)
    assert.equal(greenUnavailable.places.length, 0)

    // 4. Complete Blue's active turn with a real terminal result frame so Blue's relay settles back to idle,
    //    then confirm Green takes over smoothly without double-opening!
    const host = blue.hosts[0]!
    const nativeSessionId = randomUUID()
    host.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: nativeSessionId })}\n`,
    )
    host.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: nativeSessionId,
        uuid: `ocb-${nativeSessionId.slice(0, 8)}-${Date.now().toString(36)}-1`,
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })}\n`,
    )
    let handed: Awaited<ReturnType<RemoteLaneRuntimePort['ensureLane']>> | undefined
    for (let i = 0; i < 40; i++) {
      try {
        handed = await green.lane(SESSION_A, '91')
        break
      } catch (error) {
        if (i === 39) throw error
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    assert.ok(handed)
    assert.equal(
      handoverStatuses.at(-1),
      'released',
      'blue lane settled to idle and returned released',
    )
    assert.equal(handed.kind, 'cc5-interactive-v1')
    assert.equal(handed.sessionKey, SESSION_A)
    assert.equal(existsSync(blueView), false, 'blue old lane view removed on handover')
    const greenView = join(handle.mountSource, handed.operationId)
    assert.equal(readLaneOwnerFile(greenView)?.slot, 'green')
    assert.equal(readLaneOwnerFile(greenView)?.instanceId, 'green-1')
    openReq.destroy()
    openReq = undefined

    // 5. Verify stop failure returns status: 'unknown' from releaseSessionIfIdle (after a launched turn settles to idle).
    shouldFailStop = true
    const failing = createSlotFixture({
      baseRoot,
      ownerSlot: 'amber',
      ownerInstanceId: 'amber-1',
      failStop: () => shouldFailStop,
    })
    runtimesToCleanup.push(failing.runtime)
    const failingLane = await failing.lane(SESSION_B, '91')
    const failingView = join(handle.mountSource, failingLane.operationId)
    const failingBinding = JSON.parse(
      readFileSync(join(failingView, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    const failingSock = join(failingView, 'relay.sock')
    await cc5ControlRequest('/admit', makeAdmission(key, failingBinding), failingSock)
    const failOpen = request({ socketPath: failingSock, method: 'POST', path: '/session/open' })
    failOpen.on('error', () => {})
    failOpen.write(
      `${JSON.stringify({ ...failingBinding, type: 'open', sessionKey: SESSION_B })}\n`,
    )
    const [failOpenRes] = await once(failOpen, 'response')
    failOpenRes.on('error', () => {})
    failOpenRes.resume()
    failOpen.write(
      `${JSON.stringify({ seq: 1, bytes: userBytes.toString('base64'), hash: createHash('sha256').update(userBytes).digest('hex') })}\n`,
    )
    const failDeadline = Date.now() + 2000
    while ((failing.hosts[0]?.written.length ?? 0) === 0 && Date.now() < failDeadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const failNativeSessionId = randomUUID()
    failing.hosts[0]!.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: failNativeSessionId })}\n`,
    )
    failing.hosts[0]!.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: failNativeSessionId,
        uuid: `ocb-${failNativeSessionId.slice(0, 8)}-${Date.now().toString(36)}-1`,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })}\n`,
    )
    let failStopRes: { status: string } | undefined
    for (let i = 0; i < 40; i++) {
      failStopRes = await failing.runtime.releaseSessionIfIdle?.(SESSION_B)
      if (failStopRes?.status !== 'busy') break
      await new Promise((r) => setTimeout(r, 25))
    }
    failOpen.destroy()
    assert.deepEqual(failStopRes, { status: 'unknown' })

    // 6. Verify 'unavailable' when peer process died in the meantime recovers cleanly.
    const deadViewOp = randomUUID()
    const deadSession = 'agent:main:webchat:dm:dead_during_handover'
    let deadPeerChecks = 0
    let unavailableCalled = 0
    const greenDeadRecovery = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-recover',
      isProcessAlive: (pid) => {
        if (pid !== 999_999) return true
        deadPeerChecks += 1
        // Alive on initial scan, dead on re-check after unavailable handover.
        return deadPeerChecks === 1
      },
      peerSessionHandover: async () => {
        unavailableCalled += 1
        return 'unavailable'
      },
    })
    runtimesToCleanup.push(greenDeadRecovery.runtime)
    mkdirSync(join(handle.mountSource, deadViewOp), { recursive: true, mode: 0o700 })
    writeLaneOwnerFile(join(handle.mountSource, deadViewOp), {
      version: 1,
      slot: 'blue',
      instanceId: 'blue-crashed',
      pid: 999_999,
      pidStartTicks: '42',
      sessionKey: deadSession,
      operationId: deadViewOp,
      generation: '1',
      createdAt: Date.now(),
    })
    const recovered = await greenDeadRecovery.lane(deadSession, '91')
    assert.equal(unavailableCalled, 1)
    assert.equal(recovered.sessionKey, deadSession)
    assert.equal(existsSync(join(handle.mountSource, deadViewOp)), false)
  } finally {
    openReq?.destroy()
    shouldFailStop = false
    for (const rt of runtimesToCleanup) {
      await rt.release('91').catch(() => {})
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('drainOwnIdleAndOwnedLanes stops only this slot idle lanes without deleting shared view/, released.json, or peer lanes', async () => {
  const tmp = mkdtempSync('/tmp/s1d-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  try {
    const blue = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-1',
      admitReservationMs: 0,
    })
    const handle = await blue.container('91', DOCKER_1, publicKeyring)
    const blueLane = await blue.lane(SESSION_A, '91')

    const green = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-1',
      admitReservationMs: 0,
    })
    const greenLane = await green.lane(SESSION_B, '91')

    const containerRoot = join(handle.mountSource, '..')
    const blueView = join(handle.mountSource, blueLane.operationId)
    const greenView = join(handle.mountSource, greenLane.operationId)

    assert.equal(existsSync(blueView), true)
    assert.equal(existsSync(greenView), true)

    // Blue drains its own lanes cleanly.
    await blue.runtime.drainOwnIdleAndOwnedLanes?.()

    assert.equal(existsSync(blueView), false, 'blue lane view removed')
    assert.equal(
      existsSync(join(containerRoot, 'lanes', blueLane.operationId, 'owner.json')),
      false,
      'blue lane owner.json removed',
    )
    assert.equal(existsSync(handle.mountSource), true, 'shared container view/ preserved')
    assert.equal(
      existsSync(join(handle.mountSource, 'authority-public.json')),
      true,
      'authority-public.json preserved',
    )
    assert.equal(
      existsSync(join(containerRoot, 'released.json')),
      false,
      'released.json NOT written',
    )
    assert.equal(existsSync(greenView), true, 'green peer lane view untouched')
    assert.equal(
      existsSync(join(containerRoot, 'lanes', greenLane.operationId, 'owner.json')),
      true,
      'green peer lane owner.json untouched',
    )
    assert.deepEqual(
      blue.states.filter(([op, st]) => op === blueLane.operationId && st === 'released'),
      [[blueLane.operationId, 'released']],
    )

    // Green still serves its live lane without re-placing.
    const greenReuse = await green.lane(SESSION_B, '91')
    assert.equal(greenReuse.operationId, greenLane.operationId)
    assert.equal(green.places.length, 1)

    await green.runtime.drainOwnIdleAndOwnedLanes?.()
    assert.equal(existsSync(greenView), false)
    assert.equal(existsSync(join(containerRoot, 'released.json')), false)
    await green.runtime.release('91')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('B2: adopt preserves legacy live Unix socket dirs without owner.json, sweeps dead/stale sockets, and publishes views atomically', async () => {
  const tmp = mkdtempSync('/tmp/s1b2-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  const servers: Array<ReturnType<typeof createServer>> = []
  try {
    const blue = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-1',
      admitReservationMs: 0,
    })
    const handle = await blue.container('91', DOCKER_1, publicKeyring)
    const containerRoot = join(handle.mountSource, '..')

    // Verify atomic publication leaves zero .staging-* remnants.
    const blueLane = await blue.lane(SESSION_A, '91')
    assert.equal(
      readdirSync(handle.mountSource).some((n) => n.startsWith('.staging-')),
      false,
    )
    assert.equal(
      readdirSync(join(containerRoot, 'lanes')).some((n) => n.startsWith('.staging-')),
      false,
    )
    await blue.runtime.drainOwnIdleAndOwnedLanes?.()

    // 1. Legacy live Master lane directory WITHOUT owner.json, with a REAL listening relay.sock + tool.sock.
    const legacyLiveOp = randomUUID()
    const legacyLiveView = join(handle.mountSource, legacyLiveOp)
    const legacyLiveLaneDir = join(containerRoot, 'lanes', legacyLiveOp)
    mkdirSync(legacyLiveView, { recursive: true, mode: 0o750 })
    mkdirSync(legacyLiveLaneDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(legacyLiveView, 'binding.json'),
      JSON.stringify({ sessionKey: SESSION_B, operationId: legacyLiveOp }),
    )
    const liveRelaySock = join(legacyLiveView, 'relay.sock')
    const liveToolSock = join(legacyLiveLaneDir, 'tool.sock')
    const relayServer = createServer()
    const toolServer = createServer()
    servers.push(relayServer, toolServer)
    await new Promise<void>((resolve, reject) => {
      relayServer.once('error', reject)
      relayServer.listen(liveRelaySock, () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      toolServer.once('error', reject)
      toolServer.listen(liveToolSock, () => resolve())
    })
    assert.equal(isUnixSocketListening(liveRelaySock), true, 'listening relay.sock detected')
    assert.equal(isUnixSocketListening(liveToolSock), true, 'listening tool.sock detected')
    assert.equal(isUnixSocketListening(join(legacyLiveView, 'missing.sock')), false)

    // 2. Stale/dead Unix socket left behind on disk after SIGKILL (no owner.json).
    const staleOp = randomUUID()
    const staleView = join(handle.mountSource, staleOp)
    mkdirSync(staleView, { recursive: true, mode: 0o750 })
    const staleSock = join(staleView, 'relay.sock')
    const child = spawn(process.execPath, [
      '-e',
      'const net=require("node:net");net.createServer().listen(process.argv[1],()=>process.stdout.write("R"));',
      staleSock,
    ])
    await once(child.stdout, 'data')
    assert.equal(isUnixSocketListening(staleSock), true)
    child.kill('SIGKILL')
    await once(child, 'exit')
    assert.equal(existsSync(staleSock), true, 'SIGKILL leaves stale socket file on disk')
    assert.equal(isUnixSocketListening(staleSock), false, 'stale SIGKILL socket confirmed dead')

    // 3. Green boots in dual-slot mode: preserves live legacy view+lanes, cleans stale SIGKILL socket dir.
    const green = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-1',
      admitReservationMs: 0,
    })
    assert.equal(
      existsSync(legacyLiveView),
      true,
      'live legacy view dir preserved without owner.json',
    )
    assert.equal(
      existsSync(legacyLiveLaneDir),
      true,
      'live legacy lanes dir preserved without owner.json',
    )
    assert.equal(existsSync(staleView), false, 'dead SIGKILL legacy view dir cleaned')
    assert.equal(green.runtime.hasLivePeerOwnedLane?.({ containerDbId: '91' }), true)
    assert.equal(green.runtime.hasLivePeerOwnedLane?.({ sessionKey: SESSION_B }), true)

    // Green refuses to double-open the same sessionKey held by the live legacy socket.
    await assert.rejects(green.lane(SESSION_B, '91'), /REMOTE_POOL_DRAINING_RETRY_LATER/)

    // 4. Close the real legacy Unix sockets -> next adopt cleans both view and lanes dirs cleanly!
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
    assert.equal(isUnixSocketListening(liveRelaySock), false)
    assert.equal(isUnixSocketListening(liveToolSock), false)

    const greenAfterClose = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-2',
      admitReservationMs: 0,
    })
    assert.equal(existsSync(legacyLiveView), false, 'closed legacy view dir cleaned on next adopt')
    assert.equal(
      existsSync(legacyLiveLaneDir),
      false,
      'closed legacy lanes dir cleaned on next adopt',
    )
    assert.equal(greenAfterClose.runtime.hasLivePeerOwnedLane?.({ containerDbId: '91' }), false)
    await greenAfterClose.runtime.release('91')
    assert.equal(blueLane.kind, 'cc5-interactive-v1')
  } finally {
    for (const s of servers) {
      try {
        s.close()
      } catch {}
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('B4: ensureLane reserves lane until /admit arrives, explicit releaseSessionKey cancels, or reservation expires', async () => {
  const tmp = mkdtempSync('/tmp/s1b4-')
  const baseRoot = join(tmp, 'r')
  const { key, publicKeyring } = makeKeyring()
  let openReq: ReturnType<typeof request> | undefined
  try {
    // Default admitReservationMs in dual-slot mode is 60_000ms.
    const blue = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-1',
    })
    const handle = await blue.container('91', DOCKER_1, publicKeyring)

    // 1. Immediately after ensureLane (before /admit): reserved -> NOT idle for drain, busy for handover, skipped by drainOwnIdleAndOwnedLanes().
    const laneA = await blue.lane(SESSION_A, '91')
    const drainKeyA = `${laneA.operationId}:1`
    assert.equal(blue.drainRelays.get(drainKeyA)?.idle, false, 'reserved lane blocks drainGate')
    assert.deepEqual(await blue.runtime.releaseSessionIfIdle?.(SESSION_A), { status: 'busy' })

    await blue.runtime.drainOwnIdleAndOwnedLanes?.()
    assert.equal(
      existsSync(join(handle.mountSource, laneA.operationId)),
      true,
      'drainOwnIdleAndOwnedLanes does not kill reserved lane',
    )

    // 2. Container sends /admit + turn -> stays busy until terminal result -> then reservation is cleared and lane becomes idle & releasable!
    const viewA = join(handle.mountSource, laneA.operationId)
    const bindingA = JSON.parse(
      readFileSync(join(viewA, 'binding.json'), 'utf8'),
    ) as Cc5BridgeBinding
    const sockA = join(viewA, 'relay.sock')
    await cc5ControlRequest('/admit', makeAdmission(key, bindingA), sockA)
    assert.equal(blue.drainRelays.get(drainKeyA)?.idle, false, 'busy mid-turn after /admit')
    assert.deepEqual(await blue.runtime.releaseSessionIfIdle?.(SESSION_A), { status: 'busy' })

    openReq = request({ socketPath: sockA, method: 'POST', path: '/session/open' })
    openReq.on('error', () => {})
    openReq.write(`${JSON.stringify({ ...bindingA, type: 'open', sessionKey: SESSION_A })}\n`)
    const [openRes] = await once(openReq, 'response')
    openRes.on('error', () => {})
    openRes.resume()
    const userBytes = Buffer.from(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'b4 turn' } })}\n`,
    )
    openReq.write(
      `${JSON.stringify({ seq: 1, bytes: userBytes.toString('base64'), hash: createHash('sha256').update(userBytes).digest('hex') })}\n`,
    )
    const deadline = Date.now() + 2000
    while ((blue.hosts[0]?.written.length ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const natId = randomUUID()
    blue.hosts[0]!.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: natId })}\n`,
    )
    blue.hosts[0]!.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: natId,
        uuid: `ocb-${natId.slice(0, 8)}-${Date.now().toString(36)}-1`,
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })}\n`,
    )
    for (let i = 0; i < 40; i++) {
      if (blue.drainRelays.get(drainKeyA)?.idle === true) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(
      blue.drainRelays.get(drainKeyA)?.idle,
      true,
      'settled turn clears reservation and becomes idle',
    )
    assert.deepEqual(await blue.runtime.releaseSessionIfIdle?.(SESSION_A), { status: 'released' })
    openReq.destroy()
    openReq = undefined

    // 3. Explicit releaseSessionKey clears reservation immediately even before /admit.
    const laneB = await blue.lane(SESSION_B, '91')
    const drainKeyB = `${laneB.operationId}:1`
    assert.equal(blue.drainRelays.get(drainKeyB)?.idle, false)
    assert.deepEqual(await blue.runtime.releaseSessionKey?.(912, SESSION_B), {
      released: true,
      state: 'released',
    })
    assert.equal(blue.drainRelays.has(drainKeyB), false)

    // 4. Short admitReservationMs expires cleanly so an abandoned ensureLane becomes drainable.
    const shortRes = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-short-res',
      admitReservationMs: 60,
    })
    const sessionC = 'agent:main:webchat:dm:b4_expire'
    const laneC = await shortRes.lane(sessionC, '91')
    const drainKeyC = `${laneC.operationId}:1`
    assert.equal(shortRes.drainRelays.get(drainKeyC)?.idle, false)
    assert.deepEqual(await shortRes.runtime.releaseSessionIfIdle?.(sessionC), { status: 'busy' })
    await new Promise((r) => setTimeout(r, 90))
    assert.equal(shortRes.drainRelays.get(drainKeyC)?.idle, true)
    await shortRes.runtime.drainOwnIdleAndOwnedLanes?.()
    assert.equal(existsSync(join(handle.mountSource, laneC.operationId)), false)

    await blue.runtime.release('91')
  } finally {
    openReq?.destroy()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('B8: container release writes releasing.json tombstone, preserves shared view/ until peer cleanup proven, then finalizes', async () => {
  const tmp = mkdtempSync('/tmp/s1b8-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  try {
    const blue = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-1',
      admitReservationMs: 0,
    })
    const handle = await blue.container('91', DOCKER_1, publicKeyring)
    const blueLane = await blue.lane(SESSION_A, '91')

    const green = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-1',
      admitReservationMs: 0,
    })
    const greenLane = await green.lane(SESSION_B, '91')

    const containerRoot = join(handle.mountSource, '..')
    const blueView = join(handle.mountSource, blueLane.operationId)
    const greenView = join(handle.mountSource, greenLane.operationId)

    // Verify hasLivePeerOwnedLane filtering (peer vs self).
    assert.equal(blue.runtime.hasLivePeerOwnedLane?.({ containerDbId: '91' }), true)
    assert.equal(blue.runtime.hasLivePeerOwnedLane?.({ sessionKey: SESSION_B }), true)
    assert.equal(blue.runtime.hasLivePeerOwnedLane?.({ operationId: greenLane.operationId }), true)
    assert.equal(blue.runtime.hasLivePeerOwnedLane?.({ sessionKey: SESSION_A }), false)
    assert.equal(blue.runtime.hasLivePeerOwnedLane?.({ containerDbId: '999' }), false)

    // 1. peerCleanup returns false -> MUST fail with REMOTE_LANE_PEER_RELEASE_UNPROVEN, drop releasing.json,
    //    stop blue's own lane, and PRESERVE shared view/ + green's live lane!
    await assert.rejects(
      blue.runtime.release('91', DOCKER_1, { peerCleanup: async () => false }),
      new RegExp(REMOTE_LANE_PEER_RELEASE_UNPROVEN),
    )
    assert.equal(
      existsSync(join(containerRoot, 'releasing.json')),
      true,
      'releasing.json tombstone written',
    )
    assert.equal(
      existsSync(join(containerRoot, 'released.json')),
      false,
      'released.json NOT written yet',
    )
    assert.equal(existsSync(blueView), false, 'blue own lane stopped')
    assert.equal(existsSync(handle.mountSource), true, 'shared view/ preserved while peer unproven')
    assert.equal(existsSync(greenView), true, 'green live peer lane preserved')

    // A new slot booting while releasing.json exists must NOT adopt the container as active,
    // and ensureLane for a new session on Green must reject.
    const lateSlot = createSlotFixture({
      baseRoot,
      ownerSlot: 'amber',
      ownerInstanceId: 'amber-1',
      admitReservationMs: 0,
    })
    await assert.rejects(
      lateSlot.lane('agent:main:webchat:dm:after_tombstone', '91'),
      /REMOTE_LANE_UNAVAILABLE/,
    )
    await assert.rejects(
      green.lane('agent:main:webchat:dm:after_tombstone', '91'),
      /REMOTE_LANE_UNAVAILABLE/,
    )

    // 2. Even if peerCleanup returns true while green's live lane is STILL on disk -> STILL fail-closed!
    await assert.rejects(
      blue.runtime.release('91', DOCKER_1, { peerCleanup: async () => true }),
      new RegExp(REMOTE_LANE_PEER_RELEASE_UNPROVEN),
    )
    assert.equal(
      existsSync(handle.mountSource),
      true,
      'shared view/ still preserved when live peer remains on disk',
    )
    assert.equal(existsSync(greenView), true)

    // 3. Retry with real peer hop (skipViewCleanup: true on green) -> green stops its lane without deleting view/,
    //    then blue proves zero live peers and deletes shared view/ + lanes/ + writes released.json!
    let viewExistedAfterPeerSkipCleanup = false
    await blue.runtime.release('91', DOCKER_1, {
      peerCleanup: async () => {
        await green.runtime.release('91', DOCKER_1, { skipViewCleanup: true })
        viewExistedAfterPeerSkipCleanup =
          existsSync(handle.mountSource) && !existsSync(join(containerRoot, 'released.json'))
        return true
      },
    })
    assert.equal(
      viewExistedAfterPeerSkipCleanup,
      true,
      'peer skipViewCleanup kept shared view/ intact for primary',
    )
    assert.equal(existsSync(greenView), false, 'green peer lane stopped')
    assert.equal(existsSync(handle.mountSource), false, 'shared view/ removed after peer proven')
    assert.equal(
      existsSync(join(containerRoot, 'lanes')),
      false,
      'lanes/ removed after peer proven',
    )
    assert.equal(existsSync(join(containerRoot, 'released.json')), true, 'released.json written')
    assert.equal(
      existsSync(join(containerRoot, 'releasing.json')),
      false,
      'releasing.json cleaned up',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('B4 (capacity eviction): pool exhaustion NEVER evicts a chat within its pre-admit reservation window', async () => {
  const tmp = mkdtempSync('/tmp/s1b4c-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  try {
    let activeOnProf1 = 0
    const makePlacement = (req: Parameters<RemoteLaneHooks['place']>[0]): RemoteLanePlacement => {
      const operationId = randomUUID()
      return {
        target: {
          host: 'node.example',
          port: 22,
          user: 'box',
          keyPath: '/unused',
          knownHostsPath: '/unused',
          controllerSha256: '0'.repeat(64),
          taskRootPrefix: '/home/box/oc-agentremote-',
          upstreamModel: req.canonicalModel.replace(/-remote$/, ''),
        },
        taskRoot: `/home/box/oc-agentremote-c${operationId.replace(/-/g, '').slice(0, 23)}`,
        operationId,
        runId: randomUUID(),
        provisionPacket: Buffer.from('{"fixture":true}'),
        profileId: 'prof-1',
      }
    }
    const fixture = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-cap-1',
      admitReservationMs: 120,
      placeImpl: async (req) => {
        if (activeOnProf1 >= 1) {
          const err = new Error('REMOTE_LANE_CAPACITY_EXHAUSTED') as Error & { profiles?: string[] }
          err.profiles = ['prof-1']
          throw err
        }
        activeOnProf1 += 1
        return makePlacement(req)
      },
      onState: async (_opId, state) => {
        if (state === 'released') {
          activeOnProf1 = Math.max(0, activeOnProf1 - 1)
        }
      },
    })
    const handle = await fixture.container('91', DOCKER_1, publicKeyring)
    const laneX = await fixture.lane(SESSION_A, '91')
    const sockX = join(handle.mountSource, laneX.operationId, 'relay.sock')
    assert.equal(existsSync(sockX), true)

    // While X is inside its pre-admit reservation window, Y hitting capacity exhaustion MUST NOT evict X.
    assert.deepEqual(await fixture.runtime.releaseSessionIfIdle?.(SESSION_A), { status: 'busy' })
    await assert.rejects(
      fixture.lane(SESSION_B, '91'),
      /REMOTE_LANE_UNAVAILABLE/,
    )
    assert.equal(existsSync(sockX), true, 'reserved chat X relay.sock MUST survive capacity exhaustion')

    // Once reservation expires, Y may cleanly evict idle X and obtain capacity on the same slot.
    await new Promise((r) => setTimeout(r, 150))
    const laneY = await fixture.lane(SESSION_B, '91')
    assert.equal(existsSync(sockX), false, 'expired idle lane X evicted cleanly')
    assert.equal(existsSync(join(handle.mountSource, laneY.operationId, 'relay.sock')), true)

    await fixture.runtime.release('91', DOCKER_1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('B8 (transient PG failure retry convergence): peer retains lane on PG onState error and converges on retry', async () => {
  const tmp = mkdtempSync('/tmp/s1b8r-')
  const baseRoot = join(tmp, 'r')
  const { publicKeyring } = makeKeyring()
  try {
    let failGreenReleasedOnce = true
    const blue = createSlotFixture({
      baseRoot,
      ownerSlot: 'blue',
      ownerInstanceId: 'blue-retry-1',
      admitReservationMs: 0,
    })
    const handle = await blue.container('91', DOCKER_1, publicKeyring)
    await blue.lane(SESSION_A, '91')

    const greenStates: string[] = []
    const green = createSlotFixture({
      baseRoot,
      ownerSlot: 'green',
      ownerInstanceId: 'green-retry-1',
      admitReservationMs: 0,
      onState: async (_opId, state) => {
        greenStates.push(state)
        if (state === 'released' && failGreenReleasedOnce) {
          failGreenReleasedOnce = false
          throw new Error('PG_TRANSIENT_WRITE_FAILED')
        }
      },
    })
    const greenLane = await green.lane(SESSION_B, '91')
    const containerRoot = join(handle.mountSource, '..')
    const greenView = join(handle.mountSource, greenLane.operationId)

    // Attempt 1: peer PG write fails once -> peer hop MUST reject (preserving owner.lane & view),
    // primary fails with REMOTE_LANE_PEER_RELEASE_UNPROVEN and preserves shared view/.
    await assert.rejects(
      blue.runtime.release('91', DOCKER_1, {
        peerCleanup: async () => {
          try {
            await green.runtime.release('91', DOCKER_1, { skipViewCleanup: true })
            return true
          } catch {
            return false
          }
        },
      }),
      new RegExp(REMOTE_LANE_PEER_RELEASE_UNPROVEN),
    )
    assert.equal(existsSync(handle.mountSource), true, 'shared view/ preserved after transient peer PG failure')
    assert.equal(existsSync(greenView), true, 'green lane retained for retry convergence')

    // Attempt 2: PG recovered -> retry converges cleanly! Green stops & persists released, removes owner,
    // and primary finishes deleting shared view/ and writing released.json.
    await blue.runtime.release('91', DOCKER_1, {
      peerCleanup: async () => {
        await green.runtime.release('91', DOCKER_1, { skipViewCleanup: true })
        return true
      },
    })
    assert.equal(existsSync(greenView), false, 'green lane cleaned on retry')
    assert.equal(existsSync(handle.mountSource), false, 'shared view/ cleaned after retry convergence')
    assert.equal(existsSync(join(containerRoot, 'released.json')), true, 'released.json written on retry convergence')
    assert.equal(greenStates.filter((s) => s === 'released').length, 2, 'PG released write retried and succeeded')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
