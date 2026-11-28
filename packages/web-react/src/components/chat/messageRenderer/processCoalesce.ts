import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../../lib/chat/model";
import { isPlatedAssistantMessage } from "../../../lib/chat/pure";
import { isErrorCardHeldWithAnswer } from "../../../lib/chat/render";
import { processSwarmSnapshot } from "../../../lib/chat/swarmBoardEvidence";
import { coalesceTaskApprovalGroups } from "../../tool/taskApprovalCoalesce";
import {
  artifactEvidenceKeys,
  isClearedGoalRecord,
  isErroredAssistant,
  isFoldableWorkRole,
  isHistoricalGoalRecord,
  isInteractiveToolMessage,
  isProcessMessage,
  promptShadowedToolIds,
} from "../ProcessDisclosure";
import {
  currentTurnStartIndex,
  explicitRowTurnRoot,
  turnFinalAssistantFlags,
  turnLineageRoot,
  turnRatingFlags,
} from "../turnSegment";
import { coalesceTeam } from "./teamCoalesce";
import {
  itemMessages,
  itemRows,
  type LeafRenderItem,
  type ProcessRenderItem,
  type RenderItem,
  renderItemKey,
  type SingleRenderItem,
} from "./types";

function withActiveSwarm(
  out: RenderItem[],
  messages: ChatMessage[],
  activeStart: number,
  sending: boolean,
): RenderItem[] {
  if (!sending) return out;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const item = out[i];
    if (!item || item.kind !== "process" || !item.active) continue;
    item.swarm = processSwarmSnapshot(messages, activeStart, item.members.at(-1));
    break;
  }
  return out;
}

function hasTrailingDifferentTurnOwner(
  messages: ChatMessage[],
  index: number,
  ownerRoot: string,
  rootOf: (id: string) => string,
): boolean {
  for (let j = index + 1; j < messages.length; j += 1) {
    const otherRoot = explicitRowTurnRoot(messages[j], rootOf);
    if (otherRoot && otherRoot !== ownerRoot) return true;
  }
  return false;
}

function isLiveTurnMessageAt(
  messages: ChatMessage[],
  index: number,
  activeStart: number,
  sending: boolean,
  rootOf: (id: string) => string,
): boolean {
  if (!sending || index < activeStart) return false;
  const message = messages[index];
  // OCV5-868: 跨 tab 尚缺新轮 user 行或分页截断场景，已完整落盘的前轮 tape 终答
  // 若后方已出现另一轮的活跃行，绝不视为当前活跃轮的中间叙述。
  if (message?._turnTapeComplete === true) {
    const ownerRoot = explicitRowTurnRoot(message, rootOf);
    if (ownerRoot && hasTrailingDifferentTurnOwner(messages, index, ownerRoot, rootOf)) {
      return false;
    }
  }
  return true;
}

function disclosureAnswerIds(
  messages: ChatMessage[],
  finals: boolean[],
  sending: boolean,
  turnLineageParents?: ReadonlyMap<string, string>,
): Set<string> {
  const ids = new Set<string>();
  const activeStart = currentTurnStartIndex(messages);
  const rootOf = turnLineageRoot(messages, turnLineageParents);
  for (let i = 0; i < messages.length; i++) {
    if (!finals[i] || isLiveTurnMessageAt(messages, i, activeStart, sending, rootOf)) continue;
    const id = messages[i]?.id;
    if (id) ids.add(id);
  }
  const lastAssistant = new Map<string, number>();
  let segment = "head";
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user") {
      segment = message.id;
      continue;
    }
    if (message.role === "assistant") {
      lastAssistant.set(message._clientMessageId || segment, i);
    }
  }
  for (const index of lastAssistant.values()) {
    if (isLiveTurnMessageAt(messages, index, activeStart, sending, rootOf)) continue;
    const message = messages[index];
    if (message?._payloadDeferred && message.id) ids.add(message.id);
  }
  return ids;
}

function advanceDisclosureBoundary(
  rows: ChatMessage[],
  owner: string,
): { owner: string; boundary: string } {
  const nextOwner = rows[0]?.role === "user" ? rows[0].id : owner;
  return { owner: nextOwner, boundary: nextOwner };
}

function isNonSubstantiveContinuationRow(message: ChatMessage): boolean {
  return Boolean(
    message._payloadDeferred ||
    message._turnStatusRecord ||
    message._genPlaceholder ||
    message._turnTapeProcess ||
    message._timelineAuxiliary ||
    message._hideUnpublishedFallback === true,
  );
}

/**
 * OCV5-307: errored assistant rows followed by a later non-empty assistant reply
 * in the same user turn fold into the process instead of staying top-level.
 */
function continuedErrorIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  let pending: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      pending = [];
      continue;
    }
    if (isNonSubstantiveContinuationRow(message)) continue;
    const isWork =
      message.role === "assistant" &&
      !isErroredAssistant(message) &&
      (message.text ?? "").trim().length > 0;
    if (isWork && pending.length > 0) {
      for (const id of pending) ids.add(id);
      pending = [];
    }
    if (isErroredAssistant(message) && !isErrorCardHeldWithAnswer(message) && message.id) {
      pending.push(message.id);
    }
  }
  return ids;
}

function collectActiveDisclosureIds(
  messages: ChatMessage[],
  activeStart: number,
  sending: boolean,
  rootOf: (id: string) => string,
): Set<string> {
  if (!sending) return new Set();
  const ids = new Set<string>();
  for (let i = activeStart; i < messages.length; i += 1) {
    if (isLiveTurnMessageAt(messages, i, activeStart, sending, rootOf)) {
      const id = messages[i]?.id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

function collectAssistantArtifactKeys(items: LeafRenderItem[]): Map<string, Set<string>> {
  const assistantArtifactKeys = new Map<string, Set<string>>();
  let scanOwner = "head";
  for (const item of items) {
    const rows = itemMessages(item);
    const advanced = advanceDisclosureBoundary(rows, scanOwner);
    scanOwner = advanced.owner;
    for (const message of rows) {
      if (message.role !== "assistant" || message._hideUnpublishedFallback === true) continue;
      const keys = artifactEvidenceKeys(message.text ?? "");
      if (keys.length === 0) continue;
      let owned = assistantArtifactKeys.get(advanced.boundary);
      if (!owned) {
        owned = new Set();
        assistantArtifactKeys.set(advanced.boundary, owned);
      }
      for (const key of keys) owned.add(key);
    }
  }
  return assistantArtifactKeys;
}

type CarryState = {
  boundary: string;
  answerOwner?: string;
  group: ProcessRenderItem | undefined;
  answerIndex: number;
};

type BoundaryQueue = {
  boundary: string;
  items: LeafRenderItem[];
};

type DisclosureAcc = {
  out: RenderItem[];
  owner: string;
  group: ProcessRenderItem | undefined;
  boundary: string;
  carry: CarryState | undefined;
  shellOrdinal: Map<string, number>;
  beforeAnswer: Map<string, ProcessRenderItem>;
  interactive: BoundaryQueue | undefined;
  terminal: BoundaryQueue | undefined;
};

function sealProcessGroup(
  acc: DisclosureAcc,
  current: ProcessRenderItem | undefined,
  keyBoundary: string,
): void {
  if (!current || current.key) return;
  const work = current.members.find((message) =>
    !isClearedGoalRecord(message) && (isFoldableWorkRole(message) || isHistoricalGoalRecord(message)),
  );
  const ordinal = acc.shellOrdinal.get(keyBoundary) ?? 0;
  acc.shellOrdinal.set(keyBoundary, ordinal + 1);
  current.key = ordinal === 0 ? `process:${keyBoundary}` : `process:${keyBoundary}:${ordinal}`;
  if (!work) {
    const index = acc.out.indexOf(current);
    if (index >= 0) acc.out.splice(index, 1, ...current.items);
  }
}

function flushBoundaryQueuesOnTurnChange(acc: DisclosureAcc, nextBoundary: string): void {
  const interactiveChanged = Boolean(acc.interactive && acc.interactive.boundary !== nextBoundary);
  const terminalChanged = Boolean(acc.terminal && acc.terminal.boundary !== nextBoundary);
  if (!interactiveChanged && !terminalChanged) return;
  sealProcessGroup(acc, acc.group, acc.boundary);
  if (acc.carry?.group && acc.carry.group.key === "") {
    sealProcessGroup(acc, acc.carry.group, acc.carry.boundary);
  }
  if (interactiveChanged && acc.interactive) {
    acc.out.push(...acc.interactive.items);
    acc.interactive = undefined;
  }
  if (terminalChanged && acc.terminal) {
    acc.out.push(...acc.terminal.items);
    acc.terminal = undefined;
  }
}

function flushAllBoundaryQueues(acc: DisclosureAcc): void {
  sealProcessGroup(acc, acc.group, acc.boundary);
  if (acc.carry?.group && acc.carry.group.key === "") {
    sealProcessGroup(acc, acc.carry.group, acc.carry.boundary);
  }
  if (acc.interactive) {
    acc.out.push(...acc.interactive.items);
    acc.interactive = undefined;
  }
  if (acc.terminal) {
    acc.out.push(...acc.terminal.items);
    acc.terminal = undefined;
  }
}

function isTerminalErroredRow(rows: ChatMessage[], continuedErrors: ReadonlySet<string>): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (message) =>
        isErroredAssistant(message) &&
        !isErrorCardHeldWithAnswer(message) &&
        !continuedErrors.has(message.id),
    )
  );
}

function handleUnfoldedDisclosureItem(
  acc: DisclosureAcc,
  item: LeafRenderItem,
  rows: ChatMessage[],
  nextBoundary: string,
  answerIds: ReadonlySet<string>,
  rootOf: (id: string) => string,
): void {
  sealProcessGroup(acc, acc.group, acc.boundary);
  const crossedAnswer = rows.some((message) => answerIds.has(message.id));
  if (crossedAnswer) {
    acc.beforeAnswer.delete(acc.boundary);
    const answerRow = rows.find((message) => answerIds.has(message.id));
    const answerOwner = explicitRowTurnRoot(answerRow, rootOf);
    const kept = acc.group ?? (acc.carry?.boundary === nextBoundary ? acc.carry.group : undefined);
    acc.carry = { boundary: nextBoundary, answerOwner, group: kept, answerIndex: acc.out.length };
  } else if (acc.group && acc.out.includes(acc.group)) {
    acc.beforeAnswer.set(acc.boundary, acc.group);
    acc.carry = undefined;
  } else {
    acc.carry = undefined;
  }
  acc.group = undefined;
  acc.out.push(item);
}

function appendFoldedDisclosureItem(
  acc: DisclosureAcc,
  item: LeafRenderItem,
  rows: ChatMessage[],
  nextBoundary: string,
  activeIds: ReadonlySet<string>,
  rootOf: (id: string) => string,
): void {
  const rowOwner = explicitRowTurnRoot(rows[0], rootOf);
  const carryMatchesTurn = !(acc.carry?.answerOwner && rowOwner && rowOwner !== acc.carry.answerOwner);
  if (acc.carry && acc.carry.boundary === nextBoundary && carryMatchesTurn && !acc.group) {
    if (!acc.carry.group || acc.out.indexOf(acc.carry.group) < 0) {
      const created: ProcessRenderItem = { kind: "process", key: "", members: [], items: [], active: false };
      acc.carry.group = created;
      acc.out.splice(acc.carry.answerIndex, 0, created);
      acc.carry.answerIndex += 1;
    }
    acc.carry.group.items.push(item);
    acc.carry.group.members.push(...rows);
    if (rows.some((message) => activeIds.has(message.id))) acc.carry.group.active = true;
    return;
  }
  if (acc.carry) acc.carry = undefined;
  const rejoin = !acc.group ? acc.beforeAnswer.get(nextBoundary) : undefined;
  if (rejoin && acc.out.includes(rejoin)) {
    acc.group = rejoin;
    acc.boundary = nextBoundary;
  } else if (!acc.group || acc.boundary !== nextBoundary) {
    sealProcessGroup(acc, acc.group, acc.boundary);
    acc.group = { kind: "process", key: "", members: [], items: [], active: false };
    acc.boundary = nextBoundary;
    acc.beforeAnswer.set(nextBoundary, acc.group);
    acc.out.push(acc.group);
  }
  acc.group.items.push(item);
  acc.group.members.push(...rows);
  if (rows.some((message) => activeIds.has(message.id))) acc.group.active = true;
}

export function discloseProcess(
  items: LeafRenderItem[],
  messages: ChatMessage[],
  finals: boolean[],
  sending: boolean,
  turnLineageParents?: ReadonlyMap<string, string>,
): RenderItem[] {
  const rootOf = turnLineageRoot(messages, turnLineageParents);
  const answerIds = disclosureAnswerIds(messages, finals, sending, turnLineageParents);
  const continuedErrors = continuedErrorIds(messages);
  const activeStart = currentTurnStartIndex(messages);
  const activeIds = collectActiveDisclosureIds(messages, activeStart, sending, rootOf);
  const assistantArtifactKeys = collectAssistantArtifactKeys(items);
  const acc: DisclosureAcc = {
    out: [],
    owner: "head",
    group: undefined,
    boundary: "",
    carry: undefined,
    shellOrdinal: new Map(),
    beforeAnswer: new Map(),
    interactive: undefined,
    terminal: undefined,
  };

  for (const item of items) {
    const rows = itemMessages(item);
    if (rows.length > 0 && rows.every(isClearedGoalRecord)) continue;
    if (rows.length > 0 && rows.every((message) => message.role === "goal" && !isHistoricalGoalRecord(message))) {
      acc.out.push(item);
      continue;
    }
    const advanced = advanceDisclosureBoundary(rows, acc.owner);
    acc.owner = advanced.owner;
    const nextBoundary = advanced.boundary;
    flushBoundaryQueuesOnTurnChange(acc, nextBoundary);
    if (rows.length > 0 && rows.every(isInteractiveToolMessage)) {
      (acc.interactive ??= { boundary: nextBoundary, items: [] }).items.push(item);
      continue;
    }
    if (isTerminalErroredRow(rows, continuedErrors)) {
      (acc.terminal ??= { boundary: nextBoundary, items: [] }).items.push(item);
      continue;
    }
    const ownedArtifacts = assistantArtifactKeys.get(nextBoundary);
    const fold = rows.length > 0 && rows.every((message) =>
      isProcessMessage(message, answerIds.has(message.id), ownedArtifacts, continuedErrors.has(message.id)),
    );
    if (!fold) {
      handleUnfoldedDisclosureItem(acc, item, rows, nextBoundary, answerIds, rootOf);
      continue;
    }
    appendFoldedDisclosureItem(acc, item, rows, nextBoundary, activeIds, rootOf);
  }

  flushAllBoundaryQueues(acc);
  return withActiveSwarm(acc.out, messages, activeStart, sending);
}

/**
 * OCV5-367: where a process shell's step timings start and end.
 */
export function processTimeBounds(
  items: readonly RenderItem[],
  process: RenderItem,
  knownIndex?: number,
): { startedAt: number | null; endedAt: number | null; next?: ChatMessage; following: ChatMessage[] } {
  const index = typeof knownIndex === "number" && items[knownIndex] === process ? knownIndex : items.indexOf(process);
  const time = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  const before = index > 0 ? itemRows(items[index - 1]!).at(-1) : undefined;
  const after = index >= 0 && index + 1 < items.length ? itemRows(items[index + 1]!)[0] : undefined;
  const following: ChatMessage[] = [];
  if (index >= 0) {
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      let reachedUser = false;
      for (const message of itemRows(items[cursor]!)) {
        if (message.role === "user") {
          reachedUser = true;
          break;
        }
        following.push(message);
      }
      if (reachedUser) break;
    }
  }
  return {
    startedAt: before && !before._liveUnit ? time(before.completedAt) ?? time(before.ts) : null,
    endedAt: after && after.role !== "user" && !after._liveUnit ? time(after.ts) : null,
    next: after,
    following,
  };
}

export function turnHasVisibleWork(
  processDisclosure: boolean,
  items: RenderItem[],
  messages: ChatMessage[],
  turnStart: number,
): boolean {
  if (processDisclosure && items.some((item) => item.kind === "process" && item.active)) return true;
  for (let i = Math.max(0, turnStart); i < messages.length; i += 1) {
    const message = messages[i];
    if (message && isPlatedAssistantMessage(message)) return true;
  }
  return false;
}

export function filterTimelineInputMessages(
  rawMessages: ChatMessage[],
  messagesFingerprint: string,
): ChatMessage[] {
  void messagesFingerprint;
  let next = rawMessages.filter((message) => message.role !== "user" || message.status !== "queued");
  const shadowedAskTools = promptShadowedToolIds(next);
  if (shadowedAskTools.size > 0) next = next.filter((message) => !shadowedAskTools.has(message.id));
  return next;
}

export function buildTimelineRenderPipeline(
  renderableMessages: ChatMessage[],
  turnLineageParents: ReadonlyMap<string, string>,
  sending: boolean,
  liveTurnUsage: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot } | undefined,
  processDisclosure: boolean,
) {
  const nextTurnStart = currentTurnStartIndex(renderableMessages);
  let nextRatingFinal: boolean[] = [];
  let leafItems: LeafRenderItem[] = [];
  try {
    nextRatingFinal = turnFinalAssistantFlags(renderableMessages, turnLineageParents);
    leafItems = coalesceTeam(renderableMessages, 0, sending, liveTurnUsage);
  } catch {
    nextRatingFinal = renderableMessages.map(() => false);
    leafItems = renderableMessages.map((m, absIdx) => ({
      kind: "single" as const,
      m,
      isLast: absIdx === renderableMessages.length - 1,
      idx: absIdx,
    }));
  }
  let nextRenderItems: RenderItem[] = processDisclosure
    ? discloseProcess(leafItems, renderableMessages, nextRatingFinal, sending, turnLineageParents)
    : leafItems;
  nextRenderItems = coalesceTaskApprovalGroups<SingleRenderItem, RenderItem>(
    nextRenderItems,
    renderItemKey,
  );
  const nextActionRowFinal = turnRatingFlags(renderableMessages, nextRatingFinal, turnLineageParents);
  return {
    turnStart: nextTurnStart,
    ratingFinal: nextRatingFinal,
    renderItems: nextRenderItems,
    actionRowFinal: nextActionRowFinal,
  };
}
