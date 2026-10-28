/**
 * 按错误码查 protocol 错误目录(旧服务回包 / 历史错误行没有 userError 时兜底)。
 *
 * 目录约 7KB gzip,只给懒加载的错误卡块(components/chat/TurnErrorNotice.tsx)用;
 * 首屏代码不要 import 本文件(first-screen-budget,见 vite.config.ts)。
 */
import { getUserError } from "@openclaude/protocol/browser";
import { readUserError, type UserError } from "./userErrorView";

/** 回包带的 userError 优先;没有时按错误码查目录(未知码得到通用文案)。 */
export function resolveUserError(userError: unknown, code: unknown): UserError {
  return readUserError(userError) ?? getUserError(code);
}
