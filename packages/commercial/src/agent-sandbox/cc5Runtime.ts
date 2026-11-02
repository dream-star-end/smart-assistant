/** Personal task metadata only. No credentials are read, and OFF performs no configuration I/O. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createCc5FreshContainerRuntime } from '@openclaude/gateway/cc5-container-runtime'
import {
  CC5_TEST_UID_ENV,
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
      Object.keys(data).sort().join(',') === 'profile,task,taskRoot,testUid,user,version' &&
      data.version === 1 &&
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
  return {
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
  },
  fixture: { read?: typeof readDeployment; rejected?: () => void } = {},
) {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !input.authorityReady || !canUseCc5TestModel(uid, input.env))
    return undefined
  try {
    return createCc5FreshContainerRuntime({
      selfhost: true,
      env: input.env,
      configuration: () => (fixture.read ?? readDeployment)(uid!),
    })
  } catch {
    if (fixture.rejected) fixture.rejected()
    else
      console.error('[selfhost] cc5 task metadata rejected; test provisioning remains unavailable')
    return undefined
  }
}
