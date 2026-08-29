/** xAI OAuth refresh for Grok subscription accounts. */
import type { Pool } from 'pg'
import { request, type Dispatcher } from 'undici'
import { getPool } from '../db/index.js'
import { resolveOfficialOAuthAccountEgressDispatcher } from './codexEgress.js'
import {
  getGrokTokenSnapshotInTx,
  updateGrokTokenSnapshotInTx,
} from './store.js'

export const GROK_OAUTH_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token'
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const REFRESH_SKEW_MS = 5 * 60_000

export class GrokOAuthRefreshError extends Error {
  readonly terminal: boolean
  readonly statusCode: number
  readonly oauthCode: string | null

  constructor(statusCode: number, oauthCode: string | null) {
    super(`GROK_OAUTH_REFRESH_FAILED:${statusCode}${oauthCode ? `:${oauthCode}` : ''}`)
    this.name = 'GrokOAuthRefreshError'
    this.statusCode = statusCode
    this.oauthCode = oauthCode
    this.terminal = oauthCode === 'invalid_grant' || oauthCode === 'invalid_client'
  }
}

export async function getFreshGrokAccessToken(
  accountId: bigint | string,
  deps: {
    now?: () => number
    requestFn?: typeof request
    resolveDispatcher?: (id: bigint | string) => Promise<{ dispatcher: Dispatcher }>
    pool?: Pick<Pool, 'connect'>
    getSnapshot?: typeof getGrokTokenSnapshotInTx
    updateSnapshot?: typeof updateGrokTokenSnapshotInTx
  } = {},
): Promise<Buffer> {
  const client = await (deps.pool ?? getPool()).connect()
  const now = deps.now ?? Date.now
  let snapshot: Awaited<ReturnType<typeof getGrokTokenSnapshotInTx>> = null
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`grok-oauth:${String(accountId)}`])
    snapshot = await (deps.getSnapshot ?? getGrokTokenSnapshotInTx)(client, accountId)
    if (!snapshot) throw new Error('GROK_ACCOUNT_NOT_FOUND')
    if (snapshot.expires_at && snapshot.expires_at.getTime() > now() + REFRESH_SKEW_MS) {
      const token = snapshot.token
      snapshot.token = Buffer.alloc(0)
      snapshot.refresh?.fill(0)
      snapshot.refresh = null
      await client.query('COMMIT')
      return token
    }
    if (!snapshot.refresh || snapshot.refresh.length === 0) {
      throw new Error('GROK_REFRESH_TOKEN_MISSING')
    }
    const route = await (deps.resolveDispatcher ?? (async (id) =>
      resolveOfficialOAuthAccountEgressDispatcher(id, 'grok')))(accountId)
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: snapshot.refresh.toString('utf8'),
      client_id: GROK_OAUTH_CLIENT_ID,
    })
    if (snapshot.principal_type && snapshot.principal_id) {
      form.set('principal_type', snapshot.principal_type)
      form.set('principal_id', snapshot.principal_id)
    }
    const response = await (deps.requestFn ?? request)(GROK_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      dispatcher: route.dispatcher,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    })
    const raw = await response.body.text()
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let oauthCode: string | null = null
      try {
        const errorBody = JSON.parse(raw) as Record<string, unknown>
        if (typeof errorBody.error === 'string') oauthCode = errorBody.error
      } catch {}
      throw new GrokOAuthRefreshError(response.statusCode, oauthCode)
    }
    const body = JSON.parse(raw) as Record<string, unknown>
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('GROK_OAUTH_REFRESH_INVALID_RESPONSE')
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? Math.max(60, Math.floor(body.expires_in))
      : 3600
    const expiresAt = new Date(now() + expiresIn * 1000)
    const rotatedRefresh = typeof body.refresh_token === 'string' && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined
    const updated = await (deps.updateSnapshot ?? updateGrokTokenSnapshotInTx)(client, accountId, {
      token: body.access_token,
      ...(rotatedRefresh ? { refresh: rotatedRefresh } : {}),
      expires_at: expiresAt,
      last_error: null,
    })
    if (!updated) throw new Error('GROK_ACCOUNT_NOT_ACTIVE')
    await client.query('COMMIT')
    return Buffer.from(body.access_token, 'utf8')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    if (err instanceof GrokOAuthRefreshError && err.terminal) {
      await client.query(
        `UPDATE claude_accounts
            SET status = 'disabled', last_error = $2, updated_at = NOW()
          WHERE id = $1 AND provider = 'grok'`,
        [String(accountId), err.message],
      ).catch(() => {})
    }
    throw err
  } finally {
    snapshot?.token.fill(0)
    snapshot?.refresh?.fill(0)
    client.release()
  }
}
