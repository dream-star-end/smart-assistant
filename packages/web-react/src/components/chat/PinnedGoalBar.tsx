import { ChevronDown, Target } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { formatDurationSeconds } from "../../lib/chat/pure";
import { cn, groupDigits } from "../../lib/utils";

const STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "阻塞",
  completed: "已完成",
  complete: "已完成",
  usagelimited: "用量受限",
  budgetlimited: "预算到顶",
};

/** Latest goal that is still an objective. A newer cleared row hides the bar. */
export function latestVisibleGoal(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "goal") continue;
    const status = (message.goalStatus ?? "").trim().toLowerCase();
    if (message.cleared === true || status === "cleared") return null;
    return message;
  }
  return null;
}

/** One line above the composer. The transcript does not repeat this card. */
export function PinnedGoalBar({ messages }: { messages: ChatMessage[] }) {
  const message = latestVisibleGoal(messages);
  const [open, setOpen] = useState(false);
  const [inside, setInside] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [message?.id]);
  useEffect(() => {
    if (!open || inside) return;
    const timer = window.setTimeout(() => setOpen(false), 3000);
    return () => window.clearTimeout(timer);
  }, [open, inside, message?.id]);
  if (!message) return null;
  const status = (message.goalStatus ?? "active").trim().toLowerCase();
  const label = STATUS_LABEL[status] || message.goalStatus || "进行中";
  const used = groupDigits(String(message.tokensUsed ?? 0));
  const budget = message.tokenBudget == null ? "" : `/${groupDigits(String(message.tokenBudget))}`;
  const elapsed = formatDurationSeconds(message.timeUsedSeconds);
  const stat = [used ? `${used}${budget}` : "", elapsed].filter(Boolean).join(" · ");
  const text = message.text || "会话目标";
  return (
    <div
      className="mx-auto mb-2 max-w-3xl px-4"
      data-testid="pinned-goal"
      onPointerEnter={() => setInside(true)}
      onPointerLeave={() => setInside(false)}
    >
      <button
        type="button"
        className="oc-surface-glass oc-btn-tactile flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="oc-icon-badge oc-icon-badge-accent flex size-6 shrink-0 items-center justify-center rounded-sm">
          <Target size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-caption font-medium text-accent">{label}</span>
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{text}</span>
        <span className="shrink-0 font-mono text-caption tabular-nums text-muted">{stat}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cn("shrink-0 text-faint transition-transform duration-200 ease-[var(--ease-spring)]", open && "rotate-180")}
        />
      </button>
      {open ? (
        <p className="oc-surface-card mt-1.5 rounded-xl px-3.5 py-2.5 text-body leading-relaxed text-fg animate-in">{text}</p>
      ) : null}
    </div>
  );
}
