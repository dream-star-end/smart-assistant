import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Badge, Card, PanelHeader, Tooltip } from "../../components/ui";
import { cn } from "../../lib/utils";

/** Panel 风格分区卡：统一头部 + 内容体。表单/详情分区共用。 */
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

/** 详情键值对一行（label 左，value 右）。多行堆叠即成详情列表。 */
export function KeyValue({
  label,
  value,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 py-1.5 text-[13px]",
        className,
      )}
    >
      <span className="shrink-0 text-faint">{label}</span>
      <span className="min-w-0 break-words text-right font-medium text-fg">{value}</span>
    </div>
  );
}

/** 点击复制芯片：复制成功短暂显 ✓。用于 UUID / token / 订单号等长标识。 */
export function CopyChip({
  value,
  label,
  className,
}: {
  value: string;
  /** 展示文本（缺省用 value）。 */
  label?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* 剪贴板不可用（非安全上下文）：静默 */
    }
  };
  return (
    <Tooltip content={copied ? "已复制" : "点击复制"}>
      <button
        type="button"
        onClick={copy}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-md bg-hover px-2 py-1 font-mono text-[12px] text-muted outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <span className="truncate">{label ?? value}</span>
        {copied ? (
          <Check size={13} className="shrink-0 text-success" />
        ) : (
          <Copy size={13} className="shrink-0 opacity-70" />
        )}
      </button>
    </Tooltip>
  );
}

// ── 相对时间 ────────────────────────────────────────────────────────────
function toDate(v: string | number | Date): Date {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  return new Date(v);
}
function relative(from: Date, now: number): string {
  const diff = now - from.getTime();
  const abs = Math.abs(diff);
  const sfx = diff >= 0 ? "前" : "后";
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (abs < min) return "刚刚";
  if (abs < hr) return `${Math.floor(abs / min)} 分钟${sfx}`;
  if (abs < day) return `${Math.floor(abs / hr)} 小时${sfx}`;
  if (abs < 30 * day) return `${Math.floor(abs / day)} 天${sfx}`;
  return from.toLocaleDateString("zh-CN");
}

/** 相对时间，悬停看绝对时间。分钟级自动刷新（挂载后每 60s）。 */
export function TimeAgo({
  value,
  className,
}: {
  value: string | number | Date;
  className?: string;
}) {
  const date = toDate(value);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (Number.isNaN(date.getTime())) return <span className={className}>—</span>;
  return (
    <Tooltip content={date.toLocaleString("zh-CN")}>
      <span className={cn("cursor-default tabular-nums", className)}>{relative(date, now)}</span>
    </Tooltip>
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

/** severity/level 字串 → 语义徽标。未知级别回落 neutral，原样显示。 */
export function LevelBadge({
  level,
  label,
  className,
}: {
  level: string;
  /** 展示文本（缺省用 level）。 */
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
