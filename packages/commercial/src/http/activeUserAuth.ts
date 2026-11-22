/**
 * Shared fail-closed authentication + active DB account check for Wave 4 commercial
 * user HTTP routes (pending-decisions, research library import/span, office-preview,
 * and swarm command).
 *
 * Security invariants (B2 / OCV5-832):
 *   1. Accepts Bearer JWT or `oc_session` HttpOnly cookie -> 401 UNAUTHORIZED if missing/invalid.
 *   2. Verifies the account is still `status = 'active'` in PG `users` table (role user/admin):
 *      - Inactive / suspended / banned / deleted -> 403 FORBIDDEN (before any read/write).
 *      - DB unavailable / query failure -> 503 AUTH_DB_UNAVAILABLE (strictly fail-closed;
 *        NEVER silently bypassed in production).
 */

import type { IncomingMessage } from 'node:http'
import type { Pool } from 'pg'
import { JwtError, verifyAccess } from '../auth/jwt.js'
import { getPool } from '../db/index.js'
import type { AuthedUser } from './auth.js'
import { getBearerToken, getSessionCookieToken } from './authHelpers.js'
import { requireActiveAccountVerifyDb } from './requireUser.js'
import { HttpError } from './util.js'

export interface ActiveCommercialUserAuthOpts {
  pool?: Pool
  /** Test seam ONLY: override active-account verification in unit tests without PG. */
  verifyActiveAccount?: (userId: string) => Promise<boolean>
  /** Test seam ONLY: explicitly skip DB active check in unit tests without PG. */
  skipDbActiveCheck?: boolean
}

export async function authenticateCommercialUser(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
): Promise<AuthedUser> {
  const token = getBearerToken(req) || getSessionCookieToken(req)
  if (!token) {
    throw new HttpError(401, 'UNAUTHORIZED', 'missing or malformed authorization header')
  }
  try {
    const claims = await verifyAccess(token, jwtSecret)
    return { id: claims.sub, role: claims.role, jti: claims.jti }
  } catch (err) {
    if (err instanceof JwtError) {
      throw new HttpError(401, 'UNAUTHORIZED', 'invalid or expired token')
    }
    throw err
  }
}

/**
 * Verify a commercial account is active in DB. Throws on DB unavailability (fail-closed).
 */
export async function checkCommercialAccountActiveDb(
  userId: string,
  pool?: Pool,
): Promise<boolean> {
  if (!/^\d+$/.test(userId)) return false
  const effectivePool = pool ?? getPool()
  const active = await requireActiveAccountVerifyDb(userId, ['user', 'admin'], effectivePool)
  return active !== null
}

/**
 * Authenticate caller (Bearer or `oc_session` cookie) AND fail-closed verify active
 * commercial account status in DB before any read or write.
 */
export async function authenticateActiveCommercialUser(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
  opts: ActiveCommercialUserAuthOpts = {},
): Promise<AuthedUser> {
  const user = await authenticateCommercialUser(req, jwtSecret)
  if (opts.skipDbActiveCheck) {
    return user
  }

  let isActive: boolean
  try {
    if (opts.verifyActiveAccount) {
      isActive = await opts.verifyActiveAccount(user.id)
    } else {
      isActive = await checkCommercialAccountActiveDb(user.id, opts.pool)
    }
  } catch {
    throw new HttpError(503, 'AUTH_DB_UNAVAILABLE', 'account verification unavailable')
  }

  if (!isActive) {
    throw new HttpError(403, 'FORBIDDEN', 'user account not active')
  }
  return user
}
