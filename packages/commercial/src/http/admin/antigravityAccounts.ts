/**
 * Admin API for Antigravity Google AI subscription accounts (OCV5-415 P2).
 *
 *   POST  /api/admin/antigravity-accounts/auth/start     {label}
 *   POST  /api/admin/antigravity-accounts/auth/complete  {sessionId, code}
 *   GET   /api/admin/antigravity-accounts
 *   PATCH /api/admin/antigravity-accounts/:id            {status: active|disabled}
 *
 * Never returns token material. Disable/enable writes status and disabled_by
 * in one UPDATE (OCV5-424 provenance rule).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AntigravityOAuthError } from '../../account-pool/antigravityOAuth.js'
import {
  completeAntigravityAccountAuth,
  startAntigravityAccountAuth,
} from '../../admin/antigravityAccountAuth.js'
import { writeAdminAuditBestEffort } from '../../admin/audit.js'
import { requireAdmin, requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import { getPool } from '../../db/index.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

export const ANTIGRAVITY_ACCOUNTS_PATH = '/api/admin/antigravity-accounts'

function clientSecret(): string {
  const secret = process.env.OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() ?? ''
  if (!secret)
    throw new HttpError(
      503,
      'ANTIGRAVITY_NOT_CONFIGURED',
      'OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET is not set',
    )
  return secret
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION', 'request body must be JSON object')
  }
  return body as Record<string, unknown>
}

export async function handleAdminAntigravityAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  clientSecret()
  const body = objectBody((await readJsonBody(req)) ?? {})
  const label = typeof body.label === 'string' ? body.label : ''
  let started: ReturnType<typeof startAntigravityAccountAuth>
  try {
    started = startAntigravityAccountAuth({ label })
  } catch (err) {
    throw new HttpError(400, 'VALIDATION', err instanceof Error ? err.message : 'invalid request')
  }
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
    'antigravity_account.authorize',
    'antigravity_account:pending',
    undefined,
    { stage: 'start', label: label.trim() },
  )
  sendJson(res, 200, started)
}

export async function handleAdminAntigravityAuthComplete(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const secret = clientSecret()
  const body = objectBody((await readJsonBody(req)) ?? {})
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const code = typeof body.code === 'string' ? body.code : ''
  let account: Awaited<ReturnType<typeof completeAntigravityAccountAuth>>
  try {
    account = await completeAntigravityAccountAuth({ sessionId, code }, { clientSecret: secret })
  } catch (err) {
    if (err instanceof AntigravityOAuthError) {
      throw new HttpError(502, 'OAUTH_FAILED', err.oauthCode ?? `http_${err.statusCode}`)
    }
    const message = err instanceof Error ? err.message : 'ANTIGRAVITY_AUTH_FAILED'
    throw new HttpError(message.endsWith('SESSION_NOT_FOUND') ? 404 : 400, 'OAUTH_FAILED', message)
  }
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
    'antigravity_account.authorize',
    `antigravity_account:${account.accountId}`,
    undefined,
    { stage: 'complete', email: account.email, label: account.label },
  )
  sendJson(res, 200, account)
}

export async function handleAdminAntigravityAccountsList(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
  const rows = await getPool().query(
    `SELECT id::text AS id, label, email, paid_tier, tier_updated_at, status, health_score, cooldown_until, cooldown_reason,
            backoff_level, disabled_by, success_count::text AS success_count,
            fail_count::text AS fail_count, last_error, last_used_at, created_at, updated_at
       FROM gemini_oauth_accounts ORDER BY id`,
  )
  sendJson(res, 200, { accounts: rows.rows })
}

export async function handleAdminAntigravityAccountPatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const path = (req.url ?? '').split('?')[0] ?? ''
  const id = path.slice(`${ANTIGRAVITY_ACCOUNTS_PATH}/`.length)
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new HttpError(404, 'NOT_FOUND', 'account not found')
  const body = objectBody((await readJsonBody(req)) ?? {})
  if (body.status !== 'active' && body.status !== 'disabled') {
    throw new HttpError(400, 'VALIDATION', 'status must be active or disabled')
  }
  const disable = body.status === 'disabled'
  const updated = await getPool().query<{ id: string; status: string }>(
    disable
      ? `UPDATE gemini_oauth_accounts SET status = 'disabled', disabled_by = 'admin', updated_at = NOW()
          WHERE id = $1 RETURNING id::text AS id, status`
      : `UPDATE gemini_oauth_accounts SET status = 'active', disabled_by = NULL,
            cooldown_until = NULL, cooldown_reason = NULL, backoff_level = 0, next_probe_at = NULL,
            updated_at = NOW()
          WHERE id = $1 RETURNING id::text AS id, status`,
    [id],
  )
  if (updated.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'account not found')
  await writeAdminAuditBestEffort(
    { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
    'antigravity_account.patch',
    `antigravity_account:${id}`,
    undefined,
    { status: body.status },
  )
  sendJson(res, 200, updated.rows[0])
}
