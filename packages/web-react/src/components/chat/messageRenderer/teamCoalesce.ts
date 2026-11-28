import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../../lib/chat/model";
import {
  HIDDEN_REVIEWER_AGENT_ID,
  messageKind,
  safeMessageSignature,
} from "../../../lib/chat/render";
import {
  delegateTokenUsage,
  displayCallTokenUsage,
  type DisplayTokenUsage,
  groupedCallTokenUsage,
  tokenUsageSignature,
  tokenUsageSnapshot,
} from "../tokenUsage";
import type { LeafRenderItem } from "./types";

export function tapeRenderPageKey(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (message._historyPageKey) return message._historyPageKey;
  if (message._turnTapeProcessPageKey) return message._turnTapeProcessPageKey;
  // Rows cached by the immediately preceding build do not yet carry a cursor
  // page key. Derive a stable physical-ordinal bucket so an already-open long
  // session becomes virtualized immediately after upgrade; this is only a UI
  // render identity and does not alter, summarize or discard any record.
  if (message._turnTapeProcessLoadedFrom) {
    const ordinal = typeof message._turnTapeOrdinal === "number"
      ? message._turnTapeOrdinal
      : message._recordOrdinal;
    if (typeof ordinal === "number" && Number.isFinite(ordinal)) {
      return `${message._turnTapeProcessLoadedFrom}::legacy-bucket:${Math.floor(ordinal / 200)}`;
    }
  }
  return "";
}

function computeTurnAnchorsAndStages(messages: ChatMessage[]): {
  anchorOf: number[];
  stageOf: number[];
} {
  const total = messages.length;
  const anchorOf: number[] = new Array(total);
  const stageOf: number[] = new Array(total);
  let lastUser = -1;
  let stage = 0;
  for (let i = 0; i < total; i++) {
    const row = messages[i];
    if (row?.role === "user") {
      lastUser = i;
      stage = 0;
    }
    anchorOf[i] = lastUser;
    stageOf[i] = stage;
    if (row?.role === "assistant" && typeof row.text === "string" && row.text.trim().length > 0) {
      stage++;
    }
  }
  return { anchorOf, stageOf };
}

function findLiveTurnUsageFallbackIndex(
  messages: ChatMessage[],
  liveTurnUsage?: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot },
): number {
  if (!liveTurnUsage) return -1;
  const liveAnchor = messages.findIndex(
    (message) => message.role === "user" && message.id === liveTurnUsage.clientMessageId,
  );
  if (liveAnchor < 0) return -1;
  let liveFallbackIdx = -1;
  for (let i = liveAnchor + 1; i < messages.length && messages[i]?.role !== "user"; i++) {
    if (messages[i]?.role === "assistant") liveFallbackIdx = i;
  }
  return liveFallbackIdx;
}

function resolveMessageTokenUsage(
  absIdx: number,
  message: ChatMessage,
  liveFallbackIdx: number,
  liveTurnUsage?: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot },
): DisplayTokenUsage | undefined {
  return (
    displayCallTokenUsage(message._callUsage) ??
    tokenUsageSnapshot(message.usage) ??
    (absIdx === liveFallbackIdx && liveTurnUsage
      ? { ...liveTurnUsage.usage }
      : undefined)
  );
}

/** 面板成员资格:agent-group 且非隐藏审查员(审查卡恒单卡,按时序独立渲染)。 */
function isTeamPanelMember(m: ChatMessage | undefined): m is ChatMessage {
  return (
    !!m &&
    m._timelineRecord !== true &&
    messageKind(m) === "agent-group" &&
    m._delegateAgentId !== HIDDEN_REVIEWER_AGENT_ID
  );
}

function buildDelegateCostByAnchor(
  messages: ChatMessage[],
  anchorOf: readonly number[],
): Map<number, Record<string, string>> {
  const delegateCostByAnchor = new Map<number, Record<string, string>>();
  for (let i = 0; i < messages.length; i++) {
    const mm = messages[i];
    const delegates = mm?.role === "assistant" && Array.isArray(mm.usage?.delegates)
      ? mm.usage.delegates
      : [];
    if (delegates.length === 0) continue;
    const anchor = anchorOf[i] ?? -1;
    const rec = delegateCostByAnchor.get(anchor) ?? {};
    for (const d of delegates) {
      // 同 turn 若多条助手行都带 delegates,后者(最终答复行)胜。
      if (d && typeof d.agentId === "string" && typeof d.costCredits === "string") {
        rec[d.agentId] = d.costCredits;
      }
    }
    delegateCostByAnchor.set(anchor, rec);
  }
  return delegateCostByAnchor;
}

function countSliceTeamBatches(
  slice: ChatMessage[],
  start: number,
  batchKeyOf: (absIdx: number) => string,
): Map<string, number> {
  const teamCount = new Map<string, number>();
  for (let i = 0; i < slice.length; i++) {
    if (isTeamPanelMember(slice[i])) {
      const k = batchKeyOf(start + i);
      teamCount.set(k, (teamCount.get(k) ?? 0) + 1);
    }
  }
  return teamCount;
}

function buildTeamLeafItem(
  slice: ChatMessage[],
  start: number,
  batchKey: string,
  sending: boolean,
  batchKeyOf: (absIdx: number) => string,
  costFor: (absIdx: number, m: ChatMessage) => string | undefined,
  delegateCosts: Record<string, string> | undefined,
): LeafRenderItem {
  const members: ChatMessage[] = [];
  const memberIdx: number[] = [];
  for (let j = 0; j < slice.length; j++) {
    const candidate = slice[j];
    if (isTeamPanelMember(candidate) && batchKeyOf(start + j) === batchKey) {
      members.push(candidate);
      memberIdx.push(start + j);
    }
  }
  return {
    kind: "team",
    members,
    // 成本值取自别的行(助手行),不在成员 message sig 内 → 折进团队 sig(每成员 cost 拼入),
    // 否则成本后到时 TeamPanel 的 sig-only memo 会跳过重渲(见 TeamPanel 尾 memo 注释)。
    sig: members
      .map(
        (mm, k) =>
          `${safeMessageSignature(mm, { isLast: false, sending })}|c:${costFor(memberIdx[k] ?? 0, mm) ?? ""}|du:${tokenUsageSignature(delegateTokenUsage(mm))}`,
      )
      .join("||"),
    delegateCosts,
  };
}

function collectThinkingGroup(
  slice: ChatMessage[],
  sliceIdx: number,
  start: number,
  total: number,
  sending: boolean,
  consumedThinking: Set<number>,
): LeafRenderItem {
  const first = slice[sliceIdx]!;
  const absIdx = start + sliceIdx;
  const members: ChatMessage[] = [];
  const tapePageKey = tapeRenderPageKey(first);
  let lastAbs = absIdx;
  for (let j = sliceIdx; j < slice.length; j++) {
    const candidate = slice[j];
    if (!candidate || tapeRenderPageKey(candidate) !== tapePageKey) break;
    const kj = messageKind(candidate);
    if (kj === "thinking") {
      members.push(candidate);
      consumedThinking.add(start + j);
      lastAbs = start + j;
    } else if (kj !== "unknown") {
      break;
    }
  }
  const groupIsLast = lastAbs === total - 1;
  const sig = members
    .map((mm, k) => safeMessageSignature(mm, { isLast: groupIsLast && k === members.length - 1, sending }))
    .join("||");
  const thinkingUsage = groupedCallTokenUsage(members.map((member) => member._callUsage));
  return {
    kind: "thinking",
    members,
    sig: `${sig}|tu:${tokenUsageSignature(thinkingUsage)}`,
    isLast: groupIsLast,
    idx: absIdx,
    tokenUsage: thinkingUsage,
  };
}

/**
 * 把「队长**同一并行批次**委派的多个 agent-group」聚成一个团队项(≥2 → TeamPanel;单个
 * 退化回 AgentGroupCard),并合并连续 role=thinking 行。
 */
export function coalesceTeam(
  messages: ChatMessage[],
  start: number,
  sending: boolean,
  liveTurnUsage?: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot },
): LeafRenderItem[] {
  const total = messages.length;
  const slice = messages.slice(start);
  const { anchorOf, stageOf } = computeTurnAnchorsAndStages(messages);
  const liveFallbackIdx = findLiveTurnUsageFallbackIndex(messages, liveTurnUsage);
  const batchKeyOf = (absIdx: number): string =>
    `${anchorOf[absIdx]}:${stageOf[absIdx]}:${tapeRenderPageKey(messages[absIdx])}`;
  const delegateCostByAnchor = buildDelegateCostByAnchor(messages, anchorOf);
  const costFor = (absIdx: number, m: ChatMessage): string | undefined =>
    delegateCostByAnchor.get(anchorOf[absIdx] ?? -1)?.[m._delegateAgentId ?? ""];
  const teamCount = countSliceTeamBatches(slice, start, batchKeyOf);
  const items: LeafRenderItem[] = [];
  const emittedTeam = new Set<string>();
  const consumedThinking = new Set<number>();

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const absIdx = start + i;
    if (!m || consumedThinking.has(absIdx)) continue;
    const tokenUsage = resolveMessageTokenUsage(absIdx, m, liveFallbackIdx, liveTurnUsage);
    if (m._timelineRecord === true) {
      items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx, tokenUsage });
      continue;
    }
    if (isTeamPanelMember(m)) {
      const batchKey = batchKeyOf(absIdx);
      if ((teamCount.get(batchKey) ?? 0) >= 2) {
        if (!emittedTeam.has(batchKey)) {
          emittedTeam.add(batchKey);
          items.push(
            buildTeamLeafItem(
              slice, start, batchKey, sending, batchKeyOf, costFor,
              delegateCostByAnchor.get(anchorOf[absIdx] ?? -1),
            ),
          );
        }
        continue;
      }
      items.push({
        kind: "single", m, isLast: absIdx === total - 1, idx: absIdx,
        delegateCost: costFor(absIdx, m), tokenUsage,
      });
      continue;
    }
    if (messageKind(m) === "agent-group") {
      items.push({
        kind: "single", m, isLast: absIdx === total - 1, idx: absIdx,
        delegateCost: costFor(absIdx, m), tokenUsage,
      });
      continue;
    }
    if (messageKind(m) === "thinking") {
      items.push(collectThinkingGroup(slice, i, start, total, sending, consumedThinking));
      continue;
    }
    items.push({ kind: "single", m, isLast: absIdx === total - 1, idx: absIdx, tokenUsage });
  }
  return items;
}
