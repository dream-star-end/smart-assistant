import {
  SWARM_BOARD_TOOL_NAME,
  isSwarmSnapshot,
  type SwarmPhase,
  type SwarmSnapshot,
} from "@openclaude/protocol/browser";
import type { ChatMessage } from "./model";

/** Extract a SwarmSnapshot from either a live WS-updated message or a persisted
 * server-authored `SwarmBoard` tool row (zero DB migration durability). */
export function extractSwarmSnapshotFromMessage(msg: ChatMessage | null | undefined): SwarmSnapshot | null {
  if (!msg) return null;
  if (isSwarmSnapshot(msg._swarmSnapshot)) return msg._swarmSnapshot;
  if (msg.role !== "tool" || msg.toolName !== SWARM_BOARD_TOOL_NAME) return null;
  if (isSwarmSnapshot(msg.outputJson)) return msg.outputJson;
  if (msg.inputJson && typeof msg.inputJson === "object" && !Array.isArray(msg.inputJson)) {
    const rec = msg.inputJson as Record<string, unknown>;
    if (isSwarmSnapshot(rec.snapshot)) return rec.snapshot;
    if (isSwarmSnapshot(rec)) return rec;
  }
  return null;
}

export function isSwarmActive(phase: SwarmPhase): boolean {
  return phase === "starting" || phase === "running";
}

/** Current render segment only. A replayed board can sit outside the folded
 * process; a different dispatch owner must not lend it to this process. */
export function processSwarmSnapshot(
  messages: readonly ChatMessage[],
  start: number,
  lastStep: ChatMessage | undefined,
): SwarmSnapshot | null {
  const owner = lastStep?._turnOwnerId || lastStep?._clientMessageId || messages[start - 1]?.id;
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const message = messages[i];
    const candidate = message?._turnOwnerId || message?._clientMessageId;
    if (owner && candidate && owner !== candidate) continue;
    const snapshot = extractSwarmSnapshotFromMessage(message);
    // A terminal snapshot/row supersedes active evidence; don't hunt for an older live board.
    if (snapshot) return message._turnTapeComplete || message._dispatchTerminal ? null : snapshot;
  }
  return null;
}
