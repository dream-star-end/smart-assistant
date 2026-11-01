import type { PoolClient } from "pg";
import type { MessageLike } from "@openclaude/storage";
import { assessTurnRecoveryTape, normalizeTurnErrorCode } from "@openclaude/protocol";
import { filterMonotonicLiveFramePayloads } from "../dispatch/leftoverFrameFence.js";

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
        records.push({
          role: "delegate-progress",
          _completed: item._completed === true,
        });
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
): Promise<unknown[]> {
  const rows = (
    await client.query<{ payload: Buffer }>(
      `SELECT f.payload
         FROM client_session_live_streams s
         JOIN client_session_live_frames f ON f.stream_key=s.stream_key
        WHERE s.session_id=$1 AND s.user_id=$2 AND s.client_message_id=$3
        ORDER BY f.record_id
        LIMIT 4000`,
      [sessionId, sessionUserId, clientMessageId],
    )
  ).rows;
  const payloads: unknown[] = [];
  for (const row of rows) {
    try {
      payloads.push(JSON.parse(Buffer.from(row.payload).toString("utf8")));
    } catch {
      // Corrupt leftover frames must not poison tape-backed recovery.
    }
  }
  return leftoverFramesToRecoveryRecords(filterMonotonicLiveFramePayloads(payloads));
}

export function mergeTapeAndLeftoverRecoveryAssessment(
  tapeRecords: readonly unknown[],
  leftoverRecords: readonly unknown[],
): ReturnType<typeof assessTurnRecoveryTape> & { leftoverBacked: boolean } {
  const tape = assessTurnRecoveryTape(tapeRecords);
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
