/**
 * provider 健康度 gate 读缓存单测(0108)。
 * 覆盖:effectiveHealth 派生生效降级集(三态)/ TTL 缓存 / fail-soft(读失败返回空集不误判)。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { QueryResult } from "pg";
import { getDegradedProviders, _resetGateForTest } from "./providerHealthGate.js";

type OpsRow = {
  provider_id: string;
  health_status: string | null;
  health_mode: string;
  degraded_since: Date | null;
  degrade_reason: string | null;
};

function runnerReturning(rows: OpsRow[], counter?: { n: number }) {
  return {
    async query() {
      if (counter) counter.n++;
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    },
  };
}
function throwingRunner() {
  return {
    async query(): Promise<QueryResult> {
      throw new Error("PG down");
    },
  };
}

beforeEach(() => {
  _resetGateForTest();
});

describe("getDegradedProviders — 三态派生", () => {
  const rows: OpsRow[] = [
    { provider_id: "deepseek", health_status: "healthy", health_mode: "forced_degraded", degraded_since: null, degrade_reason: null },
    { provider_id: "minimax", health_status: "degraded", health_mode: "auto", degraded_since: new Date(), degrade_reason: "x" },
    { provider_id: "ark", health_status: "degraded", health_mode: "forced_healthy", degraded_since: new Date(), degrade_reason: "x" },
    { provider_id: "kimi", health_status: "healthy", health_mode: "auto", degraded_since: null, degrade_reason: null },
  ];

  test("forced_degraded 与 auto+degraded 计入;forced_healthy 与 auto+healthy 不计入", async () => {
    const set = await getDegradedProviders(1000, runnerReturning(rows));
    assert.equal(set.has("deepseek"), true); // forced_degraded
    assert.equal(set.has("minimax"), true); // auto + observed degraded
    assert.equal(set.has("ark"), false); // forced_healthy 压住实测降级
    assert.equal(set.has("kimi"), false); // auto + healthy
    assert.equal(set.size, 2);
  });
});

describe("getDegradedProviders — TTL 缓存", () => {
  test("TTL 内第二次读走缓存(不再查库)", async () => {
    const counter = { n: 0 };
    const runner = runnerReturning(
      [{ provider_id: "minimax", health_status: "degraded", health_mode: "auto", degraded_since: null, degrade_reason: null }],
      counter,
    );
    await getDegradedProviders(1000, runner);
    await getDegradedProviders(1000 + 5000, runner); // < 15s TTL
    assert.equal(counter.n, 1);
    // 越过 TTL → 再查一次
    await getDegradedProviders(1000 + 20_000, runner);
    assert.equal(counter.n, 2);
  });
});

describe("getDegradedProviders — fail-soft", () => {
  test("读失败且无缓存 → 空集(绝不误判降级)", async () => {
    const set = await getDegradedProviders(1000, throwingRunner());
    assert.equal(set.size, 0);
  });

  test("读失败但有旧缓存 → 返回旧缓存(不清零)", async () => {
    await getDegradedProviders(1000, runnerReturning([
      { provider_id: "minimax", health_status: "degraded", health_mode: "auto", degraded_since: null, degrade_reason: null },
    ]));
    const set = await getDegradedProviders(1000 + 20_000, throwingRunner()); // 越 TTL 触发读 → 抛 → 回退旧缓存
    assert.equal(set.has("minimax"), true);
  });
});
