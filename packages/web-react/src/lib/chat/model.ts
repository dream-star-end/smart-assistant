/**
 * v5 对话**数据模型**——ChatSession / ChatMessage 的就地可变结构，以及最薄的
 * mutation 原语（addMessage / updateMessage）。
 *
 * 这是 reducer 产出、P5 渲染层消费的**消息对象契约**。形态严格对齐现网 vanilla
 * 的 message 行字段（addMessage extra 字段 + handleOutbound 各 block 分支写入的字段），
 * 这样 P5 的九类卡片渲染器能直接按 role 分派，无需二次适配。
 *
 * 重要：reducer 对 `session.messages` **就地 mutation**（push / 改字段），不每帧
 * 重建数组（streaming delta 频率极高）。订阅侧靠 `version` 单调递增触发重渲。
 */
import type { MediaRef } from "./frames";

/** 用户消息状态机（派生展示，不持久化 'replied'，§9）。*/
export type UserMsgStatus = "sending" | "sent" | "queued" | "read" | "replied" | "error";

/** Plan 卡步骤（frames.ts plan.steps）。*/
export type PlanStep = { step: string; status: "pending" | "inProgress" | "completed" };

/** delegate-progress 兜底卡的轻量进度条目（旧 gateway 降级帧）。*/
export type DelegateEntry = {
  phase: string;
  text: string;
  toolName?: string;
  isError?: boolean;
  ts: number;
};

/** turn 计费/用量（formatMeta 渲染源）。大数字段为字符串，勿数值化。*/
export type MsgUsage = {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCost?: number;
  turn?: number;
  stopReason?: string;
  /** 响应底部 “请求ID” live 源（= master per-turn canonical traceId）。*/
  traceId?: string;
  /** 真实扣费积分（字符串大数）。*/
  costCredits?: string;
};

/** Bash 实时 tail 快照（单调守卫：totalBytes 不回退）。*/
export type BashTail = { tail: string; totalBytes: number; truncatedHead: boolean };

/**
 * 子 agent 块（agent-group 卡 childBlocks 项）。扁平化最多两层展示。
 * 形态对齐现网 _appendSubagentBlock 写入。
 */
export type ChildBlock = {
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "tool_output_tail";
  blockId?: string;
  text?: string;
  toolName?: string;
  inputPreview?: string;
  inputJson?: unknown;
  partialJson?: string;
  _partial?: boolean;
  _completed?: boolean;
  output?: string;
  error?: boolean;
  bashTail?: BashTail;
};

/**
 * 会话内一行消息。role 决定 P5 渲染分派；字段按 role 选填。
 * 这是一个**宽松联合**（与现网松散 message 对象对齐），P5 渲染器按 role narrow。
 */
export type ChatMessage = {
  id: string;
  role:
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "agent-group"
    | "plan"
    | "goal"
    | "permission"
    | "delegate-progress"
    | "system";
  /** 文本内容（user 输入 / assistant 文本 / thinking 文本 / tool 名 / goal objective / plan 摘要…）。*/
  text: string;
  /** 创建时间（client mint）。*/
  ts: number;
  /** turn 结束/最后内容到达时刻。*/
  completedAt?: number;

  // ── user ──
  status?: UserMsgStatus;
  _media?: MediaRef[];
  /** 含附件的完整模型可见文本（regen 用）。*/
  _modelText?: string;
  _isAutoRetry?: boolean;
  /** auto-continue 的确定性 idempotencyKey（dedup ack 对账）。*/
  _idem?: string;

  // ── assistant / 通用 ──
  usage?: MsgUsage;
  /** max_tokens / pause_turn 截断标记（渲染 “继续” 按钮）。*/
  _truncated?: string;
  /** error 红卡：归一化 code + 折叠区原始 detail。*/
  _errorCode?: string;
  _errorDetail?: string;
  /** 空轮 notice 标记。*/
  _emptyTurn?: boolean;
  _emptyTurnSoft?: boolean;
  _emptyTurnStopReason?: string | null;
  _emptyTurnTimeout?: boolean;
  _emptyTurnTargetMsgId?: string | null;
  /** cron/task 推送标记。*/
  cronPush?: boolean;
  cronLabel?: string;

  // ── tool / agent-group 共用 ──
  blockId?: string;
  toolName?: string;
  inputPreview?: string;
  inputJson?: unknown;
  /** 流式累加 partial JSON（final 后必 delete）。*/
  partialJson?: string;
  _partial?: boolean;
  _partialRafPending?: boolean;
  _completed?: boolean;
  output?: string | null;
  error?: boolean;
  bashTail?: BashTail;

  // ── agent-group ──
  startTime?: number;
  childBlocks?: ChildBlock[];
  _delegate?: boolean;
  _delegateAgentId?: string;
  _delegateGoal?: string;
  /** agent-group ↔ delegate-progress run 绑定键（双向 adopt，§7）。*/
  _delegateRunId?: string;
  _duration?: number;
  _resultPreview?: string;
  _isError?: boolean;

  // ── delegate-progress（委派进度兜底卡）──
  runId?: string;
  agentId?: string;
  /** start 帧原始 goal（供 agent-group 后绑 adopt）。*/
  goal?: string;
  /** 旧 gateway 降级帧的进度条目。*/
  entries?: DelegateEntry[];
  /** done/error 帧的结果摘要。*/
  summary?: string;
  /** 已被某 agent-group adopt（待移除）。*/
  _adoptedInto?: string;

  // ── plan ──
  explanation?: string;
  steps?: PlanStep[];

  // ── goal ──
  goalStatus?: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt?: number;
  cleared?: boolean;

  // ── permission ──
  requestId?: string;
  _resolved?: boolean;
  _behavior?: "allow" | "deny";
  _settledReason?: string | null;
  _answers?: Record<string, string>;
};

/**
 * 一个对话会话的完整运行期状态。下划线字段是消费侧不变量的私有状态
 * （游标 / 流式指针 / 守卫时间戳），随 session 序列化进 IndexedDB（断点续传）。
 */
export type ChatSession = {
  id: string;
  agentId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastAt: number;
  updatedAt?: number;

  // ── frameSeq 去重游标（§3）──
  _lastFrameSeqByKey?: Record<string, number>;
  _lastFrameSeq?: number;

  // ── turn 流式指针（就地 mutation 目标）──
  _streamingAssistant?: ChatMessage | null;
  _streamingThinking?: ChatMessage | null;
  _blockIdToMsgId?: Map<string, string>;
  _agentGroups?: Map<string, string>;
  /** delegate run → agent-group msg id（运行期，不持久化；refresh 后从 _delegateRunId 自愈）。*/
  _delegateRunGroups?: Map<string, string>;

  // ── turn 状态 ──
  _sendingInFlight?: boolean;
  _replyingToMsgId?: string | null;
  _currentTurnAnswerCount?: number;
  _trackerResetAt?: number;
  _agentSwitchedAt?: number | null;
  _turnStartedAt?: number | null;
  _lastFrameAt?: number;
  _turnStatus?: string | null;
  _isFirstTurnAfterReady?: boolean;
  _liveStreamBroken?: boolean;

  // ── 双帧 error 抑制（§11）──
  _suppressErrorBubbleAtSeq?: number;

  // ── 计费归因（§7 isFinal drain）──
  _pendingCostCredits?: string;
  _lastFinaledAssistantId?: string | null;
  _lastFinaledAt?: number;
  _tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

  // ── 节流渲染 rAF 标记（render 层用）──
  _streamRafPending?: boolean;
  _thinkRafPending?: boolean;
};

let _idSeq = 0;
/** 本地 mint message id（无 server canonical id 时的 fallback，§9）。*/
export function mintMsgId(): string {
  _idSeq = (_idSeq + 1) % 1_000_000;
  return `m-${Date.now().toString(36)}-${_idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createSession(input: {
  id: string;
  agentId: string;
  title?: string;
  createdAt?: number;
}): ChatSession {
  const now = Date.now();
  return {
    id: input.id,
    agentId: input.agentId,
    title: input.title || "新对话",
    messages: [],
    createdAt: input.createdAt ?? now,
    lastAt: now,
    _lastFrameSeqByKey: {},
    _blockIdToMsgId: new Map(),
    _agentGroups: new Map(),
    _streamingAssistant: null,
    _streamingThinking: null,
    _pendingCostCredits: "0",
  };
}

/** 现网 addMessage 等价：mint id（或用 extra.id canonical）、push、设标题。*/
export function addMessage(
  sess: ChatSession,
  role: ChatMessage["role"],
  text: string,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  const msg: ChatMessage = Object.assign(
    { id: mintMsgId(), role, text: text || "", ts: Date.now() },
    extra || {},
  ) as ChatMessage;
  sess.messages.push(msg);
  sess.lastAt = Date.now();
  if (role === "user") {
    const userCount = sess.messages.filter((m) => m.role === "user").length;
    if (userCount === 1) {
      sess.title = (text || "").slice(0, 50) + ((text || "").length > 50 ? "…" : "");
    }
  }
  return msg;
}

export function updateMessageText(msg: ChatMessage, newText: string): void {
  msg.text = newText;
}

/** turn 收尾清理（isFinal / stop / stuck 共用）。*/
export function clearTurnTiming(sess: ChatSession): void {
  sess._turnStartedAt = null;
  sess._lastFrameAt = undefined;
  sess._isFirstTurnAfterReady = false;
  sess._turnStatus = null;
}

export function resetReplyTracker(sess: ChatSession): void {
  sess._replyingToMsgId = null;
  sess._currentTurnAnswerCount = 0;
  sess._trackerResetAt = Date.now();
}

export function markFrameReceived(sess: ChatSession): void {
  sess._lastFrameAt = Date.now();
}

/**
 * page-refresh / 加载历史 session 后从 messages 重建 _blockIdToMsgId 与
 * _agentGroups（含 nested Agent 子块），否则 subagent live 块会回退主流（§7）。
 */
export function rebuildIndexes(sess: ChatSession): void {
  if (!sess._blockIdToMsgId) sess._blockIdToMsgId = new Map();
  if (!sess._agentGroups) sess._agentGroups = new Map();
  for (const m of sess.messages) {
    if (m.blockId) sess._blockIdToMsgId.set(m.blockId, m.id);
    if (m.role === "agent-group" && m.blockId) {
      sess._agentGroups.set(m.blockId, m.id);
      if (Array.isArray(m.childBlocks)) {
        for (const ch of m.childBlocks) {
          if (ch && ch.kind === "tool_use" && ch.blockId && /^Agent$/i.test(ch.toolName || "")) {
            sess._agentGroups.set(ch.blockId, m.id);
          }
        }
      }
    }
  }
}
