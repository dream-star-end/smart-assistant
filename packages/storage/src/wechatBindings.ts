// wechat_bindings CRUD — per-OC-user WeChat iLink bot bindings.
//
// Multi-tenant: every OpenClaude user can independently scan a QR and bind
// their own WeChat bot. The gateway's WechatManager reads active rows here at
// startup and spawns one long-poll worker per binding.
//
// Table is declared in sessionsDb.ts (see CREATE TABLE wechat_bindings).

// getActiveBackend:master 会话权威 backend 注入口(RFC D1)。wechat_bindings 是 master 六表
// 之一,其读写同样经 active backend(master 形态=PG,容器/个人版=SQLite)。下面 _sqlite* 是
// SQLite 实现(被 sessionsDb 的 sqliteBackend 组合),公有函数是薄委托。
// 与 sessionsDb 构成运行时环:此处两向引用(_sqlite* 被 sessionsDb 组合、公有函数调
// getActiveBackend)都在函数体/被组合的 function 声明层面 —— 函数声明实例化即就绪,环安全。
import { getActiveBackend, getSessionsDb } from './sessionsDb.js'

export interface WechatBinding {
  userId: string
  accountId: string
  loginUserId: string
  botToken: string
  getUpdatesBuf: string
  contextTokens: Record<string, string>
  whitelist: string[]
  status: 'active' | 'disabled' | 'expired'
  createdAt: number
  updatedAt: number
  lastEventAt: number | null
}

export class WechatAccountAlreadyBoundError extends Error {
  constructor(accountId: string) {
    super(`wechat account already bound: ${accountId}`)
    this.name = 'WechatAccountAlreadyBoundError'
  }
}

interface Row {
  user_id: string
  account_id: string
  login_user_id: string
  bot_token: string
  get_updates_buf: string
  context_tokens: string
  whitelist: string
  status: string
  created_at: number
  updated_at: number
  last_event_at: number | null
}

// Lazy migration: 老行的 context_tokens key 形态是 iLink wire 的
// `<base64url>@im.wechat`,新代码全程按 canonical base64url 写入 + 查询。
// 在 row → binding 边界剥后缀,worker 后续 cursor flush 会把 canonical
// 形态原样写回 DB,无需一次性 ALTER 迁移。
//
// 这里**不**从 @openclaude/channel-wechat 导入 canonicalSenderId — storage
// 是 channels/wechat 的上游依赖,反向引用会造成包层级倒挂。规则只一行,
// 重复在此符合本次修复范围。
const IM_WECHAT_SUFFIX = '@im.wechat'
function stripImWechatSuffix(key: string): string {
  return key.endsWith(IM_WECHAT_SUFFIX) ? key.slice(0, -IM_WECHAT_SUFFIX.length) : key
}
function canonicalizeContextTokens(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[stripImWechatSuffix(k)] = v
  }
  return out
}

function parseJsonRecord(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToBinding(r: Row): WechatBinding {
  let ctx: Record<string, string> = {}
  let wl: string[] = []
  try { ctx = canonicalizeContextTokens(JSON.parse(r.context_tokens || '{}')) } catch {}
  try { wl = JSON.parse(r.whitelist || '[]') } catch {}
  const st = (r.status === 'disabled' || r.status === 'expired') ? r.status : 'active'
  return {
    userId: r.user_id,
    accountId: r.account_id,
    loginUserId: r.login_user_id || '',
    botToken: r.bot_token,
    getUpdatesBuf: r.get_updates_buf || '',
    contextTokens: ctx,
    whitelist: wl,
    status: st as WechatBinding['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastEventAt: r.last_event_at,
  }
}

export async function _sqliteListActiveWechatBindings(): Promise<WechatBinding[]> {
  const db = await getSessionsDb()
  const rows = db.prepare('SELECT * FROM wechat_bindings WHERE status = ?').all('active') as Row[]
  return rows.map(rowToBinding)
}

export async function _sqliteListAllWechatBindings(): Promise<WechatBinding[]> {
  const db = await getSessionsDb()
  const rows = db.prepare('SELECT * FROM wechat_bindings').all() as Row[]
  return rows.map(rowToBinding)
}

export async function _sqliteGetWechatBindingByUserId(userId: string): Promise<WechatBinding | null> {
  const db = await getSessionsDb()
  const row = db.prepare('SELECT * FROM wechat_bindings WHERE user_id = ?').get(userId) as Row | undefined
  return row ? rowToBinding(row) : null
}

export async function _sqliteGetWechatBindingByAccountId(accountId: string): Promise<WechatBinding | null> {
  const db = await getSessionsDb()
  const row = db.prepare('SELECT * FROM wechat_bindings WHERE account_id = ?').get(accountId) as Row | undefined
  return row ? rowToBinding(row) : null
}

export interface UpsertWechatBindingInput {
  userId: string
  accountId: string
  loginUserId: string
  botToken: string
  // Optional — defaults to current binding value if present, otherwise empty
  getUpdatesBuf?: string
  contextTokens?: Record<string, string>
  whitelist?: string[]
  status?: WechatBinding['status']
  lastEventAt?: number | null
}

export async function _sqliteUpsertWechatBinding(input: UpsertWechatBindingInput): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  const accountOwner = db
    .prepare('SELECT user_id FROM wechat_bindings WHERE account_id = ?')
    .get(input.accountId) as { user_id: string } | undefined
  if (accountOwner && accountOwner.user_id !== input.userId) {
    throw new WechatAccountAlreadyBoundError(input.accountId)
  }
  const existing = db
    .prepare('SELECT * FROM wechat_bindings WHERE user_id = ?')
    .get(input.userId) as Row | undefined

  const identityChanged =
    !!existing &&
    (existing.account_id !== input.accountId || existing.bot_token !== input.botToken)
  const buf = input.getUpdatesBuf ?? (identityChanged ? '' : existing?.get_updates_buf ?? '')
  const ctx = JSON.stringify(
    input.contextTokens ?? (identityChanged ? {} : existing ? parseJsonRecord(existing.context_tokens) : {}),
  )
  const wl = JSON.stringify(
    input.whitelist ??
      (identityChanged
        ? []
        : existing
          ? parseJsonStringArray(existing.whitelist)
          : [input.loginUserId].filter(Boolean)),
  )
  const status = input.status ?? 'active'
  const createdAt = existing?.created_at ?? now
  const lastEventAt = input.lastEventAt ?? (identityChanged ? null : existing?.last_event_at ?? null)

  try {
    db.prepare(
      `INSERT INTO wechat_bindings
         (user_id, account_id, login_user_id, bot_token, get_updates_buf, context_tokens, whitelist, status, created_at, updated_at, last_event_at)
       VALUES (@userId, @accountId, @loginUserId, @botToken, @buf, @ctx, @wl, @status, @createdAt, @updatedAt, @lastEventAt)
       ON CONFLICT(user_id) DO UPDATE SET
         account_id = excluded.account_id,
         login_user_id = excluded.login_user_id,
         bot_token = excluded.bot_token,
         get_updates_buf = excluded.get_updates_buf,
         context_tokens = excluded.context_tokens,
         whitelist = excluded.whitelist,
         status = excluded.status,
         updated_at = excluded.updated_at,
         last_event_at = excluded.last_event_at`,
    ).run({
      userId: input.userId,
      accountId: input.accountId,
      loginUserId: input.loginUserId,
      botToken: input.botToken,
      buf,
      ctx,
      wl,
      status,
      createdAt,
      updatedAt: now,
      lastEventAt,
    })
  } catch (err: any) {
    if (/wechat_bindings\.account_id|idx_wechat_bindings_account/i.test(String(err?.message || err))) {
      throw new WechatAccountAlreadyBoundError(input.accountId)
    }
    throw err
  }
}

export async function _sqliteUpdateWechatBindingCursor(
  userId: string,
  getUpdatesBuf: string,
  contextTokens?: Record<string, string>,
): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  if (contextTokens) {
    db.prepare(
      'UPDATE wechat_bindings SET get_updates_buf = ?, context_tokens = ?, last_event_at = ?, updated_at = ? WHERE user_id = ?',
    ).run(getUpdatesBuf, JSON.stringify(contextTokens), now, now, userId)
  } else {
    db.prepare(
      'UPDATE wechat_bindings SET get_updates_buf = ?, updated_at = ? WHERE user_id = ?',
    ).run(getUpdatesBuf, now, userId)
  }
}

export async function _sqliteUpdateWechatBindingStatus(
  userId: string,
  status: WechatBinding['status'],
): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare('UPDATE wechat_bindings SET status = ?, updated_at = ? WHERE user_id = ?').run(
    status,
    now,
    userId,
  )
}

export async function _sqliteDeleteWechatBinding(userId: string): Promise<void> {
  const db = await getSessionsDb()
  db.prepare('DELETE FROM wechat_bindings WHERE user_id = ?').run(userId)
}

// ── 公有 API:薄委托 active backend(RFC D1)──────────────────────────────────
//
// 调用点(WechatManager / 绑定路由)按函数名 import 这些,签名不变、零改动。master 形态注入
// PG backend 后自动走 PG;容器/个人版无注入 → getActiveBackend() 返回默认 sqliteBackend。

export async function listActiveWechatBindings(): Promise<WechatBinding[]> {
  return getActiveBackend().listActiveWechatBindings()
}

export async function listAllWechatBindings(): Promise<WechatBinding[]> {
  return getActiveBackend().listAllWechatBindings()
}

export async function getWechatBindingByUserId(userId: string): Promise<WechatBinding | null> {
  return getActiveBackend().getWechatBindingByUserId(userId)
}

export async function getWechatBindingByAccountId(accountId: string): Promise<WechatBinding | null> {
  return getActiveBackend().getWechatBindingByAccountId(accountId)
}

export async function upsertWechatBinding(input: UpsertWechatBindingInput): Promise<void> {
  return getActiveBackend().upsertWechatBinding(input)
}

export async function updateWechatBindingCursor(
  userId: string,
  getUpdatesBuf: string,
  contextTokens?: Record<string, string>,
): Promise<void> {
  return getActiveBackend().updateWechatBindingCursor(userId, getUpdatesBuf, contextTokens)
}

export async function updateWechatBindingStatus(
  userId: string,
  status: WechatBinding['status'],
): Promise<void> {
  return getActiveBackend().updateWechatBindingStatus(userId, status)
}

export async function deleteWechatBinding(userId: string): Promise<void> {
  return getActiveBackend().deleteWechatBinding(userId)
}
