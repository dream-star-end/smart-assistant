/** Privileged v5-dev factory for one fresh container / operation / admission / tool call. */
import { randomBytes } from 'node:crypto'
import {
  constants,
  chmodSync,
  chownSync,
  closeSync,
  fchmodSync,
  fchownSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Server } from 'node:http'
import { dirname, isAbsolute, join } from 'node:path'
import {
  type AuthorityKeyring,
  type Cc5ExecutionBackend,
  CC5_INTERACTIVE_BACKEND,
  CC5_TEST_UID_ENV,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
  isCc5CanonicalModel,
  parseAuthorityKeyring,
  parseCc5ExecutionBackend,
} from '@openclaude/protocol'
import type { Cc5FinanceFactory, Cc5FinancePort } from './cc5Finance.js'
import {
  CC5_BINDING_SLIDING_TTL_MS,
  type Cc5BridgeBinding,
  assertCc5BindingScope,
} from './cc5BridgePort.js'
import { type Cc5InteractiveHostPort, Cc5Relay } from './cc5Relay.js'
import { Cc5SshHost, type Cc5SshHostConfig } from './cc5SshHost.js'

export { cc5ControlRequest, type Cc5BridgeBinding } from './cc5BridgePort.js'
export { defaultRemoteCcTarget, type RemoteCcTarget } from './cc5SshHost.js'

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
function overwriteProtectedBinding(mountSource: string, binding: Readonly<Cc5BridgeBinding>): void {
  const tmpPath = join(mountSource, 'binding.json.tmp')
  const finalPath = join(mountSource, 'binding.json')
  try {
    rmSync(tmpPath, { force: true })
  } catch {}
  const fd = openSync(
    tmpPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o640,
  )
  try {
    fchownSync(fd, 0, 1000)
    fchmodSync(fd, 0o640)
    writeFileSync(fd, JSON.stringify(binding))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
  syncDirectory(mountSource)
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
  scope: Readonly<{ sessionKey: string; canonicalModel: string }>
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
    requireRuntime(isCc5CanonicalModel(options.scope?.canonicalModel))
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
    if (!existsSync(options.baseRoot)) {
      mkdirSync(options.baseRoot, { mode: 0o700, recursive: false })
    }
    const st = lstatSync(options.baseRoot)
    requireRuntime(
      st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o777) === 0o700,
    )
    for (const entry of readdirSync(options.baseRoot)) {
      const childPath = join(options.baseRoot, entry)
      const childSt = lstatSync(childPath)
      requireRuntime(
        /^[a-f0-9]{24}$/.test(entry) &&
          childSt.isDirectory() &&
          !childSt.isSymbolicLink() &&
          childSt.uid === 0 &&
          (childSt.mode & 0o777) === 0o700 &&
          !existsSync(join(childPath, 'UNKNOWN.json')),
      )
      const mountSource = join(childPath, 'view')
      const bindingPath = join(mountSource, 'binding.json')
      const authorityPath = join(mountSource, 'authority-public.json')
      if (existsSync(join(childPath, 'released.json'))) {
        try {
          const prep = JSON.parse(readFileSync(join(childPath, 'prepared.json'), 'utf8')) as {
            containerDbId?: string
            runId?: string
            operationId?: string
          }
          const rel = JSON.parse(readFileSync(join(childPath, 'released.json'), 'utf8')) as {
            remoteStopped?: boolean
          }
          requireRuntime(
            rel?.remoteStopped === true &&
              typeof prep?.containerDbId === 'string' &&
              /^[1-9][0-9]{0,18}$/.test(prep.containerDbId),
          )
          const handle = Object.freeze({ mountSource, containerDbId: prep.containerDbId })
          const releasedRecord: RecordState = {
            handle,
            root: childPath,
            keyring: new Map(),
            runId: String(prep.runId ?? options.profile.runId),
            operationId: String(prep.operationId ?? options.profile.operationId),
            capability: '',
            state: 'released',
          }
          this.records.set(prep.containerDbId, releasedRecord)
          this.handles.set(handle, releasedRecord)
        } catch {
          this.blocked = true
          requireRuntime(false)
        }
      } else if (
        existsSync(join(childPath, 'prepared.json')) &&
        existsSync(join(childPath, 'activated.json')) &&
        existsSync(bindingPath) &&
        existsSync(authorityPath)
      ) {
        let createdRelay: Cc5Relay | undefined
        try {
          const binding = Object.freeze(
            JSON.parse(readFileSync(bindingPath, 'utf8')) as Cc5BridgeBinding,
          )
          assertCc5BindingScope(binding)
          const pub = JSON.parse(readFileSync(authorityPath, 'utf8')) as {
            version?: number
            keyring?: string
          }
          const act = JSON.parse(readFileSync(join(childPath, 'activated.json'), 'utf8')) as {
            version?: number
            dockerId?: string
          }
          requireRuntime(
            pub?.version === 1 &&
              typeof pub.keyring === 'string' &&
              act?.version === 1 &&
              act.dockerId === binding.dockerId &&
              binding.uid === this.testUid &&
              binding.sessionKey === options.scope.sessionKey &&
              binding.canonicalModel === options.scope.canonicalModel &&
              binding.operationId === options.profile.operationId &&
              binding.runId === options.profile.runId &&
              binding.expiresAt > Date.now(),
          )
          const keyring = parseAuthorityKeyring(pub.keyring)
          const finance = this.financeFactory(binding)
          requireRuntime(keyring.size > 0 && finance)
          const handle = Object.freeze({ mountSource, containerDbId: binding.containerDbId })
          const toolSocketPath = join(childPath, 'tool.sock')
          const controlSocketPath = join(mountSource, 'relay.sock')
          const host = (this.options.hostFactory ?? ((config) => new Cc5SshHost(config)))({
            ...this.options.ssh,
            operationId: binding.operationId,
            runId: binding.runId,
            toolSocketPath,
          })
          const recovered: RecordState = {
            handle,
            root: childPath,
            keyring,
            runId: binding.runId,
            operationId: binding.operationId,
            capability: binding.capability,
            binding,
            finance,
            state: 'activating',
          }
          const relay = new Cc5Relay(
            binding,
            keyring,
            binding.runId,
            host,
            join(childPath, 'journal'),
            finance,
            {
              slidingTtlMs: CC5_BINDING_SLIDING_TTL_MS,
              recoverExistingJournal: true,
              onBindingExtended: (expiresAt: number) => {
                requireRuntime(
                  recovered.binding &&
                    recovered.state !== 'released' &&
                    recovered.state !== 'unknown',
                )
                const nextBinding = Object.freeze({ ...recovered.binding, expiresAt })
                overwriteProtectedBinding(handle.mountSource, nextBinding)
                recovered.binding = nextBinding
              },
            },
          )
          createdRelay = relay
          recovered.relay = relay
          this.listenSync(relay.toolServer, toolSocketPath, 0, 0)
          this.listenSync(relay.controlServer, controlSocketPath, 1000, 1000)
          relay.attachRecoveredHost()
          recovered.state = 'active'
          this.records.set(binding.containerDbId, recovered)
          this.handles.set(handle, recovered)
        } catch {
          if (createdRelay) {
            for (const server of [createdRelay.controlServer, createdRelay.toolServer]) {
              try {
                server.closeAllConnections()
                server.close()
              } catch {}
            }
          }
          this.blocked = true
          try {
            if (!existsSync(join(childPath, 'UNKNOWN.json'))) {
              writePrivate(join(childPath, 'UNKNOWN.json'), {
                version: 1,
                reason: 'recovery-unproved',
              })
            }
          } catch {}
          requireRuntime(false)
        }
      } else {
        this.blocked = true
        try {
          if (!existsSync(join(childPath, 'UNKNOWN.json'))) {
            writePrivate(join(childPath, 'UNKNOWN.json'), {
              version: 1,
              reason: 'incomplete-state-unproved',
            })
          }
        } catch {}
        requireRuntime(false)
      }
    }
    syncDirectory(dirname(options.baseRoot))
  }
  selectBackend(input: { uid: number; containerId: number; sessionKey: string;
    canonicalModel: string; engine: string }): Cc5ExecutionBackend | undefined {
    if (String(input.uid) !== this.testUid || input.sessionKey !== this.options.scope.sessionKey)
      return undefined
    requireRuntime(input.canonicalModel === this.options.scope.canonicalModel && input.engine === 'ccb')
    const record = this.records.get(String(input.containerId))
    requireRuntime(!this.blocked && record?.state === 'active' && record.binding &&
      record.binding.expiresAt > Date.now() && record.finance && record.relay)
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
    for (const prior of this.records.values()) {
      if (prior.release) await prior.release.catch(() => {})
    }
    requireRuntime(
      input.local &&
        !this.blocked &&
        /^[1-9][0-9]{0,18}$/.test(input.containerDbId) &&
        !this.records.has(input.containerDbId) &&
        [...this.records.values()].every((r) => r.state === 'released'),
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
      expiresAt: Date.now() + CC5_BINDING_SLIDING_TTL_MS,
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
        {
          slidingTtlMs: CC5_BINDING_SLIDING_TTL_MS,
          onBindingExtended: (expiresAt: number) => {
            requireRuntime(
              record.binding && record.state !== 'released' && record.state !== 'unknown',
            )
            const nextBinding = Object.freeze({ ...record.binding, expiresAt })
            overwriteProtectedBinding(handle.mountSource, nextBinding)
            record.binding = nextBinding
          },
        },
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
  private listenSync(server: Server, path: string, uid: number, gid: number): void {
    if (existsSync(path)) {
      const existing = lstatSync(path)
      requireRuntime(existing.isSocket() && !existing.isSymbolicLink())
      rmSync(path, { force: false })
    }
    server.listen(path)
    const socket = lstatSync(path)
    requireRuntime(socket.isSocket() && socket.uid === 0 && socket.nlink === 1)
    chmodSync(path, 0o600)
    chownSync(path, uid, gid)
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
    const priorState = record.state
    // Revoke synchronously before waiting for remote proof. Never auto reset an unknown operation.
    record.state = 'released'
    const stopped = record.relay
      ? record.relay.stop()
      : priorState === 'prepared' || priorState === 'bound'
        ? Promise.resolve({ remoteStopped: true as const })
        : Promise.reject(new Error(REJECTED))
    record.release = (async () => {
      let proven = true
      try {
        const res = await stopped
        requireRuntime(res?.remoteStopped === true)
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
        if (!existsSync(join(record.root, 'UNKNOWN.json'))) {
          writePrivate(join(record.root, 'UNKNOWN.json'), {
            version: 1,
            reason: 'remote-exit-unproved',
          })
        }
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
