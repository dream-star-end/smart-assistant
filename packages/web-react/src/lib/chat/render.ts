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
import { REVIEW_VERDICT_NEEDS_FIX, REVIEW_VERDICT_PASS } from "@openclaude/protocol/teamCards";
import { isServerAuthoredRow } from "./model";
import type { ChatMessage, ChildBlock } from "./model";

/**
 * durable turn dispatch(RFC §2.5)的 error projection 虚拟行 id 前缀。server 为「受理成功但
 * 未执行/未收尾」的 turn 铸造这条虚拟行(role 'assistant'、_errorCode ∈ dispatch 终态码、
 * _clientMessageId 指向锚点 user 行),前端按既有 error 卡渲染。
 */
export const DISPATCH_ERROR_ROW_ID_PREFIX = "oc-dispatch-err:";

/**
 * dispatch 终态错误码(免单语义:受理未执行 = 未计费 / 服务重启中断 = 已退款)。归一化小写。
 * 这些是 **server 权威的稳定协议码**:`dispatch_lost`/`dispatch_not_accepted` 由 reconciler 铸在
 * error projection 上;`service_restart` 由 gateway 写在**不可变 tape**(boot recovery synthetic
 * crashed)里 —— 不可变行无法回填 master 标记,故按稳定协议码识别(非脆弱的内部 failureCode 枚举)。
 */
export const DISPATCH_LOST_ERROR_CODES = new Set([
  "dispatch_lost",
  "dispatch_not_accepted",
  "service_restart",
]);

/** 该行是否为 dispatch error projection 虚拟行(id 前缀判定,单一权威)。 */
export function isDispatchErrorProjectionRow(m: Pick<ChatMessage, "id"> | null | undefined): boolean {
  return typeof m?.id === "string" && m.id.startsWith(DISPATCH_ERROR_ROW_ID_PREFIX);
}

/** 归一化后是否命中 dispatch 终态错误码(仅用于稳定协议码;projection 走标记不走码)。 */
export function isDispatchLostCode(code: string | undefined | null): boolean {
  return typeof code === "string" && DISPATCH_LOST_ERROR_CODES.has(code.trim().toLowerCase());
}

/**
 * **去枚举化的重试判据单一权威(RFC §5 M5)**:该行是否证明其 turn 的 dispatch 已终态失败,
 * 需要重试铸新 clientMessageId。优先级:
 *   ① error projection 虚拟行(id 前缀,code-agnostic);
 *   ② server 持久标记 `_dispatchTerminal`(projection 恒带,未来新终态类别也带 → 前端零改动);
 *   ③ 不可变 tape 的稳定协议码(service_restart 等,gateway 写、无法回填标记的兜底)。
 * 前端**不**再枚举内部 failureCode(codex_pre_forward_abandoned / ERR_FRAME_TOO_BIG …)——那些
 * 都被 ① 一网打尽。
 */
export function isDispatchTerminalRow(
  m: Pick<ChatMessage, "id" | "_dispatchTerminal" | "_errorCode"> | null | undefined,
): boolean {
  if (!m) return false;
  if (isDispatchErrorProjectionRow(m)) return true;
  if (m._dispatchTerminal === true) return true;
  return isDispatchLostCode(m._errorCode);
}

/**
 * 渲染层双保险(RFC §5):收集「同 _clientMessageId 已存在非 error 终态行」的 turn 集。
 * server 侧 late-tape 会撤销 projection(§2.4),这是撤销传播前竞态窗口的端上兜底 —— 真 tape
 * 展开的 server-authored 生成行(assistant/thinking/tool、无 _errorCode)一旦出现,同轮的 error
 * projection 行即被抑制,避免「结果已显示 + 错误卡并存」。
 */
export function collectResolvedDispatchTurnIds(messages: readonly ChatMessage[]): Set<string> {
  const resolved = new Set<string>();
  for (const m of messages) {
    const cmid = m?._clientMessageId;
    if (typeof cmid !== "string" || cmid.length === 0) continue;
    if (isDispatchErrorProjectionRow(m)) continue;
    // 折叠 anchor(§9)= 真 tape 已落库的水合入口 → tape 权威压过 dispatch error projection:
    // 只要该轮存在折叠 anchor(任一终态),同轮的 dispatch_lost 投影即被抑制(late-tape 撤销投影
    // 传播前的端上竞态兜底,与 detectServerTerminalTurns 的 completed 覆盖 error 口径一致)。
    if (isCollapsedTapeAnchor(m)) {
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

/** 该 projection 行是否应被同轮非 error 终态行抑制(渲染层调用,配合 collectResolvedDispatchTurnIds)。 */
export function isProjectionSuppressedByTerminal(
  m: Pick<ChatMessage, "id" | "_clientMessageId">,
  resolvedTurnIds: Set<string>,
): boolean {
  return (
    isDispatchErrorProjectionRow(m) &&
    typeof m._clientMessageId === "string" &&
    resolvedTurnIds.has(m._clientMessageId)
  );
}

// ═══════════════ §9 会话读物化投影:折叠 anchor / 截断记录 ═══════════════

/** 该行是否为折叠 anchor 行(RFC §9.1:大 tape 只回一条折叠 anchor 而非 N 条展开行)。 */
export function isCollapsedTapeAnchor(m: Pick<ChatMessage, "_tapeCollapsed"> | null | undefined): boolean {
  return !!m && m._tapeCollapsed === true;
}

/**
 * 折叠行/展开行的**精确定位三元组键**(RFC §9.1):`_turnTapeId :: _turnTapeSha256 :: anchor id`。
 * 展开替换按此键定位,**严禁按 _seq 批量替换**——同一 _seq 上并列多条 projection 虚拟行,按 _seq 会误伤。
 * tapeSha 缺省(server 未带)时以空串占位,anchor id 仍保证唯一。
 */
export function tapeAnchorKey(
  m: Pick<ChatMessage, "id" | "_turnTapeId" | "_turnTapeSha256">,
): string {
  return `${m._turnTapeId ?? ""}::${m._turnTapeSha256 ?? ""}::${m.id}`;
}

/**
 * 折叠 anchor 的 `_dispatchOutcome` → 终态类别(RFC §9-B1 谓词拆分)。
 *  - completed / interrupted → 'completed':该轮**有内容**(tape 存在,含被中断的部分产出)→ 清发送态、
 *    user 行置 replied、抑制同轮 dispatch error projection;
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
 * 折叠 anchor 是否构成该轮"终态存在证据"(RFC §9-B1):`_tapeCollapsed ∧ _dispatchOutcome 为终态`。
 * = 参与 exact-clientMessageId 清 _sendingInFlight 与 error projection 抑制;但**不是**"内容已展开"
 * (评分卡/MetaRow 等需正文的门不由它触发;折叠行非"末条 assistant 正文",见 turnSegment)。
 */
export function isCollapsedAnchorTerminalEvidence(
  m: Pick<ChatMessage, "_tapeCollapsed" | "_dispatchOutcome"> | null | undefined,
): boolean {
  return isCollapsedTapeAnchor(m) && collapsedAnchorTerminalKind(m?._dispatchOutcome) !== null;
}

/**
 * 该记录是否被逐记录截断(RFC §9.1)。判据 = `_fullBytes` 存在(server 截断记录时与 wire `_truncated:true`
 * 同发,但前端只认无歧义的 `_fullBytes`,避开 assistant 续写标记 `_truncated:string` 的同名歧义)。
 */
export function isRecordTruncated(m: Pick<ChatMessage, "_fullBytes"> | null | undefined): boolean {
  return !!m && typeof m._fullBytes === "number" && m._fullBytes > 0;
}

/** 字节数 → 人类可读("N MB"/"N KB"/"N B")。折叠卡"本轮完整输出 N"与截断卡"共 N"共用。 */
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

/** 文本采样：长度 + 尾 16 字符。就地 append（长度单调增）下，长度即可探测增量；
 *  尾采样兜住"等长替换"这类非 append 编辑（现网 audit 提过的边角）。 */
function textSig(t: string | undefined): string {
  if (!t) return "0";
  return `${t.length}:${t.slice(-16)}`;
}

/** 子块（agent-group childBlocks 项）渲染签名。per-child 比较的最小充分集。 */
export function childSignature(ch: ChildBlock): string {
  return [
    ch.kind,
    ch.blockId ?? "",
    textSig(ch.text),
    ch.toolName ?? "",
    ch._partial ? 1 : 0,
    ch._completed ? 1 : 0,
    ch.output ? ch.output.length : 0,
    ch.error ? 1 : 0,
    ch.partialJson ? ch.partialJson.length : 0,
    ch.bashTail?.totalBytes ?? 0,
  ].join("|");
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
  // §9 折叠 anchor 由 MessageRenderer 拦截渲染 CollapseCard(不走 role 分派):其重渲触发字段
  // (_tapeExpanded / _tapeExpandCursor / _tapeTotalBytes / _dispatchOutcome)不在下方 role 分支里,
  // 折进 head 保证展开态翻转、续拉游标变化时穿透 memo 重渲。非折叠行恒空片段,不影响既有签名。
  const collapse = m._tapeCollapsed
    ? `|tc:${m._tapeExpanded ? 1 : 0}:${m._tapeExpandCursor ?? "n"}:${m._tapeTotalBytes ?? 0}:${m._dispatchOutcome ?? ""}`
    : "";
  const head = `${m.role}|${m.id}|${ctx.isLast ? 1 : 0}|${ctx.sending ? 1 : 0}|${m.completedAt ?? 0}|${ctx.turnFinalAssistant ? 1 : 0}${collapse}`;
  switch (m.role) {
    case "assistant":
      return [
        head,
        textSig(m.text),
        m.usage?.traceId ?? "",
        m.usage?.costCredits ?? "",
        m._truncated ?? "",
        m._errorCode ?? "",
        m._errorDetail ? m._errorDetail.length : 0,
        m._emptyTurn ? 1 : 0,
        m._emptyTurnSoft ? 1 : 0,
        m._emptyTurnTimeout ? 1 : 0,
        m.cronPush ? `cron:${m.cronLabel ?? ""}` : "",
      ].join("|");
    case "user":
      return [head, textSig(m.text), m.status ?? "", (m._media?.length ?? 0)].join("|");
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
        m.inputPreview ? m.inputPreview.length : 0,
        m.bashTail?.totalBytes ?? 0,
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
        (m.childBlocks ?? []).map(childSignature).join(";"),
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
        (m.childBlocks ?? []).map(childSignature).join(";"),
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

/** 归一化错误码 → 用户可读中文标题。未知码回退原码（仍可读、可反馈）。 */
const ERROR_LABELS: Record<string, string> = {
  insufficient_credits: "积分余额不足",
  rate_limited: "请求过于频繁，请稍后再试",
  context_too_long: "上下文超长，请精简或开新会话",
  upstream_error: "模型服务暂时不可用",
  upstream_timeout: "模型响应超时",
  network_error: "网络异常，请重试",
  service_restart: "服务重启，本轮已中断",
  conn_kicked: "连接已断开",
  maintenance: "服务维护中",
  unauthorized_model: "模型未开通",
  unauthorized: "登录已失效",
  // 模型权威 gate 的拒帧(方案 §4 R3-m12)。标题=类别,「怎么办」在 friendlyBridgeErrorMessage。
  model_config_changed_retry_turn: "模型配置已更新，请重发",
  model_not_available: "模型不可用",
  unresolved_agent_model: "未能确定模型",
  model_authority_unavailable: "模型服务暂时不可用",
  model_catalog_unavailable: "模型服务暂时不可用",
  stopped: "已停止本轮生成",
  internal_error: "服务内部错误",
  auth_error: "认证状态异常",
  engine_error: "任务执行失败",
  model_authority_expired: "本轮已自动免单",
  liveness_timeout: "本轮已自动免单",
  idle_timeout: "本轮已自动免单",
  no_response: "本轮已自动免单",
  phantom_turn: "本轮已自动免单",
  turn_limit: "本轮已自动免单",
};
export function errorLabel(code: string | undefined): string {
  if (!code) return "出错了";
  // 未知码回退友好"出错了"(不再把裸码 err_xxx 抛给用户;原始码/消息在「查看详情」)。
  return ERROR_LABELS[code.trim().toLowerCase()] ?? "出错了";
}

const WAIVED_ERROR_CODES = new Set([
  "model_authority_expired",
  "liveness_timeout",
  "idle_timeout",
  "no_response",
  "phantom_turn",
  "turn_limit",
]);

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

export type ErrorPresentation = {
  title: string;
  message: string;
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
  let normalized = code?.trim().toLowerCase() ?? "";
  if (/MODEL_AUTHORITY_INVALID|MODEL_AUTHORITY_EXPIRED/i.test(`${code ?? ""}\n${text ?? ""}\n${detail ?? ""}`)) {
    normalized = "model_authority_expired";
  }
  const waiverEligible = WAIVED_ERROR_CODES.has(normalized);
  const ref = requestReference(detail, text);
  // durable turn dispatch(RFC §5)error projection 文案。三者恒免单 tone(waived:true → 温和
  // ShieldCheck 卡):dispatch_lost / dispatch_not_accepted = 受理成功但从未开始执行(durable
  // not_accepted 证明,未计费);service_restart = 服务重启掐断,已生成内容无法恢复(已退款)。
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
      title: ERROR_LABELS.service_restart,
      message: "任务因服务重启中断，未能恢复已生成内容。本轮未计费；如已扣除，积分已原路退回，你可以重新尝试。",
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
  if (normalized === "engine_error" && (looksLikeInternalError(text) || looksLikeInternalError(detail))) {
    return {
      title: ERROR_LABELS.engine_error,
      message: "任务执行时遇到内部错误。你的消息已保留，可以直接重试。",
      ...(ref ? { detail: `请求 ID：${ref}` } : {}),
      waived: false,
    };
  }
  return {
    title: errorLabel(code),
    message: text?.trim() || "本轮未正常完成，请重试。",
    ...(detail?.trim() ? { detail: detail.trim() } : {}),
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
