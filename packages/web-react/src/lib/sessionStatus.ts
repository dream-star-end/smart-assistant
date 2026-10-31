/**
 * 侧栏会话状态点：纯判定（running / 终态 / 错误码 → 展示枚举）。
 * 视觉组件见 SessionStatusDot；本 tab 发送中由 isSending 注入 running，
 * 服务端 runState/lastOutcome 只做刷新与跨设备兜底。
 */
import { normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import type { SessionLastOutcome } from "./types";

export type SessionStatusKind =
  | "running"
  | "completed"
  | "stopped"
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
  stopped: "已停止",
  error: "出错",
  service_restart: "服务重启中断，可继续",
};

/** 侧栏行首唯一状态点。completed/interrupted 只在未读时出绿点；error / service_restart 不因已读消失。 */
export type SidebarDotKind = "running" | "unread" | "stopped" | "error" | "service_restart" | "none";

export const SIDEBAR_DOT_LABELS: Record<Exclude<SidebarDotKind, "none">, string> = {
  running: "运行中",
  unread: "未读",
  stopped: "已停止",
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
  if (kind === "stopped") return "stopped";
  if (unread) return "unread";
  return "none";
}

export function resolveSessionStatus(input: SessionStatusInput): SessionStatusKind {
  if (input.running) return "running";
  const code = normalizeTurnErrorCode(input.lastErrorCode);
  if (code === "service_restart") return "service_restart";
  if (code === "stopped" || code === "user_cancelled") return "stopped";
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

type TerminalCandidateMessage = {
  ts?: number;
  completedAt?: number;
  _dispatchOutcome?: string;
  _errorCode?: string;
  _turnStatusRecord?: boolean;
};

function finitePositiveMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function findLiveTerminalEntry(
  messages: ReadonlyArray<TerminalCandidateMessage> | undefined,
): {
  lastOutcome: SessionLastOutcome;
  lastErrorCode: string | null;
  messageTimestamp: number | null;
} | null {
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._turnStatusRecord) continue;
    const code = typeof m._errorCode === "string" && m._errorCode ? m._errorCode : null;
    const outcome = asLastOutcome(m._dispatchOutcome ?? "");
    const normalized = normalizeTurnErrorCode(code);
    const bestTs = Math.max(finitePositiveMs(m.completedAt) ?? 0, finitePositiveMs(m.ts) ?? 0);
    const messageTimestamp = bestTs > 0 ? bestTs : null;
    if (normalized === "stopped" || normalized === "user_cancelled") {
      return { lastOutcome: "interrupted", lastErrorCode: code, messageTimestamp };
    }
    if (normalized === "service_restart") {
      return { lastOutcome: outcome ?? "crashed", lastErrorCode: code, messageTimestamp };
    }
    if (outcome) return { lastOutcome: outcome, lastErrorCode: code, messageTimestamp };
    if (code) return { lastOutcome: "executed_error", lastErrorCode: code, messageTimestamp };
  }
  return null;
}

/** 从本 tab 会话消息倒序抽出最近一轮终态（isFinal / outbound.error），供发送结束瞬间落点。 */
export function deriveLiveTerminalFromMessages(
  messages: ReadonlyArray<TerminalCandidateMessage> | undefined,
): { lastOutcome: SessionLastOutcome; lastErrorCode: string | null } | null {
  const entry = findLiveTerminalEntry(messages);
  return entry ? { lastOutcome: entry.lastOutcome, lastErrorCode: entry.lastErrorCode } : null;
}

/**
 * 抽取最近终态的实际发生时刻：优先终态消息自带的 completedAt / ts（含离线恢复后 REST 权威历史），
 * 仅在本地终态消息无有效时间戳时回落观察时刻，避免把恢复观察时间当作会话生命周期终点。
 */
export function deriveLiveTerminalEndedAt(
  messages: ReadonlyArray<TerminalCandidateMessage> | undefined,
  observedAt = Date.now(),
): number {
  return findLiveTerminalEntry(messages)?.messageTimestamp ?? observedAt;
}

/**
 * 本 tab 发送态刚结束（isSending: true → false）时的兜底终态(U8)：
 * 实时 WS 正常完成帧的消息不带 `_dispatchOutcome`，此前 deriveLiveTerminalFromMessages 返回 null
 * 会导致侧栏沿用轮询写下的 `runState="running"` 持续转圈。无错误/中断标记即收敛为 completed。
 */
export function resolveLiveTurnEndTerminal(
  messages:
    | ReadonlyArray<{
        _dispatchOutcome?: string;
        _errorCode?: string;
        _turnStatusRecord?: boolean;
      }>
    | undefined,
): { lastOutcome: SessionLastOutcome; lastErrorCode: string | null } {
  return (
    deriveLiveTerminalFromMessages(messages) ?? {
      lastOutcome: "completed",
      lastErrorCode: null,
    }
  );
}
