import { getSessionsDb } from './sqliteHandle.js'

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

export interface UpsertWechatBindingInput {
  userId: string
  accountId: string
  loginUserId: string
  botToken: string
  getUpdatesBuf?: string
  contextTokens?: Record<string, string>
  whitelist?: string[]
  status?: WechatBinding['status']
  lastEventAt?: number | null
}

interface WechatBindingRow {
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
    const parsed: unknown = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToBinding(r: WechatBindingRow): WechatBinding {
  const ctx = canonicalizeContextTokens(parseJsonRecord(r.context_tokens))
  const wl = parseJsonStringArray(r.whitelist)
  const st = r.status === 'disabled' || r.status === 'expired' ? r.status : 'active'
  return {
    userId: r.user_id,
    accountId: r.account_id,
    loginUserId: r.login_user_id || '',
    botToken: r.bot_token,
    getUpdatesBuf: r.get_updates_buf || '',
    contextTokens: ctx,
    whitelist: wl,
    status: st,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastEventAt: r.last_event_at,
  }
}

function resolveUpsertBindingFields(
  input: UpsertWechatBindingInput,
  existing: WechatBindingRow | undefined,
  now: number,
): {
  buf: string
  ctx: string
  wl: string
  status: WechatBinding['status']
  createdAt: number
  lastEventAt: number | null
} {
  const identityChanged =
    !!existing &&
    (existing.account_id !== input.accountId || existing.bot_token !== input.botToken)
  const buf = input.getUpdatesBuf ?? (identityChanged ? '' : (existing?.get_updates_buf ?? ''))
  const fallbackCtx = identityChanged ? {} : existing ? parseJsonRecord(existing.context_tokens) : {}
  const fallbackWl = identityChanged
    ? []
    : existing
      ? parseJsonStringArray(existing.whitelist)
      : [input.loginUserId].filter(Boolean)
  return {
    buf,
    ctx: JSON.stringify(input.contextTokens ?? fallbackCtx),
    wl: JSON.stringify(input.whitelist ?? fallbackWl),
    status: input.status ?? 'active',
    createdAt: existing?.created_at ?? now,
    lastEventAt:
      input.lastEventAt ?? (identityChanged ? null : (existing?.last_event_at ?? null)),
  }
}

export async function _sqliteListActiveWechatBindings(): Promise<WechatBinding[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare('SELECT * FROM wechat_bindings WHERE status = ?')
    .all('active') as WechatBindingRow[]
  return rows.map(rowToBinding)
}

export async function _sqliteListAllWechatBindings(): Promise<WechatBinding[]> {
  const db = await getSessionsDb()
  const rows = db.prepare('SELECT * FROM wechat_bindings').all() as WechatBindingRow[]
  return rows.map(rowToBinding)
}

export async function _sqliteGetWechatBindingByUserId(
  userId: string,
): Promise<WechatBinding | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT * FROM wechat_bindings WHERE user_id = ?')
    .get(userId) as WechatBindingRow | undefined
  return row ? rowToBinding(row) : null
}

export async function _sqliteGetWechatBindingByAccountId(
  accountId: string,
): Promise<WechatBinding | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT * FROM wechat_bindings WHERE account_id = ?')
    .get(accountId) as WechatBindingRow | undefined
  return row ? rowToBinding(row) : null
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
    .get(input.userId) as WechatBindingRow | undefined
  const fields = resolveUpsertBindingFields(input, existing, now)

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
      buf: fields.buf,
      ctx: fields.ctx,
      wl: fields.wl,
      status: fields.status,
      createdAt: fields.createdAt,
      updatedAt: now,
      lastEventAt: fields.lastEventAt,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/wechat_bindings\.account_id|idx_wechat_bindings_account/i.test(msg)) {
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
