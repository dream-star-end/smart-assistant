/**
 * OCV5-928 — Wave 2 Production Root-Cause Regression & Negative-Control Suite (`W2-CS1` + `W2-CS2`).
 *
 * Covers real production entrypoints with zero type escapes, zero sync I/O, and <=80L functions:
 * 1. `W2-CS1`: Standalone `remoteRelay/main.ts` unified placement router alignment
 *    (`resolveRemoteRelayDriverV4Selection` + `createRemoteRelayPlaceHook`), WRH cache/sticky
 *    affinity, `PgLogicalModelBindingStore` narrowing + disabled negative control, capability
 *    fail-closed negative control, 4-quadrant `42P01`/staging/failover compatibility,
 *    `resolveSessionPreheatTarget` logical bindings, and `userChatBridgeRemotePoolSeal` guards.
 * 2. `W2-CS2`: Master media CAS read/write bridge (`resolveMasterMediaWithBlobBridge` +
 *    `runtimeSupervisorBootstrap` helpers) serving HTTP 200 bytes instead of 503 on remote-host
 *    & volume-missing placements, idempotent `pushRemoteHostUpload` registration, commercial 503
 *    negative control, cross-tenant 404 isolation, and `@openclaude/protocol/exec-env`
 *    `defaultCapabilitiesForHostKind` parity across `compute-pool` and `ws/containerLinkToolBroker`.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import Docker from 'dockerode'
import pg from 'pg'
import { computeCacheAffinityKey } from '@openclaude/protocol'
import {
  EXEC_ENV_HOST_KINDS,
  createInMemoryFrameLinkPair,
  defaultCapabilitiesForHostKind,
  type ExecEnvAttachmentDigest,
  type ExecEnvLease,
} from '@openclaude/protocol/exec-env'
import { RemoteReleaseDrainCoordinator } from '../account-pool/remotePool/drainGate.js'
import { resolveSelfhostDriverV4Selection } from '../account-pool/remotePool/sharedLanePlacementRuntime.js'
import {
  createMasterArtifactBlobStore,
  resolveMasterMediaDirsWithCasBridge,
  resolveMasterMediaWithBlobBridge,
} from '../agent-sandbox/artifactBlobRuntime.js'
import type { LocalCasArtifactBlobStore } from '../agent-sandbox/artifactBlobStore.js'
import {
  buildUserMediaHostDir,
  parseUserVolumeMediaFilePath,
  type DockerLike,
  type UserMediaLocation,
} from '../agent-sandbox/userMedia.js'
import {
  createCasAwareRemoteHostUploadPusher,
  createCasAwareRemoteMediaPuller,
  createCasAwareUserMediaResolver,
} from '../bootstrap/runtimeSupervisorBootstrap.js'
import {
  createContainerService,
  defaultCapabilitiesForHostKind as containerServiceDefaultCapabilities,
} from '../compute-pool/containerService.js'
import {
  attachComputePoolExecEnvHandle,
  defaultCapabilitiesForHostKind as computePoolDefaultCapabilities,
} from '../compute-pool/execEnvHandle.js'
import { PgLogicalModelBindingStore } from '../db/threeLayerStateStore.js'
import { resolveSessionPreheatTarget } from '../http/admin/remotePool.js'
import {
  createRemoteRelayPlaceHook,
  resolveRemoteRelayDriverV4Selection,
} from '../remoteRelay/main.js'
import { getRuntimeChannel } from '../runtimeChannel.js'
import {
  ContainerLinkBrokerTap,
  attachContainerLinkExecEnvHandle,
  defaultCapabilitiesForHostKind as brokerDefaultCapabilities,
} from '../ws/containerLinkToolBroker.js'
import {
  MIGRATION_INSTALL_RECEIPT_TYPE,
  parseAndHandleMigrationInstallReceipt,
  shouldMarkInstallFromDispatchReceipt,
  type MigrationInstallDispatchLookupRecord,
} from '../ws/userChatBridgeRemotePoolSeal.js'

const VALID_HEX64 = 'a'.repeat(64)

function makeValidProbeSnapshot(upstreamModelId: string, supportsVision: boolean) {
  return {
    schemaVersion: 4, driverId: 'cc', driverVersion: '1.0.0', cliBinarySha256: VALID_HEX64,
    cliVersion: '2.1.112', kernelRelease: '6.8.0-generic', osReleaseId: 'ubuntu-24.04',
    cgroupV2Writable: true, systemdUserAvailable: true, lingerEnabled: true,
    bwrapAvailable: true, usernsAvailable: true, unprivilegedNetnsClone: true,
    models: [{ upstreamModelId, supportsVision, supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsAdaptiveThinking: true }],
    probedAt: '2026-11-28T00:00:00.000Z',
  }
}

interface MockRelayDbConfig {
  readonly stickyRows?: readonly Record<string, unknown>[]
  readonly offerRows?: readonly Record<string, unknown>[]
  readonly bindingRows?: readonly Record<string, unknown>[]
  readonly throwMissingBindingTable?: boolean
}

function createMockRelayPgPool(cfg: MockRelayDbConfig): pg.Pool {
  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', async (sql: string) => {
    if (sql.includes('FROM remote_agent_bindings')) return { rows: cfg.stickyRows ?? [] }
    if (sql.includes('FROM remote_model_offers')) return { rows: cfg.offerRows ?? [] }
    if (sql.includes('FROM model_logical_pool_bindings')) {
      if (cfg.throwMissingBindingTable) {
        throw Object.assign(new Error('relation "model_logical_pool_bindings" does not exist'), { code: '42P01' })
      }
      return { rows: cfg.bindingRows ?? [] }
    }
    return { rows: [] }
  })
  return pool
}

function makeBindingRow(overrides: {
  logicalModelId: string; poolKind: 'remote_pool' | 'local_container'; driverId: string
  canonicalModelId: string; priority: number; enabled: boolean; supportsVision?: boolean
}) {
  return {
    logical_model_id: overrides.logicalModelId, pool_kind: overrides.poolKind,
    driverId: overrides.driverId, driver_id: overrides.driverId,
    canonical_model_id: overrides.canonicalModelId, priority: overrides.priority, enabled: overrides.enabled,
    capabilities_json: {
      logicalModel: overrides.logicalModelId, upstreamModelId: overrides.logicalModelId,
      supportsVision: overrides.supportsVision ?? true, supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium', supportedServiceTiers: ['standard', 'priority', 'flex'],
      supportsReadOnly: true, supportsConsultTurn: true, supportsHermeticNoTools: true,
      supportsSwarm: true, supportsAdaptiveThinking: true,
    },
  }
}

function makeOfferRow(overrides: {
  profileId: string; nodeId: string; supportsVision?: boolean
  executionReady?: boolean; verifiedFingerprint?: string | null; hasHealthyLegacyOffer?: boolean
}) {
  return {
    driver_id: 'cc', profile_id: overrides.profileId, node_id: overrides.nodeId,
    execution_ready: overrides.executionReady ?? true,
    verified_fingerprint: overrides.verifiedFingerprint === undefined ? VALID_HEX64 : overrides.verifiedFingerprint,
    weight: 100, max_concurrent_lanes: 5, active_slots: 0,
    probe_snapshot: makeValidProbeSnapshot('claude-sonnet-4-6', overrides.supportsVision ?? true),
    upstream_model_id: 'claude-sonnet-4-6', canonical_model_id: 'claude-sonnet-4-6-remote',
    rtt_ms_p50: 25, has_healthy_legacy_offer: overrides.hasHealthyLegacyOffer ?? false,
  }
}

function createInMemoryCasPgPool(): { readonly pool: pg.Pool; readonly getInsertCount: () => number } {
  const blobs = new Map<string, Record<string, unknown>>()
  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', async (sql: string, params: readonly unknown[] = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim()
    if (norm.startsWith('INSERT INTO artifact_blobs')) {
      const row: Record<string, unknown> = {
        blob_id: String(params[0]), tenant_id: String(params[1]), sha256: String(params[2]),
        size_bytes: Number(params[3]), mime_type: String(params[4]), kind: String(params[5]),
        logical_name: params[6] === null ? null : String(params[6]),
        container_relative_path: params[7] === null ? null : String(params[7]),
        storage_backend: String(params[8]), storage_uri: String(params[9]),
        created_at: new Date().toISOString(), deleted_at: null,
      }
      blobs.set(String(row.blob_id), row)
      return { rows: [row], rowCount: 1 }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND blob_id = $2')) {
      const hit = blobs.get(String(params[1]))
      const rows = hit && hit.tenant_id === String(params[0]) && hit.deleted_at === null ? [hit] : []
      return { rows, rowCount: rows.length }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND sha256 = $2')) {
      const rows = [...blobs.values()].filter((r) => r.tenant_id === String(params[0]) && r.sha256 === String(params[1]) && r.deleted_at === null)
      return { rows: rows.slice(0, 1), rowCount: rows.length }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND deleted_at IS NULL')) {
      const rows = [...blobs.values()].filter((r) => r.tenant_id === String(params[0]) && r.deleted_at === null)
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  return { pool, getInsertCount: () => blobs.size }
}

function createContainerPlacementPgPool(): pg.Pool {
  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', async (_sql: string, values?: unknown[]) => {
    const uid = Number(values?.[0])
    if (uid === 42 || uid === 999) {
      return { rows: [{ host_name: 'worker-remote-eu-1', host_uuid: '11111111-2222-3333-4444-555555555555', container_id: String(uid * 10) }] }
    }
    return { rows: [{ host_name: 'self', host_uuid: '00000000-0000-0000-0000-000000000000', container_id: '770' }] }
  })
  return pool
}

const missingVolumeDocker: DockerLike = {
  getVolume: () => ({ inspect: async () => { throw Object.assign(new Error('no such volume'), { statusCode: 404 }) } }),
}

async function serveSimulatedGatewayMediaGet(
  req: IncomingMessage,
  res: ServerResponse,
  resolveUserMediaDirs: (userId: string) => Promise<UserMediaLocation>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const filename = decodeURIComponent(url.pathname.replace(/^\/api\/media\//, ''))
  const callerUserId = String(req.headers['x-oc-user-id'] ?? 'c:42')
  const loc = await resolveUserMediaDirs(callerUserId)
  if (loc.kind === 'fail') {
    const msg =
      loc.reason === 'remote-host'
        ? 'media on remote-host placement not supported yet'
        : `media unavailable (${loc.reason})`
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: msg, reason: loc.reason }))
    return
  }
  for (const dir of [loc.uploads, loc.generated]) {
    const candidate = path.join(dir, filename)
    try {
      const st = await stat(candidate)
      if (st.isFile()) {
        const body = await readFile(candidate)
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.byteLength })
        res.end(body)
        return
      }
    } catch (err) {
      void err
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
}

async function withTestMediaServer<T>(
  resolveUserMediaDirs: (userId: string) => Promise<UserMediaLocation>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    void serveSimulatedGatewayMediaGet(req, res, resolveUserMediaDirs)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('W2-CS1: remoteRelay routes via UnifiedPlacementRouter hitting WRH cache affinity & logical bindings in lockstep with cc5Runtime', async () => {
  const promptSha = 'b'.repeat(64)
  const affinityKey = computeCacheAffinityKey({
    tenantId: '42',
    sessionKey: 'sess-wrh-affinity-1',
    logicalModel: 'claude-sonnet-4-6',
    systemPromptSha256: promptSha,
  })
  const pool = createMockRelayPgPool({
    offerRows: [
      makeOfferRow({ profileId: 'prof-cold', nodeId: 'node-1' }),
      makeOfferRow({ profileId: 'prof-warm-cache', nodeId: 'node-2' }),
    ],
    bindingRows: [
      makeBindingRow({
        logicalModelId: 'claude-sonnet-4-6',
        poolKind: 'remote_pool',
        driverId: 'cc',
        canonicalModelId: 'claude-sonnet-4-6-remote',
        priority: 10,
        enabled: true,
      }),
    ],
  })
  const routerOpts = {
    cachedAffinityByProfile: new Map<string, ReadonlySet<string>>([
      ['prof-warm-cache', new Set([affinityKey])],
    ]),
  }
  const req = {
    uid: 42,
    sessionKey: 'sess-wrh-affinity-1',
    canonicalModel: 'claude-sonnet-4-6-remote',
    engine: 'ccb' as const,
    systemPromptSha256: promptSha,
  }

  const relaySelected = await resolveRemoteRelayDriverV4Selection(pool, req, routerOpts)
  const masterSelected = await resolveSelfhostDriverV4Selection(pool, req, {
    routerOptions: routerOpts,
  })

  assert.equal(relaySelected.source, 'unified_placement_router')
  assert.equal(relaySelected.driverId, 'cc')
  assert.equal(relaySelected.selectedProfileId, 'prof-warm-cache')
  assert.equal(relaySelected.selectedNodeId, 'node-2')
  assert.equal(relaySelected.bindingStatus, 'configured')
  assert.equal(relaySelected.cacheAffinityKey, affinityKey)
  assert.equal(masterSelected.selectedProfileId, relaySelected.selectedProfileId)
  assert.equal(masterSelected.stickyHomeKey, relaySelected.stickyHomeKey)
})

test('W2-CS1: remoteRelay enforces fail-closed negative controls for CAPABILITY_UNSATISFIED and disabled logical bindings', async () => {
  const noVisionPool = createMockRelayPgPool({
    offerRows: [makeOfferRow({ profileId: 'prof-text-only', nodeId: 'node-1', supportsVision: false })],
  })
  await assert.rejects(
    () =>
      resolveRemoteRelayDriverV4Selection(noVisionPool, {
        uid: 42,
        sessionKey: 'sess-cap-fail',
        canonicalModel: 'claude-sonnet-4-6-remote',
        engine: 'ccb',
        requiredCapabilities: { needsVision: true },
      }),
    /CAPABILITY_UNSATISFIED/,
  )

  const disabledPool = createMockRelayPgPool({
    offerRows: [makeOfferRow({ profileId: 'prof-1', nodeId: 'node-1' })],
    bindingRows: [
      makeBindingRow({
        logicalModelId: 'claude-sonnet-4-6',
        poolKind: 'remote_pool',
        driverId: 'cc',
        canonicalModelId: 'claude-sonnet-4-6-remote',
        priority: 10,
        enabled: false,
      }),
    ],
  })
  const placeHook = createRemoteRelayPlaceHook({
    getPool: () => disabledPool,
    drainGate: new RemoteReleaseDrainCoordinator(),
    controllerPath: '/nonexistent/controller.py',
  })
  await assert.rejects(
    () =>
      placeHook({
        uid: 42,
        containerDbId: '101',
        dockerId: 'cid-101',
        sessionKey: 'sess-disabled-binding',
        canonicalModel: 'claude-sonnet-4-6-remote',
        engine: 'ccb',
      }),
    /CAPABILITY_UNSATISFIED/,
  )
})

test('W2-CS1: remoteRelay preserves 4-quadrant safety for Q1 42P01 missing table, staging guard, and allowStickyFailover', async () => {
  const q1Pool = createMockRelayPgPool({
    throwMissingBindingTable: true,
    offerRows: [makeOfferRow({ profileId: 'prof-q1', nodeId: 'node-q1' })],
  })
  const q1Selected = await resolveRemoteRelayDriverV4Selection(q1Pool, {
    uid: 7,
    sessionKey: 'sess-q1-missing-table',
    canonicalModel: 'claude-sonnet-4-6-remote',
    engine: 'ccb',
  })
  assert.equal(q1Selected.bindingStatus, 'unconfigured')
  assert.equal(q1Selected.selectedProfileId, 'prof-q1')

  const stagingPool = createMockRelayPgPool({
    offerRows: [
      makeOfferRow({
        profileId: 'prof-staging',
        nodeId: 'node-staging',
        executionReady: false,
        verifiedFingerprint: null,
        hasHealthyLegacyOffer: true,
      }),
    ],
  })
  const guarded = await resolveRemoteRelayDriverV4Selection(stagingPool, {
    uid: 7,
    sessionKey: 'sess-staging-guard',
    canonicalModel: 'claude-sonnet-4-6-remote',
    engine: 'ccb',
  })
  assert.equal(guarded.driverId, null)
  assert.equal(guarded.source, 'legacy_uncommissioned_guard')

  const stickyPool = createMockRelayPgPool({
    stickyRows: [{ driver_id: 'cc', profile_id: 'prof-old-dead', node_id: 'node-old' }],
    offerRows: [makeOfferRow({ profileId: 'prof-healthy-failover', nodeId: 'node-healthy' })],
  })
  const pinned = await resolveRemoteRelayDriverV4Selection(stickyPool, {
    uid: 7,
    sessionKey: 'sess-sticky-1',
    canonicalModel: 'claude-sonnet-4-6-remote',
    engine: 'ccb',
  })
  assert.equal(pinned.source, 'sticky_binding')
  assert.equal(pinned.selectedProfileId, 'prof-old-dead')

  const failedOver = await resolveRemoteRelayDriverV4Selection(stickyPool, {
    uid: 7,
    sessionKey: 'sess-sticky-1',
    canonicalModel: 'claude-sonnet-4-6-remote',
    engine: 'ccb',
    allowStickyFailover: true,
  })
  assert.equal(failedOver.source, 'unified_placement_router')
  assert.equal(failedOver.selectedProfileId, 'prof-healthy-failover')
})

test('W2-CS1: resolveSessionPreheatTarget supports logical model bindings and userChatBridgeRemotePoolSeal guards warm receipts', async () => {
  const bindingPool = createMockRelayPgPool({
    bindingRows: [
      makeBindingRow({
        logicalModelId: 'claude-sonnet-4-6',
        poolKind: 'remote_pool',
        driverId: 'cc',
        canonicalModelId: 'claude-sonnet-4-6-remote',
        priority: 5,
        enabled: true,
      }),
    ],
  })
  const logicalHit = await resolveSessionPreheatTarget('claude-sonnet-4-6', {
    bindingStore: new PgLogicalModelBindingStore(bindingPool),
  })
  assert.equal(logicalHit.isRemote, true)
  assert.equal(logicalHit.canonicalModelId, 'claude-sonnet-4-6-remote')
  assert.equal(logicalHit.driverId, 'cc')

  const q1Pool = createMockRelayPgPool({ throwMissingBindingTable: true })
  const legacyRemote = await resolveSessionPreheatTarget('claude-opus-4-7-remote', {
    bindingStore: new PgLogicalModelBindingStore(q1Pool),
  })
  assert.equal(legacyRemote.isRemote, true)

  assert.equal(
    shouldMarkInstallFromDispatchReceipt(
      { sessionKey: 's1', placementEpoch: 2, migrationId: 'mig-12345678', continuityTier: 'warm_capsule' },
      'running',
    ),
    false,
  )
  assert.equal(
    shouldMarkInstallFromDispatchReceipt(
      { sessionKey: 's1', placementEpoch: 2, migrationId: 'mig-12345678', continuityTier: 'cold_degraded' },
      'running',
    ),
    true,
  )

  const committed: Array<{ checkpointGeneration: string | null; requireWarmCheckpointMatch: boolean }> = []
  const pendingMap = new Map<string, MigrationInstallDispatchLookupRecord>([
    [
      'cmid-downgraded',
      {
        clientMessageId: 'cmid-downgraded',
        dispatchId: 'disp-1',
        attemptNo: 1,
        pendingMigrationInstall: {
          sessionKey: 'sess-cold-downgrade',
          placementEpoch: 3,
          migrationId: 'mig-downgrade-01',
          continuityTier: 'tape_rebuilt',
          checkpointGeneration: null,
        },
      },
    ],
  ])
  const consumed = parseAndHandleMigrationInstallReceipt(
    JSON.stringify({
      type: MIGRATION_INSTALL_RECEIPT_TYPE,
      clientMessageId: 'cmid-downgraded',
      dispatchId: 'disp-1',
      attemptNo: 1,
      sessionKey: 'sess-cold-downgrade',
      migrationId: 'mig-downgrade-01',
      placementEpoch: 3,
      continuityTier: 'cold_degraded',
      checkpointGeneration: null,
    }),
    {
      uid: 42,
      admittedDispatches: new Map(),
      pendingMigrationInstalls: pendingMap,
      markPlacementMigrationInstalled: async (args) => {
        committed.push({
          checkpointGeneration: args.checkpointGeneration,
          requireWarmCheckpointMatch: args.requireWarmCheckpointMatch,
        })
        return true
      },
    },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(consumed, true)
  assert.deepEqual(committed, [{ checkpointGeneration: null, requireWarmCheckpointMatch: false }])
})

test('W2-CS2: remote-host container without local Master volume serves HTTP 200 media bytes via resolveMasterMediaWithBlobBridge (and 503 when CAS disabled)', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-w2-cas-remote-'))
  try {
    const { pool: metaPool } = createInMemoryCasPgPool()
    const { store: blobStore } = createMasterArtifactBlobStore({
      openClaudeHome: tmpRoot,
      pgPool: metaPool,
      bridgeSecret: 'w2-test-bridge-secret',
    })
    const containerPool = createContainerPlacementPgPool()

    let activeStore: LocalCasArtifactBlobStore | undefined = undefined
    const prodResolver = createCasAwareUserMediaResolver({
      pool: containerPool,
      docker: missingVolumeDocker,
      getBlobStore: () => activeStore,
    })

    const unbridged = resolveMasterMediaWithBlobBridge(await prodResolver('c:42'), undefined)
    assert.equal(unbridged.kind, 'fail')

    await withTestMediaServer(prodResolver, async (baseUrl) => {
      const res503 = await fetch(`${baseUrl}/api/media/remote-plot.png`, {
        headers: { 'x-oc-user-id': 'c:42' },
      })
      assert.equal(res503.status, 503)

      activeStore = blobStore
      const generatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x99])
      await blobStore.put({
        tenantId: 'c:42',
        kind: 'generated',
        bytes: generatedPng,
        mimeType: 'image/png',
        logicalName: 'remote-plot.png',
        containerRelativePath: 'generated/remote-plot.png',
      })

      const res200 = await fetch(`${baseUrl}/api/media/remote-plot.png`, {
        headers: { 'x-oc-user-id': 'c:42' },
      })
      assert.equal(res200.status, 200)
      assert.deepEqual(Buffer.from(await res200.arrayBuffer()), generatedPng)

      const resCrossTenant = await fetch(`${baseUrl}/api/media/remote-plot.png`, {
        headers: { 'x-oc-user-id': 'c:999' },
      })
      assert.equal(resCrossTenant.status, 404)
    })
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('W2-CS2: pushRemoteHostUpload idempotently registers CAS blobs, pullRemoteHostMedia falls back to CAS, and volume-missing/local_direct recover via CAS', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-w2-cas-rw-'))
  try {
    const { pool: metaPool, getInsertCount } = createInMemoryCasPgPool()
    const { store: blobStore } = createMasterArtifactBlobStore({
      openClaudeHome: tmpRoot,
      pgPool: metaPool,
    })
    const prodResolver = createCasAwareUserMediaResolver({
      pool: createContainerPlacementPgPool(),
      docker: missingVolumeDocker,
      getBlobStore: () => blobStore,
    })

    let nodeAgentPuts = 0
    const pushUpload = createCasAwareRemoteHostUploadPusher({
      getBlobStore: () => blobStore,
      putToNodeAgent: async () => {
        nodeAgentPuts += 1
      },
    })
    const uploadBytes = Buffer.from('user-uploaded-diagram-payload-v5')
    const uploadRemotePath = `${buildUserMediaHostDir(42, 'uploads')}/user-spec.txt`
    assert.deepEqual(parseUserVolumeMediaFilePath(uploadRemotePath), {
      uid: 42,
      kind: 'uploads',
      filename: 'user-spec.txt',
    })

    await pushUpload({ hostUuid: '11111111-2222-3333-4444-555555555555', remotePath: uploadRemotePath, content: uploadBytes })
    await pushUpload({ hostUuid: '11111111-2222-3333-4444-555555555555', remotePath: uploadRemotePath, content: uploadBytes })
    assert.equal(getInsertCount(), 1)
    assert.equal(nodeAgentPuts, 2)

    const pullRemote = createCasAwareRemoteMediaPuller(() => blobStore)
    const pulled = await pullRemote({
      hostUuid: '00000000-dead-beef-0000-000000000000',
      remotePath: uploadRemotePath,
    })
    assert.deepEqual(pulled, uploadBytes)

    await withTestMediaServer(prodResolver, async (baseUrl) => {
      const noCas77 = await fetch(`${baseUrl}/api/media/missing.txt`, {
        headers: { 'x-oc-user-id': 'c:77' },
      })
      assert.equal(noCas77.status, 503)

      const recoveredBytes = Buffer.from('recovered-after-local-volume-gc')
      const shaHex = createHash('sha256').update(recoveredBytes).digest('hex')
      await blobStore.put({
        tenantId: 'c:77',
        kind: 'upload',
        bytes: recoveredBytes,
        mimeType: 'text/plain',
        logicalName: 'recovered.txt',
      })
      const recoveredRes = await fetch(`${baseUrl}/api/media/${shaHex}.txt`, {
        headers: { 'x-oc-user-id': 'c:77' },
      })
      assert.equal(recoveredRes.status, 200)
      assert.deepEqual(Buffer.from(await recoveredRes.arrayBuffer()), recoveredBytes)
    })

    const localUploads = path.join(tmpRoot, `oc-${getRuntimeChannel()}-local`, 'uploads')
    const localGenerated = path.join(tmpRoot, `oc-${getRuntimeChannel()}-local`, 'generated')
    await mkdir(localUploads, { recursive: true })
    await mkdir(localGenerated, { recursive: true })
    await blobStore.put({
      tenantId: 'c:88',
      kind: 'generated',
      bytes: Buffer.from('local-backfill-ok'),
      mimeType: 'text/plain',
      logicalName: 'report.txt',
    })
    const localBridged = await resolveMasterMediaDirsWithCasBridge(
      { kind: 'ok', uid: 88, uploads: localUploads, generated: localGenerated },
      { blobStore },
    )
    assert.equal(localBridged.kind, 'ok')
    assert.equal(
      (await readFile(path.join(localGenerated, 'report.txt'))).toString('utf8'),
      'local-backfill-ok',
    )
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('W2-CS2: defaultCapabilitiesForHostKind is identical across @openclaude/protocol/exec-env, compute-pool, and ws/containerLinkToolBroker', () => {
  assert.equal(computePoolDefaultCapabilities, defaultCapabilitiesForHostKind)
  assert.equal(containerServiceDefaultCapabilities, defaultCapabilitiesForHostKind)
  assert.equal(brokerDefaultCapabilities, defaultCapabilitiesForHostKind)

  const sampleLease: ExecEnvLease = {
    leaseId: 'lease-w2-parity-1',
    tenantId: 'c:42',
    sessionKey: 'sess-w2-parity',
    hostKind: 'desktop-virtual',
    envId: 'env-w2-parity-1',
    placementEpoch: 1,
    issuedAt: '2026-11-28T00:00:00.000Z',
    expiresAt: '2026-11-28T01:00:00.000Z',
  }
  const sampleAttachment: ExecEnvAttachmentDigest = {
    leaseId: 'lease-w2-parity-1',
    channelKind: 'ws_tunnel',
    workspaceTreeSha256: VALID_HEX64,
    policyDigest: VALID_HEX64,
    toolCatalogSha256: VALID_HEX64,
    attachedAt: '2026-11-28T00:00:00.000Z',
  }
  const tap = new ContainerLinkBrokerTap()
  const registry = {
    toolBrokerEnabled: true,
    getActiveBrokerLink() {
      return {
        uid: 42n,
        containerId: 101,
        stopping: false,
        brokerTap: tap,
        isOpen: () => true,
        sendBrokerRaw: () => undefined,
      }
    },
  }
  const [frameA] = createInMemoryFrameLinkPair()
  const containerSvc = createContainerService(
    new Docker({ socketPath: '/tmp/ocv5-unused-docker.sock' }),
    { brokerFrameLinkOpener: () => frameA },
  )

  for (const hostKind of EXEC_ENV_HOST_KINDS) {
    const l0Caps = defaultCapabilitiesForHostKind(hostKind)
    const leaseForHost: ExecEnvLease = { ...sampleLease, hostKind }
    const computeHandle = attachComputePoolExecEnvHandle({
      descriptor: { envId: `env-${hostKind}`, hostKind, uid: 42n, containerDbId: 101 },
      lease: leaseForHost,
      attachment: sampleAttachment,
      openFrameLink: () => frameA,
    })
    const serviceHandle = containerSvc.attachExecEnvHandle({
      descriptor: { envId: `env-${hostKind}`, hostKind, uid: 42n, containerDbId: 101 },
      lease: leaseForHost,
      attachment: sampleAttachment,
    })
    const brokerHandle = attachContainerLinkExecEnvHandle({
      registry,
      selfhostEnabled: true,
      runtimeChannel: 'v5',
      descriptor: { envId: `env-${hostKind}`, uid: 42n, containerId: 101, hostKind },
      lease: leaseForHost,
      attachment: sampleAttachment,
    })

    assert.deepEqual(computeHandle.capabilities, l0Caps)
    assert.deepEqual(serviceHandle.capabilities, l0Caps)
    assert.deepEqual(brokerHandle.capabilities, l0Caps)
  }

  const desktopCaps = defaultCapabilitiesForHostKind('desktop-virtual')
  assert.deepEqual(desktopCaps.supportedChannels, ['ws_tunnel', 'uds_jsonrpc'])
  assert.equal(desktopCaps.maxConcurrentJobs, 8)
  assert.equal(desktopCaps.supportsDaemonServices, false)
})
