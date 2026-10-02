import { useEffect, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { formatDurationSeconds } from "../../lib/chat/pure";
import { groupDigits } from "../../lib/utils";

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
        className="flex min-h-9 w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">{label}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{text}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted">{stat}</span>
      </button>
      {open ? (
        <p className="mt-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm leading-6 text-fg">{text}</p>
      ) : null}
    </div>
  );
}
