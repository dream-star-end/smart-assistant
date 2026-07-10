import { ArrowDown, ArrowUp, Minus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, Skeleton } from "../../components/ui";
import { cn } from "../../lib/utils";

export type StatTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const iconToneClass: Record<StatTone, string> = {
  neutral: "bg-hover text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

/** delta 趋势：视觉语义由页面决定（涨对某些指标是坏事时传 down/flat 即可）。 */
export type StatDelta = { value: ReactNode; trend?: "up" | "down" | "flat" };

const trendMeta = {
  up: { cls: "text-success", Icon: ArrowUp },
  down: { cls: "text-danger", Icon: ArrowDown },
  flat: { cls: "text-faint", Icon: Minus },
} as const;

/**
 * KPI 卡：标签 + 大数值（tabular-nums 等宽对齐）+ 可选 hint / 升降 delta / 图标芯片。
 * loading 时整卡骨架化。数值一律走 tabular-nums，避免逐秒轮询时数字宽度跳动。
 */
export function StatCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  tone = "neutral",
  loading,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  delta?: StatDelta;
  icon?: LucideIcon;
  tone?: StatTone;
  loading?: boolean;
  className?: string;
}) {
  if (loading) {
    return (
      <Card className={cn("flex flex-col gap-3 p-4", className)}>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-16" />
      </Card>
    );
  }
  const t = delta?.trend ? trendMeta[delta.trend] : null;
  return (
    <Card className={cn("flex items-start justify-between gap-3 p-4", className)}>
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium text-faint">{label}</p>
        <p className="mt-1.5 text-[22px] font-semibold leading-none text-fg tabular-nums">
          {value}
        </p>
        {(hint || delta) && (
          <div className="mt-2 flex items-center gap-2 text-[12px]">
            {delta && t && (
              <span className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", t.cls)}>
                <t.Icon size={13} />
                {delta.value}
              </span>
            )}
            {hint && <span className="truncate text-faint">{hint}</span>}
          </div>
        )}
      </div>
      {Icon && (
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            iconToneClass[tone],
          )}
        >
          <Icon size={18} />
        </span>
      )}
    </Card>
  );
}

/** KPI 卡响应式栅格（默认 2 列 → 大屏 4 列）。 */
export function StatCardRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>
  );
}
