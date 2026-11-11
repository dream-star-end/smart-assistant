/**
 * `remote-driver-v4` Fingerprint Drift & Auto-Verification Closed-Loop Coordinator (`AC-3`).
 *
 * State machine invariants:
 * 1. Fingerprint excludes volatile timestamps (`observedAt`) and binds `(engineId, driverId,
 *    driverVersion, driverDigest, coreDigest, policySha256, cliVersion, cliSha256,
 *    nativeSha256, bridgeSha256, sorted semantic model descriptors)` — byte-identical to
 *    Python `compute_probe_fingerprint` (`scripts/agent-remote/core/contract.py`).
 * 2. When a probe observes a new unverified fingerprint (or auth epoch change), a SINGLE PG
 *    transaction writes `probe_snapshot`, sets `execution_ready = FALSE`, increments
 *    `ready_generation`, supersedes stale verification runs, and enqueues at most one active
 *    `remote_driver_verification_runs` row (`auto_eligible = FALSE` if `auth_epoch` changed).
 * 3. Identical repeat probes while the same `target_fingerprint` is already queued/running
 *    refresh `last_probe_ok_at` without bumping `ready_generation` or re-enqueuing; a secondary
 *    drift (`FP_A -> FP_B`) immediately bumps `ready_generation` and supersedes `FP_A`.
 * 4. `completeDriverVerificationRun` restores `execution_ready = TRUE` via CAS ONLY when all
 *    7 invariants hold (valid evidence digest, not admin-disabled, matching `ready_generation`,
 *    matching `auth_epoch`, recomputed `probe_snapshot` fingerprint == `target_fingerprint`,
 *    matching `coreDigest` + `driverDigest`, and zero unreleased verification test bindings).
 * 5. Failed verification keeps `execution_ready = FALSE` and emits at most ONE admin alert per
 *    `(profile_id, target_fingerprint)`.
 */
import type { Pool, PoolClient } from 'pg'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  remoteCanonicalSha256,
  validateRemoteProbeSnapshot,
  type RemoteProbeSnapshot,
} from '@openclaude/protocol'
import { EVENTS } from '../../admin/alertEvents.js'
import { loadRemoteDriverRegistry } from './registry.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export const REMOTE_DRIVER_VERIFICATION_SESSION_PREFIX = 'remote-driver-verify:'

function need(condition: unknown, code = 'REMOTE_DRIFT_COORDINATOR_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export function verificationSessionKeyForRun(runId: string): string {
  need(UUID_RE.test(runId), 'REMOTE_VERIFICATION_RUN_ID_INVALID')
  return `${REMOTE_DRIVER_VERIFICATION_SESSION_PREFIX}${runId}`
}

export function computeProbeFingerprintTs(
  rawSnapshot: RemoteProbeSnapshot,
  digests: {
    readonly driverDigest: string
    readonly coreDigest: string
    readonly policySha256: string
  },
): string {
  const snapshot = validateRemoteProbeSnapshot(rawSnapshot)
  need(
    SHA256_RE.test(digests.driverDigest) &&
      SHA256_RE.test(digests.coreDigest) &&
      SHA256_RE.test(digests.policySha256),
    'REMOTE_PROBE_DIGEST_INVALID',
  )
  const modelsSem = [...snapshot.models]
    .sort((a, b) =>
      a.upstreamModelId < b.upstreamModelId ? -1 : a.upstreamModelId > b.upstreamModelId ? 1 : 0,
    )
    .map((m) => ({
      upstreamModelId: m.upstreamModelId,
      supportedEfforts: [...m.supportedEfforts],
      defaultEffort: m.defaultEffort ?? null,
      supportsAdaptiveThinking: m.supportsAdaptiveThinking,
      supportsVision: m.supportsVision,
    }))

  return remoteCanonicalSha256({
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: snapshot.engineId,
    driverId: snapshot.driverId,
    driverVersion: snapshot.driverVersion,
    driverDigest: digests.driverDigest,
    coreDigest: digests.coreDigest,
    policySha256: digests.policySha256,
    cliVersion: snapshot.cliVersion,
    cliSha256: snapshot.cliSha256,
    nativeSha256: snapshot.nativeSha256 ?? null,
    bridgeSha256: snapshot.bridgeSha256 ?? null,
    models: modelsSem,
  })
}

export interface RecordDriverProbeInput {
  readonly profileId: string
  readonly snapshot: RemoteProbeSnapshot
  readonly policySha256: string
  readonly authEpoch?: string
  readonly driverDigest?: string
  readonly coreDigest?: string
  readonly suiteDigest?: string
  readonly registryPath?: string
  readonly forceManualRetry?: boolean
}

export interface RecordDriverProbeResult {
  readonly profileId: string
  readonly drifted: boolean
  readonly executionReady: boolean
  readonly fingerprint: string
  readonly readyGeneration: string
  readonly verificationRunId: string | null
  readonly autoEligible: boolean
}

export async function recordDriverProbeSnapshot(
  pool: Pool,
  input: RecordDriverProbeInput,
): Promise<RecordDriverProbeResult> {
  need(UUID_RE.test(input.profileId), 'REMOTE_PROFILE_ID_INVALID')
  const snapshot = validateRemoteProbeSnapshot(input.snapshot)
  const regMap = loadRemoteDriverRegistry(input.registryPath)
  const reg = regMap.get(snapshot.driverId)
  need(
    reg &&
      reg.engineId === snapshot.engineId &&
      reg.driverVersion === snapshot.driverVersion,
    'REMOTE_DRIVER_NOT_REGISTERED',
  )
  const driverDigest = input.driverDigest ?? reg.driverDigest
  const coreDigest = input.coreDigest ?? reg.coreDigest
  const fingerprint = computeProbeFingerprintTs(snapshot, {
    driverDigest,
    coreDigest,
    policySha256: input.policySha256,
  })
  if (input.suiteDigest !== undefined) {
    need(SHA256_RE.test(input.suiteDigest), 'REMOTE_SUITE_DIGEST_INVALID')
  }

  const healthyProbe =
    snapshot.authPresent === true &&
    snapshot.accountObserved === true &&
    snapshot.models.length > 0

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const profRes = await client.query(
      'SELECT * FROM remote_agent_profiles WHERE id = $1 FOR UPDATE',
      [input.profileId],
    )
    need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
    const row = profRes.rows[0]!
    const prevAuthEpoch: string | null = row.auth_epoch ?? null
    const effectiveAuthEpoch: string | null =
      input.authEpoch !== undefined ? input.authEpoch : prevAuthEpoch
    const authChanged =
      input.authEpoch !== undefined && prevAuthEpoch !== null && input.authEpoch !== prevAuthEpoch
    const adminDisabled = row.disabled_by === 'admin'
    const prevManifest =
      row.execution_manifest && typeof row.execution_manifest === 'object'
        ? (row.execution_manifest as Record<string, unknown>)
        : {}
    const prevObservedFp =
      typeof prevManifest.latestFingerprint === 'string' ? prevManifest.latestFingerprint : null

    const nextManifest = {
      ...prevManifest,
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      backendKind: REMOTE_DRIVER_BACKEND,
      driverId: snapshot.driverId,
      engineId: snapshot.engineId,
      driverVersion: snapshot.driverVersion,
      driverDigest,
      coreDigest,
      policySha256: input.policySha256,
      latestFingerprint: fingerprint,
    }

    const discoveredModels = snapshot.models.map((m) => ({
      upstream_model_id: m.upstreamModelId,
      display_name: m.displayName,
      supported_reasoning_efforts: m.supportedEfforts,
      default_reasoning_effort: m.defaultEffort,
      supports_adaptive_thinking: m.supportsAdaptiveThinking,
      supports_vision: m.supportsVision,
    }))

    // Case 1: Already verified for this exact fingerprint and probe remains healthy & same auth_epoch.
    if (
      healthyProbe &&
      !authChanged &&
      !adminDisabled &&
      row.execution_ready === true &&
      row.verified_fingerprint === fingerprint &&
      !input.forceManualRetry
    ) {
      await client.query(
        `UPDATE remote_agent_profiles
            SET driver_id = $2,
                engine_id = $3,
                cli_version = $4,
                probe_snapshot = $5::jsonb,
                execution_manifest = $6::jsonb,
                discovered_models = $7::jsonb,
                auth_epoch = COALESCE($8, auth_epoch),
                last_probe_ok_at = NOW(),
                probe_failures = 0,
                last_error = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [
          input.profileId,
          snapshot.driverId,
          snapshot.engineId,
          snapshot.cliVersion,
          JSON.stringify(snapshot),
          JSON.stringify(nextManifest),
          JSON.stringify(discoveredModels),
          effectiveAuthEpoch,
        ],
      )
      await client.query('COMMIT')
      return {
        profileId: input.profileId,
        drifted: false,
        executionReady: true,
        fingerprint,
        readyGeneration: String(row.ready_generation),
        verificationRunId: null,
        autoEligible: true,
      }
    }

    // Case 2: Repeat probe of the exact same unverified fingerprint while already `execution_ready = false`
    // and `!authChanged` — do NOT bump `ready_generation` (so an in-flight verification run for this
    // exact fingerprint is not spuriously superseded).
    if (
      row.execution_ready === false &&
      prevObservedFp === fingerprint &&
      !authChanged &&
      !input.forceManualRetry
    ) {
      const existingActive = (
        await client.query<{ id: string; auto_eligible: boolean }>(
          `SELECT id::text AS id, auto_eligible
             FROM remote_driver_verification_runs
            WHERE profile_id = $1
              AND target_fingerprint = $2
              AND state IN ('pending', 'running')
            LIMIT 1`,
          [input.profileId, fingerprint],
        )
      ).rows[0]
      await client.query(
        `UPDATE remote_agent_profiles
            SET probe_snapshot = $2::jsonb,
                execution_manifest = $3::jsonb,
                last_probe_ok_at = CASE WHEN $4::boolean THEN NOW() ELSE last_probe_ok_at END,
                updated_at = NOW()
          WHERE id = $1`,
        [input.profileId, JSON.stringify(snapshot), JSON.stringify(nextManifest), healthyProbe],
      )
      await client.query('COMMIT')
      return {
        profileId: input.profileId,
        drifted: false,
        executionReady: false,
        fingerprint,
        readyGeneration: String(row.ready_generation),
        verificationRunId: existingActive?.id ?? null,
        autoEligible: existingActive?.auto_eligible ?? false,
      }
    }

    // Case 3: Genuine fingerprint drift, initial unverified observation, auth change, or manual retry.
    const nextGeneration = BigInt(row.ready_generation) + 1n
    await client.query(
      `UPDATE remote_agent_profiles
          SET driver_id = $2,
              engine_id = $3,
              cli_version = $4,
              probe_snapshot = $5::jsonb,
              execution_manifest = $6::jsonb,
              discovered_models = $7::jsonb,
              auth_epoch = COALESCE($8, auth_epoch),
              execution_ready = FALSE,
              ready_generation = $9,
              last_probe_ok_at = CASE WHEN $10::boolean THEN NOW() ELSE last_probe_ok_at END,
              last_error = CASE WHEN $10::boolean THEN NULL ELSE 'REMOTE_PROBE_UNHEALTHY' END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        input.profileId,
        snapshot.driverId,
        snapshot.engineId,
        snapshot.cliVersion,
        JSON.stringify(snapshot),
        JSON.stringify(nextManifest),
        JSON.stringify(discoveredModels),
        effectiveAuthEpoch,
        nextGeneration.toString(),
        healthyProbe,
      ],
    )

    // Supersede any pending/running verification runs for older fingerprints or older generations.
    await client.query(
      `UPDATE remote_driver_verification_runs
          SET state = 'superseded',
              error_code = 'SUPERSEDED_BY_NEWER_PROBE',
              completed_at = NOW(),
              updated_at = NOW()
        WHERE profile_id = $1
          AND state IN ('pending', 'running')
          AND (target_fingerprint <> $2 OR ready_generation < $3)`,
      [input.profileId, fingerprint, nextGeneration.toString()],
    )

    let verificationRunId: string | null = null
    const autoEligible = !authChanged
    if (healthyProbe && !adminDisabled) {
      const priorFailed = (
        await client.query(
          `SELECT 1 FROM remote_driver_verification_runs
            WHERE profile_id = $1
              AND target_fingerprint = $2
              AND state = 'failed'
            LIMIT 1`,
          [input.profileId, fingerprint],
        )
      ).rows[0]
      if (!priorFailed || input.forceManualRetry) {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO remote_driver_verification_runs
             (node_id, profile_id, engine_id, driver_id, target_fingerprint,
              driver_digest, core_digest, suite_digest, ready_generation,
              auth_epoch, auto_eligible, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
           ON CONFLICT (profile_id, target_fingerprint)
             WHERE state IN ('pending', 'running')
           DO NOTHING
           RETURNING id::text AS id`,
          [
            row.node_id,
            input.profileId,
            snapshot.engineId,
            snapshot.driverId,
            fingerprint,
            driverDigest,
            coreDigest,
            input.suiteDigest ?? null,
            nextGeneration.toString(),
            effectiveAuthEpoch,
            autoEligible,
          ],
        )
        verificationRunId = ins.rows[0]?.id ?? null
      }
    }

    await client.query('COMMIT')
    return {
      profileId: input.profileId,
      drifted: true,
      executionReady: false,
      fingerprint,
      readyGeneration: nextGeneration.toString(),
      verificationRunId,
      autoEligible,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export interface VerificationRunView {
  readonly id: string
  readonly nodeId: string
  readonly profileId: string
  readonly engineId: string
  readonly driverId: string
  readonly targetFingerprint: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly suiteDigest: string | null
  readonly readyGeneration: string
  readonly authEpoch: string | null
  readonly autoEligible: boolean
  readonly state: 'pending' | 'running' | 'passed' | 'failed' | 'superseded' | 'aborted'
  readonly leaseOwner: string | null
  readonly attemptCount: number
  readonly alertEmitted: boolean
}

function mapRunRow(r: Record<string, any>): VerificationRunView {
  return {
    id: String(r.id),
    nodeId: String(r.node_id),
    profileId: String(r.profile_id),
    engineId: String(r.engine_id),
    driverId: String(r.driver_id),
    targetFingerprint: String(r.target_fingerprint),
    driverDigest: String(r.driver_digest),
    coreDigest: String(r.core_digest),
    suiteDigest: r.suite_digest ? String(r.suite_digest) : null,
    readyGeneration: String(r.ready_generation),
    authEpoch: r.auth_epoch ? String(r.auth_epoch) : null,
    autoEligible: Boolean(r.auto_eligible),
    state: r.state,
    leaseOwner: r.lease_owner ? String(r.lease_owner) : null,
    attemptCount: Number(r.attempt_count ?? 0),
    alertEmitted: Boolean(r.alert_emitted),
  }
}

export async function claimDriverVerificationRun(
  pool: Pool,
  input: {
    readonly leaseOwner: string
    readonly leaseMs?: number
    readonly profileId?: string
    readonly allowManual?: boolean
    readonly maxAttempts?: number
  },
): Promise<VerificationRunView | null> {
  need(
    typeof input.leaseOwner === 'string' && input.leaseOwner.trim().length > 0,
    'REMOTE_VERIFICATION_OWNER_INVALID',
  )
  const leaseMs = Math.min(15 * 60_000, Math.max(5_000, Math.floor(input.leaseMs ?? 5 * 60_000)))
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 1))
  const res = await pool.query(
    `WITH candidate AS (
       SELECT r.id
         FROM remote_driver_verification_runs r
         JOIN remote_agent_profiles p ON p.id = r.profile_id
         JOIN remote_agent_nodes n ON n.id = r.node_id
        WHERE ($3::uuid IS NULL OR r.profile_id = $3::uuid)
          AND (r.auto_eligible = TRUE OR $4::boolean = TRUE)
          AND r.attempt_count < $5
          AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
          AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
          AND (
            r.state = 'pending'
            OR (r.state = 'running' AND r.lease_until IS NOT NULL AND r.lease_until <= NOW())
          )
        ORDER BY r.created_at ASC
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1
     )
     UPDATE remote_driver_verification_runs r
        SET state = 'running',
            lease_owner = $1,
            lease_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
            attempt_count = r.attempt_count + 1,
            updated_at = NOW()
       FROM candidate c
      WHERE r.id = c.id
      RETURNING r.*`,
    [
      input.leaseOwner.trim(),
      leaseMs,
      input.profileId ?? null,
      Boolean(input.allowManual),
      maxAttempts,
    ],
  )
  if (res.rows.length === 0) return null
  return mapRunRow(res.rows[0]!)
}

async function emitDeduplicatedVerificationFailureAlert(
  client: PoolClient,
  info: {
    readonly runId: string
    readonly profileId: string
    readonly nodeId: string
    readonly driverId: string
    readonly engineId: string
    readonly targetFingerprint: string
    readonly errorCode: string
    readonly errorDetail: string | null
  },
): Promise<void> {
  const dedupeKey = `${EVENTS.OPS_REMOTE_DRIVER_VERIFICATION_FAILED}:${info.profileId}:${info.targetFingerprint}`
  const title = `远端驱动漂移自动复验失败 (${info.driverId})`
  const body =
    `profile=${info.profileId} driver=${info.driverId} fingerprint=${info.targetFingerprint.slice(0, 16)} ` +
    `error=${info.errorCode}${info.errorDetail ? ` detail=${info.errorDetail}` : ''}`
  const payload = {
    runId: info.runId,
    profileId: info.profileId,
    nodeId: info.nodeId,
    driverId: info.driverId,
    engineId: info.engineId,
    targetFingerprint: info.targetFingerprint,
    errorCode: info.errorCode,
  }

  const channels = (
    await client.query<{ id: string; event_types: unknown }>(
      `SELECT id::text AS id, event_types
         FROM admin_alert_channels
        WHERE enabled = TRUE`,
    )
  ).rows.filter(
    (ch) =>
      Array.isArray(ch.event_types) &&
      (ch.event_types.length === 0 ||
        ch.event_types.includes(EVENTS.OPS_REMOTE_DRIVER_VERIFICATION_FAILED)),
  )

  if (channels.length === 0) {
    await client.query(
      `INSERT INTO admin_alert_outbox
         (event_type, severity, dedupe_key, title, body, payload, channel_id, status, attempts)
       VALUES ($1, 'warning', $2, $3, $4, $5::jsonb, NULL, 'skipped', 0)`,
      [
        EVENTS.OPS_REMOTE_DRIVER_VERIFICATION_FAILED,
        dedupeKey,
        title,
        body,
        JSON.stringify(payload),
      ],
    )
    return
  }

  for (const ch of channels) {
    await client.query(
      `INSERT INTO admin_alert_outbox
         (event_type, severity, dedupe_key, title, body, payload, channel_id, status, attempts)
       VALUES ($1, 'warning', $2, $3, $4, $5::jsonb, $6::bigint, 'pending', 0)
       ON CONFLICT (channel_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed')
       DO NOTHING`,
      [
        EVENTS.OPS_REMOTE_DRIVER_VERIFICATION_FAILED,
        dedupeKey,
        title,
        body,
        JSON.stringify(payload),
        ch.id,
      ],
    )
  }
}

export interface CompleteDriverVerificationInput {
  readonly runId: string
  readonly leaseOwner: string
  readonly outcome: 'passed' | 'failed'
  readonly evidenceDigest?: string
  readonly evidenceUri?: string
  readonly errorCode?: string
  readonly errorDetail?: string
  readonly currentDriverDigest?: string
  readonly currentCoreDigest?: string
  readonly registryPath?: string
}

export interface CompleteDriverVerificationResult {
  readonly state: 'passed' | 'failed' | 'superseded' | 'aborted'
  readonly executionReadyRestored: boolean
  readonly alertEmitted: boolean
  readonly rejectReason?: string
}

export async function completeDriverVerificationRun(
  pool: Pool,
  input: CompleteDriverVerificationInput,
): Promise<CompleteDriverVerificationResult> {
  need(UUID_RE.test(input.runId), 'REMOTE_VERIFICATION_RUN_ID_INVALID')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const runRes = await client.query(
      'SELECT * FROM remote_driver_verification_runs WHERE id = $1 FOR UPDATE',
      [input.runId],
    )
    need(runRes.rows.length === 1, 'REMOTE_VERIFICATION_RUN_NOT_FOUND')
    const run = runRes.rows[0]!
    if (run.state === 'superseded') {
      await client.query('COMMIT')
      return {
        state: 'superseded',
        executionReadyRestored: false,
        alertEmitted: false,
        rejectReason: 'SUPERSEDED_BY_NEWER_PROBE',
      }
    }
    need(
      run.state === 'running' &&
        run.lease_owner === input.leaseOwner &&
        run.lease_until &&
        new Date(run.lease_until).getTime() > Date.now(),
      'REMOTE_VERIFICATION_LEASE_LOST',
    )

    const profRes = await client.query(
      `SELECT p.*, n.disabled_by AS node_disabled_by, n.status AS node_status
         FROM remote_agent_profiles p
         JOIN remote_agent_nodes n ON n.id = p.node_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [run.profile_id],
    )
    need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
    const profile = profRes.rows[0]!

    if (input.outcome === 'failed') {
      const errorCode = input.errorCode ?? 'REMOTE_DRIVER_VERIFICATION_FAILED'
      const errorDetail = input.errorDetail ?? null
      const priorAlert = (
        await client.query(
          `SELECT 1 FROM remote_driver_verification_runs
            WHERE profile_id = $1
              AND target_fingerprint = $2
              AND alert_emitted = TRUE
            LIMIT 1`,
          [run.profile_id, run.target_fingerprint],
        )
      ).rows[0]
      const shouldAlert = !priorAlert

      await client.query(
        `UPDATE remote_driver_verification_runs
            SET state = 'failed',
                alert_emitted = $2,
                error_code = $3,
                error_detail = $4,
                evidence_digest = $5,
                evidence_uri = $6,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [
          input.runId,
          shouldAlert,
          errorCode,
          errorDetail,
          input.evidenceDigest ?? null,
          input.evidenceUri ?? null,
        ],
      )
      await client.query(
        `UPDATE remote_agent_profiles
            SET execution_ready = FALSE,
                last_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [run.profile_id, errorCode],
      )
      if (shouldAlert) {
        await emitDeduplicatedVerificationFailureAlert(client, {
          runId: String(run.id),
          profileId: String(run.profile_id),
          nodeId: String(run.node_id),
          driverId: String(run.driver_id),
          engineId: String(run.engine_id),
          targetFingerprint: String(run.target_fingerprint),
          errorCode,
          errorDetail,
        })
      }
      await client.query('COMMIT')
      return {
        state: 'failed',
        executionReadyRestored: false,
        alertEmitted: shouldAlert,
      }
    }

    // Outcome === 'passed': verify all 7 CAS invariants before restoring `execution_ready = TRUE`.
    need(
      typeof input.evidenceDigest === 'string' && SHA256_RE.test(input.evidenceDigest),
      'REMOTE_VERIFICATION_EVIDENCE_DIGEST_REQUIRED',
    )
    const regMap = loadRemoteDriverRegistry(input.registryPath)
    const reg = regMap.get(String(run.driver_id))
    const currentDriverDigest = input.currentDriverDigest ?? reg?.driverDigest
    const currentCoreDigest = input.currentCoreDigest ?? reg?.coreDigest

    const manifest =
      profile.execution_manifest && typeof profile.execution_manifest === 'object'
        ? (profile.execution_manifest as Record<string, unknown>)
        : {}
    const policySha256 = typeof manifest.policySha256 === 'string' ? manifest.policySha256 : ''
    let recomputedFp: string | null = null
    if (profile.probe_snapshot && SHA256_RE.test(policySha256) && currentDriverDigest && currentCoreDigest) {
      try {
        recomputedFp = computeProbeFingerprintTs(profile.probe_snapshot as RemoteProbeSnapshot, {
          driverDigest: currentDriverDigest,
          coreDigest: currentCoreDigest,
          policySha256,
        })
      } catch {
        recomputedFp = null
      }
    }

    const unreleasedTestBindings = Number(
      (
        await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt
             FROM remote_agent_bindings
            WHERE profile_id = $1
              AND session_key = $2
              AND state <> 'released'`,
          [run.profile_id, verificationSessionKeyForRun(String(run.id))],
        )
      ).rows[0]?.cnt ?? '0',
    )

    let abortReason: string | null = null
    let targetRunState: 'superseded' | 'aborted' = 'aborted'
    if (profile.disabled_by === 'admin' || profile.node_disabled_by === 'admin') {
      abortReason = 'ADMIN_DISABLED'
    } else if (!['active', 'degraded'].includes(String(profile.status))) {
      abortReason = 'PROFILE_STATUS_NOT_SERVABLE'
    } else if (BigInt(profile.ready_generation) !== BigInt(run.ready_generation)) {
      abortReason = 'SECONDARY_DRIFT_READY_GENERATION_MISMATCH'
      targetRunState = 'superseded'
    } else if ((profile.auth_epoch ?? null) !== (run.auth_epoch ?? null)) {
      abortReason = 'AUTH_EPOCH_CHANGED'
      targetRunState = 'superseded'
    } else if (
      !currentDriverDigest ||
      !currentCoreDigest ||
      run.driver_digest !== currentDriverDigest ||
      run.core_digest !== currentCoreDigest
    ) {
      abortReason = 'CODE_DIGEST_CHANGED_DURING_VERIFICATION'
      targetRunState = 'superseded'
    } else if (recomputedFp !== String(run.target_fingerprint)) {
      abortReason = 'PROBE_FINGERPRINT_CHANGED_DURING_VERIFICATION'
      targetRunState = 'superseded'
    } else if (unreleasedTestBindings > 0) {
      abortReason = 'VERIFICATION_TEST_BINDING_NOT_RELEASED'
    }

    if (abortReason !== null) {
      await client.query(
        `UPDATE remote_driver_verification_runs
            SET state = $2,
                error_code = $3,
                evidence_digest = $4,
                evidence_uri = $5,
                completed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [
          input.runId,
          targetRunState,
          abortReason,
          input.evidenceDigest,
          input.evidenceUri ?? null,
        ],
      )
      await client.query('COMMIT')
      return {
        state: targetRunState,
        executionReadyRestored: false,
        alertEmitted: false,
        rejectReason: abortReason,
      }
    }

    const updatedManifest = {
      ...manifest,
      verifiedAt: new Date().toISOString(),
      verifiedFingerprint: String(run.target_fingerprint),
      evidenceDigest: input.evidenceDigest,
      ...(input.evidenceUri ? { evidenceUri: input.evidenceUri } : {}),
    }

    const casProfile = await client.query(
      `UPDATE remote_agent_profiles
          SET execution_ready = TRUE,
              verified_fingerprint = $2,
              execution_manifest = $3::jsonb,
              last_probe_ok_at = NOW(),
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND ready_generation = $4
          AND auth_epoch IS NOT DISTINCT FROM $5
          AND (disabled_by IS NULL OR disabled_by <> 'admin')`,
      [
        run.profile_id,
        run.target_fingerprint,
        JSON.stringify(updatedManifest),
        run.ready_generation,
        run.auth_epoch ?? null,
      ],
    )
    need(casProfile.rowCount === 1, 'REMOTE_VERIFICATION_CAS_FAILED')

    await client.query(
      `UPDATE remote_driver_verification_runs
          SET state = 'passed',
              evidence_digest = $2,
              evidence_uri = $3,
              error_code = NULL,
              error_detail = NULL,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [input.runId, input.evidenceDigest, input.evidenceUri ?? null],
    )
    await client.query('COMMIT')
    return {
      state: 'passed',
      executionReadyRestored: true,
      alertEmitted: false,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
