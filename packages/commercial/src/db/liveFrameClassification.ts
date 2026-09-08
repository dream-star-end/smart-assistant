/**
 * Read-only classification of live journals (OCV5-180 C2).
 *
 * Does not prune, retire, persist, or DELETE. 182 owns persistGatewayLiveFrame
 * write lines; this module only SELECTs. Hot 60s ticks must not call these
 * functions — use the on-demand CLI (I3) with statement_timeout + limit.
 */
import type { Pool, PoolClient } from "pg";

const DEFAULT_RETIRE_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STREAM_LIMIT = 50_000;

export type LiveJournalClassCounts = {
  streams: number;
  frames: number;
  bytes: number;
  oldestUpdatedAt: string | null;
};

export type LiveJournalClassification =
  | {
      unknown: false;
      truncated: boolean;
      inflight: LiveJournalClassCounts;
      tapeRecoverable: LiveJournalClassCounts;
      uniqueCopy: LiveJournalClassCounts;
    }
  | {
      unknown: true;
      reason: string;
      inflight: null;
      tapeRecoverable: null;
      uniqueCopy: null;
    };

export type LiveFrameRestoreDryRun = {
  unknown: boolean;
  reason?: string;
  tapeRecoverableSample: Array<{ streamKey: string; tapeId: string; reachable: boolean }>;
  uniqueCopySample: Array<{ streamKey: string; restore: "replay_live" }>;
};

function isTimeout(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === "57014" || /statement timeout/i.test(e.message ?? "");
}

function emptyCounts(): LiveJournalClassCounts {
  return { streams: 0, frames: 0, bytes: 0, oldestUpdatedAt: null };
}

async function withReadTimeout<T>(
  pool: Pool,
  timeoutMs: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL default_transaction_read_only = on");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

function rowToCounts(row: {
  streams?: string | number | null;
  frames?: string | number | null;
  bytes?: string | number | null;
  oldest_updated_at?: string | null;
} | undefined): LiveJournalClassCounts {
  if (!row) return emptyCounts();
  return {
    streams: Number(row.streams ?? 0),
    frames: Number(row.frames ?? 0),
    bytes: Number(row.bytes ?? 0),
    oldestUpdatedAt: row.oldest_updated_at ?? null,
  };
}

/**
 * Classify live journals into inflight / tape-recoverable / unique-copy.
 * Timeouts and query failures return unknown=true with null counts (never fake 0).
 */
export async function classifyRetiredLiveJournals(
  pool: Pool,
  options?: { statementTimeoutMs?: number; streamLimit?: number; retireMinAgeMs?: number },
): Promise<LiveJournalClassification> {
  const timeoutMs = options?.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const streamLimit = Math.max(1, Math.min(options?.streamLimit ?? DEFAULT_STREAM_LIMIT, 500_000));
  const retireMinAgeMs = options?.retireMinAgeMs ?? DEFAULT_RETIRE_MIN_AGE_MS;
  try {
    return await withReadTimeout(pool, timeoutMs, async (client) => {
      const bounded = await client.query<{ scanned: string | number }>(
        `SELECT COUNT(*)::bigint AS scanned FROM (
           SELECT 1 FROM client_session_live_streams
            ORDER BY updated_at ASC
            LIMIT $1
         ) s`,
        [streamLimit + 1],
      );
      const truncated = Number(bounded.rows[0]?.scanned ?? 0) > streamLimit;
      const rows = await client.query<{
        class: "inflight" | "tapeRecoverable" | "uniqueCopy";
        streams: string | number;
        frames: string | number;
        bytes: string | number;
        oldest_updated_at: string | null;
      }>(
        `WITH sampled AS (
           SELECT s.stream_key, s.projection_source, s.provenance, s.tape_id,
                  s.session_id, s.user_id, s.dispatch_id, s.updated_at
             FROM client_session_live_streams s
            ORDER BY s.updated_at ASC
            LIMIT $2
         ),
         classified AS (
           SELECT
             s.stream_key,
             s.updated_at,
             CASE
               WHEN s.projection_source = 'live'
                 AND NOT (s.provenance ? 'retired_at')
                 AND (
                   EXISTS (
                     SELECT 1 FROM turn_dispatches d
                      WHERE d.dispatch_id = s.dispatch_id
                        AND d.status IN ('accepted','admitted','rejecting')
                   )
                   OR s.updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')
                 )
               THEN 'inflight'
               WHEN s.projection_source = 'live'
                 AND (s.provenance ? 'retired_at')
                 AND s.tape_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM client_session_turn_tape_records r
                    WHERE r.session_id = s.session_id
                      AND r.user_id = s.user_id
                      AND r.tape_id = s.tape_id
                      AND octet_length(r.payload) > 0
                 )
               THEN 'tapeRecoverable'
               WHEN s.projection_source = 'live'
                 AND (s.provenance ? 'retired_at')
               THEN 'uniqueCopy'
               ELSE NULL
             END AS class
             FROM sampled s
         )
         SELECT c.class,
                COUNT(*)::bigint AS streams,
                COALESCE(SUM(f.frames), 0)::bigint AS frames,
                COALESCE(SUM(f.bytes), 0)::bigint AS bytes,
                MIN(c.updated_at)::text AS oldest_updated_at
           FROM classified c
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::bigint AS frames,
                    COALESCE(SUM(octet_length(fr.payload)), 0)::bigint AS bytes
               FROM client_session_live_frames fr
              WHERE fr.stream_key = c.stream_key
           ) f ON TRUE
          WHERE c.class IS NOT NULL
          GROUP BY c.class`,
        [retireMinAgeMs, streamLimit],
      );
      const byClass = new Map(rows.rows.map((row) => [row.class, row]));
      return {
        unknown: false,
        truncated,
        inflight: rowToCounts(byClass.get("inflight")),
        tapeRecoverable: rowToCounts(byClass.get("tapeRecoverable")),
        uniqueCopy: rowToCounts(byClass.get("uniqueCopy")),
      };
    });
  } catch (err) {
    return {
      unknown: true,
      reason: isTimeout(err) ? "timeout" : ((err as Error)?.message ?? String(err)),
      inflight: null,
      tapeRecoverable: null,
      uniqueCopy: null,
    };
  }
}

/** Dry-run restore probe. Zero writes. */
export async function dryRunLiveFrameRestore(
  pool: Pool,
  options?: { sampleN?: number; statementTimeoutMs?: number },
): Promise<LiveFrameRestoreDryRun> {
  const sampleN = Math.max(0, Math.min(options?.sampleN ?? 5, 50));
  const timeoutMs = options?.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (sampleN === 0) {
    return { unknown: false, tapeRecoverableSample: [], uniqueCopySample: [] };
  }
  try {
    return await withReadTimeout(pool, timeoutMs, async (client) => {
      const recoverable = await client.query<{ stream_key: string; tape_id: string; reachable: boolean }>(
        `SELECT s.stream_key, s.tape_id::text AS tape_id,
                EXISTS (
                  SELECT 1 FROM client_session_turn_tape_records r
                   WHERE r.session_id = s.session_id
                     AND r.user_id = s.user_id
                     AND r.tape_id = s.tape_id
                     AND octet_length(r.payload) > 0
                ) AS reachable
           FROM client_session_live_streams s
          WHERE s.projection_source = 'live'
            AND (s.provenance ? 'retired_at')
            AND s.tape_id IS NOT NULL
          ORDER BY s.updated_at ASC
          LIMIT $1`,
        [sampleN],
      );
      const unique = await client.query<{ stream_key: string }>(
        `SELECT s.stream_key
           FROM client_session_live_streams s
          WHERE s.projection_source = 'live'
            AND (s.provenance ? 'retired_at')
            AND (
              s.tape_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM client_session_turn_tape_records r
                 WHERE r.session_id = s.session_id
                   AND r.user_id = s.user_id
                   AND r.tape_id = s.tape_id
                   AND octet_length(r.payload) > 0
              )
            )
          ORDER BY s.updated_at ASC
          LIMIT $1`,
        [sampleN],
      );
      return {
        unknown: false,
        tapeRecoverableSample: recoverable.rows.map((row) => ({
          streamKey: row.stream_key,
          tapeId: row.tape_id,
          reachable: row.reachable === true,
        })),
        uniqueCopySample: unique.rows.map((row) => ({
          streamKey: row.stream_key,
          restore: "replay_live" as const,
        })),
      };
    });
  } catch (err) {
    return {
      unknown: true,
      reason: isTimeout(err) ? "timeout" : ((err as Error)?.message ?? String(err)),
      tapeRecoverableSample: [],
      uniqueCopySample: [],
    };
  }
}
