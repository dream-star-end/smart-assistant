/**
 * On-demand business-health snapshot (OCV5-180 I3).
 *
 * Independent of /healthz process liveness. Never flips ok=false. Timeouts and
 * unknown counts stay unknown — they must not be reported as 0. Not wired to
 * the 60s leader ticks (those must not scan live_frames/tape for exact COUNT).
 */
import type { Pool } from "pg";

import { auditLiveRetentionCoverage } from "./retentionRegistry.js";
import {
  classifyRetiredLiveJournals,
  type LiveJournalClassification,
} from "../db/liveFrameClassification.js";
import { isBoundedReadTimeout, withBoundedReadOnly } from "../db/boundedReadOnly.js";

export type BoundedCount =
  | { unknown: false; count: number; oldestAgeMs: number | null }
  | { unknown: true; count: null; oldestAgeMs: null; reason: string };

export interface BusinessHealthSnapshot {
  collectedAt: string;
  timeoutMs: number;
  limit: number;
  tapeMaterialization: BoundedCount;
  settlementHeld: BoundedCount;
  cursorAuditSuccessWithoutUsage: BoundedCount;
  liveFrames: LiveJournalClassification;
  retentionUnregistered: string[] | null;
  retentionUnknown: boolean;
  backupFreshness: "not_in_scope";
}

async function boundedCount(
  pool: Pool,
  timeoutMs: number,
  sql: string,
): Promise<BoundedCount> {
  try {
    return await withBoundedReadOnly(pool, timeoutMs, async (client) => {
      const result = await client.query<{ count: string | number; oldest: string | null }>(sql);
      const count = Number(result.rows[0]?.count ?? 0);
      const oldest = result.rows[0]?.oldest;
      const oldestAgeMs = oldest ? Math.max(0, Date.now() - Date.parse(oldest)) : null;
      return {
        unknown: false as const,
        count,
        oldestAgeMs: Number.isFinite(oldestAgeMs) ? oldestAgeMs : null,
      };
    });
  } catch (err) {
    return {
      unknown: true,
      count: null,
      oldestAgeMs: null,
      reason: isBoundedReadTimeout(err) ? "timeout" : ((err as Error)?.message ?? String(err)),
    };
  }
}

export async function collectBusinessHealthSnapshot(
  pool: Pool,
  options?: { statementTimeoutMs?: number; streamLimit?: number },
): Promise<BusinessHealthSnapshot> {
  const timeoutMs = options?.statementTimeoutMs ?? 5_000;
  const limit = options?.streamLimit ?? 50_000;
  const [tapeMaterialization, settlementHeld, cursorAuditSuccessWithoutUsage, liveFrames, retention] =
    await Promise.all([
      boundedCount(
        pool,
        timeoutMs,
        `SELECT COUNT(*)::bigint AS count, MIN(updated_at)::text AS oldest
           FROM turn_tape_materialization_jobs
          WHERE status = 'failed'`,
      ),
      boundedCount(
        pool,
        timeoutMs,
        `SELECT COUNT(*)::bigint AS count, MIN(updated_at)::text AS oldest
           FROM turn_tape_settlement_jobs
          WHERE status = 'held'`,
      ),
      boundedCount(
        pool,
        timeoutMs,
        `SELECT COUNT(*)::bigint AS count, MIN(a.created_at)::text AS oldest
           FROM cursor_external_usage_audit a
          WHERE a.status IN ('success','error')
            AND NOT EXISTS (
              SELECT 1 FROM usage_records u
               WHERE u.user_id = a.user_id AND u.request_id = a.request_id
            )`,
      ),
      classifyRetiredLiveJournals(pool, { statementTimeoutMs: timeoutMs, streamLimit: limit }),
      auditLiveRetentionCoverage(pool, { statementTimeoutMs: timeoutMs }),
    ]);
  return {
    collectedAt: new Date().toISOString(),
    timeoutMs,
    limit,
    tapeMaterialization,
    settlementHeld,
    cursorAuditSuccessWithoutUsage,
    liveFrames,
    retentionUnregistered: retention.unregistered,
    retentionUnknown: retention.unknown,
    backupFreshness: "not_in_scope",
  };
}
