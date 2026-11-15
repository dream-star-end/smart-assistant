/**
 * Sub-lane lifecycle operations for `remote-driver-v4` verification (`OCV5-749`, R12).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type DriverWorkerClient,
  RemotePoolRelay,
  RemotePoolSshHost,
} from '@openclaude/gateway/remote-pool'
import { type RemoteReceiptV4, remoteCanonicalSha256 } from '@openclaude/protocol'
import { createRemoteDriverTurnFinance } from '../../billing/remoteDriverTurnBilling.js'
import { bindAuthorityTurnDispatch } from '../../billing/verificationSponsorship.js'
import { admitDispatch, casToTerminal, heartbeatLease } from '../../dispatch/turnDispatchStore.js'
import {
  type RemoteDriverVerificationCaseLane,
  verificationTurnRequestId,
} from './driftCoordinator.js'
import {
  placeRemoteDriverLane,
  recordRemoteDriverLaneState,
  recordRemoteDriverNativeSession,
  recordRemoteDriverStartAttempt,
} from './placement.js'
import type { RemoteDriverRegistryEntry } from './registry.js'
import { admitVerificationTurnBudget } from './verificationBudget.js'
import type {
  VerificationLaneCloseResult,
  VerificationSubLaneHandle,
  VerificationTurnResult,
} from './verificationCases.js'
import type { VerificationCatalogHandle } from './verificationCatalog.js'
import type {
  VerificationContainerAuditInput,
  VerificationContainerProofResult,
} from './verificationRuntimeProof.js'
import type {
  DriverVerificationExecutorDeps,
  VerificationRunInput,
  VerificationWorkerController,
} from './verificationTypes.js'

function need(condition: unknown, code = 'REMOTE_VERIFICATION_EXECUTOR_FAILED'): asserts condition {
  if (!condition) throw new Error(code)
}

export function createSubLaneOperations(ctx: {
  readonly deps: DriverVerificationExecutorDeps
  readonly run: VerificationRunInput
  readonly reg: RemoteDriverRegistryEntry
  readonly container: { readonly containerDbId: string; readonly dockerId: string }
  readonly canonicalModel: string
  readonly effort: string
  readonly journalRoot: string
  readonly sharedWorker: DriverWorkerClient
  readonly verifyCatalog: VerificationCatalogHandle
  readonly workerCtrl: VerificationWorkerController
  readonly relays: Map<string, RemotePoolRelay>
  readonly openLanes: Set<VerificationSubLaneHandle>
  readonly activeHeartbeats: Set<ReturnType<typeof setInterval>>
  readonly proveContainer: (
    dockerId: string,
    audit: VerificationContainerAuditInput,
  ) => Promise<VerificationContainerProofResult>
  readonly checkCancelled: () => void
}) {
  const laneReceipts = new Map<string, RemoteReceiptV4[]>()

  const closeSubLane = async (
    lane: VerificationSubLaneHandle,
    audit?: {
      readonly expectedFiles?: ReadonlyArray<{ readonly path: string; readonly content: string }>
      readonly absentFiles?: ReadonlyArray<string>
      readonly keepState?: boolean
    },
  ): Promise<VerificationLaneCloseResult> => {
    if (lane.closed) {
      return {
        calls: [],
        nativeSessionId: null,
        proofs: [],
        remoteStopProof: (lane.host as { verifiedStopEvidence?: unknown }).verifiedStopEvidence,
      }
    }
    lane.closed = true
    ctx.openLanes.delete(lane)
    const workerClosed = await ctx.workerCtrl.closeLane(lane.caseLane)
    await lane.relay.stop().catch(() => {})
    if (!audit?.keepState) {
      await recordRemoteDriverLaneState(
        lane.operationId,
        lane.generation,
        'released',
        ctx.deps.pool,
      )
    }
    ctx.relays.delete(lane.caseLane)
    const containerProof = await ctx.proveContainer(ctx.container.dockerId, {
      runId: ctx.run.id,
      laneId: lane.caseLane,
      proofs: workerClosed.proofs.map((p) => ({ root: p.root, lifecycleId: p.lifecycleId })),
      expectedFiles: audit?.expectedFiles,
      absentFiles: audit?.absentFiles,
    })
    return {
      ...workerClosed,
      remoteStopProof: (lane.host as { verifiedStopEvidence?: unknown }).verifiedStopEvidence,
      containerProof,
    }
  }

  const openSubLane = async (
    caseLane: RemoteDriverVerificationCaseLane,
    opts?: {
      readonly barrierMode?: 'none' | 'hold_until_release'
      readonly maxSliceMemoryBytes?: number
      readonly skipPreflight?: boolean
    },
  ): Promise<VerificationSubLaneHandle> => {
    ctx.checkCancelled()
    const placed = await placeRemoteDriverLane(
      {
        uid: 3,
        containerDbId: ctx.container.containerDbId,
        dockerId: ctx.container.dockerId,
        canonicalModel: ctx.canonicalModel,
        driverId: ctx.run.driverId,
        verificationRun: {
          runId: ctx.run.id,
          leaseOwner: ctx.run.leaseOwner,
          caseLane,
        },
      },
      {
        pool: ctx.deps.pool,
        registryPath: ctx.deps.registryPath,
        localSandboxDir: ctx.deps.fixtures?.localSandboxDir,
        maxSliceMemoryBytes: opts?.maxSliceMemoryBytes,
      },
    )

    const host = ctx.deps.fixtures?.hostFactory
      ? ctx.deps.fixtures.hostFactory(placed.sshTarget, placed.spec)
      : RemotePoolSshHost.forSshTarget(placed.sshTarget, placed.spec)
    if (!opts?.skipPreflight) {
      const pre = await host.preflight()
      need(pre.memoryOk, pre.code ?? 'REMOTE_NODE_MEMORY_EXHAUSTED')
    }
    await recordRemoteDriverLaneState(
      placed.binding.operationId,
      placed.binding.generation,
      'running',
      ctx.deps.pool,
    )

    const receiptsForLane: RemoteReceiptV4[] = []
    laneReceipts.set(placed.binding.operationId, receiptsForLane)
    const baseFinance = createRemoteDriverTurnFinance(
      {
        pool: ctx.deps.pool,
        preCheckRedis: ctx.deps.preCheckRedis,
        catalog: ctx.verifyCatalog,
        keyring: ctx.deps.keyring,
        loadUserModelAuthz: ctx.deps.loadUserModelAuthz,
        log: ctx.deps.log,
        registryPath: ctx.deps.registryPath,
      },
      ctx.deps.fixtures?.financeFixtures,
    )
    const finance = {
      async admit(admitInput: Parameters<typeof baseFinance.admit>[0]) {
        handle.usagePolicy = admitInput.usagePolicy
        const turn = await baseFinance.admit(admitInput)
        return {
          ...turn,
          beforeHostStart: () => turn.beforeHostStart(),
          beforeDispatch: (d: Parameters<typeof turn.beforeDispatch>[0]) => turn.beforeDispatch(d),
          bindNativeThread: (id: string, created: boolean) => turn.bindNativeThread(id, created),
          abandonUndispatched: (c?: Parameters<typeof turn.abandonUndispatched>[0]) =>
            turn.abandonUndispatched(c),
          stop: (s: Parameters<typeof turn.stop>[0]) => turn.stop(s),
          async terminal(rcpt: RemoteReceiptV4) {
            const out = await turn.terminal(rcpt)
            receiptsForLane.push(rcpt)
            return out
          },
        }
      },
    }

    const relay = new RemotePoolRelay({
      binding: placed.binding,
      keys: ctx.deps.keyring(),
      host,
      spec: placed.spec,
      journalDir: join(ctx.journalRoot, `${caseLane}-g${placed.generation}`),
      finance,
      worker: ctx.sharedWorker,
      onNativeSession: async (nativeId) => {
        await recordRemoteDriverNativeSession(
          placed.binding.operationId,
          placed.binding.generation,
          nativeId,
          ctx.deps.pool,
        )
      },
      onRemoteStart: async () => {
        await recordRemoteDriverStartAttempt(
          placed.binding.operationId,
          placed.binding.generation,
          ctx.deps.pool,
        )
      },
    })
    ctx.relays.set(caseLane, relay)

    const workerOpened = await ctx.workerCtrl.openLane({
      laneId: caseLane,
      binding: placed.binding as unknown as Record<string, unknown>,
      barrierMode: opts?.barrierMode,
      effort: ctx.effort,
    })

    const handle: VerificationSubLaneHandle = {
      caseLane,
      operationId: placed.binding.operationId,
      generation: placed.binding.generation,
      taskRoot: placed.spec.manifest.root,
      laneCwd: workerOpened.laneCwd,
      binding: placed.binding,
      spec: placed.spec,
      sshTarget: placed.sshTarget,
      relay,
      host,
      receipts: receiptsForLane,
      closed: false,
    }
    ctx.openLanes.add(handle)
    return handle
  }

  const startSubLaneTurn = async (
    lane: VerificationSubLaneHandle,
    turnIndex: number,
    prompt: string,
    opts?: { readonly barrierMode?: 'none' | 'hold_until_release' },
  ) => {
    ctx.checkCancelled()
    const requestId = verificationTurnRequestId(ctx.run.id, lane.caseLane, turnIndex)
    await admitVerificationTurnBudget(ctx.deps.pool, { runId: ctx.run.id, requestId })

    const snapshot = await ctx.verifyCatalog.assertFresh()
    const d = snapshot.resolve(ctx.canonicalModel)
    need(d !== null && d !== undefined, 'REMOTE_VERIFICATION_MODEL_MISSING')

    const turnKey = randomBytes(32).toString('hex')
    const dispatchId = randomUUID()
    const admit = await admitDispatch(ctx.deps.pool, {
      dispatchId,
      userId: 3n,
      sessionId: lane.binding.sessionKey,
      clientMessageId: requestId,
      agentId: 'main',
      model: ctx.canonicalModel,
      requestHash: remoteCanonicalSha256({ prompt, caseLane: lane.caseLane, turnIndex }),
      billingRequestId: requestId,
      ownerId: lane.operationId,
      anchorSeq: null,
      agentContainerId: Number(lane.binding.containerDbId),
      runtimeKind: 'v5',
    })
    need(admit.kind === 'admitted', `REMOTE_VERIFICATION_DISPATCH_CONFLICT:${admit.kind}`)

    const executionBackend = {
      kind: 'remote-driver-v4' as const,
      version: 4 as const,
      driverId: ctx.reg.driverId,
      driverVersion: ctx.reg.driverVersion,
      engineId: ctx.reg.engineId,
      authorityEngine: ctx.reg.authorityEngine,
      operationId: lane.operationId,
      generation: lane.generation,
      sessionKey: lane.binding.sessionKey,
      profileId: lane.binding.profileId,
      authEpoch: lane.binding.authEpoch,
    }

    const signed = ctx.deps.signer.signBundle(
      {
        uid: 3,
        containerId: Number(lane.binding.containerDbId),
        connectionChallenge: `v4-verify-${ctx.run.id}`,
        canonicalModel: ctx.canonicalModel,
        engine: ctx.reg.authorityEngine as 'codex' | 'ccb',
        auxModels: [],
        executionRevision: snapshot.executionRevision,
        securityEpoch: Number(snapshot.securityEpoch),
        billingRequestId: requestId,
        executionBackend,
        executionDescriptor: {
          capabilityProfile: d.capabilityProfile as never,
          capabilitySchemaVersion: d.capabilitySchemaVersion,
          contextWindow: d.contextWindow,
          supportedEfforts: [...d.capabilityProfile.reasoning.supported],
          ...(d.capabilityProfile.reasoning.codexModelDefault === null
            ? {}
            : { codexDefaultEffort: d.capabilityProfile.reasoning.codexModelDefault }),
          supportsVision: false,
        },
      },
      { leaseTtlMs: 10 * 60_000 },
    )

    await bindAuthorityTurnDispatch(ctx.deps.pool, {
      authorityTurnId: signed.payload.authorityTurnId,
      dispatchId: admit.dispatch.dispatchId,
      userId: 3n,
      sessionId: lane.binding.sessionKey,
      dispatchModel: ctx.canonicalModel,
      canonicalModel: ctx.canonicalModel,
      attemptNo: admit.dispatch.attemptNo,
      ownerId: admit.dispatch.ownerId ?? lane.operationId,
      leaseEpoch: admit.dispatch.leaseEpoch,
      agentContainerId: Number(lane.binding.containerDbId),
      runtimeKind: 'v5',
    })

    const hb = setInterval(() => {
      void heartbeatLease(ctx.deps.pool, {
        dispatchId: admit.dispatch.dispatchId,
        ownerId: admit.dispatch.ownerId ?? lane.operationId,
        leaseEpoch: admit.dispatch.leaseEpoch,
      }).catch(() => {})
    }, 25_000)
    hb.unref()
    ctx.activeHeartbeats.add(hb)

    const started = ctx.workerCtrl.startTurn({
      laneId: lane.caseLane,
      prompt,
      requestId,
      turnKey,
      authority: signed.bundle.authority,
      lease: signed.bundle.lease,
      executionDescriptor: {
        executionBackend,
        canonicalModel: ctx.canonicalModel,
        contextWindow: d.contextWindow,
        capabilityZero: d.capabilityProfile.ccb.capabilityZero,
        supportsThinking: d.capabilityProfile.ccb.supportsThinking,
        supportsVision: false,
        supportedEfforts: [...d.capabilityProfile.reasoning.supported],
      },
      barrierMode: opts?.barrierMode,
    })

    return {
      requestId,
      waitSubmitted: started.waitSubmitted,
      waitDone: async (): Promise<VerificationTurnResult> => {
        try {
          const res = await started.waitDone()
          await casToTerminal(ctx.deps.pool, {
            dispatchId: admit.dispatch.dispatchId,
            expectedEpoch: admit.dispatch.leaseEpoch,
            outcome: res.summary?.isError ? 'executed_error' : 'completed',
          }).catch(() => {})
          return { ...res, receipts: lane.receipts.slice() }
        } catch (err) {
          await casToTerminal(ctx.deps.pool, {
            dispatchId: admit.dispatch.dispatchId,
            expectedEpoch: admit.dispatch.leaseEpoch,
            outcome: 'interrupted',
          }).catch(() => {})
          throw err
        } finally {
          clearInterval(hb)
          ctx.activeHeartbeats.delete(hb)
        }
      },
    }
  }

  return { closeSubLane, openSubLane, startSubLaneTurn }
}
