import { createHmac, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = 10
const CODE_TTL_MS = 10 * 60 * 1000
const BIND_WINDOW_MS = 10 * 60 * 1000
const BIND_ATTEMPTS_PER_WINDOW = 5

export interface QqBindingView {
  bound: boolean
  maskedOpenid?: string
  boundAt?: number
  lastInteractionAt?: number
}

export interface QqBindingRow {
  userId: string
  openid: string
  bindingVersion: string
  boundAt: number
  lastInteractionAt: number
}

export type ConsumeBindCodeResult =
  | { kind: 'bound'; binding: QqBindingRow }
  | { kind: 'invalid' }
  | { kind: 'already_bound_elsewhere' }
  | { kind: 'rate_limited'; retryAfterMs: number }

function mac(secret: string, domain: 'code' | 'openid', value: string): Buffer {
  return createHmac('sha256', secret)
    .update(`v5-qq-${domain}\0`, 'utf8')
    .update(value, 'utf8')
    .digest()
}

export function normalizeBindCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '')
}

export function generateBindCode(rand: (size: number) => Buffer = randomBytes): string {
  const bytes = rand(CODE_LENGTH)
  let out = ''
  for (const byte of bytes) out += CODE_ALPHABET[byte! % CODE_ALPHABET.length]
  return out
}

export async function createBindCode(
  pool: Pool,
  userId: bigint | string,
  secret: string,
  now = Date.now(),
): Promise<{ code: string; expiresAt: number }> {
  const code = generateBindCode()
  const expiresAt = now + CODE_TTL_MS
  await pool.query(
    `INSERT INTO qq_bind_tokens (user_id, token_mac, created_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       token_mac  = EXCLUDED.token_mac,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at`,
    [String(userId), mac(secret, 'code', code), now, expiresAt],
  )
  return { code, expiresAt }
}

export async function getQqBinding(
  pool: Pool,
  userId: bigint | string,
): Promise<QqBindingRow | null> {
  const result = await pool.query<{
    user_id: string
    bot_openid: string
    binding_version: string
    bound_at: string
    last_interaction_at: string
  }>(
    `SELECT user_id, bot_openid, binding_version, bound_at, last_interaction_at
       FROM qq_bot_bindings
      WHERE user_id = $1`,
    [String(userId)],
  )
  const row = result.rows[0]
  return row
    ? {
        userId: row.user_id,
        openid: row.bot_openid,
        bindingVersion: row.binding_version,
        boundAt: Number(row.bound_at),
        lastInteractionAt: Number(row.last_interaction_at),
      }
    : null
}

export async function getQqBindingView(
  pool: Pool,
  userId: bigint | string,
): Promise<QqBindingView> {
  const binding = await getQqBinding(pool, userId)
  if (!binding) return { bound: false }
  const tail = Array.from(binding.openid).slice(-4).join('')
  return {
    bound: true,
    maskedOpenid: `••••${tail}`,
    boundAt: binding.boundAt,
    lastInteractionAt: binding.lastInteractionAt,
  }
}

export async function resolveQqBindingByOpenid(
  pool: Pool,
  openid: string,
): Promise<QqBindingRow | null> {
  const result = await pool.query<{
    user_id: string
    bot_openid: string
    binding_version: string
    bound_at: string
    last_interaction_at: string
  }>(
    `SELECT user_id, bot_openid, binding_version, bound_at, last_interaction_at
       FROM qq_bot_bindings
      WHERE bot_openid = $1`,
    [openid],
  )
  const row = result.rows[0]
  return row
    ? {
        userId: row.user_id,
        openid: row.bot_openid,
        bindingVersion: row.binding_version,
        boundAt: Number(row.bound_at),
        lastInteractionAt: Number(row.last_interaction_at),
      }
    : null
}

export async function touchQqBinding(
  pool: Pool,
  userId: string,
  bindingVersion: string,
  now = Date.now(),
): Promise<void> {
  await pool.query(
    `UPDATE qq_bot_bindings
        SET last_interaction_at = GREATEST(last_interaction_at, $3)
      WHERE user_id = $1 AND binding_version = $2`,
    [userId, bindingVersion, now],
  )
}

export async function consumeBindCode(
  pool: Pool,
  rawCode: string,
  openid: string,
  secret: string,
  now = Date.now(),
): Promise<ConsumeBindCodeResult> {
  const code = normalizeBindCode(rawCode)
  if (code.length !== CODE_LENGTH || !Array.from(code).every((c) => CODE_ALPHABET.includes(c))) {
    return { kind: 'invalid' }
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const attempt = await client.query<{ attempts: number; window_started_at: string }>(
      `INSERT INTO qq_bind_attempts
         (openid_mac, window_started_at, attempts, updated_at)
       VALUES ($1, $2, 1, $2)
       ON CONFLICT (openid_mac) DO UPDATE SET
         window_started_at = CASE
           WHEN qq_bind_attempts.window_started_at + $3 <= EXCLUDED.updated_at
             THEN EXCLUDED.updated_at
           ELSE qq_bind_attempts.window_started_at
         END,
         attempts = CASE
           WHEN qq_bind_attempts.window_started_at + $3 <= EXCLUDED.updated_at
             THEN 1
           ELSE qq_bind_attempts.attempts + 1
         END,
         updated_at = EXCLUDED.updated_at
       RETURNING attempts, window_started_at`,
      [mac(secret, 'openid', openid), now, BIND_WINDOW_MS],
    )
    const attempts = attempt.rows[0]!.attempts
    const windowStartedAt = Number(attempt.rows[0]!.window_started_at)
    if (attempts > BIND_ATTEMPTS_PER_WINDOW) {
      await client.query('COMMIT')
      return {
        kind: 'rate_limited',
        retryAfterMs: Math.max(1_000, windowStartedAt + BIND_WINDOW_MS - now),
      }
    }

    const token = await client.query<{ user_id: string }>(
      `SELECT user_id
         FROM qq_bind_tokens
        WHERE token_mac = $1 AND expires_at > $2
        FOR UPDATE`,
      [mac(secret, 'code', code), now],
    )
    const userId = token.rows[0]?.user_id
    if (!userId) {
      await client.query('COMMIT')
      return { kind: 'invalid' }
    }

    const owner = await client.query<{ user_id: string }>(
      'SELECT user_id FROM qq_bot_bindings WHERE bot_openid = $1 FOR UPDATE',
      [openid],
    )
    if (owner.rows[0] && owner.rows[0].user_id !== userId) {
      await client.query('COMMIT')
      return { kind: 'already_bound_elsewhere' }
    }

    const old = await client.query<{ binding_version: string }>(
      'SELECT binding_version FROM qq_bot_bindings WHERE user_id = $1 FOR UPDATE',
      [userId],
    )
    const bindingVersion = randomBytes(16).toString('hex')
    await client.query(
      `INSERT INTO qq_bot_bindings
         (user_id, bot_openid, binding_version, bound_at, last_interaction_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         bot_openid          = EXCLUDED.bot_openid,
         binding_version     = EXCLUDED.binding_version,
         bound_at            = EXCLUDED.bound_at,
         last_interaction_at = EXCLUDED.last_interaction_at`,
      [userId, openid, bindingVersion, now],
    )
    if (old.rows[0]) await cancelPendingOutbox(client, userId, now)
    await client.query('DELETE FROM qq_bind_tokens WHERE user_id = $1', [userId])
    await client.query('DELETE FROM qq_bind_attempts WHERE openid_mac = $1', [
      mac(secret, 'openid', openid),
    ])
    await client.query('COMMIT')
    return {
      kind: 'bound',
      binding: {
        userId,
        openid,
        bindingVersion,
        boundAt: now,
        lastInteractionAt: now,
      },
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    const pgError = err as { code?: unknown; constraint?: unknown }
    if (pgError.code === '23505' && pgError.constraint === 'qq_bot_bindings_bot_openid_key') {
      return { kind: 'already_bound_elsewhere' }
    }
    throw err
  } finally {
    client.release()
  }
}

export async function unbindQq(
  pool: Pool,
  userId: bigint | string,
  now = Date.now(),
): Promise<boolean> {
  const uid = String(userId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const binding = await client.query(
      'SELECT binding_version FROM qq_bot_bindings WHERE user_id = $1 FOR UPDATE',
      [uid],
    )
    await cancelPendingOutbox(client, uid, now)
    await client.query('DELETE FROM qq_bind_tokens WHERE user_id = $1', [uid])
    await client.query('DELETE FROM qq_running_sessions WHERE user_id = $1', [uid])
    await client.query('DELETE FROM qq_session_pointer WHERE user_id = $1', [uid])
    await client.query('DELETE FROM qq_bot_bindings WHERE user_id = $1', [uid])
    await client.query('COMMIT')
    return (binding.rowCount ?? 0) > 0
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function cancelPendingOutbox(client: PoolClient, userId: string, now: number): Promise<void> {
  await client.query(
    `UPDATE qq_outbox
        SET status = 'cancelled',
            cancelled_at = $2,
            locked_at = NULL,
            updated_at = $2
      WHERE user_id = $1 AND status IN ('queued','sending')`,
    [userId, now],
  )
}
