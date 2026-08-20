/**
 * 侧栏会话状态点：纯判定（running / 终态 / 错误码 → 展示枚举）。
 * 视觉组件见 SessionStatusDot；本 tab 发送中由 isSending 注入 running，
 * 服务端 runState/lastOutcome 只做刷新与跨设备兜底。
 */
import { normalizeTurnErrorCode } from "@openclaude/protocol";
import type { SessionLastOutcome } from "./types";

export type SessionStatusKind =
  | "running"
  | "completed"
  | "interrupted"
  | "error"
  | "service_restart"
  | "none";

export type SessionStatusInput = {
  /** 本 tab 正在发送，或列表 runState=running 且没有更新的本地终态。 */
  running?: boolean;
  lastOutcome?: string | null;
  lastErrorCode?: string | null;
};

const LAST_OUTCOMES = new Set<string>([
  "completed",
  "interrupted",
  "crashed",
  "not_accepted",
  "executed_error",
]);

export const SESSION_STATUS_LABELS: Record<Exclude<SessionStatusKind, "none">, string> = {
  running: "运行中",
  completed: "已完成",
  interrupted: "已中断",
  error: "出错",
  service_restart: "服务重启中断，可继续",
};

/** 侧栏行首唯一状态点。completed/interrupted 只在未读时出绿点；error / service_restart 不因已读消失。 */
export type SidebarDotKind = "running" | "unread" | "error" | "service_restart" | "none";

export const SIDEBAR_DOT_LABELS: Record<Exclude<SidebarDotKind, "none">, string> = {
  running: "运行中",
  unread: "未读",
  error: "出错",
  service_restart: "服务重启中断，可继续",
};

/** 与 SessionRow 同一套 running 判据：本 tab isSending 优先；否则 runState=running 且没有本 tab 终态。 */
export function isSidebarSessionRunning(
  session: { id: string; runState?: string | null },
  ctx?: {
    isSending?: (id: string) => boolean;
    liveTerminal?: (id: string) => unknown;
  },
): boolean {
  const sending = Boolean(ctx?.isSending?.(session.id));
  const live = ctx?.liveTerminal?.(session.id);
  return sending || (session.runState === "running" && !live);
}

export function resolveSidebarDot(input: SessionStatusInput, unread?: boolean): SidebarDotKind {
  const kind = resolveSessionStatus(input);
  if (kind === "running") return "running";
  if (kind === "error") return "error";
  if (kind === "service_restart") return "service_restart";
  if (unread) return "unread";
  return "none";
}

export function resolveSessionStatus(input: SessionStatusInput): SessionStatusKind {
  if (input.running) return "running";
  const code = normalizeTurnErrorCode(input.lastErrorCode);
  if (code === "service_restart") return "service_restart";
  switch ((input.lastOutcome ?? "").trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "crashed":
    case "executed_error":
    case "not_accepted":
      return "error";
    default:
      return "none";
  }
}

function asLastOutcome(value: string): SessionLastOutcome | null {
  const v = value.trim().toLowerCase();
  return LAST_OUTCOMES.has(v) ? (v as SessionLastOutcome) : null;
}

/** 从本 tab 会话消息倒序抽出最近一轮终态（isFinal / outbound.error），供发送结束瞬间落点。 */
export function deriveLiveTerminalFromMessages(
  messages:
    | ReadonlyArray<{
        _dispatchOutcome?: string;
        _errorCode?: string;
        _turnStatusRecord?: boolean;
      }>
    | undefined,
): { lastOutcome: SessionLastOutcome; lastErrorCode: string | null } | null {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._turnStatusRecord) continue;
    const code = typeof m._errorCode === "string" && m._errorCode ? m._errorCode : null;
    const outcome = asLastOutcome(m._dispatchOutcome ?? "");
    if (normalizeTurnErrorCode(code) === "service_restart") {
      return { lastOutcome: outcome ?? "crashed", lastErrorCode: code };
    }
    if (outcome) return { lastOutcome: outcome, lastErrorCode: code };
    if (code) return { lastOutcome: "executed_error", lastErrorCode: code };
  }
  return null;
}
