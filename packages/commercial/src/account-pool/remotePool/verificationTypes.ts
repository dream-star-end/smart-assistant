/**
 * Shared types for `remote-driver-v4` verification worker, executor, and fixtures (`OCV5-749`, R12).
 */
import type { RemoteCcTarget } from '@openclaude/gateway/cc5-container-runtime'
import type {
  RemotePoolHostPort,
  RemotePoolLaneSpec,
  RemotePoolRelay,
} from '@openclaude/gateway/remote-pool'
import type { AuthorityKeyring } from '@openclaude/protocol'
import type { Pool } from 'pg'
import type { UserModelAuthzLoader } from '../../auth/userModelAuthz.js'
import type { PreCheckRedis } from '../../billing/preCheck.js'
import type { RemoteDriverFinanceFixtures } from '../../billing/remoteDriverTurnBilling.js'
import type { CatalogSource } from '../../http/proxy/modelAuthorityGate.js'
import type { Logger } from '../../logging/logger.js'
import type { AuthoritySigner } from '../../ws/authoritySigner.js'
import type { CommissionContainerSource } from '../codexCommissioningContainer.js'
import type { VerificationLaneCloseResult, VerificationTurnResult } from './verificationCases.js'
import type {
  VerificationContainerAuditInput,
  VerificationContainerProofResult,
  VerificationRuntimeProof,
} from './verificationRuntimeProof.js'

export interface VerificationWorkerController {
  openLane(input: {
    readonly laneId: string
    readonly binding: Record<string, unknown>
    readonly barrierMode?: 'none' | 'hold_until_release'
    readonly effort?: string
  }): Promise<{ readonly laneCwd: string }>
  startTurn(input: {
    readonly laneId: string
    readonly prompt: string
    readonly requestId: string
    readonly turnKey: string
    readonly authority: string
    readonly lease: string
    readonly executionDescriptor: Record<string, unknown>
    readonly barrierMode?: 'none' | 'hold_until_release'
  }): {
    readonly waitSubmitted: () => Promise<void>
    readonly waitDone: () => Promise<VerificationTurnResult>
  }
  waitBarrierArrived(laneId: string): Promise<void>
  releaseBarrier(laneId: string, abort: boolean): Promise<void>
  interruptLane(laneId: string): Promise<void>
  closeLane(
    laneId: string,
  ): Promise<Omit<VerificationLaneCloseResult, 'remoteStopProof' | 'containerProof'>>
  shutdown(): Promise<void>
}

export interface DriverVerificationTestFixtures {
  readonly proveRuntime?: (dockerId: string) => Promise<VerificationRuntimeProof>
  readonly proveContainer?: (
    dockerId: string,
    input: VerificationContainerAuditInput,
  ) => Promise<VerificationContainerProofResult>
  readonly proveLocalStopped?: (dockerId: string, runId: string) => Promise<void>
  readonly spawnWorker?: (input: {
    readonly dockerId: string
    readonly runId: string
    readonly keyring: ReadonlyArray<readonly [string, string]>
    readonly relays: ReadonlyMap<string, RemotePoolRelay>
    readonly localSandboxDir?: string
  }) => Promise<VerificationWorkerController>
  readonly hostFactory?: (target: RemoteCcTarget, spec: RemotePoolLaneSpec) => RemotePoolHostPort
  readonly sshCheckTaskFileExists?: (
    target: RemoteCcTarget,
    taskRoot: string,
    relPath: string,
  ) => Promise<boolean>
  readonly financeFixtures?: RemoteDriverFinanceFixtures
  readonly localSandboxDir?: string
  readonly redProofPath?: string
  readonly skipCatalogSync?: boolean
}

export interface DriverVerificationExecutorDeps {
  readonly pool: Pool
  readonly preCheckRedis: PreCheckRedis
  readonly catalog: CatalogSource
  readonly keyring: () => AuthorityKeyring
  readonly signer: AuthoritySigner
  readonly loadUserModelAuthz: UserModelAuthzLoader
  readonly log: Logger
  readonly containerSource: CommissionContainerSource
  readonly evidenceRoot?: string
  readonly registryPath?: string
  readonly fixtures?: DriverVerificationTestFixtures
}

export interface VerificationRunInput {
  readonly id: string
  readonly nodeId: string
  readonly profileId: string
  readonly driverId: string
  readonly engineId: string
  readonly targetFingerprint: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly suiteDigest: string
  readonly readyGeneration: string
  readonly leaseOwner: string
}

export interface VerificationRunExecutionResult {
  readonly runId: string
  readonly state: string
  readonly executionReadyRestored: boolean
  readonly alertEmitted: boolean
  readonly evidenceDigest: string
  readonly evidenceUri: string
  readonly artifact: Record<string, unknown>
}
