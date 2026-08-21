import { createHash } from "node:crypto";
import {
  type LiveFrameInput,
  type LiveUnitsPage,
  type ServeLiveUnitsOptions,
  assembleLiveUnitsFromState,
  continueReduceLiveFrames,
  fallbackLiveUnitsPage,
  reduceLiveFrames,
} from "@openclaude/protocol";
import type { Pool, PoolClient } from "pg";
import {
  DISPATCH_LEASE_TTL_MS,
  touchDispatchLeaseOnLiveFrame,
} from "../dispatch/turnDispatchStore.js";
import {
  deleteLiveUnitCheckpoints,
  loadOpenDispatchLiveUnitCheckpoint,
  scheduleLiveUnitCheckpoint,
  upsertLiveUnitCheckpoint,
} from "./liveUnitCheckpoints.js";

export interface PersistGatewayLiveFrameInput {
  uid: bigint;
  sessionId: string;
  clientMessageId: string | null;
  agentContainerId: number;
  sessionKey: string;
  frameSeq: number;
  payload: string;
}

export interface ClientSessionLiveFrame {
  recordId: string;
  streamKey: string;
  source: "gateway" | "rollout_import";
  clientMessageId: string | null;
  payload: unknown;
}

export interface ClientSessionLiveFramePage {
  frames: ClientSessionLiveFrame[];
  nextCursor: string | null;
  hasMore: boolean;
  /** True when this page starts after earlier frames on the current open dispatch. */
  hasMoreBefore: boolean;
  streamClientMessageIds: string[];
  hasTapeProjection: boolean;
  /** tape 投影版本水位(tape 投影流计数,单调递增)。见 readClientSessionLiveFrames。 */
  tapeProjectionVersion: number;
}

export type ReadClientSessionLiveFramesOptions = {
  /** Opt-in last-page read. after=0 still pages forward unless this is set. */
  seekTail?: boolean;
};

/** Hot GET live-frames only reads live streams of in-flight dispatches. */
const OPEN_DISPATCH_STREAM_SQL = `s.projection_source='live'
            AND EXISTS (
              SELECT 1
                FROM turn_dispatches d
               WHERE d.session_id=s.session_id
                 AND d.status IN ('accepted','admitted','rejecting')
                 AND s.stream_key LIKE 'dispatch:' || d.dispatch_id::text || ':%'
            )`;

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Retrying the same live-frame journal write cannot resolve an identity or
 * immutable-payload conflict. The bridge duck-types this exact flag so these
 * permanent conflicts do not poison the outbound ordering barrier or close
 * the browser socket.
 */
export class LiveFramePermanentConflictError extends Error {
  readonly liveFramePermanentConflict = true as const;

  constructor(message: string) {
    super(message);
    this.name = "LiveFramePermanentConflictError";
  }
}

async function withTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  beginSql = "BEGIN",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(beginSql);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Persist one exact stamped container frame before it is eligible for browser
 * delivery.  The bridge serializes calls per container/session namespace;
 * this transaction additionally makes cross-tab duplicate writers strictly
 * idempotent and rejects same-identity/different-payload corruption.
 */
export async function persistGatewayLiveFrame(
  pool: Pool,
  input: PersistGatewayLiveFrameInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.agentContainerId) || input.agentContainerId <= 0) {
    throw new TypeError("invalid agentContainerId");
  }
  if (!Number.isSafeInteger(input.frameSeq) || input.frameSeq <= 0) {
    throw new TypeError("invalid frameSeq");
  }
  const payload = Buffer.from(input.payload, "utf8");
  const payloadSha256 = sha256(payload);
  const sessionUserId = `c:${input.uid.toString()}`;

  const persisted = await retryOnSerializationFailure(() => withTx(pool, async (client) => {
    // Lock the dispatch row BEFORE reading tape state, in a SEPARATE statement:
    // finalizeLosslessTurnTape takes the same row lock (see
    // convergeDispatchOnFinalize), and READ COMMITTED takes a per-statement
    // snapshot — the tape probe below runs only after the lock is ours, so a
    // finalize that committed while we waited is guaranteed visible. Folding
    // both into one statement would keep the stale pre-wait snapshot.
    const dispatch = input.clientMessageId === null
      ? null
      : (
          await client.query<{ dispatch_id: string; attempt_no: number }>(
            `SELECT dispatch_id::text,attempt_no
               FROM turn_dispatches
              WHERE user_id=$1 AND session_id=$2 AND client_message_id=$3
              FOR UPDATE`,
            [input.uid.toString(), input.sessionId, input.clientMessageId],
          )
        ).rows[0] ?? null;
    const streamKey = dispatch
      ? `dispatch:${dispatch.dispatch_id}:${dispatch.attempt_no}`
      : `legacy:${input.agentContainerId}:${input.sessionKey}`;
    // Any finalized tape (completed/interrupted/crashed) is the authoritative
    // projection for this stream. A turn whose only frame arrives AFTER its
    // tape finalized (crash before first live frame, then the terminal error
    // frame) must not mint a permanent orphan live stream.
    const finalizedTape = dispatch
      ? (
          await client.query<{ tape_id: string; status: string; tape_sha256: string }>(
            `SELECT tape_id,status,tape_sha256
               FROM client_session_turn_tapes
              WHERE dispatch_id=$1::uuid AND attempt_no=$2 AND finalized_at IS NOT NULL
              ORDER BY finalized_at DESC, tape_id DESC LIMIT 1`,
            [dispatch.dispatch_id, dispatch.attempt_no],
          )
        ).rows[0] ?? null
      : null;

    const stream = await client.query(
      `INSERT INTO client_session_live_streams
         (stream_key,session_id,user_id,client_message_id,dispatch_id,attempt_no,
          agent_container_id,source,projection_source,terminal_status,tape_id,tape_sha256)
       VALUES (
         $1,$2,$3,$4,$5::uuid,$6,$7,'gateway',
         $8,$9,$10,$11
       )
       ON CONFLICT (stream_key) DO UPDATE SET
         updated_at=NOW(),
         client_message_id=CASE
           WHEN EXCLUDED.dispatch_id IS NULL
             THEN COALESCE(EXCLUDED.client_message_id,client_session_live_streams.client_message_id)
           ELSE client_session_live_streams.client_message_id
         END
       WHERE client_session_live_streams.session_id=EXCLUDED.session_id
         AND client_session_live_streams.user_id=EXCLUDED.user_id
         AND client_session_live_streams.agent_container_id IS NOT DISTINCT FROM EXCLUDED.agent_container_id
         AND client_session_live_streams.source='gateway'
         AND (
           (
             EXCLUDED.dispatch_id IS NULL
             AND EXCLUDED.attempt_no IS NULL
             AND client_session_live_streams.dispatch_id IS NULL
             AND client_session_live_streams.attempt_no IS NULL
           )
           OR
           (
             EXCLUDED.dispatch_id IS NOT NULL
             AND client_session_live_streams.client_message_id IS NOT DISTINCT FROM EXCLUDED.client_message_id
             AND client_session_live_streams.dispatch_id IS NOT DISTINCT FROM EXCLUDED.dispatch_id
             AND client_session_live_streams.attempt_no IS NOT DISTINCT FROM EXCLUDED.attempt_no
           )
         )
       RETURNING stream_key`,
      [
        streamKey,
        input.sessionId,
        sessionUserId,
        input.clientMessageId,
        dispatch?.dispatch_id ?? null,
        dispatch?.attempt_no ?? null,
        input.agentContainerId,
        finalizedTape ? "tape" : "live",
        finalizedTape?.status ?? null,
        finalizedTape?.tape_id ?? null,
        finalizedTape?.tape_sha256 ?? null,
      ],
    );
    if ((stream.rowCount ?? 0) !== 1) {
      throw new LiveFramePermanentConflictError("live frame stream identity conflict");
    }

    type StoredGatewayFrame = {
      stream_key: string;
      payload_sha256: string;
      payload: Buffer;
    };
    const insertOrReadExisting = async (storageSessionKey: string): Promise<StoredGatewayFrame | null> => {
      const inserted = await client.query(
        `INSERT INTO client_session_live_frames
           (stream_key,source,agent_container_id,session_key,frame_seq,payload,payload_sha256)
         VALUES ($1,'gateway',$2,$3,$4,$5,$6)
         ON CONFLICT (agent_container_id,session_key,frame_seq)
           WHERE source='gateway' DO NOTHING
         RETURNING record_id`,
        [streamKey, input.agentContainerId, storageSessionKey, input.frameSeq, payload, payloadSha256],
      );
      if ((inserted.rowCount ?? 0) === 1) return null;

      return (
        await client.query<StoredGatewayFrame>(
          `SELECT stream_key,payload_sha256,payload
             FROM client_session_live_frames
            WHERE source='gateway' AND agent_container_id=$1 AND session_key=$2 AND frame_seq=$3
            FOR UPDATE`,
          [input.agentContainerId, storageSessionKey, input.frameSeq],
        )
      ).rows[0] ?? null;
    };
    const matchesCurrentFrame = (existing: StoredGatewayFrame | null): boolean =>
      existing !== null &&
      existing.stream_key === streamKey &&
      existing.payload_sha256 === payloadSha256 &&
      Buffer.from(existing.payload).equals(payload);

    const finish = async (): Promise<{ streamKey: string; live: boolean }> => {
      if (dispatch !== null && input.clientMessageId !== null) {
        await touchDispatchLeaseOnLiveFrame(client, {
          userId: input.uid,
          sessionId: input.sessionId,
          clientMessageId: input.clientMessageId,
          leaseTtlMs: DISPATCH_LEASE_TTL_MS,
        });
      }
      return { streamKey, live: finalizedTape == null };
    };

    const existing = await insertOrReadExisting(input.sessionKey);
    if (existing === null || matchesCurrentFrame(existing)) {
      return await finish();
    }
    if (existing.stream_key === streamKey) {
      throw new LiveFramePermanentConflictError("live frame immutable payload conflict");
    }

    // A destroyed gateway session can later reuse the same wire session key
    // after its outbound frame sequence restarts. Keep the first generation's
    // legacy identity, but namespace a later distinct stream (including a
    // server-authored stream without a dispatch) so one stale generation cannot
    // poison every subsequent frame on the user's shared WebSocket.
    const storageSessionKey = `v2:${JSON.stringify([input.sessionKey, streamKey])}`;
    const namespacedExisting = await insertOrReadExisting(storageSessionKey);
    if (namespacedExisting !== null && !matchesCurrentFrame(namespacedExisting)) {
      throw new LiveFramePermanentConflictError("live frame immutable payload conflict");
    }
    return await finish();
  }));
  // Reduce is a derived cache. Never await it on the persist stack; never run
  // it inside the frame transaction. Failures must not surface to the caller.
  scheduleLiveUnitCheckpoint(pool, {
    sessionId: input.sessionId,
    userId: sessionUserId,
    streamKey: persisted.streamKey,
    live: persisted.live,
  });
}

/** Hello catch-up byte budget. Matches fan-out `DEFAULT_MAX_BUFFERED_BYTES`. */
export const HELLO_LIVE_CATCHUP_MAX_BYTES = 4 * 1024 * 1024;
const WS_OPEN = 1;

export interface ReadOpenDispatchLiveFramePayloadsInput {
  uid: bigint;
  sessionId: string;
  afterFrameSeq: number;
  limit?: number;
  /** Cumulative payload-byte cap for this reconnect. Defaults to 4 MiB. */
  maxBytes?: number;
}

/** Hello catch-up row. Oversize sentinels never carry payload bytes. */
export type LiveCatchupReadItem =
  | { kind: "payload"; payload: string }
  | { kind: "oversize"; frameSeq: number; nbytes: number };

/**
 * Decide whether this reconnect WS can take one more catch-up payload.
 * `backpressure` means close only this socket and stop this catch-up —
 * never tear down the rest of the bridge.
 */
export function liveCatchupSendDecision(
  readyState: number,
  bufferedAmount: number,
  payloadBytes: number,
  maxBufferedBytes: number,
): "send" | "stop" | "backpressure" {
  if (readyState !== WS_OPEN) return "stop";
  const payload = Number.isSafeInteger(payloadBytes) && payloadBytes >= 0 ? payloadBytes : 0;
  const buffered = Number.isSafeInteger(bufferedAmount) && bufferedAmount >= 0 ? bufferedAmount : 0;
  const budget = Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes > 0
    ? maxBufferedBytes
    : HELLO_LIVE_CATCHUP_MAX_BYTES;
  if (buffered + payload > budget) return "backpressure";
  return "send";
}

/**
 * Hello/reconnect catch-up: exact stamped payloads for the current open
 * dispatch of one uid+session, after the client's wire frameSeq cursor.
 * Missing/non-positive cursor starts at the stream head. Isolation is the
 * query predicate (user_id + session_id + open dispatch stream key) — never
 * returns another user's or another session's frames.
 */
export async function readOpenDispatchLiveFramePayloadsAfterSeq(
  q: Pick<Pool, "query">,
  input: ReadOpenDispatchLiveFramePayloadsInput,
): Promise<LiveCatchupReadItem[]> {
  const after = Number.isSafeInteger(input.afterFrameSeq) && input.afterFrameSeq > 0
    ? input.afterFrameSeq
    : 0;
  const limit = Number.isSafeInteger(input.limit)
    ? Math.max(1, Math.min(500, Math.trunc(input.limit as number)))
    : 500;
  const maxBytes = Number.isSafeInteger(input.maxBytes) && (input.maxBytes as number) > 0
    ? Math.trunc(input.maxBytes as number)
    : HELLO_LIVE_CATCHUP_MAX_BYTES;
  const sessionUserId = `c:${input.uid.toString()}`;
  // Metadata CTE reads octet_length only so a 500-row LIMIT cannot materialize
  // hundreds of MiB of payload. Payload is joined only for rows whose cumulative
  // bytes still sit at or under the budget. The first overflowing row comes back
  // as metadata (frame_seq + nbytes) with payload NULL so this reconnect can
  // fail-closed without ever loading the oversize bytes.
  const res = await q.query<{
    payload: Buffer | null;
    frame_seq: string | number;
    nbytes: string | number;
  }>(
    `WITH candidates AS (
       SELECT f.stream_key, f.frame_seq, octet_length(f.payload) AS nbytes
         FROM client_session_live_streams s
         JOIN client_session_live_frames f ON f.stream_key = s.stream_key
        WHERE s.session_id = $2
          AND s.user_id = $3
          AND s.projection_source = 'live'
          AND EXISTS (
            SELECT 1
              FROM turn_dispatches d
             WHERE d.user_id = $1
               AND d.session_id = s.session_id
               AND d.status IN ('accepted', 'admitted')
               AND d.terminal_at IS NULL
               AND s.stream_key LIKE 'dispatch:' || d.dispatch_id::text || ':%'
          )
          AND f.frame_seq > $4
        ORDER BY f.frame_seq ASC
        LIMIT $5
     ), picked AS (
       SELECT stream_key, frame_seq, nbytes,
              SUM(nbytes) OVER (ORDER BY frame_seq ASC) AS cum_bytes
         FROM candidates
     )
     SELECT p.frame_seq, p.nbytes, f.payload
       FROM picked p
       LEFT JOIN client_session_live_frames f
         ON f.stream_key = p.stream_key
        AND f.frame_seq = p.frame_seq
        AND p.cum_bytes <= $6
      WHERE p.cum_bytes <= $6
         OR p.frame_seq = (
              SELECT MIN(p2.frame_seq) FROM picked p2 WHERE p2.cum_bytes > $6
            )
      ORDER BY p.frame_seq ASC`,
    [input.uid.toString(), input.sessionId, sessionUserId, after, limit, maxBytes],
  );
  const out: LiveCatchupReadItem[] = [];
  for (const row of res.rows) {
    if (row.payload == null) {
      const frameSeq = Number(row.frame_seq);
      const nbytes = Number(row.nbytes);
      out.push({
        kind: "oversize",
        frameSeq: Number.isSafeInteger(frameSeq) ? frameSeq : 0,
        nbytes: Number.isSafeInteger(nbytes) ? nbytes : 0,
      });
      continue;
    }
    out.push({ kind: "payload", payload: Buffer.from(row.payload).toString("utf8") });
  }
  return out;
}


/**
 * Self-heal only the retry-safe serialization failures. The dispatch-row lock
 * taken by persistGatewayLiveFrame opposes the finalize transaction's
 * session→dispatch order, and turnDispatchReconciler locks dispatch→session,
 * so an occasional 40P01/40001 abort is expected and harmless to retry: every
 * statement in the frame transaction is idempotent (ON CONFLICT / FOR UPDATE
 * re-read). All other errors propagate untouched.
 */
async function retryOnSerializationFailure<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if ((code !== "40P01" && code !== "40001") || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

export async function readClientSessionLiveFrames(
  pool: Pool,
  sessionId: string,
  userId: string,
  afterRecordId = 0,
  limit = 200,
  options?: ReadClientSessionLiveFramesOptions,
): Promise<ClientSessionLiveFramePage | null> {
  const cursor = Number.isSafeInteger(afterRecordId) && afterRecordId >= 0 ? afterRecordId : 0;
  const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 200;
  const wantTail = options?.seekTail === true;
  return withTx(pool, async (client) => {
    const session = await client.query(
      "SELECT 1 FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, userId],
    );
    if ((session.rowCount ?? 0) !== 1) return null;

    const streams = await client.query<{
      client_message_id: string | null;
      projection_source: "live" | "tape";
      retired: boolean;
      superseded_by_completed_tape: boolean;
      tape_projection_version: string | number;
      open_dispatch: boolean;
    }>(
      `SELECT client_message_id,projection_source,
              (provenance ? 'retired_at') AS retired,
              (
                client_message_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                    FROM client_session_turn_tapes t
                   WHERE t.session_id=client_session_live_streams.session_id
                     AND t.user_id=client_session_live_streams.user_id
                     AND t.client_message_id=client_session_live_streams.client_message_id
                     AND t.status='completed'
                     AND t.finalized_at IS NOT NULL
                )
              ) AS superseded_by_completed_tape,
              COUNT(*) FILTER (WHERE projection_source='tape')
                OVER ()::text AS tape_projection_version,
              EXISTS (
                SELECT 1
                  FROM turn_dispatches d
                 WHERE d.session_id=client_session_live_streams.session_id
                   AND d.status IN ('accepted','admitted','rejecting')
                   AND client_session_live_streams.stream_key
                     LIKE 'dispatch:' || d.dispatch_id::text || ':%'
              ) AS open_dispatch
         FROM client_session_live_streams
        WHERE session_id=$1 AND user_id=$2
        ORDER BY created_at,stream_key`,
      [sessionId, userId],
    );
    const streamClientMessageIds = [...new Set(
      streams.rows
        .filter((row) =>
          row.projection_source === "live"
          && !row.retired
          && !row.superseded_by_completed_tape
          && row.open_dispatch
        )
        .map((row) => row.client_message_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    )];

    // Hot path never reads leftover legacy:*, tapeless cmid-less streams, or
    // taped old live journals. Only the current accepted/admitted/rejecting
    // dispatch's dispatch:<id>:% stream. No in-flight dispatch → empty page;
    // the browser already has history from GET /api/sessions tape.
    // after=0 pages that dispatch forward from the stream head. seekTail is
    // opt-in only; a raw tail page is not a renderable snapshot.
    const seekTail = wantTail;

    const rows = (
      await client.query<{
        record_id: string;
        stream_key: string;
        source: "gateway" | "rollout_import";
        client_message_id: string | null;
        payload: Buffer;
      }>(
        seekTail
          ? `SELECT record_id::text,stream_key,source,client_message_id,payload
               FROM (
                 SELECT f.record_id,f.stream_key,f.source,s.client_message_id,f.payload
                   FROM client_session_live_streams s
                   JOIN client_session_live_frames f ON f.stream_key=s.stream_key
                  WHERE s.user_id=$2 AND s.session_id=$1
                    AND ${OPEN_DISPATCH_STREAM_SQL}
                  ORDER BY f.record_id DESC
                  LIMIT $3
               ) tail
              ORDER BY record_id`
          : `SELECT f.record_id::text,f.stream_key,f.source,s.client_message_id,f.payload
               FROM client_session_live_streams s
               CROSS JOIN LATERAL (
                 SELECT fr.record_id,fr.stream_key,fr.source,fr.payload
                   FROM client_session_live_frames fr
                  WHERE fr.stream_key=s.stream_key
                    AND fr.record_id>$3::bigint
                  ORDER BY fr.record_id
                  LIMIT $4
               ) f
              WHERE s.user_id=$2 AND s.session_id=$1
                AND ${OPEN_DISPATCH_STREAM_SQL}
              ORDER BY f.record_id
              LIMIT $4`,
        seekTail
          ? [sessionId, userId, pageSize + 1]
          : [sessionId, userId, cursor, pageSize + 1],
      )
    ).rows;
    let hasMore = false;
    let hasMoreBefore = false;
    let page = rows;
    if (seekTail) {
      hasMore = false;
      if (rows.length > pageSize) {
        hasMoreBefore = true;
        page = rows.slice(1);
      }
    } else {
      hasMore = rows.length > pageSize;
      page = hasMore ? rows.slice(0, pageSize) : rows;
      if (cursor > 0) {
        const older = await client.query(
          `SELECT 1
             FROM client_session_live_streams s
             JOIN client_session_live_frames fr ON fr.stream_key=s.stream_key
            WHERE s.user_id=$2 AND s.session_id=$1
              AND ${OPEN_DISPATCH_STREAM_SQL}
              AND fr.record_id<=$3::bigint
            LIMIT 1`,
          [sessionId, userId, cursor],
        );
        hasMoreBefore = (older.rowCount ?? 0) > 0;
      }
    }
    const frames = page.map((row): ClientSessionLiveFrame => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(row.payload).toString("utf8"));
      } catch {
        throw new Error(`durable live frame payload is not JSON: ${row.record_id}`);
      }
      return {
        recordId: row.record_id,
        streamKey: row.stream_key,
        source: row.source,
        clientMessageId: row.client_message_id,
        payload: parsed,
      };
    });
    const versionRaw = streams.rows[0]?.tape_projection_version;
    const tapeProjectionVersion =
      typeof versionRaw === "number" && Number.isSafeInteger(versionRaw) && versionRaw >= 0
        ? versionRaw
        : Number.parseInt(String(versionRaw ?? "0"), 10) || 0;
    return {
      frames,
      hasMore,
      hasMoreBefore,
      nextCursor: frames.length > 0 ? frames[frames.length - 1]!.recordId : null,
      streamClientMessageIds,
      hasTapeProjection: streams.rows.some((row) => row.projection_source === "tape"),
      // tape 投影版本水位 = 当前 tape 投影流计数,单调递增(完成只增不减)。
      // 客户端据此识别"两次水合之间发生的 live→tape 切换"(含断连期间完成的
      // turn),一次性布尔标记对那种场景是盲的(codex 审计 blocker)。
      tapeProjectionVersion,
    };
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
}

export type ReadClientSessionLiveUnitsOptions = ServeLiveUnitsOptions & {
  deadlineMs?: number;
};

function parseLiveFrameRow(row: {
  record_id: string;
  stream_key: string;
  client_message_id: string | null;
  payload: Buffer;
  payload_sha256?: string | null;
}): LiveFrameInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(row.payload).toString("utf8"));
  } catch {
    throw new Error(`durable live frame payload is not JSON: ${row.record_id}`);
  }
  return {
    recordId: row.record_id,
    streamKey: row.stream_key,
    clientMessageId: row.client_message_id,
    payload: parsed,
    ...(row.payload_sha256 ? { payloadSha256: row.payload_sha256 } : {}),
  };
}

async function readOpenDispatchStreamMeta(
  client: PoolClient,
  sessionId: string,
  userId: string,
): Promise<{
  streamClientMessageIds: string[];
  openDispatch: boolean;
  hasTapeProjection: boolean;
  tapeProjectionVersion: number;
} | null> {
  const session = await client.query(
    "SELECT 1 FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
    [sessionId, userId],
  );
  if ((session.rowCount ?? 0) !== 1) return null;
  const streams = await client.query<{
    client_message_id: string | null;
    projection_source: "live" | "tape";
    retired: boolean;
    superseded_by_completed_tape: boolean;
    tape_projection_version: string | number;
    open_dispatch: boolean;
  }>(
    `SELECT client_message_id,projection_source,
            (provenance ? 'retired_at') AS retired,
            (
              client_message_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM client_session_turn_tapes t
                 WHERE t.session_id=client_session_live_streams.session_id
                   AND t.user_id=client_session_live_streams.user_id
                   AND t.client_message_id=client_session_live_streams.client_message_id
                   AND t.status='completed'
                   AND t.finalized_at IS NOT NULL
              )
            ) AS superseded_by_completed_tape,
            COUNT(*) FILTER (WHERE projection_source='tape')
              OVER ()::text AS tape_projection_version,
            EXISTS (
              SELECT 1
                FROM turn_dispatches d
               WHERE d.session_id=client_session_live_streams.session_id
                 AND d.status IN ('accepted','admitted','rejecting')
                 AND client_session_live_streams.stream_key
                   LIKE 'dispatch:' || d.dispatch_id::text || ':%'
            ) AS open_dispatch
       FROM client_session_live_streams
      WHERE session_id=$1 AND user_id=$2
      ORDER BY created_at,stream_key`,
    [sessionId, userId],
  );
  const streamClientMessageIds = [...new Set(
    streams.rows
      .filter((row) =>
        row.projection_source === "live"
        && !row.retired
        && !row.superseded_by_completed_tape
        && row.open_dispatch
      )
      .map((row) => row.client_message_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
  const versionRaw = streams.rows[0]?.tape_projection_version;
  const tapeProjectionVersion =
    typeof versionRaw === "number" && Number.isSafeInteger(versionRaw) && versionRaw >= 0
      ? versionRaw
      : Number.parseInt(String(versionRaw ?? "0"), 10) || 0;
  return {
    streamClientMessageIds,
    openDispatch: streams.rows.some((row) => row.open_dispatch),
    hasTapeProjection: streams.rows.some((row) => row.projection_source === "tape"),
    tapeProjectionVersion,
  };
}

/**
 * Query-time reduce of the current open-dispatch live journal into renderable
 * units. Catch-up is a second query after the snapshot (not optional): WS does
 * not replay frames persisted before subscribe, so resume.frameSeq is only
 * minted after this extra scan reaches the true tail.
 */
export async function readClientSessionLiveUnits(
  pool: Pool,
  sessionId: string,
  userId: string,
  options?: ReadClientSessionLiveUnitsOptions,
): Promise<LiveUnitsPage | null> {
  const snapshot = await withTx(pool, async (client) => {
    const meta = await readOpenDispatchStreamMeta(client, sessionId, userId);
    if (!meta) return null;
    if (meta.streamClientMessageIds.length === 0) {
      return { meta, frames: [] as LiveFrameInput[], checkpoint: null as Awaited<ReturnType<typeof loadOpenDispatchLiveUnitCheckpoint>> };
    }
    const checkpoint = await loadOpenDispatchLiveUnitCheckpoint(
      client,
      sessionId,
      userId,
      OPEN_DISPATCH_STREAM_SQL,
    );
    const afterRecordId = checkpoint ? checkpoint.state.throughRecordId : "0";
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
          WHERE s.user_id=$2 AND s.session_id=$1
            AND ${OPEN_DISPATCH_STREAM_SQL}
            AND f.record_id>$3::bigint
          ORDER BY f.record_id`,
        [sessionId, userId, afterRecordId],
      )
    ).rows;
    return { meta, frames: rows.map(parseLiveFrameRow), checkpoint };
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  if (!snapshot) return null;
  const lastRecordId = snapshot.frames.length > 0
    ? snapshot.frames[snapshot.frames.length - 1]!.recordId
    : snapshot.checkpoint?.state.throughRecordId ?? "0";
  const catchUp = await withTx(pool, async (client) => {
    if (snapshot.meta.streamClientMessageIds.length === 0) return [] as LiveFrameInput[];
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
          WHERE s.user_id=$2 AND s.session_id=$1
            AND ${OPEN_DISPATCH_STREAM_SQL}
            AND f.record_id>$3::bigint
          ORDER BY f.record_id`,
        [sessionId, userId, lastRecordId],
      )
    ).rows;
    return rows.map(parseLiveFrameRow);
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  const opts = options ?? {};
  const reduced = snapshot.checkpoint
    ? continueReduceLiveFrames(snapshot.checkpoint.state, snapshot.frames, opts)
    : reduceLiveFrames(snapshot.frames, opts);
  if (!reduced.ok) return fallbackLiveUnitsPage(snapshot.meta);
  const page = assembleLiveUnitsFromState(reduced.state, snapshot.meta, opts, catchUp);
  if (page.degraded === false) {
    const forCache = catchUp.length === 0
      ? reduced
      : continueReduceLiveFrames(reduced.state, catchUp, opts);
    const streamKey = snapshot.checkpoint?.streamKey
      ?? snapshot.frames[0]?.streamKey
      ?? catchUp[0]?.streamKey;
    if (forCache.ok && streamKey) {
      const cacheState = forCache.state;
      setImmediate(() => {
        void upsertLiveUnitCheckpoint(pool, {
          streamKey,
          sessionId,
          userId,
          state: cacheState,
        }).catch(() => {
          /* cache only — never block the GET stack on fold/stringify */
        });
      });
    }
  }
  return page;
}

export async function readLiveOrTapeFramePayload(
  pool: Pool,
  sessionId: string,
  userId: string,
  ref: { recordId?: string | null; sha256?: string | null },
): Promise<{ source: "live" | "tape"; payload: unknown; sha256?: string } | null> {
  return withTx(pool, async (client) => {
    const session = await client.query(
      "SELECT 1 FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, userId],
    );
    if ((session.rowCount ?? 0) !== 1) return null;
    if (ref.recordId && /^\d+$/.test(ref.recordId)) {
      const live = await client.query<{ payload: Buffer; payload_sha256: string }>(
        `SELECT f.payload,f.payload_sha256
           FROM client_session_live_frames f
           JOIN client_session_live_streams s ON s.stream_key=f.stream_key
          WHERE s.session_id=$1 AND s.user_id=$2 AND f.record_id=$3::bigint
          LIMIT 1`,
        [sessionId, userId, ref.recordId],
      );
      const row = live.rows[0];
      if (row) {
        return {
          source: "live" as const,
          payload: JSON.parse(Buffer.from(row.payload).toString("utf8")),
          sha256: row.payload_sha256,
        };
      }
    }
    if (ref.sha256 && /^[a-f0-9]{64}$/i.test(ref.sha256)) {
      const tape = await client.query<{ payload: Buffer; content_sha256: string }>(
        `SELECT payload,content_sha256
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND content_sha256=$3
          LIMIT 1`,
        [sessionId, userId, ref.sha256.toLowerCase()],
      );
      const row = tape.rows[0];
      if (row) {
        return {
          source: "tape" as const,
          payload: JSON.parse(Buffer.from(row.payload).toString("utf8")),
          sha256: row.content_sha256,
        };
      }
    }
    return null;
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
}

export async function reconcileLiveStreamWithFinalTape(
  client: PoolClient,
  input: {
    dispatchId: string;
    status: string;
    tapeId: string;
    tapeSha256: string;
  },
): Promise<void> {
  // Every caller runs inside finalizeLosslessTurnTape with the tape row and its
  // records already durable, so all three terminal statuses
  // (completed/interrupted/crashed) project to tape — interrupted tapes carry
  // the same authoritative records and replaying their live frames on every
  // cold-start journal hydration is pure waste (0201's original comment kept
  // abnormal turns on live; records became the authority for them since).
  await client.query(
    `UPDATE client_session_live_streams
        SET terminal_status=$2,
            projection_source='tape',
            tape_id=$3,
            tape_sha256=$4,
            updated_at=NOW()
      WHERE dispatch_id=$1::uuid AND source='gateway'`,
    [input.dispatchId, input.status, input.tapeId, input.tapeSha256],
  );
  await deleteLiveUnitCheckpoints(client, (
    await client.query<{ stream_key: string }>(
      `SELECT stream_key FROM client_session_live_streams
        WHERE dispatch_id=$1::uuid AND source='gateway'`,
      [input.dispatchId],
    )
  ).rows.map((row) => row.stream_key));
}

/**
 * One-shot, idempotent convergence of gateway live streams whose dispatch
 * already has a finalized tape. Rows written before the unconditional
 * projection fix keep `projection_source='live'` forever because nothing
 * re-runs their finalize transaction; every cold-start journal hydration
 * would keep replaying them. Covers both shapes: streams that got
 * terminal_status+tape_id from the old CASE reconcile but stayed live, and
 * tape_id-less orphans whose tape finalized only after their last frame.
 * Backfills tape identity so the rows stay introspectable. Strictly scoped:
 * a finalized tape per (dispatch_id, attempt_no) is the single authority —
 * in-flight turns (no tape yet), tapeless dead streams and rollout imports
 * are never touched.
 */
export async function convergeFinalizedTapeLiveStreams(pool: Pool): Promise<{ converged: number }> {
  const byDispatch = await pool.query(
    `UPDATE client_session_live_streams s
        SET projection_source='tape',
            terminal_status=t.status,
            tape_id=t.tape_id,
            tape_sha256=t.tape_sha256,
            updated_at=NOW()
       FROM turn_dispatches d
       JOIN client_session_turn_tapes t
         ON t.dispatch_id=d.dispatch_id AND t.attempt_no=d.attempt_no
        AND t.finalized_at IS NOT NULL
      WHERE s.dispatch_id=d.dispatch_id AND s.attempt_no=d.attempt_no
        AND s.source='gateway' AND s.projection_source='live'
      RETURNING s.stream_key`,
  );
  // Leftover legacy:* journals keep projection_source='live' after their
  // client_message_id already has a completed tape (no dispatch_id, so the
  // statement above never sees them). Cold-start hydrate then replays stale
  // outbound.error onto finished sessions. Flip those rows to tape so the
  // live read path and prune can treat the tape as authority.
  const byCompletedCmid = await pool.query(
    `UPDATE client_session_live_streams s
        SET projection_source='tape',
            terminal_status=t.status,
            tape_id=t.tape_id,
            tape_sha256=t.tape_sha256,
            updated_at=NOW()
       FROM (
         SELECT DISTINCT ON (session_id, user_id, client_message_id)
                session_id, user_id, client_message_id, status, tape_id, tape_sha256
           FROM client_session_turn_tapes
          WHERE status='completed'
            AND finalized_at IS NOT NULL
            AND client_message_id IS NOT NULL
          ORDER BY session_id, user_id, client_message_id, finalized_at DESC
       ) t
      WHERE s.session_id=t.session_id
        AND s.user_id=t.user_id
        AND s.client_message_id=t.client_message_id
        AND s.source='gateway'
        AND s.projection_source='live'
      RETURNING s.stream_key`,
  );
  const keys = [
    ...byDispatch.rows.map((row: { stream_key: string }) => row.stream_key),
    ...byCompletedCmid.rows.map((row: { stream_key: string }) => row.stream_key),
  ];
  if (keys.length > 0) await deleteLiveUnitCheckpoints(pool, keys);
  return { converged: (byDispatch.rowCount ?? 0) + (byCompletedCmid.rowCount ?? 0) };
}

export async function importRolloutLiveFrames(
  pool: Pool,
  input: {
    uid: bigint;
    sessionId: string;
    clientMessageId: string;
    dispatchId: string;
    attemptNo: number;
    rolloutSha256: string;
    provenance: Record<string, unknown>;
    payloads: string[];
  },
): Promise<{ inserted: number; idempotent: number }> {
  const streamKey = `import:${input.rolloutSha256}`;
  return withTx(pool, async (client) => {
    const dispatch = await client.query(
      `SELECT 1 FROM turn_dispatches
        WHERE dispatch_id=$1::uuid AND attempt_no=$2 AND user_id=$3
          AND session_id=$4 AND client_message_id=$5
          AND status='terminal' AND outcome='crashed'
        FOR UPDATE`,
      [
        input.dispatchId,
        input.attemptNo,
        input.uid.toString(),
        input.sessionId,
        input.clientMessageId,
      ],
    );
    if ((dispatch.rowCount ?? 0) !== 1) {
      throw new Error("rollout import dispatch identity is not an authoritative crash");
    }
    const stream = await client.query(
      `INSERT INTO client_session_live_streams
         (stream_key,session_id,user_id,client_message_id,dispatch_id,attempt_no,
          source,projection_source,terminal_status,import_sha256,provenance)
       VALUES ($1,$2,$3,$4,$5::uuid,$6,'rollout_import','live','crashed',$7,$8::jsonb)
       ON CONFLICT (stream_key) DO UPDATE SET updated_at=NOW()
       WHERE client_session_live_streams.session_id=EXCLUDED.session_id
         AND client_session_live_streams.user_id=EXCLUDED.user_id
         AND client_session_live_streams.client_message_id=EXCLUDED.client_message_id
         AND client_session_live_streams.dispatch_id=EXCLUDED.dispatch_id
         AND client_session_live_streams.attempt_no=EXCLUDED.attempt_no
         AND client_session_live_streams.source='rollout_import'
         AND client_session_live_streams.import_sha256=EXCLUDED.import_sha256
         AND client_session_live_streams.provenance=EXCLUDED.provenance
       RETURNING stream_key`,
      [
        streamKey,
        input.sessionId,
        `c:${input.uid.toString()}`,
        input.clientMessageId,
        input.dispatchId,
        input.attemptNo,
        input.rolloutSha256,
        JSON.stringify(input.provenance),
      ],
    );
    if ((stream.rowCount ?? 0) !== 1) throw new Error("rollout import stream identity conflict");

    let inserted = 0;
    let idempotent = 0;
    for (let index = 0; index < input.payloads.length; index++) {
      const payload = Buffer.from(input.payloads[index]!, "utf8");
      const digest = sha256(payload);
      const ordinal = index + 1;
      const write = await client.query(
        `INSERT INTO client_session_live_frames
           (stream_key,source,session_key,import_ordinal,payload,payload_sha256)
         VALUES ($1,'rollout_import',$2,$3,$4,$5)
         ON CONFLICT (stream_key,import_ordinal)
           WHERE source='rollout_import' DO NOTHING
         RETURNING record_id`,
        [streamKey, `rollout:${input.rolloutSha256}`, ordinal, payload, digest],
      );
      if ((write.rowCount ?? 0) === 1) {
        inserted += 1;
        continue;
      }
      const existing = (
        await client.query<{ payload: Buffer; payload_sha256: string }>(
          `SELECT payload,payload_sha256 FROM client_session_live_frames
            WHERE stream_key=$1 AND source='rollout_import' AND import_ordinal=$2
            FOR UPDATE`,
          [streamKey, ordinal],
        )
      ).rows[0];
      if (
        !existing || existing.payload_sha256 !== digest ||
        !Buffer.from(existing.payload).equals(payload)
      ) {
        throw new Error(`rollout import immutable payload conflict at ordinal ${ordinal}`);
      }
      idempotent += 1;
    }
    const count = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM client_session_live_frames WHERE stream_key=$1",
      [streamKey],
    );
    if (Number(count.rows[0]?.count ?? -1) !== input.payloads.length) {
      throw new Error("rollout import row-count mismatch");
    }
    return { inserted, idempotent };
  });
}

const DEFAULT_PRUNE_BATCH_SIZE = 5000;
const DEFAULT_RETIRE_MIN_AGE_MS = 2 * 60 * 60 * 1000;

function asPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(max, value);
}

/**
 * Delete frames that belong to tape-projected streams whose tape records
 * actually exist. Read paths only fetch projection_source='live', so these
 * frames are unreachable — but some tape streams have no tape records
 * (production had 18 such streams, one with 2343 frames); deleting those
 * would be real data loss. Eligibility is (session_id, user_id, tape_id)
 * EXISTS in client_session_turn_tape_records; tape_id IS NULL is skipped.
 * Batched to avoid a long table lock. Idempotent.
 */
export async function pruneProjectedLiveFrames(
  pool: Pool,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<{ deletedFrames: number; prunedStreams: number }> {
  const batchSize = asPositiveInt(options?.batchSize, DEFAULT_PRUNE_BATCH_SIZE, 20_000);
  const maxBatches = options?.maxBatches === undefined
    ? Number.POSITIVE_INFINITY
    : asPositiveInt(options.maxBatches, 1, 1_000_000);
  const touched = new Set<string>();
  let deletedFrames = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await pool.query<{ stream_key: string }>(
      `DELETE FROM client_session_live_frames
        WHERE record_id IN (
          SELECT f.record_id
            FROM client_session_live_frames f
            JOIN client_session_live_streams s ON s.stream_key=f.stream_key
           WHERE s.projection_source='tape'
             AND s.tape_id IS NOT NULL
             AND EXISTS (
               SELECT 1
                 FROM client_session_turn_tape_records r
                WHERE r.session_id=s.session_id
                  AND r.user_id=s.user_id
                  AND r.tape_id=s.tape_id
             )
           LIMIT $1
        )
        RETURNING stream_key`,
      [batchSize],
    );
    const count = result.rowCount ?? 0;
    if (count === 0) break;
    deletedFrames += count;
    for (const row of result.rows) touched.add(row.stream_key);
  }
  if (touched.size > 0) {
    await deleteLiveUnitCheckpoints(pool, [...touched]);
  }
  return { deletedFrames, prunedStreams: touched.size };
}

/**
 * Retire live streams that cannot produce more frames so hydration stops
 * treating them as in-flight. Does not change projection_source: flipping
 * them to tape with a null tape_id would inflate hasTapeProjection /
 * tapeProjectionVersion. Retirement is a provenance.retired_at stamp
 * (no DDL — aurora already occupies 0219; a new column would force a 0220
 * gap and a migrate-before-code deploy order).
 *
 * Retirement is hygiene, not the open-session hot path. GET live-frames now
 * only returns the current in-flight dispatch:* stream; retired leftover and
 * terminal live journals stay in the table (no prune) for cold audit.
 *
 * Eligible, all required:
 *   - source='gateway' (never rollout_import)
 *   - projection_source='live' and not already retired
 *   - updated_at older than minAgeMs (default 2h)
 *   - either dispatch_id IS NULL (legacy:* never seen by converge), or the
 *     dispatch is terminal / manual_reconcile
 * Never touches accepted/admitted/rejecting dispatches, including an
 * in-flight accepted turn even if its lease has expired.
 */
export async function retireDeadLiveStreams(
  pool: Pool,
  options?: { minAgeMs?: number },
): Promise<{ retired: number }> {
  const minAgeMs = asPositiveInt(
    options?.minAgeMs,
    DEFAULT_RETIRE_MIN_AGE_MS,
    365 * 24 * 60 * 60 * 1000,
  );
  const aged = await pool.query<{ stream_key: string }>(
    `UPDATE client_session_live_streams s
        SET provenance = s.provenance || jsonb_build_object('retired_at', NOW()::text),
            terminal_status = COALESCE(
              s.terminal_status,
              (
                SELECT CASE
                  WHEN d.outcome IN ('completed','interrupted','crashed') THEN d.outcome
                  ELSE 'interrupted'
                END
                  FROM turn_dispatches d
                 WHERE d.dispatch_id=s.dispatch_id
              ),
              'interrupted'
            ),
            updated_at = NOW()
      WHERE s.source='gateway'
        AND s.projection_source='live'
        AND NOT (s.provenance ? 'retired_at')
        AND s.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND (
          s.dispatch_id IS NULL
          OR EXISTS (
            SELECT 1 FROM turn_dispatches d
             WHERE d.dispatch_id=s.dispatch_id
               AND d.status IN ('terminal','manual_reconcile')
          )
        )
      RETURNING s.stream_key`,
    [minAgeMs],
  );
  // Leftover legacy journals (no cmid, no dispatch) never converge. Retire
  // them immediately when the session has no in-flight dispatch — do not
  // wait for the scheduler minAge floor.
  const leftover = await pool.query<{ stream_key: string }>(
    `UPDATE client_session_live_streams s
        SET provenance = s.provenance || jsonb_build_object('retired_at', NOW()::text)
      WHERE s.client_message_id IS NULL
        AND s.dispatch_id IS NULL
        AND s.source='gateway'
        AND s.projection_source='live'
        AND NOT (s.provenance ? 'retired_at')
        AND NOT EXISTS (
          SELECT 1 FROM turn_dispatches d
           WHERE d.session_id=s.session_id
             AND d.status IN ('accepted','admitted','rejecting')
        )
      RETURNING s.stream_key`,
  );
  return { retired: (aged.rowCount ?? 0) + (leftover.rowCount ?? 0) };
}
