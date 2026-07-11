/**
 * providers/feishu — BYOA(用户企业自建应用)oauth2 授权码 + refresh + PKCE。
 *
 * 端点**全部静态注册表**(用户只提供 client 凭据,不提供任何 URL,§2):
 *   authorize(浏览器跳转,不经出站策略):accounts.feishu.cn
 *   token / API(server fetch):open.feishu.cn —— 固定域静态白名单 + direct 出口
 *   (国内域名,走 directEgressDispatcher 绕全局出海代理)。
 *
 * 刷新(§2):Redis per-connection 锁(TTL 30s;调端点前/写回前验证 lease)→
 * 事务外调 token 端点 → 短事务条件更新(revision+generation fencing,bump generation)。
 * `invalid_grant` → status='error' + last_error_code='RELINK_REQUIRED'(同带 generation
 * 条件),fail-closed,设置页引导重绑。
 *
 * actions:get_doc / list_calendar_events / create_calendar_event★ / send_message★。
 */

import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { fetch as undiciFetch } from 'undici'
import { directEgressDispatcher } from '../../account-pool/egressDispatcher.js'
import { ConnectorError } from '../errors.js'
import { TOTAL_TIMEOUT_MS, assertFixedDomainUrl } from '../outboundPolicy.js'
import {
  type ConnectionRow,
  type FeishuSecret,
  decryptConnectionSecret,
  getActiveConnection,
  markConnectionError,
  updateConnectionSecret,
} from '../store.js'
import {
  MAX_UPSTREAM_JSON_BYTES,
  TEXT_FIELD_MAX_CHARS,
  mapFetchFailure,
  mapUpstreamStatus,
  readBoundedJson,
  truncateText,
} from './shared.js'

// ─── 静态端点注册表 ──────────────────────────────────────────────────────

export const FEISHU_ENDPOINTS = {
  /** 浏览器授权页(不经 server 出站)。 */
  authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  /** v2 oauth token(支持 PKCE + refresh)。 */
  tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  /** 用户身份(union_id)。 */
  userInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
  apiBase: 'https://open.feishu.cn',
} as const

/** v1 申请的用户级 scopes(最小化;granted 以 token 响应为准,存 meta)。 */
export const FEISHU_SCOPES = [
  'docx:document:readonly',
  'calendar:calendar.event:read',
  'calendar:calendar.event:create',
  'im:message:send_as_bot',
] as const

/** 规范化 scope 串:按空白/逗号切分、trim、去空、去重(保序)。 */
export function normalizeScopes(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of raw.split(/[\s,]+/)) {
    const t = s.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

export interface FeishuScopeCheck {
  granted: string[]
  /** 必需但未授予的 scope。 */
  missing: string[]
  /** granted 已覆盖全部必需集(missing 为空)。 */
  verified: boolean
}

/**
 * 校验飞书 token 响应回报的 granted scopes 是否覆盖 v1 必需集(P2#12)。
 * - 有回报且缺必需 → missing 非空 → 调用方拒绝绑定(fail-closed)。
 * - 有回报且齐全 → verified=true。
 * - **完全未回报(空串)** → 无法核验:不误拒(避免因飞书省略 scope 字段而断掉整个
 *   provider),返回 verified=false + missing 为空,调用方放行但在 meta 标注 scopesVerified。
 */
export function checkFeishuScopes(grantedRaw: string): FeishuScopeCheck {
  const granted = normalizeScopes(grantedRaw)
  if (granted.length === 0) {
    return { granted, missing: [], verified: false }
  }
  const grantedSet = new Set(granted)
  const missing = FEISHU_SCOPES.filter((s) => !grantedSet.has(s))
  return { granted, missing, verified: missing.length === 0 }
}

export interface FeishuDeps {
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  /** 可选外部中止信号(刷新路径用:lease 丢失时 abort 在飞的 token 请求,P1#3)。 */
  signal?: AbortSignal
}

/** 合并多个 AbortSignal(任一触发即中止;跨 Node 版本安全,不依赖 AbortSignal.any)。 */
function anyAbortSignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController()
  for (const s of signals) {
    if (!s) continue
    if (s.aborted) {
      controller.abort((s as { reason?: unknown }).reason)
      break
    }
    s.addEventListener('abort', () => controller.abort((s as { reason?: unknown }).reason), {
      once: true,
    })
  }
  return controller.signal
}

function doFeishuFetch(deps: FeishuDeps) {
  return (
    deps.fetchImpl ??
    ((input: string, i: Record<string, unknown>) =>
      undiciFetch(input, {
        ...i,
        dispatcher: directEgressDispatcher(), // 国内域直连,绕全局出海代理
      } as never) as unknown as Promise<Response>)
  )
}

async function feishuJson(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  deps: FeishuDeps,
): Promise<Record<string, unknown>> {
  const u = assertFixedDomainUrl('feishu', url)
  let res: Response
  try {
    res = await doFeishuFetch(deps)(u.toString(), {
      ...init,
      redirect: 'error',
      signal: anyAbortSignal([AbortSignal.timeout(TOTAL_TIMEOUT_MS), deps.signal]),
    })
  } catch (err) {
    throw mapFetchFailure(err, 'feishu')
  }
  if (!res.ok) {
    // token 端点的错误语义在 JSON body(error=invalid_grant 等),400 也要读 body
    if (res.status === 400 || res.status === 401) {
      const body = (await readBoundedJson(res, 64 * 1024, 'feishu').catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (body) return { __httpStatus: res.status, ...body }
    }
    await res.body?.cancel().catch(() => {})
    throw mapUpstreamStatus(res.status, 'feishu')
  }
  return (await readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, 'feishu')) as Record<string, unknown>
}

// ─── PKCE ────────────────────────────────────────────────────────────────

export function generatePkceVerifier(): string {
  return randomBytes(48).toString('base64url') // 64 chars ∈ [43,128]
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** 组 authorize URL(浏览器跳转)。 */
export async function buildFeishuAuthorizeUrl(opts: {
  clientId: string
  redirectUri: string
  state: string
  pkceVerifier: string
}): Promise<string> {
  const challenge = await pkceChallengeS256(opts.pkceVerifier)
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    state: opts.state,
    scope: FEISHU_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${FEISHU_ENDPOINTS.authorizeUrl}?${params.toString()}`
}

// ─── token exchange / refresh / user info ────────────────────────────────

export interface FeishuTokenResult {
  accessToken: string
  refreshToken: string
  /** epoch ms(access token 过期时刻;meta 唯一权威)。 */
  expiresAt: number
  grantedScopes: string
}

function parseTokenResponse(json: Record<string, unknown>): FeishuTokenResult {
  // v2 端点:{code:0, access_token, refresh_token, expires_in, scope} 或
  // {error:'invalid_grant', error_description} / {code:非0, ...}
  const err = json.error ?? (typeof json.code === 'number' && json.code !== 0 ? json.code : null)
  if (err !== null && err !== undefined) {
    const isInvalidGrant =
      json.error === 'invalid_grant' ||
      json.error === 'invalid_request' ||
      json.__httpStatus === 400
    if (isInvalidGrant) {
      throw new ConnectorError('RELINK_REQUIRED', 'feishu token grant invalid')
    }
    throw new ConnectorError('OAUTH_EXCHANGE_FAILED', 'feishu token endpoint error')
  }
  const access = json.access_token
  const refresh = json.refresh_token
  const expiresIn = json.expires_in
  if (typeof access !== 'string' || access.length === 0 || typeof refresh !== 'string') {
    throw new ConnectorError('OAUTH_EXCHANGE_FAILED', 'feishu token response missing tokens')
  }
  const ttlSec = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 7200
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + ttlSec * 1000,
    grantedScopes: typeof json.scope === 'string' ? json.scope : '',
  }
}

export async function exchangeFeishuCode(
  opts: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
    pkceVerifier: string
  },
  deps: FeishuDeps = {},
): Promise<FeishuTokenResult> {
  const json = await feishuJson(
    FEISHU_ENDPOINTS.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        redirect_uri: opts.redirectUri,
        code_verifier: opts.pkceVerifier,
      }),
    },
    deps,
  )
  return parseTokenResponse(json)
}

export async function refreshFeishuToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  deps: FeishuDeps = {},
): Promise<FeishuTokenResult> {
  const json = await feishuJson(
    FEISHU_ENDPOINTS.tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        refresh_token: opts.refreshToken,
      }),
    },
    deps,
  )
  return parseTokenResponse(json)
}

export interface FeishuUserInfo {
  unionId: string
  name: string
}

export async function fetchFeishuUserInfo(
  accessToken: string,
  deps: FeishuDeps = {},
): Promise<FeishuUserInfo> {
  const json = await feishuJson(
    FEISHU_ENDPOINTS.userInfoUrl,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    deps,
  )
  if (typeof json.code === 'number' && json.code !== 0) {
    throw new ConnectorError('OAUTH_EXCHANGE_FAILED', 'feishu user_info error')
  }
  const data = (json.data ?? {}) as Record<string, unknown>
  const unionId = data.union_id
  if (typeof unionId !== 'string' || unionId.length === 0) {
    throw new ConnectorError('OAUTH_EXCHANGE_FAILED', 'feishu user_info missing union_id')
  }
  return { unionId, name: typeof data.name === 'string' ? data.name : '' }
}

// ─── access token 惰性刷新(Redis 锁 + generation fencing) ────────────────

/** 最小 Redis 面(全 Lua,ioredis 结构兼容;测试注入内存版)。 */
export interface ConnectorRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

const LOCK_ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end`
const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`
/** compare-and-PEXPIRE 续租:仅当仍持 lease 时延长 TTL,返回 1;否则(被抢走)返回 0。 */
const LOCK_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`

const REFRESH_LOCK_TTL_MS = 30_000
/** 续租间隔:显著短于 TTL,保证出站请求(总超时可达 60s)全程持锁。 */
const REFRESH_RENEW_INTERVAL_MS = 8_000
/** 过期前 60s 视为需刷新(时钟偏移缓冲)。 */
const EXPIRY_SKEW_MS = 60_000

/**
 * 后台续租(P1#3):持锁期间周期性 compare-and-PEXPIRE。lease 被抢走(别的请求因我方
 * 停顿而抢锁)→ 调 onLost(调用方据此 abort 在飞的网络请求,不把旧凭据写回)。
 * Redis 抖动 → 本 tick 跳过(真 fencing 在 DB 双代数 CAS),下 tick 再试。
 * 返回 stop():清定时器,幂等。
 */
export function startLeaseRenewal(opts: {
  redis: ConnectorRedis
  lockKey: string
  lease: string
  ttlMs: number
  intervalMs: number
  onLost: () => void
}): () => void {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void (async () => {
      let held: unknown
      try {
        held = await opts.redis.eval(LOCK_RENEW, 1, opts.lockKey, opts.lease, opts.ttlMs)
      } catch {
        return // Redis 抖动:不 abort,下 tick 再试
      }
      if (held !== 1 && !stopped) opts.onLost()
    })()
  }, opts.intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function feishuTokenExpired(meta: Record<string, unknown>, now = Date.now()): boolean {
  const exp = meta.tokenExpiresAt
  if (typeof exp !== 'number') return true // 权威缺失 → 保守刷新
  return exp - EXPIRY_SKEW_MS <= now
}

/**
 * 确保 access token 可用:未过期直接返回;过期 → 锁内刷新 + 条件写回。
 * 返回**最新行**(刷新成功=新 generation;别人刷了=重读)。
 * invalid_grant → markConnectionError(RELINK_REQUIRED)fail-closed。
 *
 * P1#3 修复:
 *   ① 拿到 Redis 锁后**重新 SELECT active connection 并解密当前 generation**——不用拿锁前
 *      捕获的旧 secret(等锁期间别的请求可能已轮换 refresh token,旧 secret 会 invalid_grant)。
 *   ② compare-and-PEXPIRE 后台续租(lease TTL 30s < 出站总超时 60s);lease 丢失 → abort
 *      在飞的 token 请求,不把基于失效租约取得的凭据写回。
 *   ③ DB 双代数 CAS(updateConnectionSecret)保留为真 fencing——stale writer rowCount=0 丢弃。
 */
export async function ensureFreshFeishuConnection(
  row: ConnectionRow,
  pool: Pool,
  redis: ConnectorRedis | null,
  deps: FeishuDeps = {},
): Promise<{ row: ConnectionRow; secret: FeishuSecret }> {
  const secret0 = decryptConnectionSecret<FeishuSecret>(row)
  if (!feishuTokenExpired(row.meta)) return { row, secret: secret0 }

  const lockKey = `connectors:refresh:${row.id}`
  const lease = randomBytes(16).toString('hex')
  let locked = false
  // Redis 挂 ≠ 锁被别人持有:锁只减少无谓并发,真 fencing 在 DB revision+generation
  // 条件 —— eval 抛错时按"无锁直刷"处理,不能把 Redis 故障当 contention 死等。
  let lockUnavailable = redis == null
  if (redis) {
    try {
      locked = (await redis.eval(LOCK_ACQUIRE, 1, lockKey, lease, REFRESH_LOCK_TTL_MS)) === 1
    } catch {
      lockUnavailable = true
    }
  }

  let stopRenewal: (() => void) | undefined
  try {
    if (redis && !locked && !lockUnavailable) {
      // 别人在刷:小等后重读(最多 ~3s),拿到新 generation 即用
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const fresh = await getActiveConnection(row.id, row.user_id, pool)
        if (!fresh) throw new ConnectorError('CONNECTION_ERROR', 'connection gone during refresh')
        if (fresh.secret_generation !== row.secret_generation || !feishuTokenExpired(fresh.meta)) {
          return { row: fresh, secret: decryptConnectionSecret<FeishuSecret>(fresh) }
        }
      }
      throw new ConnectorError('UPSTREAM_TIMEOUT', 'feishu token refresh contention')
    }

    // ① 拿到锁(或无 Redis 直刷):以**锁内重查**的当前行为准,用当前 generation 的 secret。
    let workingRow = row
    let workingSecret = secret0
    if (redis && locked) {
      const fresh = await getActiveConnection(row.id, row.user_id, pool)
      if (!fresh) throw new ConnectorError('CONNECTION_ERROR', 'connection gone during refresh')
      // 等锁期间别人可能已刷新完成 → 直接用,避免拿旧 refresh token 再刷一次
      if (!feishuTokenExpired(fresh.meta)) {
        return { row: fresh, secret: decryptConnectionSecret<FeishuSecret>(fresh) }
      }
      workingRow = fresh
      workingSecret = decryptConnectionSecret<FeishuSecret>(fresh)
    }

    // ② 后台续租 + abort:lease 丢失即中止在飞的 token 请求
    const abortController = new AbortController()
    if (redis && locked) {
      stopRenewal = startLeaseRenewal({
        redis,
        lockKey,
        lease,
        ttlMs: REFRESH_LOCK_TTL_MS,
        intervalMs: REFRESH_RENEW_INTERVAL_MS,
        onLost: () => abortController.abort(),
      })
    }

    let refreshed: FeishuTokenResult
    try {
      refreshed = await refreshFeishuToken(
        {
          clientId: workingSecret.clientId,
          clientSecret: workingSecret.clientSecret,
          refreshToken: workingSecret.refreshToken,
        },
        { fetchImpl: deps.fetchImpl, signal: abortController.signal },
      )
    } catch (err) {
      if (err instanceof ConnectorError && err.code === 'RELINK_REQUIRED') {
        // fail-closed:标 error(generation 条件;stale 则丢弃)
        await markConnectionError(
          {
            id: workingRow.id,
            userId: workingRow.user_id,
            expectedGeneration: workingRow.secret_generation,
            errorCode: 'RELINK_REQUIRED',
          },
          pool,
        ).catch(() => {})
      }
      // 刷新失败(含 lease 丢失 abort)= 用户写 action 从未 dispatch(refresh 先于 action)
      // → 清除 transport 可能打上的 maybeDelivered,让写路径判 failed 而非 unknown(P1#3/P1#4)。
      if (err && typeof err === 'object' && 'maybeDelivered' in err) {
        ;(err as { maybeDelivered?: boolean }).maybeDelivered = false
      }
      throw err
    } finally {
      if (stopRenewal) stopRenewal()
    }

    // ③ 双代数 CAS 写回(基于锁内当前 revision/generation);stale writer rowCount=0 丢弃。
    const newSecret: FeishuSecret = {
      ...workingSecret,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    }
    const newMeta = { ...workingRow.meta, tokenExpiresAt: refreshed.expiresAt }
    await updateConnectionSecret(
      {
        id: workingRow.id,
        userId: workingRow.user_id,
        provider: 'feishu',
        expectedRevision: workingRow.revision,
        expectedGeneration: workingRow.secret_generation,
        payload: newSecret,
        meta: newMeta,
      },
      pool,
    )
    // 以 DB 现状为准(写入成功=我方新 token;stale=别人的新 token)——§2 fencing 纪律
    const fresh = await getActiveConnection(workingRow.id, workingRow.user_id, pool)
    if (!fresh) throw new ConnectorError('CONNECTION_ERROR', 'connection gone during refresh')
    return { row: fresh, secret: decryptConnectionSecret<FeishuSecret>(fresh) }
  } finally {
    if (stopRenewal) stopRenewal()
    if (redis && locked) {
      await redis.eval(LOCK_RELEASE, 1, lockKey, lease).catch(() => {})
    }
  }
}

// ─── actions ─────────────────────────────────────────────────────────────

async function feishuApi(
  accessToken: string,
  path: string,
  init: { method: string; body?: unknown },
  deps: FeishuDeps,
): Promise<Record<string, unknown>> {
  const json = await feishuJson(
    `${FEISHU_ENDPOINTS.apiBase}${path}`,
    {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    deps,
  )
  const code = json.code
  if (typeof code === 'number' && code !== 0) {
    // 99991677 / 99991668 等 token 失效族 → auth;其余稳定映射
    if (code === 99991661 || code === 99991668 || code === 99991677) {
      throw new ConnectorError('UPSTREAM_AUTH_FAILED', `feishu api auth code ${code}`)
    }
    throw new ConnectorError('UPSTREAM_ERROR', `feishu api code ${code}`)
  }
  return json
}

export async function feishuGetDoc(
  accessToken: string,
  params: { docId: string },
  deps: FeishuDeps = {},
): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(params.docId)) {
    throw new ConnectorError('VALIDATION_FAILED', 'docId shape invalid')
  }
  const json = await feishuApi(
    accessToken,
    `/open-apis/docx/v1/documents/${encodeURIComponent(params.docId)}/raw_content`,
    { method: 'GET' },
    deps,
  )
  const content = String((json.data as { content?: unknown })?.content ?? '')
  const [text, contentTruncated] = truncateText(content, TEXT_FIELD_MAX_CHARS)
  return { docId: params.docId, content: text, contentTruncated }
}

async function resolvePrimaryCalendarId(accessToken: string, deps: FeishuDeps): Promise<string> {
  const json = await feishuApi(
    accessToken,
    '/open-apis/calendar/v4/calendars/primary',
    { method: 'POST' },
    deps,
  )
  const data = json.data as { calendars?: Array<{ calendar?: { calendar_id?: string } }> }
  const id = data?.calendars?.[0]?.calendar?.calendar_id
  if (!id) throw new ConnectorError('UPSTREAM_ERROR', 'feishu primary calendar not found')
  return id
}

function toEpochSec(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) throw new ConnectorError('VALIDATION_FAILED', 'invalid datetime')
  return String(Math.floor(t / 1000))
}

export async function feishuListCalendarEvents(
  accessToken: string,
  params: { calendarId?: string; startTime: string; endTime: string },
  deps: FeishuDeps = {},
): Promise<unknown> {
  const calendarId = params.calendarId ?? (await resolvePrimaryCalendarId(accessToken, deps))
  const qs = new URLSearchParams({
    start_time: toEpochSec(params.startTime),
    end_time: toEpochSec(params.endTime),
    page_size: '200',
  })
  const json = await feishuApi(
    accessToken,
    `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
    { method: 'GET' },
    deps,
  )
  const items = ((json.data as { items?: unknown[] })?.items ?? []) as Array<
    Record<string, unknown>
  >
  const events = items.slice(0, 200).map((e) => {
    const [summary] = truncateText(String(e.summary ?? ''), 500)
    const start = (e.start_time as { timestamp?: string })?.timestamp
    const end = (e.end_time as { timestamp?: string })?.timestamp
    return {
      eventId: String(e.event_id ?? ''),
      summary,
      ...(start ? { startTime: new Date(Number(start) * 1000).toISOString() } : {}),
      ...(end ? { endTime: new Date(Number(end) * 1000).toISOString() } : {}),
      ...(typeof e.status === 'string' ? { status: e.status } : {}),
    }
  })
  return { events }
}

export async function feishuCreateCalendarEvent(
  accessToken: string,
  params: {
    calendarId?: string
    summary: string
    startTime: string
    endTime: string
    description?: string
    timezone?: string
  },
  idempotencyKey: string | undefined,
  deps: FeishuDeps = {},
): Promise<unknown> {
  const calendarId = params.calendarId ?? (await resolvePrimaryCalendarId(accessToken, deps))
  const tz = params.timezone ?? 'Asia/Shanghai'
  const qs = idempotencyKey ? `?idempotency_key=${encodeURIComponent(idempotencyKey)}` : ''
  const json = await feishuApi(
    accessToken,
    `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events${qs}`,
    {
      method: 'POST',
      body: {
        summary: params.summary,
        ...(params.description ? { description: params.description } : {}),
        start_time: { timestamp: toEpochSec(params.startTime), timezone: tz },
        end_time: { timestamp: toEpochSec(params.endTime), timezone: tz },
      },
    },
    deps,
  )
  const ev = (json.data as { event?: Record<string, unknown> })?.event ?? {}
  const eventId = String(ev.event_id ?? '')
  if (!eventId) throw new ConnectorError('UPSTREAM_ERROR', 'feishu event create returned no id')
  const [summary] = truncateText(String(ev.summary ?? params.summary), 500)
  return { eventId, summary }
}

export async function feishuSendMessage(
  accessToken: string,
  params: { receiveId: string; receiveIdType: string; text: string },
  idempotencyKey: string | undefined,
  deps: FeishuDeps = {},
): Promise<unknown> {
  const qs = new URLSearchParams({ receive_id_type: params.receiveIdType })
  const json = await feishuApi(
    accessToken,
    `/open-apis/im/v1/messages?${qs.toString()}`,
    {
      method: 'POST',
      body: {
        receive_id: params.receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: params.text }),
        ...(idempotencyKey ? { uuid: idempotencyKey } : {}), // provider 幂等键透传(§3)
      },
    },
    deps,
  )
  const messageId = String((json.data as { message_id?: unknown })?.message_id ?? '')
  if (!messageId) throw new ConnectorError('UPSTREAM_ERROR', 'feishu message send returned no id')
  return { messageId }
}

export async function executeFeishu(
  accessToken: string,
  action: string,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  deps: FeishuDeps = {},
): Promise<unknown> {
  switch (action) {
    case 'get_doc':
      return feishuGetDoc(accessToken, params as never, deps)
    case 'list_calendar_events':
      return feishuListCalendarEvents(accessToken, params as never, deps)
    case 'create_calendar_event':
      return feishuCreateCalendarEvent(accessToken, params as never, idempotencyKey, deps)
    case 'send_message':
      return feishuSendMessage(accessToken, params as never, idempotencyKey, deps)
    default:
      throw new ConnectorError('ACTION_UNKNOWN', `feishu has no action ${action}`)
  }
}
