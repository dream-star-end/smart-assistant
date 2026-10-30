/** Error-card presentation helpers; imported only by the lazy notice chunk. */
import type { ErrorActionHandlers, ErrorNoticeAction, UserError, UserErrorAction } from "./userErrorView";

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
