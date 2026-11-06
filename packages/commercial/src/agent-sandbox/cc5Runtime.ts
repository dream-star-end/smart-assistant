/** Master wiring of the remote-pool lane runtime. OFF performs no configuration I/O. */
import { resolve } from 'node:path'
import type { Cc5FinanceFactory } from '@openclaude/gateway/cc5-finance'
import {
  createRemoteLaneRuntime,
  type RemoteLaneRuntimePort,
} from '@openclaude/gateway/cc5-container-runtime'
import {
  CC5_TEST_UID_ENV,
  type Cc5ExecutionBackend,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
} from '@openclaude/protocol'
import { placeRemoteLane, recordRemoteLaneState } from '../account-pool/remoteBrainPool.js'

const BASE_ROOT = '/run/oc-cc5-t1555u'

export function createMasterCc5Runtime(
  input: {
    selfhost: boolean
    authorityReady: boolean
    env: Cc5PolicyEnvironment
    financeFactory?: Cc5FinanceFactory
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
      configuration: () => ({ baseRoot: BASE_ROOT, controllerPath }),
      hooks: {
        place: (request) => placeRemoteLane(request, { controllerPath }),
        onState: (operationId, state) => {
          void recordRemoteLaneState(operationId, state).catch((error: unknown) => {
            console.error('[selfhost] remote lane state not recorded', { operationId, state,
              error: error instanceof Error ? error.message : String(error) })
          })
        },
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
): Promise<Cc5ExecutionBackend | undefined> {
  if (input.placement !== 'remote_pool') return undefined
  if (!selfhost || !runtime || input.engine !== 'ccb' || !canUseCc5TestModel(String(input.uid), env)) {
    throw new Error('REMOTE_LANE_UNAVAILABLE')
  }
  return runtime.ensureLane({ uid: input.uid, containerDbId: String(input.containerId),
    sessionKey: input.sessionKey, canonicalModel: input.canonicalModel })
}
