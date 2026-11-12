/** Master wiring of the remote-pool lane runtime. OFF performs no configuration I/O. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RemoteFinanceFactory } from '@openclaude/gateway/remote-finance'
import {
  createRemoteLaneRuntime,
  type RemoteLaneRuntimePort,
} from '@openclaude/gateway/cc5-container-runtime'
import {
  CC5_TEST_UID_ENV,
  type RemoteExecutionBackend,
  isRemoteBackendAuthority,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
} from '@openclaude/protocol'
import { placeRemoteLane, recordRemoteLaneState, recordRemoteNativeThread, recordRemoteStartAttempt } from '../account-pool/remoteBrainPool.js'
import {
  DEFAULT_REMOTE_V4_DRAIN_SOCKET,
  getMasterRemoteReleaseDrainCoordinator,
  legacyBindingEngineForAuthority,
  legacyProfileEngineForAuthority,
  placeRemoteDriverLane,
  recordRemoteDriverLaneState,
  recordRemoteDriverNativeSession,
  recordRemoteDriverStartAttempt,
  startRemoteReleaseDrainSocketServer,
  type PlaceRemoteDriverLaneOptions,
  type RemoteReleaseDrainCoordinator,
} from '../account-pool/remotePool/index.js'

import { getPool } from '../db/index.js'
import { reconcileRemoteChat, reconcileStaleContainerLanes } from '../account-pool/remoteLaneRecovery.js'

const BASE_ROOT = '/run/oc-cc5-t1555u'

/**
 * Model-level v4 cutover selector (Design §5.1 / §7):
 * - Sticky v4 chats stay pinned to their v4 `driver_id`.
 * - Once at least one v4 profile for `(canonicalModel, engine)` has been commissioned
 *   (`execution_ready = TRUE` or `verified_fingerprint IS NOT NULL`), new chats for that model
 *   route exclusively to v4 and NEVER auto-downgrade to legacy on drift (`REMOTE_DRIVER_REVERIFY_REQUIRED`).
 * - Uncommissioned staging rows (`execution_ready = FALSE AND verified_fingerprint IS NULL`) do NOT
 *   hijack traffic while a healthy legacy (`driver_id IS NULL`) offer exists for the same model.
 * - During cutover, `drainGate` closes new-session admission; warm resident lanes' subsequent turns
 *   are gated by `cutover_wait_for_user_idle` prior to master restart.
 */
async function resolveDriverV4Selection(
  pool: ReturnType<typeof getPool>,
  request: { uid: number; sessionKey: string; canonicalModel: string; engine?: 'ccb' | 'codex' },
): Promise<string | null> {
  const authEngine = request.engine === 'codex' ? 'codex' : 'ccb'
  const legacyBindEngine = legacyBindingEngineForAuthority(authEngine)
  const legacyProfEngine = legacyProfileEngineForAuthority(authEngine)
  const sticky = (
    await pool.query<{ driver_id: string | null }>(
      `SELECT driver_id
         FROM remote_agent_bindings
        WHERE uid = $1
          AND session_key = $2
          AND driver_id IS NOT NULL
          AND engine = $3
        ORDER BY updated_at DESC
        LIMIT 1`,
      [String(request.uid), request.sessionKey, legacyBindEngine],
    )
  ).rows[0]
  if (sticky?.driver_id) return sticky.driver_id

  const offer = (
    await pool.query<{ driver_id: string }>(
      `SELECT p.driver_id
         FROM remote_model_offers o
         JOIN remote_agent_profiles p ON p.id = o.profile_id
         JOIN remote_agent_nodes n ON n.id = p.node_id
        WHERE o.canonical_model_id = $1
          AND o.enabled = TRUE
          AND p.driver_id IS NOT NULL
          AND p.engine = $2
          AND p.status IN ('active', 'degraded')
          AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
          AND n.status IN ('active', 'degraded')
          AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
          AND (
            p.execution_ready = TRUE
            OR p.verified_fingerprint IS NOT NULL
            OR NOT EXISTS (
              SELECT 1
                FROM remote_model_offers o_leg
                JOIN remote_agent_profiles p_leg ON p_leg.id = o_leg.profile_id
                JOIN remote_agent_nodes n_leg ON n_leg.id = p_leg.node_id
               WHERE o_leg.canonical_model_id = $1
                 AND o_leg.enabled = TRUE
                 AND p_leg.driver_id IS NULL
                 AND p_leg.engine = $2
                 AND p_leg.status IN ('active', 'degraded')
                 AND (p_leg.disabled_by IS NULL OR p_leg.disabled_by <> 'admin')
                 AND n_leg.status IN ('active', 'degraded')
                 AND (n_leg.disabled_by IS NULL OR n_leg.disabled_by <> 'admin')
            )
          )
        ORDER BY p.execution_ready DESC, p.weight DESC, p.id ASC
        LIMIT 1`,
      [request.canonicalModel, legacyProfEngine],
    )
  ).rows[0]
  return offer?.driver_id ?? null
}

export function createMasterCc5Runtime(
  input: {
    selfhost: boolean
    authorityReady: boolean
    env: Cc5PolicyEnvironment & { OC_REMOTE_V4_DRAIN_SOCKET?: string }
    financeFactory?: RemoteFinanceFactory
  },
  fixture: {
    create?: typeof createRemoteLaneRuntime
    rejected?: (error: unknown) => void
    pool?: () => ReturnType<typeof getPool>
    drainGate?: RemoteReleaseDrainCoordinator
    v4PlacementOptions?: Partial<PlaceRemoteDriverLaneOptions>
    baseRoot?: string
    evidenceRoot?: string
  } = {},
): RemoteLaneRuntimePort | undefined {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !input.authorityReady || !input.financeFactory || !canUseCc5TestModel(uid, input.env))
    return undefined
  const cwdController = resolve('scripts/agent-remote/cc5-host-controller.py')
  const controllerPath = existsSync(cwdController)
    ? cwdController
    : fileURLToPath(new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url))
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
    const runPlaceOnce = async (request: {
      engine?: 'ccb' | 'codex'
      uid: number
      containerDbId: string
      dockerId: string
      sessionKey: string
      canonicalModel: string
    }) => {
      drainGate.assertAdmissionOpen()
      const pool = activePool()
      const driverId = await resolveDriverV4Selection(pool, request)
      if (driverId) {
        const v4 = await placeRemoteDriverLane(
          {
            uid: request.uid,
            containerDbId: request.containerDbId,
            dockerId: request.dockerId,
            sessionKey: request.sessionKey,
            canonicalModel: request.canonicalModel,
            driverId,
          },
          {
            pool,
            drainGate,
            ...(fixture.v4PlacementOptions ?? {}),
          },
        )
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
      return placeRemoteLane(request, { controllerPath, pool })
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
        place: async (request) => {
          try {
            return await runPlaceOnce(request)
          } catch (error) {
            const code = error instanceof Error ? error.message : ''
            const pool = activePool()
            if (code === 'REMOTE_LANE_STOP_UNPROVEN') await reconcileRemoteChat(pool, request.uid, request.sessionKey)
            else if (
              code !== 'REMOTE_LANE_CAPACITY_EXHAUSTED' ||
              !(await reconcileStaleContainerLanes(pool, request.uid, request.dockerId))
            )
              throw error
            return runPlaceOnce(request)
          }
        },
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
    if (fixture.rejected) fixture.rejected(error)
    else console.error('[selfhost] remote lane runtime unavailable', {
      error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** A remote-pool model turn gets its chat's lane; a local model gets none. Never a fallback. */
export async function selectMasterCc5Backend(
  runtime: RemoteLaneRuntimePort | undefined,
  input: { uid: number; containerId: number; sessionKey: string; canonicalModel: string;
    engine: string; placement: 'local' | 'remote_pool' },
  selfhost: boolean,
  env: Cc5PolicyEnvironment,
): Promise<RemoteExecutionBackend | undefined> {
  if (input.placement !== 'remote_pool') return undefined
  if (!selfhost || !runtime || !['ccb','codex'].includes(input.engine) || !canUseCc5TestModel(String(input.uid), env)) {
    throw new Error('REMOTE_LANE_UNAVAILABLE')
  }
  const backend = await runtime.ensureLane({ uid: input.uid, containerDbId: String(input.containerId),
    sessionKey: input.sessionKey, canonicalModel: input.canonicalModel,
    ...(input.engine === 'codex' ? { engine: 'codex' as const } : {}) })
  if (!isRemoteBackendAuthority({ engine: input.engine, canonicalModel: input.canonicalModel, executionBackend: backend })) throw new Error('REMOTE_LANE_UNAVAILABLE')
  return backend
}
