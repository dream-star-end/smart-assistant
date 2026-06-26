import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 分 → ¥ 显示（保留两位）。负数保留负号。计费 surface 共用，故置于此通用层。 */
export function formatCny(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
}

// ─── 字符串大数格式化（v5 计费/用量 surface 专用） ─────────────────────────
// 后端 credits / tokens / cost 一律以字符串返回（可能越过 2^53），**全程禁止 Number() 化**。
// 这里所有格式化只做"纯字符串处理"或"BigInt 精确运算"，绝不引入浮点精度损失。

/**
 * 整数字符串千分位分组（积分、token 计数）。非法输入原样返回（防御）。
 * 纯字符串正则插逗号 —— 不经过 Number/BigInt，任意位数安全；保留负号。
 */
export function groupDigits(s: string): string {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) return s;
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 积分（字符串大数）展示：千分位分组。负号保留（退费 / 扣费方向由调用方加号决定）。
 */
export function formatCredits(s: string): string {
  return groupDigits(s);
}

/**
 * 分（字符串大数）→ ¥ 元。BigInt 精确换算，保留两位小数，千分位分组，保留负号。
 * 用于充值金额、账单金额等"金额分"字段（amount_cents）。
 */
export function formatCentsYuan(centsStr: string): string {
  if (typeof centsStr !== "string" || !/^-?\d+$/.test(centsStr)) return centsStr;
  let cents: bigint;
  try {
    cents = BigInt(centsStr);
  } catch {
    return centsStr;
  }
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const yuan = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}¥${groupDigits(yuan.toString())}.${frac.toString().padStart(2, "0")}`;
}

/**
 * 大 token 数缩写（10,000 → 1万；1,200,000 → 120万）。用于用量图表轴/摘要的紧凑展示。
 * 用 BigInt 取整数万/亿，余数转一位小数（仅小数位用 Number，分母固定 10，无精度风险）。
 * 不足 1 万原样千分位。非法输入原样返回。
 */
export function formatCompactCount(s: string): string {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) return s;
  let n: bigint;
  try {
    n = BigInt(s);
  } catch {
    return s;
  }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const sign = neg ? "-" : "";
  const WAN = 10_000n;
  const YI = 100_000_000n;
  if (abs >= YI) {
    const whole = abs / YI;
    const tenth = Number((abs % YI) / (YI / 10n));
    return `${sign}${groupDigits(whole.toString())}${tenth ? `.${tenth}` : ""}亿`;
  }
  if (abs >= WAN) {
    const whole = abs / WAN;
    const tenth = Number((abs % WAN) / (WAN / 10n));
    return `${sign}${groupDigits(whole.toString())}${tenth ? `.${tenth}` : ""}万`;
  }
  return groupDigits(s);
}

/**
 * 两个字符串大数的占比（0–100）。仅用于"画条/算百分比"，BigInt 算分子分母后映射到
 * [0,100] 的 Number（比例值天然有界，无大数精度风险）。分母 0 → 0。
 */
export function ratioPct(part: string, total: string): number {
  if (!/^-?\d+$/.test(part) || !/^-?\d+$/.test(total)) return 0;
  try {
    const p = BigInt(part);
    const t = BigInt(total);
    if (t <= 0n) return 0;
    // 放大 1e6 再转 Number，避免整除丢精度
    return Number((p * 1_000_000n) / t) / 10_000;
  } catch {
    return 0;
  }
}

export function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return "本周";
  if (days < 30) return "本月";
  return "更早";
}
