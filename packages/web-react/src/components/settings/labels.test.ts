import { describe, expect, test } from "vitest";
import { apiRequestStatusLabel, ledgerReasonLabel, ledgerReasonView, ledgerRowView } from "./labels";

describe("ledgerReasonView（审计 SET-16：未知 reason 显示「其他」并保留原值）", () => {
  test("已知 reason → 中文标签，raw 为 null", () => {
    expect(ledgerReasonView("topup")).toEqual({ label: "充值到账", raw: null });
    expect(ledgerReasonView("usage_charge")).toEqual({ label: "对话扣费", raw: null });
  });

  test("未知 reason → 「其他」+ raw 原文（可挂 title，观测不丢）", () => {
    expect(ledgerReasonView("mystery_backend_reason")).toEqual({
      label: "其他",
      raw: "mystery_backend_reason",
    });
    // 旧的 ledgerReasonLabel 仍原样回退，供图表 legend 等开发者可见位置使用
    expect(ledgerReasonLabel("mystery_backend_reason")).toBe("mystery_backend_reason");
  });
  test("workload=auto_dream → 「记忆整理」(OCV5-392: reason 仍为 chat)", () => {
    expect(ledgerReasonView("chat", "auto_dream")).toEqual({ label: "记忆整理", raw: null });
    expect(ledgerReasonView("chat", null)).toEqual({ label: "其他", raw: "chat" });
  });
});

describe("apiRequestStatusLabel（审计 SET-25：外接 API 结果码 → 中文）", () => {
  test("常见状态码映射", () => {
    expect(apiRequestStatusLabel("success")).toBe("成功");
    expect(apiRequestStatusLabel("insufficient_credits")).toBe("余额不足");
    expect(apiRequestStatusLabel("rate_limited")).toBe("已限流");
    expect(apiRequestStatusLabel("key_revoked")).toBe("密钥已撤销");
  });

  test("未知码回退原文；空值显示破折号", () => {
    expect(apiRequestStatusLabel("some_new_code")).toBe("some_new_code");
    expect(apiRequestStatusLabel(null)).toBe("—");
    expect(apiRequestStatusLabel(undefined)).toBe("—");
    expect(apiRequestStatusLabel("")).toBe("—");
  });
});


describe("subscription ledger presentation", () => {
  const row = { reason: "subscription_expire", ref_type: "subscription", ref_id: "order-lite",
    memo: "expire 300 on lite renew/rollover" };
  test("paid order settlement explains historical free quota replacement", () => {
    expect(ledgerRowView(row)).toEqual({ label: "订单生效，旧额度结清", raw: null,
      memo: "旧周期剩余 300 积分结清，新周期额度另行到账" });
    expect(ledgerReasonView("subscription").label).toBe("订阅额度到账");
  });
  test("automatic rollover stays a period settlement; unknown memos remain visible", () => {
    expect(ledgerRowView({ ...row, ref_id: null }).label).toBe("周期额度结清");
    expect(ledgerRowView({ ...row, ref_type: "other" }).label).toBe("周期额度结清");
    expect(ledgerRowView({ ...row, memo: "operator note" }).memo).toBe("operator note");
    expect(ledgerRowView({ ...row, memo: null }).memo).toBeNull();
    expect(ledgerRowView({ ...row, reason: "unknown" })).toEqual({ label: "其他", raw: "unknown", memo: row.memo });
  });
});
