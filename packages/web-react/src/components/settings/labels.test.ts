import { describe, expect, test } from "vitest";
import { apiRequestStatusLabel, ledgerReasonLabel, ledgerReasonView, ledgerRowView, shortTime } from "./labels";

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
    // #1237:chat 是对话扣费的真实写法(此前漏映射而显示「其他」)。
    expect(ledgerReasonView("chat", null)).toEqual({ label: "对话扣费", raw: null });
  });
  test("credit_ledger CHECK 中的写侧 reason 都有中文标签", () => {
    for (const r of [
      "topup", "chat", "agent_chat", "agent_subscription", "refund", "admin_adjust", "promotion",
      "minimax_media", "image_generation", "subscription", "subscription_expire", "pack",
    ]) {
      expect(ledgerReasonView(r).raw).toBeNull();
    }
  });
});

describe("对话扣费 / 退费行文案（#1237：不展示内部 memo）", () => {
  const chat = { reason: "chat", ref_type: "usage_record", ref_id: "29026", memo: "cost=53" };
  test("有模型名与会话标题 → 「模型 · 会话」", () => {
    expect(ledgerRowView({ ...chat, model_name: "GPT-6.1-Sol", session_title: "office-1029pm" })).toEqual({
      label: "对话扣费", raw: null, memo: "GPT-6.1-Sol · office-1029pm",
    });
    expect(ledgerRowView({ ...chat, model_name: "Kimi K3", session_title: null }).memo).toBe("Kimi K3");
  });
  test("旧后端无上下文 → 不显示 cost=<n>", () => {
    expect(ledgerRowView(chat).memo).toBeNull();
  });
  test("免单退费 memo 转白话，turn 哈希不外露", () => {
    const refund = { reason: "refund", ref_type: "usage_record", ref_id: "1", model_name: "GPT-6.1-Sol" };
    expect(ledgerRowView({ ...refund, memo: "waive:idle_timeout;turn:6a18" })).toEqual({
      label: "退费", raw: null, memo: "对话超时未完成，已退回",
    });
    expect(ledgerRowView({ ...refund, memo: "waive:no_response;turn:eacb" }).memo).toBe("模型未返回内容，已退回");
    expect(ledgerRowView({ ...refund, memo: "waive:new_code;turn:ab" }).memo).toBe("未完成的对话，已退回");
  });
});

describe("shortTime（#1237：固定北京时间，不随浏览器时区）", () => {
  test("UTC 03:12 → 北京时间同日 11:12", () => {
    expect(shortTime("2026-10-29T03:12:24.566Z")).toBe("10月29日 11:12");
    expect(shortTime("2026-10-28T16:05:00.000Z")).toBe("10月29日 00:05");
    expect(shortTime("not-a-date")).toBe("");
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
