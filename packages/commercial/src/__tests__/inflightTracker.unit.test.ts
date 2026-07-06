/**
 * 0106 — per-model 在飞计量单测(纯内存,无 DB)。
 * 跑法: npx tsx --test packages/commercial/src/__tests__/inflightTracker.unit.test.ts
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  trackModelRequestStart,
  trackModelRequestEnd,
  snapshotInflight,
  _resetInflightForTests,
} from "../http/proxy/inflightTracker.js";

describe("inflightTracker", () => {
  beforeEach(() => _resetInflightForTests());

  it("start/end 配对:current 归零后从 map 清出,peak 保留", () => {
    trackModelRequestStart("glm-5.2");
    trackModelRequestStart("glm-5.2");
    trackModelRequestEnd("glm-5.2");
    let s = snapshotInflight();
    assert.equal(s.by_model["glm-5.2"].current, 1);
    assert.equal(s.by_model["glm-5.2"].peak, 2);
    trackModelRequestEnd("glm-5.2");
    s = snapshotInflight();
    assert.equal(s.by_model["glm-5.2"].current, 0);
    assert.equal(s.by_model["glm-5.2"].peak, 2, "peak 自进程启动累计,不随归零消失");
    assert.equal(s.total_current, 0);
  });

  it("多模型独立计量 + total 合计", () => {
    trackModelRequestStart("kimi-k2.7-code");
    trackModelRequestStart("qwen3.7-max");
    trackModelRequestStart("qwen3.7-max");
    const s = snapshotInflight();
    assert.equal(s.by_model["kimi-k2.7-code"].current, 1);
    assert.equal(s.by_model["qwen3.7-max"].current, 2);
    assert.equal(s.total_current, 3);
  });

  it("多余的 end(防御)不把 current 打成负数", () => {
    trackModelRequestStart("glm-5.2");
    trackModelRequestEnd("glm-5.2");
    trackModelRequestEnd("glm-5.2"); // 重复 end
    const s = snapshotInflight();
    assert.equal(s.by_model["glm-5.2"].current, 0);
    assert.equal(s.total_current, 0);
  });

  it("peak_at 随新峰值更新", () => {
    trackModelRequestStart("m");
    const first = snapshotInflight().by_model["m"].peak_at;
    trackModelRequestStart("m");
    const s = snapshotInflight().by_model["m"];
    assert.equal(s.peak, 2);
    assert.ok(s.peak_at >= first);
  });
});
