/**
 * Douyin managed-browser runtime (OCV5-553). Ported from the reviewed Bilibili account runtime
 * (biliAccount.ts): QR login, reads of the account's own works / comments, and (1.1.0) write actions
 * behind the reviewed dispatch fence of the Zhihu runtime (zhihu.ts): the worker emits `prepared`,
 * the master durably arms the ledger in `beforeDispatch` and only then writes `dispatch`; a worker
 * that finds the target changed ends with `not_dispatched` (proven not sent). Write media is mounted
 * read-only at `/inputs` from the sha256-verified staging directory.
 * Login workers additionally take command frames on stdin for the account owner's SMS
 * verification (design 4.3.C): the master writes `send_sms` / `sms_code` / `resend_sms` / `abort`;
 * the code frame buffer is zeroed right after the write.
 *
 * Structure follows the reviewed Weibo runtime (weibo.ts): one pinned-image worker container per
 * call, NetworkMode none + TLS CONNECT broker limited to the contract's IP pins, read-only rootfs,
 * all capabilities dropped, Docker log driver `none` (stdout carries storage state), 4-byte framed
 * JSON on stdin/stdout. No compatibility pins: no earlier version was ever published.
 */
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
import {
  DOUYIN_DRIVER_ID,
  DOUYIN_DRIVER_VERSION,
  DOUYIN_LAUNCHER_ID,
  DOUYIN_LAUNCHER_VERSION,
  DOUYIN_LOGIN_ORIGINS,
  DOUYIN_NETWORK_ORIGINS,
  DOUYIN_PLUGIN_CONTRACT,
  DOUYIN_WORKER_DIGEST,
} from './douyinContract.js'
import {
  DEFAULT_DOUYIN_WORKER_LOG_DIR,
  type DouyinFailureCode,
  type DouyinWorkerProtocolFailureCode,
  douyinWorkerDockerLogConfig,
  isDouyinWorkerProtocolFailureCode,
  mapDouyinWorkerProtocolFailure,
  persistDouyinWorkerLog,
  sanitizeDouyinWorkerLogLine,
} from './douyinObservability.js'
import { DOUYIN_WORKER_SOURCE } from './douyinWorkerSource.js'
import { douyinRuntimePublicMessage } from './pluginErrorGuidance.js'

export {
  DOUYIN_DRIVER_ID,
  DOUYIN_DRIVER_VERSION,
  DOUYIN_LAUNCHER_ID,
  DOUYIN_LAUNCHER_VERSION,
  DOUYIN_LOGIN_ORIGINS,
  DOUYIN_PLUGIN_ARTIFACT,
  DOUYIN_PLUGIN_CONTRACT,
  DOUYIN_PLUGIN_SLUG,
  DOUYIN_PLUGIN_VERSION,
  DOUYIN_WORKER_DIGEST,
  COMPILED_DOUYIN_PLUGIN,
  classifyDouyinSetupPin,
  isOfficialDouyinPluginIdentity,
} from './douyinContract.js'
export {
  DEFAULT_DOUYIN_WORKER_LOG_DIR,
  douyinWorkerDockerLogConfig,
} from './douyinObservability.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const WORKER_FILE = 'douyin-worker.mjs'
const WORKER_RUNTIME = 'douyin-worker-v1'
const EXPECTED_PLAYWRIGHT_MCP_VERSION = '0.0.76'
const WORKER_MAX_FRAME_BYTES = 1024 * 1024
const WORKER_STDERR_MAX_BYTES = 64 * 1024
const WORKER_LABEL = 'com.openclaude.plugin.worker'
const WORKER_LABEL_VALUE = 'douyin-v1'
const WORKER_EXPIRY_LABEL = 'com.openclaude.plugin.expires_at_ms'
const WORKER_BOOT_LABEL = 'com.openclaude.plugin.boot_id'
const WORKER_SESSION_LABEL = 'com.openclaude.plugin.session_id'
const WORKER_DIGEST_LABEL = 'com.openclaude.plugin.worker_digest'
/**
 * Broker / worker roots (shared by master wiring and the seed script). The broker socket path is
 * `<root>/<36-char invocation id>/tls.sock` and must stay ≤ 100 bytes (browserBroker.ts), so a
 * root may be at most 54 bytes; these keep a margin.
 */
export const DOUYIN_BROKER_ROOT = '/run/openclaude-v5/plugin-browser-brokers-douyin'
export const DOUYIN_WORKER_ROOT = '/var/lib/openclaude-v5/plugin-workers-douyin'
export const DOUYIN_SEED_BROKER_ROOT = '/run/openclaude-v5/douyin-seed-brokers'
export const DOUYIN_SEED_WORKER_ROOT = '/var/lib/openclaude-v5/plugin-workers-douyin-seed'

/** 只读动作都是几次页面内请求,给 3 分钟上限;写动作(含视频上传)与微博 / 知乎写操作相同,570 秒。 */
const ACTION_SESSION_MS = 180_000
const WRITE_SESSION_MS = 570_000

export function resolveDouyinWorkerResources(kind: 'action' | 'login'): {
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

export class DouyinRuntimeError extends Error {
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
    | 'PRECONDITION_CHANGED'
    | DouyinFailureCode

  /** worker 证明了没有发出（目标在发出前变了）：账本记 failed 而不是 unknown。 */
  readonly dispatchProvenNotStarted: boolean

  constructor(
    code: DouyinRuntimeError['code'],
    message: string = douyinRuntimePublicMessage(code),
  ) {
    super(message)
    this.name = 'DouyinRuntimeError'
    this.code = code
    this.dispatchProvenNotStarted = code === 'PRECONDITION_CHANGED'
  }
}

interface ReadyEvent {
  event: 'ready'
  runtime: typeof WORKER_RUNTIME
  playwrightMcpVersion: typeof EXPECTED_PLAYWRIGHT_MCP_VERSION
}
interface FailedEvent {
  event: 'failed'
  code: DouyinWorkerProtocolFailureCode
}
interface CompletedEvent {
  event: 'completed'
  result: unknown
  storageState: unknown
}
/** 写动作：worker 已核对目标、准备好发出，等 master 落定派发围栏后的 `dispatch`。 */
interface PreparedEvent {
  event: 'prepared'
}
/** 写动作：发出前目标已变化，确定没有发出。 */
interface NotDispatchedEvent {
  event: 'not_dispatched'
  code: 'PRECONDITION_CHANGED'
}
interface QrEvent {
  event: 'qr'
  png: Buffer
  /** 服务端给这个码的过期时间（epoch ms）。 */
  expireAt: number
}
/** 扫码后抖音要求本人验证（OCV5-553 4.3.C）。只有短信这条路由我们代为提交。 */
interface VerificationEvent {
  event: 'verification'
  kind: 'sms_available' | 'unsupported'
}
interface SmsSentEvent {
  event: 'sms_sent'
  resendAfterSec: number
}
interface SmsRejectedEvent {
  event: 'sms_rejected'
}
interface SmsResendFailedEvent {
  event: 'sms_resend_failed'
}
/** worker 作废了当前二维码（换码 / 502）：master 立即撤下缓存的码。 */
interface QrInvalidEvent {
  event: 'qr_invalid'
}
interface AuthenticatedEvent {
  event: 'authenticated'
  storageState: unknown
}
type WorkerEvent =
  | ReadyEvent
  | FailedEvent
  | CompletedEvent
  | PreparedEvent
  | NotDispatchedEvent
  | QrEvent
  | AuthenticatedEvent
  | VerificationEvent
  | SmsSentEvent
  | SmsRejectedEvent
  | SmsResendFailedEvent
  | QrInvalidEvent

/** 只在登录 worker 里出现的非终止帧。 */
const LOGIN_ONLY_EVENTS = new Set([
  'qr',
  'qr_invalid',
  'verification',
  'sms_sent',
  'sms_rejected',
  'sms_resend_failed',
])

/** master → 登录 worker 的命令帧（stdin）。验证码只在内存里，写出后立即清零。 */
export type DouyinLoginCommand =
  | { cmd: 'send_sms' }
  | { cmd: 'resend_sms' }
  | { cmd: 'abort' }
  | { cmd: 'sms_code'; code: string }

const TERMINAL_EVENTS = new Set(['failed', 'completed', 'authenticated', 'not_dispatched'])
/** 只在动作 worker 的写流程里出现的帧。 */
const WRITE_ONLY_EVENTS = new Set(['prepared', 'not_dispatched'])

function plainEvent(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new DouyinRuntimeError('PROTOCOL', 'worker emitted an invalid frame')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    throw new DouyinRuntimeError('PROTOCOL', 'worker emitted an invalid frame')
  return value as Record<string, unknown>
}

function exactEventKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    throw new DouyinRuntimeError('PROTOCOL', 'worker frame fields are invalid')
}

/** prepared / not_dispatched 只属于动作 worker 的写流程;登录 worker 发出即协议错误(见 startReservedWorker)。 */
function parseWorkerEvent(value: unknown): WorkerEvent {
  const event = plainEvent(value)
  if (event.event === 'ready') {
    exactEventKeys(event, ['event', 'runtime', 'playwrightMcpVersion'])
    if (
      event.runtime !== WORKER_RUNTIME ||
      event.playwrightMcpVersion !== EXPECTED_PLAYWRIGHT_MCP_VERSION
    )
      throw new DouyinRuntimeError('PROTOCOL', 'worker compatibility handshake failed')
    return event as unknown as ReadyEvent
  }
  if (event.event === 'failed') {
    exactEventKeys(event, ['event', 'code'])
    if (!isDouyinWorkerProtocolFailureCode(String(event.code)))
      throw new DouyinRuntimeError('PROTOCOL', 'worker failure code is invalid')
    return event as unknown as FailedEvent
  }
  if (event.event === 'completed') {
    exactEventKeys(event, ['event', 'result', 'storageState'])
    return event as unknown as CompletedEvent
  }
  if (event.event === 'prepared') {
    exactEventKeys(event, ['event'])
    return event as unknown as PreparedEvent
  }
  if (event.event === 'not_dispatched') {
    exactEventKeys(event, ['event', 'code'])
    if (event.code !== 'PRECONDITION_CHANGED')
      throw new DouyinRuntimeError('PROTOCOL', 'worker precondition code is invalid')
    return event as unknown as NotDispatchedEvent
  }
  if (event.event === 'authenticated') {
    exactEventKeys(event, ['event', 'storageState'])
    return event as unknown as AuthenticatedEvent
  }
  if (event.event === 'verification') {
    exactEventKeys(event, ['event', 'kind'])
    if (event.kind !== 'sms_available' && event.kind !== 'unsupported')
      throw new DouyinRuntimeError('PROTOCOL', 'worker verification frame is invalid')
    return event as unknown as VerificationEvent
  }
  if (event.event === 'sms_sent') {
    exactEventKeys(event, ['event', 'resendAfterSec'])
    if (
      !Number.isSafeInteger(event.resendAfterSec) ||
      (event.resendAfterSec as number) < 0 ||
      (event.resendAfterSec as number) > 600
    )
      throw new DouyinRuntimeError('PROTOCOL', 'worker sms frame is invalid')
    return event as unknown as SmsSentEvent
  }
  if (
    event.event === 'sms_rejected' ||
    event.event === 'sms_resend_failed' ||
    event.event === 'qr_invalid'
  ) {
    exactEventKeys(event, ['event'])
    return event as unknown as SmsRejectedEvent | SmsResendFailedEvent | QrInvalidEvent
  }
  if (event.event === 'qr') {
    exactEventKeys(event, ['event', 'png', 'expireAt'])
    if (!Number.isSafeInteger(event.expireAt) || (event.expireAt as number) <= 0)
      throw new DouyinRuntimeError('PROTOCOL', 'worker QR frame is invalid')
    if (typeof event.png !== 'string' || event.png.length > 700_000)
      throw new DouyinRuntimeError('PROTOCOL', 'worker QR frame is invalid')
    const png = Buffer.from(event.png, 'base64')
    if (
      png.length < 8 ||
      png.length > 512 * 1024 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new DouyinRuntimeError('PROTOCOL', 'worker QR image is invalid')
    return { event: 'qr', png, expireAt: event.expireAt as number }
  }
  throw new DouyinRuntimeError('PROTOCOL', 'worker event is unsupported')
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
          throw new DouyinRuntimeError('PROTOCOL', 'worker frame size is invalid')
      }
      if (this.buffered.length < this.expected + 4) return
      const body = this.buffered.subarray(4, this.expected + 4)
      this.buffered = this.buffered.subarray(this.expected + 4)
      this.expected = null
      let value: unknown
      try {
        value = JSON.parse(body.toString('utf8'))
      } catch {
        throw new DouyinRuntimeError('PROTOCOL', 'worker frame is not JSON')
      }
      this.onEvent(parseWorkerEvent(value))
      if (this.buffered.length === 0) return
    }
  }

  finish(): void {
    if (this.buffered.length !== 0 || this.expected !== null)
      throw new DouyinRuntimeError('PROTOCOL', 'worker output ended mid-frame')
  }
}

/** Regression seam: frame parsing without Docker. */
/**
 * 帧顺序与模式(纯函数,单测直接调用):第一帧必须是 ready;终止帧之后不能再有帧;登录 worker 只能以
 * authenticated / failed 结束、不能发写流程帧;动作 worker 不能发登录帧;prepared / not_dispatched 只属于
 * 带 beforeDispatch 的写调用,prepared 只能一次;写调用要以 completed 结束必须先经过 prepared(派发围栏)。
 */
export function assertDouyinWorkerEventOrder(input: {
  kind: 'action' | 'login'
  prior: readonly string[]
  event: string
  writeCall: boolean
}): void {
  const { kind, prior, event } = input
  if (prior.length === 0 && event !== 'ready')
    throw new DouyinRuntimeError('PROTOCOL', 'worker omitted compatibility handshake')
  if (prior.length > 0 && event === 'ready')
    throw new DouyinRuntimeError('PROTOCOL', 'worker repeated compatibility handshake')
  if (prior.some((item) => TERMINAL_EVENTS.has(item)))
    throw new DouyinRuntimeError('PROTOCOL', 'worker emitted data after terminal event')
  if (
    (kind === 'login' && (event === 'completed' || WRITE_ONLY_EVENTS.has(event))) ||
    (kind === 'action' && (event === 'authenticated' || LOGIN_ONLY_EVENTS.has(event)))
  )
    throw new DouyinRuntimeError('PROTOCOL', 'worker event does not match its mode')
  if (event === 'prepared' && (!input.writeCall || prior.includes('prepared')))
    throw new DouyinRuntimeError('PROTOCOL', 'worker dispatch fence is invalid')
  if (event === 'not_dispatched' && !input.writeCall)
    throw new DouyinRuntimeError('PROTOCOL', 'worker dispatch fence is invalid')
  if (event === 'completed' && input.writeCall && !prior.includes('prepared'))
    throw new DouyinRuntimeError('PROTOCOL', 'write worker completed without the dispatch fence')
}

export function decodeDouyinWorkerFramesForTest(chunk: Buffer): WorkerEvent['event'][] {
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
    throw new DouyinRuntimeError('PROTOCOL', 'worker input exceeds limit')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

async function safeRoot(rootInput: string, expectedOwnerUid: number): Promise<string> {
  if (!isAbsolute(rootInput))
    throw new DouyinRuntimeError('UNAVAILABLE', 'worker root must be absolute')
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
    throw new DouyinRuntimeError('UNAVAILABLE', 'worker root is unsafe')
  return root
}

async function materializeWorker(
  rootInput: string,
  expectedOwnerUid: number,
): Promise<{ digest: string; directory: string }> {
  const root = await safeRoot(rootInput, expectedOwnerUid)
  const digest = createHash('sha256').update(DOUYIN_WORKER_SOURCE).digest('hex')
  if (digest !== DOUYIN_WORKER_DIGEST)
    throw new DouyinRuntimeError('UNAVAILABLE', 'worker implementation pin mismatch')
  const directory = join(root, digest)
  const workerPath = join(directory, WORKER_FILE)
  const existing = await readFile(workerPath, 'utf8').catch(() => null)
  if (existing === DOUYIN_WORKER_SOURCE) {
    const stat = await lstat(workerPath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedOwnerUid ||
      (stat.mode & 0o777) !== 0o444 ||
      (await realpath(directory)) !== directory
    )
      throw new DouyinRuntimeError('UNAVAILABLE', 'materialized worker is unsafe')
    return { digest, directory }
  }
  const staging = `${directory}.tmp-${randomUUID()}`
  await mkdir(staging, { mode: 0o700 })
  try {
    await writeFile(join(staging, WORKER_FILE), DOUYIN_WORKER_SOURCE, {
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
    materialized !== DOUYIN_WORKER_SOURCE ||
    createHash('sha256').update(materialized).digest('hex') !== digest
  )
    throw new DouyinRuntimeError('UNAVAILABLE', 'worker materialization failed')
  return { digest, directory }
}

interface ActiveWorker {
  container: Docker.Container
  broker: ManagedBrowserBrokerHandle
  done: Promise<WorkerEvent[]>
  kind: 'action' | 'login'
  /** 向 worker stdin 写一帧（只用于登录 worker 的命令）。 */
  send(value: DouyinLoginCommand): Promise<void>
}

export interface DouyinLoginWorkerHandle {
  sessionId: string
  done: Promise<void>
  stop(): Promise<void>
  /** 发命令给登录 worker（发短信 / 提交验证码 / 重发 / 放弃）。 */
  command(value: DouyinLoginCommand): Promise<void>
}

export class DouyinDockerService {
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
    void persistDouyinWorkerLog(
      this.opts.workerLogDir ?? DEFAULT_DOUYIN_WORKER_LOG_DIR,
      sessionId,
      event,
    )
  }

  private reserveWorker(key: string, kind: 'action' | 'login'): void {
    if (this.closing) throw new DouyinRuntimeError('CLOSING')
    if (this.active.has(key) || this.reserved.has(key))
      throw new DouyinRuntimeError('DOUYIN_WORKER_BUSY', 'worker key is already active')
    const total = this.active.size + this.reserved.size
    const kindTotal =
      [...this.active.values()].filter((worker) => worker.kind === kind).length +
      [...this.reserved.values()].filter((reservedKind) => reservedKind === kind).length
    const totalLimit = this.opts.maxWorkers ?? 2
    const kindLimit =
      kind === 'login' ? (this.opts.maxLoginWorkers ?? 1) : (this.opts.maxActionWorkers ?? 2)
    if (total >= totalLimit || kindTotal >= kindLimit)
      throw new DouyinRuntimeError('CAPACITY_EXCEEDED', 'managed-browser worker capacity is full')
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
            name: `oc-v5-douyin-worker-slot-${slot}`,
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
    throw new DouyinRuntimeError(
      'CAPACITY_EXCEEDED',
      'managed-browser host worker capacity is full',
    )
  }

  private async initialize(): Promise<{ digest: string; directory: string }> {
    if (this.closing) throw new DouyinRuntimeError('CLOSING')
    if (!this.initialized) {
      this.initialized = (async () => {
        if (!IMAGE_ID_RE.test(this.opts.imageId))
          throw new DouyinRuntimeError(
            'IMAGE_MISMATCH',
            'managed-browser image must be an exact sha256 ID',
          )
        const image = await this.docker
          .getImage(this.opts.imageId)
          .inspect()
          .catch(() => null)
        if (!image || image.Id !== this.opts.imageId)
          throw new DouyinRuntimeError(
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
      if (remains) throw new DouyinRuntimeError('CLEANUP_FAILED', 'expired worker remains')
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
    beforeDispatch?: () => Promise<void>
    inputDirectory?: string
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
    beforeDispatch?: () => Promise<void>
    inputDirectory?: string
  }): Promise<ActiveWorker> {
    const materialized = await this.initialize()
    if (args.signal?.aborted) throw args.signal.reason
    if (this.closing) throw new DouyinRuntimeError('CLOSING')
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
      if (args.inputDirectory) {
        // 只挂载宿主已按 sha256 核对过的暂存目录(stageKnowledgePlanetMedia),且只给写动作。
        const stat = await lstat(args.inputDirectory)
        if (
          args.kind !== 'action' ||
          !isAbsolute(args.inputDirectory) ||
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== (this.opts.expectedOwnerUid ?? 0) ||
          (stat.mode & 0o777) !== 0o555 ||
          (await realpath(args.inputDirectory)) !== args.inputDirectory
        )
          throw new DouyinRuntimeError('UNAVAILABLE', 'worker input directory is unsafe')
      }
      const resources = resolveDouyinWorkerResources(args.kind)
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
            ...(args.inputDirectory
              ? [
                  {
                    Type: 'bind' as const,
                    Source: args.inputDirectory,
                    Target: '/inputs',
                    ReadOnly: true,
                    BindOptions: { Propagation: 'rprivate' as const },
                  },
                ]
              : []),
          ],
          RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          LogConfig: douyinWorkerDockerLogConfig(),
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
      let dispatchFailure: unknown = null
      let dispatchPromise: Promise<void> | null = null
      let prepared = false
      let stderrBytes = 0
      let stderrRemainder = ''
      const decoder = new FrameDecoder((event) => {
        assertDouyinWorkerEventOrder({
          kind: args.kind,
          prior: events.map((item) => item.event),
          event: event.event,
          writeCall: args.beforeDispatch !== undefined,
        })
        events.push(event)
        args.onEvent?.(event)
        if (event.event === 'ready') this.writeWorkerLog(sessionId, { step: 'host.ready' })
        if (event.event === 'failed')
          this.writeWorkerLog(sessionId, { step: 'host.failed', code: event.code })
        if (event.event === 'completed') this.writeWorkerLog(sessionId, { step: 'host.completed' })
        if (event.event === 'authenticated')
          this.writeWorkerLog(sessionId, { step: 'host.authenticated' })
        if (event.event === 'not_dispatched')
          this.writeWorkerLog(sessionId, { step: 'host.not_dispatched', code: event.code })
        if (event.event === 'prepared') {
          // 顺序已由 assertDouyinWorkerEventOrder 检查;master 先落定派发围栏再放行。
          if (prepared || !args.beforeDispatch || !stream)
            throw new DouyinRuntimeError('PROTOCOL', 'worker dispatch fence is invalid')
          prepared = true
          this.writeWorkerLog(sessionId, { step: 'host.prepared' })
          dispatchPromise = args
            .beforeDispatch()
            .then(() => {
              this.writeWorkerLog(sessionId, { step: 'host.dispatch' })
              return new Promise<void>((resolveWrite, reject) => {
                stream!.write(frame({ event: 'dispatch' }), (error) =>
                  error ? reject(error) : resolveWrite(),
                )
              })
            })
            .catch((error) => {
              dispatchFailure = error
              this.writeWorkerLog(sessionId, {
                step: 'host.dispatch_failed',
                code:
                  typeof (error as { code?: unknown })?.code === 'string'
                    ? String((error as { code: string }).code)
                    : 'INTERNAL',
              })
              void current.kill().catch(() => {})
            })
        }
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
            const sanitized = sanitizeDouyinWorkerLogLine(line)
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
                reject(new DouyinRuntimeError('DOUYIN_WORKER_DEADLINE', 'worker deadline'))
              }, remaining)
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          if (dispatchPromise) await dispatchPromise
          await Promise.race([
            streamEnded,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new DouyinRuntimeError('PROTOCOL', 'worker stream timeout')),
                2_000,
              )
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          decoder.finish()
          if (protocolFailure) throw protocolFailure
          if (stderrBytes > WORKER_STDERR_MAX_BYTES)
            throw new DouyinRuntimeError('PROTOCOL', 'worker stderr exceeded limit')
          const status = (result as { StatusCode?: number }).StatusCode ?? -1
          const terminal = events.at(-1)
          if (status !== 0 || !terminal || !TERMINAL_EVENTS.has(terminal.event))
            throw new DouyinRuntimeError('DOUYIN_WORKER_INCOMPLETE', 'worker did not finish')
          if (dispatchFailure) throw dispatchFailure
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
        if (cleanupFailure) throw new DouyinRuntimeError('CLEANUP_FAILED', 'worker cleanup failed')
        if (!completed) throw failure
        return completed
      })()
      const liveStream = stream!
      const send = (value: DouyinLoginCommand): Promise<void> => {
        if (args.kind !== 'login')
          return Promise.reject(
            new DouyinRuntimeError('PROTOCOL', 'only login workers take commands'),
          )
        const bytes = frame(value)
        return new Promise<void>((resolveWrite, rejectWrite) => {
          liveStream.write(bytes, (error) => {
            bytes.fill(0)
            if (error)
              rejectWrite(new DouyinRuntimeError('PROTOCOL', 'worker command write failed'))
            else resolveWrite()
          })
        })
      }
      const active = { container: current, broker, done, kind: args.kind, send }
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
        throw new DouyinRuntimeError('CLEANUP_FAILED', 'worker startup cleanup failed')
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
    beforeDispatch?: () => Promise<void>
    inputDirectory?: string
  }): Promise<{ result: unknown; storageState: unknown }> {
    const worker = await this.startWorker({
      key: args.profileDir,
      kind: 'action',
      pins: args.pins,
      deadlineMs: args.deadlineMs,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.beforeDispatch ? { beforeDispatch: args.beforeDispatch } : {}),
      ...(args.inputDirectory ? { inputDirectory: args.inputDirectory } : {}),
      input: {
        mode: 'action',
        actionId: args.actionId,
        params: args.params,
        storageState: args.storageState,
        cookieDomains: DOUYIN_PLUGIN_CONTRACT.runtime.accountState.cookieDomains,
        stateOrigins: DOUYIN_PLUGIN_CONTRACT.runtime.accountState.origins,
      },
    })
    const terminal = (await worker.done).at(-1)!
    if (terminal.event === 'failed')
      throw new DouyinRuntimeError(mapDouyinWorkerProtocolFailure(terminal.code))
    if (terminal.event === 'not_dispatched')
      throw new DouyinRuntimeError('PRECONDITION_CHANGED', 'Douyin target changed before dispatch')
    if (terminal.event !== 'completed')
      throw new DouyinRuntimeError('PROTOCOL', 'action worker terminal event is invalid')
    return { result: terminal.result, storageState: terminal.storageState }
  }

  async startLogin(args: {
    sessionId: string
    pins: readonly ManagedBrowserPinnedOrigin[]
    deadlineMs: number
    onQr: (png: Buffer, expireAt: number) => void
    onQrInvalid?: () => void
    onAuthenticated: (storageState: unknown) => void
    onFailed: (code: string) => void
    onVerification?: (kind: 'sms_available' | 'unsupported') => void
    onSmsSent?: (resendAfterSec: number) => void
    onSmsRejected?: () => void
    onSmsResendFailed?: () => void
  }): Promise<DouyinLoginWorkerHandle> {
    const worker = await this.startWorker({
      key: `login:${args.sessionId}`,
      kind: 'login',
      pins: args.pins,
      deadlineMs: args.deadlineMs,
      input: {
        mode: 'login',
        allowedOrigins: DOUYIN_LOGIN_ORIGINS.map((origin) => new URL(origin).origin),
        cookieDomains: DOUYIN_PLUGIN_CONTRACT.runtime.accountState.cookieDomains,
        stateOrigins: DOUYIN_PLUGIN_CONTRACT.runtime.accountState.origins,
      },
      onEvent: (event) => {
        if (event.event === 'qr') args.onQr(event.png, event.expireAt)
        else if (event.event === 'qr_invalid') args.onQrInvalid?.()
        else if (event.event === 'authenticated') args.onAuthenticated(event.storageState)
        else if (event.event === 'failed') args.onFailed(event.code)
        else if (event.event === 'verification') args.onVerification?.(event.kind)
        else if (event.event === 'sms_sent') args.onSmsSent?.(event.resendAfterSec)
        else if (event.event === 'sms_rejected') args.onSmsRejected?.()
        else if (event.event === 'sms_resend_failed') args.onSmsResendFailed?.()
      },
    })
    return {
      sessionId: args.sessionId,
      done: worker.done.then(() => undefined),
      stop: () => this.terminate(`login:${args.sessionId}`),
      command: (value) => worker.send(value),
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
      throw new DouyinRuntimeError('CLEANUP_FAILED', 'worker termination did not drain')
  }

  async closeAndDrain(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.starting])
    const keys = [...this.active.keys()]
    await Promise.all(keys.map((key) => this.terminate(key)))
    if (this.active.size !== 0)
      throw new DouyinRuntimeError('CLEANUP_FAILED', 'workers remain during shutdown')
  }
}

class DouyinManagedSession implements ManagedBrowserSession {
  readonly driverSession = this
  private completed: { result: unknown; storageState: unknown } | null = null
  private executing = false

  constructor(
    private readonly service: DouyinDockerService,
    private readonly args: ManagedBrowserLaunchArgs,
  ) {}

  async execute(
    actionId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    beforeDispatch?: () => Promise<void>,
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
        deadlineMs: Date.now() + (beforeDispatch ? WRITE_SESSION_MS : ACTION_SESSION_MS),
        signal,
        ...(beforeDispatch ? { beforeDispatch } : {}),
        ...(this.args.inputDirectory ? { inputDirectory: this.args.inputDirectory } : {}),
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

export function createDouyinRuntimeRegistries(service: DouyinDockerService): {
  drivers: ReadonlyMap<string, ManagedBrowserDriverV1>
  launchers: ReadonlyMap<string, ManagedBrowserLauncherV1>
} {
  const launcher: ManagedBrowserLauncherV1 = {
    id: DOUYIN_LAUNCHER_ID,
    version: DOUYIN_LAUNCHER_VERSION,
    capabilities: REQUIRED_BROWSER_LAUNCHER_CAPABILITIES,
    async launch(args) {
      return new DouyinManagedSession(service, args)
    },
    terminate: (profileDir) => service.terminate(profileDir),
  }
  const driver: ManagedBrowserDriverV1 = {
    id: DOUYIN_DRIVER_ID,
    version: DOUYIN_DRIVER_VERSION,
    launcherId: DOUYIN_LAUNCHER_ID,
    launcherVersion: DOUYIN_LAUNCHER_VERSION,
    maximumNetwork: { origins: DOUYIN_NETWORK_ORIGINS, methods: ['GET'] },
    async execute(args) {
      if (!(args.session instanceof DouyinManagedSession))
        throw new ManagedBrowserRuntimeError('EXECUTION_FAILED', 'driver session is invalid')
      return args.session.execute(args.actionId, args.params, args.signal, args.beforeDispatch)
    },
  }
  return {
    drivers: new Map([[`${driver.id}@${driver.version}`, driver]]),
    launchers: new Map([[`${launcher.id}@${launcher.version}`, launcher]]),
  }
}

export function validateDouyinState(input: unknown): BrowserStorageStateV1 {
  return validateBrowserStorageState(input, DOUYIN_PLUGIN_CONTRACT)
}
