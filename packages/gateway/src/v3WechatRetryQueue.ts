/**
 * Container-side durable retry queue for the v3 master `/internal/v3/wechat-
 * outbound` POST(P1.7 slice 7c)。
 *
 * **复制 v3MasterRetryQueue 模式而非把它泛型化**:已经 Codex PASS 的代码不动,
 * 同形态拷贝一份(payload 不同、错误分类相同),互不污染。两份代码一起改的成本
 * 远低于 broker outbound 退路误用 v3MasterSink 的代价 —— 后者 schema 完全
 * 不同(sessionId / turnIndex / status / text vs sessionId / peer / agentId /
 * idempotencyKey / blocks)。
 *
 * **架构对齐**:
 *   - 文件粒度原子:`<ms-ts>-<8-hex>.json`,enqueue 与 drainer 不会写碰撞
 *   - 24h TTL:超期 unlink + warn(operator 知道丢了什么),不静默续命
 *   - 单 flight drainer:在内存 boolean 锁 + pendingKick 合并多次 kick
 *   - 周期 30s + boot 时 kick(参 startPeriodic)
 *   - 错误分类:`fatal` → unlink + warn;`transient` / 未知 → 计数 + rewrite
 *   - 例外:message payload 的 `isFinal:true` 即使遇到 fatal 也保留重试,因为
 *     master 接受 final 后才会清 wechat_running_sessions。
 *
 * **broker.send 与 shutdown 的契约**(Codex slice 7c plan v3 reminder):
 *   - shutdown() 只停 periodic 计时器,不阻塞 enqueueDurable —— 即使 adapter
 *     已收到 shutdown,后续 send() 仍然要把 payload 落盘(单元测试 lock-in)。
 *     否则 race:gateway 收 SIGTERM 时 broker outbound 的最后一帧会被静默丢。
 *   - 周期 drain 停止后,下次 gateway 启动从同一 dir 接着 drain,数据不丢。
 */

import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { paths } from '@openclaude/storage'

import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3WechatRetryQueue' })

/** Per-entry TTL = 24h(与 v3MasterRetryQueue 一致;master broker 长时间不可达
 *  时不无限堆积 disk)。 */
export const ENTRY_TTL_MS = 24 * 60 * 60 * 1000

/** Periodic drain interval。30s 同 v3MasterRetryQueue;boot 时也 kick。 */
export const DEFAULT_DRAIN_INTERVAL_MS = 30_000

/** Default queue dir = ${HOME}/v3-wechat-retry.d。与 master sink 的
 *  v3-master-retry.d 严格区分:错混会让两条 retry 链共用 ENOENT-tolerant 路径,
 *  在 ops 重启时数据归错处。 */
export function defaultQueueDir(): string {
  return join(paths.home, 'v3-wechat-retry.d')
}

/**
 * Wire payload that gets POSTed to master `/internal/v3/wechat-outbound`。
 *
 * **Field names must exactly match** master `outboundReceiver.ts:BodySchema`
 * (.strict() — extra fields will be rejected):
 *   - `sessionId` = wsess-[0-9a-f]{16}(broker-owned namespace)
 *   - `channel: 'wechat'` literal(BodySchema z.literal 校验)
 *   - `agentId?` = container agent id([A-Za-z0-9_-]{1,64})
 *   - `outboundId` = turn-level unique id(`[A-Za-z0-9._:-]{8,128}`),audit 表去重
 *   - `peer.kind: 'dm' | 'group'`,`peer.meta.senderId`(微信 openid 衍生)
 *   - `blocks` = OutboundContentBlock[](text / tool_use / tool_result / thinking)
 *   - `isFinal?` 终态标记(master 用它清 running-session 状态)
 *   - `createdAt?` ms epoch(仅审计,broker outbox 行 createdAt 由 broker 自打)
 *   - `traceId?` 调试用透传
 *
 * 字段类型放宽为 `unknown[]` / `string` —— 真正的 z 校验在 master 侧,本队列只做
 * "原样落盘 + 原样吐回"。`isV3WechatRetryEntry` 守门最小存在性,防止恶意 / 老
 * schema 文件让 drainer 反复 POST 注定 400 的请求。
 */
export interface V3WechatSinkWirePayload {
  sessionId: string
  channel: 'wechat'
  agentId?: string
  outboundId: string
  peer: {
    kind: 'dm' | 'group'
    meta: { senderId: string; [k: string]: unknown }
  }
  blocks: unknown[]
  isFinal?: boolean
  createdAt?: number
  traceId?: string
}

export interface V3WechatCodexBillingWirePayload {
  type: 'outbound.codex_billing'
  requestId: string
  status: 'success' | 'error'
  durationMs: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_output_tokens?: number
  }
  errorReason?: string
  rateLimits?: {
    util5h?: number
    reset5h?: string
    util7d?: number
    reset7d?: string
  }
  traceId?: string
}

export type V3WechatOutboundPostPayload =
  | V3WechatSinkWirePayload
  | V3WechatCodexBillingWirePayload

/** 错误分类。fatal → unlink + warn(master 永久拒绝:401/403/404/410/4xx 业务错);
 *  transient → 计数 retry(5xx / 网络 / 超时)。 */
export type V3WechatSinkErrorClass = 'fatal' | 'transient'

export class V3WechatSinkError extends Error {
  override readonly name = 'V3WechatSinkError'
  constructor(
    message: string,
    readonly errorClass: V3WechatSinkErrorClass,
    readonly httpStatus?: number,
  ) {
    super(message)
  }
}

export interface V3WechatRetryEntry {
  schemaVersion: 1
  payload: V3WechatOutboundPostPayload
  firstSeenAt: number
  attempts: number
  lastErrorClass?: V3WechatSinkErrorClass
  lastErrorAt?: number
  /** Truncated error message,never the bearer / payload body。 */
  lastErrorMessage?: string
}

export interface DrainStats {
  considered: number
  drained: number
  retried: number
  ttlDropped: number
  fatalDropped: number
  errors: number
  pending: number
}

export interface V3WechatRetryQueue {
  enqueueDurable(entry: V3WechatRetryEntry): Promise<void>
  drainOnce(): Promise<DrainStats>
  kick(): void
  startPeriodic(): void
  stopPeriodic(): void
  pendingCount(): Promise<number>
}

export interface MakeV3WechatRetryQueueDeps {
  dir?: string
  attemptSend: (payload: V3WechatOutboundPostPayload) => Promise<void>
  now?: () => number
  drainIntervalMs?: number
}

export function makeV3WechatRetryQueue(deps: MakeV3WechatRetryQueueDeps): V3WechatRetryQueue {
  const dir = deps.dir ?? defaultQueueDir()
  const now = deps.now ?? (() => Date.now())
  const drainIntervalMs = deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS

  let draining = false
  let pendingKick = false
  let periodicTimer: ReturnType<typeof setInterval> | null = null

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  function entryFilename(): string {
    return `${now()}-${randomBytes(8).toString('hex')}.json`
  }

  async function atomicWriteJson(filepath: string, data: unknown): Promise<void> {
    const tmp = `${filepath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const json = JSON.stringify(data)
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(json, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, filepath)
  }

  async function enqueueDurable(entry: V3WechatRetryEntry): Promise<void> {
    await ensureDir()
    const filepath = join(dir, entryFilename())
    await atomicWriteJson(filepath, entry)
    kick()
  }

  function kick(): void {
    if (draining) {
      pendingKick = true
      return
    }
    draining = true
    drainOnce()
      .catch((err) => {
        log.error('v3WechatRetryQueue.drainOnce threw', undefined, err)
      })
      .finally(() => {
        draining = false
        if (pendingKick) {
          pendingKick = false
          setImmediate(() => kick())
        }
      })
  }

  async function drainOnce(): Promise<DrainStats> {
    const stats: DrainStats = {
      considered: 0,
      drained: 0,
      retried: 0,
      ttlDropped: 0,
      fatalDropped: 0,
      errors: 0,
      pending: 0,
    }
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return stats
      }
      throw err
    }
    const entries = names.filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))
    entries.sort()

    for (const name of entries) {
      stats.considered++
      const filepath = join(dir, name)
      let raw: string
      try {
        raw = await readFile(filepath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        stats.errors++
        log.warn('v3WechatRetryQueue: read failed', { name }, err)
        continue
      }
      let entry: V3WechatRetryEntry
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!isV3WechatRetryEntry(parsed)) {
          throw new Error('schema mismatch')
        }
        entry = parsed
      } catch (err) {
        stats.fatalDropped++
        log.warn('v3WechatRetryQueue: malformed entry, unlinking', { name }, err)
        await unlinkIgnoreEnoent(filepath)
        continue
      }
      if (now() - entry.firstSeenAt > ENTRY_TTL_MS) {
        stats.ttlDropped++
        log.warn('v3WechatRetryQueue: entry TTL exceeded, dropping', {
          name,
          ...payloadLogContext(entry.payload),
          attempts: entry.attempts,
          lastErrorClass: entry.lastErrorClass,
          firstSeenAt: entry.firstSeenAt,
        })
        await unlinkIgnoreEnoent(filepath)
        continue
      }
      try {
        await deps.attemptSend(entry.payload)
        stats.drained++
        await unlinkIgnoreEnoent(filepath)
      } catch (err) {
        if (err instanceof V3WechatSinkError && err.errorClass === 'fatal') {
          if (!isFinalMessagePayload(entry.payload)) {
            stats.fatalDropped++
            log.warn(
              'v3WechatRetryQueue: fatal sink error, unlinking',
              {
                name,
                ...payloadLogContext(entry.payload),
                httpStatus: err.httpStatus,
              },
              err,
            )
            await unlinkIgnoreEnoent(filepath)
            continue
          }
          log.warn(
            'v3WechatRetryQueue: fatal final sink error, keeping terminal retry',
            {
              name,
              ...payloadLogContext(entry.payload),
              httpStatus: err.httpStatus,
            },
            err,
          )
        }
        stats.retried++
        stats.pending++
        const cls: V3WechatSinkErrorClass =
          err instanceof V3WechatSinkError ? err.errorClass : 'transient'
        const updated: V3WechatRetryEntry = {
          ...entry,
          attempts: entry.attempts + 1,
          lastErrorClass: cls,
          lastErrorAt: now(),
          lastErrorMessage:
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        }
        try {
          await atomicWriteJson(filepath, updated)
        } catch (writeErr) {
          if ((writeErr as NodeJS.ErrnoException).code === 'ENOENT') {
            log.warn('v3WechatRetryQueue: dir vanished during retry rewrite', { name })
          } else {
            stats.errors++
            log.error('v3WechatRetryQueue: retry rewrite failed', { name }, writeErr)
          }
        }
      }
    }
    return stats
  }

  function startPeriodic(): void {
    if (periodicTimer) return
    periodicTimer = setInterval(() => kick(), drainIntervalMs)
    if (typeof periodicTimer.unref === 'function') periodicTimer.unref()
  }

  function stopPeriodic(): void {
    if (periodicTimer) {
      clearInterval(periodicTimer)
      periodicTimer = null
    }
  }

  async function pendingCount(): Promise<number> {
    try {
      const names = await readdir(dir)
      return names.filter((n) => n.endsWith('.json') && !n.includes('.tmp-')).length
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
  }

  return {
    enqueueDurable,
    drainOnce,
    kick,
    startPeriodic,
    stopPeriodic,
    pendingCount,
  }
}

async function unlinkIgnoreEnoent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

function payloadLogContext(payload: V3WechatOutboundPostPayload): Record<string, string> {
  if (isCodexBillingPayload(payload)) {
    return { payloadType: 'codex_billing', requestId: payload.requestId }
  }
  return {
    payloadType: 'message',
    sessionId: payload.sessionId,
    outboundId: payload.outboundId,
  }
}

function isCodexBillingPayload(
  payload: V3WechatOutboundPostPayload,
): payload is V3WechatCodexBillingWirePayload {
  return 'type' in payload && payload.type === 'outbound.codex_billing'
}

function isFinalMessagePayload(payload: V3WechatOutboundPostPayload): payload is V3WechatSinkWirePayload {
  return !isCodexBillingPayload(payload) && payload.isFinal === true
}

function isV3WechatRetryEntry(v: unknown): v is V3WechatRetryEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (o.schemaVersion !== 1) return false
  if (typeof o.firstSeenAt !== 'number' || !Number.isFinite(o.firstSeenAt)) return false
  if (typeof o.attempts !== 'number' || !Number.isFinite(o.attempts)) return false
  const p = o.payload as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return false
  if (p.type === 'outbound.codex_billing') {
    if (typeof p.requestId !== 'string' || !/^[0-9a-f]{32}$/.test(p.requestId)) return false
    if (p.status !== 'success' && p.status !== 'error') return false
    if (typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs) || p.durationMs < 0) return false
    return true
  }
  // wsess-[0-9a-f]{16} — broker 命名空间签名,误用 personal session id 会被 master
  // outboundReceiver BodySchema regex 直接拒(400 INVALID_BODY = fatal),提前在
  // shape guard 截,避免 drainer 反复 POST 注定 400 的请求。
  if (typeof p.sessionId !== 'string' || !/^wsess-[0-9a-f]{16}$/.test(p.sessionId)) return false
  if (p.channel !== 'wechat') return false
  if (p.agentId !== undefined) {
    if (typeof p.agentId !== 'string') return false
    if (p.agentId.length === 0 || p.agentId.length > 64) return false
    if (!/^[A-Za-z0-9_-]+$/.test(p.agentId)) return false
  }
  // outboundId regex 与 master outboundReceiver.OUTBOUND_ID_RE 完全一致。
  if (typeof p.outboundId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(p.outboundId)) return false
  if (p.createdAt !== undefined && (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt))) return false
  const peer = p.peer as Record<string, unknown> | undefined
  if (!peer || typeof peer !== 'object') return false
  if (peer.kind !== 'dm' && peer.kind !== 'group') return false
  const meta = peer.meta as Record<string, unknown> | undefined
  if (!meta || typeof meta !== 'object') return false
  if (typeof meta.senderId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(meta.senderId)) return false
  if (!Array.isArray(p.blocks) || p.blocks.length === 0) return false
  if (p.isFinal !== undefined && typeof p.isFinal !== 'boolean') return false
  return true
}
