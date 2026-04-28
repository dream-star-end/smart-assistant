/**
 * 0042 — quarantine reason taxonomy / priority 纯函数单测。
 *
 * 这层只测枚举 + 谓词,不依赖 PG / IO。queries.ts 内部 setQuarantined / applyHealthSnapshot
 * 的优先级判定全部走这里的 softReasonPriority + isHardQuarantineReason,任何调整都
 * 应先有这套用例兜底。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  QUARANTINE_REASONS,
  SOFT_QUARANTINE_REASONS,
  HARD_QUARANTINE_REASONS,
  isSoftQuarantineReason,
  isHardQuarantineReason,
  softReasonPriority,
} from "../compute-pool/types.js";

describe("QUARANTINE_REASONS taxonomy", () => {
  test("soft 三类 + hard 三类 不重叠且总集 = 全部 reason", () => {
    const all = new Set(Object.values(QUARANTINE_REASONS));
    const soft = new Set(SOFT_QUARANTINE_REASONS);
    const hard = new Set(HARD_QUARANTINE_REASONS);
    // 不重叠
    for (const r of soft) {
      assert.equal(hard.has(r), false, `soft reason ${r} 不应在 hard 集合中`);
    }
    // 并集 = 全集
    const union = new Set([...soft, ...hard]);
    assert.equal(union.size, all.size);
    for (const r of all) {
      assert.equal(union.has(r), true, `reason ${r} 必须落在 soft 或 hard 集合`);
    }
  });

  test("isSoftQuarantineReason / isHardQuarantineReason 互斥且不漏", () => {
    for (const r of Object.values(QUARANTINE_REASONS)) {
      const soft = isSoftQuarantineReason(r);
      const hard = isHardQuarantineReason(r);
      assert.notEqual(soft, hard, `reason ${r} 必须严格一边一边`);
    }
  });

  test("isSoftQuarantineReason / isHardQuarantineReason 对 null/undefined 返回 false", () => {
    assert.equal(isSoftQuarantineReason(null), false);
    assert.equal(isSoftQuarantineReason(undefined), false);
    assert.equal(isHardQuarantineReason(null), false);
    assert.equal(isHardQuarantineReason(undefined), false);
  });
});

describe("softReasonPriority 顺序", () => {
  test("uplink-probe-failed > health-poll-fail > egress-probe-failed", () => {
    // 数字越小优先级越高
    const uplink = softReasonPriority("uplink-probe-failed");
    const health = softReasonPriority("health-poll-fail");
    const egress = softReasonPriority("egress-probe-failed");
    assert.ok(uplink < health, "uplink 必须比 health 优先");
    assert.ok(health < egress, "health 必须比 egress 优先");
  });

  test("hard reason 不参与 soft 优先级序(返 99 兜底)", () => {
    // 设计:hard reason 不应该被 softReasonPriority 调用,但兜底返 99 避免 NaN/undefined。
    for (const r of HARD_QUARANTINE_REASONS) {
      assert.equal(softReasonPriority(r), 99, `hard reason ${r} fallback 应是 99`);
    }
  });
});
