/**
 * P5 渲染层**纯逻辑核心** —— 与 React 无关、可独立单测。
 *
 * 这里集中三类「会引发 UI bug 的隐性规则」，从组件里抽出来用 vitest 钉死：
 *  1. role → 渲染分派 kind（含平台同步的 goal 更新卡）。
 *  2. 单条消息 / 子块 **渲染签名**：reducer 对 message 做**就地 mutation**（同一对象
 *     引用、改字段），React.memo 默认浅比较会把"同引用"当"没变"而漏渲。这里产出一个
 *     仅捕获「影响渲染的字段」的字符串签名，作为 memo 比较键 —— 内容变才变、不变则
 *     稳定，从而复刻现网 vanilla 的 keyed-reconcile + per-child 签名防闪。
 *  3. 折叠态默认值（thinking 完成折叠 / agent-group 运行展开完成折叠），用户显式切换
 *     后由组件本地 state 锁定，不被签名重渲覆盖。
 */
import {
  isDisplayableServerMessage,
  normalizeTurnErrorCode,
  turnErrorSemantics,
  WAIVED_TURN_ERROR_CODES,
} from "@openclaude/protocol";
import { REVIEW_VERDICT_NEEDS_FIX, REVIEW_VERDICT_PASS } from "@openclaude/protocol/teamCards";
import { isServerAuthoredRow } from "./model";
import type { BashTail, ChatMessage, ChildBlock } from "./model";
import { friendlyBridgeErrorMessage } from "./pure";

/**
 * dispatch 终态错误码(免单语义:受理未执行 = 未计费 / 服务重启中断 = 已退款)。归一化小写。
 * 这些是 **server 权威的稳定协议码**:`dispatch_lost`/`dispatch_not_accepted` 由 reconciler 铸在
 * durable dispatch status 上;`service_restart` 由 gateway 写在**不可变 tape**(boot recovery synthetic
 * crashed)里 —— 不可变行无法回填 master 标记,故按稳定协议码识别(非脆弱的内部 failureCode 枚举)。
 */
export const DISPATCH_LOST_ERROR_CODES = new Set([
  "dispatch_lost",
  "dispatch_not_accepted",
  "service_restart",
]);

/** 归一化后是否命中 dispatch 终态错误码。 */
export function isDispatchLostCode(code: string | undefined | null): boolean {
  return typeof code === "string" && DISPATCH_LOST_ERROR_CODES.has(code.trim().toLowerCase());
}

/**
 * 该行是否证明其 turn 的 dispatch 已终态失败,需要重试铸新 clientMessageId。
 * server 持久标记 `_dispatchTerminal` 是直接状态读的权威；不可变 tape 的
 * service_restart 稳定协议码用于旧数据兼容。
 * 前端**不**再枚举内部 failureCode(codex_pre_forward_abandoned / ERR_FRAME_TOO_BIG …)——那些
 * 都被 ① 一网打尽。
 */
export function isDispatchTerminalRow(
  m: Pick<ChatMessage, "id" | "_dispatchTerminal" | "_errorCode"> | null | undefined,
): boolean {
  if (!m) return false;
  if (m._dispatchTerminal === true) return true;
  return isDispatchLostCode(m._errorCode);
}

/**
 * 收集已有真实 tape 内容的 turn。用于在 full-sync 到达前的极短竞态窗口里
 * 抑制过时的 verified failure 状态，避免「结果已显示 + 失败状态并存」。
 */
export function collectResolvedDispatchTurnIds(messages: readonly ChatMessage[]): Set<string> {
  const resolved = new Set<string>();
  for (const m of messages) {
    const cmid = m?._clientMessageId;
    if (typeof cmid !== "string" || cmid.length === 0) continue;
    if (m._turnStatusRecord) continue;
    if (isTurnTapeProcessControl(m)) {
      resolved.add(cmid);
      continue;
    }
    if (typeof m._errorCode === "string" && m._errorCode.length > 0) continue;
    if (
      isServerAuthoredRow(m) &&
      (m.role === "assistant" || m.role === "thinking" || m.role === "tool")
    ) {
      resolved.add(cmid);
    }
  }
  return resolved;
}

/** 该 verified status 是否应被同轮真实 tape 抑制。 */
export function isTurnStatusSuppressedByTape(
  m: Pick<ChatMessage, "_turnStatusRecord" | "_clientMessageId">,
  resolvedTurnIds: Set<string>,
): boolean {
  return (
    m._turnStatusRecord === true &&
    typeof m._clientMessageId === "string" &&
    resolvedTurnIds.has(m._clientMessageId)
  );
}

// ═══════════════ immutable turn tape lazy process controls ═══════════════

/** 该行是否为真实过程记录的惰性入口。 */
export function isTurnTapeProcessControl(m: Pick<ChatMessage, "_turnTapeProcess"> | null | undefined): boolean {
  return !!m && m._turnTapeProcess === true;
}

/**
 * 控制行/已加载行的精确定位三元组键。
 * tapeSha 缺省(server 未带)时以空串占位,anchor id 仍保证唯一。
 */
export function turnTapeProcessKey(
  m: Pick<ChatMessage, "id" | "_turnTapeId" | "_turnTapeSha256">,
): string {
  return `${m._turnTapeId ?? ""}::${m._turnTapeSha256 ?? ""}::${m.id}`;
}

/**
 * 过程控制的 `_dispatchOutcome` → 终态类别。
 *  - completed / interrupted → 'completed':该轮**有内容**(tape 存在,含被中断的部分产出)→ 清发送态、
 *    user 行置 replied、抑制同轮过时 dispatch status;
 *  - crashed / executed_error / not_accepted → 'error':终态但失败;
 *  - 其余/缺省 → null:非终态(不作终态存在证据,不清发送态)。
 */
export function collapsedAnchorTerminalKind(
  outcome: string | undefined | null,
): "completed" | "error" | null {
  switch ((outcome ?? "").trim().toLowerCase()) {
    case "completed":
    case "interrupted":
      return "completed";
    case "crashed":
    case "executed_error":
    case "not_accepted":
      return "error";
    default:
      return null;
  }
}

/**
 * 过程控制是否构成该轮终态存在证据。它不代表正文；正文始终是独立真实记录。
 * (评分卡/MetaRow 等需正文的门不由它触发;折叠行非"末条 assistant 正文",见 turnSegment)。
 */
export function isCollapsedAnchorTerminalEvidence(
  m: Pick<ChatMessage, "_turnTapeProcess" | "_dispatchOutcome"> | null | undefined,
): boolean {
  return isTurnTapeProcessControl(m) && collapsedAnchorTerminalKind(m?._dispatchOutcome) !== null;
}

/** 字节数 → 人类可读。 */
export function formatTapeBytes(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/**
 * 隐藏审查员(平台内置、管理 API 404 隐藏的系统 agent)的 agentId —— 单一权威。
 * 团队卡据此判定「该委派行是否为审查员行」(审查裁决徽记仅审查员行渲染),
 * agentNames.ts 的显示名映射(hidden-reviewer→质量审查员)也复用此常量做键。
 * 放在纯逻辑层:两处消费方(render 裁决守卫 + agentNames 显示名)从此不再各写字面量。
 */
export const HIDDEN_REVIEWER_AGENT_ID = "hidden-reviewer";

export type MessageKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "agent-group"
  | "plan"
  | "goal"
  | "permission"
  | "delegate-progress"
  | "system"
  | "unknown";

/**
 * role → 渲染分派 kind。
 * Unknown/future roles land in `unknown`, keeping rendering fail-safe.
 */
export function messageKind(m: Pick<ChatMessage, "role">): MessageKind {
  switch (m.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "tool":
    case "agent-group":
    case "plan":
    case "goal":
    case "permission":
    case "delegate-progress":
    case "system":
      return m.role;
    default:
      return "unknown";
  }
}

/**
 * Low-level engine transport envelopes are not Agent-authored timeline blocks.
 * The same immutable tape already contains the canonical thinking/tool/plan/
 * delegate/assistant records produced while parsing these envelopes. Rendering
 * both copies turns one short answer into hundreds of generic raw-event cards
 * and can push the real final answer out of the viewport.
 *
 * This is presentation-only: no tape bytes are deleted or rewritten. Unknown
 * future Agent roles remain exact fallback records, while every runtime-event
 * stays an audit/transport row rather than a conversation card. Runtime batches
 * contain only runtime-event rows; standalone Bash output tails are reconciled
 * into their owning Bash tool card while the exact envelope remains in memory
 * and in the immutable tape.
 */
export function isCcbBashOutputTailEnvelope(message: ChatMessage): boolean {
  if (
    message.role !== "runtime-event" ||
    message._runtimeSource !== "ccb" ||
    message._turnTapeProcess ||
    message._turnStatusRecord
  ) return false;
  const event = message._runtimeEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const raw = event as Record<string, unknown>;
  return raw.type === "system" && raw.subtype === "bash_output_tail";
}

export function isRedundantRuntimeEnvelope(message: ChatMessage): boolean {
  if (
    message.role !== "runtime-event" ||
    message._turnTapeProcess ||
    message._turnStatusRecord
  ) return false;

  if (message._runtimeSource === "codex-jsonrpc") return true;
  if (message._runtimeSource !== "ccb") return false;

  if (isCcbBashOutputTailEnvelope(message)) return true;

  const event = message._runtimeEvent;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const raw = event as Record<string, unknown>;
  if (["stream_event", "assistant", "user", "result"].includes(String(raw.type))) {
    return true;
  }
  return raw.type === "system" && (raw.subtype === "init" || raw.subtype === "status");
}

/** 文本采样：长度 + 尾 16 字符。就地 append（长度单调增）下，长度即可探测增量；
 *  尾采样兜住"等长替换"这类非 append 编辑（现网 audit 提过的边角）。 */
function textSig(t: string | undefined): string {
  if (!t) return "0";
  return `${t.length}:${t.slice(-16)}`;
}

/** Bash tail 是 replace 快照；相同 totalBytes 也可能带来新的正文/截断态。 */
function bashTailSig(tail: BashTail | undefined): string {
  return tail
    ? `${tail.totalBytes}:${tail.truncatedHead ? 1 : 0}:${tail.tail}`
    : "";
}

/** 子块（agent-group childBlocks 项）渲染签名。per-child 比较的最小充分集。 */
export function childSignature(ch: ChildBlock): string {
  const raw = ch as ChildBlock & { error?: unknown };
  return [
    ch.kind,
    ch.blockId ?? "",
    textSig(ch.text),
    ch.toolName ?? "",
    ch._partial ? 1 : 0,
    ch._completed ? 1 : 0,
    textSig(ch.output),
    textSig(ch.preview),
    textSig(ch.tail),
    typeof raw.error === "string" ? textSig(raw.error) : raw.error ? 1 : 0,
    ch.partialJson ? ch.partialJson.length : 0,
    ch._inputRevision ?? 0,
    bashTailSig(ch.bashTail),
    ch.explanation ? textSig(ch.explanation) : "",
    ch.objective ? textSig(ch.objective) : "",
    ch.steps?.map((step) => `${step.status}:${textSig(step.step)}`).join(",") ?? "",
  ].join("|");
}

function childBlocksSignature(message: ChatMessage): string {
  const blocks = message.childBlocks ?? [];
  // Finalized tape payloads are immutable and already hash-addressed. Avoid
  // walking tens of thousands of children on every unrelated UI render; the
  // children are still all present and are progressively mounted by the card.
  if (message._turnTapeComplete && message._turnTapeSha256) {
    return `tape:${message._turnTapeSha256}:${blocks.length}:${message._runtimeBashTailRevision ?? 0}`;
  }
  return blocks.map(childSignature).join(";");
}

/**
 * 单条消息渲染签名。捕获该 role 渲染所读的全部「会变」字段 + 外部上下文（isLast /
 * sending，决定流式光标 / typing / 动作条可见性）。**不含折叠态**（折叠是组件本地
 * state，自身触发重渲，无需进签名）。
 */
export function messageSignature(
  m: ChatMessage,
  ctx: { isLast: boolean; sending: boolean; turnFinalAssistant?: boolean },
): string {
  // turnFinalAssistant：该行是否为「所在轮末条 assistant 正文」(评价反馈行唯一可见位)。它是
  // **随列表增长而翻转**的外部渲染上下文——后续追加(工具卡/新一段文本/新一轮)会把原末条挤成
  // 非末条,而该行自身字段未变(reducer 就地 mutate 同引用)。必须与 isLast 同放 sig head,否则
  // memo 浅比较判「无变化」漏渲、旧行评价残留。非 assistant 行恒 false(与 isLast 一样对全 role
  // 落进 head,不影响非消费方——只 AssistantCard 读它)。
  // Process control 由 MessageRenderer 拦截渲染 TurnProcessCard(不走 role 分派):其重渲触发字段
  // (_turnTapeProcessExpanded / _turnTapeProcessCursor / _turnTapeTotalBytes / _dispatchOutcome)不在下方 role 分支里,
  // 折进 head 保证展开态翻转、续拉游标变化时穿透 memo 重渲。非折叠行恒空片段,不影响既有签名。
  const collapse = m._turnTapeProcess
    ? `|tc:${m._turnTapeProcessExpanded ? 1 : 0}:${m._turnTapeProcessCursor ?? "n"}:${m._turnTapeTotalBytes ?? 0}:${m._dispatchOutcome ?? ""}`
    : "";
  const head = `${m.role}|${m.id}|${ctx.isLast ? 1 : 0}|${ctx.sending ? 1 : 0}|${m.completedAt ?? 0}|${ctx.turnFinalAssistant ? 1 : 0}${collapse}`;
  switch (m.role) {
    case "assistant":
      return [
        head,
        textSig(m.text),
        m.usage?.traceId ?? "",
        m.usage?.costCredits ?? "",
        m.usage?.waived ? 1 : 0,
        m._truncated ?? "",
        m._errorCode ?? "",
        m._errorDetail ? m._errorDetail.length : 0,
        m._emptyTurn ? 1 : 0,
        m._emptyTurnSoft ? 1 : 0,
        m._emptyTurnTimeout ? 1 : 0,
        m.cronPush ? `cron:${m.cronLabel ?? ""}` : "",
      ].join("|");
    case "user":
      return [
        head,
        textSig(m.text),
        m.status ?? "",
        (m._media?.length ?? 0),
        m._replyTo
          ? `${m._replyTo.messageId}:${m._replyTo.role}:${textSig(m._replyTo.text)}`
          : "",
        m._userPayloadDeferred ? 1 : 0,
        m._userPayloadId ?? "",
        m._payloadSha256 ?? "",
      ].join("|");
    case "thinking":
      return [head, textSig(m.text)].join("|");
    case "tool":
      return [
        head,
        m.toolName ?? "",
        m._partial ? 1 : 0,
        m._completed ? 1 : 0,
        m.output ? m.output.length : 0,
        m.error ? 1 : 0,
        m.partialJson ? m.partialJson.length : 0,
        m.inputJson ? 1 : 0,
        m._inputRevision ?? 0,
        m.inputPreview ? m.inputPreview.length : 0,
        bashTailSig(m.bashTail),
      ].join("|");
    case "plan":
      return [
        head,
        textSig(m.text),
        m.explanation ? m.explanation.length : 0,
        (m.steps ?? []).map((s) => `${s.status}:${s.step.length}`).join(","),
        m._partial ? 1 : 0,
      ].join("|");
    case "goal":
      return [
        head,
        textSig(m.text),
        m.goalStatus ?? "",
        m.tokenBudget ?? "",
        m.tokensUsed ?? 0,
        m.timeUsedSeconds ?? 0,
        m.updatedAt ?? 0,
        m.cleared ? 1 : 0,
        m.platformGoalId ?? "",
        m.platformStateRevision ?? 0,
      ].join("|");
    case "permission":
      return [
        head,
        m.toolName ?? "",
        m.requestId ?? "",
        m._resolved ? 1 : 0,
        m._behavior ?? "",
        m._settledReason ?? "",
        m._answers ? Object.keys(m._answers).join(",") : "",
        m.inputJson ? 1 : 0,
      ].join("|");
    case "agent-group":
      return [
        head,
        textSig(m.text),
        // 委派队员标识/目标也是显示字段（AgentGroupCard 头 + TeamPanel 队员行读它们）：
        // reducer 就地 mutate，若后到/修正而签名漏掉，memo 会跳过重渲，名字/任务卡在旧值。
        // 用完整字符串而非 textSig（尾采样）—— goal 可能是较长任务描述，「只改前缀、后缀同长」
        // 会让尾采样碰撞导致漏渲；这俩字段短、逐字符比较成本可忽略。
        m._delegateAgentId ?? "",
        m._delegateGoal ?? "",
        m._agentGroupOrigin ?? "",
        m._teamFallback ? 1 : 0,
        m._completed ? 1 : 0,
        m._isError ? 1 : 0,
        // 终态三态(server 行区分超时):变则徽记要重渲。
        m._delegateStatus ?? "",
        // 审查裁决(仅审查员行携带):与执行态正交,可能在委派完成后才到达,
        // 漏进签名 → memo 跳过 → PASS/未通过徽记不出现。
        m._reviewVerdict ?? "",
        m._duration ?? 0,
        m._resultPreview ? m._resultPreview.length : 0,
        m._delegate ? 1 : 0,
        childBlocksSignature(m),
      ].join("|");
    case "delegate-progress":
      return [
        head,
        textSig(m.text),
        m._completed ? 1 : 0,
        m._isError ? 1 : 0,
        m.summary ? m.summary.length : 0,
        (m.entries ?? []).length,
        m.entries?.length ? m.entries[m.entries.length - 1].phase : "",
        // P5 fix(Codex):reducer 把 legacy 降级帧的流式文本 append 到同一 entry.text(entries
        // 数量/phase 不变),签名必须含 entries 文本量,否则 delegate-progress 流式文本卡住不刷。
        (m.entries ?? []).reduce((n, e) => n + (e.text ? e.text.length : 0), 0),
        childBlocksSignature(m),
        m._adoptedInto ?? "",
      ].join("|");
    default:
      return [head, textSig(m.text)].join("|");
  }
}

/**
 * agent-group / 团队队员的**终态徽记**(单一权威,AgentGroupCard 与 TeamPanel 共用)。
 * 三态优先看 server-authored 行的 `_delegateStatus`(区分超时),缺省回退本地富卡的 `_isError`
 * 两态。仅在非运行态(已完成 / server 骨架)使用——运行态由调用方单独渲染"运行中"。
 */
export function agentTerminalStatus(
  m: Pick<ChatMessage, "_isError" | "_delegateStatus">,
): { label: string; tone: "success" | "danger" | "warning" } {
  if (m._delegateStatus === "timeout") return { label: "超时", tone: "warning" };
  if (m._isError || m._delegateStatus === "failed") return { label: "失败", tone: "danger" };
  return { label: "完成", tone: "success" };
}

/**
 * 隐藏审查员委派行的**质量审查裁决徽记**(单一权威,AgentGroupCard 与 TeamPanel 共用)。
 * 仅 `_delegateAgentId === 'hidden-reviewer'` 的行渲染;普通成员委派行(protocol 契约上
 * 不携带 `_reviewVerdict`)恒返回 null。
 *
 * ⚠️ 裁决(`_reviewVerdict`)与执行态(`_delegateStatus` ok/failed/timeout)**正交**:
 * 一次成功执行(status='ok')的审查照样可裁决 NEEDS_FIX。因此 PASS/未通过必须读
 * `_reviewVerdict`,禁止从执行态反推。裁决缺省(审查未产出/降级)→ null(执行态徽记照常)。
 *
 * tone 语义:PASS→success(通过态);NEEDS_FIX→warning(需修改的负向裁决,不用 danger 以
 * 免与「执行失败」的红色徽记混淆——审查本身执行成功,只是内容需返工)。未知裁决值 fail-safe 返回 null。
 */
export function reviewVerdictBadge(
  m: Pick<ChatMessage, "_delegateAgentId" | "_reviewVerdict">,
): { label: string; tone: "success" | "warning" } | null {
  if (m._delegateAgentId !== HIDDEN_REVIEWER_AGENT_ID) return null;
  if (m._reviewVerdict === REVIEW_VERDICT_PASS) return { label: "PASS", tone: "success" };
  if (m._reviewVerdict === REVIEW_VERDICT_NEEDS_FIX) return { label: "未通过", tone: "warning" };
  return null;
}

/**
 * 一条 thinking/assistant/agent-group 是否处于"实时流式"态。
 * thinking/assistant：仅当它是末条且本轮 in-flight（后续 text/tool 块到达会把它挤下
 * 末位 → 自动转完成态）。agent-group：以 _completed 为准（与末位无关，可并行多个）。
 */
export function isLive(
  m: Pick<ChatMessage, "role" | "_completed">,
  ctx: { isLast: boolean; sending: boolean },
): boolean {
  if (m.role === "agent-group" || m.role === "delegate-progress") return !m._completed;
  return ctx.isLast && ctx.sending;
}

/**
 * 折叠态默认值（用户未显式切换前）。
 *  - agent-group：运行中展开（看实时进度）、完成折叠（收成一行摘要）。
 *  - thinking：实时展开（"思考中…"）、完成折叠（💭 收起）。
 * 用户点击表头后由组件本地 state 锁定，不再走本默认。
 */
export function defaultCollapsed(
  m: Pick<ChatMessage, "role" | "_completed">,
  ctx: { isLast: boolean; sending: boolean },
): boolean {
  if (m.role === "agent-group") return !!m._completed;
  if (m.role === "thinking") return !isLive(m, ctx);
  return false;
}

/** 截断续写的中性提示词（不绑定话题，避免触发模型重做总结）。现网同款。 */
export const CONTINUE_PROMPT =
  "请接着上一条回复被截断的位置继续完成，不要重复已写过的内容，直接续写。";

/**
 * 归一化错误码 → 用户可读中文**标题**表。**key 集合与 protocol TURN_ERROR_TAXONOMY 对齐**
 * (契约测试 turnErrorTaxonomy.contract 锁死每码有标题,防漂移);正文在 pure.ts
 * BRIDGE_ERROR_MESSAGES(同源同 key,另一权威)。标题=类别,「怎么办」在正文。未知码回退「出错了」。
 */
const ERROR_LABELS: Record<string, string> = {
  // ── 计费/配额 ──
  insufficient_credits: "积分余额不足",
  rate_limited: "请求过于频繁，请稍后再试",
  // ── 上游模型服务 ──
  model_capacity: "模型繁忙",
  upstream_failed: "模型服务暂时中断",
  upstream_timeout: "模型响应超时",
  network_error: "网络异常，请重试",
  context_too_long: "上下文超长，请精简或开新会话",
  bad_request: "请求无法处理",
  // ── 引擎/平台执行 ──
  engine_error: "任务执行失败",
  internal_error: "服务内部错误",
  auth_error: "认证状态异常",
  service_restart: "服务重启，本轮已中断",
  session_persist_unavailable: "消息暂未安全送达",
  stopped: "已停止本轮生成",
  user_cancelled: "已取消本轮",
  runner_crashed: "执行环境异常中断",
  // ── 免单类 ──
  model_authority_expired: "本轮已自动免单",
  liveness_timeout: "本轮已自动免单",
  idle_timeout: "本轮已自动免单",
  no_response: "本轮已自动免单",
  phantom_turn: "本轮已自动免单",
  turn_limit: "本轮已自动免单",
  // ── 模型权威 gate 拒帧(方案 §4 R3-m12)──
  model_config_changed_retry_turn: "模型配置已更新，请重发",
  model_not_available: "模型不可用",
  unresolved_agent_model: "未能确定模型",
  model_authority_unavailable: "模型服务暂时不可用",
  model_catalog_unavailable: "模型服务暂时不可用",
  unauthorized_model: "模型未开通",
  // ── 连接/环境 ──
  unauthorized: "登录已失效",
  maintenance: "服务维护中",
  conn_kicked: "连接已断开",
  container_outdated: "运行环境已更新，请刷新页面",
  err_container: "运行环境异常",
  err_container_timeout: "运行环境响应超时",
  err_internal: "服务内部错误",
  forbidden: "操作被拒绝",
  err_frame_too_big: "内容过大",
  bad_json: "数据格式异常",
  bad_sequence: "消息时序异常",
  unknown_control: "未知控制指令",
  // ── 媒体/子系统 ──
  image_upstream_rejected: "图片生成被拒绝",
  image_server_busy: "图片服务繁忙",
  voice_upstream_error: "语音识别失败",
  voice_timeout: "语音识别超时",
  // ── 遗留兼容 ──
  codex_turn_busy: "上一轮仍在进行",
  codex_pool_busy: "账号池繁忙",
  codex_route_unavailable: "服务暂时不可用",
  codex_container_recycled: "环境已重建",
  codex_billing: "计费服务暂时不可用",
  upstream_error: "模型服务暂时不可用",
};
export function errorLabel(code: string | undefined): string {
  // 归一化(legacy 大写码经 normalizeTurnErrorCode → 语义码)后查表;未知码回退友好「出错了」
  // (不再把裸码 err_xxx 抛给用户;原始码/消息在「查看详情」)。
  return ERROR_LABELS[normalizeTurnErrorCode(code)] ?? "出错了";
}

/** 免单类错误码集合:**从 protocol 单一权威派生**(TURN_ERROR_TAXONOMY 中 waivable===true)。 */
const WAIVED_ERROR_CODES = WAIVED_TURN_ERROR_CODES;

function requestReference(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value) continue;
    const labelled = /(?:请求|request|trace)[ _-]?(?:id)?[：:=\s]+([A-Za-z0-9_-]{8,64})/i.exec(value)?.[1];
    if (labelled) return labelled;
    const trace = /\b[0-9a-f]{32}\b/i.exec(value)?.[0];
    if (trace) return trace;
  }
  return undefined;
}

function looksLikeInternalError(value: string | undefined): boolean {
  if (!value) return false;
  return (
    /^\s*[\[{]/.test(value) ||
    /MODEL_AUTHORITY_INVALID|API Error|"(?:error|errors|status|code)"\s*:|\bat\s+\S+\s*\(/i.test(value)
  );
}

/**
 * 「查看详情」detail 统一守卫(Codex 审计 R7)。新 tape 码(model_capacity 等)可能携带 Codex 的
 * JSON errorDetail;若无条件透传就会绕过 engine_error 特判直接进 <pre> 外泄。规则:
 *   - 终止器短 prose([turn failed: …] / [error] …)是可读排查线索 → 保留;
 *   - JSON 信封 / 堆栈 / 内部串(looksLikeInternalError)→ 脱敏,只保留可提取的请求 ID;
 *   - 其余普通说明(白名单服务端 message 亦属此类,非内部串)→ 原样保留(不受影响)。
 */
function sanitizeErrorDetail(detail: string | undefined): string | undefined {
  const d = detail?.trim();
  if (!d) return undefined;
  if (/^\[(?:turn failed|error)\b/i.test(d)) return d;
  if (looksLikeInternalError(d)) {
    const ref = requestReference(d);
    return ref ? `请求 ID：${ref}` : undefined;
  }
  return d;
}

/**
 * 从正文尾部切出 tape 兼容终止器([turn failed: …] / [error] …)。tape 把它作为兼容 final
 * 追加到最后一个 assistant segment 的 text 尾,合法部分回答与终止器常同串:
 *   "…正常部分回答…\n\n[turn failed: …]\n"
 * 返回 { body: 终止器前的正文(trim), terminator: 终止器串(trim) };无终止器 → body=原串、terminator=""。
 */
function splitTrailingTerminator(text: string): { body: string; terminator: string } {
  const m = /\n*[ \t]*(\[(?:turn failed|error)\b[^\n]*)\s*$/i.exec(text);
  if (!m) return { body: text, terminator: "" };
  return { body: text.slice(0, m.index).trim(), terminator: m[1].trim() };
}

export type ErrorPresentation = {
  title: string;
  message: string;
  /**
   * 失败轮里模型已产出的**合法部分回答**正文(Codex 审计 R6)。tape 水合把 _errorCode 挂在最后一个
   * assistant segment,其 text 可能同时携带正常部分回答;此字段承载那段正文,由 AssistantCard 用
   * Markdown 正常渲染,红卡(message=按码文案)在其下方,复刻 live 双卡形态。无部分回答时缺省。
   */
  bodyText?: string;
  detail?: string;
  waived: boolean;
};

/** Render-time privacy/UX boundary for both new and already-persisted errors. */
export function errorPresentation(
  code: string | undefined,
  text: string | undefined,
  detail: string | undefined,
  waiverApplied = false,
): ErrorPresentation {
  let normalized = normalizeTurnErrorCode(code);
  if (/MODEL_AUTHORITY_INVALID|MODEL_AUTHORITY_EXPIRED/i.test(`${code ?? ""}\n${text ?? ""}\n${detail ?? ""}`)) {
    normalized = "model_authority_expired";
  }
  const waiverEligible = WAIVED_ERROR_CODES.has(normalized);
  const ref = requestReference(detail, text);
  // durable turn dispatch failure-status 文案。三者恒免单 tone(waived:true → 温和
  // ShieldCheck 卡):dispatch_lost / dispatch_not_accepted = 受理成功但从未开始执行(durable
  // not_accepted 证明,未计费);service_restart = 服务重启掐断，但 master 的
  // durable live-frame journal 保留此前所有已展示过程。
  // 均非平台内部错误,不甩堆栈。dispatch_not_accepted 是 reconciler 对「容器 rejected tombstone」
  // 铸的精确码(MIN2),与 dispatch_lost 同免单文案。
  if (normalized === "dispatch_lost" || normalized === "dispatch_not_accepted") {
    return {
      title: "消息未开始处理",
      message: "消息未能开始处理，已确认未计费，请重试。",
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: true,
    };
  }
  if (normalized === "service_restart") {
    return {
      title: "任务已中断",
      message: "此前已生成的过程已完整保留。你可以从现有进度继续；本轮未计费，如已扣除，积分已原路退回。",
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: true,
    };
  }
  if (waiverEligible && waiverApplied) {
    const message = normalized === "turn_limit"
      ? "任务达到 12 小时运行上限，系统已中断。本轮不收费；如已扣除，积分已原路退回，并已发送站内信说明。"
      : normalized === "liveness_timeout" || normalized === "idle_timeout"
        ? "任务长时间没有新输出，系统已中断。本轮不收费；如已扣除，积分已原路退回，并已发送站内信说明。"
        : normalized === "no_response" || normalized === "phantom_turn"
          ? "任务未能产生有效回复。本轮未扣费，并已发送站内信说明。"
          : "长任务的执行凭证未能继续。本轮不收费；如已扣除，积分已原路退回，并已发送站内信说明。你可以重新尝试。";
    return {
      title: "本轮已自动免单",
      message,
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: true,
    };
  }
  if (waiverEligible) {
    const message = normalized === "turn_limit"
      ? "任务达到 12 小时运行上限，系统已中断。你可以重新尝试。"
      : normalized === "liveness_timeout" || normalized === "idle_timeout"
        ? "任务长时间没有新输出，系统已中断。你可以重新尝试。"
        : normalized === "no_response" || normalized === "phantom_turn"
          ? "任务未能产生有效回复。你可以重新尝试。"
          : "长任务的执行凭证未能继续。你的消息已保留，可以重新尝试。";
    return {
      title: "任务未正常完成",
      message,
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: false,
    };
  }
  if (normalized === "auth_error") {
    return {
      title: ERROR_LABELS.auth_error,
      message: "认证状态异常，本轮未正常完成。请重新尝试。",
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: false,
    };
  }
  // engine_error 且**正文本身**是 JSON/堆栈内部串 → 收敛为友好内部错误文案(把内部转储当"答复"
  // 甩给用户是最刺眼的一类)。**只看 text**(不再因 detail 内部就命中):若 text 是合法部分回答、
  // 仅 detail 是内部串,应落到下方 R6 分支保住部分回答(detail 交由 sanitizeErrorDetail 脱敏)。
  if (normalized === "engine_error" && looksLikeInternalError(text)) {
    return {
      title: ERROR_LABELS.engine_error,
      message: "任务执行时遇到内部错误。你的消息已保留，可以直接重试。",
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: false,
    };
  }
  // ── 兜底分支:区分「终止器/内部串」「合法部分回答」「空」三类 text(任务②ﾠ+ Codex 审计 R6)──
  // 历史上这里直接把 msg.text 当正文,tape 终止器(「[turn failed: …]」/「[error] server shutting
  // down」)、平台内部串会原样甩给用户;更早的整改又把**合法部分回答**一并降进 detail(刷新后消失)。
  // 现在:仅当 text 正是**该码已知友好文案**或**白名单服务端 message**时原样作正文;否则切出尾部终止
  // 器,前半段若是合法部分回答 → 进 bodyText(AssistantCard 正常 Markdown 渲染)、红卡正文用按码文案;
  // 终止器/内部串按 R7 守卫决定去留,detail 一律过 sanitizeErrorDetail。
  const t = text?.trim() ?? "";
  const byCode = friendlyBridgeErrorMessage(normalized); // 纯按码正文(不喂 message,避免 server-msg 自反)
  const safeDetail = sanitizeErrorDetail(detail); // R7:统一守卫 _errorDetail(JSON/堆栈脱敏,保留请求 ID)
  // [turn failed …] / [error] … 是 tape 终止器(以 [ 开头,已被 looksLikeInternalError 命中),显式列出
  // 仅为可读;serverMsgOk = 该码白名单且 message 过展示守卫(必非 [ 开头,故与 raw 互斥)。
  const isRaw = !t || looksLikeInternalError(t) || /^\[(?:turn failed|error)\b/i.test(t);
  const sem = turnErrorSemantics(normalized);
  const serverMsgOk = sem.allowPublicServerMessage === true && isDisplayableServerMessage(t);
  const keepText = !isRaw && (t === byCode || serverMsgOk);
  if (keepText) {
    return {
      title: errorLabel(normalized),
      message: t,
      ...(safeDetail ? { detail: safeDetail } : {}),
      waived: false,
    };
  }
  // R6:切出尾部终止器,前半段若是合法部分回答(非空、非内部串) → 作 bodyText 正常渲染,红卡在其下方。
  const { body: preTerminator, terminator } = splitTrailingTerminator(t);
  const partialAnswer = preTerminator && !looksLikeInternalError(preTerminator) ? preTerminator : "";
  // detail 优先级:已脱敏的原 _errorDetail > 终止器排查线索 > 无。真正的 JSON 信封/堆栈已被 R7 隐去。
  const detailOut = safeDetail ?? (terminator || undefined);
  return {
    title: errorLabel(normalized),
    message: byCode,
    ...(partialAnswer ? { bodyText: partialAnswer } : {}),
    ...(detailOut ? { detail: detailOut } : {}),
    waived: false,
  };
}

/**
 * 轻量 markdown → 纯文本（"复制纯文本"用）。只剥常见标记，不追求完备：
 * 去围栏/行内 code 反引号、强调符、标题井号、列表符、引用符，链接取可见文字。
 */
export function stripMarkdown(md: string): string {
  if (!md) return "";
  return md
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```[^\n]*\n?/g, "").replace(/```$/, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$2")
    .trim();
}
