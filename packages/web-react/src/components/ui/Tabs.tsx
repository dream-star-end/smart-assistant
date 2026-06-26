import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: ReactNode;
}

/**
 * 无障碍分段 Tabs(WAI-ARIA tablist)。受控:value 由调用方持有。
 * 容器 role=tablist,每项 role=tab + aria-selected;roving tabindex(选中项可 Tab 聚焦,
 * 其余 -1)+ 左右 / Home / End 键盘导航。面板由调用方按 value 条件渲染,本组件只管 tablist。
 * 视觉为分段药丸(segmented),用于设置中心、计费等就地视图切换。
 */
export function Tabs({
  value,
  onValueChange,
  items,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: TabItem[];
  className?: string;
  "aria-label"?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, idx: number) => {
    const last = items.length - 1;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = idx === last ? 0 : idx + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = idx === 0 ? last : idx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === -1) return;
    e.preventDefault();
    onValueChange(items[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex gap-1 rounded-full bg-hover p-1", className)}
    >
      {items.map((it, i) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(it.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "whitespace-nowrap rounded-full px-4 py-1.5 text-[13px] font-medium outline-none transition-colors duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-surface text-fg shadow-soft" : "text-muted hover:text-fg",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
