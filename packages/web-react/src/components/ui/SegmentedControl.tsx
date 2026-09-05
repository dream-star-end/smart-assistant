import { cva } from "class-variance-authority";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * 分段单选(segmented control)。
 *
 * 与 Tabs 的分工:Tabs 切换的是**面板内容**(role=tablist,需配 tabpanel);
 * SegmentedControl 切换的是**一个值**(视图密度、排序方式、时间范围、模式开关),
 * 语义上是单选组 —— role=radiogroup + radio,`aria-checked` 表达选中。
 * 审计里全仓有 10+ 处用 Tabs 或手写 button 组来做"选一个值",读屏会宣告"选项卡"却找不到面板。
 *
 * 键盘:←/→ 循环切换(跳过 disabled),Home/End 到首尾;roving tabindex,选中项可 Tab 聚焦。
 * 窄屏:容器 `max-w-full overflow-x-auto no-scrollbar`,项 `shrink-0 whitespace-nowrap`,
 * 选项多时可横滑而不撑破父级。字号走 text-meta / text-body 语义档,不写任意值。
 */
const groupClass =
  "no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-full bg-hover p-0.5";

const itemVariants = cva(
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full font-medium outline-none transition-colors duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 [@media(hover:none)]:min-h-9",
  {
    variants: {
      size: {
        md: "px-3 py-1 text-body",
        sm: "px-2.5 py-0.5 text-meta",
      },
      checked: {
        true: "bg-surface text-fg shadow-soft",
        false: "text-muted hover:text-fg",
      },
    },
    defaultVariants: { size: "md", checked: false },
  },
);

export interface SegmentedControlProps<V extends string = string> {
  value: V;
  onValueChange: (v: V) => void;
  options: readonly SegmentedOption<V>[];
  size?: "md" | "sm";
  /** 整组禁用。 */
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export function SegmentedControl<V extends string = string>({
  value,
  onValueChange,
  options,
  size = "md",
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: SegmentedControlProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabledIdx = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);

  const onKeyDown = (e: KeyboardEvent, idx: number) => {
    if (enabledIdx.length === 0) return;
    const pos = enabledIdx.indexOf(idx);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = enabledIdx[pos === -1 || pos === enabledIdx.length - 1 ? 0 : pos + 1];
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = enabledIdx[pos <= 0 ? enabledIdx.length - 1 : pos - 1];
    } else if (e.key === "Home") next = enabledIdx[0];
    else if (e.key === "End") next = enabledIdx[enabledIdx.length - 1];
    if (next === -1) return;
    e.preventDefault();
    onValueChange(options[next].value);
    refs.current[next]?.focus();
  };

  // 选中项落在 disabled 上(外部状态漂移)时,让第一个可用项承接 Tab 焦点,组内始终有一个可聚焦点。
  const activeIndex = options.findIndex((o) => o.value === value);
  const focusIndex =
    activeIndex >= 0 && enabledIdx.includes(activeIndex) ? activeIndex : (enabledIdx[0] ?? -1);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-disabled={disabled || undefined}
      className={cn(groupClass, className)}
    >
      {options.map((opt, i) => {
        const checked = opt.value === value;
        const itemDisabled = disabled || !!opt.disabled;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: 分段控件是富样式 button 组,按 WAI-ARIA radio 模式补语义(与 PermissionCard 同一约定)
            role="radio"
            aria-checked={checked}
            disabled={itemDisabled}
            tabIndex={i === focusIndex ? 0 : -1}
            onClick={() => {
              if (!checked) onValueChange(opt.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(itemVariants({ size, checked }))}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
