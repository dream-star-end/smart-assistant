/**
 * Leader scheduler for `remote-driver-v4` lease reaping, probe drift checks, and bounded
 * authorized auto-reverification (`OCV5-749`, R12).
 */
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import type { RemotePoolProbeOutput, RemotePoolProbeSpec } from '@openclaude/gateway/remote-pool'
import type { Pool } from 'pg'
import {
  claimDriverVerificationRun,
  reapExpiredDriverVerificationRuns,
  recordProductionDriverProbeSnapshot,
} from './driftCoordinator.js'
import { executeLiveRemoteDriverProbe } from './liveProbe.js'
import { computeProductionConformanceSuiteDigest } from './profileCutover.js'
import { assertVerificationRunAuthorized, loadVerificationPolicy } from './verificationBudget.js'
import { syncProfileOffersCatalogState } from './verificationCatalog.js'
import {
  type DriverVerificationExecutorDeps,
  executeDriverVerificationRun,
} from './verificationExecutor.js'

const DEFAULT_INTERVAL_MS = 4 * 60_000
const DEFAULT_INITIAL_DELAY_MS = 30_000

export interface RemoteDriverDriftSchedulerDeps {
  readonly pool: Pool
  readonly executorDeps?: DriverVerificationExecutorDeps
  readonly probeHostFactory?: (
    target: RemoteCcTarget,
    spec: RemotePoolProbeSpec,
  ) => { probe(context: Record<string, unknown>): Promise<RemotePoolProbeOutput> }
  readonly keyDir?: string
  readonly registryPath?: string
  readonly suiteDigest?: string
  readonly intervalMs?: number
  readonly initialDelayMs?: number
  readonly leaseOwner?: string
  readonly skipCatalogSync?: boolean
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void
    warn?: (msg: string, fields?: Record<string, unknown>) => void
  }
}

export interface RemoteDriverDriftSchedulerHandle {
  stop(): Promise<void>
  runOnce(): Promise<void>
}

export function startRemoteDriverDriftScheduler(
  deps: RemoteDriverDriftSchedulerDeps,
): RemoteDriverDriftSchedulerHandle {
  if (process.env.OC_REMOTE_DRIVER_DRIFT_DISABLED === '1') {
    return {
      stop: async () => {},
      runOnce: async () => {},
    }
  }

  let stopped = false
  let inFlight: Promise<void> | null = null
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const initialDelayMs = deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const leaseOwner = deps.leaseOwner ?? `drift-scheduler-${process.pid}`

  const tick = async (): Promise<void> => {
    if (stopped) return
    const suiteDigest = deps.suiteDigest ?? computeProductionConformanceSuiteDigest()

    await reapExpiredDriverVerificationRuns(deps.pool)

    const profiles = (
      await deps.pool.query<{ id: string; execution_ready: boolean }>(
        `SELECT p.id, p.execution_ready
           FROM remote_agent_profiles p
           JOIN remote_agent_nodes n ON n.id = p.node_id
          WHERE p.driver_id IS NOT NULL
            AND p.status IN ('active', 'degraded')
            AND p.disabled_by IS DISTINCT FROM 'admin'
            AND n.disabled_by IS DISTINCT FROM 'admin'
          ORDER BY p.probed_at NULLS FIRST, p.updated_at ASC
          LIMIT 16`,
      )
    ).rows

    for (const p of profiles) {
      if (stopped) return
      try {
        const probed = await executeLiveRemoteDriverProbe(
          deps.pool,
          {
            profileId: p.id,
            keyDir: deps.keyDir,
            registryPath: deps.registryPath,
          },
          { probeHostFactory: deps.probeHostFactory },
        )
        const recorded = await recordProductionDriverProbeSnapshot(deps.pool, {
          profileId: p.id,
          snapshot: probed.snapshot,
          policySha256: probed.policySha256,
          suiteDigest,
        })
        if (!deps.skipCatalogSync && recorded.executionReady !== p.execution_ready) {
          await syncProfileOffersCatalogState(deps.pool, p.id)
        }
      } catch (err) {
        deps.log?.warn?.('remoteDriverDrift probe refresh failed', {
          profileId: p.id,
          error: String(err),
        })
      }
    }

    if (stopped || !deps.executorDeps) return

    const policy = await loadVerificationPolicy(deps.pool)
    if (!policy.autoVerifyEnabled) return

    const claimed = await claimDriverVerificationRun(deps.pool, {
      leaseOwner,
      allowManual: false,
      maxAttempts: 2,
    })
    if (!claimed) return

    try {
      await assertVerificationRunAuthorized(deps.pool, claimed.id, {
        allowManualUnbound: false,
      })
      await executeDriverVerificationRun(deps.executorDeps, {
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
      })
      if (!deps.skipCatalogSync) {
        await syncProfileOffersCatalogState(deps.pool, claimed.profileId)
      }
    } catch (err) {
      deps.log?.warn?.('remoteDriverDrift auto-reverify failed', {
        runId: claimed.id,
        error: String(err),
      })
    }
  }

  const scheduleTick = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = tick()
      .catch((err) => {
        deps.log?.warn?.('remoteDriverDrift tick error', { error: String(err) })
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  let intervalTimer: ReturnType<typeof setInterval> | undefined
  const initialTimer = setTimeout(() => {
    if (stopped) return
    void scheduleTick()
    intervalTimer = setInterval(() => {
      void scheduleTick()
    }, intervalMs)
    intervalTimer.unref()
  }, initialDelayMs)
  initialTimer.unref()

  return {
    runOnce: () => scheduleTick(),
    stop: async () => {
      stopped = true
      clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      if (inFlight) await inFlight
    },
  }
}
