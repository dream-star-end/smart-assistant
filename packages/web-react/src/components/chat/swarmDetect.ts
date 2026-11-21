import {
  SWARM_BOARD_TOOL_NAME,
  isSwarmSnapshot,
  type SwarmSnapshot,
} from "@openclaude/protocol/browser";
import type { ChatMessage } from "../../lib/chat/model";

export type SwarmOpenRequest = {
  snapshot: SwarmSnapshot;
  /** Specific timeline message id for turn-scoped board tracking. */
  cardId?: string;
  /** Specific wire/persisted block id for turn-scoped board tracking. */
  blockId?: string;
  focusMember?: string | null;
  focusChannel?: string | null;
  focusSeq?: number | null;
};

export type SwarmCardEntry = {
  messageId: string;
  blockId?: string;
  snapshot: SwarmSnapshot;
};

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

/**
 * UI-side check for Antigravity models capable of Swarm mode without
 * pulling the full Node model metadata table into the first-screen browser chunk.
 * Both local Antigravity and remote-pool (`-remote`) Antigravity routes support
 * Swarm mode (local uses CLI native swarm; remote uses container-side Swarm runtime).
 */
export function isAntigravityModelForUi(
  modelId: string | null | undefined,
  models?: readonly { id: string; engine?: string; placement?: string }[],
): boolean {
  if (!modelId) return false;
  const hit = models?.find((m) => m.id === modelId);
  if (hit?.engine) return hit.engine === "antigravity";
  return /^antigravity-/i.test(modelId);
}

/** Find the latest SwarmCardEntry in a session's message timeline. */
export function latestSwarmCard(messages: readonly ChatMessage[]): SwarmCardEntry | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const snap = extractSwarmSnapshotFromMessage(msg);
    if (snap && msg) {
      return { messageId: msg.id, blockId: msg.blockId, snapshot: snap };
    }
  }
  return null;
}

/** Look up a specific turn's SwarmBoard card by messageId or blockId. */
export function findSwarmCardByIdentity(
  messages: readonly ChatMessage[],
  cardId?: string | null,
  blockId?: string | null,
): SwarmCardEntry | null {
  if (!cardId && !blockId) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if ((cardId && msg.id === cardId) || (blockId && msg.blockId === blockId)) {
      const snap = extractSwarmSnapshotFromMessage(msg);
      if (snap) return { messageId: msg.id, blockId: msg.blockId, snapshot: snap };
    }
  }
  return null;
}

/** Find the latest SwarmSnapshot in a session's message timeline. */
export function latestSwarmSnapshot(messages: readonly ChatMessage[]): SwarmSnapshot | null {
  return latestSwarmCard(messages)?.snapshot ?? null;
}
