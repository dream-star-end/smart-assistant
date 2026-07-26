import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Tooltip } from "./Tooltip";

/**
 * 全站日期展示的唯一权威(组件 + 纯函数双出口)。
 *
 * 存在的理由:改造前仓内有 3 套相对时间实现(admin/components/misc、lib/utils.relativeTime、
 * manage/MemoryPanel)外加 47 处裸 `toLocaleString`,同一个弹窗里能同时出现
 * 「7/26」「2026/7/26 14:30:12」「3 天前」三种写法 —— 日期格式属于产品语言,必须只有
 * 一处定义。这里把绝对格式收敛成 canonical 的 `YYYY-MM-DD HH:mm`(24h、补零、无
 * locale 抖动),相对格式收敛成一档中文口径。
 *
 * 非 JSX 场景(CSV 导出、aria-label、图表轴)用 `formatDate()`,不要再手写 toLocaleString。
 *
 * 刻意**不**设默认字号:时间戳总是嵌在别的文本流里(表格单元、卡片脚注),字号应随
 * 上下文继承;需要压小时由调用方给 `className="text-caption text-faint"`。
 */

export type DateInput = string | number | Date | null | undefined;

/**
 * 展示档位:
 * - relative  相对现在(刚刚 / N 分钟前 / …;超过 30 天回落绝对日期)
 * - datetime  2026-07-26 14:30   —— 默认绝对档
 * - full      2026-07-26 14:30:12 —— 审计/排障需要秒时用(Tooltip 默认档)
 * - date      2026-07-26
 * - time      14:30
 * - short     07-26 14:30(当年内的紧凑展示,省年份)
 */
export type DateFormat = "relative" | "datetime" | "full" | "date" | "time" | "short";

/** 宽松解析:ISO 串 / epoch 毫秒 / Date 都收;不可解析(含 null/空串)一律 null。 */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** canonical 绝对格式。固定 24h + 补零,不走 locale —— 同一个界面不能有两种日期长相。 */
function absolute(d: Date, format: DateFormat): string {
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  switch (format) {
    case "date":
      return `${Y}-${M}-${D}`;
    case "time":
      return `${h}:${m}`;
    case "short":
      return `${M}-${D} ${h}:${m}`;
    case "full":
      return `${Y}-${M}-${D} ${h}:${m}:${s}`;
    default:
      return `${Y}-${M}-${D} ${h}:${m}`;
  }
}

/** 相对现在。未来时间用「后」缀;跨过 30 天就没有相对意义了,回落 canonical 日期。 */
function relative(d: Date, now: number): string {
  const diff = now - d.getTime();
  const abs = Math.abs(diff);
  const sfx = diff >= 0 ? "前" : "后";
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (abs < min) return "刚刚";
  if (abs < hr) return `${Math.floor(abs / min)} 分钟${sfx}`;
  if (abs < day) return `${Math.floor(abs / hr)} 小时${sfx}`;
  if (abs < 30 * day) return `${Math.floor(abs / day)} 天${sfx}`;
  return absolute(d, "date");
}

/** 纯函数出口。非法值 → fallback(默认破折号,与全仓空值展示一致)。 */
export function formatDate(
  value: DateInput,
  format: DateFormat = "datetime",
  options?: { fallback?: string; now?: number },
): string {
  const d = toDate(value);
  if (!d) return options?.fallback ?? "—";
  return format === "relative" ? relative(d, options?.now ?? Date.now()) : absolute(d, format);
}

export type TimeAgoProps = {
  value: DateInput;
  /** 展示档位。默认 relative(与改造前 admin 的 TimeAgo 行为一致)。 */
  format?: DateFormat;
  /** 悬停显示绝对时间。默认开;设 false 得到纯文本 span。 */
  tooltip?: boolean;
  /** Tooltip 里的档位。默认 full(带秒,排障时对得上日志)。 */
  tooltipFormat?: DateFormat;
  /** relative 档的自刷新周期(ms)。传 0 关闭。非 relative 档不起定时器。 */
  refreshMs?: number;
  /** 非法/缺失值的占位。 */
  fallback?: string;
  className?: string;
};

export function TimeAgo({
  value,
  format = "relative",
  tooltip = true,
  tooltipFormat = "full",
  refreshMs = 60_000,
  fallback = "—",
  className,
}: TimeAgoProps) {
  const date = toDate(value);
  const live = format === "relative" && refreshMs > 0;
  const [now, setNow] = useState(() => Date.now());
  // 相对时间会随墙钟走 —— 不自刷新的话「刚刚」会一直挂在那里骗人。
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(t);
  }, [live, refreshMs]);

  if (!date) return <span className={className}>{fallback}</span>;

  const text = format === "relative" ? relative(date, now) : absolute(date, format);
  const body = (
    <span className={cn("cursor-default tabular-nums", className)}>{text}</span>
  );
  if (!tooltip) return body;
  return <Tooltip content={absolute(date, tooltipFormat)}>{body}</Tooltip>;
}
