/**
 * 侧栏会话状态点：纯判定（running / 终态 / 错误码 → 展示枚举）。
 * 视觉组件见 SessionStatusDot；本 tab 发送中由 isSending 注入 running，
 * 服务端 runState/lastOutcome 只做刷新与跨设备兜底。
 */
import { normalizeTurnErrorCode } from "@openclaude/protocol/browser";
import type { SessionLastOutcome } from "./types";

export type SessionNeedsYouKind = "answer" | "approval";

export type SessionStatusKind =
  | "needs_you"
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
  /** 会话处于等待用户回答或审批状态（侧栏显示 Q 版问号）。 */
  needsYou?: boolean | SessionNeedsYouKind | null;
};

const LAST_OUTCOMES = new Set<string>([
  "completed",
  "interrupted",
  "crashed",
  "not_accepted",
  "executed_error",
]);

export const SESSION_STATUS_LABELS: Record<Exclude<SessionStatusKind, "none">, string> = {
  needs_you: "等你回答",
  running: "运行中",
  completed: "已完成",
  interrupted: "已中断",
  stopped: "已停止",
  error: "出错",
  service_restart: "服务重启中断，可继续",
};

/** 侧栏行首唯一状态点。needs_you 优先显示 Q 版问号；completed/interrupted 只在未读时出绿点；error / service_restart 不因已读消失。 */
export type SidebarDotKind =
  | "needs_you"
  | "running"
  | "unread"
  | "stopped"
  | "error"
  | "service_restart"
  | "none";

export const SIDEBAR_DOT_LABELS: Record<Exclude<SidebarDotKind, "none">, string> = {
  needs_you: "等你回答",
  running: "运行中",
  unread: "未读",
  stopped: "已停止",
  error: "出错",
  service_restart: "服务重启中断，可继续",
};

export function resolveSidebarDotLabel(
  kind: Exclude<SidebarDotKind, "none">,
  needsYou?: boolean | SessionNeedsYouKind | null,
): string {
  if (kind === "needs_you") {
    return needsYou === "approval" ? "等你批准" : SIDEBAR_DOT_LABELS.needs_you;
  }
  return SIDEBAR_DOT_LABELS[kind];
}

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
  if (input.needsYou) return "needs_you";
  const kind = resolveSessionStatus(input);
  if (kind === "needs_you") return "needs_you";
  if (kind === "running") return "running";
  if (kind === "error") return "error";
  if (kind === "service_restart") return "service_restart";
  if (kind === "stopped") return "stopped";
  if (unread) return "unread";
  return "none";
}

export function resolveSessionStatus(input: SessionStatusInput): SessionStatusKind {
  if (input.needsYou) return "needs_you";
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


import {
  clearTicketApprovalPendingCacheForTest,
  getTicketApprovalPendingVersion,
  isTicketApprovalKnownResolved,
  recordTicketApprovalPending,
  subscribeTicketApprovalPending,
  syncTicketApprovalFromTicket,
} from "./taskboardFeature";
export {
  clearTicketApprovalPendingCacheForTest,
  getTicketApprovalPendingVersion,
  isTicketApprovalKnownResolved,
  recordTicketApprovalPending,
  subscribeTicketApprovalPending,
  syncTicketApprovalFromTicket,
};

const OPTIONS_FENCE_RE = /(?:^`{3,}|^~{3,}|\n\s*`{3,}|\n\s*~{3,})\s*options\b/i;

export function hasUnansweredOptionsFence(text: string | undefined | null): boolean {
  if (typeof text !== "string" || !text) return false;
  return OPTIONS_FENCE_RE.test(text);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v) return null;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function unwrapToolNameAndInput(m: {
  toolName?: string;
  inputJson?: unknown;
  toolInput?: unknown;
  input?: unknown;
}): { name: string; input: Record<string, unknown> | null } {
  const rawName = typeof m.toolName === "string" ? m.toolName.trim() : "";
  const outer = asRecord(m.inputJson ?? m.toolInput ?? m.input);
  if (!outer) return { name: rawName, input: null };
  const innerRaw =
    outer.tool_input ??
    outer.toolInput ??
    outer.arguments ??
    outer.Arguments ??
    outer.params ??
    outer.input;
  const innerArgs = asRecord(innerRaw) ?? outer;
  const innerTool =
    (typeof outer.tool_name === "string" && outer.tool_name.trim()) ||
    (typeof outer.toolName === "string" && outer.toolName.trim()) ||
    (typeof outer.ToolName === "string" && outer.ToolName.trim()) ||
    (typeof outer.name === "string" && outer.name.trim()) ||
    (typeof outer.tool === "string" && outer.tool.trim()) ||
    "";
  const isWrapper =
    !rawName ||
    /(?:^|__|:|-)(?:use_tool|call_mcp_tool|ExecuteExtraTool|mcpToolCall|mcp_tool_call)$/i.test(
      rawName,
    );
  if (innerTool && (isWrapper || innerTool.includes("__") || innerTool.startsWith("mcp__"))) {
    const server =
      (typeof outer.server === "string" && outer.server.trim()) ||
      (typeof outer.server_name === "string" && outer.server_name.trim()) ||
      (typeof outer.serverName === "string" && outer.serverName.trim()) ||
      (typeof outer.serverIdentifier === "string" && outer.serverIdentifier.trim()) ||
      (typeof outer.ServerName === "string" && outer.ServerName.trim()) ||
      "";
    const resolvedName =
      server && !innerTool.includes("__") ? `mcp__${server}__${innerTool}` : innerTool;
    return { name: resolvedName, input: innerArgs };
  }
  return { name: rawName, input: outer };
}

type NeedsYouCandidateMessage = TerminalCandidateMessage & {
    toolName?: string;
    inputJson?: unknown;
    toolInput?: unknown;
    input?: unknown;
    output?: unknown;
    error?: boolean;
    cancelled?: boolean;
    role?: string;
    text?: string;
    _resolved?: boolean;
    _controlPending?: boolean;
    _askUserExpiresAt?: number;
    _hideUnpublishedFallback?: boolean;
    _isAutoRetry?: boolean;
    _automaticRecovery?: boolean;
    _continuationOfClientMessageId?: string;
  };

function isUnresolvedPermissionRow(msg: NeedsYouCandidateMessage, now: number): boolean {
  if (msg.role !== "permission") return false;
  if (msg._resolved === true || msg._controlPending === true) return false;
  if (
    typeof msg._askUserExpiresAt === "number" &&
    Number.isFinite(msg._askUserExpiresAt) &&
    now >= msg._askUserExpiresAt
  ) {
    return false;
  }
  return true;
}

/**
 * 推导会话当前是否处于需要用户审批或回答的状态（侧栏显示 Q 版问号）：
 *  - 未决的 permission 卡（AskUserQuestion → answer，ExitPlanMode / 工具权限 → approval）
 *  - turnStatus === "waiting_for_user"
 *  - 最新一轮包含未决的 present_task_approval（approval）、present_options / ask_user / request_user_input（answer）
 *  - 最新一轮 assistant 回复含未作答的 ```options 选择卡（answer）
 * 一旦用户发送了新消息或完成了单据审批，状态立即消解。
 */
export function deriveSessionNeedsYou(
  session:
    | {
        messages?: ReadonlyArray<NeedsYouCandidateMessage>;
        _turnStatus?: unknown;
        _sendingInFlight?: boolean;
      }
    | undefined,
  now = Date.now(),
): SessionNeedsYouKind | null {
  if (!session) return null;
  const messages = session.messages ?? [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m._turnStatusRecord) continue;
    if (
      m.role === "user" &&
      !m._isAutoRetry &&
      !m._automaticRecovery &&
      !m._continuationOfClientMessageId
    ) {
      lastUserIdx = i;
      break;
    }
  }
  const turnMsgs = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;

  for (let i = turnMsgs.length - 1; i >= 0; i--) {
    const m = turnMsgs[i];
    if (!m || !isUnresolvedPermissionRow(m, now)) continue;
    const tName = m.toolName ?? "";
    if (tName === "AskUserQuestion" || /ask_user|request_user_input|present_options/i.test(tName)) {
      return "answer";
    }
    return "approval";
  }

  if (session._turnStatus === "waiting_for_user") {
    return "answer";
  }

  if (turnMsgs.length === 0) return null;

  const terminal = deriveLiveTerminalFromMessages(turnMsgs);
  if (
    terminal &&
    (terminal.lastErrorCode ||
      (terminal.lastOutcome && terminal.lastOutcome !== "completed"))
  ) {
    return null;
  }

  for (let i = turnMsgs.length - 1; i >= 0; i--) {
    const m = turnMsgs[i];
    if (!m || m._turnStatusRecord) continue;
    if (m.role === "tool") {
      if (m.error || m.cancelled) continue;
      if (typeof m.output === "string" && /^error:/i.test(m.output.trim())) continue;
      const { name, input } = unwrapToolNameAndInput(m);
      const outputObj = typeof m.output === "string" ? asRecord(m.output) : asRecord(m.output);
      const isTaskApproval =
        /present_task_approval/i.test(name) ||
        outputObj?.kind === "task_approval" ||
        (typeof m.output === "string" && m.output.includes('"kind":"task_approval"'));
      if (isTaskApproval) {
        const candidates = [
          input?.id,
          input?.identifier,
          input?.ticketId,
          input?.ticket_id,
          outputObj?.id,
          outputObj?.identifier,
          outputObj?.ticketId,
        ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
        if (candidates.length > 0 && candidates.some((c) => isTicketApprovalKnownResolved(c))) {
          continue;
        }
        return "approval";
      }
      if (
        name !== "AskUserQuestion" &&
        name !== "ExitPlanMode" &&
        /present_options|ask_user|request_user_input/i.test(name) &&
        !session._sendingInFlight
      ) {
        return "answer";
      }
    }
    if (
      m.role === "assistant" &&
      !m._hideUnpublishedFallback &&
      !m._errorCode &&
      hasUnansweredOptionsFence(m.text)
    ) {
      return "answer";
    }
  }

  return null;
}
