import { describe, expect, test } from "vitest";
import type { OrgPlan } from "./types";
import {
  budgetView,
  canLeaveNameStep,
  canLeavePlanStep,
  canManageOrgBilling,
  clampSeats,
  computeSeatTotal,
  minSeatPriceYuan,
  normalizeOrgPlan,
  normalizeOrgSubscription,
  ratioPct,
  seatsUsage,
} from "./orgBilling";

const PRO: OrgPlan = {
  code: "org-pro",
  name: "企业标准",
  seatPriceCents: "7800",
  perSeatCredits: "10000",
  minSeats: 2,
  periodDays: 30,
};

describe("normalizeOrgPlan（契约适配层，字段名与后端解耦）", () => {
  test("方案文档默认字段名（snake）", () => {
    expect(
      normalizeOrgPlan({
        code: "org-max",
        name: "企业专业",
        seat_price_cents: "26800",
        per_seat_credits: "35000",
        min_seats: 2,
        period_days: 30,
      }),
    ).toEqual({
      code: "org-max",
      name: "企业专业",
      seatPriceCents: "26800",
      perSeatCredits: "35000",
      minSeats: 2,
      periodDays: 30,
    });
  });

  test("批次 F 实际字段名（subscription_plans scope='org'：price_cents / monthly_credits）", () => {
    // serializeOrgPlan 实产:{code,name,price_cents,monthly_credits,period_days,min_seats,tier,sort_order}
    expect(
      normalizeOrgPlan({
        code: "org-pro",
        name: "企业标准",
        price_cents: "7800",
        monthly_credits: "10000",
        period_days: 30,
        min_seats: 2,
        tier: 1,
        sort_order: 10,
      }),
    ).toEqual({
      code: "org-pro",
      name: "企业标准",
      seatPriceCents: "7800",
      perSeatCredits: "10000",
      minSeats: 2,
      periodDays: 30,
    });
  });

  test("容忍 F 偏离：camel / 个人版同源命名（price_cents / credits）", () => {
    const p = normalizeOrgPlan({
      plan_code: "org-ultra",
      plan_name: "企业旗舰",
      priceCents: "44800",
      seat_credits: "60000",
      minSeats: 3,
    });
    expect(p.code).toBe("org-ultra");
    expect(p.name).toBe("企业旗舰");
    expect(p.seatPriceCents).toBe("44800");
    expect(p.perSeatCredits).toBe("60000");
    expect(p.minSeats).toBe(3);
    expect(p.periodDays).toBe(30); // 缺省回落
  });

  test("数字型大数字段转字符串；缺失回落安全默认", () => {
    const p = normalizeOrgPlan({ code: "x", seat_price_cents: 7800 });
    expect(p.seatPriceCents).toBe("7800");
    expect(p.perSeatCredits).toBe("0");
    expect(p.minSeats).toBe(1);
  });

  test("非对象输入不抛错", () => {
    expect(normalizeOrgPlan(null).code).toBe("");
    expect(normalizeOrgPlan(undefined).minSeats).toBe(1);
  });
});

describe("normalizeOrgSubscription", () => {
  test("批次 F 实际形（无 plan_name，含 status；planName 回落 code）", () => {
    expect(
      normalizeOrgSubscription({
        plan_code: "org-pro",
        seats: 5,
        status: "active",
        period_start: "2026-07-01T00:00:00Z",
        period_end: "2026-07-31T00:00:00Z",
        period_credits: "42000",
      }),
    ).toEqual({
      planCode: "org-pro",
      planName: "org-pro", // 后端无 plan_name → 回落 code（UI 再用 plans 列表覆盖）
      status: "active",
      seats: 5,
      periodStart: "2026-07-01T00:00:00Z",
      periodEnd: "2026-07-31T00:00:00Z",
      periodCredits: "42000",
    });
  });

  test("status 缺省回落 active；expired 透传", () => {
    expect(normalizeOrgSubscription({ plan_code: "org-pro" })?.status).toBe("active");
    expect(normalizeOrgSubscription({ plan_code: "org-pro", status: "expired" })?.status).toBe(
      "expired",
    );
  });

  test("null / 缺 plan_code → null（无订阅）", () => {
    expect(normalizeOrgSubscription(null)).toBeNull();
    expect(normalizeOrgSubscription({ seats: 5 })).toBeNull();
  });
});

describe("computeSeatTotal（席位总价，BigInt 禁浮点）", () => {
  test("总价 = 每席价 × 席位；总入池积分 = 每席积分 × 席位", () => {
    expect(computeSeatTotal(PRO, 2)).toEqual({ totalCents: "15600", totalCredits: "20000" });
    expect(computeSeatTotal(PRO, 5)).toEqual({ totalCents: "39000", totalCredits: "50000" });
  });

  test("加席增量计价（传增量席位）", () => {
    // org-ultra ¥448=44800 分/席,+3 席
    expect(
      computeSeatTotal({ seatPriceCents: "44800", perSeatCredits: "60000" }, 3),
    ).toEqual({ totalCents: "134400", totalCredits: "180000" });
  });

  test("超大席位不丢精度（越过 2^53）", () => {
    expect(computeSeatTotal({ seatPriceCents: "9007199254740993", perSeatCredits: "0" }, 2))
      .toEqual({ totalCents: "18014398509481986", totalCredits: "0" });
  });

  test("席位非正 → 0（不产生负 / NaN）", () => {
    expect(computeSeatTotal(PRO, 0)).toEqual({ totalCents: "0", totalCredits: "0" });
    expect(computeSeatTotal(PRO, -3)).toEqual({ totalCents: "0", totalCredits: "0" });
    expect(computeSeatTotal(PRO, Number.NaN)).toEqual({ totalCents: "0", totalCredits: "0" });
  });
});

describe("clampSeats（席位输入规整）", () => {
  test("低于下限抬到下限", () => {
    expect(clampSeats(1, 2)).toBe(2);
    expect(clampSeats(0, 2)).toBe(2);
    expect(clampSeats(-5, 2)).toBe(2);
  });
  test("≥ 下限保留", () => {
    expect(clampSeats(5, 2)).toBe(5);
  });
  test("NaN / 非整数回落", () => {
    expect(clampSeats(Number.NaN, 2)).toBe(2);
    expect(clampSeats(3.9, 2)).toBe(3);
  });
  test("下限本身至少 1", () => {
    expect(clampSeats(0, 0)).toBe(1);
  });
});

describe("向导步骤状态机（名称 → 选档 → 席位/总价 可前进判定）", () => {
  test("组织名步骤：非空且 ≤60 字可前进", () => {
    expect(canLeaveNameStep("")).toBe(false);
    expect(canLeaveNameStep("   ")).toBe(false);
    expect(canLeaveNameStep("Acme")).toBe(true);
    expect(canLeaveNameStep("x".repeat(60))).toBe(true);
    expect(canLeaveNameStep("x".repeat(61))).toBe(false);
  });

  test("选档步骤：未选档不可前进", () => {
    expect(canLeavePlanStep(null, 2)).toBe(false);
  });

  test("选档步骤：席位需 ≥ 档位最低", () => {
    expect(canLeavePlanStep(PRO, 1)).toBe(false); // 低于 minSeats=2
    expect(canLeavePlanStep(PRO, 2)).toBe(true);
    expect(canLeavePlanStep(PRO, 9)).toBe(true);
  });
});

describe("seatsUsage（席位占用与满席闸）", () => {
  const sub = {
    planCode: "org-pro",
    planName: "企业标准",
    status: "active",
    seats: 3,
    periodStart: "",
    periodEnd: "",
    periodCredits: "0",
  };

  test("有订阅：total = min(seats, maxMembers)，used ≥ total 即满", () => {
    expect(seatsUsage(sub, 2, 50)).toEqual({ used: 2, total: 3, full: false });
    expect(seatsUsage(sub, 3, 50)).toEqual({ used: 3, total: 3, full: true });
    // maxMembers 收窄了有效上限
    expect(seatsUsage(sub, 2, 2)).toEqual({ used: 2, total: 2, full: true });
  });

  test("无订阅：total = maxMembers", () => {
    expect(seatsUsage(null, 4, 5)).toEqual({ used: 4, total: 5, full: false });
    expect(seatsUsage(null, 5, 5)).toEqual({ used: 5, total: 5, full: true });
  });
});

describe("ratioPct（进度条百分比，BigInt 精确）", () => {
  test("常规占比", () => {
    expect(ratioPct("5000", "10000")).toBe(50);
    expect(ratioPct("2500", "10000")).toBe(25);
  });
  test("边界：0 / 满 / 超出", () => {
    expect(ratioPct("0", "10000")).toBe(0);
    expect(ratioPct("10000", "10000")).toBe(100);
    expect(ratioPct("99999", "10000")).toBe(100);
    expect(ratioPct("100", "0")).toBe(0);
  });
  test("超大值不丢精度", () => {
    expect(ratioPct("9007199254740993", "18014398509481986")).toBe(50);
  });
});

describe("canManageOrgBilling（计费写面门控派生，三期）", () => {
  test("owner 恒可", () => {
    expect(canManageOrgBilling("owner", false)).toBe(true);
    expect(canManageOrgBilling("owner", undefined)).toBe(true);
    expect(canManageOrgBilling("owner", null)).toBe(true);
  });
  test("admin / member 仅在被授予财务委派时可", () => {
    expect(canManageOrgBilling("admin", true)).toBe(true);
    expect(canManageOrgBilling("member", true)).toBe(true);
    expect(canManageOrgBilling("admin", false)).toBe(false);
    expect(canManageOrgBilling("member", undefined)).toBe(false);
  });
  test("空角色 + 无委派 → 不可", () => {
    expect(canManageOrgBilling(null, null)).toBe(false);
    expect(canManageOrgBilling(undefined, undefined)).toBe(false);
  });
});

describe("budgetView（成员月度限额展示态，三期）", () => {
  test("null 预算 → 不限（hasBudget=false，不超限）", () => {
    const v = budgetView(null, "3000");
    expect(v.hasBudget).toBe(false);
    expect(v.over).toBe(false);
    expect(v.pct).toBe(0);
  });
  test("预算内：进度与剩余精确", () => {
    const v = budgetView("10000", "2500");
    expect(v.hasBudget).toBe(true);
    expect(v.over).toBe(false);
    expect(v.pct).toBe(25);
    expect(v.remaining).toBe("7500");
  });
  test("恰好达限 → over=true，剩余 0", () => {
    const v = budgetView("10000", "10000");
    expect(v.over).toBe(true);
    expect(v.pct).toBe(100);
    expect(v.remaining).toBe("0");
  });
  test("超限 → over=true，剩余 floor 到 0（不出现负数）", () => {
    const v = budgetView("10000", "13000");
    expect(v.over).toBe(true);
    expect(v.pct).toBe(100);
    expect(v.remaining).toBe("0");
  });
  test("预算 0 视为不限的宽松展示（hasBudget=false）", () => {
    const v = budgetView("0", "500");
    expect(v.hasBudget).toBe(false);
    expect(v.over).toBe(false);
  });
  test("大数不丢精度", () => {
    const v = budgetView("9007199254740993", "9007199254740992");
    expect(v.over).toBe(false);
    expect(v.remaining).toBe("1");
  });
});

describe("minSeatPriceYuan（落地页锚点价，取最低每席价→整元）", () => {
  test("多档取最低，去分到整元", () => {
    expect(
      minSeatPriceYuan([
        { code: "a", name: "A", seatPriceCents: "29800", perSeatCredits: "0", minSeats: 3, periodDays: 30 },
        { code: "b", name: "B", seatPriceCents: "8800", perSeatCredits: "0", minSeats: 3, periodDays: 30 },
      ]),
    ).toBe("88");
  });
  test("空列表 / 全 0 → null（调用方静态兜底）", () => {
    expect(minSeatPriceYuan([])).toBeNull();
    expect(
      minSeatPriceYuan([
        { code: "z", name: "Z", seatPriceCents: "0", perSeatCredits: "0", minSeats: 1, periodDays: 30 },
      ]),
    ).toBeNull();
  });
});
