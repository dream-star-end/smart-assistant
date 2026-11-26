import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import type {
  Cc5PreparedContainer,
  RemoteLaneRequest,
} from '@openclaude/gateway/cc5-container-runtime'
import { REMOTE_DRIVER_BACKEND, type RemoteExecutionBackend } from '@openclaude/protocol'
import { RemoteReleaseDrainCoordinator } from '../account-pool/remotePool/drainGate.js'
import {
  createRemoteRelayClient,
  createRemoteRelayPeerClient,
  isExternalRemoteLaneRuntime,
} from '../agent-sandbox/remoteRelayClient.js'
import {
  OWN_UNSETTLED_JOURNALS_SQL,
  OwnLaneGenerationTracker,
  REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE,
  countOwnUnsettledJournals,
  executeGracefulShutdownDrain,
  reconcileActiveSymlinkOnStartup,
} from '../remoteRelay/main.js'
import {
  REMOTE_RELAY_PATHS,
  REMOTE_RELAY_SECRET_HEADER,
  type ReleaseSessionIfIdleResult,
  type ReleaseSessionKeyResult,
  deserializeRpcError,
  serializeRpcError,
  verifyRelaySecret,
} from '../remoteRelay/protocol.js'
import {
  type RemoteRelayReleaseOptions,
  type RemoteRelayRpcServerHandle,
  type RemoteRelayRuntimeLike,
  createRemoteRelayRpcServer,
} from '../remoteRelay/server.js'

const TEST_SECRET = 'oc-relay-test-secret-0123456789abcdef'
const DOCKER_ID = 'a'.repeat(64)
const OP_A = '11111111-1111-4111-8111-111111111111'
const OP_B = '22222222-2222-4222-8222-222222222222'

function makeFakePool(opts?: { unsettledCount?: number; fail?: boolean }) {
  return {
    async query<R = Record<string, unknown>>() {
      if (opts?.fail) throw new Error('PG_DOWN')
      return { rows: [{ cnt: String(opts?.unsettledCount ?? 0) }] as unknown as R[] }
    },
  }
}

function rawUnixRequest(args: {
  socketPath: string
  method: 'GET' | 'POST'
  path: string
  headers?: Record<string, string>
  rawBody?: string
}): Promise<{ statusCode: number; text: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: args.socketPath,
        method: args.method,
        path: args.path,
        headers: args.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown
          try {
            json = text ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          resolve({ statusCode: res.statusCode ?? 0, text, json })
        })
      },
    )
    req.on('error', reject)
    req.end(args.rawBody)
  })
}

function sampleV4Backend(sessionKey: string, operationId: string): RemoteExecutionBackend {
  return {
    kind: REMOTE_DRIVER_BACKEND,
    version: 4,
    engineId: 'codex-app-server',
    driverId: 'codex-v4',
    driverVersion: '4.1.0',
    authorityEngine: 'codex',
    operationId,
    sessionKey,
    generation: '1',
    profileId: 'prof-1',
    authEpoch: 'epoch-1',
  }
}

function createFakeRuntime(overrides: Partial<RemoteRelayRuntimeLike> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const preparedMap = new Map<string, Cc5PreparedContainer>()
  const sessions = new Map<string, { operationId: string; busy: boolean; reservedUntil?: number }>()

  const runtime: RemoteRelayRuntimeLike = {
    async prepare(input) {
      calls.push({ method: 'prepare', args: [input] })
      if (input.uid === 99999) return null
      const handle = Object.freeze({
        mountSource: `/run/oc-cc5-t1555u/c${input.containerDbId}/view`,
        containerDbId: input.containerDbId,
      })
      preparedMap.set(input.containerDbId, handle)
      return handle
    },
    async bindCreated(handle, dockerId) {
      calls.push({ method: 'bindCreated', args: [handle, dockerId] })
    },
    async activate(handle, dockerId) {
      calls.push({ method: 'activate', args: [handle, dockerId] })
    },
    async release(containerDbId, dockerId, opts?: RemoteRelayReleaseOptions) {
      calls.push({ method: 'release', args: [containerDbId, dockerId, opts] })
      if (opts?.peerCleanup) {
        const ok = await opts.peerCleanup()
        if (!ok) throw new Error('REMOTE_LANE_PEER_RELEASE_UNPROVEN')
      }
      if (!opts?.skipViewCleanup) {
        preparedMap.delete(containerDbId)
      }
    },
    async ensureLane(request: RemoteLaneRequest & { allowStickyFailover?: boolean }) {
      calls.push({ method: 'ensureLane', args: [request] })
      sessions.set(request.sessionKey, { operationId: OP_A, busy: false })
      return sampleV4Backend(request.sessionKey, OP_A)
    },
    async releaseChat(uid, chatId) {
      calls.push({ method: 'releaseChat', args: [uid, chatId] })
    },
    async releaseSessionKey(uid, sessionKey, opts): Promise<ReleaseSessionKeyResult> {
      calls.push({ method: 'releaseSessionKey', args: [uid, sessionKey, opts] })
      const hit = sessions.get(sessionKey)
      if (!hit) return { released: true, state: 'not_found' }
      if (opts?.operationId && hit.operationId !== opts.operationId) {
        return { released: false, state: 'mismatch' }
      }
      sessions.delete(sessionKey)
      return { released: true, state: 'released' }
    },
    async releaseSessionIfIdle(sessionKey, opts): Promise<ReleaseSessionIfIdleResult> {
      calls.push({ method: 'releaseSessionIfIdle', args: [sessionKey, opts] })
      const hit = sessions.get(sessionKey)
      if (!hit) return { status: 'not_found' }
      if (opts?.operationId && hit.operationId !== opts.operationId) {
        return { status: 'not_found' }
      }
      if (hit.busy || (hit.reservedUntil !== undefined && Date.now() < hit.reservedUntil)) {
        return { status: 'busy' }
      }
      sessions.delete(sessionKey)
      return { status: 'released' }
    },
    hasLivePeerOwnedLane() {
      return false
    },
    ...overrides,
  }
  return { runtime, calls, sessions, preparedMap }
}

describe('remoteRelay AF_UNIX RPC end-to-end (node:test)', () => {
  const dirs: string[] = []
  const servers: RemoteRelayRpcServerHandle[] = []
  const extraClosers: Array<() => Promise<void> | void> = []

  function makeTempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'oc-remote-relay-'))
    dirs.push(d)
    return d
  }

  afterEach(async () => {
    while (extraClosers.length > 0) {
      const fn = extraClosers.pop()!
      await Promise.resolve(fn()).catch(() => {})
    }
    while (servers.length > 0) {
      const s = servers.pop()!
      await s.close({ unlinkSocket: true }).catch(() => {})
    }
    while (dirs.length > 0) {
      const d = dirs.pop()!
      rmSync(d, { recursive: true, force: true })
    }
  })

  test('round-trips all 7 RemoteLaneRuntimePort methods and deserializes frozen Cc5PreparedContainer', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'nested', 'relay-A.sock')
    const drainGate = new RemoteReleaseDrainCoordinator()
    const { runtime, calls } = createFakeRuntime()

    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-a-1',
      runtime,
      drainGate,
      pool: () => makeFakePool(),
    })
    servers.push(srv)

    assert.equal(statSync(sock).mode & 0o777, 0o600)

    const client = createRemoteRelayClient({ socketPath: sock, secret: TEST_SECRET })
    assert.equal(isExternalRemoteLaneRuntime(client), true)
    assert.equal(isExternalRemoteLaneRuntime(undefined), false)

    // 1. prepare (non-null and null)
    const prepared = await client.prepare({
      uid: 42,
      containerDbId: '101',
      local: true,
      publicKeyring: 'pub-keyring-v1',
    })
    assert.deepEqual(prepared, {
      mountSource: '/run/oc-cc5-t1555u/c101/view',
      containerDbId: '101',
    })
    assert.equal(Object.isFrozen(prepared), true)

    const nullPrepared = await client.prepare({
      uid: 99999,
      containerDbId: '102',
      local: true,
      publicKeyring: 'pub-keyring-v1',
    })
    assert.equal(nullPrepared, null)

    // 2. bindCreated
    await client.bindCreated(prepared!, DOCKER_ID)

    // 3. activate
    await client.activate(prepared!, DOCKER_ID)

    // 4. ensureLane (preserving engine & allowStickyFailover)
    const backend = await (
      client.ensureLane as (
        req: RemoteLaneRequest & { allowStickyFailover?: boolean },
      ) => Promise<RemoteExecutionBackend>
    )({
      uid: 42,
      containerDbId: '101',
      sessionKey: 'agent:main:webchat:dm:chat-1',
      canonicalModel: 'gpt-6-remote',
      engine: 'codex',
      allowStickyFailover: true,
    })
    assert.deepEqual(backend, sampleV4Backend('agent:main:webchat:dm:chat-1', OP_A))

    // 5. releaseChat
    await client.releaseChat(42, 'chat-1')

    // 6. releaseSessionKey
    const relKey = await client.releaseSessionKey!(42, 'agent:main:webchat:dm:chat-1', {
      containerDbId: '101',
      operationId: OP_A,
      generation: '1',
    })
    assert.deepEqual(relKey, { released: true, state: 'released' })

    // 7. release
    await client.release('101', DOCKER_ID)

    assert.deepEqual(
      calls.map((c) => c.method),
      [
        'prepare',
        'prepare',
        'bindCreated',
        'activate',
        'ensureLane',
        'releaseChat',
        'releaseSessionKey',
        'release',
      ],
    )
    const ensureArg = calls.find((c) => c.method === 'ensureLane')!.args[0] as Record<
      string,
      unknown
    >
    assert.equal(ensureArg.allowStickyFailover, true)
    assert.equal(ensureArg.engine, 'codex')
  })

  test('rejects unauthenticated requests (401), oversized bodies (413), and invalid JSON/objects (400)', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-auth.sock')
    const { runtime } = createFakeRuntime()

    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-auth',
      runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(srv)

    assert.equal(verifyRelaySecret(TEST_SECRET, TEST_SECRET), true)
    assert.equal(verifyRelaySecret('short', TEST_SECRET), false)
    assert.equal(verifyRelaySecret(undefined, TEST_SECRET), false)

    const noAuth = await rawUnixRequest({
      socketPath: sock,
      method: 'GET',
      path: REMOTE_RELAY_PATHS.healthz,
    })
    assert.equal(noAuth.statusCode, 401)
    assert.deepEqual(noAuth.json, { ok: false, error: 'UNAUTHORIZED' })

    const badAuth = await rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.ensureLane,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: 'wrong-secret',
        'content-type': 'application/json',
      },
      rawBody: JSON.stringify({}),
    })
    assert.equal(badAuth.statusCode, 401)

    const hugeBody = JSON.stringify({ pad: 'x'.repeat(70 * 1024) })
    const tooLarge = await rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.prepare,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: hugeBody,
    })
    assert.equal(tooLarge.statusCode, 413)

    const arrayBody = await rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.prepare,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: '[1,2,3]',
    })
    assert.equal(arrayBody.statusCode, 400)

    const badJson = await rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.prepare,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: '{not-json',
    })
    assert.equal(badJson.statusCode, 400)
  })

  test('preserves exact error codes and remoteNodeMemory activeSessions metadata across RPC', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-err.sock')
    let nextError: Error = new Error('REMOTE_LANE_UNAVAILABLE')
    const { runtime } = createFakeRuntime({
      async ensureLane() {
        throw nextError
      },
    })

    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-err',
      runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(srv)

    const client = createRemoteRelayClient({ socketPath: sock, secret: TEST_SECRET })
    const req: RemoteLaneRequest = {
      uid: 42,
      containerDbId: '101',
      sessionKey: 'agent:main:webchat:dm:err-test',
      canonicalModel: 'gpt-6-remote',
    }

    nextError = new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
    await assert.rejects(client.ensureLane(req), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'REMOTE_POOL_DRAINING_RETRY_LATER')
      assert.equal((err as { code?: string }).code, 'REMOTE_POOL_DRAINING_RETRY_LATER')
      return true
    })

    nextError = new Error('REMOTE_DRIVER_REVERIFY_REQUIRED')
    await assert.rejects(client.ensureLane(req), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.message, 'REMOTE_DRIVER_REVERIFY_REQUIRED')
      assert.equal((err as { code?: string }).code, 'REMOTE_DRIVER_REVERIFY_REQUIRED')
      return true
    })

    nextError = Object.assign(
      new Error('远端节点内存不足，当前底座已有 7 个会话在跑（本次未计费）'),
      { code: 'REMOTE_NODE_MEMORY_EXHAUSTED', activeSessions: 7 },
    )
    await assert.rejects(client.ensureLane(req), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'REMOTE_NODE_MEMORY_EXHAUSTED')
      assert.equal((err as { memoryCode?: string }).memoryCode, 'REMOTE_NODE_MEMORY_EXHAUSTED')
      assert.equal((err as { activeSessions?: number }).activeSessions, 7)
      return true
    })

    nextError = Object.assign(
      new Error('远端节点进程/线程额度不足，当前底座已有 12 个会话在跑（本次未计费）'),
      { code: 'REMOTE_NODE_TASKS_EXHAUSTED', activeSessions: 12 },
    )
    await assert.rejects(client.ensureLane(req), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'REMOTE_NODE_TASKS_EXHAUSTED')
      assert.equal((err as { memoryCode?: string }).memoryCode, 'REMOTE_NODE_TASKS_EXHAUSTED')
      assert.equal((err as { activeSessions?: number }).activeSessions, 12)
      return true
    })

    for (const code of [
      'REMOTE_LANE_CAPACITY_EXHAUSTED',
      'REMOTE_SESSION_KEY_RESERVED',
      'CC5_FRESH_CONTAINER_BINDING_REJECTED',
      'REMOTE_LANE_PEER_RELEASE_UNPROVEN',
    ]) {
      const roundTripped = deserializeRpcError(serializeRpcError(new Error(code)))
      assert.equal(roundTripped.code, code)
      assert.equal(roundTripped.message, code)
    }
  })

  test('supports dual-slot coexistence, atomic symlink flip, /drain-begin rejection, peer forwarding, and releaseSessionIfIdle', async () => {
    const dir = makeTempDir()
    const sockA = join(dir, 'remote-relay-A.sock')
    const sockB = join(dir, 'remote-relay-B.sock')
    const activeSock = join(dir, 'remote-relay-active.sock')

    const drainA = new RemoteReleaseDrainCoordinator()
    const drainB = new RemoteReleaseDrainCoordinator()
    const rtA = createFakeRuntime({
      async ensureLane(request) {
        rtA.sessions.set(request.sessionKey, { operationId: OP_A, busy: false })
        return sampleV4Backend(request.sessionKey, OP_A)
      },
    })
    const rtB = createFakeRuntime({
      async ensureLane(request) {
        rtB.sessions.set(request.sessionKey, { operationId: OP_B, busy: false })
        return sampleV4Backend(request.sessionKey, OP_B)
      },
    })

    const peerForA = createRemoteRelayPeerClient({ socketPath: sockB, secret: TEST_SECRET })
    const peerForB = createRemoteRelayPeerClient({ socketPath: sockA, secret: TEST_SECRET })

    const srvA = await createRemoteRelayRpcServer({
      socketPath: sockA,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-slot-A',
      runtime: rtA.runtime,
      drainGate: drainA,
      pool: () => makeFakePool(),
      peerClient: peerForA,
    })
    servers.push(srvA)

    const srvB = await createRemoteRelayRpcServer({
      socketPath: sockB,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-slot-B',
      runtime: rtB.runtime,
      drainGate: drainB,
      pool: () => makeFakePool(),
      peerClient: peerForB,
    })
    servers.push(srvB)

    symlinkSync(sockA, activeSock)
    const client = createRemoteRelayClient({ socketPath: activeSock, secret: TEST_SECRET })

    const healthA = await client.probeHealth()
    assert.equal(healthA?.slot, 'A')
    assert.equal(healthA?.instanceId, 'inst-slot-A')
    assert.equal(healthA?.accepting, true)
    assert.equal(healthA?.runtimeState, 'ready')

    const sessKeyA = 'agent:main:delegate:child-a'
    const backendA = await client.ensureLane({
      uid: 42,
      containerDbId: '101',
      sessionKey: sessKeyA,
      canonicalModel: 'gpt-6-remote',
      engine: 'codex',
    })
    assert.equal(backendA.operationId, OP_A)

    // Atomically flip active symlink A -> B
    const tmpLink = join(dir, 'remote-relay-active.sock.tmp')
    symlinkSync(sockB, tmpLink)
    renameSync(tmpLink, activeSock)

    // Begin drain on Slot A
    const drainBeginRes = await rawUnixRequest({
      socketPath: sockA,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.drainBegin,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
    })
    assert.equal(drainBeginRes.statusCode, 200)
    assert.equal((drainBeginRes.json as Record<string, unknown>).draining, true)

    const clientDirectA = createRemoteRelayClient({ socketPath: sockA, secret: TEST_SECRET })
    await assert.rejects(
      clientDirectA.ensureLane({
        uid: 42,
        containerDbId: '101',
        sessionKey: 'agent:main:webchat:dm:new-on-a',
        canonicalModel: 'gpt-6-remote',
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { code?: string }).code, 'REMOTE_POOL_DRAINING_RETRY_LATER')
        return true
      },
    )
    const healthADraining = await clientDirectA.probeHealth()
    assert.equal(healthADraining?.ok, true)
    assert.equal(healthADraining?.draining, true)
    assert.equal(healthADraining?.accepting, false)

    // Active symlink immediately routes to Slot B (no stale keep-alive connection to Slot A)
    const healthB = await client.probeHealth()
    assert.equal(healthB?.slot, 'B')
    assert.equal(healthB?.accepting, true)

    // B4: Pre-admit reservation causes releaseSessionIfIdle to report `busy`
    rtA.sessions.get(sessKeyA)!.reservedUntil = Date.now() + 60_000
    assert.deepEqual(await peerForB.releaseSessionIfIdle(sessKeyA, { operationId: OP_A }), {
      status: 'busy',
    })
    rtA.sessions.get(sessKeyA)!.reservedUntil = 0

    // Busy relay also returns `busy`
    rtA.sessions.get(sessKeyA)!.busy = true
    assert.deepEqual(await peerForB.releaseSessionIfIdle(sessKeyA, { operationId: OP_A }), {
      status: 'busy',
    })

    // Transparent peer forwarding: Slot B misses locally, forwards to Slot A, releases!
    const forwardedRelease = await client.releaseSessionKey!(42, sessKeyA, {
      operationId: OP_A,
    })
    assert.deepEqual(forwardedRelease, { released: true, state: 'released' })
    assert.equal(rtA.sessions.has(sessKeyA), false)

    // Non-existent sessionKey stops after 1 hop (no infinite loop)
    const missingRelease = await client.releaseSessionKey!(42, 'agent:main:delegate:missing')
    assert.deepEqual(missingRelease, { released: true, state: 'not_found' })

    // Idle handover succeeds
    rtA.sessions.set('agent:main:webchat:dm:idle-handover', { operationId: OP_A, busy: false })
    assert.deepEqual(
      await peerForB.releaseSessionIfIdle('agent:main:webchat:dm:idle-handover', {
        operationId: OP_A,
      }),
      { status: 'released' },
    )

    // releaseChat forwards best-effort to Slot A
    await client.releaseChat(42, 'chat-shared')
    assert.equal(rtA.calls.some((c) => c.method === 'releaseChat'), true)
    assert.equal(rtB.calls.some((c) => c.method === 'releaseChat'), true)

    // /status, /reopen, and /drain control endpoints
    const statusRes = await rawUnixRequest({
      socketPath: sockA,
      method: 'GET',
      path: REMOTE_RELAY_PATHS.status,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
    })
    assert.equal(statusRes.statusCode, 200)
    assert.equal((statusRes.json as Record<string, unknown>).draining, true)

    const reopenRes = await rawUnixRequest({
      socketPath: sockA,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.reopen,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
    })
    assert.equal(reopenRes.statusCode, 200)
    assert.equal((reopenRes.json as Record<string, unknown>).accepting, true)

    const drainRes = await rawUnixRequest({
      socketPath: sockA,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.drain,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: JSON.stringify({ timeoutMs: 200, keepClosedForRestart: true }),
    })
    assert.equal(drainRes.statusCode, 200)
    assert.equal((drainRes.json as Record<string, unknown>).drained, true)
  })

  test('B6: distinguishes intentionally-disabled (200 ok, ready=false) from enabled-but-broken error (503 fail-closed)', async () => {
    const dir = makeTempDir()
    const disabledSock = join(dir, 'relay-disabled.sock')
    const errorSock = join(dir, 'relay-error.sock')

    const disabledSrv = await createRemoteRelayRpcServer({
      socketPath: disabledSock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-disabled',
      runtime: undefined,
      runtimeState: 'disabled',
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(disabledSrv)

    const errorSrv = await createRemoteRelayRpcServer({
      socketPath: errorSock,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-error',
      runtime: undefined,
      runtimeState: 'error',
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(errorSrv)

    const disabledRaw = await rawUnixRequest({
      socketPath: disabledSock,
      method: 'GET',
      path: REMOTE_RELAY_PATHS.healthz,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
    })
    assert.equal(disabledRaw.statusCode, 200)
    assert.deepEqual(disabledRaw.json, {
      ok: true,
      role: 'remote-relay',
      slot: 'A',
      instanceId: 'inst-disabled',
      pid: process.pid,
      accepting: false,
      draining: false,
      activeRelayCount: 0,
      registeredRelayCount: 0,
      unsettledJournals: 0,
      remoteRuntimeReady: false,
      runtimeState: 'disabled',
      inFlightRpcCount: 0,
    })

    const disabledClient = createRemoteRelayClient({ socketPath: disabledSock, secret: TEST_SECRET })
    const disabledHealth = await disabledClient.probeHealth()
    assert.equal(disabledHealth?.runtimeState, 'disabled')
    assert.equal(disabledHealth?.remoteRuntimeReady, false)
    assert.equal(disabledHealth?.accepting, false)

    // Enabled-but-broken MUST return 503 ok:false and probeHealth() must fail-closed to null!
    const errorRaw = await rawUnixRequest({
      socketPath: errorSock,
      method: 'GET',
      path: REMOTE_RELAY_PATHS.healthz,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
    })
    assert.equal(errorRaw.statusCode, 503)
    assert.equal((errorRaw.json as Record<string, unknown>).ok, false)
    assert.equal((errorRaw.json as Record<string, unknown>).runtimeState, 'error')
    assert.equal((errorRaw.json as Record<string, unknown>).remoteRuntimeReady, false)

    const errorClient = createRemoteRelayClient({ socketPath: errorSock, secret: TEST_SECRET })
    assert.equal(await errorClient.probeHealth(), null)
  })

  test('B4: tracks inFlightRpcCount across in-progress RPCs and surfaces it in /healthz', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-inflight.sock')
    let releaseEnsure!: () => void
    const ensureBlocked = new Promise<void>((r) => {
      releaseEnsure = r
    })
    let ensureEntered!: () => void
    const enteredPromise = new Promise<void>((r) => {
      ensureEntered = r
    })

    const { runtime } = createFakeRuntime({
      async ensureLane(request) {
        ensureEntered()
        await ensureBlocked
        return sampleV4Backend(request.sessionKey, OP_A)
      },
    })

    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-inflight',
      runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(srv)

    const client = createRemoteRelayClient({ socketPath: sock, secret: TEST_SECRET })
    assert.equal(srv.getInFlightRpcCount(), 0)

    const pendingCall = client.ensureLane({
      uid: 42,
      containerDbId: '101',
      sessionKey: 'agent:main:webchat:dm:inflight',
      canonicalModel: 'gpt-6-remote',
    })
    await enteredPromise
    assert.equal(srv.getInFlightRpcCount(), 1)
    const healthDuring = await client.probeHealth()
    assert.equal(healthDuring?.inFlightRpcCount, 1)

    releaseEnsure()
    await pendingCall
    assert.equal(srv.getInFlightRpcCount(), 0)
    const healthAfter = await client.probeHealth()
    assert.equal(healthAfter?.inFlightRpcCount, 0)
  })

  test('B8: releaseSessionKey fails closed with state=unknown on peer timeout/401/disconnect, and container release preserves shared view/', async () => {
    const dir = makeTempDir()
    const sockB = join(dir, 'relay-B.sock')
    const sockPeerHang = join(dir, 'relay-peer-hang.sock')
    const sockPeerAuth = join(dir, 'relay-peer-auth.sock')

    // 1. Peer hangs past timeout -> primary MUST return 503 + { released: false, state: 'unknown' }
    const hangSockets = new Set<import('node:net').Socket>()
    const hangServer = createNetServer((socket) => {
      hangSockets.add(socket)
      socket.on('close', () => hangSockets.delete(socket))
      // Accept connection and intentionally hold it open without responding
      socket.on('error', () => {})
    })
    await new Promise<void>((r) => hangServer.listen(sockPeerHang, r))
    extraClosers.push(async () => {
      for (const s of hangSockets) s.destroy()
      await new Promise<void>((r) => hangServer.close(() => r()))
    })

    const rtB1 = createFakeRuntime()
    const srvHang = await createRemoteRelayRpcServer({
      socketPath: sockB,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-b-hang',
      runtime: rtB1.runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
      peerClient: createRemoteRelayPeerClient({
        socketPath: sockPeerHang,
        secret: TEST_SECRET,
        timeoutMs: 150,
      }),
    })
    servers.push(srvHang)

    const clientB1 = createRemoteRelayClient({ socketPath: sockB, secret: TEST_SECRET })
    const rawHang = await rawUnixRequest({
      socketPath: sockB,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.releaseSessionKey,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: JSON.stringify({ uid: 42, sessionKey: 'agent:main:delegate:peer-hang' }),
    })
    assert.equal(rawHang.statusCode, 503)
    assert.deepEqual((rawHang.json as Record<string, unknown>).result, {
      released: false,
      state: 'unknown',
    })
    assert.deepEqual(await clientB1.releaseSessionKey!(42, 'agent:main:delegate:peer-hang'), {
      released: false,
      state: 'unknown',
    })

    // Container release while peer hangs -> peerCleanup returns false, shared view/ preserved, 503 error!
    rtB1.preparedMap.set('101', { mountSource: '/tmp/view-101', containerDbId: '101' })
    await assert.rejects(clientB1.release('101', DOCKER_ID), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'REMOTE_LANE_PEER_RELEASE_UNPROVEN')
      return true
    })
    assert.equal(rtB1.preparedMap.has('101'), true)

    await srvHang.close({ unlinkSocket: true })

    // 2. Peer rejects with 401 (mismatched secret) -> primary MUST return state='unknown'
    const authPeerSrv = await createRemoteRelayRpcServer({
      socketPath: sockPeerAuth,
      secret: 'different-peer-secret-value-1234',
      slot: 'A',
      instanceId: 'inst-a-auth',
      runtime: createFakeRuntime().runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(authPeerSrv)

    const srvAuthMismatch = await createRemoteRelayRpcServer({
      socketPath: sockB,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-b-auth',
      runtime: createFakeRuntime().runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
      peerClient: createRemoteRelayPeerClient({
        socketPath: sockPeerAuth,
        secret: TEST_SECRET,
        timeoutMs: 500,
      }),
    })
    servers.push(srvAuthMismatch)

    const clientB2 = createRemoteRelayClient({ socketPath: sockB, secret: TEST_SECRET })
    assert.deepEqual(await clientB2.releaseSessionKey!(42, 'agent:main:delegate:peer-401'), {
      released: false,
      state: 'unknown',
    })

    // 3. Peer hop on /rpc/release invokes runtime.release with skipViewCleanup=true
    const rtPeerHop = createFakeRuntime()
    rtPeerHop.preparedMap.set('202', { mountSource: '/tmp/view-202', containerDbId: '202' })
    const sockPeerHop = join(dir, 'relay-peer-hop.sock')
    const srvPeerHop = await createRemoteRelayRpcServer({
      socketPath: sockPeerHop,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-peer-hop',
      runtime: rtPeerHop.runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(srvPeerHop)

    const peerClientHop = createRemoteRelayPeerClient({
      socketPath: sockPeerHop,
      secret: TEST_SECRET,
    })
    assert.equal(await peerClientHop.release('202', DOCKER_ID), true)
    // Shared view/ must NOT be deleted by peer hop!
    assert.equal(rtPeerHop.preparedMap.has('202'), true)
    const releaseCall = rtPeerHop.calls.find((c) => c.method === 'release')
    assert.deepEqual(releaseCall?.args[2], { skipViewCleanup: true })

    // 4. Absent peer socket AND disk hasLivePeerOwnedLane=false -> legitimately returns not_found
    const sockSolo = join(dir, 'relay-solo.sock')
    const absentPeerSock = join(dir, 'relay-absent.sock')
    const srvSolo = await createRemoteRelayRpcServer({
      socketPath: sockSolo,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-solo',
      runtime: createFakeRuntime().runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
      peerClient: createRemoteRelayPeerClient({
        socketPath: absentPeerSock,
        secret: TEST_SECRET,
      }),
    })
    servers.push(srvSolo)
    const clientSolo = createRemoteRelayClient({ socketPath: sockSolo, secret: TEST_SECRET })
    assert.deepEqual(await clientSolo.releaseSessionKey!(42, 'agent:main:delegate:gone'), {
      released: true,
      state: 'not_found',
    })
  })

  test('B3: graceful drain timeout preserves live child stream, writes timeout marker, and exits 79 without calling drainOwnIdleAndOwnedLanes', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-timeout.sock')
    const markerFile = join(dir, 'state', 'remote-relay-drain-timeout.json')

    // Spawn a real child process simulating a live SSH relay streaming heartbeats
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write("tick\\n"); setInterval(() => process.stdout.write("tick\\n"), 40); setTimeout(() => process.exit(0), 10000);',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    extraClosers.push(() => {
      if (!child.killed) child.kill('SIGKILL')
    })

    const waitNextTick = (timeoutMs = 3_000): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child stream did not tick in time')), timeoutMs)
        child.stdout.once('data', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    await waitNextTick()

    const drainGate = new RemoteReleaseDrainCoordinator()
    const unregister = drainGate.registerRelay('op-live:1', { idle: false })
    let drainOwnCalled = false
    const { runtime } = createFakeRuntime({
      async drainOwnIdleAndOwnedLanes() {
        drainOwnCalled = true
      },
    })
    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-timeout-1',
      runtime,
      drainGate,
      pool: () => makeFakePool(),
    })
    servers.push(srv)

    const outcome = await executeGracefulShutdownDrain({
      slot: 'A',
      instanceId: 'inst-timeout-1',
      drainMs: 80,
      pollIntervalMs: 20,
      drainTimeoutFilePath: markerFile,
      rpcServer: srv,
      drainGate,
      runtime,
      countOwnUnsettled: async () => 2,
    })
    assert.equal(outcome.drained, false)
    assert.equal(outcome.exitCode, REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE)
    assert.equal(outcome.exitCode, 79)
    assert.equal(outcome.activeRelayCount, 1)
    assert.equal(outcome.ownUnsettled, 2)
    assert.equal(drainOwnCalled, false, 'must NOT call drainOwnIdleAndOwnedLanes on timeout')
    assert.equal(existsSync(markerFile), true)
    const parsedMarker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
    assert.equal(parsedMarker.slot, 'A')
    assert.equal(parsedMarker.instanceId, 'inst-timeout-1')
    assert.equal(parsedMarker.activeRelayCount, 1)
    assert.equal(parsedMarker.ownUnsettled, 2)

    // Real child stream must still be alive and ticking after timeout!
    await waitNextTick()
    assert.equal(child.exitCode, null)

    // Now test clean normal drain: once idle + unsettled=0, calls drainOwnIdleAndOwnedLanes & exits 0
    unregister()
    const sock2 = join(dir, 'relay-clean.sock')
    const srv2 = await createRemoteRelayRpcServer({
      socketPath: sock2,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-clean-1',
      runtime,
      drainGate,
      pool: () => makeFakePool(),
    })
    servers.push(srv2)
    const cleanOutcome = await executeGracefulShutdownDrain({
      slot: 'B',
      instanceId: 'inst-clean-1',
      drainMs: 500,
      pollIntervalMs: 10,
      drainTimeoutFilePath: join(dir, 'unused-marker.json'),
      rpcServer: srv2,
      drainGate,
      runtime,
      countOwnUnsettled: async () => 0,
    })
    assert.equal(cleanOutcome.drained, true)
    assert.equal(cleanOutcome.exitCode, 0)
    assert.equal(drainOwnCalled, true)
    assert.equal(existsSync(sock2), false)
  })

  test('B10: reconcileActiveSymlinkOnStartup restores missing/dangling active.sock without preempting a live peer', async () => {
    const dir = makeTempDir()
    const sockA = join(dir, 'remote-relay-A.sock')
    const sockB = join(dir, 'remote-relay-B.sock')
    const activeSock = join(dir, 'remote-relay-active.sock')
    const stateFile = join(dir, 'remote-relay-state.json')

    // 1. Unmigrated (no state file) -> skipped
    const unmigrated = await reconcileActiveSymlinkOnStartup({
      slot: 'A',
      runtimeState: 'ready',
      slotSocketPath: sockA,
      activeSocketPath: activeSock,
      stateFilePath: stateFile,
    })
    assert.equal(unmigrated.action, 'skipped_unmigrated')
    assert.equal(existsSync(activeSock), false)

    // 2. Migrated with activeSlot='A' and missing active.sock -> restored!
    writeFileSync(stateFile, JSON.stringify({ migrated: true, activeSlot: 'A' }))
    const restored = await reconcileActiveSymlinkOnStartup({
      slot: 'A',
      runtimeState: 'ready',
      slotSocketPath: sockA,
      activeSocketPath: activeSock,
      stateFilePath: stateFile,
    })
    assert.equal(restored.action, 'restored')
    assert.equal(readlinkSync(activeSock), sockA)

    // 3. Dangling/dead active.sock pointing to dead Slot B -> restored to Slot A!
    rmSync(activeSock, { force: true })
    symlinkSync(sockB, activeSock)
    const restoredDangling = await reconcileActiveSymlinkOnStartup({
      slot: 'A',
      runtimeState: 'ready',
      slotSocketPath: sockA,
      activeSocketPath: activeSock,
      stateFilePath: stateFile,
    })
    assert.equal(restoredDangling.action, 'restored')
    assert.equal(readlinkSync(activeSock), sockA)

    // 4. Live peer listening on Slot B -> active.sock pointing to Slot B MUST NOT be preempted!
    const livePeerSrv = await createRemoteRelayRpcServer({
      socketPath: sockB,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-live-b',
      runtime: createFakeRuntime().runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(livePeerSrv)
    rmSync(activeSock, { force: true })
    symlinkSync(sockB, activeSock)

    const kept = await reconcileActiveSymlinkOnStartup({
      slot: 'A',
      runtimeState: 'ready',
      slotSocketPath: sockA,
      activeSocketPath: activeSock,
      stateFilePath: stateFile,
    })
    assert.equal(kept.action, 'kept_live_peer')
    assert.equal(readlinkSync(activeSock), sockB)

    // 5. Not ready (`disabled` / `error`) -> skipped
    const notReady = await reconcileActiveSymlinkOnStartup({
      slot: 'A',
      runtimeState: 'disabled',
      slotSocketPath: sockA,
      activeSocketPath: activeSock,
      stateFilePath: stateFile,
    })
    assert.equal(notReady.action, 'skipped_not_ready')
  })

  test('tracks exact (operationId, generation) keys: retains settlement after binding release until PG settles, and ignores peer slot new generation', async () => {
    const tracker = new OwnLaneGenerationTracker()
    assert.equal(tracker.size, 0)
    assert.equal(await countOwnUnsettledJournals(makeFakePool({ unsettledCount: 5 }), tracker), 0)

    tracker.record(OP_A, '1')
    tracker.record(OP_B, '3')
    assert.equal(tracker.size, 2)
    assert.deepEqual(tracker.scopedKeys().sort(), [`${OP_A}:1`, `${OP_B}:3`].sort())

    // Simulate PG table containing opA gen 2 (peer slot's new generation) and opB gen 3 (our slot)
    let opBState: 'inflight' | 'committed' = 'inflight'
    const getRows = () => [
      {
        ctx: {
          remoteNativeBillingRecovery: 'remote-native-v4',
          remoteDriverV4: { scope: { operationId: OP_A, generation: '2' } },
        },
        state: 'inflight',
      },
      {
        ctx: {
          remoteNativeBillingRecovery: 'remote-native-v4',
          remoteDriverV4: { scope: { operationId: OP_B, generation: '3' } },
        },
        state: opBState,
      },
    ]

    let capturedSql = ''
    let capturedParams: readonly unknown[] | undefined
    const mockPool = {
      async query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        capturedSql = sql
        capturedParams = params
        const keySet = new Set((params?.[0] as string[]) ?? [])
        const matched = getRows()
          .filter((r) => r.state === 'inflight' || r.state === 'finalizing')
          .map((r) => `${r.ctx.remoteDriverV4.scope.operationId}:${r.ctx.remoteDriverV4.scope.generation}`)
          .filter((k) => keySet.has(k))
        return { rows: matched.map((k) => ({ scoped_key: k })) as unknown as R[] }
      },
    }

    // Only OP_B:3 matches; OP_A:2 (peer slot's newer generation) is ignored!
    assert.equal(await countOwnUnsettledJournals(mockPool, tracker), 1)
    assert.equal(capturedSql, OWN_UNSETTLED_JOURNALS_SQL)
    assert.deepEqual((capturedParams?.[0] as string[]).sort(), [`${OP_A}:1`, `${OP_B}:3`].sort())

    // B3: Marking binding released while OP_B:3 journal is STILL inflight MUST continue reporting 1!
    tracker.markBindingReleased(OP_B, '3')
    assert.equal(await countOwnUnsettledJournals(mockPool, tracker), 1)
    assert.equal(tracker.scopedKeys().includes(`${OP_B}:3`), true)

    // Once PG settles OP_B:3 to committed, count drops to 0 AND OP_B:3 is pruned while OP_A:2 remains ignored.
    opBState = 'committed'
    assert.equal(await countOwnUnsettledJournals(mockPool, tracker), 0)
    assert.equal(tracker.scopedKeys().includes(`${OP_B}:3`), false)
  })

  test('B2 + B3: blocking /drain waits for in-flight ensureLane + releases warm idle lanes, and online self-drain keeps live turns alive past timeout', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-b2b3.sock')
    const drainGate = new RemoteReleaseDrainCoordinator()
    let releaseEnsure!: () => void
    const ensureEntered = new Promise<void>((r) => {
      releaseEnsure = r
    })
    let finishEnsure!: () => void
    const ensureBlocked = new Promise<void>((r) => {
      finishEnsure = r
    })
    let idleDrainedCount = 0
    let drainBeginExitFlag: boolean | undefined

    const { runtime } = createFakeRuntime({
      async ensureLane(req) {
        releaseEnsure()
        await ensureBlocked
        return sampleV4Backend(req.sessionKey, OP_A)
      },
      async drainOwnIdleAndOwnedLanes() {
        idleDrainedCount += 1
      },
    })
    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-b2b3',
      runtime,
      drainGate,
      pool: () => makeFakePool(),
      onDrainBegin: (opts) => {
        drainBeginExitFlag = opts?.exitWhenDrained
      },
    })
    servers.push(srv)

    const client = createRemoteRelayClient({ socketPath: sock, secret: TEST_SECRET })
    // 1. Start an ensureLane that pauses inside preflight/placement.
    const pendingEnsure = client.ensureLane({
      uid: 42,
      containerDbId: '101',
      sessionKey: 'agent:main:webchat:dm:b2_inflight',
      canonicalModel: 'gpt-6-remote',
    })
    await ensureEntered

    // 2. Send POST /drain with releaseIdleLanes=true while ensureLane is STILL in flight.
    let drainResolved = false
    const drainPromise = rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.drain,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: JSON.stringify({ timeoutMs: 2_000, pollIntervalMs: 15, releaseIdleLanes: true }),
    }).then((res) => {
      drainResolved = true
      return res
    })

    // Drain MUST NOT resolve while ensureLane is still in flight!
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(drainResolved, false, 'POST /drain MUST wait for in-flight ensureLane RPC')

    // Release in-flight ensureLane -> both ensureLane and /drain complete cleanly, and warm idle lanes are released!
    finishEnsure()
    const [backend, drainRes] = await Promise.all([pendingEnsure, drainPromise])
    assert.equal(backend.operationId, OP_A)
    assert.equal(drainRes.statusCode, 200)
    const drainJson = drainRes.json as Record<string, unknown>
    assert.equal(drainJson.ok, true)
    assert.equal(drainJson.drained, true)
    assert.equal(drainJson.inFlightRpcCount, 0)
    assert.equal(drainJson.releasedIdleLanes, true)
    assert.equal(idleDrainedCount, 1)

    // 3. Reopen, then test POST /drain-begin { exitWhenDrained: true } + keepAliveOnTimeout=true.
    const reopenRes = await rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.reopen,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
      rawBody: '{}',
    })
    assert.equal(reopenRes.statusCode, 200)
    assert.equal((reopenRes.json as Record<string, unknown>).draining, false)

    const dbRes = await rawUnixRequest({
      socketPath: sock,
      method: 'POST',
      path: REMOTE_RELAY_PATHS.drainBegin,
      headers: {
        [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET,
        'content-type': 'application/json',
      },
      rawBody: JSON.stringify({ exitWhenDrained: true }),
    })
    assert.equal(dbRes.statusCode, 200)
    assert.equal((dbRes.json as Record<string, unknown>).exitWhenDrained, true)
    assert.equal(drainBeginExitFlag, true)

    // B3: Online self-drain with keepAliveOnTimeout=true MUST NOT close RPC server or resources!
    const unregister = drainGate.registerRelay('op-long:1', { idle: false })
    let resourcesClosed = false
    const markerFile = join(dir, 'online-drain-timeout.json')
    const keepAliveOutcome = await executeGracefulShutdownDrain({
      slot: 'A',
      instanceId: 'inst-b2b3',
      drainMs: 60,
      pollIntervalMs: 15,
      drainTimeoutFilePath: markerFile,
      keepAliveOnTimeout: true,
      rpcServer: srv,
      drainGate,
      runtime,
      countOwnUnsettled: async () => 1,
      closeResources: async () => {
        resourcesClosed = true
      },
    })
    assert.equal(keepAliveOutcome.drained, false)
    assert.equal(keepAliveOutcome.keptAlive, true)
    assert.equal(resourcesClosed, false, 'keepAliveOnTimeout MUST NOT close PG/Redis resources')
    assert.equal(existsSync(sock), true, 'keepAliveOnTimeout MUST keep slot socket alive')
    assert.equal(existsSync(markerFile), true, 'alert marker written on timeout')
    unregister()
  })

  test('probeHealth returns healthy status normally and fails closed (null) on PG failure, auth error, or disconnect', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-health.sock')
    let pgFail = false
    const drainGate = new RemoteReleaseDrainCoordinator()
    const unregister = drainGate.registerRelay('op-1:1', { idle: false })
    const { runtime } = createFakeRuntime()

    const srv = await createRemoteRelayRpcServer({
      socketPath: sock,
      secret: TEST_SECRET,
      slot: 'B',
      instanceId: 'inst-health-1',
      runtime,
      drainGate,
      pool: () => makeFakePool({ unsettledCount: 3, fail: pgFail }),
    })
    servers.push(srv)

    const client = createRemoteRelayClient({ socketPath: sock, secret: TEST_SECRET })
    const okHealth = await client.probeHealth()
    assert.deepEqual(okHealth, {
      ok: true,
      role: 'remote-relay',
      slot: 'B',
      instanceId: 'inst-health-1',
      pid: process.pid,
      accepting: true,
      draining: false,
      activeRelayCount: 1,
      registeredRelayCount: 1,
      unsettledJournals: 3,
      remoteRuntimeReady: true,
      runtimeState: 'ready',
      inFlightRpcCount: 0,
    })

    pgFail = true
    const rawPgFail = await rawUnixRequest({
      socketPath: sock,
      method: 'GET',
      path: REMOTE_RELAY_PATHS.healthz,
      headers: { [REMOTE_RELAY_SECRET_HEADER]: TEST_SECRET },
    })
    assert.equal(rawPgFail.statusCode, 503)
    assert.equal((rawPgFail.json as Record<string, unknown>).unsettledJournals, -1)
    assert.equal(await client.probeHealth(), null)

    pgFail = false
    const badSecretClient = createRemoteRelayClient({
      socketPath: sock,
      secret: 'invalid-secret',
    })
    assert.equal(await badSecretClient.probeHealth(), null)

    unregister()
    await srv.close({ unlinkSocket: true })
    assert.equal(await client.probeHealth(200), null)
  })

  test('retries only pre-connect ENOENT and never retries after request has been sent', async () => {
    const dir = makeTempDir()
    const sock = join(dir, 'relay-flip.sock')
    const { runtime } = createFakeRuntime()
    const client = createRemoteRelayClient({
      socketPath: sock,
      secret: TEST_SECRET,
      requestTimeoutMs: 2_000,
    })

    const delayedStart = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        createRemoteRelayRpcServer({
          socketPath: sock,
          secret: TEST_SECRET,
          slot: 'A',
          instanceId: 'inst-delayed',
          runtime,
          drainGate: new RemoteReleaseDrainCoordinator(),
          pool: () => makeFakePool(),
        })
          .then((srv) => {
            servers.push(srv)
            resolve()
          })
          .catch(reject)
      }, 40)
    })

    const [backend] = await Promise.all([
      client.ensureLane({
        uid: 42,
        containerDbId: '101',
        sessionKey: 'agent:main:webchat:dm:flip-retry',
        canonicalModel: 'gpt-6-remote',
      }),
      delayedStart,
    ])
    assert.equal(backend.operationId, OP_A)

    const dropSock = join(dir, 'relay-drop.sock')
    let invokeCount = 0
    const dropSrv = await createRemoteRelayRpcServer({
      socketPath: dropSock,
      secret: TEST_SECRET,
      slot: 'A',
      instanceId: 'inst-drop',
      runtime: createFakeRuntime({
        async ensureLane() {
          invokeCount += 1
          dropSrv.server.closeAllConnections()
          await new Promise((r) => setTimeout(r, 100))
          return sampleV4Backend('agent:main:webchat:dm:drop', OP_A)
        },
      }).runtime,
      drainGate: new RemoteReleaseDrainCoordinator(),
      pool: () => makeFakePool(),
    })
    servers.push(dropSrv)

    const dropClient = createRemoteRelayClient({
      socketPath: dropSock,
      secret: TEST_SECRET,
      requestTimeoutMs: 2_000,
    })
    await assert.rejects(
      dropClient.ensureLane({
        uid: 42,
        containerDbId: '101',
        sessionKey: 'agent:main:webchat:dm:drop',
        canonicalModel: 'gpt-6-remote',
      }),
    )
    assert.equal(invokeCount, 1)
  })
})
