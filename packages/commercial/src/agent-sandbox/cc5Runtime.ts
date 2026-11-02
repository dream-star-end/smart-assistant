/** Personal task metadata only. No credentials are read, and OFF performs no configuration I/O. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Cc5FinanceFactory } from '@openclaude/gateway/cc5-finance'
import { createCc5FreshContainerRuntime } from '@openclaude/gateway/cc5-container-runtime'
import {
  CC5_TEST_UID_ENV,
  CC5_INTERACTIVE_BACKEND,
  CC5_NATIVE_MODEL,
  parseCc5ExecutionBackend,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
} from '@openclaude/protocol'

const DEPLOYMENT = '/opt/openclaude/cc5-t1555u/deployment.json'
const KEY_DIRECTORY =
  '/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-agentremote-cc5-web-t1555u/.task-tmp/cc5-ssh'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function requireConfig(ok: unknown): asserts ok {
  if (!ok) throw new Error('CC5_DEPLOYMENT_METADATA_REJECTED')
}
export function parseCc5DeploymentMetadata(bytes: Buffer, expectedUid: string) {
  requireConfig(bytes.length > 0 && bytes.length <= 16384)
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  requireConfig(
    data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.keys(data).sort().join(',') === 'profile,scope,task,taskRoot,testUid,user,version' &&
      data.version === 2 &&
      data.task === 'AGENT-REMOTE-T1555U' &&
      data.testUid === expectedUid &&
      typeof data.user === 'string' &&
      /^[a-z_][a-z0-9_-]{0,31}$/.test(data.user) &&
      data.user !== 'root' &&
      typeof data.taskRoot === 'string' &&
      data.taskRoot.startsWith(`/home/${data.user}/`) &&
      /^\/home\/[a-z_][a-z0-9_-]{0,31}\/oc-agentremote-t1555u-[a-z0-9-]{16,40}$/.test(
        data.taskRoot,
      ) &&
      data.profile &&
      Object.keys(data.profile).sort().join(',') === 'operationId,runId' &&
      typeof data.profile.operationId === 'string' &&
      UUID.test(data.profile.operationId) &&
      typeof data.profile.runId === 'string' &&
      UUID.test(data.profile.runId),
  )
  requireConfig(data.scope && typeof data.scope === 'object' && !Array.isArray(data.scope) &&
    Object.keys(data.scope).sort().join(',') === 'canonicalModel,sessionKey' &&
    data.scope.canonicalModel === CC5_NATIVE_MODEL)
  const backend = parseCc5ExecutionBackend({ kind: CC5_INTERACTIVE_BACKEND,
    sessionKey: data.scope.sessionKey, operationId: data.profile.operationId })
  return {
    scope: Object.freeze({ canonicalModel: CC5_NATIVE_MODEL, sessionKey: backend.sessionKey }),
    baseRoot: '/run/oc-cc5-t1555u',
    profile: Object.freeze({
      operationId: data.profile.operationId as string,
      runId: data.profile.runId as string,
    }),
    ssh: Object.freeze({
      user: data.user as string,
      taskRoot: data.taskRoot as string,
      privateKeyPath: `${KEY_DIRECTORY}/id_ed25519`,
      knownHostsPath: `${KEY_DIRECTORY}/known_hosts`,
      controllerPath: resolve('scripts/agent-remote/cc5-host-controller.py'),
    }),
  }
}
function readDeployment(expectedUid: string) {
  const dir = lstatSync(dirname(DEPLOYMENT))
  requireConfig(dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o077) === 0)
  const fd = openSync(DEPLOYMENT, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    const link = lstatSync(DEPLOYMENT)
    requireConfig(
      st.isFile() &&
        st.uid === 0 &&
        st.nlink === 1 &&
        (st.mode & 0o777) === 0o600 &&
        st.size > 0 &&
        st.size <= 16384 &&
        !link.isSymbolicLink() &&
        st.ino === link.ino &&
        st.dev === link.dev,
    )
    return parseCc5DeploymentMetadata(readFileSync(fd), expectedUid)
  } finally {
    closeSync(fd)
  }
}
export function createMasterCc5Runtime(
  input: {
    selfhost: boolean
    authorityReady: boolean
    env: Cc5PolicyEnvironment
    financeFactory?: Cc5FinanceFactory
  },
  fixture: { read?: typeof readDeployment; rejected?: () => void } = {},
) {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !input.authorityReady || !input.financeFactory || !canUseCc5TestModel(uid, input.env))
    return undefined
  try {
    return createCc5FreshContainerRuntime({
      selfhost: true,
      env: input.env,
      financeFactory: input.financeFactory,
      configuration: () => (fixture.read ?? readDeployment)(uid!),
    })
  } catch {
    if (fixture.rejected) fixture.rejected()
    else
      console.error('[selfhost] cc5 task metadata rejected; test provisioning remains unavailable')
    return undefined
  }
}

/** Enabled but incomplete setup must never silently fall back to the ordinary Box worker. */
export function selectMasterCc5Backend(
  runtime: ReturnType<typeof createMasterCc5Runtime>,
  input: Parameters<NonNullable<ReturnType<typeof createMasterCc5Runtime>>['selectBackend']>[0],
  selfhost: boolean,
  env: Cc5PolicyEnvironment,
) {
  if (!selfhost || !canUseCc5TestModel(String(input.uid), env)) return undefined
  if (!runtime) throw new Error('CC5_FRESH_CONTAINER_BINDING_REJECTED')
  return runtime.selectBackend(input)
}
