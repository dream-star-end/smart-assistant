/**
 * V3 commercial Codex API relay (master side).
 *
 * Platform-managed Codex traffic is forced through:
 *   Codex CLI → container gateway loopback relay → master internal relay →
 *   codex account egress proxy → upstream OpenAI-compatible endpoint.
 *
 * This keeps proxy credentials out of user containers and makes egress
 * account-bound and fail-closed. Unknown/misconfigured proxy state never falls
 * back to master direct egress or process-global HTTP_PROXY.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Dispatcher } from 'undici'

import { rootLogger, type Logger } from '../logging/logger.js'
import { getRuntimeChannel } from '../runtimeChannel.js'
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from './util.js'
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from '../auth/containerIdentity.js'
import {
  CodexEgressError,
  resolveCodexAccountEgressDispatcher,
} from '../account-pool/codexEgress.js'
import { query } from '../db/queries.js'
import {
  markRelayCredentialFailure,
  markRelayCredentialSuccess,
  resolveCodexRouteContext,
  type ResolvedCodexRouteContext,
} from '../account-pool/groups.js'
import { getCodexTokenSnapshot } from '../account-pool/store.js'
import { zeroBuffer } from '../crypto/keys.js'

export const CODEX_RELAY_PREFIX = '/internal/v3/codex-relay'
export const CODEX_UPSTREAM_AUTH_HEADER = 'x-openclaude-upstream-authorization'

/** official_oauth 数据面的专用上游常量(方案 A3d/B5):代码内固定,不依赖
 *  OC_CODEX_UPSTREAM_BASE_URL env(那是 api_relay 遗产键,v5 部署已删)。
 *  对应容器 loopback base path = `${CODEX_RELAY_PREFIX}/backend-api/codex`
 *  (codexRelayBasePathForUpstream 既有拼法),与 gateway 侧
 *  CODEX_OFFICIAL_RELAY_BASE_PATH 常量成对 —— parity 由单测锁定。 */
export const CODEX_OFFICIAL_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SAFE_UPSTREAM_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'user-agent',
  // chatgpt.com/backend-api/codex(official_oauth 数据面)必需的非敏感请求元数据:
  // codex CLI 在 ChatGPT auth 模式下随请求发送 chatgpt-account-id(选择 workspace)、
  // originator / session_id / conversation_id(客户端指纹与会话关联)。均非凭证。
  'chatgpt-account-id',
  'originator',
  'session_id',
  'conversation_id',
])

export interface CodexRelayCtx {
  hostUuid: string
  boundIp: string
}

export type CodexRelayHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CodexRelayCtx,
) => Promise<void>

export interface CodexRelayBindingRow {
  codexAccountId: bigint | null
  userId: bigint
  state: string
  provider: string | null
  accountStatus: string | null
}

export interface CodexRelayDb {
  readContainerBinding(containerId: number): Promise<CodexRelayBindingRow | null>
}

export interface CodexRelayDispatcherInfo {
  accountId: bigint
  proxyId: bigint
  dispatcher: Dispatcher
}

export interface CodexRelayDeps {
  identityRepo: ContainerIdentityRepo
  db: CodexRelayDb
  upstreamBaseUrl?: string
  resolveDispatcher?: (accountId: bigint) => Promise<CodexRelayDispatcherInfo>
  resolveRouteContext?: typeof resolveCodexRouteContext
  markCredentialFailure?: typeof markRelayCredentialFailure
  markCredentialSuccess?: typeof markRelayCredentialSuccess
  /** 非 route 路径的 fallback 代注(方案 B5/3b):仅当容器没带上游 Authorization
   *  时,按绑定账号读当前 access token 代注。返回 Buffer 由 handler 用后清零。
   *  返回 null / 抛错 → 503 fail-closed(不静默直连、不裸转发)。 */
  readBoundAccountAccessToken?: (accountId: bigint) => Promise<Buffer | null>
  fetchImpl?: typeof fetch
  logger?: Logger
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { code, message }, requestId }))
}

function normalizeBasePath(upstreamBaseUrl: string): string {
  const u = new URL(upstreamBaseUrl)
  const p = u.pathname.replace(/\/+$/, '')
  return p === '/' ? '' : p
}

export function codexRelayBasePathForUpstream(upstreamBaseUrl: string): string {
  return `${CODEX_RELAY_PREFIX}${normalizeBasePath(upstreamBaseUrl)}`
}

export function readCodexUpstreamBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromDedicated = env.OC_CODEX_UPSTREAM_BASE_URL?.trim()
  if (fromDedicated) return fromDedicated
  const fromLegacy = env.OC_CODEX_BASE_URL?.trim()
  if (fromLegacy) return fromLegacy
  return 'https://api.openai.com/v1'
}

export function buildCodexRelayLocalBaseUrl(
  localOrigin: string,
  upstreamBaseUrl: string,
): string {
  return `${localOrigin.replace(/\/+$/, '')}${codexRelayBasePathForUpstream(upstreamBaseUrl)}`
}

function validateRelaySuffix(method: string, suffixRaw: string): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const suffix = suffixRaw.length === 0 ? '/' : suffixRaw
  let decoded: string
  try {
    decoded = decodeURIComponent(suffix)
  } catch {
    return { ok: false, status: 400, code: 'BAD_PATH', message: 'malformed relay path encoding' }
  }
  if (
    decoded.includes('..')
    || decoded.includes('\\')
    || decoded.startsWith('//')
    || decoded.includes('\u0000')
  ) {
    return { ok: false, status: 400, code: 'BAD_PATH', message: 'unsafe relay path' }
  }

  if (method === 'POST' && decoded === '/responses') return { ok: true }
  if ((method === 'GET' || method === 'POST' || method === 'DELETE') && /^\/responses\/[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?$/.test(decoded)) {
    return { ok: true }
  }
  if (method === 'POST' && decoded === '/chat/completions') return { ok: true }
  if (method === 'GET' && /^\/models(?:\/[A-Za-z0-9_.:-]+)?$/.test(decoded)) return { ok: true }
  // codex 原生生图(imagegen 工具,gpt-image-2):平台生图首选(boss 裁决 2026-07-11)。
  // 仍走绑定账号 egress 代理 + 上游鉴权,与 /responses 同一 fail-closed 面;
  // 按张计费未接(playbook §5 债),当前计入平台账号订阅配额。
  if (method === 'POST' && (decoded === '/images/generations' || decoded === '/images/edits')) {
    return { ok: true }
  }

  return { ok: false, status: 404, code: 'PATH_NOT_ALLOWED', message: 'codex relay path not allowed' }
}

export function mapCodexRelayUrl(
  reqUrl: string,
  method: string,
  upstreamBaseUrl: string,
): { url: string; upstreamHost: string; upstreamPath: string; suffix: string } | { error: { status: number; code: string; message: string } } {
  let parsed: URL
  try {
    parsed = new URL(reqUrl, 'http://internal')
  } catch {
    return { error: { status: 400, code: 'BAD_URL', message: 'malformed request url' } }
  }
  if (parsed.pathname.includes('://')) {
    return { error: { status: 400, code: 'BAD_URL', message: 'absolute url proxying is not allowed' } }
  }
  const basePath = codexRelayBasePathForUpstream(upstreamBaseUrl)
  if (parsed.pathname !== basePath && !parsed.pathname.startsWith(`${basePath}/`)) {
    return { error: { status: 404, code: 'NOT_FOUND', message: 'unknown codex relay path' } }
  }
  const suffix = parsed.pathname.slice(basePath.length)
  const allowed = validateRelaySuffix(method, suffix)
  if (allowed.ok === false) {
    return {
      error: {
        status: allowed.status,
        code: allowed.code,
        message: allowed.message,
      },
    }
  }

  const upstream = new URL(upstreamBaseUrl)
  const upstreamBasePath = normalizeBasePath(upstreamBaseUrl)
  upstream.pathname = `${upstreamBasePath}${suffix || ''}` || '/'
  upstream.search = parsed.search
  return {
    url: upstream.toString(),
    upstreamHost: upstream.host,
    upstreamPath: upstream.pathname,
    suffix,
  }
}

/**
 * 非 route 路径可用的上游 base 集合(方案 B5):official 常量恒在;env base
 * (api_relay 遗产,v3 兼容)仅在 relay base path 与 official 不撞时保留。
 * 撞了 official 赢 —— env 不允许把 `/backend-api/codex` 前缀劫持到别的 host。
 * 返回按 base path 从长到短排序,供最长前缀优先匹配。
 */
export function resolveCodexRelayUpstreamBases(envUpstreamBaseUrl: string): string[] {
  const officialBasePath = normalizeBasePath(CODEX_OFFICIAL_UPSTREAM_BASE_URL)
  const bases = [CODEX_OFFICIAL_UPSTREAM_BASE_URL]
  if (normalizeBasePath(envUpstreamBaseUrl) !== officialBasePath) {
    bases.push(envUpstreamBaseUrl)
  }
  return bases.sort((a, b) => normalizeBasePath(b).length - normalizeBasePath(a).length)
}

/**
 * 多上游 base 的路径映射:最长 base path 优先。base path 不匹配(NOT_FOUND)
 * 才尝试下一个;base path 匹配但 suffix 不在 allowlist(PATH_NOT_ALLOWED /
 * BAD_PATH / BAD_URL)立即返回该错,不给短前缀 base "接盘" 的机会。
 */
export function mapCodexRelayUrlMulti(
  reqUrl: string,
  method: string,
  upstreamBaseUrls: string[],
): ReturnType<typeof mapCodexRelayUrl> {
  let notFound: ReturnType<typeof mapCodexRelayUrl> | null = null
  for (const base of upstreamBaseUrls) {
    const mapped = mapCodexRelayUrl(reqUrl, method, base)
    if (!('error' in mapped)) return mapped
    if (mapped.error.code !== 'NOT_FOUND') return mapped
    notFound ??= mapped
  }
  return notFound ?? { error: { status: 404, code: 'NOT_FOUND', message: 'unknown codex relay path' } }
}


function parseRouteRelayUrl(
  reqUrl: string,
  method: string,
):
  | { route: true; token: string; suffix: string; search: string }
  | { route: false }
  | { error: { status: number; code: string; message: string } } {
  let parsed: URL
  try {
    parsed = new URL(reqUrl, 'http://internal')
  } catch {
    return { error: { status: 400, code: 'BAD_URL', message: 'malformed request url' } }
  }
  const prefix = `${CODEX_RELAY_PREFIX}/route/`
  if (!parsed.pathname.startsWith(prefix)) return { route: false }
  const rest = parsed.pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  const token = slash >= 0 ? rest.slice(0, slash) : rest
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return { error: { status: 400, code: 'BAD_ROUTE_TOKEN', message: 'invalid route token' } }
  }
  const suffix = slash >= 0 ? rest.slice(slash) : ''
  const allowed = validateRelaySuffix(method, suffix)
  if (allowed.ok === false) {
    return { error: { status: allowed.status, code: allowed.code, message: allowed.message } }
  }
  return { route: true, token, suffix, search: parsed.search }
}

function mapRouteContextUrl(
  route: ResolvedCodexRouteContext,
  suffix: string,
  search: string,
): { url: string; upstreamHost: string; upstreamPath: string } {
  const upstream = new URL(route.credential.base_url)
  const upstreamBasePath = normalizeBasePath(route.credential.base_url)
  upstream.pathname = `${upstreamBasePath}${suffix || ''}` || '/'
  upstream.search = search
  return { url: upstream.toString(), upstreamHost: upstream.host, upstreamPath: upstream.pathname }
}

function appendHeader(headers: Headers, key: string, value: string | string[] | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    for (const v of value) headers.append(key, v)
    return
  }
  headers.set(key, value)
}

function buildUpstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (key === 'host' || key === 'content-length') continue
    if (key === 'authorization' || key === CODEX_UPSTREAM_AUTH_HEADER) continue
    if (key.startsWith('x-openclaude-')) continue
    if (!SAFE_UPSTREAM_REQUEST_HEADERS.has(key)) continue
    appendHeader(headers, rawKey, rawValue)
  }
  const upstreamAuth = req.headers[CODEX_UPSTREAM_AUTH_HEADER]
  if (typeof upstreamAuth === 'string' && upstreamAuth.trim().length > 0) {
    headers.set('authorization', upstreamAuth)
  }
  // Avoid response decompression/header mismatch surprises in the relay. SSE
  // and JSON streaming work fine with identity encoding.
  headers.set('accept-encoding', 'identity')
  return headers
}

function copyResponseHeaders(from: Headers, res: ServerResponse): void {
  from.forEach((value, rawKey) => {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) return
    if (key === 'content-length') return
    res.setHeader(rawKey, value)
  })
}

export function isRelayCredentialFailureStatus(status: number): boolean {
  return status >= 500 || status === 401 || status === 403 || status === 429
}

function closeIfHeadersAlreadySent(res: ServerResponse, err: unknown): boolean {
  if (res.writableEnded) return true
  if (!res.headersSent) return false
  res.destroy(err instanceof Error ? err : undefined)
  return true
}

export function makeDefaultCodexRelayDb(): CodexRelayDb {
  return {
    async readContainerBinding(containerId) {
      const r = await query<{
        codex_account_id: string | null
        user_id: string
        state: string
        provider: string | null
        account_status: string | null
      }>(
        `SELECT ac.codex_account_id::text AS codex_account_id,
                ac.user_id::text AS user_id,
                ac.state,
                ca.provider,
                ca.status AS account_status
           FROM agent_containers ac -- state selected above; handler rejects non-active
           LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
          WHERE ac.id = $1 AND ac.runtime_channel = $2`,
        [containerId, getRuntimeChannel()],
      )
      if (!r.rows[0]) return null
      const row = r.rows[0]
      return {
        codexAccountId: row.codex_account_id === null ? null : BigInt(row.codex_account_id),
        userId: BigInt(row.user_id),
        state: row.state,
        provider: row.provider,
        accountStatus: row.account_status,
      }
    },
  }
}

export function makeCodexRelayHandler(deps: CodexRelayDeps): CodexRelayHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalCodexRelay' })
  const envUpstreamBaseUrl = deps.upstreamBaseUrl ?? readCodexUpstreamBaseUrl()
  // Validate once at construction; invalid env should fail loudly during boot
  // rather than at first user request.
  new URL(envUpstreamBaseUrl)
  // 非 route 路径支持的上游集合:official 常量 + env base(v3 api_relay 兼容)。
  const upstreamBaseUrls = resolveCodexRelayUpstreamBases(envUpstreamBaseUrl)
  const resolveDispatcher = deps.resolveDispatcher ?? (async (accountId: bigint) => {
    const r = await resolveCodexAccountEgressDispatcher(accountId)
    return { accountId: r.accountId, proxyId: r.proxyId, dispatcher: r.dispatcher }
  })
  const resolveRoute = deps.resolveRouteContext ?? resolveCodexRouteContext
  const markCredentialFailure = deps.markCredentialFailure ?? markRelayCredentialFailure
  const markCredentialSuccess = deps.markCredentialSuccess ?? markRelayCredentialSuccess
  const readBoundAccountAccessToken = deps.readBoundAccountAccessToken ?? (async (accountId: bigint) => {
    const snap = await getCodexTokenSnapshot(accountId)
    if (!snap) return null
    // 代注只需要 access token;refresh 材料立即清零,不出本闭包。
    if (snap.refresh) zeroBuffer(snap.refresh)
    return snap.token
  })
  const fetchImpl = deps.fetchImpl ?? fetch

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    const method = req.method ?? 'GET'
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp, method })

    const routeReq = parseRouteRelayUrl(req.url ?? '/', method)
    if ('error' in routeReq) {
      sendJsonError(res, routeReq.error.status, routeReq.error.code, routeReq.error.message, requestId)
      return
    }
    let mapped: ReturnType<typeof mapCodexRelayUrl> | null = null
    if (routeReq.route === false) {
      mapped = mapCodexRelayUrlMulti(req.url ?? '/', method, upstreamBaseUrls)
      if ('error' in mapped) {
        sendJsonError(res, mapped.error.status, mapped.error.code, mapped.error.message, requestId)
        return
      }
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn('identity_failed', { errcode: err.code })
        sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
        return
      }
      throw err
    }

    const userLog = reqLog.child({ uid: identity.userId, containerId: identity.containerId })

    let binding: CodexRelayBindingRow | null
    try {
      binding = await deps.db.readContainerBinding(identity.containerId)
    } catch (err) {
      userLog.error('binding_read_failed', { err: err as Error })
      sendJsonError(res, 500, 'INTERNAL', 'container binding read failed', requestId)
      return
    }
    if (!binding) {
      userLog.warn('binding_missing_after_identity')
      sendJsonError(res, 409, 'CONTAINER_BINDING_CHANGED', 'container row vanished', requestId)
      return
    }
    if (binding.userId !== BigInt(identity.userId)) {
      userLog.error('identity_userid_mismatch', { rowUid: String(binding.userId) })
      sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
      return
    }
    if (binding.state !== 'active') {
      userLog.warn('container_not_active', { state: binding.state })
      sendJsonError(res, 409, 'CONTAINER_BINDING_CHANGED', 'container is not active', requestId)
      return
    }

    let egress: CodexRelayDispatcherInfo | null = null
    let routeContext: ResolvedCodexRouteContext | null = null
    let mappedUrl: { url: string; upstreamHost: string; upstreamPath: string }
    // 非 route 路径的上游 Authorization 来源(B5/3b):
    //   container         — 容器带了 x-openclaude-upstream-authorization,原样转发;
    //                        上游 401 → 记日志 + 401 透传 fail-closed,绝不改用
    //                        DB token 静默重试(防掩盖 codex auth 行为漂移)。
    //   account_fallback  — 容器没带 → 按绑定账号 DB 读 access token 代注;
    //                        读不到 / 解密失败 → 503 fail-closed。
    let hadContainerUpstreamAuth = false
    let fallbackAccessToken: Buffer | null = null
    if (routeReq.route === true) {
      try {
        routeContext = await resolveRoute({
          token: routeReq.token,
          containerId: identity.containerId,
          userId: BigInt(identity.userId),
        })
      } catch (err) {
        userLog.warn('route_context_read_failed', { err: err instanceof Error ? err.message : String(err) })
        sendJsonError(res, 503, 'CODEX_ROUTE_UNAVAILABLE', 'codex route unavailable', requestId)
        return
      }
      if (!routeContext) {
        userLog.warn('route_context_unavailable')
        sendJsonError(res, 503, 'CODEX_ROUTE_UNAVAILABLE', 'codex route unavailable', requestId)
        return
      }
      mappedUrl = mapRouteContextUrl(routeContext, routeReq.suffix, routeReq.search)
    } else {
      if (binding.codexAccountId === null) {
        userLog.warn('no_bound_account')
        sendJsonError(res, 503, 'NO_BOUND_CODEX_ACCOUNT', 'container has no codex account bound', requestId)
        return
      }
      if (binding.provider !== 'codex' || binding.accountStatus !== 'active') {
        userLog.warn('bound_account_not_active', {
          codexAccountId: String(binding.codexAccountId),
          provider: binding.provider,
          accountStatus: binding.accountStatus,
        })
        sendJsonError(res, 503, 'CODEX_ACCOUNT_NOT_ACTIVE', 'bound codex account is not active', requestId)
        return
      }

      try {
        egress = await resolveDispatcher(binding.codexAccountId)
      } catch (err) {
        const fields = err instanceof CodexEgressError
          ? { code: err.code, proxyId: err.details.proxyId ?? null }
          : { code: 'unknown', proxyId: null }
        userLog.warn('egress_unavailable', {
          codexAccountId: String(binding.codexAccountId),
          ...fields,
        })
        sendJsonError(res, 503, 'CODEX_EGRESS_UNAVAILABLE', 'codex account egress unavailable', requestId)
        return
      }
      mappedUrl = mapped as Exclude<typeof mapped, null | { error: unknown }>

      const upstreamAuthRaw = req.headers[CODEX_UPSTREAM_AUTH_HEADER]
      hadContainerUpstreamAuth =
        typeof upstreamAuthRaw === 'string' && upstreamAuthRaw.trim().length > 0
      if (!hadContainerUpstreamAuth) {
        try {
          fallbackAccessToken = await readBoundAccountAccessToken(binding.codexAccountId)
        } catch (err) {
          userLog.warn('auth_fallback_token_read_failed', {
            codexAccountId: String(binding.codexAccountId),
            err: err instanceof Error ? err.message : String(err),
          })
          sendJsonError(res, 503, 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE', 'codex account token unavailable', requestId)
          return
        }
        if (fallbackAccessToken === null || fallbackAccessToken.length === 0) {
          userLog.warn('auth_fallback_token_missing', {
            codexAccountId: String(binding.codexAccountId),
          })
          sendJsonError(res, 503, 'CODEX_ACCOUNT_TOKEN_UNAVAILABLE', 'codex account token unavailable', requestId)
          return
        }
        userLog.info('auth_fallback_injected', {
          codexAccountId: String(binding.codexAccountId),
        })
      }
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    res.once('close', abort)

    const relayLog = userLog.child({
      codexAccountId: egress ? String(egress.accountId) : null,
      relayCredentialId: routeContext ? String(routeContext.credential.id) : null,
      proxyId: egress ? String(egress.proxyId) : null,
      upstreamHost: mappedUrl.upstreamHost,
      upstreamPath: mappedUrl.upstreamPath,
    })

    try {
      const init: RequestInit & { dispatcher?: unknown; duplex?: 'half' } = {
        method,
        headers: buildUpstreamHeaders(req),
        body: method === 'GET' || method === 'HEAD' ? undefined : (req as unknown as BodyInit),
        dispatcher: egress?.dispatcher,
        duplex: 'half',
        signal: controller.signal,
      }
      if (routeContext) {
        const apiKey = routeContext.apiKey
        try {
          init.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers as HeadersInit)
          ;(init.headers as Headers).set('authorization', `Bearer ${apiKey.toString('utf8')}`)
        } finally {
          zeroBuffer(apiKey)
        }
      }
      if (fallbackAccessToken !== null) {
        try {
          init.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers as HeadersInit)
          ;(init.headers as Headers).set('authorization', `Bearer ${fallbackAccessToken.toString('utf8')}`)
        } finally {
          zeroBuffer(fallbackAccessToken)
          fallbackAccessToken = null
        }
      }
      const upstream = await fetchImpl(mappedUrl.url, init)
      res.statusCode = upstream.status
      copyResponseHeaders(upstream.headers, res)
      relayLog.info('relay_upstream_response', { status: upstream.status })
      if (egress !== null && upstream.status === 401 && hadContainerUpstreamAuth) {
        // fail-closed:容器自带的上游 Authorization 被上游拒 → 只记日志、401 原样
        // 透传。不允许在这里换 DB token 重试 —— 那会静默掩盖 codex CLI auth 行为
        // 漂移 / 容器 auth.json 与账号池的失同步。
        relayLog.warn('upstream_401_container_auth_fail_closed', {
          codexAccountId: String(egress.accountId),
        })
      }
      if (routeContext) {
        if (isRelayCredentialFailureStatus(upstream.status)) {
          void markCredentialFailure(routeContext.credential.id, `http_${upstream.status}`).catch(() => {})
        } else {
          void markCredentialSuccess(routeContext.credential.id).catch(() => {})
        }
      }
      if (!upstream.body) {
        res.end()
        return
      }
      await new Promise<void>((resolve, reject) => {
        const body = Readable.fromWeb(upstream.body as any)
        body.on('error', reject)
        res.on('error', reject)
        res.on('finish', resolve)
        body.pipe(res)
      })
    } catch (err) {
      if (controller.signal.aborted) return
      relayLog.warn('relay_fetch_failed', { err: err as Error })
      if (routeContext) {
        void markCredentialFailure(routeContext.credential.id, err instanceof Error ? err.message : String(err)).catch(() => {})
      }
      if (closeIfHeadersAlreadySent(res, err)) return
      sendJsonError(res, 502, 'CODEX_RELAY_UPSTREAM_FAILED', 'codex upstream request failed', requestId)
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
  }
}
