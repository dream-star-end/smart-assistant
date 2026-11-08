// Commercial conversation jobs: the Muse row is both execution journal and delivery outbox.
import { parseSessionKey } from '@openclaude/protocol'
import type { Pool } from 'pg'
import type { MuseJobSpec } from './protocol.js'
import { MuseError } from './protocol.js'

export const MUSE_LEASE_MS = 120_000
export const MUSE_BACKGROUND_TTL_MS = 7 * 24 * 60 * 60 * 1000
export interface MuseFence {
  owner: string
  nonce: string
}
export interface MuseDurableState {
  spec: MuseJobSpec
  sessionId: string
  agentId: string
  background: boolean
  backgroundFailures: number
  retryCount: number
  retryAt: number
  state: 'queued' | 'dispatched' | 'running'
  nonce: string
  expiresAt: number
}
export interface MuseRecoveredJob {
  id: string
  userId: string
  containerId: string | null
  price: string
  durable: MuseDurableState
}
export interface MuseDurability {
  validateOrigin(
    userId: string,
    sessionKey: string,
  ): Promise<{ sessionId: string; agentId: string }>
  save(id: string, owner: string, state: MuseDurableState): Promise<void>
  claim(owner: string, limit: number, online: boolean): Promise<MuseRecoveredJob[]>
  release(id: string, owner: string): Promise<void>
  protectedFile(id: string): Promise<boolean>
  deliver(): Promise<void>
}
export class MuseFenceLost extends Error {
  constructor() {
    super('MUSE_LEASE_LOST')
  }
}

export function createMuseDurability(
  pool: Pool,
  deliver: () => Promise<void>,
  originActive: (sessionId: string, userId: string) => Promise<boolean>,
): MuseDurability {
  return {
    async validateOrigin(userId, sessionKey) {
      let key: ReturnType<typeof parseSessionKey> | null = null
      try {
        key = parseSessionKey(sessionKey)
      } catch {
        /* invalid */
      }
      if (!key || key.channel !== 'webchat' || key.scope !== 'dm' || !key.peerId) {
        throw new MuseError(
          400,
          'MUSE_ORIGIN_REQUIRED',
          'Muse video requires the originating web conversation',
        )
      }
      if (!(await originActive(key.peerId, `c:${userId}`)))
        throw new MuseError(
          403,
          'MUSE_ORIGIN_INVALID',
          'conversation does not belong to this account',
        )
      return { sessionId: key.peerId, agentId: key.agentId }
    },
    async save(id, owner, state) {
      const r = await pool.query(
        `UPDATE muse_media_jobs SET durable=durable || $3::jsonb, lease_until=NOW()+INTERVAL '120 seconds'
         WHERE id=$1 AND lease_owner=$2 AND lease_until>NOW() AND status IN ('queued','running')`,
        [id, owner, JSON.stringify({ ...state, spec: undefined })],
      )
      if (r.rowCount !== 1) throw new MuseFenceLost()
    },
    async claim(owner, limit, online) {
      const r = await pool.query<{
        id: string
        user_id: string
        container_id: string | null
        price: string
        durable: MuseDurableState
      }>(
        `WITH candidates AS (
           SELECT id FROM muse_media_jobs WHERE durable IS NOT NULL
             AND status IN ('queued','running') AND lease_until<=NOW()
             AND ($3 OR durable->>'background'='false' OR (durable->>'expiresAt')::double precision BETWEEN 1 AND EXTRACT(EPOCH FROM NOW())*1000)
           ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT $2
         ) UPDATE muse_media_jobs j SET lease_owner=$1, lease_until=NOW()+INTERVAL '120 seconds'
           FROM candidates c WHERE j.id=c.id
           RETURNING j.id,j.user_id::text,j.container_id::text,j.price_credits::text AS price,j.durable || jsonb_build_object('spec', j.durable_payload) AS durable`,
        [owner, limit, online],
      )
      return r.rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        containerId: r.container_id,
        price: r.price,
        durable: r.durable,
      }))
    },
    async release(id, owner) {
      await pool.query(
        `UPDATE muse_media_jobs SET lease_until=NOW()
        WHERE id=$1 AND lease_owner=$2 AND status IN ('queued','running')`,
        [id, owner],
      )
    },
    async protectedFile(id) {
      // Retain until the existing 180-day Muse audit retention removes the row. No new sweeper.
      const r = await pool.query(
        'SELECT 1 FROM muse_media_jobs WHERE id=$1 AND durable IS NOT NULL',
        [id],
      )
      return Boolean(r.rowCount)
    },
    deliver,
  }
}
