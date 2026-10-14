/**
 * Google AI subscription accounts (consumer OAuth) behind the Antigravity
 * relay (OCV5-415 P2). Storage: gemini_oauth_accounts (0305).
 *
 * Two kinds of access token come out of one stored refresh token:
 *   - full scope (cloud-platform, …): only the relay uses it, injected into
 *     each forwarded `/v1internal:*` call. Cached encrypted in the row.
 *   - limited scope (openid + userinfo): handed to the CLI in the user
 *     container. The CLI's startup eligibility check reads userinfo directly
 *     from Google, so it needs a real token, but this one cannot call Cloud
 *     Code or any other API, and the CLI never sees a refresh token.
 * Both are minted with the official CLI's installed-app client.
 */
import type { Pool, PoolClient } from 'pg'
import { type Dispatcher, request } from 'undici'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import { directEgressDispatcher } from './egressDispatcher.js'

export const ANTIGRAVITY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/auth'
export const ANTIGRAVITY_OAUTH_REDIRECT_URI = 'https://antigravity.google/oauth-callback'
export const ANTIGRAVITY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode',
  'openid',
] as const
export const ANTIGRAVITY_LIMITED_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const
const REFRESH_SKEW_MS = 5 * 60_000
/** Limited tokens are minted per turn; reuse one while it has this much left. */
const LIMITED_MIN_REMAINING_MS = 20 * 60_000

export class AntigravityOAuthError extends Error {
  readonly statusCode: number
  readonly oauthCode: string | null
  /** invalid_grant / invalid_client: the stored grant is unusable until re-auth. */
  readonly authInvalid: boolean

  constructor(statusCode: number, oauthCode: string | null) {
    super(`ANTIGRAVITY_OAUTH_FAILED:${statusCode}${oauthCode ? `:${oauthCode}` : ''}`)
    this.name = 'AntigravityOAuthError'
    this.statusCode = statusCode
    this.oauthCode = oauthCode
    this.authInvalid =
      oauthCode === 'invalid_grant' || oauthCode === 'invalid_client' || statusCode === 401
  }
}

export interface AntigravityTokenGrant {
  accessToken: string
  expiresAt: Date
  idToken: string | null
  refreshToken: string | null
}

export interface AntigravityOAuthDeps {
  clientSecret: string
  requestFn?: typeof request
  dispatcher?: Dispatcher
  now?: () => number
}

async function postToken(
  deps: AntigravityOAuthDeps,
  form: Record<string, string>,
): Promise<AntigravityTokenGrant> {
  const now = deps.now ?? Date.now
  const response = await (deps.requestFn ?? request)(ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    dispatcher: deps.dispatcher ?? directEgressDispatcher(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      ...form,
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: deps.clientSecret,
    }).toString(),
  })
  const raw = await response.body.text()
  if (response.statusCode < 200 || response.statusCode >= 300) {
    let oauthCode: string | null = null
    try {
      const body = JSON.parse(raw) as Record<string, unknown>
      if (typeof body.error === 'string') oauthCode = body.error.slice(0, 64)
    } catch {
      /* non-JSON error body */
    }
    throw new AntigravityOAuthError(response.statusCode, oauthCode)
  }
  const body = JSON.parse(raw) as Record<string, unknown>
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('ANTIGRAVITY_OAUTH_INVALID_RESPONSE')
  }
  const expiresIn =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? Math.max(60, Math.floor(body.expires_in))
      : 3600
  return {
    accessToken: body.access_token,
    expiresAt: new Date(now() + expiresIn * 1000),
    idToken: typeof body.id_token === 'string' && body.id_token ? body.id_token : null,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
  }
}

/** Authorization-code exchange for the admin onboarding flow (PKCE). */
export function exchangeAntigravityAuthCode(
  deps: AntigravityOAuthDeps,
  args: { code: string; codeVerifier: string },
): Promise<AntigravityTokenGrant> {
  return postToken(deps, {
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: ANTIGRAVITY_OAUTH_REDIRECT_URI,
  })
}

export function refreshAntigravityGrant(
  deps: AntigravityOAuthDeps,
  refreshToken: string,
  scopes?: readonly string[],
): Promise<AntigravityTokenGrant> {
  return postToken(deps, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(scopes ? { scope: scopes.join(' ') } : {}),
  })
}

/** Google account email for an access token (userinfo scope). */
export async function fetchAntigravityAccountEmail(
  deps: Pick<AntigravityOAuthDeps, 'requestFn' | 'dispatcher'>,
  accessToken: string,
): Promise<string> {
  const response = await (deps.requestFn ?? request)(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    {
      method: 'GET',
      dispatcher: deps.dispatcher ?? directEgressDispatcher(),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    },
  )
  const raw = await response.body.text()
  if (response.statusCode !== 200) throw new AntigravityOAuthError(response.statusCode, null)
  const body = JSON.parse(raw) as Record<string, unknown>
  if (typeof body.email !== 'string' || !body.email.includes('@') || body.verified_email !== true) {
    throw new Error('ANTIGRAVITY_ACCOUNT_EMAIL_UNVERIFIED')
  }
  return body.email.toLowerCase()
}

export interface AntigravityAccountInsert {
  label: string
  email: string
  refreshToken: string
  accessToken?: string | null
  accessExpiresAt?: Date | null
}

/** Insert or re-authorize (same email) an account. Returns its id. */
export async function upsertAntigravityAccount(
  account: AntigravityAccountInsert,
  deps: { pool?: Pick<Pool, 'query'>; keyFn?: () => Buffer } = {},
): Promise<bigint> {
  const key = (deps.keyFn ?? loadKmsKey)()
  try {
    const refresh = encrypt(account.refreshToken, key)
    const access = account.accessToken ? encrypt(account.accessToken, key) : null
    const res = await (deps.pool ?? getPool()).query<{ id: string }>(
      `INSERT INTO gemini_oauth_accounts
         (label, email, refresh_token_enc, refresh_token_nonce,
          access_token_enc, access_token_nonce, access_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         refresh_token_nonce = EXCLUDED.refresh_token_nonce,
         access_token_enc = EXCLUDED.access_token_enc,
         access_token_nonce = EXCLUDED.access_token_nonce,
         access_expires_at = EXCLUDED.access_expires_at,
         -- Re-authorization clears automatic cooldowns, never an admin disable.
         status = CASE WHEN gemini_oauth_accounts.disabled_by = 'admin'
                       THEN gemini_oauth_accounts.status ELSE 'active' END,
         cooldown_until = NULL, cooldown_reason = NULL, backoff_level = 0,
         next_probe_at = NULL, last_error = NULL, updated_at = NOW()
       RETURNING id::text AS id`,
      [
        account.label,
        account.email.toLowerCase(),
        refresh.ciphertext,
        refresh.nonce,
        access?.ciphertext ?? null,
        access?.nonce ?? null,
        access ? (account.accessExpiresAt ?? null) : null,
      ],
    )
    return BigInt(res.rows[0]!.id)
  } finally {
    zeroBuffer(key)
  }
}

interface SecretRow {
  refresh_token_enc: Buffer
  refresh_token_nonce: Buffer
  access_token_enc: Buffer | null
  access_token_nonce: Buffer | null
  access_expires_at: Date | null
}

export type AntigravityAuthFailureSink = (
  accountId: bigint,
  err: AntigravityOAuthError,
) => Promise<void>

/**
 * Full-scope access token for relay injection. Serialized per account with an
 * advisory lock so concurrent turns refresh once. Caller must `.fill(0)`.
 */
export async function getFreshAntigravityAccessToken(
  accountId: bigint,
  deps: AntigravityOAuthDeps & {
    pool?: Pick<Pool, 'connect'>
    keyFn?: () => Buffer
    onAuthFailure?: AntigravityAuthFailureSink
  },
): Promise<Buffer> {
  const now = deps.now ?? Date.now
  const client: PoolClient = (await (deps.pool ?? getPool()).connect()) as PoolClient
  const key = (deps.keyFn ?? loadKmsKey)()
  let refresh: Buffer | null = null
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `antigravity-oauth:${accountId}`,
    ])
    const res = await client.query<SecretRow>(
      `SELECT refresh_token_enc, refresh_token_nonce, access_token_enc, access_token_nonce, access_expires_at
         FROM gemini_oauth_accounts WHERE id = $1`,
      [accountId.toString()],
    )
    const row = res.rows[0]
    if (!row) throw new Error('ANTIGRAVITY_ACCOUNT_NOT_FOUND')
    if (
      row.access_token_enc &&
      row.access_token_nonce &&
      row.access_expires_at &&
      row.access_expires_at.getTime() > now() + REFRESH_SKEW_MS
    ) {
      const token = decryptToBuffer(row.access_token_enc, row.access_token_nonce, key)
      await client.query('COMMIT')
      return token
    }
    refresh = decryptToBuffer(row.refresh_token_enc, row.refresh_token_nonce, key)
    let grant: AntigravityTokenGrant
    try {
      grant = await refreshAntigravityGrant(deps, refresh.toString('utf8'))
    } catch (err) {
      if (err instanceof AntigravityOAuthError && err.authInvalid && deps.onAuthFailure) {
        await client.query('ROLLBACK').catch(() => {})
        await deps.onAuthFailure(accountId, err).catch(() => {})
        throw err
      }
      throw err
    }
    const access = encrypt(grant.accessToken, key)
    const rotated = grant.refreshToken ? encrypt(grant.refreshToken, key) : null
    await client.query(
      `UPDATE gemini_oauth_accounts SET
         access_token_enc = $2, access_token_nonce = $3, access_expires_at = $4,
         refresh_token_enc = COALESCE($5, refresh_token_enc),
         refresh_token_nonce = COALESCE($6, refresh_token_nonce),
         updated_at = NOW()
       WHERE id = $1`,
      [
        accountId.toString(),
        access.ciphertext,
        access.nonce,
        grant.expiresAt,
        rotated?.ciphertext ?? null,
        rotated?.nonce ?? null,
      ],
    )
    await client.query('COMMIT')
    return Buffer.from(grant.accessToken, 'utf8')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    refresh?.fill(0)
    zeroBuffer(key)
    client.release()
  }
}

export interface AntigravityLimitedToken {
  accessToken: string
  expiresAt: Date
  idToken: string | null
}

const limitedCache = new Map<string, AntigravityLimitedToken>()

/**
 * openid/userinfo-only token for the CLI token file. Cached in process memory
 * per account while it has ≥20 min left (a turn's eligibility check happens
 * at CLI start).
 */
export async function mintAntigravityLimitedToken(
  accountId: bigint,
  deps: AntigravityOAuthDeps & {
    pool?: Pick<Pool, 'query'>
    keyFn?: () => Buffer
    onAuthFailure?: AntigravityAuthFailureSink
  },
): Promise<AntigravityLimitedToken> {
  const now = deps.now ?? Date.now
  const cacheKey = accountId.toString()
  const cached = limitedCache.get(cacheKey)
  if (cached && cached.expiresAt.getTime() - now() >= LIMITED_MIN_REMAINING_MS) return cached
  const res = await (deps.pool ?? getPool()).query<SecretRow>(
    `SELECT refresh_token_enc, refresh_token_nonce, access_token_enc, access_token_nonce, access_expires_at
       FROM gemini_oauth_accounts WHERE id = $1`,
    [cacheKey],
  )
  const row = res.rows[0]
  if (!row) throw new Error('ANTIGRAVITY_ACCOUNT_NOT_FOUND')
  const key = (deps.keyFn ?? loadKmsKey)()
  let refresh: Buffer | null = null
  try {
    refresh = decryptToBuffer(row.refresh_token_enc, row.refresh_token_nonce, key)
    let grant: AntigravityTokenGrant
    try {
      grant = await refreshAntigravityGrant(
        deps,
        refresh.toString('utf8'),
        ANTIGRAVITY_LIMITED_SCOPES,
      )
    } catch (err) {
      if (err instanceof AntigravityOAuthError && err.authInvalid && deps.onAuthFailure) {
        await deps.onAuthFailure(accountId, err).catch(() => {})
      }
      throw err
    }
    const minted: AntigravityLimitedToken = {
      accessToken: grant.accessToken,
      expiresAt: grant.expiresAt,
      idToken: grant.idToken,
    }
    limitedCache.set(cacheKey, minted)
    return minted
  } finally {
    refresh?.fill(0)
    zeroBuffer(key)
  }
}

export function _resetAntigravityLimitedCacheForTests(): void {
  limitedCache.clear()
}
