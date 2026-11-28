/**
 * OCV5-928 Batch 1 R2 — Unified Router Profile & Capability Binding Closure Suite (T2 Audit Blocker B5).
 *
 * Verifies from BOTH real entrypoints (`resolveRemotePoolBackendAndSeal` -> `selectMasterCc5Backend`
 * and standalone AF_UNIX `remoteRelayClient` -> `remoteRelay/server`) that capability constraints
 * and router-selected profiles are re-verified inside `placeRemoteDriverLane`'s `FOR UPDATE`
 * transaction and reflected in the committed `remote_agent_bindings` row and SSH execution target.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { CC5_TEST_ENABLED_ENV, CC5_TEST_UID_ENV, REMOTE_DRIVER_BACKEND } from '@openclaude/protocol'
import { remotePoolBackendOf } from '@openclaude/gateway/remote-pool'
import { RemoteReleaseDrainCoordinator } from '../account-pool/remotePool/drainGate.js'
import { computeProbeFingerprintTs } from '../account-pool/remotePool/driftCoordinator.js'
import { loadRemoteDriverRegistry } from '../account-pool/remotePool/registry.js'
import { placeSelfhostRemoteLaneWithRetry } from '../account-pool/remotePool/sharedLanePlacementRuntime.js'
import { createMasterCc5Runtime, selectMasterCc5Backend } from '../agent-sandbox/cc5Runtime.js'
import { createRemoteRelayClient } from '../agent-sandbox/remoteRelayClient.js'
import { createRemoteRelayRpcServer } from '../remoteRelay/server.js'
import { resolveRemotePoolBackendAndSeal } from '../ws/userChatBridgeRemotePoolSeal.js'

const HEX64_A = 'a'.repeat(64)
const PROFILE_A_NO_VISION = '11111111-1111-4111-8111-111111111111'
const PROFILE_B_VISION = '22222222-2222-4222-8222-222222222222'
const NODE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NODE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeProbeSnap(driverVersion: string, supportsVision: boolean, observedAt: string) {
  return {
    schemaVersion: 4 as const,
    engineId: 'cc',
    driverId: 'cc',
    driverVersion,
    source: 'cli:probe' as const,
    freshness: 'cli-observed' as const,
    authPresent: true,
    accountObserved: true,
    cliVersion: '2.1.112',
    cliSha256: HEX64_A,
    models: [
      {
        upstreamModelId: 'claude-sonnet-4-6',
        displayName: 'claude-sonnet-4-6',
        supportsVision,
        supportedEfforts: ['low', 'medium', 'high'] as const,
        defaultEffort: 'medium' as const,
        supportsAdaptiveThinking: true,
      },
    ],
    rawResponseSha256: 'b'.repeat(64),
    observedAt,
  }
}

function createPlacementTxMockPool(opts: {
  nowMs: number
  profileBStaleInTx?: boolean
  stickyProfileId?: string
  pendingBillingJournal?: boolean
}) {
  const reg = loadRemoteDriverRegistry().get('cc')!
  const policySha256 = 'c'.repeat(64)
  const digests = { driverDigest: reg.driverDigest, coreDigest: reg.coreDigest, policySha256 }
  const freshIso = new Date(opts.nowMs - 5_000).toISOString()
  const staleIso = new Date(opts.nowMs - 48 * 3_600_000).toISOString()
  const snapA = makeProbeSnap(reg.driverVersion, false, freshIso)
  const fpA = computeProbeFingerprintTs(snapA, digests)
  const snapBRouter = makeProbeSnap(reg.driverVersion, true, freshIso)
  const fpBRouter = computeProbeFingerprintTs(snapBRouter, digests)
  const snapBTx = makeProbeSnap(reg.driverVersion, true, opts.profileBStaleInTx ? staleIso : freshIso)
  const fpBTx = computeProbeFingerprintTs(snapBTx, digests)

  const committedBindings: Array<{
    operationId: string
    profileId: string
    nodeId: string
    sshHost: string
    sessionKey: string
  }> = []

  const buildOfferRows = (inTx: boolean) => [
    {
      id: PROFILE_A_NO_VISION,
      profile_id: PROFILE_A_NO_VISION,
      node_id: NODE_A,
      driver_id: 'cc',
      engine: 'ccb',
      profile_name: 'prof-a-text-only',
      status: 'active',
      disabled_by: null,
      execution_ready: true,
      execution_manifest: { policySha256 },
      verified_fingerprint: fpA,
      probe_snapshot: snapA,
      probed_at: snapA.observedAt,
      last_probe_ok_at: snapA.observedAt,
      weight: 200,
      health_score: 100,
      max_concurrent_lanes: 5,
      active_slots: 0,
      hot_slots: 0,
      max_hot_slots: 5,
      upstream_model_id: 'claude-sonnet-4-6',
      canonical_model_id: 'claude-sonnet-4-6-remote',
      label: 'node-a',
      ssh_host: '10.10.0.1',
      ssh_port: 22,
      ssh_user: 'ubuntu',
      host_key_fp: 'SHA256:nodeA',
      key_id: 'rpoolv4',
      rtt_ms_p50: 10,
      node_status: 'active',
      has_healthy_legacy_offer: false,
    },
    {
      id: PROFILE_B_VISION,
      profile_id: PROFILE_B_VISION,
      node_id: NODE_B,
      driver_id: 'cc',
      engine: 'ccb',
      profile_name: 'prof-b-vision',
      status: 'active',
      disabled_by: null,
      execution_ready: true,
      execution_manifest: { policySha256 },
      verified_fingerprint: inTx ? fpBTx : fpBRouter,
      probe_snapshot: inTx ? snapBTx : snapBRouter,
      probed_at: (inTx ? snapBTx : snapBRouter).observedAt,
      last_probe_ok_at: (inTx ? snapBTx : snapBRouter).observedAt,
      weight: 100,
      health_score: 100,
      max_concurrent_lanes: 5,
      active_slots: 0,
      hot_slots: 0,
      max_hot_slots: 5,
      upstream_model_id: 'claude-sonnet-4-6',
      canonical_model_id: 'claude-sonnet-4-6-remote',
      label: 'node-b',
      ssh_host: '10.10.0.2',
      ssh_port: 22,
      ssh_user: 'ubuntu',
      host_key_fp: 'SHA256:nodeB',
      key_id: 'rpoolv4',
      rtt_ms_p50: 35,
      node_status: 'active',
      has_healthy_legacy_offer: false,
    },
  ]

  let pendingTxRow: (typeof committedBindings)[number] | null = null
  const handleQuery = async (sql: string, params: readonly unknown[] = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim()
    if (norm === 'BEGIN' || norm === 'ROLLBACK') {
      if (norm === 'ROLLBACK') pendingTxRow = null
      return { rows: [], rowCount: 0 }
    }
    if (norm === 'COMMIT') {
      if (pendingTxRow) committedBindings.push(pendingTxRow)
      pendingTxRow = null
      return { rows: [], rowCount: 0 }
    }
    if (norm.includes('FROM model_logical_pool_bindings')) {
      throw Object.assign(new Error('missing table'), { code: '42P01' })
    }
    if (norm.includes('FROM remote_model_offers')) {
      return { rows: buildOfferRows(norm.includes('FOR UPDATE')), rowCount: 2 }
    }
    if (norm.includes('SELECT COUNT(*)::int AS profile_used FROM remote_agent_bindings')) {
      return { rows: [{ profile_used: 0 }], rowCount: 1 }
    }
    if (norm.includes('FROM request_finalize_journal')) {
      return opts.pendingBillingJournal ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (norm.startsWith('INSERT INTO remote_agent_bindings')) {
      pendingTxRow = {
        operationId: String(params[0]),
        nodeId: String(params[6]),
        profileId: String(params[7]),
        sshHost: String(params[7]) === PROFILE_B_VISION ? '10.10.0.2' : '10.10.0.1',
        sessionKey: String(params[5]),
      }
      return { rows: [], rowCount: 1 }
    }
    if (norm.startsWith('UPDATE remote_agent_bindings')) {
      return { rows: [], rowCount: 1 }
    }
    if (norm.includes("state <> 'released'")) {
      return { rows: [], rowCount: 0 }
    }
    if (norm.includes('FROM remote_agent_bindings') && opts.stickyProfileId) {
      return {
        rows: [
          {
            driver_id: 'cc',
            operation_id: '33333333-3333-4333-8333-333333333333',
            run_id: '44444444-4444-4444-8444-444444444444',
            profile_id: opts.stickyProfileId,
            node_id: opts.stickyProfileId === PROFILE_A_NO_VISION ? NODE_A : NODE_B,
            generation: '1',
            native_session_id: 'sess-native-1',
          },
        ],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }

  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', handleQuery)
  Reflect.set(pool, 'connect', async () => ({ query: handleQuery, release: () => undefined }))
  return { pool, committedBindings }
}

test('R2-B5a: WS seal -> cc5Runtime and standalone AF_UNIX remoteRelay both bind the capability-verified profile in DB and SSH target', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'oc-drvtest-r2-b5a-'))
  try {
    const nowMs = Date.parse('2026-11-28T12:00:00.000Z')
    const drainGate = new RemoteReleaseDrainCoordinator()
    const env = { [CC5_TEST_ENABLED_ENV]: '1', [CC5_TEST_UID_ENV]: '42', OC_REMOTE_V4_DRAIN_SOCKET: 'none' }

    const wsDb = createPlacementTxMockPool({ nowMs })
    const spawnedTargets: Array<{ host: string; upstreamModel: string }> = []
    const inProcRuntime = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env,
        financeFactory: (() => ({
          admitTurn: async () => ({ requestId: 'req-1' }),
          completeTurn: async () => undefined,
          failTurn: async () => undefined,
        })) as unknown as NonNullable<Parameters<typeof createMasterCc5Runtime>[0]['financeFactory']>,
      },
      {
        pool: () => wsDb.pool,
        drainGate,
        baseRoot: path.join(tmpRoot, 'ws-base'),
        evidenceRoot: path.join(tmpRoot, 'ws-ev'),
        v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
        create: (cfg) => ({
          prepare: async () => ({ mountSource: tmpRoot, containerDbId: '101' }),
          bindCreated: async () => undefined,
          activate: async () => undefined,
          release: async () => undefined,
          releaseChat: async () => undefined,
          ensureLane: async (req) => {
            const placed = await cfg.hooks.place({ ...req, dockerId: HEX64_A })
            spawnedTargets.push({ host: placed.target.host, upstreamModel: placed.target.upstreamModel })
            return remotePoolBackendOf(placed.v4!.binding)
          },
        }),
      },
    )

    const sealed = await resolveRemotePoolBackendAndSeal({
      uid: 42,
      containerId: 101,
      sessionKey: 'agent:main:webchat:dm:b5_ws_vision_1',
      requiredCapabilities: { needsVision: true },
      exec: { canonicalModel: 'claude-sonnet-4-6-remote', engine: 'ccb', placement: 'remote_pool', securityEpoch: 1 },
      log: null,
      cc5BackendSelector: (selInput) => selectMasterCc5Backend(inProcRuntime, selInput, true, env),
      readEpochAtSign: async () => 1n,
      signAuthorityBundle: (_ex, _br, _at, eb) =>
        ({
          payload: { canonicalModel: 'claude-sonnet-4-6-remote', ...(eb ? { executionBackend: eb } : {}) },
          signature: 'sig',
          keyId: 'k1',
        }) as unknown as ReturnType<Parameters<typeof resolveRemotePoolBackendAndSeal>[0]['signAuthorityBundle']>,
      reject: async (code) => {
        throw new Error(`unexpected reject: ${code}`)
      },
    })
    assert.ok(sealed)
    assert.equal(wsDb.committedBindings.length, 1)
    assert.equal(wsDb.committedBindings[0]?.profileId, PROFILE_B_VISION)
    assert.equal(wsDb.committedBindings[0]?.nodeId, NODE_B)
    assert.equal(spawnedTargets[0]?.host, '10.10.0.2')

    const relayDb = createPlacementTxMockPool({ nowMs })
    const relaySock = path.join(tmpRoot, 'relay.sock')
    const relayHosts: string[] = []
    const relayServer = await createRemoteRelayRpcServer({
      socketPath: relaySock,
      secret: 'b5-relay-secret',
      slot: 'A',
      instanceId: 'inst-a',
      drainGate,
      pool: () => relayDb.pool,
      runtime: {
        prepare: async () => ({ mountSource: tmpRoot, containerDbId: '101' }),
        bindCreated: async () => undefined,
        activate: async () => undefined,
        release: async () => undefined,
        releaseChat: async () => undefined,
        ensureLane: async (req) => {
          const placed = await placeSelfhostRemoteLaneWithRetry(
            { ...req, dockerId: HEX64_A },
            {
              getPool: () => relayDb.pool,
              drainGate,
              controllerPath: '/nonexistent/controller.py',
              v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
            },
          )
          relayHosts.push(placed.target.host)
          return remotePoolBackendOf(placed.v4!.binding)
        },
      },
    })
    try {
      const relayClient = createRemoteRelayClient({ socketPath: relaySock, secret: 'b5-relay-secret' })
      const backend = await relayClient.ensureLane({
        uid: 42,
        containerDbId: '101',
        sessionKey: 'agent:main:webchat:dm:b5_relay_vision_1',
        canonicalModel: 'claude-sonnet-4-6-remote',
        requiredCapabilities: { needsVision: true },
      })
      assert.equal(backend.kind, REMOTE_DRIVER_BACKEND)
      assert.equal(relayDb.committedBindings.length, 1)
      assert.equal(relayDb.committedBindings[0]?.profileId, PROFILE_B_VISION)
      assert.equal(relayHosts[0], '10.10.0.2')
    } finally {
      await relayServer.close()
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('R2-B5b: In-transaction candidate expiry, sticky capability mismatch, and unsettled billing fail closed without binding incapable profiles', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'oc-drvtest-r2-b5b-'))
  try {
    const nowMs = Date.parse('2026-11-28T12:00:00.000Z')
    const drainGate = new RemoteReleaseDrainCoordinator()

    const expiredDb = createPlacementTxMockPool({ nowMs, profileBStaleInTx: true })
    await assert.rejects(
      () =>
        placeSelfhostRemoteLaneWithRetry(
          {
            uid: 42,
            containerDbId: '101',
            dockerId: HEX64_A,
            sessionKey: 'agent:main:webchat:dm:b5_tx_expired',
            canonicalModel: 'claude-sonnet-4-6-remote',
            requiredCapabilities: { needsVision: true },
          },
          {
            getPool: () => expiredDb.pool,
            drainGate,
            controllerPath: '/nonexistent/controller.py',
            v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
          },
        ),
      /REMOTE_DRIVER_PROBE_STALE|CAPABILITY_UNSATISFIED/,
    )
    assert.equal(expiredDb.committedBindings.length, 0)

    const billingPendingDb = createPlacementTxMockPool({
      nowMs,
      stickyProfileId: PROFILE_A_NO_VISION,
      pendingBillingJournal: true,
    })
    await assert.rejects(
      () =>
        placeSelfhostRemoteLaneWithRetry(
          {
            uid: 42,
            containerDbId: '101',
            dockerId: HEX64_A,
            sessionKey: 'agent:main:webchat:dm:b5_sticky_billing',
            canonicalModel: 'claude-sonnet-4-6-remote',
            requiredCapabilities: { needsVision: true },
          },
          {
            getPool: () => billingPendingDb.pool,
            drainGate,
            controllerPath: '/nonexistent/controller.py',
            v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
          },
        ),
      /REMOTE_OPERATION_BILLING_PENDING/,
    )

    const stickyFailClosedDb = createPlacementTxMockPool({ nowMs, stickyProfileId: PROFILE_A_NO_VISION })
    await assert.rejects(
      () =>
        placeSelfhostRemoteLaneWithRetry(
          {
            uid: 42,
            containerDbId: '101',
            dockerId: HEX64_A,
            sessionKey: 'agent:main:webchat:dm:b5_sticky_no_failover',
            canonicalModel: 'claude-sonnet-4-6-remote',
            requiredCapabilities: { needsVision: true },
          },
          {
            getPool: () => stickyFailClosedDb.pool,
            drainGate,
            controllerPath: '/nonexistent/controller.py',
            v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
          },
        ),
      /CAPABILITY_UNSATISFIED/,
    )
    assert.equal(stickyFailClosedDb.committedBindings.length, 0)

    const stickyFailoverDb = createPlacementTxMockPool({ nowMs, stickyProfileId: PROFILE_A_NO_VISION })
    const migrated = await placeSelfhostRemoteLaneWithRetry(
      {
        uid: 42,
        containerDbId: '101',
        dockerId: HEX64_A,
        sessionKey: 'agent:main:webchat:dm:b5_sticky_with_failover',
        canonicalModel: 'claude-sonnet-4-6-remote',
        requiredCapabilities: { needsVision: true },
        allowStickyFailover: true,
      },
      {
        getPool: () => stickyFailoverDb.pool,
        drainGate,
        controllerPath: '/nonexistent/controller.py',
        v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
      },
    )
    assert.equal(migrated.profileId, PROFILE_B_VISION)
    assert.equal(stickyFailoverDb.committedBindings[0]?.profileId, PROFILE_B_VISION)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})
