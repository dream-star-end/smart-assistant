/** Master wiring of the remote-pool lane runtime. OFF performs no configuration I/O. */
import { resolve } from 'node:path'
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

import { getPool } from '../db/index.js'
import { reconcileRemoteChat, reconcileStaleContainerLanes } from '../account-pool/remoteLaneRecovery.js'

const BASE_ROOT = '/run/oc-cc5-t1555u'

export function createMasterCc5Runtime(
  input: {
    selfhost: boolean
    authorityReady: boolean
    env: Cc5PolicyEnvironment
    financeFactory?: RemoteFinanceFactory
  },
  fixture: { create?: typeof createRemoteLaneRuntime; rejected?: (error: unknown) => void } = {},
): RemoteLaneRuntimePort | undefined {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !input.authorityReady || !input.financeFactory || !canUseCc5TestModel(uid, input.env))
    return undefined
  const controllerPath = resolve('scripts/agent-remote/cc5-host-controller.py')
  try {
    return (fixture.create ?? createRemoteLaneRuntime)({
      selfhost: true,
      env: input.env,
      financeFactory: input.financeFactory,
      configuration: () => ({ baseRoot: BASE_ROOT, controllerPath, evidenceRoot: '/var/lib/openclaude/remote-native' }),
      hooks: {
        place: async (request) => {
          try { return await placeRemoteLane(request, { controllerPath }) }
          catch (error) {
            const code = error instanceof Error ? error.message : ''
            if (code === 'REMOTE_LANE_STOP_UNPROVEN') await reconcileRemoteChat(getPool(),request.uid,request.sessionKey)
            else if (code !== 'REMOTE_LANE_CAPACITY_EXHAUSTED' ||
              !await reconcileStaleContainerLanes(getPool(),request.uid,request.dockerId)) throw error
            return placeRemoteLane(request,{controllerPath})
          }
        },
        onState: (operationId, state, generation) => recordRemoteLaneState(operationId,state,undefined,generation),
        onRemoteStart: (operationId,generation) => recordRemoteStartAttempt(operationId,generation),
        onNativeThread: (operationId,generation,id) => recordRemoteNativeThread(operationId,generation,id),
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
