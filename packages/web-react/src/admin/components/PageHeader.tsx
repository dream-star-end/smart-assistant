import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 页头：标题 + 可选描述 + 右侧 actions 槽（主操作/导出/筛选入口）。
 * 每个管理页顶部统一用它，保证结构一致。文案由页面传入。
 */
export function PageHeader({
  title,
  desc,
  actions,
  className,
}: {
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        {desc && <p className="mt-1 text-[13px] leading-snug text-muted">{desc}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
