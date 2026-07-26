import { ArrowDown, ArrowUp, type LucideIcon, Minus } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Card } from "./Card";
import { Skeleton } from "./Skeleton";
import { cn } from "../../lib/utils";

/**
 * KPI 卡:标签 + 大数值(tabular-nums 等宽对齐)+ 可选 hint / 升降 delta / 图标芯片。
 * loading 时整卡骨架化。
 *
 * 存在的理由:原本只有 admin 有这套卡,用户侧(管理中心额度、市场作者收益)各写各的
 * "一个 div 里塞标签和数字",行高与数字对齐全靠手调。数值一律走 tabular-nums,避免
 * 轮询刷新时数字宽度跳动。
 */

export type StatTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const iconToneClass: Record<StatTone, string> = {
  neutral: "bg-hover text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

/** delta 趋势:视觉语义由页面决定(涨对某些指标是坏事时传 down/flat 即可)。 */
export type StatDelta = { value: ReactNode; trend?: "up" | "down" | "flat" };

const trendMeta = {
  up: { cls: "text-success", Icon: ArrowUp },
  down: { cls: "text-danger", Icon: ArrowDown },
  flat: { cls: "text-faint", Icon: Minus },
} as const;

export function StatCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  tone = "neutral",
  loading,
  onClick,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  delta?: StatDelta;
  icon?: LucideIcon;
  tone?: StatTone;
  loading?: boolean;
  /** 传了才变成可点卡(role=button + 键盘可达 + 焦点环);默认是纯展示卡。 */
  onClick?: () => void;
  className?: string;
}) {
  if (loading) {
    return (
      <Card padding="md" className={cn("flex flex-col gap-3", className)}>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-3 w-16" />
      </Card>
    );
  }
  const t = delta?.trend ? trendMeta[delta.trend] : null;
  const onKeyDown = onClick
    ? (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.currentTarget !== event.target) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick();
      }
    : undefined;
  return (
    <Card
      padding="md"
      // 可点态一律走 Card 的 interactive 轴(手型 + 抬升 + 焦点环 + 44px 触控靶),
      // 不在这里另写一套 —— 全站"卡片可点"的观感必须只有一个定义。
      // role/tabIndex 由本组件给:Card 刻意不代劳(它不知道自己会被包成什么)。
      interactive={onClick ? true : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn("flex items-start justify-between gap-3", onClick && "text-left", className)}
    >
      <div className="min-w-0">
        <p className="truncate text-meta font-medium text-faint">{label}</p>
        <p className="mt-1.5 text-xl font-semibold leading-none text-fg tabular-nums">{value}</p>
        {(hint || delta) && (
          <div className="mt-2 flex items-center gap-2 text-meta">
            {delta && t && (
              <span
                className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", t.cls)}
              >
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

const colsClass = {
  2: "sm:grid-cols-2",
  3: "grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
} as const;

/** KPI 卡响应式栅格(默认 2 列 → 大屏 4 列)。 */
export function StatCardRow({
  children,
  /** 大屏列数。默认 4,与存量一致。 */
  cols = 4,
  className,
}: {
  children: ReactNode;
  cols?: 2 | 3 | 4;
  className?: string;
}) {
  return <div className={cn("grid gap-3", colsClass[cols], className)}>{children}</div>;
}
