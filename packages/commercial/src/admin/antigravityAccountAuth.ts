/**
 * Admin onboarding for Antigravity Google AI subscription accounts
 * (OCV5-415 P2). Same consent screen the official CLI shows:
 *
 *   start    → PKCE authorization URL (installed-app client, redirect to
 *              antigravity.google/oauth-callback, which displays a code)
 *   complete → the admin pastes that code; we exchange it, read the verified
 *              account email, and store the refresh token encrypted.
 *
 * Sessions live 15 minutes in process memory; the verifier never leaves it.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  ANTIGRAVITY_OAUTH_AUTH_ENDPOINT,
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_REDIRECT_URI,
  ANTIGRAVITY_OAUTH_SCOPES,
  type AntigravityOAuthDeps,
  exchangeAntigravityAuthCode,
  fetchAntigravityAccountEmail,
  upsertAntigravityAccount,
} from '../account-pool/antigravityOAuth.js'

const SESSION_TTL_MS = 15 * 60_000
const MAX_SESSIONS = 16
const SESSION_ID_RE = /^[0-9a-f]{32}$/
const AUTH_CODE_RE = /^4\/[A-Za-z0-9._~-]{20,512}$/

interface PendingSession {
  verifier: string
  label: string
  createdAt: number
}

const sessions = new Map<string, PendingSession>()

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }
}

export function startAntigravityAccountAuth(
  args: { label: string },
  now: number = Date.now(),
): { sessionId: string; authUrl: string; expiresAt: string } {
  sweep(now)
  if (sessions.size >= MAX_SESSIONS) throw new Error('ANTIGRAVITY_AUTH_TOO_MANY_SESSIONS')
  const label = args.label.trim()
  if (label.length < 1 || label.length > 120) throw new Error('ANTIGRAVITY_AUTH_INVALID_LABEL')
  const sessionId = randomBytes(16).toString('hex')
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  sessions.set(sessionId, { verifier, label, createdAt: now })
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account consent',
    redirect_uri: ANTIGRAVITY_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: ANTIGRAVITY_OAUTH_SCOPES.join(' '),
    state: sessionId,
  })
  return {
    sessionId,
    authUrl: `${ANTIGRAVITY_OAUTH_AUTH_ENDPOINT}?${params.toString()}`,
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  }
}

export async function completeAntigravityAccountAuth(
  args: { sessionId: string; code: string },
  deps: AntigravityOAuthDeps & { upsert?: typeof upsertAntigravityAccount },
): Promise<{ accountId: string; email: string; label: string }> {
  const now = (deps.now ?? Date.now)()
  sweep(now)
  if (!SESSION_ID_RE.test(args.sessionId)) throw new Error('ANTIGRAVITY_AUTH_SESSION_NOT_FOUND')
  const session = sessions.get(args.sessionId)
  if (!session) throw new Error('ANTIGRAVITY_AUTH_SESSION_NOT_FOUND')
  const code = args.code.trim()
  if (!AUTH_CODE_RE.test(code)) throw new Error('ANTIGRAVITY_AUTH_INVALID_CODE')
  // One attempt per session: a code is single-use upstream anyway.
  sessions.delete(args.sessionId)
  const grant = await exchangeAntigravityAuthCode(deps, { code, codeVerifier: session.verifier })
  if (!grant.refreshToken) throw new Error('ANTIGRAVITY_AUTH_NO_REFRESH_TOKEN')
  const email = await fetchAntigravityAccountEmail(deps, grant.accessToken)
  const accountId = await (deps.upsert ?? upsertAntigravityAccount)({
    label: session.label,
    email,
    refreshToken: grant.refreshToken,
    accessToken: grant.accessToken,
    accessExpiresAt: grant.expiresAt,
  })
  return { accountId: accountId.toString(), email, label: session.label }
}

export function _resetAntigravityAccountAuthForTests(): void {
  sessions.clear()
}
