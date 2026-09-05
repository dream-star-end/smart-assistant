import { type VariantProps, cva } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 可点击的药丸筛选项(filter chip)。
 *
 * 与 Badge 的分工:Badge 是**只读**状态标签(span),Chip 是**可交互**的开关/筛选(button),
 * 带 `aria-pressed` 表达选中态。审计里全仓有 20+ 处手写的 `rounded-full border px-2.5 py-1
 * text-[12px]` 筛选药丸,选中态的底色/边框/字色三处各自漂移 —— 这条不变量收进原语。
 *
 * 字号一律走语义 token(text-meta / text-caption),不写任意值;触屏下补触控靶
 * `[@media(hover:none)]:min-h-9`(桌面 hover 可用时渲染零变化)。
 */
export const chipVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border font-medium outline-none transition-colors duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 [@media(hover:none)]:min-h-9",
  {
    variants: {
      selected: {
        true: "border-accent bg-accent-soft text-accent",
        false: "border-border bg-surface text-muted hover:border-fg/30 hover:text-fg",
      },
      size: {
        md: "px-2.5 py-1 text-meta",
        sm: "px-2 py-0.5 text-caption",
      },
    },
    defaultVariants: { selected: false, size: "md" },
  },
);

export interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">,
    VariantProps<typeof chipVariants> {
  /** 选中态;同时落 `aria-pressed`,读屏能听到"已按下"。 */
  selected?: boolean;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, selected = false, size, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      className={cn(chipVariants({ selected, size }), className)}
      {...props}
    />
  );
});
