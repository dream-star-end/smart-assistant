/**
 * Bilibili account managed-browser runtime (OCV5-402). Read-only.
 *
 * Structure follows the reviewed Weibo runtime (weibo.ts): one pinned-image worker container per
 * call, NetworkMode none + TLS CONNECT broker limited to the contract's IP pins, read-only rootfs,
 * all capabilities dropped, Docker log driver `none` (stdout carries storage state), 4-byte framed
 * JSON on stdin/stdout. What is intentionally absent: the write dispatch fence (`prepared` /
 * `dispatch` / `not_dispatched`), media input mounts and compatibility pins — there are no write
 * actions and no earlier versions.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { type Duplex, Writable } from 'node:stream'

import type Docker from 'dockerode'

import { type BrowserStorageStateV1, validateBrowserStorageState } from './accounts.js'
import {
  BILI_ACCOUNT_DRIVER_ID,
  BILI_ACCOUNT_DRIVER_VERSION,
  BILI_ACCOUNT_LAUNCHER_ID,
  BILI_ACCOUNT_LAUNCHER_VERSION,
  BILI_ACCOUNT_LOGIN_ORIGINS,
  BILI_ACCOUNT_NETWORK_ORIGINS,
  BILI_ACCOUNT_PLUGIN_CONTRACT,
  BILI_ACCOUNT_WORKER_DIGEST,
} from './biliAccountContract.js'
import {
  type BiliAccountFailureCode,
  type BiliAccountWorkerProtocolFailureCode,
  DEFAULT_BILI_ACCOUNT_WORKER_LOG_DIR,
  biliAccountWorkerDockerLogConfig,
  isBiliAccountWorkerProtocolFailureCode,
  mapBiliAccountWorkerProtocolFailure,
  persistBiliAccountWorkerLog,
  sanitizeBiliAccountWorkerLogLine,
} from './biliAccountObservability.js'
import { BILI_ACCOUNT_WORKER_SOURCE } from './biliAccountWorkerSource.js'
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
import { biliAccountRuntimePublicMessage } from './pluginErrorGuidance.js'

export {
  BILI_ACCOUNT_DRIVER_ID,
  BILI_ACCOUNT_DRIVER_VERSION,
  BILI_ACCOUNT_LAUNCHER_ID,
  BILI_ACCOUNT_LAUNCHER_VERSION,
  BILI_ACCOUNT_LOGIN_ORIGINS,
  BILI_ACCOUNT_PLUGIN_ARTIFACT,
  BILI_ACCOUNT_PLUGIN_CONTRACT,
  BILI_ACCOUNT_PLUGIN_SLUG,
  BILI_ACCOUNT_PLUGIN_VERSION,
  BILI_ACCOUNT_WORKER_DIGEST,
  COMPILED_BILI_ACCOUNT_PLUGIN,
  classifyBiliAccountSetupPin,
  isOfficialBiliAccountPluginIdentity,
} from './biliAccountContract.js'
export {
  DEFAULT_BILI_ACCOUNT_WORKER_LOG_DIR,
  biliAccountWorkerDockerLogConfig,
} from './biliAccountObservability.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const WORKER_FILE = 'bili-account-worker.mjs'
const WORKER_RUNTIME = 'bili-account-worker-v1'
const EXPECTED_PLAYWRIGHT_MCP_VERSION = '0.0.76'
const WORKER_MAX_FRAME_BYTES = 1024 * 1024
const WORKER_STDERR_MAX_BYTES = 64 * 1024
const WORKER_LABEL = 'com.openclaude.plugin.worker'
const WORKER_LABEL_VALUE = 'bili-account-v1'
const WORKER_EXPIRY_LABEL = 'com.openclaude.plugin.expires_at_ms'
const WORKER_BOOT_LABEL = 'com.openclaude.plugin.boot_id'
const WORKER_SESSION_LABEL = 'com.openclaude.plugin.session_id'
const WORKER_DIGEST_LABEL = 'com.openclaude.plugin.worker_digest'
/**
 * Broker / worker roots (shared by master wiring and the seed script). The broker socket path is
 * `<root>/<36-char invocation id>/tls.sock` and must stay ≤ 100 bytes (browserBroker.ts), so a
 * root may be at most 54 bytes; these keep a margin.
 */
export const BILI_ACCOUNT_BROKER_ROOT = '/run/openclaude-v5/plugin-browser-brokers-bili'
export const BILI_ACCOUNT_WORKER_ROOT = '/var/lib/openclaude-v5/plugin-workers-bili-account'
export const BILI_ACCOUNT_SEED_BROKER_ROOT = '/run/openclaude-v5/bili-seed-brokers'
export const BILI_ACCOUNT_SEED_WORKER_ROOT = '/var/lib/openclaude-v5/plugin-workers-bili-seed'

/** 只读动作都是几次页面内请求,给 3 分钟上限,远低于 Weibo 写操作用的 570 秒。 */
const ACTION_SESSION_MS = 180_000

export function resolveBiliAccountWorkerResources(kind: 'action' | 'login'): {
  memoryBytes: number
  memorySwapBytes: number
  pidsLimit: number
  shmSizeBytes: number
} {
  return {
    memoryBytes: 768 * 1024 * 1024,
    memorySwapBytes: 768 * 1024 * 1024,
    pidsLimit: kind === 'login' ? 256 : 128,
    shmSizeBytes: kind === 'login' ? 256 * 1024 * 1024 : 64 * 1024 * 1024,
  }
}

export class BiliAccountRuntimeError extends Error {
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
    | BiliAccountFailureCode

  constructor(
    code: BiliAccountRuntimeError['code'],
    message: string = biliAccountRuntimePublicMessage(code),
  ) {
    super(message)
    this.name = 'BiliAccountRuntimeError'
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
  code: BiliAccountWorkerProtocolFailureCode
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

const TERMINAL_EVENTS = new Set(['failed', 'completed', 'authenticated'])

function plainEvent(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new BiliAccountRuntimeError('PROTOCOL', 'worker emitted an invalid frame')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    throw new BiliAccountRuntimeError('PROTOCOL', 'worker emitted an invalid frame')
  return value as Record<string, unknown>
}

function exactEventKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    throw new BiliAccountRuntimeError('PROTOCOL', 'worker frame fields are invalid')
}

/** 只认这五种帧;写流程用的 prepared / not_dispatched 在只读 worker 里一律是协议错误。 */
function parseWorkerEvent(value: unknown): WorkerEvent {
  const event = plainEvent(value)
  if (event.event === 'ready') {
    exactEventKeys(event, ['event', 'runtime', 'playwrightMcpVersion'])
    if (
      event.runtime !== WORKER_RUNTIME ||
      event.playwrightMcpVersion !== EXPECTED_PLAYWRIGHT_MCP_VERSION
    )
      throw new BiliAccountRuntimeError('PROTOCOL', 'worker compatibility handshake failed')
    return event as unknown as ReadyEvent
  }
  if (event.event === 'failed') {
    exactEventKeys(event, ['event', 'code'])
    if (!isBiliAccountWorkerProtocolFailureCode(String(event.code)))
      throw new BiliAccountRuntimeError('PROTOCOL', 'worker failure code is invalid')
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
      throw new BiliAccountRuntimeError('PROTOCOL', 'worker QR frame is invalid')
    const png = Buffer.from(event.png, 'base64')
    if (
      png.length < 8 ||
      png.length > 512 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new BiliAccountRuntimeError('PROTOCOL', 'worker QR image is invalid')
    return { event: 'qr', png }
  }
  throw new BiliAccountRuntimeError('PROTOCOL', 'worker event is unsupported')
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
          throw new BiliAccountRuntimeError('PROTOCOL', 'worker frame size is invalid')
      }
      if (this.buffered.length < this.expected + 4) return
      const body = this.buffered.subarray(4, this.expected + 4)
      this.buffered = this.buffered.subarray(this.expected + 4)
      this.expected = null
      let value: unknown
      try {
        value = JSON.parse(body.toString('utf8'))
      } catch {
        throw new BiliAccountRuntimeError('PROTOCOL', 'worker frame is not JSON')
      }
      this.onEvent(parseWorkerEvent(value))
      if (this.buffered.length === 0) return
    }
  }

  finish(): void {
    if (this.buffered.length !== 0 || this.expected !== null)
      throw new BiliAccountRuntimeError('PROTOCOL', 'worker output ended mid-frame')
  }
}

/** Regression seam: frame parsing without Docker. */
export function decodeBiliAccountWorkerFramesForTest(chunk: Buffer): WorkerEvent['event'][] {
  const events: WorkerEvent['event'][] = []
  const decoder = new FrameDecoder((event) => {
    events.push(event.event)
  })
  decoder.push(chunk)
  decoder.finish()
  return events
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > 512 * 1024)
    throw new BiliAccountRuntimeError('PROTOCOL', 'worker input exceeds limit')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

async function safeRoot(rootInput: string, expectedOwnerUid: number): Promise<string> {
  if (!isAbsolute(rootInput))
    throw new BiliAccountRuntimeError('UNAVAILABLE', 'worker root must be absolute')
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
    throw new BiliAccountRuntimeError('UNAVAILABLE', 'worker root is unsafe')
  return root
}

async function materializeWorker(
  rootInput: string,
  expectedOwnerUid: number,
): Promise<{ digest: string; directory: string }> {
  const root = await safeRoot(rootInput, expectedOwnerUid)
  const digest = createHash('sha256').update(BILI_ACCOUNT_WORKER_SOURCE).digest('hex')
  if (digest !== BILI_ACCOUNT_WORKER_DIGEST)
    throw new BiliAccountRuntimeError('UNAVAILABLE', 'worker implementation pin mismatch')
  const directory = join(root, digest)
  const workerPath = join(directory, WORKER_FILE)
  const existing = await readFile(workerPath, 'utf8').catch(() => null)
  if (existing === BILI_ACCOUNT_WORKER_SOURCE) {
    const stat = await lstat(workerPath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedOwnerUid ||
      (stat.mode & 0o777) !== 0o444 ||
      (await realpath(directory)) !== directory
    )
      throw new BiliAccountRuntimeError('UNAVAILABLE', 'materialized worker is unsafe')
    return { digest, directory }
  }
  const staging = `${directory}.tmp-${randomUUID()}`
  await mkdir(staging, { mode: 0o700 })
  try {
    await writeFile(join(staging, WORKER_FILE), BILI_ACCOUNT_WORKER_SOURCE, {
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
    materialized !== BILI_ACCOUNT_WORKER_SOURCE ||
    createHash('sha256').update(materialized).digest('hex') !== digest
  )
    throw new BiliAccountRuntimeError('UNAVAILABLE', 'worker materialization failed')
  return { digest, directory }
}

interface ActiveWorker {
  container: Docker.Container
  broker: ManagedBrowserBrokerHandle
  done: Promise<WorkerEvent[]>
  kind: 'action' | 'login'
}

export interface BiliAccountLoginWorkerHandle {
  sessionId: string
  done: Promise<void>
  stop(): Promise<void>
}

export class BiliAccountDockerService {
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
      workerLogDir?: string
    },
  ) {}

  private writeWorkerLog(sessionId: string, event: Record<string, unknown>): void {
    void persistBiliAccountWorkerLog(
      this.opts.workerLogDir ?? DEFAULT_BILI_ACCOUNT_WORKER_LOG_DIR,
      sessionId,
      event,
    )
  }

  private reserveWorker(key: string, kind: 'action' | 'login'): void {
    if (this.closing) throw new BiliAccountRuntimeError('CLOSING')
    if (this.active.has(key) || this.reserved.has(key))
      throw new BiliAccountRuntimeError('BILI_ACCOUNT_WORKER_BUSY', 'worker key is already active')
    const total = this.active.size + this.reserved.size
    const kindTotal =
      [...this.active.values()].filter((worker) => worker.kind === kind).length +
      [...this.reserved.values()].filter((reservedKind) => reservedKind === kind).length
    const totalLimit = this.opts.maxWorkers ?? 2
    const kindLimit =
      kind === 'login' ? (this.opts.maxLoginWorkers ?? 1) : (this.opts.maxActionWorkers ?? 2)
    if (total >= totalLimit || kindTotal >= kindLimit)
      throw new BiliAccountRuntimeError(
        'CAPACITY_EXCEEDED',
        'managed-browser worker capacity is full',
      )
    this.reserved.set(key, kind)
  }

  /** Fixed Docker names make the total cap atomic across rolling master processes. */
  private async createContainerInHostSlot(
    options: Docker.ContainerCreateOptions,
  ): Promise<Docker.Container> {
    const limit = this.opts.maxWorkers ?? 2
    const attempt = async (): Promise<Docker.Container | null> => {
      for (let slot = 0; slot < limit; slot++) {
        try {
          return await this.docker.createContainer({
            ...options,
            name: `oc-v5-bili-account-worker-slot-${slot}`,
          })
        } catch (error) {
          if ((error as { statusCode?: unknown })?.statusCode !== 409) throw error
        }
      }
      return null
    }
    const available = await attempt()
    if (available) return available
    if ((await this.gcExpiredOrphans()) > 0) {
      const recovered = await attempt()
      if (recovered) return recovered
    }
    throw new BiliAccountRuntimeError(
      'CAPACITY_EXCEEDED',
      'managed-browser host worker capacity is full',
    )
  }

  private async initialize(): Promise<{ digest: string; directory: string }> {
    if (this.closing) throw new BiliAccountRuntimeError('CLOSING')
    if (!this.initialized) {
      this.initialized = (async () => {
        if (!IMAGE_ID_RE.test(this.opts.imageId))
          throw new BiliAccountRuntimeError(
            'IMAGE_MISMATCH',
            'managed-browser image must be an exact sha256 ID',
          )
        const image = await this.docker
          .getImage(this.opts.imageId)
          .inspect()
          .catch(() => null)
        if (!image || image.Id !== this.opts.imageId)
          throw new BiliAccountRuntimeError(
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
      if (summary.Labels?.[WORKER_LABEL] !== WORKER_LABEL_VALUE) continue
      const expiry = Number(summary.Labels?.[WORKER_EXPIRY_LABEL])
      if (!Number.isFinite(expiry) || expiry + grace >= now) continue
      const container = this.docker.getContainer(summary.Id)
      await container.kill().catch(() => {})
      await container.remove({ force: true }).catch(() => {})
      const remains = await container.inspect().catch(() => null)
      if (remains) throw new BiliAccountRuntimeError('CLEANUP_FAILED', 'expired worker remains')
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
    if (this.closing) throw new BiliAccountRuntimeError('CLOSING')
    const sessionId = randomUUID()
    this.writeWorkerLog(sessionId, {
      step: 'host.worker_start',
      kind: args.kind,
      actionId: typeof args.input.actionId === 'string' ? args.input.actionId : undefined,
    })
    const broker = await createManagedBrowserTlsBroker({
      root: this.opts.brokerRoot,
      invocationId: sessionId,
      pins: args.pins,
      expectedOwnerUid: this.opts.expectedOwnerUid ?? 0,
      socketUid: this.opts.socketUid ?? 1000,
      socketGid: this.opts.socketGid ?? 1000,
      limits: {
        maxConnections: 128,
        maxConcurrent: 32,
        maxBytesPerDirection: 64 * 1024 * 1024,
        idleTimeoutMs: 120_000,
        connectTimeoutMs: 10_000,
      },
    })
    if (args.signal?.aborted) {
      await broker.close()
      throw args.signal.reason
    }
    let container: Docker.Container | null = null
    let stream: Duplex | null = null
    let cleanupFailure: unknown = null
    try {
      const resources = resolveBiliAccountWorkerResources(args.kind)
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
          Memory: resources.memoryBytes,
          MemorySwap: resources.memorySwapBytes,
          MemorySwappiness: 0,
          NanoCpus: 1_000_000_000,
          PidsLimit: resources.pidsLimit,
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
          LogConfig: biliAccountWorkerDockerLogConfig(),
          AutoRemove: false,
          ShmSize: resources.shmSizeBytes,
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
      let stderrRemainder = ''
      const decoder = new FrameDecoder((event) => {
        if (events.length === 0 && event.event !== 'ready')
          throw new BiliAccountRuntimeError('PROTOCOL', 'worker omitted compatibility handshake')
        if (events.some((item) => TERMINAL_EVENTS.has(item.event)))
          throw new BiliAccountRuntimeError('PROTOCOL', 'worker emitted data after terminal event')
        // 登录 worker 只能以 authenticated / failed 结束,动作 worker 只能以 completed / failed 结束。
        if (
          (args.kind === 'login' && event.event === 'completed') ||
          (args.kind === 'action' && (event.event === 'authenticated' || event.event === 'qr'))
        )
          throw new BiliAccountRuntimeError('PROTOCOL', 'worker event does not match its mode')
        events.push(event)
        args.onEvent?.(event)
        if (event.event === 'ready') this.writeWorkerLog(sessionId, { step: 'host.ready' })
        if (event.event === 'failed')
          this.writeWorkerLog(sessionId, { step: 'host.failed', code: event.code })
        if (event.event === 'completed') this.writeWorkerLog(sessionId, { step: 'host.completed' })
        if (event.event === 'authenticated')
          this.writeWorkerLog(sessionId, { step: 'host.authenticated' })
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
        write: (chunk: Buffer, _encoding, callback) => {
          stderrBytes += chunk.length
          stderrRemainder += chunk.toString('utf8')
          const lines = stderrRemainder.split('\n')
          stderrRemainder = lines.pop() ?? ''
          for (const line of lines) {
            const sanitized = sanitizeBiliAccountWorkerLogLine(line)
            if (sanitized) this.writeWorkerLog(sessionId, sanitized)
          }
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
                reject(
                  new BiliAccountRuntimeError('BILI_ACCOUNT_WORKER_DEADLINE', 'worker deadline'),
                )
              }, remaining)
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          await Promise.race([
            streamEnded,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new BiliAccountRuntimeError('PROTOCOL', 'worker stream timeout')),
                2_000,
              )
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          decoder.finish()
          if (protocolFailure) throw protocolFailure
          if (stderrBytes > WORKER_STDERR_MAX_BYTES)
            throw new BiliAccountRuntimeError('PROTOCOL', 'worker stderr exceeded limit')
          const status = (result as { StatusCode?: number }).StatusCode ?? -1
          const terminal = events.at(-1)
          if (status !== 0 || !terminal || !TERMINAL_EVENTS.has(terminal.event))
            throw new BiliAccountRuntimeError(
              'BILI_ACCOUNT_WORKER_INCOMPLETE',
              'worker did not finish',
            )
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
          throw new BiliAccountRuntimeError('CLEANUP_FAILED', 'worker cleanup failed')
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
        throw new BiliAccountRuntimeError('CLEANUP_FAILED', 'worker startup cleanup failed')
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
        cookieDomains: BILI_ACCOUNT_PLUGIN_CONTRACT.runtime.accountState.cookieDomains,
        stateOrigins: BILI_ACCOUNT_PLUGIN_CONTRACT.runtime.accountState.origins,
      },
    })
    const terminal = (await worker.done).at(-1)!
    if (terminal.event === 'failed')
      throw new BiliAccountRuntimeError(mapBiliAccountWorkerProtocolFailure(terminal.code))
    if (terminal.event !== 'completed')
      throw new BiliAccountRuntimeError('PROTOCOL', 'action worker terminal event is invalid')
    return { result: terminal.result, storageState: terminal.storageState }
  }

  async startLogin(args: {
    sessionId: string
    pins: readonly ManagedBrowserPinnedOrigin[]
    deadlineMs: number
    onQr: (png: Buffer) => void
    onAuthenticated: (storageState: unknown) => void
    onFailed: (code: string) => void
  }): Promise<BiliAccountLoginWorkerHandle> {
    const worker = await this.startWorker({
      key: `login:${args.sessionId}`,
      kind: 'login',
      pins: args.pins,
      deadlineMs: args.deadlineMs,
      input: {
        mode: 'login',
        allowedOrigins: BILI_ACCOUNT_LOGIN_ORIGINS.map((origin) => new URL(origin).origin),
        cookieDomains: BILI_ACCOUNT_PLUGIN_CONTRACT.runtime.accountState.cookieDomains,
        stateOrigins: BILI_ACCOUNT_PLUGIN_CONTRACT.runtime.accountState.origins,
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
      throw new BiliAccountRuntimeError('CLEANUP_FAILED', 'worker termination did not drain')
  }

  async closeAndDrain(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.starting])
    const keys = [...this.active.keys()]
    await Promise.all(keys.map((key) => this.terminate(key)))
    if (this.active.size !== 0)
      throw new BiliAccountRuntimeError('CLEANUP_FAILED', 'workers remain during shutdown')
  }
}

class BiliAccountManagedSession implements ManagedBrowserSession {
  readonly driverSession = this
  private completed: { result: unknown; storageState: unknown } | null = null
  private executing = false

  constructor(
    private readonly service: BiliAccountDockerService,
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
        deadlineMs: Date.now() + ACTION_SESSION_MS,
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

export function createBiliAccountRuntimeRegistries(service: BiliAccountDockerService): {
  drivers: ReadonlyMap<string, ManagedBrowserDriverV1>
  launchers: ReadonlyMap<string, ManagedBrowserLauncherV1>
} {
  const launcher: ManagedBrowserLauncherV1 = {
    id: BILI_ACCOUNT_LAUNCHER_ID,
    version: BILI_ACCOUNT_LAUNCHER_VERSION,
    capabilities: REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
    async launch(args) {
      return new BiliAccountManagedSession(service, args)
    },
    terminate: (profileDir) => service.terminate(profileDir),
  }
  const driver: ManagedBrowserDriverV1 = {
    id: BILI_ACCOUNT_DRIVER_ID,
    version: BILI_ACCOUNT_DRIVER_VERSION,
    launcherId: BILI_ACCOUNT_LAUNCHER_ID,
    launcherVersion: BILI_ACCOUNT_LAUNCHER_VERSION,
    maximumNetwork: { origins: BILI_ACCOUNT_NETWORK_ORIGINS, methods: ['GET'] },
    async execute(args) {
      if (!(args.session instanceof BiliAccountManagedSession))
        throw new ManagedBrowserRuntimeError('EXECUTION_FAILED', 'driver session is invalid')
      // 只读插件没有派发围栏:任何 beforeDispatch(写流程)到这里都是编程错误。
      if (args.beforeDispatch)
        throw new ManagedBrowserRuntimeError('EXECUTION_FAILED', 'read-only driver has no dispatch')
      return args.session.execute(args.actionId, args.params, args.signal)
    },
  }
  return {
    drivers: new Map([[`${driver.id}@${driver.version}`, driver]]),
    launchers: new Map([[`${launcher.id}@${launcher.version}`, launcher]]),
  }
}

export function validateBiliAccountState(input: unknown): BrowserStorageStateV1 {
  return validateBrowserStorageState(input, BILI_ACCOUNT_PLUGIN_CONTRACT)
}
