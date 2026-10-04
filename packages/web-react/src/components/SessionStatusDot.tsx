import {
  SIDEBAR_DOT_LABELS,
  type SessionStatusInput,
  type SidebarDotKind,
  resolveSidebarDot,
} from "../lib/sessionStatus";
import { cn } from "../lib/utils";

/**
 * 侧栏会话状态标记。四态靠**形状 + 颜色**双重区分，不只靠色相（SD-01 / SIDEBAR-R1）：
 * - running：细线旋转环（进行中的通用语汇）；reduce-motion 下静止为缺口环，形状仍可辨；
 * - unread：实心 accent 点（「有新结果未看」的通用语汇，不再用一排绿灯制造噪声）；
 * - error / service_restart：实心点 + 同色柔光晕。
 */
const TONE: Record<Exclude<SidebarDotKind, "none">, string> = {
  running:
    "size-2.5 rounded-full border-[1.5px] border-info border-r-transparent oc-session-running",
  unread: "size-[7px] rounded-full bg-accent",
  error: "size-[7px] rounded-full bg-danger ring-[3px] ring-danger/20",
  service_restart: "size-[7px] rounded-full bg-warning ring-[3px] ring-warning/20",
};

export function SessionStatusDot({
  running,
  lastOutcome,
  lastErrorCode,
  unread,
  className,
}: SessionStatusInput & { unread?: boolean; className?: string }) {
  const kind = resolveSidebarDot({ running, lastOutcome, lastErrorCode }, unread);
  if (kind === "none") return null;
  const label = SIDEBAR_DOT_LABELS[kind];
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      data-dot-kind={kind}
      className={cn("inline-block shrink-0", TONE[kind], className)}
    />
  );
}
