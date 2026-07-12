/**
 * /api/admin/connectors/platform-oauth-apps —— 平台自有 OAuth App provisioning(超管)。
 *
 * 端点:
 *   GET    /api/admin/connectors/platform-oauth-apps        列表(**永不回 client_secret**)
 *   PUT    /api/admin/connectors/platform-oauth-apps/:slug  provision / 轮换 {clientId, clientSecret}
 *   DELETE /api/admin/connectors/platform-oauth-apps/:slug  反 provision
 *
 * 这套 API 是 `clientProvisioning='platform'` 连接器的**唯一信任闸**:
 *   - 有这一行 → 该连接器出现在用户目录里、可一键授权;
 *   - 没有 → oauth/start 503 OAUTH_NOT_CONFIGURED,且 catalog 里根本不展示(fail-closed)。
 * 连接器作者在 spec 里写 'platform' 只是"提出诉求",给不给平台身份 100% 由 admin 在这里决定。
 *
 * 鉴权:GET requireAdmin;PUT/DELETE requireAdminVerifyDb(破坏性写 → DB 二次复核 role/status,
 * 与 literature/modelOps 同款分层)。注:router.ts 对 /api/admin/* 还有一道全局 gate,这里是第二道。
 *
 * 审计:两个写操作都是 mode='tx' 的 fail-closed 审计(auditActions.ts 已登记)——
 * 业务写与 admin_audit 写在**同一事务**里,审计写不下就整个回滚(平台级密钥写入不许无痕)。
 * before/after 里**只放 clientId**(公开标识)与 slug,**永不放 clientSecret**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PoolClient } from 'pg'
import { writeAdminAudit } from '../../admin/audit.js'
import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import { ConnectorError } from '../../connectors/errors.js'
import {
  deletePlatformOauthApp,
  getPlatformOauthAppClientId,
  listPlatformOauthApps,
  upsertPlatformOauthApp,
} from '../../connectors/platformOauthApps.js'
import { tx } from '../../db/queries.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

const PREFIX = '/api/admin/connectors/platform-oauth-apps'
/** = spec/types.ts Slug = 0136 表的 CHECK(三处同源)。 */
const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/
const MAX_CLIENT_ID_LEN = 256
const MAX_CLIENT_SECRET_LEN = 1024

/** 从 `/api/admin/connectors/platform-oauth-apps/:slug` 抽 slug(形状不合法 → 400,绝不进 SQL)。 */
function extractSlug(url: URL): string {
  const tail = decodeURIComponent(url.pathname.slice(`${PREFIX}/`.length))
  if (!SLUG_RE.test(tail)) {
    throw new HttpError(400, 'VALIDATION', 'invalid connector slug in URL', {
      issues: [{ path: 'slug', message: tail.slice(0, 64) }],
    })
  }
  return tail
}

/** body 里的必填有界凭据字符串。**值绝不进 message/issues**(那会把 secret 写进错误响应)。 */
function requireCredential(body: Record<string, unknown>, key: string, maxLen: number): string {
  const v = body[key]
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen) {
    throw new HttpError(400, 'VALIDATION', `${key} must be a non-empty string (<= ${maxLen})`, {
      issues: [{ path: key, message: 'invalid' }],
    })
  }
  return v
}

/** ConnectorError(slug/凭据形状)→ 400;其余原样上抛。 */
function toHttp(err: unknown): never {
  if (err instanceof ConnectorError) throw new HttpError(err.httpStatus, 'VALIDATION', err.code)
  throw err
}

// ─── GET /api/admin/connectors/platform-oauth-apps ─────────────────────

export async function handleAdminListPlatformOauthApps(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
  const apps = await listPlatformOauthApps()
  // 投影里结构上没有 secret(listPlatformOauthApps 的 SQL 都不 SELECT 那一列)。
  sendJson(res, 200, {
    apps: apps.map((a) => ({
      slug: a.slug,
      clientId: a.clientId,
      updatedAt: a.updatedAt.toISOString(),
    })),
  })
}

// ─── PUT /api/admin/connectors/platform-oauth-apps/:slug ───────────────

export async function handleAdminPutPlatformOauthApp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const slug = extractSlug(url)

  const body = (await readJsonBody(req)) ?? {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION', 'request body must be JSON object')
  }
  const b = body as Record<string, unknown>
  const clientId = requireCredential(b, 'clientId', MAX_CLIENT_ID_LEN)
  const clientSecret = requireCredential(b, 'clientSecret', MAX_CLIENT_SECRET_LEN)

  // 事务:凭据写入 + 审计同生共死(mode='tx' fail-closed)。
  try {
    await tx(async (client: PoolClient) => {
      // before 只记公开的 clientId(有没有旧行 = 首次 provision 还是轮换)。
      const beforeClientId = await getPlatformOauthAppClientId(slug, client)
      await upsertPlatformOauthApp({ slug, clientId, clientSecret, updatedBy: admin.id }, client)
      await writeAdminAudit(client, {
        adminId: admin.id,
        action: 'connector_platform_oauth.put',
        target: `connector_platform_oauth:${slug}`,
        // **只记 clientId**(公开标识)。client_secret 永不进审计表 —— 审计是给人看的,
        // 平台密钥落进 admin_audit 等于给它开第二个泄露面。轮换与否看 secret_rotated。
        before: beforeClientId === null ? null : { clientId: beforeClientId },
        after: { clientId, secretRotated: true },
        ip: ctx.clientIp,
        userAgent: ctx.userAgent,
      })
    })
  } catch (err) {
    toHttp(err)
  }
  sendJson(res, 200, { ok: true, app: { slug, clientId } })
}

// ─── DELETE /api/admin/connectors/platform-oauth-apps/:slug ────────────

export async function handleAdminDeletePlatformOauthApp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const slug = extractSlug(url)

  let deleted = false
  try {
    await tx(async (client: PoolClient) => {
      const beforeClientId = await getPlatformOauthAppClientId(slug, client)
      deleted = await deletePlatformOauthApp(slug, client)
      if (!deleted) return // 不存在 → 不写审计(没发生任何变更),下面回 404。
      await writeAdminAudit(client, {
        adminId: admin.id,
        action: 'connector_platform_oauth.delete',
        target: `connector_platform_oauth:${slug}`,
        before: beforeClientId === null ? null : { clientId: beforeClientId },
        after: null,
        ip: ctx.clientIp,
        userAgent: ctx.userAgent,
      })
    })
  } catch (err) {
    toHttp(err)
  }
  if (!deleted) throw new HttpError(404, 'NOT_FOUND', 'platform oauth app not found')
  sendJson(res, 200, { ok: true })
}
