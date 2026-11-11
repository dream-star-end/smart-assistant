/**
 * End-to-end Conformance Harness (`OCV5-749` `AC-1`, `AC-2`):
 *
 * Wires the COMPLETE un-mocked stack for any registered 5-duty driver (`cc`, `codex`, or 3rd driver):
 *   PostgreSQL (`0339_remote_driver_core_v4`) -> `recordDriverProbeSnapshot` / verification CAS ->
 *   `placeRemoteDriverLane` -> `RemotePoolSshHost.forLocalSandbox` (`controller.py` / `mcp_socket.py` /
 *   `mcp_client.py` / `resources.py`) -> `DriverWorkerClient` (`driver_worker.py`) ->
 *   `RemotePoolRelay` + `RemoteObservationGate` + `createRemoteDriverTurnFinance` ->
 *   `RemoteEngineAdapter` + `RemoteContainerLane` + REAL `Cc5ToolHost` (`cc5-toolhost-supervisor.py`).
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Pool } from 'pg'
import {
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteDriverUsagePolicy,
  type RemoteProbeSnapshot,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import { Cc5ToolHost } from '../../../packages/gateway/src/cc5ToolHost.js'
import type { EngineBillingEvent, EngineEvent } from '../../../packages/gateway/src/engine/engineEvents.js'
import type { TurnParams } from '../../../packages/gateway/src/engine/engineAdapter.js'
import {
  DriverWorkerClient,
  RemoteEngineAdapter,
  RemotePoolRelay,
  RemotePoolSshHost,
  remotePoolBackendOf,
  remotePoolControlRequest,
  type LaneToolHost,
  type RemoteDriverPlacementResult,
  type RemotePoolFinancePort,
  type RemotePoolLaneSpec,
} from '../../../packages/gateway/src/remotePool/index.js'
import '../../../packages/gateway/src/remotePool/registerRemoteDriver.js'
import {
  claimDriverVerificationRun,
  completeDriverVerificationRun,
  computeProbeFingerprintTs,
  loadRemoteDriverRegistry,
  placeRemoteDriverLane,
  recordDriverProbeSnapshot,
  recordRemoteDriverLaneState,
  type RemoteDriverRegistryEntry,
} from '../../../packages/commercial/src/account-pool/remotePool/index.js'
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
} from '../../../packages/commercial/src/billing/modelCatalog.js'
import {
  createRemoteDriverTurnFinance,
  recoverRemoteDriverTurnBilling,
} from '../../../packages/commercial/src/billing/remoteDriverTurnBilling.js'
import { recoverRemoteNativeTurnBilling } from '../../../packages/commercial/src/billing/remoteNativeTurnBilling.js'
import { closePool, setPoolOverride } from '../../../packages/commercial/src/db/index.js'
import { runMigrations } from '../../../packages/commercial/src/db/migrate.js'
import { createLogger } from '../../../packages/commercial/src/logging/logger.js'
import { resetAndMigrateBefore } from '../../../packages/commercial/src/__tests__/helpers/db.js'
import { prepareDriverSandbox, type DriverSandboxPrepared } from './fixtures.js'

const CONTROLLER_PATH = fileURLToPath(new URL('../core/controller.py', import.meta.url))
const MCP_CLIENT_PATH = fileURLToPath(new URL('../core/mcp_client.py', import.meta.url))

export const PRICING_RATES = {
  inputPerMtok: 1_000n,
  outputPerMtok: 5_000n,
  cacheReadPerMtok: 100n,
  cacheWritePerMtok: 1_250n,
} as const

export interface OpenLaneOptions {
  readonly sessionKey?: string
  readonly sessionIndex?: number
  readonly memAvailableBytes?: number
  readonly nodeMemoryBudgetBytes?: number
  readonly extraDriverContext?: Record<string, unknown>
  readonly toolAuthorizeTimeoutMs?: number
  readonly observationOptions?: {
    readonly testFaultBypassObservation?: boolean
    readonly allowTestBypassInTmp?: boolean
    readonly authorizeTimeoutMs?: number
  }
  readonly containerObservationOptions?: {
    readonly testFaultBypassObservation?: boolean
    readonly allowTestBypassInTmp?: boolean
  }
  readonly callInterceptor?: (
    path: string,
    body: Readonly<Record<string, unknown>>,
    defaultCall: (p: string, b: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>
  readonly customHostFactory?: (
    toolRoot: string,
    lifecycleId: string,
    containerCwd: string,
    containerHome: string,
  ) => LaneToolHost
  readonly failTurnInsertOnce?: { active: boolean }
  readonly autoRecordStopState?: boolean
  readonly dedicatedToolHost?: boolean
}

export interface SubmittedTurnHandle {
  readonly requestId: string
  readonly authorityTurnId: string
  readonly turnKey: string
  readonly authorityEnvelope: string
  readonly leaseEnvelope: string
  readonly events: EngineEvent[]
  readonly run: ReturnType<RemoteEngineAdapter['submitTurn']>
}

export interface SessionLaneHandle {
  readonly placed: RemoteDriverPlacementResult
  readonly sandboxPrep: DriverSandboxPrepared
  readonly containerCwd: string
  readonly containerHome: string
  readonly containerExecRoot: string
  readonly journalDir: string
  readonly socketPath: string
  readonly host: RemotePoolSshHost
  readonly relay: RemotePoolRelay
  readonly adapter: RemoteEngineAdapter
  readonly executedCalls: Array<{
    readonly name: string
    readonly args: Record<string, unknown>
    readonly toolUseId: string
  }>
  readonly settledReceipts: RemoteReceiptV4[]
  readonly billingEvents: EngineBillingEvent[]
  readonly stopNotifications: Array<Record<string, unknown>>
  readonly getFenceDiag: () => string
  readonly submitTurn: (prompt: string, requestIdOverride?: string) => Promise<SubmittedTurnHandle>
  readonly closeLane: () => Promise<void>
}

export interface ConformanceHarness {
  readonly driverId: string
  readonly registryPath?: string
  readonly reg: RemoteDriverRegistryEntry
  readonly pool: Pool
  readonly sandbox: string
  readonly resRoot: string
  readonly fakeSys: string
  readonly evidenceSpoolRoot: string
  readonly uid: string
  readonly nodeId: string
  readonly profileId: string
  readonly profileName: string
  readonly authEpoch: string
  readonly peerDriverId: string
  readonly peerProfileId: string
  readonly peerCanonicalModel: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly expectedPolicySha256: string
  readonly probedSnapshot: RemoteProbeSnapshot
  readonly probeFingerprint: string
  readonly usagePolicy: RemoteDriverUsagePolicy
  readonly worker: DriverWorkerClient
  readonly openLane: (opts?: OpenLaneOptions) => Promise<SessionLaneHandle>
  readonly getUserCredits: () => Promise<bigint>
  readonly recoverSpool: () => Promise<{ proven: number; pending: number }>
  readonly recoverV4Only: () => Promise<{ proven: number; pending: number }>
  readonly close: () => Promise<void>
}

export async function createConformanceHarness(
  driverId: string,
  opts: { registryPath?: string; profileOverride?: string } = {},
): Promise<ConformanceHarness> {
  const baseDbUrl = process.env.TEST_DATABASE_URL
  assert.ok(
    baseDbUrl && new URL(baseDbUrl).pathname.endsWith('_test'),
    'Conformance runner requires isolated TEST_DATABASE_URL ending with _test',
  )
  const templateDbName = 'oc_remote_conf_tmpl_v4_test'
  const dedicatedDbName = `oc_remote_conf_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`
  const ensureMigratedTemplate = async () => {
    const admin = new Client({ connectionString: baseDbUrl, connectionTimeoutMillis: 3000 })
    await admin.connect()
    try {
      await admin.query('SELECT pg_advisory_lock(7490339)')
      try {
        const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          templateDbName,
        ])
        if (exists.rowCount === 0) {
          await admin.query(`CREATE DATABASE ${templateDbName} TEMPLATE template0`)
          const tmplUrl = new URL(baseDbUrl)
          tmplUrl.pathname = `/${templateDbName}`
          const tmplPool = new Pool({ connectionString: tmplUrl.toString(), max: 2 })
          tmplPool.on('error', () => {})
          setPoolOverride(tmplPool)
          await runMigrations()
          await tmplPool.end()
        }
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [templateDbName],
        )
        await admin.query(`DROP DATABASE IF EXISTS ${dedicatedDbName}`)
        await admin.query(`CREATE DATABASE ${dedicatedDbName} TEMPLATE ${templateDbName}`)
      } finally {
        await admin.query('SELECT pg_advisory_unlock(7490339)').catch(() => {})
      }
    } finally {
      await admin.end().catch(() => {})
    }
  }
  const adminExec = async (sql: string) => {
    const admin = new Client({ connectionString: baseDbUrl, connectionTimeoutMillis: 3000 })
    await admin.connect()
    try {
      await admin.query(sql)
    } finally {
      await admin.end().catch(() => {})
    }
  }
  await ensureMigratedTemplate()
  const dedicatedUrlObj = new URL(baseDbUrl)
  dedicatedUrlObj.pathname = `/${dedicatedDbName}`
  const dedicatedDbUrl = dedicatedUrlObj.toString()

  const pool = new Pool({ connectionString: dedicatedDbUrl, max: 10, connectionTimeoutMillis: 3000 })
  pool.on('error', () => {})
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, dedicatedDbName)
  setPoolOverride(pool)
  await runMigrations()
  const v4Table = await pool.query(
    `SELECT to_regclass('public.remote_driver_verification_runs') AS rel`,
  )
  assert.ok(v4Table.rows[0]?.rel, 'Migration 0339_remote_driver_core_v4 must be applied')

  const regMap = loadRemoteDriverRegistry(opts.registryPath)
  const reg = regMap.get(driverId)
  assert.ok(reg, `Driver '${driverId}' not found in registry`)

  // Short `/tmp/oc-drvtest-cf-` prefix ensures AF_UNIX `tool.sock` stays well below 104 bytes.
  const sandbox = mkdtempSync('/tmp/oc-drvtest-cf-')
  const resRoot = join(sandbox, 'res')
  const fakeSys = join(sandbox, 'sys')
  const evidenceSpoolRoot = join(sandbox, 'spool')
  const sharedWorkspaceCwd = join(sandbox, 'workspace-cwd')
  mkdirSync(resRoot, { recursive: true, mode: 0o700 })
  mkdirSync(fakeSys, { recursive: true, mode: 0o700 })
  mkdirSync(evidenceSpoolRoot, { recursive: true, mode: 0o700 })
  mkdirSync(sharedWorkspaceCwd, { recursive: true, mode: 0o700 })

  const worker = new DriverWorkerClient({ registryPath: opts.registryPath })
  const workerInfo = await worker.info(driverId)
  const usagePolicy = workerInfo.usagePolicy

  const initPrep = prepareDriverSandbox(driverId, sandbox, 1)
  const canonicalModel = initPrep.canonicalModel
  const upstreamModel = initPrep.upstreamModel
  const profileName = (opts.profileOverride ?? `${driverId.replaceAll('_', '-')}-acct-1`).slice(0, 48)
  const authEpoch = `epoch-${driverId.replaceAll('_', '-')}-1`

  // Run REAL node-side probe via `controller.py probe`.
  const probeRoot = join(sandbox, 'run-init-probe')
  const bootstrapSpec: RemotePoolLaneSpec = {
    controllerPath: CONTROLLER_PATH,
    controllerSha256: reg.controllerSha256,
    ...(opts.registryPath ? { registryPath: opts.registryPath } : {}),
    manifest: {
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      root: probeRoot,
      driverId: reg.driverId,
      engineId: reg.engineId,
      operationId: randomUUID(),
      runId: randomUUID(),
      generation: '1',
      profileId: profileName,
      authEpoch,
      model: upstreamModel,
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
    },
    driverContext: initPrep.driverContext,
    verifiedProbe: {
      schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
      engineId: reg.engineId,
      driverId: reg.driverId,
      driverVersion: reg.driverVersion,
      source: 'bootstrap:conformance',
      freshness: 'cli-observed',
      authPresent: true,
      accountObserved: true,
      cliVersion: '0.0.0',
      cliSha256: 'a'.repeat(64),
      models: [
        {
          upstreamModelId: upstreamModel,
          displayName: upstreamModel,
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          supportsAdaptiveThinking: true,
          supportsVision: true,
        },
      ],
      rawResponseSha256: 'b'.repeat(64),
      observedAt: new Date().toISOString(),
    },
  }

  const baseNodeEnv: Record<string, string> = {
    OC_REMOTE_RESOURCE_ROOT: resRoot,
    OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
    OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
    OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
  }

  const probeHost = RemotePoolSshHost.forLocalSandbox(bootstrapSpec, baseNodeEnv)
  const probed = await probeHost.probe(initPrep.probeContext, probeRoot)

  // Obtain exact `policySha256` from the driver's own `launch_spec()` and verify fingerprint parity.
  const specSample = await worker.launchSpec(
    driverId,
    {
      ...initPrep.driverContext,
      root: join(sandbox, 'run-policy-sample'),
      model: upstreamModel,
      operationId: randomUUID(),
      mcpClientPath: MCP_CLIENT_PATH,
      tools: {
        tools: [{ name: 'Write', description: 'Write file', inputSchema: { type: 'object' } }],
      },
    },
    probed.snapshot,
  )
  const expectedPolicySha256 = String(specSample.policySha256 ?? probed.snapshot.rawResponseSha256)
  assert.equal(
    computeProbeFingerprintTs(probed.snapshot, {
      driverDigest: probed.driverDigest,
      coreDigest: probed.coreDigest,
      policySha256: expectedPolicySha256,
    }),
    probed.probeFingerprint,
    'TS and Python probe fingerprints must be byte-identical',
  )

  // Seed user, container, node, target profile, AND a cross-engine peer profile on the same node (Group 6).
  const uid = (
    await pool.query(
      `INSERT INTO users (email, password_hash, credits)
       VALUES ($1, 'conformance-only', 1000000)
       RETURNING id::text`,
      [`conf-${driverId}-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0].id

  await pool.query(
    `INSERT INTO agent_containers (id, user_id, secret_hash)
     VALUES (7, $1, $2)`,
    [uid, Buffer.alloc(32, 7)],
  )

  const nodeId = (
    await pool.query(
      `INSERT INTO remote_agent_nodes
         (label, ssh_host, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ('conf-node-1', '127.0.0.1', 'box', 'SHA256:conftest', 'confkey', $1, 'active')
       RETURNING id::text`,
      [reg.controllerSha256],
    )
  ).rows[0].id

  const legacyProfileEngine = reg.authorityEngine === 'codex' ? 'codex' : 'cc'
  const profileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, runner_mode, auth_epoch, max_concurrent_lanes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5)
       RETURNING id::text`,
      [
        nodeId,
        legacyProfileEngine,
        reg.driverId,
        reg.engineId,
        profileName,
        `fp-${profileName}`,
        reg.runnerMode,
        authEpoch,
      ],
    )
  ).rows[0].id

  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, $4)`,
    [profileId, upstreamModel, canonicalModel, upstreamModel],
  )

  // Verify target profile through real driftCoordinator closed loop (`execution_ready = true`).
  const rec = await recordDriverProbeSnapshot(pool, {
    profileId,
    snapshot: probed.snapshot,
    policySha256: expectedPolicySha256,
    registryPath: opts.registryPath,
  })
  assert.ok(rec.verificationRunId)
  const claimed = await claimDriverVerificationRun(pool, {
    leaseOwner: 'conformance-init',
    profileId,
  })
  assert.ok(claimed)
  const verified = await completeDriverVerificationRun(pool, {
    runId: claimed.id,
    leaseOwner: 'conformance-init',
    outcome: 'passed',
    evidenceDigest: 'e'.repeat(64),
    registryPath: opts.registryPath,
  })
  assert.equal(verified.executionReadyRestored, true)

  // Peer engine profile on the SAME `nodeId` for Group 6 cross-engine independence proof.
  const peerDriverId = reg.engineId === 'codex' ? 'cc' : 'codex'
  const peerReg = regMap.get(peerDriverId)!
  const peerPrep = prepareDriverSandbox(peerDriverId, sandbox, 99)
  const peerProbeRoot = join(sandbox, 'run-peer-probe')
  const peerBootstrap: RemotePoolLaneSpec = {
    ...bootstrapSpec,
    manifest: {
      ...bootstrapSpec.manifest,
      root: peerProbeRoot,
      driverId: peerReg.driverId,
      engineId: peerReg.engineId,
      profileId: `peer-${peerDriverId}-1`,
      authEpoch: `epoch-peer-${peerDriverId}`,
      model: peerPrep.upstreamModel,
      driverDigest: peerReg.driverDigest,
      coreDigest: peerReg.coreDigest,
    },
    driverContext: peerPrep.driverContext,
  }
  const peerProbed = await RemotePoolSshHost.forLocalSandbox(peerBootstrap, baseNodeEnv).probe(
    peerPrep.probeContext,
    peerProbeRoot,
  )
  const peerSpecSample = await worker.launchSpec(
    peerDriverId,
    {
      ...peerPrep.driverContext,
      root: join(sandbox, 'run-peer-policy'),
      model: peerPrep.upstreamModel,
      operationId: randomUUID(),
      mcpClientPath: MCP_CLIENT_PATH,
      tools: {
        tools: [{ name: 'Write', description: 'Write file', inputSchema: { type: 'object' } }],
      },
    },
    peerProbed.snapshot,
  )
  const peerPolicySha = String(peerSpecSample.policySha256 ?? peerProbed.snapshot.rawResponseSha256)
  const peerLegacyEngine = peerReg.authorityEngine === 'codex' ? 'codex' : 'cc'
  const peerProfileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, runner_mode, auth_epoch, max_concurrent_lanes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5)
       RETURNING id::text`,
      [
        nodeId,
        peerLegacyEngine,
        peerReg.driverId,
        peerReg.engineId,
        `peer-${peerDriverId}-1`,
        `fp-peer-${peerDriverId}`,
        peerReg.runnerMode,
        `epoch-peer-${peerDriverId}`,
      ],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, $4)`,
    [peerProfileId, peerPrep.upstreamModel, peerPrep.canonicalModel, peerPrep.upstreamModel],
  )
  const peerRec = await recordDriverProbeSnapshot(pool, {
    profileId: peerProfileId,
    snapshot: peerProbed.snapshot,
    policySha256: peerPolicySha,
    registryPath: opts.registryPath,
  })
  const peerClaim = await claimDriverVerificationRun(pool, {
    leaseOwner: 'conformance-peer-init',
    profileId: peerProfileId,
  })
  await completeDriverVerificationRun(pool, {
    runId: peerClaim!.id,
    leaseOwner: 'conformance-peer-init',
    outcome: 'passed',
    evidenceDigest: peerRec.fingerprint,
    registryPath: opts.registryPath,
  })

  // Keyring & model catalog for real `createRemoteDriverTurnFinance`.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'mak1_conf_v4_0001'
  const keys: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])
  const baseCap = {
    supportsVision: true,
    reasoning: { supported: ['low', 'medium', 'high'] as const, codexModelDefault: 'medium' as const },
    ccb: { capabilityZero: false, supportsThinking: true },
  }
  const targetCatalogEntry: ModelCatalogEntry = {
    entryId: 501,
    modelId: canonicalModel,
    engine: reg.authorityEngine as any,
    providerId: reg.authorityEngine === 'codex' ? 'codex' : 'anthropic',
    placement: 'remote_pool',
    upstreamModelId: upstreamModel,
    contextWindow: 200_000,
    capabilityProfile: baseCap,
    capabilitySchemaVersion: 1,
    state: 'active',
    lockVersion: 0,
  }
  const peerCatalogEntry: ModelCatalogEntry = {
    entryId: 502,
    modelId: peerPrep.canonicalModel,
    engine: peerReg.authorityEngine as any,
    providerId: peerReg.authorityEngine === 'codex' ? 'codex' : 'anthropic',
    placement: 'remote_pool',
    upstreamModelId: peerPrep.upstreamModel,
    contextWindow: 200_000,
    capabilityProfile: baseCap,
    capabilitySchemaVersion: 1,
    state: 'active',
    lockVersion: 0,
  }
  const catalog = new ModelCatalogSnapshot({
    entries: [targetCatalogEntry, peerCatalogEntry],
    aliases: new Map(),
    securityEpoch: 7n,
    pricing: new Map([
      [
        canonicalModel,
        {
          modelId: canonicalModel,
          displayName: canonicalModel,
          ...PRICING_RATES,
          multiplier: '1.000',
          visibility: 'public',
          sortOrder: 10,
          defaultEffort: 'medium',
        },
      ],
      [
        peerPrep.canonicalModel,
        {
          modelId: peerPrep.canonicalModel,
          displayName: peerPrep.canonicalModel,
          ...PRICING_RATES,
          multiplier: '1.000',
          visibility: 'public',
          sortOrder: 20,
          defaultEffort: 'medium',
        },
      ],
    ]),
  })

  const fakeRedis = { eval: async () => 0 } as any
  const silentLog = createLogger({ out: () => {} })

  let laneSeq = 0
  let pooledHostSeq = 0
  let closingHarness = false
  const openLanes = new Set<SessionLaneHandle>()
  const idleRealHosts: Cc5ToolHost[] = []
  const allPooledRealHosts = new Set<Cc5ToolHost>()
  const retiredHostCloses: Promise<unknown>[] = []

  const spawnPooledRealHost = (env: NodeJS.ProcessEnv): Cc5ToolHost => {
    const hostIdx = ++pooledHostSeq
    const sharedRoot = join(sandbox, `shared-toolhost-${hostIdx}`)
    const sharedHome = join(sharedRoot, 'home')
    mkdirSync(sharedRoot, { recursive: true, mode: 0o700 })
    mkdirSync(join(sharedHome, '.claude'), { recursive: true, mode: 0o700 })
    const created = new Cc5ToolHost(
      sharedRoot,
      randomUUID(),
      { cwd: sharedWorkspaceCwd, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
      async () => {
        throw new Error('REMOTE_PERMISSION_PROMPT_UNSUPPORTED')
      },
      {
        ...env,
        HOME: sharedHome,
        CLAUDE_CONFIG_DIR: join(sharedHome, '.claude'),
      },
    )
    allPooledRealHosts.add(created)
    return created
  }

  for (let i = 0; i < 3; i++) {
    idleRealHosts.push(
      spawnPooledRealHost({
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
      }),
    )
  }

  const acquirePooledRealHost = (env: NodeJS.ProcessEnv): Cc5ToolHost => {
    const existing = idleRealHosts.pop() ?? spawnPooledRealHost(env)
    if (!closingHarness && idleRealHosts.length < 2) {
      idleRealHosts.push(spawnPooledRealHost(env))
    }
    return existing
  }

  const openLane = async (laneOpts: OpenLaneOptions = {}): Promise<SessionLaneHandle> => {
    const idx = laneOpts.sessionIndex ?? ++laneSeq
    const sessionPrep = prepareDriverSandbox(driverId, sandbox, idx)
    const mergedDriverCtx = {
      ...sessionPrep.driverContext,
      ...(laneOpts.extraDriverContext ?? {}),
    }
    const sessionKey =
      laneOpts.sessionKey ?? `agent:main:webchat:dm:cf_${driverId}_${idx}_${randomUUID().slice(0, 6)}`

    const placed = await placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'd'.repeat(64),
        sessionKey,
        canonicalModel,
        driverId,
        driverContext: mergedDriverCtx,
      },
      {
        pool,
        registryPath: opts.registryPath,
        localSandboxDir: sandbox,
      },
    )

    const laneNodeEnv: Record<string, string> = {
      ...baseNodeEnv,
      ...(laneOpts.nodeMemoryBudgetBytes !== undefined
        ? { OC_REMOTE_NODE_MEMORY_BUDGET: String(laneOpts.nodeMemoryBudgetBytes) }
        : {}),
      ...(laneOpts.memAvailableBytes !== undefined
        ? { OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(laneOpts.memAvailableBytes) }
        : {}),
    }
    const host = RemotePoolSshHost.forLocalSandbox(placed.spec, laneNodeEnv)

    const effectivePool: Pool = laneOpts.failTurnInsertOnce
      ? (new Proxy(pool, {
          get(target, prop) {
            if (prop === 'connect') {
              return async () => {
                const c = await target.connect()
                return new Proxy(c, {
                  get(t, p) {
                    if (p === 'query') {
                      return async (...args: any[]) => {
                        if (
                          laneOpts.failTurnInsertOnce?.active &&
                          String(args[0]).includes('INSERT INTO remote_native_turns')
                        ) {
                          laneOpts.failTurnInsertOnce.active = false
                          throw new Error('simulated-pg-disconnect-before-receipt-commit')
                        }
                        return (t.query as any)(...args)
                      }
                    }
                    const v = Reflect.get(t, p)
                    return typeof v === 'function' ? v.bind(t) : v
                  },
                })
              }
            }
            const v = Reflect.get(target, prop)
            return typeof v === 'function' ? v.bind(target) : v
          },
        }) as Pool)
      : pool

    const rawFinance = createRemoteDriverTurnFinance(
      {
        pool: effectivePool,
        preCheckRedis: fakeRedis,
        catalog: { assertFresh: async () => catalog } as unknown as ModelCatalogCache,
        keyring: keys,
        loadUserModelAuthz: async (userId) => ({
          uid: userId,
          role: 'user',
          grantedModelIds: new Set<string>(),
          deniedModelIds: new Set<string>(),
          userPlanTier: null,
          orgPlanCode: null,
        }),
        log: silentLog,
      },
      { reserve: async () => ({ maxCost: 100n }) as any, release: async () => true },
    )

    const settledReceipts: RemoteReceiptV4[] = []
    const stopNotifications: Array<Record<string, unknown>> = []
    const autoStopState = laneOpts.autoRecordStopState !== false

    const finance: RemotePoolFinancePort = {
      admit: async (admitIn) => {
        const innerTurn = await rawFinance.admit(admitIn)
        return {
          requestId: innerTurn.requestId,
          beforeHostStart: () => innerTurn.beforeHostStart(),
          beforeDispatch: (d) => innerTurn.beforeDispatch(d),
          bindNativeThread: (sid, newly) => innerTurn.bindNativeThread(sid, newly),
          abandonUndispatched: (f) => innerTurn.abandonUndispatched(f),
          terminal: async (receipt) => {
            settledReceipts.push(receipt)
            return await innerTurn.terminal(receipt)
          },
          stop: async (stopInfo) => {
            stopNotifications.push({ ...stopInfo })
            await innerTurn.stop(stopInfo)
            if (autoStopState) {
              await recordRemoteDriverLaneState(
                placed.binding.operationId,
                placed.generation,
                stopInfo.remoteStopped ? 'released' : 'unknown',
                pool,
              ).catch(() => {})
            }
          },
        }
      },
    }

    const journalDir = join(
      evidenceSpoolRoot,
      placed.binding.operationId,
      placed.generation,
      'journal',
    )
    const relay = new RemotePoolRelay({
      binding: placed.binding,
      keys,
      host,
      spec: placed.spec,
      journalDir,
      finance,
      worker,
      onRemoteStart: async () => {
        await recordRemoteDriverLaneState(
          placed.binding.operationId,
          placed.generation,
          'running',
          pool,
        )
      },
      observationOptions: {
        authorizeTimeoutMs: laneOpts.toolAuthorizeTimeoutMs ?? 350,
        ...(laneOpts.observationOptions ?? {}),
      },
    })

    const socketPath = join(
      sandbox,
      `rl-${placed.binding.operationId.replace(/-/g, '').slice(0, 12)}-g${placed.generation}.sock`,
    )
    relay.controlServer.listen(socketPath)
    await once(relay.controlServer, 'listening')

    const containerRoot = join(sandbox, `cnt-${idx}-${randomUUID().slice(0, 6)}`)
    const containerCwd = join(sharedWorkspaceCwd, `cnt-${idx}-${randomUUID().slice(0, 6)}`)
    const containerHome = join(containerRoot, 'home')
    const containerExecRoot = join(containerRoot, 'exec')
    mkdirSync(containerRoot, { recursive: true, mode: 0o700 })
    mkdirSync(containerCwd, { recursive: true, mode: 0o700 })
    mkdirSync(join(containerHome, '.claude'), { recursive: true, mode: 0o700 })
    mkdirSync(containerExecRoot, { recursive: true, mode: 0o700 })

    const executedCalls: Array<{
      readonly name: string
      readonly args: Record<string, unknown>
      readonly toolUseId: string
    }> = []

    const hostFactory = (
      toolRoot: string,
      lifecycleId: string,
      profile: { cwd: string; mcpConfigPath: string | null; settingsPath: string | null; disallowedTools: string[] },
      env: NodeJS.ProcessEnv,
    ): LaneToolHost => {
      if (laneOpts.customHostFactory) {
        return laneOpts.customHostFactory(toolRoot, lifecycleId, containerCwd, containerHome)
      }
      if (laneOpts.dedicatedToolHost) {
        const realHost = new Cc5ToolHost(
          toolRoot,
          lifecycleId,
          profile,
          async () => {
            throw new Error('REMOTE_PERMISSION_PROMPT_UNSUPPORTED')
          },
          env,
        )
        return {
          tools: () => realHost.tools(),
          close: () => realHost.close(),
          execute: async (name, rawArgs, identity) => {
            const argsObj =
              rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
            executedCalls.push({
              name,
              args: structuredClone(argsObj),
              toolUseId: identity.toolUseId,
            })
            return await realHost.execute(name, rawArgs, identity)
          },
        }
      }
      const pooledHost = acquirePooledRealHost(env)
      let healthy = true
      let hasExecuted = false
      let inFlightOps = 0
      let returned = false
      return {
        tools: async () => {
          inFlightOps += 1
          try {
            return await pooledHost.tools()
          } catch (err) {
            healthy = false
            throw err
          } finally {
            inFlightOps -= 1
          }
        },
        close: async () => {
          if (returned) return
          returned = true
          if (healthy && !hasExecuted && inFlightOps === 0 && !closingHarness) {
            idleRealHosts.push(pooledHost)
          } else {
            allPooledRealHosts.delete(pooledHost)
            retiredHostCloses.push(pooledHost.close().catch(() => {}))
          }
        },
        execute: async (name, rawArgs, identity) => {
          hasExecuted = true
          inFlightOps += 1
          const argsObj =
            rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
          executedCalls.push({
            name,
            args: structuredClone(argsObj),
            toolUseId: identity.toolUseId,
          })
          try {
            return await pooledHost.execute(name, rawArgs, identity)
          } catch (err) {
            healthy = false
            throw err
          } finally {
            inFlightOps -= 1
          }
        },
      }
    }

    const defaultCall = (p: string, b: Readonly<Record<string, unknown>>) =>
      remotePoolControlRequest(p, b, socketPath)

    const adapter = new RemoteEngineAdapter(
      {
        peerId: `peer-${idx}`,
        sessionKey,
        executionBackend: remotePoolBackendOf(placed.binding),
        agentId: 'main',
        agentBaseDir: containerCwd,
        model: canonicalModel,
        config: {} as any,
      },
      {
        binding: placed.binding,
        socketPath,
        ...(laneOpts.callInterceptor
          ? {
              call: (p, b) => laneOpts.callInterceptor!(p, b, defaultCall),
            }
          : {}),
        keyring: keys,
        executionRoot: containerExecRoot,
        hostFactory,
        toolContextFactory: async () => ({
          profile: {
            cwd: containerCwd,
            mcpConfigPath: null,
            settingsPath: null,
            disallowedTools: [],
          },
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: containerHome,
            CLAUDE_CONFIG_DIR: join(containerHome, '.claude'),
            LANG: 'C.UTF-8',
          },
          cleanup: () => {},
        }),
        toolAuthorizeTimeoutMs: laneOpts.toolAuthorizeTimeoutMs ?? 350,
        ...(laneOpts.containerObservationOptions
          ? { observationOptions: laneOpts.containerObservationOptions }
          : {}),
      },
    )

    const billingEvents: EngineBillingEvent[] = []
    const adapterErrors: string[] = []
    adapter.on('billing', (ev: EngineBillingEvent) => billingEvents.push(ev))
    adapter.on('error', (err: unknown) => {
      adapterErrors.push(err instanceof Error ? err.message : String(err))
    })

    const sessionTotals = { totalCostUSD: 0, turns: 0 }
    const toolUseIdToName = new Map<string, string>()

    const submitTurn = async (
      prompt: string,
      requestIdOverride?: string,
    ): Promise<SubmittedTurnHandle> => {
      const dispatchId = randomUUID()
      const authorityTurnId = randomUUID().replaceAll('-', '')
      const requestId = requestIdOverride ?? `req_${driverId}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const turnKey = createHash('sha256').update(`${requestId}:turnKey`).digest('hex')

      await pool.query(
        `INSERT INTO turn_dispatches
           (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
            request_hash, billing_request_id, status, agent_container_id)
         VALUES ($1, $2, $3, $4, 'main', $5, $6, $4, 'admitted', 7)`,
        [dispatchId, uid, placed.binding.sessionKey, requestId, canonicalModel, turnKey],
      )
      await pool.query(
        `INSERT INTO authority_turn_dispatches
           (authority_turn_id, user_id, canonical_model, session_id, dispatch_id, attempt_no)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [authorityTurnId, uid, canonicalModel, placed.binding.sessionKey, dispatchId],
      )

      const now = Date.now()
      const a: ModelAuthorityPayload = {
        v: 1,
        keyId,
        uid: Number(uid),
        containerId: 7,
        authorityTurnId,
        connectionChallenge: 'conf-v4',
        canonicalModel,
        engine: placed.binding.authorityEngine,
        executionBackend: remotePoolBackendOf(placed.binding),
        executionDescriptor: {
          capabilityProfile: baseCap,
          capabilitySchemaVersion: 1,
          contextWindow: 200_000,
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'],
          ...(placed.binding.authorityEngine === 'codex' ? { codexDefaultEffort: 'medium' } : {}),
        },
        executionRevision: catalog.executionRevision,
        securityEpoch: 7,
        billingRequestId: requestId,
        issuedAt: now,
        expiresAt: now + 120_000,
      }
      const l: TurnLease = {
        v: 1,
        keyId,
        uid: Number(uid),
        containerId: 7,
        authorityTurnId,
        connectionChallenge: 'conf-v4',
        canonicalModel,
        securityEpoch: 7,
        issuedAt: now,
        expiresAt: now + 600_000,
      }
      const authorityEnvelope = encodeAuthorityEnvelope(
        a,
        sign(null, authoritySigningInput(a), privateKey),
      )
      const leaseEnvelope = encodeTurnLeaseEnvelope(
        l,
        sign(null, turnLeaseSigningInput(l), privateKey),
      )

      const events: EngineEvent[] = []
      const params: TurnParams = {
        input: prompt,
        requestId,
        turnKey,
        modelAuthority: {
          authorityEnvelope,
          leaseEnvelope,
          executionDescriptor: {
            executionBackend: remotePoolBackendOf(placed.binding),
            canonicalModel,
            contextWindow: 200_000,
            capabilityZero: false,
            supportsThinking: true,
            supportsVision: true,
            supportedEfforts: ['low', 'medium', 'high'],
          },
        },
        onEvent: (ev) => events.push(ev),
        sessionTotals,
        toolUseIdToName,
      }
      const run = adapter.submitTurn(params)
      run.submitted.catch(() => {})
      return {
        requestId,
        authorityTurnId,
        turnKey,
        authorityEnvelope,
        leaseEnvelope,
        events,
        run,
      }
    }

    const getFenceDiag = (): string => {
      const files = existsSync(journalDir)
        ? readdirSync(journalDir).filter((f) => f.endsWith('-fence.json'))
        : []
      const details = files.map((f) => readFileSync(join(journalDir, f), 'utf8')).join(';')
      return `relayFence=${relay.fenceReason ?? 'none'} adapterFence=${adapter.fenceError?.message ?? 'none'} adapterErrors=${adapterErrors.join('|') || 'none'} journal=${details}`
    }

    let closed = false
    const handle: SessionLaneHandle = {
      placed,
      sandboxPrep: sessionPrep,
      containerCwd,
      containerHome,
      containerExecRoot,
      journalDir,
      socketPath,
      host,
      relay,
      adapter,
      executedCalls,
      settledReceipts,
      billingEvents,
      stopNotifications,
      getFenceDiag,
      submitTurn,
      closeLane: async () => {
        if (closed) return
        closed = true
        openLanes.delete(handle)
        await adapter.shutdown().catch(() => {})
        await relay.stop().catch(() => {})
        relay.controlServer.closeAllConnections()
        await new Promise<void>((res) => relay.controlServer.close(() => res()))
        if (autoStopState) {
          const cur = await pool.query(
            'SELECT state FROM remote_agent_bindings WHERE operation_id = $1',
            [placed.binding.operationId],
          )
          if (cur.rows[0]?.state === 'preparing') {
            await recordRemoteDriverLaneState(
              placed.binding.operationId,
              placed.generation,
              'released',
              pool,
            ).catch(() => {})
          }
        }
      },
    }
    openLanes.add(handle)
    return handle
  }

  return {
    driverId,
    registryPath: opts.registryPath,
    reg,
    pool,
    sandbox,
    resRoot,
    fakeSys,
    evidenceSpoolRoot,
    uid,
    nodeId,
    profileId,
    profileName,
    authEpoch,
    peerDriverId,
    peerProfileId,
    peerCanonicalModel: peerPrep.canonicalModel,
    canonicalModel,
    upstreamModel,
    expectedPolicySha256,
    probedSnapshot: probed.snapshot,
    probeFingerprint: probed.probeFingerprint,
    usagePolicy,
    worker,
    openLane,
    getUserCredits: async () =>
      BigInt((await pool.query('SELECT credits::text FROM users WHERE id = $1', [uid])).rows[0].credits),
    recoverSpool: () =>
      recoverRemoteNativeTurnBilling(
        { pool, preCheckRedis: fakeRedis, log: silentLog },
        { evidenceRoot: evidenceSpoolRoot },
      ),
    recoverV4Only: () =>
      recoverRemoteDriverTurnBilling(
        { pool, preCheckRedis: fakeRedis, log: silentLog },
        { evidenceRoot: evidenceSpoolRoot },
      ),
    close: async () => {
      closingHarness = true
      for (const lane of [...openLanes]) {
        await lane.closeLane().catch(() => {})
      }
      await Promise.allSettled([
        ...retiredHostCloses,
        ...[...allPooledRealHosts].map((ph) => ph.close().catch(() => {})),
      ])
      allPooledRealHosts.clear()
      retiredHostCloses.length = 0
      idleRealHosts.length = 0
      await worker.close().catch(() => {})
      await pool.end().catch(() => {})
      await closePool().catch(() => {})
      await adminExec(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dedicatedDbName}' AND pid <> pg_backend_pid()`,
      ).catch(() => {})
      await adminExec(`DROP DATABASE IF EXISTS ${dedicatedDbName}`).catch(() => {})
      rmSync(sandbox, { recursive: true, force: true })
    },
  }
}
