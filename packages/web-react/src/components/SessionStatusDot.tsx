import { SIDEBAR_DOT_LABELS, type SessionStatusInput, resolveSidebarDot } from "../lib/sessionStatus";
import { SIDEBAR_DOT_STATUS } from "../lib/ui/statusTone";
import { StatusPill } from "./ui/StatusPill";

/**
 * 侧栏会话状态标记 —— StatusPill 的薄封装。判定仍在 sessionStatus.resolveSidebarDot,
 * 悬停 / 读屏文案仍是侧栏的 SIDEBAR_DOT_LABELS;形状和颜色交给 StatusPill(状态表 + --status-* 别名)。
 * 四态靠**形状 + 颜色**双重区分,不只靠色相(SD-01 / SIDEBAR-R1):
 * - running:细线旋转环;reduce-motion 下静止为缺口环,形状仍可辨;
 * - unread:实心点;
 * - error / service_restart:实心点 + 同色柔光晕。
 */
export function SessionStatusDot({
  running,
  lastOutcome,
  lastErrorCode,
  unread,
  className,
}: SessionStatusInput & { unread?: boolean; className?: string }) {
  const kind = resolveSidebarDot({ running, lastOutcome, lastErrorCode }, unread);
  if (kind === "none") return null;
  return (
    <StatusPill
      status={SIDEBAR_DOT_STATUS[kind]}
      label={SIDEBAR_DOT_LABELS[kind]}
      size="md"
      mark={kind === "running" ? "ring" : "dot"}
      data-dot-kind={kind}
      className={className}
    />
  );
}
