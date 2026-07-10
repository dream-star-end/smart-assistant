/**
 * Container → master marketplace skill-usage reporter.
 *
 * 市场质量信号闭环(批2)的容器上报器。gateway 既有的 `tool.called` 事件流里,
 * hub 技能被 `skill_view` 调用即视为一次「真实使用」。本模块把这类事件低敏上报给
 * master(只记 slug / agentId / sessionKey / traceId 这类**元数据**,绝不带技能内容
 * 或用户输入),master 侧 verifyContainerIdentity 推导 userId 后落库
 * `marketplace_skill_usage_events`,聚合出目录的 usage30d / users30d + 评分归因。
 *
 * 范式 clone 自 v3ToolFailureReporter:落盘队列 + 定时 drain POST + TTL/退避/队列上限 +
 * 幂等 event_id。与 tool-failure 的**唯一语义差异**见 SKILL_USAGE_ENV / 门控注释。
 *
 * fail-open 红线:本模块任何失败(解析不出 slug、hub 目录不存在、master 不可达、
 * 队列写盘失败)都**绝不** throw 回工具链路、**绝不**影响 turn 执行 —— 使用信号是
 * 弱信号,允许漏,不允许拖垮主流程。Codex 子进程永远拿不到 master token,只有长驻
 * gateway 进程用自身 env 上报。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ToolCalledEvent } from '@openclaude/protocol'

import { eventBus, type GatewayEventBus } from './eventBus.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'skillUsageReporter' })

export const SKILL_USAGE_PATH = '/internal/v3/marketplace/skill-usage'

/** hub 技能被此工具查看即计一次使用(与 openclaude-memory MCP 的 skill_view 对齐)。 */
export const SKILL_VIEW_TOOL = 'mcp__openclaude-memory__skill_view'

/** 单批上报事件上限(与 master 侧批量 INSERT 契约一致:body.events ≤ 100)。 */
const BATCH_MAX_EVENTS = 100
/** 字段长度上限**与 master 侧 internalSkillUsage 校验一致**:超限那侧会整批 400,
 *  reporter 会当作 fatal 丢整批。实际 agentId/sessionKey 都很短,这里纯防御对齐。 */
const MAX_AGENT_ID_CHARS = 128
const MAX_SESSION_KEY_CHARS = 512
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000
const DRAIN_INTERVAL_MS = 30_000
const RETRY_BACKOFF_BASE_MS = 5_000
const RETRY_BACKOFF_MAX_MS = 5 * 60_000
const ATTEMPT_TIMEOUT_MS = 10_000
/** 磁盘队列条数上限:master 长期不可达时不允许队列无界膨胀(默认 500,测试可注入)。 */
const MAX_QUEUE_ENTRIES = 500
/** 队列超限丢弃的 warn 限频窗口:突发上报下防日志刷屏。 */
const QUEUE_OVERFLOW_WARN_INTERVAL_MS = 60_000
/** hub slug 集缓存 TTL:60s。skill_view 事件不密集,60s 内的新装技能漏计属可接受弱信号。 */
const HUB_SLUGS_TTL_MS = 60_000
/** master-owned per-turn canonical traceId 的形状(32 hex)。只透传合法值,防止把
 *  畸形/自造值当归因键(单一铸造权威在 master,reporter 绝不铸造)。 */
const TRACE_ID_RE = /^[0-9a-f]{32}$/

/**
 * 遥测门控 env。**默认开**:未设 或 显式 '1' = 开;显式 '0' = 关。
 *
 * 与 tool-failure(默认关,须显式 OC_TOOL_FAILURE_AUDIT=1)语义**不同**,原因:
 * 这是**产品质量信号**而非诊断遥测 —— 只记录 slug / agentId / sessionKey / traceId
 * 这类槽位级元数据,**不记录任何技能正文或用户输入内容**,敏感度低;且是目录排序/
 * 「哪个好用」的数据地基,常态需要开启。master 进程默认注入 '1',运维要临时熄火时
 * 才显式置 '0'。仍受 master base URL + 容器 token 存在性约束(见 readConfig),
 * 个人版 / 无 commercial env 环境自然不上报。
 */
export const SKILL_USAGE_ENV = 'OC_MARKET_SKILL_USAGE'

export function isSkillUsageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // 默认开:仅显式 '0' 关闭,未设/其它值一律视为开。
  return env[SKILL_USAGE_ENV] !== '0'
}

export interface SkillUsageReportConfig {
  masterBaseUrl: string
  containerToken: string
}

/** 单条上报事件(对齐 master body.events[i] 契约)。 */
export interface SkillUsageReportPayload {
  eventId: string
  slug: string
  agentId: string | null
  sessionKey: string | null
  /** master per-turn canonical traceId(32hex)或 null;评分归因键,拿不到即 null。 */
  traceId: string | null
  /** ISO8601 事件时间(仅供 master 参考,落库以 master NOW() 为准)。 */
  at: string
}

interface SkillUsageQueueEntry {
  schemaVersion: 1
  payload: SkillUsageReportPayload
  firstSeenAt: number
  attempts: number
  lastErrorAt?: number
  lastErrorMessage?: string
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

type EventBusLike = Pick<GatewayEventBus, 'on' | 'off'>

/** 从 sessionKey 取本 turn 的 canonical traceId(拿不到 null)。单一权威在 master,
 *  reporter 只透传(见 server.ts 接线:读 session._currentTurnTraceId)。 */
export type TraceIdResolver = (sessionKey: string) => string | null | undefined

export class SkillUsageReportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SkillUsageReportError'
  }
}

export function readSkillUsageReportConfig(
  env: NodeJS.ProcessEnv = process.env,
): SkillUsageReportConfig | null {
  // 门控关闭 → 无条件视为未配置(与 tool-failure 同结构,仅默认值相反)。
  if (!isSkillUsageEnabled(env)) return null
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token) return null
  return {
    masterBaseUrl: base.replace(/\/+$/, ''),
    containerToken: token,
  }
}

function ocHome(): string {
  return (
    process.env.OPENCLAUDE_HOME?.trim() ||
    join(process.env.HOME?.trim() || homedir(), '.openclaude')
  )
}

export function defaultSkillUsageQueueDir(): string {
  return join(ocHome(), 'skill-usage-report.d')
}

/** hub 技能目录:~/.openclaude/hub/skills/,子目录名 = slug(与 storage/paths 同解析)。 */
export function defaultHubSkillsDir(): string {
  return join(ocHome(), 'hub', 'skills')
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 12))}…[truncated]`
}

function retryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20), RETRY_BACKOFF_MAX_MS)
}

/** traceId 归一:只放行合法 32hex(master 铸造空间),其余一律 null —— 绝不自造。 */
export function normalizeTraceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return TRACE_ID_RE.test(t) ? t : null
}

/**
 * 从 tool.called 的 inputPreview 解析 skill_view 的 `name` 参数(= 技能 slug)。
 *
 * inputPreview 是工具入参 JSON.stringify 后截断(≤500 字符,见 ccbMessageParser)。
 * skill_view 入参形如 `{"name":"browser"}` / `{"name":"browser","path":"references/x.md"}`,
 * name 是短字段,一般不被截断。优先 JSON.parse 取 name;JSON 被截断/畸形时回落正则
 * 抓 `"name":"..."`。解析不到 → null(fail-open,静默丢弃)。
 */
export function parseSkillSlug(inputPreview: string | undefined): string | null {
  if (typeof inputPreview !== 'string' || inputPreview.length === 0) return null
  let name: unknown
  try {
    const obj = JSON.parse(inputPreview) as { name?: unknown }
    name = obj?.name
  } catch {
    const m = /"name"\s*:\s*"([^"\\]+)"/.exec(inputPreview)
    name = m?.[1]
  }
  if (typeof name !== 'string') return null
  const slug = name.trim()
  // 目录名合理性下限(最终权威是 hub 目录成员判定;这里只挡明显垃圾/超长)。
  if (slug.length === 0 || slug.length > 128) return null
  return slug
}

export async function sendSkillUsageReport(
  events: SkillUsageReportPayload[],
  cfg: SkillUsageReportConfig,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS)
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`${cfg.masterBaseUrl}${SKILL_USAGE_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.containerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    })
    if (res.ok) return
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500
    throw new SkillUsageReportError(`skill usage report returned HTTP ${res.status}`, retryable, res.status)
  } catch (err) {
    if (err instanceof SkillUsageReportError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new SkillUsageReportError(message, true)
  } finally {
    clearTimeout(timer)
  }
}

export interface SkillUsageReporter {
  start(): void
  stop(): void
  drainOnce(): Promise<{ considered: number; sent: number; retried: number; dropped: number }>
  pendingCount(): Promise<number>
}

export function makeSkillUsageReporter(deps: {
  config: SkillUsageReportConfig
  queueDir?: string
  hubSkillsDir?: string
  eventBus?: EventBusLike
  fetchImpl?: FetchLike
  resolveTraceId?: TraceIdResolver
  now?: () => number
  drainIntervalMs?: number
  maxQueueEntries?: number
}): SkillUsageReporter {
  const dir = deps.queueDir ?? defaultSkillUsageQueueDir()
  const hubDir = deps.hubSkillsDir ?? defaultHubSkillsDir()
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
  // hub slug 集 TTL 缓存(60s)。缓存命中避免每个事件都 readdir。
  let hubCache: { at: number; slugs: Set<string> } | null = null

  async function loadHubSlugs(): Promise<Set<string>> {
    const t = now()
    if (hubCache && t - hubCache.at < HUB_SLUGS_TTL_MS) return hubCache.slugs
    try {
      const entries = await readdir(hubDir, { withFileTypes: true })
      const slugs = new Set<string>()
      for (const e of entries) if (e.isDirectory()) slugs.add(e.name)
      hubCache = { at: t, slugs }
      return slugs
    } catch {
      // hub 目录不存在/不可读:返回空集但**不缓存失败**——一旦目录被创建,下个事件即刻
      // 重读(skill_view 事件稀疏,无 readdir 风暴风险)。fail-open:本轮全部丢弃。
      return new Set()
    }
  }

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
   * 重试元数据(attempts/lastError*)就地回写。**必须**用 'r+'(要求文件仍存在),
   * 不能走 atomicWriteJson:rename 覆盖会把 send 期间刚被队列上限 unlink 的条目
   * 「复活」,击穿上限。'r+' 下条目已被丢弃 → ENOENT,返回 false 由调用方按 dropped
   * 处理。语义与 v3ToolFailureReporter 一致。
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

  async function enqueue(payload: SkillUsageReportPayload): Promise<void> {
    await ensureDir()
    // 条数上限:超限先丢最旧(文件名前缀是时间戳,字典序≈时间序),再写新条目;warn 限频。
    const existing = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    if (existing.length >= maxQueueEntries) {
      const overflow = existing.slice(0, existing.length - maxQueueEntries + 1)
      await Promise.all(overflow.map((f) => unlink(join(dir, f)).catch(() => {})))
      if (now() - lastOverflowWarnAt >= QUEUE_OVERFLOW_WARN_INTERVAL_MS) {
        lastOverflowWarnAt = now()
        log.warn('skill usage queue over capacity: dropped oldest entries', {
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
    } satisfies SkillUsageQueueEntry)
    kick()
  }

  function onToolCalled(ev: ToolCalledEvent): void {
    // 过滤:只认成功的 hub skill_view。isError / 非 skill_view → 直接忽略。
    if (ev.isError) return
    if (ev.toolName !== SKILL_VIEW_TOOL) return
    const slug = parseSkillSlug(ev.inputPreview)
    if (!slug) return
    // traceId **同步**捕获(此刻仍处于本 turn 的同步派发栈,session._currentTurnTraceId
    // 是本 turn 的 canonical 值);异步 enqueue 前定格,避免与后续 turn 竞态。
    const traceId = normalizeTraceId(deps.resolveTraceId?.(ev.sessionKey))
    const agentId = typeof ev.agentId === 'string' && ev.agentId.trim().length > 0 ? cap(ev.agentId.trim(), MAX_AGENT_ID_CHARS) : null
    const sessionKey = typeof ev.sessionKey === 'string' && ev.sessionKey.trim().length > 0 ? cap(ev.sessionKey.trim(), MAX_SESSION_KEY_CHARS) : null
    // hub 成员判定 + 落盘走异步串行链(readdir 是异步)。非 hub → 静默丢弃(fail-open)。
    enqueueChain = enqueueChain
      .then(async () => {
        const slugs = await loadHubSlugs()
        if (!slugs.has(slug)) return // 平台/baseline 技能不在 hub → 不产生事件
        await enqueue({
          eventId: randomUUID(),
          slug,
          agentId,
          sessionKey,
          traceId,
          at: new Date(now()).toISOString(),
        })
      })
      .catch((err) => {
        // fail-open:上报入队失败绝不上抛,仅 warn。
        log.warn('failed to enqueue skill usage event', { slug, toolName: ev.toolName }, err)
      })
  }

  function kick(): void {
    if (draining) {
      pendingKick = true
      return
    }
    draining = true
    void drainOnce()
      .catch((err) => log.warn('skill usage report drain failed', {}, err))
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
    // 收集本轮可发送(未过 TTL、退避已到)的条目,批量 POST(单批 ≤ BATCH_MAX_EVENTS)。
    const batch: Array<{ file: string; entry: SkillUsageQueueEntry }> = []
    for (const file of files) {
      if (batch.length >= BATCH_MAX_EVENTS) break
      const filepath = join(dir, file)
      let entry: SkillUsageQueueEntry
      try {
        entry = JSON.parse(await readFile(filepath, 'utf8')) as SkillUsageQueueEntry
      } catch (err) {
        stats.dropped += 1
        await unlink(filepath).catch(() => {})
        log.warn('dropped unreadable skill usage queue entry', { file }, err)
        continue
      }
      stats.considered += 1
      const age = now() - entry.firstSeenAt
      if (age > ENTRY_TTL_MS) {
        stats.dropped += 1
        await unlink(filepath).catch(() => {})
        log.warn('dropped expired skill usage queue entry', { file, eventId: entry.payload?.eventId })
        continue
      }
      const last = entry.lastErrorAt ?? entry.firstSeenAt
      if (entry.attempts > 0 && now() - last < retryBackoffMs(entry.attempts)) continue
      batch.push({ file, entry })
    }
    if (batch.length === 0) return stats
    try {
      await sendSkillUsageReport(
        batch.map((b) => b.entry.payload),
        deps.config,
        { fetchImpl: deps.fetchImpl },
      )
      stats.sent += batch.length
      await Promise.all(batch.map((b) => unlink(join(dir, b.file)).catch(() => {})))
    } catch (err) {
      if (err instanceof SkillUsageReportError && !err.retryable) {
        // 非可重试(如 400 契约错误):整批丢弃,重试无意义。
        stats.dropped += batch.length
        await Promise.all(batch.map((b) => unlink(join(dir, b.file)).catch(() => {})))
        log.warn('dropped fatal skill usage batch', {
          count: batch.length,
          status: err instanceof SkillUsageReportError ? err.status : undefined,
        })
      } else {
        // 可重试:逐条 bump attempts + 退避元数据,就地回写(被上限 unlink 者按 dropped 计)。
        const message = cap(err instanceof Error ? err.message : String(err), 300)
        for (const b of batch) {
          b.entry.attempts += 1
          b.entry.lastErrorAt = now()
          b.entry.lastErrorMessage = message
          if (await updateEntryInPlace(join(dir, b.file), b.entry)) stats.retried += 1
          else stats.dropped += 1
        }
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
      log.info('skill usage reporter started')
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

/**
 * 进程启动接线。**默认开**(见 SKILL_USAGE_ENV):未显式 OC_MARKET_SKILL_USAGE=0 且
 * commercial master env(base URL + 容器 token)齐全时启动;否则打一行日志 no-op。
 *
 * `resolveTraceId` 由 server.ts 注入(读 session._currentTurnTraceId),使上报事件携带
 * 本 turn 的 master canonical traceId 用于评分归因;缺省则所有事件 traceId=null(仍计
 * usage/users,只是不进评分归因)。
 */
export function startSkillUsageReporter(
  opts: { resolveTraceId?: TraceIdResolver } = {},
): SkillUsageReporter | null {
  if (!isSkillUsageEnabled(process.env)) {
    log.info('skill usage reporter disabled: OC_MARKET_SKILL_USAGE=0 (explicit opt-out)')
    return null
  }
  const cfg = readSkillUsageReportConfig(process.env)
  if (!cfg) {
    log.info('skill usage reporter disabled: commercial master env not configured')
    return null
  }
  const reporter = makeSkillUsageReporter({ config: cfg, resolveTraceId: opts.resolveTraceId })
  reporter.start()
  return reporter
}
