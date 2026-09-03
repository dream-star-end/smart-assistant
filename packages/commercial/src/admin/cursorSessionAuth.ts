/**
 * Short-lived admin login sessions for Cursor account credentials (Sand mode).
 *
 * This is the same PKCE "deep control" login the Cursor Sand/Grok Bot client
 * performs: we mint a verifier + S256 challenge + `bp_` uuid, hand the admin a
 * https://cursor.com/loginDeepControl URL, and poll /auth/poll until Cursor
 * returns the account session pair. The resulting accessToken/refreshToken is
 * then stored through the normal encrypted account form as a
 * `cursor_credential_kind = 'session'` row together with the machine id that
 * was used during login (Cursor ties the session to that machine id; the
 * checksum header on every later request must be derived from the same one).
 *
 * Secrets never leave this module in logs: only lengths / prefixes of the
 * uuid are surfaced, and the verifier is dropped once the session settles.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  CURSOR_MACHINE_ID_PATTERN,
  CURSOR_SESSION_CLIENT_VERSION,
  CURSOR_SESSION_TOKEN_PATTERN,
  cursorSessionChecksum,
  cursorSessionTokenExpiryMs,
} from '@openclaude/protocol'

export const CURSOR_LOGIN_DEEP_CONTROL_URL = 'https://cursor.com/loginDeepControl'
export const CURSOR_AUTH_POLL_URL = 'https://api2.cursor.sh/auth/poll'
const SESSION_TTL_MS = 10 * 60_000
const POLL_INTERVAL_MS = 2_000
const POLL_REQUEST_TIMEOUT_MS = 15_000
const MIN_REMAINING_MS = 60 * 60_000
const MACHINE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export interface CursorSessionCredential {
  access_token: string
  refresh_token: string
  expires_at: string
  machine_id: string
  auth_id: string | null
  email: string | null
}

export type CursorSessionAuthStatus =
  | { status: 'pending'; session_id: string; verification_url: string }
  | ({ status: 'complete'; session_id: string } & CursorSessionCredential)
  | { status: 'failed'; session_id: string; error: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface CursorSessionAuthOptions {
  fetchImpl?: FetchLike
  pollIntervalMs?: number
  ttlMs?: number
  now?: () => number
}

interface LoginSession {
  id: string
  createdAt: number
  verifier: string | null
  uuid: string
  machineId: string
  verificationUrl: string
  state: 'pending' | 'complete' | 'failed' | 'cancelled'
  credential: CursorSessionCredential | null
  error: string | null
  abort: AbortController
  ttl: NodeJS.Timeout
  loop: Promise<void> | null
}

const sessions = new Map<string, LoginSession>()

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 26 lowercase alphanumerics, same shape the Sand client persists. */
export function generateCursorMachineId(): string {
  const bytes = randomBytes(26)
  let out = ''
  for (const byte of bytes) out += MACHINE_ID_ALPHABET[byte % MACHINE_ID_ALPHABET.length]!
  if (!CURSOR_MACHINE_ID_PATTERN.test(out)) throw new Error('CURSOR_SESSION_MACHINE_ID_INVALID')
  return out
}

export function buildCursorLoginUrl(challenge: string, uuid: string): string {
  const url = new URL(CURSOR_LOGIN_DEEP_CONTROL_URL)
  url.searchParams.set('challenge', challenge)
  url.searchParams.set('uuid', uuid)
  url.searchParams.set('mode', 'login')
  url.searchParams.set('redirectTarget', 'sand')
  url.searchParams.set('supportsSelectedTeamLogin', 'true')
  return url.toString()
}

export function buildCursorPollHeaders(machineId: string, nowMs = Date.now()): Record<string, string> {
  return {
    accept: 'application/json',
    'x-cursor-checksum': cursorSessionChecksum(machineId, nowMs),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': CURSOR_SESSION_CLIENT_VERSION,
    'x-ghost-mode': 'true',
    'x-request-id': randomBytes(16).toString('hex'),
    'connect-protocol-version': '1',
  }
}

/** Strictly validate a /auth/poll success body into a storable credential. */
export function parseCursorPollResponse(
  body: unknown,
  machineId: string,
  nowMs = Date.now(),
): CursorSessionCredential {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('CURSOR_SESSION_POLL_BODY_INVALID')
  const doc = body as Record<string, unknown>
  const access = doc.accessToken
  const refresh = doc.refreshToken
  if (typeof access !== 'string' || !CURSOR_SESSION_TOKEN_PATTERN.test(access.trim())) {
    throw new Error('CURSOR_SESSION_ACCESS_TOKEN_MALFORMED')
  }
  if (typeof refresh !== 'string' || !CURSOR_SESSION_TOKEN_PATTERN.test(refresh.trim())) {
    throw new Error('CURSOR_SESSION_REFRESH_TOKEN_MALFORMED')
  }
  const accessToken = access.trim()
  const expiresAt = cursorSessionTokenExpiryMs(accessToken)
  if (expiresAt === null) throw new Error('CURSOR_SESSION_ACCESS_TOKEN_MALFORMED')
  if (expiresAt <= nowMs + MIN_REMAINING_MS) throw new Error('CURSOR_SESSION_ACCESS_TOKEN_EXPIRED')
  const authId = typeof doc.authId === 'string' && doc.authId.trim() ? doc.authId.trim().slice(0, 256) : null
  const email = typeof doc.email === 'string' && doc.email.trim() ? doc.email.trim().slice(0, 256) : null
  return {
    access_token: accessToken,
    refresh_token: refresh.trim(),
    expires_at: new Date(expiresAt).toISOString(),
    machine_id: machineId,
    auth_id: authId,
    email,
  }
}

function destroySession(session: LoginSession): void {
  sessions.delete(session.id)
  clearTimeout(session.ttl)
  session.verifier = null
  if (!session.abort.signal.aborted) session.abort.abort()
}

function settle(session: LoginSession, state: 'complete' | 'failed', credential: CursorSessionCredential | null, error: string | null): void {
  if (session.state !== 'pending') return
  session.state = state
  session.credential = credential
  session.error = error
  session.verifier = null
  clearTimeout(session.ttl)
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    timer.unref()
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function pollOnce(session: LoginSession, fetchImpl: FetchLike, now: () => number): Promise<'pending' | 'done'> {
  const verifier = session.verifier
  if (!verifier) return 'done'
  const url = new URL(CURSOR_AUTH_POLL_URL)
  url.searchParams.set('uuid', session.uuid)
  url.searchParams.set('verifier', verifier)
  const requestAbort = new AbortController()
  const timer = setTimeout(() => requestAbort.abort(), POLL_REQUEST_TIMEOUT_MS)
  timer.unref()
  const onOuterAbort = (): void => requestAbort.abort()
  session.abort.signal.addEventListener('abort', onOuterAbort, { once: true })
  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: buildCursorPollHeaders(session.machineId, now()),
      signal: requestAbort.signal,
    })
  } catch (err) {
    if (session.abort.signal.aborted) return 'done'
    // Network hiccups are retried until the session TTL fires.
    void err
    return 'pending'
  } finally {
    clearTimeout(timer)
    session.abort.signal.removeEventListener('abort', onOuterAbort)
  }
  if (response.status === 404) return 'pending'
  if (response.status === 401 || response.status === 403) {
    settle(session, 'failed', null, 'CURSOR_SESSION_LOGIN_REJECTED')
    return 'done'
  }
  if (!response.ok) {
    // Transient upstream errors (429/5xx) keep polling; anything else fails.
    if (response.status === 429 || response.status >= 500) return 'pending'
    settle(session, 'failed', null, `CURSOR_SESSION_POLL_HTTP_${response.status}`)
    return 'done'
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    settle(session, 'failed', null, 'CURSOR_SESSION_POLL_BODY_INVALID')
    return 'done'
  }
  try {
    const credential = parseCursorPollResponse(body, session.machineId, now())
    settle(session, 'complete', credential, null)
  } catch (err) {
    settle(session, 'failed', null, err instanceof Error ? err.message : 'CURSOR_SESSION_POLL_BODY_INVALID')
  }
  return 'done'
}

async function runPollLoop(session: LoginSession, fetchImpl: FetchLike, intervalMs: number, now: () => number): Promise<void> {
  while (session.state === 'pending' && !session.abort.signal.aborted) {
    const outcome = await pollOnce(session, fetchImpl, now)
    if (outcome === 'done') break
    await sleep(intervalMs, session.abort.signal)
  }
}

export function startCursorSessionAuth(opts: CursorSessionAuthOptions = {}): CursorSessionAuthStatus {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  const now = opts.now ?? (() => Date.now())
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const uuid = `bp_${base64url(randomBytes(24))}`
  const machineId = generateCursorMachineId()
  const id = randomBytes(16).toString('hex')
  const session: LoginSession = {
    id,
    createdAt: now(),
    verifier,
    uuid,
    machineId,
    verificationUrl: buildCursorLoginUrl(challenge, uuid),
    state: 'pending',
    credential: null,
    error: null,
    abort: new AbortController(),
    ttl: setTimeout(() => {
      settle(session, 'failed', null, 'CURSOR_SESSION_LOGIN_EXPIRED')
      session.abort.abort()
    }, opts.ttlMs ?? SESSION_TTL_MS),
    loop: null,
  }
  session.ttl.unref()
  sessions.set(id, session)
  session.loop = runPollLoop(session, fetchImpl, opts.pollIntervalMs ?? POLL_INTERVAL_MS, now).catch((err: unknown) => {
    settle(session, 'failed', null, err instanceof Error ? err.message : 'CURSOR_SESSION_POLL_FAILED')
  })
  return { status: 'pending', session_id: id, verification_url: session.verificationUrl }
}

/** One-shot for terminal states: the credential is handed out exactly once. */
export function getCursorSessionAuthStatus(id: string): CursorSessionAuthStatus | null {
  const session = sessions.get(id)
  if (!session) return null
  if (session.state === 'complete' && session.credential) {
    const out: CursorSessionAuthStatus = { status: 'complete', session_id: id, ...session.credential }
    session.credential = null
    destroySession(session)
    return out
  }
  if (session.state === 'failed') {
    const out: CursorSessionAuthStatus = { status: 'failed', session_id: id, error: session.error ?? 'CURSOR_SESSION_LOGIN_FAILED' }
    destroySession(session)
    return out
  }
  if (session.state === 'cancelled') return null
  return { status: 'pending', session_id: id, verification_url: session.verificationUrl }
}

export function cancelCursorSessionAuth(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.state = 'cancelled'
  session.credential = null
  destroySession(session)
  return true
}

/** Test hook: wait for the background poll loop of a session to finish. */
export async function waitForCursorSessionAuthLoop(id: string): Promise<void> {
  await sessions.get(id)?.loop
}
