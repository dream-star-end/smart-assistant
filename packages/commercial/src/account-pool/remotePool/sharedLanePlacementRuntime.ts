/**
 * OCV5-928 W2-CS1 — Shared Selfhost Remote-Pool Lane Placement Runtime (`accounts` L3).
 *
 * Unifies `remoteRelay/main.ts` (`remote-relay` L6) and `agent-sandbox/cc5Runtime.ts`
 * (`app-container` L4) onto one `UnifiedPlacementRouter`-backed driver selection and
 * retryable placement pipeline so standalone blue-green `remote-relay` never diverges
 * from Master in-process `cc5Runtime`.
 *
 * Architecture & governance invariants:
 * - Module: `accounts` (L3, `scope: ["master", "egress"]`).
 * - Zero `process.env`, zero `syncIo`, zero `@openclaude/gateway/*` value imports,
 *   zero `emptyCatch`, zero `typeEscape`, zero `R3-special-case`.
 */
import type { Pool } from 'pg'
import type { RemoteDriverAuthorityEngine, RequiredTurnCapabilities } from '@openclaude/protocol'
import { placeRemoteLane } from '../remoteBrainPool.js'
import { reconcileRemoteChat, reconcileStaleContainerLanes } from '../remoteLaneRecovery.js'
import type { RemoteReleaseDrainCoordinator } from './drainGate.js'
import { isReservedVerificationSessionKey } from './driftCoordinator.js'
import {
  placeRemoteDriverLane,
  type PlaceRemoteDriverLaneOptions,
} from './placement.js'
import {
  selectSelfhostRemoteDriverViaUnifiedRouter,
  type SelectSelfhostRemoteDriverOptions,
  type SelfhostRemoteDriverSelectionResult,
} from './remoteDriverRouterSelection.js'

const LEGACY_SUPPORTED_ENGINES: ReadonlySet<string> = new Set(['ccb', 'codex'])

function isLegacyRemoteEngine(value: string): value is 'ccb' | 'codex' {
  return LEGACY_SUPPORTED_ENGINES.has(value)
}

export interface SharedLaneSelectionRequest {
  readonly uid: number | string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly engine?: RemoteDriverAuthorityEngine
  readonly allowStickyFailover?: boolean
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly systemPromptSha256?: string
}

export interface SharedLanePlacementRequest extends SharedLaneSelectionRequest {
  readonly uid: number
  readonly containerDbId: string
  readonly dockerId: string
}

export interface ResolveSelfhostDriverV4Options {
  readonly routerOptions?: SelectSelfhostRemoteDriverOptions
  readonly onBindingReadWarning?: (meta: {
    readonly canonicalModel: string
    readonly sessionKey: string
    readonly error: string
    readonly fallbackSource: SelfhostRemoteDriverSelectionResult['source']
    readonly selectedDriverId: string | null
    readonly selectedProfileId: string | null
  }) => void
}

export interface SharedLanePlacementDeps extends ResolveSelfhostDriverV4Options {
  readonly getPool: () => Pool
  readonly drainGate: RemoteReleaseDrainCoordinator
  readonly controllerPath: string
  readonly isShuttingDown?: () => boolean
  readonly legacyRetirementGate?: {
    assertLegacyPlacementAllowedAsync(): Promise<void>
  }
  readonly v4PlacementOptions?: Partial<PlaceRemoteDriverLaneOptions>
  readonly onPlacedGeneration?: (operationId: string, generation?: string) => void
}

/**
 * Shared selfhost `remote-driver-v4` selector backed by `selectSelfhostRemoteDriverViaUnifiedRouter`:
 * - Enforces `PgLogicalModelBindingStore` priority & fail-closed disabled bindings (`MODEL_POOL_BINDING_DISABLED`).
 * - Applies WRH `stickyHomeKey` and `cacheAffinityKey` ranking.
 * - Preserves Q1/Q2 4-quadrant compatibility (`42P01` unconfigured table fallback, sticky v4 pinning,
 *   `allowStickyFailover`, and uncommissioned-staging guard).
 */
export async function resolveSelfhostDriverV4Selection(
  pool: Pool,
  request: SharedLaneSelectionRequest,
  options: ResolveSelfhostDriverV4Options = {},
): Promise<SelfhostRemoteDriverSelectionResult> {
  const selected = await selectSelfhostRemoteDriverViaUnifiedRouter(
    pool,
    {
      selfhost: true,
      uid: request.uid,
      sessionKey: request.sessionKey,
      canonicalModel: request.canonicalModel,
      engine: request.engine,
      ...(request.requiredCapabilities
        ? { requiredCapabilities: request.requiredCapabilities }
        : {}),
      ...(request.systemPromptSha256 ? { systemPromptSha256: request.systemPromptSha256 } : {}),
      ...(request.allowStickyFailover === true ? { allowStickyFailover: true } : {}),
    },
    options.routerOptions,
  )

  if (selected.bindingStatus === 'read_error') {
    options.onBindingReadWarning?.({
      canonicalModel: request.canonicalModel,
      sessionKey: request.sessionKey,
      error: selected.bindingReadError ?? 'unknown',
      fallbackSource: selected.source,
      selectedDriverId: selected.driverId,
      selectedProfileId: selected.selectedProfileId ?? null,
    })
  }

  return selected
}

export async function placeSelfhostRemoteLaneOnce(
  request: SharedLanePlacementRequest,
  deps: SharedLanePlacementDeps,
) {
  if (isReservedVerificationSessionKey(request.sessionKey)) {
    throw new Error('REMOTE_SESSION_KEY_RESERVED')
  }
  if (deps.isShuttingDown?.()) {
    throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
  }
  deps.drainGate.assertAdmissionOpen()

  const pool = deps.getPool()
  const selected = await resolveSelfhostDriverV4Selection(pool, request, deps)
  if (selected.driverId) {
    const v4 = await placeRemoteDriverLane(
      {
        uid: request.uid,
        containerDbId: request.containerDbId,
        dockerId: request.dockerId,
        sessionKey: request.sessionKey,
        canonicalModel: request.canonicalModel,
        driverId: selected.driverId,
      },
      {
        pool,
        drainGate: deps.drainGate,
        ...(deps.v4PlacementOptions ?? {}),
        ...(request.allowStickyFailover === true ? { allowStickyFailover: true } : {}),
      },
    )
    deps.onPlacedGeneration?.(v4.binding.operationId, v4.generation)
    return {
      target: v4.sshTarget,
      taskRoot: v4.spec.manifest.root,
      operationId: v4.binding.operationId,
      runId: v4.binding.runId,
      provisionPacket: Buffer.alloc(0),
      profileId: v4.profileUuid,
      generation: v4.generation,
      v4: {
        binding: v4.binding,
        spec: v4.spec,
        sshTarget: v4.sshTarget,
      },
    }
  }

  const requestedEngine = request.engine
  if (requestedEngine !== undefined && !isLegacyRemoteEngine(requestedEngine)) {
    throw new Error('REMOTE_LANE_UNAVAILABLE')
  }
  await deps.legacyRetirementGate?.assertLegacyPlacementAllowedAsync()
  const legacy = await placeRemoteLane(
    {
      ...request,
      engine: requestedEngine,
    },
    { controllerPath: deps.controllerPath, pool },
  )
  deps.onPlacedGeneration?.(legacy.operationId, legacy.generation)
  return legacy
}

export async function placeSelfhostRemoteLaneWithRetry(
  request: SharedLanePlacementRequest,
  deps: SharedLanePlacementDeps,
) {
  try {
    return await placeSelfhostRemoteLaneOnce(request, deps)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    const pool = deps.getPool()
    if (code === 'REMOTE_LANE_STOP_UNPROVEN') {
      await reconcileRemoteChat(pool, request.uid, request.sessionKey)
    } else if (
      code !== 'REMOTE_LANE_CAPACITY_EXHAUSTED' ||
      !(await reconcileStaleContainerLanes(pool, request.uid, request.dockerId))
    ) {
      throw error
    }
    return placeSelfhostRemoteLaneOnce(request, deps)
  }
}
