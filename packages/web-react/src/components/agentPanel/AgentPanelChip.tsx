/**
 * 窄屏（<md）入口 chip（PRD F1.5，DESIGN §8.1）：「Agent 电脑 · 终端 · 4/7 ● ˄」。
 * 挂在 composer 上方 HUD 容器内，只占一行；点开贴底 Sheet。turn 收口后由宿主不再渲染。
 */
import { ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ToolStatusKind } from "../tool/status";
import type { ActionKindMeta } from "./actionKind";
import { chipLabel } from "./strings";

const TONE_TEXT: Record<ActionKindMeta["tone"], string> = {
  accent: "text-accent",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  neutral: "text-muted",
};

/** 状态点颜色（rail 与 chip 共用，DESIGN §7）。 */
export const STATUS_DOT_CLS: Record<ToolStatusKind, string> = {
  running: "bg-accent animate-pulse motion-reduce:animate-none",
  done: "bg-success",
  error: "bg-danger",
  blocked: "bg-warning",
  cancelled: "bg-faint",
};

export function AgentPanelChip({
  kind,
  k,
  n,
  status,
  onClick,
  className,
}: {
  kind: ActionKindMeta;
  k: number;
  n: number;
  status: ToolStatusKind;
  onClick: () => void;
  className?: string;
}) {
  const Icon = kind.icon;
  const label = chipLabel(kind.label, k, n);
  return (
    <div className={cn("mx-auto mb-2 w-full max-w-3xl px-4 md:hidden", className)}>
      <button
        type="button"
        data-agent-chip=""
        aria-label={label}
        onClick={onClick}
        className="flex min-h-11 w-full items-center gap-2 rounded-full border border-border bg-elevated px-3 text-left shadow-soft outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon size={14} className={cn("shrink-0", TONE_TEXT[kind.tone])} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-body text-fg">{label}</span>
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_CLS[status])} aria-hidden />
        <ChevronUp size={14} className="shrink-0 text-faint" aria-hidden />
      </button>
    </div>
  );
}
