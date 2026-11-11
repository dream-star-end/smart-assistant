/**
 * Generic `remote-driver-v4` lane placement and binding lifecycle (`AC-4`, `AC-5`, `AC-6`).
 *
 * Key invariants:
 * - Zero per-engine branches (`AC-6`): driver metadata, resource caps, and digests come from
 *   `scripts/agent-remote/drivers/registry.json`.
 * - Independent `(node, engine, profile)` pool concurrency (`min(row.max_concurrent_lanes,
 *   reg.profileMaxLanes)`, default 5) with NO account-wide exclusive lock, so 2+ concurrent
 *   sessions on the same account overlap cleanly while cross-engine profiles on the same node
 *   never starve each other.
 * - Unready or fingerprint-drifted profiles fail closed with `REMOTE_DRIVER_REVERIFY_REQUIRED`
 *   for user traffic while permitting bounded leased verification runs (`AC-3`).
 * - Respects `RemoteReleaseDrainCoordinator` (`REMOTE_POOL_DRAINING_RETRY_LATER`) during R1
 *   cutover (`AC-5`) and seamlessly upgrades sticky v1/v3 bindings to v4 on the next generation.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  remoteCanonicalSha256,
  validateRemoteProbeSnapshot,
  type RemoteProbeSnapshot,
} from '@openclaude/protocol'
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import type {
  RemotePoolBinding,
  RemotePoolLaneSpec,
  RemotePoolNodeManifest,
} from '@openclaude/gateway/remote-pool'

export type RemotePoolSshTarget = RemoteCcTarget
import {
  CODEX_REMOTE_BILLING_RECOVERY_VERSION,
  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
  REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
} from '../../billing/remoteNativeBillingIdentity.js'
import { getPool } from '../../db/index.js'
import {
  rankRemotePoolCandidates,
  remoteNodeExecKeyDir,
  type RemoteBrainEngine,
} from '../remoteBrainPool.js'
import type { RemoteReleaseDrainCoordinator } from './drainGate.js'
import {
  computeProbeFingerprintTs,
  verificationSessionKeyForRun,
} from './driftCoordinator.js'
import {
  legacyBindingEngineForAuthority,
  legacyProfileEngineForAuthority,
  loadRemoteDriverRegistry,
} from './registry.js'

const DEFAULT_MAX_PROBE_AGE_MS = 10 * 60_000
const DEFAULT_BINDING_TTL_MS = 24 * 60 * 60_000
const SHA256_RE = /^[a-f0-9]{64}$/

function need(condition: unknown, code = 'REMOTE_DRIVER_PLACEMENT_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface PlaceRemoteDriverLaneInput {
  readonly uid: number | string
  readonly containerDbId: string
  readonly dockerId: string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly driverId: string
  readonly driverContext?: Record<string, unknown>
  readonly verificationRun?: {
    readonly runId: string
    readonly leaseOwner: string
  }
}

export interface PlaceRemoteDriverLaneOptions {
  readonly pool?: Pool
  readonly registryPath?: string
  readonly drainGate?: RemoteReleaseDrainCoordinator
  readonly maxProbeAgeMs?: number
  readonly ttlMs?: number
  readonly now?: () => number
  /** Hermetic `/tmp/oc-drvtest-*` directory for local controller conformance runs. */
  readonly localSandboxDir?: string
}

export interface RemoteDriverPlacementResult {
  readonly binding: RemotePoolBinding
  readonly spec: RemotePoolLaneSpec
  readonly sshTarget: RemotePoolSshTarget
  readonly nodeId: string
  readonly profileUuid: string
  readonly profileName: string
  readonly generation: string
}

function verifyProfileReadyForV4(
  row: Record<string, any>,
  expectedDriverDigest: string,
  expectedCoreDigest: string,
  nowMs: number,
  maxProbeAgeMs: number,
): { ready: true; snapshot: RemoteProbeSnapshot; fingerprint: string } | { ready: false; reason: 'reverify' | 'stale' } {
  if (row.execution_ready !== true || typeof row.verified_fingerprint !== 'string') {
    return { ready: false, reason: 'reverify' }
  }
  if (!row.probe_snapshot || typeof row.probe_snapshot !== 'object') {
    return { ready: false, reason: 'reverify' }
  }
  const manifest =
    row.execution_manifest && typeof row.execution_manifest === 'object'
      ? (row.execution_manifest as Record<string, unknown>)
      : {}
  const policySha256 = typeof manifest.policySha256 === 'string' ? manifest.policySha256 : ''
  if (!SHA256_RE.test(policySha256)) {
    return { ready: false, reason: 'reverify' }
  }
  let snapshot: RemoteProbeSnapshot
  let computedFp: string
  try {
    snapshot = validateRemoteProbeSnapshot(row.probe_snapshot)
    computedFp = computeProbeFingerprintTs(snapshot, {
      driverDigest: expectedDriverDigest,
      coreDigest: expectedCoreDigest,
      policySha256,
    })
  } catch {
    return { ready: false, reason: 'reverify' }
  }
  if (computedFp !== row.verified_fingerprint) {
    return { ready: false, reason: 'reverify' }
  }
  if (row.last_probe_ok_at) {
    const probeAge = nowMs - new Date(row.last_probe_ok_at).getTime()
    if (probeAge > maxProbeAgeMs) {
      return { ready: false, reason: 'stale' }
    }
  }
  return { ready: true, snapshot, fingerprint: computedFp }
}

export async function placeRemoteDriverLane(
  input: PlaceRemoteDriverLaneInput,
  options: PlaceRemoteDriverLaneOptions = {},
): Promise<RemoteDriverPlacementResult> {
  if (process.env.OC_REMOTE_POOL_EXECUTION_ENABLED === '0') {
    throw new Error('REMOTE_POOL_EXECUTION_DISABLED')
  }
  options.drainGate?.assertAdmissionOpen()

  const pool = options.pool ?? getPool()
  const now = options.now ?? Date.now
  const nowMs = now()
  const maxProbeAgeMs = options.maxProbeAgeMs ?? DEFAULT_MAX_PROBE_AGE_MS
  const ttlMs = options.ttlMs ?? DEFAULT_BINDING_TTL_MS

  const regMap = loadRemoteDriverRegistry(options.registryPath)
  const reg = regMap.get(input.driverId)
  need(reg !== undefined, 'REMOTE_DRIVER_NOT_REGISTERED')

  const uidStr = String(input.uid)
  need(/^[1-9][0-9]{0,18}$/.test(uidStr), 'REMOTE_PLACEMENT_UID_INVALID')
  need(/^[1-9][0-9]{0,18}$/.test(input.containerDbId), 'REMOTE_PLACEMENT_CONTAINER_INVALID')
  need(SHA256_RE.test(input.dockerId), 'REMOTE_PLACEMENT_DOCKER_INVALID')
  need(
    typeof input.sessionKey === 'string' &&
      input.sessionKey.length > 0 &&
      input.sessionKey.length <= 512,
    'REMOTE_PLACEMENT_SESSION_INVALID',
  )

  const legacyProfileEngine = legacyProfileEngineForAuthority(reg.authorityEngine)
  const legacyBindEngine = legacyBindingEngineForAuthority(reg.authorityEngine)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`remote-chat:${uidStr}:${input.sessionKey}`],
    )

    const busy = await client.query(
      `SELECT operation_id FROM remote_agent_bindings
        WHERE uid = $1 AND session_key = $2 AND state <> 'released'
        LIMIT 1`,
      [uidStr, input.sessionKey],
    )
    if (busy.rows.length > 0) {
      throw new Error('REMOTE_LANE_STOP_UNPROVEN')
    }

    let selectedRow: Record<string, any> | undefined
    let verifiedProbe: RemoteProbeSnapshot | undefined
    let activeFingerprint: string | undefined

    if (input.verificationRun) {
      const expectedSessionKey = verificationSessionKeyForRun(input.verificationRun.runId)
      need(
        input.sessionKey === expectedSessionKey,
        'REMOTE_VERIFICATION_SESSION_KEY_MISMATCH',
      )
      const vRun = (
        await client.query(
          `SELECT * FROM remote_driver_verification_runs
            WHERE id = $1
              AND state = 'running'
              AND lease_owner = $2
              AND lease_until > NOW()
              AND driver_id = $3
            FOR UPDATE`,
          [input.verificationRun.runId, input.verificationRun.leaseOwner, reg.driverId],
        )
      ).rows[0]
      need(vRun !== undefined, 'REMOTE_VERIFICATION_RUN_NOT_AUTHORIZED')

      const cand = (
        await client.query(
          `SELECT p.*, p.id AS profile_id, p.node_id,
                  o.id AS offer_id, o.upstream_model_id, o.canonical_model_id,
                  n.label, n.ssh_host, n.ssh_port, n.ssh_user, n.host_key_fp, n.key_id,
                  n.rtt_ms_p50, n.status AS node_status
             FROM remote_model_offers o
             JOIN remote_agent_profiles p ON p.id = o.profile_id
             JOIN remote_agent_nodes n ON n.id = p.node_id
            WHERE p.id = $1
              AND o.canonical_model_id = $2
              AND o.enabled = TRUE
              AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
              AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
            FOR UPDATE OF p`,
          [vRun.profile_id, input.canonicalModel],
        )
      ).rows[0]
      need(cand !== undefined, 'REMOTE_VERIFICATION_PROFILE_UNAVAILABLE')

      const used = Number(
        (
          await client.query<{ profile_used: number }>(
            `SELECT COUNT(*)::int AS profile_used
               FROM remote_agent_bindings
              WHERE profile_id = $1 AND state <> 'released'`,
            [cand.profile_id],
          )
        ).rows[0]?.profile_used ?? 0,
      )
      const effectiveCap = Math.min(Number(cand.max_concurrent_lanes), reg.profileMaxLanes)
      if (used >= effectiveCap) {
        throw Object.assign(new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'), {
          profiles: [String(cand.profile_id)],
        })
      }
      const snap = validateRemoteProbeSnapshot(cand.probe_snapshot)
      const manifest = (cand.execution_manifest ?? {}) as Record<string, unknown>
      const fp = computeProbeFingerprintTs(snap, {
        driverDigest: reg.driverDigest,
        coreDigest: reg.coreDigest,
        policySha256: String(manifest.policySha256 ?? ''),
      })
      need(fp === String(vRun.target_fingerprint), 'REMOTE_VERIFICATION_FINGERPRINT_DRIFTED')
      selectedRow = cand
      verifiedProbe = snap
      activeFingerprint = fp
    } else {
      const candidates = (
        await client.query(
          `SELECT p.*, p.id AS profile_id, p.node_id,
                  o.id AS offer_id, o.upstream_model_id, o.canonical_model_id,
                  n.label, n.ssh_host, n.ssh_port, n.ssh_user, n.host_key_fp, n.key_id,
                  n.rtt_ms_p50, n.status AS node_status
             FROM remote_model_offers o
             JOIN remote_agent_profiles p ON p.id = o.profile_id
             JOIN remote_agent_nodes n ON n.id = p.node_id
            WHERE o.canonical_model_id = $1
              AND o.enabled = TRUE
              AND (
                p.driver_id = $2
                OR (p.driver_id IS NULL AND p.engine = $3)
              )
              AND p.status IN ('active', 'degraded')
              AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
              AND n.status IN ('active', 'degraded')
              AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
            ORDER BY n.id, p.id
            FOR UPDATE OF p`,
          [input.canonicalModel, reg.driverId, legacyProfileEngine],
        )
      ).rows

      const sticky = (
        await client.query<{
          operation_id: string
          run_id: string
          profile_id: string
          generation: string
          native_session_id: string | null
        }>(
          `SELECT operation_id::text, run_id::text, profile_id::text,
                  generation::text, native_session_id
             FROM remote_agent_bindings
            WHERE uid = $1
              AND session_key = $2
              AND (
                driver_id = $3
                OR (driver_id IS NULL AND engine = $4)
              )
            ORDER BY updated_at DESC
            LIMIT 1`,
          [uidStr, input.sessionKey, reg.driverId, legacyBindEngine],
        )
      ).rows[0]

      const readyMap = new Map<string, { snapshot: RemoteProbeSnapshot; fingerprint: string; effectiveCap: number }>()
      const eligible: typeof candidates = []
      const fullProfiles = new Set<string>()
      const reverifyProfiles = new Set<string>()
      const staleProfiles = new Set<string>()

      for (const row of candidates) {
        const pid = String(row.profile_id)
        const check = verifyProfileReadyForV4(
          row,
          reg.driverDigest,
          reg.coreDigest,
          nowMs,
          maxProbeAgeMs,
        )
        if (!check.ready) {
          if (check.reason === 'reverify') reverifyProfiles.add(pid)
          else staleProfiles.add(pid)
          continue
        }
        const used = Number(
          (
            await client.query<{ profile_used: number }>(
              `SELECT COUNT(*)::int AS profile_used
                 FROM remote_agent_bindings
                WHERE profile_id = $1 AND state <> 'released'`,
              [row.profile_id],
            )
          ).rows[0]?.profile_used ?? 0,
        )
        const effectiveCap = Math.min(Number(row.max_concurrent_lanes), reg.profileMaxLanes)
        if (used >= effectiveCap) {
          fullProfiles.add(pid)
          continue
        }
        readyMap.set(pid, {
          snapshot: check.snapshot,
          fingerprint: check.fingerprint,
          effectiveCap,
        })
        eligible.push(row)
      }

      const exhausted = (profiles: string[]) =>
        Object.assign(new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'), { profiles })

      if (sticky) {
        selectedRow = eligible.find((r) => String(r.profile_id) === sticky.profile_id)
        if (!selectedRow) {
          if (reverifyProfiles.has(sticky.profile_id)) {
            throw new Error('REMOTE_DRIVER_REVERIFY_REQUIRED')
          }
          if (staleProfiles.has(sticky.profile_id)) {
            throw new Error('REMOTE_DRIVER_PROBE_STALE')
          }
          if (fullProfiles.has(sticky.profile_id)) {
            throw exhausted([sticky.profile_id])
          }
          throw new Error('REMOTE_LANE_PROFILE_UNAVAILABLE')
        }
      } else {
        const ranked = rankRemotePoolCandidates(
          eligible.map((r) => ({
            profileId: String(r.profile_id),
            nodeId: String(r.node_id),
            engine: (r.engine as RemoteBrainEngine) ?? legacyProfileEngine,
            profileName: String(r.profile_name),
            weight: Number(r.weight ?? 100),
            healthScore:
              r.node_status === 'degraded'
                ? Math.min(Number(r.health_score ?? 100), 60)
                : Number(r.health_score ?? 100),
            hotSlots: Number(r.hot_slots ?? 0),
            activeSlots: Number(r.active_slots ?? 0),
            maxHotSlots: Math.max(Number(r.max_hot_slots ?? 8), reg.profileMaxLanes),
            maxActiveSlots: readyMap.get(String(r.profile_id))!.effectiveCap,
            nodeRttMsP50: r.rtt_ms_p50 == null ? null : Number(r.rtt_ms_p50),
          })),
          `${uidStr}:${input.sessionKey}:${input.canonicalModel}`,
        )
        selectedRow = eligible.find((r) => String(r.profile_id) === ranked[0]?.profileId)
        if (!selectedRow) {
          if (fullProfiles.size > 0) throw exhausted([...fullProfiles])
          if (reverifyProfiles.size > 0) throw new Error('REMOTE_DRIVER_REVERIFY_REQUIRED')
          if (staleProfiles.size > 0) throw new Error('REMOTE_DRIVER_PROBE_STALE')
          throw new Error('NO_ELIGIBLE_REMOTE_PROFILE')
        }
      }

      const info = readyMap.get(String(selectedRow.profile_id))!
      verifiedProbe = info.snapshot
      activeFingerprint = info.fingerprint

      if (sticky) {
        const pendingJournal = await client.query(
          `SELECT 1 FROM request_finalize_journal
            WHERE user_id = $1
              AND ctx->>'remoteNativeBillingRecovery' = ANY($2::text[])
              AND (
                ctx#>>'{remoteNative,scope,operationId}' = $3
                OR ctx#>>'{remoteDriverV4,scope,operationId}' = $3
              )
              AND state IN ('inflight', 'finalizing')
            LIMIT 1`,
          [
            uidStr,
            [
              REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
              CODEX_REMOTE_BILLING_RECOVERY_VERSION,
              REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
            ],
            sticky.operation_id,
          ],
        )
        if (pendingJournal.rows.length > 0) {
          throw new Error('REMOTE_OPERATION_BILLING_PENDING')
        }
        selectedRow._sticky = sticky
      }
    }

    need(
      selectedRow !== undefined && verifiedProbe !== undefined && activeFingerprint !== undefined,
      'NO_ELIGIBLE_REMOTE_PROFILE',
    )

    const sticky = selectedRow._sticky as
      | {
          operation_id: string
          run_id: string
          generation: string
          native_session_id: string | null
        }
      | undefined
    const operationId = sticky?.operation_id ?? randomUUID()
    const runId = sticky?.run_id ?? randomUUID()
    const generation = sticky ? String(BigInt(sticky.generation) + 1n) : '1'
    const safeDriverSlug = reg.driverId.replaceAll('_', '-')
    let taskRootPrefix: string
    let taskRoot: string
    let controllerPath: string
    if (options.localSandboxDir !== undefined) {
      need(
        options.localSandboxDir.startsWith('/tmp/oc-drvtest-') &&
          !options.localSandboxDir.endsWith('/'),
        'REMOTE_LOCAL_SANDBOX_ROOT_FORBIDDEN',
      )
      taskRootPrefix = `${options.localSandboxDir}/run-`
      taskRoot = `${taskRootPrefix}${safeDriverSlug.slice(0, 12)}-${operationId.replace(/-/g, '').slice(0, 20)}-g${generation}`
      controllerPath = reg.controllerPath
    } else {
      const home = selectedRow.ssh_user === 'root' ? '/root' : `/home/${selectedRow.ssh_user}`
      taskRootPrefix = `${home}/oc-remotedrv-`
      taskRoot = `${taskRootPrefix}${safeDriverSlug}-${operationId.replace(/-/g, '')}-g${generation}`
      controllerPath = `/opt/openclaude/remote-driver/${reg.controllerSha256}/core/controller.py`
    }
    const profileName = String(selectedRow.profile_name)
    const authEpoch = String(selectedRow.auth_epoch ?? selectedRow.account_fingerprint ?? 'epoch-1')
    const upstreamModel = String(selectedRow.upstream_model_id)
    const effectiveCap = Math.min(Number(selectedRow.max_concurrent_lanes), reg.profileMaxLanes)

    const manifest: RemotePoolNodeManifest = Object.freeze({
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      root: taskRoot,
      driverId: reg.driverId,
      engineId: reg.engineId,
      operationId,
      runId,
      generation,
      profileId: profileName,
      authEpoch,
      model: upstreamModel,
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
      nativeSessionId: sticky?.native_session_id ?? null,
      maxConcurrentLanes: effectiveCap,
    })
    const manifestSha256 = remoteCanonicalSha256(manifest)
    const expiresAt = nowMs + ttlMs
    const capability = randomBytes(32).toString('hex')

    const binding: RemotePoolBinding = Object.freeze({
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      backendKind: REMOTE_DRIVER_BACKEND,
      operationId,
      runId,
      uid: uidStr,
      containerDbId: input.containerDbId,
      dockerId: input.dockerId,
      sessionKey: input.sessionKey,
      canonicalModel: input.canonicalModel,
      upstreamModel,
      driverId: reg.driverId,
      engineId: reg.engineId,
      authorityEngine: reg.authorityEngine,
      driverVersion: reg.driverVersion,
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
      probeFingerprint: activeFingerprint,
      manifestSha256,
      generation,
      profileId: profileName,
      authEpoch,
      capability,
      expiresAt,
    })

    const execDir = remoteNodeExecKeyDir(String(selectedRow.key_id))
    const sshTarget: RemotePoolSshTarget = Object.freeze({
      host: String(selectedRow.ssh_host),
      port: Number(selectedRow.ssh_port ?? 22),
      user: String(selectedRow.ssh_user),
      keyPath: join(execDir, `v4_${reg.driverId}_id_ed25519`),
      knownHostsPath: join(execDir, 'known_hosts'),
      controllerSha256: reg.controllerSha256,
      taskRootPrefix,
      upstreamModel,
    })

    const spec: RemotePoolLaneSpec = Object.freeze({
      controllerPath,
      controllerSha256: reg.controllerSha256,
      manifest,
      driverContext: input.driverContext ?? {},
      verifiedProbe,
      ...(options.registryPath ? { registryPath: options.registryPath } : {}),
    })

    const recoverySpec = {
      version: 4,
      sshTarget,
      spec,
      operationId,
      runId,
      generation,
    }

    const upserted = await client.query(
      `INSERT INTO remote_agent_bindings
         (operation_id, run_id, uid, container_db_id, docker_id, session_key,
          node_id, profile_id, canonical_model_id, native_session_id, state, expires_at,
          engine, backend_kind, generation, auth_epoch, manifest_sha256, recovery_spec,
          remote_start_attempted, no_host_effect_proven, remote_protocol_version,
          engine_id, driver_id, driver_version, driver_digest, core_digest, probe_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, 'preparing', to_timestamp($11 / 1000.0),
               $12, $13, $14, $15, $16, $17::jsonb,
               FALSE, FALSE, 4,
               $18, $19, $20, $21, $22, $23)
       ON CONFLICT (operation_id) DO UPDATE
          SET container_db_id = EXCLUDED.container_db_id,
              docker_id = EXCLUDED.docker_id,
              canonical_model_id = EXCLUDED.canonical_model_id,
              state = 'preparing',
              expires_at = EXCLUDED.expires_at,
              engine = EXCLUDED.engine,
              backend_kind = EXCLUDED.backend_kind,
              generation = EXCLUDED.generation,
              auth_epoch = EXCLUDED.auth_epoch,
              manifest_sha256 = EXCLUDED.manifest_sha256,
              recovery_spec = EXCLUDED.recovery_spec,
              remote_start_attempted = FALSE,
              no_host_effect_proven = FALSE,
              remote_protocol_version = 4,
              engine_id = EXCLUDED.engine_id,
              driver_id = EXCLUDED.driver_id,
              driver_version = EXCLUDED.driver_version,
              driver_digest = EXCLUDED.driver_digest,
              core_digest = EXCLUDED.core_digest,
              probe_fingerprint = EXCLUDED.probe_fingerprint,
              updated_at = NOW()
        WHERE remote_agent_bindings.state = 'released'`,
      [
        operationId,
        runId,
        uidStr,
        input.containerDbId,
        input.dockerId,
        input.sessionKey,
        String(selectedRow.node_id),
        String(selectedRow.profile_id),
        input.canonicalModel,
        sticky?.native_session_id ?? null,
        expiresAt,
        legacyBindEngine,
        REMOTE_DRIVER_BACKEND,
        generation,
        authEpoch,
        manifestSha256,
        JSON.stringify(recoverySpec),
        reg.engineId,
        reg.driverId,
        reg.driverVersion,
        reg.driverDigest,
        reg.coreDigest,
        activeFingerprint!,
      ],
    )
    need(upserted.rowCount === 1, 'REMOTE_BINDING_INSERT_CONFLICT')

    await client.query('COMMIT')
    return {
      binding,
      spec,
      sshTarget,
      nodeId: String(selectedRow.node_id),
      profileUuid: String(selectedRow.profile_id),
      profileName,
      generation,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function recordRemoteDriverLaneState(
  operationId: string,
  generation: string,
  state: 'running' | 'released' | 'unknown',
  pool: Pool = getPool(),
): Promise<void> {
  const saved = await pool.query(
    `UPDATE remote_agent_bindings
        SET state = $3,
            updated_at = NOW()
      WHERE operation_id = $1
        AND generation = $2
        AND remote_protocol_version = 4
        AND ($3 <> 'running' OR state IN ('preparing', 'running'))`,
    [operationId, generation, state],
  )
  if (state === 'running' && saved.rowCount !== 1) {
    throw new Error('REMOTE_LANE_GENERATION_FENCED')
  }
}

export async function recordRemoteDriverStartAttempt(
  operationId: string,
  generation: string,
  pool: Pool = getPool(),
): Promise<void> {
  const saved = await pool.query(
    `UPDATE remote_agent_bindings
        SET remote_start_attempted = TRUE,
            updated_at = NOW()
      WHERE operation_id = $1
        AND generation = $2
        AND remote_protocol_version = 4
        AND state = 'running'`,
    [operationId, generation],
  )
  if (saved.rowCount !== 1) {
    throw new Error('REMOTE_DRIVER_START_FENCED')
  }
}

export async function recordRemoteDriverNativeSession(
  operationId: string,
  generation: string,
  nativeSessionId: string,
  pool: Pool = getPool(),
): Promise<void> {
  const saved = await pool.query(
    `UPDATE remote_agent_bindings
        SET native_session_id = $3,
            updated_at = NOW()
      WHERE operation_id = $1
        AND generation = $2
        AND remote_protocol_version = 4
        AND state = 'running'
        AND (native_session_id IS NULL OR native_session_id = $3)`,
    [operationId, generation, nativeSessionId],
  )
  if (saved.rowCount !== 1) {
    throw new Error('REMOTE_DRIVER_NATIVE_SESSION_FENCED')
  }
}
