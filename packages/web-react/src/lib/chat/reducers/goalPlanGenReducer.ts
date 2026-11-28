/**
 * Goal cards, plan cards, and imageEdit generation placeholder reducers.
 */
import type { OutboundMessageWire } from "../frames";
import {
  addMessage,
  type ChatMessage,
  type ChatSession,
  isServerAuthoredRow,
  rebuildIndexes,
} from "../model";
import { isImmutableTapeViewportRow } from "./frameSeqCursor";

function goalCardIdentity(msg: ChatMessage): string | null {
  if (msg.role !== "goal") return null;
  if (typeof msg.platformGoalId === "string" && msg.platformGoalId) {
    return `platform-goal-${msg.platformGoalId}`;
  }
  if (msg.blockId === "engine-goal" || msg.blockId?.startsWith("codex-goal-")) {
    return "engine-goal";
  }
  return msg.blockId || null;
}

function isLaterGoalCard(candidate: ChatMessage, current: ChatMessage): boolean {
  const candidateRevision = candidate.platformStateRevision ?? -1;
  const currentRevision = current.platformStateRevision ?? -1;
  if (candidateRevision !== currentRevision) return candidateRevision > currentRevision;
  const candidateUpdated = candidate.updatedAt ?? candidate.ts ?? 0;
  const currentUpdated = current.updatedAt ?? current.ts ?? 0;
  return candidateUpdated >= currentUpdated;
}

/** Hydration can return one server-authored goal record per historical turn.
 * Collapse them to the same stable identity used by the live reducer (slot = earliest, content = latest). */
export function normalizeGoalCards(sess: ChatSession): void {
  const anchor = new Map<string, ChatMessage>();
  const winner = new Map<string, ChatMessage>();
  for (const msg of sess.messages) {
    if (isImmutableTapeViewportRow(msg)) continue;
    const identity = goalCardIdentity(msg);
    if (!identity) continue;
    if (!anchor.has(identity)) anchor.set(identity, msg);
    const w = winner.get(identity);
    if (!w || isLaterGoalCard(msg, w)) winner.set(identity, msg);
  }
  if (anchor.size === 0) return;

  let changed = false;
  const remove = new Set<ChatMessage>();
  for (const msg of sess.messages) {
    if (isImmutableTapeViewportRow(msg)) continue;
    const identity = goalCardIdentity(msg);
    if (!identity) continue;
    const slot = anchor.get(identity)!;
    if (msg !== slot) {
      remove.add(msg);
      continue;
    }
    const win = winner.get(identity)!;
    if (win !== slot) {
      Object.assign(slot, win, { id: slot.id, ts: slot.ts, blockId: identity });
      changed = true;
    } else if (slot.blockId !== identity) {
      slot.blockId = identity;
      changed = true;
    }
  }
  if (remove.size > 0) {
    sess.messages = sess.messages.filter((msg) => !remove.has(msg));
    changed = true;
  }
  if (!changed) return;
  sess._blockIdToMsgId = new Map();
  sess._agentGroups = new Map();
  rebuildIndexes(sess);
}

// ═══════════════ plan 卡身份（websocket.js:668-751）═══════════════

function isPlanTurnBoundary(msg?: ChatMessage): boolean {
  return !!msg && (msg.role === "user" || msg.role === "system");
}

export function planTurnStart(messages: ChatMessage[], beforeIndex: number): number {
  let i = Math.min(beforeIndex, messages.length) - 1;
  for (; i >= 0; i--) if (isPlanTurnBoundary(messages[i])) return i + 1;
  return 0;
}

function safePlanIdPart(value: unknown): string {
  return String(value || "plan").replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function planMessageId(blockId: unknown, turnStart: number): string {
  return `plan:${safePlanIdPart(blockId)}:g${Number.isFinite(turnStart) ? turnStart : 0}`;
}

function findPlanInRange(
  messages: ChatMessage[],
  blockId: string,
  start: number,
  end: number,
): ChatMessage | null {
  for (let i = Math.max(0, start); i < Math.min(end, messages.length); i++) {
    const m = messages[i];
    if (m && m.role === "plan" && m.blockId === blockId && !isImmutableTapeViewportRow(m)) return m;
  }
  return null;
}

export function applyPlanBlock(
  sess: ChatSession,
  pb: {
    blockId?: string;
    text?: string;
    explanation?: string;
    steps?: ChatMessage["steps"];
    partial?: boolean;
  },
  frameTurnOwnerId: string | undefined,
): void {
  const blockId = pb.blockId || "plan";
  const turnStart = planTurnStart(sess.messages, sess.messages.length);
  let planMsg = findPlanInRange(sess.messages, blockId, turnStart, sess.messages.length);
  if (!planMsg) {
    planMsg = addMessage(sess, "plan", pb.text || "", {
      id: planMessageId(blockId, turnStart),
      blockId,
      _partial: !!pb.partial,
      explanation: pb.explanation || "",
      steps: Array.isArray(pb.steps) ? pb.steps : [],
      ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
    });
  } else {
    if (typeof pb.text === "string") planMsg.text = pb.text;
    if (typeof pb.explanation === "string") planMsg.explanation = pb.explanation;
    if (Array.isArray(pb.steps)) planMsg.steps = pb.steps;
    planMsg._partial = !!pb.partial;
    planMsg.completedAt = Date.now();
    if (frameTurnOwnerId) planMsg._turnOwnerId = frameTurnOwnerId;
  }
  sess._blockIdToMsgId?.set(blockId, planMsg.id);
}

export function applyGoalBlock(
  sess: ChatSession,
  gb: {
    objective?: string;
    status?: string;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    updatedAt?: number;
    cleared?: boolean;
    platformGoalId?: string;
    platformStateRevision?: number;
  },
  frameTurnOwnerId: string | undefined,
): void {
  const goalId = gb.platformGoalId ? `platform-goal-${gb.platformGoalId}` : "engine-goal";
  let goalMsg: ChatMessage | null = null;
  if (goalId && sess._blockIdToMsgId?.has(goalId)) {
    const mid = sess._blockIdToMsgId.get(goalId);
    goalMsg = sess.messages.find((m) => m.id === mid && m.role === "goal") || null;
  }
  const objective = typeof gb.objective === "string" ? gb.objective : "";
  const goalFields: Partial<ChatMessage> = {
    blockId: goalId,
    goalStatus: typeof gb.status === "string" ? gb.status : "",
    tokenBudget:
      typeof gb.tokenBudget === "number" || gb.tokenBudget === null ? gb.tokenBudget : undefined,
    tokensUsed: typeof gb.tokensUsed === "number" ? gb.tokensUsed : undefined,
    timeUsedSeconds: typeof gb.timeUsedSeconds === "number" ? gb.timeUsedSeconds : undefined,
    updatedAt: typeof gb.updatedAt === "number" ? gb.updatedAt : undefined,
    cleared: !!gb.cleared,
    platformGoalId: gb.platformGoalId,
    platformStateRevision: gb.platformStateRevision,
    completedAt: Date.now(),
    ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
  };
  if (!goalMsg) {
    goalMsg = addMessage(sess, "goal", objective, goalFields);
    if (goalId) sess._blockIdToMsgId?.set(goalId, goalMsg.id);
  } else {
    goalMsg.text = objective || goalMsg.text || "";
    Object.assign(goalMsg, goalFields);
  }
}

// ═══════════════ 生成占位卡（需求 C）消解/失败 ═══════════════

export function extractImageEditJobId(frame: OutboundMessageWire): string | undefined {
  const j = frame.imageEditJobId;
  return typeof j === "string" && j.length > 0 ? j : undefined;
}

export function resolveGenPlaceholders(sess: ChatSession, jobId?: string): void {
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const gp = sess.messages[i]._genPlaceholder;
    if (!gp) continue;
    if (jobId) {
      if (gp.jobId === jobId) sess.messages.splice(i, 1);
    } else if (gp.status === "running") {
      sess.messages.splice(i, 1);
    }
  }
}

export function failGenPlaceholders(sess: ChatSession, reason?: string): void {
  for (const m of sess.messages) {
    const gp = m._genPlaceholder;
    if (gp && gp.status === "running") {
      gp.status = "failed";
      if (reason && !gp.reason) gp.reason = reason;
    }
  }
}

export function expireGenPlaceholdersAgainstServerRows(sess: ChatSession): void {
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const gp = sess.messages[i]._genPlaceholder;
    if (!gp || gp.status !== "running" || !gp.afterUserMsgId) continue;
    const anchor = sess.messages.find((m) => m.id === gp.afterUserMsgId);
    if (!anchor || typeof anchor._seq !== "number") continue;
    const anchorSeq = anchor._seq;
    const answered = sess.messages.some(
      (m) =>
        m.role === "assistant" &&
        isServerAuthoredRow(m) &&
        typeof m._seq === "number" &&
        m._seq > anchorSeq,
    );
    if (answered) sess.messages.splice(i, 1);
  }
}
