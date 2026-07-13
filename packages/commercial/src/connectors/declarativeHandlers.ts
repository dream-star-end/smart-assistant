/**
 * 声明式连接器 · 前端 REST 子路由(挂在 dispatchConnectorsRoute 的 `declarative` 段下)。
 *
 * 面向浏览器/管理界面:catalog(可绑连接器目录)/ bind(直填绑定,含 identityProbe)/
 * oauth/start(oauth2-auth-code 授权流起点)/ connections(已绑列表)/ unbind(解绑)。
 * **执行(read/write)不在这里**——那是 agent 经容器 RPC(rpc.ts)走的面。
 *
 * OAuth **回调**也不在这里:它与 v1 feishu **共用** `GET /api/connectors/oauth/callback`
 * (handlers.ts)—— state→provider→cookie→四因子消费这段加固逻辑是单一权威,绝不开第二条回调路由。
 * 本模块只负责起点:落 pending(draft 里带 connectorVersionId 作声明式标记)+ 组 authorize URL。
 *
 * 每个子 handler 复刻仓内 http 约定:requireAuth(拿 userId)→ readJsonBody → 调引擎 → sendJson;
 * ConnectorError → HttpError(稳定 code + httpStatus,不泄内部 message)。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { getPool } from '../db/index.js'
import { requireAuth } from '../http/auth.js'
import type { CommercialHttpDeps } from '../http/handlers.js'
import { HttpError, readJsonBody, sendJson } from '../http/util.js'
import { bindDeclarativeConnector } from './engine/bind.js'
import {
  getDeclarativeConnection,
  listDeclarativeConnections,
  revokeDeclarativeConnection,
} from './engine/binding.js'
import { listDeclarativeCatalog } from './engine/catalog.js'
import { oauth2ClientProvisioning } from './engine/credentialBag.js'
import { buildAuthorizeUrl } from './engine/oauth2.js'
import { clearTokenCache } from './engine/tokenEngine.js'
import { ConnectorError } from './errors.js'
import {
  readConnectorsOauthRedirectUri,
  setConnectorOauthCookie,
  startOauthPending,
} from './oauthPending.js'
import { generatePkceVerifier, pkceChallengeS256 } from './pkce.js'
import { getPlatformOauthAppClientId } from './platformOauthApps.js'
import { loadVerifiedContractWithMeta } from './spec/review.js'
import { ConnectorSpecError } from './spec/types.js'

/** ConnectorError/ConnectorSpecError → HttpError(稳定 code,不泄 message)。 */
function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof ConnectorError) return new HttpError(err.httpStatus, err.code, err.code)
  if (err instanceof ConnectorSpecError) return new HttpError(400, err.code, err.code)
  return new HttpError(500, 'INTERNAL', 'INTERNAL')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** body 里的必填有界字符串(缺/空/超长 → BAD_REQUEST;值绝不进 message)。 */
function requireBoundedString(body: Record<string, unknown>, key: string, maxLen: number): string {
  const v = body[key]
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > maxLen)
    throw new HttpError(400, 'BAD_REQUEST', `field ${key} required`)
  return v.trim()
}

/** body 里的正整数 versionId。 */
function requireVersionId(body: Record<string, unknown>): number {
  const versionId = Number(body.versionId)
  if (!Number.isInteger(versionId) || versionId <= 0)
    throw new HttpError(400, 'BAD_REQUEST', 'versionId required')
  return versionId
}

/** GET declarative/catalog —— 已审可绑连接器目录(含 authMode / 需填 source / 动作)。 */
async function handleCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  pool: Pool,
): Promise<void> {
  await requireAuth(req, deps.jwtSecret)
  // 目录查询/投影单一权威(与 agent RPC catalog 共用 listDeclarativeCatalog)。
  const catalog = await listDeclarativeCatalog(pool)
  sendJson(res, 200, { connectors: catalog })
}

/**
 * POST declarative/bind —— 直填绑定(body: {versionId, secrets, displayName?})。
 * oauth2-auth-code 契约在引擎层被硬拒(必须走 oauth/start),这里不需要重复判断。
 */
async function handleBind(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  pool: Pool,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const body = asRecord(await readJsonBody(req))
  const versionId = requireVersionId(body)
  const secretsRaw = asRecord(body.secrets)
  const secrets: Record<string, string> = {}
  for (const [k, v] of Object.entries(secretsRaw)) if (typeof v === 'string') secrets[k] = v
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : undefined

  const result = await bindDeclarativeConnector(
    {
      userId,
      connectorVersionId: versionId,
      secrets,
      displayName,
      ...(deps.connectorEngineDeps ? { deps: deps.connectorEngineDeps } : {}),
    },
    pool,
  )
  sendJson(res, 200, {
    connection: {
      id: result.connectionId,
      rebound: result.rebound,
      accountHint: result.accountHint,
    },
  })
}

/**
 * POST declarative/oauth/start —— oauth2-auth-code 授权流起点
 * (body: {versionId, displayName?} + **byoa 模式**额外要 {clientId, clientSecret})。
 *
 * **两种 client 供给模式**(权威 = 已验签契约的 oauth2.clientProvisioning,**不看请求**):
 *   - `byoa`     用户自带 OAuth App:body 必带 clientId/clientSecret → 进加密 pending draft。
 *   - `platform` 平台注册 OAuth App:**完全不读 body 的 clientId/clientSecret**(带了也忽略,
 *     杜绝"用户伪造 client_id 冒充平台应用"),client_id 取自平台表;未 provision →
 *     503 OAUTH_NOT_CONFIGURED(fail-closed)。draft 里**不含**任何 client 凭据。
 *
 * 凭据流向(切片 B 安全核心):
 *   - clientSecret:byoa → **只**进 AEAD 加密的 pending draft;platform → **start 阶段根本不出现**
 *     (start 只需公开的 client_id,故用 getPlatformOauthAppClientId,不解密 secret)。
 *     两种模式下 clientSecret **绝不**进 authorize URL(buildAuthorizeUrl 结构上就不收它);
 *   - pkceVerifier 服务端生成 → 只进 draft;进 URL 的是它的 S256 单向派生 challenge;
 *   - state / cookieNonce 原值只出现在 authorize URL / Set-Cookie,DB 只存 sha256。
 * 回调时四因子(state_hash + cookie_nonce + 未消费 + 未过期)全中才解出 draft。
 */
async function handleOauthStart(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  pool: Pool,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const body = asRecord(await readJsonBody(req))
  const versionId = requireVersionId(body)
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : undefined

  // 载入即验签(4 闸 fail-closed);slug/versionId/provisioning 全取 DB 事实,不信任调用方。
  const meta = await loadVerifiedContractWithMeta(versionId, pool)
  if (meta.contract.authMode !== 'oauth2-auth-code')
    throw new HttpError(400, 'BAD_REQUEST', 'connector does not use oauth2 authorization code flow')
  const provisioning = oauth2ClientProvisioning(meta.contract)

  // authorize URL 用的 client_id + (byoa 才有的)进 draft 的 client 凭据。
  let clientId: string
  let draftClientCreds: { clientId: string; clientSecret: string } | undefined
  if (provisioning === 'platform') {
    // 一键授权:用户什么都不填。**未 provision = 平台没授权这个连接器用平台身份** → fail-closed。
    const platformClientId = await getPlatformOauthAppClientId(meta.slug, pool)
    if (platformClientId === null)
      throw new HttpError(503, 'OAUTH_NOT_CONFIGURED', 'OAUTH_NOT_CONFIGURED')
    clientId = platformClientId
  } else {
    const byoaClientId = requireBoundedString(body, 'clientId', 256)
    const byoaClientSecret = requireBoundedString(body, 'clientSecret', 512)
    clientId = byoaClientId
    draftClientCreds = { clientId: byoaClientId, clientSecret: byoaClientSecret }
  }

  const redirectUri = readConnectorsOauthRedirectUri()
  const pkceVerifier = generatePkceVerifier()
  const pkceChallenge = await pkceChallengeS256(pkceVerifier)

  const started = await startOauthPending(
    {
      userId,
      provider: meta.slug,
      draft: {
        // platform 模式:draft 里**没有** client 凭据(回调时从平台表现取)。
        ...(draftClientCreds ?? {}),
        pkceVerifier,
        connectorVersionId: meta.versionId,
        ...(displayName ? { displayName } : {}),
      },
      pins: {
        connectorVersionId: meta.versionId,
        specHashHex: meta.contract.spec_hash,
        execContractHashHex: meta.execContractHash,
        authContractVersion: meta.authContractVersion,
      },
    },
    pool,
  )
  // authorize URL 先组(纯函数,可能因契约端点/受众问题抛错)—— 成功后才发 cookie,
  // 避免"给了 cookie 却没给跳转地址"的半吊子响应。
  const authorizeUrl = buildAuthorizeUrl(meta.contract, {
    clientId,
    redirectUri,
    state: started.state,
    pkceChallenge,
  })
  setConnectorOauthCookie(res, meta.slug, started.cookieNonce, { secure: deps.refreshCookieSecure })
  sendJson(res, 200, { authorizeUrl })
}

/** GET declarative/connections —— 已绑声明式连接列表。 */
async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  pool: Pool,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const rows = await listDeclarativeConnections(Number(user.id), pool)
  sendJson(res, 200, {
    connections: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      displayName: r.displayName,
      accountHint: typeof r.meta.account_hint === 'string' ? r.meta.account_hint : undefined,
      createdAt: r.createdAt.toISOString(),
    })),
  })
}

/** DELETE declarative/connections/:id —— 解绑(撤销连接 + 清 token 缓存)。 */
async function handleUnbind(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  pool: Pool,
  id: string,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  if (!/^\d+$/.test(id)) throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'CONNECTION_NOT_FOUND')
  // 确认归属(存在且属于本人)。
  const row = await getDeclarativeConnection(id, userId, pool)
  const ok = await revokeDeclarativeConnection(id, userId, pool)
  if (!ok && row === null) throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'CONNECTION_NOT_FOUND')
  await clearTokenCache(id, pool)
  sendJson(res, 200, { ok: true })
}

/**
 * 声明式子路由分发。segs = `/api/connectors/declarative/` 之后的段。
 * 由 dispatchConnectorsRoute 在 segs[0]==='declarative' 时调用(传入 segs.slice(1))。
 */
export async function dispatchDeclarativeConnectors(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  subSegs: string[],
  method: string,
): Promise<void> {
  const pool = getPool()
  try {
    if (subSegs.length === 1 && subSegs[0] === 'catalog' && method === 'GET') {
      await handleCatalog(req, res, deps, pool)
      return
    }
    if (subSegs.length === 1 && subSegs[0] === 'bind' && method === 'POST') {
      await handleBind(req, res, deps, pool)
      return
    }
    if (
      subSegs.length === 2 &&
      subSegs[0] === 'oauth' &&
      subSegs[1] === 'start' &&
      method === 'POST'
    ) {
      await handleOauthStart(req, res, deps, pool)
      return
    }
    if (subSegs.length === 1 && subSegs[0] === 'connections' && method === 'GET') {
      await handleList(req, res, deps, pool)
      return
    }
    if (subSegs.length === 2 && subSegs[0] === 'connections' && method === 'DELETE') {
      await handleUnbind(req, res, deps, pool, subSegs[1]!)
      return
    }
    throw new HttpError(404, 'NOT_FOUND', 'unknown declarative connector route')
  } catch (err) {
    throw toHttp(err)
  }
}
