// 企业版席位订阅纯函数层(二期 P3.1)—— 唯一权威源,供 api.ts 适配、组件计价、单测复用。
// 全程字符串 / BigInt,绝不数值化大数(每席价分 / 每席积分 / 期内池)。无 React 依赖,可纯测。

import type { OrgPlan, OrgRole, OrgSubscriptionView } from "./types";

/** 容错读字符串大数:number/bigint 转字符串,其余回落默认值。 */
function readStr(v: unknown, d = "0"): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return v.toString();
  return d;
}

/** 容错读整数(席位 / 周期天数):非有限值回落默认。 */
function readInt(v: unknown, d = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.floor(n) : d;
}

/** 安全 BigInt(非纯整数串按 0)。 */
function safeBig(v: string): bigint {
  if (typeof v !== "string" || !/^-?\d+$/.test(v.trim())) return 0n;
  try {
    return BigInt(v.trim());
  } catch {
    return 0n;
  }
}

/** 大数字符串 × 非负整数(BigInt,禁浮点)。非法输入按 0。 */
function mulStr(base: string, factor: number): string {
  if (!Number.isInteger(factor) || factor < 0) return "0";
  return (safeBig(base) * BigInt(factor)).toString();
}

/**
 * 契约适配:后端 org 套餐档(字段名以批次 F 为准)→ 归一化 OrgPlan。
 * 同时容忍 snake / camel / 个人版同源命名(price_cents / credits),把 UI 与 F 字段名解耦。
 */
export function normalizeOrgPlan(raw: unknown): OrgPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const minSeats = readInt(r.min_seats ?? r.minSeats, 0);
  const periodDays = readInt(r.period_days ?? r.periodDays, 0);
  return {
    code: readStr(r.code ?? r.plan_code ?? r.planCode, ""),
    name: readStr(r.name ?? r.plan_name ?? r.planName, ""),
    // 批次 F 实际用 subscription_plans(scope='org')的 price_cents / monthly_credits(每席值);
    // 保留 seat_* 别名容错,避免 F 若改名再断。
    seatPriceCents: readStr(r.seat_price_cents ?? r.seatPriceCents ?? r.price_cents ?? r.priceCents),
    perSeatCredits: readStr(
      r.per_seat_credits ??
        r.perSeatCredits ??
        r.monthly_credits ??
        r.monthlyCredits ??
        r.seat_credits ??
        r.credits_per_seat,
    ),
    minSeats: minSeats > 0 ? minSeats : 1,
    periodDays: periodDays > 0 ? periodDays : 30,
  };
}

/** 契约适配:后端当前订阅 → 归一化 OrgSubscriptionView。无订阅 / 缺 plan_code → null。 */
export function normalizeOrgSubscription(raw: unknown): OrgSubscriptionView {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const code = readStr(r.plan_code ?? r.planCode, "");
  if (!code) return null;
  return {
    planCode: code,
    // F 的 subscription 不含 plan_name;UI 会用 plans 列表里的名覆盖,这里回落 code。
    planName: readStr(r.plan_name ?? r.planName, code),
    status: readStr(r.status, "active"),
    seats: readInt(r.seats, 0),
    periodStart: readStr(r.period_start ?? r.periodStart, ""),
    periodEnd: readStr(r.period_end ?? r.periodEnd, ""),
    periodCredits: readStr(r.period_credits ?? r.periodCredits, "0"),
  };
}

/**
 * 席位订单总价:总价分 = 每席价 × 席位;总入池积分 = 每席积分 × 席位。全 BigInt。
 * seats 非正 → 0(不产生负 / NaN 展示)。加席场景传入「增量席位」即得该次应付。
 */
export function computeSeatTotal(
  plan: Pick<OrgPlan, "seatPriceCents" | "perSeatCredits">,
  seats: number,
): { totalCents: string; totalCredits: string } {
  const n = Number.isFinite(seats) && seats > 0 ? Math.floor(seats) : 0;
  return {
    totalCents: mulStr(plan.seatPriceCents, n),
    totalCredits: mulStr(plan.perSeatCredits, n),
  };
}

/** 席位输入规整:非整数 / 低于下限 → 下限(下限本身至少 1)。 */
export function clampSeats(seats: number, min: number): number {
  const lo = Number.isFinite(min) && min >= 1 ? Math.floor(min) : 1;
  if (!Number.isFinite(seats)) return lo;
  const n = Math.floor(seats);
  return n < lo ? lo : n;
}

/** 组织名步骤可前进:去空白后非空且 ≤ 60 字(与后端 org name 约束对齐)。 */
export function canLeaveNameStep(orgName: string): boolean {
  const s = orgName.trim();
  return s.length > 0 && s.length <= 60;
}

/** 选档步骤可前进:已选档 + 席位为正整数且 ≥ 档位最低席位。 */
export function canLeavePlanStep(plan: OrgPlan | null, seats: number): boolean {
  if (!plan) return false;
  return Number.isInteger(seats) && seats > 0 && seats >= plan.minSeats;
}

/**
 * 席位占用:used = 活跃成员数;total = 有订阅取 min(seats, maxMembers),否则 maxMembers。
 * full 即席位已满(用于邀请闸的友好前置提示;后端 SEATS_FULL 仍是权威)。
 */
export function seatsUsage(
  subscription: OrgSubscriptionView,
  memberCount: number,
  maxMembers: number,
): { used: number; total: number; full: boolean } {
  const used = Number.isFinite(memberCount) && memberCount > 0 ? Math.floor(memberCount) : 0;
  const cap = Number.isFinite(maxMembers) && maxMembers > 0 ? Math.floor(maxMembers) : 0;
  const total = subscription ? Math.min(subscription.seats, cap || subscription.seats) : cap;
  return { used, total, full: total > 0 && used >= total };
}

/**
 * 组织计费写面门控(三期,唯一权威源)——供 OrgCenter 派生 + 单测复用。
 * owner 恒可;billing_delegate 被授予者亦可。覆盖充值/订阅/加席/发票写。
 * 后端鉴权仍是权威(降权窗口 403 由 UI 兜底 toast);此函数只决定按钮可见性。
 */
export function canManageOrgBilling(
  role: OrgRole | null | undefined,
  billingDelegate: boolean | null | undefined,
): boolean {
  return role === "owner" || billingDelegate === true;
}

/**
 * 成员月度限额展示态(三期,纯函数)。budget=null → 不限(hasBudget=false)。
 * pct 供进度条(0–100);over=已用达/超预算(预算>0 时);remaining=剩余额度(floor 0,字符串大数)。
 * 全 BigInt,绝不数值化大数。
 */
export function budgetView(
  budget: string | null,
  spent: string,
): { hasBudget: boolean; pct: number; over: boolean; remaining: string } {
  const b = budget == null ? null : safeBig(budget);
  const s = safeBig(spent);
  if (b == null || b <= 0n) {
    // null=不限;预算 ≤0 亦视为不限的宽松展示(后端 0 语义由其定义,这里不硬扣)。
    return { hasBudget: false, pct: 0, over: false, remaining: "0" };
  }
  const rem = b - s;
  return {
    hasBudget: true,
    pct: ratioPct(spent, budget as string),
    over: s >= b,
    remaining: (rem > 0n ? rem : 0n).toString(),
  };
}

/**
 * 落地页锚点价:企业档中最低「每席价」→ 整元字符串(去分,"起"锚点无需精确到分)。
 * 无有效档 / 全 0 → null(调用方静态兜底文案,不硬编码全价)。
 */
export function minSeatPriceYuan(plans: OrgPlan[]): string | null {
  let min: bigint | null = null;
  for (const p of plans) {
    const c = safeBig(p.seatPriceCents);
    if (c > 0n && (min == null || c < min)) min = c;
  }
  return min == null ? null : (min / 100n).toString();
}

/** 占比百分数(0–100,BigInt 精确,仅用于进度条宽度)。whole ≤ 0 → 0;part ≥ whole → 100。 */
export function ratioPct(part: string, whole: string): number {
  const w = safeBig(whole);
  const p = safeBig(part);
  if (w <= 0n || p <= 0n) return 0;
  if (p >= w) return 100;
  return Number((p * 10000n) / w) / 100;
}
