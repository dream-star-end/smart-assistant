/**
 * P5 渲染层**纯逻辑核心** —— 与 React 无关、可独立单测。
 *
 * 这里集中三类「会引发 UI bug 的隐性规则」，从组件里抽出来用 vitest 钉死：
 *  1. role → 渲染分派 kind（goal/codex v5 不产生 → 'unknown' 不出卡）。
 *  2. 单条消息 / 子块 **渲染签名**：reducer 对 message 做**就地 mutation**（同一对象
 *     引用、改字段），React.memo 默认浅比较会把"同引用"当"没变"而漏渲。这里产出一个
 *     仅捕获「影响渲染的字段」的字符串签名，作为 memo 比较键 —— 内容变才变、不变则
 *     稳定，从而复刻现网 vanilla 的 keyed-reconcile + per-child 签名防闪。
 *  3. 折叠态默认值（thinking 完成折叠 / agent-group 运行展开完成折叠），用户显式切换
 *     后由组件本地 state 锁定，不被签名重渲覆盖。
 */
import type { ChatMessage, ChildBlock } from "./model";

export type MessageKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "agent-group"
  | "plan"
  | "permission"
  | "delegate-progress"
  | "system"
  | "unknown";

/**
 * role → 渲染分派 kind。
 * v5 已删 codex：`goal` 永不产生 → 落 'unknown'（渲染层静默跳过，不出空卡）。
 * 未知/将来新增 role 同样落 'unknown'，保证渲染层 fail-safe（不崩、不出占位）。
 */
export function messageKind(m: Pick<ChatMessage, "role">): MessageKind {
  switch (m.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "tool":
    case "agent-group":
    case "plan":
    case "permission":
    case "delegate-progress":
    case "system":
      return m.role;
    default:
      // goal（codex 专属，v5 不实现）及任何未知 role。
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
  ctx: { isLast: boolean; sending: boolean },
): string {
  const head = `${m.role}|${m.id}|${ctx.isLast ? 1 : 0}|${ctx.sending ? 1 : 0}|${m.completedAt ?? 0}`;
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
        m._completed ? 1 : 0,
        m._isError ? 1 : 0,
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
        (m.childBlocks ?? []).map(childSignature).join(";"),
        m._adoptedInto ?? "",
      ].join("|");
    default:
      return [head, textSig(m.text)].join("|");
  }
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
  stopped: "已停止本轮生成",
  internal_error: "服务内部错误",
};
export function errorLabel(code: string | undefined): string {
  if (!code) return "出错了";
  return ERROR_LABELS[code] ?? code;
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
