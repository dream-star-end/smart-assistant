/**
 * Codex 风格单文件精读顶栏 / 移动端紧凑微条（OCV5-820 / OCV5-834）：
 *   - 多产物进入精读态：左侧「← 文件列表 (N)」+ 当前文件名 + 右侧轻量 `‹ ›` 切换下一份（+ 紧凑模式视图切换）；
 *   - 单产物多轮紧凑态：清晰的「‹ 第 X/Y 轮 ›」+ 文件名 + 视图切换（告别迷惑的裸 `< 8/8 >`）；
 *   - 单轮单产物紧凑态：不渲染，直接全出血进入预览正文。
 */
import { ArrowLeft, ChevronLeft, ChevronRight, Code2, Eye, FileDiff } from "lucide-react";
import { cn } from "../../lib/utils";
import type { HeroRef, TurnOutputs } from "./workbench";

export type CompactHeroView = "preview" | "source" | "changes";

function listDeliverables(outputs: TurnOutputs): HeroRef[] {
  return [
    ...outputs.files.map((f): HeroRef => ({ type: "file", path: f.path })),
    ...outputs.media.map((m): HeroRef => ({ type: "media", src: m.src })),
  ];
}

function activeDeliverableIndex(items: readonly HeroRef[], hero: HeroRef | null): number {
  if (!hero) return -1;
  return items.findIndex((item) =>
    item.type === "file" && hero.type === "file"
      ? item.path === hero.path
      : item.type === "media" && hero.type === "media" && item.src === hero.src,
  );
}

export function OutputsCompactBar({
  turnIndex,
  turnTotal,
  onPrevTurn,
  onNextTurn,
  outputs,
  hero,
  heroName,
  onPick,
  onBackToList,
  showFileName = true,
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
  /** 多产物精读态返回「文件目录总览」的回调。 */
  onBackToList?: () => void;
  /** 是否在本条中渲染当前文件名（桌面端 FileHero 自带文件名头部时可关闭，避免重复）。 */
  showFileName?: boolean;
  view?: CompactHeroView;
  viewOptions?: readonly { value: CompactHeroView; label: string }[];
  onChangeView?: (v: CompactHeroView) => void;
}) {
  const deliverables = listDeliverables(outputs);
  const deliverableCount = deliverables.length;
  const multiTurn = turnTotal > 1;
  const multiOutput = deliverableCount > 1;
  const showBack = Boolean(onBackToList && multiOutput);

  if (!showBack && !multiTurn) return null;

  const curIdx = activeDeliverableIndex(deliverables, hero);
  const canPrevFile = showBack && curIdx > 0;
  const canNextFile = showBack && curIdx >= 0 && curIdx < deliverableCount - 1;

  return (
    <div
      className="oc-surface-glass flex min-h-10 shrink-0 items-center gap-1.5 border-b border-border/75 px-2.5 py-1 text-caption text-muted"
      data-testid="outputs-compact-strip"
    >
      {showBack ? (
        <button
          type="button"
          onClick={onBackToList}
          aria-label="返回文件列表"
          data-testid="outputs-back-to-list"
          className="oc-btn-tactile inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-9"
        >
          <ArrowLeft size={13} aria-hidden />
          <span>文件列表</span>
          <span className="tabular-nums text-faint">({deliverableCount})</span>
        </button>
      ) : multiTurn ? (
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
          <span className="px-1.5 font-medium tabular-nums text-fg" data-testid="outputs-turn-counter">
            第 {turnIndex + 1}/{turnTotal} 轮
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
      ) : null}

      {showFileName ? (
        <span
          className="min-w-0 flex-1 truncate px-1 text-meta font-medium text-fg"
          data-testid="outputs-hero-name"
          title={heroName}
        >
          {heroName ?? ""}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      {showBack && curIdx >= 0 && (
        <div className="oc-surface-recessed flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
          <button
            type="button"
            aria-label="上一份文件"
            title="上一份文件"
            disabled={!canPrevFile}
            onClick={() => {
              const target = deliverables[curIdx - 1];
              if (target) onPick(target);
            }}
            className="oc-btn-tactile inline-flex size-6 items-center justify-center rounded-xs text-muted outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            aria-label="下一份文件"
            title="下一份文件"
            disabled={!canNextFile}
            onClick={() => {
              const target = deliverables[curIdx + 1];
              if (target) onPick(target);
            }}
            className="oc-btn-tactile inline-flex size-6 items-center justify-center rounded-xs text-muted outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={13} />
          </button>
        </div>
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
