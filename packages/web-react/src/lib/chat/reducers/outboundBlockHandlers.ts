/**
 * Per-block dispatch handlers for `outbound.message.blocks` (§7 / §8 / §9).
 */
import type { OutboundContentBlock, OutboundMessageWire } from "../frames";
import { addMessage, type ChatMessage, type ChatSession } from "../model";
import { applyPartialJsonDelta, findOrCreateStreamingRow } from "../pure";
import { applySwarmSnapshotBlock } from "../swarmReducer";
import {
  adoptMaterializedFanoutGroupForTool,
  adoptStandaloneDelegateRun,
  appendSubagentBlock,
  bindDelegateWaitToolRow,
  handleDelegateProgressBlock,
} from "./delegateReducer";
import {
  backgroundDelegateJobId,
  friendlyDelegateResultPreview,
  isDelegateProgressBlock,
  isDelegateResultWrapper,
  isRunningBackgroundToolResult,
  isSendToAgentToolName,
  parseDelegateToolInfo,
  parseToolInputObject,
} from "./delegateToolParser";
import {
  frameSeqAlreadyApplied,
  isFrozenLiveTarget,
  noteAppliedFrameSeq,
} from "./frameSeqCursor";
import { applyGoalBlock, applyPlanBlock, planTurnStart } from "./goalPlanGenReducer";
import type { DelegateToolInfo, FrameEffects } from "./types";

export type OutboundBlockContext = {
  frame: OutboundMessageWire;
  frameTurnOwnerId: string | undefined;
  isCronPush: boolean;
  effects: FrameEffects;
};

type RichBlock = OutboundContentBlock & {
  parentToolUseId?: string;
  messageId?: string;
  blockId?: string;
  toolName?: string;
  toolUseBlockId?: string;
};

type ToolUseBlockFields = {
  toolName?: string;
  blockId?: string;
  inputPreview?: string;
  inputJson?: unknown;
  partial?: boolean;
  messageId?: string;
  partialJsonDelta?: unknown;
  partialJsonOffset?: unknown;
};

type ToolResultBlockFields = {
  toolName?: string;
  blockId?: string;
  toolUseBlockId?: string;
  preview?: string;
  output?: string;
  outputJson?: unknown;
  isError?: boolean;
};

function extractBlockText(b: RichBlock): string {
  const raw = (b as { text?: unknown }).text;
  if (typeof raw === "string") return raw;
  return raw != null ? JSON.stringify(raw) : "";
}

function routeOwnedSubagentBlock(
  sess: ChatSession,
  block: RichBlock,
  blockText: string,
): boolean {
  if (!block.parentToolUseId || !sess._agentGroups?.has(block.parentToolUseId)) return false;
  const groupMsgId = sess._agentGroups.get(block.parentToolUseId);
  const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
  if (!groupMsg) return false;
  appendSubagentBlock(sess, groupMsg, block, blockText);
  return true;
}

function handleTextBlock(
  sess: ChatSession,
  b: RichBlock,
  blockText: string,
  ctx: OutboundBlockContext,
): void {
  sess._streamingThinking = null;
  if (b.messageId && sess._streamingAssistant && sess._streamingAssistant.id !== b.messageId) {
    sess._streamingAssistant.completedAt = Date.now();
    sess._streamingAssistant = null;
  }
  if (!sess._streamingAssistant) {
    if (
      b.messageId &&
      sess.messages.some(
        (message) =>
          message.id === b.messageId &&
          message.role === "assistant" &&
          isFrozenLiveTarget(message),
      )
    ) {
      return;
    }
    sess._streamingAssistant = findOrCreateStreamingRow(
      sess.messages,
      "assistant",
      b.messageId,
      (idOverride) => {
        const extra: Partial<ChatMessage> = ctx.isCronPush
          ? { cronPush: true, cronLabel: ctx.frame.cronJob?.label }
          : {};
        Object.assign(extra, idOverride);
        if (ctx.frameTurnOwnerId) extra._turnOwnerId = ctx.frameTurnOwnerId;
        return addMessage(sess, "assistant", "", extra);
      },
    );
  }
  if (ctx.frameTurnOwnerId && !sess._streamingAssistant._turnOwnerId) {
    sess._streamingAssistant._turnOwnerId = ctx.frameTurnOwnerId;
  }
  if (frameSeqAlreadyApplied(sess._streamingAssistant, ctx.frame.frameSeq)) return;
  noteAppliedFrameSeq(sess._streamingAssistant, ctx.frame.frameSeq);
  sess._streamingAssistant.text += blockText;
  sess._streamingAssistant.completedAt = Date.now();
}

function handleThinkingBlock(
  sess: ChatSession,
  b: RichBlock,
  blockText: string,
  ctx: OutboundBlockContext,
): void {
  if (b.messageId && sess._streamingThinking && sess._streamingThinking.id !== b.messageId) {
    sess._streamingThinking.completedAt = Date.now();
    sess._streamingThinking = null;
  }
  if (!sess._streamingThinking) {
    if (
      b.messageId &&
      sess.messages.some(
        (message) =>
          message.id === b.messageId &&
          message.role === "thinking" &&
          isFrozenLiveTarget(message),
      )
    ) {
      return;
    }
    sess._streamingThinking = findOrCreateStreamingRow(
      sess.messages,
      "thinking",
      b.messageId,
      (idOverride) =>
        addMessage(sess, "thinking", "", {
          ...idOverride,
          ...(ctx.frameTurnOwnerId ? { _turnOwnerId: ctx.frameTurnOwnerId } : {}),
        }),
    );
  }
  if (ctx.frameTurnOwnerId && !sess._streamingThinking._turnOwnerId) {
    sess._streamingThinking._turnOwnerId = ctx.frameTurnOwnerId;
  }
  if (frameSeqAlreadyApplied(sess._streamingThinking, ctx.frame.frameSeq)) return;
  noteAppliedFrameSeq(sess._streamingThinking, ctx.frame.frameSeq);
  sess._streamingThinking.text += blockText;
  sess._streamingThinking.completedAt = Date.now();
}

function resolveAgentOrDelegateCardSpec(
  tb: ToolUseBlockFields,
  delegateInfo: DelegateToolInfo | null,
): {
  desc: string;
  delegateFields: Partial<ChatMessage> | null;
  agentFields: Partial<ChatMessage>;
} {
  const input = parseToolInputObject(tb.inputJson, tb.inputPreview);
  const preview = (tb.inputPreview || "").replace(/[{}"]/g, "").slice(0, 80);
  if (delegateInfo) {
    const desc = (delegateInfo.goalRaw && delegateInfo.goalRaw.trim()) || preview || "委托子任务";
    const isBg = Boolean(delegateInfo.background || isSendToAgentToolName(tb.toolName));
    return {
      desc,
      delegateFields: {
        _delegate: true,
        _delegateAgentId: delegateInfo.agentId,
        _delegateGoal: delegateInfo.goalKey,
        ...(isBg ? { _background: true } : {}),
      },
      agentFields: {},
    };
  }
  const originRaw =
    input && typeof input.openclaudeOrigin === "string" ? input.openclaudeOrigin : "";
  const teamFallback = input?.openclaudeTeamFallback === true;
  const desc =
    (input && typeof input.description === "string" && input.description) ||
    (input && typeof input.prompt === "string" && input.prompt.slice(0, 80)) ||
    preview ||
    "子任务";
  return {
    desc,
    delegateFields: null,
    agentFields: {
      ...(originRaw ? { _agentGroupOrigin: originRaw } : {}),
      ...(teamFallback ? { _teamFallback: true } : {}),
    },
  };
}

function promoteExistingToolToDelegateGroup(
  sess: ChatSession,
  blockId: string,
  tb: ToolUseBlockFields,
  desc: string,
  fields: Partial<ChatMessage>,
  frameTurnOwnerId: string | undefined,
): boolean {
  const existingId = sess._blockIdToMsgId?.get(blockId);
  const existingTool = existingId
    ? sess.messages.find((m) => m.id === existingId && m.role === "tool")
    : null;
  if (!existingTool) return false;
  existingTool.role = "agent-group";
  existingTool.text = desc;
  existingTool.toolName = tb.toolName || "delegate_task";
  existingTool.inputPreview = tb.inputPreview || existingTool.inputPreview;
  existingTool.inputJson = tb.inputJson ?? existingTool.inputJson ?? null;
  delete existingTool.partialJson;
  existingTool._partial = false;
  existingTool._completed = false;
  existingTool.output = null;
  existingTool.error = false;
  existingTool.startTime = existingTool.startTime || existingTool.ts || Date.now();
  existingTool.childBlocks = Array.isArray(existingTool.childBlocks) ? existingTool.childBlocks : [];
  existingTool._delegate = true;
  existingTool._delegateAgentId = fields._delegateAgentId;
  existingTool._delegateGoal = fields._delegateGoal;
  if (fields._background) existingTool._background = true;
  if (!existingTool._turnOwnerId && frameTurnOwnerId) existingTool._turnOwnerId = frameTurnOwnerId;
  sess._agentGroups!.set(blockId, existingTool.id);
  sess._blockIdToMsgId?.set(blockId, existingTool.id);
  adoptStandaloneDelegateRun(sess, existingTool);
  return true;
}

function updateExistingAgentOrDelegateGroup(
  sess: ChatSession,
  groupMsg: ChatMessage,
  desc: string,
  tb: ToolUseBlockFields,
  delegateFields: Partial<ChatMessage> | null,
  agentFields: Partial<ChatMessage>,
  frameTurnOwnerId: string | undefined,
): void {
  if (groupMsg._source !== "server" && !groupMsg._turnOwnerId && frameTurnOwnerId) {
    groupMsg._turnOwnerId = frameTurnOwnerId;
  }
  if (desc && groupMsg.text !== desc) groupMsg.text = desc;
  groupMsg.inputPreview = tb.inputPreview || groupMsg.inputPreview;
  if (tb.inputJson !== undefined) groupMsg.inputJson = tb.inputJson;
  if (delegateFields) {
    groupMsg._delegate = true;
    groupMsg._delegateAgentId = delegateFields._delegateAgentId;
    groupMsg._delegateGoal = delegateFields._delegateGoal;
    if (delegateFields._background) groupMsg._background = true;
    adoptStandaloneDelegateRun(sess, groupMsg);
  } else {
    if (agentFields._agentGroupOrigin) groupMsg._agentGroupOrigin = agentFields._agentGroupOrigin;
    if (agentFields._teamFallback) groupMsg._teamFallback = true;
  }
}

function upsertAgentOrDelegateGroupBlock(
  sess: ChatSession,
  tb: ToolUseBlockFields,
  delegateInfo: DelegateToolInfo | null,
  frameTurnOwnerId: string | undefined,
): void {
  if (!sess._agentGroups) sess._agentGroups = new Map();
  if (!tb.blockId) return;
  const { desc, delegateFields, agentFields } = resolveAgentOrDelegateCardSpec(tb, delegateInfo);
  if (delegateInfo && delegateFields) {
    if (promoteExistingToolToDelegateGroup(sess, tb.blockId, tb, desc, delegateFields, frameTurnOwnerId)) {
      return;
    }
    if (adoptMaterializedFanoutGroupForTool(sess, delegateInfo, tb.blockId, desc)) return;
  }
  if (!sess._agentGroups.has(tb.blockId)) {
    const groupMsg = addMessage(sess, "agent-group", desc, {
      blockId: tb.blockId,
      toolName: delegateInfo ? tb.toolName || "delegate_task" : "Agent",
      inputPreview: tb.inputPreview || "",
      inputJson: tb.inputJson ?? null,
      startTime: Date.now(),
      childBlocks: [],
      ...agentFields,
      ...(delegateFields || {}),
      ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
    });
    sess._agentGroups.set(tb.blockId, groupMsg.id);
    sess._blockIdToMsgId?.set(tb.blockId, groupMsg.id);
    if (delegateFields) adoptStandaloneDelegateRun(sess, groupMsg);
    return;
  }
  const groupMsgId = sess._agentGroups.get(tb.blockId);
  const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
  if (groupMsg) {
    updateExistingAgentOrDelegateGroup(
      sess,
      groupMsg,
      desc,
      tb,
      delegateFields,
      agentFields,
      frameTurnOwnerId,
    );
  }
}

function updateExistingTopLevelToolCard(
  sess: ChatSession,
  mid: string | undefined,
  tb: ToolUseBlockFields,
  frameTurnOwnerId: string | undefined,
): void {
  const existing = sess.messages.find((m) => m.id === mid);
  if (!existing) return;
  if (frameTurnOwnerId && !existing._turnOwnerId) existing._turnOwnerId = frameTurnOwnerId;
  existing.inputPreview = tb.inputPreview || existing.inputPreview;
  const deltaResult = applyPartialJsonDelta(existing.partialJson, tb);
  if (deltaResult.action === "set") existing.partialJson = deltaResult.value;
  else if (deltaResult.action === "drop") delete existing.partialJson;
  if (tb.inputJson !== undefined && tb.inputJson !== null) {
    existing.inputJson = tb.inputJson;
    existing._inputRevision = (existing._inputRevision ?? 0) + 1;
  }
  existing._partial = !!tb.partial;
  if (!tb.partial) {
    delete existing.partialJson;
    existing._partialRafPending = false;
  }
  bindDelegateWaitToolRow(sess, existing);
}

function createTopLevelToolCard(
  sess: ChatSession,
  tb: ToolUseBlockFields,
  frameTurnOwnerId: string | undefined,
): void {
  const r = applyPartialJsonDelta(null, tb);
  const m = addMessage(sess, "tool", tb.toolName || "unknown", {
    ...(tb.messageId ? { id: tb.messageId } : {}),
    toolName: tb.toolName,
    blockId: tb.blockId,
    inputPreview: tb.inputPreview || "",
    inputJson: tb.inputJson || null,
    ...(tb.inputJson != null ? { _inputRevision: 1 } : {}),
    partialJson: r.action === "set" ? r.value : undefined,
    _partial: !!tb.partial,
    _completed: false,
    error: false,
    ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
  });
  if (tb.blockId) sess._blockIdToMsgId?.set(tb.blockId, m.id);
  bindDelegateWaitToolRow(sess, m);
}

function closeStreamingRowsBeforeTool(sess: ChatSession): void {
  if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now();
  if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now();
  sess._streamingAssistant = null;
  sess._streamingThinking = null;
}

function handleToolUseBlock(sess: ChatSession, b: RichBlock, ctx: OutboundBlockContext): void {
  closeStreamingRowsBeforeTool(sess);
  const tb = b as ToolUseBlockFields;
  const isAgent = /^Agent$/i.test(tb.toolName || "");
  const delegateInfo = parseDelegateToolInfo(tb.toolName, tb.inputJson, tb.inputPreview);
  if (isAgent || delegateInfo) {
    upsertAgentOrDelegateGroupBlock(sess, tb, delegateInfo, ctx.frameTurnOwnerId);
  } else if (tb.blockId && sess._blockIdToMsgId?.has(tb.blockId)) {
    updateExistingTopLevelToolCard(
      sess,
      sess._blockIdToMsgId.get(tb.blockId),
      tb,
      ctx.frameTurnOwnerId,
    );
  } else {
    createTopLevelToolCard(sess, tb, ctx.frameTurnOwnerId);
  }
}

function applyAgentGroupToolResult(
  sess: ChatSession,
  agentToolUseId: string | null,
  rb: ToolResultBlockFields,
  frameTurnOwnerId: string | undefined,
): boolean {
  if (!agentToolUseId || !sess._agentGroups?.has(agentToolUseId)) return false;
  const groupMsgId = sess._agentGroups.get(agentToolUseId);
  const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
  if (!groupMsg) return true;
  if (frameTurnOwnerId && !groupMsg._turnOwnerId) groupMsg._turnOwnerId = frameTurnOwnerId;
  const rawOutput = rb.output ?? rb.preview ?? "";
  const rawPreview = rb.preview ?? rawOutput;
  const preview =
    friendlyDelegateResultPreview(rawPreview) ||
    (isDelegateResultWrapper(rawPreview) ? "" : rawPreview);
  groupMsg.output = rawOutput;
  if (rb.outputJson !== undefined) groupMsg.outputJson = rb.outputJson;
  if (isRunningBackgroundToolResult(rawOutput, rb.outputJson)) {
    groupMsg._background = true;
    groupMsg._completed = false;
    const jobId = backgroundDelegateJobId(rawOutput, rb.outputJson);
    if (jobId) {
      groupMsg._delegateJobId = jobId;
      adoptStandaloneDelegateRun(sess, groupMsg);
      for (const row of [...sess.messages]) bindDelegateWaitToolRow(sess, row);
    }
  } else {
    groupMsg._completed = true;
    groupMsg._duration = Date.now() - (groupMsg.startTime || Date.now());
    if (preview && !groupMsg._resultPreview) groupMsg._resultPreview = preview.slice(0, 200);
    groupMsg._isError = !!rb.isError || !!groupMsg._isError;
  }
  return true;
}

function applyExistingToolCardResult(
  sess: ChatSession,
  toolUseId: string | null,
  rb: ToolResultBlockFields,
  frameTurnOwnerId: string | undefined,
): boolean {
  if (!toolUseId || !sess._blockIdToMsgId?.has(toolUseId)) return false;
  const mid = sess._blockIdToMsgId.get(toolUseId);
  const existing = sess.messages.find((m) => m.id === mid);
  if (existing) {
    if (existing.role === "agent-group") return true;
    if (frameTurnOwnerId && !existing._turnOwnerId) existing._turnOwnerId = frameTurnOwnerId;
    existing._completed = true;
    existing.completedAt = Date.now();
    existing.output = rb.output ?? rb.preview ?? "";
    if (rb.outputJson !== undefined) existing.outputJson = rb.outputJson;
    existing.error = !!rb.isError;
    existing._partial = false;
    return true;
  }
  return sess.messages.some(
    (m) => m.role === "agent-group" && m._swallowedToolBlockIds?.includes(toolUseId),
  );
}

function handleToolResultBlock(sess: ChatSession, b: RichBlock, ctx: OutboundBlockContext): void {
  closeStreamingRowsBeforeTool(sess);
  const rb = b as ToolResultBlockFields;
  const agentToolUseId =
    rb.toolUseBlockId || (rb.blockId ? String(rb.blockId).replace(/:result$/, "") : null);
  if (applyAgentGroupToolResult(sess, agentToolUseId, rb, ctx.frameTurnOwnerId)) return;
  const toolUseId = rb.toolUseBlockId || (rb.blockId ? rb.blockId.replace(/:result$/, "") : null);
  if (applyExistingToolCardResult(sess, toolUseId, rb, ctx.frameTurnOwnerId)) return;
  if (
    toolUseId &&
    sess.messages.some(
      (m) => m.role === "agent-group" && m._swallowedToolBlockIds?.includes(toolUseId),
    )
  ) {
    return;
  }
  if (rb.output === undefined && rb.preview === undefined) return;
  const m = addMessage(sess, "tool", rb.toolName || "unknown", {
    toolName: rb.toolName,
    blockId: rb.blockId,
    _completed: true,
    output: rb.output ?? rb.preview ?? "",
    ...(rb.outputJson !== undefined ? { outputJson: rb.outputJson } : {}),
    error: !!rb.isError,
    inputJson: null,
    inputPreview: "",
    _partial: false,
    ...(ctx.frameTurnOwnerId ? { _turnOwnerId: ctx.frameTurnOwnerId } : {}),
  });
  if (rb.blockId) sess._blockIdToMsgId?.set(rb.blockId, m.id);
}

function handleToolOutputTailBlock(sess: ChatSession, b: RichBlock): void {
  const tlb = b as {
    toolUseBlockId?: string;
    tail?: string;
    totalBytes?: number;
    truncatedHead?: boolean;
  };
  if (!tlb.toolUseBlockId || !sess._blockIdToMsgId?.has(tlb.toolUseBlockId)) return;
  const mid = sess._blockIdToMsgId.get(tlb.toolUseBlockId);
  const existing = sess.messages.find((m) => m.id === mid);
  if (!existing) return;
  const tail = typeof tlb.tail === "string" ? tlb.tail : "";
  const totalBytes = typeof tlb.totalBytes === "number" ? tlb.totalBytes : 0;
  const truncatedHead = !!tlb.truncatedHead;
  const prev = existing.bashTail?.totalBytes ?? 0;
  if (totalBytes < prev) return;
  existing.bashTail = { tail, totalBytes, truncatedHead };
}

function handleSwarmSnapshotBlock(
  sess: ChatSession,
  b: RichBlock,
  ctx: OutboundBlockContext,
): void {
  const swarmRes = applySwarmSnapshotBlock(
    sess,
    b as { blockId?: string; snapshot?: unknown },
    planTurnStart(sess.messages, sess.messages.length),
    ctx.frameTurnOwnerId,
    isFrozenLiveTarget,
  );
  if (swarmRes !== "missing_base") return;
  const nowMs = Date.now();
  if (!sess._swarmResyncLastAt || nowMs - sess._swarmResyncLastAt >= 5_000) {
    sess._swarmResyncLastAt = nowMs;
    if (ctx.effects.resyncSwarmUnits) {
      ctx.effects.resyncSwarmUnits(sess.id, ctx.frameTurnOwnerId);
    } else {
      ctx.effects.forceSync?.(sess.id);
    }
  }
}

type BlockHandlerFn = (
  sess: ChatSession,
  b: RichBlock,
  blockText: string,
  ctx: OutboundBlockContext,
) => void;

const BLOCK_DISPATCH: Partial<Record<OutboundContentBlock["kind"], BlockHandlerFn>> = {
  text: handleTextBlock,
  thinking: handleThinkingBlock,
  plan: (sess, b, _text, ctx) =>
    applyPlanBlock(
      sess,
      b as Parameters<typeof applyPlanBlock>[1],
      ctx.frameTurnOwnerId,
    ),
  goal: (sess, b, _text, ctx) =>
    applyGoalBlock(
      sess,
      b as Parameters<typeof applyGoalBlock>[1],
      ctx.frameTurnOwnerId,
    ),
  tool_use: (sess, b, _text, ctx) => handleToolUseBlock(sess, b, ctx),
  tool_result: (sess, b, _text, ctx) => handleToolResultBlock(sess, b, ctx),
  tool_output_tail: (sess, b) => handleToolOutputTailBlock(sess, b),
  swarm_snapshot: (sess, b, _text, ctx) => handleSwarmSnapshotBlock(sess, b, ctx),
};

export function applyOutboundContentBlocks(
  sess: ChatSession,
  blocksToRender: readonly OutboundContentBlock[],
  ctx: OutboundBlockContext,
): void {
  for (const block of blocksToRender) {
    const b = block as RichBlock;
    const blockText = extractBlockText(b);
    if (isDelegateProgressBlock(b)) {
      handleDelegateProgressBlock(sess, b, ctx.frameTurnOwnerId);
      continue;
    }
    if (routeOwnedSubagentBlock(sess, b, blockText)) continue;
    const handler = BLOCK_DISPATCH[b.kind];
    if (handler) handler(sess, b, blockText, ctx);
  }
}
