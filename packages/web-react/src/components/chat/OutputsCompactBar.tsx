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
      className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface px-2.5 text-caption text-muted"
      data-testid="outputs-compact-strip"
    >
      {multiTurn && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="上一轮"
            disabled={turnIndex <= 0}
            onClick={onPrevTurn}
            className="inline-flex size-6 items-center justify-center rounded text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="tabular-nums text-faint" data-testid="outputs-turn-counter">
            {turnIndex + 1}/{turnTotal}
          </span>
          <button
            type="button"
            aria-label="下一轮"
            disabled={turnIndex >= turnTotal - 1}
            onClick={onNextTurn}
            className="inline-flex size-6 items-center justify-center rounded text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      )}

      {multiOutput ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="outputs-compact-file-picker"
              className="inline-flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-0.5 text-left text-caption font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
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
                  className={cn(active && "bg-accent-soft text-accent")}
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
                  className={cn(active && "bg-accent-soft text-accent")}
                >
                  <span className="truncate">{m.name}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium text-fg" data-testid="outputs-hero-name">
          {heroName ?? ""}
        </span>
      )}

      {viewOptions && viewOptions.length > 1 && view && onChangeView && (
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="查看方式">
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
                  "inline-flex size-6 items-center justify-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
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
