/** Independent browser proof. A container token or access JWT alone cannot approve writes. */
import type { IncomingMessage } from 'node:http'
import type { QueryRunner } from '../db/queries.js'
import { extractBearer } from '../http/auth.js'
import { HttpError } from '../http/util.js'
import { verifyAccess, refreshTokenHash, type AccessClaims } from './jwt.js'

export interface ActiveBrowserSession {
  id: string
  role: 'user' | 'admin'
  refreshFamilyId: string
  refreshSessionId: string
}
export interface BrowserConfirmationPrincipal extends ActiveBrowserSession {
  accessJti: string
  accessExpiresAt: number
}
const denied = () => new HttpError(403, 'BROWSER_CONFIRMATION_REQUIRED', '请在本人登录的第一方页面重新打开确认。')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Configuration only; never derive trust from the request Host or forwarded headers. */
export function normalizeConfirmationOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const value = new URL(raw)
    if (!['https:', 'http:'].includes(value.protocol) || value.username || value.password || value.search || value.hash || value.pathname !== '/') return null
    if (value.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)) return null
    return value.origin
  } catch { return null }
}
function uniqueHeader(req: IncomingMessage, name: string): string | null {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) count++
  const value = req.headers[name]
  if (count > 1 || typeof value !== 'string') return null
  return value
}
function strictRefreshCookie(req: IncomingMessage): string | null {
  const cookie = uniqueHeader(req, 'cookie')
  if (!cookie || cookie.length > 16_384) return null
  const matches = cookie.split(';').map(p => p.trim()).filter(p => p.startsWith('oc_rt='))
  if (matches.length !== 1) return null
  const value = matches[0]?.slice(6) ?? ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === 32 && decoded.toString('base64url') === value ? value : null
}

/** No rotation, last-used update, ensure-account, or grace/theft side effect. */
export async function findActiveRefreshSession(tokenHash: string, expectedUserId: string, runner: QueryRunner): Promise<ActiveBrowserSession | null> {
  if (!/^[a-f0-9]{64}$/.test(tokenHash) || !/^[1-9][0-9]*$/.test(expectedUserId)) return null
  const result = await runner.query<{
    id: string; role: string; refresh_session_id: string; refresh_family_id: string
  }>(`SELECT u.id::text AS id, u.role, rt.id::text AS refresh_session_id, rt.family_id::text AS refresh_family_id
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1 AND rt.user_id = $2::bigint
        AND rt.revoked_at IS NULL AND rt.rotated_to_id IS NULL AND rt.expires_at > CURRENT_TIMESTAMP
        AND u.status = 'active' AND u.role IN ('user', 'admin') LIMIT 1`, [tokenHash, expectedUserId])
  const row = result.rows[0]
  if (!row || row.id !== expectedUserId || !['user', 'admin'].includes(row.role) || !UUID.test(row.refresh_family_id) || !/^[1-9][0-9]*$/.test(row.refresh_session_id)) return null
  return { id: row.id, role: row.role as 'user' | 'admin', refreshFamilyId: row.refresh_family_id, refreshSessionId: row.refresh_session_id }
}

/** Use only on /api/auth/system-actions/... so the existing Path=/api/auth cookie is present. */
export async function requireBrowserConfirmationPrincipal(req: IncomingMessage, deps: {
  jwtSecret: string | Uint8Array
  firstPartyOrigin: string | null
  runner: QueryRunner
}): Promise<BrowserConfirmationPrincipal> {
  const configured = normalizeConfirmationOrigin(deps.firstPartyOrigin ?? undefined)
  if (!configured || configured !== deps.firstPartyOrigin || req.method !== 'POST' || uniqueHeader(req, 'origin') !== configured ||
      uniqueHeader(req, 'sec-fetch-site') !== 'same-origin' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(uniqueHeader(req, 'content-type') ?? '')) throw denied()
  if (!uniqueHeader(req, 'authorization')) throw denied()
  const bearer = extractBearer(req)
  const refresh = strictRefreshCookie(req)
  if (!bearer || !refresh) throw denied()
  let claims: AccessClaims
  try { claims = await verifyAccess(bearer, deps.jwtSecret) } catch { throw denied() }
  const active = await findActiveRefreshSession(refreshTokenHash(refresh), claims.sub, deps.runner)
  // A changed role must refresh its access identity before approving anything.
  if (!active || active.role !== claims.role) throw denied()
  return { ...active, accessJti: claims.jti, accessExpiresAt: claims.exp }
}
