import { Check, ChevronDown, Cpu } from "lucide-react";
import type { PublicModel } from "../lib/types";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui";

/**
 * 线路展示名。后端 PublicModel.display_name 是权威标签（pricing.ts），但前端类型
 * 宽松透传（`{ id: string; [k]: unknown }`），故运行时做一次 string narrowing，
 * 缺失/非串时退回 model id —— 绝不臆造映射，避免与后端两套权威源漂移。
 */
export function modelLabel(m: PublicModel): string {
  const dn = (m as { display_name?: unknown }).display_name;
  return typeof dn === "string" && dn.trim() ? dn : m.id;
}

/**
 * 对话线路选择器（Aurora 顶栏）。完全由 GET /api/public/models 的结果驱动，
 * 不持有任何硬编码/demo 线路列表（demo 预览的 fixture 由调用方注入）。选中的 model id
 * 上抛给 App 顶层状态，P4 的 WS inbound.message 据此发送（前端只发 agentId + model，
 * agent→model 的最终权威在后端）。
 */
export function ModelSelector({
  models,
  selectedId,
  onSelect,
  loading,
}: {
  models: PublicModel[];
  selectedId?: string;
  onSelect: (id: string) => void;
  loading?: boolean;
}) {
  const selected = models.find((m) => m.id === selectedId);
  const label = selected
    ? modelLabel(selected)
    : loading
      ? "加载线路…"
      : models[0]
        ? modelLabel(models[0])
        : "暂无可用线路";
  const disabled = loading || models.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="选择对话线路"
          className={cn(
            "flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13.5px] font-medium text-muted outline-none transition-colors",
            "hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <Cpu size={14} className="text-faint" />
          <span className="max-w-[160px] truncate">{label}</span>
          <ChevronDown size={14} className="text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuLabel>对话线路</DropdownMenuLabel>
        {models.map((m) => {
          const active = m.id === selectedId;
          return (
            <DropdownMenuItem
              key={m.id}
              onSelect={() => onSelect(m.id)}
              className="justify-between"
            >
              <span className="truncate">{modelLabel(m)}</span>
              {active && <Check size={14} className="shrink-0 text-accent" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
