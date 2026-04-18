// wechat_bindings CRUD — per-OC-user WeChat iLink bot bindings.
//
// Multi-tenant: every OpenClaude user can independently scan a QR and bind
// their own WeChat bot. The gateway's WechatManager reads active rows here at
// startup and spawns one long-poll worker per binding.
//
// Table is declared in sessionsDb.ts (see CREATE TABLE wechat_bindings).

import { getSessionsDb } from './sessionsDb.js'

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

function rowToBinding(r: Row): WechatBinding {
  let ctx: Record<string, string> = {}
  let wl: string[] = []
  try { ctx = JSON.parse(r.context_tokens || '{}') } catch {}
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

export async function listActiveWechatBindings(): Promise<WechatBinding[]> {
  const db = await getSessionsDb()
  const rows = db.prepare('SELECT * FROM wechat_bindings WHERE status = ?').all('active') as Row[]
  return rows.map(rowToBinding)
}

export async function listAllWechatBindings(): Promise<WechatBinding[]> {
  const db = await getSessionsDb()
  const rows = db.prepare('SELECT * FROM wechat_bindings').all() as Row[]
  return rows.map(rowToBinding)
}

export async function getWechatBindingByUserId(userId: string): Promise<WechatBinding | null> {
  const db = await getSessionsDb()
  const row = db.prepare('SELECT * FROM wechat_bindings WHERE user_id = ?').get(userId) as Row | undefined
  return row ? rowToBinding(row) : null
}

export async function getWechatBindingByAccountId(accountId: string): Promise<WechatBinding | null> {
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
}

export async function upsertWechatBinding(input: UpsertWechatBindingInput): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  const existing = db
    .prepare('SELECT * FROM wechat_bindings WHERE user_id = ?')
    .get(input.userId) as Row | undefined

  const buf = input.getUpdatesBuf ?? existing?.get_updates_buf ?? ''
  const ctx = JSON.stringify(input.contextTokens ?? (existing ? JSON.parse(existing.context_tokens || '{}') : {}))
  const wl = JSON.stringify(
    input.whitelist ?? (existing ? JSON.parse(existing.whitelist || '[]') : [input.loginUserId].filter(Boolean)),
  )
  const status = input.status ?? 'active'
  const createdAt = existing?.created_at ?? now

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
       updated_at = excluded.updated_at`,
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
    lastEventAt: existing?.last_event_at ?? null,
  })
}

export async function updateWechatBindingCursor(
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

export async function updateWechatBindingStatus(
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

export async function updateWechatBindingWhitelist(
  userId: string,
  whitelist: string[],
): Promise<void> {
  const db = await getSessionsDb()
  const now = Date.now()
  db.prepare('UPDATE wechat_bindings SET whitelist = ?, updated_at = ? WHERE user_id = ?').run(
    JSON.stringify(whitelist),
    now,
    userId,
  )
}

export async function deleteWechatBinding(userId: string): Promise<void> {
  const db = await getSessionsDb()
  db.prepare('DELETE FROM wechat_bindings WHERE user_id = ?').run(userId)
}
