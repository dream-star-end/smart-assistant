/**
 * ChatGPT direct-connect proxy credentials.
 *
 * One Basic-auth secret per user. Only the scrypt hash is stored; plaintext is
 * returned exactly once from `issueCredential`. `verifyCredential` keeps a
 * short positive cache keyed by sha256(uid:secret) so a browser opening dozens
 * of CONNECT tunnels per page does not hit PostgreSQL every time.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import type { Pool } from 'pg'

const scrypt = promisify(scryptCb)

const SECRET_BYTES = 32
const SALT_BYTES = 16
const KEY_LEN = 32
const HASH_PREFIX = 'scrypt$'
const POSITIVE_CACHE_TTL_MS = 30_000
const NEGATIVE_CACHE_TTL_MS = 5_000
const CACHE_CAP = 4_096
const LAST_USED_THROTTLE_MS = 60_000

export interface ChatGptProxyCredentialInfo {
  hasCredential: boolean
  createdAt: string | null
  rotatedAt: string | null
  lastUsedAt: string | null
}

export interface IssuedChatGptProxyCredential {
  /** Plaintext secret; shown once, never stored. */
  secret: string
  rotatedAt: string
}

export async function hashChatGptProxySecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = (await scrypt(secret, salt, KEY_LEN)) as Buffer
  return `${HASH_PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyChatGptProxySecretHash(
  secret: string,
  stored: string,
): Promise<boolean> {
  if (!stored.startsWith(HASH_PREFIX)) return false
  const parts = stored.slice(HASH_PREFIX.length).split('$')
  if (parts.length !== 2) return false
  const salt = Buffer.from(parts[0]!, 'base64url')
  const expected = Buffer.from(parts[1]!, 'base64url')
  if (salt.byteLength !== SALT_BYTES || expected.byteLength !== KEY_LEN) return false
  const key = (await scrypt(secret, salt, KEY_LEN)) as Buffer
  return timingSafeEqual(key, expected)
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

export class ChatGptProxyCredentialStore {
  private readonly cache = new Map<string, { ok: boolean; expiresAt: number }>()
  private readonly lastTouched = new Map<number, number>()

  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
  ) {}

  async info(uid: number): Promise<ChatGptProxyCredentialInfo> {
    const r = await this.pool.query<{
      created_at: Date
      rotated_at: Date
      last_used_at: Date | null
    }>(
      `SELECT created_at, rotated_at, last_used_at
         FROM chatgpt_proxy_credentials
        WHERE user_id = $1::bigint AND revoked_at IS NULL
        LIMIT 1`,
      [uid],
    )
    if (r.rowCount === 0) {
      return { hasCredential: false, createdAt: null, rotatedAt: null, lastUsedAt: null }
    }
    const row = r.rows[0]!
    return {
      hasCredential: true,
      createdAt: iso(row.created_at),
      rotatedAt: iso(row.rotated_at),
      lastUsedAt: iso(row.last_used_at),
    }
  }

  /** Create or rotate. Old secret stops working immediately (cache is flushed). */
  async issue(uid: number): Promise<IssuedChatGptProxyCredential> {
    const secret = randomBytes(SECRET_BYTES).toString('base64url')
    const hash = await hashChatGptProxySecret(secret)
    const r = await this.pool.query<{ rotated_at: Date }>(
      `INSERT INTO chatgpt_proxy_credentials (user_id, secret_hash, created_at, rotated_at, last_used_at, revoked_at)
       VALUES ($1::bigint, $2, NOW(), NOW(), NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_hash = EXCLUDED.secret_hash,
             rotated_at = NOW(),
             last_used_at = NULL,
             revoked_at = NULL
       RETURNING rotated_at`,
      [uid, hash],
    )
    this.flushUser(uid)
    return { secret, rotatedAt: iso(r.rows[0]?.rotated_at) ?? new Date(this.now()).toISOString() }
  }

  async revoke(uid: number): Promise<void> {
    await this.pool.query(
      `UPDATE chatgpt_proxy_credentials
          SET revoked_at = NOW()
        WHERE user_id = $1::bigint AND revoked_at IS NULL`,
      [uid],
    )
    this.flushUser(uid)
  }

  /** Constant-time-ish verification with short positive/negative caching. */
  async verify(uid: number, secret: string): Promise<boolean> {
    if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) return false
    const now = this.now()
    const key = cacheKey(uid, secret)
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > now) return hit.ok

    const r = await this.pool.query<{ secret_hash: string }>(
      `SELECT secret_hash
         FROM chatgpt_proxy_credentials
        WHERE user_id = $1::bigint AND revoked_at IS NULL
        LIMIT 1`,
      [uid],
    )
    const ok =
      r.rowCount === 1 && (await verifyChatGptProxySecretHash(secret, r.rows[0]!.secret_hash))
    this.remember(key, ok, now)
    return ok
  }

  /** Throttled last_used_at bump; never throws. */
  touchLastUsed(uid: number): void {
    const now = this.now()
    const last = this.lastTouched.get(uid) ?? 0
    if (now - last < LAST_USED_THROTTLE_MS) return
    this.lastTouched.set(uid, now)
    void this.pool
      .query(
        `UPDATE chatgpt_proxy_credentials SET last_used_at = NOW()
          WHERE user_id = $1::bigint AND revoked_at IS NULL`,
        [uid],
      )
      .catch(() => undefined)
  }

  private remember(key: string, ok: boolean, now: number): void {
    if (this.cache.size >= CACHE_CAP) {
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k)
      }
      if (this.cache.size >= CACHE_CAP) {
        const first = this.cache.keys().next().value
        if (first !== undefined) this.cache.delete(first)
      }
    }
    this.cache.set(key, {
      ok,
      expiresAt: now + (ok ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
    })
  }

  private flushUser(uid: number): void {
    const prefix = `${uid}:`
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k)
    this.lastTouched.delete(uid)
  }
}

function cacheKey(uid: number, secret: string): string {
  return `${uid}:${createHash('sha256').update(secret, 'utf8').digest('hex')}`
}
