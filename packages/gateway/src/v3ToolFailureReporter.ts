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
}): ToolFailureReporter {
  const dir = deps.queueDir ?? defaultToolFailureQueueDir()
  const now = deps.now ?? (() => Date.now())
  const bus = deps.eventBus ?? eventBus
  const drainIntervalMs = deps.drainIntervalMs ?? DRAIN_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  let draining = false
  let pendingKick = false
  let started = false

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

  async function enqueue(payload: ToolFailureReportPayload): Promise<void> {
    await ensureDir()
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
    void enqueue(payload).catch((err) => {
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
        stats.retried += 1
        entry.attempts += 1
        entry.lastErrorAt = now()
        entry.lastErrorMessage = cap(err instanceof Error ? err.message : String(err), 300)
        await atomicWriteJson(filepath, entry)
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
  const cfg = readToolFailureReportConfig(process.env)
  if (!cfg) {
    log.info('tool failure reporter disabled: commercial master env not configured')
    return null
  }
  const reporter = makeToolFailureReporter({ config: cfg })
  reporter.start()
  return reporter
}
