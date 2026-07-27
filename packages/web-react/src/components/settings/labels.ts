// v5 设置/计费中心的展示文案映射（唯一权威源，杜绝各组件硬编码散落）。

import {
  LEDGER_REASON_LABELS,
  ledgerReasonLabel,
} from "@openclaude/protocol/ledger";
import type { UsageReportWindow } from "../../lib/types";

export { LEDGER_REASON_LABELS, ledgerReasonLabel };

/** 思考深度档位（preferences.default_effort 枚举；具体模型支持集由 API 决定）。 */
export const EFFORT_OPTIONS: {
  value: "low" | "medium" | "high" | "xhigh" | "max";
  label: string;
}[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "很高" },
  { value: "max", label: "最高" },
];

/** 订单状态 → 中文（虎皮椒：pending|paid|expired|canceled）。 */
export function orderStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待支付";
    case "paid":
      return "已到账";
    case "expired":
      return "已过期";
    case "canceled":
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

/** 报表窗口 → 中文名词（用量/账单图表卡的窗口标注共用）。 */
export const REPORT_WINDOW_NOUN: Record<UsageReportWindow, string> = {
  "24h": "24 小时",
  "7d": "7 天",
  "30d": "30 天",
};

/**
 * 报表 bucket → 图表轴标签（设置/计费图表共用单一权威）。
 * 24h 桶「MM-DD HH:00」取「HH:00」；日桶「YYYY-MM-DD」去年份取「MM-DD」；其余原样。
 */
export function formatReportBucket(bucket: string, window: UsageReportWindow): string {
  if (window === "24h") {
    const parts = bucket.split(" ");
    return parts.length > 1 ? parts[parts.length - 1] : bucket;
  }
  const m = /^\d{4}-(\d{2}-\d{2})$/.exec(bucket);
  return m ? m[1] : bucket;
}

/** ISO 时间 → 简洁本地展示（M月D日 HH:mm）。非法时间返回空串。 */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}
