import { describe, expect, test } from "vitest";
import { claimProblemCardReport, problemCardReportKey } from "./problemCardReportGuard";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const key = problemCardReportKey({
  sessionId: "s1", rootCmid: "u1", outcome: "failed", path: "decision_declined", code: "service_restart",
});

describe("失败卡上报去重", () => {
  test("同一张卡在刷新 / 重连 / 另一标签页(共用 localStorage)只报一次", () => {
    const store = memoryStore();
    expect(claimProblemCardReport(key, 1_000, store)).toBe(true);
    // 管理员数据:同一张卡 71 分钟里 20 条连接报了 35 次。
    for (let i = 1; i <= 35; i += 1) expect(claimProblemCardReport(key, 1_000 + i * 120_000, store)).toBe(false);
  });

  test("不同结果或不同卡各报各的", () => {
    const store = memoryStore();
    expect(claimProblemCardReport(key, 1, store)).toBe(true);
    expect(claimProblemCardReport(key.replace(":failed:", ":recovered:"), 1, store)).toBe(true);
    expect(claimProblemCardReport(key.replace("u1", "u2"), 1, store)).toBe(true);
  });

  test("24 小时后同一键可再报", () => {
    const store = memoryStore();
    expect(claimProblemCardReport(key, 0, store)).toBe(true);
    expect(claimProblemCardReport(key, 24 * 60 * 60 * 1000, store)).toBe(true);
  });

  test("存储不可用或损坏时照常上报", () => {
    const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} };
    expect(claimProblemCardReport(key, 1, broken)).toBe(true);
    expect(claimProblemCardReport(key, 1, undefined)).toBe(true);
    const garbage = memoryStore();
    garbage.setItem("oc:problem-card-reports:v1", "[1,2]");
    expect(claimProblemCardReport(key, 1, garbage)).toBe(true);
    expect(claimProblemCardReport(key, 2, garbage)).toBe(false);
  });
});
