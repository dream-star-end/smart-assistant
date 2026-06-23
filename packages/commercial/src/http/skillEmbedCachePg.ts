/**
 * Postgres-backed cross-tenant skill embedding cache (see migration 0081).
 *
 * Vectors are deterministic per (content_hash, backend_id, dimensions), so
 * writes are insert-once (ON CONFLICT DO NOTHING). Baseline skills shared by
 * every tenant are therefore embedded exactly once across the whole fleet.
 */
import { query } from '../db/queries.js'
import type { SkillEmbedCache, SkillSearchLogRow } from './internalSkillEmbed.js'

/**
 * Best-effort central feedback writer (migration 0082). Fire-and-forget: a
 * logging failure must never affect skill_search, so errors are swallowed.
 */
export function makePgSkillSearchLogger(): (row: SkillSearchLogRow) => void {
  return (row) => {
    void query(
      `INSERT INTO skill_search_log
         (user_id, container_id, raw_query, cleaned_query, method, ok, reason, returned, model, backend_id, dimensions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        row.userId,
        row.containerId,
        row.rawQuery.slice(0, 8000),
        row.cleanedQuery.slice(0, 4000),
        row.method,
        row.ok,
        row.reason ?? null,
        JSON.stringify(row.returned),
        row.model,
        row.backendId,
        row.dimensions,
      ],
    ).catch(() => {})
  }
}

function vecToBuffer(vec: Float32Array): Buffer {
  // Copy into a standalone buffer so we never serialize a view that shares (and
  // could outlive/alias) a larger pooled ArrayBuffer.
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

/**
 * Decode a BYTEA payload into an owned, 4-byte-aligned Float32Array. Returns
 * null on a malformed length rather than silently truncating — the caller then
 * treats the row as a cache miss (re-embed) instead of ranking on junk.
 */
function bufferToVec(buf: Buffer): Float32Array | null {
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return new Float32Array(ab)
}

export function makePgSkillEmbedCache(): SkillEmbedCache {
  return {
    async getMany(hashes, backendId, dimensions) {
      const out = new Map<string, Float32Array>()
      if (hashes.length === 0) return out
      const r = await query<{ content_hash: string; embedding: Buffer }>(
        `SELECT content_hash, embedding
           FROM skill_embedding_cache
          WHERE backend_id = $1 AND dimensions = $2 AND content_hash = ANY($3::text[])`,
        [backendId, dimensions, hashes],
      )
      for (const row of r.rows) {
        const vec = bufferToVec(row.embedding)
        if (vec && vec.length === dimensions) out.set(row.content_hash, vec)
      }
      return out
    },

    async putMany(entries, backendId, dimensions) {
      for (const e of entries) {
        await query(
          `INSERT INTO skill_embedding_cache (content_hash, backend_id, dimensions, embedding)
                VALUES ($1, $2, $3, $4)
           ON CONFLICT (content_hash, backend_id, dimensions) DO NOTHING`,
          [e.contentHash, backendId, dimensions, vecToBuffer(e.vec)],
        )
      }
    },
  }
}
