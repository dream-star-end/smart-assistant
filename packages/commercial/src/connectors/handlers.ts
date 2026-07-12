/**
 * handlers — 用户管理 API(设计终稿 §7;router.ts 以 ANY_METHOD 挂
 * `/api/connectors`(精确)+ `/api/connectors/`(前缀)两行,method/子路由
 * 权威收口在本 dispatcher,照 dispatchOrgRoute 模式)。
 *
 *   GET    /api/connectors                        目录 + 已绑合并视图
 *   POST   /api/connectors/:provider              表单绑定(token/basic)verify→落库
 *   POST   /api/connectors/:provider/oauth/start  BYOA(feishu)
 *   GET    /api/connectors/oauth/callback         consume→exchange→verify→落库→302
 *   GET    /api/connectors/confirmations/:id      完整确认详情(服务端解密渲染)
 *   POST   /api/connectors/confirmations/:id/approve|deny
 *   PATCH  /api/connectors/:id                    display_name
 *   DELETE /api/connectors/:id                    解绑 saga(§8)
 *
 * wire 契约对齐(web-react lib/connectors.ts,钉死不得擅改):
 *   authKind ∈ 'basic_form' | 'token' | 'oauth2_byoa'(registry 内部值在此翻译);
 *   错误码翻译到前端已映射的稳定码(SSRF_BLOCKED/INVALID_CREDENTIALS/…),
 *   未映射的走前端通用回退,不泄内部细节。
 *
 * github 在目录中以虚拟连接(id='github')露出;PATCH 拒绝,DELETE 复用既有
 * revoke/清 session 语义(§4)。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { AeadError } from '../crypto/aead.js'
import { getPool } from '../db/index.js'
import { revokeGithubLinkAndClearSessions } from '../github/tokenStore.js'
import { requireAuth } from '../http/auth.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import { HttpError, sendJson } from '../http/util.js'
import { dispatchDeclarativeConnectors } from './declarativeHandlers.js'
import { bindWithBag } from './engine/bind.js'
import type { DeclarativeSecretBag } from './engine/credentialBag.js'
import { exchangeAuthCode } from './engine/oauth2.js'
import { ConnectorError, toConnectorError } from './errors.js'
import {
  approveConfirmation,
  decryptLedgerParams,
  denyConfirmation,
  getLedgerRow,
} from './ledger.js'
import {
  type OauthDraft,
  clearConnectorOauthCookie,
  consumeOauthPending,
  readConnectorOauthCookie,
  readConnectorsOauthRedirectUri,
  setConnectorOauthCookie,
  startOauthPending,
} from './oauthPending.js'
import { validateWebdavBaseUrl } from './outboundPolicy.js'
import { generatePkceVerifier } from './pkce.js'
import {
  buildFeishuAuthorizeUrl,
  checkFeishuScopes,
  exchangeFeishuCode,
  fetchFeishuUserInfo,
} from './providers/feishu.js'
import { presetImapConfig, verifyImapCredentials } from './providers/imap.js'
import { verifyNotionToken } from './providers/notion.js'
import { verifyWebdavCredentials } from './providers/webdav.js'
import {
  CONNECTOR_PROVIDERS,
  type ConnectorAuthKind,
  type ConnectorProviderDecl,
  type DbConnectorProvider,
  isDbProvider,
} from './registry.js'
import { buildWriteDetail } from './service.js'
import { loadVerifiedContractWithMeta } from './spec/review.js'
import { ConnectorSpecError } from './spec/types.js'
import {
  type ConnectionRow,
  type ConnectorSecret,
  canonicalAccountIdentity,
  computeAccountKey,
  getConnectionAnyStatus,
  listConnections,
  renameConnection,
  revokeConnection,
  upsertConnection,
} from './store.js'

const MAX_BODY_BYTES = 64 * 1024

// ─── wire 翻译 ───────────────────────────────────────────────────────────

/** registry authKind → 前端钉死的 wire 值。 */
function wireAuthKind(kind: ConnectorAuthKind): string {
  switch (kind) {
    case 'form':
      return 'basic_form'
    case 'token':
      return 'token'
    case 'oauth':
      return 'oauth2_byoa'
    case 'github':
      // github 不走弹层(前端按 id 拦截跳现有 OAuth);wire 值取 oauth2_byoa 占位
      return 'oauth2_byoa'
  }
}

/** 内部稳定码 → 前端已映射码(绑定/授权语境)。未列出的原样透出(前端通用回退)。 */
function wireErrorCode(code: string, context: 'bind' | 'oauth' | 'generic'): string {
  switch (code) {
    case 'OUTBOUND_BLOCKED':
      return 'SSRF_BLOCKED'
    case 'PROVIDER_UNKNOWN':
      return 'UNSUPPORTED_PROVIDER'
    case 'CONNECTION_NOT_FOUND':
    case 'CONFIRMATION_NOT_FOUND':
      return 'NOT_FOUND'
    case 'UPSTREAM_AUTH_FAILED':
      return context === 'bind' ? 'INVALID_CREDENTIALS' : code
    case 'UPSTREAM_ERROR':
    case 'UPSTREAM_TIMEOUT':
    case 'UPSTREAM_NOT_FOUND':
    case 'UPSTREAM_RATE_LIMITED':
      return context === 'bind' ? 'VERIFY_FAILED' : code
    case 'OAUTH_STATE_MISMATCH':
      return 'STATE_MISMATCH'
    case 'OAUTH_EXCHANGE_FAILED':
      return 'TOKEN_EXCHANGE_FAILED'
    case 'OAUTH_NOT_CONFIGURED':
      return 'OAUTH_START_FAILED'
    case 'SCOPE_INSUFFICIENT':
      return 'SCOPE_INSUFFICIENT'
    default:
      return code
  }
}

function toHttpError(err: unknown, context: 'bind' | 'oauth' | 'generic'): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof AeadError) {
    return new HttpError(500, 'INTERNAL', 'credential integrity failure')
  }
  const ce = toConnectorError(err)
  const status = ce.code === 'INTERNAL' ? 500 : ce.httpStatus
  // message 不透传上游/内部细节
  return new HttpError(status, wireErrorCode(ce.code, context), 'connector operation failed')
}

// ─── 公共 helpers ────────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'body must be a JSON object')
  }
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(`Redirecting to ${location}\n`)
}

function connectorErrorRedirect(code: string): string {
  return `/?connector_error=${encodeURIComponent(code)}`
}

function connectionWire(row: ConnectionRow): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    accountHint: typeof row.meta.account_hint === 'string' ? row.meta.account_hint : '',
    status: row.status,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at.toISOString(),
  }
}

function providerWire(decl: ConnectorProviderDecl): Record<string, unknown> {
  return {
    id: decl.id,
    label: decl.label,
    description: decl.description,
    authKind: wireAuthKind(decl.authKind),
    formFields: decl.formFields,
  }
}

function requireStringField(obj: Record<string, unknown>, key: string, maxLen: number): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > maxLen) {
    throw new HttpError(400, 'VALIDATION_FAILED', `field ${key} required`)
  }
  return v.trim()
}

// ─── 入口 dispatcher(router 挂 ANY_METHOD) ──────────────────────────────

export async function dispatchConnectorsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const path = url.pathname.replace(/\/+$/, '') || url.pathname
  const method = (req.method ?? 'GET').toUpperCase()
  const rest = path === '/api/connectors' ? '' : path.slice('/api/connectors/'.length)
  const segs = rest === '' ? [] : rest.split('/')

  // GET /api/connectors — 目录
  if (segs.length === 0) {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only')
    await handleCatalog(req, res, deps)
    return
  }

  // 声明式连接器子路由(/api/connectors/declarative/*):catalog/bind/connections/unbind。
  if (segs[0] === 'declarative') {
    await dispatchDeclarativeConnectors(req, res, deps, segs.slice(1), method)
    return
  }

  // GET /api/connectors/oauth/callback(浏览器导航,无 Bearer)
  if (segs[0] === 'oauth' && segs[1] === 'callback' && segs.length === 2) {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only')
    await handleOauthCallback(req, res, ctx, deps)
    return
  }

  // confirmations/:id[/approve|deny]
  if (segs[0] === 'confirmations' && segs.length >= 2) {
    const id = segs[1]!
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new HttpError(404, 'NOT_FOUND', 'bad id')
    if (segs.length === 2) {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only')
      await handleConfirmationDetail(req, res, deps, id)
      return
    }
    if (segs.length === 3 && (segs[2] === 'approve' || segs[2] === 'deny')) {
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST only')
      await handleConfirmationDecision(req, res, deps, id, segs[2])
      return
    }
    throw new HttpError(404, 'NOT_FOUND', 'unknown confirmations route')
  }

  // :provider/oauth/start
  if (segs.length === 3 && segs[1] === 'oauth' && segs[2] === 'start') {
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST only')
    await handleOauthStart(req, res, deps, segs[0]!)
    return
  }

  if (segs.length === 1) {
    const first = segs[0]!
    // 数字 id → PATCH/DELETE 连接;'github' → 虚拟连接管理
    if (/^\d{1,19}$/.test(first) || first === 'github') {
      if (method === 'PATCH') {
        await handleRename(req, res, deps, first)
        return
      }
      if (method === 'DELETE') {
        await handleUnbind(req, res, ctx, deps, first)
        return
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'PATCH/DELETE only')
    }
    // :provider → POST 表单绑定
    if (method === 'POST') {
      await handleBind(req, res, ctx, deps, first)
      return
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST only')
  }

  throw new HttpError(404, 'NOT_FOUND', 'unknown connectors route')
}

// ─── GET /api/connectors ─────────────────────────────────────────────────

async function handleCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const pool = getPool()

  const providers = Object.values(CONNECTOR_PROVIDERS).map(providerWire)
  const rows = await listConnections(userId, pool)
  const connections: Array<Record<string, unknown>> = rows.map(connectionWire)

  // github 虚拟连接(§4;id='github',DELETE 走既有 revoke 语义)
  const gh = await pool.query<{ login: string; linked_at: Date }>(
    `SELECT login, linked_at FROM github_links
      WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`,
    [userId],
  )
  if ((gh.rowCount ?? 0) > 0) {
    const row = gh.rows[0]!
    connections.push({
      id: 'github',
      provider: 'github',
      displayName: 'GitHub',
      accountHint: row.login,
      status: 'active',
      lastErrorCode: null,
      createdAt: row.linked_at.toISOString(),
    })
  }
  sendJson(res, 200, { providers, connections })
}

// ─── POST /api/connectors/:provider(表单绑定) ────────────────────────────

async function handleBind(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  providerId: string,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const pool = getPool()

  if (!isDbProvider(providerId) || providerId === 'feishu') {
    // feishu 走 oauth/start;github 走现有 OAuth
    throw new HttpError(400, 'UNSUPPORTED_PROVIDER', 'provider does not support form bind')
  }
  const body = await readJsonBody(req)
  const fields =
    body.fields !== null && typeof body.fields === 'object' && !Array.isArray(body.fields)
      ? (body.fields as Record<string, unknown>)
      : {}
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : undefined

  try {
    const bound = await bindFormProvider(providerId, userId, fields, displayName, pool)
    ctx.log.info('connector_bound', {
      sub: user.id,
      provider: providerId,
      connectionId: bound.id,
      rebound: bound.rebound,
    })
    sendJson(res, 200, { connection: connectionWire(bound.row) })
  } catch (err) {
    ctx.log.warn('connector_bind_failed', {
      sub: user.id,
      provider: providerId,
      code: err instanceof ConnectorError ? err.code : 'INTERNAL',
    })
    throw toHttpError(err, 'bind')
  }
}

async function bindFormProvider(
  provider: Exclude<DbConnectorProvider, 'feishu'>,
  userId: number,
  fields: Record<string, unknown>,
  displayName: string | undefined,
  pool: Pool,
): Promise<{ id: string; rebound: boolean; row: ConnectionRow }> {
  let payload: ConnectorSecret
  let identity: string
  let accountHint: string
  const meta: Record<string, unknown> = {}

  if (provider === 'webdav') {
    const serverUrl = requireStringField(fields, 'serverUrl', 1024)
    const username = requireStringField(fields, 'username', 256)
    const password = requireStringField(fields, 'password', 512)
    const base = validateWebdavBaseUrl(serverUrl) // 形状校验(https/无 userinfo/非 IP…)
    const normalizedUrl = `${base.origin}${base.basePath}`
    identity = canonicalAccountIdentity('webdav', { origin: base.origin, username })
    payload = {
      schema_version: 1,
      account_identity: identity,
      account_identity_version: 1,
      serverUrl: normalizedUrl,
      username,
      password,
    }
    accountHint = `${username}@${base.hostname}`
    await verifyWebdavCredentials(payload)
  } else if (provider === 'imap') {
    const email = requireStringField(fields, 'email', 254).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ConnectorError('VALIDATION_FAILED', 'email shape invalid')
    }
    const password = requireStringField(fields, 'password', 512)
    const preset = presetImapConfig(email)
    const imapHost =
      typeof fields.imapHost === 'string' && fields.imapHost.trim()
        ? fields.imapHost.trim()
        : preset?.imapHost
    const smtpHost =
      typeof fields.smtpHost === 'string' && fields.smtpHost.trim()
        ? fields.smtpHost.trim()
        : preset?.smtpHost
    const smtpPortRaw =
      typeof fields.smtpPort === 'string' && fields.smtpPort.trim()
        ? Number(fields.smtpPort.trim())
        : (preset?.smtpPort ?? 465)
    if (!imapHost || !smtpHost) {
      throw new ConnectorError('VALIDATION_FAILED', 'imapHost/smtpHost required for this domain')
    }
    if (smtpPortRaw !== 465 && smtpPortRaw !== 587) {
      throw new ConnectorError('OUTBOUND_BLOCKED', 'smtp port must be 465/587')
    }
    identity = canonicalAccountIdentity('imap', { email })
    payload = {
      schema_version: 1,
      account_identity: identity,
      account_identity_version: 1,
      email,
      password,
      imapHost,
      imapPort: 993,
      smtpHost,
      smtpPort: smtpPortRaw,
    }
    accountHint = email
    await verifyImapCredentials(payload)
  } else {
    // notion
    const token = requireStringField(fields, 'token', 512)
    const who = await verifyNotionToken(token)
    identity = canonicalAccountIdentity('notion', { botId: who.botId })
    payload = {
      schema_version: 1,
      account_identity: identity,
      account_identity_version: 1,
      token,
    }
    accountHint = who.workspaceName ?? 'Notion'
  }

  meta.account_hint = accountHint
  const accountKey = computeAccountKey(identity)
  const { connection, rebound } = await upsertConnection(
    { userId, provider, displayName, accountKey, payload, meta },
    pool,
  )
  return { id: connection.id, rebound, row: connection }
}

// ─── POST /api/connectors/:provider/oauth/start(BYOA feishu) ─────────────
//
// 声明式 oauth2 连接器的起点在 declarativeHandlers(POST declarative/oauth/start);
// redirect_uri 的读取权威已上移 oauthPending.readConnectorsOauthRedirectUri(两条起点 + 唯一回调共用)。

async function handleOauthStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  providerId: string,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  if (providerId !== 'feishu') {
    throw new HttpError(400, 'UNSUPPORTED_PROVIDER', 'only feishu supports BYOA oauth')
  }
  const body = await readJsonBody(req)
  const clientId = requireStringField(body, 'clientId', 256)
  const clientSecret = requireStringField(body, 'clientSecret', 512)
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : undefined

  try {
    const redirectUri = readConnectorsOauthRedirectUri()
    const pkceVerifier = generatePkceVerifier()
    const started = await startOauthPending({
      userId,
      provider: 'feishu',
      draft: { clientId, clientSecret, pkceVerifier, ...(displayName ? { displayName } : {}) },
    })
    setConnectorOauthCookie(res, 'feishu', started.cookieNonce, {
      secure: deps.refreshCookieSecure,
    })
    const authorizeUrl = await buildFeishuAuthorizeUrl({
      clientId,
      redirectUri,
      state: started.state,
      pkceVerifier,
    })
    sendJson(res, 200, { authorizeUrl })
  } catch (err) {
    throw toHttpError(err, 'oauth')
  }
}

// ─── GET /api/connectors/oauth/callback ──────────────────────────────────

async function handleOauthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const providerError = url.searchParams.get('error')
  const pool = getPool()

  if (!state) {
    sendRedirect(res, connectorErrorRedirect('STATE_MISMATCH'))
    return
  }
  // state→查行→行.provider→读对应 cookie(§2 callback 顺序)
  const { createHash } = await import('node:crypto')
  const stateHash = createHash('sha256').update(state, 'utf8').digest()
  const probe = await pool.query<{ provider: string }>(
    'SELECT provider FROM connector_oauth_pending WHERE state_hash = $1 LIMIT 1',
    [stateHash],
  )
  const provider = probe.rows[0]?.provider
  if (!provider) {
    ctx.log.warn('connector_oauth_state_unknown', {})
    sendRedirect(res, connectorErrorRedirect('STATE_MISMATCH'))
    return
  }
  const cookieNonce = readConnectorOauthCookie(req, provider)
  if (!cookieNonce) {
    ctx.log.warn('connector_oauth_cookie_missing', { provider })
    sendRedirect(res, connectorErrorRedirect('STATE_MISMATCH'))
    return
  }
  // cookie 一次性:进入消费流程即清
  clearConnectorOauthCookie(res, provider, { secure: deps.refreshCookieSecure })

  let consumed: Awaited<ReturnType<typeof consumeOauthPending>>
  try {
    consumed = await consumeOauthPending({ state, cookieNonce }, pool)
  } catch (err) {
    ctx.log.warn('connector_oauth_consume_failed', {
      provider,
      code: err instanceof ConnectorError ? err.code : 'INTERNAL',
    })
    sendRedirect(res, connectorErrorRedirect('STATE_MISMATCH'))
    return
  }

  // 用户在授权页点了拒绝(?error=...):pending 已消费(一次性),回错误 toast
  if (providerError || !code) {
    ctx.log.info('connector_oauth_provider_error', { provider, hasCode: !!code })
    sendRedirect(res, connectorErrorRedirect('TOKEN_EXCHANGE_FAILED'))
    return
  }

  // ── 分流:draft 带 connectorVersionId → 声明式连接器(引擎路径);否则 v1 feishu(下方原逻辑)。
  //    上面的 state→provider→cookie→四因子消费是**两条路径共用的单一权威**,故绝不另开回调路由。
  if (consumed.draft.connectorVersionId !== undefined) {
    await completeDeclarativeOauth(res, ctx, {
      provider,
      versionId: consumed.draft.connectorVersionId,
      userId: consumed.userId,
      draft: consumed.draft,
      code,
      pool,
      deps,
    })
    return
  }

  try {
    const redirectUri = readConnectorsOauthRedirectUri()
    const tokens = await exchangeFeishuCode({
      clientId: consumed.draft.clientId,
      clientSecret: consumed.draft.clientSecret,
      code,
      redirectUri,
      pkceVerifier: consumed.draft.pkceVerifier,
    })
    // P2#12:校验飞书回报的 granted scopes 覆盖 v1 必需集;缺失则 fail-closed 拒绝绑定
    // (缺权限仍绑定 → 运行时 action 报不透明错;不如绑定期挡下并明确告知)。
    const scopeCheck = checkFeishuScopes(tokens.grantedScopes)
    if (scopeCheck.missing.length > 0) {
      ctx.log.warn('connector_feishu_scope_insufficient', {
        provider,
        missingCount: scopeCheck.missing.length,
      })
      throw new ConnectorError('SCOPE_INSUFFICIENT', 'feishu granted scopes missing required set')
    }

    const who = await fetchFeishuUserInfo(tokens.accessToken)
    const identity = canonicalAccountIdentity('feishu', { unionId: who.unionId })
    const accountKey = computeAccountKey(identity)
    const { connection } = await upsertConnection(
      {
        userId: consumed.userId,
        provider: 'feishu',
        displayName: consumed.draft.displayName,
        accountKey,
        payload: {
          schema_version: 1,
          account_identity: identity,
          account_identity_version: 1,
          clientId: consumed.draft.clientId,
          clientSecret: consumed.draft.clientSecret,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        },
        meta: {
          account_hint: who.name || '飞书',
          tokenExpiresAt: tokens.expiresAt,
          // granted scopes 存 meta(§2)。P2#12 fail-closed 后:能走到这里必已过
          // missing 校验(缺任一必需 scope、含空 granted 全部,都已在上面 SCOPE_INSUFFICIENT
          // 拒绝),故此处 scopesVerified 恒 true;保留字段供审计与将来降级 capability 用。
          grantedScopes: scopeCheck.granted.join(' '),
          scopesVerified: scopeCheck.verified,
        },
      },
      pool,
    )
    ctx.log.info('connector_oauth_linked', {
      sub: String(consumed.userId),
      provider,
      connectionId: connection.id,
    })
    sendRedirect(res, `/?connector_linked=${encodeURIComponent(provider)}`)
  } catch (err) {
    const codeOut =
      err instanceof ConnectorError ? wireErrorCode(err.code, 'oauth') : 'TOKEN_EXCHANGE_FAILED'
    ctx.log.warn('connector_oauth_exchange_failed', {
      provider,
      code: err instanceof ConnectorError ? err.code : 'INTERNAL',
    })
    sendRedirect(res, connectorErrorRedirect(codeOut))
  }
}

// ─── 声明式 oauth2 回调分支(共用上面那条回调路由的四因子消费结果) ─────────────

interface DeclarativeOauthInput {
  /** pending 行里的 provider(= listing slug,DB 事实)。 */
  provider: string
  versionId: number
  userId: number
  draft: OauthDraft
  /** 授权回跳带回的一次性 authorization code。 */
  code: string
  pool: Pool
  deps: CommercialHttpDeps
}

/**
 * 声明式 oauth2-auth-code 收尾:载入即验签 → code 换 token(发 sole token origin)→ 组落库袋 →
 * bindWithBag(identity 探针 + 加密落 pin 连接)→ 302。
 *
 * 凭据流向(全链不落日志、不回显、不进 URL):
 *   - `code` / `client_secret` / `pkceVerifier`:**只**进 exchangeAuthCode 发往 token origin 的
 *     form body / basic-auth 头(受众隔离由 contract.credentialAudiencePolicy 在引擎里硬校验);
 *   - 换回的 access_token(+ refresh_token,若上游给)与 client_id/client_secret 一起进**加密**凭据袋
 *     落库(AEAD,AAD 绑 user+slug);
 *   - 任何失败只回**稳定错误码**,绝不回显凭据或上游原文(exchangeAuthCode 内已做脱敏出口)。
 */
async function completeDeclarativeOauth(
  res: ServerResponse,
  ctx: RequestContext,
  input: DeclarativeOauthInput,
): Promise<void> {
  const { provider, draft, pool } = input
  try {
    const redirectUri = readConnectorsOauthRedirectUri()
    // 载入即验签(4 闸 fail-closed:kind/审核态/未 revoke/hash+签名+policy)。
    const meta = await loadVerifiedContractWithMeta(input.versionId, pool)
    if (meta.contract.authMode !== 'oauth2-auth-code')
      throw new ConnectorError('BAD_REQUEST', 'pinned connector is not oauth2-auth-code')
    // pending 行的 provider 必须 == 契约 slug(两者都是 DB 事实;不等 = 数据错配,fail-closed)。
    if (meta.slug !== provider)
      throw new ConnectorError('BAD_REQUEST', 'pending provider does not match contract slug')

    const tokens = await exchangeAuthCode({
      contract: meta.contract,
      code: input.code,
      clientId: draft.clientId,
      clientSecret: draft.clientSecret,
      redirectUri,
      pkceVerifier: draft.pkceVerifier,
      ...(input.deps.connectorEngineDeps ? { deps: input.deps.connectorEngineDeps } : {}),
    })

    // 落库袋 = storedBagSources('oauth2-auth-code'):access_token + client_id + client_secret
    // (+ refresh_token 若上游下发)。client_secret 留袋供日后 refresh 轮换,但**永不**进
    // ResolvedCredentials(placement 层结构上拿不到它)。
    const bag: DeclarativeSecretBag = {
      access_token: tokens.accessToken,
      client_id: draft.clientId,
      client_secret: draft.clientSecret,
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    }
    const bound = await bindWithBag(
      {
        userId: input.userId,
        meta,
        bag,
        displayName: draft.displayName,
        ...(input.deps.connectorEngineDeps ? { deps: input.deps.connectorEngineDeps } : {}),
      },
      pool,
    )
    ctx.log.info('connector_declarative_oauth_linked', {
      sub: String(input.userId),
      provider,
      versionId: input.versionId,
      connectionId: bound.connectionId,
      rebound: bound.rebound,
    })
    sendRedirect(res, `/?connector_linked=${encodeURIComponent(provider)}`)
  } catch (err) {
    // 稳定码,不泄上游/内部细节:ConnectorError → wire 映射;契约层错误(被 revoke/验签失败等)
    // → 统一 CONNECTOR_UNAVAILABLE(不把审核状态机的内部态透给浏览器);其余 → TOKEN_EXCHANGE_FAILED。
    const codeOut =
      err instanceof ConnectorError
        ? wireErrorCode(err.code, 'oauth')
        : err instanceof ConnectorSpecError
          ? 'CONNECTOR_UNAVAILABLE'
          : 'TOKEN_EXCHANGE_FAILED'
    ctx.log.warn('connector_declarative_oauth_failed', {
      provider,
      versionId: input.versionId,
      code:
        err instanceof ConnectorError || err instanceof ConnectorSpecError ? err.code : 'INTERNAL',
    })
    sendRedirect(res, connectorErrorRedirect(codeOut))
  }
}

// ─── confirmations ───────────────────────────────────────────────────────

async function handleConfirmationDetail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  id: string,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const pool = getPool()
  const row = await getLedgerRow(id, userId, pool)
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'no such confirmation')

  // detail=解密 params 的结构化完整详情(§3②);终态 params 已销毁 → null
  let detail: unknown = null
  if (row.params_enc && row.params_nonce) {
    try {
      const params = decryptLedgerParams(row)
      detail = buildWriteDetail(row.provider, row.action, params)
    } catch {
      detail = null // 完整性异常不阻断状态查询;approve 会硬失败
    }
  }
  sendJson(res, 200, {
    id: row.id,
    provider: row.provider,
    action: row.action,
    summary: row.summary,
    detail,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
  })
}

async function handleConfirmationDecision(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  id: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const pool = getPool()
  try {
    const out =
      decision === 'approve'
        ? await approveConfirmation(id, userId, pool)
        : await denyConfirmation(id, userId, pool)
    sendJson(res, 200, { ok: true, status: out.status })
  } catch (err) {
    throw toHttpError(err, 'generic')
  }
}

// ─── PATCH / DELETE /api/connectors/:id ──────────────────────────────────

async function handleRename(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  id: string,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  if (id === 'github') {
    throw new HttpError(400, 'BAD_REQUEST', 'github connection is managed via GitHub binding')
  }
  const body = await readJsonBody(req)
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  if (displayName.length === 0 || displayName.length > 64) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'displayName must be 1..64 chars')
  }
  const ok = await renameConnection(id, userId, displayName, getPool())
  if (!ok) throw new HttpError(404, 'NOT_FOUND', 'no such connection')
  sendJson(res, 200, { ok: true })
}

/** Redis 解绑互斥 key(rpc call 路径同查,阻新调用 —— §8 ①)。 */
export function revokeMutexKey(connectionId: string): string {
  return `connectors:revoke:${connectionId}`
}

async function handleUnbind(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  id: string,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const pool = getPool()

  if (id === 'github') {
    // §4:github 解绑复用既有 revoke/清 session 语义
    const r = await revokeGithubLinkAndClearSessions(pool, userId, 'user_revoked')
    ctx.log.info('connector_github_revoked', { sub: user.id, sessionsCleared: r.sessionsCleared })
    sendJson(res, 200, { ok: true })
    return
  }

  // 解绑 saga(§8):① Redis 互斥阻新调用(best-effort;真 fail-closed 在 DB 行状态)
  const redis = deps.redis as unknown as {
    eval?: (script: string, n: number, ...args: Array<string | number>) => Promise<unknown>
  }
  if (redis && typeof redis.eval === 'function') {
    await redis
      .eval(`redis.call('SET', KEYS[1], '1', 'PX', 60000) return 1`, 1, revokeMutexKey(id))
      .catch(() => {})
  }

  // ② 【已知偏离,P1#8】设计 §8 ② 为"解密暂存 revoke 所需 Buffer";但 v1 唯一有 OAuth
  //    凭据的 provider 是**飞书 BYOA**,其 user_access_token **无公开 revoke/logout 端点**
  //    (设计债表已登记:"feishu upstream token revoke 无公开 BYOA 端点")。故本地 tombstone
  //    即为终态,**不解密**(拒绝"解密后只拿来算个布尔值"的无意义明文触碰)。若未来飞书
  //    ISV/端点可用,再在此解密 + 事务外 best-effort 调 revoke。
  const existing = await getConnectionAnyStatus(id, userId, pool)
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'no such connection')

  // ③ 短事务:secret 置 NULL + revoked_at(事务内禁网络 I/O)
  const revoked = await revokeConnection(id, userId, pool)
  if (!revoked) throw new HttpError(404, 'NOT_FOUND', 'no such connection')

  // ④ 事务外 best-effort provider revoke:v1 无 provider 有公开 user token revoke 端点
  //    (飞书亦无)→ 本地销毁即终态,仅如实记录 outcome。
  ctx.log.info('connector_unbound', {
    sub: user.id,
    provider: existing.provider,
    connectionId: id,
    upstreamRevoke: existing.provider === 'feishu' ? 'unsupported_no_endpoint' : 'not_applicable',
  })
  sendJson(res, 200, { ok: true })
}
