/**
 * 声明式连接器 · 前端 REST 子路由(挂在 dispatchConnectorsRoute 的 `declarative` 段下)。
 *
 * 面向浏览器/管理界面:catalog(可绑连接器目录)/ bind(绑定,含 identityProbe)/ connections(已绑列表)/
 * unbind(解绑)。**执行(read/write)不在这里**——那是 agent 经容器 RPC(rpc.ts)走的面。
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
import { clearTokenCache } from './engine/tokenEngine.js'
import { ConnectorError } from './errors.js'
import { ConnectorSpecError } from './spec/types.js'

/** ConnectorError/ConnectorSpecError → HttpError(稳定 code,不泄 message)。 */
function toHttp(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof ConnectorError) return new HttpError(err.httpStatus, err.code, err.code)
  if (err instanceof ConnectorSpecError) return new HttpError(400, err.code, err.code)
  return new HttpError(500, 'INTERNAL', 'INTERNAL')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** GET declarative/catalog —— 已审可绑连接器目录(含 authMode / 需填 source / 动作)。 */
async function handleCatalog(res: ServerResponse, pool: Pool): Promise<void> {
  // 目录查询/投影单一权威(与 agent RPC catalog 共用 listDeclarativeCatalog)。
  const catalog = await listDeclarativeCatalog(pool)
  sendJson(res, 200, { connectors: catalog })
}

/** POST declarative/bind —— 绑定(body: {versionId, secrets, displayName?})。 */
async function handleBind(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  pool: Pool,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = Number(user.id)
  const body = asRecord(await readJsonBody(req))
  const versionId = Number(body.versionId)
  if (!Number.isInteger(versionId) || versionId <= 0)
    throw new HttpError(400, 'BAD_REQUEST', 'versionId required')
  const secretsRaw = asRecord(body.secrets)
  const secrets: Record<string, string> = {}
  for (const [k, v] of Object.entries(secretsRaw)) if (typeof v === 'string') secrets[k] = v
  const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : undefined

  const result = await bindDeclarativeConnector(
    { userId, connectorVersionId: versionId, secrets, displayName },
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
      await handleCatalog(res, pool)
      return
    }
    if (subSegs.length === 1 && subSegs[0] === 'bind' && method === 'POST') {
      await handleBind(req, res, deps, pool)
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
