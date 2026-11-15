import type { ChatMessage } from "../../lib/chat/model";
import { resetPermissionPopupCoordinator } from "../../lib/chat/permissionPopupCoordinator";

export type PermissionRespond = (p: {
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}) => void;

/** 服务端 pending permission 的权威存活上界，镜像 gateway 的
 *  `Gateway.PENDING_PERMISSION_TTL_MS`（packages/gateway/src/server.ts）。
 *
 *  gateway 每 60s 跑 `_sweepStalePendingPermissions()`，超过该 TTL 的 pending 一律 force-deny
 *  并广播 `outbound.permission_settled{reason:'timeout'}`；断开连接走 `'disconnect'`，容器没了
 *  走 `'crashed'`。也就是说**超过这个时长的未决卡，服务端侧一定已经不在等了**。
 *
 *  两处数值必须一致，由 PermissionCard.test.tsx 的契约断言直接读 server.ts 源码锁定
 *  （前端改不动 gateway 常量：那是容器内源码面 / runtime release 轴，见 V5_DEV_PLAYBOOK §4.1）。
 *
 *  ⚠️ TTL 只用来决定「是否过期」：过期卡不再自动弹框。活跃提问在时钟偏差误判时
 *  仍保留手动「回答」入口（fail-safe）。历史/已结束会话里的过期卡改为只读「已过期」。
 *
 *  Detached Cursor `ask_user` cards (`requestId` 以 `ask-user:` 开头,或
 *  `_detachedAskUser`) 的过期上界是 24 小时（或消息上的 `_askUserExpiresAt`）。
 *  自动弹窗不再用这条 TTL 当「是不是当前活跃提问」的判据 —— 历史未决卡滚进视口
 *  不得再弹。 */
export const PENDING_PERMISSION_TTL_MS = 30 * 60_000;
export const DETACHED_ASK_USER_TTL_MS = 24 * 60 * 60_000;

export function isDetachedAskUserCard(msg: ChatMessage): boolean {
  return (
    msg._detachedAskUser === true ||
    (typeof msg.requestId === "string" && msg.requestId.startsWith("ask-user:"))
  );
}

export function resetPermissionAutoOpenMemory(): void {
  resetPermissionPopupCoordinator();
}

export function isExitPlanModeTool(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode";
}

/** CCB injects `plan` via normalizeToolInput before can_use_tool. */
export function extractExitPlanMarkdown(input: Record<string, unknown> | null | undefined): string {
  if (!input) return "";
  const plan = input.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan : "";
}

/** Prefer the server-carried absolute expiry; fall back to ts + role TTL for
 *  old rows that never received `_askUserExpiresAt`. */
export function permissionExpiresAt(msg: ChatMessage): number {
  const expiresAt = msg._askUserExpiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  if (!Number.isFinite(msg.ts)) return Number.POSITIVE_INFINITY;
  const ttlMs = isDetachedAskUserCard(msg) || isExitPlanModeTool(msg.toolName)
    ? DETACHED_ASK_USER_TTL_MS : PENDING_PERMISSION_TTL_MS;
  return msg.ts + ttlMs;
}

export function permissionHasExpired(msg: ChatMessage, now = Date.now()): boolean {
  return now >= permissionExpiresAt(msg);
}

export function permissionRemainingMs(msg: ChatMessage, now: number): number {
  const expiresAt = permissionExpiresAt(msg);
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0;
}

/** 剩余时长文案(审计 PC-06):≥ 90 分钟按小时说(detached ask_user 的 24h 不再显示「约 1440 分钟」)。 */
export function formatPermissionRemaining(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes >= 90) return `约 ${Math.ceil(minutes / 60)} 小时内有效`;
  return `约 ${minutes} 分钟内有效`;
}

/** A prompt the runtime is (as far as this browser can tell) still blocked on:
 *  unresolved, no durable response in flight, and inside the server TTL.
 *  MessageRenderer uses it to decide whether an unresolved card in the current
 *  segment may be treated as live even when `sending` is false — the
 *  INC-20260904 case where the turn belongs to a master-authored `m-recover-*`
 *  row this tab never adopted, so `_sendingInFlight` stayed false while the
 *  engine sat in waitingForUserInput. */
export function isAwaitingPermissionPrompt(msg: ChatMessage, now = Date.now()): boolean {
  if (msg.role !== "permission") return false;
  if (msg._resolved === true || msg._controlPending === true) return false;
  return !permissionHasExpired(msg, now);
}
