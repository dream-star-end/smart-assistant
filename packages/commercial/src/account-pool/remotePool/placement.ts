/**
 * Generic `remote-driver-v4` lane placement and binding lifecycle (`AC-4`, `AC-5`, `AC-6`).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import type {
  RemotePoolBinding,
  RemotePoolLaneSpec,
  RemotePoolNodeManifest,
} from '@openclaude/gateway/remote-pool'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  type RemoteProbeSnapshot,
  type RequiredTurnCapabilities,
  computeStickyHomeKey,
  remoteCanonicalSha256,
  validateRemoteProbeSnapshot,
} from '@openclaude/protocol'
import type { Pool, PoolClient } from 'pg'

export type RemotePoolSshTarget = RemoteCcTarget
import {
  CODEX_REMOTE_BILLING_RECOVERY_VERSION,
  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
  REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
} from '../../billing/remoteNativeBillingIdentity.js'
import { getPool } from '../../db/index.js'
import {
  type RemoteBrainEngine,
  rankRemotePoolCandidates,
  remoteNodeExecKeyDir,
} from '../remoteBrainPool.js'
import type { RemoteReleaseDrainCoordinator } from './drainGate.js'
import {
  DEFAULT_MAX_PROBE_AGE_MS,
  REMOTE_DRIVER_VERIFICATION_CASE_LANES,
  type RemoteDriverVerificationCaseLane,
  computeProbeFingerprintTs,
  isReservedVerificationSessionKey,
  verificationSessionKeyForCaseLane,
  verificationSessionKeyForRun,
  verifyProfileReadyForV4,
} from './driftCoordinator.js'
import { buildDefaultDriverContextForNode, resolveProbedUpstreamModel } from './modelResolution.js'
import {
  collectEligibleV4Candidates,
  selectEligibleV4ProfileOrThrow,
} from './placementCandidateSelection.js'
import {
  legacyBindingEngineForAuthority,
  legacyProfileEngineForAuthority,
  loadRemoteDriverRegistry,
} from './registry.js'

const DEFAULT_BINDING_TTL_MS = 24 * 60 * 60_000
const SHA256_RE = /^[a-f0-9]{64}$/
const STICKY_HOME_DRIVERS = new Set(['antigravity'])

function need(condition: unknown, code = 'REMOTE_DRIVER_PLACEMENT_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export function resolveRemoteDriverV4ExecKeyPath(
  keyId: string,
  driverId: string,
  baseKeyDir?: string,
): string {
  need(typeof keyId === 'string' && keyId.trim().length > 0, 'REMOTE_KEY_ID_INVALID')
  need(/^[a-z0-9][a-z0-9_-]{0,31}$/.test(driverId), 'REMOTE_DRIVER_ID_INVALID')
  const fileName = `v4_${driverId}_id_ed25519`
  const perNodePath = join(remoteNodeExecKeyDir(keyId, baseKeyDir), fileName)
  const sharedV4Path = join(remoteNodeExecKeyDir('rpoolv4', baseKeyDir), fileName)
  if (!existsSync(perNodePath) && existsSync(sharedV4Path)) {
    return sharedV4Path
  }
  return perNodePath
}

export interface PlaceRemoteDriverLaneInput {
  readonly uid: number | string
  readonly containerDbId: string
  readonly dockerId: string
  readonly sessionKey?: string
  readonly canonicalModel: string
  readonly driverId: string
  readonly preferredProfileId?: string
  readonly preferredNodeId?: string
  readonly rankedCandidateKeys?: readonly string[]
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly driverContext?: Record<string, unknown>
  readonly verificationRun?: {
    readonly runId: string
    readonly leaseOwner: string
    readonly caseLane?: RemoteDriverVerificationCaseLane
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
  /** Optional tighten-only slice memory ceiling (bytes) enforced by `resources.admit`. */
  readonly maxSliceMemoryBytes?: number
  /** Strictly sandbox-fenced (`/tmp/oc-drvtest-*`) fault-injection mode for `AC-1` Group 6 Red controls. */
  readonly allowTestFaultsInSandbox?: boolean
  readonly testFaultSandboxMode?: 'account_mutex' | 'shared_node_cap_5'
  readonly onAccountMutexBlocked?: (attempt: number) => void
  /** OCV5-890: permit cross-node failover within the same pool when the sticky profile is unavailable. */
  readonly allowStickyFailover?: boolean
}

export interface RemoteDriverPlacementResult {
  readonly binding: RemotePoolBinding
  readonly spec: RemotePoolLaneSpec
  readonly sshTarget: RemotePoolSshTarget
  readonly nodeId: string
  readonly profileUuid: string
  readonly profileName: string
  readonly generation: string
  readonly migratedFromProfileId?: string
}

interface BillingJournalQueryable {
  query(sql: string, params?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>
}

export interface ExcludeCurrentPreparedBinding {
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
}

async function assertNoPendingBillingJournal(
  client: BillingJournalQueryable,
  uidStr: string,
  operationIds: string | readonly string[] | null,
  sessionKey?: string | null,
): Promise<void> {
  const normalizedOpIds =
    typeof operationIds === 'string'
      ? operationIds.trim().length > 0
        ? [operationIds.trim()]
        : []
      : Array.isArray(operationIds)
        ? [...new Set(operationIds.map((id) => id.trim()).filter((id) => id.length > 0))]
        : []
  const pendingJournal = await client.query(
    `SELECT 1 FROM request_finalize_journal j
      WHERE j.user_id = $1
        AND j.ctx->>'remoteNativeBillingRecovery' = ANY($2::text[])
        AND j.state IN ('inflight', 'finalizing')
        AND (
          (cardinality($3::text[]) > 0 AND (
            j.ctx#>>'{remoteNative,scope,operationId}' = ANY($3::text[])
            OR j.ctx#>>'{remoteDriverV4,scope,operationId}' = ANY($3::text[])
          ))
          OR ($4::text IS NOT NULL AND (
            j.ctx#>>'{remoteNative,scope,sessionKey}' = $4
            OR j.ctx#>>'{remoteDriverV4,scope,sessionKey}' = $4
            OR EXISTS (
              SELECT 1
                FROM remote_agent_bindings b
               WHERE b.uid = $1
                 AND b.session_key = $4
                 AND b.operation_id::text = COALESCE(
                   j.ctx#>>'{remoteDriverV4,scope,operationId}',
                   j.ctx#>>'{remoteNative,scope,operationId}',
                   j.ctx->>'operationId'
                 )
            )
          ))
        )
      LIMIT 1`,
    [
      uidStr,
      [
        REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
        CODEX_REMOTE_BILLING_RECOVERY_VERSION,
        REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
      ],
      normalizedOpIds,
      sessionKey ?? null,
    ],
  )
  if (pendingJournal.rows.length > 0) {
    throw new Error('REMOTE_OPERATION_BILLING_PENDING')
  }
}

export async function assertNoPendingRemoteBillingForSession(
  client: BillingJournalQueryable,
  uid: number | string | bigint,
  sessionKey: string,
  operationId?: string | null,
  options?: {
    readonly excludeCurrentPreparedBinding?: ExcludeCurrentPreparedBinding
  },
): Promise<void> {
  const uidStr = String(uid)
  const exclude = options?.excludeCurrentPreparedBinding
  const hasValidExclude =
    exclude !== undefined &&
    typeof exclude.operationId === 'string' &&
    exclude.operationId.trim().length > 0 &&
    typeof exclude.generation === 'string' &&
    exclude.generation.trim().length > 0 &&
    typeof exclude.profileId === 'string' &&
    exclude.profileId.trim().length > 0

  // B06 + B01: Query ALL non-released bindings; only excuse the exact prepared triple.
  const activeBindingsRes = await client.query(
    `SELECT operation_id::text AS operation_id, generation::text AS generation,
            profile_id::text AS profile_id, recovery_spec#>>'{spec,manifest,profileId}' AS profile_name, state
       FROM remote_agent_bindings WHERE uid = $1 AND session_key = $2 AND state <> 'released'`,
    [uidStr, sessionKey],
  )
  for (const raw of activeBindingsRes.rows) {
    const row = raw as { operation_id?: unknown; generation?: unknown; profile_id?: unknown; profile_name?: unknown; state?: unknown }
    const matchesCurrentPrepared =
      hasValidExclude &&
      (row.state === 'preparing' || row.state === 'running') &&
      String(row.operation_id ?? '') === exclude.operationId.trim() &&
      String(row.generation ?? '') === exclude.generation.trim() &&
      (String(row.profile_id ?? '') === exclude.profileId.trim() ||
        String(row.profile_name ?? '') === exclude.profileId.trim())
    if (!matchesCurrentPrepared) throw new Error('REMOTE_LANE_STOP_UNPROVEN')
  }
  await assertNoPendingBillingJournal(client, uidStr, operationId ?? null, sessionKey)
}

export async function placeRemoteDriverLane(
  input: PlaceRemoteDriverLaneInput,
  options: PlaceRemoteDriverLaneOptions = {},
): Promise<RemoteDriverPlacementResult> {
  if (process.env.OC_REMOTE_POOL_EXECUTION_ENABLED === '0') {
    throw new Error('REMOTE_POOL_EXECUTION_DISABLED')
  }
  options.drainGate?.assertAdmissionOpen()
  if (options.testFaultSandboxMode !== undefined) {
    need(
      options.allowTestFaultsInSandbox === true &&
        typeof options.localSandboxDir === 'string' &&
        options.localSandboxDir.startsWith('/tmp/oc-drvtest-'),
      'REMOTE_FAULT_INJECTION_SANDBOX_ONLY',
    )
  }

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
  let effectiveSessionKey: string
  if (input.verificationRun) {
    if (input.verificationRun.caseLane !== undefined) {
      need(
        (REMOTE_DRIVER_VERIFICATION_CASE_LANES as readonly string[]).includes(
          input.verificationRun.caseLane,
        ),
        'REMOTE_VERIFICATION_CASE_LANE_INVALID',
      )
    }
    effectiveSessionKey = input.verificationRun.caseLane
      ? verificationSessionKeyForCaseLane(
          input.verificationRun.runId,
          input.verificationRun.caseLane,
        )
      : verificationSessionKeyForRun(input.verificationRun.runId)
    if (input.sessionKey !== undefined) {
      need(input.sessionKey === effectiveSessionKey, 'REMOTE_VERIFICATION_SESSION_KEY_MISMATCH')
    }
  } else {
    need(
      typeof input.sessionKey === 'string' &&
        input.sessionKey.length > 0 &&
        input.sessionKey.length <= 512,
      'REMOTE_PLACEMENT_SESSION_INVALID',
    )
    need(!isReservedVerificationSessionKey(input.sessionKey), 'REMOTE_SESSION_KEY_RESERVED')
    effectiveSessionKey = input.sessionKey
  }

  const legacyProfileEngine = legacyProfileEngineForAuthority(reg.authorityEngine)
  const legacyBindEngine = legacyBindingEngineForAuthority(reg.authorityEngine)

  const accountMutexDeadline =
    options.testFaultSandboxMode === 'account_mutex' ? Date.now() + 15_000 : 0
  let accountMutexBlockedCount = 0
  while (true) {
    let retryAccountMutex = false
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `remote-chat:${uidStr}:${effectiveSessionKey}`,
      ])

      const busy = await client.query(
        `SELECT operation_id FROM remote_agent_bindings
        WHERE uid = $1 AND session_key = $2 AND state <> 'released'
        LIMIT 1`,
        [uidStr, effectiveSessionKey],
      )
      if (busy.rows.length > 0) {
        throw new Error('REMOTE_LANE_STOP_UNPROVEN')
      }

      let selectedRow: Record<string, any> | undefined
      let migratedFromProfileId: string | undefined
      let verifiedProbe: RemoteProbeSnapshot | undefined
      let activeFingerprint: string | undefined

      if (input.verificationRun) {
        const vRun = (
          await client.query(
            `SELECT * FROM remote_driver_verification_runs
            WHERE id = $1
              AND state = 'running'
              AND lease_owner = $2
              AND lease_until > NOW()
            FOR UPDATE`,
            [input.verificationRun.runId, input.verificationRun.leaseOwner],
          )
        ).rows[0]
        need(vRun !== undefined, 'REMOTE_VERIFICATION_RUN_NOT_AUTHORIZED')
        need(String(vRun.driver_id) === reg.driverId, 'REMOTE_VERIFICATION_ENGINE_MISMATCH')

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
        need(String(cand.engine) === legacyProfileEngine, 'REMOTE_VERIFICATION_ENGINE_MISMATCH')
        need(
          cand.driver_id === null || String(cand.driver_id) === reg.driverId,
          'REMOTE_VERIFICATION_DRIVER_MISMATCH',
        )

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
        if (input.verificationRun.caseLane) {
          const stickyVerif = (
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
                AND profile_id = $3
                AND driver_id = $4
                AND recovery_spec->>'verificationRunId' = $5
              ORDER BY updated_at DESC
              LIMIT 1`,
              [uidStr, effectiveSessionKey, cand.profile_id, reg.driverId, vRun.id],
            )
          ).rows[0]
          if (stickyVerif) {
            await assertNoPendingBillingJournal(client, uidStr, stickyVerif.operation_id)
            cand._sticky = stickyVerif
          }
        }
        selectedRow = cand
        verifiedProbe = snap
        activeFingerprint = fp
      } else {
        const candidates: Array<Record<string, any>> = (
          await client.query<Record<string, any>>(
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
                OR ($5::boolean AND driver_id IS NULL AND engine = $4)
              )
            ORDER BY updated_at DESC
            LIMIT 1`,
            [
              uidStr,
              effectiveSessionKey,
              reg.driverId,
              legacyBindEngine,
              reg.driverId === 'cc' || reg.driverId === 'codex',
            ],
          )
        ).rows[0]

        const collected = await collectEligibleV4Candidates({
          client,
          candidates,
          reg,
          canonicalModel: input.canonicalModel,
          requiredCapabilities: input.requiredCapabilities,
          nowMs,
          maxProbeAgeMs,
          testFaultSandboxMode: options.testFaultSandboxMode,
        })
        const chosen = await selectEligibleV4ProfileOrThrow({
          collected,
          sticky,
          allowStickyFailover: options.allowStickyFailover,
          reg,
          legacyProfileEngine,
          uidStr,
          effectiveSessionKey,
          canonicalModel: input.canonicalModel,
          preferredProfileId: input.preferredProfileId,
          preferredNodeId: input.preferredNodeId,
          rankedCandidateKeys: input.rankedCandidateKeys,
          guardPendingBilling: (priorOpId) =>
            assertNoPendingBillingJournal(client, uidStr, priorOpId, effectiveSessionKey),
        })
        selectedRow = chosen.selectedRow
        verifiedProbe = chosen.verifiedProbe
        activeFingerprint = chosen.activeFingerprint
        migratedFromProfileId = chosen.migratedFromProfileId
        if (chosen.effectiveSticky) {
          selectedRow._sticky = chosen.effectiveSticky
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
        taskRoot = `${taskRootPrefix}${safeDriverSlug.slice(0, 12)}-${operationId.replace(/-/g, '').slice(0, 24)}-g${generation}`
        controllerPath = `/opt/openclaude/remote-driver/${reg.controllerSha256}/core/controller.py`
      }
      if (options.maxSliceMemoryBytes !== undefined) {
        need(
          Number.isSafeInteger(options.maxSliceMemoryBytes) && options.maxSliceMemoryBytes > 0,
          'REMOTE_SLICE_MEMORY_CAP_INVALID',
        )
      }
      const profileName = String(selectedRow.profile_name)
      const authEpoch = String(
        selectedRow.auth_epoch ?? selectedRow.account_fingerprint ?? 'epoch-1',
      )
      const resolvedUpstreamModel = resolveProbedUpstreamModel(
        reg.driverId,
        String(selectedRow.upstream_model_id),
        verifiedProbe,
      )
      need(resolvedUpstreamModel !== null, 'REMOTE_MODEL_NOT_IN_PROBE_SNAPSHOT')
      const upstreamModel = resolvedUpstreamModel
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
        ...(options.maxSliceMemoryBytes !== undefined
          ? { maxSliceMemoryBytes: options.maxSliceMemoryBytes }
          : {}),
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
        sessionKey: effectiveSessionKey,
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
        keyPath: resolveRemoteDriverV4ExecKeyPath(String(selectedRow.key_id), reg.driverId),
        knownHostsPath: join(execDir, 'known_hosts'),
        controllerSha256: reg.controllerSha256,
        taskRootPrefix,
        upstreamModel,
      })

      const execManifestObj =
        selectedRow.execution_manifest &&
        typeof selectedRow.execution_manifest === 'object' &&
        !Array.isArray(selectedRow.execution_manifest)
          ? (selectedRow.execution_manifest as Record<string, unknown>)
          : {}
      const manifestDriverCtx =
        execManifestObj.driverContext &&
        typeof execManifestObj.driverContext === 'object' &&
        !Array.isArray(execManifestObj.driverContext)
          ? (execManifestObj.driverContext as Record<string, unknown>)
          : {}
      let mergedDriverContext: Record<string, unknown>
      if (options.localSandboxDir !== undefined) {
        mergedDriverContext = {
          mcpClientPath: join(dirname(controllerPath), 'mcp_client.py'),
          ...manifestDriverCtx,
          ...(input.driverContext ?? {}),
        }
      } else {
        const defaultNodeCtx = buildDefaultDriverContextForNode({
          driverId: reg.driverId,
          sshUser: String(selectedRow.ssh_user),
          profileName,
          controllerSha256: reg.controllerSha256,
          cliVersion: verifiedProbe.cliVersion,
          includeBridgeFiles: true,
        })
        mergedDriverContext = {
          ...defaultNodeCtx,
          ...manifestDriverCtx,
          ...(input.driverContext ?? {}),
        }
        if (reg.driverId === 'cc' && !mergedDriverContext.bridgeFiles) {
          mergedDriverContext.bridgeFiles = defaultNodeCtx.bridgeFiles
        }
      }
      if (STICKY_HOME_DRIVERS.has(reg.driverId) && mergedDriverContext.stickyHomeKey === undefined) {
        mergedDriverContext.stickyHomeKey = computeStickyHomeKey(effectiveSessionKey)
      }

      const spec: RemotePoolLaneSpec = Object.freeze({
        controllerPath,
        controllerSha256: reg.controllerSha256,
        manifest,
        driverContext: mergedDriverContext,
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
        ...(input.verificationRun
          ? {
              verificationRunId: input.verificationRun.runId,
              ...(input.verificationRun.caseLane
                ? { verificationCaseLane: input.verificationRun.caseLane }
                : {}),
            }
          : {}),
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
          effectiveSessionKey,
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
        ...(migratedFromProfileId ? { migratedFromProfileId } : {}),
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (
        options.testFaultSandboxMode === 'account_mutex' &&
        err instanceof Error &&
        err.message === 'REMOTE_LANE_CAPACITY_EXHAUSTED' &&
        Date.now() < accountMutexDeadline
      ) {
        accountMutexBlockedCount += 1
        options.onAccountMutexBlocked?.(accountMutexBlockedCount)
        retryAccountMutex = true
      } else {
        throw err
      }
    } finally {
      client.release()
    }
    if (retryAccountMutex) {
      await new Promise((r) => setTimeout(r, 20))
    }
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
