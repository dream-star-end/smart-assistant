import {
  SESSION_STATUS_LABELS,
  type SessionStatusInput,
  type SessionStatusKind,
  resolveSessionStatus,
} from "../lib/sessionStatus";
import { cn } from "../lib/utils";

const TONE: Record<Exclude<SessionStatusKind, "none">, string> = {
  running: "bg-success oc-session-running",
  completed: "bg-success",
  interrupted: "bg-success",
  error: "bg-danger",
  service_restart: "bg-warning",
};

export function SessionStatusDot({
  running,
  lastOutcome,
  lastErrorCode,
  className,
}: SessionStatusInput & { className?: string }) {
  const kind = resolveSessionStatus({ running, lastOutcome, lastErrorCode });
  if (kind === "none") return null;
  const label = SESSION_STATUS_LABELS[kind];
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE[kind], className)}
    />
  );
}
