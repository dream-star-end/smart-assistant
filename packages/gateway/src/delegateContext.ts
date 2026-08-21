/**
 * Per-turn delegate caller binding.
 *
 * Cursor Shell env is model-controllable, so agentId / sessionKey / depth MUST
 * NOT be taken from env or body when a context token is present. The gateway
 * process mints an HMAC token with a process-lifetime key (not the shared
 * bearer). The CLI sends the opaque token; the gateway verifies and uses the
 * claims. A model can replay a stolen token (same-uid residual) but cannot mint
 * a new identity.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  TURN_LEASE_GRACE_MS,
} from '@openclaude/protocol'

export const DELEGATE_CONTEXT_HEADER = 'x-openclaude-delegate-context'
/**
 * Refreshed at every engine turn boundary. It must outlive the complete
 * platform turn plus settlement grace, otherwise an active 8h+ async delegate
 * can finish successfully but its captain can no longer retrieve the result.
 */
export const DELEGATE_CONTEXT_TTL_MS =
  AUTHORITY_TURN_MAX_LIFETIME_MS + TURN_LEASE_GRACE_MS

export type DelegateContextClaims = {
  v: 1
  agentId: string
  sessionKey: string
  depth: number
  iat: number
  exp: number
  nonce: string
}

let signingKey: Buffer | undefined

function getSigningKey(): Buffer {
  if (!signingKey) signingKey = randomBytes(32)
  return signingKey
}

/** Test-only: rotate the process key so leftover tokens fail closed. */
export function resetDelegateContextKeyForTests(): void {
  signingKey = randomBytes(32)
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSigningKey()).update(payload).digest('base64url')
}

export function issueDelegateContextToken(input: {
  agentId: string
  sessionKey: string
  depth: number
  now?: number
  ttlMs?: number
}): string {
  const now = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? DELEGATE_CONTEXT_TTL_MS
  const claims: DelegateContextClaims = {
    v: 1,
    agentId: input.agentId.trim(),
    sessionKey: input.sessionKey.trim(),
    depth: Number.isFinite(input.depth) ? Math.max(0, Math.floor(input.depth)) : 0,
    iat: now,
    exp: now + ttlMs,
    nonce: randomBytes(8).toString('hex'),
  }
  if (!claims.agentId || !claims.sessionKey) {
    throw new Error('delegate context requires agentId and sessionKey')
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${signPayload(payload)}`
}

export function verifyDelegateContextToken(
  raw: string | undefined,
  now = Date.now(),
): DelegateContextClaims | null {
  const token = String(raw ?? '').trim()
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!payload || !sig) return null
  const expected = signPayload(payload)
  const sigBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (sigBuf.length !== expectedBuf.length) return null
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null
  let claims: DelegateContextClaims
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DelegateContextClaims
    if (parsed?.v !== 1) return null
    if (typeof parsed.agentId !== 'string' || !parsed.agentId.trim()) return null
    if (typeof parsed.sessionKey !== 'string' || !parsed.sessionKey.trim()) return null
    if (typeof parsed.depth !== 'number' || !Number.isFinite(parsed.depth) || parsed.depth < 0) {
      return null
    }
    if (typeof parsed.exp !== 'number' || parsed.exp <= now) return null
    claims = parsed
  } catch {
    return null
  }
  return claims
}

export function readDelegateContextHeader(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined
  const direct = headers[DELEGATE_CONTEXT_HEADER]
  if (typeof direct === 'string') return direct
  const lower = headers[DELEGATE_CONTEXT_HEADER.toLowerCase()]
  return typeof lower === 'string' ? lower : undefined
}
