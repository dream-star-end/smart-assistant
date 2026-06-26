import { ChevronRight, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import type { ToolCard as ToolCardT } from "../lib/types";
import { cn } from "../lib/utils";
import { Badge } from "./ui";

type Tone = "accent" | "success" | "warning" | "danger";

// 状态 → 中文标签 + 语义色调 + 是否进行中（spinner）。P4 流式工具卡 pending/running 动效。
// 色调统一走设计系统 Badge tone（不再硬编码 emerald/amber）。
const STATUS_META: Record<string, { label: string; tone: Tone; spinning: boolean }> = {
  pending: { label: "排队中", tone: "accent", spinning: true },
  running: { label: "运行中", tone: "accent", spinning: true },
  ok: { label: "完成", tone: "success", spinning: false },
  warn: { label: "提示", tone: "warning", spinning: false },
  error: { label: "失败", tone: "danger", spinning: false },
};

const ICON_TONE: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function ToolCard({ card }: { card: ToolCardT }) {
  const [open, setOpen] = useState(false);
  const has = (card.evidence?.length ?? 0) > 0;
  const meta = STATUS_META[card.status] ?? {
    label: card.status,
    tone: "accent" as Tone,
    spinning: false,
  };
  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-border bg-surface">
      <button
        onClick={() => has && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left",
          has && "cursor-pointer hover:bg-hover",
        )}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            ICON_TONE[meta.tone],
          )}
        >
          {meta.spinning ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
        </span>
        <span className="text-[13px] font-medium text-fg">{card.title}</span>
        <span className="ml-auto flex items-center gap-2">
          <Badge tone={meta.tone} aria-label={`状态：${meta.label}`}>
            {meta.label}
          </Badge>
          {has && (
            <ChevronRight
              size={15}
              className={cn("text-faint transition-transform", open && "rotate-90")}
            />
          )}
        </span>
      </button>
      {open && has && (
        <div className="border-t border-border px-3.5 py-2.5">
          <ul className="space-y-1 font-mono text-xs text-muted">
            {card.evidence!.map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
