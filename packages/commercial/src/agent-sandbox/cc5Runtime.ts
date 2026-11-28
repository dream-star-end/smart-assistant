/** Master wiring of the remote-pool lane runtime. OFF performs no configuration I/O. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type RemoteLaneRuntimePort,
  createRemoteLaneRuntime,
} from '@openclaude/gateway/cc5-container-runtime'
import type { RemoteFinanceFactory } from '@openclaude/gateway/remote-finance'
import {
  CC5_TEST_UID_ENV,
  type Cc5PolicyEnvironment,
  type RemoteExecutionBackend,
  type RequiredTurnCapabilities,
  canUseCc5TestModel,
  isRemoteBackendAuthority,
} from '@openclaude/protocol'
import {
  recordRemoteLaneState,
  recordRemoteNativeThread,
  recordRemoteStartAttempt,
} from '../account-pool/remoteBrainPool.js'
import {
  DEFAULT_REMOTE_V4_DRAIN_SOCKET,
  type PlaceRemoteDriverLaneOptions,
  type RemoteReleaseDrainCoordinator,
  getMasterRemoteReleaseDrainCoordinator,
  isReservedVerificationSessionKey,
  recordRemoteDriverLaneState,
  recordRemoteDriverNativeSession,
  recordRemoteDriverStartAttempt,
  startRemoteReleaseDrainSocketServer,
} from '../account-pool/remotePool/index.js'
import { placeSelfhostRemoteLaneWithRetry } from '../account-pool/remotePool/sharedLanePlacementRuntime.js'
import { getPool } from '../db/index.js'
import {
  DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET,
  createRemoteRelayClient,
  isExternalRemoteLaneRuntime,
} from './remoteRelayClient.js'

const BASE_ROOT = '/run/oc-cc5-t1555u'
const NON_DEFAULT_LANE_ENGINES: ReadonlyMap<string, 'codex' | 'antigravity'> = new Map([
  ['codex', 'codex'],
  ['antigravity', 'antigravity'],
])

export const DEFAULT_REMOTE_RELAY_STATE_FILE =
  '/var/lib/openclaude-v5-selfhost/remote-relay-state.json'

export interface MigratedRemoteRelayState {
  readonly migrated: boolean
  readonly corrupted: boolean
  readonly activeSlot?: 'A' | 'B'
}

export function readMigratedRemoteRelayState(stateFilePath: string): MigratedRemoteRelayState {
  let raw: string
  try {
    raw = readFileSync(stateFilePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { migrated: false, corrupted: false }
    }
    return { migrated: true, corrupted: true }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { migrated: true, corrupted: true }
    }
    const obj = parsed as Record<string, unknown>
    const activeSlot =
      obj.activeSlot === 'A' || obj.activeSlot === 'B' ? obj.activeSlot : undefined
    if (obj.migrated === true || activeSlot !== undefined) {
      return {
        migrated: true,
        corrupted: false,
        ...(activeSlot !== undefined ? { activeSlot } : {}),
      }
    }
    if (obj.migrated === false) {
      return { migrated: false, corrupted: false }
    }
    return { migrated: true, corrupted: true }
  } catch {
    return { migrated: true, corrupted: true }
  }
}

export interface MasterCc5RemoteRelayReadiness {
  readonly external: boolean
  readonly healthy: boolean
  readonly disabled: boolean
  readonly slot: 'A' | 'B' | null
  readonly instanceId: string | null
  readonly activeCount: number
}

export async function probeMasterCc5RemoteRelayReadiness(
  runtime: RemoteLaneRuntimePort | undefined,
): Promise<MasterCc5RemoteRelayReadiness> {
  if (!isExternalRemoteLaneRuntime(runtime)) {
    return {
      external: false,
      healthy: false,
      disabled: false,
      slot: null,
      instanceId: null,
      activeCount: 0,
    }
  }
  try {
    const h = await runtime.probeHealth(1500)
    const slot = h && (h.slot === 'A' || h.slot === 'B') ? h.slot : null
    const instanceId =
      h && typeof h.instanceId === 'string' && h.instanceId.length > 0 ? h.instanceId : null
    const rawRuntimeState =
      h && typeof (h as { runtimeState?: unknown }).runtimeState === 'string'
        ? (h as { runtimeState?: string }).runtimeState
        : undefined
    if (rawRuntimeState === 'disabled') {
      return {
        external: true,
        healthy: false,
        disabled: true,
        slot,
        instanceId,
        activeCount: 0,
      }
    }
    const activeCount =
      h && typeof h.activeRelayCount === 'number' && Number.isFinite(h.activeRelayCount)
        ? Math.max(0, h.activeRelayCount)
        : 0
    const healthy =
      h !== null &&
      h.ok === true &&
      h.role === 'remote-relay' &&
      h.remoteRuntimeReady === true &&
      h.accepting === true &&
      rawRuntimeState !== 'error' &&
      instanceId !== null
    return {
      external: true,
      healthy,
      disabled: false,
      slot,
      instanceId,
      activeCount,
    }
  } catch {
    return {
      external: true,
      healthy: false,
      disabled: false,
      slot: null,
      instanceId: null,
      activeCount: 0,
    }
  }
}

export function createMasterCc5Runtime(
  input: {
    selfhost: boolean
    authorityReady: boolean
    env: Cc5PolicyEnvironment & {
      OC_REMOTE_V4_DRAIN_SOCKET?: string
      OC_REMOTE_RELAY_MODE?: string
      OC_REMOTE_RELAY_SOCKET?: string
      OC_REMOTE_RELAY_STATE_FILE?: string
      OC_EGRESS_SECRET?: string
    }
    egressSecret?: string; financeFactory?: RemoteFinanceFactory; legacyRetirementGate?: { assertLegacyPlacementAllowedAsync(): Promise<void> }
  },
  fixture: {
    create?: typeof createRemoteLaneRuntime
    createExternalClient?: typeof createRemoteRelayClient
    rejected?: (error: unknown) => void
    pool?: () => ReturnType<typeof getPool>
    drainGate?: RemoteReleaseDrainCoordinator
    v4PlacementOptions?: Partial<PlaceRemoteDriverLaneOptions>
    baseRoot?: string
    evidenceRoot?: string
  } = {},
): RemoteLaneRuntimePort | undefined {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !input.authorityReady || !canUseCc5TestModel(uid, input.env))
    return undefined

  const reportRejected = (error: unknown): undefined => {
    if (fixture.rejected) fixture.rejected(error)
    else
      console.error('[selfhost] remote lane runtime unavailable', {
        error: error instanceof Error ? error.message : String(error),
      })
    return undefined
  }

  const rawMode = (input.env.OC_REMOTE_RELAY_MODE ?? '').trim().toLowerCase()
  const sockPath = input.env.OC_REMOTE_RELAY_SOCKET?.trim() || DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET
  const stateFilePath =
    input.env.OC_REMOTE_RELAY_STATE_FILE?.trim() || DEFAULT_REMOTE_RELAY_STATE_FILE
  const secret = (input.egressSecret ?? input.env.OC_EGRESS_SECRET ?? '').trim()

  if (rawMode === 'external') {
    if (!sockPath || !secret) {
      return reportRejected(
        new Error('REMOTE_RELAY_EXTERNAL_MISCONFIGURED: missing socketPath or egressSecret'),
      )
    }
    try {
      return (fixture.createExternalClient ?? createRemoteRelayClient)({
        socketPath: sockPath,
        secret,
      })
    } catch (error) {
      return reportRejected(error)
    }
  }

  if (rawMode === 'auto') {
    const migratedState = readMigratedRemoteRelayState(stateFilePath)
    if (migratedState.migrated) {
      if (!sockPath || !secret) {
        return reportRejected(
          new Error(
            'REMOTE_RELAY_AUTO_MIGRATED_MISCONFIGURED: migrated state present but missing socketPath or egressSecret',
          ),
        )
      }
      try {
        return (fixture.createExternalClient ?? createRemoteRelayClient)({
          socketPath: sockPath,
          secret,
        })
      } catch (error) {
        return reportRejected(error)
      }
    }
    if (sockPath && secret && (fixture.createExternalClient || existsSync(sockPath))) {
      try {
        return (fixture.createExternalClient ?? createRemoteRelayClient)({
          socketPath: sockPath,
          secret,
        })
      } catch (error) {
        return reportRejected(error)
      }
    }
  }

  if (!input.financeFactory) return undefined
  const cwdController = resolve('scripts/agent-remote/cc5-host-controller.py')
  const controllerPath = existsSync(cwdController)
    ? cwdController
    : fileURLToPath(
        new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
      )
  const drainGate = fixture.drainGate ?? getMasterRemoteReleaseDrainCoordinator()
  const activePool = fixture.pool ?? getPool
  try {
    const drainSockEnv = input.env.OC_REMOTE_V4_DRAIN_SOCKET
    if (drainSockEnv !== 'none' && (!fixture.create || typeof drainSockEnv === 'string')) {
      startRemoteReleaseDrainSocketServer(drainGate, {
        pool: activePool,
        socketPath: drainSockEnv || DEFAULT_REMOTE_V4_DRAIN_SOCKET,
      })
    }
    return (fixture.create ?? createRemoteLaneRuntime)({
      selfhost: true,
      env: input.env,
      financeFactory: input.financeFactory,
      configuration: () => ({
        baseRoot: fixture.baseRoot ?? BASE_ROOT,
        controllerPath,
        evidenceRoot: fixture.evidenceRoot ?? '/var/lib/openclaude/remote-native',
      }),
      hooks: {
        place: (request) =>
          placeSelfhostRemoteLaneWithRetry(request, {
            getPool: activePool,
            drainGate,
            controllerPath,
            legacyRetirementGate: input.legacyRetirementGate,
            v4PlacementOptions: fixture.v4PlacementOptions,
            onBindingReadWarning: (meta) => {
              console.warn(
                '[selfhost] logical model binding read error during unified router selection',
                meta,
              )
            },
          }),
        onState: (operationId, state, generation, isV4) =>
          isV4
            ? recordRemoteDriverLaneState(operationId, generation!, state, activePool())
            : recordRemoteLaneState(operationId, state, activePool(), generation),
        onRemoteStart: (operationId, generation, isV4) =>
          isV4
            ? recordRemoteDriverStartAttempt(operationId, generation, activePool())
            : recordRemoteStartAttempt(operationId, generation, activePool()),
        onNativeThread: (operationId, generation, id, isV4) =>
          isV4
            ? recordRemoteDriverNativeSession(operationId, generation, id, activePool())
            : recordRemoteNativeThread(operationId, generation, id, activePool()),
        registerDrainRelay: (id, relay) => drainGate.registerRelay(id, relay),
      },
    })
  } catch (error) {
    return reportRejected(error)
  }
}

/** A remote-pool model turn gets its chat's lane; a local model gets none. Never a fallback. */
export async function selectMasterCc5Backend(
  runtime: RemoteLaneRuntimePort | undefined,
  input: {
    uid: number
    containerId: number
    sessionKey: string
    canonicalModel: string
    engine: string
    placement: 'local' | 'remote_pool'
    allowStickyFailover?: boolean
    requiredCapabilities?: RequiredTurnCapabilities
    systemPromptSha256?: string
  },
  selfhost: boolean,
  env: Cc5PolicyEnvironment,
): Promise<RemoteExecutionBackend | undefined> {
  if (isReservedVerificationSessionKey(input.sessionKey)) {
    throw new Error('REMOTE_SESSION_KEY_RESERVED')
  }
  if (input.placement !== 'remote_pool') return undefined
  const isSupportedRemoteEngine =
    input.engine === 'ccb' || input.engine === 'codex' || input.engine === 'antigravity'
  if (
    !selfhost ||
    !runtime ||
    !isSupportedRemoteEngine ||
    !canUseCc5TestModel(String(input.uid), env)
  ) {
    throw new Error('REMOTE_LANE_UNAVAILABLE')
  }
  const laneEngine = NON_DEFAULT_LANE_ENGINES.get(input.engine)
  const laneRequest = {
    uid: input.uid,
    containerDbId: String(input.containerId),
    sessionKey: input.sessionKey,
    canonicalModel: input.canonicalModel,
    ...(laneEngine ? { engine: laneEngine } : {}),
    ...(input.allowStickyFailover === true ? { allowStickyFailover: true } : {}),
    ...(input.requiredCapabilities !== undefined
      ? { requiredCapabilities: input.requiredCapabilities }
      : {}),
    ...(input.systemPromptSha256 !== undefined
      ? { systemPromptSha256: input.systemPromptSha256 }
      : {}),
  }
  const backend = await runtime.ensureLane(laneRequest)
  if (
    !isRemoteBackendAuthority({
      engine: input.engine,
      canonicalModel: input.canonicalModel,
      executionBackend: backend,
    })
  )
    throw new Error('REMOTE_LANE_UNAVAILABLE')
  return backend
}
