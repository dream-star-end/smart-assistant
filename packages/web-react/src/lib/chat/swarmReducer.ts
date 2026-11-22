import {
  isSwarmSnapshot,
  mergeSwarmSnapshotsStrict,
  SWARM_BOARD_TOOL_NAME,
  type SwarmSnapshot,
} from "@openclaude/protocol/browser";
import { addMessage, type ChatMessage, type ChatSession } from "./model";

export type SwarmSnapshotApplyResult = "applied" | "stale" | "missing_base" | "ignored";

function extractExistingSwarmSnapshot(m: ChatMessage | null | undefined): SwarmSnapshot | null {
  if (!m) return null;
  if (isSwarmSnapshot(m._swarmSnapshot)) return m._swarmSnapshot;
  if (m.role !== "tool" || m.toolName !== SWARM_BOARD_TOOL_NAME) return null;
  if (isSwarmSnapshot(m.outputJson)) return m.outputJson;
  if (m.inputJson && typeof m.inputJson === "object" && !Array.isArray(m.inputJson)) {
    const rec = m.inputJson as Record<string, unknown>;
    if (isSwarmSnapshot(rec.snapshot)) return rec.snapshot;
    if (isSwarmSnapshot(rec)) return rec;
  }
  return null;
}

export function applySwarmSnapshotBlock(
  sess: ChatSession,
  block: { blockId?: string; snapshot?: unknown },
  turnStart: number,
  frameTurnOwnerId: string | undefined,
  isFrozenRow: (m: ChatMessage) => boolean,
): SwarmSnapshotApplyResult {
  if (!isSwarmSnapshot(block.snapshot)) return "ignored";
  const snap: SwarmSnapshot = block.snapshot;
  const blockId =
    typeof block.blockId === "string" && block.blockId
      ? block.blockId
      : `agy-swarm-${snap.swarmId.slice(0, 8)}`;

  // 1. Exact blockId lookup across the session first: if an authoritative frozen/tape
  //    historical row already represents this exact blockId, ignore late/replayed frames
  //    instead of mutating the immutable row or minting a duplicate card.
  let existing: ChatMessage | null = null;
  if (sess._blockIdToMsgId?.has(blockId)) {
    const mid = sess._blockIdToMsgId.get(blockId);
    const hit = sess.messages.find((m) => m.id === mid && m.role === "tool") ?? null;
    if (hit) {
      if (isFrozenRow(hit)) return "ignored";
      existing = hit;
    }
  }
  if (!existing) {
    for (let idx = sess.messages.length - 1; idx >= 0; idx -= 1) {
      const cand = sess.messages[idx];
      if (cand?.role === "tool" && cand.toolName === SWARM_BOARD_TOOL_NAME && cand.blockId === blockId) {
        if (isFrozenRow(cand)) return "ignored";
        existing = cand;
        break;
      }
    }
  }

  // 2. Fallback scan within the current mutable turn only (never match frozen history).
  if (!existing) {
    for (let idx = sess.messages.length - 1; idx >= turnStart; idx -= 1) {
      const cand = sess.messages[idx];
      if (!cand || cand.role !== "tool" || cand.toolName !== SWARM_BOARD_TOOL_NAME) continue;
      if (isFrozenRow(cand)) continue;
      const candSnap = extractExistingSwarmSnapshot(cand);
      if (cand.blockId === blockId || candSnap?.swarmId === snap.swarmId) {
        existing = cand;
        break;
      }
    }
  }

  // 3. Monotonic revision guard + strict delta continuity check against out-of-order/gapped frames.
  const existingSnap = extractExistingSwarmSnapshot(existing);
  const mergeRes = mergeSwarmSnapshotsStrict(existingSnap, snap);
  if (!mergeRes.ok) {
    if (mergeRes.reason === "missing_base") {
      sess._swarmSyncStale = true;
      return "missing_base";
    }
    return "stale";
  }

  const mergedSnap = mergeRes.snapshot;
  sess._swarmSyncStale = false;
  const isTerminal = mergedSnap.phase !== "running" && mergedSnap.phase !== "starting";
  const inputJson = {
    swarmId: mergedSnap.swarmId,
    title: mergedSnap.title,
    phase: mergedSnap.phase,
    snapshot: mergedSnap,
  };
  if (!existing) {
    existing = addMessage(sess, "tool", SWARM_BOARD_TOOL_NAME, {
      blockId,
      toolName: SWARM_BOARD_TOOL_NAME,
      inputJson,
      inputPreview: mergedSnap.title,
      output: "",
      error: mergedSnap.phase === "error",
      _partial: false,
      _completed: isTerminal,
      _swarmSnapshot: mergedSnap,
      ...(isTerminal ? { completedAt: Date.now() } : {}),
      ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
    });
  } else {
    existing.toolName = SWARM_BOARD_TOOL_NAME;
    existing.blockId = blockId;
    existing.inputJson = inputJson;
    existing.inputPreview = mergedSnap.title;
    existing.error = mergedSnap.phase === "error";
    existing._partial = false;
    existing._completed = isTerminal;
    existing._swarmSnapshot = mergedSnap;
    if (isTerminal) {
      if (existing.completedAt == null) existing.completedAt = Date.now();
    } else {
      existing.completedAt = undefined;
    }
    if (frameTurnOwnerId) existing._turnOwnerId = frameTurnOwnerId;
  }
  sess._blockIdToMsgId?.set(blockId, existing.id);
  return "applied";
}

export function finalizeSwarmMessageOnTurnEnd(
  m: ChatMessage,
  interrupted: boolean,
  isFrozenRow: (m: ChatMessage) => boolean,
): void {
  if (isFrozenRow(m)) return;
  if (
    m.role !== "tool" ||
    m.toolName !== SWARM_BOARD_TOOL_NAME ||
    !m._swarmSnapshot ||
    (m._swarmSnapshot.phase !== "running" && m._swarmSnapshot.phase !== "starting")
  ) {
    return;
  }
  const nextPhase = interrupted ? "interrupted" : "completed";
  const settled: SwarmSnapshot = {
    ...m._swarmSnapshot,
    phase: nextPhase,
    revision: m._swarmSnapshot.revision + 1,
    updatedAt: Date.now(),
    members: m._swarmSnapshot.members.map((member) => ({
      ...member,
      status: member.status === "killed" ? "killed" : "waiting",
    })),
  };
  m._swarmSnapshot = settled;
  m.inputJson = {
    swarmId: settled.swarmId,
    title: settled.title,
    phase: settled.phase,
    snapshot: settled,
  };
  m._completed = true;
  if (m.completedAt == null) m.completedAt = Date.now();
}
