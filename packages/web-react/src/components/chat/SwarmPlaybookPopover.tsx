/**
 * Composer 蜂群高阶剧本模板快选弹层（OCV5-833 / OCV5-838 · Clarvy Atelier）。
 *
 * 按需经 React.lazy 懒加载，不进首屏主包：
 *   - 基于 Radix Popover 实现自动碰撞避让与 Portal 浮层，彻底告别窄屏裁切与溢出；
 *   - 提供 4 套与 `packages/gateway/src/swarmCommand.ts` 100% 对齐的预设剧本；
 *   - 支持非受控与受控开合（<640px 移动端由 ComposerPlusMenu 触发打开）。
 */
import * as RP from "@radix-ui/react-popover";
import { BookOpenCheck, ChevronDown, Code2, Layers, Scale, X } from "lucide-react";
import { type CSSProperties, type RefObject, useState } from "react";
import {
  SWARM_PLAYBOOK_PRESETS,
  type SwarmPlaybookPreset,
  buildSwarmPlaybookDraft,
} from "../../lib/api/wave4Api";
import { cn } from "../../lib/utils";
import { Badge, IconButton, PopoverContent, useToast } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";

export type SwarmPlaybookPopoverProps = {
  disabled?: boolean;
  currentText: string;
  onSelectPlaybook: (draft: string, preset: SwarmPlaybookPreset) => void;
  /** 可选受控开合态（移动端/桌面从 ComposerPlusMenu 唤起时复用同一弹层）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 可选外部可见锚点引用（避免 `hidden` 触发器导致 Radix Anchor 0×0 定位漂移）。 */
  anchorRef?: RefObject<HTMLElement | null>;
  /** 可选覆盖触发器样式（无 anchorRef 时生效）。 */
  triggerClassName?: string;
};

function presetIcon(id: SwarmPlaybookPreset["id"]) {
  switch (id) {
    case "parallel-impl-verify":
      return <Code2 size={14} strokeWidth={1.85} aria-hidden />;
    case "multi-source-lit-verify":
      return <BookOpenCheck size={14} strokeWidth={1.85} aria-hidden />;
    case "arch-deep-audit":
      return <AtelierIcon name="shield" size={14} />;
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
  open: openProp,
  onOpenChange,
  anchorRef,
  triggerClassName,
}: SwarmPlaybookPopoverProps) {
  const toast = useToast();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp !== undefined ? openProp : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      {anchorRef ? (
        <RP.Anchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      ) : (
        <RP.Anchor className="inline-flex shrink-0 items-center">
          <RP.Trigger asChild>
            <button
              type="button"
              data-testid="composer-swarm-playbooks"
              data-product-control
              aria-expanded={open}
              disabled={disabled}
              title="选择蜂群高阶剧本模板"
              className={cn(
                "oc-btn-tactile oc-spring-press inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-caption font-medium transition-colors [@media(hover:none)]:min-h-10",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                open
                  ? "border-accent/30 bg-accent-soft text-accent"
                  : "border-transparent text-muted hover:bg-hover hover:text-fg",
                triggerClassName,
              )}
            >
              <Layers size={12} strokeWidth={1.85} aria-hidden />
              <span>剧本</span>
              <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
            </button>
          </RP.Trigger>
        </RP.Anchor>
      )}

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        role="dialog"
        aria-label="蜂群高阶剧本模板"
        data-testid="swarm-playbook-popover"
        onFocusOutside={(event) => {
          // 外部 anchorRef 模式下无 RP.Trigger，防止触发器或退场中的「+」菜单焦点回跳误关弹层（OCV5-861）。
          if (!anchorRef) return;
          const target = event.target as HTMLElement | null;
          if (target && (anchorRef.current?.contains(target) || target.closest?.('[role="menu"]'))) {
            event.preventDefault();
          }
        }}
        className="w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
          <div className="flex items-center gap-1.5">
            <AtelierIcon name="sparkles" size={14} className="text-accent" />
            <span className="text-meta font-semibold text-fg">蜂群高阶剧本模板</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-micro text-faint">点击一键填入</span>
            <IconButton
              aria-label="关闭剧本模板"
              size="sm"
              shape="square"
              className="oc-spring-press"
              onClick={() => setOpen(false)}
            >
              <X size={13} />
            </IconButton>
          </div>
        </div>

        <div className="max-h-[min(20rem,55dvh)] space-y-1.5 overflow-y-auto p-2">
          {SWARM_PLAYBOOK_PRESETS.map((preset, idx) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`swarm-playbook-option-${preset.id}`}
              style={{ "--stagger-i": idx } as CSSProperties}
              onClick={() => {
                const draft = buildSwarmPlaybookDraft(preset, currentText);
                onSelectPlaybook(draft, preset);
                toast(`已载入剧本「${preset.title}」`, "success");
                setOpen(false);
              }}
              className="oc-stagger-in oc-spring-press group flex w-full flex-col gap-1.5 rounded-xl border border-transparent bg-bg p-2.5 text-left outline-none transition-all hover:border-border hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
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
      </PopoverContent>
    </RP.Root>
  );
}

export default SwarmPlaybookPopover;
