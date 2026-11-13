import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

import { HttpError } from '../http/util.js'

/**
 * MiniMax voice ownership (OCV5-589).
 *
 * Designed and cloned voices belong to the whole MiniMax account behind the
 * media key, so anyone who learns a voice_id could synthesize with it. Every
 * synthesis therefore checks that the voice is either a MiniMax system voice
 * or one this user created (`minimax_voices`, migration 0322). When the system
 * list cannot be fetched we fail closed: only the historic default voice and
 * the user's own voices pass.
 */

export const DEFAULT_SYSTEM_VOICE = 'male-qn-qingse'
const SYSTEM_VOICE_TTL_MS = 24 * 60 * 60 * 1000
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export interface SystemVoice {
  voiceId: string
  voiceName: string
  description: string[]
}

/** `oc<uid>x<12 base32>` — letter first, [A-Za-z0-9] only, 8..256 chars (MiniMax voice_id rules). */
export function generateVoiceId(
  userId: bigint,
  random: (n: number) => Buffer = randomBytes,
): string {
  const bytes = random(12)
  let suffix = ''
  for (const b of bytes) suffix += BASE32[b & 31]
  return `oc${userId.toString()}x${suffix}`
}

export function isGeneratedVoiceId(voiceId: string): boolean {
  return /^oc[0-9]+x[a-z2-7]{12}$/.test(voiceId)
}

export class SystemVoiceCache {
  private voices: SystemVoice[] | null = null
  private fetchedAt = 0
  private inflight: Promise<SystemVoice[] | null> | null = null

  constructor(
    private readonly fetchVoices: () => Promise<SystemVoice[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Current list; refreshes when stale. A failed refresh keeps the last good list (or null). */
  async get(): Promise<SystemVoice[] | null> {
    if (this.voices && this.now() - this.fetchedAt < SYSTEM_VOICE_TTL_MS) return this.voices
    if (!this.inflight) {
      this.inflight = this.fetchVoices()
        .then((list) => {
          this.voices = list
          this.fetchedAt = this.now()
          return list
        })
        .catch(() => this.voices)
        .finally(() => {
          this.inflight = null
        })
    }
    return await this.inflight
  }
}

export interface OwnedVoice {
  voiceId: string
  kind: 'design' | 'clone'
  label: string
  createdAt: string
  lastUsedAt: string | null
}

export async function findOwnedVoice(
  pool: Pool,
  userId: bigint,
  voiceId: string,
): Promise<OwnedVoice | null> {
  const r = await pool.query<{
    voice_id: string
    kind: 'design' | 'clone'
    label: string
    created_at: Date
    last_used_at: Date | null
  }>(
    `SELECT voice_id, kind, label, created_at, last_used_at FROM minimax_voices
      WHERE user_id=$1 AND voice_id=$2 AND status='active' AND deleted_at IS NULL`,
    [userId.toString(), voiceId],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    voiceId: row.voice_id,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  }
}

export async function listOwnedVoices(pool: Pool, userId: bigint): Promise<OwnedVoice[]> {
  const r = await pool.query<{
    voice_id: string
    kind: 'design' | 'clone'
    label: string
    created_at: Date
    last_used_at: Date | null
  }>(
    `SELECT voice_id, kind, label, created_at, last_used_at FROM minimax_voices
      WHERE user_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
    [userId.toString()],
  )
  return r.rows.map((row) => ({
    voiceId: row.voice_id,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  }))
}

export type VoiceAccess = { ok: true; owned: boolean } | { ok: false }

/** Owned voice → allowed; system voice → allowed; system list unknown → only the default voice. */
export async function checkVoiceAccess(
  pool: Pool,
  cache: SystemVoiceCache,
  userId: bigint,
  voiceId: string,
): Promise<VoiceAccess> {
  if (await findOwnedVoice(pool, userId, voiceId)) return { ok: true, owned: true }
  // Another user's generated id is never a system voice; skip the network.
  if (isGeneratedVoiceId(voiceId)) return { ok: false }
  const system = await cache.get()
  if (system === null)
    return voiceId === DEFAULT_SYSTEM_VOICE ? { ok: true, owned: false } : { ok: false }
  return system.some((v) => v.voiceId === voiceId) ? { ok: true, owned: false } : { ok: false }
}

const PENDING_STALE_MS = 15 * 60 * 1000

/**
 * Settlement request id for a voice creation. Namespaced so it can never collide with other media
 * calls of the same user (container request ids are 32 hex chars; studio take ids never start with
 * "voice:"), and replaying the settlement can never return an unrelated charge.
 */
export function voiceSettleRequestId(kind: 'design' | 'clone', requestId: string): string {
  return `voice:${kind}:${requestId}`
}

export type VoiceCreation =
  | { state: 'proceed'; voiceId: string }
  | { state: 'done'; voiceId: string; usageId: bigint | null }

/**
 * Idempotent voice creation, step 1 (before any upstream call). The row keyed by
 * (user_id, request_id) is the binding between a caller request and a voice id:
 *   none            → insert 'pending' with a fresh id → proceed
 *   active          → done (replay; no second upstream call, no second charge)
 *   pending, fresh  → 409 VOICE_CREATE_IN_PROGRESS
 *   pending (stale) / failed, already settled → activate the original voice → done
 *   pending (stale) / failed, never settled   → new id, back to 'pending' → proceed
 *   different params → 409 REQUEST_ID_REUSED
 */
export async function beginVoiceCreation(
  pool: Pool,
  args: {
    userId: bigint
    requestId: string
    paramsSha256: string
    kind: 'design' | 'clone'
    label: string
    prompt: string | null
    consent: Record<string, unknown> | null
    newVoiceId?: () => string
    now?: () => number
  },
): Promise<VoiceCreation> {
  const freshId = args.newVoiceId ?? (() => generateVoiceId(args.userId))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query<{ voice_id: string }>(
      `INSERT INTO minimax_voices (user_id, request_id, params_sha256, status, voice_id, kind, label, prompt, consent)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, request_id) DO NOTHING
       RETURNING voice_id`,
      [
        args.userId.toString(),
        args.requestId,
        args.paramsSha256,
        freshId(),
        args.kind,
        args.label.slice(0, 200),
        args.prompt,
        args.consent ? JSON.stringify(args.consent) : null,
      ],
    )
    if (inserted.rows[0]) {
      await client.query('COMMIT')
      return { state: 'proceed', voiceId: inserted.rows[0].voice_id }
    }
    const existing = await client.query<{
      voice_id: string
      status: string
      params_sha256: string
      usage_id: string | null
      updated_at: Date
    }>(
      `SELECT voice_id, status, params_sha256, usage_id::text AS usage_id, updated_at FROM minimax_voices
        WHERE user_id=$1 AND request_id=$2 FOR UPDATE`,
      [args.userId.toString(), args.requestId],
    )
    const row = existing.rows[0]
    if (!row) throw new Error('minimax voice row vanished')
    if (row.params_sha256 !== args.paramsSha256) {
      throw new HttpError(
        409,
        'REQUEST_ID_REUSED',
        'request id was already used with different parameters',
      )
    }
    if (row.status === 'active') {
      await client.query('COMMIT')
      return {
        state: 'done',
        voiceId: row.voice_id,
        usageId: row.usage_id === null ? null : BigInt(row.usage_id),
      }
    }
    const now = (args.now ?? Date.now)()
    if (row.status === 'pending' && now - row.updated_at.getTime() < PENDING_STALE_MS) {
      throw new HttpError(409, 'VOICE_CREATE_IN_PROGRESS', 'this voice is still being created')
    }
    // Reconcile before re-issuing an id (Codex plan r2 P1): settlement commits in its own
    // transaction before the row turns active, so a crash in between leaves a paid voice still
    // 'pending'. If this request was already settled, the original voice is the paid one —
    // activate it and replay instead of minting a new id.
    // Only this creation's own settlement counts (Codex code r1 P1): same namespaced request id,
    // same operation, and the same voice id recorded in output_meta.
    const settledUsage = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM minimax_media_usage_records
        WHERE user_id=$1 AND request_id=$2 AND status='success'
          AND operation=$3 AND output_meta->>'voice_id'=$4`,
      [
        args.userId.toString(),
        voiceSettleRequestId(args.kind, args.requestId),
        `voice_${args.kind}`,
        row.voice_id,
      ],
    )
    if (settledUsage.rows[0]) {
      await client.query(
        `UPDATE minimax_voices SET status='active', usage_id=$3, updated_at=NOW()
          WHERE user_id=$1 AND request_id=$2`,
        [args.userId.toString(), args.requestId, settledUsage.rows[0].id],
      )
      await client.query('COMMIT')
      return { state: 'done', voiceId: row.voice_id, usageId: BigInt(settledUsage.rows[0].id) }
    }
    const retried = await client.query<{ voice_id: string }>(
      `UPDATE minimax_voices SET voice_id=$3, status='pending', updated_at=NOW()
        WHERE user_id=$1 AND request_id=$2 RETURNING voice_id`,
      [args.userId.toString(), args.requestId, freshId()],
    )
    await client.query('COMMIT')
    return { state: 'proceed', voiceId: retried.rows[0]!.voice_id }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function completeVoiceCreation(
  pool: Pool,
  args: { userId: bigint; requestId: string; voiceId: string; usageId: bigint | null },
): Promise<void> {
  await pool.query(
    `UPDATE minimax_voices SET status='active', usage_id=$4, updated_at=NOW()
      WHERE user_id=$1 AND request_id=$2 AND voice_id=$3`,
    [
      args.userId.toString(),
      args.requestId,
      args.voiceId,
      args.usageId === null ? null : args.usageId.toString(),
    ],
  )
}

export async function failVoiceCreation(
  pool: Pool,
  args: { userId: bigint; requestId: string; voiceId: string },
): Promise<void> {
  await pool.query(
    `UPDATE minimax_voices SET status='failed', updated_at=NOW()
      WHERE user_id=$1 AND request_id=$2 AND voice_id=$3 AND status='pending'`,
    [args.userId.toString(), args.requestId, args.voiceId],
  )
}

export async function touchOwnedVoice(pool: Pool, userId: bigint, voiceId: string): Promise<void> {
  await pool.query(
    `UPDATE minimax_voices SET last_used_at=NOW() WHERE user_id=$1 AND voice_id=$2 AND status='active' AND deleted_at IS NULL`,
    [userId.toString(), voiceId],
  )
}
