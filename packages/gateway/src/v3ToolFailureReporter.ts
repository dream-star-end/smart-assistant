/**
 * Container → master failed tool-call reporter.
 *
 * Gateway already emits `tool.called` for metrics. This module adds a
 * commercial-only, non-blocking telemetry path for failed tool calls so backend
 * operators can inspect repeated tool failures and improve tool adapters/UI.
 * The Codex child process never receives the commercial master token; the
 * long-lived gateway process sends reports using its own env.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ToolCalledEvent } from '@openclaude/protocol'

import { eventBus, type GatewayEventBus } from './eventBus.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3ToolFailureReporter' })

export const TOOL_FAILURE_AUDIT_PATH = '/internal/v3/agent-audit/tool-failure'

const MAX_PREVIEW_CHARS = 4_096
const MAX_FIELD_CHARS = 512
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000
const DRAIN_INTERVAL_MS = 30_000
const RETRY_BACKOFF_BASE_MS = 5_000
const RETRY_BACKOFF_MAX_MS = 5 * 60_000
const ATTEMPT_TIMEOUT_MS = 10_000
/** 磁盘队列条数上限:master 长期不可达时不允许队列无界膨胀(默认 500,测试可注入)。 */
const MAX_QUEUE_ENTRIES = 500
/** 队列超限丢弃的 warn 限频窗口:突发失败风暴下防日志刷屏。 */
const QUEUE_OVERFLOW_WARN_INTERVAL_MS = 60_000

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

export interface ToolFailureReportPayload {
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

interface ToolFailureQueueEntry {
  schemaVersion: 1
  payload: ToolFailureReportPayload
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
  const home = process.env.OPENCLAUDE_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.openclaude')
  return join(home, 'tool-failure-report.d')
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 12))}…[truncated]`
}

function scrubPreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return cap(value, MAX_PREVIEW_CHARS)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/oc-v3\.\d+\.[0-9a-f]{32,128}/gi, '[redacted-container-token]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
}

function safeString(value: unknown, fallback: string, max = MAX_FIELD_CHARS): string {
  return typeof value === 'string' && value.trim().length > 0
    ? cap(value.trim(), max)
    : fallback
}

function retryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20), RETRY_BACKOFF_MAX_MS)
}

export function buildToolFailureReportPayload(ev: ToolCalledEvent): ToolFailureReportPayload | null {
  if (!ev.isError) return null
  return {
    schemaVersion: 1,
    eventId: safeString(ev.id, createHash('sha256').update(JSON.stringify(ev)).digest('hex'), 128),
    sessionKey: safeString(ev.sessionKey, 'unknown', 512),
    agentId: safeString(ev.agentId, 'unknown', 128),
    turnIndex: Number.isFinite(ev.turnIndex) ? Math.max(0, Math.trunc(ev.turnIndex)) : 0,
    toolName: safeString(ev.toolName, 'unknown', 128),
    durationMs: Number.isFinite(ev.durationMs) ? Math.max(0, Math.trunc(ev.durationMs)) : 0,
    inputPreview: scrubPreview(ev.inputPreview),
    outputPreview: scrubPreview(ev.outputPreview),
    timestamp: Number.isFinite(ev.timestamp) ? Math.max(0, Math.trunc(ev.timestamp)) : Date.now(),
  }
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
    const res = await fetchImpl(`${cfg.masterBaseUrl}${TOOL_FAILURE_AUDIT_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.containerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (res.ok) return
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500
    throw new ToolFailureReportError(`tool failure audit returned HTTP ${res.status}`, retryable, res.status)
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
  maxQueueEntries?: number
}): ToolFailureReporter {
  const dir = deps.queueDir ?? defaultToolFailureQueueDir()
  const now = deps.now ?? (() => Date.now())
  const bus = deps.eventBus ?? eventBus
  const drainIntervalMs = deps.drainIntervalMs ?? DRAIN_INTERVAL_MS
  const maxQueueEntries = deps.maxQueueEntries ?? MAX_QUEUE_ENTRIES
  let timer: ReturnType<typeof setInterval> | null = null
  let draining = false
  let pendingKick = false
  let started = false
  // enqueue 串行链:事件突发时并发 readdir 会各自看到旧计数,上限被击穿;串行化保证准确。
  let enqueueChain: Promise<void> = Promise.resolve()
  let lastOverflowWarnAt = 0

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  function filename(): string {
    return `${now()}-${randomBytes(8).toString('hex')}.json`
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

  async function enqueue(payload: ToolFailureReportPayload): Promise<void> {
    await ensureDir()
    // 条数上限:超限先丢最旧(文件名前缀是毫秒时间戳,字典序≈时间序),再写新条目;
    // warn 限频,避免 master 长期不可达 + 工具失败风暴时日志刷屏。
    const existing = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    if (existing.length >= maxQueueEntries) {
      const overflow = existing.slice(0, existing.length - maxQueueEntries + 1)
      await Promise.all(overflow.map((f) => unlink(join(dir, f)).catch(() => {})))
      if (now() - lastOverflowWarnAt >= QUEUE_OVERFLOW_WARN_INTERVAL_MS) {
        lastOverflowWarnAt = now()
        log.warn('tool failure queue over capacity: dropped oldest entries', {
          dropped: overflow.length,
          max: maxQueueEntries,
        })
      }
    }
    await atomicWriteJson(join(dir, filename()), {
      schemaVersion: 1,
      payload,
      firstSeenAt: now(),
      attempts: 0,
    } satisfies ToolFailureQueueEntry)
    kick()
  }

  function onToolCalled(ev: ToolCalledEvent): void {
    const payload = buildToolFailureReportPayload(ev)
    if (!payload) return
    enqueueChain = enqueueChain
      .then(() => enqueue(payload))
      .catch((err) => {
        log.warn('failed to enqueue tool failure report', { eventId: payload.eventId, toolName: payload.toolName }, err)
      })
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
        if (pendingKick) {
          pendingKick = false
          setTimeout(kick, 1_000)
        }
      })
  }

  async function drainOnce(): Promise<{ considered: number; sent: number; retried: number; dropped: number }> {
    await ensureDir()
    const stats = { considered: 0, sent: 0, retried: 0, dropped: 0 }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    for (const file of files) {
      const filepath = join(dir, file)
      let entry: ToolFailureQueueEntry
      try {
        entry = JSON.parse(await readFile(filepath, 'utf8')) as ToolFailureQueueEntry
      } catch (err) {
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
        log.warn('dropped expired tool failure queue entry', { file, eventId: entry.payload?.eventId })
        continue
      }
      const last = entry.lastErrorAt ?? entry.firstSeenAt
      if (entry.attempts > 0 && now() - last < retryBackoffMs(entry.attempts)) continue
      try {
        await sendToolFailureReport(entry.payload, deps.config, { fetchImpl: deps.fetchImpl })
        stats.sent += 1
        await unlink(filepath).catch(() => {})
      } catch (err) {
        if (err instanceof ToolFailureReportError && !err.retryable) {
          stats.dropped += 1
          await unlink(filepath).catch(() => {})
          log.warn('dropped fatal tool failure report', { eventId: entry.payload?.eventId, status: err.status })
          continue
        }
        entry.attempts += 1
        entry.lastErrorAt = now()
        entry.lastErrorMessage = cap(err instanceof Error ? err.message : String(err), 300)
        if (!(await updateEntryInPlace(filepath, entry))) {
          // send 期间条目已被队列上限 unlink → 不复活,按 dropped 计
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

  return {
    start() {
      if (started) return
      started = true
      bus.on('tool.called', onToolCalled)
      timer = setInterval(kick, drainIntervalMs)
      timer.unref?.()
      kick()
      log.info('tool failure reporter started')
    },
    stop() {
      if (!started) return
      started = false
      bus.off('tool.called', onToolCalled)
      if (timer) clearInterval(timer)
      timer = null
    },
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
