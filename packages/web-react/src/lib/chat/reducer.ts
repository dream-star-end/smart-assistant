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
  findOrCreateStreamingRow,
  frameSeqKey,
  friendlyBridgeErrorMessage,
  getFrameSeqCursor,
  isBridgeAuthControlError,
  normalizeBridgeErrorCode,
  REPORT_EXEMPT_TURN_ERR_CODES,
  safeBridgeErrorDetail,
  shouldAutoContinueEmptyTurn,
} from "./pure";
import {
  addMessage,
  agentGroupRunId,
  type ChatMessage,
  type ChatSession,
  type ChildBlock,
  clearTurnTiming,
  isRetryingTurnStatus,
  isServerAuthoredRow,
  markFrameReceived,
  rebuildIndexes,
  resetReplyTracker,
  trackServerTs,
} from "./model";
import { repairPostFinalProcessOrder } from "./order";
import { errorLabel } from "./render";

/** teardown 后非 final 帧的压制时间窗(客户端同域):覆盖 stop 后 server 收尾期,不无界压制多端新 turn。*/
const TEARDOWN_DROP_WINDOW_MS = 3 * 60_000;
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
  /** isFinal 到达（turn 收尾后）：socket 清 thinking-safety / 推进 drain / promote status。
   * `clientMessageId` 在 reducer 清 active turn 前捕获，异步 REST 对账必须按它精确合并。*/
  onFinal?: (
    sess: ChatSession,
    frame: OutboundMessageWire,
    isCronOrHeartbeat: boolean,
    clientMessageId?: string,
  ) => void;
  /** service_restart 中断 final:调度自动续写(socket 决定是否真续,见其守卫)。 */
  scheduleRestartContinue?: (sessId: string) => void;
  /** Terminal recoverable error: sync the finalized exact tape, then let the
   * socket attempt one safety-gated checkpoint/replay child turn. */
  scheduleAutomaticRecovery?: (sessId: string, clientMessageId?: string) => void;
  /** 非 final 且 in-flight：socket 重置 thinking-safety（证明后端活着）。*/
  onLiveFrame?: (sess: ChatSession) => void;
  /** 空轮 end_turn → deferred(setTimeout 0) 自动续写。*/
  scheduleAutoContinue?: (sessId: string, targetMsgId: string, cls: EmptyTurnDecision) => void;
  /** 商业版余额刷新（cost_charged / insufficient_credits）。*/
  refreshBalance?: () => void;
  /** 真 turn 失败自动上报（跳过预期业务态）。*/
  reportTurnError?: (p: { code: string; message: string; traceId?: string; sessionId?: string }) => void;
  /** resume_failed / reconcile：游标已推进 + 标 _liveStreamBroken 后，强制 REST 全量 sync。*/
  forceSync?: (sessId: string, context?: { clientMessageId?: string }) => void;
  /**
   * reconcile 'turn_state_unknown'(RFC §4):server 无法判定在飞 turn 终态。**绝不清发送态**,
   * 由 socket 把该会话 thinking-safety 定时降至 60s(默认 10min),尽快复检服务端权威态。
   */
  onTurnStateUnknown?: (sessId: string) => void;
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

/**
 * 容器 ring **重启签名**下的游标归零(resume_failed reason='no_buffer' 且 to===0 专用)。
 *
 * 「只进不退」不适用于这个签名:它是**容器本人**对自家 ring 的权威裁决("我这代 ring 里
 * 该 sessionKey 一帧都没有"),不是当年 bridge 越权伪造的陈旧信号(那个源已根治——bridge
 * 对自身 miss 刻意不发 resume_failed,replay 唯一裁决者=容器,见 userChatBridge)。若游标
 * 不回退,冷容器新生代帧 seq=1..旧游标 会被 acceptFrameSeq 全部当重复帧黑洞:流式轮丢开头
 * 一截(自愈但丢内容),而 imageEdit 免模型直投轮**整轮只有一帧终帧 → 整轮蒸发**。
 * 2026-07-11 boss 生产实证(会话 webmrfo3rtrwhgi15):hello 后容器答复 resume_failed
 * {from:14,to:0,no_buffer},客户端游标停 14;直投终帧 frameSeq=1 被丢 → 粒子占位卡永不
 * 消解、assistant 行只能靠 REST 对账迟到补上、发送态挂到 thinking-safety 超时。
 * 安全性:空 ring 无帧可重放,归零后新生代帧 seq 1..N 恰好各被接受一次,无重复应用面。
 */
export function resetFrameSeqCursor(sess: ChatSession, frame: { sessionKey?: string }): void {
  const key = frameSeqKey(frame, sess.id);
  setFrameSeqCursor(sess, key, 0);
}

/**
 * 冷启(sys.cold_start = bridge provision 分支 = **全新容器**)下,把该会话全部 agent-scoped
 * 游标归零。覆盖「连接不断、容器中途被回收重建」的场景——此时没有 hello/resume_failed 仲裁,
 * 新容器 outboundRing 从零计数,不归零则与上面同一类帧黑洞。删除键即可:getFrameSeqCursor
 * 对 agent-scoped 缺省键恒返回 0(严禁回退 legacy 单游标,pure.ts)。
 */
export function resetAgentFrameSeqCursorsForSession(sess: ChatSession): void {
  const byKey = sess._lastFrameSeqByKey;
  if (!byKey || typeof byKey !== "object") return;
  const safeId = String(sess.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = `:webchat:dm:${safeId}`;
  for (const key of Object.keys(byKey)) {
    if (key.startsWith("agent:") && key.endsWith(suffix)) delete byKey[key];
  }
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

type DelegateToolInfo = { agentId: string; goalRaw: string; goalKey: string };

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseToolInputObject(inputJson: unknown, inputPreview?: string): Record<string, unknown> | null {
  return parseJsonObject(inputJson) ?? parseJsonObject(inputPreview);
}

function parseArgsObject(raw: unknown): Record<string, unknown> {
  return parseJsonObject(raw) ?? {};
}

function normalizeMcpServerName(raw: string): string {
  return raw.replace(/_/g, "-");
}

function parseCodexTypeName(name?: string): string {
  if (!name) return "";
  if (name.startsWith("codex:")) return name.slice(6);
  if (name.startsWith("Codex:")) return name.slice(6);
  return "";
}

function parseMcpToolName(name?: string): { server: string; op: string } | null {
  if (!name || !name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx < 0) return { server: normalizeMcpServerName(rest), op: "" };
  return { server: normalizeMcpServerName(rest.slice(0, idx)), op: rest.slice(idx + 2) };
}

function delegateInfoFromArgs(args: Record<string, unknown>): DelegateToolInfo {
  const goalRaw = str(args.goal);
  return {
    agentId: str(args.agentId) || "main",
    goalRaw,
    goalKey: normalizeDelegateGoalKey(goalRaw),
  };
}

function parseDelegateToolInfo(toolName?: string, inputJson?: unknown, inputPreview?: string): DelegateToolInfo | null {
  const name = toolName || "";
  const input = parseToolInputObject(inputJson, inputPreview) ?? {};
  const mcp = parseMcpToolName(name);
  if (mcp?.server === "openclaude-memory" && mcp.op === "delegate_task") {
    return delegateInfoFromArgs(input);
  }
  if (isDelegateToolName(name) && parseCodexTypeName(name) !== "mcpToolCall") {
    return delegateInfoFromArgs(input);
  }
  if (parseCodexTypeName(name) !== "mcpToolCall") return null;
  const server = normalizeMcpServerName(str(input.server) || str(input.serverName));
  const op = str(input.tool) || str(input.toolName) || str(input.name);
  if (server !== "openclaude-memory" || op !== "delegate_task") return null;
  const rawArgs = input.arguments ?? input.args ?? input.params;
  return delegateInfoFromArgs(parseArgsObject(rawArgs));
}

/**
 * 该 tool 行是否为**复数 fan-out 委派** `delegate_tasks`(区别于单数 delegate_task)。
 * fan-out 的 tool 卡故意不转 agent-group(一对多语义不成立),但它的存在是判定「后续按 runId
 * 落不到组的 delegate_progress 帧属于 fan-out 成员(→ 物化成 live agent-group)」的信号:
 * fan-out 里每个子任务只有独立 progressRunId、没有 per-subtask delegate_task tool_use 可 adopt。
 */
function isFanoutDelegateToolRow(msg: ChatMessage): boolean {
  if (msg.role !== "tool") return false;
  const name = msg.toolName || "";
  const mcp = parseMcpToolName(name);
  if (mcp?.server === "openclaude-memory" && mcp.op === "delegate_tasks") return true;
  if (/(?:^|_)delegate_tasks$/.test(name) && parseCodexTypeName(name) !== "mcpToolCall") return true;
  if (parseCodexTypeName(name) === "mcpToolCall") {
    const input = parseToolInputObject(msg.inputJson, msg.inputPreview) ?? {};
    const server = normalizeMcpServerName(str(input.server) || str(input.serverName));
    const op = str(input.tool) || str(input.toolName) || str(input.name);
    return server === "openclaude-memory" && op === "delegate_tasks";
  }
  return false;
}

/** 当前活跃 turn(最近一条 user 消息之后)是否存在 fan-out `delegate_tasks` tool 卡。
 *  fan-out 的 tool_use 恒早于其子任务 progress 帧(MCP 服务端拿到完整 tool 调用后才 spawn 子任务),
 *  故 progress 落兜底时该 tool 卡已在本轮消息里;限定「本轮」避免上一轮的 fan-out 误判本轮单数委派。*/
function hasActiveFanoutDelegate(sess: ChatSession): boolean {
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m.role === "user") return false; // 到达本轮 turn 边界
    if (isFanoutDelegateToolRow(m)) return true;
  }
  return false;
}

function extractMcpContentText(item: Record<string, unknown> | null): string {
  if (!item) return "";
  const result = asPlainObject(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content
    .map((part) => (part && typeof part === "object" ? str((part as Record<string, unknown>).text) : ""))
    .filter(Boolean);
  if (texts.length > 0) return texts.join("\n");
  const error = asPlainObject(item.error);
  return str(error?.message) || str(item.error) || str(item.result);
}

// export: persist.mergeLocalTeamDisplayFields 回填 server 工具行输出时复用同一预览语义。
export function friendlyDelegateResultPreview(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const parsed = parseJsonObject(raw);
  if (!parsed) return text.trim().startsWith("{") ? "" : text;
  const server = normalizeMcpServerName(str(parsed.server) || str(parsed.serverName));
  const op = str(parsed.tool) || str(parsed.toolName) || str(parsed.name);
  const content = extractMcpContentText(parsed);
  if (server === "openclaude-memory" && op === "delegate_task") return content;
  return content || (text.trim().startsWith("{") ? "" : text);
}

function isDelegateResultWrapper(raw: unknown): boolean {
  const parsed = parseJsonObject(raw);
  if (!parsed) return false;
  const server = normalizeMcpServerName(str(parsed.server) || str(parsed.serverName));
  const op = str(parsed.tool) || str(parsed.toolName) || str(parsed.name);
  return server === "openclaude-memory" && op === "delegate_task";
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
      if (block.inputJson !== undefined && block.inputJson !== null) {
        existing.inputJson = block.inputJson;
        existing._inputRevision = (existing._inputRevision ?? 0) + 1;
      }
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
        ...(block.inputJson != null ? { _inputRevision: 1 } : {}),
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
      target.output = block.output ?? block.preview ?? "";
      if (block.outputJson !== undefined) target.outputJson = block.outputJson;
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
        output: block.output ?? block.preview ?? "",
        ...(block.outputJson !== undefined ? { outputJson: block.outputJson } : {}),
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
  } else if (block.kind === "plan" || block.kind === "goal") {
    // Structured child events are real Agent process records. Keep the exact
    // event instead of replacing it with the legacy one-line progress text.
    children.push({ ...block } as ChildBlock);
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
      // server-authored 骨架行是跨设备终态快照,永不接收 live 委派绑定/childBlocks(债A)。
      !isServerAuthoredRow(m) &&
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

function legacyDelegateTextToChildBlock(phase: string | undefined, text: string): ChildBlock | null {
  if (!text || phase === "start" || phase === "done") return null;
  if (phase === "thinking") return { kind: "thinking", text };
  if (phase === "text") return { kind: "text", text };
  return { kind: "text", text: `[${phase || "progress"}] ${text}` };
}

function legacyDelegateEntriesToChildBlocks(entries: ChatMessage["entries"]): ChildBlock[] {
  if (!Array.isArray(entries)) return [];
  const out: ChildBlock[] = [];
  for (const entry of entries) {
    const text = typeof entry?.text === "string" ? entry.text : "";
    const child = legacyDelegateTextToChildBlock(entry.phase, text);
    if (child) out.push(child);
  }
  return out;
}

function mergeDelegateProgressIntoGroup(sess: ChatSession, groupMsg: ChatMessage, standalone: ChatMessage): boolean {
  if (!groupMsg || groupMsg.role !== "agent-group" || !groupMsg._delegate) return false;
  if (!standalone || standalone.role !== "delegate-progress" || standalone._adoptedInto) return false;
  if (groupMsg._delegateRunId && standalone.runId && groupMsg._delegateRunId !== standalone.runId) return false;

  const entryBlocks = legacyDelegateEntriesToChildBlocks(standalone.entries);
  const richBlocks = Array.isArray(standalone.childBlocks) ? standalone.childBlocks : [];
  const mergedChildren = [...(groupMsg.childBlocks ?? []), ...entryBlocks, ...richBlocks];
  groupMsg.childBlocks = mergedChildren;
  for (const child of mergedChildren) {
    if (child && child.kind === "tool_use" && child.blockId && /^Agent$/i.test(child.toolName || "")) {
      if (!sess._agentGroups) sess._agentGroups = new Map();
      sess._agentGroups.set(child.blockId, groupMsg.id);
    }
  }
  if (standalone.summary && !groupMsg._resultPreview) groupMsg._resultPreview = String(standalone.summary).slice(0, 200);
  if (standalone.summary && groupMsg.output == null) groupMsg.output = String(standalone.summary);
  if (standalone.error || standalone._isError) groupMsg._isError = true;
  if (standalone._completed && !groupMsg._completed) groupMsg._completed = true;
  if (standalone.completedAt && !groupMsg.completedAt) groupMsg.completedAt = standalone.completedAt;
  if (groupMsg._source !== "server" && !groupMsg._turnOwnerId) {
    groupMsg._turnOwnerId = standalone._turnOwnerId ?? standalone._clientMessageId;
  }
  if (standalone.runId) {
    groupMsg._delegateRunId = standalone.runId;
    if (!sess._delegateRunGroups) sess._delegateRunGroups = new Map();
    sess._delegateRunGroups.set(standalone.runId, groupMsg.id);
  }
  standalone._adoptedInto = groupMsg.id;
  const idx = sess.messages.findIndex((m) => m === standalone);
  if (idx >= 0) sess.messages.splice(idx, 1);
  return true;
}

/** Unified timeline rows are historical evidence, not live UI state.
 * Normalizers may operate around them but must never rewrite or remove them.
 * The legacy marker remains recognized only while rolling caches are drained. */
function isImmutableTapeViewportRow(message: ChatMessage): boolean {
  return message._timelineRecord === true || (
    typeof message._turnTapeProcessLoadedFrom === "string" &&
    message._turnTapeProcessLoadedFrom.length > 0
  );
}

function matchesDelegateProgress(groupMsg: ChatMessage, progress: ChatMessage): boolean {
  if (groupMsg.role !== "agent-group" || !groupMsg._delegate || progress.role !== "delegate-progress") return false;
  if (isImmutableTapeViewportRow(progress)) return false;
  // live progress 只绑本地富卡,不落到 server 骨架行(债A：骨架行无过程树,不接收 childBlocks)。
  if (isServerAuthoredRow(groupMsg)) return false;
  if (progress.runId && groupMsg._delegateRunId === progress.runId) return true;
  if (groupMsg._delegateRunId && progress.runId && groupMsg._delegateRunId !== progress.runId) return false;
  const agentId = groupMsg._delegateAgentId || "";
  const goal = groupMsg._delegateGoal || "";
  return !!agentId && !!goal && (progress.agentId || "") === agentId && progress._delegateGoal === goal;
}

function findSingleMatchingDelegateGroup(sess: ChatSession, progress: ChatMessage): ChatMessage | null {
  const matches = sess.messages.filter((m) => matchesDelegateProgress(m, progress));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * mixed turn(同一轮里既调了 fan-out `delegate_tasks`、又调了单数 `delegate_task`)且单数委派的
 * progress 早于其 tool_use 到达时:兜底会因 hasActiveFanoutDelegate 命中而先把该单数 run 物化成一张
 * fan-out 成员 agent-group。此处让随后到达的单数 delegate_task tool_use **复用**那张已物化的组
 * (按 (agentId, goalKey) 唯一匹配一条「无 blockId、未完成、已绑 runId」的本地富组),避免重复卡。
 * 纯单数场景(兜底走 delegate-progress standalone、无此类组)与纯 fan-out(无单数 tool_use 进本分支)
 * 都不命中 → 零回归。`candidates.length !== 1` 的歧义一律 bail(与既有 bind/adopt 同纪律)。
 */
function adoptMaterializedFanoutGroupForTool(
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
      m._delegateGoal === info.goalKey,
  );
  if (candidates.length !== 1) return null;
  const groupMsg = candidates[0];
  groupMsg.blockId = blockId;
  if (desc && groupMsg.text !== desc) groupMsg.text = desc;
  if (!sess._agentGroups) sess._agentGroups = new Map();
  sess._agentGroups.set(blockId, groupMsg.id);
  sess._blockIdToMsgId?.set(blockId, groupMsg.id);
  return groupMsg.id;
}

/** 反向 adopt：standalone delegate-progress 卡并入后绑定的 agent-group。*/
function adoptStandaloneDelegateRun(sess: ChatSession, groupMsg: ChatMessage): boolean {
  if (!groupMsg || !groupMsg._delegate) return false;
  const candidates = sess.messages.filter((m) => matchesDelegateProgress(groupMsg, m));
  if (candidates.length !== 1) return false;
  return mergeDelegateProgressIntoGroup(sess, groupMsg, candidates[0]);
}

function normalizeDelegateToolRow(sess: ChatSession, msg: ChatMessage): boolean {
  if (isImmutableTapeViewportRow(msg)) return false;
  if (msg.role !== "tool") return false;
  const info = parseDelegateToolInfo(msg.toolName, msg.inputJson, msg.inputPreview);
  if (!info) return false;
  const existingGroup = msg.blockId
    ? sess.messages.find((m) =>
        m !== msg && m.role === "agent-group" && m.blockId === msg.blockId &&
        !isImmutableTapeViewportRow(m))
    : null;
  if (existingGroup) {
    if (existingGroup._source !== "server" && !existingGroup._turnOwnerId) {
      existingGroup._turnOwnerId = msg._turnOwnerId ?? msg._clientMessageId;
    }
    const preview = friendlyDelegateResultPreview(msg.output);
    if (preview && !existingGroup._resultPreview) existingGroup._resultPreview = preview.slice(0, 200);
    // The rich group is only presentation. Preserve the authoritative tool
    // record before removing its duplicate top-level row so no raw field is
    // replaced by the friendly summary.
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
  msg.role = "agent-group";
  msg.text = info.goalRaw.trim() || msg.text || "委托子任务";
  msg.toolName = msg.toolName || "delegate_task";
  msg.startTime = msg.startTime || msg.ts || Date.now();
  msg.childBlocks = Array.isArray(msg.childBlocks) ? msg.childBlocks : [];
  msg._delegate = true;
  msg._delegateAgentId = info.agentId;
  msg._delegateGoal = info.goalKey;
  msg._completed = !!msg._completed;
  if (msg._source !== "server" && !msg._turnOwnerId) {
    msg._turnOwnerId = msg._clientMessageId;
  }
  const preview = friendlyDelegateResultPreview(msg.output);
  if (preview && !msg._resultPreview) msg._resultPreview = preview.slice(0, 200);
  if (msg.error) msg._isError = true;
  if (msg.blockId) {
    if (!sess._agentGroups) sess._agentGroups = new Map();
    sess._agentGroups.set(msg.blockId, msg.id);
    sess._blockIdToMsgId?.set(msg.blockId, msg.id);
  }
  return true;
}

/**
 * 债A：折叠 server-authored agent-group 骨架行(srv-* 或 _source:'server')按 runId 去重。
 *  - 本地富卡(m-*)同 runId 存在 → 丢弃 server 骨架(local-wins,保住 childBlocks,永不吞富卡);
 *  - 多个 server 骨架共享同一 runId → 只留首个(防重复卡)。
 * 收口在 normalizeDelegateCards(loadStored / applyServerMessages 后),与 persist 合并去重双保险:
 * 合并去重防「同一数组同时含富卡+骨架」重复渲染;本 fold 兜住其它路径塞进来的重复骨架。
 */
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
    if (m.role !== "agent-group" || !isServerAuthoredRow(m)) continue;
    if (isImmutableTapeViewportRow(m)) continue;
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
  // 债A：server-authored 骨架行按 runId 折叠(local-wins + 去重)。放在富卡物化之后,
  // 使 localRichRunIds 已含本轮 tool→agent-group 转换出的富卡。
  changed = foldServerAuthoredAgentGroups(sess) || changed;
  if (!changed) return;
  sess._blockIdToMsgId = new Map();
  sess._agentGroups = new Map();
  rebuildIndexes(sess);
  sess._delegateRunGroups = new Map();
  for (const msg of sess.messages) {
    if (
      msg.role === "agent-group" && msg._delegateRunId &&
      !isImmutableTapeViewportRow(msg)
    ) {
      sess._delegateRunGroups.set(msg._delegateRunId, msg.id);
    }
  }
}

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
 * Collapse them to the same stable identity used by the live reducer so
 * refresh/reconnect never recreates a row per Codex notification.
 *
 * 位置一致性(与实时 reducer 对齐):实时侧目标卡在**首次记录**处创建、后续修订就地
 * Object.assign 更新(同对象、同 id、首位置、内容取最新)。hydrate 每个历史 turn 会各投一张
 * 同身份卡,这里折叠时必须保持同一心智模型——**槽位取最早出现处(位置 min)、内容取最高
 * 修订(内容 max)**,否则刷新后目标卡会跳到「最后更新的 turn」位置,与实时不一致。 */
export function normalizeGoalCards(sess: ChatSession): void {
  // anchor = 每个身份最早出现的卡(位置权威);winner = 修订最高的卡(内容权威)。
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
      // 非最早槽位的同身份卡:折叠移除(内容已并入 slot)。
      remove.add(msg);
      continue;
    }
    // 最早槽位卡:归一 blockId,并把最高修订的内容并入。保留 slot 自身 id/ts(位置/创建时刻
    // 稳定,与实时首次创建的卡一致),仅内容取 winner —— 位置 min、内容 max。
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

/** 把一个 delegate_progress 帧落到已绑定的 agent-group 富卡(done/error → 终态;block → 富子块;
 *  legacy text → 降级子块)。fan-out 物化的组与既有单数委派组共用同一套落地语义。 */
function applyDelegatePhaseToGroup(sess: ChatSession, groupMsg: ChatMessage, block: DelegateProgressBlock): void {
  if (block.phase === "done" || block.phase === "error") {
    groupMsg._completed = true;
    groupMsg.completedAt = Date.now();
    if (block.text && !groupMsg._resultPreview) groupMsg._resultPreview = String(block.text).slice(0, 200);
    if (block.text && groupMsg.output == null) groupMsg.output = String(block.text);
    if (block.phase === "error") groupMsg._isError = true;
  } else if (block.block && typeof block.block === "object") {
    const child = block.block;
    const childText = typeof (child as { text?: unknown }).text === "string" ? (child as { text: string }).text : "";
    appendSubagentBlock(sess, groupMsg, child, childText);
  } else {
    const text = typeof block.text === "string" ? block.text : "";
    const child = legacyDelegateTextToChildBlock(block.phase, text);
    if (child) appendSubagentBlock(sess, groupMsg, child as OutboundContentBlock, child.text || "");
  }
}

function handleDelegateProgressBlock(
  sess: ChatSession,
  block: DelegateProgressBlock,
  turnOwnerId?: string,
): void {
  if (!block.runId) return;
  let groupMsgId = sess._delegateRunGroups?.get(block.runId);
  if (groupMsgId === undefined) {
    // 只绑本地富卡:server-authored 骨架行同 runId 也不接收 live 帧(债A)。
    const bound = sess.messages.find(
      (m) => m.role === "agent-group" && !isServerAuthoredRow(m) && m._delegateRunId === block.runId,
    );
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
      if (groupMsg._source !== "server" && !groupMsg._turnOwnerId && turnOwnerId) {
        groupMsg._turnOwnerId = turnOwnerId;
      }
      applyDelegatePhaseToGroup(sess, groupMsg, block);
      return;
    }
  }

  // ── 兜底 ── 已持久化的 standalone delegate-progress 行(旧会话 / 尚未被 adopt)按 runId 继续原地更新。
  const legacy =
    sess.messages.find((m) =>
      m.role === "delegate-progress" && m.runId === block.runId && !m._adoptedInto &&
      !isImmutableTapeViewportRow(m)) || null;

  // fan-out 成员:队长本轮调用的是复数 `delegate_tasks`(tool 卡不转组、无 per-subtask delegate_task
  // tool_use 可 adopt),直接把该 run 物化成 live agent-group —— 同轮 ≥2 个自动聚成 TeamPanel,turn 末
  // server-authored 骨架行按 runId 折叠去重(债A),消除「兜底卡 + 团队面板」三卡并存。单数委派(无 fan-out
  // tool 卡)则保留下方 delegate-progress standalone 兜底,由后到的 delegate_task tool_use adopt(零回归)。
  if (!legacy && hasActiveFanoutDelegate(sess)) {
    const goalRaw = typeof block.goal === "string" ? block.goal : "";
    const groupMsg = addMessage(sess, "agent-group", goalRaw.trim() || "子任务", {
      startTime: Date.now(),
      childBlocks: [],
      _delegate: true,
      _delegateRunId: block.runId,
      _delegateAgentId: block.agentId || "",
      _delegateGoal: goalRaw ? normalizeDelegateGoalKey(goalRaw) : "",
      _completed: false,
      ...(turnOwnerId ? { _turnOwnerId: turnOwnerId } : {}),
    });
    if (!sess._delegateRunGroups) sess._delegateRunGroups = new Map();
    sess._delegateRunGroups.set(block.runId, groupMsg.id);
    applyDelegatePhaseToGroup(sess, groupMsg, block);
    return;
  }

  // Fallback: standalone delegate-progress card keyed by runId.
  let msg = legacy;
  if (!msg) {
    msg = addMessage(sess, "delegate-progress", "", {
      runId: block.runId,
      agentId: block.agentId || "",
      goal: typeof block.goal === "string" ? block.goal : "",
      _delegateGoal: typeof block.goal === "string" ? normalizeDelegateGoalKey(block.goal) : "",
      entries: [],
      childBlocks: [],
      _completed: false,
      ...(turnOwnerId ? { _turnOwnerId: turnOwnerId } : {}),
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
  const group = findSingleMatchingDelegateGroup(sess, msg);
  if (group) mergeDelegateProgressIntoGroup(sess, group, msg);
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
    if (
      m && m.role === "plan" && m.blockId === blockId &&
      !isImmutableTapeViewportRow(m)
    ) return m;
  }
  return null;
}

// ═══════════════ 生成占位卡（需求 C）消解/失败 ═══════════════

/**
 * 交付终帧回带的图片编辑 jobId。契约（protocol OutboundMessage 顶层 `imageEditJobId`，Agent B）：
 * gateway「免模型直投」交付终帧携带 imageEditJobId（= inbound imageEdit.clientJobId =
 * 占位行 _genPlaceholder.jobId），容器→master→user 全程 raw 透传；普通 turn 终帧不带。
 * 运行期防御性校验（wire 帧不可尽信），类型上该字段已入约。
 */
function extractImageEditJobId(frame: OutboundMessageWire): string | undefined {
  const j = frame.imageEditJobId;
  return typeof j === "string" && j.length > 0 ? j : undefined;
}

/**
 * 消解本会话的生成占位行（imageEdit 结果图已作为 assistant 消息落地）。
 *  - `jobId` 存在（image-edit 直投终帧回带顶层 imageEditJobId）→ **精确匹配该 job 的占位、
 *    无论状态**删除：既清运行中,也清「上次失败后重试成功」残留的失败占位（重试复用同
 *    clientJobId，见 socket.retryMessage）。
 *  - `jobId` 缺省（普通 turn 终帧 / 旧 gateway 不带该字段）→ 按「本会话 turn 串行、同一时刻
 *    至多一条运行中占位」语义,只删运行中（不误删其它轮的失败卡）。
 * 倒序 splice，就地维持 messages 数组（与 reducer 就地 mutation 语义一致）。
 */
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

/** 把本会话「运行中」的生成占位行转失败态（turn error 收尾用）。就地改字段（sig 含 status → 重渲）。 */
export function failGenPlaceholders(sess: ChatSession, reason?: string): void {
  for (const m of sess.messages) {
    const gp = m._genPlaceholder;
    if (gp && gp.status === "running") {
      gp.status = "failed";
      if (reason && !gp.reason) gp.reason = reason;
    }
  }
}

/**
 * 兜底消解(纵深防御):REST 对账(applyServerMessages)后,若某**运行中**占位的锚点 user 行
 * (占位随其注入的那条乐观 user 消息,GenPlaceholder.afterUserMsgId)已被 server echo 回带
 * `_seq`,且会话里存在 **server 序更晚** 的 server-authored assistant 行 —— 说明该轮结果已在
 * 服务端 durable 收尾,只是 live 终帧没送达(任何帧丢失类故障)。按「turn 串行」语义清掉该
 * 占位,防「扣费成功 + 结果已显示 + 占位永转」(2026-07-11 boss 生产事故形态:冷容器 frameSeq
 * 重置致直投终帧被游标黑洞,结果行靠 REST 对账补上而占位无人消解)。
 * 纯 `_seq`(server 单调序)比较,零时钟依赖;锚点行未被 echo(_seq 缺省)则不动(fail-safe,
 * 绝不在轮进行中误清);failed 占位保留(失败卡要给用户看)。
 */
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

  // server ts 跟踪(max 单调):供 resetReplyTracker 定格 server 域 stale 截止(§11)。
  trackServerTs(sess, frame.ts);

  // A delayed frame from an older turn on the same peer must never mutate
  // the streaming pointers/lifecycle of a newer active turn. The durable
  // tape owns the old content, so an exact sync is safer than cross-turn
  // client-side merging here.
  if (
    frame.clientMessageId &&
    sess._activeClientMessageId &&
    frame.clientMessageId !== sess._activeClientMessageId
  ) {
    if (frame.isFinal) effects.forceSync?.(sess.id, { clientMessageId: frame.clientMessageId });
    return;
  }

  // Exact turn ownership for browser-only process cards.  Rolling legacy
  // frames without an id may use the active turn, but an explicit frame id
  // always wins and is never replaced with a nearby active turn.
  const frameTurnOwnerId = frame.clientMessageId ?? sess._activeClientMessageId;

  // ── reconcile 'turn_state_unknown'(非 final,RFC §4)──
  // hello 对账时 server 对客户端上报的在飞 turn **无法给出终态**(durable inbox 无行且不是
  // negative proof)。此时**绝不清 _sendingInFlight** —— turn 可能仍在服务端执行,静默清态正是
  // 本 RFC 要根治的丢 turn 症状。改为:① 立即 REST 全量对账拉回权威态
  // (含 durable dispatch 状态行);② 请 socket 把 thinking-safety 定时降至 60s(默认
  // 10min),尽快让用户看到真实终态或经核验的错误状态。
  // markFrameReceived 计活(server 确在应答),但不触碰 turn 生命周期。到达此处已过 cross-turn
  // 守卫:frame.clientMessageId 要么命中 active、要么本地无 active/legacy 无 id,均安全放行。
  if (!frame.isFinal && frame.meta?.reconcile === "turn_state_unknown") {
    markFrameReceived(sess);
    const clientMessageId = frame.clientMessageId ?? sess._activeClientMessageId;
    if (clientMessageId) effects.forceSync?.(sess.id, { clientMessageId });
    else effects.forceSync?.(sess.id);
    effects.onTurnStateUnknown?.(sess.id);
    return;
  }

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

  // ── §11 service_restart 合成 final：重连清扫信号，绝不凭空落一条持久 ⚠️ 气泡 ──
  // gateway 重启后对「客户端上报 inFlight」的会话补推 meta.interrupted='service_restart'
  // 的 isFinal（server.ts autoResumeFromHello）。它本质是**清扫在途发送态**的信号，权威
  // 只在 client：唯有本地确有「在途流式内容」（assistant 正文已流 / thinking 已流）才说明
  // 真有一轮被上游断流掐断（1b488863 场景）——此时落到下方通用 final：⚠️ 文本（若服务端仍
  // 带）追加到既有流式行、并 scheduleRestartContinue 自动续写，语义不回归。
  //
  // 其余全部走**带外清扫**：有 queued user（按原语义不绑新轮）；或本地**无在途流**（tool-only
  // 在途 / 卡死残留发送态 / 已完成轮的 stale inFlight）。后者正是 bug 形态：peerInFlight 上报
  // 为真但根本没有正文在途，旧代码让 ⚠️ text 走进 §7 block 循环，findOrCreateStreamingRow
  // 在 `!_streamingAssistant` 时**新建一条 assistant 气泡**（reducer §7:967），phantom 中断卡
  // 就此凭空生成、随 onFinal→persistSession 永久落库（生产实证 10/24 条为此形态）。带外清扫
  // 直接 return，绝不进 block 循环、也不 scheduleRestartContinue（无正文可续），一并根治「落库
  // 放大」。清流式指针与 reconcile('turn_completed') 分支对称，避免 stale 指针渗入下一轮。
  if (frame.isFinal && frame.meta?.interrupted === "service_restart") {
    const hasQueuedUser = sess.messages.some((m) => m.role === "user" && m.status === "queued");
    const hasLiveStream =
      (!!sess._streamingAssistant && (sess._streamingAssistant.text ?? "").trim().length > 0) ||
      !!sess._streamingThinking;
    if (!(hasLiveStream && !hasQueuedUser)) {
      const clientMessageId = frame.clientMessageId ?? sess._activeClientMessageId;
      sess._streamingAssistant = null;
      sess._streamingThinking = null;
      sess._sendingInFlight = false;
      sess._activeClientMessageId = undefined;
      clearTurnTiming(sess);
      resetReplyTracker(sess);
      sess.messages = repairPostFinalProcessOrder(sess.messages);
      effects.onFinal?.(sess, frame, true, clientMessageId);
      return;
    }
  }

  // ── reconcile 合成 final(turn_completed / interrupted,RFC §4 身份对称)──
  //    hello 重连对账时 server 判定该在飞 turn **已在服务端收尾**(正常完成 / 中断),但客户端仍挂
  //    发送态(missed 真 final)。这些合成帧**现在必带 clientMessageId**,归属按 **exact clientMessageId
  //    匹配**:仅当它精确命中当前 active turn(或本地无 active / legacy 无 id)才收口本轮发送态。跨轮
  //    mismatch 由顶部 cross-turn 守卫拦截,此处再显式校验一次 —— 旧轮的 reconcile final 绝不清新轮
  //    的 sending 态(R3「拿上一轮 outcome 冒充当前在飞 turn」根因的端上闭合)。收口不走空轮分类
  //    (空 blocks 不合成空气泡——内容其实已在服务端生成/中断),并强制 REST 全量对账拉回真实内容。──
  if (
    frame.isFinal &&
    (frame.meta?.reconcile === "turn_completed" || frame.meta?.reconcile === "interrupted")
  ) {
    const active = sess._activeClientMessageId;
    const frameCmid = frame.clientMessageId;
    if (frameCmid && active && frameCmid !== active) {
      // 旧轮 reconcile 命中新轮:只精确对账旧轮内容,绝不触碰新轮生命周期。
      effects.forceSync?.(sess.id, { clientMessageId: frameCmid });
      return;
    }
    const clientMessageId = frameCmid ?? active;
    sess._streamingAssistant = null;
    sess._streamingThinking = null;
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    clearTurnTiming(sess);
    resetReplyTracker(sess);
    // 该轮已在服务端收尾（含 imageEdit 结果图）：消解运行中占位，结果随 forceSync 回带。
    resolveGenPlaceholders(sess, extractImageEditJobId(frame));
    sess.messages = repairPostFinalProcessOrder(sess.messages);
    effects.onFinal?.(sess, frame, false, clientMessageId);
    if (clientMessageId) effects.forceSync?.(sess.id, { clientMessageId });
    else effects.forceSync?.(sess.id);
    return;
  }

  // ── §11 stale 守卫 ──
  // stale 判定优先走 **server 时钟域同域比较**（frame.ts ≤ reset 前所见最大 server ts →
  // 帧发出不晚于 reset 前已见内容 → stale）；仅当从未见过 server ts（_trackerResetServerTs
  // 缺省）才回退到 frame.ts(server 钟) vs _trackerResetAt(客户端钟) 的跨域比较——跨域比较
  // 在客户端时钟快于 server 时会把整轮新帧误杀,不能作首选。
  const staleVsTrackerReset = (ts: number): boolean =>
    typeof sess._trackerResetServerTs === "number"
      ? ts <= sess._trackerResetServerTs
      : typeof sess._trackerResetAt === "number" && ts < sess._trackerResetAt;
  // final 与非 final **同走 server 时钟域截止**(staleVsTrackerReset:frame.ts ≤ 最近一次
  // tracker reset 所见最大 server ts → 帧发出不晚于上一轮 turn 边界 → stale)。
  // 旧实现在 _replyingToMsgId 绑定时改用 `frame.ts(server 钟) < boundMsg.ts(客户端钟)` 跨钟域
  // 比较:设备钟快于 server 且超过「发送→final」间隔时,本轮**合法 final** 被误判 stale 丢弃 →
  // _sendingInFlight 永不清 → 本轮永久卡「回复中」。统一到 server 域后消除这一整类跨钟域误吞
  // (frame.ts 与 _trackerResetServerTs 同为 server 钟;仅在从未见过 server ts 的首轮回退客户端钟,
  //  此时无「上一轮遗留 late final」风险)。
  // The compatibility terminator immediately following an accepted
  // outbound.error is authorized by its exact adjacent frameSeq. Both
  // gateway deliver() calls can share one millisecond timestamp, and the
  // error handler intentionally resets the tracker before this final arrives;
  // do not let that reset suppress the terminal lifecycle/sync callback.
  if (
    typeof frame.ts === "number" &&
    staleVsTrackerReset(frame.ts) &&
    !suppressLegacyErrorText
  ) {
    return; // final:不误 teardown;非 final:不恢复 in-flight
  }
  // 本地 stop/timeout/switch/error 后，禁止旧 turn 非 final 复活发送态；cron/proactive 推送
  // 仍放行。**时间窗有界**（客户端钟 vs 客户端钟,同域）:该守卫针对的是「stop 后 server 端
  // turn 尚未被 interrupt 掉的收尾期晚到帧」,量级是秒到分;无界压制会把**另一端设备**在本端
  // stop 之后发起的新 turn 流式帧也全部吞掉(多端同看回归)。窗口过期后帧正常放行,由下方
  // in-flight 复活逻辑接管。
  if (
    !frame.isFinal &&
    !frame.cronJob &&
    !sess._sendingInFlight &&
    typeof sess._localTeardownAt === "number" &&
    Date.now() - sess._localTeardownAt < TEARDOWN_DROP_WINDOW_MS
  ) {
    return;
  }

  // ── §11 agent 切换守卫 ──
  // 旧的 `frame.ts(server 钟) < _agentSwitchedAt(客户端钟)` 跨钟域比较已删除:switchAgent 会
  // resetReplyTracker → 定格 _trackerResetServerTs(切换时刻的 server ts),故切 agent 前发出的
  // 旧 agent 帧已被上方 server 域 staleVsTrackerReset 统一拦下(与 final/非 final 同一判据)。
  // 保留下面这条**同为客户端钟**(Date.now() vs _agentSwitchedAt)的 2s 窗:压制切换后短暂
  // settle 期里旧 agent 尚未被 server interrupt 的非 final 收尾帧恢复发送态(无跨钟域问题)。
  if (sess._agentSwitchedAt && !sess._sendingInFlight && !frame.isFinal && Date.now() - sess._agentSwitchedAt < 2000) return;

  const hasBlocks = Array.isArray(frame.blocks) && frame.blocks.length > 0;
  // tool_output_tail-only 帧(bg bash 每秒一条 tail 快照)是长命令的尾巴刷新,不是模型新内容、也不是
  // turn 生命周期信号。它**只做两件事**:① markFrameReceived 帧计活 ② 下方 block 循环对**既有**
  // tool_output_tail 卡的原位刷新(bash tail)。其余一律短路——不复活发送态、不绑 reply tracker、
  // 不改 user 行状态、不触发 onLiveFrame。否则旧 turn 的 bg bash tail 与新 turn 的用户行重叠时会:
  // 把已结束轮点亮成"回复中"(生产事故:一条 bg bash tail 让终态轮亮 13 分钟)、把新 turn 尚未回复
  // 的用户行错标成 read、发出错误的 live 生命周期信号。final 帧**永不**算 tail-only(其收尾逻辑必须
  // 照常跑)。混合帧(tail + text/tool)代表模型确有新生成 → 行为完全不变。thinking-safety 不受影响:
  // 计时器触发时按 _lastFrameAt(markFrameReceived 推进)做 liveness 复检,长 bash 只发 tail 也不误超时。
  const tailOnlyFrame =
    !frame.isFinal &&
    hasBlocks &&
    (frame.blocks as Array<{ kind?: string }>).every((b) => b?.kind === "tool_output_tail");
  // reload 后若本轮仍有新内容抵达，先通过 frameSeq/stale/agent-switch 守卫，再恢复 in-flight；cron 推送不是用户 turn。
  if (!frame.isFinal && !frame.cronJob && hasBlocks && !tailOnlyFrame && !sess._sendingInFlight)
    sess._sendingInFlight = true;
  if (hasBlocks || frame.isFinal) markFrameReceived(sess);
  // 自动重试软提示的**内容帧兜底消解**:引擎在下一 attempt 产出真实内容(非 tail-only)即代表流
  // 已恢复 → 清 retrying,防 gateway 的 turn_status:null 复位帧在断线重连窗口丢失时软提示粘住。
  // final/error/interrupted 由 clearTurnTiming 统一清 _turnStatus,此处只兜「流恢复但 null 帧丢」。
  if (hasBlocks && !tailOnlyFrame && isRetryingTurnStatus(sess._turnStatus)) sess._turnStatus = null;
  // thinking-safety：通过守卫的非 final 帧重置；isFinal 清（由 socket 持 timer）。tail-only 帧不触发。
  if (sess._sendingInFlight && !frame.isFinal && !tailOnlyFrame) effects.onLiveFrame?.(sess);

  // reply tracker 绑定 / user 行状态 / answer 计数 / isFinal 收尾 —— tail-only 帧全部短路(见上注释)。
  if (!tailOnlyFrame) {
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
      handleDelegateProgressBlock(sess, b as unknown as DelegateProgressBlock, frameTurnOwnerId);
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
        if (
          b.messageId && sess.messages.some((message) =>
            message.id === b.messageId && message.role === "assistant" &&
            isImmutableTapeViewportRow(message))
        ) continue;
        sess._streamingAssistant = findOrCreateStreamingRow(
          sess.messages,
          "assistant",
          b.messageId,
          (idOverride) => {
            const extra: Partial<ChatMessage> = isCronPush
              ? { cronPush: true, cronLabel: frame.cronJob?.label }
              : {};
            Object.assign(extra, idOverride);
            if (frameTurnOwnerId) extra._turnOwnerId = frameTurnOwnerId;
            return addMessage(sess, "assistant", "", extra);
          },
        );
      }
      if (frameTurnOwnerId && !sess._streamingAssistant._turnOwnerId) {
        sess._streamingAssistant._turnOwnerId = frameTurnOwnerId;
      }
      sess._streamingAssistant.text += blockText;
      sess._streamingAssistant.completedAt = Date.now();
    } else if (b.kind === "thinking") {
      if (!sess._streamingThinking) {
        if (
          b.messageId && sess.messages.some((message) =>
            message.id === b.messageId && message.role === "thinking" &&
            isImmutableTapeViewportRow(message))
        ) continue;
        sess._streamingThinking = findOrCreateStreamingRow(
          sess.messages,
          "thinking",
          b.messageId,
          (idOverride) => addMessage(sess, "thinking", "", {
            ...idOverride,
            ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
          }),
        );
      }
      if (frameTurnOwnerId && !sess._streamingThinking._turnOwnerId) {
        sess._streamingThinking._turnOwnerId = frameTurnOwnerId;
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
    } else if (b.kind === "goal") {
      const gb = b as {
        objective?: string;
        status?: string;
        tokenBudget?: number | null;
        tokensUsed?: number;
        timeUsedSeconds?: number;
        updatedAt?: number;
        cleared?: boolean;
        platformGoalId?: string;
        platformStateRevision?: number;
      };
      // One stable row per platform goal. Codex's native block id is turn-
      // scoped, so using it directly would append a duplicate card every turn.
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
        tokenBudget: typeof gb.tokenBudget === "number" || gb.tokenBudget === null ? gb.tokenBudget : undefined,
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
      const delegateInfo = parseDelegateToolInfo(tb.toolName, tb.inputJson, tb.inputPreview);
      const isDelegate = !!delegateInfo;
      if (isAgent || isDelegate) {
        if (!sess._agentGroups) sess._agentGroups = new Map();
        if (tb.blockId) {
          const input = parseToolInputObject(tb.inputJson, tb.inputPreview);
          const preview = (tb.inputPreview || "").replace(/[{}"]/g, "").slice(0, 80);
          let desc: string;
          let delegateFields: Partial<ChatMessage> | null = null;
          let agentFields: Partial<ChatMessage> = {};
          if (isDelegate) {
            const info = delegateInfo!;
            desc = (info.goalRaw && info.goalRaw.trim()) || preview || "委托子任务";
            delegateFields = { _delegate: true, _delegateAgentId: info.agentId, _delegateGoal: info.goalKey };
          } else {
            const originRaw = input && typeof input.openclaudeOrigin === "string" ? input.openclaudeOrigin : "";
            const teamFallback = input?.openclaudeTeamFallback === true;
            agentFields = {
              ...(originRaw ? { _agentGroupOrigin: originRaw } : {}),
              ...(teamFallback ? { _teamFallback: true } : {}),
            };
            desc =
              (input && typeof input.description === "string" && input.description) ||
              (input && typeof input.prompt === "string" && input.prompt.slice(0, 80)) ||
              preview ||
              "子任务";
          }
          if (isDelegate) {
            const fields = delegateFields!;
            const existingId = sess._blockIdToMsgId?.get(tb.blockId);
            const existingTool = existingId
              ? sess.messages.find((m) => m.id === existingId && m.role === "tool")
              : null;
            if (existingTool) {
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
              if (!existingTool._turnOwnerId && frameTurnOwnerId) {
                existingTool._turnOwnerId = frameTurnOwnerId;
              }
              sess._agentGroups.set(tb.blockId, existingTool.id);
              sess._blockIdToMsgId?.set(tb.blockId, existingTool.id);
              adoptStandaloneDelegateRun(sess, existingTool);
              continue;
            }
            // mixed turn:复用本轮已被 fan-out 兜底物化、实属本单数委派的组(见 helper),消重复卡。
            if (adoptMaterializedFanoutGroupForTool(sess, delegateInfo!, tb.blockId, desc)) continue;
          }
          if (!sess._agentGroups.has(tb.blockId)) {
            const groupMsg = addMessage(sess, "agent-group", desc, {
              blockId: tb.blockId,
              toolName: isDelegate ? tb.toolName || "delegate_task" : "Agent",
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
          } else {
            const groupMsgId = sess._agentGroups.get(tb.blockId);
            const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
            if (groupMsg) {
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
                adoptStandaloneDelegateRun(sess, groupMsg);
              } else {
                if (agentFields._agentGroupOrigin) groupMsg._agentGroupOrigin = agentFields._agentGroupOrigin;
                if (agentFields._teamFallback) groupMsg._teamFallback = true;
              }
            }
          }
        }
      } else if (tb.blockId && sess._blockIdToMsgId?.has(tb.blockId)) {
        // 更新现有 tool 卡（partial → final）。
        const mid = sess._blockIdToMsgId.get(tb.blockId);
        const existing = sess.messages.find((m) => m.id === mid);
        if (existing) {
          if (frameTurnOwnerId && !existing._turnOwnerId) existing._turnOwnerId = frameTurnOwnerId;
          existing.inputPreview = tb.inputPreview || existing.inputPreview;
          // §8 partialJson offset 累加。
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
        }
      } else {
        // 新建 tool 卡（§9 canonical id 条件 spread）。
        const m = addMessage(sess, "tool", tb.toolName || "unknown", {
          ...(tb.messageId ? { id: tb.messageId } : {}),
          toolName: tb.toolName,
          blockId: tb.blockId,
          inputPreview: tb.inputPreview || "",
          inputJson: tb.inputJson || null,
          ...(tb.inputJson != null ? { _inputRevision: 1 } : {}),
          partialJson: (() => {
            const r = applyPartialJsonDelta(null, tb);
            return r.action === "set" ? r.value : undefined;
          })(),
          _partial: !!tb.partial,
          _completed: false,
          output: null,
          error: false,
          ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
        });
        if (tb.blockId) sess._blockIdToMsgId?.set(tb.blockId, m.id);
      }
    } else if (b.kind === "tool_result") {
      if (sess._streamingAssistant) sess._streamingAssistant.completedAt = Date.now();
      if (sess._streamingThinking) sess._streamingThinking.completedAt = Date.now();
      sess._streamingAssistant = null;
      sess._streamingThinking = null;
      const rb = b as {
        toolName?: string;
        blockId?: string;
        toolUseBlockId?: string;
        preview?: string;
        output?: string;
        outputJson?: unknown;
        isError?: boolean;
      };
      const agentToolUseId = rb.toolUseBlockId || (rb.blockId ? String(rb.blockId).replace(/:result$/, "") : null);
      if (agentToolUseId && sess._agentGroups?.has(agentToolUseId)) {
        const groupMsgId = sess._agentGroups.get(agentToolUseId);
        const groupMsg = sess.messages.find((m) => m.id === groupMsgId);
        if (groupMsg) {
          if (frameTurnOwnerId && !groupMsg._turnOwnerId) groupMsg._turnOwnerId = frameTurnOwnerId;
          const rawOutput = rb.output ?? rb.preview ?? "";
          const rawPreview = rb.preview ?? rawOutput;
          const preview = friendlyDelegateResultPreview(rawPreview) || (isDelegateResultWrapper(rawPreview) ? "" : rawPreview);
          groupMsg._completed = true;
          groupMsg._duration = Date.now() - (groupMsg.startTime || Date.now());
          if (preview && !groupMsg._resultPreview) groupMsg._resultPreview = preview.slice(0, 200);
          groupMsg.output = rawOutput;
          if (rb.outputJson !== undefined) groupMsg.outputJson = rb.outputJson;
          groupMsg._isError = !!rb.isError || !!groupMsg._isError;
        }
        continue;
      }
      const toolUseId = rb.toolUseBlockId || (rb.blockId ? rb.blockId.replace(/:result$/, "") : null);
      if (toolUseId && sess._blockIdToMsgId?.has(toolUseId)) {
        const mid = sess._blockIdToMsgId.get(toolUseId);
        const existing = sess.messages.find((m) => m.id === mid);
        if (existing) {
          if (frameTurnOwnerId && !existing._turnOwnerId) existing._turnOwnerId = frameTurnOwnerId;
          existing._completed = true;
          existing.output = rb.output ?? rb.preview ?? "";
          if (rb.outputJson !== undefined) existing.outputJson = rb.outputJson;
          existing.error = !!rb.isError;
          existing._partial = false;
          continue;
        }
      }
      if (rb.output === undefined && rb.preview === undefined) continue;
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
        ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
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
              ...(frameTurnOwnerId ? { _turnOwnerId: frameTurnOwnerId } : {}),
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
      if (isImmutableTapeViewportRow(m)) continue;
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
    const clientMessageId = frame.clientMessageId ?? sess._activeClientMessageId;
    sess._streamingAssistant = null;
    sess._streamingThinking = null;
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    clearTurnTiming(sess);
    // 生成占位卡（需求 C）消解：本 turn 收尾 → imageEdit 结果图已作为 assistant 消息原位落地，
    // 删占位行。直投终帧回带顶层 imageEditJobId 时精确匹配；缺省按串行语义消解运行中占位（见函数注释）。
    resolveGenPlaceholders(sess, extractImageEditJobId(frame));
    sess.messages = repairPostFinalProcessOrder(sess.messages);
    effects.onFinal?.(sess, frame, isCronOrHeartbeat, clientMessageId);
    // 服务重启掐断上游生成流的合成 final:有截断内容则自动续写(守卫在 socket 侧)。
    if (frame.meta?.interrupted === "service_restart") effects.scheduleRestartContinue?.(sess.id);
  }
}

// ═══════════════ outbound.turn_status（§6/§7）═══════════════
export function applyTurnStatus(sess: ChatSession, frame: OutboundTurnStatusWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  markFrameReceived(sess); // liveness signal
  // 判别联合(turn-retry 批):compacting 沿用字符串态;retrying 存下 attempt/max/retryAt 软提示
  // 载荷(不进 tape);其余(status:null / compact_end / abort)回到普通流式空态。retry 元数据只在
  // retrying 分支携带,故此处显式 narrow,不接受其它态漂出 retry 字段。
  if (frame.status === "compacting") {
    sess._turnStatus = "compacting";
  } else if (frame.status === "retrying") {
    sess._turnStatus = {
      kind: "retrying",
      attempt: frame.retry.attempt,
      max: frame.retry.max,
      retryAt: frame.retry.retryAt,
    };
  } else {
    sess._turnStatus = null;
  }
}

// ═══════════════ outbound.error 双帧（§11）═══════════════
export function applyOutboundError(sess: ChatSession, frame: OutboundErrorWire, effects: FrameEffects = {}): void {
  if (typeof frame.frameSeq === "number" && frame.frameSeq > 0) {
    if (!acceptFrameSeq(sess, frame)) return;
    sess._suppressErrorBubbleAtSeq = frame.frameSeq + 1;
  }
  const normalized = normalizeBridgeErrorCode(frame.code);
  addMessage(sess, "assistant", friendlyBridgeErrorMessage(frame.code, frame.message || "出错了"), {
    _errorCode: normalized,
    _errorDetail: safeBridgeErrorDetail(frame.code, frame.traceId),
    ...(frame.clientMessageId ? { _clientMessageId: frame.clientMessageId } : {}),
    ...(frame.traceId ? { usage: { traceId: frame.traceId } } : {}),
  });
  // outbound.error is the structured error card; the following [error] text final is only a
  // compatibility terminator. Clear/persist locally now so a refresh in that tiny gap does not
  // resurrect the stop button or let late non-final frames revive the failed turn.
  const ownsActiveTurn = frame.clientMessageId
    ? sess._activeClientMessageId === frame.clientMessageId
    : true; // rolling compatibility for old gateways
  if (ownsActiveTurn) {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    clearTurnTiming(sess);
    resetReplyTracker(sess);
    sess._localTeardownAt = sess._trackerResetAt;
    // 生成占位卡（需求 C）：本轮出错 → 运行中占位转失败态（danger 边 + 原因）。
    failGenPlaceholders(sess, errorLabel(normalized));
  }
  const exactUser = frame.clientMessageId
    ? sess.messages.find((m) => m?.role === "user" && m.id === frame.clientMessageId)
    : undefined;
  if (exactUser) {
    exactUser.status = "error";
  } else if (!frame.clientMessageId) {
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (m?.role === "user" && (m.status === "sending" || m.status === "sent" || m.status === "queued")) {
        m.status = "error";
        break;
      }
    }
  }
  effects.persistSession?.(sess.id);
  // 遥测上报口径用**遥测豁免集**(reportable===false),与"预期业务态"(expected)解耦
  // (Codex 审计 R5c):rate_limited/model_capacity/service_restart/image_server_busy 虽对用户预期,
  // 但是平台运营故障信号,必须上报;仅用户主动(stopped/user_cancelled)与业务拒绝类才豁免。
  if (!REPORT_EXEMPT_TURN_ERR_CODES.has(normalized)) {
    effects.reportTurnError?.({
      code: normalized,
      message: `${normalized}: ${frame.message || frame.detail || ""}`,
      traceId: typeof frame.traceId === "string" ? frame.traceId : undefined,
      sessionId: sess.id,
    });
  }
  if (normalized === "insufficient_credits") effects.refreshBalance?.();
  effects.scheduleAutomaticRecovery?.(sess.id, frame.clientMessageId);
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
    _errorDetail: safeBridgeErrorDetail(frame.code, frame.traceId),
    ...(frame.clientMessageId ? { _clientMessageId: frame.clientMessageId } : {}),
    ...(frame.traceId ? { usage: { traceId: frame.traceId } } : {}),
  });
  // legacy error 无后续 final，前端自己收尾本轮 UI。
  const ownsActiveTurn = frame.clientMessageId
    ? sess._activeClientMessageId === frame.clientMessageId
    : true;
  if (ownsActiveTurn) {
    sess._sendingInFlight = false;
    sess._activeClientMessageId = undefined;
    clearTurnTiming(sess);
    resetReplyTracker(sess);
    sess._localTeardownAt = sess._trackerResetAt;
    // 生成占位卡（需求 C）：本轮出错 → 运行中占位转失败态。
    failGenPlaceholders(sess, errorLabel(normalized));
  }
  const exactUser = frame.clientMessageId
    ? sess.messages.find((m) => m?.role === "user" && m.id === frame.clientMessageId)
    : undefined;
  if (exactUser) {
    exactUser.status = "error";
  } else if (!frame.clientMessageId) {
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      const m = sess.messages[i];
      if (m?.role === "user" && (m.status === "sending" || m.status === "sent" || m.status === "queued")) {
        m.status = "error";
        break;
      }
    }
  }
  effects.persistSession?.(sess.id);
  if (normalized === "insufficient_credits") effects.refreshBalance?.();
  effects.scheduleAutomaticRecovery?.(sess.id, frame.clientMessageId);
}

// ═══════════════ resume_failed（§4 第三层）═══════════════
export function applyResumeFailed(sess: ChatSession, frame: OutboundResumeFailedWire, effects: FrameEffects = {}): void {
  const frameTo = typeof frame.to === "number" ? frame.to : 0;
  if (frameTo === 0 && frame.reason === "no_buffer") {
    // 容器 ring 重启签名(该 sessionKey 在这代容器里零帧):游标必须归零,否则新生代帧
    // seq=1.. 全被当重复帧黑洞——直投单帧轮整轮蒸发(生产实证见 resetFrameSeqCursor 注释)。
    resetFrameSeqCursor(sess, frame);
  } else {
    advanceFrameSeqCursorTo(sess, frame, frameTo); // 推游标到 server currentLast（防 reload 死循环，配 dbPut）
  }
  sess._liveStreamBroken = true;
  effects.persistSession?.(sess.id); // 立即落地仲裁后的游标（dbPut 写点；防 reload 死循环）
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
  //
  // Fix B — 委派成本精确归属:frame.parentSessionId 存在 = 这是委派子智能体的成本,它属于
  // **父会话当前在飞的队长 turn**(委派 LLM 调用发生在队长 isFinal 之前)。此时若无
  // streamingAssistant 又命中 60s 内的 lastFinaled(那是**上一** turn 的助手消息),旧逻辑会把
  // 本轮委派成本错算到上一轮响应上。故委派 + 在飞(_sendingInFlight)时**跳过** lastFinaled 分支
  // → 落入下方 (a) 入队 _pendingCostCredits,由本轮队长 isFinal 的 meta-drain/收尾兜底落到本轮
  // 队长响应。普通 chat(无 parentSessionId)行为完全不变。
  const isDelegateInFlight = !!frame.parentSessionId && sess._sendingInFlight;
  let target: ChatMessage | null = null;
  if (sess._streamingAssistant) {
    target = sess._streamingAssistant;
  } else if (
    !isDelegateInFlight &&
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

/** turn 免单退款帧：master 已精确冲正扣费并创建站内信。
 *  余额始终刷新；消息更新只允许按 master 持久化的 root turnKey 精确命中。
 *  `_pendingCostCredits` 没有 turn 归属，绝不能用它猜测，否则迟到的 A 轮免单会
 *  篡改正在展示的 B 轮成本。未命中时等待下一次 server history 对账。*/
export function applyCostWaived(sess: ChatSession | null, frame: CostWaivedWire, effects: FrameEffects = {}): void {
  if (frame.balanceAfter !== undefined && frame.balanceAfter !== null) effects.refreshBalance?.();
  if (!sess) return;
  if (typeof frame.turnKey !== "string" || !/^[0-9a-f]{64}$/.test(frame.turnKey)) return;
  let target: ChatMessage | undefined;
  for (let index = sess.messages.length - 1; index >= 0; index--) {
    const message = sess.messages[index];
    if (message.role === "assistant" && message._turnKey === frame.turnKey) {
      target = message;
      break;
    }
  }
  if (!target) {
    // The live fallback row does not know the master turn key. Pull the
    // authoritative waiver+receipt history instead of guessing a nearby row.
    effects.forceSync?.(sess.id);
    return;
  }
  // Keep gross costCredits as audit evidence. The waived marker controls the
  // presentation, matching the durable history record exactly.
  target.usage = { ...target.usage, waived: true };
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
    ...((frame.clientMessageId ?? sess._activeClientMessageId)
      ? { _turnOwnerId: frame.clientMessageId ?? sess._activeClientMessageId }
      : {}),
  });
}

export function applyPermissionSettled(sess: ChatSession, frame: OutboundPermissionSettledWire): void {
  if (!acceptFrameSeq(sess, frame)) return;
  const msg = sess.messages.find((m) =>
    m.requestId === frame.requestId && !isImmutableTapeViewportRow(m));
  if (!msg) return;
  msg._resolved = true;
  msg._behavior = frame.behavior;
  msg._settledReason = frame.reason || null;
  if (frame.answers && typeof frame.answers === "object") msg._answers = frame.answers;
}

export { AUTO_CONTINUE_PROMPT };
