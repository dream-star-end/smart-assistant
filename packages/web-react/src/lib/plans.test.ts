import { describe, expect, test } from "vitest";
import { PLANS, TOPUP_PACK } from "./plans";

describe("套餐数据（落地页营销展示权威源）", () => {
  test("4 档包月套餐价格 / 月度积分与产品定档一致", () => {
    const byId = Object.fromEntries(PLANS.map((p) => [p.id, p]));
    expect(PLANS).toHaveLength(4);
    expect(byId.free).toMatchObject({ price: 0, credits: 300 });
    expect(byId.pro).toMatchObject({ price: 88, credits: 10000 });
    expect(byId.max).toMatchObject({ price: 298, credits: 35000 });
    expect(byId.ultra).toMatchObject({ price: 498, credits: 60000 });
  });

  test("仅一档 highlight（最受欢迎 = Max）", () => {
    const highlighted = PLANS.filter((p) => p.highlight);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].id).toBe("max");
  });

  test("加量包：¥50 / 5000 积分，套餐有效期内可用", () => {
    expect(TOPUP_PACK.price).toBe(50);
    expect(TOPUP_PACK.credits).toBe(5000);
    expect(TOPUP_PACK.note).toMatch(/有效期/);
  });
});
