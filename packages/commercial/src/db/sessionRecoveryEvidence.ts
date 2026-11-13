import type { PoolClient } from "pg";
import type { MessageLike } from "@openclaude/storage";
import { assessTurnRecoveryTape, normalizeTurnErrorCode } from "@openclaude/protocol";
import { filterMonotonicLiveFramePayloads } from "../dispatch/leftoverFrameFence.js";

export const LEFTOVER_RECOVERY_FRAME_LIMIT = 4000;

const truncatedLeftoverRecords = new WeakSet<readonly unknown[]>();

export function isLeftoverRecoveryRecordsTruncated(records: readonly unknown[]): boolean {
  if (truncatedLeftoverRecords.has(records)) return true;
  return records.some(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>)._leftoverTruncated === true,
  );
}

/** Leftover live frames are display-isolated after tape projection, but they
 * remain the SERVICE_RESTART checkpoint store. Recovery admission is not the
 * hot hydrate path, so it may read them without putting leftover back into
 * GET /live-frames. */
/** Callers must pass payloads already through filterMonotonicLiveFramePayloads. */
export async function sessionTurnHasSuccessfulUsage(
  client: PoolClient,
  uid: bigint,
  turnKey: string | undefined,
): Promise<boolean> {
  if (typeof turnKey !== "string" || !/^[0-9a-f]{64}$/.test(turnKey)) return false;
  const row = await client.query(
    `SELECT 1
       FROM usage_records
      WHERE user_id=$1 AND turn_key=$2 AND status='success'
        AND (output_tokens > 0 OR cache_read_tokens > 0)
      LIMIT 1`,
    [uid, turnKey],
  );
  return (row.rowCount ?? 0) > 0;
}

export function leftoverFramesToRecoveryRecords(payloads: readonly unknown[]): unknown[] {
  const records: Array<Record<string, unknown>> = [];
  // OCV5-321 (#611729fb): a live stream carries a tool_use block and later its
  // tool_result (toolUseBlockId → tool_use.blockId). Unpaired id-less rows made
  // every Box turn with tools look unsettled, so the OCV5-317 settled-tools
  // checkpoint was declined as checkpoint_unsafe. Pair by id; blocks without
  // an id keep the old fail-closed shape.
  const toolsById = new Map<string, Record<string, unknown>>();
  const delegatesByExecution = new Map<string, Record<string, unknown>>();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const frame = payload as Record<string, unknown>;
    if (frame.type !== "outbound.message" || !Array.isArray(frame.blocks)) continue;
    for (const block of frame.blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const item = block as Record<string, unknown>;
      const kind = item.kind;
      if (kind === "thinking") {
        records.push({
          role: "thinking",
          text: typeof item.text === "string" ? item.text : "",
        });
        continue;
      }
      if (kind === "text") {
        const text = typeof item.text === "string" ? item.text : "";
        if (text.trim().length > 0) records.push({ role: "assistant", text });
        continue;
      }
      if (kind === "tool_use" || kind === "tool_result") {
        const rawId = kind === "tool_use" ? item.blockId : item.toolUseBlockId;
        const id = typeof rawId === "string" && rawId.length > 0 ? rawId : null;
        const known = id ? toolsById.get(id) : undefined;
        if (known) {
          if (kind === "tool_result") known._completed = true;
          continue;
        }
        const record: Record<string, unknown> = {
          role: "tool",
          ...(id ? { toolUseId: id } : {}),
          _completed: kind === "tool_result",
        };
        if (id) toolsById.set(id, record);
        records.push(record);
        continue;
      }
      if (kind === "delegate_progress") {
        // Legacy completion is an independent observation, never authority
        // for a different progress frame or a guessed display identity.
        if (!Object.hasOwn(item, "phase")) {
          records.push({ role: "delegate-progress", _completed: item._completed === true });
          continue;
        }
        // Usage is telemetry, not evidence that an execution started or
        // stopped. An unexpected execution block must still fail closed.
        if (item.phase === "usage" && !Object.hasOwn(item, "block")) continue;
        const rawKey = item.usageRunId;
        const key = typeof rawKey === "string" && rawKey.length > 0 && rawKey.length <= 256
          && !/[\s\u0000-\u001f\u007f]/u.test(rawKey) ? rawKey : null;
        // Routing runId/agentId may be rebound to an ancestor's card. Only
        // the producer's immutable execution key can supersede old progress.
        // OCV5-716: nested grandchild lifecycle frames have phase rewritten to
        // "text" so they do not close the first-level parent card, while
        // preserving nestedPhase="done" for their own usageRunId.
        const completed =
          key !== null &&
          ((item.phase === "done" && !Object.hasOwn(item, "block")) ||
            (item.phase === "text" &&
              item.nestedPhase === "done" &&
              typeof item.runId === "string" &&
              item.runId.length > 0 &&
              item.runId !== key));
        const known = key ? delegatesByExecution.get(key) : undefined;
        if (known) known._completed = completed;
        else {
          const record = { role: "delegate-progress", _completed: completed };
          if (key) delegatesByExecution.set(key, record);
          records.push(record);
        }
      }
    }
  }
  return records;
}

export async function loadLeftoverRecoveryRecords(
  client: PoolClient,
  sessionId: string,
  sessionUserId: string,
  clientMessageId: string,
  maxFrames: number = LEFTOVER_RECOVERY_FRAME_LIMIT,
): Promise<unknown[]> {
  const safeLimit = Number.isSafeInteger(maxFrames) && maxFrames >= 1
    ? maxFrames
    : LEFTOVER_RECOVERY_FRAME_LIMIT;
  const rows = (
    await client.query<{ payload: Buffer }>(
      `SELECT f.payload
         FROM client_session_live_streams s
         JOIN client_session_live_frames f ON f.stream_key=s.stream_key
        WHERE s.session_id=$1 AND s.user_id=$2 AND s.client_message_id=$3
        ORDER BY f.record_id
        LIMIT $4`,
      [sessionId, sessionUserId, clientMessageId, safeLimit + 1],
    )
  ).rows;
  const truncated = rows.length > safeLimit;
  const boundedRows = truncated ? rows.slice(0, safeLimit) : rows;
  const payloads: unknown[] = [];
  for (const row of boundedRows) {
    try {
      payloads.push(JSON.parse(Buffer.from(row.payload).toString("utf8")));
    } catch {
      // Corrupt leftover frames must not poison tape-backed recovery.
    }
  }
  const records = leftoverFramesToRecoveryRecords(filterMonotonicLiveFramePayloads(payloads));
  if (truncated) {
    // OCV5-717: if leftover frames exceeded the read cap, later tool_use or
    // delegate_progress start frames may have been truncated away. Append an
    // unsettled sentinel so both assessment and allowUnsafeAutomaticCheckpoint
    // fail closed (checkpoint_unsafe).
    records.push({
      role: "delegate-progress",
      _completed: false,
      _leftoverTruncated: true,
    });
    truncatedLeftoverRecords.add(records);
  }
  return records;
}

export function mergeTapeAndLeftoverRecoveryAssessment(
  tapeRecords: readonly unknown[],
  leftoverRecords: readonly unknown[],
): ReturnType<typeof assessTurnRecoveryTape> & { leftoverBacked: boolean } {
  const tape = assessTurnRecoveryTape(tapeRecords);
  if (isLeftoverRecoveryRecordsTruncated(leftoverRecords)) {
    const base = tape.mode === "checkpoint" ? tape : assessTurnRecoveryTape(leftoverRecords);
    return {
      ...base,
      mode: "checkpoint",
      checkpointSafe: false,
      leftoverBacked: tape.mode !== "checkpoint",
    };
  }
  if (tape.mode === "checkpoint") return { ...tape, leftoverBacked: false };
  const leftover = assessTurnRecoveryTape(leftoverRecords);
  if (leftover.mode === "checkpoint") return { ...leftover, leftoverBacked: true };
  return { ...tape, leftoverBacked: false };
}

/** The last assistant record is the semantic terminal surface. An earlier
 * error followed by a later answer is not a failed turn, while trailing tool
 * or runtime audit rows do not erase a terminal assistant error. */
export function terminalTurnRecordErrorCode(records: readonly unknown[]): string {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const message = record as MessageLike;
    if (message.role !== "assistant") continue;
    return typeof message._errorCode === "string"
      ? normalizeTurnErrorCode(message._errorCode)
      : "";
  }
  return "";
}
