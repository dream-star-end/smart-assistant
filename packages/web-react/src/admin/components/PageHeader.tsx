import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 页头：编辑风标题区（可选图标徽章 + 标题/眉标/徽标 + 副标题层次 + 右侧触感操作区 + 发丝底分隔）。
 * 每个管理页顶部统一用它，保证结构一致。文案由页面传入。
 */
export function PageHeader({
  title,
  desc,
  actions,
  icon: Icon,
  badge,
  className,
}: {
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3.5 border-b border-border/80 pb-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-10 shrink-0 rounded-xl">
            <Icon size={19} strokeWidth={1.9} />
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
            {badge}
          </div>
          {desc && (
            <p className="mt-1 max-w-3xl text-body leading-relaxed text-muted">{desc}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
