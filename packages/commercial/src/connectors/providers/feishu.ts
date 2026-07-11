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

export interface FeishuDeps {
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
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
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
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
const LOCK_VERIFY = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 else return 0 end`
const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

const REFRESH_LOCK_TTL_MS = 30_000
/** 过期前 60s 视为需刷新(时钟偏移缓冲)。 */
const EXPIRY_SKEW_MS = 60_000

export function feishuTokenExpired(meta: Record<string, unknown>, now = Date.now()): boolean {
  const exp = meta.tokenExpiresAt
  if (typeof exp !== 'number') return true // 权威缺失 → 保守刷新
  return exp - EXPIRY_SKEW_MS <= now
}

/**
 * 确保 access token 可用:未过期直接返回;过期 → 锁内刷新 + 条件写回。
 * 返回**最新行**(刷新成功=新 generation;别人刷了=重读)。
 * invalid_grant → markConnectionError(RELINK_REQUIRED)fail-closed。
 */
export async function ensureFreshFeishuConnection(
  row: ConnectionRow,
  pool: Pool,
  redis: ConnectorRedis | null,
  deps: FeishuDeps = {},
): Promise<{ row: ConnectionRow; secret: FeishuSecret }> {
  let secret = decryptConnectionSecret<FeishuSecret>(row)
  if (!feishuTokenExpired(row.meta)) return { row, secret }

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

    // 调端点前验证 lease 仍在手(锁被过期抢走 → 放弃,让新持有者做)
    if (redis && locked) {
      const ok = (await redis.eval(LOCK_VERIFY, 1, lockKey, lease).catch(() => 1)) === 1
      if (!ok) throw new ConnectorError('UPSTREAM_TIMEOUT', 'refresh lease lost')
    }

    let refreshed: FeishuTokenResult
    try {
      refreshed = await refreshFeishuToken(
        {
          clientId: secret.clientId,
          clientSecret: secret.clientSecret,
          refreshToken: secret.refreshToken,
        },
        deps,
      )
    } catch (err) {
      if (err instanceof ConnectorError && err.code === 'RELINK_REQUIRED') {
        // fail-closed:标 error(generation 条件;stale 则丢弃)
        await markConnectionError(
          {
            id: row.id,
            userId: row.user_id,
            expectedGeneration: row.secret_generation,
            errorCode: 'RELINK_REQUIRED',
          },
          pool,
        ).catch(() => {})
      }
      throw err
    }

    // 写回前再验 lease(锁丢≠必败:DB 条件是真 fencing,但 lease 丢弃可少一次冲突写)
    if (redis && locked) {
      const ok = (await redis.eval(LOCK_VERIFY, 1, lockKey, lease).catch(() => 1)) === 1
      if (!ok) {
        const fresh = await getActiveConnection(row.id, row.user_id, pool)
        if (fresh && fresh.secret_generation !== row.secret_generation) {
          return { row: fresh, secret: decryptConnectionSecret<FeishuSecret>(fresh) }
        }
      }
    }

    const newSecret: FeishuSecret = {
      ...secret,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    }
    const newMeta = { ...row.meta, tokenExpiresAt: refreshed.expiresAt }
    const wrote = await updateConnectionSecret(
      {
        id: row.id,
        userId: row.user_id,
        provider: 'feishu',
        expectedRevision: row.revision,
        expectedGeneration: row.secret_generation,
        payload: newSecret,
        meta: newMeta,
      },
      pool,
    )
    // rowCount=0 → stale writer,丢弃本次结果,以 DB 现状为准(§2 fencing 纪律)
    const fresh = await getActiveConnection(row.id, row.user_id, pool)
    if (!fresh) throw new ConnectorError('CONNECTION_ERROR', 'connection gone during refresh')
    if (!wrote) {
      secret = decryptConnectionSecret<FeishuSecret>(fresh)
      return { row: fresh, secret }
    }
    return { row: fresh, secret: decryptConnectionSecret<FeishuSecret>(fresh) }
  } finally {
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
