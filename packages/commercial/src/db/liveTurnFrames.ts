import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

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
  streamClientMessageIds: string[];
  hasTapeProjection: boolean;
  /** tape 投影版本水位(tape 投影流计数,单调递增)。见 readClientSessionLiveFrames。 */
  tapeProjectionVersion: number;
}

function sha256(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
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

  await retryOnSerializationFailure(() => withTx(pool, async (client) => {
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
       ON CONFLICT (stream_key) DO UPDATE SET updated_at=NOW()
       WHERE client_session_live_streams.session_id=EXCLUDED.session_id
         AND client_session_live_streams.user_id=EXCLUDED.user_id
         AND client_session_live_streams.client_message_id IS NOT DISTINCT FROM EXCLUDED.client_message_id
         AND client_session_live_streams.dispatch_id IS NOT DISTINCT FROM EXCLUDED.dispatch_id
         AND client_session_live_streams.attempt_no IS NOT DISTINCT FROM EXCLUDED.attempt_no
         AND client_session_live_streams.agent_container_id IS NOT DISTINCT FROM EXCLUDED.agent_container_id
         AND client_session_live_streams.source='gateway'
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
      throw new Error("live frame stream identity conflict");
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

    const existing = await insertOrReadExisting(input.sessionKey);
    if (existing === null || matchesCurrentFrame(existing)) return;
    if (existing.stream_key === streamKey) {
      throw new Error("live frame immutable payload conflict");
    }

    // A destroyed gateway session can later reuse the same wire session key
    // after its outbound frame sequence restarts. Keep the first generation's
    // legacy identity, but namespace a later distinct stream (including a
    // server-authored stream without a dispatch) so one stale generation cannot
    // poison every subsequent frame on the user's shared WebSocket.
    const storageSessionKey = `v2:${JSON.stringify([input.sessionKey, streamKey])}`;
    const namespacedExisting = await insertOrReadExisting(storageSessionKey);
    if (namespacedExisting !== null && !matchesCurrentFrame(namespacedExisting)) {
      throw new Error("live frame immutable payload conflict");
    }
  }));
}

/**
 * Self-heal only the retry-safe serialization failures. The dispatch-row lock
 * taken by persistGatewayLiveFrame opposes the finalize transaction's
 * session→dispatch order, and turnDispatchReconciler locks dispatch→session,
 * so an occasional 40P01/40001 abort is expected and harmless to retry: every
 * statement in the frame transaction is idempotent (ON CONFLICT / FOR UPDATE
 * re-read). All other errors propagate untouched.
 */
async function retryOnSerializationFailure(fn: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fn();
      return;
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
): Promise<ClientSessionLiveFramePage | null> {
  const cursor = Number.isSafeInteger(afterRecordId) && afterRecordId >= 0 ? afterRecordId : 0;
  const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 200;
  return withTx(pool, async (client) => {
    const session = await client.query(
      "SELECT 1 FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
      [sessionId, userId],
    );
    if ((session.rowCount ?? 0) !== 1) return null;

    const streams = await client.query<{
      client_message_id: string | null;
      projection_source: "live" | "tape";
      tape_projection_version: string | number;
    }>(
      `SELECT client_message_id,projection_source,
              COUNT(*) FILTER (WHERE projection_source='tape')
                OVER ()::text AS tape_projection_version
         FROM client_session_live_streams
        WHERE session_id=$1 AND user_id=$2
        ORDER BY created_at,stream_key`,
      [sessionId, userId],
    );
    const streamClientMessageIds = [...new Set(
      streams.rows
        .filter((row) => row.projection_source === "live")
        .map((row) => row.client_message_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    )];

    const rows = (
      await client.query<{
        record_id: string;
        stream_key: string;
        source: "gateway" | "rollout_import";
        client_message_id: string | null;
        payload: Buffer;
      }>(
        `SELECT f.record_id::text,f.stream_key,f.source,s.client_message_id,f.payload
           FROM client_session_live_frames f
           JOIN client_session_live_streams s ON s.stream_key=f.stream_key
          WHERE s.session_id=$1 AND s.user_id=$2 AND s.projection_source='live'
            AND f.record_id>$3::bigint
          ORDER BY f.record_id
          LIMIT $4`,
        [sessionId, userId, cursor, pageSize + 1],
      )
    ).rows;
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
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
  const result = await pool.query(
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
  return { converged: result.rowCount ?? 0 };
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
