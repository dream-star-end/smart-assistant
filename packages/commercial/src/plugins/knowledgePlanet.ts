import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { type Duplex, Writable } from 'node:stream'

import type Docker from 'dockerode'

import { type BrowserStorageStateV1, validateBrowserStorageState } from './accounts.js'
import { type ManagedBrowserBrokerHandle, createManagedBrowserTlsBroker } from './browserBroker.js'
import {
  type ManagedBrowserDriverV1,
  type ManagedBrowserLaunchArgs,
  type ManagedBrowserLauncherV1,
  type ManagedBrowserPinnedOrigin,
  ManagedBrowserRuntimeError,
  type ManagedBrowserSession,
  REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
} from './browserRuntime.js'
import { KNOWLEDGE_PLANET_WORKER_SOURCE } from './knowledgePlanetWorkerSource.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const WORKER_FILE = 'knowledge-planet-worker.mjs'
const WORKER_RUNTIME = 'knowledge-planet-worker-v1.2'
const EXPECTED_PLAYWRIGHT_MCP_VERSION = '0.0.76'
const WORKER_MAX_FRAME_BYTES = 1024 * 1024
const WORKER_STDERR_MAX_BYTES = 64 * 1024
const WORKER_LABEL = 'com.openclaude.plugin.worker'
const WORKER_LABEL_VALUE = 'knowledge-planet-v1.2'
const RECLAIMABLE_WORKER_LABEL_VALUES = new Set([
  'knowledge-planet-v1',
  'knowledge-planet-v1.1',
  WORKER_LABEL_VALUE,
])
const WORKER_EXPIRY_LABEL = 'com.openclaude.plugin.expires_at_ms'
const WORKER_BOOT_LABEL = 'com.openclaude.plugin.boot_id'
const WORKER_SESSION_LABEL = 'com.openclaude.plugin.session_id'
const WORKER_DIGEST_LABEL = 'com.openclaude.plugin.worker_digest'

import {
  KNOWLEDGE_PLANET_DRIVER_ID,
  KNOWLEDGE_PLANET_DRIVER_VERSION,
  KNOWLEDGE_PLANET_LAUNCHER_ID,
  KNOWLEDGE_PLANET_LAUNCHER_VERSION,
  KNOWLEDGE_PLANET_LOGIN_ORIGINS,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
} from './knowledgePlanetContract.js'
export {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_DRIVER_ID,
  KNOWLEDGE_PLANET_DRIVER_VERSION,
  KNOWLEDGE_PLANET_LAUNCHER_ID,
  KNOWLEDGE_PLANET_LAUNCHER_VERSION,
  KNOWLEDGE_PLANET_LOGIN_ORIGINS,
  KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_PLUGIN_VERSION,
  KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  classifyKnowledgePlanetSetupPin,
  isOfficialKnowledgePlanetPluginIdentity,
} from './knowledgePlanetContract.js'

export class KnowledgePlanetRuntimeError extends Error {
  readonly code:
    | 'UNAVAILABLE'
    | 'CAPACITY_EXCEEDED'
    | 'IMAGE_MISMATCH'
    | 'PROTOCOL'
    | 'EXECUTION_FAILED'
    | 'LOGIN_EXPIRED'
    | 'LOGIN_EXPIRED_ACCOUNT'
    | 'CLOSING'
    | 'CLEANUP_FAILED'

  constructor(code: KnowledgePlanetRuntimeError['code'], message: string = code) {
    super(message)
    this.name = 'KnowledgePlanetRuntimeError'
    this.code = code
  }
}

interface ReadyEvent {
  event: 'ready'
  runtime: typeof WORKER_RUNTIME
  playwrightMcpVersion: typeof EXPECTED_PLAYWRIGHT_MCP_VERSION
}

interface FailedEvent {
  event: 'failed'
  code: 'WORKER_FAILED' | 'LOGIN_EXPIRED' | 'UPSTREAM_FAILED'
}

interface CompletedEvent {
  event: 'completed'
  result: unknown
  storageState: unknown
}

interface QrEvent {
  event: 'qr'
  png: Buffer
}

interface AuthenticatedEvent {
  event: 'authenticated'
  storageState: unknown
}

type WorkerEvent = ReadyEvent | FailedEvent | CompletedEvent | QrEvent | AuthenticatedEvent

function plainEvent(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker emitted an invalid frame')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker emitted an invalid frame')
  return value as Record<string, unknown>
}

function exactEventKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker frame fields are invalid')
}

function parseWorkerEvent(value: unknown): WorkerEvent {
  const event = plainEvent(value)
  if (event.event === 'ready') {
    exactEventKeys(event, ['event', 'runtime', 'playwrightMcpVersion'])
    if (
      event.runtime !== WORKER_RUNTIME ||
      event.playwrightMcpVersion !== EXPECTED_PLAYWRIGHT_MCP_VERSION
    )
      throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker compatibility handshake failed')
    return event as unknown as ReadyEvent
  }
  if (event.event === 'failed') {
    exactEventKeys(event, ['event', 'code'])
    if (!['WORKER_FAILED', 'LOGIN_EXPIRED', 'UPSTREAM_FAILED'].includes(String(event.code)))
      throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker failure code is invalid')
    return event as unknown as FailedEvent
  }
  if (event.event === 'completed') {
    exactEventKeys(event, ['event', 'result', 'storageState'])
    return event as unknown as CompletedEvent
  }
  if (event.event === 'authenticated') {
    exactEventKeys(event, ['event', 'storageState'])
    return event as unknown as AuthenticatedEvent
  }
  if (event.event === 'qr') {
    exactEventKeys(event, ['event', 'png'])
    if (typeof event.png !== 'string' || event.png.length > 700_000)
      throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker QR frame is invalid')
    const png = Buffer.from(event.png, 'base64')
    if (
      png.length < 8 ||
      png.length > 512 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker QR image is invalid')
    return { event: 'qr', png }
  }
  throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker event is unsupported')
}

class FrameDecoder {
  private buffered = Buffer.alloc(0)
  private expected: number | null = null

  constructor(private readonly onEvent: (event: WorkerEvent) => void) {}

  push(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk])
    while (true) {
      if (this.expected === null) {
        if (this.buffered.length < 4) return
        this.expected = this.buffered.readUInt32BE(0)
        if (this.expected < 2 || this.expected > WORKER_MAX_FRAME_BYTES)
          throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker frame size is invalid')
      }
      if (this.buffered.length < this.expected + 4) return
      const body = this.buffered.subarray(4, this.expected + 4)
      this.buffered = this.buffered.subarray(this.expected + 4)
      this.expected = null
      let value: unknown
      try {
        value = JSON.parse(body.toString('utf8'))
      } catch {
        throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker frame is not JSON')
      }
      this.onEvent(parseWorkerEvent(value))
      if (this.buffered.length === 0) return
    }
  }

  finish(): void {
    if (this.buffered.length !== 0 || this.expected !== null)
      throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker output ended mid-frame')
  }
}

/** Regression seam: a stream chunk may legally coalesce multiple bounded frames. */
export function decodeKnowledgePlanetWorkerFramesForTest(chunk: Buffer): number {
  let count = 0
  const decoder = new FrameDecoder(() => {
    count++
  })
  decoder.push(chunk)
  decoder.finish()
  return count
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > 512 * 1024)
    throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker input exceeds limit')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

async function safeRoot(rootInput: string, expectedOwnerUid: number): Promise<string> {
  if (!isAbsolute(rootInput))
    throw new KnowledgePlanetRuntimeError('UNAVAILABLE', 'worker root must be absolute')
  const root = resolve(rootInput)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const before = await lstat(root)
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== expectedOwnerUid ||
    (before.mode & 0o777) !== 0o700 ||
    (await realpath(root)) !== root
  )
    throw new KnowledgePlanetRuntimeError('UNAVAILABLE', 'worker root is unsafe')
  return root
}

async function materializeWorker(
  rootInput: string,
  expectedOwnerUid: number,
): Promise<{ digest: string; directory: string }> {
  const root = await safeRoot(rootInput, expectedOwnerUid)
  const digest = createHash('sha256').update(KNOWLEDGE_PLANET_WORKER_SOURCE).digest('hex')
  if (digest !== KNOWLEDGE_PLANET_WORKER_DIGEST)
    throw new KnowledgePlanetRuntimeError('UNAVAILABLE', 'worker implementation pin mismatch')
  const directory = join(root, digest)
  const workerPath = join(directory, WORKER_FILE)
  const existing = await readFile(workerPath, 'utf8').catch(() => null)
  if (existing === KNOWLEDGE_PLANET_WORKER_SOURCE) {
    const stat = await lstat(workerPath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedOwnerUid ||
      (stat.mode & 0o777) !== 0o444 ||
      (await realpath(directory)) !== directory
    )
      throw new KnowledgePlanetRuntimeError('UNAVAILABLE', 'materialized worker is unsafe')
    return { digest, directory }
  }
  const staging = `${directory}.tmp-${randomUUID()}`
  await mkdir(staging, { mode: 0o700 })
  try {
    await writeFile(join(staging, WORKER_FILE), KNOWLEDGE_PLANET_WORKER_SOURCE, {
      encoding: 'utf8',
      mode: 0o444,
      flag: 'wx',
    })
    await chmod(staging, 0o555)
    await rename(staging, directory).catch(async (error: unknown) => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const materialized = await readFile(workerPath, 'utf8')
  if (
    materialized !== KNOWLEDGE_PLANET_WORKER_SOURCE ||
    createHash('sha256').update(materialized).digest('hex') !== digest
  )
    throw new KnowledgePlanetRuntimeError('UNAVAILABLE', 'worker materialization failed')
  return { digest, directory }
}

interface ActiveWorker {
  container: Docker.Container
  broker: ManagedBrowserBrokerHandle
  done: Promise<WorkerEvent[]>
  kind: 'action' | 'login'
}

export interface KnowledgePlanetLoginWorkerHandle {
  sessionId: string
  done: Promise<void>
  stop(): Promise<void>
}

export class KnowledgePlanetDockerService {
  private readonly bootId = randomUUID()
  private readonly active = new Map<string, ActiveWorker>()
  private readonly reserved = new Map<string, 'action' | 'login'>()
  private readonly starting = new Set<Promise<ActiveWorker>>()
  private initialized: Promise<{ digest: string; directory: string }> | null = null
  private closing = false

  constructor(
    private readonly docker: Docker,
    private readonly opts: {
      imageId: string
      workerRoot: string
      brokerRoot: string
      expectedOwnerUid?: number
      socketUid?: number
      socketGid?: number
      orphanGraceMs?: number
      maxWorkers?: number
      maxLoginWorkers?: number
      maxActionWorkers?: number
    },
  ) {}

  private reserveWorker(key: string, kind: 'action' | 'login'): void {
    if (this.closing) throw new KnowledgePlanetRuntimeError('CLOSING')
    if (this.active.has(key) || this.reserved.has(key))
      throw new KnowledgePlanetRuntimeError('EXECUTION_FAILED', 'worker key is already active')
    const total = this.active.size + this.reserved.size
    const kindTotal =
      [...this.active.values()].filter((worker) => worker.kind === kind).length +
      [...this.reserved.values()].filter((reservedKind) => reservedKind === kind).length
    const totalLimit = this.opts.maxWorkers ?? 4
    const kindLimit =
      kind === 'login' ? (this.opts.maxLoginWorkers ?? 2) : (this.opts.maxActionWorkers ?? 4)
    if (total >= totalLimit || kindTotal >= kindLimit)
      throw new KnowledgePlanetRuntimeError(
        'CAPACITY_EXCEEDED',
        'managed-browser worker capacity is full',
      )
    this.reserved.set(key, kind)
  }

  /** Fixed Docker names make the total cap atomic across rolling master processes. */
  private async createContainerInHostSlot(
    options: Docker.ContainerCreateOptions,
  ): Promise<Docker.Container> {
    const limit = this.opts.maxWorkers ?? 4
    const attempt = async (): Promise<Docker.Container | null> => {
      for (let slot = 0; slot < limit; slot++) {
        try {
          return await this.docker.createContainer({
            ...options,
            name: `oc-v5-kp-worker-slot-${slot}`,
          })
        } catch (error) {
          if ((error as { statusCode?: unknown })?.statusCode !== 409) throw error
        }
      }
      return null
    }
    const available = await attempt()
    if (available) return available
    // Fixed names survive a non-graceful master exit. Reclaim only workers whose signed
    // deadline plus grace has elapsed, then retry exactly once; live old-master work wins.
    if ((await this.gcExpiredOrphans()) > 0) {
      const recovered = await attempt()
      if (recovered) return recovered
    }
    throw new KnowledgePlanetRuntimeError(
      'CAPACITY_EXCEEDED',
      'managed-browser host worker capacity is full',
    )
  }

  private async initialize(): Promise<{ digest: string; directory: string }> {
    if (this.closing) throw new KnowledgePlanetRuntimeError('CLOSING')
    if (!this.initialized) {
      this.initialized = (async () => {
        if (!IMAGE_ID_RE.test(this.opts.imageId))
          throw new KnowledgePlanetRuntimeError(
            'IMAGE_MISMATCH',
            'managed-browser image must be an exact sha256 ID',
          )
        const image = await this.docker
          .getImage(this.opts.imageId)
          .inspect()
          .catch(() => null)
        if (!image || image.Id !== this.opts.imageId)
          throw new KnowledgePlanetRuntimeError(
            'IMAGE_MISMATCH',
            'managed-browser exact image is unavailable',
          )
        await this.gcExpiredOrphans()
        return materializeWorker(this.opts.workerRoot, this.opts.expectedOwnerUid ?? 0)
      })().catch((error) => {
        this.initialized = null
        throw error
      })
    }
    return this.initialized
  }

  async gcExpiredOrphans(now = Date.now()): Promise<number> {
    const grace = this.opts.orphanGraceMs ?? 30_000
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [WORKER_LABEL] }),
    })
    let removed = 0
    for (const summary of containers) {
      if (!RECLAIMABLE_WORKER_LABEL_VALUES.has(summary.Labels?.[WORKER_LABEL] ?? '')) continue
      const expiry = Number(summary.Labels?.[WORKER_EXPIRY_LABEL])
      if (!Number.isFinite(expiry) || expiry + grace >= now) continue
      const container = this.docker.getContainer(summary.Id)
      await container.kill().catch(() => {})
      await container.remove({ force: true }).catch(() => {})
      const remains = await container.inspect().catch(() => null)
      if (remains) throw new KnowledgePlanetRuntimeError('CLEANUP_FAILED', 'expired worker remains')
      removed++
    }
    return removed
  }

  private async startWorker(args: {
    key: string
    kind: 'action' | 'login'
    pins: readonly ManagedBrowserPinnedOrigin[]
    deadlineMs: number
    input: Record<string, unknown>
    onEvent?: (event: WorkerEvent) => void
    signal?: AbortSignal
  }): Promise<ActiveWorker> {
    if (args.signal?.aborted) throw args.signal.reason
    this.reserveWorker(args.key, args.kind)
    const started = this.startReservedWorker(args)
    const tracked = started.finally(() => {
      this.reserved.delete(args.key)
      this.starting.delete(tracked)
    })
    this.starting.add(tracked)
    return tracked
  }

  private async startReservedWorker(args: {
    key: string
    kind: 'action' | 'login'
    pins: readonly ManagedBrowserPinnedOrigin[]
    deadlineMs: number
    input: Record<string, unknown>
    onEvent?: (event: WorkerEvent) => void
    signal?: AbortSignal
  }): Promise<ActiveWorker> {
    const materialized = await this.initialize()
    if (args.signal?.aborted) throw args.signal.reason
    if (this.closing) throw new KnowledgePlanetRuntimeError('CLOSING')
    const sessionId = randomUUID()
    const broker = await createManagedBrowserTlsBroker({
      root: this.opts.brokerRoot,
      invocationId: sessionId,
      pins: args.pins,
      expectedOwnerUid: this.opts.expectedOwnerUid ?? 0,
      socketUid: this.opts.socketUid ?? 1000,
      socketGid: this.opts.socketGid ?? 1000,
    })
    if (args.signal?.aborted) {
      await broker.close()
      throw args.signal.reason
    }
    let container: Docker.Container | null = null
    let stream: Duplex | null = null
    let cleanupFailure: unknown = null
    try {
      container = await this.createContainerInHostSlot({
        Image: this.opts.imageId,
        User: '1000:1000',
        WorkingDir: '/state',
        Env: [
          'HOME=/state',
          'PATH=/usr/local/bin:/usr/bin:/bin',
          'LANG=C.UTF-8',
          'LC_ALL=C.UTF-8',
          'NO_PROXY=',
          'HTTP_PROXY=',
          'HTTPS_PROXY=',
          'ALL_PROXY=',
        ],
        Entrypoint: [],
        Cmd: ['/usr/local/bin/node', `/runtime/${WORKER_FILE}`],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: true,
        StdinOnce: true,
        Tty: false,
        NetworkDisabled: true,
        Healthcheck: { Test: ['NONE'] },
        Labels: {
          [WORKER_LABEL]: WORKER_LABEL_VALUE,
          [WORKER_BOOT_LABEL]: this.bootId,
          [WORKER_SESSION_LABEL]: sessionId,
          [WORKER_EXPIRY_LABEL]: String(args.deadlineMs),
          [WORKER_DIGEST_LABEL]: materialized.digest,
          'com.openclaude.plugin.worker_kind': args.kind,
        },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [],
          SecurityOpt: ['no-new-privileges'],
          Privileged: false,
          Memory: args.kind === 'login' ? 768 * 1024 * 1024 : 384 * 1024 * 1024,
          MemorySwap: args.kind === 'login' ? 768 * 1024 * 1024 : 384 * 1024 * 1024,
          MemorySwappiness: 0,
          NanoCpus: 1_000_000_000,
          PidsLimit: args.kind === 'login' ? 256 : 128,
          Tmpfs: {
            '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=1000,gid=1000',
            '/state': 'rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=1000,gid=1000',
          },
          Mounts: [
            {
              Type: 'bind',
              Source: materialized.directory,
              Target: '/runtime',
              ReadOnly: true,
              BindOptions: { Propagation: 'rprivate' },
            },
            {
              Type: 'bind',
              Source: broker.mount.hostDirectory,
              Target: dirname(broker.mount.containerSocketPath),
              ReadOnly: true,
              BindOptions: { Propagation: 'rprivate' },
            },
          ],
          RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          LogConfig: { Type: 'none', Config: {} },
          AutoRemove: false,
          ShmSize: args.kind === 'login' ? 256 * 1024 * 1024 : 64 * 1024 * 1024,
        },
      })
      if (args.signal?.aborted) throw args.signal.reason
      const current = container
      stream = (await current.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
      })) as Duplex
      if (args.signal?.aborted) throw args.signal.reason
      const events: WorkerEvent[] = []
      let protocolFailure: unknown = null
      let stderrBytes = 0
      const decoder = new FrameDecoder((event) => {
        if (events.length === 0 && event.event !== 'ready')
          throw new KnowledgePlanetRuntimeError(
            'PROTOCOL',
            'worker omitted compatibility handshake',
          )
        if (events.some((item) => ['failed', 'completed', 'authenticated'].includes(item.event)))
          throw new KnowledgePlanetRuntimeError(
            'PROTOCOL',
            'worker emitted data after terminal event',
          )
        events.push(event)
        args.onEvent?.(event)
      })
      const stdout = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          try {
            decoder.push(Buffer.from(chunk))
            callback()
          } catch (error) {
            protocolFailure = error
            void current.kill().catch(() => {})
            callback()
          }
        },
      })
      const stderr = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          stderrBytes += chunk.length
          if (stderrBytes > WORKER_STDERR_MAX_BYTES) void current.kill().catch(() => {})
          callback()
        },
      })
      this.docker.modem.demuxStream(stream, stdout, stderr)
      const streamEnded = new Promise<void>((resolveEnd, rejectEnd) => {
        stream!.once('end', resolveEnd)
        stream!.once('error', rejectEnd)
      })
      await current.start()
      if (args.signal?.aborted) throw args.signal.reason
      const input = frame({ ...args.input, token: broker.mount.token, deadlineMs: args.deadlineMs })
      await new Promise<void>((resolveWrite, reject) => {
        stream!.write(input, (error) => (error ? reject(error) : resolveWrite()))
      })
      if (args.signal?.aborted) throw args.signal.reason
      const done = (async (): Promise<WorkerEvent[]> => {
        let completed: WorkerEvent[] | null = null
        let failure: unknown = null
        try {
          const remaining = Math.max(1_000, args.deadlineMs - Date.now() + 5_000)
          let timer: NodeJS.Timeout | undefined
          const result = await Promise.race([
            current.wait(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                void current.kill().catch(() => {})
                reject(new KnowledgePlanetRuntimeError('EXECUTION_FAILED', 'worker deadline'))
              }, remaining)
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          await Promise.race([
            streamEnded,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new KnowledgePlanetRuntimeError('PROTOCOL', 'worker stream timeout')),
                2_000,
              )
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          decoder.finish()
          if (protocolFailure) throw protocolFailure
          if (stderrBytes > WORKER_STDERR_MAX_BYTES)
            throw new KnowledgePlanetRuntimeError('PROTOCOL', 'worker stderr exceeded limit')
          const status = (result as { StatusCode?: number }).StatusCode ?? -1
          const terminal = events.at(-1)
          if (
            status !== 0 ||
            !terminal ||
            !['failed', 'completed', 'authenticated'].includes(terminal.event)
          )
            throw new KnowledgePlanetRuntimeError('EXECUTION_FAILED', 'worker did not finish')
          completed = events
        } catch (error) {
          failure = error
        } finally {
          stream?.destroy()
          await current.remove({ force: true }).catch((error) => {
            cleanupFailure ??= error
          })
          if (await current.inspect().catch(() => null))
            cleanupFailure ??= new Error('container remains')
          try {
            await broker.close()
          } catch (error) {
            cleanupFailure ??= error
          }
          if (!cleanupFailure) this.active.delete(args.key)
        }
        if (cleanupFailure)
          throw new KnowledgePlanetRuntimeError('CLEANUP_FAILED', 'worker cleanup failed')
        if (!completed) throw failure
        return completed
      })()
      const active = { container: current, broker, done, kind: args.kind }
      if (args.signal?.aborted) throw args.signal.reason
      this.active.set(args.key, active)
      return active
    } catch (error) {
      stream?.destroy()
      let cleanupFailed = false
      if (container) {
        await container.remove({ force: true }).catch(() => {})
        if (await container.inspect().catch(() => null)) cleanupFailed = true
      }
      await broker.close().catch(() => {
        cleanupFailed = true
      })
      if (cleanupFailed)
        throw new KnowledgePlanetRuntimeError('CLEANUP_FAILED', 'worker startup cleanup failed')
      throw error
    }
  }

  async runAction(args: {
    profileDir: string
    pins: readonly ManagedBrowserPinnedOrigin[]
    storageState: BrowserStorageStateV1
    actionId: string
    params: Record<string, unknown>
    deadlineMs: number
    signal?: AbortSignal
  }): Promise<{ result: unknown; storageState: unknown }> {
    const worker = await this.startWorker({
      key: args.profileDir,
      kind: 'action',
      pins: args.pins,
      deadlineMs: args.deadlineMs,
      ...(args.signal ? { signal: args.signal } : {}),
      input: {
        mode: 'action',
        actionId: args.actionId,
        params: args.params,
        storageState: args.storageState,
        cookieDomains: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState.cookieDomains,
        stateOrigins: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState.origins,
      },
    })
    const terminal = (await worker.done).at(-1)!
    if (terminal.event === 'failed') {
      if (terminal.code === 'LOGIN_EXPIRED')
        throw new KnowledgePlanetRuntimeError('LOGIN_EXPIRED_ACCOUNT', 'Plugin login expired')
      throw new KnowledgePlanetRuntimeError('EXECUTION_FAILED', 'Knowledge Planet read failed')
    }
    if (terminal.event !== 'completed')
      throw new KnowledgePlanetRuntimeError('PROTOCOL', 'action worker terminal event is invalid')
    return { result: terminal.result, storageState: terminal.storageState }
  }

  async startLogin(args: {
    sessionId: string
    pins: readonly ManagedBrowserPinnedOrigin[]
    deadlineMs: number
    onQr: (png: Buffer) => void
    onAuthenticated: (storageState: unknown) => void
    onFailed: (code: string) => void
  }): Promise<KnowledgePlanetLoginWorkerHandle> {
    const worker = await this.startWorker({
      key: `login:${args.sessionId}`,
      kind: 'login',
      pins: args.pins,
      deadlineMs: args.deadlineMs,
      input: {
        mode: 'login',
        allowedOrigins: KNOWLEDGE_PLANET_LOGIN_ORIGINS.map((origin) => new URL(origin).origin),
        cookieDomains: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState.cookieDomains,
        stateOrigins: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState.origins,
      },
      onEvent: (event) => {
        if (event.event === 'qr') args.onQr(event.png)
        else if (event.event === 'authenticated') args.onAuthenticated(event.storageState)
        else if (event.event === 'failed') args.onFailed(event.code)
      },
    })
    return {
      sessionId: args.sessionId,
      done: worker.done.then(() => undefined),
      stop: () => this.terminate(`login:${args.sessionId}`),
    }
  }

  async terminate(key: string): Promise<void> {
    const active = this.active.get(key)
    if (!active) return
    await active.container.kill().catch(() => {})
    await active.done.catch(() => {})
    if (this.active.has(key)) {
      let cleanupFailure = false
      await active.container.remove({ force: true }).catch(() => {
        cleanupFailure = true
      })
      if (await active.container.inspect().catch(() => null)) cleanupFailure = true
      await active.broker.close().catch(() => {
        cleanupFailure = true
      })
      if (!cleanupFailure) this.active.delete(key)
    }
    if (this.active.has(key))
      throw new KnowledgePlanetRuntimeError('CLEANUP_FAILED', 'worker termination did not drain')
  }

  async closeAndDrain(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.starting])
    const keys = [...this.active.keys()]
    await Promise.all(keys.map((key) => this.terminate(key)))
    if (this.active.size !== 0)
      throw new KnowledgePlanetRuntimeError('CLEANUP_FAILED', 'workers remain during shutdown')
  }
}

class KnowledgePlanetManagedSession implements ManagedBrowserSession {
  readonly driverSession = this
  private completed: { result: unknown; storageState: unknown } | null = null
  private executing = false

  constructor(
    private readonly service: KnowledgePlanetDockerService,
    private readonly args: ManagedBrowserLaunchArgs,
  ) {}

  async execute(
    actionId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.executing || this.completed)
      throw new ManagedBrowserRuntimeError('EXECUTION_FAILED', 'browser session is single use')
    this.executing = true
    const abort = () => {
      void this.service.terminate(this.args.profileDir).catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.completed = await this.service.runAction({
        profileDir: this.args.profileDir,
        pins: this.args.pins,
        storageState: this.args.storageState,
        actionId,
        params,
        deadlineMs: Date.now() + 120_000,
        signal,
      })
      return this.completed.result
    } finally {
      signal.removeEventListener('abort', abort)
      this.executing = false
    }
  }

  async exportStorageState(): Promise<unknown> {
    if (!this.completed)
      throw new ManagedBrowserRuntimeError('EXECUTION_FAILED', 'browser session did not complete')
    return this.completed.storageState
  }

  async close(): Promise<void> {
    await this.service.terminate(this.args.profileDir)
  }
}

export function createKnowledgePlanetRuntimeRegistries(service: KnowledgePlanetDockerService): {
  drivers: ReadonlyMap<string, ManagedBrowserDriverV1>
  launchers: ReadonlyMap<string, ManagedBrowserLauncherV1>
} {
  const launcher: ManagedBrowserLauncherV1 = {
    id: KNOWLEDGE_PLANET_LAUNCHER_ID,
    version: KNOWLEDGE_PLANET_LAUNCHER_VERSION,
    capabilities: REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
    async launch(args) {
      return new KnowledgePlanetManagedSession(service, args)
    },
    terminate: (profileDir) => service.terminate(profileDir),
  }
  const driver: ManagedBrowserDriverV1 = {
    id: KNOWLEDGE_PLANET_DRIVER_ID,
    version: KNOWLEDGE_PLANET_DRIVER_VERSION,
    launcherId: KNOWLEDGE_PLANET_LAUNCHER_ID,
    launcherVersion: KNOWLEDGE_PLANET_LAUNCHER_VERSION,
    maximumNetwork: { origins: ['https://api.zsxq.com'], methods: ['GET', 'POST'] },
    async execute(args) {
      if (!(args.session instanceof KnowledgePlanetManagedSession))
        throw new ManagedBrowserRuntimeError('EXECUTION_FAILED', 'driver session is invalid')
      return args.session.execute(args.actionId, args.params, args.signal)
    },
  }
  return {
    drivers: new Map([[`${driver.id}@${driver.version}`, driver]]),
    launchers: new Map([[`${launcher.id}@${launcher.version}`, launcher]]),
  }
}

export function validateKnowledgePlanetAccountState(input: unknown): BrowserStorageStateV1 {
  return validateBrowserStorageState(input, KNOWLEDGE_PLANET_PLUGIN_CONTRACT)
}
