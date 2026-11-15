/**
 * Milestone R11 real-PostgreSQL integration suite (`OCV5-749`):
 * - Group 1: `applyRemoteNodeProbeResult` v4 isolation & `countEligibleEnabledRemoteOffers` v4 readiness projection
 * - Group 2: `driftCoordinator` sub-lanes, production wrappers, financial finality & metadata binding, lease renewal & expiry reaper, reserved prefix rejection
 * - Group 3: `probeRemoteDriverProfileLive` read-only dryRun enforcement & zero DB writes
 * - Group 4: `convertProfileToDriverV4` / `revertDriverV4ProfileToLegacy` P0-1 CAS cutover & rollback
 * - Group 5: `scripts/v5-remote-driver-probe.ts` read-only CLI flag & argument enforcement
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadBoxBridgeMod } from '@openclaude/gateway'
import {
  CC5_TEST_UID_ENV,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  type RemoteProbeSnapshot,
} from '@openclaude/protocol'
import { Pool } from 'pg'
import {
  applyRemoteNodeProbeResult,
  countEligibleEnabledRemoteOffers,
  remoteNodeExecKeyDir,
} from '../account-pool/remoteBrainPool.js'
import {
  REMOTE_DRIVER_VERIFICATION_CASE_LANES,
  REMOTE_DRIVER_VERIFICATION_REQUEST_PREFIX,
  claimDriverVerificationRun,
  completeDriverVerificationRun,
  completeProductionDriverVerificationRun,
  computeProbeFingerprintTs,
  computeProductionConformanceSuiteDigest,
  convertProfileToDriverV4,
  isReservedVerificationSessionKey,
  loadRemoteDriverRegistry,
  placeRemoteDriverLane,
  probeRemoteDriverProfileLive,
  reapExpiredDriverVerificationRuns,
  recordDriverProbeSnapshot,
  recordProductionDriverProbeSnapshot,
  recordRemoteDriverLaneState,
  renewDriverVerificationLease,
  resolveRemoteDriverV4ExecKeyPath,
  revertDriverV4ProfileToLegacy,
  verificationSessionKeyForCaseLane,
  verificationSessionKeyForRun,
  verificationTurnRequestId,
} from '../account-pool/remotePool/index.js'
import { createMasterCc5Runtime, selectMasterCc5Backend } from '../agent-sandbox/cc5Runtime.js'
import { REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION } from '../billing/remoteNativeBillingIdentity.js'
import { closePool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { resetAndMigrateBefore } from './helpers/db.js'

const execFileAsync = promisify(execFile)
const url = process.env.TEST_DATABASE_URL
assert.ok(
  url && new URL(url).pathname.endsWith('_test'),
  'explicit isolated TEST_DATABASE_URL required',
)
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000 })

const CC_CANONICAL = 'claude-sonnet-5-remote'
const CC_UPSTREAM = 'claude-sonnet-5'
const CODEX_CANONICAL = 'gpt-6-luna-remote'
const CODEX_UPSTREAM = 'gpt-6-luna'
const POLICY_SHA = '1'.repeat(64)
const EVIDENCE_SHA = '2'.repeat(64)

function makeSnapshot(
  driverId: 'cc' | 'codex',
  cliSha256: string,
  modelsOverride?: RemoteProbeSnapshot['models'],
): RemoteProbeSnapshot {
  const reg = loadRemoteDriverRegistry().get(driverId)!
  const upstreamModel = driverId === 'codex' ? CODEX_UPSTREAM : CC_UPSTREAM
  return {
    schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: reg.engineId,
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    source: `${driverId}:live-probe`,
    freshness: 'cli-observed',
    observedAt: '2026-11-11T04:00:00Z',
    authPresent: true,
    accountObserved: true,
    cliVersion: '2.1.0',
    cliSha256,
    ...(driverId === 'codex' ? { nativeSha256: 'b'.repeat(64) } : { bridgeSha256: 'c'.repeat(64) }),
    models: modelsOverride ?? [
      {
        upstreamModelId: upstreamModel,
        displayName: driverId === 'codex' ? 'GPT 6 Luna' : 'Claude Sonnet 5',
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsAdaptiveThinking: true,
        supportsVision: true,
      },
    ],
    rawResponseSha256: 'd'.repeat(64),
  }
}

async function seedFixture(tag: string) {
  const uid = 910_000 + Math.floor(Math.random() * 50_000)
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, credits)
     VALUES ($1, $2, 'hash', 'user', 500000)
     ON CONFLICT (id) DO NOTHING`,
    [uid, `r11-${tag}-${uid}@test.local`],
  )
  const containerDbId = String(uid)

  const nodeId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_nodes
         (label, ssh_host, ssh_port, ssh_user, host_key_fp, key_id, controller_sha256, status, health_score, rtt_ms_p50)
       VALUES ($1, 'node1.test.local', 22, 'agent', 'SHA256:testfp', $2, $3, 'active', 100, 12)
       RETURNING id::text AS id`,
      [
        `r11-node-${tag}-${randomUUID().slice(0, 8)}`,
        `key-${tag}-${randomUUID().slice(0, 6)}`,
        'e'.repeat(64),
      ],
    )
  ).rows[0]!.id

  return {
    uid,
    containerDbId,
    dockerId: createHash('sha256').update(`docker-${tag}-${uid}`).digest('hex'),
    nodeId,
  }
}

before(async () => {
  setPoolOverride(pool)
  await resetAndMigrateBefore('0338')
  await runMigrations()
})

after(async () => {
  await closePool()
})

// ---------------------------------------------------------------------------
// Group 1: applyRemoteNodeProbeResult v4 isolation & countEligibleEnabledRemoteOffers v4 projection
// ---------------------------------------------------------------------------
test('Group 1: applyRemoteNodeProbeResult isolates v4 profiles and countEligibleEnabledRemoteOffers projects v4 readiness', async () => {
  const fx = await seedFixture('g1')
  const suiteDigest = computeProductionConformanceSuiteDigest()
  const ccFp = createHash('sha256').update(`g1-cc-${fx.nodeId}`).digest('hex')
  const codexFp = createHash('sha256').update(`g1-codex-${fx.nodeId}`).digest('hex')
  const ccLegacyFp = createHash('sha256').update(`g1-cc-legacy-${fx.nodeId}`).digest('hex')

  // Seed legacy + v4 profiles on the same node
  const ccV4Id = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, status, execution_ready)
       VALUES ($1, 'cc', 'cc-v4', $2, 'active', FALSE)
       RETURNING id::text AS id`,
      [fx.nodeId, ccFp],
    )
  ).rows[0]!.id
  const codexV4Id = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode, status, execution_ready)
       VALUES ($1, 'codex', 'codex-v4', $2, 'app-server', 'active', FALSE)
       RETURNING id::text AS id`,
      [fx.nodeId, codexFp],
    )
  ).rows[0]!.id

  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, upstream_model_id, canonical_model_id, base_display_name, enabled)
     VALUES ($1, $2, $3, 'Sonnet 5', TRUE),
            ($4, $5, $6, 'GPT 6 Luna', TRUE)`,
    [ccV4Id, CC_UPSTREAM, CC_CANONICAL, codexV4Id, CODEX_UPSTREAM, CODEX_CANONICAL],
  )

  // Convert both to ready v4 profiles via record + claim + complete
  for (const [profileId, driverId, fp] of [
    [ccV4Id, 'cc', ccFp],
    [codexV4Id, 'codex', codexFp],
  ] as const) {
    const snap = makeSnapshot(driverId, fp)
    const rec = await recordProductionDriverProbeSnapshot(pool, {
      profileId,
      snapshot: snap,
      policySha256: POLICY_SHA,
      suiteDigest,
    })
    assert.ok(rec.verificationRunId)
    const claimed = await claimDriverVerificationRun(pool, {
      leaseOwner: 'g1-owner',
      profileId,
    })
    assert.ok(claimed)
    const done = await completeProductionDriverVerificationRun(pool, {
      runId: claimed.id,
      leaseOwner: 'g1-owner',
      outcome: 'passed',
      evidenceDigest: EVIDENCE_SHA,
    })
    assert.equal(done.executionReadyRestored, true)
  }

  // Before running legacy probe: both v4 offers must count in countEligibleEnabledRemoteOffers
  assert.equal(await countEligibleEnabledRemoteOffers(CC_CANONICAL, pool), 1)
  assert.equal(await countEligibleEnabledRemoteOffers(CODEX_CANONICAL, pool), 1)

  const beforeCcRow = (
    await pool.query(
      'SELECT driver_id, verified_fingerprint, execution_ready, probe_snapshot, status FROM remote_agent_profiles WHERE id = $1',
      [ccV4Id],
    )
  ).rows[0]!
  const beforeCodexRow = (
    await pool.query(
      'SELECT driver_id, verified_fingerprint, execution_ready, probe_snapshot, status FROM remote_agent_profiles WHERE id = $1',
      [codexV4Id],
    )
  ).rows[0]!

  // Run legacy applyRemoteNodeProbeResult:
  // - Includes conflicting (cc, cc-v4) name + a legacy (cc, cc-legacy) name -> tests Path 1 (DO UPDATE) & Path 3 (stale cc cleanup)
  // - Omits codex-v4 completely -> tests Path 4 (codex missing-profile revoke)
  const modSha = loadBoxBridgeMod().sha256
  await applyRemoteNodeProbeResult(
    fx.nodeId,
    {
      profiles: [
        {
          engine: 'cc',
          profile_name: 'cc-v4',
          account_fingerprint: '0'.repeat(64),
          runner_mode: 'interactive',
          tmux_version: '3.4',
          mod_digest: modSha,
          discovered_models: [
            { upstream_model_id: 'legacy-wrong-model', display_name: 'Legacy Wrong' },
          ],
        },
        {
          engine: 'cc',
          profile_name: 'cc-legacy',
          account_fingerprint: ccLegacyFp,
          runner_mode: 'interactive',
          tmux_version: '3.4',
          mod_digest: modSha,
          discovered_models: [{ upstream_model_id: CC_UPSTREAM, display_name: 'Claude Sonnet 5' }],
        },
      ],
    },
    pool,
  )

  const afterCcRow = (
    await pool.query(
      'SELECT driver_id, verified_fingerprint, execution_ready, probe_snapshot, status FROM remote_agent_profiles WHERE id = $1',
      [ccV4Id],
    )
  ).rows[0]!
  const afterCodexRow = (
    await pool.query(
      'SELECT driver_id, verified_fingerprint, execution_ready, probe_snapshot, status FROM remote_agent_profiles WHERE id = $1',
      [codexV4Id],
    )
  ).rows[0]!

  assert.equal(afterCcRow.driver_id, 'cc')
  assert.equal(afterCcRow.verified_fingerprint, beforeCcRow.verified_fingerprint)
  assert.equal(afterCcRow.execution_ready, true)
  assert.deepEqual(afterCcRow.probe_snapshot, beforeCcRow.probe_snapshot)

  assert.equal(afterCodexRow.driver_id, 'codex')
  assert.equal(afterCodexRow.verified_fingerprint, beforeCodexRow.verified_fingerprint)
  assert.equal(afterCodexRow.execution_ready, true)
  assert.equal(afterCodexRow.status, 'active')
  assert.deepEqual(afterCodexRow.probe_snapshot, beforeCodexRow.probe_snapshot)

  // Legacy cc profile (driver_id IS NULL) ALSO exists and continues legacy behavior
  const legacyCcRows = (
    await pool.query(
      `SELECT id, driver_id FROM remote_agent_profiles WHERE node_id = $1 AND profile_name = 'cc-legacy'`,
      [fx.nodeId],
    )
  ).rows
  assert.equal(legacyCcRows.length, 1)
  assert.equal(legacyCcRows[0]!.driver_id, null)

  // Offer projection negative gates on v4 codex:
  // 1) Drift/unready -> 0
  await pool.query('UPDATE remote_agent_profiles SET execution_ready = FALSE WHERE id = $1', [
    codexV4Id,
  ])
  assert.equal(await countEligibleEnabledRemoteOffers(CODEX_CANONICAL, pool), 0)
  // 2) Stale probe (> 10 min) -> 0 even when execution_ready=TRUE
  await pool.query(
    `UPDATE remote_agent_profiles SET execution_ready = TRUE, last_probe_ok_at = NOW() - INTERVAL '15 minutes' WHERE id = $1`,
    [codexV4Id],
  )
  assert.equal(await countEligibleEnabledRemoteOffers(CODEX_CANONICAL, pool), 0)
  // 3) Restored fresh probe -> 1 again
  await pool.query('UPDATE remote_agent_profiles SET last_probe_ok_at = NOW() WHERE id = $1', [
    codexV4Id,
  ])
  assert.equal(await countEligibleEnabledRemoteOffers(CODEX_CANONICAL, pool), 1)
  // 4) Offer points to model absent from v4 probe_snapshot -> 0
  const unprobedModel = 'gpt-6-absent-remote'
  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, upstream_model_id, canonical_model_id, base_display_name, enabled)
     VALUES ($1, 'gpt-6-absent', $2, 'Absent Model', TRUE)`,
    [codexV4Id, unprobedModel],
  )
  assert.equal(await countEligibleEnabledRemoteOffers(unprobedModel, pool), 0)
})

// ---------------------------------------------------------------------------
// Group 2: sub-lanes, W1 sticky resume, completion financial & metadata gates,
// production wrappers, lease renewal & expiry reaper, reserved prefix
// ---------------------------------------------------------------------------
test('Group 2: sub-lanes, W1 sticky resume, financial/metadata gates, production wrappers, lease renew & reap', async () => {
  const fx = await seedFixture('g2')
  const suiteDigest = computeProductionConformanceSuiteDigest()
  const ccFp = createHash('sha256').update(`g2-cc-${fx.nodeId}`).digest('hex')
  const reg = loadRemoteDriverRegistry().get('cc')!
  const canonicalForTest = `claude-sonnet-5-g2-${randomUUID().slice(0, 6)}-remote`

  const profileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, status, execution_ready)
       VALUES ($1, 'cc', 'default', $2, 'active', FALSE)
       RETURNING id::text AS id`,
      [fx.nodeId, ccFp],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, upstream_model_id, canonical_model_id, base_display_name, enabled)
     VALUES ($1, $2, $3, 'Sonnet 5', TRUE)`,
    [profileId, CC_UPSTREAM, canonicalForTest],
  )

  const snap = makeSnapshot('cc', ccFp)

  // Production wrapper rejects digest/registry overrides
  await assert.rejects(
    () =>
      recordProductionDriverProbeSnapshot(pool, {
        profileId,
        snapshot: snap,
        policySha256: POLICY_SHA,
        suiteDigest,
        driverDigest: '0'.repeat(64),
      } as any),
    /REMOTE_PRODUCTION_DIGEST_OVERRIDE_FORBIDDEN/,
  )

  const rec = await recordProductionDriverProbeSnapshot(pool, {
    profileId,
    snapshot: snap,
    policySha256: POLICY_SHA,
    suiteDigest,
  })
  assert.ok(rec.verificationRunId)
  const claimed = await claimDriverVerificationRun(pool, {
    leaseOwner: 'g2-worker',
    profileId,
    leaseMs: 120_000,
  })
  assert.ok(claimed)

  // Sub-lane key & prefix helpers
  assert.ok(REMOTE_DRIVER_VERIFICATION_CASE_LANES.includes('g1'))
  const laneKey = verificationSessionKeyForCaseLane(claimed.id, 'g1')
  assert.equal(laneKey, `remote-driver-verify:${claimed.id}:g1`)
  assert.equal(isReservedVerificationSessionKey(laneKey), true)
  assert.equal(isReservedVerificationSessionKey('user-chat-1'), false)
  assert.throws(
    () => verificationSessionKeyForCaseLane(claimed.id, 'bad_lane!'),
    /REMOTE_VERIFICATION_CASE_LANE_INVALID/,
  )
  const turnReq1 = verificationTurnRequestId(claimed.id, 'g1', 1)
  assert.equal(turnReq1, `${REMOTE_DRIVER_VERIFICATION_REQUEST_PREFIX}${claimed.id}:g1:1`)

  // Regular placement & cc5Runtime reject reserved prefix
  await assert.rejects(
    () =>
      placeRemoteDriverLane(
        {
          uid: fx.uid,
          containerDbId: fx.containerDbId,
          dockerId: fx.dockerId,
          sessionKey: laneKey,
          canonicalModel: canonicalForTest,
          driverId: 'cc',
        },
        { pool },
      ),
    /REMOTE_SESSION_KEY_RESERVED/,
  )
  await assert.rejects(
    () =>
      selectMasterCc5Backend(
        undefined,
        {
          uid: fx.uid,
          containerId: Number(fx.containerDbId),
          sessionKey: laneKey,
          canonicalModel: canonicalForTest,
          engine: 'ccb',
          placement: 'remote_pool',
        },
        true,
        {} as any,
      ),
    /REMOTE_SESSION_KEY_RESERVED/,
  )

  let capturedPlaceHook: ((req: any) => Promise<any>) | undefined
  createMasterCc5Runtime(
    {
      selfhost: true,
      authorityReady: true,
      env: {
        OC_SELFHOST_CC5_T1555U_ENABLED: '1',
        [CC5_TEST_UID_ENV]: String(fx.uid),
        OC_REMOTE_V4_DRAIN_SOCKET: 'none',
      },
      financeFactory: (() => ({})) as any,
    },
    {
      pool: () => pool,
      create: (opts: any) => {
        capturedPlaceHook = opts.hooks.place
        return {} as any
      },
    },
  )
  assert.ok(capturedPlaceHook)
  await assert.rejects(
    () =>
      capturedPlaceHook!({
        engine: 'ccb',
        uid: fx.uid,
        containerDbId: fx.containerDbId,
        dockerId: fx.dockerId,
        sessionKey: laneKey,
        canonicalModel: canonicalForTest,
      }),
    /REMOTE_SESSION_KEY_RESERVED/,
  )

  // Engine mismatch rejected on verification placement
  await assert.rejects(
    () =>
      placeRemoteDriverLane(
        {
          uid: fx.uid,
          containerDbId: fx.containerDbId,
          dockerId: fx.dockerId,
          canonicalModel: canonicalForTest,
          driverId: 'codex',
          verificationRun: { runId: claimed.id, leaseOwner: 'g2-worker', caseLane: 'g1' },
        },
        { pool },
      ),
    /REMOTE_VERIFICATION_ENGINE_MISMATCH/,
  )

  // Mismatched explicit sessionKey rejected
  await assert.rejects(
    () =>
      placeRemoteDriverLane(
        {
          uid: fx.uid,
          containerDbId: fx.containerDbId,
          dockerId: fx.dockerId,
          sessionKey: verificationSessionKeyForRun(claimed.id),
          canonicalModel: canonicalForTest,
          driverId: 'cc',
          verificationRun: { runId: claimed.id, leaseOwner: 'g2-worker', caseLane: 'g1' },
        },
        { pool },
      ),
    /REMOTE_VERIFICATION_SESSION_KEY_MISMATCH/,
  )

  // Verification placement succeeds with omitted sessionKey -> computes sub-lane key + recovery_spec.verificationRunId + exec key path
  const p1 = await placeRemoteDriverLane(
    {
      uid: fx.uid,
      containerDbId: fx.containerDbId,
      dockerId: fx.dockerId,
      canonicalModel: canonicalForTest,
      driverId: 'cc',
      verificationRun: { runId: claimed.id, leaseOwner: 'g2-worker', caseLane: 'g1' },
    },
    { pool },
  )
  assert.equal(p1.binding.sessionKey, laneKey)
  assert.equal(p1.generation, '1')
  assert.equal(
    p1.sshTarget.keyPath,
    resolveRemoteDriverV4ExecKeyPath(
      (await pool.query('SELECT key_id FROM remote_agent_nodes WHERE id = $1', [fx.nodeId]))
        .rows[0]!.key_id,
      'cc',
    ),
  )
  const recSpec1 = (
    await pool.query(
      'SELECT recovery_spec, run_id::text AS run_id FROM remote_agent_bindings WHERE operation_id = $1',
      [p1.binding.operationId],
    )
  ).rows[0]!
  assert.equal(recSpec1.recovery_spec.runId, recSpec1.run_id)
  assert.equal(recSpec1.recovery_spec.verificationRunId, claimed.id)
  assert.equal(recSpec1.recovery_spec.verificationCaseLane, 'g1')

  // Unreleased caseLane binding blocks completion even without profile_id filter
  await assert.rejects(
    () =>
      completeProductionDriverVerificationRun(pool, {
        runId: claimed.id,
        leaseOwner: 'wrong-owner',
        outcome: 'passed',
        evidenceDigest: EVIDENCE_SHA,
      }),
    /REMOTE_VERIFICATION_LEASE_LOST/,
  )
  const blockedBinding = await completeProductionDriverVerificationRun(pool, {
    runId: claimed.id,
    leaseOwner: 'g2-worker',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(blockedBinding.state, 'aborted')
  assert.equal(blockedBinding.rejectReason, 'VERIFICATION_TEST_BINDING_NOT_RELEASED')

  // Release p1, then test W1 sticky resume on same caseLane in SAME runId (after re-claiming aborted->or let's test W1 before aborting? Wait: complete aborted the run!)
  // Re-record/claim a fresh run to test W1 + journal finality + evidenceMetadata + pass!
  await recordRemoteDriverLaneState(p1.binding.operationId, p1.generation, 'released', pool)
  const rec2 = await recordProductionDriverProbeSnapshot(pool, {
    profileId,
    snapshot: snap,
    policySha256: POLICY_SHA,
    suiteDigest,
    forceManualRetry: true,
  })
  const claimed2 = await claimDriverVerificationRun(pool, {
    leaseOwner: 'g2-worker-2',
    profileId,
    allowManual: true,
    leaseMs: 120_000,
    maxAttempts: 2,
  })
  assert.ok(claimed2)
  assert.equal(claimed2.id, rec2.verificationRunId)

  const w1First = await placeRemoteDriverLane(
    {
      uid: fx.uid,
      containerDbId: fx.containerDbId,
      dockerId: fx.dockerId,
      canonicalModel: canonicalForTest,
      driverId: 'cc',
      verificationRun: { runId: claimed2.id, leaseOwner: 'g2-worker-2', caseLane: 'g4mid' },
    },
    { pool },
  )
  assert.equal(w1First.generation, '1')
  await recordRemoteDriverLaneState(
    w1First.binding.operationId,
    w1First.generation,
    'released',
    pool,
  )

  // Pending billing journal blocks W1 sticky resume AND complete financial finality
  const reqId2 = verificationTurnRequestId(claimed2.id, 'g4mid', 1)
  await pool.query(
    `INSERT INTO request_finalize_journal (request_id, user_id, state, ctx, precheck_credits)
     VALUES ($1, $2, 'inflight', $3::jsonb, 100)`,
    [
      reqId2,
      fx.uid,
      JSON.stringify({
        remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
        remoteDriverV4: { scope: { operationId: w1First.binding.operationId } },
      }),
    ],
  )
  await assert.rejects(
    () =>
      placeRemoteDriverLane(
        {
          uid: fx.uid,
          containerDbId: fx.containerDbId,
          dockerId: fx.dockerId,
          canonicalModel: canonicalForTest,
          driverId: 'cc',
          verificationRun: { runId: claimed2.id, leaseOwner: 'g2-worker-2', caseLane: 'g4mid' },
        },
        { pool },
      ),
    /REMOTE_OPERATION_BILLING_PENDING/,
  )

  // Even if all bindings are released, inflight journal row blocks completion with VERIFICATION_FINANCE_NOT_SETTLED
  const blockedFinance = await completeProductionDriverVerificationRun(pool, {
    runId: claimed2.id,
    leaseOwner: 'g2-worker-2',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
  })
  assert.equal(blockedFinance.state, 'aborted')
  assert.equal(blockedFinance.rejectReason, 'VERIFICATION_FINANCE_NOT_SETTLED')

  // Settle journal -> now test evidenceMetadata mismatch & valid completion
  await pool.query(
    `UPDATE request_finalize_journal SET state = 'committed' WHERE request_id = $1`,
    [reqId2],
  )

  const rec3 = await recordProductionDriverProbeSnapshot(pool, {
    profileId,
    snapshot: snap,
    policySha256: POLICY_SHA,
    suiteDigest,
    forceManualRetry: true,
  })
  const claimed3 = await claimDriverVerificationRun(pool, {
    leaseOwner: 'g2-worker-3',
    profileId,
    allowManual: true,
    leaseMs: 60_000,
  })
  assert.ok(claimed3)
  assert.equal(claimed3.id, rec3.verificationRunId)

  // Place & release same-caseLane twice to prove W1 sticky generation increment
  const stick1 = await placeRemoteDriverLane(
    {
      uid: fx.uid,
      containerDbId: fx.containerDbId,
      dockerId: fx.dockerId,
      canonicalModel: canonicalForTest,
      driverId: 'cc',
      verificationRun: { runId: claimed3.id, leaseOwner: 'g2-worker-3', caseLane: 'g4disc' },
    },
    { pool },
  )
  await recordRemoteDriverLaneState(stick1.binding.operationId, stick1.generation, 'released', pool)
  const stick2 = await placeRemoteDriverLane(
    {
      uid: fx.uid,
      containerDbId: fx.containerDbId,
      dockerId: fx.dockerId,
      canonicalModel: canonicalForTest,
      driverId: 'cc',
      verificationRun: { runId: claimed3.id, leaseOwner: 'g2-worker-3', caseLane: 'g4disc' },
    },
    { pool },
  )
  assert.equal(stick2.binding.operationId, stick1.binding.operationId)
  assert.equal(stick2.binding.runId, stick1.binding.runId)
  assert.equal(stick2.generation, '2')
  await recordRemoteDriverLaneState(stick2.binding.operationId, stick2.generation, 'released', pool)

  // Lease renewal CAS
  const badRenew = await renewDriverVerificationLease(pool, {
    runId: claimed3.id,
    leaseOwner: 'wrong',
    leaseMs: 90_000,
  })
  assert.equal(badRenew.renewed, false)
  const goodRenew = await renewDriverVerificationLease(pool, {
    runId: claimed3.id,
    leaseOwner: 'g2-worker-3',
    leaseMs: 90_000,
  })
  assert.equal(goodRenew.renewed, true)

  // Complete production wrapper rejects overrides
  await assert.rejects(
    () =>
      completeProductionDriverVerificationRun(pool, {
        runId: claimed3.id,
        leaseOwner: 'g2-worker-3',
        outcome: 'passed',
        evidenceDigest: EVIDENCE_SHA,
        currentDriverDigest: '0'.repeat(64),
      } as any),
    /REMOTE_PRODUCTION_DIGEST_OVERRIDE_FORBIDDEN/,
  )

  // Mismatched evidenceMetadata aborts (create one more run first or check pass then check mismatch on run3)
  const mismatchMeta = await completeProductionDriverVerificationRun(pool, {
    runId: claimed3.id,
    leaseOwner: 'g2-worker-3',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
    evidenceMetadata: {
      runId: claimed3.id,
      suiteDigest: '9'.repeat(64),
      caseLanes: ['g4disc'],
    },
  })
  assert.equal(mismatchMeta.state, 'aborted')
  assert.equal(mismatchMeta.rejectReason, 'VERIFICATION_EVIDENCE_METADATA_MISMATCH')

  // Fresh run4 completes cleanly with valid evidenceMetadata
  const rec4 = await recordProductionDriverProbeSnapshot(pool, {
    profileId,
    snapshot: snap,
    policySha256: POLICY_SHA,
    suiteDigest,
    forceManualRetry: true,
  })
  const claimed4 = await claimDriverVerificationRun(pool, {
    leaseOwner: 'g2-worker-4',
    profileId,
    allowManual: true,
    leaseMs: 60_000,
  })
  assert.ok(claimed4 && claimed4.id === rec4.verificationRunId)
  const okDone = await completeProductionDriverVerificationRun(pool, {
    runId: claimed4.id,
    leaseOwner: 'g2-worker-4',
    outcome: 'passed',
    evidenceDigest: EVIDENCE_SHA,
    evidenceMetadata: {
      runId: claimed4.id,
      profileId,
      driverId: 'cc',
      engineId: reg.engineId,
      targetFingerprint: claimed4.targetFingerprint,
      readyGeneration: claimed4.readyGeneration,
      suiteDigest,
      caseLanes: ['g1'],
      turnRequestIds: [verificationTurnRequestId(claimed4.id, 'g1', 1)],
    },
  })
  assert.equal(okDone.state, 'passed')
  assert.equal(okDone.executionReadyRestored, true)

  // Test DB NOW() expired lease rejection & reaper (attempt_count >= maxAttempts -> failed + alert + unready)
  const rec5 = await recordProductionDriverProbeSnapshot(pool, {
    profileId,
    snapshot: makeSnapshot('cc', ccFp),
    policySha256: POLICY_SHA,
    suiteDigest,
    forceManualRetry: true,
  })
  const claimed5 = await claimDriverVerificationRun(pool, {
    leaseOwner: 'g2-worker-5',
    profileId,
    allowManual: true,
    leaseMs: 60_000,
  })
  assert.ok(claimed5 && claimed5.id === rec5.verificationRunId)
  await pool.query(
    `UPDATE remote_driver_verification_runs SET lease_until = NOW() - INTERVAL '5 seconds' WHERE id = $1`,
    [claimed5.id],
  )
  await assert.rejects(
    () =>
      completeDriverVerificationRun(pool, {
        runId: claimed5.id,
        leaseOwner: 'g2-worker-5',
        outcome: 'passed',
        evidenceDigest: EVIDENCE_SHA,
      }),
    /REMOTE_VERIFICATION_LEASE_LOST/,
  )
  const reaped = await reapExpiredDriverVerificationRuns(pool, { maxAttempts: 1 })
  assert.ok(reaped.failedIds.includes(claimed5.id))
  const reapedRow = (
    await pool.query(
      'SELECT state, error_code, alert_emitted FROM remote_driver_verification_runs WHERE id = $1',
      [claimed5.id],
    )
  ).rows[0]!
  assert.equal(reapedRow.state, 'failed')
  assert.equal(reapedRow.error_code, 'REMOTE_VERIFICATION_LEASE_EXPIRED')
  assert.equal(reapedRow.alert_emitted, true)
})

// ---------------------------------------------------------------------------
// Group 3: remoteNodeExecKeyDir, resolveRemoteDriverV4ExecKeyPath & probeRemoteDriverProfileLive
// ---------------------------------------------------------------------------
test('Group 3: liveProbe strictly refuses dryRun=false and runs read-only dryRun with zero DB mutations', async () => {
  const fx = await seedFixture('g3')
  const keyDir = mkdtempSync('/tmp/oc-drvtest-keys-')
  try {
    const keyId = (
      await pool.query('SELECT key_id FROM remote_agent_nodes WHERE id = $1', [fx.nodeId])
    ).rows[0]!.key_id
    assert.equal(remoteNodeExecKeyDir(keyId, keyDir), join(keyDir, `${keyId}-exec`))
    assert.equal(
      resolveRemoteDriverV4ExecKeyPath(keyId, 'cc', keyDir),
      join(keyDir, `${keyId}-exec`, 'v4_cc_id_ed25519'),
    )

    const fp = createHash('sha256').update(`g3-cc-${fx.nodeId}`).digest('hex')
    const profId = (
      await pool.query<{ id: string }>(
        `INSERT INTO remote_agent_profiles
           (node_id, engine, profile_name, account_fingerprint, status, execution_ready, ready_generation)
         VALUES ($1, 'cc', 'default', $2, 'active', FALSE, 1)
         RETURNING id::text AS id`,
        [fx.nodeId, fp],
      )
    ).rows[0]!.id

    await assert.rejects(
      () =>
        probeRemoteDriverProfileLive(pool, {
          profileId: profId,
          driverId: 'cc',
          dryRun: false,
          keyDir,
        }),
      /REMOTE_LIVE_PROBE_WRITE_DISABLED_IN_R11/,
    )

    const snap: RemoteProbeSnapshot = {
      ...makeSnapshot('cc', fp),
      bridgeSha256: loadBoxBridgeMod().sha256,
    }
    const reg = loadRemoteDriverRegistry().get('cc')!
    let sawKeyPath = ''
    let sawProbeRoot = ''
    const res = await probeRemoteDriverProfileLive(
      pool,
      {
        profileId: profId,
        driverId: 'cc',
        keyDir,
      },
      {
        probeHostFactory: (sshTarget, spec) => {
          sawKeyPath = sshTarget.keyPath
          sawProbeRoot = spec.probeRoot
          return {
            async probe() {
              const policySha = createHash('sha256').update('probe-placeholder').digest('hex')
              return {
                snapshot: snap,
                driverDigest: reg.driverDigest,
                coreDigest: reg.coreDigest,
                probeFingerprint: computeProbeFingerprintTs(snap, {
                  driverDigest: reg.driverDigest,
                  coreDigest: reg.coreDigest,
                  policySha256: policySha,
                }),
              }
            },
          }
        },
      },
    )

    assert.equal(res.dryRun, true)
    assert.equal(res.profileId, profId)
    assert.equal(res.driverId, 'cc')
    assert.match(res.policySha256, /^[a-f0-9]{64}$/)
    assert.match(res.probeFingerprint, /^[a-f0-9]{64}$/)
    assert.equal(sawKeyPath, resolveRemoteDriverV4ExecKeyPath(keyId, 'cc', keyDir))
    assert.match(sawProbeRoot, /^\/home\/agent\/oc-remoteprobe-cc-/)

    // DB row MUST remain completely untouched
    const dbRow = (
      await pool.query(
        'SELECT driver_id, execution_ready, ready_generation, verified_fingerprint FROM remote_agent_profiles WHERE id = $1',
        [profId],
      )
    ).rows[0]!
    assert.equal(dbRow.driver_id, null)
    assert.equal(dbRow.execution_ready, false)
    assert.equal(String(dbRow.ready_generation), '1')
    assert.equal(dbRow.verified_fingerprint, null)
  } finally {
    rmSync(keyDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Group 4: P0-1 convertProfileToDriverV4 & revertDriverV4ProfileToLegacy CAS
// ---------------------------------------------------------------------------
test('Group 4: P0-1 atomic CAS cutover and rollback preserve monotonic ready_generation', async () => {
  const fx = await seedFixture('g4')
  const suiteDigest = computeProductionConformanceSuiteDigest()
  assert.match(suiteDigest, /^[a-f0-9]{64}$/)
  const fp = createHash('sha256').update(`g4-codex-${fx.nodeId}`).digest('hex')

  const legacySnapshot = { legacy_key: 'legacy_val', snapshot_sha256: '7'.repeat(64) }
  const legacyManifest = {
    backendKind: 'codex-app-server-v1',
    gatewayRevision: 'codex-remote-adapter-v1',
  }
  const profId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode, status,
          execution_ready, auth_epoch, probe_snapshot, execution_manifest, discovered_models, ready_generation)
       VALUES ($1, 'codex', 'default', $2, 'app-server', 'active',
               TRUE, 'legacy-epoch', $3::jsonb, $4::jsonb, '["gpt-6-luna"]'::jsonb, 1)
       RETURNING id::text AS id`,
      [fx.nodeId, fp, JSON.stringify(legacySnapshot), JSON.stringify(legacyManifest)],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, upstream_model_id, canonical_model_id, base_display_name, enabled)
     VALUES ($1, $2, $3, 'GPT 6 Luna', TRUE)`,
    [profId, CODEX_UPSTREAM, `gpt-6-g4-${randomUUID().slice(0, 6)}-remote`],
  )

  const snap = makeSnapshot('codex', fp)
  const reg = loadRemoteDriverRegistry().get('codex')!
  const targetFp = computeProbeFingerprintTs(snap, {
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256: POLICY_SHA,
  })

  // Engine mismatch rejected
  const ccSnap = makeSnapshot('cc', fp)
  const ccReg = loadRemoteDriverRegistry().get('cc')!
  const ccTargetFp = computeProbeFingerprintTs(ccSnap, {
    driverDigest: ccReg.driverDigest,
    coreDigest: ccReg.coreDigest,
    policySha256: POLICY_SHA,
  })
  await assert.rejects(
    () =>
      convertProfileToDriverV4(pool, {
        profileId: profId,
        driverId: 'cc',
        targetFingerprint: ccTargetFp,
        evidenceDigest: EVIDENCE_SHA,
        suiteDigest,
        policySha256: POLICY_SHA,
        probeSnapshot: ccSnap,
      }),
    /REMOTE_CUTOVER_ENGINE_MISMATCH/,
  )

  // Unreleased binding blocks cutover
  const blockingOpId = randomUUID()
  await pool.query(
    `INSERT INTO remote_agent_bindings
       (operation_id, run_id, uid, container_db_id, docker_id, session_key, node_id, profile_id,
        canonical_model_id, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'legacy-sess', $6, $7, $8, 'hot_idle', NOW() + INTERVAL '1 hour')`,
    [
      blockingOpId,
      randomUUID(),
      fx.uid,
      fx.containerDbId,
      fx.dockerId,
      fx.nodeId,
      profId,
      CODEX_CANONICAL,
    ],
  )
  await assert.rejects(
    () =>
      convertProfileToDriverV4(pool, {
        profileId: profId,
        driverId: 'codex',
        targetFingerprint: targetFp,
        evidenceDigest: EVIDENCE_SHA,
        suiteDigest,
        policySha256: POLICY_SHA,
        probeSnapshot: snap,
      }),
    /REMOTE_CUTOVER_PROFILE_BUSY/,
  )
  await pool.query(`UPDATE remote_agent_bindings SET state = 'released' WHERE operation_id = $1`, [
    blockingOpId,
  ])

  const cut = await convertProfileToDriverV4(pool, {
    profileId: profId,
    driverId: 'codex',
    targetFingerprint: targetFp,
    evidenceDigest: EVIDENCE_SHA,
    suiteDigest,
    policySha256: POLICY_SHA,
    probeSnapshot: snap,
    authEpoch: 'v4-epoch-1',
  })
  assert.equal(cut.readyGeneration, '2')
  assert.equal(cut.verifiedFingerprint, targetFp)

  // Block revert while a v4 binding is unreleased
  const v4OpId = randomUUID()
  await pool.query(
    `INSERT INTO remote_agent_bindings
       (operation_id, run_id, uid, container_db_id, docker_id, session_key, node_id, profile_id,
        canonical_model_id, state, expires_at, remote_protocol_version, driver_id)
     VALUES ($1, $2, $3, $4, $5, 'v4-sess', $6, $7, $8, 'running', NOW() + INTERVAL '1 hour', 4, 'codex')`,
    [
      v4OpId,
      randomUUID(),
      fx.uid,
      fx.containerDbId,
      fx.dockerId,
      fx.nodeId,
      profId,
      CODEX_CANONICAL,
    ],
  )
  await assert.rejects(
    () =>
      revertDriverV4ProfileToLegacy(pool, {
        profileId: profId,
        expectedMinReadyGeneration: '2',
        legacyBackup: cut.legacyBackup,
      }),
    /REMOTE_REVERT_ACTIVE_BINDINGS_EXIST/,
  )
  await pool.query(`UPDATE remote_agent_bindings SET state = 'released' WHERE operation_id = $1`, [
    v4OpId,
  ])

  // CAS generation mismatch rejected
  await assert.rejects(
    () =>
      revertDriverV4ProfileToLegacy(pool, {
        profileId: profId,
        expectedMinReadyGeneration: '99',
        legacyBackup: cut.legacyBackup,
      }),
    /REMOTE_REVERT_CAS_GENERATION_MISMATCH/,
  )

  const rev = await revertDriverV4ProfileToLegacy(pool, {
    profileId: profId,
    expectedMinReadyGeneration: '2',
    legacyBackup: cut.legacyBackup,
  })
  assert.equal(rev.readyGeneration, '3') // Monotonic increase: never rolled back to 1
  const revertedRow = (
    await pool.query(
      'SELECT driver_id, engine_id, verified_fingerprint, execution_ready, auth_epoch, probe_snapshot, execution_manifest, ready_generation FROM remote_agent_profiles WHERE id = $1',
      [profId],
    )
  ).rows[0]!
  assert.equal(revertedRow.driver_id, null)
  assert.equal(revertedRow.engine_id, null)
  assert.equal(revertedRow.verified_fingerprint, null)
  assert.equal(revertedRow.execution_ready, true)
  assert.equal(revertedRow.auth_epoch, 'legacy-epoch')
  assert.deepEqual(revertedRow.probe_snapshot, legacySnapshot)
  assert.deepEqual(revertedRow.execution_manifest, legacyManifest)
  assert.equal(String(revertedRow.ready_generation), '3')
})

// ---------------------------------------------------------------------------
// Group 5: scripts/v5-remote-driver-probe.ts read-only CLI argument enforcement
// ---------------------------------------------------------------------------
test('Group 5: v5-remote-driver-probe CLI enforces read-only dry-run contract', async () => {
  const repoRoot = join(fileURLToPath(new URL('../../../../', import.meta.url)))
  const cliPath = join(repoRoot, 'scripts/v5-remote-driver-probe.ts')
  await assert.rejects(
    () =>
      execFileAsync(
        'npx',
        ['tsx', cliPath, '--profile-id', randomUUID(), '--driver', 'cc', '--write'],
        { cwd: repoRoot },
      ),
    (err: any) => err && typeof err.code === 'number' && err.code !== 0,
  )
  await assert.rejects(
    () => execFileAsync('npx', ['tsx', cliPath, '--driver', 'cc'], { cwd: repoRoot }),
    (err: any) => err && typeof err.code === 'number' && err.code !== 0,
  )
})
