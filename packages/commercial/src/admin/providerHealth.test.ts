/**
 * provider 健康度纯判定层单测(0108)。
 * 覆盖:evaluateProviderHealth 状态机(降级/恢复/阈值边界/连续失败/aborted 排除/latency 辅助)
 *      + effectiveHealth 三态派生。不依赖 PG。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateProviderHealth,
  effectiveHealth,
  loadHealthThresholds,
  type HealthSample,
  type HealthThresholds,
} from "./providerHealth.js";

const T: HealthThresholds = {
  windowMin: 10,
  recoverWindowMin: 5,
  minSamples: 5,
  degradeRate: 0.6,
  consecutiveFails: 8,
  recoverRate: 0.2,
  latencyAuxConsecutive: 3,
  degradeRateAux: 0.5,
};

const NOW = 1_000_000_000_000;
function sample(ok: boolean, ageMs: number, kind = ok ? "final" : "upstream_5xx"): HealthSample {
  return { ok, kind, at: NOW - ageMs };
}

describe("evaluateProviderHealth — 降级判定", () => {
  test("样本足量且失败率达阈值 → to_degraded", () => {
    const samples = [
      ...Array.from({ length: 7 }, (_, i) => sample(false, i * 1000)),
      ...Array.from({ length: 3 }, (_, i) => sample(true, 8000 + i * 1000)),
    ]; // 7 fail / 10 = 70% ≥ 60%
    const r = evaluateProviderHealth({ samples, currentStatus: null, latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "to_degraded");
    assert.match(r.reason ?? "", /失败率/);
    assert.equal(r.snapshot.windowTotal, 10);
    assert.equal(r.snapshot.windowFailures, 7);
  });

  test("样本不足 minSamples → 不降级(小样本保护)", () => {
    const samples = Array.from({ length: 4 }, (_, i) => sample(false, i * 1000)); // 全失败但只有 4 条
    const r = evaluateProviderHealth({ samples, currentStatus: null, latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "none");
  });

  test("失败率低于阈值 → 不降级", () => {
    const samples = [
      ...Array.from({ length: 5 }, (_, i) => sample(false, i * 1000)),
      ...Array.from({ length: 5 }, (_, i) => sample(true, 6000 + i * 1000)),
    ]; // 50% < 60%
    const r = evaluateProviderHealth({ samples, currentStatus: null, latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "none");
  });

  test("连续失败达阈值 → to_degraded(无视失败率)", () => {
    // 8 连续失败(最新)+ 大量历史成功稀释失败率到 <60%,仍应因连续失败降级
    const samples = [
      ...Array.from({ length: 8 }, (_, i) => sample(false, i * 1000)),
      ...Array.from({ length: 20 }, (_, i) => sample(true, 10_000 + i * 1000)),
    ];
    const r = evaluateProviderHealth({ samples, currentStatus: null, latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "to_degraded");
    assert.match(r.reason ?? "", /连续失败/);
    assert.equal(r.snapshot.consecutiveFailures, 8);
  });

  test("aborted 样本从判定排除(不计入失败率/连续失败)", () => {
    // 6 aborted(客户端断)+ 4 final:排除 aborted 后 total=4 < minSamples → 不降级
    const samples = [
      ...Array.from({ length: 6 }, (_, i) => sample(false, i * 1000, "aborted")),
      ...Array.from({ length: 4 }, (_, i) => sample(true, 7000 + i * 1000)),
    ];
    const r = evaluateProviderHealth({ samples, currentStatus: null, latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "none");
    assert.equal(r.snapshot.windowTotal, 4);
    assert.equal(r.snapshot.consecutiveFailures, 0);
  });

  test("latency 辅助:仅加权(降阈值),绝不单独触发", () => {
    // 5 fail / 10 = 50%:默认 60% 不降;但 latency 连续 fail=3 → 阈值降到 50% → 降级
    const samples = [
      ...Array.from({ length: 5 }, (_, i) => sample(false, i * 1000)),
      ...Array.from({ length: 5 }, (_, i) => sample(true, 6000 + i * 1000)),
    ];
    const withAux = evaluateProviderHealth({ samples, currentStatus: null, latencyConsecutiveFails: 3, now: NOW, thresholds: T });
    assert.equal(withAux.transition, "to_degraded");
    assert.equal(withAux.snapshot.latencyAuxApplied, true);
    // 但样本不足时 latency 辅助不生效(不单独触发):4 条样本 + latency fail=5
    const few = Array.from({ length: 4 }, (_, i) => sample(false, i * 1000));
    const noTrigger = evaluateProviderHealth({ samples: few, currentStatus: null, latencyConsecutiveFails: 5, now: NOW, thresholds: T });
    assert.equal(noTrigger.transition, "none");
    assert.equal(noTrigger.snapshot.latencyAuxApplied, false);
  });
});

describe("evaluateProviderHealth — 恢复判定", () => {
  test("恢复窗口失败率低且有成功样本 → to_healthy", () => {
    const samples = [
      ...Array.from({ length: 9 }, (_, i) => sample(true, i * 1000)), // 近端全成功
      sample(false, 9000),
    ]; // 恢复窗(5min)内失败率 ~10% < 20% 且有成功
    const r = evaluateProviderHealth({ samples, currentStatus: "degraded", latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "to_healthy");
  });

  test("已 degraded 但恢复窗仍高失败率 → 不恢复", () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(false, i * 1000));
    const r = evaluateProviderHealth({ samples, currentStatus: "degraded", latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "none");
  });

  test("恢复窗无任何样本 → 不恢复(需成功样本证据)", () => {
    // 样本都在恢复窗(5min)之外
    const samples = Array.from({ length: 6 }, (_, i) => sample(true, 6 * 60_000 + i * 1000));
    const r = evaluateProviderHealth({ samples, currentStatus: "degraded", latencyConsecutiveFails: 0, now: NOW, thresholds: T });
    assert.equal(r.transition, "none");
  });
});

describe("effectiveHealth — 三态派生", () => {
  test("auto + 观测 degraded → 生效 degraded,带 since/reason", () => {
    const e = effectiveHealth({
      health_status: "degraded",
      health_mode: "auto",
      degraded_since: new Date(NOW),
      degrade_reason: "失败率 70%",
    });
    assert.equal(e.degraded, true);
    assert.equal(e.mode, "auto");
    assert.equal(e.observed, "degraded");
    assert.equal(e.reason, "失败率 70%");
    assert.ok(e.since);
  });

  test("auto + 观测 healthy → 生效 healthy,since/reason 清空", () => {
    const e = effectiveHealth({ health_status: "healthy", health_mode: "auto", degraded_since: null, degrade_reason: "旧理由" });
    assert.equal(e.degraded, false);
    assert.equal(e.since, null);
    assert.equal(e.reason, null);
  });

  test("forced_degraded → 生效 degraded(无视观测),reason 兜底", () => {
    const e = effectiveHealth({
      health_status: "healthy",
      health_mode: "forced_degraded",
      degraded_since: null,
      degrade_reason: null,
      ops_updated_at: new Date(NOW),
    });
    assert.equal(e.degraded, true);
    assert.equal(e.observed, "healthy"); // 观测与生效分离
    assert.equal(e.reason, "管理员强制降级");
    assert.ok(e.since); // 回退到 ops_updated_at
  });

  test("forced_healthy → 恒生效 healthy(压误判),即便观测 degraded", () => {
    const e = effectiveHealth({ health_status: "degraded", health_mode: "forced_healthy", degraded_since: new Date(NOW), degrade_reason: "x" });
    assert.equal(e.degraded, false);
    assert.equal(e.observed, "degraded");
  });
});

describe("loadHealthThresholds — env 缺省与夹取", () => {
  test("无 env → 缺省值", () => {
    const t = loadHealthThresholds();
    assert.equal(t.minSamples, 5);
    assert.equal(t.degradeRate, 0.6);
    assert.equal(t.consecutiveFails, 8);
    assert.equal(t.recoverRate, 0.2);
  });
});
