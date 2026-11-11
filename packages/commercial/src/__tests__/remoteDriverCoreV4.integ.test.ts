/**
 * Real-PostgreSQL integration suite for `remote-driver-v4` commercial master modules (`OCV5-749`):
 * - `0339_remote_driver_core_v4.sql` schema & v3 -> v4 sticky/thread continuity (`AC-5`)
 * - `placeRemoteDriverLane` `(node, engine, profile)` cap=5, same-account overlap & cross-engine independence (`AC-1` G6, `AC-4`, `AC-6`)
 * - `createRemoteDriverTurnFinance` + `recoverRemoteDriverTurnBilling` (`per_turn` & `cumulative` `RemoteReceiptV4` ledger accuracy, conflict/drop rejection, spool recovery) (`AC-1` G5, `AC-6`, `AC-7`, `AC-8`)
 * - `driftCoordinator` (`recordDriverProbeSnapshot`, `claimDriverVerificationRun`, `completeDriverVerificationRun` 7-invariant CAS & deduplicated failure alerts) (`AC-3`)
 * - `RemoteReleaseDrainCoordinator` cutover drain & timeout safety (`AC-5`)
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  buildRemoteReceiptV4,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  zeroCountersForUsagePolicy,
  type ModelAuthorityPayload,
  type RemoteDriverUsagePolicy,
  type RemoteProbeSnapshot,
  type TurnLease,
} from '@openclaude/protocol'
import {
  buildCodexReceipt,
  codexBackend,
  zeroNativeTokens,
  type CodexRemoteBinding,
} from '@openclaude/gateway/remote-finance'
import { remotePoolBackendOf, type RemotePoolBinding } from '@openclaude/gateway/remote-pool'
import { EVENTS } from '../admin/alertEvents.js'
import {
  RemoteReleaseDrainCoordinator,
  claimDriverVerificationRun,
  completeDriverVerificationRun,
  computeProbeFingerprintTs,
  loadRemoteDriverRegistry,
  placeRemoteDriverLane,
  recordDriverProbeSnapshot,
  recordRemoteDriverLaneState,
  verificationSessionKeyForRun,
} from '../account-pool/remotePool/index.js'
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
} from '../billing/modelCatalog.js'
import {
  createRemoteDriverTurnFinance,
  recoverRemoteDriverTurnBilling,
} from '../billing/remoteDriverTurnBilling.js'
import {
  createRemoteNativeTurnFinance,
  recoverRemoteNativeTurnBilling,
} from '../billing/remoteNativeTurnBilling.js'
import { closePool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { createLogger } from '../logging/logger.js'
import { resetAndMigrateBefore } from './helpers/db.js'

const url = process.env.TEST_DATABASE_URL
assert.ok(url && new URL(url).pathname.endsWith('_test'), 'explicit isolated TEST_DATABASE_URL required')
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000 })

const CC_CANONICAL = 'claude-sonnet-5-remote'
const CC_UPSTREAM = 'claude-sonnet-5'
const CODEX_CANONICAL = 'gpt-6-luna-remote'
const CODEX_UPSTREAM = 'gpt-6-luna'
const POLICY_SHA = '1'.repeat(64)
const EVIDENCE_SHA = '2'.repeat(64)

const CC_USAGE_POLICY: RemoteDriverUsagePolicy = {
  semanticsId: 'cc-result-per-turn-v1',
  mode: 'per_turn',
  inputField: 'input_tokens',
  outputField: 'output_tokens',
  cacheReadField: 'cache_read_input_tokens',
  cacheWriteField: 'cache_creation_input_tokens',
  inputIncludesCacheRead: false,
  outputIncludesReasoning: true,
  allowCacheWrite: true,
}

const CODEX_USAGE_POLICY: RemoteDriverUsagePolicy = {
  semanticsId: 'codex-thread-total-v1',
  mode: 'cumulative',
  inputField: 'inputTokens',
  outputField: 'outputTokens',
  cacheReadField: 'cachedInputTokens',
  cacheWriteField: 'cacheWriteInputTokens',
  reasoningField: 'reasoningOutputTokens',
  inputIncludesCacheRead: true,
  outputIncludesReasoning: true,
  allowCacheWrite: false,
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const keyId = 'mak1_v4testkey000001'
const keys = new Map([
  [keyId, new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
])

const baseCap = {
  supportsVision: true,
  reasoning: { supported: ['low', 'medium', 'high'] as const, codexModelDefault: 'medium' as const },
  ccb: { capabilityZero: false, supportsThinking: true },
}

const ccEntry: ModelCatalogEntry = {
  entryId: 101,
  modelId: CC_CANONICAL,
  engine: 'ccb',
  providerId: 'anthropic',
  placement: 'remote_pool',
  upstreamModelId: CC_UPSTREAM,
  contextWindow: 200_000,
  capabilityProfile: baseCap,
  capabilitySchemaVersion: 1,
  state: 'active',
  lockVersion: 0,
}

const codexEntry: ModelCatalogEntry = {
  entryId: 102,
  modelId: CODEX_CANONICAL,
  engine: 'codex',
  providerId: 'codex',
  placement: 'remote_pool',
  upstreamModelId: CODEX_UPSTREAM,
  contextWindow: 200_000,
  capabilityProfile: baseCap,
  capabilitySchemaVersion: 1,
  state: 'active',
  lockVersion: 0,
}

const catalog = new ModelCatalogSnapshot({
  entries: [ccEntry, codexEntry],
  aliases: new Map(),
  securityEpoch: 7n,
  pricing: new Map([
    [
      CC_CANONICAL,
      {
        modelId: CC_CANONICAL,
        displayName: 'Claude Sonnet 5 Remote',
        inputPerMtok: 1_000n,
        outputPerMtok: 5_000n,
        cacheReadPerMtok: 100n,
        cacheWritePerMtok: 1_250n,
        multiplier: '1.000',
        visibility: 'public',
        sortOrder: 10,
        defaultEffort: 'medium',
      },
    ],
    [
      CODEX_CANONICAL,
      {
        modelId: CODEX_CANONICAL,
        displayName: 'GPT-6 Luna Remote',
        inputPerMtok: 600n,
        outputPerMtok: 2_400n,
        cacheReadPerMtok: 120n,
        cacheWritePerMtok: 750n,
        multiplier: '1.000',
        visibility: 'public',
        sortOrder: 20,
        defaultEffort: 'medium',
      },
    ],
  ]),
})

function makeSnapshot(
  driverId: 'cc' | 'codex',
  cliSha256 = 'a'.repeat(64),
  cliVersion = '1.0.0',
): RemoteProbeSnapshot {
  const reg = loadRemoteDriverRegistry().get(driverId)!
  const upstreamModelId = driverId === 'cc' ? CC_UPSTREAM : CODEX_UPSTREAM
  return {
    schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: reg.engineId,
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    source: `${driverId}:live-probe`,
    freshness: 'cli-observed',
    observedAt: '2026-11-11T04:00:00Z',
    cliVersion,
    cliSha256,
    ...(driverId === 'cc' ? { bridgeSha256: 'b'.repeat(64) } : {}),
    authPresent: true,
    accountObserved: true,
    rawResponseSha256: 'c'.repeat(64),
    models: [
      {
        upstreamModelId,
        displayName: upstreamModelId,
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsAdaptiveThinking: true,
        supportsVision: true,
      },
    ],
  }
}

async function verifyProfileToReady(
  profileId: string,
  driverId: 'cc' | 'codex',
  cliSha256 = 'a'.repeat(64),
): Promise<string> {
  const snapshot = makeSnapshot(driverId, cliSha256)
  const recorded = await recordDriverProbeSnapshot(pool, {
    profileId,
    snapshot,
    policySha256: POLICY_SHA,
  })
  assert.ok(recorded.verificationRunId)
  const claimed = await claimDriverVerificationRun(pool, {
    leaseOwner: 'integ-verifier',
    profileId,
  })
  assert.ok(claimed && claimed.id === recorded.verificationRunId)
  const done = await completeDriverVerificationRun(pool, {
    runId: claimed.id,
    leaseOwner: 'integ-verifier',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(done.state, 'passed')
  assert.equal(done.executionReadyRestored, true)
  return recorded.fingerprint
}

async function issueSignedTurn(
  uid: string,
  binding: RemotePoolBinding,
  requestId: string,
) {
  const dispatchId = randomUUID()
  const authorityTurnId = randomUUID().replaceAll('-', '')
  const turnKey = createHash('sha256').update(`${requestId}:turnKey`).digest('hex')
  await pool.query(
    `INSERT INTO turn_dispatches
       (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
        request_hash, billing_request_id, status, agent_container_id)
     VALUES ($1, $2, $3, $4, 'main', $5, $6, $4, 'admitted', $7)`,
    [
      dispatchId,
      uid,
      binding.sessionKey,
      requestId,
      binding.canonicalModel,
      turnKey,
      Number(binding.containerDbId),
    ],
  )
  await pool.query(
    `INSERT INTO authority_turn_dispatches
       (authority_turn_id, user_id, canonical_model, session_id, dispatch_id, attempt_no)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [authorityTurnId, uid, binding.canonicalModel, binding.sessionKey, dispatchId],
  )
  const now = Date.now()
  const a: ModelAuthorityPayload = {
    v: 1,
    keyId,
    uid: Number(uid),
    containerId: Number(binding.containerDbId),
    authorityTurnId,
    connectionChallenge: 'v4-fixture',
    canonicalModel: binding.canonicalModel,
    engine: binding.authorityEngine,
    executionBackend: remotePoolBackendOf(binding),
    executionDescriptor: {
      capabilityProfile: baseCap,
      capabilitySchemaVersion: 1,
      contextWindow: 200_000,
      supportsVision: true,
      supportedEfforts: ['low', 'medium', 'high'],
      ...(binding.authorityEngine === 'codex' ? { codexDefaultEffort: 'medium' } : {}),
    },
    executionRevision: catalog.executionRevision,
    securityEpoch: 7,
    billingRequestId: requestId,
    issuedAt: now,
    expiresAt: now + 60_000,
  }
  const l: TurnLease = {
    v: 1,
    keyId,
    uid: Number(uid),
    containerId: Number(binding.containerDbId),
    authorityTurnId,
    connectionChallenge: 'v4-fixture',
    canonicalModel: binding.canonicalModel,
    securityEpoch: 7,
    issuedAt: now,
    expiresAt: now + 600_000,
  }
  return {
    requestId,
    authorityTurnId,
    turnKey,
    authorityEnvelope: encodeAuthorityEnvelope(a, sign(null, authoritySigningInput(a), privateKey)),
    leaseEnvelope: encodeTurnLeaseEnvelope(l, sign(null, turnLeaseSigningInput(l), privateKey)),
  }
}

let nodeId: string
let ccProfileId: string
let codexProfileId: string
let uid: string

before(async () => {
  assert.match((await pool.query('SELECT current_database() AS db')).rows[0].db, /_test$/)
  setPoolOverride(pool)
  await resetAndMigrateBefore('0338')
  const applied = await runMigrations()
  assert.ok(applied.applied.includes('0339_remote_driver_core_v4'))

  uid = (
    await pool.query(
      `INSERT INTO users (email, password_hash, credits)
       VALUES ('v4driver@example.test', 'test-only', 100000)
       RETURNING id::text`,
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO agent_containers (id, user_id, secret_hash)
     VALUES (7, $1, $2)`,
    [uid, Buffer.alloc(32, 7)],
  )
  nodeId = (
    await pool.query(
      `INSERT INTO remote_agent_nodes
         (label, ssh_host, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ('v4-node-1', '10.0.0.77', 'box', 'SHA256:v4test', 'v4key', 'v4ctrl', 'active')
       RETURNING id::text`,
    )
  ).rows[0].id

  ccProfileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode, auth_epoch)
       VALUES ($1, 'cc', 'cc-acct-1', 'cc-fp-1', 'interactive', 'epoch-cc-1')
       RETURNING id::text`,
      [nodeId],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, 'Sonnet 5')`,
    [ccProfileId, CC_UPSTREAM, CC_CANONICAL],
  )

  codexProfileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode, auth_epoch)
       VALUES ($1, 'codex', 'codex-acct-1', 'codex-fp-1', 'app-server', 'epoch-codex-1')
       RETURNING id::text`,
      [nodeId],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, 'GPT-6 Luna')`,
    [codexProfileId, CODEX_UPSTREAM, CODEX_CANONICAL],
  )

  await verifyProfileToReady(ccProfileId, 'cc')
  await verifyProfileToReady(codexProfileId, 'codex')
})

after(async () => {
  await closePool()
})

test('v4 placement enforces (node, engine, profile) cap=5, same-account 2-session overlap, cross-engine independence, and sticky v3->v4 upgrade', async () => {
  const baseReq = { uid, containerDbId: '7', dockerId: 'a'.repeat(64) }

  // 1. Two concurrent sessions on the SAME CC account overlap with distinct operationIds & roots (no account-wide lock).
  const [cc1, cc2] = await Promise.all([
    placeRemoteDriverLane(
      { ...baseReq, sessionKey: 'agent:main:webchat:dm:cc_overlap_1', canonicalModel: CC_CANONICAL, driverId: 'cc' },
      { pool, localSandboxDir: '/tmp/oc-drvtest-integ' },
    ),
    placeRemoteDriverLane(
      { ...baseReq, sessionKey: 'agent:main:webchat:dm:cc_overlap_2', canonicalModel: CC_CANONICAL, driverId: 'cc' },
      { pool, localSandboxDir: '/tmp/oc-drvtest-integ' },
    ),
  ])
  assert.notEqual(cc1.binding.operationId, cc2.binding.operationId)
  assert.notEqual(cc1.spec.manifest.root, cc2.spec.manifest.root)
  assert.equal(cc1.binding.profileId, 'cc-acct-1')
  assert.equal(cc2.binding.profileId, 'cc-acct-1')

  // 2. Fill remaining 3 CC slots (total 5) and verify the 6th is rejected, while Codex on the SAME node still admits all 5!
  const ccMore = await Promise.all(
    [3, 4, 5].map((i) =>
      placeRemoteDriverLane(
        { ...baseReq, sessionKey: `agent:main:webchat:dm:cc_overlap_${i}`, canonicalModel: CC_CANONICAL, driverId: 'cc' },
        { pool },
      ),
    ),
  )
  await recordRemoteDriverLaneState(cc1.binding.operationId, cc1.generation, 'unknown', pool)
  // Stale generation release frees nothing; fenced generation cannot transition to 'running'.
  await recordRemoteDriverLaneState(cc1.binding.operationId, '999', 'released', pool)
  assert.equal(
    (await pool.query('SELECT state FROM remote_agent_bindings WHERE operation_id = $1', [cc1.binding.operationId]))
      .rows[0].state,
    'unknown',
  )
  await assert.rejects(
    recordRemoteDriverLaneState(cc1.binding.operationId, '999', 'running', pool),
    /REMOTE_LANE_GENERATION_FENCED/,
  )
  await assert.rejects(
    placeRemoteDriverLane(
      { ...baseReq, sessionKey: 'agent:main:webchat:dm:cc_overlap_6', canonicalModel: CC_CANONICAL, driverId: 'cc' },
      { pool },
    ),
    /REMOTE_LANE_CAPACITY_EXHAUSTED/,
  )

  const codexFive = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      placeRemoteDriverLane(
        { ...baseReq, sessionKey: `agent:main:webchat:dm:codex_indep_${i}`, canonicalModel: CODEX_CANONICAL, driverId: 'codex' },
        { pool },
      ),
    ),
  )
  assert.equal(codexFive.length, 5)
  await assert.rejects(
    placeRemoteDriverLane(
      { ...baseReq, sessionKey: 'agent:main:webchat:dm:codex_indep_6', canonicalModel: CODEX_CANONICAL, driverId: 'codex' },
      { pool },
    ),
    /REMOTE_LANE_CAPACITY_EXHAUSTED/,
  )

  // Cleanup active lanes from step 1 & 2.
  for (const lane of [cc1, cc2, ...ccMore, ...codexFive]) {
    await recordRemoteDriverLaneState(lane.binding.operationId, lane.generation, 'released', pool)
  }

  // 3. Sticky legacy v3 binding (`driver_id IS NULL`, `remote_protocol_version = 3`) upgrades cleanly to v4 generation+1.
  const legacyOpId = randomUUID()
  const legacyRunId = randomUUID()
  await pool.query(
    `INSERT INTO remote_agent_bindings
       (operation_id, run_id, uid, container_db_id, docker_id, session_key,
        node_id, profile_id, canonical_model_id, native_session_id, state,
        expires_at, engine, backend_kind, generation, auth_epoch, remote_protocol_version)
     VALUES ($1, $2, $3, 7, $4, 'agent:main:webchat:dm:sticky_v3_upgrade',
             $5, $6, $7, 'legacy-codex-sess-77', 'released',
             NOW() + INTERVAL '1 hour', 'codex', 'codex-app-server-v1', 3, 'epoch-codex-1', 3)`,
    [legacyOpId, legacyRunId, uid, 'a'.repeat(64), nodeId, codexProfileId, CODEX_CANONICAL],
  )

  const upgraded = await placeRemoteDriverLane(
    {
      ...baseReq,
      sessionKey: 'agent:main:webchat:dm:sticky_v3_upgrade',
      canonicalModel: CODEX_CANONICAL,
      driverId: 'codex',
    },
    { pool },
  )
  assert.equal(upgraded.binding.operationId, legacyOpId)
  assert.equal(upgraded.binding.runId, legacyRunId)
  assert.equal(upgraded.generation, '4')
  assert.equal(upgraded.spec.manifest.nativeSessionId, 'legacy-codex-sess-77')
  const dbUpgraded = (
    await pool.query(
      `SELECT remote_protocol_version, backend_kind, driver_id, engine_id, generation::text
         FROM remote_agent_bindings
        WHERE operation_id = $1`,
      [legacyOpId],
    )
  ).rows[0]
  assert.equal(dbUpgraded.remote_protocol_version, 4)
  assert.equal(dbUpgraded.backend_kind, REMOTE_DRIVER_BACKEND)
  assert.equal(dbUpgraded.driver_id, 'codex')
  assert.equal(dbUpgraded.engine_id, 'codex')
  assert.equal(dbUpgraded.generation, '4')
  await recordRemoteDriverLaneState(upgraded.binding.operationId, upgraded.generation, 'released', pool)
})

test('ReceiptV4 per_turn (cc) and cumulative (codex) settle exact ledger credits, deduplicate identical terminals, reject conflicts/drops, and recover from crash spool', async () => {
  const redis = { eval: async () => 0 } as any
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'v4-spool-recovery-'))
  let failTurnInsert = false

  const faultPool = new Proxy(pool, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          const c = await target.connect()
          return new Proxy(c, {
            get(t, p) {
              if (p === 'query') {
                return async (...args: any[]) => {
                  if (failTurnInsert && String(args[0]).includes('INSERT INTO remote_native_turns')) {
                    throw new Error('simulated-crash-before-receipt-commit')
                  }
                  return (t.query as any)(...args)
                }
              }
              const val = Reflect.get(t, p)
              return typeof val === 'function' ? val.bind(t) : val
            },
          })
        }
      }
      const val = Reflect.get(target, prop)
      return typeof val === 'function' ? val.bind(target) : val
    },
  })

  const makeFinance = () =>
    createRemoteDriverTurnFinance(
      {
        pool: faultPool,
        preCheckRedis: redis,
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
        log: createLogger({ out: () => {} }),
      },
      { reserve: async () => ({ maxCost: 100n }) as any, release: async () => true },
    )

  const creditsBefore = BigInt(
    (await pool.query('SELECT credits::text FROM users WHERE id = $1', [uid])).rows[0].credits,
  )

  // --- Part A: CC `per_turn` multi-turn settlement (must NOT subtract previous turn's counters) ---
  const ccPlacement = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:cc_v4_billing',
      canonicalModel: CC_CANONICAL,
      driverId: 'cc',
    },
    { pool },
  )
  const ccPort = makeFinance()
  for (let i = 0; i < 2; i++) {
    const signed = await issueSignedTurn(uid, ccPlacement.binding, `ccv4req_${i}_${randomUUID().slice(0, 8)}`)
    const turn = await ccPort.admit({
      binding: ccPlacement.binding,
      usagePolicy: CC_USAGE_POLICY,
      sessionKey: ccPlacement.binding.sessionKey,
      turnKey: signed.turnKey,
      authorityEnvelope: signed.authorityEnvelope,
      leaseEnvelope: signed.leaseEnvelope,
    })
    await turn.beforeHostStart()
    const base = await turn.bindNativeThread('cc-native-sess-1', i === 0)
    assert.equal(base, null)
    await turn.beforeDispatch({ sequence: i + 1, inputSha256: signed.turnKey })
    const receipt = buildRemoteReceiptV4({
      engineId: ccPlacement.binding.engineId,
      driverId: ccPlacement.binding.driverId,
      driverVersion: ccPlacement.binding.driverVersion,
      driverDigest: ccPlacement.binding.driverDigest,
      uid,
      containerDbId: '7',
      dockerId: ccPlacement.binding.dockerId,
      operationId: ccPlacement.binding.operationId,
      runId: ccPlacement.binding.runId,
      sessionKey: ccPlacement.binding.sessionKey,
      canonicalModel: CC_CANONICAL,
      upstreamModel: CC_UPSTREAM,
      profileId: ccPlacement.binding.profileId,
      authEpoch: ccPlacement.binding.authEpoch,
      authorityTurnId: signed.authorityTurnId,
      turnKey: signed.turnKey,
      requestId: signed.requestId,
      nativeSessionId: 'cc-native-sess-1',
      terminalId: `cc-res-uuid-${i}`,
      policy: CC_USAGE_POLICY,
      countersBaseline: null,
      countersFinal: {
        input_tokens: 2_000_000, // 2M * 1000 / 1M = 2000 credits
        output_tokens: 1_000_000, // 1M * 5000 / 1M = 5000 credits
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      nativeStatus: 'success',
      rawEvidenceDigest: remoteCanonicalSha256({ turn: i }),
      provenance: {
        generation: ccPlacement.generation,
        manifestHash: ccPlacement.binding.manifestSha256,
        coreDigest: ccPlacement.binding.coreDigest,
        probeFingerprint: ccPlacement.binding.probeFingerprint,
      },
    })
    // Duplicate identical terminal calls settle once and return identical proven outcome.
    const dupOutcomes = await Promise.all([
      turn.terminal(structuredClone(receipt)),
      turn.terminal(structuredClone(receipt)),
    ])
    assert.deepEqual(dupOutcomes, [
      { state: 'proven', requestId: signed.requestId },
      { state: 'proven', requestId: signed.requestId },
    ])
    // Conflicting terminal payload on same turn is rejected synchronously.
    assert.throws(
      () =>
        turn.terminal(
          buildRemoteReceiptV4({
            ...receipt,
            policy: CC_USAGE_POLICY,
            countersFinal: {
              input_tokens: 2_000_001,
              output_tokens: 1_000_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }),
        ),
      /REMOTE_RECEIPT_CONFLICT/,
    )
    const uRows = (
      await pool.query(
        'SELECT cost_credits::text, input_tokens::text, output_tokens::text FROM usage_records WHERE request_id = $1',
        [signed.requestId],
      )
    ).rows
    assert.equal(uRows.length, 1)
    assert.equal(uRows[0].cost_credits, '7000')
  }
  await recordRemoteDriverLaneState(ccPlacement.binding.operationId, ccPlacement.generation, 'released', pool)

  // Both CC per-turn requests charged 7000 each = 14000 total.
  const creditsAfterCc = BigInt(
    (await pool.query('SELECT credits::text FROM users WHERE id = $1', [uid])).rows[0].credits,
  )
  assert.equal(creditsBefore - creditsAfterCc, 14_000n)

  // --- Part B: Codex `cumulative` settlement + crash spool recovery + counter-drop rejection ---
  const codexPlacement = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:codex_v4_billing',
      canonicalModel: CODEX_CANONICAL,
      driverId: 'codex',
    },
    { pool },
  )
  const codexPort = makeFinance()
  const cTotals = [
    { inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteInputTokens: 0, outputTokens: 500_000, reasoningOutputTokens: 200_000 },
    { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 0, outputTokens: 1_000_000, reasoningOutputTokens: 400_000 },
  ]
  for (let i = 0; i < 2; i++) {
    const signed = await issueSignedTurn(uid, codexPlacement.binding, `cdxv4req_${i}_${randomUUID().slice(0, 8)}`)
    const turn = await codexPort.admit({
      binding: codexPlacement.binding,
      usagePolicy: CODEX_USAGE_POLICY,
      sessionKey: codexPlacement.binding.sessionKey,
      turnKey: signed.turnKey,
      authorityEnvelope: signed.authorityEnvelope,
      leaseEnvelope: signed.leaseEnvelope,
    })
    await turn.beforeHostStart()
    const base = await turn.bindNativeThread('codex-native-sess-1', i === 0)
    assert.deepEqual(base, i === 0 ? zeroCountersForUsagePolicy(CODEX_USAGE_POLICY) : cTotals[i - 1])
    await turn.beforeDispatch({ sequence: i + 1, inputSha256: signed.turnKey })
    const receipt = buildRemoteReceiptV4({
      engineId: codexPlacement.binding.engineId,
      driverId: codexPlacement.binding.driverId,
      driverVersion: codexPlacement.binding.driverVersion,
      driverDigest: codexPlacement.binding.driverDigest,
      uid,
      containerDbId: '7',
      dockerId: codexPlacement.binding.dockerId,
      operationId: codexPlacement.binding.operationId,
      runId: codexPlacement.binding.runId,
      sessionKey: codexPlacement.binding.sessionKey,
      canonicalModel: CODEX_CANONICAL,
      upstreamModel: CODEX_UPSTREAM,
      profileId: codexPlacement.binding.profileId,
      authEpoch: codexPlacement.binding.authEpoch,
      authorityTurnId: signed.authorityTurnId,
      turnKey: signed.turnKey,
      requestId: signed.requestId,
      nativeSessionId: 'codex-native-sess-1',
      terminalId: `codex-turn-${i}`,
      policy: CODEX_USAGE_POLICY,
      countersBaseline: base,
      countersFinal: cTotals[i]!,
      nativeStatus: 'success',
      rawEvidenceDigest: remoteCanonicalSha256({ codexTurn: i }),
      provenance: {
        generation: codexPlacement.generation,
        manifestHash: codexPlacement.binding.manifestSha256,
        coreDigest: codexPlacement.binding.coreDigest,
        probeFingerprint: codexPlacement.binding.probeFingerprint,
      },
    })

    if (i === 1) {
      // Simulate process crash before PG receipt persistence; spool file recovers via `recoverRemoteNativeTurnBilling`.
      failTurnInsert = true
      const crashed = await turn.terminal(receipt)
      assert.equal(crashed.state, 'pending')
      failTurnInsert = false
      const journalDir = join(
        evidenceRoot,
        codexPlacement.binding.operationId,
        codexPlacement.generation,
        'journal',
      )
      mkdirSync(journalDir, { recursive: true })
      writeFileSync(join(journalDir, '00000002-native-terminal.json'), JSON.stringify(receipt), {
        mode: 0o600,
      })
      const recovered = await recoverRemoteNativeTurnBilling(
        { pool, preCheckRedis: redis, log: createLogger({ out: () => {} }) },
        { evidenceRoot },
      )
      assert.deepEqual(recovered, { proven: 1, pending: 0 })
    } else {
      const ok = await turn.terminal(receipt)
      assert.equal(ok.state, 'proven')
    }

    // Each turn has delta: 500k uncached input (300) + 500k cacheRead (60) + 500k output (1200; reasoning NOT added) = 1560 credits.
    const uRow = (
      await pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
        signed.requestId,
      ])
    ).rows[0]
    assert.equal(uRow.cost_credits, '1560')
  }

  // Counter-drop on cumulative receipt fails closed at construction/validation with zero extra usage rows.
  assert.throws(
    () =>
      buildRemoteReceiptV4({
        engineId: 'codex',
        driverId: 'codex',
        driverVersion: codexPlacement.binding.driverVersion,
        driverDigest: codexPlacement.binding.driverDigest,
        uid,
        containerDbId: '7',
        dockerId: codexPlacement.binding.dockerId,
        operationId: codexPlacement.binding.operationId,
        runId: codexPlacement.binding.runId,
        sessionKey: codexPlacement.binding.sessionKey,
        canonicalModel: CODEX_CANONICAL,
        upstreamModel: CODEX_UPSTREAM,
        profileId: codexPlacement.binding.profileId,
        authEpoch: codexPlacement.binding.authEpoch,
        authorityTurnId: 'f'.repeat(32),
        turnKey: 'e'.repeat(64),
        requestId: 'drop_req_1',
        nativeSessionId: 'codex-native-sess-1',
        terminalId: 'codex-turn-drop',
        policy: CODEX_USAGE_POLICY,
        countersBaseline: cTotals[1]!,
        countersFinal: { ...cTotals[1]!, inputTokens: cTotals[1]!.inputTokens - 1 },
        nativeStatus: 'success',
        rawEvidenceDigest: 'd'.repeat(64),
        provenance: {
          generation: codexPlacement.generation,
          manifestHash: codexPlacement.binding.manifestSha256,
          coreDigest: codexPlacement.binding.coreDigest,
          probeFingerprint: codexPlacement.binding.probeFingerprint,
        },
      }),
    /REMOTE_USAGE_COUNTER_DECREASED/,
  )

  assert.deepEqual(
    await recoverRemoteDriverTurnBilling(
      { pool, preCheckRedis: redis, log: createLogger({ out: () => {} }) },
      { evidenceRoot },
    ),
    { proven: 0, pending: 0 },
  )
  await recordRemoteDriverLaneState(codexPlacement.binding.operationId, codexPlacement.generation, 'released', pool)
  rmSync(evidenceRoot, { recursive: true, force: true })
})

test('legacy v3 cumulative thread resumes seamlessly into v4 codex without baseline reset and rejects incompatible usage semantics', async () => {
  const redis = { eval: async () => 0 } as any
  const sessionKey = 'agent:main:webchat:dm:v3_to_v4_thread_resume'
  const operationId = randomUUID()
  const runId = randomUUID()

  // 1. Settle Turn 1 on legacy v3 `codex-app-server-v1` (`remoteNativeTurnBilling.ts`), leaving `usage_mode/usage_semantics` NULL.
  const v3Binding: CodexRemoteBinding = {
    version: 3,
    backendKind: 'codex-app-server-v1',
    uid,
    containerDbId: '7',
    dockerId: 'a'.repeat(64),
    operationId,
    runId,
    sessionKey,
    canonicalModel: CODEX_CANONICAL,
    generation: '1',
    profileId: 'codex-acct-1',
    authEpoch: 'epoch-codex-1',
    manifestSha256: 'f'.repeat(64),
    capability: 'f'.repeat(64),
    expiresAt: Date.now() + 3_600_000,
  }
  await pool.query(
    `INSERT INTO remote_agent_bindings
       (operation_id, run_id, uid, container_db_id, docker_id, session_key,
        node_id, profile_id, canonical_model_id, native_session_id, state,
        expires_at, engine, backend_kind, generation, auth_epoch, remote_protocol_version)
     VALUES ($1, $2, $3, 7, $4, $5, $6, $7, $8, 'shared-thread-v3-v4', 'released',
             NOW() + INTERVAL '1 hour', 'codex', 'codex-app-server-v1', 1, 'epoch-codex-1', 3)`,
    [operationId, runId, uid, v3Binding.dockerId, sessionKey, nodeId, codexProfileId, CODEX_CANONICAL],
  )

  const legacyPort = createRemoteNativeTurnFinance(
    {
      pool,
      upstreamModel: CODEX_UPSTREAM,
      preCheckRedis: redis,
      keyring: keys,
      catalog: { assertFresh: async () => catalog } as unknown as ModelCatalogCache,
      loadUserModelAuthz: async (userId) => ({
        uid: userId,
        role: 'user',
        grantedModelIds: new Set<string>(),
        deniedModelIds: new Set<string>(),
        userPlanTier: null,
        orgPlanCode: null,
      }),
      log: createLogger({ out: () => {} }),
    },
    { reserve: async () => ({ maxCost: 100n }) as any, release: async () => true },
  )

  const v3Req = `v3leg_${randomUUID().slice(0, 8)}`
  const v3Dispatch = randomUUID()
  const v3Auth = randomUUID().replaceAll('-', '')
  const v3TurnKey = createHash('sha256').update(v3Req).digest('hex')
  await pool.query(
    `INSERT INTO turn_dispatches
       (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
        request_hash, billing_request_id, status, agent_container_id)
     VALUES ($1, $2, $3, $4, 'main', $5, $6, $4, 'admitted', 7)`,
    [v3Dispatch, uid, sessionKey, v3Req, CODEX_CANONICAL, v3TurnKey],
  )
  await pool.query(
    `INSERT INTO authority_turn_dispatches
       (authority_turn_id, user_id, canonical_model, session_id, dispatch_id, attempt_no)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [v3Auth, uid, CODEX_CANONICAL, sessionKey, v3Dispatch],
  )
  const now = Date.now()
  const v3Authority: ModelAuthorityPayload = {
    v: 1,
    keyId,
    uid: Number(uid),
    containerId: 7,
    authorityTurnId: v3Auth,
    connectionChallenge: 'v3-fixture',
    canonicalModel: CODEX_CANONICAL,
    engine: 'codex',
    executionBackend: codexBackend(v3Binding),
    executionDescriptor: {
      capabilityProfile: baseCap,
      capabilitySchemaVersion: 1,
      contextWindow: 200_000,
      supportsVision: true,
      supportedEfforts: ['low', 'medium', 'high'],
      codexDefaultEffort: 'medium',
    },
    executionRevision: catalog.executionRevision,
    securityEpoch: 7,
    billingRequestId: v3Req,
    issuedAt: now,
    expiresAt: now + 60_000,
  }
  const v3Lease: TurnLease = {
    v: 1,
    keyId,
    uid: Number(uid),
    containerId: 7,
    authorityTurnId: v3Auth,
    connectionChallenge: 'v3-fixture',
    canonicalModel: CODEX_CANONICAL,
    securityEpoch: 7,
    issuedAt: now,
    expiresAt: now + 600_000,
  }
  const turn1 = await legacyPort.admit({
    binding: v3Binding,
    sessionKey,
    turnKey: v3TurnKey,
    authorityEnvelope: encodeAuthorityEnvelope(v3Authority, sign(null, authoritySigningInput(v3Authority), privateKey)),
    leaseEnvelope: encodeTurnLeaseEnvelope(v3Lease, sign(null, turnLeaseSigningInput(v3Lease), privateKey)),
  })
  await turn1.beforeHostStart()
  const base1 = await turn1.bindNativeThread!('shared-thread-v3-v4', true)
  assert.deepEqual(base1, zeroNativeTokens())
  await turn1.beforeDispatch({ sequence: 1, inputSha256: v3TurnKey })
  const v3Total = {
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    cacheWriteInputTokens: 0,
    outputTokens: 250_000,
    reasoningOutputTokens: 100_000,
  }
  const v3Receipt = buildCodexReceipt(
    v3Binding,
    {
      authorityTurnId: v3Auth,
      turnKey: v3TurnKey,
      upstreamModel: CODEX_UPSTREAM,
      nativeThreadId: 'shared-thread-v3-v4',
      nativeTurnId: 'v3-turn-1',
    },
    base1,
    v3Total,
    'completed',
  )
  assert.equal((await turn1.terminal(v3Receipt)).state, 'proven')

  // 2. Upgrade lane to v4 `codex` (generation 2) and settle Turn 2 — baseline MUST equal `v3Total` (never reset!).
  const v4Lane = await placeRemoteDriverLane(
    { uid, containerDbId: '7', dockerId: 'a'.repeat(64), sessionKey, canonicalModel: CODEX_CANONICAL, driverId: 'codex' },
    { pool },
  )
  assert.equal(v4Lane.binding.operationId, operationId)
  assert.equal(v4Lane.generation, '2')

  const v4Port = createRemoteDriverTurnFinance(
    {
      pool,
      preCheckRedis: redis,
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
      log: createLogger({ out: () => {} }),
    },
    { reserve: async () => ({ maxCost: 100n }) as any, release: async () => true },
  )

  const signed2 = await issueSignedTurn(uid, v4Lane.binding, `v4res_${randomUUID().slice(0, 8)}`)
  const turn2 = await v4Port.admit({
    binding: v4Lane.binding,
    usagePolicy: CODEX_USAGE_POLICY,
    sessionKey,
    turnKey: signed2.turnKey,
    authorityEnvelope: signed2.authorityEnvelope,
    leaseEnvelope: signed2.leaseEnvelope,
  })
  await turn2.beforeHostStart()
  const base2 = await turn2.bindNativeThread('shared-thread-v3-v4', false)
  assert.deepEqual(base2, v3Total)
  await turn2.beforeDispatch({ sequence: 2, inputSha256: signed2.turnKey })
  const v4Total = {
    inputTokens: 1_500_000, // delta 500k (minus 100k cached delta = 400k uncached -> 240 credits)
    cachedInputTokens: 500_000, // delta 100k -> 12 credits
    cacheWriteInputTokens: 0,
    outputTokens: 500_000, // delta 250k -> 600 credits
    reasoningOutputTokens: 150_000,
  }
  const v4Receipt = buildRemoteReceiptV4({
    engineId: v4Lane.binding.engineId,
    driverId: v4Lane.binding.driverId,
    driverVersion: v4Lane.binding.driverVersion,
    driverDigest: v4Lane.binding.driverDigest,
    uid,
    containerDbId: '7',
    dockerId: v4Lane.binding.dockerId,
    operationId,
    runId,
    sessionKey,
    canonicalModel: CODEX_CANONICAL,
    upstreamModel: CODEX_UPSTREAM,
    profileId: v4Lane.binding.profileId,
    authEpoch: v4Lane.binding.authEpoch,
    authorityTurnId: signed2.authorityTurnId,
    turnKey: signed2.turnKey,
    requestId: signed2.requestId,
    nativeSessionId: 'shared-thread-v3-v4',
    terminalId: 'v4-turn-2',
    policy: CODEX_USAGE_POLICY,
    countersBaseline: base2,
    countersFinal: v4Total,
    nativeStatus: 'success',
    rawEvidenceDigest: '9'.repeat(64),
    provenance: {
      generation: v4Lane.generation,
      manifestHash: v4Lane.binding.manifestSha256,
      coreDigest: v4Lane.binding.coreDigest,
      probeFingerprint: v4Lane.binding.probeFingerprint,
    },
  })
  assert.equal((await turn2.terminal(v4Receipt)).state, 'proven')
  const turn2Usage = (
    await pool.query('SELECT cost_credits::text FROM usage_records WHERE request_id = $1', [
      signed2.requestId,
    ])
  ).rows[0]
  assert.equal(turn2Usage.cost_credits, '852') // 240 + 12 + 600 = 852 (exact delta, NOT full 1.5M cumulative!)

  // 3. Attempting to resume that cumulative thread under an incompatible semanticsId fails closed!
  const signedBad = await issueSignedTurn(uid, v4Lane.binding, `v4bad_${randomUUID().slice(0, 8)}`)
  const turnBad = await v4Port.admit({
    binding: v4Lane.binding,
    usagePolicy: { ...CODEX_USAGE_POLICY, semanticsId: 'incompatible-semantics-v9' },
    sessionKey,
    turnKey: signedBad.turnKey,
    authorityEnvelope: signedBad.authorityEnvelope,
    leaseEnvelope: signedBad.leaseEnvelope,
  })
  await turnBad.beforeHostStart()
  await assert.rejects(
    turnBad.bindNativeThread('shared-thread-v3-v4', false),
    /REMOTE_USAGE_SEMANTICS_INCOMPATIBLE/,
  )
  await turnBad.abandonUndispatched()
  await recordRemoteDriverLaneState(operationId, v4Lane.generation, 'released', pool)
})

test('undispatched cancel and node admission rejection abort journals at zero cost and free native thread claims', async () => {
  const redis = { eval: async () => 0 } as any
  const lane = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:v4_abandon_and_mem_reject',
      canonicalModel: CODEX_CANONICAL,
      driverId: 'codex',
    },
    { pool },
  )
  const port = createRemoteDriverTurnFinance(
    {
      pool,
      preCheckRedis: redis,
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
      log: createLogger({ out: () => {} }),
    },
    { reserve: async () => ({ maxCost: 100n }) as any, release: async () => true },
  )

  // 1. `abandonUndispatched` after `beforeHostStart` + `bindNativeThread` clears claim & charges 0.
  const s1 = await issueSignedTurn(uid, lane.binding, `abn1_${randomUUID().slice(0, 8)}`)
  const t1 = await port.admit({
    binding: lane.binding,
    usagePolicy: CODEX_USAGE_POLICY,
    sessionKey: lane.binding.sessionKey,
    turnKey: s1.turnKey,
    authorityEnvelope: s1.authorityEnvelope,
    leaseEnvelope: s1.leaseEnvelope,
  })
  await t1.beforeHostStart()
  await t1.bindNativeThread('abandon-thread-1', true)
  assert.deepEqual(await t1.abandonUndispatched(), { state: 'proven', requestId: s1.requestId })
  const j1 = (
    await pool.query(
      'SELECT state, final_credits::text, failure_code FROM request_finalize_journal WHERE request_id = $1',
      [s1.requestId],
    )
  ).rows[0]
  assert.equal(j1.state, 'aborted')
  assert.equal(j1.final_credits, '0')
  assert.equal(j1.failure_code, 'USER_CANCELLED')
  const th1 = (
    await pool.query(
      'SELECT pending_request_id FROM remote_native_threads WHERE operation_id = $1',
      [lane.binding.operationId],
    )
  ).rows[0]
  assert.equal(th1.pending_request_id, null)

  // 2. Node memory admission rejection (`stop` with `nodeAdmissionRejected: true`) aborts cleanly at 0 credits.
  const s2 = await issueSignedTurn(uid, lane.binding, `memrej_${randomUUID().slice(0, 8)}`)
  const t2 = await port.admit({
    binding: lane.binding,
    usagePolicy: CODEX_USAGE_POLICY,
    sessionKey: lane.binding.sessionKey,
    turnKey: s2.turnKey,
    authorityEnvelope: s2.authorityEnvelope,
    leaseEnvelope: s2.leaseEnvelope,
  })
  await t2.beforeHostStart()
  await t2.stop({
    hostStartAttempted: true,
    userSubmitted: false,
    remoteStopped: true,
    nodeAdmissionRejected: true,
    nodeAdmissionReason: 'REMOTE_NODE_MEMORY_EXHAUSTED',
  })
  const j2 = (
    await pool.query(
      'SELECT state, final_credits::text, error_msg FROM request_finalize_journal WHERE request_id = $1',
      [s2.requestId],
    )
  ).rows[0]
  assert.equal(j2.state, 'aborted')
  assert.equal(j2.final_credits, '0')
  assert.equal(j2.error_msg, 'REMOTE_NODE_MEMORY_EXHAUSTED')
  await recordRemoteDriverLaneState(lane.binding.operationId, lane.generation, 'released', pool)
})

test('AC-3 drift closed-loop: probe drift withdraws ready, blocks user placement, runs leased verification, enforces all CAS guards, and deduplicates failure alerts', async () => {
  // Isolate a dedicated CC profile for drift state-machine transitions so other profiles stay unaffected.
  const driftProfileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode, auth_epoch)
       VALUES ($1, 'cc', 'cc-drift-acct', 'cc-drift-fp', 'interactive', 'epoch-drift-1')
       RETURNING id::text`,
      [nodeId],
    )
  ).rows[0].id
  const driftModel = 'claude-drift-test-remote'
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, 'Drift Sonnet')`,
    [driftProfileId, CC_UPSTREAM, driftModel],
  )
  await verifyProfileToReady(driftProfileId, 'cc', '1'.repeat(64))

  // 1. CLI upgrade (`cliSha256` changes to `222...`) -> single-tx ready withdrawal + ready_generation++ + pending run.
  const snapB = makeSnapshot('cc', '2'.repeat(64), '2.1.320')
  const driftB = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: snapB,
    policySha256: POLICY_SHA,
  })
  assert.equal(driftB.drifted, true)
  assert.equal(driftB.executionReady, false)
  assert.ok(driftB.verificationRunId)

  // Repeat probe with exact same `snapB` does NOT bump `ready_generation` or create a duplicate run.
  const repeatB = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: { ...snapB, observedAt: '2026-11-11T04:01:00Z' },
    policySha256: POLICY_SHA,
  })
  assert.equal(repeatB.drifted, false)
  assert.equal(repeatB.readyGeneration, driftB.readyGeneration)
  assert.equal(repeatB.verificationRunId, driftB.verificationRunId)

  // User admission immediately fails closed with `REMOTE_DRIVER_REVERIFY_REQUIRED`.
  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:user_blocked_by_drift',
        canonicalModel: driftModel,
        driverId: 'cc',
      },
      { pool },
    ),
    /REMOTE_DRIVER_REVERIFY_REQUIRED/,
  )

  // 2. Claim verification run & place authorized verification test lane; verify unreleased test binding blocks CAS!
  const runB = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runB && runB.id === driftB.verificationRunId)

  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:wrong_verify_session',
        canonicalModel: driftModel,
        driverId: 'cc',
        verificationRun: { runId: runB.id, leaseOwner: 'worker-drift-1' },
      },
      { pool },
    ),
    /REMOTE_VERIFICATION_SESSION_KEY_MISMATCH/,
  )

  const verifyLane = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: verificationSessionKeyForRun(runB.id),
      canonicalModel: driftModel,
      driverId: 'cc',
      verificationRun: { runId: runB.id, leaseOwner: 'worker-drift-1' },
    },
    { pool },
  )
  const blockedUnreleased = await completeDriverVerificationRun(pool, {
    runId: runB.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(blockedUnreleased.executionReadyRestored, false)
  assert.equal(blockedUnreleased.rejectReason, 'VERIFICATION_TEST_BINDING_NOT_RELEASED')
  await recordRemoteDriverLaneState(verifyLane.binding.operationId, verifyLane.generation, 'released', pool)

  // 3. Secondary drift mid-run (`FP_C` -> `FP_D`): stale verification result for `FP_C` CANNOT restore ready!
  const driftC = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: makeSnapshot('cc', '3'.repeat(64), '2.1.321'),
    policySha256: POLICY_SHA,
  })
  const runC = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runC && runC.id === driftC.verificationRunId)

  const driftD = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: makeSnapshot('cc', '4'.repeat(64), '2.1.322'),
    policySha256: POLICY_SHA,
  })
  const staleComplete = await completeDriverVerificationRun(pool, {
    runId: runC.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(staleComplete.state, 'superseded')
  assert.equal(staleComplete.executionReadyRestored, false)

  // 4. Admin disable mid-run blocks CAS restore!
  const runD = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runD && runD.id === driftD.verificationRunId)
  await pool.query(`UPDATE remote_agent_profiles SET disabled_by = 'admin' WHERE id = $1`, [driftProfileId])
  const blockedAdmin = await completeDriverVerificationRun(pool, {
    runId: runD.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(blockedAdmin.executionReadyRestored, false)
  assert.equal(blockedAdmin.rejectReason, 'ADMIN_DISABLED')
  await pool.query('UPDATE remote_agent_profiles SET disabled_by = NULL WHERE id = $1', [driftProfileId])

  // 5. Credential `auth_epoch` change marks run `auto_eligible = FALSE` so auto-worker refuses to claim it.
  const authDrift = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: makeSnapshot('cc', '5'.repeat(64), '2.1.323'),
    policySha256: POLICY_SHA,
    authEpoch: 'epoch-drift-NEW-CREDS',
  })
  assert.equal(authDrift.autoEligible, false)
  assert.equal(
    await claimDriverVerificationRun(pool, {
      leaseOwner: 'auto-worker',
      profileId: driftProfileId,
      allowManual: false,
    }),
    null,
  )

  // 6. Failed verification keeps `execution_ready = FALSE` and emits AT MOST 1 alert per `(profile_id, target_fingerprint)`.
  const failSnap = makeSnapshot('cc', '6'.repeat(64), '2.1.324')
  const driftFail1 = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: failSnap,
    policySha256: POLICY_SHA,
  })
  const runFail1 = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runFail1)
  const resFail1 = await completeDriverVerificationRun(pool, {
    runId: runFail1.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'failed',
    errorCode: 'CONFORMANCE_GROUP_3_FAILED',
  })
  assert.equal(resFail1.executionReadyRestored, false)
  assert.equal(resFail1.alertEmitted, true)

  // Repeat automatic probe of a previously failed fingerprint does NOT re-enqueue automatically;
  // manual retry (`forceManualRetry: true`) failing again does NOT emit a second duplicate alert!
  const repeatFailedAuto = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: failSnap,
    policySha256: POLICY_SHA,
  })
  assert.equal(repeatFailedAuto.verificationRunId, null)

  const manualRetry = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: failSnap,
    policySha256: POLICY_SHA,
    forceManualRetry: true,
  })
  assert.ok(manualRetry.verificationRunId)
  const runFail2 = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runFail2)
  const resFail2 = await completeDriverVerificationRun(pool, {
    runId: runFail2.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'failed',
    errorCode: 'CONFORMANCE_GROUP_3_FAILED_AGAIN',
  })
  assert.equal(resFail2.alertEmitted, false)
  const outboxCount = Number(
    (
      await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM admin_alert_outbox
          WHERE event_type = $1
            AND dedupe_key = $2`,
        [
          EVENTS.OPS_REMOTE_DRIVER_VERIFICATION_FAILED,
          `${EVENTS.OPS_REMOTE_DRIVER_VERIFICATION_FAILED}:${driftProfileId}:${driftFail1.fingerprint}`,
        ],
      )
    ).rows[0].n,
  )
  assert.equal(outboxCount, 1)

  // 7. Healthy fix (`777...`) passes all 7 CAS invariants -> restores `execution_ready = TRUE` -> user placement succeeds!
  const snapPass = makeSnapshot('cc', '7'.repeat(64), '2.1.325')
  const driftPass = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: snapPass,
    policySha256: POLICY_SHA,
  })
  const runPass = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runPass)
  const testLanePass = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: verificationSessionKeyForRun(runPass.id),
      canonicalModel: driftModel,
      driverId: 'cc',
      verificationRun: { runId: runPass.id, leaseOwner: 'worker-drift-1' },
    },
    { pool },
  )
  await recordRemoteDriverLaneState(testLanePass.binding.operationId, testLanePass.generation, 'released', pool)
  const restored = await completeDriverVerificationRun(pool, {
    runId: runPass.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(restored.state, 'passed')
  assert.equal(restored.executionReadyRestored, true)

  const userAfterRestore = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:user_restored_after_drift',
      canonicalModel: driftModel,
      driverId: 'cc',
    },
    { pool },
  )
  assert.equal(userAfterRestore.binding.probeFingerprint, driftPass.fingerprint)
  assert.equal(
    computeProbeFingerprintTs(snapPass, {
      driverDigest: userAfterRestore.binding.driverDigest,
      coreDigest: userAfterRestore.binding.coreDigest,
      policySha256: POLICY_SHA,
    }),
    driftPass.fingerprint,
  )
  await recordRemoteDriverLaneState(
    userAfterRestore.binding.operationId,
    userAfterRestore.generation,
    'released',
    pool,
  )

  // 8. (`B3`) Unhealthy probe (`authPresent = false`) with IDENTICAL fingerprint revokes `execution_ready`,
  //    rejects user admission, and subsequent healthy probe at the SAME fingerprint auto-enqueues a
  //    pending verification run so CAS restores `execution_ready = TRUE` without stranding the profile!
  const snapUnhealthySameFp = {
    ...snapPass,
    authPresent: false,
    accountObserved: false,
    observedAt: new Date(Date.now() + 5_000).toISOString(),
  }
  const unhealthyTransition = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: snapUnhealthySameFp,
    policySha256: POLICY_SHA,
  })
  assert.equal(unhealthyTransition.fingerprint, driftPass.fingerprint)
  assert.equal(unhealthyTransition.executionReady, false)
  assert.equal(unhealthyTransition.verificationRunId, null)

  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:user_blocked_during_unhealthy',
        canonicalModel: driftModel,
        driverId: 'cc',
      },
      { pool },
    ),
    /REMOTE_DRIVER_REVERIFY_REQUIRED/,
  )

  const snapRecoveredSameFp = {
    ...snapPass,
    observedAt: new Date(Date.now() + 10_000).toISOString(),
  }
  const recoveredTransition = await recordDriverProbeSnapshot(pool, {
    profileId: driftProfileId,
    snapshot: snapRecoveredSameFp,
    policySha256: POLICY_SHA,
  })
  assert.equal(recoveredTransition.fingerprint, driftPass.fingerprint)
  assert.equal(recoveredTransition.executionReady, false)
  assert.equal(recoveredTransition.autoEligible, true)
  assert.ok(recoveredTransition.verificationRunId, 'Healthy probe after unhealthy at same FP must auto-enqueue verification run')

  // Admission MUST remain rejected while verification is pending/running!
  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:user_still_blocked_pending_reverify',
        canonicalModel: driftModel,
        driverId: 'cc',
      },
      { pool },
    ),
    /REMOTE_DRIVER_REVERIFY_REQUIRED/,
  )

  const runRecover = await claimDriverVerificationRun(pool, {
    leaseOwner: 'worker-drift-1',
    profileId: driftProfileId,
  })
  assert.ok(runRecover)
  assert.equal(runRecover.id, recoveredTransition.verificationRunId)
  const restoredAfterUnhealthy = await completeDriverVerificationRun(pool, {
    runId: runRecover.id,
    leaseOwner: 'worker-drift-1',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(restoredAfterUnhealthy.state, 'passed')
  assert.equal(restoredAfterUnhealthy.executionReadyRestored, true)

  // 9. (`S1`) NULL `last_probe_ok_at` fails closed as stale when `maxProbeAgeMs > 0`.
  await pool.query(
    'UPDATE remote_agent_profiles SET last_probe_ok_at = NULL WHERE id = $1',
    [driftProfileId],
  )
  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:user_null_probe_timestamp',
        canonicalModel: driftModel,
        driverId: 'cc',
      },
      { pool, maxProbeAgeMs: 60_000 },
    ),
    /REMOTE_DRIVER_PROBE_STALE/,
  )
  await pool.query(
    'UPDATE remote_agent_profiles SET last_probe_ok_at = NOW() WHERE id = $1',
    [driftProfileId],
  )

  const userAfterUnhealthyRecovery = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:user_after_unhealthy_recovery',
      canonicalModel: driftModel,
      driverId: 'cc',
    },
    { pool },
  )
  assert.equal(userAfterUnhealthyRecovery.binding.probeFingerprint, driftPass.fingerprint)
  await recordRemoteDriverLaneState(
    userAfterUnhealthyRecovery.binding.operationId,
    userAfterUnhealthyRecovery.generation,
    'released',
    pool,
  )
})

test('AC-5 R1 RemoteReleaseDrainCoordinator blocks new admissions while waiting for active relay and inflight journal, and reopens without killing on timeout', async () => {
  const drainGate = new RemoteReleaseDrainCoordinator()
  let relayIdle = false
  const unregister = drainGate.registerRelay('relay-1', {
    get idle() {
      return relayIdle
    },
  })

  // Insert an inflight v4 journal row representing an in-flight turn during R1 cutover.
  const activeLane = await placeRemoteDriverLane(
    {
      uid,
      containerDbId: '7',
      dockerId: 'a'.repeat(64),
      sessionKey: 'agent:main:webchat:dm:r1_drain_active_turn',
      canonicalModel: CC_CANONICAL,
      driverId: 'cc',
    },
    { pool, drainGate },
  )
  const redis = { eval: async () => 0 } as any
  const port = createRemoteDriverTurnFinance(
    {
      pool,
      preCheckRedis: redis,
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
      log: createLogger({ out: () => {} }),
    },
    { reserve: async () => ({ maxCost: 100n }) as any, release: async () => true },
  )
  const signed = await issueSignedTurn(uid, activeLane.binding, `drainreq_${randomUUID().slice(0, 8)}`)
  const turn = await port.admit({
    binding: activeLane.binding,
    usagePolicy: CC_USAGE_POLICY,
    sessionKey: activeLane.binding.sessionKey,
    turnKey: signed.turnKey,
    authorityEnvelope: signed.authorityEnvelope,
    leaseEnvelope: signed.leaseEnvelope,
  })
  await turn.beforeHostStart()
  await turn.bindNativeThread('drain-cc-sess', true)
  await turn.beforeDispatch({ sequence: 1, inputSha256: signed.turnKey })

  // 1. Timeout control: while relay & journal remain active past timeoutMs, new admissions are blocked
  // with `REMOTE_POOL_DRAINING_RETRY_LATER`, and timeout reopens without killing/aborting the turn!
  const timeoutDrain = drainGate.drainForCutover(pool, { timeoutMs: 90, pollIntervalMs: 15 })
  assert.equal(drainGate.isDraining, true)
  await assert.rejects(
    placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:r1_drain_blocked_new',
        canonicalModel: CC_CANONICAL,
        driverId: 'cc',
      },
      { pool, drainGate },
    ),
    /REMOTE_POOL_DRAINING_RETRY_LATER/,
  )
  await assert.rejects(timeoutDrain, /REMOTE_RELEASE_DRAIN_TIMEOUT/)
  assert.equal(drainGate.isDraining, false)
  const stillInflight = (
    await pool.query('SELECT state FROM request_finalize_journal WHERE request_id = $1', [
      signed.requestId,
    ])
  ).rows[0]
  assert.equal(stillInflight.state, 'inflight')

  // 2. Real drain completion: resolves `{ drained: true }` only AFTER relay becomes idle AND journal settles!
  const drainPromise = drainGate.drainForCutover(pool, { timeoutMs: 5_000, pollIntervalMs: 15 })
  let drainedResolved = false
  drainPromise.then(() => {
    drainedResolved = true
  })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(drainedResolved, false)
  relayIdle = true
  await new Promise((r) => setTimeout(r, 40))
  // Still waiting because journal is still inflight!
  assert.equal(drainedResolved, false)

  const receipt = buildRemoteReceiptV4({
    engineId: activeLane.binding.engineId,
    driverId: activeLane.binding.driverId,
    driverVersion: activeLane.binding.driverVersion,
    driverDigest: activeLane.binding.driverDigest,
    uid,
    containerDbId: '7',
    dockerId: activeLane.binding.dockerId,
    operationId: activeLane.binding.operationId,
    runId: activeLane.binding.runId,
    sessionKey: activeLane.binding.sessionKey,
    canonicalModel: CC_CANONICAL,
    upstreamModel: CC_UPSTREAM,
    profileId: activeLane.binding.profileId,
    authEpoch: activeLane.binding.authEpoch,
    authorityTurnId: signed.authorityTurnId,
    turnKey: signed.turnKey,
    requestId: signed.requestId,
    nativeSessionId: 'drain-cc-sess',
    terminalId: 'drain-cc-term-1',
    policy: CC_USAGE_POLICY,
    countersBaseline: null,
    countersFinal: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    nativeStatus: 'success',
    rawEvidenceDigest: '8'.repeat(64),
    provenance: {
      generation: activeLane.generation,
      manifestHash: activeLane.binding.manifestSha256,
      coreDigest: activeLane.binding.coreDigest,
      probeFingerprint: activeLane.binding.probeFingerprint,
    },
  })
  assert.equal((await turn.terminal(receipt)).state, 'proven')

  const drainRes = await drainPromise
  assert.equal(drainRes.drained, true)
  unregister()
  drainGate.reopen()
  await recordRemoteDriverLaneState(activeLane.binding.operationId, activeLane.generation, 'released', pool)
})
