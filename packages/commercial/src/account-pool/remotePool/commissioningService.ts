/**
 * `remote-driver-v4` cutover, live verification orchestration, catalog offer sync, and
 * automatic CAS rollback (`OCV5-749`, R12, `P0-1`).
 */
import { randomUUID } from 'node:crypto'
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import type { RemotePoolProbeOutput, RemotePoolProbeSpec } from '@openclaude/gateway/remote-pool'
import type { Pool } from 'pg'
import { countEligibleEnabledRemoteOffers } from '../remoteBrainPool.js'
import {
  proveRemoteLaneContainerStopped,
  reconcileRemoteLane,
  reconcileStaleContainerLanes,
} from '../remoteLaneRecovery.js'
import {
  claimDriverVerificationRun,
  recordProductionDriverProbeSnapshot,
} from './driftCoordinator.js'
import { executeLiveRemoteDriverProbe } from './liveProbe.js'
import {
  computeProductionConformanceSuiteDigest,
  convertProfileToDriverV4,
  revertDriverV4ProfileToLegacy,
} from './profileCutover.js'
import {
  type RemoteDriverVerificationPolicy,
  authorizeProfileInVerificationPolicy,
  loadVerificationPolicy,
  upsertVerificationPolicy,
} from './verificationBudget.js'
import { syncProfileOffersCatalogState } from './verificationCatalog.js'
import {
  type DriverVerificationExecutorDeps,
  executeDriverVerificationRun,
} from './verificationExecutor.js'
import { proveVerificationRunLocalStopped } from './verificationRuntimeProof.js'
import {
  type LegacyHistoricalTurnRecord,
  createLegacyBillingReadOnlyShell,
} from './legacyRetirement.js'
import {
  type LegacyRetirementGateStatus,
  LegacyTrackRetirementGate,
} from './legacyRetirementRuntime.js'
import {
  type DualPoolParityGateInput,
  type DualPoolParityGateResult,
  evaluateProfileDualPoolParityStatus,
  verifyDualPoolParityConformance,
} from './dualPoolParityGate.js'

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const DEFAULT_CUTOVER_DEADLINE_MS = 12 * 60_000
const MAX_PARITY_CACHE_ENTRIES = 2048

function need(condition: unknown, code = 'REMOTE_DRIVER_COMMISSION_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface CutoverJobRecord {
  readonly jobId: string
  readonly profileId: string
  readonly action: 'cutover' | 'reverify'
  status: 'running' | 'passed' | 'reverted' | 'failed'
  readonly startedAt: string
  finishedAt?: string
  verificationRunId?: string
  readyGeneration?: string
  evidenceDigest?: string
  evidenceUri?: string
  reverted?: boolean
  error?: string
  dualPoolParity?: DualPoolParityGateResult
}

export interface RemoteDriverV4CommissioningServiceDeps {
  readonly executorDeps: DriverVerificationExecutorDeps
  readonly keyDir?: string
  readonly snapshotDir?: string
  readonly suiteDigest?: string
  readonly probeHostFactory?: (
    target: RemoteCcTarget,
    spec: RemotePoolProbeSpec,
  ) => { probe(context: Record<string, unknown>): Promise<RemotePoolProbeOutput> }
  readonly recoveryFixtures?: Parameters<typeof reconcileRemoteLane>[3]
  readonly onJobSettled?: (job: CutoverJobRecord) => void
  readonly legacyRetirementGate?: LegacyTrackRetirementGate
  readonly extendedRedProofArtifact?: unknown
  readonly requireExtendedRedProof?: boolean
  readonly dualPoolParityPrecheck?: (
    input: DualPoolParityGateInput,
  ) => Promise<DualPoolParityGateResult> | DualPoolParityGateResult
}

async function releaseVerificationBindingsForProfile(
  pool: Pool,
  profileId: string,
  verificationRunId?: string,
  fixtures?: Parameters<typeof reconcileRemoteLane>[3],
  liveDockerId?: string,
): Promise<void> {
  const rows = (
    await pool.query<{ operation_id: string; generation: string; run_id: string | null }>(
      `SELECT operation_id::text AS operation_id,
              generation::text AS generation,
              recovery_spec->>'verificationRunId' AS run_id
         FROM remote_agent_bindings
        WHERE profile_id = $1
          AND state <> 'released'
          AND ($2::text IS NULL OR recovery_spec->>'verificationRunId' = $2)`,
      [profileId, verificationRunId ?? null],
    )
  ).rows
  for (const r of rows) {
    const rowRunId = verificationRunId ?? r.run_id ?? undefined
    const rowFixtures = fixtures?.proveLocal
      ? fixtures
      : {
          ...fixtures,
          proveLocal: async (dId: string) =>
            liveDockerId && dId === liveDockerId && rowRunId
              ? await proveVerificationRunLocalStopped(dId, rowRunId)
              : await proveRemoteLaneContainerStopped(dId),
        }
    await reconcileRemoteLane(pool, r.operation_id, r.generation, rowFixtures)
  }
}

export class RemoteDriverV4CommissioningService {
  private readonly jobs = new Map<string, CutoverJobRecord>()
  private readonly latestJobByProfile = new Map<string, string>()
  private readonly latestParityByProfile = new Map<string, DualPoolParityGateResult>()

  constructor(private readonly deps: RemoteDriverV4CommissioningServiceDeps) {}

  private recordParityStatus(profileId: string, parity: DualPoolParityGateResult): void {
    if (this.latestParityByProfile.has(profileId)) {
      this.latestParityByProfile.delete(profileId)
    } else if (this.latestParityByProfile.size >= MAX_PARITY_CACHE_ENTRIES) {
      const oldest = this.latestParityByProfile.keys().next().value
      if (oldest !== undefined) this.latestParityByProfile.delete(oldest)
    }
    this.latestParityByProfile.set(profileId, parity)
  }

  async getPolicy(): Promise<RemoteDriverVerificationPolicy> {
    return await loadVerificationPolicy(this.deps.executorDeps.pool)
  }

  async updatePolicy(
    patch: Partial<Omit<RemoteDriverVerificationPolicy, 'version' | 'uid'>>,
    adminUid = 3,
  ): Promise<RemoteDriverVerificationPolicy> {
    return await upsertVerificationPolicy(this.deps.executorDeps.pool, patch, adminUid)
  }

  getJobStatus(jobIdOrProfileId: string): CutoverJobRecord | null {
    const direct = this.jobs.get(jobIdOrProfileId)
    if (direct) return { ...direct }
    const mapped = this.latestJobByProfile.get(jobIdOrProfileId)
    if (!mapped) return null
    const found = this.jobs.get(mapped)
    return found ? { ...found } : null
  }

  async getProfileStatus(profileId: string): Promise<Record<string, unknown>> {
    need(UUID_RE.test(profileId), 'REMOTE_PROFILE_ID_INVALID')
    const pool = this.deps.executorDeps.pool
    const profRes = await pool.query<Record<string, any>>(
      `SELECT p.id, p.node_id, p.profile_name, p.engine, p.driver_id, p.engine_id,
              p.status, p.disabled_by, p.execution_ready, p.ready_generation::text AS ready_generation,
              p.verified_fingerprint,
              COALESCE(p.probe_snapshot->>'probeFingerprint', p.execution_manifest->>'latestFingerprint') AS target_fingerprint,
              p.auth_epoch, p.max_concurrent_lanes,
              p.last_probe_ok_at, p.updated_at
         FROM remote_agent_profiles p
        WHERE p.id = $1`,
      [profileId],
    )
    need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
    const offers = (
      await pool.query<{ canonical_model_id: string; upstream_model_id: string; enabled: boolean }>(
        `SELECT canonical_model_id, upstream_model_id, enabled
           FROM remote_model_offers
          WHERE profile_id = $1
          ORDER BY canonical_model_id`,
        [profileId],
      )
    ).rows
    const eligibleCounts: Record<string, number> = {}
    for (const o of offers) {
      eligibleCounts[o.canonical_model_id] = await countEligibleEnabledRemoteOffers(
        o.canonical_model_id,
        pool,
      )
    }
    const latestRun =
      (
        await pool.query<Record<string, any>>(
          `SELECT id, state, ready_generation::text AS ready_generation, error_code, error_detail,
                evidence_digest, evidence_uri, created_at, completed_at
           FROM remote_driver_verification_runs
          WHERE profile_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
          [profileId],
        )
      ).rows[0] ?? null

    const profileRow = profRes.rows[0]
    const dualPoolParity = await evaluateProfileDualPoolParityStatus({
      driverId: typeof profileRow?.driver_id === 'string' ? profileRow.driver_id : null,
      canonicalModel: offers[0]?.canonical_model_id,
      registryPath: this.deps.executorDeps.registryPath,
      extendedRedProofArtifact: this.deps.extendedRedProofArtifact,
      requireExtendedRedProof: this.deps.requireExtendedRedProof,
      cached: this.latestParityByProfile.get(profileId) ?? null,
    })

    return {
      profile: profileRow,
      offers,
      eligibleOfferCounts: eligibleCounts,
      latestVerificationRun: latestRun,
      latestJob: this.getJobStatus(profileId),
      dualPoolParity,
    }
  }

  async startCutover(
    input: {
      readonly profileId: string
      readonly driverId?: string
      readonly deadlineMs?: number
      readonly maxCreditsPerRun?: number
      readonly maxCreditsPerDay?: number
    },
    adminUid = 3,
  ): Promise<CutoverJobRecord> {
    return await this.launchJob({ ...input, action: 'cutover' }, adminUid)
  }

  async startReverify(
    input: {
      readonly profileId: string
      readonly deadlineMs?: number
      readonly maxCreditsPerRun?: number
      readonly maxCreditsPerDay?: number
    },
    adminUid = 3,
  ): Promise<CutoverJobRecord> {
    return await this.launchJob({ ...input, action: 'reverify' }, adminUid)
  }

  async revertToLegacy(profileId: string): Promise<Record<string, unknown>> {
    need(UUID_RE.test(profileId), 'REMOTE_PROFILE_ID_INVALID')
    await this.deps.legacyRetirementGate?.assertLegacyPlacementAllowedAsync()
    const pool = this.deps.executorDeps.pool
    const liveContainer = await this.deps.executorDeps.containerSource().catch(() => null)
    await releaseVerificationBindingsForProfile(
      pool,
      profileId,
      undefined,
      this.deps.recoveryFixtures,
      liveContainer?.dockerId,
    )
    const profRes = await pool.query<{ ready_generation: string; driver_id: string | null }>(
      'SELECT ready_generation::text AS ready_generation, driver_id FROM remote_agent_profiles WHERE id = $1',
      [profileId],
    )
    need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
    need(profRes.rows[0]!.driver_id !== null, 'REMOTE_REVERT_NOT_V4')
    const reverted = await revertDriverV4ProfileToLegacy(pool, {
      profileId,
      expectedMinReadyGeneration: profRes.rows[0]!.ready_generation,
      ...(this.deps.recoveryFixtures ? { allowEmbeddedBackupFallback: true } : {}),
    })
    const syncedOffers = await syncProfileOffersCatalogState(pool, profileId)
    return {
      reverted: true,
      profileId,
      readyGeneration: reverted.readyGeneration,
      syncedOffers,
    }
  }

  async getLegacyRetirementStatus(): Promise<LegacyRetirementGateStatus> {
    if (this.deps.legacyRetirementGate) {
      return await this.deps.legacyRetirementGate.getStatus()
    }
    const fallback = new LegacyTrackRetirementGate({
      queryable: this.deps.executorDeps.pool,
      mode: 'force_off',
    })
    return await fallback.getStatus()
  }

  async lookupLegacyHistoricalTurn(input: {
    readonly requestId: string
    readonly userId?: number | bigint
  }): Promise<LegacyHistoricalTurnRecord | null> {
    if (this.deps.legacyRetirementGate) {
      return await this.deps.legacyRetirementGate.lookupHistoricalTurn(input)
    }
    return await createLegacyBillingReadOnlyShell(this.deps.executorDeps.pool).lookupHistoricalTurn(
      input,
    )
  }

  async sealLegacyRetirement(adminUid = 3): Promise<LegacyRetirementGateStatus> {
    need(this.deps.legacyRetirementGate !== undefined, 'LEGACY_RETIREMENT_GATE_UNAVAILABLE')
    return await this.deps.legacyRetirementGate.seal(adminUid)
  }

  async unsealLegacyRetirement(adminUid = 3): Promise<LegacyRetirementGateStatus> {
    need(this.deps.legacyRetirementGate !== undefined, 'LEGACY_RETIREMENT_GATE_UNAVAILABLE')
    return await this.deps.legacyRetirementGate.unseal(adminUid)
  }

  private async launchJob(
    input: {
      readonly action: 'cutover' | 'reverify'
      readonly profileId: string
      readonly driverId?: string
      readonly deadlineMs?: number
      readonly maxCreditsPerRun?: number
      readonly maxCreditsPerDay?: number
    },
    adminUid: number,
  ): Promise<CutoverJobRecord> {
    need(UUID_RE.test(input.profileId), 'REMOTE_PROFILE_ID_INVALID')
    const pool = this.deps.executorDeps.pool
    const existsRes = await pool.query('SELECT 1 FROM remote_agent_profiles WHERE id = $1', [
      input.profileId,
    ])
    need(existsRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')

    const job: CutoverJobRecord = {
      jobId: randomUUID(),
      profileId: input.profileId,
      action: input.action,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    this.jobs.set(job.jobId, job)
    this.latestJobByProfile.set(input.profileId, job.jobId)

    void this.runJobInternal(job, input, adminUid).finally(() => {
      this.deps.onJobSettled?.({ ...job })
    })
    return { ...job }
  }

  private async runDualPoolParityPrecheck(
    job: CutoverJobRecord,
    input: { readonly profileId: string; readonly driverId?: string },
    suiteDigest: string,
  ): Promise<void> {
    const pool = this.deps.executorDeps.pool
    const regPath = this.deps.executorDeps.registryPath
    const precheckProfile = (
      await pool.query<{ driver_id: string | null; engine: string | null }>(
        'SELECT driver_id, engine FROM remote_agent_profiles WHERE id = $1',
        [input.profileId],
      )
    ).rows[0]
    const profileDriver = precheckProfile?.driver_id || precheckProfile?.engine || undefined
    const precheckDriverId = input.driverId ?? profileDriver
    if (!precheckDriverId) return
    const precheckOffer = (
      await pool.query<{ canonical_model_id: string; upstream_model_id: string }>(
        `SELECT canonical_model_id, upstream_model_id
           FROM remote_model_offers
          WHERE profile_id = $1 AND enabled = TRUE
          ORDER BY canonical_model_id ASC
          LIMIT 1`,
        [input.profileId],
      )
    ).rows[0]
    const redProofPath = this.deps.executorDeps.fixtures?.redProofPath
    const precheckInput: DualPoolParityGateInput = {
      driverId: precheckDriverId,
      ...(precheckOffer
        ? {
            canonicalModel: precheckOffer.canonical_model_id,
            upstreamModel: precheckOffer.upstream_model_id,
          }
        : {}),
      ...(regPath ? { registryPath: regPath } : {}),
      ...(this.deps.extendedRedProofArtifact !== undefined
        ? { extendedRedProofArtifact: this.deps.extendedRedProofArtifact }
        : {}),
      ...(this.deps.requireExtendedRedProof === true ? { requireExtendedRedProof: true } : {}),
      expectedSuiteDigest: suiteDigest,
      ...(redProofPath ? { redProofPath } : {}),
    }
    const parityResult = await (
      this.deps.dualPoolParityPrecheck ?? verifyDualPoolParityConformance
    )(precheckInput)
    job.dualPoolParity = parityResult
    this.recordParityStatus(input.profileId, parityResult)
    need(parityResult.ok, parityResult.errorCode ?? 'DUAL_POOL_PARITY_PRECHECK_FAILED')
  }

  private async executeVerificationWithDeadline(
    claimed: NonNullable<Awaited<ReturnType<typeof claimDriverVerificationRun>>>,
    suiteDigest: string,
    leaseOwner: string,
    deadlineMs: number,
  ): Promise<Awaited<ReturnType<typeof executeDriverVerificationRun>>> {
    const abortController = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const runPromise = executeDriverVerificationRun(
      this.deps.executorDeps,
      {
        id: claimed.id,
        nodeId: claimed.nodeId,
        profileId: claimed.profileId,
        driverId: claimed.driverId,
        engineId: claimed.engineId,
        targetFingerprint: claimed.targetFingerprint,
        driverDigest: claimed.driverDigest,
        coreDigest: claimed.coreDigest,
        suiteDigest: claimed.suiteDigest ?? suiteDigest,
        readyGeneration: claimed.readyGeneration,
        leaseOwner: claimed.leaseOwner ?? leaseOwner,
      },
      { signal: abortController.signal },
    )
    return await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort()
          reject(new Error('REMOTE_CUTOVER_DEADLINE_EXCEEDED'))
        }, deadlineMs)
        timeoutHandle.unref()
      }),
    ])
      .catch(async (runErr) => {
        abortController.abort()
        await runPromise.catch(() => {})
        throw runErr
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      })
  }

  private async rollbackLegacyCutover(
    job: CutoverJobRecord,
    profileId: string,
    cutoverReadyGeneration: string,
    claimedRunId: string | undefined,
    liveDockerId: string | undefined,
    msg: string,
  ): Promise<void> {
    const pool = this.deps.executorDeps.pool
    try {
      await releaseVerificationBindingsForProfile(
        pool,
        profileId,
        claimedRunId,
        this.deps.recoveryFixtures,
        liveDockerId,
      )
      await revertDriverV4ProfileToLegacy(pool, {
        profileId,
        expectedMinReadyGeneration: cutoverReadyGeneration,
        ...(this.deps.recoveryFixtures ? { allowEmbeddedBackupFallback: true } : {}),
      })
      if (!this.deps.executorDeps.fixtures?.skipCatalogSync) {
        await syncProfileOffersCatalogState(pool, profileId)
      }
      job.reverted = true
      job.status = 'reverted'
    } catch (rollbackErr) {
      job.reverted = false
      job.status = 'failed'
      job.error = `${msg}; rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
    }
  }

  private async runJobInternal(
    job: CutoverJobRecord,
    input: {
      readonly action: 'cutover' | 'reverify'
      readonly profileId: string
      readonly driverId?: string
      readonly deadlineMs?: number
      readonly maxCreditsPerRun?: number
      readonly maxCreditsPerDay?: number
    },
    adminUid: number,
  ): Promise<void> {
    const pool = this.deps.executorDeps.pool
    const regPath = this.deps.executorDeps.registryPath
    const suiteDigest = this.deps.suiteDigest ?? computeProductionConformanceSuiteDigest()
    let convertedFromLegacy = false
    let cutoverReadyGeneration: string | undefined
    let claimedRunId: string | undefined
    let liveDockerId: string | undefined

    try {
      await this.runDualPoolParityPrecheck(job, input, suiteDigest)

      const container = await this.deps.executorDeps.containerSource()
      need(container !== null, 'REMOTE_VERIFICATION_CONTAINER_NOT_RUNNING')
      liveDockerId = container.dockerId
      await reconcileStaleContainerLanes(pool, 3, container.dockerId, this.deps.recoveryFixtures)

      const probed = await executeLiveRemoteDriverProbe(
        pool,
        {
          profileId: input.profileId,
          driverId: input.driverId,
          keyDir: this.deps.keyDir,
          registryPath: regPath,
        },
        { probeHostFactory: this.deps.probeHostFactory },
      )

      if (input.maxCreditsPerRun !== undefined || input.maxCreditsPerDay !== undefined) {
        await upsertVerificationPolicy(
          pool,
          {
            ...(input.maxCreditsPerRun !== undefined
              ? { maxCreditsPerRun: input.maxCreditsPerRun }
              : {}),
            ...(input.maxCreditsPerDay !== undefined
              ? { maxCreditsPerDay: input.maxCreditsPerDay }
              : {}),
          },
          adminUid,
        )
      }

      const authEpoch =
        probed.profileRow.auth_epoch ?? probed.profileRow.account_fingerprint ?? randomUUID()

      await authorizeProfileInVerificationPolicy(pool, {
        profileId: input.profileId,
        driverId: probed.driverId,
        accountFingerprint: probed.profileRow.account_fingerprint
          ? String(probed.profileRow.account_fingerprint)
          : null,
        authEpoch: String(authEpoch),
        policySha256: probed.policySha256,
        authorizedByUid: adminUid,
        authorizedAt: new Date().toISOString(),
      })

      if (probed.profileRow.driver_id === null) {
        const cutover = await convertProfileToDriverV4(pool, {
          profileId: input.profileId,
          driverId: probed.driverId,
          targetFingerprint: probed.probeFingerprint,
          suiteDigest,
          policySha256: probed.policySha256,
          probeSnapshot: probed.snapshot,
          authEpoch: String(authEpoch),
          driverContext: probed.nonBlobDriverContext,
          registryPath: regPath,
          snapshotDir: this.deps.snapshotDir,
        })
        convertedFromLegacy = true
        cutoverReadyGeneration = cutover.readyGeneration
        job.readyGeneration = cutover.readyGeneration
      } else {
        const rec = await recordProductionDriverProbeSnapshot(pool, {
          profileId: input.profileId,
          snapshot: probed.snapshot,
          policySha256: probed.policySha256,
          suiteDigest,
          forceManualRetry: true,
        })
        job.readyGeneration = rec.readyGeneration
      }

      if (!this.deps.executorDeps.fixtures?.skipCatalogSync) {
        await syncProfileOffersCatalogState(pool, input.profileId)
      }

      const leaseOwner = `commission-job-${job.jobId}`
      const claimed = await claimDriverVerificationRun(pool, {
        leaseOwner,
        profileId: input.profileId,
        allowManual: true,
        maxAttempts: 5,
      })
      need(claimed !== null, 'REMOTE_VERIFICATION_CLAIM_FAILED')
      claimedRunId = claimed.id
      job.verificationRunId = claimed.id

      const result = await this.executeVerificationWithDeadline(
        claimed,
        suiteDigest,
        leaseOwner,
        input.deadlineMs ?? DEFAULT_CUTOVER_DEADLINE_MS,
      )

      if (!this.deps.executorDeps.fixtures?.skipCatalogSync) {
        await syncProfileOffersCatalogState(pool, input.profileId)
      }

      job.status = 'passed'
      job.evidenceDigest = result.evidenceDigest
      job.evidenceUri = result.evidenceUri
      job.finishedAt = new Date().toISOString()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      job.error = msg
      if (convertedFromLegacy && cutoverReadyGeneration !== undefined) {
        await this.rollbackLegacyCutover(
          job,
          input.profileId,
          cutoverReadyGeneration,
          claimedRunId,
          liveDockerId,
          msg,
        )
      } else {
        job.status = 'failed'
      }
      job.finishedAt = new Date().toISOString()
    }
  }
}
