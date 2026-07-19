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
import type { MessageUsageDelegate, ReviewVerdict } from "@openclaude/protocol/teamCards";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import type { InboundMessage, MediaRef } from "./frames";

/** 用户消息状态机（派生展示，不持久化 'replied'，§9）。*/
export type UserMsgStatus = "sending" | "sent" | "queued" | "read" | "replied" | "error";

/**
 * 本轮非流式阶段状态（会话级软提示的单一权威判别联合，镜像 protocol OutboundTurnStatus）。
 *  - `'compacting'`：CCB 压缩上下文中（数十秒~数分钟无 stream），沿用字符串态不改。
 *  - `{ kind:'retrying' }`：自动重试等待中（模型繁忙/瞬态失败），`retryAt` = 下次尝试的
 *    绝对 epoch ms（断线重连后前端按它重算剩余倒计时，不从完整 delayMs 重头显示）。
 *  `null` = 回到普通流式 / 空闲态。**只驱动软提示 UX，不作业务完成信号**（业务完成走
 *  outbound.message isFinal）。retry 元数据只在 retrying 分支存在，不在其它态漂移。
 */
export type TurnStatusState =
  | "compacting"
  | { kind: "retrying"; attempt: number; max: number; retryAt: number };

/** 判别 `_turnStatus` 是否处于「自动重试中」态（供 reducer 内容帧自动消解 + 渲染层消费）。 */
export function isRetryingTurnStatus(
  s: TurnStatusState | null | undefined,
): s is { kind: "retrying"; attempt: number; max: number; retryAt: number } {
  return typeof s === "object" && s !== null && s.kind === "retrying";
}

/** A user turn's immutable model/team/reasoning selection, reused by retry. */
export type ChatRoutingSnapshot = {
  model?: string;
  teamMode?: boolean;
  effortLevel?: string | null;
};

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
  /** 本轮已免单（idle-timeout 无响应退款,cost_waived 帧置位）。*/
  waived?: boolean;
  /**
   * 债D per-delegate 成本明细(纯展示投影)。master 排空委派 pending 时按 agentId 分组
   * 求和,写进队长**助手行**;前端团队卡/委派卡按 `_delegateAgentId` 匹配显示「· N 积分」。
   * costCredits 为十进制大数字符串,与 `costCredits` 同单位/精度(禁 Number 化)。
   */
  delegates?: MessageUsageDelegate[];
};

/** Bash 实时 tail 快照（单调守卫：totalBytes 不回退）。*/
export type BashTail = { tail: string; totalBytes: number; truncatedHead: boolean };

/**
 * 生成占位卡的本地状态（需求 C）。imageEdit（编辑/评论/调整大小）提交时由
 * socket.sendMessage 注入一条**本地专属**行承载它：turn 生成期间在对话流内占位
 * （粒子特效框），结果图作为 assistant 消息自然渲染后由 reducer 按 `jobId` 消解，
 * turn error 时转 `failed`。**绝不持久化**（toStored 显式剥离），故重开会话不留孤儿卡。
 *  - `jobId` === 提交帧 imageEdit.clientJobId（消解/失败的关联键，单一权威）。
 *  - `aspect` = 目标宽高比：数字比值（编辑/评论用源图 width/height）或比例枚举字符串
 *    （调整大小用 targetAspect，如 "16:9"）；渲染据此定占位框比例。
 *  - `reason` = 失败友好文案（可选，契约外附加项，供 danger 卡展示原因）。
 *  - `afterUserMsgId` = 触发本占位的乐观 user 行 id（兜底消解锚点：REST 对账发现锚点行被
 *    server echo 且存在更晚 `_seq` 的 server-authored assistant 行 → 该轮已在服务端收尾,
 *    live 终帧丢失也能清占位。见 reducer.expireGenPlaceholdersAgainstServerRows）。
 */
export type GenPlaceholder = {
  jobId: string;
  aspect: number | string;
  status: "running" | "failed";
  startedAt: number;
  reason?: string;
  afterUserMsgId?: string;
};

/**
 * 子 agent 块（agent-group 卡 childBlocks 项）。扁平化最多两层展示。
 * 形态对齐现网 _appendSubagentBlock 写入。
 */
export type ChildBlock = {
  kind:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "tool_output_tail"
    | "plan"
    | "goal"
    | "error"
    | "final";
  blockId?: string;
  text?: string;
  toolName?: string;
  toolUseBlockId?: string;
  inputPreview?: string;
  inputJson?: unknown;
  partialJson?: string;
  preview?: string;
  isError?: boolean;
  _partial?: boolean;
  _completed?: boolean;
  output?: string;
  outputJson?: unknown;
  error?: boolean;
  bashTail?: BashTail;
  tail?: string;
  totalBytes?: number;
  truncatedHead?: boolean;
  explanation?: string;
  steps?: Array<{ step: string; status: string }>;
  objective?: string;
  status?: string;
  meta?: unknown;
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
    | "runtime-event"
    | "system";
  /** 文本内容（user 输入 / assistant 文本 / thinking 文本 / tool 名 / goal objective / plan 摘要…）。*/
  text: string;
  /** 创建时间（client mint）。*/
  ts: number;
  /** turn 结束/最后内容到达时刻。*/
  completedAt?: number;
  /**
   * 行的产出来源。`'server'` = 后端 server-authored 行(getSession/listSessions 带回的
   * durable 快照,id 形如 `srv-*`);缺省/`'local'` = 本设备 reducer 就地产出的行。
   * 团队卡去重按此区分:server-authored agent-group 是跨设备团队结构+终态骨架(无 childBlocks
   * 过程树),本地富卡(m-*)同 runId 存在时 local-wins。判定统一走 isServerAuthoredRow()。
   */
  _source?: "server" | "local";
  /**
   * server 权威内容版本游标。内容 patch 会换号；仅用于 getSession `_seq > since` 增量同步，
   * 不参与展示顺序。
   */
  _seq?: number;
  /** 首次持久化即冻结的历史顺序轴。展示、turn 分组、spill/归档分页均以它为权威；
   * 本地乐观行在 server echo 前缺省，由排序器锚到最近的耐久行。 */
  _orderSeq?: number;
  /** Exact persisted user row that owns this turn. Server-authored rows get
   * this from the immutable lossless tape; local fallback m-* output rows are
   * tagged while streaming so final sync can replace only the right turn. */
  _clientMessageId?: string;
  /**
   * Browser-owned process-card turn identity. Unlike `_clientMessageId`
   * (generated/server turn output), this field is only for local
   * agent-group/delegate-progress/permission rows so history repair can keep
   * them before the exact turn terminal after reload/reconciliation.
   */
  _turnOwnerId?: string;
  /** Master-authored exact logical turn key used for targeted billing updates. */
  _turnKey?: string;
  // ── user ──
  status?: UserMsgStatus;
  _media?: MediaRef[];
  /** Full local retry payload; hidden source/mask never enter cloud user-message persistence. */
  _retryMedia?: MediaRef[];
  _imageEdit?: NonNullable<InboundMessage["content"]>["imageEdit"];
  /** 含附件的完整模型可见文本（regen 用）。*/
  _modelText?: string;
  /** 首发时的路由快照；重试旧消息时不能被后续 turn 的选择覆盖。*/
  _routing?: ChatRoutingSnapshot;
  /** Stable logical-send attempt. Reconnect/offline replay keeps the current
   * value; only an explicit user click on Retry increments it. */
  _sendAttempt?: number;
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
  /**
   * durable turn dispatch server 侧持久化标记:该行证明其 _clientMessageId 的
   * dispatch 已终态失败。`_turnStatusRecord` 表示它是状态记录、不是 Agent 输出。
   */
  _dispatchLost?: boolean;
  _dispatchTerminal?: boolean;
  _turnStatusRecord?: boolean;

  // ── lossless turn tape 水合标记（v2 tape;server-authored 行携带，前端只读）──
  /** 该行所属的 lossless turn tape id（tape 是一个原子同步单元）。 */
  _turnTapeId?: string;
  /** hydration 的 complete-anchor 分支盖章：该 tape 已完整原子落库（同步权威传播的作证前提）。 */
  _turnTapeComplete?: boolean;
  /** 该行在同一 lossless turn tape 内的持久 record ordinal。多个展开行共享 `_orderSeq`，
   *  其内部顺序必须以本字段为准，不能依赖会回拨/碰撞的 wall-clock `ts`。 */
  _turnTapeOrdinal?: number;
  /** tape 内容 sha256。§9 折叠行展开的三元组定位键之一（(_turnTapeId, _turnTapeSha256, anchor id)）。 */
  _turnTapeSha256?: string;
  /** Exact runtime envelope persisted by the gateway. */
  _runtimeEvent?: unknown;
  _runtimeSource?: string;
  _ocEventOrdinal?: number;
  /** Exact ordered structured events folded into a single readable plan/goal card. */
  _eventHistory?: unknown[];

  // ── 真实 turn tape 的惰性过程入口（server 铸控制标记，前端只读）──
  /**
   * 过程控制行只负责记录页游标。最终 assistant 正文始终来自 immutable tape 并立即显示；
   * 思考、工具与运行事件由用户展开后按物理 ordinal 分页读取。
   */
  _turnTapeProcess?: boolean;
  /** 该轮不可变记录总字节数，仅作辅助信息，不替代任何正文。 */
  _turnTapeTotalBytes?: number;
  /** 该轮待惰性读取的真实过程记录数。 */
  _turnTapeProcessCount?: number;
  /** 折叠行：dispatch 终态（completed|interrupted|crashed|executed_error|not_accepted）。终态存在证据判据。 */
  _dispatchOutcome?: string;
  /** 记录在 immutable tape 内的物理 ordinal。 */
  _recordOrdinal?: number;

  /** 超大物理记录尚未取 payload；这是加载状态，不是内容替身。 */
  _payloadDeferred?: boolean;
  _payloadBytes?: number;
  _payloadSha256?: string;

  // ── 过程控制的本地展开态（仅会话内存，不写回 server）──
  /** 已开始显示真实 Agent 过程。 */
  _turnTapeProcessExpanded?: boolean;
  /** 已加载记录所属的过程控制键。 */
  _turnTapeProcessLoadedFrom?: string;
  /** 下一页物理 ordinal；null=已读完。 */
  _turnTapeProcessCursor?: number | null;

  /** 空轮 notice 标记。*/
  _emptyTurn?: boolean;
  _emptyTurnSoft?: boolean;
  _emptyTurnStopReason?: string | null;
  _emptyTurnTimeout?: boolean;
  _emptyTurnTargetMsgId?: string | null;
  /** cron/task 推送标记。*/
  cronPush?: boolean;
  cronLabel?: string;

  // ── 生成占位卡（需求 C，本地专属行；toStored 剥离、不进 server 历史）──
  /**
   * imageEdit 提交后的生成占位状态。携带此字段的行由 socket.sendMessage 注入（role
   * 取 'system' 客户端域），MessageList 拦截渲染 GeneratingPlaceholderCard；reducer 在
   * 该会话 turn final 时按 jobId 消解、turn error 时转 failed。见 GenPlaceholder。
   */
  _genPlaceholder?: GenPlaceholder;

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
  /** Exact structured tool result before any text-oriented rendering. */
  outputJson?: unknown;
  error?: boolean;
  bashTail?: BashTail;

  // ── agent-group ──
  startTime?: number;
  childBlocks?: ChildBlock[];
  _delegate?: boolean;
  _delegateAgentId?: string;
  _delegateGoal?: string;
  _agentGroupOrigin?: string;
  _teamFallback?: boolean;
  /** agent-group ↔ delegate-progress run 绑定键（双向 adopt，§7）。*/
  _delegateRunId?: string;
  _duration?: number;
  _resultPreview?: string;
  _isError?: boolean;
  /**
   * 终态三态(server-authored 行权威):'ok' 完成 / 'failed' 失败 / 'timeout' 超时。
   * 本地富卡只有 _isError 两态,server 骨架行额外区分超时。渲染徽记 & 团队面板计数按此。
   * 缺省时回退 _isError('failed' 语义)。
   */
  _delegateStatus?: "ok" | "failed" | "timeout";
  /**
   * 债C — 隐藏审查员委派行的结构化审查裁决(PASS / NEEDS_FIX)。仅
   * `_delegateAgentId === 'hidden-reviewer'` 的行携带;普通成员委派行缺省。
   * 与 `_delegateStatus`(执行态)**正交**:一次成功执行的审查照样可裁决 NEEDS_FIX,
   * 故 PASS/未通过必须读本字段,禁止从执行态反推。渲染裁决徽记(reviewVerdictBadge)按此。
   */
  _reviewVerdict?: ReviewVerdict;

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
  platformGoalId?: string;
  platformStateRevision?: number;

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
  /** Server-authoritative session goal. Kept out of IndexedDB; active-session
   * REST/WS snapshots repopulate it after every load. */
  goalState?: GoalStateSnapshot | null;

  /** 最近一次用户发送的路由字段快照(model/teamMode/effortLevel)。合成续写
   *  (服务重启自动续写/空轮续写)必须复用——否则桥按默认模型分类,不做 codex
   *  改写(无 server requestId/无 preCheck),暖 codex 会话续写被计费闸 fail-closed
   *  拒绝(2026-07-07 boss 团队模式"一直无响应"事故:CODEX_BILLING_GUARD)。 */
  _lastRouting?: ChatRoutingSnapshot;
  /** 会话级模型选择(用户在该会话显式选择/首发时定格的模型;per-session 持久化,
   *  IndexedDB + 服务端 client_sessions.model_id 双落点)。**与 _lastRouting 分责**:
   *  _lastRouting 是"最近实际发送"的路由快照(合成续写/计费分类复用,只在发送时写),
   *  本字段是"用户选择"(切会话恢复选择器用,选择即写,未发送也生效)。恢复时须经
   *  resolveSessionModel 校验仍可见且健康,否则回落 default_model。 */
  _selectedModelId?: string;
  // ── frameSeq 去重游标（§3）──
  _lastFrameSeqByKey?: Record<string, number>;
  _lastFrameSeq?: number;
  /** server canonical 增量游标（历史加载 getSession 的 sinceSeq；随 StoredSession 落地）。*/
  _maxSeq?: number;
  /** Server history revision paired with `_maxSeq`; persisted across reload. */
  _historyRevision?: number;
  /** 已应用 full 载荷的 SessionDetail.updatedAt 水位:同步权威传播(P1 缺席删除)的版本护栏,
   *  只允许 updatedAt ≥ 此值的 full 执行缺席删除。仅进程内存,不随 StoredSession 落地
   *  (重开会话从 0 起,首个 full 天然可授权;护栏防的是同进程内两条 REST 的乱序竞态)。*/
  _lastServerSyncUpdatedAt?: number;
  /** 归档 `_orderSeq` 水位(字段名保留兼容);full 合并与归档分页共用。*/
  _archivedThroughSeq?: number;
  /** 已归档消息条数(会话总数 = tail + 此值)。UI"还有 N 条"与"从云端加载更早历史"按钮据此。*/
  _archivedCount?: number;

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
  /**
   * server 时钟域的 tracker reset 截止戳 = reset 时刻已见过的最大 frame.ts。stale 判定
   * 优先用它与 frame.ts **同域比较**（frame.ts ≤ 此值 → 帧发出不晚于 reset 前所见 → stale），
   * 消掉「客户端时钟快于 server → 整轮新帧被 _trackerResetAt 跨域比较误杀」一类风险；
   * _trackerResetAt（客户端钟）仅在从未见过 server ts 时作回退。
   */
  _trackerResetServerTs?: number;
  /** 迄今所见最大 server frame.ts（运行期跟踪 + 持久化,供 reset 时定格 server 域截止）。*/
  _lastServerTs?: number;
  /** 本地 stop/timeout/switch/error 后的非 final 截止戳；防 late frame 在 reload 后复活发送态。*/
  _localTeardownAt?: number;
  _agentSwitchedAt?: number | null;
  _turnStartedAt?: number | null;
  _lastFrameAt?: number;
  _turnStatus?: TurnStatusState | null;
  /** User-row id of the turn currently streaming in this browser. */
  _activeClientMessageId?: string;
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
  if (
    sess._activeClientMessageId &&
    (role === "assistant" || role === "thinking" || role === "tool") &&
    msg._source !== "server"
  ) {
    // 本地新建的**生成内容行**一律盖当前活跃轮的 clientMessageId——无论 id 是 m-* fallback
    // 还是直接采用引擎 messageId(v7 起主 agent live text/thinking/tool 带 srv-* messageId,
    // 见 reducer.findOrCreateStreamingRow)。旧代码只盖 m-* 行,导致采用引擎 messageId 的本地
    // 行拿不到 _clientMessageId → turn finalize 后 server 展开成 srv-*-s{idx} 分段行(id 不同,
    // server-wins 按 id 漏)、完成证据去重又只认 m-*(漏)→ 与 server 副本并存重复渲染。
    // 权威守卫仍是 _source:'server'(server-authored 行绝不在此被本地 clientMessageId 污染);
    // 不给 user/system/agent-group/goal/delegate-progress 等 client-owned 行盖。
    msg._clientMessageId ??= sess._activeClientMessageId;
  }
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
  // server 域截止定格:此后凡 frame.ts ≤ 该值的帧都视为 stale(同域比较,见字段注释)。
  if (typeof sess._lastServerTs === "number") sess._trackerResetServerTs = sess._lastServerTs;
}

/** 每见一帧带 server ts 就推进(max);reset 时定格进 _trackerResetServerTs。*/
export function trackServerTs(sess: ChatSession, ts: unknown): void {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return;
  if (typeof sess._lastServerTs !== "number" || ts > sess._lastServerTs) sess._lastServerTs = ts;
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

/**
 * 该行是否为后端 server-authored 行(债A 团队卡跨设备骨架)。判定:显式 `_source === 'server'`
 * 优先;回退到 canonical id 前缀 `srv-`(server 重写/持久化行的既有命名惯例,见 persist.ts docstring)。
 *
 * ⚠️ **硬约束(B7):`srv-` 前缀兜底仅限 agent-group / 团队卡语义**(团队卡去重、live progress
 * 绑定守卫),用途是「server 骨架行永不接收 live childBlocks / 永不吞本地富卡」。
 * **严禁**用本函数判定 assistant / thinking / tool 生成内容行的权威归属:v7 起主 agent 的
 * live text/thinking/tool 直接采用引擎 messageId(形如 `srv-<peer>-<agent>-tN`),它们是 reducer
 * **本地铸的乐观行**(无 `_source`)却带 `srv-` 前缀 → 本函数会因前缀兜底把它们**误判成
 * server-authored**(参见 persist.ts `isSupersededLocalTurnRow` 为此显式改用 `_source` 的整段说明)。
 * **新调用一律走 `_source === 'server'`**;`srv-` 兜底只为不能改的 v7 legacy 团队卡路径保留。
 */
export function isServerAuthoredRow(
  m: Pick<ChatMessage, "id" | "_source"> | null | undefined,
): boolean {
  if (!m) return false;
  if (m._source === "server") return true;
  return typeof m.id === "string" && m.id.startsWith("srv-");
}

/**
 * agent-group 行的委派 run 标识(去重折叠键)。本地富卡写 `_delegateRunId`;server-authored
 * 行可能只带 `runId`(durable 载荷字段)——两者取其一,容忍后端契约命名(见报告待对齐点)。
 * 非 agent-group 行返回 undefined。
 */
export function agentGroupRunId(m: ChatMessage): string | undefined {
  if (m.role !== "agent-group") return undefined;
  const rid = m._delegateRunId || m.runId;
  return typeof rid === "string" && rid.length > 0 ? rid : undefined;
}

/** Monotonic merge for REST/WS goal snapshots. State changes are ordered by
 * stateRevision; usage/engine refreshes by snapshotRevision. Equal revisions
 * may still carry a later active-runtime sample, but no usage counter may
 * move backwards. A stale `null` GET never erases an observed goal. */
export function shouldApplyGoalSnapshot(
  current: GoalStateSnapshot | null | undefined,
  incoming: GoalStateSnapshot | null,
): boolean {
  if (!incoming) return !current;
  if (!current) return true;
  if (incoming.goalId !== current.goalId) {
    return incoming.stateRevision > current.stateRevision;
  }
  if (incoming.stateRevision !== current.stateRevision) {
    return incoming.stateRevision > current.stateRevision;
  }
  if (incoming.snapshotRevision !== current.snapshotRevision) {
    return incoming.snapshotRevision > current.snapshotRevision;
  }
  let creditsMonotonic = false;
  try {
    creditsMonotonic = BigInt(incoming.creditsUsed) >= BigInt(current.creditsUsed);
  } catch {
    return false;
  }
  return (
    incoming.tokensUsed >= current.tokensUsed &&
    incoming.timeUsedSeconds >= current.timeUsedSeconds &&
    creditsMonotonic
  );
}
