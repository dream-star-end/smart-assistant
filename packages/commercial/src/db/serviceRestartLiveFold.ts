/**
 * OCV5-646: gateway boot recovery stages a SERVICE_RESTART crashed tape built
 * only from inbox fields (text '', no process), because the container never
 * sees the live frames the master journaled for that dispatch. Finalize then
 * projects the stream to tape and pruneProjectedLiveFrames deletes the frames,
 * so another device hydrates only the synthetic error row although the user
 * watched the answer stream. Before such a tape is materialized, fold the
 * dispatch's own live frames into its payload (answer text, thinking, tool
 * steps). Records stay derived from one payload, so record hashes, sidecars
 * and recovery assessment read the same bytes the browser will.
 */
import type { Pool, PoolClient } from "pg";
import { filterMonotonicLiveFramePayloads } from "../dispatch/leftoverFrameFence.js";

/** Above this the fold is skipped and the tape keeps its synthetic row. */
export const SERVICE_RESTART_FOLD_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const TOOL_TEXT_MAX_CHARS = 64 * 1024;
const PROCESS_KEYS = [
  "thinkingText",
  "tools",
  "thinkingSegments",
  "assistantSegments",
  "agentGroups",
  "structuredBlocks",
  "runtimeEvents",
] as const;

export type FoldedRestartTool = {
  blockId: string;
  toolName: string;
  inputJson?: unknown;
  inputPreview: string;
  output: string;
  isError: boolean;
  completed: boolean;
};

export type FoldedRestartProcess = {
  text: string;
  thinkingText: string;
  tools: FoldedRestartTool[];
};

/** Exactly the boot-recovery shape (buildSyntheticCrashedTapePayload). */
export function isSyntheticServiceRestartPayload(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const payload = raw as Record<string, unknown>;
  if (payload.status !== "crashed" || payload.errorCode !== "SERVICE_RESTART" || payload.text !== "") {
    return false;
  }
  return PROCESS_KEYS.every((key) => payload[key] === undefined);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(text: string): string {
  return text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS)}\n…(已截断)` : text;
}

/**
 * Folds outbound.message deltas the way the live reducer does: consecutive
 * text (or thinking) blocks of one message concatenate, any other block ends
 * the run. Tool results pair with their tool_use by id. Permission and other
 * control frames are skipped — the live-units reducer gives up on them, and
 * the incident turn (t1134u) had three.
 */
export function foldServiceRestartLiveFrames(payloads: readonly unknown[]): FoldedRestartProcess {
  const runs: { text: string[]; thinking: string[] } = { text: [], thinking: [] };
  let open: { kind: "text" | "thinking"; messageId: string } | null = null;
  const tools = new Map<string, FoldedRestartTool>();
  let anonymous = 0;
  for (const payload of filterMonotonicLiveFramePayloads(payloads)) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const frame = payload as Record<string, unknown>;
    if (frame.type !== "outbound.message" || !Array.isArray(frame.blocks)) continue;
    for (const raw of frame.blocks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const block = raw as Record<string, unknown>;
      const kind = block.kind;
      if (kind === "text" || kind === "thinking") {
        const messageId = str(block.messageId);
        const list = runs[kind];
        if (open && open.kind === kind && open.messageId === messageId && list.length > 0) {
          list[list.length - 1] += str(block.text);
        } else {
          list.push(str(block.text));
          open = { kind, messageId };
        }
        continue;
      }
      open = null;
      if (kind === "tool_use") {
        const blockId = str(block.blockId) || `restart-tool-${++anonymous}`;
        const known = tools.get(blockId);
        if (known) {
          if (block.inputJson !== undefined && block.inputJson !== null) known.inputJson = block.inputJson;
          if (str(block.toolName)) known.toolName = str(block.toolName);
          continue;
        }
        tools.set(blockId, {
          blockId,
          toolName: str(block.toolName) || "unknown",
          ...(block.inputJson !== undefined && block.inputJson !== null ? { inputJson: block.inputJson } : {}),
          inputPreview: str(block.inputPreview),
          output: "",
          isError: false,
          completed: false,
        });
        continue;
      }
      if (kind === "tool_result") {
        const blockId = str(block.toolUseBlockId) ||
          str(block.blockId).replace(/:result$/, "") ||
          `restart-tool-${++anonymous}`;
        const tool = tools.get(blockId) ?? {
          blockId,
          toolName: str(block.toolName) || "unknown",
          inputPreview: "",
          output: "",
          isError: false,
          completed: false,
        };
        tool.output = str(block.output) || str(block.preview) || tool.output;
        tool.isError = block.isError === true;
        tool.completed = true;
        tools.set(blockId, tool);
      }
    }
  }
  const join = (list: string[]) => list.filter((text) => text.trim().length > 0).join("\n\n");
  return {
    text: join(runs.text),
    thinkingText: join(runs.thinking),
    tools: [...tools.values()].map((tool) => {
      const { inputJson, ...rest } = tool;
      const keepInput = inputJson !== undefined &&
        (JSON.stringify(inputJson)?.length ?? 0) <= TOOL_TEXT_MAX_CHARS;
      return {
        ...rest,
        ...(keepInput ? { inputJson } : {}),
        inputPreview: clip(rest.inputPreview),
        output: clip(rest.output),
      };
    }),
  };
}

/** Payload with the folded process, or `raw` itself when nothing applies. */
export function applyServiceRestartFold(
  raw: Record<string, unknown>,
  folded: FoldedRestartProcess,
): Record<string, unknown> {
  if (!folded.text && !folded.thinkingText && folded.tools.length === 0) return raw;
  return {
    ...raw,
    text: folded.text,
    ...(folded.thinkingText ? { thinkingText: folded.thinkingText } : {}),
    ...(folded.tools.length > 0 ? { tools: folded.tools } : {}),
  };
}

/**
 * Reads the frames of the tape's own dispatch attempt (header columns, not the
 * payload) and folds them. A journal over the byte cap keeps the synthetic
 * payload; query errors propagate like any other prepare read (retryable).
 */
export async function foldSyntheticServiceRestartTape(
  q: Pool | PoolClient,
  tape: { sessionId: string; userId: string; tapeId: string },
  raw: unknown,
): Promise<unknown> {
  if (!isSyntheticServiceRestartPayload(raw)) return raw;
  const header = (
    await q.query<{ dispatch_id: string | null; attempt_no: number | null }>(
      `SELECT dispatch_id::text,attempt_no
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [tape.sessionId, tape.userId, tape.tapeId],
    )
  ).rows[0];
  if (!header?.dispatch_id || header.attempt_no === null) return raw;
  const streamFilter = `s.dispatch_id=$1::uuid AND s.attempt_no=$2
            AND s.session_id=$3 AND s.user_id=$4 AND s.source='gateway'`;
  const params = [header.dispatch_id, header.attempt_no, tape.sessionId, tape.userId];
  const size = await q.query<{ bytes: string }>(
    `SELECT COALESCE(SUM(octet_length(f.payload)),0)::text AS bytes
       FROM client_session_live_streams s
       JOIN client_session_live_frames f ON f.stream_key=s.stream_key
      WHERE ${streamFilter}`,
    params,
  );
  if (Number(size.rows[0]?.bytes ?? 0) > SERVICE_RESTART_FOLD_MAX_FRAME_BYTES) return raw;
  const rows = (
    await q.query<{ payload: Buffer }>(
      `SELECT f.payload
         FROM client_session_live_streams s
         JOIN client_session_live_frames f ON f.stream_key=s.stream_key
        WHERE ${streamFilter}
        ORDER BY f.record_id`,
      params,
    )
  ).rows;
  const payloads: unknown[] = [];
  for (const row of rows) {
    try {
      payloads.push(JSON.parse(Buffer.from(row.payload).toString("utf8")));
    } catch {
      /* a corrupt frame only loses itself */
    }
  }
  return applyServiceRestartFold(raw, foldServiceRestartLiveFrames(payloads));
}
