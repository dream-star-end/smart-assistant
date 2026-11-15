/**
 * Orchestrator for the 8-item `remote-driver-v4` production verification suite (`OCV5-749`, R12).
 *
 * Prechecks before spending upstream tokens:
 * 1. `assertVerificationRunAuthorized` (`remote_driver_verification_policy` + daily run cap)
 * 2. Profile `max_concurrent_lanes >= 3` (`W2`)
 * 3. `verifySandboxRedProofForDriver` against committed `sandbox-red-proof.json`
 * 4. Container runtime identity & hash parity (`proveVerificationRuntime`)
 * 5. Lease renewal heartbeat every 30s (`renewDriverVerificationLease`)
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriverWorkerClient, type RemotePoolRelay } from '@openclaude/gateway/remote-pool'
import { type RemoteProbeSnapshot, validateRemoteProbeSnapshot } from '@openclaude/protocol'
import {
  type RemoteDriverVerificationCaseLane,
  completeProductionDriverVerificationRun,
  renewDriverVerificationLease,
} from './driftCoordinator.js'
import { loadRemoteDriverRegistry } from './registry.js'
import { verifySandboxRedProofForDriver } from './sandboxRedProof.js'
import { assertVerificationRunAuthorized } from './verificationBudget.js'
import { type VerificationSubLaneHandle, runAllVerificationCases } from './verificationCases.js'
import { createDriverVerificationCatalog } from './verificationCatalog.js'
import { DEFAULT_EVIDENCE_ROOT, writeArtifactSafely } from './verificationEvidence.js'
import { createSubLaneOperations } from './verificationLaneHost.js'
import { proveVerificationContainer, proveVerificationRuntime } from './verificationRuntimeProof.js'
import type {
  DriverVerificationExecutorDeps,
  DriverVerificationTestFixtures,
  VerificationRunExecutionResult,
  VerificationRunInput,
  VerificationWorkerController,
} from './verificationTypes.js'
import { createDockerWorkerController } from './verificationWorkerClient.js'

export type {
  DriverVerificationExecutorDeps,
  DriverVerificationTestFixtures,
  VerificationRunExecutionResult,
  VerificationRunInput,
  VerificationWorkerController,
}

const LEASE_RENEW_INTERVAL_MS = 30_000

function need(condition: unknown, code = 'REMOTE_VERIFICATION_EXECUTOR_FAILED'): asserts condition {
  if (!condition) throw new Error(code)
}

export async function executeDriverVerificationRun(
  deps: DriverVerificationExecutorDeps,
  run: VerificationRunInput,
  options: { readonly allowManualUnbound?: boolean } = {},
): Promise<VerificationRunExecutionResult> {
  const { policy, canonicalModel } = await assertVerificationRunAuthorized(deps.pool, run.id, {
    allowManualUnbound: options.allowManualUnbound,
  })

  const profRes = await deps.pool.query<Record<string, any>>(
    `SELECT p.*, n.ssh_host, n.ssh_user
       FROM remote_agent_profiles p
       JOIN remote_agent_nodes n ON n.id = p.node_id
      WHERE p.id = $1`,
    [run.profileId],
  )
  need(profRes.rows.length === 1, 'REMOTE_PROFILE_NOT_FOUND')
  const profileRow = profRes.rows[0]!
  need(
    Number(profileRow.max_concurrent_lanes ?? 0) >= 3,
    'REMOTE_VERIFICATION_PROFILE_CONCURRENCY_TOO_LOW',
  )
  const verifiedProbe: RemoteProbeSnapshot = validateRemoteProbeSnapshot(profileRow.probe_snapshot)
  const manifestObj = (profileRow.execution_manifest ?? {}) as Record<string, unknown>
  const expectedPolicySha256 = String(manifestObj.policySha256 ?? '')
  need(/^[a-f0-9]{64}$/.test(expectedPolicySha256), 'REMOTE_POLICY_SHA256_MISSING')

  const reg = loadRemoteDriverRegistry(deps.registryPath).get(run.driverId)
  need(reg !== undefined, 'REMOTE_DRIVER_NOT_REGISTERED')

  verifySandboxRedProofForDriver({
    driverId: run.driverId,
    expectedDriverDigest: run.driverDigest,
    expectedCoreDigest: run.coreDigest,
    expectedSuiteDigest: run.suiteDigest,
    proofPath: deps.fixtures?.redProofPath,
  })

  const container = await deps.containerSource()
  need(container !== null, 'REMOTE_VERIFICATION_CONTAINER_NOT_RUNNING')
  const proveRuntime = deps.fixtures?.proveRuntime ?? proveVerificationRuntime
  const proveContainer = deps.fixtures?.proveContainer ?? proveVerificationContainer
  const runtimeProof = await proveRuntime(container.dockerId)

  let cancelledError: Error | null = null
  let leaseStopped = false
  const leaseTimer = setInterval(() => {
    void renewDriverVerificationLease(deps.pool, {
      runId: run.id,
      leaseOwner: run.leaseOwner,
    })
      .then((res) => {
        if (!res.renewed) cancelledError = new Error('REMOTE_VERIFICATION_LEASE_LOST')
      })
      .catch((err) => {
        cancelledError = err instanceof Error ? err : new Error('REMOTE_VERIFICATION_LEASE_ERROR')
      })
  }, LEASE_RENEW_INTERVAL_MS)
  leaseTimer.unref()

  const relays = new Map<string, RemotePoolRelay>()
  const openLanes = new Set<VerificationSubLaneHandle>()
  const sharedWorker = new DriverWorkerClient(
    deps.registryPath ? { registryPath: deps.registryPath } : {},
  )
  const journalRoot = mkdtempSync(join(tmpdir(), `oc-v4-verify-journal-${run.id.slice(0, 8)}-`))
  const keyringEncoded: ReadonlyArray<readonly [string, string]> = [
    ...deps.keyring().entries(),
  ].map(([id, key]) => [id, Buffer.from(key).toString('base64')])

  const workerCtrl = deps.fixtures?.spawnWorker
    ? await deps.fixtures.spawnWorker({
        dockerId: container.dockerId,
        runId: run.id,
        keyring: keyringEncoded,
        relays,
        localSandboxDir: deps.fixtures.localSandboxDir,
      })
    : await createDockerWorkerController({
        dockerId: container.dockerId,
        runId: run.id,
        keyring: keyringEncoded,
        relays,
      })

  const checkCancelled = () => {
    if (leaseStopped || cancelledError) {
      throw cancelledError ?? new Error('REMOTE_VERIFICATION_CANCELLED')
    }
  }

  const verifyCatalog = createDriverVerificationCatalog({
    pool: deps.pool,
    source: deps.catalog,
    loadAuthz: deps.loadUserModelAuthz,
    driverId: run.driverId,
    canonicalModel,
    verifiedProbe,
    registryPath: deps.registryPath,
    fence: async () => {
      if (cancelledError) throw cancelledError
    },
  })

  const activeHeartbeats = new Set<ReturnType<typeof setInterval>>()
  const allCaseLanes: RemoteDriverVerificationCaseLane[] = []
  const allTurnReqIds: string[] = []
  const laneOps = createSubLaneOperations({
    deps,
    run,
    reg,
    container,
    canonicalModel,
    effort: policy.effort,
    journalRoot,
    sharedWorker,
    verifyCatalog,
    workerCtrl,
    relays,
    openLanes,
    activeHeartbeats,
    proveContainer,
    checkCancelled,
  })

  try {
    const casesOut = await runAllVerificationCases({
      pool: deps.pool,
      run,
      reg,
      canonicalModel,
      effort: policy.effort,
      expectedPolicySha256,
      snapshot: verifiedProbe,
      checkCancelled,
      openSubLane: laneOps.openSubLane,
      submitSubLaneTurn: async (lane, turnIndex, prompt, opts) => {
        const t = await laneOps.startSubLaneTurn(lane, turnIndex, prompt, opts)
        return await t.waitDone()
      },
      startSubLaneTurn: laneOps.startSubLaneTurn,
      waitBarrierArrived: (l) => workerCtrl.waitBarrierArrived(l),
      releaseBarrier: (l, abort = false) => workerCtrl.releaseBarrier(l, abort),
      interruptSubLane: (l) => workerCtrl.interruptLane(l),
      closeSubLane: laneOps.closeSubLane,
      proveContainerFiles: (laneId, audit) =>
        proveContainer(container.dockerId, { runId: run.id, laneId, ...audit }),
      checkRemoteTaskFileExists: async (lane, relPath) => {
        if (deps.fixtures?.sshCheckTaskFileExists) {
          return await deps.fixtures.sshCheckTaskFileExists(lane.sshTarget, lane.taskRoot, relPath)
        }
        return lane.taskRoot.startsWith('/tmp/oc-drvtest-')
          ? existsSync(join(lane.taskRoot, relPath))
          : false
      },
      recordCaseLane: (l) => {
        if (!allCaseLanes.includes(l)) allCaseLanes.push(l)
      },
      recordRequestId: (id) => {
        allTurnReqIds.push(id)
      },
    })

    const bindingAudit = await deps.pool.query<{ state: string }>(
      `SELECT state FROM remote_agent_bindings WHERE recovery_spec->>'verificationRunId' = $1`,
      [run.id],
    )
    need(
      bindingAudit.rows.every((r) => r.state === 'released'),
      'VERIFICATION_UNRELEASED_SUBLANE_REMAINS',
    )

    const artifact: Record<string, unknown> = {
      schemaVersion: 1,
      runId: run.id,
      profileId: run.profileId,
      nodeId: run.nodeId,
      driverId: run.driverId,
      engineId: run.engineId,
      canonicalModel,
      effort: policy.effort,
      targetFingerprint: run.targetFingerprint,
      driverDigest: run.driverDigest,
      coreDigest: run.coreDigest,
      suiteDigest: run.suiteDigest,
      readyGeneration: run.readyGeneration,
      runtimeProof,
      items: casesOut.items,
      caseLanes: allCaseLanes,
      turnRequestIds: allTurnReqIds,
      completedAt: new Date().toISOString(),
    }

    const { evidenceUri, evidenceDigest } = writeArtifactSafely(
      deps.evidenceRoot ?? DEFAULT_EVIDENCE_ROOT,
      run.id,
      artifact,
      deps.fixtures?.localSandboxDir !== undefined,
    )

    const completion = await completeProductionDriverVerificationRun(deps.pool, {
      runId: run.id,
      outcome: 'passed',
      leaseOwner: run.leaseOwner,
      evidenceDigest,
      evidenceUri,
      evidenceMetadata: {
        runId: run.id,
        profileId: run.profileId,
        nodeId: run.nodeId,
        driverId: run.driverId,
        engineId: run.engineId,
        targetFingerprint: run.targetFingerprint,
        readyGeneration: run.readyGeneration,
        suiteDigest: run.suiteDigest,
        uid: 3,
        caseLanes: allCaseLanes,
        turnRequestIds: allTurnReqIds,
      },
    })
    need(
      completion.executionReadyRestored,
      `VERIFICATION_COMPLETE_REJECTED:${completion.state}:${completion.rejectReason ?? ''}`,
    )

    return {
      runId: run.id,
      state: completion.state,
      executionReadyRestored: completion.executionReadyRestored,
      alertEmitted: completion.alertEmitted,
      evidenceDigest,
      evidenceUri,
      artifact,
    }
  } finally {
    leaseStopped = true
    clearInterval(leaseTimer)
    for (const hb of activeHeartbeats) clearInterval(hb)
    activeHeartbeats.clear()
    for (const lane of [...openLanes]) {
      await laneOps.closeSubLane(lane, { keepState: true }).catch(() => {})
    }
    await workerCtrl.shutdown().catch(() => {})
    await sharedWorker.close().catch(() => {})
    rmSync(journalRoot, { recursive: true, force: true })
  }
}
