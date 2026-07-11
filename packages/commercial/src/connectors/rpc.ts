/**
 * rpc — 容器 → master 连接器 RPC(照 literatureProxy 范式,设计终稿 §7)。
 *
 * 拓扑:oc-connect → ${OPENCLAUDE_V3_MASTER_BASE_URL}/v3/connectors/{list|call}
 *   + 容器 bearer → index.ts dispatchInternal 分流 → 本 handler →
 *   verifyContainerIdentity 双因子 → userId → 凭据查询强制
 *   WHERE id AND user_id AND revoked_at IS NULL AND status='active' → exec。
 *
 * 响应契约(跨 agent 钉死;CLI 侧只在**传输/HTTP 层**失败才抛,业务结果一律
 * HTTP 200 + 统一信封):
 *   {kind:'result', result} | {kind:'confirmation_required', id, provider, action,
 *    summary, expiresAt} | {kind:'in_progress', id} | {kind:'replay', status,
 *    errorCode?, resultDigest?} | {kind:'error', code}
 * 唯一例外:容器身份双因子失败 → HTTP 401(CLI 显示 CONNECTOR_RPC_HTTP 401)。
 *
 * 限流(§3/§6):
 *   - 读:per-container 内存 60/5min + per-user Redis 600/h(Redis 抖动 fail-open+warn)
 *   - propose:per-user Redis 10/min(fail-closed)
 *   - send 类:per-user Redis 50/日(fail-closed)
 *   - per-connection 并发 2(进程内计数)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { getPool } from '../db/index.js'
import { getGithubLinkPublic } from '../github/tokenStore.js'
import { canonicalDigestHex } from './canonicalJson.js'
import { ConnectorError, toConnectorError } from './errors.js'
import { beginExecute, finalizeExecute, proposeWrite } from './ledger.js'
import type { DnsResolver } from './outboundPolicy.js'
import type { ConnectorRedis } from './providers/feishu.js'
import { GITHUB_VIRTUAL_CONNECTION_ID } from './providers/github.js'
import { CONNECTOR_PROVIDERS, getProviderDecl, validateActionParams } from './registry.js'
import {
  buildWriteSummary,
  executeConnectionAction,
  executeGithubAction,
  requireAction,
} from './service.js'
import {
  getActiveConnection,
  getConnectionAnyStatus,
  listConnections,
  touchConnectionVerified,
} from './store.js'

export const CONNECTORS_RPC_PREFIX = '/v3/connectors/'
const LIST_PATH = '/v3/connectors/list'
const CALL_PATH = '/v3/connectors/call'

/** call body 上限:put_file contentBase64 ≤6MB + JSON 包装余量。 */
const MAX_CALL_BODY_BYTES = 8 * 1024 * 1024
const MAX_LIST_BODY_BYTES = 4 * 1024

// ─── per-container 内存限流(60/5min;照 literatureProxy 纪律,进程内辅助闸) ──

const PC_WINDOW_MS = 5 * 60 * 1000
const PC_MAX = 60
const PC_LRU = 10_000

interface Bucket {
  ts: number[]
  lastSeen: number
}

export interface PerContainerLimiter {
  check(containerId: number, now: number): boolean
}

export function makeConnectorContainerLimiter(
  windowMs = PC_WINDOW_MS,
  max = PC_MAX,
): PerContainerLimiter {
  const buckets = new Map<number, Bucket>()
  return {
    check(containerId, now) {
      let b = buckets.get(containerId)
      if (!b) {
        b = { ts: [], lastSeen: now }
        buckets.set(containerId, b)
        if (buckets.size > PC_LRU) {
          let oldestK = -1
          let oldestT = Number.POSITIVE_INFINITY
          for (const [k, v] of buckets) {
            if (v.lastSeen < oldestT) {
              oldestT = v.lastSeen
              oldestK = k
            }
          }
          if (oldestK >= 0) buckets.delete(oldestK)
        }
      }
      b.lastSeen = now
      const cutoff = now - windowMs
      b.ts = b.ts.filter((t) => t > cutoff)
      if (b.ts.length >= max) return false
      b.ts.push(now)
      return true
    },
  }
}

// ─── per-connection 并发闸(2;进程内) ───────────────────────────────────

const connInflight = new Map<string, number>()
export const PER_CONNECTION_CONCURRENCY = 2

async function withConnectionSlot<T>(connKey: string, fn: () => Promise<T>): Promise<T> {
  const cur = connInflight.get(connKey) ?? 0
  if (cur >= PER_CONNECTION_CONCURRENCY) {
    throw new ConnectorError('RATE_LIMITED', 'per-connection concurrency exceeded')
  }
  connInflight.set(connKey, cur + 1)
  try {
    return await fn()
  } finally {
    const n = (connInflight.get(connKey) ?? 1) - 1
    if (n <= 0) connInflight.delete(connKey)
    else connInflight.set(connKey, n)
  }
}

// ─── Redis 固定窗限流(GET-then-INCR Lua,原子;照 literatureProxy) ─────────

const WINDOW_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if v >= cap then return -1 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return n
`

export const READ_HOURLY_CAP = 600
export const PROPOSE_PER_MIN_CAP = 10
export const SEND_DAILY_CAP = 50

function utcDay(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 解绑 saga §8 ①:unbind 期间 Redis 互斥阻新调用(best-effort;真 fail-closed 在 DB 行态)。 */
async function assertNotRevoking(
  redis: ConnectorRedis | null | undefined,
  connectionId: string,
): Promise<void> {
  if (!redis) return
  const held = await redis
    .eval(`return redis.call('EXISTS', KEYS[1])`, 1, `connectors:revoke:${connectionId}`)
    .catch(() => 0)
  if (held === 1) {
    throw new ConnectorError('CONNECTION_REVOKED', 'connection is being unbound')
  }
}

type LimiterKind = 'read' | 'propose' | 'send'

async function checkRedisWindow(
  redis: ConnectorRedis | null | undefined,
  kind: LimiterKind,
  userId: number,
  now: number,
  log: RpcLog,
): Promise<void> {
  if (!redis) {
    // 未接 Redis(测试装配):propose/send 是 abuse 面,fail-closed;读放行
    if (kind !== 'read') throw new ConnectorError('INTERNAL', 'rate limiter unavailable')
    return
  }
  let key: string
  let cap: number
  let ttlSec: number
  if (kind === 'read') {
    key = `connectors:read:${userId}:${Math.floor(now / 3_600_000)}`
    cap = READ_HOURLY_CAP
    ttlSec = 7_200
  } else if (kind === 'propose') {
    key = `connectors:propose:${userId}:${Math.floor(now / 60_000)}`
    cap = PROPOSE_PER_MIN_CAP
    ttlSec = 120
  } else {
    key = `connectors:send:${userId}:${utcDay(now)}`
    cap = SEND_DAILY_CAP
    ttlSec = 48 * 3600
  }
  let n: number
  try {
    n = (await redis.eval(WINDOW_SCRIPT, 1, key, cap, ttlSec)) as number
  } catch (err) {
    if (kind === 'read') {
      // 读闸 Redis 抖动 fail-open(researchProxy 先例;UX 铁律),warn 留痕
      log('warn', 'read_limiter_redis_error', { err: String(err) })
      return
    }
    // propose/send fail-closed(literatureProxy 纪律:限额闸挂 → 拒绝)
    throw new ConnectorError('INTERNAL', 'rate limiter unavailable')
  }
  if (n === -1) {
    throw new ConnectorError(
      kind === 'send' ? 'SEND_DAILY_CAP' : 'RATE_LIMITED',
      `${kind} window cap reached`,
    )
  }
}

// ─── handler ─────────────────────────────────────────────────────────────

type RpcLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields?: Record<string, unknown>,
) => void

export interface ConnectorsRpcDeps {
  identityRepo: ContainerIdentityRepo
  redis?: ConnectorRedis | null
  pool?: Pool
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  limiter?: PerContainerLimiter
  now?: () => number
  log?: RpcLog
}

export interface ConnectorsRpcCtx {
  hostUuid: string
  boundIp: string
}

export type ConnectorsRpcHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ConnectorsRpcCtx,
) => Promise<void>

async function readBoundedJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > maxBytes) throw new ConnectorError('BAD_REQUEST', 'body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ConnectorError('BAD_REQUEST', 'body must be JSON')
  }
}

function sendEnvelope(res: ServerResponse, body: unknown, status = 200): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** meta.account_hint 提取(绑定时写入;无则空)。 */
function accountHintOf(meta: Record<string, unknown>): string {
  const h = meta.account_hint
  return typeof h === 'string' ? h : ''
}

export function makeConnectorsRpcHandler(deps: ConnectorsRpcDeps): ConnectorsRpcHandler {
  const limiter = deps.limiter ?? makeConnectorContainerLimiter()
  const now = deps.now ?? Date.now
  const log: RpcLog =
    deps.log ??
    ((level, msg, fields) => {
      // eslint-disable-next-line no-console
      console[level === 'info' ? 'log' : level](`[connectorsRpc] ${msg}`, fields ?? '')
    })

  return async function handle(req, res, ctx) {
    if (req.method !== 'POST') {
      sendEnvelope(res, { kind: 'error', code: 'BAD_REQUEST' }, 405)
      return
    }
    const path = (req.url ?? '/').split('?')[0]

    // 1) 容器身份双因子(唯一的非 200 业务外错误面)
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        log('warn', 'identity_failed', { errcode: err.code, boundIp: ctx.boundIp })
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'container identity verification failed' },
          }),
        )
        return
      }
      log('error', 'identity_threw', { err: String(err) })
      sendEnvelope(res, { kind: 'error', code: 'INTERNAL' }, 500)
      return
    }
    const pool = deps.pool ?? getPool()
    const userId = identity.userId

    try {
      if (path === LIST_PATH) {
        await readBoundedJsonBody(req, MAX_LIST_BODY_BYTES) // drain(CLI 发空 {})
        await handleList(res, userId, pool)
        return
      }
      if (path === CALL_PATH) {
        await handleCall(req, res, { userId, containerId: identity.containerId }, pool, {
          deps,
          limiter,
          now,
          log,
        })
        return
      }
      sendEnvelope(res, { kind: 'error', code: 'BAD_REQUEST' })
    } catch (err) {
      const ce = toConnectorError(err)
      if (ce.code === 'INTERNAL') {
        log('error', 'rpc_internal', {
          path,
          err: err instanceof Error ? err.message : String(err),
        })
      } else {
        log('warn', 'rpc_error', { path, code: ce.code })
      }
      // 业务错误统一 HTTP 200 信封(CLI 只解析 kind;非 2xx 会被当传输层失败)
      sendEnvelope(res, { kind: 'error', code: ce.code })
    }
  }
}

// ─── list ────────────────────────────────────────────────────────────────

async function handleList(res: ServerResponse, userId: number, pool: Pool): Promise<void> {
  const rows = await listConnections(userId, pool)
  const connections: Array<Record<string, unknown>> = rows.map((row) => {
    const decl = getProviderDecl(row.provider)
    return {
      id: row.id, // 字符串化 bigint(契约)
      provider: row.provider,
      displayName: row.display_name || (decl?.label ?? row.provider),
      accountHint: accountHintOf(row.meta),
      status: row.status,
      actions: (decl?.actions ?? []).map((a) => ({
        id: a.id,
        description: a.description,
        readOnly: a.readOnly,
      })),
    }
  })
  // github 虚拟连接(§4:无 connections 行;id 用保留字符串 'github')
  const gh = await getGithubLinkPublic(pool, userId)
  if (gh.linked) {
    const decl = CONNECTOR_PROVIDERS.github
    connections.push({
      id: GITHUB_VIRTUAL_CONNECTION_ID,
      provider: 'github',
      displayName: decl.label,
      accountHint: gh.login ?? '',
      status: 'active',
      actions: decl.actions.map((a) => ({
        id: a.id,
        description: a.description,
        readOnly: a.readOnly,
      })),
    })
  }
  sendEnvelope(res, { connections })
}

// ─── call ────────────────────────────────────────────────────────────────

interface CallBody {
  connectionId: string
  action: string
  params?: Record<string, unknown>
  confirmId?: string
}

function parseCallBody(raw: unknown): CallBody {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConnectorError('BAD_REQUEST', 'call body must be an object')
  }
  const b = raw as Record<string, unknown>
  if (
    typeof b.connectionId !== 'string' ||
    b.connectionId.length === 0 ||
    b.connectionId.length > 32
  ) {
    throw new ConnectorError('BAD_REQUEST', 'connectionId required')
  }
  if (typeof b.action !== 'string' || !/^[a-z0-9_]{1,64}$/.test(b.action)) {
    throw new ConnectorError('BAD_REQUEST', 'action required')
  }
  if (
    b.params !== undefined &&
    (b.params === null || typeof b.params !== 'object' || Array.isArray(b.params))
  ) {
    throw new ConnectorError('BAD_REQUEST', 'params must be an object')
  }
  if (
    b.confirmId !== undefined &&
    (typeof b.confirmId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(b.confirmId))
  ) {
    throw new ConnectorError('BAD_REQUEST', 'confirmId must be a UUID')
  }
  return {
    connectionId: b.connectionId,
    action: b.action,
    params: b.params as Record<string, unknown> | undefined,
    confirmId: b.confirmId as string | undefined,
  }
}

async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  who: { userId: number; containerId: number },
  pool: Pool,
  rt: {
    deps: ConnectorsRpcDeps
    limiter: PerContainerLimiter
    now: () => number
    log: RpcLog
  },
): Promise<void> {
  const body = parseCallBody(await readBoundedJsonBody(req, MAX_CALL_BODY_BYTES))
  const execDeps = {
    pool,
    redis: rt.deps.redis ?? null,
    resolver: rt.deps.resolver,
    fetchImpl: rt.deps.fetchImpl,
  }

  // ── github 虚拟连接(只读) ──
  if (body.connectionId === GITHUB_VIRTUAL_CONNECTION_ID) {
    const decl = requireAction('github', body.action)
    if (!decl.readOnly) throw new ConnectorError('ACTION_UNKNOWN', 'github adapter is read-only')
    if (!rt.limiter.check(who.containerId, rt.now())) {
      throw new ConnectorError('RATE_LIMITED', 'per-container window exceeded')
    }
    await checkRedisWindow(rt.deps.redis, 'read', who.userId, rt.now(), rt.log)
    const params = validateActionParams(decl.params, body.params)
    const result = await withConnectionSlot(`gh:${who.userId}`, () =>
      executeGithubAction({ userId: who.userId, action: decl, params, deps: execDeps }),
    )
    sendEnvelope(res, { kind: 'result', result })
    return
  }

  // ── DB 连接 ──
  if (!/^\d{1,19}$/.test(body.connectionId)) {
    throw new ConnectorError('CONNECTION_NOT_FOUND', 'malformed connection id')
  }
  const row = await getActiveConnection(body.connectionId, who.userId, pool)
  if (!row) {
    // 区分 error 态(引导重绑)与不存在
    const any = await getConnectionAnyStatus(body.connectionId, who.userId, pool)
    if (any && any.status === 'error') {
      throw new ConnectorError(
        any.last_error_code === 'RELINK_REQUIRED' ? 'RELINK_REQUIRED' : 'CONNECTION_ERROR',
        'connection in error state',
      )
    }
    throw new ConnectorError('CONNECTION_NOT_FOUND', 'no such connection')
  }
  const decl = requireAction(row.provider, body.action)

  await assertNotRevoking(rt.deps.redis, row.id)

  // ── 读操作:直接执行(不过确认门,§3) ──
  if (decl.readOnly) {
    if (!rt.limiter.check(who.containerId, rt.now())) {
      throw new ConnectorError('RATE_LIMITED', 'per-container window exceeded')
    }
    await checkRedisWindow(rt.deps.redis, 'read', who.userId, rt.now(), rt.log)
    const params = validateActionParams(decl.params, body.params)
    const result = await withConnectionSlot(`c:${row.id}`, () =>
      executeConnectionAction({
        connectionId: row.id,
        userId: who.userId,
        action: decl,
        params,
        expectedRevision: null,
        deps: execDeps,
      }),
    )
    await touchConnectionVerified(row.id, pool).catch(() => {})
    sendEnvelope(res, { kind: 'result', result })
    return
  }

  // ── 写操作,无 confirmId:propose → 确认卡 ──
  if (!body.confirmId) {
    await checkRedisWindow(rt.deps.redis, 'propose', who.userId, rt.now(), rt.log)
    if (decl.sendClass) {
      await checkRedisWindow(rt.deps.redis, 'send', who.userId, rt.now(), rt.log)
    }
    const params = validateActionParams(decl.params, body.params)
    const proposed = await proposeWrite(
      {
        userId: who.userId,
        connectionId: row.id,
        connectionRevision: row.revision,
        provider: row.provider,
        action: decl.id,
        params,
        summary: buildWriteSummary(row.provider, decl.id, params, accountHintOf(row.meta)),
      },
      pool,
    )
    sendEnvelope(res, {
      kind: 'confirmation_required',
      id: proposed.id,
      provider: row.provider,
      action: decl.id,
      summary: proposed.summary,
      expiresAt: proposed.expiresAt.toISOString(),
    })
    return
  }

  // ── 写操作,带 confirmId:执行(只用账本解密参数,忽略模型重传 params) ──
  const begun = await beginExecute(
    { id: body.confirmId, userId: who.userId, connectionId: row.id },
    pool,
  )
  if (begun.kind === 'in_progress') {
    sendEnvelope(res, { kind: 'in_progress', id: body.confirmId })
    return
  }
  if (begun.kind === 'replay') {
    sendEnvelope(res, {
      kind: 'replay',
      status: begun.status,
      ...(begun.errorCode ? { errorCode: begun.errorCode } : {}),
      ...(begun.resultDigest ? { resultDigest: begun.resultDigest } : {}),
    })
    return
  }

  // executing:执行 → 终态
  try {
    const result = await withConnectionSlot(`c:${row.id}`, () =>
      executeConnectionAction({
        connectionId: row.id,
        userId: who.userId,
        action: decl,
        params: begun.params, // 账本参数(hash 已复核)
        expectedRevision: begun.row.connection_revision,
        idempotencyKey: begun.row.idempotency_key,
        deps: execDeps,
      }),
    )
    const digest = canonicalDigestHex(result)
    await finalizeExecute({ id: body.confirmId, status: 'succeeded', resultDigest: digest }, pool)
    await touchConnectionVerified(row.id, pool).catch(() => {})
    sendEnvelope(res, { kind: 'result', result })
  } catch (err) {
    const ce = toConnectorError(err)
    const maybeDelivered =
      (err as { maybeDelivered?: boolean })?.maybeDelivered === true ||
      ce.code === 'UPSTREAM_TIMEOUT' // 已发出请求且超时 → 结局不明,不盲重试(§3)
    await finalizeExecute(
      {
        id: body.confirmId,
        status: maybeDelivered ? 'unknown' : 'failed',
        errorCode: ce.code,
      },
      pool,
    ).catch(() => {})
    throw ce
  }
}
