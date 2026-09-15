import {
  SIDEBAR_DOT_LABELS,
  type SessionStatusInput,
  type SidebarDotKind,
  resolveSidebarDot,
} from "../lib/sessionStatus";
import { cn } from "../lib/utils";

const TONE: Record<Exclude<SidebarDotKind, "none">, string> = {
  running: "bg-info oc-session-running",
  unread: "bg-success",
  error: "bg-danger",
  service_restart: "bg-warning",
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
  // 6px 的点在深色主题与小屏上难以分辨四态，放大到 8px（SD-01）；出错态额外描一圈同色环，
  // 与运行 / 未读的实心点在形状上也有区分，不只靠颜色。
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TONE[kind],
        (kind === "error" || kind === "service_restart") && "ring-2 ring-current/25",
        className,
      )}
    />
  );
}
