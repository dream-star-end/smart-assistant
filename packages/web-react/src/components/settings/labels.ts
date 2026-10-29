// v5 设置/计费中心的展示文案映射（唯一权威源，杜绝各组件硬编码散落）。

import type { UsageLedgerRow, UsageReportWindow } from "../../lib/types";

/**
 * credit_ledger.reason → 中文标签。后端 reason 是开放枚举（admin/ledger.ts），
 * 未知值回退到 reason 原文 —— 绝不吞掉未知类型，保证可观测。
 */
export const LEDGER_REASON_LABEL: Record<string, string> = {
  seed_grant: "初始额度",
  promotion: "活动赠送",
  topup: "充值到账",
  topup_test: "测试充值",
  // 写侧真实 reason(credit_ledger CHECK)。chat 是对话扣费的唯一写法(proxyBilling spendTwoBucket)。
  chat: "对话扣费",
  agent_chat: "智能体对话扣费",
  agent_subscription: "智能体订阅",
  admin_adjust: "人工调整",
  minimax_media: "媒体生成",
  image_generation: "图片生成",
  pack: "加量包到账",
  charge: "对话扣费",
  usage: "对话扣费",
  usage_charge: "对话扣费",
  refund: "退费",
  adjustment: "人工调整",
  monthly_grant: "月度额度",
  subscription: "订阅额度到账",
  subscription_expire: "周期额度结清",
  agent_open: "开通智能体",
  muse_media: "Muse 图片/视频",
};

/** 退费 memo `waive:<code>;turn:<hash>` 的 code → 用户说明(#1237)。 */
const WAIVE_MEMO_LABEL: Record<string, string> = {
  idle_timeout: "对话超时未完成，已退回",
  no_response: "模型未返回内容，已退回",
};

/** 对话扣费行的次级文案:模型 · 会话;写侧内部 memo(cost=<n>)不给用户看。 */
function usageRowMemo(
  row: Pick<UsageLedgerRow, "memo" | "model_name" | "session_title">,
): string | null {
  const parts = [row.model_name, row.session_title].filter((s): s is string => !!s?.trim());
  if (parts.length > 0) return parts.join(" · ");
  return row.memo && /^cost=\d+$/.test(row.memo) ? null : row.memo;
}

export function ledgerReasonLabel(reason: string): string {
  return LEDGER_REASON_LABEL[reason] || reason;
}

/**
 * 面向用户的流水类型展示(审计 SET-16):未知 reason 不再把后端枚举原文当标题砸给用户,
 * 显示「其他」并把原值放进 `raw`(调用方挂到 title / 次级文案),可观测性不丢。
 */
export function ledgerReasonView(
  reason: string,
  workload?: string | null,
): { label: string; raw: string | null } {
  // 0304 OCV5-392: memory consolidation is billed as chat but tagged workload='auto_dream'.
  if (workload === "auto_dream") return { label: "记忆整理", raw: null };
  const known = LEDGER_REASON_LABEL[reason];
  return known ? { label: known, raw: null } : { label: "其他", raw: reason };
}

/** Subscription replacement and expiry share a ledger reason; the order reference distinguishes them. */
export function ledgerRowView(
  row: Pick<UsageLedgerRow, "reason" | "workload" | "ref_type" | "ref_id" | "memo"> &
    Partial<Pick<UsageLedgerRow, "model_name" | "session_title">>,
): { label: string; raw: string | null; memo: string | null } {
  const reason = ledgerReasonView(row.reason, row.workload);
  const waive = row.reason === "refund" ? /^waive:([a-z_]+)(;|$)/.exec(row.memo ?? "") : null;
  if (waive) return { ...reason, memo: WAIVE_MEMO_LABEL[waive[1]] ?? "未完成的对话，已退回" };
  if (row.ref_type === "usage_record" && row.reason !== "refund") {
    return { ...reason, memo: usageRowMemo(row) };
  }
  if (row.reason !== "subscription_expire" || row.workload === "auto_dream") {
    return { ...reason, memo: row.memo };
  }
  const ordered = row.ref_type === "subscription" && !!row.ref_id;
  // Translate the exact historical writer format, without rewriting append-only ledger rows.
  const legacy = /^expire (\d+) on [a-z0-9-]+ renew\/rollover$/.exec(row.memo ?? "");
  return {
    label: ordered ? "订单生效，旧额度结清" : reason.label,
    raw: reason.raw,
    memo: legacy ? `旧周期剩余 ${legacy[1]} 积分结清，新周期额度另行到账` : row.memo,
  };
}

/**
 * 外接 API 请求结果 → 中文(usage_records.status / 审计 terminal_code)。
 * 后端是开放枚举;未知值回退原文(审计 SET-25:此前除 success 外一律原样展示)。
 */
export const API_REQUEST_STATUS_LABEL: Record<string, string> = {
  success: "成功",
  ok: "成功",
  insufficient_credits: "余额不足",
  credit_limit_exceeded: "超出密钥上限",
  key_limit_exceeded: "超出密钥上限",
  rate_limited: "已限流",
  key_disabled: "密钥已停用",
  key_revoked: "密钥已撤销",
  unauthorized: "未授权",
  forbidden: "无权限",
  invalid_request: "请求无效",
  upstream_error: "上游错误",
  timeout: "超时",
  cancelled: "已取消",
  canceled: "已取消",
  error: "失败",
  failed: "失败",
};

export function apiRequestStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return API_REQUEST_STATUS_LABEL[status] || status;
}

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

const SHORT_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * ISO 时间 → 北京时间简洁展示（M月D日 HH:mm）。非法时间返回空串。
 * 固定 Asia/Shanghai(#1237):与收支报表的日桶(usageReport.ts)同一时区，
 * 不随浏览器时区漂移——美西时区浏览器曾把当天 11:12 的扣费显示成前一天 20:12。
 */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p: Record<string, string> = {};
  for (const x of SHORT_TIME_FMT.formatToParts(d)) p[x.type] = x.value;
  const pad = (v: string | undefined) => (v ?? "").padStart(2, "0");
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`;
}
