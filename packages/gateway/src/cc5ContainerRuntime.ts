import { memoryRejection, nodeMemoryError } from './remoteNodeMemory.js'
/** Privileged master runtime for remote-pool chats (`CC5_MOUNT` read-only view + per-chat SSH relays). */
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
  type RequiredTurnCapabilities,
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
import {
  LANE_OWNER_FILENAME,
  type LaneOwnerMetadata,
  type ProcessAliveChecker,
  type SocketListeningChecker,
  isLivePeerOwnedLane,
  isProcessAliveWithStartTicks,
  isUnixSocketListening,
  readLaneOwnerFile,
  readProcessStartTicks,
  writeLaneOwnerFile,
} from './cc5LaneOwnership.js'
import { type Cc5InteractiveHostPort, Cc5Relay } from './cc5Relay.js'
import { Cc5SshHost, type Cc5SshHostConfig, type RemoteCcTarget } from './cc5SshHost.js'

export { cc5ControlRequest, type Cc5BridgeBinding } from './cc5BridgePort.js'
export {
  LANE_OWNER_FILENAME,
  type LaneOwnerMetadata,
  type ProcessAliveChecker,
  type SocketListeningChecker,
  isLivePeerOwnedLane,
  isProcessAliveWithStartTicks,
  isUnixSocketListening,
  readLaneOwnerFile,
  readProcessStartTicks,
  writeLaneOwnerFile,
} from './cc5LaneOwnership.js'
export { defaultRemoteCcTarget, type RemoteCcTarget } from './cc5SshHost.js'

interface FsIdentity {
  readonly requireRoot: boolean
  readonly ownerUid: number
  readonly viewGid: number
  readonly toolSocketUid: number
  readonly toolSocketGid: number
  readonly controlSocketUid: number
  readonly controlSocketGid: number
}

const PRODUCTION_FS_IDENTITY: FsIdentity = Object.freeze({
  requireRoot: true,
  ownerUid: 0,
  viewGid: 1000,
  toolSocketUid: 0,
  toolSocketGid: 0,
  controlSocketUid: 1000,
  controlSocketGid: 1000,
})

const REJECTED = 'CC5_FRESH_CONTAINER_BINDING_REJECTED'
export const REMOTE_LANE_UNAVAILABLE = 'REMOTE_LANE_UNAVAILABLE'
export const REMOTE_LANE_PEER_RELEASE_UNPROVEN = 'REMOTE_LANE_PEER_RELEASE_UNPROVEN'
const DEFAULT_ADMIT_RESERVATION_MS = 60_000
const STAGING_GRACE_MS = 5_000
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
function writePrivate(
  path: string,
  value: unknown,
  groupReadable = false,
  fsIdentity: FsIdentity = PRODUCTION_FS_IDENTITY,
): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    groupReadable ? 0o640 : 0o600,
  )
  try {
    if (groupReadable) fchownSync(fd, fsIdentity.ownerUid, fsIdentity.viewGid)
    fchmodSync(fd, groupReadable ? 0o640 : 0o600)
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dirname(path))
}
function overwriteProtectedBinding(
  laneView: string,
  binding: Readonly<RemoteBridgeBinding>,
  fsIdentity: FsIdentity = PRODUCTION_FS_IDENTITY,
): void {
  const tmpPath = join(laneView, 'binding.json.tmp')
  rmSync(tmpPath, { force: true })
  writePrivate(tmpPath, binding, true, fsIdentity)
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
  readonly engine?: 'ccb' | 'codex' | 'antigravity'
  readonly uid: number
  readonly containerDbId: string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly allowStickyFailover?: boolean
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly systemPromptSha256?: string
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
  release(
    containerDbId: string,
    dockerId?: string,
    opts?: {
      readonly skipViewCleanup?: boolean
      readonly peerCleanup?: () => Promise<boolean>
    },
  ): Promise<void>
  /** The chat's live lane, created on first use. Rejects with REMOTE_LANE_UNAVAILABLE. */
  ensureLane(request: RemoteLaneRequest): Promise<RemoteExecutionBackend>
  /** A deleted chat frees its idle lanes (any agent); a lane mid-turn stays reclaimable as before. */
  releaseChat(uid: number, chatId: string): Promise<void>
  /** Explicitly stops and reclaims a delegate/swarm lane keyed by full sessionKey. */
  releaseSessionKey?(
    uid: number,
    sessionKey: string,
    opts?: { containerDbId?: string; operationId?: string; generation?: string },
  ): Promise<{ released: boolean; state: 'released' | 'not_found' | 'mismatch' | 'unknown' }>
  /** Releases a session's lane only if currently idle; used for cross-slot handover. */
  releaseSessionIfIdle?(
    sessionKey: string,
    opts?: { operationId?: string },
  ): Promise<{ status: 'released' | 'busy' | 'not_found' | 'unknown' }>
  /** Stops idle own lanes without deleting shared container views or peer lanes (pass force:true to stop all own lanes). */
  drainOwnIdleAndOwnedLanes?(opts?: { readonly force?: boolean }): Promise<void>
  /** Scans adopted containers and baseRoot for any live peer-owned lane matching the optional filter. */
  hasLivePeerOwnedLane?(filter?: {
    readonly containerDbId?: string
    readonly sessionKey?: string
    readonly operationId?: string
  }): boolean
}

export interface PeerSessionHandoverInput {
  sessionKey: string
  operationId: string
  ownerSlot: string
  ownerPid: number
}
export type PeerSessionHandoverResult = 'released' | 'busy' | 'unavailable'

export interface RuntimeOptions {
  baseRoot: string
  controllerPath: string
  evidenceRoot?: string
  /** Trusted fixture seam only; default constructs the production SSH host. */
  hostFactory?: (config: Cc5SshHostConfig) => RemoteLaneHost
  ownerSlot?: string
  ownerInstanceId?: string
  /** Reservation window (ms) protecting a handed-out backend until `/admit` arrives. Defaults to 60_000 in dual-slot mode. */
  admitReservationMs?: number
  /** Test-only injection for peer process liveness verification. */
  isProcessAlive?: (pid: number, expectedStartTicks: string | null) => boolean
  /** Test-only injection for AF_UNIX listening socket probing. */
  isSocketListening?: SocketListeningChecker
  peerSessionHandover?: (input: PeerSessionHandoverInput) => Promise<PeerSessionHandoverResult>
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
  /** Timestamp until which the lane is reserved after `ensureLane` returns and before `/admit` arrives. */
  admitReservationUntil: number
  /** Count of in-flight control HTTP requests on `relay.controlServer` bridging reservation -> relay state. */
  activeControlRequests: number
  /** Preparation may reset/provision remotely before the relay attempts a model launch. */
  preparationStop?: () => Promise<unknown>
  creationFailed?: boolean
  verifiedCapabilityKeys?: Set<string>
}
interface ContainerState {
  readonly handle: Cc5PreparedContainer
  readonly root: string
  readonly keyring: AuthorityKeyring
  dockerId?: string
  state: 'prepared' | 'bound' | 'active' | 'released'
  release?: Promise<void>
}
/** One owner per chat across all containers: its live lane and a serial tail. */
interface ChatOwner {
  lane?: Lane
  tail: Promise<unknown>
}

const CONTAINER_STATE_RANK: Record<ContainerState['state'], number> = {
  prepared: 1,
  bound: 2,
  active: 3,
  released: 4,
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
  return new RemoteLaneRuntime(
    uid!,
    input.configuration(),
    input.financeFactory,
    input.hooks,
    PRODUCTION_FS_IDENTITY,
  )
}

/**
 * Test-only factory that runs the exact same `RemoteLaneRuntime` against a `/tmp/` baseRoot
 * using the current unprivileged user's uid/gid when tests execute without root.
 */
export function __createNonRootRemoteLaneRuntimeForTests(input: {
  selfhost: boolean
  env: Cc5PolicyEnvironment
  configuration: () => RuntimeOptions
  financeFactory: RemoteFinanceFactory
  hooks: RemoteLaneHooks
}): RemoteLaneRuntimePort | undefined {
  const uid = input.env[CC5_TEST_UID_ENV]
  if (!input.selfhost || !canUseCc5TestModel(uid, input.env)) return undefined
  const config = input.configuration()
  requireRuntime(
    config.baseRoot.startsWith('/tmp/') && typeof config.hostFactory === 'function',
  )
  const currentUid = process.getuid?.() ?? 0
  const currentGid = process.getgid?.() ?? 0
  return new RemoteLaneRuntime(uid!, config, input.financeFactory, input.hooks, {
    requireRoot: false,
    ownerUid: currentUid,
    viewGid: currentGid,
    toolSocketUid: currentUid,
    toolSocketGid: currentGid,
    controlSocketUid: currentUid,
    controlSocketGid: currentGid,
  })
}

class RemoteLaneRuntime implements RemoteLaneRuntimePort {
  private readonly containers = new Map<string, ContainerState>()
  private readonly handles = new WeakMap<Cc5PreparedContainer, ContainerState>()
  private readonly chats = new Map<string, ChatOwner>()
  private readonly ownerSlot?: string
  private readonly ownerInstanceId: string
  private readonly selfPidStartTicks: string | null
  private readonly admitReservationMs: number
  constructor(
    private readonly uid: string,
    private readonly options: RuntimeOptions,
    private readonly financeFactory: RemoteFinanceFactory,
    private readonly hooks: RemoteLaneHooks,
    private readonly fsIdentity: FsIdentity = PRODUCTION_FS_IDENTITY,
  ) {
    requireRuntime(typeof financeFactory === 'function' && typeof hooks?.place === 'function')
    requireRuntime(
      (!fsIdentity.requireRoot || process.getuid?.() === 0) &&
        isAbsolute(options.baseRoot) &&
        isAbsolute(options.controllerPath) &&
        Buffer.byteLength(join(options.baseRoot, 'a'.repeat(24), 'lanes', 'a'.repeat(36), 'tool.sock')) <= 100,
    )
    this.ownerSlot = options.ownerSlot?.trim() || undefined
    this.ownerInstanceId =
      options.ownerInstanceId?.trim() || `${process.pid}-${randomBytes(6).toString('hex')}`
    this.selfPidStartTicks = readProcessStartTicks(process.pid)
    this.admitReservationMs =
      typeof options.admitReservationMs === 'number' &&
      Number.isFinite(options.admitReservationMs) &&
      options.admitReservationMs >= 0
        ? options.admitReservationMs
        : this.ownerSlot
          ? DEFAULT_ADMIT_RESERVATION_MS
          : 0
    if (!existsSync(options.baseRoot)) mkdirSync(options.baseRoot, { mode: 0o700 })
    const st = lstatSync(options.baseRoot)
    requireRuntime(
      st.isDirectory() &&
        !st.isSymbolicLink() &&
        st.uid === fsIdentity.ownerUid &&
        (st.mode & 0o777) === 0o700,
    )
    for (const entry of readdirSync(options.baseRoot)) this.adopt(entry, false)
  }

  private isSocketListening(sockPath: string): boolean {
    return (this.options.isSocketListening ?? isUnixSocketListening)(sockPath)
  }

  private isFreshStagingEntry(entryDir: string, name: string): boolean {
    if (!name.startsWith('.staging-')) return false
    try {
      const st = lstatSync(entryDir)
      return st.isDirectory() && !st.isSymbolicLink() && Date.now() - st.mtimeMs < STAGING_GRACE_MS
    } catch {
      return false
    }
  }

  private isLaneBusyOrReserved(lane: Lane): boolean {
    return (
      !lane.relay.idle ||
      lane.activeControlRequests > 0 ||
      Date.now() < lane.admitReservationUntil
    )
  }

  private refreshAdoptedContainers(): void {
    try {
      for (const entry of readdirSync(this.options.baseRoot)) {
        this.adopt(entry, true)
      }
    } catch {
      // Base root scan errors do not disturb already-known containers.
    }
  }

  private cleanupAdoptedContainerOrphans(root: string, mountSource: string, containerDbId: string): void {
    if (!this.ownerSlot) {
      for (const name of readdirSync(mountSource)) {
        if (name !== 'authority-public.json') rmSync(join(mountSource, name), { recursive: true, force: true })
      }
      rmSync(join(root, 'lanes'), { recursive: true, force: true })
      rmSync(join(root, 'UNKNOWN.json'), { force: true })
      return
    }
    const ownActiveOps = new Set<string>()
    for (const owner of this.chats.values()) {
      if (owner.lane && owner.lane.container.handle.containerDbId === containerDbId) {
        ownActiveOps.add(owner.lane.operationId)
      }
    }
    const liveLegacyOps = new Set<string>()
    for (const name of readdirSync(mountSource)) {
      if (name === 'authority-public.json' || ownActiveOps.has(name)) continue
      const entryDir = join(mountSource, name)
      const check = isLivePeerOwnedLane(
        entryDir,
        this.ownerSlot,
        this.ownerInstanceId,
        this.options.isProcessAlive,
      )
      if (check.livePeer) continue
      if (!check.owner) {
        if (this.isFreshStagingEntry(entryDir, name)) continue
        if (this.isSocketListening(join(entryDir, 'relay.sock'))) {
          liveLegacyOps.add(name)
          continue
        }
      }
      rmSync(entryDir, { recursive: true, force: true })
    }
    const lanesDir = join(root, 'lanes')
    if (existsSync(lanesDir)) {
      try {
        const lanesSt = lstatSync(lanesDir)
        if (lanesSt.isDirectory() && !lanesSt.isSymbolicLink()) {
          for (const name of readdirSync(lanesDir)) {
            if (ownActiveOps.has(name) || liveLegacyOps.has(name)) continue
            const laneDir = join(lanesDir, name)
            const check = isLivePeerOwnedLane(
              laneDir,
              this.ownerSlot,
              this.ownerInstanceId,
              this.options.isProcessAlive,
            )
            if (check.livePeer) continue
            if (!check.owner) {
              if (this.isFreshStagingEntry(laneDir, name)) continue
              if (this.isSocketListening(join(laneDir, 'tool.sock'))) continue
            }
            rmSync(laneDir, { recursive: true, force: true })
          }
        }
      } catch {
        // Unreadable lanes entry is ignored.
      }
    }
    rmSync(join(root, 'UNKNOWN.json'), { force: true })
  }

  /**
   * A container prepared by an earlier master keeps its mounted view; it is adopted with no lane.
   * Lane leftovers are dropped here — in dual-slot mode (`ownerSlot` set), live peer-owned lanes
   * and live legacy listening lanes are preserved while dead orphans are cleaned.
   */
  private adopt(entry: string, includeUnactivated = false): void {
    const root = join(this.options.baseRoot, entry)
    try {
      const st = lstatSync(root)
      if (
        !/^[a-f0-9]{24}$/.test(entry) ||
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        st.uid !== this.fsIdentity.ownerUid
      )
        return
      if (existsSync(join(root, 'released.json')) || existsSync(join(root, 'releasing.json'))) {
        for (const existing of this.containers.values()) {
          if (existing.root === root) existing.state = 'released'
        }
        return
      }
      const prepared = readJson(join(root, 'prepared.json'))
      const containerDbId = String(prepared.containerDbId)
      const mountSource = join(root, 'view')
      if (
        String(prepared.uid) !== this.uid ||
        !/^[1-9][0-9]{0,18}$/.test(containerDbId) ||
        !existsSync(mountSource)
      )
        return
      let diskState: 'prepared' | 'bound' | 'active'
      let dockerId: string | undefined
      const activatedPath = join(root, 'activated.json')
      const boundPath = join(root, 'bound.json')
      if (existsSync(activatedPath)) {
        const activated = readJson(activatedPath)
        if (typeof activated.dockerId !== 'string' || !/^[a-f0-9]{64}$/.test(activated.dockerId)) return
        diskState = 'active'
        dockerId = activated.dockerId
      } else if (includeUnactivated && existsSync(boundPath)) {
        const bound = readJson(boundPath)
        if (typeof bound.dockerId !== 'string' || !/^[a-f0-9]{64}$/.test(bound.dockerId)) return
        diskState = 'bound'
        dockerId = bound.dockerId
      } else if (includeUnactivated) {
        diskState = 'prepared'
      } else {
        return
      }
      const existing = this.containers.get(containerDbId)
      if (existing) {
        if (existing.root === root) {
          if (CONTAINER_STATE_RANK[diskState] > CONTAINER_STATE_RANK[existing.state]) {
            existing.state = diskState
            if (dockerId) existing.dockerId = dockerId
          }
          return
        }
        if (
          existing.state !== 'released' &&
          (existsSync(join(existing.root, 'released.json')) ||
            existsSync(join(existing.root, 'releasing.json')))
        ) {
          existing.state = 'released'
        }
        if (existing.state !== 'released') return
      }
      const authority = readJson(join(mountSource, 'authority-public.json'))
      const keyring = parseAuthorityKeyring(String(authority.keyring))
      if (keyring.size === 0) return
      if (diskState === 'active') {
        this.cleanupAdoptedContainerOrphans(root, mountSource, containerDbId)
      }
      const handle = Object.freeze({ mountSource, containerDbId })
      const record: ContainerState = { handle, root, keyring, dockerId, state: diskState }
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
    if (prior && prior.state !== 'released' && existsSync(join(prior.root, 'released.json'))) {
      prior.state = 'released'
    }
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
    chownSync(mountSource, this.fsIdentity.ownerUid, this.fsIdentity.viewGid)
    chmodSync(mountSource, 0o750)
    const handle = Object.freeze({ mountSource, containerDbId: input.containerDbId })
    const record: ContainerState = { handle, root, keyring, state: 'prepared' }
    this.containers.set(input.containerDbId, record)
    this.handles.set(handle, record)
    writePrivate(
      join(root, 'prepared.json'),
      { version: 3, uid: this.uid, containerDbId: input.containerDbId },
      false,
      this.fsIdentity,
    )
    writePrivate(
      join(mountSource, 'authority-public.json'),
      { version: 1, keyring: input.publicKeyring },
      true,
      this.fsIdentity,
    )
    return handle
  }
  private record(handle: Cc5PreparedContainer): ContainerState {
    const direct = this.handles.get(handle)
    if (direct && this.containers.get(handle.containerDbId) === direct) return direct
    const byId = this.containers.get(handle.containerDbId)
    if (byId && byId.handle.mountSource === handle.mountSource) {
      this.handles.set(handle, byId)
      return byId
    }
    this.refreshAdoptedContainers()
    const refreshed = this.containers.get(handle.containerDbId)
    requireRuntime(refreshed && refreshed.handle.mountSource === handle.mountSource)
    this.handles.set(handle, refreshed)
    return refreshed
  }
  async bindCreated(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
    const record = this.record(handle)
    requireRuntime(record.state === 'prepared' && /^[a-f0-9]{64}$/.test(dockerId))
    writePrivate(join(record.root, 'bound.json'), { version: 1, dockerId }, false, this.fsIdentity)
    record.dockerId = dockerId
    record.state = 'bound'
  }
  async activate(handle: Cc5PreparedContainer, dockerId: string): Promise<void> {
    let record = this.record(handle)
    if (record.state !== 'bound' || record.dockerId !== dockerId) {
      this.refreshAdoptedContainers()
      record = this.record(handle)
    }
    requireRuntime(record.state === 'bound' && record.dockerId === dockerId)
    writePrivate(join(record.root, 'activated.json'), { version: 1, dockerId }, false, this.fsIdentity)
    record.state = 'active'
  }

  private buildLaneOwnerMetadata(input: {
    sessionKey: string
    operationId: string
    generation: string
  }): LaneOwnerMetadata | undefined {
    if (!this.ownerSlot) return undefined
    return {
      version: 1,
      slot: this.ownerSlot,
      instanceId: this.ownerInstanceId,
      pid: process.pid,
      pidStartTicks: this.selfPidStartTicks,
      sessionKey: input.sessionKey,
      operationId: input.operationId,
      generation: input.generation,
      createdAt: Date.now(),
    }
  }

  private writeLaneOwner(
    dirs: readonly string[],
    input: { sessionKey: string; operationId: string; generation: string },
  ): void {
    const meta = this.buildLaneOwnerMetadata(input)
    if (!meta) return
    for (const dir of dirs) {
      writeLaneOwnerFile(dir, meta)
    }
  }

  /**
   * Publishes `<mountSource>/<operationId>` atomically via a sibling staging directory containing
   * `owner.json` (when dual-slot is enabled) and `binding.json`, eliminating any naked-directory
   * race window between `mkdir` and `owner.json` creation.
   */
  private publishLaneViewDir(
    mountSource: string,
    operationId: string,
    binding: Readonly<RemoteBridgeBinding | RemotePoolBinding>,
    ownerInput: { sessionKey: string; operationId: string; generation: string },
  ): string {
    const view = join(mountSource, operationId)
    const staging = join(mountSource, `.staging-${operationId}-${randomBytes(6).toString('hex')}`)
    mkdirSync(staging, { mode: 0o750 })
    try {
      chownSync(staging, this.fsIdentity.ownerUid, this.fsIdentity.viewGid)
      chmodSync(staging, 0o750)
      const meta = this.buildLaneOwnerMetadata(ownerInput)
      if (meta) writeLaneOwnerFile(staging, meta)
      writePrivate(join(staging, 'binding.json'), binding, true, this.fsIdentity)
      renameSync(staging, view)
      syncDirectory(mountSource)
      return view
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  private publishLanePrivateDir(
    lanesRoot: string,
    operationId: string,
    ownerInput: { sessionKey: string; operationId: string; generation: string },
  ): string {
    mkdirSync(lanesRoot, { recursive: true, mode: 0o700 })
    const dir = join(lanesRoot, operationId)
    const staging = join(lanesRoot, `.staging-${operationId}-${randomBytes(6).toString('hex')}`)
    mkdirSync(staging, { mode: 0o700 })
    try {
      const meta = this.buildLaneOwnerMetadata(ownerInput)
      if (meta) writeLaneOwnerFile(staging, meta)
      renameSync(staging, dir)
      syncDirectory(lanesRoot)
      return dir
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  private async ensurePeerSessionHandover(
    container: ContainerState,
    sessionKey: string,
  ): Promise<void> {
    if (!this.ownerSlot) return
    let entries: string[]
    try {
      entries = readdirSync(container.handle.mountSource)
    } catch {
      return
    }
    const aliveCheck = this.options.isProcessAlive ?? isProcessAliveWithStartTicks
    for (const name of entries) {
      if (name === 'authority-public.json' || name.startsWith('.staging-')) continue
      const entryDir = join(container.handle.mountSource, name)
      const check = isLivePeerOwnedLane(
        entryDir,
        this.ownerSlot,
        this.ownerInstanceId,
        aliveCheck,
      )
      if (!check.owner) {
        // Legacy master lane without owner.json: fail closed if its relay.sock is still live for this sessionKey.
        if (this.isSocketListening(join(entryDir, 'relay.sock'))) {
          try {
            const legacyBinding = readJson(join(entryDir, 'binding.json'))
            if (legacyBinding.sessionKey === sessionKey) {
              throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
            }
          } catch (error) {
            if (error instanceof Error && error.message === 'REMOTE_POOL_DRAINING_RETRY_LATER') {
              throw error
            }
          }
        }
        continue
      }
      if (!check.livePeer || check.owner.sessionKey !== sessionKey) continue
      if (!this.options.peerSessionHandover) {
        throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
      }
      let outcome: PeerSessionHandoverResult
      try {
        outcome = await this.options.peerSessionHandover({
          sessionKey,
          operationId: check.owner.operationId,
          ownerSlot: check.owner.slot,
          ownerPid: check.owner.pid,
        })
      } catch {
        outcome = 'unavailable'
      }
      if (outcome === 'released') {
        const current = readLaneOwnerFile(entryDir)
        if (
          current &&
          current.operationId === check.owner.operationId &&
          current.instanceId === check.owner.instanceId
        ) {
          rmSync(entryDir, { recursive: true, force: true })
          rmSync(join(container.root, 'lanes', name), { recursive: true, force: true })
        }
        continue
      }
      if (outcome === 'busy') {
        throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
      }
      if (aliveCheck(check.owner.pid, check.owner.pidStartTicks)) {
        throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
      }
      rmSync(entryDir, { recursive: true, force: true })
      rmSync(join(container.root, 'lanes', name), { recursive: true, force: true })
    }
  }

  private isContainerReleasingOnDisk(container: ContainerState): boolean {
    if (
      existsSync(join(container.root, 'releasing.json')) ||
      existsSync(join(container.root, 'released.json'))
    ) {
      container.state = 'released'
      return true
    }
    return false
  }

  async ensureLane(request: RemoteLaneRequest): Promise<RemoteExecutionBackend> {
    let container = this.containers.get(request.containerDbId)
    if (!container || container.state !== 'active' || !container.dockerId) {
      this.refreshAdoptedContainers()
      container = this.containers.get(request.containerDbId)
    }
    if (container && this.isContainerReleasingOnDisk(container)) {
      requireLane(false)
    }
    requireLane(container?.state === 'active' && container.dockerId && String(request.uid) === this.uid &&
      isCc5CanonicalModel(request.canonicalModel))
    const owner = this.chat(request.sessionKey)
    const reqCapEntries = request.requiredCapabilities
      ? Object.entries(request.requiredCapabilities)
          .filter(([, v]) => v !== undefined && v !== false)
          .sort(([a], [b]) => a.localeCompare(b))
      : []
    const reqCapKey = reqCapEntries.length > 0 ? JSON.stringify(reqCapEntries) : null
    const live = (lane: Lane | undefined): lane is Lane => !!lane && lane.container === container &&
      !lane.creationFailed && !lane.stopping && !lane.relay.stopped && lane.canonicalModel === request.canonicalModel &&
      lane.binding.expiresAt > Date.now() &&
      (reqCapKey === null || Boolean(lane.verifiedCapabilityKeys?.has(reqCapKey))) &&
      (lane.binding.version === 4
        ? lane.binding.authorityEngine === (request.engine ?? 'ccb')
        : request.engine !== 'antigravity' && (request.engine === 'codex') === (lane.binding.backendKind === 'codex-app-server-v1'))
    let lane = owner.lane
    if (!live(lane)) {
      lane = await this.serial(owner, async () => {
        if (live(owner.lane)) return owner.lane
        try {
          requireLane(
            container.state === 'active' &&
              container.dockerId &&
              !this.isContainerReleasingOnDisk(container),
          )
          await this.ensurePeerSessionHandover(container, request.sessionKey)
          if (owner.lane) {
            const old = owner.lane
            await this.stopLane(old)
            owner.lane = undefined
          }
          requireLane(
            container.state === 'active' &&
              container.dockerId &&
              !this.isContainerReleasingOnDisk(container),
          )
          const placement = await this.place(request, container.dockerId)
          requireLane(UUID.test(placement.operationId) && UUID.test(placement.runId) &&
            placement.target.upstreamModel.length > 0)
          const next = await this.startLane(container, request, placement)
          if (reqCapKey !== null) {
            next.verifiedCapabilityKeys = new Set([reqCapKey])
          }
          if (container.state !== 'active' || this.isContainerReleasingOnDisk(container)) {
            await this.stopLane(next)
            requireLane(false)
          }
          try { await this.hooks.onState?.(next.operationId, 'running', next.generation, next.isV4) }
          catch (error) {
            try { await this.stopLane(next) } catch { owner.lane = next }
            throw error
          }
          owner.lane = next
          return next
        } catch (error) {
          if (error instanceof Error &&
            (error.message === REMOTE_LANE_UNAVAILABLE ||
              error.message === 'REMOTE_POOL_DRAINING_RETRY_LATER' ||
              error.message === 'REMOTE_DRIVER_REVERIFY_REQUIRED' ||
              error.message === 'CAPABILITY_UNSATISFIED' ||
              memoryRejection(error) !== undefined)) throw error
          throw new Error(REMOTE_LANE_UNAVAILABLE, { cause: error })
        }
      })
    }
    const now = Date.now()
    lane.lastUsedAt = now
    if (this.admitReservationMs > 0) {
      lane.admitReservationUntil = Math.max(lane.admitReservationUntil, now + this.admitReservationMs)
    }
    if (lane.binding.version === 4) return remotePoolBackendOf(lane.binding)
    if (lane.binding.version === 3) return codexBackend(lane.binding)
    return parseCc5ExecutionBackend({ kind: CC5_INTERACTIVE_BACKEND, sessionKey: lane.sessionKey,
      operationId: lane.operationId })
  }

  /**
   * A chat keeps its lane while idle so the next turn is warm. When the pool is full, a new turn
   * takes over this user's longest-idle lane of the same engine; that chat resumes on its next turn.
   * B4: Never evicts a lane that is busy, servicing a control request, or within its pre-admit
   * reservation window; re-verifies eligibility inside the victim chat's serial queue before stop.
   */
  private async place(request: RemoteLaneRequest, dockerId: string): Promise<RemoteLanePlacement> {
    try { return await this.hooks.place({ ...request, dockerId }) }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'REMOTE_LANE_CAPACITY_EXHAUSTED') throw error
      // Only a slot of a profile this placement could use ends the wait.
      const profiles = (error as { profiles?: unknown }).profiles
      if (!Array.isArray(profiles)) throw error
      const candidates = [...this.chats.entries()]
        .filter(([key, owner]) => key !== request.sessionKey && owner.lane && !owner.lane.stopping &&
          !this.isLaneBusyOrReserved(owner.lane) && profiles.includes(owner.lane.profileId))
        .sort(([, a], [, b]) => a.lane!.lastUsedAt - b.lane!.lastUsedAt)
      let evicted = false
      for (const [, victim] of candidates) {
        const targetLane = victim.lane
        if (!targetLane) continue
        const didEvict = await this.serial(victim, async () => {
          const current = victim.lane
          if (!current || current !== targetLane || current.stopping) return false
          if (this.isLaneBusyOrReserved(current) || !profiles.includes(current.profileId)) return false
          await this.stopLane(current)
          if (victim.lane === current) victim.lane = undefined
          return true
        })
        if (didEvict) {
          evicted = true
          break
        }
      }
      if (!evicted) throw error
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
      if (!lane || lane.stopping || this.isLaneBusyOrReserved(lane)) return
      await this.stopLane(lane)
      if (owner.lane === lane) owner.lane = undefined
    })))
  }

  async releaseSessionKey(
    uid: number,
    sessionKey: string,
    opts?: { containerDbId?: string; operationId?: string; generation?: string },
  ): Promise<{ released: boolean; state: 'released' | 'not_found' | 'mismatch' | 'unknown' }> {
    if (String(uid) !== this.uid || !sessionKey) return { released: false, state: 'not_found' }
    const owner = this.chats.get(sessionKey)
    if (!owner) return { released: true, state: 'not_found' }
    return await this.serial(owner, async () => {
      const lane = owner.lane
      if (!lane) return { released: true, state: 'not_found' }
      if (opts?.containerDbId && lane.binding.containerDbId !== opts.containerDbId) {
        return { released: false, state: 'mismatch' }
      }
      if (opts?.operationId && lane.operationId !== opts.operationId) {
        return { released: false, state: 'mismatch' }
      }
      if (opts?.generation && lane.generation !== opts.generation) {
        return { released: false, state: 'mismatch' }
      }
      lane.admitReservationUntil = 0
      try {
        await this.stopLane(lane)
        if (owner.lane === lane) owner.lane = undefined
        return { released: true, state: 'released' }
      } catch {
        return { released: false, state: 'unknown' }
      }
    })
  }

  async releaseSessionIfIdle(
    sessionKey: string,
    opts?: { operationId?: string },
  ): Promise<{ status: 'released' | 'busy' | 'not_found' | 'unknown' }> {
    if (!sessionKey) return { status: 'not_found' }
    const owner = this.chats.get(sessionKey)
    if (!owner) return { status: 'not_found' }
    return await this.serial(owner, async () => {
      const lane = owner.lane
      if (!lane) return { status: 'not_found' }
      if (opts?.operationId && lane.operationId !== opts.operationId) {
        return { status: 'not_found' }
      }
      if (this.isLaneBusyOrReserved(lane)) {
        return { status: 'busy' }
      }
      try {
        await this.stopLane(lane)
        if (owner.lane === lane) owner.lane = undefined
        return { status: 'released' }
      } catch {
        return { status: 'unknown' }
      }
    })
  }

  async drainOwnIdleAndOwnedLanes(opts?: { readonly force?: boolean }): Promise<void> {
    const force = opts?.force === true
    const owners = [...this.chats.values()]
    await Promise.allSettled(
      owners.map((owner) =>
        this.serial(owner, async () => {
          const lane = owner.lane
          if (!lane) return
          if (!force && this.isLaneBusyOrReserved(lane)) return
          try {
            await this.stopLane(lane)
            if (owner.lane === lane) owner.lane = undefined
          } catch {
            // Retain unproved lane on owner without touching container-level views or peer lanes.
          }
        }),
      ),
    )
  }

  hasLivePeerOwnedLane(filter?: {
    readonly containerDbId?: string
    readonly sessionKey?: string
    readonly operationId?: string
  }): boolean {
    if (!this.ownerSlot) return false
    const aliveCheck = this.options.isProcessAlive ?? isProcessAliveWithStartTicks
    const mounts = new Map<string, string>() // mountSource -> containerDbId
    for (const record of this.containers.values()) {
      if (existsSync(record.handle.mountSource)) {
        mounts.set(record.handle.mountSource, record.handle.containerDbId)
      }
    }
    try {
      for (const entry of readdirSync(this.options.baseRoot)) {
        if (!/^[a-f0-9]{24}$/.test(entry)) continue
        const root = join(this.options.baseRoot, entry)
        try {
          const st = lstatSync(root)
          if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== this.fsIdentity.ownerUid) continue
          if (existsSync(join(root, 'released.json'))) continue
          const prepared = readJson(join(root, 'prepared.json'))
          const containerDbId = String(prepared.containerDbId)
          const mountSource = join(root, 'view')
          if (String(prepared.uid) !== this.uid || !existsSync(mountSource)) continue
          mounts.set(mountSource, containerDbId)
        } catch {
          // Ignore unreadable entries.
        }
      }
    } catch {
      // Ignore baseRoot scan errors.
    }

    for (const [mountSource, containerDbId] of mounts) {
      if (filter?.containerDbId && filter.containerDbId !== containerDbId) continue
      let names: string[]
      try {
        names = readdirSync(mountSource)
      } catch {
        continue
      }
      for (const name of names) {
        if (name === 'authority-public.json' || name.startsWith('.staging-')) continue
        const entryDir = join(mountSource, name)
        const check = isLivePeerOwnedLane(
          entryDir,
          this.ownerSlot,
          this.ownerInstanceId,
          aliveCheck,
        )
        if (check.livePeer && check.owner) {
          if (filter?.operationId && check.owner.operationId !== filter.operationId) continue
          if (filter?.sessionKey && check.owner.sessionKey !== filter.sessionKey) continue
          return true
        }
        if (!check.owner && this.isSocketListening(join(entryDir, 'relay.sock'))) {
          if (filter?.operationId && name !== filter.operationId) continue
          if (filter?.sessionKey) {
            try {
              const legacyBinding = readJson(join(entryDir, 'binding.json'))
              if (legacyBinding.sessionKey !== filter.sessionKey) continue
            } catch {
              continue
            }
          }
          return true
        }
      }
    }
    return false
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
    requireLane(request.engine !== 'antigravity')
    let lane: Lane | undefined
    try {
    requireLane(!placement.codex)
    const lanesRoot = join(container.root, 'lanes')
    const dir = join(lanesRoot, placement.operationId)
    const view = join(container.handle.mountSource, placement.operationId)
    if (this.ownerSlot) {
      const viewPeer = isLivePeerOwnedLane(
        view,
        this.ownerSlot,
        this.ownerInstanceId,
        this.options.isProcessAlive,
      )
      const dirPeer = isLivePeerOwnedLane(
        dir,
        this.ownerSlot,
        this.ownerInstanceId,
        this.options.isProcessAlive,
      )
      if (
        viewPeer.livePeer ||
        dirPeer.livePeer ||
        (!viewPeer.owner && this.isSocketListening(join(view, 'relay.sock'))) ||
        (!dirPeer.owner && this.isSocketListening(join(dir, 'tool.sock')))
      ) {
        throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
      }
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(view, { recursive: true, force: true })
    const ownerInput = {
      sessionKey: request.sessionKey,
      operationId: placement.operationId,
      generation: placement.generation ?? '1',
    }
    this.publishLanePrivateDir(lanesRoot, placement.operationId, ownerInput)
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
    this.publishLaneViewDir(container.handle.mountSource, placement.operationId, binding, ownerInput)
    let current: Lane | undefined
    const relay = new Cc5Relay(binding, container.keyring, placement.runId, host, join(dir, 'journal'), finance, {
      slidingTtlMs: CC5_BINDING_SLIDING_TTL_MS,
      upstreamModel: placement.target.upstreamModel,
      onBindingExtended: (expiresAt: number) => {
        requireLane(current && !current.stopping && existsSync(view) && current.binding.version !== 4)
        const next = Object.freeze({ ...current.binding, expiresAt })
        overwriteProtectedBinding(view, next, this.fsIdentity)
        current.binding = next
      },
      // A stale cached catalog replaces the remote without re-running task provisioning.
      replaceHost: () => createHost(hostConfig),
    })
    const unregisterDrain = this.bindRelayDrainAndAutoStop(
      request.sessionKey,
      `${placement.operationId}:${placement.generation ?? '1'}`,
      relay,
      () => lane,
    )
    lane = current = { container, sessionKey: request.sessionKey, canonicalModel: request.canonicalModel,
      operationId: placement.operationId, profileId: placement.profileId, generation: placement.generation ?? '1', dir, view, binding, relay,
      unregisterDrain, lastUsedAt: Date.now(), admitReservationUntil: 0, activeControlRequests: 0 }
    lane.preparationStop = () => host.stop()
    await host.prepareTask(placement.provisionPacket)
    lane.preparationStop = undefined
    await this.listen(relay.toolServer, toolSocketPath, this.fsIdentity.toolSocketUid, this.fsIdentity.toolSocketGid)
      await this.listen(relay.controlServer, join(view, 'relay.sock'), this.fsIdentity.controlSocketUid, this.fsIdentity.controlSocketGid)
    return lane
    } catch (error) {
      if (lane) {
        lane.creationFailed = true
        try { await this.stopLane(lane) }
        catch { this.chat(request.sessionKey).lane = lane } // owner survives for proof retry
      } else {
        // No remote action is possible before the lane owns its preparation stop boundary.
        await this.hooks.onState?.(placement.operationId, 'released', placement.generation)
        const failedView = join(container.handle.mountSource, placement.operationId)
        const check = this.ownerSlot
          ? isLivePeerOwnedLane(failedView, this.ownerSlot, this.ownerInstanceId, this.options.isProcessAlive)
          : undefined
        const liveExternal =
          Boolean(check?.livePeer) ||
          Boolean(this.ownerSlot && !check?.owner && this.isSocketListening(join(failedView, 'relay.sock')))
        if (!liveExternal) {
          rmSync(failedView, { recursive: true, force: true })
        }
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
    const ownerInput = {
      sessionKey: request.sessionKey,
      operationId: placement.operationId,
      generation: placement.generation,
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.writeLaneOwner([dir], ownerInput)
    const binding: CodexRemoteBinding = Object.freeze({ version:3,backendKind:'codex-app-server-v1',
      canonicalModel:request.canonicalModel,sessionKey:request.sessionKey,uid:this.uid,containerDbId:request.containerDbId,
      dockerId:container.dockerId!,operationId:placement.operationId,runId:placement.runId,generation:placement.generation,
      profileId:spec.manifest.profileId,authEpoch:spec.manifest.authEpoch,manifestSha256:codexJsonHash(JSON.stringify(spec.manifest)),
      capability:randomBytes(32).toString('hex'),expiresAt:Date.now()+CC5_BINDING_SLIDING_TTL_MS })
    const finance = this.financeFactory(binding, { upstreamModel:spec.manifest.model }); requireLane(finance)
    const relay = new CodexRemoteRelay(binding,container.keyring,host,spec,join(dir,'journal'),finance,
      id => this.hooks.onNativeThread!(placement.operationId,placement.generation!,id),
      () => this.hooks.onRemoteStart!(placement.operationId,placement.generation!))
    const unregisterDrain = this.bindRelayDrainAndAutoStop(
      request.sessionKey,
      `${placement.operationId}:${placement.generation}`,
      relay,
      () => lane,
    )
    lane = { container,sessionKey:request.sessionKey,canonicalModel:request.canonicalModel,operationId:placement.operationId,
      profileId:placement.profileId,generation:placement.generation,dir,view,binding,relay,unregisterDrain,
      lastUsedAt:Date.now(), admitReservationUntil: 0, activeControlRequests: 0 }
    this.publishLaneViewDir(container.handle.mountSource, placement.operationId, binding, ownerInput)
    await this.listen(relay.controlServer,join(view,'relay.sock'),this.fsIdentity.controlSocketUid,this.fsIdentity.controlSocketGid)
    return lane
    } catch (error) {
      if (lane) {
        lane.creationFailed = true
        try { await this.stopLane(lane) } catch { this.chat(request.sessionKey).lane = lane }
      }
      else {
        // No endpoint/host was exposed. The persistent remote-start CAS remains false.
        const check = this.ownerSlot
          ? isLivePeerOwnedLane(view, this.ownerSlot, this.ownerInstanceId, this.options.isProcessAlive)
          : undefined
        const liveExternal =
          Boolean(check?.livePeer) ||
          Boolean(this.ownerSlot && !check?.owner && this.isSocketListening(join(view, 'relay.sock')))
        if (!liveExternal) {
          rmSync(view, { recursive: true, force: true })
        }
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
        ? RemotePoolSshHost.forLocalSandbox(v4.spec, {
            ...(process.env.OC_REMOTE_RESOURCE_ROOT ? { OC_REMOTE_RESOURCE_ROOT: process.env.OC_REMOTE_RESOURCE_ROOT } : {}),
            ...(process.env.OC_REMOTE_TEST_FAKE_SYSTEMD_DIR ? { OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: process.env.OC_REMOTE_TEST_FAKE_SYSTEMD_DIR } : {}),
            ...(process.env.OC_REMOTE_NODE_MEMORY_BUDGET ? { OC_REMOTE_NODE_MEMORY_BUDGET: process.env.OC_REMOTE_NODE_MEMORY_BUDGET } : {}),
            ...(process.env.OC_REMOTE_TEST_MEM_AVAILABLE_BYTES ? { OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: process.env.OC_REMOTE_TEST_MEM_AVAILABLE_BYTES } : {}),
          })
        : RemotePoolSshHost.forSshTarget(v4.sshTarget, v4.spec)
      const preflight = await host.preflight()
      if (!preflight.memoryOk) throw nodeMemoryError(preflight.activeSessions, preflight.code)
      const ownerInput = {
        sessionKey: request.sessionKey,
        operationId: placement.operationId,
        generation: placement.generation,
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      this.writeLaneOwner([dir], ownerInput)
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
      const unregisterDrain = this.bindRelayDrainAndAutoStop(
        request.sessionKey,
        `${placement.operationId}:${placement.generation}`,
        relay,
        () => lane,
      )
      lane = { container, sessionKey: request.sessionKey, canonicalModel: request.canonicalModel,
        operationId: placement.operationId, profileId: placement.profileId, generation: placement.generation,
        dir, view, binding: v4.binding, relay, isV4: true, unregisterDrain,
        lastUsedAt: Date.now(), admitReservationUntil: 0, activeControlRequests: 0 }
      this.publishLaneViewDir(container.handle.mountSource, placement.operationId, v4.binding, ownerInput)
      await this.listen(relay.controlServer, join(view, 'relay.sock'), this.fsIdentity.controlSocketUid, this.fsIdentity.controlSocketGid)
      return lane
    } catch (error) {
      if (lane) {
        lane.creationFailed = true
        try { await this.stopLane(lane) } catch { this.chat(request.sessionKey).lane = lane }
      } else {
        const check = this.ownerSlot
          ? isLivePeerOwnedLane(view, this.ownerSlot, this.ownerInstanceId, this.options.isProcessAlive)
          : undefined
        const liveExternal =
          Boolean(check?.livePeer) ||
          Boolean(this.ownerSlot && !check?.owner && this.isSocketListening(join(view, 'relay.sock')))
        if (!liveExternal) {
          rmSync(view, { recursive: true, force: true })
        }
        try { await this.hooks.onState?.(placement.operationId, 'released', placement.generation, true) } catch { /* durable no-effect CAS permits recovery */ }
      }
      throw error
    }
  }

  /**
   * Ensures a lane stopped directly by the container over `relay.sock` (`/stop` + `/tool/stopped`)
   * immediately stops blocking `RemoteReleaseDrainCoordinator`, and schedules serialized `stopLane`
   * cleanup after any in-flight `/stop` HTTP response flushes so `unregisterDrain` + PG `'released'`
   * happen without waiting for a future turn on the same chat.
   */
  private bindRelayDrainAndAutoStop(
    sessionKey: string,
    drainId: string,
    relay: Lane['relay'],
    getLane: () => Lane | undefined,
  ): (() => void) | undefined {
    let stopProven = false
    let activeStopHttp = 0
    let stopRequestedByClient = false
    let cleanupScheduled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const clearGraceTimer = (): void => {
      if (!graceTimer) return
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    const scheduleCleanup = (): void => {
      if (cleanupScheduled || activeStopHttp > 0) return
      cleanupScheduled = true
      clearGraceTimer()
      setImmediate(() => {
        if (activeStopHttp > 0) {
          cleanupScheduled = false
          return
        }
        const owner = this.chats.get(sessionKey)
        const target = getLane()
        if (!owner || !target) {
          cleanupScheduled = false
          return
        }
        void this.serial(owner, async () => {
          if (activeStopHttp > 0) {
            cleanupScheduled = false
            return
          }
          if (owner.lane !== target || target.stopping) return
          try {
            await this.stopLane(target)
            if (owner.lane === target) owner.lane = undefined
          } catch {
            cleanupScheduled = false
            // Retain unproved lane on owner for subsequent retry/release.
          }
        })
      })
    }
    relay.controlServer.on('request', (req, res) => {
      const target = getLane()
      const isStreamingEndpoint = req.url === '/session/open' || req.url === '/poll'
      if (target) {
        if (req.url === '/stop' || isStreamingEndpoint) {
          target.admitReservationUntil = 0
        }
        if (!isStreamingEndpoint) {
          target.activeControlRequests += 1
        }
      }
      let reqFinished = false
      const finishControlRequest = (): void => {
        if (reqFinished) return
        reqFinished = true
        const current = getLane()
        if (current) {
          if (!isStreamingEndpoint) {
            current.activeControlRequests = Math.max(0, current.activeControlRequests - 1)
          }
          current.admitReservationUntil = 0
        }
      }
      res.once('finish', finishControlRequest)
      res.once('close', finishControlRequest)

      if (req.url !== '/stop' && req.url !== '/tool/stopped') return
      if (req.url === '/stop') stopRequestedByClient = true
      clearGraceTimer()
      activeStopHttp += 1
      let doneCalled = false
      const done = (): void => {
        if (doneCalled) return
        doneCalled = true
        activeStopHttp = Math.max(0, activeStopHttp - 1)
        if (stopProven && activeStopHttp === 0) {
          scheduleCleanup()
        }
      }
      res.once('finish', done)
      res.once('close', done)
    })
    const rawStop = relay.stop.bind(relay)
    ;(relay as { stop: Lane['relay']['stop'] }).stop = () =>
      rawStop().then((res) => {
        if (res.remoteStopped === true) {
          stopProven = true
          if (activeStopHttp === 0) {
            if (stopRequestedByClient) {
              scheduleCleanup()
            } else if (!cleanupScheduled && !graceTimer) {
              graceTimer = setTimeout(scheduleCleanup, 250)
              graceTimer.unref()
            }
          }
        }
        return res
      })
    const rawUnregister = this.hooks.registerDrainRelay?.(drainId, {
      get idle(): boolean {
        if (stopProven) return true
        const target = getLane()
        if (!target) return relay.idle
        return (
          relay.idle &&
          target.activeControlRequests === 0 &&
          Date.now() >= target.admitReservationUntil
        )
      },
    })
    return () => {
      clearGraceTimer()
      rawUnregister?.()
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
        server.closeIdleConnections()
        const forceTimer = setTimeout(() => server.closeAllConnections(), 200)
        forceTimer.unref()
        try {
          await new Promise<void>((resolve) => server.close(() => resolve()))
        } finally {
          clearTimeout(forceTimer)
        }
      }
      rmSync(lane.view, { recursive: true, force: true })
      if (this.ownerSlot) {
        rmSync(join(lane.dir, LANE_OWNER_FILENAME), { force: true })
      }
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
          requireRuntime(socket.isSocket() && socket.uid === this.fsIdentity.ownerUid && socket.nlink === 1)
          chmodSync(path, 0o600)
          chownSync(path, uid, gid) // Only this newly-created socket; never the directory/files.
          resolve()
        } catch {
          reject(new Error(REJECTED))
        }
      })
    })
  }

  private findReleasingContainerOnDisk(containerDbId: string): ContainerState | undefined {
    try {
      for (const entry of readdirSync(this.options.baseRoot)) {
        if (!/^[a-f0-9]{24}$/.test(entry)) continue
        const root = join(this.options.baseRoot, entry)
        try {
          const st = lstatSync(root)
          if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== this.fsIdentity.ownerUid) continue
          if (existsSync(join(root, 'released.json')) || !existsSync(join(root, 'releasing.json'))) continue
          const prepared = readJson(join(root, 'prepared.json'))
          if (String(prepared.uid) !== this.uid || String(prepared.containerDbId) !== containerDbId) continue
          const mountSource = join(root, 'view')
          const authority = existsSync(join(mountSource, 'authority-public.json'))
            ? readJson(join(mountSource, 'authority-public.json'))
            : undefined
          const keyring = authority ? parseAuthorityKeyring(String(authority.keyring)) : new Map()
          let dockerId: string | undefined
          for (const file of ['activated.json', 'bound.json']) {
            const p = join(root, file)
            if (existsSync(p)) {
              const parsed = readJson(p)
              if (typeof parsed.dockerId === 'string' && /^[a-f0-9]{64}$/.test(parsed.dockerId)) {
                dockerId = parsed.dockerId
                break
              }
            }
          }
          const handle = Object.freeze({ mountSource, containerDbId })
          const record: ContainerState = { handle, root, keyring, dockerId, state: 'released' }
          this.containers.set(containerDbId, record)
          this.handles.set(handle, record)
          return record
        } catch {
          // Ignore unreadable entries.
        }
      }
    } catch {
      // Ignore baseRoot scan errors.
    }
    return undefined
  }

  private writeReleasingTombstone(root: string): void {
    const tombstone = join(root, 'releasing.json')
    if (existsSync(tombstone) || existsSync(join(root, 'released.json'))) return
    try {
      writePrivate(tombstone, { version: 1, ts: Date.now() }, false, this.fsIdentity)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
    }
  }

  release(
    containerDbId: string,
    dockerId?: string,
    opts?: {
      readonly skipViewCleanup?: boolean
      readonly peerCleanup?: () => Promise<boolean>
    },
  ): Promise<void> {
    let record = this.containers.get(containerDbId)
    if (!record && this.ownerSlot) {
      this.refreshAdoptedContainers()
      record = this.containers.get(containerDbId) ?? this.findReleasingContainerOnDisk(containerDbId)
    }
    if (!record) return Promise.resolve()
    requireRuntime(!dockerId || !record.dockerId || record.dockerId === dockerId)
    if (record.release) return record.release
    this.writeReleasingTombstone(record.root)
    record.state = 'released' // No new lane from here on; a lane still starting stops itself.
    const skipViewCleanup = opts?.skipViewCleanup === true
    const strictConvergence = Boolean(this.ownerSlot || skipViewCleanup || opts?.peerCleanup)
    const run = (async () => {
      // On each chat's own tail, after any placement already queued there for this container.
      const stopResults = await Promise.allSettled([...this.chats.values()].map((owner) => this.serial(owner, async () => {
        if (owner.lane?.container !== record) return
        const lane = owner.lane
        lane.admitReservationUntil = 0
        if (strictConvergence) {
          // B8: Retain owner.lane until remote stop, PG state persistence, and view/owner cleanup
          // all succeed so a transient PG/stop error stays retryable and convergent.
          await this.stopLane(lane)
          if (owner.lane === lane) owner.lane = undefined
          return
        }
        owner.lane = undefined
        try { await this.stopLane(lane) }
        finally {
          // Legacy single-process release closes transport even when capacity remains quarantined in PG.
          lane.unregisterDrain?.()
          lane.unregisterDrain = undefined
          for (const server of [lane.relay.controlServer, 'toolServer' in lane.relay ? lane.relay.toolServer : undefined]) {
            if (!server?.listening) continue
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
          }
        }
      })))
      if (strictConvergence) {
        const failed = stopResults.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        )
        if (failed) {
          record.release = undefined
          throw failed.reason
        }
      }
      if (skipViewCleanup) {
        record.release = undefined
        return
      }
      if (opts?.peerCleanup) {
        let peerOk = false
        try {
          peerOk = (await opts.peerCleanup()) === true
        } catch {
          peerOk = false
        }
        if (!peerOk || this.hasLivePeerOwnedLane({ containerDbId })) {
          record.release = undefined
          throw new Error(REMOTE_LANE_PEER_RELEASE_UNPROVEN)
        }
      } else if (this.ownerSlot && this.hasLivePeerOwnedLane({ containerDbId })) {
        record.release = undefined
        throw new Error(REMOTE_LANE_PEER_RELEASE_UNPROVEN)
      }
      rmSync(record.handle.mountSource, { recursive: true, force: true })
      rmSync(join(record.root, 'lanes'), { recursive: true, force: true })
      if (!existsSync(join(record.root, 'released.json'))) {
        writePrivate(join(record.root, 'released.json'), { version: 1 }, false, this.fsIdentity)
      }
      rmSync(join(record.root, 'releasing.json'), { force: true })
    })()
    record.release = run
    return run
  }
}
