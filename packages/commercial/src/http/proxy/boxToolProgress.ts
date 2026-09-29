/** Strict classifier for one already-framed CLI JSONL record.
 * A proven heartbeat is telemetry for a tool the previous round already
 * handed off. It is not a tool result, a new tool id, or a session claim. */
import type { BoxToolCatalog } from "./boxToolCatalog.js";

const TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOX_NAME = /^mcp__ocbridge__t[0-9]{1,3}$/;
const HEARTBEAT_INDEX = /^(0|[1-9][0-9]{0,5})$/;
const HEARTBEAT_KEYS = "elapsed_time_seconds,heartbeat,parent_tool_use_id,session_id,tool_name,tool_use_id,type,uuid";

export interface BoxToolProgressHeartbeat {
  readonly parentToolUseId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly elapsedSeconds: number;
  readonly uuid: string;
}
export interface BoxToolProgressBinding {
  readonly toolUses: readonly { readonly id: string; readonly boxName: string;
    readonly clientName: string }[];
  readonly nativeSessionId: string;
  readonly catalog: BoxToolCatalog;
}
export type BoxToolProgressClass =
  | { readonly kind: "not_progress" }
  | { readonly kind: "malformed" }
  | { readonly kind: "heartbeat"; readonly heartbeat: BoxToolProgressHeartbeat };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Unknown record types stay not_progress so the semantic decoder rejects them.
 * A tool_progress record with any other shape is malformed and must not fall
 * through into tool, usage, or session handling. */
export function classifyBoxToolProgress(value: unknown): BoxToolProgressClass {
  if (!record(value) || value.type !== "tool_progress") return { kind: "not_progress" };
  if (Object.keys(value).sort().join(",") !== HEARTBEAT_KEYS || value.heartbeat !== true) {
    return { kind: "malformed" };
  }
  const parent = value.parent_tool_use_id;
  const toolUseId = value.tool_use_id;
  const toolName = value.tool_name;
  const sessionId = value.session_id;
  const uuid = value.uuid;
  const elapsed = value.elapsed_time_seconds;
  if (typeof parent !== "string" || !TOOL_ID.test(parent)
    || typeof toolUseId !== "string" || typeof toolName !== "string" || !BOX_NAME.test(toolName)
    || typeof sessionId !== "string" || !UUID_V4.test(sessionId)
    || typeof uuid !== "string" || !UUID_V4.test(uuid)
    || typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0
    || (Number.isInteger(elapsed) && !Number.isSafeInteger(elapsed))) {
    return { kind: "malformed" };
  }
  const prefix = `${parent}-heartbeat-`;
  if (!toolUseId.startsWith(prefix) || !HEARTBEAT_INDEX.test(toolUseId.slice(prefix.length))) {
    return { kind: "malformed" };
  }
  return { kind: "heartbeat", heartbeat: { parentToolUseId: parent, toolUseId,
    toolName, sessionId, elapsedSeconds: elapsed, uuid } };
}

/** Parent id must be one prior handoff tool. The heartbeat id is never added
 * to that set. Session must be the already-bound root CLI session. */
export function acceptBoxToolProgress(heartbeat: BoxToolProgressHeartbeat,
  binding: BoxToolProgressBinding | undefined): boolean {
  if (!binding || !UUID_V4.test(binding.nativeSessionId)
    || heartbeat.sessionId !== binding.nativeSessionId
    || !Array.isArray(binding.toolUses) || binding.toolUses.length < 1
    || binding.toolUses.length > 32) return false;
  const match = binding.toolUses.find((use) => use.id === heartbeat.parentToolUseId);
  if (!match || match.boxName !== heartbeat.toolName
    || binding.toolUses.some((use) => use.id === heartbeat.toolUseId)) return false;
  const clientName = binding.catalog.clientNameByBoxName.get(heartbeat.toolName);
  return clientName !== undefined && clientName === match.clientName;
}
