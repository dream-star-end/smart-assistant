import { memoryRejection, nodeMemoryError } from './remoteNodeMemory.js'
/**
 * Privileged master runtime for remote-pool chats.
 *
 * Per container the supervisor prepares one read-only view (mounted at CC5_MOUNT) holding the
 * public authority keyring. Per chat a lane is created on demand: the chat's task root on its
 * pool node is reset and provisioned, then a Cc5Relay + Cc5SshHost serve it through
 * `<view>/<operationId>/{binding.json,relay.sock}`. A master restart only loses lanes; the next
 * turn of a chat resets the node root and resumes the same native session.
 */
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
  type RemoteExecutionBackend,
  parseRemoteExecutionBackend,
  REMOTE_DRIVER_BACKEND,
  CC5_INTERACTIVE_BACKEND,
  CC5_TEST_UID_ENV,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
  isCc5CanonicalModel,
  parseAuthorityKeyring,
  parseCc5ExecutionBackend,
} from '@openclaude/protocol'
import type { RemoteFinanceFactory } from './remoteFinance.js'
import { codexBackend, type RemoteBridgeBinding, type CodexRemoteBinding, codexJsonHash } from './codexRemoteContract.js'
import { CodexSshHost, type CodexLaneSpec } from './codexRemoteHost.js'
import { CodexRemoteRelay } from './codexRemoteRelay.js'
import {
  RemotePoolRelay,
  RemotePoolSshHost,
  remotePoolBackendOf,
  type RemotePoolBinding,
  type RemotePoolFinancePort,
  type RemotePoolLaneSpec,
} from './remotePool/index.js'
export { CodexSshHost, type CodexLaneSpec } from './codexRemoteHost.js'
export { Cc5SshHost } from './cc5SshHost.js'
import { CC5_BINDING_SLIDING_TTL_MS, CC5_MOUNT, type Cc5BridgeBinding } from './cc5BridgePort.js'
import { type Cc5InteractiveHostPort, Cc5Relay } from './cc5Relay.js'
import { Cc5SshHost, type Cc5SshHostConfig, type RemoteCcTarget } from './cc5SshHost.js'

export { cc5ControlRequest, type Cc5BridgeBinding } from './cc5BridgePort.js'
export { defaultRemoteCcTarget, type RemoteCcTarget } from './cc5SshHost.js'

const REJECTED = 'CC5_FRESH_CONTAINER_BINDING_REJECTED'
export const REMOTE_LANE_UNAVAILABLE = 'REMOTE_LANE_UNAVAILABLE'
/** Node admission refused the session: not a lane fault, and the operator can free memory. */
export const REMOTE_NODE_MEMORY_EXHAUSTED = 'REMOTE_NODE_MEMORY_EXHAUSTED'
export const CC5_CONTAINER_MOUNT = CC5_MOUNT
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function requireRuntime(ok: unknown): asserts ok {
  if (!ok) throw new Error(REJECTED)
}
function requireLane(ok: unknown): asserts ok {
  if (!ok) throw new Error(REMOTE_LANE_UNAVAILABLE)
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
function overwriteProtectedBinding(laneView: string, binding: Readonly<RemoteBridgeBinding>): void {
  const tmpPath = join(laneView, 'binding.json.tmp')
  rmSync(tmpPath, { force: true })
  writePrivate(tmpPath, binding, true)
  renameSync(tmpPath, join(laneView, 'binding.json'))
  syncDirectory(laneView)
}
function readJson(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  requireRuntime(value && typeof value === 'object' && !Array.isArray(value))
  return value
}

export interface Cc5PreparedContainer {
  readonly mountSource: string
  readonly containerDbId: string
}

export interface RemoteDriverV4LanePlacement {
  readonly binding: Readonly<RemotePoolBinding>
  readonly spec: RemotePoolLaneSpec
  readonly sshTarget: Readonly<RemoteCcTarget>
}

/** Where one chat runs, decided by the master's pool scheduler for this lane. */
export interface RemoteLanePlacement {
  readonly target: Readonly<RemoteCcTarget>
  readonly taskRoot: string
  /** Stable per task root, so a chat's resume ids survive container and master restarts. */
  readonly operationId: string
  readonly runId: string
  /** The node `provision` packet (controller `package-provision` output). */
  readonly provisionPacket: Buffer
  readonly generation?: string
  readonly codex?: CodexLaneSpec
  readonly v4?: RemoteDriverV4LanePlacement
  /** The pool profile whose slot this lane holds. */
  readonly profileId?: string
}
export interface RemoteLaneRequest {
  readonly engine?: 'ccb' | 'codex'
  readonly uid: number
  readonly containerDbId: string
  readonly sessionKey: string
  readonly canonicalModel: string
}
export type RemoteLaneState = 'running' | 'released' | 'unknown'
export interface RemoteLaneHooks {
  place(request: RemoteLaneRequest & { readonly dockerId: string }): Promise<RemoteLanePlacement>
  onState?(operationId: string, state: RemoteLaneState, generation?: string, isV4?: boolean): void | Promise<void>
  onNativeThread?(operationId: string, generation: string, nativeThreadId: string, isV4?: boolean): Promise<void>
  onRemoteStart?(operationId: string, generation: string, isV4?: boolean): Promise<void>
  registerDrainRelay?(id: string, relay: { readonly idle: boolean }): () => void
}
export type RemoteLaneHost = Cc5InteractiveHostPort & { prepareTask(packet: Buffer): Promise<void> }

export interface RemoteLaneRuntimePort {
  prepare(input: {
    uid: number
    containerDbId: string
    local: boolean
    publicKeyring: string
  }): Promise<Cc5PreparedContainer | null>
  bindCreated(handle: Cc5PreparedContainer, dockerId: string): Promise<void>
  /** Caller MUST invoke only after the guarded Tx2 UPDATE has committed successfully. */
  activate(handle: Cc5PreparedContainer, dockerId: string): Promise<void>
  /** Stops every lane of the container; a lane whose remote exit is unproved is reported, not retried. */
  release(containerDbId: string, dockerId?: string): Promise<void>
  /** The chat's live lane, created on first use. Rejects with REMOTE_LANE_UNAVAILABLE. */
  ensureLane(request: RemoteLaneRequest): Promise<RemoteExecutionBackend>
  /** A deleted chat frees its idle lanes (any agent); a lane mid-turn stays reclaimable as before. */
  releaseChat(uid: number, chatId: string): Promise<void>
}

interface RuntimeOptions {
  baseRoot: string
  controllerPath: string
  evidenceRoot?: string
  /** Trusted fixture seam only; default constructs the production SSH host. */
  hostFactory?: (config: Cc5SshHostConfig) => RemoteLaneHost
}
interface Lane {
  readonly container: ContainerState
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly operationId: string
  readonly profileId?: string
  readonly dir: string
  readonly view: string
  readonly generation: string
  readonly relay: Cc5Relay | CodexRemoteRelay | RemotePoolRelay
  binding: Readonly<RemoteBridgeBinding | RemotePoolBinding>
  readonly isV4?: boolean
  unregisterDrain?: () => void
  stopping?: Promise<void>
  lastUsedAt: number
  /** Preparation may reset/provision remotely before the relay attempts a model launch. */
  preparationStop?: () => Promise<unknown>
  creationFailed?: boolean
}
interface ContainerState {
  readonly handle: Cc5PreparedContainer
  readonly root: string
  readonly keyring: AuthorityKeyring
  dockerId?: string
  state: 'prepared' | 'bound' | 'active' | 'released'
  release?: Promise<void>
}
/**
 * One owner per chat across all containers: its live lane and a serial tail. Placement, stopping
 * the previous lane (another container's, a dead one, another model's) and starting the next all
 * run on this tail, so the chat's node root is handed over strictly one lane at a time.
 */
interface ChatOwner {
  lane?: Lane
  tail: Promise<unknown>
}

/** OFF/nonselfhost returns before reading configuration or creating any files. */
export function createRemoteLaneRuntime(input: {
  selfhost: boolean
  env: Cc5PolicyEnvironment
  configuration: () => RuntimeOptions
  financeFactory: RemoteFinanceFactory
  hooks: RemoteLaneHooks
}): RemoteLaneRuntimePort | undefined {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !canUseCc5TestModel(uid, input.env)) return undefined
  return new RemoteLaneRuntime(uid!, input.configuration(), input.financeFactory, input.hooks)
}

class RemoteLaneRuntime implements RemoteLaneRuntimePort {
  private readonly containers = new Map<string, ContainerState>()
  private readonly handles = new WeakMap<Cc5PreparedContainer, ContainerState>()
  private readonly chats = new Map<string, ChatOwner>()
  constructor(
    private readonly uid: string,
    private readonly options: RuntimeOptions,
    private readonly financeFactory: RemoteFinanceFactory,
    private readonly hooks: RemoteLaneHooks,
  ) {
    requireRuntime(typeof financeFactory === 'function' && typeof hooks?.place === 'function')
    requireRuntime(
      process.getuid?.() === 0 &&
        isAbsolute(options.baseRoot) &&
        isAbsolute(options.controllerPath) &&
        Buffer.byteLength(join(options.baseRoot, 'a'.repeat(24), 'lanes', 'a'.repeat(36), 'tool.sock')) <= 100,
    )
    if (!existsSync(options.baseRoot)) mkdirSync(options.baseRoot, { mode: 0o700 })
    const st = lstatSync(options.baseRoot)
    requireRuntime(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o777) === 0o700)
    for (const entry of readdirSync(options.baseRoot)) this.adopt(entry)
  }

  /**
   * A container prepared by an earlier master keeps its mounted view; it is adopted with no lane.
   * Lane leftovers are dropped here — their remote side is reset by the chat's next lane.
   * Anything not recognisable is left alone and simply not served.
   */
  private adopt(entry: string): void {
    const root = join(this.options.baseRoot, entry)
    try {
      const st = lstatSync(root)
      if (!/^[a-f0-9]{24}$/.test(entry) || !st.isDirectory() || st.isSymbolicLink() || st.uid !== 0) return
      if (existsSync(join(root, 'released.json'))) return
      const prepared = readJson(join(root, 'prepared.json'))
      const activated = readJson(join(root, 'activated.json'))
      const containerDbId = String(prepared.containerDbId)
      const mountSource = join(root, 'view')
      if (String(prepared.uid) !== this.uid || !/^[1-9][0-9]{0,18}$/.test(containerDbId) ||
          typeof activated.dockerId !== 'string' || !/^[a-f0-9]{64}$/.test(activated.dockerId) ||
          this.containers.has(containerDbId) || !existsSync(mountSource)) return
      const authority = readJson(join(mountSource, 'authority-public.json'))
      const keyring = parseAuthorityKeyring(String(authority.keyring))
      if (keyring.size === 0) return
      for (const name of readdirSync(mountSource)) {
        if (name !== 'authority-public.json') rmSync(join(mountSource, name), { recursive: true, force: true })
      }
      rmSync(join(root, 'lanes'), { recursive: true, force: true })
      rmSync(join(root, 'UNKNOWN.json'), { force: true })
      const handle = Object.freeze({ mountSource, containerDbId })
      const record: ContainerState = { handle, root, keyring, dockerId: activated.dockerId, state: 'active' }
      this.containers.set(containerDbId, record)
      this.handles.set(handle, record)
    } catch {
      // Unreadable leftovers are not adopted; they never block other containers.
    }
  }

  async prepare(input: {
    uid: number
    containerDbId: string
    local: boolean
    publicKeyring: string
  }): Promise<Cc5PreparedContainer | null> {
    if (!Number.isSafeInteger(input.uid) || String(input.uid) !== this.uid) return null
    const prior = this.containers.get(input.containerDbId)
    if (prior?.release) await prior.release.catch(() => {})
    requireRuntime(
      input.local &&
        /^[1-9][0-9]{0,18}$/.test(input.containerDbId) &&
        (!prior || prior.state === 'released'),
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
    const handle = Object.freeze({ mountSource, containerDbId: input.containerDbId })
    const record: ContainerState = { handle, root, keyring, state: 'prepared' }
    this.containers.set(input.containerDbId, record)
    this.handles.set(handle, record)
    writePrivate(join(root, 'prepared.json'), { version: 3, uid: this.uid, containerDbId: input.containerDbId })
    writePrivate(join(mountSource, 'authority-public.json'), { version: 1, keyring: input.publicKeyring }, true)
    return handle
  }
  private record(handle: Cc5PreparedContainer): ContainerState {
    const record = this.handles.get(handle)
    requireRuntime(record && this.containers.get(handle.containerDbId) === record)
    return record
  }
  async bindCreated(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
    const record = this.record(handle)
    requireRuntime(record.state === 'prepared' && /^[a-f0-9]{64}$/.test(dockerId))
    record.dockerId = dockerId
    record.state = 'bound'
  }
  async activate(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
    const record = this.record(handle)
    requireRuntime(record.state === 'bound' && record.dockerId === dockerId)
    writePrivate(join(record.root, 'activated.json'), { version: 1, dockerId })
    record.state = 'active'
  }

  async ensureLane(request: RemoteLaneRequest): Promise<RemoteExecutionBackend> {
    const container = this.containers.get(request.containerDbId)
    requireLane(container?.state === 'active' && container.dockerId && String(request.uid) === this.uid &&
      isCc5CanonicalModel(request.canonicalModel))
    const owner = this.chat(request.sessionKey)
    const live = (lane: Lane | undefined): lane is Lane => !!lane && lane.container === container &&
      !lane.creationFailed && !lane.stopping && !lane.relay.stopped && lane.canonicalModel === request.canonicalModel &&
      lane.binding.expiresAt > Date.now() &&
      (lane.binding.version === 4
        ? lane.binding.authorityEngine === (request.engine === 'codex' ? 'codex' : 'ccb')
        : (request.engine === 'codex') === (lane.binding.backendKind === 'codex-app-server-v1'))
    // A resident lane answers without waiting; anything else is decided on the chat's tail.
    let lane = owner.lane
    if (!live(lane)) {
      lane = await this.serial(owner, async () => {
        if (live(owner.lane)) return owner.lane
        try {
          // A request whose container was released while it queued must not touch the chat's lane.
          requireLane(container.state === 'active' && container.dockerId)
          if (owner.lane) {
            const old = owner.lane
            await this.stopLane(old)
            owner.lane = undefined // Only a proven stop permits replacement.
            // // Another container's, a dead one, or another model's.
          }
          requireLane(container.state === 'active' && container.dockerId)
          const placement = await this.place(request, container.dockerId)
          requireLane(UUID.test(placement.operationId) && UUID.test(placement.runId) &&
            placement.target.upstreamModel.length > 0)
          const next = await this.startLane(container, request, placement)
          if (container.state !== 'active') {
            await this.stopLane(next) // Released while the node was being prepared.
            requireLane(false)
          }
          try { await this.hooks.onState?.(next.operationId, 'running', next.generation, next.isV4) }
          catch (error) {
            try { await this.stopLane(next) } catch { owner.lane = next } // retain only a fenced lane for proof retry
            throw error
          }
          owner.lane = next
          return next
        } catch (error) {
          // Node memory admission & explicit R1 drain / drift reverify are actionable causes.
          if (error instanceof Error &&
            (error.message === REMOTE_LANE_UNAVAILABLE ||
              error.message === 'REMOTE_POOL_DRAINING_RETRY_LATER' ||
              error.message === 'REMOTE_DRIVER_REVERIFY_REQUIRED' ||
              memoryRejection(error) !== undefined)) throw error
          throw new Error(REMOTE_LANE_UNAVAILABLE, { cause: error })
        }
      })
    }
    lane.lastUsedAt = Date.now()
    if (lane.binding.version === 4) return remotePoolBackendOf(lane.binding)
    if (lane.binding.version === 3) return codexBackend(lane.binding)
    return parseCc5ExecutionBackend({ kind: CC5_INTERACTIVE_BACKEND, sessionKey: lane.sessionKey,
      operationId: lane.operationId })
  }

  /**
   * A chat keeps its lane while idle so the next turn is warm. When the pool is full, a new turn
   * takes over this user's longest-idle lane of the same engine; that chat resumes on its next turn.
   */
  private async place(request: RemoteLaneRequest, dockerId: string): Promise<RemoteLanePlacement> {
    try { return await this.hooks.place({ ...request, dockerId }) }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'REMOTE_LANE_CAPACITY_EXHAUSTED') throw error
      // Only a slot of a profile this placement could use ends the wait.
      const profiles = (error as { profiles?: unknown }).profiles
      if (!Array.isArray(profiles)) throw error
      const victim = [...this.chats.entries()]
        .filter(([key, owner]) => key !== request.sessionKey && owner.lane && !owner.lane.stopping &&
          owner.lane.relay.idle && profiles.includes(owner.lane.profileId))
        .sort(([, a], [, b]) => a.lane!.lastUsedAt - b.lane!.lastUsedAt)[0]?.[1]
      if (!victim) throw error
      const lane = victim.lane!
      await this.stopLane(lane)
      if (victim.lane === lane) victim.lane = undefined
      return this.hooks.place({ ...request, dockerId })
    }
  }

  async releaseChat(uid: number, chatId: string): Promise<void> {
    if (String(uid) !== this.uid || !chatId) return
    const suffix = `:webchat:dm:${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    const owners = [...this.chats.entries()]
      .filter(([key]) => key.startsWith('agent:') && key.endsWith(suffix) &&
        key.split(':').length === 5).map(([, owner]) => owner)
    await Promise.allSettled(owners.map(owner => this.serial(owner, async () => {
      const lane = owner.lane
      if (!lane || lane.stopping || !lane.relay.idle) return
      await this.stopLane(lane)
      if (owner.lane === lane) owner.lane = undefined
    })))
  }

  private chat(sessionKey: string): ChatOwner {
    let owner = this.chats.get(sessionKey)
    if (!owner) {
      owner = { tail: Promise.resolve() }
      this.chats.set(sessionKey, owner)
    }
    return owner
  }

  private serial<T>(owner: ChatOwner, step: () => Promise<T>): Promise<T> {
    const run = owner.tail.then(step, step)
    owner.tail = run.catch(() => {})
    return run
  }

  private async startLane(container: ContainerState, request: RemoteLaneRequest,
    placement: RemoteLanePlacement): Promise<Lane> {
    if (placement.v4) return this.startDriverV4Lane(container, request, placement)
    if (request.engine === 'codex') return this.startCodexLane(container, request, placement)
    let lane: Lane | undefined
    try {
    requireLane(!placement.codex)
    const dir = join(container.root, 'lanes', placement.operationId)
    const view = join(container.handle.mountSource, placement.operationId)
    rmSync(dir, { recursive: true, force: true })
    rmSync(view, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const toolSocketPath = join(dir, 'tool.sock')
    const hostConfig: Cc5SshHostConfig = {
      target: placement.target,
      taskRoot: placement.taskRoot,
      operationId: placement.operationId,
      runId: placement.runId,
      controllerPath: this.options.controllerPath,
      toolSocketPath,
    }
    const createHost = this.options.hostFactory ?? ((config: Cc5SshHostConfig) => new Cc5SshHost(config))
    const host = createHost(hostConfig)
    const binding: Readonly<RemoteBridgeBinding> = Object.freeze({
      version: 2,
      backendKind: CC5_INTERACTIVE_BACKEND,
      canonicalModel: request.canonicalModel,
      sessionKey: request.sessionKey,
      runId: placement.runId,
      uid: this.uid,
      containerDbId: request.containerDbId,
      dockerId: container.dockerId!,
      operationId: placement.operationId,
      capability: randomBytes(32).toString('hex'),
      expiresAt: Date.now() + CC5_BINDING_SLIDING_TTL_MS,
    })
    const finance = this.financeFactory(binding, { upstreamModel: placement.target.upstreamModel })
    requireLane(finance)
    mkdirSync(view, { mode: 0o750 })
    chownSync(view, 0, 1000)
    chmodSync(view, 0o750)
    writePrivate(join(view, 'binding.json'), binding, true)
    let current: Lane | undefined
    const relay = new Cc5Relay(binding, container.keyring, placement.runId, host, join(dir, 'journal'), finance, {
      slidingTtlMs: CC5_BINDING_SLIDING_TTL_MS,
      upstreamModel: placement.target.upstreamModel,
      onBindingExtended: (expiresAt: number) => {
        requireLane(current && !current.stopping && existsSync(view) && current.binding.version !== 4)
        const next = Object.freeze({ ...current.binding, expiresAt })
        overwriteProtectedBinding(view, next)
        current.binding = next
      },
      // A stale cached catalog replaces the remote without re-running task provisioning.
      replaceHost: () => createHost(hostConfig),
    })
    const unregisterDrain = this.hooks.registerDrainRelay?.(`${placement.operationId}:${placement.generation ?? '1'}`, relay)
    lane = current = { container, sessionKey: request.sessionKey, canonicalModel: request.canonicalModel,
      operationId: placement.operationId, profileId: placement.profileId, generation: placement.generation ?? '1', dir, view, binding, relay,
      unregisterDrain, lastUsedAt: Date.now() }
    lane.preparationStop = () => host.stop()
    await host.prepareTask(placement.provisionPacket)
    lane.preparationStop = undefined
    await this.listen(relay.toolServer, toolSocketPath, 0, 0)
      await this.listen(relay.controlServer, join(view, 'relay.sock'), 1000, 1000)
    return lane
    } catch (error) {
      if (lane) {
        lane.creationFailed = true
        try { await this.stopLane(lane) }
        catch { this.chat(request.sessionKey).lane = lane } // owner survives for proof retry
      } else {
        // No remote action is possible before the lane owns its preparation stop boundary.
        await this.hooks.onState?.(placement.operationId, 'released', placement.generation)
        rmSync(join(container.handle.mountSource, placement.operationId), { recursive: true, force: true })
      }
      throw error
    }
  }

  private async startCodexLane(container: ContainerState, request: RemoteLaneRequest, placement: RemoteLanePlacement): Promise<Lane> {
    let lane: Lane | undefined
    const view = join(container.handle.mountSource, placement.operationId)
    try {
    requireLane(placement.codex && placement.generation && this.hooks.onNativeThread && this.hooks.onRemoteStart &&
      /^[1-9][0-9]{0,15}$/.test(placement.generation))
    const spec = placement.codex
    requireLane(spec.manifest.operationId === placement.operationId && spec.manifest.runId === placement.runId &&
      spec.manifest.generation === placement.generation && request.canonicalModel === `${spec.manifest.model}-remote`)
    const dir = join(this.options.evidenceRoot ?? join(this.options.baseRoot, 'evidence'), placement.operationId, placement.generation)
    // Durable evidence is never erased by adopt/release. A repeated generation is an unknown effect, not a reset.
    requireLane(!existsSync(dir) && !existsSync(view))
    const host = new CodexSshHost(placement.target,spec)
    const preflight = await host.preflight()
    if (!preflight.memoryOk) throw nodeMemoryError(preflight.activeSessions, preflight.code)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    mkdirSync(view, { mode: 0o750 }); chownSync(view, 0, 1000); chmodSync(view, 0o750)
    const binding: CodexRemoteBinding = Object.freeze({ version:3,backendKind:'codex-app-server-v1',
      canonicalModel:request.canonicalModel,sessionKey:request.sessionKey,uid:this.uid,containerDbId:request.containerDbId,
      dockerId:container.dockerId!,operationId:placement.operationId,runId:placement.runId,generation:placement.generation,
      profileId:spec.manifest.profileId,authEpoch:spec.manifest.authEpoch,manifestSha256:codexJsonHash(JSON.stringify(spec.manifest)),
      capability:randomBytes(32).toString('hex'),expiresAt:Date.now()+CC5_BINDING_SLIDING_TTL_MS })
    const finance = this.financeFactory(binding, { upstreamModel:spec.manifest.model }); requireLane(finance)
    const relay = new CodexRemoteRelay(binding,container.keyring,host,spec,join(dir,'journal'),finance,
      id => this.hooks.onNativeThread!(placement.operationId,placement.generation!,id),
      () => this.hooks.onRemoteStart!(placement.operationId,placement.generation!))
    const unregisterDrain = this.hooks.registerDrainRelay?.(`${placement.operationId}:${placement.generation}`, relay)
    lane = { container,sessionKey:request.sessionKey,canonicalModel:request.canonicalModel,operationId:placement.operationId,
      profileId:placement.profileId,generation:placement.generation,dir,view,binding,relay,unregisterDrain,lastUsedAt:Date.now() }
    writePrivate(join(view,'binding.json'),binding,true)
    await this.listen(relay.controlServer,join(view,'relay.sock'),1000,1000)
    return lane
    } catch (error) {
      if (lane) {
        lane.creationFailed = true
        try { await this.stopLane(lane) } catch { this.chat(request.sessionKey).lane = lane }
      }
      else {
        // No endpoint/host was exposed. The persistent remote-start CAS remains false.
        rmSync(view, { recursive: true, force: true })
        try { await this.hooks.onState?.(placement.operationId, 'released', placement.generation) } catch { /* durable no-effect CAS permits recovery */ }
      }
      throw error
    }
  }

  private async startDriverV4Lane(container: ContainerState, request: RemoteLaneRequest, placement: RemoteLanePlacement): Promise<Lane> {
    let lane: Lane | undefined
    const view = join(container.handle.mountSource, placement.operationId)
    try {
      const v4 = placement.v4
      requireLane(v4 && placement.generation && this.hooks.onNativeThread && this.hooks.onRemoteStart &&
        /^[1-9][0-9]{0,15}$/.test(placement.generation))
      requireLane(v4.binding.version === 4 && v4.binding.backendKind === REMOTE_DRIVER_BACKEND &&
        v4.binding.operationId === placement.operationId && v4.binding.generation === placement.generation &&
        v4.binding.canonicalModel === request.canonicalModel && v4.binding.dockerId === container.dockerId)
      const dir = join(this.options.evidenceRoot ?? join(this.options.baseRoot, 'evidence'), placement.operationId, placement.generation)
      requireLane(!existsSync(dir) && !existsSync(view))
      const host = v4.spec.manifest.root.startsWith('/tmp/oc-drvtest-')
        ? RemotePoolSshHost.forLocalSandbox(v4.spec)
        : RemotePoolSshHost.forSshTarget(v4.sshTarget, v4.spec)
      const preflight = await host.preflight()
      if (!preflight.memoryOk) throw nodeMemoryError(preflight.activeSessions, preflight.code)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      mkdirSync(view, { mode: 0o750 }); chownSync(view, 0, 1000); chmodSync(view, 0o750)
      const rawFinance = this.financeFactory(v4.binding, { upstreamModel: v4.binding.upstreamModel })
      requireLane(rawFinance?.admitV4)
      const v4Finance: RemotePoolFinancePort = { admit: (inp) => rawFinance.admitV4!(inp) }
      const relay = new RemotePoolRelay({
        binding: v4.binding,
        keys: container.keyring,
        host,
        spec: v4.spec,
        journalDir: join(dir, 'journal'),
        finance: v4Finance,
        onNativeSession: (id) => this.hooks.onNativeThread!(placement.operationId, placement.generation!, id, true),
        onRemoteStart: () => this.hooks.onRemoteStart!(placement.operationId, placement.generation!, true),
      })
      const unregisterDrain = this.hooks.registerDrainRelay?.(`${placement.operationId}:${placement.generation}`, relay)
      lane = { container, sessionKey: request.sessionKey, canonicalModel: request.canonicalModel,
        operationId: placement.operationId, profileId: placement.profileId, generation: placement.generation,
        dir, view, binding: v4.binding, relay, isV4: true, unregisterDrain, lastUsedAt: Date.now() }
      writePrivate(join(view, 'binding.json'), v4.binding, true)
      await this.listen(relay.controlServer, join(view, 'relay.sock'), 1000, 1000)
      return lane
    } catch (error) {
      if (lane) {
        lane.creationFailed = true
        try { await this.stopLane(lane) } catch { this.chat(request.sessionKey).lane = lane }
      } else {
        rmSync(view, { recursive: true, force: true })
        try { await this.hooks.onState?.(placement.operationId, 'released', placement.generation, true) } catch { /* durable no-effect CAS permits recovery */ }
      }
      throw error
    }
  }

  private stopLane(lane: Lane): Promise<void> {
    if (lane.stopping) return lane.stopping
    lane.stopping = (async () => {
      let proven = false
      try {
        await lane.preparationStop?.()
        lane.preparationStop = undefined
        proven = (await lane.relay.stop()).remoteStopped === true
      } catch {
        proven = false
      } finally {
        lane.unregisterDrain?.()
        lane.unregisterDrain = undefined
      }
      await this.hooks.onState?.(lane.operationId, proven ? 'released' : 'unknown', lane.generation, lane.isV4)
      requireLane(proven)
      for (const server of [lane.relay.controlServer, 'toolServer' in lane.relay ? lane.relay.toolServer : undefined]) {
        if (!server?.listening) continue
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      rmSync(lane.view, { recursive: true, force: true })
      // An unproved stop retains its control endpoint for late local proof.
    })()
    lane.stopping = lane.stopping.catch(error => { lane.stopping = undefined; throw error })
    return lane.stopping
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
    const record = this.containers.get(containerDbId)
    if (!record) return Promise.resolve()
    requireRuntime(!dockerId || !record.dockerId || record.dockerId === dockerId)
    if (record.release) return record.release
    record.state = 'released' // No new lane from here on; a lane still starting stops itself.
    record.release = (async () => {
      // On each chat's own tail, after any placement already queued there for this container.
      await Promise.allSettled([...this.chats.values()].map((owner) => this.serial(owner, async () => {
        if (owner.lane?.container !== record) return
        const lane = owner.lane
        owner.lane = undefined
        try { await this.stopLane(lane) }
        finally {
          // Container release closes transport even when capacity remains quarantined in PG.
          lane.unregisterDrain?.()
          lane.unregisterDrain = undefined
          for (const server of [lane.relay.controlServer, 'toolServer' in lane.relay ? lane.relay.toolServer : undefined]) {
            if (!server?.listening) continue
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
          }
        }
      })))
      rmSync(record.handle.mountSource, { recursive: true, force: true })
      rmSync(join(record.root, 'lanes'), { recursive: true, force: true })
      writePrivate(join(record.root, 'released.json'), { version: 1 })
    })()
    return record.release
  }
}
