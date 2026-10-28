/**
 * 报错说人话(W3 FE-errors)。服务端在错误回包 / 错误帧 / 终态卡上带 `userError`
 * (protocol USER_ERROR_CATALOG 的一项);旧服务回包没有它,就按错误码查同一张目录
 * (`userErrorLookup.ts`,只在懒加载的错误卡块里用 —— 目录约 7KB gzip,不进首屏)。
 *
 * 界限:
 *  - 用户看的正文只用 `userError.message`。错误码、请求 ID、消息 ID 只进「技术详情」。
 *  - `actions` 只是建议。按钮执行时仍走卡片原来的接口和门控(精确重发、换模型、反馈),
 *    这里不授权任何重试或计费。
 *
 * 本文件在首屏闭包里:只许 import protocol 的类型,不许引目录本身。
 */
import type { UserError, UserErrorAction } from "@openclaude/protocol/browser";

export type { UserError, UserErrorAction };

const ACTIONS: ReadonlySet<string> = new Set<UserErrorAction>([
  "retry", "switch_model", "contact_admin", "edit_message", "relogin",
  "refresh", "topup", "new_session", "wait", "check_settings",
]);

/** 采信回包里的 userError:码、正文、动作齐全才用,否则交给错误码兜底。 */
export function readUserError(value: unknown): UserError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<UserError>;
  if (typeof v.code !== "string" || typeof v.message !== "string" || !v.message.trim()) return undefined;
  if (!Array.isArray(v.actions)) return undefined;
  return {
    code: v.code,
    category: typeof v.category === "string" ? v.category : "unknown",
    retryable: v.retryable === true,
    userMessageKey: typeof v.userMessageKey === "string" ? v.userMessageKey : `errors.${v.code}`,
    message: v.message,
    actions: v.actions.filter((a): a is UserErrorAction => typeof a === "string" && ACTIONS.has(a)),
  };
}

/** HTTP 错误:回包里的 userError。未知码(通用文案)返回 undefined,让调用方用更贴近操作的说法。 */
export function knownUserError(value: unknown): UserError | undefined {
  const userError = readUserError(value);
  return userError && userError.code !== "unexpected_error" ? userError : undefined;
}

export type ErrorActionHandler = { label: string; onClick: () => void };
export type ErrorActionHandlers = Partial<Record<UserErrorAction, ErrorActionHandler>>;
export type ErrorNoticeAction = ErrorActionHandler;

/**
 * 按目录给的顺序取能执行的动作,最多 `max` 个(Notice 只放两个按钮)。没有执行入口的建议
 * (例如「稍后再试」)不出按钮,文案里已经说了。
 */
export function pickErrorActions(
  actions: readonly UserErrorAction[],
  handlers: ErrorActionHandlers,
  max = 2,
): ErrorNoticeAction[] {
  const out: ErrorNoticeAction[] = [];
  for (const action of actions) {
    const handler = handlers[action];
    if (!handler || out.some((a) => a.label === handler.label)) continue;
    out.push(handler);
    if (out.length >= max) break;
  }
  return out;
}

/** 「技术详情」正文:原始错误码、请求 ID、消息 ID 和已脱敏的排查线索,一行一项。 */
export function errorTechnicalDetails(input: {
  code?: string;
  requestId?: string;
  clientMessageId?: string;
  detail?: string;
}): string | undefined {
  const lines: string[] = [];
  const code = input.code?.trim();
  const requestId = input.requestId?.trim();
  if (code) lines.push(`错误码：${code}`);
  if (requestId) lines.push(`请求 ID：${requestId}`);
  if (input.clientMessageId) lines.push(`消息 ID：${input.clientMessageId}`);
  for (const line of input.detail?.split("\n") ?? []) {
    const text = line.trim();
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** 没有错误码、只带 userError 的终态行(服务端「自动重试已停止」卡)用的标题。 */
export function standaloneErrorTitle(userError: UserError): string {
  return userError.code.startsWith("automatic_retry_") ? "自动重试已停止" : "这一轮没有完成";
}
