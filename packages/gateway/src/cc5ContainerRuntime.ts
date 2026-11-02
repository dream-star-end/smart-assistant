/** Privileged v5-dev factory for one fresh container / operation / admission / tool call. */
import { randomBytes } from 'node:crypto'
import {
  constants,
  chmodSync,
  chownSync,
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Server } from 'node:http'
import { dirname, isAbsolute, join } from 'node:path'
import {
  type AuthorityKeyring,
  type Cc5ExecutionBackend,
  CC5_INTERACTIVE_BACKEND,
  CC5_NATIVE_MODEL,
  CC5_TEST_UID_ENV,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
  parseAuthorityKeyring,
  parseCc5ExecutionBackend,
} from '@openclaude/protocol'
import type { Cc5FinanceFactory, Cc5FinancePort } from './cc5Finance.js'
import type { Cc5BridgeBinding } from './cc5BridgePort.js'
import { type Cc5InteractiveHostPort, Cc5Relay } from './cc5Relay.js'
import { Cc5SshHost, type Cc5SshHostConfig } from './cc5SshHost.js'

export { cc5ControlRequest, type Cc5BridgeBinding } from './cc5BridgePort.js'

const REJECTED = 'CC5_FRESH_CONTAINER_BINDING_REJECTED'
export const CC5_CONTAINER_MOUNT = '/run/oc/cc5-remote-t1555u'
function requireRuntime(ok: unknown): asserts ok {
  if (!ok) throw new Error(REJECTED)
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function writePrivate(path: string, value: unknown, groupReadable = false): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    groupReadable ? 0o640 : 0o600,
  )
  try {
    if (groupReadable) fchownSync(fd, 0, 1000)
    fchmodSync(fd, groupReadable ? 0o640 : 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dirname(path))
}
export interface Cc5PreparedContainer {
  readonly mountSource: string
  readonly containerDbId: string
}
export interface Cc5FreshContainerRuntimePort {
  selectBackend(input: { uid: number; containerId: number; sessionKey: string;
    canonicalModel: string; engine: string }): Cc5ExecutionBackend | undefined
  prepare(input: {
    uid: number
    containerDbId: string
    local: boolean
    publicKeyring: string
  }): Promise<Cc5PreparedContainer | null>
  bindCreated(handle: Cc5PreparedContainer, dockerId: string): Promise<void>
  /** Caller MUST invoke only after the guarded Tx2 UPDATE has committed successfully. */
  activate(handle: Cc5PreparedContainer, dockerId: string): Promise<void>
  release(containerDbId: string, dockerId?: string): Promise<void>
}
type SshDeployment = Omit<Cc5SshHostConfig, 'operationId' | 'runId' | 'toolSocketPath'>
interface RuntimeOptions {
  baseRoot: string
  ssh: Readonly<SshDeployment>
  /** IDs of this exact preinstalled strict MCP profile; one binding consumes it once. */
  profile: Readonly<{ operationId: string; runId: string }>
  scope: Readonly<{ sessionKey: string; canonicalModel: typeof CC5_NATIVE_MODEL }>
  /** Trusted fixture seam only; default constructs the pinned production SSH port. */
  hostFactory?: (config: Cc5SshHostConfig) => Cc5InteractiveHostPort
}
interface RecordState {
  handle: Cc5PreparedContainer
  root: string
  runId: string
  operationId: string
  capability: string
  keyring: AuthorityKeyring
  binding?: Readonly<Cc5BridgeBinding>
  relay?: Cc5Relay
  finance?: Cc5FinancePort
  state: 'prepared' | 'bound' | 'activating' | 'active' | 'released' | 'unknown'
  release?: Promise<void>
  activation?: Promise<void>
}

/** OFF/nonselfhost returns before reading configuration, SSH metadata or creating any files. */
export function createCc5FreshContainerRuntime(input: {
  selfhost: boolean
  env: Cc5PolicyEnvironment
  configuration: () => RuntimeOptions
  financeFactory: Cc5FinanceFactory
}): Cc5FreshContainerRuntimePort | undefined {
  const testUid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !canUseCc5TestModel(testUid, input.env)) return undefined
  return new Cc5FreshContainerRuntime(testUid!, input.configuration(), input.financeFactory)
}

class Cc5FreshContainerRuntime implements Cc5FreshContainerRuntimePort {
  private readonly records = new Map<string, RecordState>()
  private readonly handles = new WeakMap<Cc5PreparedContainer, RecordState>()
  private blocked = false
  constructor(
    private readonly testUid: string,
    private readonly options: RuntimeOptions,
    private readonly financeFactory: Cc5FinanceFactory,
  ) {
    requireRuntime(typeof financeFactory === 'function')
    requireRuntime(options.scope?.canonicalModel === CC5_NATIVE_MODEL)
    parseCc5ExecutionBackend({ kind: CC5_INTERACTIVE_BACKEND, sessionKey: options.scope.sessionKey,
      operationId: options.profile.operationId })
    requireRuntime(
      process.getuid?.() === 0 &&
        isAbsolute(options.baseRoot) &&
        Buffer.byteLength(join(options.baseRoot, 'a'.repeat(24), 'tool.sock')) <= 100,
    )
    // Existing state is never silently adopted/reset after a master restart or unknown result.
    requireRuntime(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.profile.operationId) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.profile.runId),
    )
    mkdirSync(options.baseRoot, { mode: 0o700, recursive: false })
    const st = lstatSync(options.baseRoot)
    requireRuntime(st.isDirectory() && st.uid === 0 && (st.mode & 0o777) === 0o700)
    syncDirectory(dirname(options.baseRoot))
  }
  selectBackend(input: { uid: number; containerId: number; sessionKey: string;
    canonicalModel: string; engine: string }): Cc5ExecutionBackend | undefined {
    if (String(input.uid) !== this.testUid || input.sessionKey !== this.options.scope.sessionKey)
      return undefined
    requireRuntime(input.canonicalModel === this.options.scope.canonicalModel && input.engine === 'ccb')
    const record = this.records.get(String(input.containerId))
    requireRuntime(!this.blocked && record?.state === 'active' && record.binding &&
      record.binding.expiresAt > Date.now() && record.finance)
    return Object.freeze({ kind: CC5_INTERACTIVE_BACKEND, sessionKey: record.binding.sessionKey,
      operationId: record.binding.operationId })
  }
  async prepare(input: {
    uid: number
    containerDbId: string
    local: boolean
    publicKeyring: string
  }): Promise<Cc5PreparedContainer | null> {
    if (!Number.isSafeInteger(input.uid) || String(input.uid) !== this.testUid) return null
    requireRuntime(
      input.local &&
        !this.blocked &&
        /^[1-9][0-9]{0,18}$/.test(input.containerDbId) &&
        this.records.size === 0,
    )
    const keyring = parseAuthorityKeyring(input.publicKeyring)
    requireRuntime(keyring.size > 0)
    const root = join(this.options.baseRoot, randomBytes(12).toString('hex'))
    mkdirSync(root, { mode: 0o700 })
    syncDirectory(this.options.baseRoot)
    const mountSource = join(root, 'view')
    mkdirSync(mountSource, { mode: 0o750 })
    chownSync(mountSource, 0, 1000)
    chmodSync(mountSource, 0o750)
    syncDirectory(mountSource)
    const handle = Object.freeze({ mountSource, containerDbId: input.containerDbId })
    const record: RecordState = {
      handle,
      root,
      keyring,
      runId: this.options.profile.runId,
      operationId: this.options.profile.operationId,
      capability: randomBytes(32).toString('hex'),
      state: 'prepared',
    }
    // Retain a fence even if publication fails; a retry cannot reset this operation.
    this.records.set(input.containerDbId, record)
    this.handles.set(handle, record)
    writePrivate(join(root, 'prepared.json'), {
      version: 2,
      backendKind: CC5_INTERACTIVE_BACKEND,
      canonicalModel: this.options.scope.canonicalModel,
      sessionKey: this.options.scope.sessionKey,
      uid: this.testUid,
      containerDbId: input.containerDbId,
      runId: record.runId,
      operationId: record.operationId,
    })
    writePrivate(
      join(mountSource, 'authority-public.json'),
      { version: 1, keyring: input.publicKeyring },
      true,
    )
    return handle
  }
  private record(handle: Cc5PreparedContainer): RecordState {
    const record = this.handles.get(handle)
    requireRuntime(record && this.records.get(handle.containerDbId) === record)
    return record
  }
  async bindCreated(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
    const record = this.record(handle)
    requireRuntime(record.state === 'prepared' && /^[a-f0-9]{64}$/.test(dockerId))
    record.binding = Object.freeze({
      version: 2,
      backendKind: CC5_INTERACTIVE_BACKEND,
      canonicalModel: this.options.scope.canonicalModel,
      sessionKey: this.options.scope.sessionKey,
      runId: record.runId,
      uid: this.testUid,
      containerDbId: handle.containerDbId,
      dockerId,
      operationId: record.operationId,
      capability: record.capability,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
    })
    record.finance = this.financeFactory(record.binding)
    requireRuntime(record.finance)
    writePrivate(join(handle.mountSource, 'binding.json'), record.binding, true)
    record.state = 'bound'
  }
  activate(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
    const record = this.record(handle)
    requireRuntime(
      record.state === 'bound' && record.binding?.dockerId === dockerId && !this.blocked,
    )
    record.state = 'activating'
    record.activation = (async () => {
      const finance = record.finance
      requireRuntime(finance)
      const toolSocketPath = join(record.root, 'tool.sock')
      const host = (this.options.hostFactory ?? ((config) => new Cc5SshHost(config)))({
        ...this.options.ssh,
        operationId: record.operationId,
        runId: record.runId,
        toolSocketPath,
      })
      record.relay = new Cc5Relay(
        record.binding!,
        record.keyring,
        record.runId,
        host,
        join(record.root, 'journal'),
        finance,
      )
      await this.listen(record.relay.toolServer, toolSocketPath, 0, 0)
      requireRuntime(record.state === 'activating' && !this.blocked)
      await this.listen(
        record.relay.controlServer,
        join(handle.mountSource, 'relay.sock'),
        1000,
        1000,
      )
      requireRuntime(record.state === 'activating' && !this.blocked)
      record.state = 'active'
      writePrivate(join(record.root, 'activated.json'), { version: 1, dockerId })
    })().catch(() => {
      throw new Error(REJECTED)
    })
    // The provisioning caller must release this handle on any activation failure.
    return record.activation
  }
  private async listen(server: Server, path: string, uid: number, gid: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const error = (): void => reject(new Error(REJECTED))
      server.once('error', error)
      server.listen(path, () => {
        server.removeListener('error', error)
        try {
          const socket = lstatSync(path)
          requireRuntime(socket.isSocket() && socket.uid === 0 && socket.nlink === 1)
          chmodSync(path, 0o600)
          chownSync(path, uid, gid) // Only this newly-created socket; never the directory/files.
          resolve()
        } catch {
          reject(new Error(REJECTED))
        }
      })
    })
  }
  release(containerDbId: string, dockerId?: string): Promise<void> {
    const record = this.records.get(containerDbId)
    if (!record) return Promise.resolve()
    requireRuntime(!dockerId || !record.binding || record.binding.dockerId === dockerId)
    if (record.release) return record.release
    // Revoke synchronously before waiting for remote proof. Never auto reset an unknown operation.
    record.state = 'released'
    const stopped = record.relay?.stop()
    record.release = (async () => {
      let proven = true
      try {
        await stopped
      } catch {
        proven = false
        record.state = 'unknown'
        this.blocked = true
      }
      await record.activation?.catch(() => {})
      for (const server of [record.relay?.controlServer, record.relay?.toolServer]) {
        if (!server) continue
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      if (!proven) {
        writePrivate(join(record.root, 'UNKNOWN.json'), {
          version: 1,
          reason: 'remote-exit-unproved',
        })
        throw new Error(REJECTED)
      }
      // Retain private identity/fence journal; only the now-inaccessible container view is removed.
      rmSync(record.handle.mountSource, { recursive: true, force: false })
      syncDirectory(record.root)
      writePrivate(join(record.root, 'released.json'), { version: 1, remoteStopped: true })
    })()
    return record.release
  }
}
