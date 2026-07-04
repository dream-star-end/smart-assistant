/**
 * v5 出站帧 → 消息模型**翻译 reducer**。从现网 vanilla handleOutbound + 各独立帧
 * handler 逐条复刻（websocket.js:2559-3540 主线 + 3565-4595 各 handler）。
 *
 * 与 vanilla 的唯一架构差异：**零 DOM / 零 timer / 零 setState**。reducer 只做
 * `session.messages` 就地 mutation + 维护游标/指针/守卫；所有跨切面副作用
 * （deferred auto-continue、REST sync、余额刷新、错误上报、drain 推进、
 * thinking-safety 重置）通过 `FrameEffects` 回调上交给 ChatSocket（它持有
 * timer / ws / REST）。节流渲染（rAF/80ms/120ms）下放到订阅侧批量 notify。
 *
 * 漏掉本文件任一守卫 = 重现一类历史已修 bug（每条都标了 §）。
 */
import {
  AUTO_CONTINUE_PROMPT,
  applyPartialJsonDelta,
  classifyEmptyTurn,
  countAnswerBlocks,
  type EmptyTurnDecision,
  EXPECTED_TURN_ERR_CODES,
  findOrCreateStreamingRow,
  frameSeqKey,
  friendlyBridgeErrorMessage,
  getFrameSeqCursor,
  isBridgeAuthControlError,
  normalizeBridgeErrorCode,
  shouldAutoContinueEmptyTurn,
} from "./pure";
import {
  addMessage,
  type ChatMessage,
  type ChatSession,
  type ChildBlock,
  clearTurnTiming,
  markFrameReceived,
  rebuildIndexes,
  resetReplyTracker,
} from "./model";
import type {
  CostChargedWire,
  CostWaivedWire,
  LegacyBridgeErrorWire,
  OutboundContentBlock,
  OutboundErrorWire,
  OutboundMessageWire,
  OutboundPermissionRequestWire,
  OutboundPermissionSettledWire,
  OutboundResumeFailedWire,
  OutboundTurnStatusWire,
} from "./frames";

const COST_CHARGED_LAST_FINAL_TTL_MS = 60_000;

/** reducer 上交给 ChatSocket 的跨切面副作用。全部可选——纯模型测试可不传。*/
export type FrameEffects = {
  /** isFinal 到达（turn 收尾后）：socket 清 thinking-safety / 推进 drain / promote status。*/
  onFinal?: (sess: ChatSession, frame: OutboundMessageWire, isCronOrHeartbeat: boolean) => void;
  /** service_restart 中断 final:调度自动续写(socket 决定是否真续,见其守卫)。 */
  scheduleRestartContinue?: (sessId: string) => void;
  /** 非 final 且 in-flight：socket 重置 thinking-safety（证明后端活着）。*/
  onLiveFrame?: (sess: ChatSession) => void;
  /** 空轮 end_turn → deferred(setTimeout 0) 自动续写。*/
  scheduleAutoContinue?: (sessId: string, targetMsgId: string, cls: EmptyTurnDecision) => void;
  /** 商业版余额刷新（cost_charged / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 真 turn 失败自动上报（跳过预期业务态）。*/
  reportTurnError?: (p: { code: string; message: string; traceId?: string; sessionId?: string }) => void;
  /** resume_failed / reconcile：游标已推进 + 标 _liveStreamBroken 后，强制 REST 全量 sync。*/
  forceSync?: (sessId: string) => void;
  /**
   * 立即把会话快照落 IndexedDB（断点续传游标 durable）。resume_failed 推进游标后必须
   * 同步落地：否则 reload 后 hello 仍发旧游标 → server 反复 resume 失败 → reload 死循环。
   * turn 收尾（isFinal）也落一次保证 reload 不丢已完成轮。
   */
  persistSession?: (sessId: string) => void;
  /** 1008 前的 auth-control error：交给 close handler 续期，不渲染。*/
  onAuthControlError?: () => void;
};

// ═══════════════ frameSeq 去重（per-sessionKey 游标，§3）═══════════════

function setFrameSeqCursor(sess: ChatSession, key: string, seq: number): void {
  if (!sess._lastFrameSeqByKey || typeof sess._lastFrameSeqByKey !== "object") {
    sess._lastFrameSeqByKey = {};
  }
  sess._lastFrameSeqByKey[key] = seq;
  sess._lastFrameSeq = Math.max(sess._lastFrameSeq || 0, seq);
}

/** 无 frameSeq>0 直接接受；<=游标 drop；否则严格前进推进游标（乱序不回退）。*/
function acceptFrameSeq(sess: ChatSession, frame: { frameSeq?: number; sessionKey?: string }): boolean {
  const fs = frame.frameSeq;
  if (!(typeof fs === "number" && fs > 0)) return true;
  const key = frameSeqKey(frame, sess.id);
  const last = getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key);
  if (fs <= last) return false;
  setFrameSeqCursor(sess, key, fs);
  return true;
}

/** 公开给 resume_failed：把游标推到 server currentLast（§4）。
 *  只进不退:重启后的空 ring/陈旧信号可能带 to=0 或倒退值,回退游标会让后续
 *  重放帧被当新帧重复应用/让本地状态被无谓重置(纵深防御,主修在 bridge 侧)。*/
export function advanceFrameSeqCursorTo(sess: ChatSession, frame: { sessionKey?: string }, to: number): void {
  const key = frameSeqKey(frame, sess.id);
  const last = getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key);
  if (to > last) setFrameSeqCursor(sess, key, to);
}

// ═══════════════ delegate / subagent helpers（websocket.js:800-1172）═══════════════

function isDelegateToolName(name?: string): boolean {
  return /(?:^|_)delegate_task$/.test(name || "");
}

function normalizeDelegateGoalKey(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, 1024);
}

/** 子 agent 块合并进 owning Agent 卡 childBlocks（coalesce 同类尾块）。*/
function appendSubagentBlock(
  sess: ChatSession,
  groupMsg: ChatMessage,
  block: OutboundContentBlock,
  blockText: string,
): void {
  if (!Array.isArray(groupMsg.childBlocks)) groupMsg.childBlocks = [];
  const children = groupMsg.childBlocks;
  if (block.kind === "text") {
    if (!blockText) return;
    const last = children[children.length - 1];
    if (last && last.kind === "text") last.text = (last.text || "") + blockText;
    else children.push({ kind: "text", text: blockText });
  } else if (block.kind === "thinking") {
    if (!blockText) return;
    const last = children[children.length - 1];
    if (last && last.kind === "thinking") last.text = (last.text || "") + blockText;
    else children.push({ kind: "thinking", text: blockText });
  } else if (block.kind === "tool_use") {
    const existing = block.blockId
      ? children.find((c) => c.kind === "tool_use" && c.blockId === block.blockId)
      : null;
    if (existing) {
      existing.inputPreview = block.inputPreview || existing.inputPreview;
      // P5 fix(Codex):子 tool_use 也累进 partialJson(镜像 top-level §8),否则 agent-group 内
      // Edit/Write 子工具不会边流边渲 diff,只能等 final inputJson。applyPartialJsonDelta 对
      // 无 delta 字段的 block 返 "keep"(no-op),安全。
      const dr = applyPartialJsonDelta(existing.partialJson, block);
      if (dr.action === "set") existing.partialJson = dr.value;
      else if (dr.action === "drop") delete existing.partialJson;
      if (block.inputJson !== undefined && block.inputJson !== null) existing.inputJson = block.inputJson;
      existing._partial = !!block.partial;
      if (!block.partial) delete existing.partialJson;
      if (block.toolName) existing.toolName = block.toolName;
    } else {
      const initialPartialJson = (() => {
        const r = applyPartialJsonDelta(null, block);
        return r.action === "set" ? r.value : undefined;
      })();
      children.push({
        kind: "tool_use",
        blockId: block.blockId,
        toolName: block.toolName || "unknown",
        inputPreview: block.inputPreview || "",
        inputJson: block.inputJson != null ? block.inputJson : null,
        ...(initialPartialJson !== undefined ? { partialJson: initialPartialJson } : {}),
        _partial: !!block.partial,
        _completed: false,
        output: null as unknown as string,
        error: false,
      });
      if (block.blockId && /^Agent$/i.test(block.toolName || "")) {
        if (!sess._agentGroups) sess._agentGroups = new Map();
        sess._agentGroups.set(block.blockId, groupMsg.id);
      }
    }
  } else if (block.kind === "tool_result") {
    const toolUseId =
      block.toolUseBlockId || (block.blockId ? String(block.blockId).replace(/:result$/, "") : null);
    const target = toolUseId
      ? children.find((c) => c.kind === "tool_use" && c.blockId === toolUseId)
      : null;
    if (target) {
      target._completed = true;
      target.output = block.preview || "";
      target.error = !!block.isError;
      target._partial = false;
    } else {
      children.push({
        kind: "tool_use",
        blockId: block.blockId,
        toolName: block.toolName || "unknown",
        inputPreview: "",
        inputJson: null,
        _partial: false,
        _completed: true,
        output: block.preview || "",
        error: !!block.isError,
      });
    }
  } else if (block.kind === "tool_output_tail") {
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
}

/** 严格唯一 (agentId, goal) 把 delegate run 绑回 leader 的 delegate_task 卡。*/
function bindDelegateRunToGroup(sess: ChatSession, block: { agentId?: string; goal?: string; runId: string }): string | null {
  const agentId = block.agentId || "";
  const goal = typeof block.goal === "string" ? block.goal : "";
  if (!agentId || !goal) return null;
  const candidates = sess.messages.filter(
    (m) =>
      m.role === "agent-group" &&
      m._delegate &&
      !m._delegateRunId &&
      m._delegateAgentId === agentId &&
      m._delegateGoal === goal,
  );
  if (candidates.length !== 1) return null;
  const groupMsg = candidates[0];
  groupMsg._delegateRunId = block.runId;
  if (!sess._delegateRunGroups) sess._delegateRunGroups = new Map();
  sess._delegateRunGroups.set(block.runId, groupMsg.id);
  return groupMsg.id;
}

/** 反向 adopt：standalone delegate-progress 卡并入后绑定的 agent-group。*/
function adoptStandaloneDelegateRun(sess: ChatSession, groupMsg: ChatMessage): boolean {
  if (!groupMsg || !groupMsg._delegate || groupMsg._delegateRunId) return false;
  const agentId = groupMsg._delegateAgentId || "";
  const goal = groupMsg._delegateGoal || "";
  if (!agentId || !goal) return false;
  if (Array.isArray(groupMsg.childBlocks) && groupMsg.childBlocks.length > 0) return false;
  const candidates = sess.messages.filter(
    (m) =>
      m.role === "delegate-progress" &&
      !m._adoptedInto &&
      m.runId &&
      m._delegateGoal === goal &&
      (m.agentId || "") === agentId,
  );
  if (candidates.length !== 1) return false;
  const standalone = candidates[0];
  const standaloneChildBlocks = Array.isArray(standalone.childBlocks) ? standalone.childBlocks : [];
  const standaloneEntries = Array.isArray(standalone.entries) ? standalone.entries : [];
  const hasNonStartEntries = standaloneEntries.some((entry) => entry.phase !== "start");
  // Start-only entries are the duplicate fallback header from the
  // progress-before-tool_use race. Preserve non-start legacy entries because
  // adopting the standalone would otherwise drop visible fallback output.
  if (hasNonStartEntries) return false;
  groupMsg.childBlocks = standaloneChildBlocks;
  if (standalone.summary && !groupMsg._resultPreview) groupMsg._resultPreview = String(standalone.summary).slice(0, 200);
  if (standalone.error) groupMsg._isError = true;
  groupMsg._delegateRunId = standalone.runId;
  if (!sess._delegateRunGroups) sess._delegateRunGroups = new Map();
  sess._delegateRunGroups.set(standalone.runId!, groupMsg.id);
  standalone._adoptedInto = groupMsg.id;
  const idx = sess.messages.findIndex((m) => m === standalone);
  if (idx >= 0) sess.messages.splice(idx, 1);
  return true;
}

type DelegateProgressBlock = {
  kind: "delegate_progress";
  runId: string;
  agentId: string;
  phase: "start" | "text" | "thinking" | "plan" | "tool" | "done" | "error";
  text?: string;
  toolName?: string;
  isError?: boolean;
  goal?: string;
  block?: OutboundContentBlock;
};

function handleDelegateProgressBlock(sess: ChatSession, block: DelegateProgressBlock): void {
  if (!block.runId) return;
  let groupMsgId = sess._delegateRunGroups?.get(block.runId);
  if (groupMsgId === undefined) {
    const bound = sess.messages.find((m) => m.role === "agent-group" && m._delegateRunId === block.runId);
    if (bound) {
      if (!sess._delegateRunGroups) sess._delegateRunGroups = new Map();
      sess._delegateRunGroups.set(block.runId, bound.id);
      groupMsgId = bound.id;
    } else if (block.phase === "start") {
      groupMsgId = bindDelegateRunToGroup(sess, block) ?? undefined;
    }
  }
  if (groupMsgId) {
    const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
    if (groupMsg) {
      if (block.phase === "done" || block.phase === "error") {
        if (block.text && !groupMsg._resultPreview) groupMsg._resultPreview = String(block.text).slice(0, 200);
        if (block.phase === "error") groupMsg._isError = true;
      } else if (block.block && typeof block.block === "object") {
        const child = block.block;
        const childText = typeof (child as { text?: unknown }).text === "string" ? (child as { text: string }).text : "";
        appendSubagentBlock(sess, groupMsg, child, childText);
      }
      return;
    }
  }
  // Fallback: standalone delegate-progress card keyed by runId.
  let msg = sess.messages.find((m) => m.role === "delegate-progress" && m.runId === block.runId) || null;
  if (!msg) {
    msg = addMessage(sess, "delegate-progress", "", {
      runId: block.runId,
      agentId: block.agentId || "",
      goal: typeof block.goal === "string" ? block.goal : "",
      _delegateGoal: typeof block.goal === "string" ? normalizeDelegateGoalKey(block.goal) : "",
      entries: [],
      childBlocks: [],
      _completed: false,
    });
  }
  if (block.agentId) msg.agentId = block.agentId;
  if (typeof block.goal === "string" && block.goal && !msg._delegateGoal) {
    msg.goal = block.goal;
    msg._delegateGoal = normalizeDelegateGoalKey(block.goal);
  }
  if (block.phase === "done" || block.phase === "error") {
    msg._completed = true;
    msg.completedAt = Date.now();
    msg.error = block.phase === "error" || !!block.isError;
    if (block.text) msg.summary = block.text;
  } else if (block.block && typeof block.block === "object") {
    if (!Array.isArray(msg.childBlocks)) msg.childBlocks = [];
    const child = block.block;
    const childText = typeof (child as { text?: unknown }).text === "string" ? (child as { text: string }).text : "";
    appendSubagentBlock(sess, msg, child, childText);
  } else {
    // 旧降级帧：entries 视图回落。
    if (!Array.isArray(msg.entries)) msg.entries = [];
    const text = typeof block.text === "string" ? block.text : "";
    if (text) {
      const last = msg.entries[msg.entries.length - 1];
      if (last && (block.phase === "text" || block.phase === "thinking") && last.phase === block.phase && !last.isError && !block.isError) {
        last.text = `${last.text || ""}${text}`;
        last.ts = Date.now();
      } else {
        msg.entries.push({ phase: block.phase || "text", text, toolName: block.toolName || "", isError: !!block.isError, ts: Date.now() });
      }
      if (msg.entries.length > 120) msg.entries.splice(0, msg.entries.length - 120);
    }
  }
}

// ═══════════════ plan 卡身份（websocket.js:668-751）═══════════════

function isPlanTurnBoundary(msg?: ChatMessage): boolean {
  return !!msg && (msg.role === "user" || msg.role === "system");
}
function planTurnStart(messages: ChatMessage[], beforeIndex: number): number {
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
function findPlanInRange(messages: ChatMessage[], blockId: string, start: number, end: number): ChatMessage | null {
  for (let i = Math.max(0, start); i < Math.min(end, messages.length); i++) {
    const m = messages[i];
    if (m && m.role === "plan" && m.blockId === blockId) return m;
  }
  return null;
}

// ═══════════════ handleOutbound 主线（websocket.js:2559-3540）═══════════════

/**
 * outbound.message 总线翻译。`getSession(peerId)`：未知 peer 直接丢（不创建）；
 * 调用方负责保证 session 存在（v5 webchat 每会话即 peer）。
 */
export function applyOutboundMessage(
  sess: ChatSession,
  frame: OutboundMessageWire,
  effects: FrameEffects = {},
): void {
  let deferredEmptyNotice: { targetMsgId: string; stopReason?: string; hadAnswerLookahead: boolean } | null = null;

  // ── §3 frameSeq dedupe ──
  if (!acceptFrameSeq(sess, frame)) return;

  // ── §11 双帧 error 抑制：紧随 outbound.error 的 [error] text isFinal 不渲染气泡 ──
  let suppressLegacyErrorText = false;
  if (
    sess._suppressErrorBubbleAtSeq !== undefined &&
    typeof frame.frameSeq === "number" &&
    frame.frameSeq === sess._suppressErrorBubbleAtSeq &&
    frame.isFinal &&
    Array.isArray(frame.blocks) &&
    frame.blocks.length === 1 &&
    frame.blocks[0]?.kind === "text" &&
    typeof (frame.blocks[0] as { text?: unknown }).text === "string" &&
    (frame.blocks[0] as { text: string }).text.startsWith("[error]")
  ) {
    suppressLegacyErrorText = true;
    sess._suppressErrorBubbleAtSeq = undefined;
  }

  // refresh 后从 messages 重建 blockId/agentGroup 索引（§7）。
  if (!sess._blockIdToMsgId) rebuildIndexes(sess);

  // ── §11 service_restart 合成 final + 已有 queued user：当带外清理消费，不绑新轮 ──
  if (frame.isFinal && frame.meta?.interrupted === "service_restart") {
    const hasQueuedUser = sess.messages.some((m) => m.role === "user" && m.status === "queued");
    if (hasQueuedUser) {
      sess._sendingInFlight = false;
      clearTurnTiming(sess);
      resetReplyTracker(sess);
      effects.onFinal?.(sess, frame, true);
      return;
    }
  }

  // ── §11 stale-final 守卫（跨时钟域，需 frame.ts）──
  if (frame.isFinal && typeof frame.ts === "number") {
    if (sess._replyingToMsgId) {
      const boundMsg = sess.messages.find((m) => m.id === sess._replyingToMsgId);
      if (boundMsg && typeof boundMsg.ts === "number" && frame.ts < boundMsg.ts) return; // 早于绑定 user msg
    } else if (typeof sess._trackerResetAt === "number" && frame.ts < sess._trackerResetAt) {
      return; // 早于 tracker reset（stop/switch/timeout 后的 late final）
    }
  }

  // thinking-safety：非 final 帧重置；isFinal 清（由 socket 持 timer）。
  if (sess._sendingInFlight && !frame.isFinal) effects.onLiveFrame?.(sess);

  // ── §11 agent 切换守卫 ──
  if (sess._agentSwitchedAt && frame.ts && frame.ts < sess._agentSwitchedAt) return;
  if (sess._agentSwitchedAt && !sess._sendingInFlight && !frame.isFinal && Date.now() - sess._agentSwitchedAt < 2000) return;

  const hasBlocks = Array.isArray(frame.blocks) && frame.blocks.length > 0;
  if (hasBlocks || frame.isFinal) markFrameReceived(sess);

  // reply tracker 绑定（跳过 queued）。
  if (!sess._replyingToMsgId) {
    const pending = [...sess.messages]
      .reverse()
      .find((m) => m.role === "user" && m.status && m.status !== "replied" && m.status !== "queued");
    if (pending) {
      sess._replyingToMsgId = pending.id;
      sess._currentTurnAnswerCount = 0;
    }
  }
  const targetMsg = sess._replyingToMsgId ? sess.messages.find((m) => m.id === sess._replyingToMsgId) : null;
  // tracker 指向已删消息（/clear mid-turn）→ 自愈重绑。
  if (sess._replyingToMsgId && !targetMsg) resetReplyTracker(sess);

  // answer-block 计数（白名单，thinking 不算）。
  if (targetMsg && hasBlocks) {
    sess._currentTurnAnswerCount = (sess._currentTurnAnswerCount || 0) + countAnswerBlocks(frame.blocks);
  }
  if (targetMsg) {
    if (hasBlocks && targetMsg.status !== "read" && targetMsg.status !== "replied") {
      targetMsg.status = "read";
    }
    if (frame.isFinal) {
      deferredEmptyNotice = {
        targetMsgId: targetMsg.id,
        stopReason: frame.meta?.stopReason,
        hadAnswerLookahead: !!sess._currentTurnAnswerCount || !!sess._streamingAssistant,
      };
      resetReplyTracker(sess);
    }
  }

  const isCronPush = !!frame.cronJob && !frame.cronJob.heartbeat;
  const isCronOrHeartbeat = !!frame.cronJob;

  // ── block 翻译循环（§7）──
  const blocksToRender = suppressLegacyErrorText ? [] : frame.blocks || [];
  for (const block of blocksToRender) {
    const b = block as OutboundContentBlock & {
      parentToolUseId?: string;
      messageId?: string;
      blockId?: string;
      toolName?: string;
      toolUseBlockId?: string;
    };
    const blockText =
      typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : (b as { text?: unknown }).text != null
          ? JSON.stringify((b as { text: unknown }).text)
          : "";

    if (b.kind === "delegate_progress") {
      handleDelegateProgressBlock(sess, b as unknown as DelegateProgressBlock);
      continue;
    }

    // subagent 块路由进 owning Agent 卡 childBlocks。
    if (b.parentToolUseId && sess._agentGroups?.has(b.parentToolUseId)) {
      const groupMsgId = sess._agentGroups.get(b.parentToolUseId);
      const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
      if (groupMsg) {
        appendSubagentBlock(sess, groupMsg, block, blockText);
        continue;
      }
    }

    if (b.kind === "text") {
      // vanilla 在此 flush thinking 的 rAF 残留再清指针；React 侧文本已累加在模型上，
      // 无独立 rAF buffer，直接清指针即可（渲染节流在订阅侧批量 notify）。
      sess._streamingThinking = null;
      if (!sess._streamingAssistant) {
        sess._streamingAssistant = findOrCreateStreamingRow(
          sess.messages,
          "assistant",
          b.messageId,
          (idOverride) => {
            const extra: Partial<ChatMessage> = isCronPush
              ? { cronPush: true, cronLabel: frame.cronJob?.label }
              : {};
            Object.assign(extra, idOverride);
            return addMessage(sess, "assistant", "", extra);
          },
        );
      }
      sess._streamingAssistant.text += blockText;
      sess._streamingAssistant.completedAt = Date.now();
    } else if (b.kind === "thinking") {
      if (!sess._streamingThinking) {
        sess._streamingThinking = findOrCreateStreamingRow(
          sess.messages,
          "thinking",
          b.messageId,
          (idOverride) => addMessage(sess, "thinking", "", idOverride),
        );
      }
      sess._streamingThinking.text += blockText;
      sess._streamingThinking.completedAt = Date.now();
    } else if (b.kind === "plan") {
      const blockId = b.blockId || "plan";
      const turnStart = planTurnStart(sess.messages, sess.messages.length);
      let planMsg = findPlanInRange(sess.messages, blockId, turnStart, sess.messages.length);
      const pb = b as { text?: string; explanation?: string; steps?: ChatMessage["steps"]; partial?: boolean };
      if (!planMsg) {
        planMsg = addMessage(sess, "plan", pb.text || "", {
          id: planMessageId(blockId, turnStart),
          blockId,
          _partial: !!pb.partial,
          explanation: pb.explanation || "",
          steps: Array.isArray(pb.steps) ? pb.steps : [],
        });
      } else {
        if (typeof pb.text === "string") planMsg.text = pb.text;
        if (typeof pb.explanation === "string") planMsg.explanation = pb.explanation;
        if (Array.isArray(pb.steps)) planMsg.steps = pb.steps;
        planMsg._partial = !!pb.partial;
        planMsg.completedAt = Date.now();
      }
    } else if (b.kind === "goal") {
      const goalId = b.blockId || "goal";
      let goalMsg: ChatMessage | null = null;
      if (goalId && sess._blockIdToMsgId?.has(goalId)) {
        const mid = sess._blockIdToMsgId.get(goalId);
        goalMsg = sess.messages.find((m) => m.id === mid && m.role === "goal") || null;
      }
      const gb = b as {
        objective?: string;
        status?: string;
        tokenBudget?: number | null;
        tokensUsed?: number;
        timeUsedSeconds?: number;
        updatedAt?: number;
        cleared?: boolean;
      };
      const objective = typeof gb.objective === "string" ? gb.objective : "";
      const goalFields: Partial<ChatMessage> = {
        blockId: goalId,
        goalStatus: typeof gb.status === "string" ? gb.status : "",
        tokenBudget: typeof gb.tokenBudget === "number" || gb.tokenBudget === null ? gb.tokenBudget : undefined,
        tokensUsed: typeof gb.tokensUsed === "number" ? gb.tokensUsed : undefined,
        timeUsedSeconds: typeof gb.timeUsedSeconds === "number" ? gb.timeUsedSeconds : undefined,
        updatedAt: typeof gb.updatedAt === "number" ? gb.updatedAt : undefined,
        cleared: !!gb.cleared,
        completedAt: Date.now(),
      };
      if (!goalMsg) {
        goalMsg = addMessage(sess, "goal", objective, goalFields);
        if (goalId) sess._blockIdToMsgId?.set(goalId, goalMsg.id);
      } else {
        goalMsg.text = objective || goalMsg.text || "";
        Object.assign(goalMsg, goalFields);
      }
    } else if (b.kind === "tool_use") {
      if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now();
      if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now();
      sess._streamingAssistant = null;
      sess._streamingThinking = null;
      const tb = b as {
        toolName?: string;
        blockId?: string;
        inputPreview?: string;
        inputJson?: unknown;
        partial?: boolean;
        messageId?: string;
        partialJsonDelta?: unknown;
        partialJsonOffset?: unknown;
      };
      const isAgent = /^Agent$/i.test(tb.toolName || "");
      const isDelegate = isDelegateToolName(tb.toolName);
      if (isAgent || isDelegate) {
        if (!sess._agentGroups) sess._agentGroups = new Map();
        if (tb.blockId) {
          const input = tb.inputJson && typeof tb.inputJson === "object" ? (tb.inputJson as Record<string, unknown>) : null;
          const preview = (tb.inputPreview || "").replace(/[{}"]/g, "").slice(0, 80);
          let desc: string;
          let delegateFields: Partial<ChatMessage> | null = null;
          if (isDelegate) {
            const goalRaw = input && typeof input.goal === "string" ? input.goal : "";
            const agentRaw = input && typeof input.agentId === "string" && input.agentId ? input.agentId : "main";
            desc = (goalRaw && goalRaw.trim()) || preview || "委托子任务";
            delegateFields = { _delegate: true, _delegateAgentId: agentRaw, _delegateGoal: normalizeDelegateGoalKey(goalRaw) };
          } else {
            desc =
              (input && typeof input.description === "string" && input.description) ||
              (input && typeof input.prompt === "string" && input.prompt.slice(0, 80)) ||
              preview ||
              "子任务";
          }
          if (!sess._agentGroups.has(tb.blockId)) {
            const groupMsg = addMessage(sess, "agent-group", desc, {
              blockId: tb.blockId,
              toolName: isDelegate ? tb.toolName || "delegate_task" : "Agent",
              startTime: Date.now(),
              childBlocks: [],
              ...(delegateFields || {}),
            });
            sess._agentGroups.set(tb.blockId, groupMsg.id);
            sess._blockIdToMsgId?.set(tb.blockId, groupMsg.id);
            if (delegateFields) adoptStandaloneDelegateRun(sess, groupMsg);
          } else {
            const groupMsgId = sess._agentGroups.get(tb.blockId);
            const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
            if (groupMsg) {
              if (desc && groupMsg.text !== desc) groupMsg.text = desc;
              if (delegateFields) {
                groupMsg._delegate = true;
                groupMsg._delegateAgentId = delegateFields._delegateAgentId;
                groupMsg._delegateGoal = delegateFields._delegateGoal;
                adoptStandaloneDelegateRun(sess, groupMsg);
              }
            }
          }
        }
      } else if (tb.blockId && sess._blockIdToMsgId?.has(tb.blockId)) {
        // 更新现有 tool 卡（partial → final）。
        const mid = sess._blockIdToMsgId.get(tb.blockId);
        const existing = sess.messages.find((m) => m.id === mid);
        if (existing) {
          existing.inputPreview = tb.inputPreview || existing.inputPreview;
          // §8 partialJson offset 累加。
          const deltaResult = applyPartialJsonDelta(existing.partialJson, tb);
          if (deltaResult.action === "set") existing.partialJson = deltaResult.value;
          else if (deltaResult.action === "drop") delete existing.partialJson;
          if (tb.inputJson) existing.inputJson = tb.inputJson;
          existing._partial = !!tb.partial;
          if (!tb.partial) {
            delete existing.partialJson;
            existing._partialRafPending = false;
          }
        }
      } else {
        // 新建 tool 卡（§9 canonical id 条件 spread）。
        const m = addMessage(sess, "tool", tb.toolName || "unknown", {
          ...(tb.messageId ? { id: tb.messageId } : {}),
          toolName: tb.toolName,
          blockId: tb.blockId,
          inputPreview: tb.inputPreview || "",
          inputJson: tb.inputJson || null,
          partialJson: (() => {
            const r = applyPartialJsonDelta(null, tb);
            return r.action === "set" ? r.value : undefined;
          })(),
          _partial: !!tb.partial,
          _completed: false,
          output: null,
          error: false,
        });
        if (tb.blockId) sess._blockIdToMsgId?.set(tb.blockId, m.id);
      }
    } else if (b.kind === "tool_result") {
      if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now();
      if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now();
      sess._streamingAssistant = null;
      sess._streamingThinking = null;
      const rb = b as { toolName?: string; blockId?: string; toolUseBlockId?: string; preview?: string; isError?: boolean };
      const isAgentResult = /^Agent$/i.test(rb.toolName || "") || isDelegateToolName(rb.toolName);
      const agentToolUseId = rb.toolUseBlockId || (rb.blockId ? String(rb.blockId).replace(/:result$/, "") : null);
      if (isAgentResult && agentToolUseId && sess._agentGroups?.has(agentToolUseId)) {
        const groupMsgId = sess._agentGroups.get(agentToolUseId);
        const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
        if (groupMsg) {
          groupMsg._completed = true;
          groupMsg._duration = Date.now() - (groupMsg.startTime || Date.now());
          groupMsg._resultPreview = (rb.preview || "").slice(0, 200);
          groupMsg._isError = !!rb.isError;
        }
        continue;
      }
      const toolUseId = rb.toolUseBlockId || (rb.blockId ? rb.blockId.replace(/:result$/, "") : null);
      if (toolUseId && sess._blockIdToMsgId?.has(toolUseId)) {
        const mid = sess._blockIdToMsgId.get(toolUseId);
        const existing = sess.messages.find((m) => m.id === mid);
        if (existing) {
          existing._completed = true;
          existing.output = rb.preview || "";
          existing.error = !!rb.isError;
          existing._partial = false;
          continue;
        }
      }
      if (!rb.preview) continue;
      const m = addMessage(sess, "tool", rb.toolName || "unknown", {
        toolName: rb.toolName,
        blockId: rb.blockId,
        _completed: true,
        output: rb.preview || "",
        error: !!rb.isError,
        inputJson: null,
        inputPreview: "",
        _partial: false,
      });
      if (rb.blockId) sess._blockIdToMsgId?.set(rb.blockId, m.id);
    } else if (b.kind === "tool_output_tail") {
      // §7 单调守卫：totalBytes 回退丢弃。
      const tlb = b as { toolUseBlockId?: string; tail?: string; totalBytes?: number; truncatedHead?: boolean };
      if (!tlb.toolUseBlockId) continue;
      if (!sess._blockIdToMsgId?.has(tlb.toolUseBlockId)) continue;
      const mid = sess._blockIdToMsgId.get(tlb.toolUseBlockId);
      const existing = sess.messages.find((m) => m.id === mid);
      if (!existing) continue;
      const tail = typeof tlb.tail === "string" ? tlb.tail : "";
      const totalBytes = typeof tlb.totalBytes === "number" ? tlb.totalBytes : 0;
      const truncatedHead = !!tlb.truncatedHead;
      const prev = existing.bashTail?.totalBytes ?? 0;
      if (totalBytes < prev) continue;
      existing.bashTail = { tail, totalBytes, truncatedHead };
    }
  }

  sess.lastAt = Date.now();

  // ── isFinal 收尾（§7）──
  if (frame.isFinal) {
    // 空轮分类（block 渲染后；deferred 到这里）。
    if (deferredEmptyNotice) {
      const cls = classifyEmptyTurn({
        messages: sess.messages,
        targetMsgId: deferredEmptyNotice.targetMsgId,
        hasAnswerOutput: deferredEmptyNotice.hadAnswerLookahead || !!sess._streamingAssistant,
        stopReason: deferredEmptyNotice.stopReason,
      });
      if (cls.insert) {
        const autoTid = deferredEmptyNotice.targetMsgId;
        const canAuto =
          !!effects.scheduleAutoContinue &&
          shouldAutoContinueEmptyTurn({ messages: sess.messages, targetMsgId: autoTid, stopReason: cls.stopReason });
        if (canAuto) {
          effects.scheduleAutoContinue!(sess.id, autoTid, cls);
        } else {
          const lastMsg = sess.messages[sess.messages.length - 1];
          const dup = lastMsg && lastMsg._emptyTurn && lastMsg._emptyTurnTargetMsgId === autoTid;
          if (!dup) {
            addMessage(sess, "assistant", cls.text, {
              _emptyTurn: true,
              _emptyTurnSoft: cls.soft,
              _emptyTurnStopReason: cls.stopReason,
              _emptyTurnTargetMsgId: autoTid,
            });
          }
        }
      }
      deferredEmptyNotice = null;
    }

    // 合 frame.meta 进 _streamingAssistant.usage + drain 早到 cost_charged。
    if (frame.meta && sess._streamingAssistant) {
      const usagePatch: ChatMessage["usage"] = { ...frame.meta };
      if (typeof frame.traceId === "string" && frame.traceId) usagePatch.traceId = frame.traceId;
      try {
        const pending = BigInt(sess._pendingCostCredits || "0");
        if (pending > 0n) {
          usagePatch.costCredits = pending.toString();
          sess._pendingCostCredits = "0";
        }
      } catch {
        sess._pendingCostCredits = "0";
      }
      sess._streamingAssistant.usage = { ...(sess._streamingAssistant.usage || {}), ...usagePatch };
      sess._lastFinaledAssistantId = sess._streamingAssistant.id;
      sess._lastFinaledAt = Date.now();
    }
    // session-level token 累计。
    if (frame.meta) {
      if (!sess._tokenUsage) sess._tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const meta = frame.meta;
      if (typeof meta.inputTokens === "number") sess._tokenUsage.input += meta.inputTokens;
      if (typeof meta.outputTokens === "number") sess._tokenUsage.output += meta.outputTokens;
      if (typeof meta.cacheReadTokens === "number") sess._tokenUsage.cacheRead += meta.cacheReadTokens;
      if (typeof meta.cacheCreationTokens === "number") sess._tokenUsage.cacheWrite += meta.cacheCreationTokens;
      if (typeof meta.cost === "number") sess._tokenUsage.cost += meta.cost;
    }
    if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now();
    if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now();
    // max_tokens / pause_turn 截断标记。
    const stopReason = frame.meta?.stopReason;
    const truncatedReason = stopReason === "max_tokens" || stopReason === "pause_turn" ? stopReason : null;
    if (truncatedReason && sess._streamingAssistant?.text) sess._streamingAssistant._truncated = truncatedReason;
    // finalize plan / tool 卡。
    for (const m of sess.messages) {
      if (m.role === "plan" && m._partial) {
        m._partial = false;
        m.completedAt = Date.now();
      }
      if (m.role === "tool" && typeof m._completed === "boolean" && !m._completed && !m.error) {
        m._completed = true;
      }
      // agent-group / delegate-progress：turn 收尾仍未完成 → 标完成。turn 已结束就不该再
      // "运行中/子智能体启动中…"(委托帧 runId 绑定缺位时会卡住,这里兜底收口)。
      if ((m.role === "agent-group" || m.role === "delegate-progress") && !m._completed) {
        m._completed = true;
        if (m.completedAt == null) m.completedAt = Date.now();
      }
    }
    // 兜底 flush：本 turn 入队但未被上方 meta-drain 落账的 cost（收尾帧无 meta / 无流式助手 /
    // 委派 turn cost 在子状态间到达）→ 累加到本轮最后一条助手消息（用户看到的响应）；无助手
    // 消息则清零。**务必清零**：否则残留 pending 会被下一 turn 的 meta-drain 错算（归因黑洞）。
    try {
      const pending = BigInt(sess._pendingCostCredits || "0");
      if (pending > 0n) {
        // 目标限定在**本轮**内:从尾向前找 assistant,遇到 user(=本轮起点)即停——本轮没有
        // assistant 响应(tool-only / thinking-only / empty end_turn)时绝不落到上一轮的 assistant
        // (Codex BLOCKER:跨 turn 归因)。找不到则下方统一清零,只丢展示不泄漏。
        let lastAsst: ChatMessage | null = null;
        for (let k = sess.messages.length - 1; k >= 0; k--) {
          const m = sess.messages[k];
          if (m.role === "user") break;
          if (m.role === "assistant") {
            lastAsst = m;
            break;
          }
        }
        if (lastAsst) {
          let cur = 0n;
          try {
            cur = BigInt(lastAsst.usage?.costCredits ?? "0");
          } catch {
            cur = 0n;
          }
          lastAsst.usage = { ...(lastAsst.usage || {}), costCredits: (cur + pending).toString() };
        }
      }
    } catch {
      /* 解析失败:照常清零 */
    }
    sess._pendingCostCredits = "0";
    // 清流式指针 + in-flight。
    sess._streamingAssistant = null;
    sess._streamingThinking = null;
    sess._sendingInFlight = false;
    clearTurnTiming(sess);
    effects.onFinal?.(sess, frame, isCronOrHeartbeat);
    // 服务重启掐断上游生成流的合成 final:有截断内容则自动续写(守卫在 socket 侧)。
    if (frame.meta?.interrupted === "service_restart") effects.scheduleRestartContinue?.(sess.id);
  }
}

// ═══════════════ outbound.turn_status（§6/§7）═══════════════
export function applyTurnStatus(sess: ChatSession, frame: OutboundTurnStatusWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  markFrameReceived(sess); // liveness signal
  sess._turnStatus = frame.status === "compacting" ? "compacting" : null;
}

// ═══════════════ outbound.error 双帧（§11）═══════════════
export function applyOutboundError(sess: ChatSession, frame: OutboundErrorWire, effects: FrameEffects = {}): void {
  if (typeof frame.frameSeq === "number" && frame.frameSeq > 0) {
    if (!acceptFrameSeq(sess, frame)) return;
    sess._suppressErrorBubbleAtSeq = frame.frameSeq + 1;
  }
  const normalized = normalizeBridgeErrorCode(frame.code);
  // 友好主文案;原始技术信息(detail 优先,无则 message)落 _errorDetail→「查看详情」,未知码也不丢
  // (friendlyBridgeErrorMessage 未知码返通用文案、不再带 message,故这里必须兜住 message)。Codex 审。
  const rawDetail =
    (typeof frame.detail === "string" && frame.detail) ||
    (typeof frame.message === "string" && frame.message) ||
    "";
  addMessage(sess, "assistant", friendlyBridgeErrorMessage(frame.code, frame.message || "出错了"), {
    _errorCode: normalized,
    _errorDetail: rawDetail,
    ...(frame.traceId ? { usage: { traceId: frame.traceId } } : {}),
  });
  if (!EXPECTED_TURN_ERR_CODES.has(normalized)) {
    effects.reportTurnError?.({
      code: normalized,
      message: `${normalized}: ${frame.message || frame.detail || ""}`,
      traceId: typeof frame.traceId === "string" ? frame.traceId : undefined,
      sessionId: sess.id,
    });
  }
  if (normalized === "insufficient_credits") effects.refreshBalance?.();
}

// ═══════════════ legacy bridge error（type:'error'）═══════════════
export function applyLegacyBridgeError(sess: ChatSession, frame: LegacyBridgeErrorWire, effects: FrameEffects = {}): void {
  if (isBridgeAuthControlError(frame.code)) {
    effects.onAuthControlError?.();
    return;
  }
  const normalized = normalizeBridgeErrorCode(frame.code);
  const text = friendlyBridgeErrorMessage(frame.code, frame.message);
  addMessage(sess, "assistant", text, {
    _errorCode: normalized,
    _errorDetail: typeof frame.message === "string" ? frame.message : "",
    ...(frame.traceId ? { usage: { traceId: frame.traceId } } : {}),
  });
  // legacy error 无后续 final，前端自己收尾本轮 UI。
  sess._sendingInFlight = false;
  clearTurnTiming(sess);
  resetReplyTracker(sess);
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m?.role === "user" && (m.status === "sending" || m.status === "sent" || m.status === "queued")) {
      m.status = "error";
      break;
    }
  }
  if (normalized === "insufficient_credits") effects.refreshBalance?.();
}

// ═══════════════ resume_failed（§4 第三层）═══════════════
export function applyResumeFailed(sess: ChatSession, frame: OutboundResumeFailedWire, effects: FrameEffects = {}): void {
  const frameTo = typeof frame.to === "number" ? frame.to : 0;
  advanceFrameSeqCursorTo(sess, frame, frameTo); // 推游标到 server currentLast（防 reload 死循环，配 dbPut）
  sess._liveStreamBroken = true;
  effects.persistSession?.(sess.id); // 立即落地推进后的游标（dbPut 写点；防 reload 死循环）
  effects.forceSync?.(sess.id);
}

// ═══════════════ cost_charged（商业版，**不去重**，§3；归因严格不跨会话/不跨 turn）═══════════════
export function applyCostCharged(sess: ChatSession | null, frame: CostChargedWire, effects: FrameEffects = {}): void {
  const refresh = () => {
    if (frame.balanceAfter !== undefined && frame.balanceAfter !== null) effects.refreshBalance?.();
  };
  if (!sess) {
    refresh();
    return;
  }
  // target：streamingAssistant（turn 进行中）OR 60s 内 lastFinaled（刚 final 完晚到）。
  let target: ChatMessage | null = null;
  if (sess._streamingAssistant) {
    target = sess._streamingAssistant;
  } else if (
    sess._lastFinaledAssistantId &&
    sess._lastFinaledAt &&
    Date.now() - sess._lastFinaledAt < COST_CHARGED_LAST_FINAL_TTL_MS
  ) {
    target = sess.messages.find((m) => m.id === sess._lastFinaledAssistantId) || null;
  }
  // 解析 costCredits → BigInt（负数/非法 → null，丢弃累加但仍刷余额）。
  let add: bigint | null = null;
  try {
    const parsed = BigInt(frame.costCredits as string);
    add = parsed < 0n ? null : parsed;
  } catch {
    add = null;
  }
  // (a) 无 target：
  //   - **turn 进行中（_sendingInFlight）→ 入队 _pendingCostCredits**，收尾时 drain 到本轮响应。
  //     委派/多请求 turn 里 cost 常在两个子状态之间到达（队长等子智能体时无 streamingAssistant、
  //     lastFinal 又已过期/指向别处），旧逻辑一律 drop 导致积分时有时无（boss 报）；turn 在飞时
  //     这笔 cost 必属本轮，入队后由 isFinal 的 meta-drain 或收尾兜底落到本轮最后一条助手消息。
  //   - turn 之间（未发送）才 drop 展示只刷余额：避免错算到下一 turn（Codex 归因黑洞）。
  if (!target) {
    if (sess._sendingInFlight && add !== null) {
      try {
        const cur = BigInt(sess._pendingCostCredits || "0");
        sess._pendingCostCredits = (cur + add).toString();
      } catch {
        sess._pendingCostCredits = add.toString();
      }
    }
    refresh();
    return;
  }
  // (b) target 存在但 usage 未建（仅 streamingAssistant 路径，isFinal 还没到）→ enqueue 等 isFinal drain。
  if (!target.usage) {
    if (add !== null) {
      try {
        const cur = BigInt(sess._pendingCostCredits || "0");
        sess._pendingCostCredits = (cur + add).toString();
      } catch {
        sess._pendingCostCredits = add.toString();
      }
    }
    refresh();
    return;
  }
  // (c) target 命中且 usage 已就位 → 累加 costCredits。
  if (add !== null) {
    let cur = 0n;
    try {
      cur = BigInt(target.usage.costCredits ?? "0");
    } catch {
      cur = 0n;
    }
    target.usage = { ...target.usage, costCredits: (cur + add).toString() };
  }
  refresh();
}

/** turn 免单退款帧：idle-timeout 无响应轮,master 已冲正扣费。
 *  处理三件事：
 *   1. 刷余额气泡（balanceAfter 在则触发 refreshBalance）。
 *   2. 从 _pendingCostCredits 未落账队列里先行抵扣（cost 常在 turn 结束前入队未 drain）。
 *   3. 找最近一条有 costCredits 的助手消息，把展示扣费额度减回去并标 waived
 *      （UI 显示「已免单」而不是积分数）。*/
export function applyCostWaived(sess: ChatSession | null, frame: CostWaivedWire, effects: FrameEffects = {}): void {
  if (frame.balanceAfter !== undefined && frame.balanceAfter !== null) effects.refreshBalance?.();
  if (!sess) return;
  let refund: bigint;
  try {
    refund = BigInt(frame.refundedCredits ?? "0");
  } catch {
    refund = 0n;
  }
  if (refund <= 0n) return;
  // 先抵扣未落账队列。
  try {
    const pending = BigInt(sess._pendingCostCredits || "0");
    if (pending > 0n) {
      const used = pending < refund ? pending : refund;
      sess._pendingCostCredits = (pending - used).toString();
      refund -= used;
    }
  } catch {
    /* 非法 pending — 忽略 */
  }
  // 再从最近一条已展示扣费的助手消息上减（从尾部找，超时轮必然是最近的）。
  for (let i = sess.messages.length - 1; i >= 0 && i >= sess.messages.length - 20; i--) {
    const m = sess.messages[i];
    if (m.role !== "assistant" || !m.usage?.costCredits) continue;
    let cur = 0n;
    try {
      cur = BigInt(m.usage.costCredits);
    } catch {
      cur = 0n;
    }
    const used = cur < refund ? cur : refund;
    m.usage = { ...m.usage, costCredits: (cur - used).toString(), waived: true };
    refund -= used;
    break;
  }
}

// ═══════════════ permission_request / settled（§3 去重）═══════════════
export function applyPermissionRequest(sess: ChatSession, frame: OutboundPermissionRequestWire): ChatMessage | null {
  if (!acceptFrameSeq(sess, frame)) return null;
  return addMessage(sess, "permission", frame.toolName, {
    requestId: frame.requestId,
    toolName: frame.toolName,
    inputPreview: frame.inputPreview || "",
    inputJson: frame.inputJson || null,
    _resolved: false,
  });
}

export function applyPermissionSettled(sess: ChatSession, frame: OutboundPermissionSettledWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  const msg = sess.messages.find((m) => m.requestId === frame.requestId);
  if (!msg) return;
  msg._resolved = true;
  msg._behavior = frame.behavior;
  msg._settledReason = frame.reason || null;
  if (frame.answers && typeof frame.answers === "object") msg._answers = frame.answers;
}

export { AUTO_CONTINUE_PROMPT };
