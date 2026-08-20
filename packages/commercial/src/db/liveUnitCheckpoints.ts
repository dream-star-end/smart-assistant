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

export const LIVE_UNIT_CHECKPOINT_DEBOUNCE_MS = 200;
export const LIVE_UNIT_CHECKPOINT_DEBOUNCE_FRAMES = 50;

export type LiveUnitCheckpointRow = {
  streamKey: string;
  sessionId: string;
  userId: string;
  state: LiveUnitState;
};

type PendingJob = {
  pool: Pool;
  sessionId: string;
  userId: string;
  streamKey: string;
  framesSinceFlush: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type LiveUnitCheckpointSchedulerHooks = {
  debounceMs?: number;
  debounceFrames?: number;
  flush?: (job: { pool: Pool; sessionId: string; userId: string; streamKey: string }) => Promise<void>;
};

const pending = new Map<string, PendingJob>();
let hooks: LiveUnitCheckpointSchedulerHooks = {};

export function configureLiveUnitCheckpointScheduler(next: LiveUnitCheckpointSchedulerHooks): void {
  hooks = next;
}

export function resetLiveUnitCheckpointScheduler(): void {
  for (const job of pending.values()) {
    if (job.timer) clearTimeout(job.timer);
  }
  pending.clear();
  hooks = {};
}

/**
 * Fire-and-forget. Never throws. Call AFTER persistGatewayLiveFrame's
 * transaction commits — never inside that transaction, and never reduce
 * on the persist call stack.
 */
export function scheduleLiveUnitCheckpoint(
  pool: Pool,
  input: { sessionId: string; userId: string; streamKey: string; live: boolean },
): void {
  try {
    if (!input.live) return;
    if (!input.streamKey.startsWith("dispatch:")) return;
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
      const flush = hooks.flush ?? flushLiveUnitCheckpoint;
      void flush({
        pool: job.pool,
        sessionId: job.sessionId,
        userId: job.userId,
        streamKey: job.streamKey,
      }).catch(() => {
        /* cache only — frame path already committed */
      });
    };
    if (job.framesSinceFlush >= debounceFrames) {
      run();
      return;
    }
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(run, debounceMs);
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
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const existing = await loadLiveUnitCheckpointForStream(client, input.streamKey);
    const afterRecordId = existing?.throughRecordId ?? "0";
    const rows = (
      await client.query<{
        record_id: string;
        stream_key: string;
        client_message_id: string | null;
        payload: Buffer;
        payload_sha256: string | null;
      }>(
        `SELECT f.record_id::text,f.stream_key,s.client_message_id,f.payload,f.payload_sha256
           FROM client_session_live_streams s
           JOIN client_session_live_frames f ON f.stream_key=s.stream_key
          WHERE s.stream_key=$1
            AND s.projection_source='live'
            AND f.record_id>$2::bigint
          ORDER BY f.record_id`,
        [input.streamKey, afterRecordId],
      )
    ).rows;
    await client.query("COMMIT");
    if (rows.length === 0 && existing) return;
    const frames: LiveFrameInput[] = rows.map((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(row.payload).toString("utf8"));
      } catch {
        throw new Error(`durable live frame payload is not JSON: ${row.record_id}`);
      }
      return {
        recordId: row.record_id,
        streamKey: row.stream_key,
        clientMessageId: row.client_message_id,
        payload,
        ...(row.payload_sha256 ? { payloadSha256: row.payload_sha256 } : {}),
      };
    });
    const reduced = existing
      ? continueReduceLiveFrames(existing, frames)
      : reduceLiveFrames(frames);
    if (!reduced.ok) return;
    await upsertLiveUnitCheckpoint(input.pool, {
      streamKey: input.streamKey,
      sessionId: input.sessionId,
      userId: input.userId,
      state: reduced.state,
    });
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
  } finally {
    client.release();
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
): Promise<{ written: boolean }> {
  if (input.state.throughFrameSeq <= 0 || input.state.throughRecordId === "0") {
    return { written: false };
  }
  const folded = foldLiveUnitStateForCheckpoint(input.state);
  if (!folded) return { written: false };
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
     WHERE client_session_live_unit_checkpoints.through_frame_seq < EXCLUDED.through_frame_seq`,
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
  return { written: (result.rowCount ?? 0) > 0 };
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
