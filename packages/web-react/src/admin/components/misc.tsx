import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, PanelHeader } from "../../components/ui";
import { cn } from "../../lib/utils";

// KeyValue / CopyChip / TimeAgo 已提升为全站共享原语:
//   KeyValue → components/ui/DescriptionList.tsx 的 DescriptionRow(语义更准)
//   CopyChip → components/ui/CopyChip.tsx
//   TimeAgo  → components/ui/TimeAgo.tsx(全站日期唯一权威)
// admin 侧经 ./index.ts 再导出,页面 import 路径不变。

const SECTION_ICON_TONE = {
  neutral: "oc-icon-badge",
  accent: "oc-icon-badge oc-icon-badge-accent",
  success: "oc-icon-badge oc-icon-badge-success",
  warning: "oc-icon-badge oc-icon-badge-warning",
  danger: "oc-icon-badge oc-icon-badge-danger",
  info: "oc-icon-badge oc-icon-badge-info",
} as const;

/** Panel 风格分区卡:精雕卡片表面 + 可选图标徽章头部 + 发丝分隔内容体。表单/详情分区共用。 */
export function SectionCard({
  title,
  hint,
  action,
  icon: Icon,
  iconTone = "accent",
  children,
  className,
  bodyClassName,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: LucideIcon;
  iconTone?: keyof typeof SECTION_ICON_TONE;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      {Icon ? (
        <div
          data-panel-header=""
          className="flex flex-wrap items-center justify-between gap-3 bg-sidebar/40 px-4 py-3 dark:bg-elevated/40"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cn("size-8 rounded-lg", SECTION_ICON_TONE[iconTone])}>
              <Icon size={15} strokeWidth={1.95} />
            </span>
            <div className="min-w-0">
              <h3 className="text-title font-semibold tracking-tight text-fg">{title}</h3>
              {hint && <p className="mt-0.5 text-caption text-muted">{hint}</p>}
            </div>
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      ) : (
        <div className="bg-sidebar/35 dark:bg-elevated/35">
          <PanelHeader title={title} hint={hint} action={action} />
        </div>
      )}
      <div className={cn("border-t border-border/80 px-5 py-4", bodyClassName)}>{children}</div>
    </Card>
  );
}

// ── 级别徽标 ────────────────────────────────────────────────────────────
type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
const LEVEL_TONE: Record<string, BadgeTone> = {
  critical: "danger",
  fatal: "danger",
  error: "danger",
  err: "danger",
  high: "danger",
  warning: "warning",
  warn: "warning",
  medium: "warning",
  degraded: "warning",
  info: "info",
  notice: "info",
  low: "info",
  success: "success",
  ok: "success",
  healthy: "success",
  resolved: "success",
  active: "success",
};

/** severity/level 字串 → 语义徽标（带 Clarvy Atelier 工艺内描边）。未知级别回落 neutral,原样显示。 */
export function LevelBadge({
  level,
  label,
  className,
}: {
  level: string;
  /** 展示文本(缺省用 level)。 */
  label?: ReactNode;
  className?: string;
}) {
  const tone = LEVEL_TONE[level?.toLowerCase?.()] ?? "neutral";
  return (
    <Badge tone={tone} className={cn("font-semibold", className)}>
      {label ?? level}
    </Badge>
  );
}
