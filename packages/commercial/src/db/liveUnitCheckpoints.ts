import type { Pool, PoolClient } from "pg";
import {
  LIVE_UNITS_REDUCER_EPOCH,
  continueReduceLiveFrames,
  foldLiveUnitStateForCheckpoint,
  parseLiveUnitCheckpoint,
  reduceLiveFrames,
  type LiveFrameInput,
  type LiveUnitState,
} from "@openclaude/protocol";
import { liveUnitCheckpointEvents } from "../admin/metrics.js";

export const LIVE_UNIT_CHECKPOINT_DEBOUNCE_MS = 200;
export const LIVE_UNIT_CHECKPOINT_DEBOUNCE_FRAMES = 50;
export const LIVE_UNIT_CHECKPOINT_BATCH_LIMIT = 500;
export const LIVE_UNIT_CHECKPOINT_MAX_BATCHES_PER_FLUSH = 8;
export const LIVE_UNIT_CHECKPOINT_MAX_BYTES_PER_FLUSH = 8 * 1024 * 1024;
export const LIVE_UNIT_CHECKPOINT_STATEMENT_TIMEOUT_MS = 5_000;
export const LIVE_UNIT_CHECKPOINT_DEGRADED_MAX_ENTRIES = 4_096;
const WARN_THROTTLE_MS = 60_000;
const SLOW_FLUSH_WARN_MS = 1_000;

export type LiveUnitCheckpointDegradedReason = "fallback" | "budget" | "parse_error";

export type LiveUnitCheckpointRow = {
  streamKey: string;
  sessionId: string;
  userId: string;
  state: LiveUnitState;
};

type ScheduledJobInput = {
  pool: Pool;
  sessionId: string;
  userId: string;
  streamKey: string;
};

type PendingJob = ScheduledJobInput & {
  framesSinceFlush: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type LiveUnitCheckpointSchedulerHooks = {
  debounceMs?: number;
  debounceFrames?: number;
  batchLimit?: number;
  maxBatchesPerFlush?: number;
  maxBytesPerFlush?: number;
  statementTimeoutMs?: number;
  onWarn?: (message: string, fields: Record<string, unknown>) => void;
  flush?: (job: ScheduledJobInput) => Promise<void>;
};

const pending = new Map<string, PendingJob>();
const inFlight = new Set<string>();
const dirty = new Map<string, ScheduledJobInput>();
const degradedStreams = new Map<string, LiveUnitCheckpointDegradedReason>();
const lastWarnAt = new Map<string, number>();
let hooks: LiveUnitCheckpointSchedulerHooks = {};

function warnThrottled(key: string, message: string, fields: Record<string, unknown>): void {
  const now = Date.now();
  const prev = lastWarnAt.get(key) ?? 0;
  if (now - prev < WARN_THROTTLE_MS) return;
  lastWarnAt.set(key, now);
  if (lastWarnAt.size > LIVE_UNIT_CHECKPOINT_DEGRADED_MAX_ENTRIES) {
    const oldest = lastWarnAt.keys().next().value;
    if (oldest !== undefined) lastWarnAt.delete(oldest);
  }
  if (hooks.onWarn) {
    hooks.onWarn(message, fields);
  } else {
    console.warn(`[live-unit-checkpoints] ${message}`, fields);
  }
}

export function markLiveUnitCheckpointDegraded(
  streamKey: string,
  reason: LiveUnitCheckpointDegradedReason,
): void {
  if (!streamKey) return;
  const existed = degradedStreams.has(streamKey);
  if (existed) degradedStreams.delete(streamKey);
  degradedStreams.set(streamKey, reason);
  if (degradedStreams.size > LIVE_UNIT_CHECKPOINT_DEGRADED_MAX_ENTRIES) {
    const oldest = degradedStreams.keys().next().value;
    if (oldest !== undefined) degradedStreams.delete(oldest);
  }
  const job = pending.get(streamKey);
  if (job) {
    if (job.timer) clearTimeout(job.timer);
    pending.delete(streamKey);
  }
  dirty.delete(streamKey);
  if (!existed) {
    const outcome =
      reason === "budget"
        ? "degraded_budget"
        : reason === "parse_error"
          ? "degraded_parse"
          : "degraded_fallback";
    liveUnitCheckpointEvents.inc({ outcome });
    warnThrottled(`degraded:${streamKey}`, "marking live stream degraded; skipping future checkpoints", {
      streamKey,
      reason,
    });
  }
}

export function isLiveUnitCheckpointDegraded(streamKey: string): boolean {
  return degradedStreams.has(streamKey);
}

export function getLiveUnitCheckpointDegradedReason(
  streamKey: string,
): LiveUnitCheckpointDegradedReason | undefined {
  return degradedStreams.get(streamKey);
}

export function configureLiveUnitCheckpointScheduler(next: LiveUnitCheckpointSchedulerHooks): void {
  hooks = next;
}

export function resetLiveUnitCheckpointScheduler(): void {
  for (const job of pending.values()) {
    if (job.timer) clearTimeout(job.timer);
  }
  pending.clear();
  inFlight.clear();
  dirty.clear();
  degradedStreams.clear();
  lastWarnAt.clear();
  hooks = {};
}

/**
 * Fire-and-forget. Never throws. Call AFTER persistGatewayLiveFrame's
 * transaction commits — never inside that transaction, and never reduce
 * on the persist call stack.
 *
 * Guarantees per-stream singleflight (`inFlight` + `dirty` coalescing) and
 * O(1) circuit-breaking for degraded streams (OCV5-819).
 */
export function scheduleLiveUnitCheckpoint(
  pool: Pool,
  input: { sessionId: string; userId: string; streamKey: string; live: boolean },
): void {
  try {
    if (!input.live) return;
    if (!input.streamKey.startsWith("dispatch:")) return;
    if (degradedStreams.has(input.streamKey)) {
      liveUnitCheckpointEvents.inc({ outcome: "skipped_degraded" });
      return;
    }
    if (inFlight.has(input.streamKey)) {
      dirty.set(input.streamKey, {
        pool,
        sessionId: input.sessionId,
        userId: input.userId,
        streamKey: input.streamKey,
      });
      return;
    }
    const debounceMs = hooks.debounceMs ?? LIVE_UNIT_CHECKPOINT_DEBOUNCE_MS;
    const debounceFrames = hooks.debounceFrames ?? LIVE_UNIT_CHECKPOINT_DEBOUNCE_FRAMES;
    let job = pending.get(input.streamKey);
    if (!job) {
      job = {
        pool,
        sessionId: input.sessionId,
        userId: input.userId,
        streamKey: input.streamKey,
        framesSinceFlush: 0,
        timer: null,
      };
      pending.set(input.streamKey, job);
    }
    job.pool = pool;
    job.sessionId = input.sessionId;
    job.userId = input.userId;
    job.framesSinceFlush += 1;
    const run = () => {
      pending.delete(input.streamKey);
      if (job?.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      if (degradedStreams.has(input.streamKey)) {
        liveUnitCheckpointEvents.inc({ outcome: "skipped_degraded" });
        return;
      }
      if (inFlight.has(input.streamKey)) {
        dirty.set(input.streamKey, {
          pool: job.pool,
          sessionId: job.sessionId,
          userId: job.userId,
          streamKey: job.streamKey,
        });
        return;
      }
      inFlight.add(input.streamKey);
      const flush = hooks.flush ?? flushLiveUnitCheckpoint;
      void flush({
        pool: job.pool,
        sessionId: job.sessionId,
        userId: job.userId,
        streamKey: job.streamKey,
      })
        .catch((err) => {
          liveUnitCheckpointEvents.inc({ outcome: "error" });
          warnThrottled(`flush_err:${input.streamKey}`, "checkpoint flush rejected", {
            streamKey: input.streamKey,
            err: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          inFlight.delete(input.streamKey);
          const next = dirty.get(input.streamKey);
          if (next) {
            dirty.delete(input.streamKey);
            if (!degradedStreams.has(input.streamKey)) {
              scheduleLiveUnitCheckpoint(next.pool, { ...next, live: true });
            }
          }
        });
    };
    if (job.framesSinceFlush >= debounceFrames) {
      run();
      return;
    }
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(run, debounceMs);
    if (typeof job.timer.unref === "function") job.timer.unref();
  } catch {
    /* cache only */
  }
}

export async function flushLiveUnitCheckpoint(input: {
  pool: Pool;
  sessionId: string;
  userId: string;
  streamKey: string;
}): Promise<void> {
  if (degradedStreams.has(input.streamKey)) {
    liveUnitCheckpointEvents.inc({ outcome: "skipped_degraded" });
    return;
  }
  const startedAt = Date.now();
  const batchLimit = Math.max(1, hooks.batchLimit ?? LIVE_UNIT_CHECKPOINT_BATCH_LIMIT);
  const maxBatches = Math.max(1, hooks.maxBatchesPerFlush ?? LIVE_UNIT_CHECKPOINT_MAX_BATCHES_PER_FLUSH);
  const maxBytes = Math.max(1024, hooks.maxBytesPerFlush ?? LIVE_UNIT_CHECKPOINT_MAX_BYTES_PER_FLUSH);
  const statementTimeoutMs = Math.max(
    500,
    Math.trunc(hooks.statementTimeoutMs ?? LIVE_UNIT_CHECKPOINT_STATEMENT_TIMEOUT_MS),
  );

  let totalBytes = 0;
  let totalRows = 0;
  let state: LiveUnitState | null = null;
  let hasMoreAfterBatches = false;

  for (let batchIdx = 0; batchIdx < maxBatches; batchIdx += 1) {
    const remainingBytes = Math.max(0, maxBytes - totalBytes);
    if (remainingBytes === 0) {
      markLiveUnitCheckpointDegraded(input.streamKey, "budget");
      return;
    }
    let rows: Array<{
      record_id: string;
      stream_key: string;
      client_message_id: string | null;
      payload: Buffer | null;
      payload_sha256: string | null;
      nbytes?: string | number | null;
      rn?: string | number | null;
    }> = [];
    let existing: LiveUnitState | null = state;
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}'`);
      if (batchIdx === 0) {
        existing = await loadLiveUnitCheckpointForStream(client, input.streamKey);
      }
      const afterRecordId = existing?.throughRecordId ?? "0";
      // Compute cumulative octet_length inside PostgreSQL and join f.payload ONLY for
      // rows within [1..batchLimit] whose cumulative bytes <= remainingBytes. Lookahead
      // and first overflowing rows return payload=NULL sentinels so oversize bytea never
      // leaves PostgreSQL (OCV5-819 B2).
      rows = (
        await client.query<{
          record_id: string;
          stream_key: string;
          client_message_id: string | null;
          payload: Buffer | null;
          payload_sha256: string | null;
          nbytes?: string | number | null;
          rn?: string | number | null;
        }>(
          `WITH candidates AS (
             SELECT f.record_id, f.stream_key, s.client_message_id, f.payload_sha256,
                    octet_length(f.payload) AS nbytes,
                    ROW_NUMBER() OVER (ORDER BY f.record_id ASC) AS rn
               FROM client_session_live_streams s
               JOIN client_session_live_frames f ON f.stream_key = s.stream_key
              WHERE s.stream_key = $1
                AND s.projection_source = 'live'
                AND f.record_id > $2::bigint
              ORDER BY f.record_id ASC
              LIMIT $3
           ), picked AS (
             SELECT record_id, stream_key, client_message_id, payload_sha256, nbytes, rn,
                    SUM(nbytes) OVER (ORDER BY record_id ASC) AS cum_bytes
               FROM candidates
           )
           SELECT p.record_id::text, p.stream_key, p.client_message_id, p.payload_sha256, p.nbytes, p.rn,
                  CASE WHEN p.rn <= $4 AND p.cum_bytes <= $5 THEN f.payload ELSE NULL END AS payload
             FROM picked p
             LEFT JOIN client_session_live_frames f
               ON f.record_id = p.record_id
              AND p.rn <= $4
              AND p.cum_bytes <= $5
            WHERE (p.rn <= $4 AND p.cum_bytes <= $5)
               OR (p.rn <= $4 AND p.record_id = (
                    SELECT MIN(p2.record_id) FROM picked p2 WHERE p2.rn <= $4 AND p2.cum_bytes > $5
                  ))
               OR p.rn = $3
            ORDER BY p.record_id ASC`,
          [input.streamKey, afterRecordId, batchLimit + 1, batchLimit, remainingBytes],
        )
      ).rows;
      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      liveUnitCheckpointEvents.inc({ outcome: "error" });
      warnThrottled(`db_err:${input.streamKey}`, "checkpoint batch query failed", {
        streamKey: input.streamKey,
        sessionId: input.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    } finally {
      client.release();
    }

    const lookaheadIndex = rows.findIndex((r, idx) =>
      r.rn != null ? Number(r.rn) > batchLimit : idx >= batchLimit,
    );
    const batchHasMore = lookaheadIndex >= 0 || rows.length > batchLimit;
    const pageRows = lookaheadIndex >= 0 ? rows.slice(0, lookaheadIndex) : rows.slice(0, batchLimit);
    if (pageRows.length === 0) break;

    for (const row of pageRows) {
      if (row.payload == null) {
        markLiveUnitCheckpointDegraded(input.streamKey, "budget");
        return;
      }
      const rowBytes =
        row.nbytes != null && Number.isFinite(Number(row.nbytes))
          ? Number(row.nbytes)
          : Buffer.isBuffer(row.payload)
            ? row.payload.byteLength
            : Buffer.byteLength(String(row.payload), "utf8");
      totalBytes += rowBytes;
      if (totalBytes > maxBytes) {
        markLiveUnitCheckpointDegraded(input.streamKey, "budget");
        return;
      }
    }

    const frames: LiveFrameInput[] = [];
    for (const row of pageRows) {
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(row.payload!).toString("utf8"));
      } catch {
        markLiveUnitCheckpointDegraded(input.streamKey, "parse_error");
        return;
      }
      frames.push({
        recordId: row.record_id,
        streamKey: row.stream_key,
        clientMessageId: row.client_message_id,
        payload,
        ...(row.payload_sha256 ? { payloadSha256: row.payload_sha256 } : {}),
      });
    }
    totalRows += frames.length;

    const reduced: ReturnType<typeof reduceLiveFrames> = existing
      ? continueReduceLiveFrames(existing, frames)
      : reduceLiveFrames(frames);
    if (!reduced.ok) {
      markLiveUnitCheckpointDegraded(input.streamKey, "fallback");
      return;
    }
    state = reduced.state;
    if (!batchHasMore) {
      hasMoreAfterBatches = false;
      break;
    }
    hasMoreAfterBatches = true;
  }

  if (!state) return;

  try {
    const res = await upsertLiveUnitCheckpoint(input.pool, {
      streamKey: input.streamKey,
      sessionId: input.sessionId,
      userId: input.userId,
      state,
    });
    if (res.reason === "fold_overflow") {
      // Checkpoint JSON itself exceeded LIVE_UNITS_CHECKPOINT_MAX_BYTES; circuit-break
      // instead of rescheduling from record 0 forever (OCV5-819 B3).
      markLiveUnitCheckpointDegraded(input.streamKey, "budget");
      return;
    }
    if (res.written) liveUnitCheckpointEvents.inc({ outcome: "written" });
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_FLUSH_WARN_MS) {
      warnThrottled(`slow:${input.streamKey}`, "slow checkpoint flush", {
        streamKey: input.streamKey,
        sessionId: input.sessionId,
        elapsedMs,
        totalRows,
        totalBytes,
        hasMoreAfterBatches,
      });
    }
    // Only self-schedule another catch-up batch when persisted watermark ACTUALLY advanced
    // (`res.written === true`), preventing zero-progress rescan loops (OCV5-819 B3).
    if (res.written && hasMoreAfterBatches && !degradedStreams.has(input.streamKey)) {
      dirty.set(input.streamKey, {
        pool: input.pool,
        sessionId: input.sessionId,
        userId: input.userId,
        streamKey: input.streamKey,
      });
    }
  } catch (err) {
    liveUnitCheckpointEvents.inc({ outcome: "error" });
    warnThrottled(`upsert_err:${input.streamKey}`, "checkpoint upsert failed", {
      streamKey: input.streamKey,
      sessionId: input.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function loadLiveUnitCheckpointForStream(
  client: PoolClient,
  streamKey: string,
): Promise<LiveUnitState | null> {
  const row = (
    await client.query<{
      reducer_epoch: string;
      through_frame_seq: string;
      through_record_id: string;
      units_jsonb: unknown;
      session_key: string | null;
    }>(
      `SELECT reducer_epoch,through_frame_seq::text,through_record_id::text,units_jsonb,session_key
         FROM client_session_live_unit_checkpoints
        WHERE stream_key=$1`,
      [streamKey],
    )
  ).rows[0];
  if (!row) return null;
  return parseCheckpointRow(row);
}

export async function loadOpenDispatchLiveUnitCheckpoint(
  client: PoolClient,
  sessionId: string,
  userId: string,
  openDispatchSql: string,
): Promise<LiveUnitCheckpointRow | null> {
  const row = (
    await client.query<{
      stream_key: string;
      reducer_epoch: string;
      through_frame_seq: string;
      through_record_id: string;
      units_jsonb: unknown;
      session_key: string | null;
    }>(
      `SELECT c.stream_key,c.reducer_epoch,c.through_frame_seq::text,c.through_record_id::text,
              c.units_jsonb,c.session_key
         FROM client_session_live_unit_checkpoints c
         JOIN client_session_live_streams s ON s.stream_key=c.stream_key
        WHERE s.user_id=$2 AND s.session_id=$1
          AND ${openDispatchSql}
        ORDER BY c.through_record_id DESC
        LIMIT 1`,
      [sessionId, userId],
    )
  ).rows[0];
  if (!row) return null;
  const state = parseCheckpointRow(row);
  if (!state) return null;
  return { streamKey: row.stream_key, sessionId, userId, state };
}

export async function loadSessionLiveCheckpointUnits(
  client: PoolClient,
  sessionId: string,
  userId: string,
): Promise<import("@openclaude/protocol").LiveUnit[]> {
  const rows = (
    await client.query<{
      reducer_epoch: string;
      through_frame_seq: string;
      through_record_id: string;
      units_jsonb: unknown;
      session_key: string | null;
    }>(
      `SELECT c.reducer_epoch,c.through_frame_seq::text,c.through_record_id::text,
              c.units_jsonb,c.session_key
         FROM client_session_live_unit_checkpoints c
         JOIN client_session_live_streams s ON s.stream_key=c.stream_key
        WHERE s.session_id=$1 AND s.user_id=$2`,
      [sessionId, userId],
    )
  ).rows;
  const units: import("@openclaude/protocol").LiveUnit[] = [];
  for (const row of rows) {
    const state = parseCheckpointRow(row);
    if (state) units.push(...state.units);
  }
  return units;
}

function parseCheckpointRow(row: {
  reducer_epoch: string;
  through_frame_seq: string;
  through_record_id: string;
  units_jsonb: unknown;
  session_key: string | null;
}): LiveUnitState | null {
  if (row.reducer_epoch !== LIVE_UNITS_REDUCER_EPOCH) return null;
  const parsed = parseLiveUnitCheckpoint(row.units_jsonb);
  if (!parsed) return null;
  if (parsed.throughRecordId !== row.through_record_id) {
    parsed.throughRecordId = row.through_record_id;
  }
  if (Number(parsed.throughFrameSeq) !== Number(row.through_frame_seq)) {
    parsed.throughFrameSeq = Number(row.through_frame_seq);
  }
  if (row.session_key && !parsed.sessionKey) parsed.sessionKey = row.session_key;
  return parsed;
}

export async function upsertLiveUnitCheckpoint(
  pool: Pool,
  input: { streamKey: string; sessionId: string; userId: string; state: LiveUnitState },
): Promise<{ written: boolean; reason: "written" | "fold_overflow" | "not_newer" }> {
  if (input.state.throughFrameSeq <= 0 || input.state.throughRecordId === "0") {
    return { written: false, reason: "not_newer" };
  }
  const folded = foldLiveUnitStateForCheckpoint(input.state);
  if (!folded) return { written: false, reason: "fold_overflow" };
  // Allow a strictly newer reducer_epoch (e.g. epoch 4 replacing epoch 3) to overwrite
  // its first slice even if the old epoch had a higher through_frame_seq, while still
  // preventing an older epoch from overwriting a newer epoch (OCV5-819 B3).
  const result = await pool.query(
    `INSERT INTO client_session_live_unit_checkpoints
       (stream_key,session_id,user_id,reducer_epoch,through_frame_seq,through_record_id,units_jsonb,session_key,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW())
     ON CONFLICT (stream_key) DO UPDATE SET
       reducer_epoch=EXCLUDED.reducer_epoch,
       through_frame_seq=EXCLUDED.through_frame_seq,
       through_record_id=EXCLUDED.through_record_id,
       units_jsonb=EXCLUDED.units_jsonb,
       session_key=EXCLUDED.session_key,
       updated_at=NOW()
     WHERE (
       (
         CASE WHEN client_session_live_unit_checkpoints.reducer_epoch ~ '^[0-9]+$'
              THEN client_session_live_unit_checkpoints.reducer_epoch::int ELSE 0 END
       ) < (
         CASE WHEN EXCLUDED.reducer_epoch ~ '^[0-9]+$'
              THEN EXCLUDED.reducer_epoch::int ELSE 0 END
       )
     ) OR (
       client_session_live_unit_checkpoints.reducer_epoch = EXCLUDED.reducer_epoch
       AND client_session_live_unit_checkpoints.through_frame_seq < EXCLUDED.through_frame_seq
     )`,
    [
      input.streamKey,
      input.sessionId,
      input.userId,
      folded.state.reducerEpoch,
      folded.state.throughFrameSeq,
      folded.state.throughRecordId,
      JSON.parse(folded.json),
      folded.state.sessionKey ?? null,
    ],
  );
  const written = (result.rowCount ?? 0) > 0;
  return { written, reason: written ? "written" : "not_newer" };
}

export async function deleteLiveUnitCheckpoints(
  client: Pool | PoolClient,
  streamKeys: string[],
): Promise<number> {
  if (streamKeys.length === 0) return 0;
  const result = await client.query(
    `DELETE FROM client_session_live_unit_checkpoints
      WHERE stream_key = ANY($1::text[])`,
    [streamKeys],
  );
  return result.rowCount ?? 0;
}
