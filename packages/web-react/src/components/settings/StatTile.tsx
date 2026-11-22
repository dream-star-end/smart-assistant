import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 设置 / 计费 / 组织报表共用的紧凑数字卡(2×2 宫格里那种)。
 *
 * 之前 UsageTab / ApiAccessTab / ReportsTab 各写一份 `Stat`:字号 16 或 20、有无边框、
 * 底色各不相同(审计 SET-27),而 20px 那份在 390px 半宽卡里会把「2,340,000 积分」折成
 * 「积/分」两行(SET-06)。这里统一:16px 数字 + `tabular-nums`,数字本体 `whitespace-nowrap`,
 * 单位放独立 span —— 实在放不下时只在数字与单位之间换行,绝不把数字或单位从中间掰断。
 *
 * 不用 ui/StatCard:那张是 KPI 大卡(20px、带 icon / delta),定位是仪表盘,不是分区内的小格。
 */
export function StatTile({
  label,
  value,
  unit,
  icon,
  accent,
  className,
}: {
  label: ReactNode;
  /** 已格式化的数字字符串(formatCredits / groupDigits / formatCompactCount 的输出)。 */
  value: string;
  /** 数字单位(如「积分」);单独渲染,避免与数字之间被当作可断词的整体。 */
  unit?: string;
  /** 可选微型图标，置于标签旁强化扫描识别。 */
  icon?: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "oc-surface-card min-w-0 rounded-xl px-3.5 py-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-caption font-medium text-faint">{label}</div>
        {icon && (
          <span
            className={cn(
              "oc-icon-badge h-6 w-6 rounded-xs",
              accent && "oc-icon-badge-accent",
            )}
            aria-hidden
          >
            {icon}
          </span>
        )}
      </div>
      <div
        className={cn(
          "mt-1 flex flex-wrap items-baseline gap-x-1 text-base font-semibold leading-tight tracking-tight tabular-nums",
          accent ? "text-accent" : "text-fg",
        )}
      >
        <span className="whitespace-nowrap">{value}</span>
        {unit && <span className="whitespace-nowrap text-body font-medium text-muted">{unit}</span>}
      </div>
    </div>
  );
}
