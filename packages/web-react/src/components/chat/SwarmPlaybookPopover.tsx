/**
 * Composer 蜂群高阶剧本模板快选弹层（OCV5-833 · Clarvy Atelier）。
 *
 * 按需经 React.lazy 懒加载，不进首屏主包：
 *   提供 4 套与 `packages/gateway/src/swarmCommand.ts` 100% 对齐的预设剧本：
 *     1. 并行实现+验收（parallel-impl-verify）
 *     2. 多源文献深研+核验（multi-source-lit-verify）
 *     3. 架构深度体检（arch-deep-audit）
 *     4. 多方案评审（multi-option-review）
 *   点击任意剧本一键填充结构化指令到 Composer，并自动开启蜂群模式。
 */
import { BookOpenCheck, ChevronDown, Code2, Layers, Scale, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  SWARM_PLAYBOOK_PRESETS,
  type SwarmPlaybookPreset,
  buildSwarmPlaybookDraft,
} from "../../lib/api/wave4Api";
import { cn } from "../../lib/utils";
import { Badge, IconButton, useToast } from "../ui";

export type SwarmPlaybookPopoverProps = {
  disabled?: boolean;
  currentText: string;
  onSelectPlaybook: (draft: string, preset: SwarmPlaybookPreset) => void;
};

function presetIcon(id: SwarmPlaybookPreset["id"]) {
  switch (id) {
    case "parallel-impl-verify":
      return <Code2 size={14} strokeWidth={1.85} aria-hidden />;
    case "multi-source-lit-verify":
      return <BookOpenCheck size={14} strokeWidth={1.85} aria-hidden />;
    case "arch-deep-audit":
      return <ShieldCheck size={14} strokeWidth={1.85} aria-hidden />;
    case "multi-option-review":
      return <Scale size={14} strokeWidth={1.85} aria-hidden />;
  }
}

function categoryTone(category: SwarmPlaybookPreset["category"]): "accent" | "info" | "warning" {
  if (category === "research") return "info";
  if (category === "decision") return "warning";
  return "accent";
}

export function SwarmPlaybookPopover({
  disabled = false,
  currentText,
  onSelectPlaybook,
}: SwarmPlaybookPopoverProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-testid="composer-swarm-playbooks"]')) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="relative inline-flex shrink-0 items-center">
      <button
        type="button"
        data-testid="composer-swarm-playbooks"
        data-product-control
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="选择蜂群高阶剧本模板"
        className={cn(
          "oc-btn-tactile inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-caption font-medium transition-colors [@media(hover:none)]:min-h-10",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          open
            ? "border-accent/30 bg-accent-soft text-accent"
            : "border-transparent text-muted hover:bg-hover hover:text-fg",
        )}
      >
        <Layers size={12} strokeWidth={1.85} aria-hidden />
        <span>剧本</span>
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="蜂群高阶剧本模板"
          data-testid="swarm-playbook-popover"
          className={cn(
            "oc-surface-popover absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-float outline-none animate-in",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-accent" aria-hidden />
              <span className="text-meta font-semibold text-fg">蜂群高阶剧本模板</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-micro text-faint">点击一键填入</span>
              <IconButton aria-label="关闭剧本模板" size="sm" shape="square" onClick={() => setOpen(false)}>
                <X size={13} />
              </IconButton>
            </div>
          </div>

          <div className="max-h-80 space-y-1.5 overflow-y-auto p-2">
            {SWARM_PLAYBOOK_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`swarm-playbook-option-${preset.id}`}
                onClick={() => {
                  const draft = buildSwarmPlaybookDraft(preset, currentText);
                  onSelectPlaybook(draft, preset);
                  toast(`已载入剧本「${preset.title}」`, "success");
                  setOpen(false);
                }}
                className="group flex w-full flex-col gap-1.5 rounded-xl border border-transparent bg-bg p-2.5 text-left outline-none transition-all hover:border-border hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center gap-2">
                  <span className="oc-icon-badge oc-icon-badge-accent size-7 shrink-0 rounded-lg">
                    {presetIcon(preset.id)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-meta font-semibold text-fg group-hover:text-accent">
                        {preset.title}
                      </span>
                      <Badge tone={categoryTone(preset.category)} size="sm">
                        {preset.categoryLabel}
                      </Badge>
                    </div>
                  </div>
                </div>
                <p className="text-caption leading-relaxed text-muted">{preset.summary}</p>
                <div className="flex flex-wrap items-center gap-1">
                  {preset.roles.map((role) => (
                    <span
                      key={role}
                      className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-micro text-faint"
                    >
                      @{role}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default SwarmPlaybookPopover;
