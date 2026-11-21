/**
 * 移动端紧凑态极轻单行微条（~32px，OCV5-820）：
 * 仅在多轮或多产物时出现，提供「轮次切换 + 文件切换 + 预览/源码图标切换」；
 * 单轮单文件时不渲染，直接全出血进入预览正文。
 */
import { ChevronDown, ChevronLeft, ChevronRight, Code2, Eye, FileDiff } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui";
import type { HeroRef, TurnOutputs } from "./workbench";

export type CompactHeroView = "preview" | "source" | "changes";

export function OutputsCompactBar({
  turnIndex,
  turnTotal,
  onPrevTurn,
  onNextTurn,
  outputs,
  hero,
  heroName,
  onPick,
  view,
  viewOptions,
  onChangeView,
}: {
  turnIndex: number;
  turnTotal: number;
  onPrevTurn: () => void;
  onNextTurn: () => void;
  outputs: TurnOutputs;
  hero: HeroRef | null;
  heroName?: string;
  onPick: (ref: HeroRef) => void;
  view?: CompactHeroView;
  viewOptions?: readonly { value: CompactHeroView; label: string }[];
  onChangeView?: (v: CompactHeroView) => void;
}) {
  const deliverableCount = outputs.files.length + outputs.media.length;
  const multiTurn = turnTotal > 1;
  const multiOutput = deliverableCount > 1;
  if (!multiTurn && !multiOutput) return null;

  return (
    <div
      className="oc-surface-glass flex h-9 shrink-0 items-center gap-1.5 border-b border-border/75 px-2.5 text-caption text-muted"
      data-testid="outputs-compact-strip"
    >
      {multiTurn && (
        <div className="oc-surface-recessed flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
          <button
            type="button"
            aria-label="上一轮"
            disabled={turnIndex <= 0}
            onClick={onPrevTurn}
            className="oc-btn-tactile inline-flex size-5 items-center justify-center rounded-xs text-muted outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="px-1 font-medium tabular-nums text-fg" data-testid="outputs-turn-counter">
            {turnIndex + 1}/{turnTotal}
          </span>
          <button
            type="button"
            aria-label="下一轮"
            disabled={turnIndex >= turnTotal - 1}
            onClick={onNextTurn}
            className="oc-btn-tactile inline-flex size-5 items-center justify-center rounded-xs text-muted outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      )}

      {multiOutput ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="outputs-compact-file-picker"
              className="oc-btn-tactile inline-flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-caption font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate" data-testid="outputs-hero-name">
                {heroName ?? "选择产物"}
              </span>
              <span className="shrink-0 tabular-nums text-faint">({deliverableCount})</span>
              <ChevronDown size={12} className="shrink-0 text-faint" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-[70] max-w-[18rem]">
            {outputs.files.map((f) => {
              const active = hero?.type === "file" && hero.path === f.path;
              return (
                <DropdownMenuItem
                  key={f.path}
                  onSelect={() => onPick({ type: "file", path: f.path })}
                  className={cn(active && "bg-accent-soft font-medium text-accent")}
                >
                  <span className="truncate">{f.name}</span>
                </DropdownMenuItem>
              );
            })}
            {outputs.media.map((m) => {
              const active = hero?.type === "media" && hero.src === m.src;
              return (
                <DropdownMenuItem
                  key={m.src}
                  onSelect={() => onPick({ type: "media", src: m.src })}
                  className={cn(active && "bg-accent-soft font-medium text-accent")}
                >
                  <span className="truncate">{m.name}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="min-w-0 flex-1 truncate px-1 font-medium text-fg" data-testid="outputs-hero-name">
          {heroName ?? ""}
        </span>
      )}

      {viewOptions && viewOptions.length > 1 && view && onChangeView && (
        <div className="oc-surface-recessed flex shrink-0 items-center gap-0.5 rounded-md p-0.5" role="group" aria-label="查看方式">
          {viewOptions.map((opt) => {
            const active = opt.value === view;
            const Icon = opt.value === "preview" ? Eye : opt.value === "source" ? Code2 : FileDiff;
            return (
              <button
                key={opt.value}
                type="button"
                aria-label={opt.label}
                aria-pressed={active}
                title={opt.label}
                onClick={() => onChangeView(opt.value)}
                className={cn(
                  "oc-btn-tactile inline-flex size-6 items-center justify-center rounded-xs outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "oc-segmented-thumb text-accent" : "text-muted hover:text-fg",
                )}
              >
                <Icon size={13} aria-hidden />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
