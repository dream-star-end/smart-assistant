/**
 * Subagent / delegate card binding, adoption, normalization, and `delegate_progress` frame reducer.
 */
import type { OutboundContentBlock } from "../frames";
import {
  addMessage,
  agentGroupRunId,
  type ChatMessage,
  type ChatSession,
  type ChildBlock,
  isServerAuthoredRow,
  rebuildIndexes,
} from "../model";
import { repairPostFinalProcessOrder } from "../order";
import { applyPartialJsonDelta } from "../pure";
import {
  delegateGoalsMatch,
  friendlyDelegateResultPreview,
  hasActiveFanoutDelegate,
  legacyDelegateEntriesToChildBlocks,
  legacyDelegateTextToChildBlock,
  normalizeDelegateGoalKey,
  parseDelegateToolInfo,
  parseDelegateWaitJobId,
} from "./delegateToolParser";
import { isImmutableTapeViewportRow } from "./frameSeqCursor";
import type { DelegateProgressBlock, DelegateToolInfo } from "./types";

function appendCoalescedSubagentText(
  children: ChildBlock[],
  kind: "text" | "thinking",
  blockText: string,
): void {
  if (!blockText) return;
  const last = children[children.length - 1];
  if (last && last.kind === kind) last.text = (last.text || "") + blockText;
  else children.push({ kind, text: blockText });
}

function updateExistingSubagentToolUse(
  existing: ChildBlock,
  block: Extract<OutboundContentBlock, { kind: "tool_use" }>,
): void {
  existing.inputPreview = block.inputPreview || existing.inputPreview;
  const dr = applyPartialJsonDelta(existing.partialJson, block);
  if (dr.action === "set") existing.partialJson = dr.value;
  else if (dr.action === "drop") Reflect.deleteProperty(existing, "partialJson");
  if (block.inputJson !== undefined && block.inputJson !== null) {
    existing.inputJson = block.inputJson;
    existing._inputRevision = (existing._inputRevision ?? 0) + 1;
  }
  existing._partial = !!block.partial;
  if (!block.partial) Reflect.deleteProperty(existing, "partialJson");
  if (block.toolName) existing.toolName = block.toolName;
}

function createSubagentToolUseChild(
  sess: ChatSession,
  groupMsg: ChatMessage,
  block: Extract<OutboundContentBlock, { kind: "tool_use" }>,
): ChildBlock {
  const r = applyPartialJsonDelta(null, block);
  const initialPartialJson = r.action === "set" ? r.value : undefined;
  if (block.blockId && /^Agent$/i.test(block.toolName || "")) {
    if (!sess._agentGroups) sess._agentGroups = new Map();
    sess._agentGroups.set(block.blockId, groupMsg.id);
  }
  return {
    kind: "tool_use",
    blockId: block.blockId,
    toolName: block.toolName || "unknown",
    inputPreview: block.inputPreview || "",
    inputJson: block.inputJson != null ? block.inputJson : null,
    ...(block.inputJson != null ? { _inputRevision: 1 } : {}),
    ...(initialPartialJson !== undefined ? { partialJson: initialPartialJson } : {}),
    _partial: !!block.partial,
    _completed: false,
    error: false,
  };
}

function applySubagentToolResultBlock(
  children: ChildBlock[],
  block: Extract<OutboundContentBlock, { kind: "tool_result" }>,
): void {
  const toolUseId =
    block.toolUseBlockId || (block.blockId ? String(block.blockId).replace(/:result$/, "") : null);
  const target = toolUseId
    ? children.find((c) => c.kind === "tool_use" && c.blockId === toolUseId)
    : null;
  if (target) {
    target._completed = true;
    target.output = block.output ?? block.preview ?? "";
    if (block.outputJson !== undefined) target.outputJson = block.outputJson;
    target.error = !!block.isError;
    target._partial = false;
    return;
  }
  children.push({
    kind: "tool_use",
    blockId: block.blockId,
    toolName: block.toolName || "unknown",
    inputPreview: "",
    inputJson: null,
    _partial: false,
    _completed: true,
    output: block.output ?? block.preview ?? "",
    ...(block.outputJson !== undefined ? { outputJson: block.outputJson } : {}),
    error: !!block.isError,
  });
}

function applySubagentToolOutputTail(
  children: ChildBlock[],
  block: Extract<OutboundContentBlock, { kind: "tool_output_tail" }>,
): void {
  const tail = typeof block.tail === "string" ? block.tail : "";
  const totalBytes = typeof block.totalBytes === "number" ? block.totalBytes : 0;
  const truncatedHead = !!block.truncatedHead;
  const target = block.toolUseBlockId
    ? children.find((c) => c.kind === "tool_use" && c.blockId === block.toolUseBlockId)
    : null;
  if (target) {
    const prev = target.bashTail?.totalBytes ?? 0;
    if (totalBytes >= prev) target.bashTail = { tail, totalBytes, truncatedHead };
  }
}

/** 子 agent 块合并进 owning Agent 卡 childBlocks（coalesce 同类尾块）。*/
export function appendSubagentBlock(
  sess: ChatSession,
  groupMsg: ChatMessage,
  block: OutboundContentBlock,
  blockText: string,
): void {
  if (!Array.isArray(groupMsg.childBlocks)) groupMsg.childBlocks = [];
  const children = groupMsg.childBlocks;
  if (block.kind === "text" || block.kind === "thinking") {
    appendCoalescedSubagentText(children, block.kind, blockText);
  } else if (block.kind === "tool_use") {
    const existing = block.blockId
      ? children.find((c) => c.kind === "tool_use" && c.blockId === block.blockId)
      : null;
    if (existing) updateExistingSubagentToolUse(existing, block);
    else children.push(createSubagentToolUseChild(sess, groupMsg, block));
  } else if (block.kind === "tool_result") {
    applySubagentToolResultBlock(children, block);
  } else if (block.kind === "tool_output_tail") {
    applySubagentToolOutputTail(children, block);
  } else if (block.kind === "plan" || block.kind === "goal") {
    children.push({ ...block } as ChildBlock);
  }
}

/** 严格唯一 (agentId, goal) 把 delegate run 绑回 leader 的 delegate_task 卡。*/
function bindDelegateRunToGroup(
  sess: ChatSession,
  block: { agentId?: string; goal?: string; jobId?: string; runId: string },
): string | null {
  if (block.jobId) {
    const exact = sess.messages.filter(
      (m) =>
        m.role === "agent-group" &&
        !isServerAuthoredRow(m) &&
        m._delegate &&
        !m._delegateRunId &&
        m._delegateJobId === block.jobId,
    );
    if (exact.length === 1) {
      exact[0]._delegateRunId = block.runId;
      (sess._delegateRunGroups ??= new Map()).set(block.runId, exact[0].id);
      return exact[0].id;
    }
  }
  const agentId = block.agentId || "";
  const goal = typeof block.goal === "string" ? block.goal : "";
  if (!agentId || !goal) return null;
  const goalKey = normalizeDelegateGoalKey(goal);
  const candidates = sess.messages.filter(
    (m) =>
      m.role === "agent-group" &&
      !isServerAuthoredRow(m) &&
      m._delegate &&
      !m._delegateRunId &&
      m._delegateAgentId === agentId &&
      delegateGoalsMatch(m._delegateGoal, goalKey),
  );
  if (candidates.length !== 1) return null;
  const groupMsg = candidates[0];
  groupMsg._delegateRunId = block.runId;
  (sess._delegateRunGroups ??= new Map()).set(block.runId, groupMsg.id);
  return groupMsg.id;
}

function canMergeDelegateProgress(groupMsg: ChatMessage, standalone: ChatMessage): boolean {
  if (!groupMsg || groupMsg.role !== "agent-group" || !groupMsg._delegate) return false;
  if (!standalone || standalone.role !== "delegate-progress" || standalone._adoptedInto) return false;
  return !(groupMsg._delegateRunId && standalone.runId && groupMsg._delegateRunId !== standalone.runId);
}

function copyStandaloneFieldsToGroup(groupMsg: ChatMessage, standalone: ChatMessage): void {
  if (standalone.summary && !groupMsg._resultPreview) {
    groupMsg._resultPreview = String(standalone.summary).slice(0, 200);
  }
  if (standalone.summary && groupMsg.output == null) groupMsg.output = String(standalone.summary);
  if (standalone._delegateUsageByRun) {
    groupMsg._delegateUsageByRun = {
      ...(groupMsg._delegateUsageByRun ?? {}),
      ...standalone._delegateUsageByRun,
    };
  }
  if (standalone.error || standalone._isError) groupMsg._isError = true;
  if (standalone._completed && !groupMsg._completed) groupMsg._completed = true;
  if (standalone.completedAt && !groupMsg.completedAt) groupMsg.completedAt = standalone.completedAt;
  if (groupMsg._source !== "server" && !groupMsg._turnOwnerId) {
    groupMsg._turnOwnerId = standalone._turnOwnerId ?? standalone._clientMessageId;
  }
}

function mergeDelegateProgressIntoGroup(
  sess: ChatSession,
  groupMsg: ChatMessage,
  standalone: ChatMessage,
): boolean {
  if (!canMergeDelegateProgress(groupMsg, standalone)) return false;
  const entryBlocks = legacyDelegateEntriesToChildBlocks(standalone.entries);
  const richBlocks = Array.isArray(standalone.childBlocks) ? standalone.childBlocks : [];
  const mergedChildren = [...(groupMsg.childBlocks ?? []), ...entryBlocks, ...richBlocks];
  groupMsg.childBlocks = mergedChildren;
  for (const child of mergedChildren) {
    if (child?.kind === "tool_use" && child.blockId && /^Agent$/i.test(child.toolName || "")) {
      (sess._agentGroups ??= new Map()).set(child.blockId, groupMsg.id);
    }
  }
  copyStandaloneFieldsToGroup(groupMsg, standalone);
  if (standalone.runId) {
    groupMsg._delegateRunId = standalone.runId;
    (sess._delegateRunGroups ??= new Map()).set(standalone.runId, groupMsg.id);
  }
  standalone._adoptedInto = groupMsg.id;
  const idx = sess.messages.findIndex((m) => m === standalone);
  if (idx >= 0) sess.messages.splice(idx, 1);
  return true;
}

function isEligibleLiveDelegatePair(groupMsg: ChatMessage, progress: ChatMessage): boolean {
  if (groupMsg.role !== "agent-group" || !groupMsg._delegate || progress.role !== "delegate-progress") {
    return false;
  }
  return !isImmutableTapeViewportRow(progress) && !isServerAuthoredRow(groupMsg);
}

function matchesDelegateJobOrRunId(groupMsg: ChatMessage, progress: ChatMessage): boolean | null {
  if (progress._delegateJobId) {
    if (groupMsg._delegateJobId === progress._delegateJobId) return true;
    if (groupMsg._delegateJobId) return false;
  }
  if (progress.runId) {
    if (groupMsg._delegateRunId === progress.runId) return true;
    if (groupMsg._delegateRunId) return false;
  }
  return null;
}

function matchesDelegateProgress(groupMsg: ChatMessage, progress: ChatMessage): boolean {
  if (!isEligibleLiveDelegatePair(groupMsg, progress)) return false;
  const idMatch = matchesDelegateJobOrRunId(groupMsg, progress);
  if (idMatch !== null) return idMatch;
  const agentId = groupMsg._delegateAgentId || "";
  const goal = groupMsg._delegateGoal || "";
  return (
    !!agentId &&
    !!goal &&
    (progress.agentId || "") === agentId &&
    delegateGoalsMatch(progress._delegateGoal, goal)
  );
}

function findSingleMatchingDelegateGroup(sess: ChatSession, progress: ChatMessage): ChatMessage | null {
  const matches = sess.messages.filter((m) => matchesDelegateProgress(m, progress));
  return matches.length === 1 ? matches[0] : null;
}

export function adoptMaterializedFanoutGroupForTool(
  sess: ChatSession,
  info: DelegateToolInfo,
  blockId: string,
  desc: string,
): string | null {
  const candidates = sess.messages.filter(
    (m) =>
      m.role === "agent-group" &&
      !isServerAuthoredRow(m) &&
      !!m._delegate &&
      !m.blockId &&
      !m._completed &&
      typeof m._delegateRunId === "string" &&
      m._delegateAgentId === info.agentId &&
      delegateGoalsMatch(m._delegateGoal, info.goalKey),
  );
  if (candidates.length !== 1) return null;
  const groupMsg = candidates[0];
  groupMsg.blockId = blockId;
  if (desc && groupMsg.text !== desc) groupMsg.text = desc;
  (sess._agentGroups ??= new Map()).set(blockId, groupMsg.id);
  sess._blockIdToMsgId?.set(blockId, groupMsg.id);
  return groupMsg.id;
}

/** 反向 adopt：standalone delegate-progress 卡并入后绑定的 agent-group。*/
export function adoptStandaloneDelegateRun(sess: ChatSession, groupMsg: ChatMessage): boolean {
  if (!groupMsg || !groupMsg._delegate) return false;
  const candidates = sess.messages.filter((m) => matchesDelegateProgress(groupMsg, m));
  if (candidates.length !== 1) return false;
  return mergeDelegateProgressIntoGroup(sess, groupMsg, candidates[0]);
}

/** Bash `oc-memory delegate-wait <jobId>`：能对上已有组则从时间线摘掉；对不上保持普通工具卡。 */
export function bindDelegateWaitToolRow(sess: ChatSession, msg: ChatMessage): boolean {
  if (isImmutableTapeViewportRow(msg) || msg.role !== "tool") return false;
  const jobId = parseDelegateWaitJobId(msg.toolName, msg.inputJson, msg.inputPreview);
  if (!jobId) return false;
  const groups = sess.messages.filter(
    (m) =>
      m.role === "agent-group" &&
      m._delegate &&
      !isServerAuthoredRow(m) &&
      !isImmutableTapeViewportRow(m) &&
      m._delegateJobId === jobId,
  );
  if (groups.length !== 1) return false;
  const group = groups[0];
  msg._adoptedInto = group.id;
  if (msg.blockId) {
    const ids = group._swallowedToolBlockIds ?? [];
    if (!ids.includes(msg.blockId)) group._swallowedToolBlockIds = [...ids, msg.blockId];
    sess._blockIdToMsgId?.set(msg.blockId, group.id);
  }
  const idx = sess.messages.indexOf(msg);
  if (idx >= 0) sess.messages.splice(idx, 1);
  return true;
}

function mergeToolRowIntoExistingDelegateGroup(
  sess: ChatSession,
  msg: ChatMessage,
  existingGroup: ChatMessage,
): true {
  if (existingGroup._source !== "server" && !existingGroup._turnOwnerId) {
    existingGroup._turnOwnerId = msg._turnOwnerId ?? msg._clientMessageId;
  }
  const preview = friendlyDelegateResultPreview(msg.output);
  if (preview && !existingGroup._resultPreview) existingGroup._resultPreview = preview.slice(0, 200);
  if (msg.inputJson !== undefined) existingGroup.inputJson = msg.inputJson;
  if (msg.partialJson !== undefined) existingGroup.partialJson = msg.partialJson;
  if (msg.inputPreview !== undefined) existingGroup.inputPreview = msg.inputPreview;
  if (msg.output !== undefined) existingGroup.output = msg.output;
  if (msg.bashTail !== undefined) existingGroup.bashTail = msg.bashTail;
  if (msg.error) existingGroup._isError = true;
  if (msg._completed && !existingGroup._completed) existingGroup._completed = true;
  const idx = sess.messages.indexOf(msg);
  if (idx >= 0) sess.messages.splice(idx, 1);
  return true;
}

function convertToolRowInPlaceToDelegateGroup(
  sess: ChatSession,
  msg: ChatMessage,
  info: DelegateToolInfo,
): true {
  msg.role = "agent-group";
  msg.text = info.goalRaw.trim() || msg.text || "委托子任务";
  msg.toolName = msg.toolName || "delegate_task";
  msg.startTime = msg.startTime || msg.ts || Date.now();
  msg.childBlocks = Array.isArray(msg.childBlocks) ? msg.childBlocks : [];
  msg._delegate = true;
  msg._delegateAgentId = info.agentId;
  msg._delegateGoal = info.goalKey;
  msg._completed = !!msg._completed;
  if (msg._source !== "server" && !msg._turnOwnerId) msg._turnOwnerId = msg._clientMessageId;
  const preview = friendlyDelegateResultPreview(msg.output);
  if (preview && !msg._resultPreview) msg._resultPreview = preview.slice(0, 200);
  if (msg.error) msg._isError = true;
  if (msg.blockId) {
    (sess._agentGroups ??= new Map()).set(msg.blockId, msg.id);
    sess._blockIdToMsgId?.set(msg.blockId, msg.id);
  }
  return true;
}

function normalizeDelegateToolRow(sess: ChatSession, msg: ChatMessage): boolean {
  if (isImmutableTapeViewportRow(msg) || msg.role !== "tool") return false;
  if (bindDelegateWaitToolRow(sess, msg)) return true;
  const info = parseDelegateToolInfo(msg.toolName, msg.inputJson, msg.inputPreview);
  if (!info) return false;
  const existingGroup = msg.blockId
    ? sess.messages.find(
        (m) =>
          m !== msg &&
          m.role === "agent-group" &&
          m.blockId === msg.blockId &&
          !isImmutableTapeViewportRow(m),
      )
    : null;
  if (existingGroup) return mergeToolRowIntoExistingDelegateGroup(sess, msg, existingGroup);
  return convertToolRowInPlaceToDelegateGroup(sess, msg, info);
}

function foldServerAuthoredAgentGroups(sess: ChatSession): boolean {
  const localRichRunIds = new Set<string>();
  for (const m of sess.messages) {
    if (m.role === "agent-group" && !isServerAuthoredRow(m)) {
      const rid = agentGroupRunId(m);
      if (rid) localRichRunIds.add(rid);
    }
  }
  const seenServerRunIds = new Set<string>();
  let changed = false;
  for (const m of [...sess.messages]) {
    if (m.role !== "agent-group" || !isServerAuthoredRow(m) || isImmutableTapeViewportRow(m)) {
      continue;
    }
    const rid = agentGroupRunId(m);
    if (!rid) continue;
    if (localRichRunIds.has(rid) || seenServerRunIds.has(rid)) {
      const idx = sess.messages.indexOf(m);
      if (idx >= 0) {
        sess.messages.splice(idx, 1);
        changed = true;
      }
      continue;
    }
    seenServerRunIds.add(rid);
  }
  return changed;
}

/** Collapse old/persisted delegate tool + delegate-progress duplicate rows into one agent-group. */
export function normalizeDelegateCards(sess: ChatSession): void {
  let changed = false;
  for (const msg of [...sess.messages]) changed = normalizeDelegateToolRow(sess, msg) || changed;
  for (const progress of [...sess.messages]) {
    if (isImmutableTapeViewportRow(progress)) continue;
    if (progress.role !== "delegate-progress" || progress._adoptedInto) continue;
    const group = findSingleMatchingDelegateGroup(sess, progress);
    if (group) changed = mergeDelegateProgressIntoGroup(sess, group, progress) || changed;
  }
  changed = foldServerAuthoredAgentGroups(sess) || changed;
  if (!changed) return;
  sess._blockIdToMsgId = new Map();
  sess._agentGroups = new Map();
  rebuildIndexes(sess);
  sess._delegateRunGroups = new Map();
  for (const msg of sess.messages) {
    if (msg.role === "agent-group" && msg._delegateRunId && !isImmutableTapeViewportRow(msg)) {
      sess._delegateRunGroups.set(msg._delegateRunId, msg.id);
    }
  }
}

function applyDelegateUsageSnapshot(msg: ChatMessage, block: DelegateProgressBlock): boolean {
  if (block.phase !== "usage" || !block.usageRunId || !block.usage) return false;
  msg._delegateUsageByRun = {
    ...(msg._delegateUsageByRun ?? {}),
    [block.usageRunId]: { ...block.usage },
  };
  return true;
}

function applyDelegatePhaseToGroup(
  sess: ChatSession,
  groupMsg: ChatMessage,
  block: DelegateProgressBlock,
): void {
  if (applyDelegateUsageSnapshot(groupMsg, block)) return;
  if (block.phase === "done" || block.phase === "error") {
    groupMsg._completed = true;
    groupMsg.completedAt = Date.now();
    if (block.text && !groupMsg._resultPreview) {
      groupMsg._resultPreview = String(block.text).slice(0, 200);
    }
    if (block.text && groupMsg.output == null) groupMsg.output = String(block.text);
    if (block.phase === "error") groupMsg._isError = true;
    return;
  }
  if (block.block && typeof block.block === "object") {
    const child = block.block;
    const rawChildText = (child as { text?: unknown }).text;
    const childText = typeof rawChildText === "string" ? rawChildText : "";
    appendSubagentBlock(sess, groupMsg, child, childText);
    return;
  }
  const text = typeof block.text === "string" ? block.text : "";
  const child = legacyDelegateTextToChildBlock(block.phase, text);
  if (child) appendSubagentBlock(sess, groupMsg, child as OutboundContentBlock, child.text || "");
}

function placeProcessCardAtCallSite(sess: ChatSession, card: ChatMessage): void {
  const idx = sess.messages.lastIndexOf(card);
  if (idx < 0) return;
  let insertAt = -1;
  const streaming = sess._streamingAssistant;
  if (streaming) {
    const sidx = sess.messages.indexOf(streaming);
    if (sidx >= 0 && sidx < idx) insertAt = sidx;
  }
  if (insertAt < 0 && !sess._sendingInFlight) {
    for (let i = idx - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (
        m?.role === "assistant" &&
        !m._turnTapeProcess &&
        !m._errorCode &&
        typeof m.text === "string" &&
        m.text.trim().length > 0
      ) {
        insertAt = i;
        break;
      }
    }
  }
  if (insertAt < 0 || insertAt >= idx) return;
  sess.messages.splice(idx, 1);
  sess.messages.splice(insertAt, 0, card);
}

function hasFrozenDelegateCard(sess: ChatSession, runId: string): boolean {
  return sess.messages.some(
    (m) =>
      !m._adoptedInto &&
      (isServerAuthoredRow(m) || isImmutableTapeViewportRow(m)) &&
      ((m.role === "delegate-progress" && m.runId === runId) ||
        (m.role === "agent-group" && m._delegateRunId === runId)),
  );
}

function resolveOrBindDelegateGroupId(
  sess: ChatSession,
  block: DelegateProgressBlock,
): string | undefined {
  const existing = sess._delegateRunGroups?.get(block.runId);
  if (existing !== undefined) return existing;
  const bound = sess.messages.find(
    (m) => m.role === "agent-group" && !isServerAuthoredRow(m) && m._delegateRunId === block.runId,
  );
  if (bound) {
    (sess._delegateRunGroups ??= new Map()).set(block.runId, bound.id);
    return bound.id;
  }
  return bindDelegateRunToGroup(sess, block) ?? undefined;
}

function materializeFanoutDelegateGroupCard(
  sess: ChatSession,
  block: DelegateProgressBlock,
  goalRaw: string,
  goalKey: string,
  jobId: string | undefined,
  turnOwnerId: string | undefined,
): void {
  const groupMsg = addMessage(sess, "agent-group", goalRaw.trim() || "子任务", {
    startTime: Date.now(),
    childBlocks: [],
    _delegate: true,
    _delegateRunId: block.runId,
    _delegateAgentId: block.agentId || "",
    _delegateGoal: goalKey,
    _delegateJobId: jobId,
    _completed: false,
    ...(turnOwnerId ? { _turnOwnerId: turnOwnerId } : {}),
  });
  placeProcessCardAtCallSite(sess, groupMsg);
  (sess._delegateRunGroups ??= new Map()).set(block.runId, groupMsg.id);
  applyDelegatePhaseToGroup(sess, groupMsg, block);
  if (!sess._sendingInFlight) sess.messages = repairPostFinalProcessOrder(sess.messages);
}

function appendLegacyDelegateEntry(msg: ChatMessage, block: DelegateProgressBlock): void {
  if (!Array.isArray(msg.entries)) msg.entries = [];
  const text = typeof block.text === "string" ? block.text : "";
  if (!text) return;
  const last = msg.entries[msg.entries.length - 1];
  const coalescible = block.phase === "text" || block.phase === "thinking";
  if (last && coalescible && last.phase === block.phase && !last.isError && !block.isError) {
    last.text = `${last.text || ""}${text}`;
    last.ts = Date.now();
  } else {
    msg.entries.push({
      phase: block.phase || "text",
      text,
      toolName: block.toolName || "",
      isError: !!block.isError,
      ts: Date.now(),
    });
  }
  if (msg.entries.length > 120) msg.entries.splice(0, msg.entries.length - 120);
}

function applyPhaseToStandaloneDelegateProgress(
  sess: ChatSession,
  msg: ChatMessage,
  block: DelegateProgressBlock,
  goalRaw: string,
  goalKey: string,
): void {
  if (block.agentId) msg.agentId = block.agentId;
  if (goalRaw && !msg._delegateGoal) {
    msg.goal = goalRaw;
    msg._delegateGoal = goalKey;
  }
  if (applyDelegateUsageSnapshot(msg, block)) return;
  if (block.phase === "done" || block.phase === "error") {
    msg._completed = true;
    msg.completedAt = Date.now();
    msg.error = block.phase === "error" || !!block.isError;
    if (block.text) msg.summary = block.text;
    return;
  }
  if (block.block && typeof block.block === "object") {
    if (!Array.isArray(msg.childBlocks)) msg.childBlocks = [];
    const child = block.block;
    const rawChildText = (child as { text?: unknown }).text;
    const childText = typeof rawChildText === "string" ? rawChildText : "";
    appendSubagentBlock(sess, msg, child, childText);
    return;
  }
  appendLegacyDelegateEntry(msg, block);
}

function ensureStandaloneDelegateProgressCard(
  sess: ChatSession,
  block: DelegateProgressBlock,
  turnOwnerId: string | undefined,
): { msg: ChatMessage; goalRaw: string; goalKey: string } | null {
  const runId = block.runId;
  const existing =
    sess.messages.find(
      (m) =>
        m.role === "delegate-progress" &&
        m.runId === runId &&
        !m._adoptedInto &&
        !isImmutableTapeViewportRow(m),
    ) || null;
  const goalRaw = typeof block.goal === "string" ? block.goal : "";
  const goalKey = goalRaw ? normalizeDelegateGoalKey(goalRaw) : "";
  if (existing) return { msg: existing, goalRaw, goalKey };

  const jobId = typeof block.jobId === "string" ? block.jobId : undefined;
  if (hasFrozenDelegateCard(sess, runId)) return null;
  if (hasActiveFanoutDelegate(sess)) {
    materializeFanoutDelegateGroupCard(sess, block, goalRaw, goalKey, jobId, turnOwnerId);
    return null;
  }
  const msg = addMessage(sess, "delegate-progress", "", {
    runId,
    agentId: block.agentId || "",
    goal: goalRaw,
    _delegateGoal: goalKey,
    _delegateJobId: jobId,
    entries: [],
    childBlocks: [],
    _completed: false,
    ...(turnOwnerId ? { _turnOwnerId: turnOwnerId } : {}),
  });
  placeProcessCardAtCallSite(sess, msg);
  return { msg, goalRaw, goalKey };
}

export function handleDelegateProgressBlock(
  sess: ChatSession,
  block: DelegateProgressBlock,
  turnOwnerId?: string,
): void {
  if (!block.runId) return;
  if ((block.phase === "done" || block.phase === "error") && sess._turnProgressHint?.startsWith("子任务")) {
    sess._turnProgressHint = undefined;
  }
  const groupMsgId = resolveOrBindDelegateGroupId(sess, block);
  if (groupMsgId) {
    const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
    if (groupMsg) {
      if (groupMsg._source !== "server" && !groupMsg._turnOwnerId && turnOwnerId) {
        groupMsg._turnOwnerId = turnOwnerId;
      }
      applyDelegatePhaseToGroup(sess, groupMsg, block);
      return;
    }
  }
  const resolved = ensureStandaloneDelegateProgressCard(sess, block, turnOwnerId);
  if (!resolved) return;
  applyPhaseToStandaloneDelegateProgress(
    sess,
    resolved.msg,
    block,
    resolved.goalRaw,
    resolved.goalKey,
  );
  const group = findSingleMatchingDelegateGroup(sess, resolved.msg);
  if (group) mergeDelegateProgressIntoGroup(sess, group, resolved.msg);
  if (!sess._sendingInFlight) sess.messages = repairPostFinalProcessOrder(sess.messages);
}
