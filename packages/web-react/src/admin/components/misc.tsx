import type { ReactNode } from "react";
import { Badge, Card, PanelHeader } from "../../components/ui";
import { cn } from "../../lib/utils";

// KeyValue / CopyChip / TimeAgo 已提升为全站共享原语:
//   KeyValue → components/ui/DescriptionList.tsx 的 DescriptionRow(语义更准)
//   CopyChip → components/ui/CopyChip.tsx
//   TimeAgo  → components/ui/TimeAgo.tsx(全站日期唯一权威)
// admin 侧经 ./index.ts 再导出,页面 import 路径不变。

/** Panel 风格分区卡:统一头部 + 内容体。表单/详情分区共用。 */
export function SectionCard({
  title,
  hint,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <PanelHeader title={title} hint={hint} action={action} />
      <div className={cn("border-t border-border px-5 py-4", bodyClassName)}>{children}</div>
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

/** severity/level 字串 → 语义徽标。未知级别回落 neutral,原样显示。 */
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
    <Badge tone={tone} className={className}>
      {label ?? level}
    </Badge>
  );
}
