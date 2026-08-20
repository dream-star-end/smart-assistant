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
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE[kind], className)}
    />
  );
}
