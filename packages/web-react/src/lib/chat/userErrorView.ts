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
  "refresh", "topup", "new_session", "wait", "check_settings", "split_upload",
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
