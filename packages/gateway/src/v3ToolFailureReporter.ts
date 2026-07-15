/**
 * Container → master privacy-safe tool-call reporter.
 *
 * Gateway already emits `tool.called` for metrics. This module adds a
 * commercial-only, non-blocking telemetry path: every call contributes only to
 * bounded aggregate counters, while failures also produce a privacy-safe row so
 * operators can inspect repeated failures and improve tool adapters/UI.
 * The Codex child process never receives the commercial master token; the
 * long-lived gateway process sends reports using its own env.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  type ToolCalledEvent,
  type ToolFailureErrorClass,
  type ToolFailureKind,
  type ToolTerminationReason,
  classifyToolFailure,
} from '@openclaude/protocol'

import { type GatewayEventBus, eventBus } from './eventBus.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3ToolFailureReporter' })

export const TOOL_FAILURE_AUDIT_PATH = '/internal/v3/agent-audit/tool-failure'
export const TOOL_CALL_ROLLUP_PATH = '/internal/v3/agent-audit/tool-rollup'
export const TOOL_AUDIT_SCHEMA_HEADER = 'x-openclaude-tool-audit-schema'

const MAX_FIELD_CHARS = 512
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000
const DRAIN_INTERVAL_MS = 30_000
const ROLLUP_INTERVAL_MS = 5 * 60_000
const RETRY_BACKOFF_BASE_MS = 5_000
const RETRY_BACKOFF_MAX_MS = 5 * 60_000
const ATTEMPT_TIMEOUT_MS = 10_000
const ENQUEUE_DRAIN_DEBOUNCE_MS = 50
const MAX_ROLLUP_DIMENSIONS = 256
const MAX_ROLLUP_COUNT = 1_000_000
/** 磁盘队列条数上限:master 长期不可达时不允许队列无界膨胀(默认 500,测试可注入)。 */
const MAX_QUEUE_ENTRIES = 500
/** 队列超限丢弃的 warn 限频窗口:突发失败风暴下防日志刷屏。 */
const QUEUE_OVERFLOW_WARN_INTERVAL_MS = 60_000
const FAILURE_QUEUE_PREFIX = 'failure-'
const ROLLUP_QUEUE_PREFIX = 'rollup-'

/**
 * 遥测显式开关 env(与 master 侧 internalToolFailureAudit 路由门控同名,双端一致)。
 *
 * 为什么不能只靠 OPENCLAUDE_V3_MASTER_BASE_URL/OPENCLAUDE_V3_CONTAINER_TOKEN 存在性:
 * 这俩是商业容器的必备 env(server-authored sink 等也依赖),存在性门控等于事实恒开、
 * 无法关停;且这套代码将来合回 v3 生产分支时会静默对现网用户开启明文遥测。
 * 本开关由 master 进程 env 显式设置,supervisor(v3supervisor.ts)仅在 master 设了
 * 才透传进容器 —— 不设即全链关停,隐私默认安全。
 */
export const TOOL_FAILURE_AUDIT_ENV = 'OC_TOOL_FAILURE_AUDIT'

export function isToolFailureAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TOOL_FAILURE_AUDIT_ENV] === '1'
}

export interface ToolFailureReportConfig {
  masterBaseUrl: string
  containerToken: string
}

/** Legacy on-disk queue / rolling-upgrade payload. New reports never create v1. */
export interface ToolFailureReportPayloadV1 {
  schemaVersion: 1
  eventId: string
  sessionKey: string
  agentId: string
  turnIndex: number
  toolName: string
  durationMs: number
  inputPreview?: string
  outputPreview?: string
  timestamp: number
}

export interface ToolFailureReportPayloadV2 {
  schemaVersion: 2
  eventId: string
  sessionKey: string
  agentId: string
  turnIndex: number
  toolName: string
  durationMs: number
  inputHash?: string
  outputHash?: string
  errorClass: ToolFailureErrorClass
  timestamp: number
}

export interface ToolFailureReportPayloadV3 {
  schemaVersion: 3
  eventId: string
  sessionKey: string
  agentId: string
  turnIndex: number
  toolName: string
  durationMs: number
  inputHash?: string
  outputHash?: string
  errorClass: ToolFailureErrorClass
  failureKind: ToolFailureKind
  exitCode?: number
  terminationReason?: ToolTerminationReason
  timestamp: number
}

export type ToolFailureReportPayload =
  | ToolFailureReportPayloadV1
  | ToolFailureReportPayloadV2
  | ToolFailureReportPayloadV3

export interface ToolCallRollupCount {
  agentId: string
  toolName: string
  outcome: 'success' | 'failure'
  errorClass: ToolFailureErrorClass | 'none'
  failureKind: ToolFailureKind | 'none'
  count: number
}

export interface ToolCallRollupPayload {
  schemaVersion: 1
  reportId: string
  reporterRunId: string
  sequence: number
  windowStartedAt: number
  windowEndedAt: number
  counts: ToolCallRollupCount[]
}

interface ToolReportQueueEntry {
  schemaVersion: 1 | 2
  kind?: 'failure' | 'rollup'
  payload: ToolFailureReportPayload | ToolCallRollupPayload
  firstSeenAt: number
  attempts: number
  lastErrorAt?: number
  lastErrorMessage?: string
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

type EventBusLike = Pick<GatewayEventBus, 'on' | 'off'>

export class ToolFailureReportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ToolFailureReportError'
  }
}

export function readToolFailureReportConfig(
  env: NodeJS.ProcessEnv = process.env,
): ToolFailureReportConfig | null {
  // 显式开关叠加既有 env 条件:OC_TOOL_FAILURE_AUDIT != '1' 时无条件视为未配置。
  if (!isToolFailureAuditEnabled(env)) return null
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return null
  return {
    masterBaseUrl: base.replace(/\/+$/, ''),
    containerToken: token,
  }
}

export function defaultToolFailureQueueDir(): string {
  const home =
    process.env.OPENCLAUDE_HOME?.trim() ||
    join(process.env.HOME?.trim() || homedir(), '.openclaude')
  return join(home, 'tool-failure-report.d')
}

type QueueKind = 'failure' | 'rollup'

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 12))}…[truncated]`
}

function safeString(value: unknown, fallback: string, max = MAX_FIELD_CHARS): string {
  return typeof value === 'string' && value.trim().length > 0 ? cap(value.trim(), max) : fallback
}

function retryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20), RETRY_BACKOFF_MAX_MS)
}

function sha256Preview(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex')
}

export function buildToolFailureReportPayload(
  ev: ToolCalledEvent,
): ToolFailureReportPayloadV3 | null {
  if (!ev.isError) return null
  const classification = classifyToolFailure({
    outputPreview: ev.outputPreview,
    exitCode: ev.exitCode,
    terminationReason: ev.terminationReason,
  })
  return {
    schemaVersion: 3,
    eventId: safeString(ev.id, createHash('sha256').update(JSON.stringify(ev)).digest('hex'), 128),
    sessionKey: safeString(ev.sessionKey, 'unknown', 512),
    agentId: safeString(ev.agentId, 'unknown', 128),
    turnIndex: Number.isFinite(ev.turnIndex) ? Math.max(0, Math.trunc(ev.turnIndex)) : 0,
    toolName: safeString(ev.toolName, 'unknown', 128),
    durationMs: Number.isFinite(ev.durationMs) ? Math.max(0, Math.trunc(ev.durationMs)) : 0,
    inputHash: sha256Preview(ev.inputPreview),
    outputHash: sha256Preview(ev.outputPreview),
    errorClass: classification.errorClass,
    failureKind: classification.failureKind,
    ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
    ...(ev.terminationReason !== undefined ? { terminationReason: ev.terminationReason } : {}),
    timestamp: Number.isFinite(ev.timestamp) ? Math.max(0, Math.trunc(ev.timestamp)) : Date.now(),
  }
}

function v2Projection(payload: ToolFailureReportPayloadV3): ToolFailureReportPayloadV2 {
  const errorClass =
    payload.errorClass === 'not_executable'
      ? 'permission_denied'
      : payload.errorClass === 'process_exit' || payload.errorClass === 'edit_conflict'
        ? 'other'
        : payload.errorClass
  return {
    schemaVersion: 2,
    eventId: payload.eventId,
    sessionKey: payload.sessionKey,
    agentId: payload.agentId,
    turnIndex: payload.turnIndex,
    toolName: payload.toolName,
    durationMs: payload.durationMs,
    ...(payload.inputHash !== undefined ? { inputHash: payload.inputHash } : {}),
    ...(payload.outputHash !== undefined ? { outputHash: payload.outputHash } : {}),
    errorClass,
    timestamp: payload.timestamp,
  }
}

let schemaFallbackWarned = false

function retryableStatus(status: number, rollup = false): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    (rollup && (status === 404 || status === 405))
  )
}

async function postReport(
  path: string,
  payload: unknown,
  cfg: ToolFailureReportConfig,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImpl(`${cfg.masterBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.containerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  })
}

export async function sendToolFailureReport(
  payload: ToolFailureReportPayload,
  cfg: ToolFailureReportConfig,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS)
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    let res = await postReport(TOOL_FAILURE_AUDIT_PATH, payload, cfg, fetchImpl, controller.signal)
    if (res.ok) return
    if (
      payload.schemaVersion === 3 &&
      res.status === 400 &&
      res.headers.get(TOOL_AUDIT_SCHEMA_HEADER) === null
    ) {
      if (!schemaFallbackWarned) {
        schemaFallbackWarned = true
        log.warn('tool failure audit master lacks schema v3; falling back to v2')
      }
      res = await postReport(
        TOOL_FAILURE_AUDIT_PATH,
        v2Projection(payload),
        cfg,
        fetchImpl,
        controller.signal,
      )
      if (res.ok) return
    }
    throw new ToolFailureReportError(
      `tool failure audit returned HTTP ${res.status}`,
      retryableStatus(res.status),
      res.status,
    )
  } catch (err) {
    if (err instanceof ToolFailureReportError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ToolFailureReportError(message, true)
  } finally {
    clearTimeout(timer)
  }
}

export async function sendToolCallRollup(
  payload: ToolCallRollupPayload,
  cfg: ToolFailureReportConfig,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS)
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await postReport(TOOL_CALL_ROLLUP_PATH, payload, cfg, fetchImpl, controller.signal)
    if (res.ok) return
    throw new ToolFailureReportError(
      `tool call rollup returned HTTP ${res.status}`,
      retryableStatus(res.status, true),
      res.status,
    )
  } catch (err) {
    if (err instanceof ToolFailureReportError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ToolFailureReportError(message, true)
  } finally {
    clearTimeout(timer)
  }
}

export interface ToolFailureReporter {
  start(): void
  stop(): void
  shutdown(timeoutMs?: number): Promise<void>
  flushRollup(): Promise<void>
  drainOnce(): Promise<{ considered: number; sent: number; retried: number; dropped: number }>
  pendingCount(): Promise<number>
}

export function makeToolFailureReporter(deps: {
  config: ToolFailureReportConfig
  queueDir?: string
  eventBus?: EventBusLike
  fetchImpl?: FetchLike
  now?: () => number
  drainIntervalMs?: number
  rollupIntervalMs?: number
  maxQueueEntries?: number
  maxRollupQueueEntries?: number
  maxRollupDimensions?: number
  maxRollupCount?: number
  reporterRunId?: string
}): ToolFailureReporter {
  const dir = deps.queueDir ?? defaultToolFailureQueueDir()
  const now = deps.now ?? (() => Date.now())
  const bus = deps.eventBus ?? eventBus
  const drainIntervalMs = deps.drainIntervalMs ?? DRAIN_INTERVAL_MS
  const rollupIntervalMs = deps.rollupIntervalMs ?? ROLLUP_INTERVAL_MS
  const maxQueueEntries = deps.maxQueueEntries ?? MAX_QUEUE_ENTRIES
  const maxRollupQueueEntries = deps.maxRollupQueueEntries ?? MAX_QUEUE_ENTRIES
  const maxRollupDimensions = Math.max(
    1,
    Math.trunc(
      Math.min(MAX_ROLLUP_DIMENSIONS, deps.maxRollupDimensions ?? MAX_ROLLUP_DIMENSIONS),
    ),
  )
  const maxRollupCount = Math.max(
    1,
    Math.trunc(Math.min(MAX_ROLLUP_COUNT, deps.maxRollupCount ?? MAX_ROLLUP_COUNT)),
  )
  const reporterRunId = deps.reporterRunId ?? randomBytes(16).toString('hex')
  let drainTimer: ReturnType<typeof setInterval> | null = null
  let rollupTimer: ReturnType<typeof setInterval> | null = null
  let drainKickTimer: ReturnType<typeof setTimeout> | null = null
  let draining = false
  let pendingKick = false
  let started = false
  let shutdownPromise: Promise<void> | null = null
  // enqueue 串行链:事件突发时并发 readdir 会各自看到旧计数,上限被击穿;串行化保证准确。
  let enqueueChain: Promise<void> = Promise.resolve()
  let rollupFlushChain: Promise<void> = Promise.resolve()
  let lastOverflowWarnAt = 0
  let rollupStartedAt = now()
  let rollupSequence = 0
  const rollupCounts = new Map<string, ToolCallRollupCount>()

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  function filename(kind: QueueKind): string {
    const prefix = kind === 'rollup' ? ROLLUP_QUEUE_PREFIX : FAILURE_QUEUE_PREFIX
    return `${prefix}${now()}-${randomBytes(8).toString('hex')}.json`
  }

  function fileKind(file: string): QueueKind {
    return file.startsWith(ROLLUP_QUEUE_PREFIX) ? 'rollup' : 'failure'
  }

  async function atomicWriteJson(filepath: string, data: unknown): Promise<void> {
    const tmp = `${filepath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(JSON.stringify(data), 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, filepath)
  }

  /**
   * 重试元数据(attempts/lastError*)的就地回写。**必须**用 'r+'(要求文件仍存在),
   * 不能走 atomicWriteJson:rename 覆盖会把 send 期间刚被队列上限 unlink 的条目
   * 重建"复活",击穿上限。'r+' 下条目已被丢弃 → ENOENT,返回 false 由调用方按
   * dropped 处理;open 成功后即使再被 unlink,写的也只是孤儿 inode,无害。
   * 代价:非原子写,进程崩溃恰在写中 → JSON 残缺 → 下轮 drain 按 unreadable 丢弃
   * (已有该路径 + warn 日志)—— 对失败遥测队列可接受。
   */
  async function updateEntryInPlace(filepath: string, data: unknown): Promise<boolean> {
    let fh: Awaited<ReturnType<typeof open>>
    try {
      fh = await open(filepath, 'r+')
    } catch {
      return false
    }
    try {
      const buf = Buffer.from(JSON.stringify(data), 'utf8')
      await fh.truncate(0)
      await fh.write(buf, 0, buf.length, 0)
      await fh.sync()
    } finally {
      await fh.close()
    }
    return true
  }

  async function enqueue(
    kind: QueueKind,
    payload: ToolFailureReportPayload | ToolCallRollupPayload,
  ): Promise<void> {
    await ensureDir()
    // 条数上限:超限先丢最旧(文件名前缀是毫秒时间戳,字典序≈时间序),再写新条目;
    // warn 限频,避免 master 长期不可达 + 工具失败风暴时日志刷屏。
    const cap = kind === 'rollup' ? maxRollupQueueEntries : maxQueueEntries
    const existing = (await readdir(dir))
      .filter((f) => f.endsWith('.json') && fileKind(f) === kind)
      .sort()
    if (existing.length >= cap) {
      const overflow = existing.slice(0, existing.length - cap + 1)
      await Promise.all(overflow.map((f) => unlink(join(dir, f)).catch(() => {})))
      if (now() - lastOverflowWarnAt >= QUEUE_OVERFLOW_WARN_INTERVAL_MS) {
        lastOverflowWarnAt = now()
        log.warn('tool failure queue over capacity: dropped oldest entries', {
          dropped: overflow.length,
          max: cap,
          kind,
        })
      }
    }
    await atomicWriteJson(join(dir, filename(kind)), {
      schemaVersion: kind === 'rollup' ? 2 : 1,
      kind,
      payload,
      firstSeenAt: now(),
      attempts: 0,
    } satisfies ToolReportQueueEntry)
    scheduleKick()
  }

  function rollupCountOf(ev: ToolCalledEvent): ToolCallRollupCount {
    const agentId = safeString(ev.agentId, 'unknown', 128)
    const toolName = safeString(ev.toolName, 'unknown', 128)
    if (!ev.isError) {
      return {
        agentId,
        toolName,
        outcome: 'success',
        errorClass: 'none',
        failureKind: 'none',
        count: 1,
      }
    }
    const failure = classifyToolFailure({
      outputPreview: ev.outputPreview,
      exitCode: ev.exitCode,
      terminationReason: ev.terminationReason,
    })
    return {
      agentId,
      toolName,
      outcome: 'failure',
      errorClass: failure.errorClass,
      failureKind: failure.failureKind,
      count: 1,
    }
  }

  function addRollupCount(count: ToolCallRollupCount): void {
    const key = JSON.stringify([
      count.agentId,
      count.toolName,
      count.outcome,
      count.errorClass,
      count.failureKind,
    ])
    const existing = rollupCounts.get(key)
    if (existing) existing.count += count.count
    else rollupCounts.set(key, { ...count })
  }

  function splitRollupCounts(counts: ToolCallRollupCount[]): ToolCallRollupCount[][] {
    if (counts.length === 0) return [[]]
    const batches: Array<{
      counts: ToolCallRollupCount[]
      dimensions: Set<string>
    }> = []
    for (const count of counts) {
      const dimension = JSON.stringify([
        count.agentId,
        count.toolName,
        count.outcome,
        count.errorClass,
        count.failureKind,
      ])
      let remaining = count.count
      while (remaining > 0) {
        let target = batches.find(
          (batch) =>
            batch.counts.length < maxRollupDimensions && !batch.dimensions.has(dimension),
        )
        if (!target) {
          target = { counts: [], dimensions: new Set() }
          batches.push(target)
        }
        target.counts.push({ ...count, count: Math.min(remaining, maxRollupCount) })
        target.dimensions.add(dimension)
        remaining -= maxRollupCount
      }
    }
    return batches.map((batch) => batch.counts)
  }

  function enqueueFailure(payload: ToolFailureReportPayload): void {
    enqueueChain = enqueueChain
      .then(() => enqueue('failure', payload))
      .catch((err) => {
        log.warn(
          'failed to enqueue tool failure report',
          { eventId: payload.eventId, toolName: payload.toolName },
          err,
        )
      })
  }

  function flushRollup(): Promise<void> {
    const task = rollupFlushChain.then(async () => {
      const windowEndedAt = now()
      const windowStartedAt = rollupStartedAt
      const counts = [...rollupCounts.values()].map((count) => ({ ...count }))
      rollupCounts.clear()
      rollupStartedAt = windowEndedAt
      const batches = splitRollupCounts(counts)
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index]
        const sequence = rollupSequence + 1
        const payload: ToolCallRollupPayload = {
          schemaVersion: 1,
          reportId: randomBytes(16).toString('hex'),
          reporterRunId,
          sequence,
          windowStartedAt,
          windowEndedAt,
          counts: batch,
        }
        try {
          const enqueueTask = enqueueChain.then(() => enqueue('rollup', payload))
          enqueueChain = enqueueTask.catch(() => {})
          await enqueueTask
          rollupSequence = sequence
        } catch (err) {
          // Earlier chunks are already durable and keep their sequence. Merge
          // only the unsaved chunks into the active window, so a later flush
          // resumes at the next sequence without duplicating accepted counts.
          for (const unsaved of batches.slice(index)) {
            for (const count of unsaved) addRollupCount(count)
          }
          rollupStartedAt = Math.min(rollupStartedAt, windowStartedAt)
          throw err
        }
      }
    })
    rollupFlushChain = task.catch(() => {})
    return task
  }

  function onToolCalled(ev: ToolCalledEvent): void {
    addRollupCount(rollupCountOf(ev))
    const payload = buildToolFailureReportPayload(ev)
    if (payload) enqueueFailure(payload)
  }

  function kick(): void {
    if (draining) {
      pendingKick = true
      return
    }
    draining = true
    void drainOnce()
      .catch((err) => log.warn('tool failure report drain failed', {}, err))
      .finally(() => {
        draining = false
        if (pendingKick && started) {
          pendingKick = false
          setTimeout(kick, 1_000)
        }
      })
  }

  function scheduleKick(): void {
    if (!started) return
    if (drainKickTimer) clearTimeout(drainKickTimer)
    drainKickTimer = setTimeout(() => {
      drainKickTimer = null
      kick()
    }, ENQUEUE_DRAIN_DEBOUNCE_MS)
    drainKickTimer.unref?.()
  }

  async function drainOnce(): Promise<{
    considered: number
    sent: number
    retried: number
    dropped: number
  }> {
    await ensureDir()
    const stats = { considered: 0, sent: 0, retried: 0, dropped: 0 }
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => {
        const kindOrder = Number(fileKind(a) !== 'rollup') - Number(fileKind(b) !== 'rollup')
        return kindOrder !== 0 ? kindOrder : a.localeCompare(b)
      })
    for (const file of files) {
      const filepath = join(dir, file)
      let entry: ToolReportQueueEntry
      try {
        entry = JSON.parse(await readFile(filepath, 'utf8')) as ToolReportQueueEntry
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') continue
        stats.dropped += 1
        await unlink(filepath).catch(() => {})
        log.warn('dropped unreadable tool failure queue entry', { file }, err)
        continue
      }
      stats.considered += 1
      const age = now() - entry.firstSeenAt
      if (age > ENTRY_TTL_MS) {
        stats.dropped += 1
        await unlink(filepath).catch(() => {})
        log.warn('dropped expired tool report queue entry', { file })
        continue
      }
      const last = entry.lastErrorAt ?? entry.firstSeenAt
      if (entry.attempts > 0 && now() - last < retryBackoffMs(entry.attempts)) continue
      try {
        const kind = entry.kind ?? fileKind(file)
        if (kind === 'rollup') {
          await sendToolCallRollup(entry.payload as ToolCallRollupPayload, deps.config, {
            fetchImpl: deps.fetchImpl,
          })
        } else {
          await sendToolFailureReport(entry.payload as ToolFailureReportPayload, deps.config, {
            fetchImpl: deps.fetchImpl,
          })
        }
        stats.sent += 1
        await unlink(filepath).catch(() => {})
      } catch (err) {
        if (err instanceof ToolFailureReportError && !err.retryable) {
          stats.dropped += 1
          await unlink(filepath).catch(() => {})
          log.warn('dropped fatal tool report', {
            kind: entry.kind ?? fileKind(file),
            status: err.status,
          })
          continue
        }
        entry.attempts += 1
        entry.lastErrorAt = now()
        entry.lastErrorMessage = cap(err instanceof Error ? err.message : String(err), 300)
        if (!(await updateEntryInPlace(filepath, entry))) {
          // 条目可能已被旧版进程或外部清理;不复活,按 dropped 计。
          stats.dropped += 1
          continue
        }
        stats.retried += 1
      }
    }
    return stats
  }

  async function pendingCount(): Promise<number> {
    try {
      await ensureDir()
      return (await readdir(dir)).filter((f) => f.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  function stopListening(): void {
    if (!started) return
    started = false
    bus.off('tool.called', onToolCalled)
    if (drainTimer) clearInterval(drainTimer)
    if (rollupTimer) clearInterval(rollupTimer)
    if (drainKickTimer) clearTimeout(drainKickTimer)
    drainTimer = null
    rollupTimer = null
    drainKickTimer = null
    pendingKick = false
  }

  function shutdown(timeoutMs = 5_000): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    stopListening()
    const flush = (async () => {
      await flushRollup()
      await rollupFlushChain
      await enqueueChain
    })()
    shutdownPromise = new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(
        () => {
          log.warn('tool report shutdown flush timed out', { timeoutMs })
          finish()
        },
        Math.max(0, timeoutMs),
      )
      timer.unref?.()
      flush.then(finish, (err) => {
        log.warn('tool report shutdown flush failed', {}, err)
        finish()
      })
    })
    return shutdownPromise
  }

  return {
    start() {
      if (started) return
      started = true
      bus.on('tool.called', onToolCalled)
      drainTimer = setInterval(kick, drainIntervalMs)
      drainTimer.unref?.()
      rollupTimer = setInterval(() => {
        void flushRollup().catch((err) => log.warn('tool call rollup flush failed', {}, err))
      }, rollupIntervalMs)
      rollupTimer.unref?.()
      kick()
      log.info('tool failure reporter started', { rollupIntervalMs })
    },
    stop() {
      stopListening()
    },
    shutdown,
    flushRollup,
    drainOnce,
    pendingCount,
  }
}

export function startToolFailureReporter(): ToolFailureReporter | null {
  // 显式 opt-in:遥测默认关(隐私红线)。未设 OC_TOOL_FAILURE_AUDIT=1 → 打一行日志后 no-op,
  // 与 OPENCLAUDE_V3_MASTER_BASE_URL/OPENCLAUDE_V3_CONTAINER_TOKEN(容器必备 env)解耦。
  if (!isToolFailureAuditEnabled(process.env)) {
    log.info('tool failure reporter disabled: OC_TOOL_FAILURE_AUDIT != 1 (explicit opt-in)')
    return null
  }
  const cfg = readToolFailureReportConfig(process.env)
  if (!cfg) {
    log.info('tool failure reporter disabled: commercial master env not configured')
    return null
  }
  const reporter = makeToolFailureReporter({ config: cfg })
  reporter.start()
  return reporter
}
