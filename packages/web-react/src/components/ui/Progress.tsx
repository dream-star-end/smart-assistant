import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
}

/**
 * 进度条。value 0–100(内部 clamp)。配额 / 用量 / 同步进度共用,填充走极光渐变。
 * `...props` 透传到外层 div,调用方可补 aria-label / id 给 progressbar 一个可访问名。
 */
export function Progress({ value, className, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-hover", className)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-grad-cta transition-[width] duration-300 ease-standard"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
