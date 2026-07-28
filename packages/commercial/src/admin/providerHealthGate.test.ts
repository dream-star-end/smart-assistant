/**
 * provider 健康度 gate 读缓存单测(0108)。
 * 覆盖:effectiveHealth 派生生效降级集(三态)/ TTL 缓存 / fail-soft(读失败返回空集不误判)。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { QueryResult } from "pg";
import {
  getDegradedProviders,
  getProviderRoutingAvailability,
  getProviderQuotaBlock,
  _resetGateForTest,
} from "./providerHealthGate.js";

type OpsRow = {
  provider_id: string;
  health_status: string | null;
  health_mode: string;
  degraded_since: Date | null;
  degrade_reason: string | null;
  quota_retry_at?: Date | null;
  quota_probe_lease_until?: Date | null;
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

describe("getDegradedProviders — exact quota block", () => {
  const base: OpsRow = {
    provider_id: "moonshot",
    health_status: "healthy",
    health_mode: "auto",
    degraded_since: null,
    degrade_reason: null,
    quota_retry_at: new Date(20_000),
    quota_probe_lease_until: null,
  };

  test("active quota annotates degraded; expired row remains visible for half-open claim", async () => {
    const active = await getDegradedProviders(10_000, runnerReturning([base]));
    assert.equal(active.has("moonshot"), true);
    _resetGateForTest();
    const expired = await getDegradedProviders(30_000, runnerReturning([base]));
    assert.equal(expired.has("moonshot"), false);
    assert.deepEqual(
      await getProviderQuotaBlock("moonshot", 30_000, runnerReturning([base])),
      { retryAt: 20_000, probeLeaseUntil: null },
    );
  });

  test("quota-only provider is read even when sparse provider_ops has no row", async () => {
    let statement = "";
    const runner = {
      async query(sql: string) {
        statement = sql;
        return { rows: [base], rowCount: 1 } as unknown as QueryResult;
      },
    };
    const set = await getDegradedProviders(10_000, runner);
    assert.equal(set.has("moonshot"), true);
    assert.match(statement, /FULL OUTER JOIN provider_quota_blocks/);
  });

  test("active probe lease keeps concurrent requests blocked after retry_at", async () => {
    const row = { ...base, quota_probe_lease_until: new Date(40_000) };
    const set = await getDegradedProviders(30_000, runnerReturning([row]));
    assert.equal(set.has("moonshot"), true);
  });
});

describe("getProviderRoutingAvailability — team fallback revision", () => {
  const rows: OpsRow[] = [
    {
      provider_id: "deepseek",
      health_status: "degraded",
      health_mode: "auto",
      degraded_since: new Date(),
      degrade_reason: "probe",
      quota_retry_at: null,
      quota_probe_lease_until: null,
    },
    {
      provider_id: "ark",
      health_status: "healthy",
      health_mode: "auto",
      degraded_since: null,
      degrade_reason: null,
      quota_retry_at: new Date(20_000),
      quota_probe_lease_until: null,
    },
  ];

  test("quota always blocks; health only blocks when enforcement is enabled", async () => {
    const shadow = await getProviderRoutingAvailability(10_000, runnerReturning(rows), false);
    assert.deepEqual([...shadow.unavailableProviderIds], ["ark"]);

    _resetGateForTest();
    const enforced = await getProviderRoutingAvailability(10_000, runnerReturning(rows), true);
    assert.deepEqual([...enforced.unavailableProviderIds].sort(), ["ark", "deepseek"]);
    assert.notEqual(enforced.revision, shadow.revision);
  });

  test("quota state changes the revision", async () => {
    const blocked = await getProviderRoutingAvailability(10_000, runnerReturning(rows), false);
    _resetGateForTest();
    const expired = await getProviderRoutingAvailability(30_000, runnerReturning(rows), false);
    assert.notEqual(blocked.revision, expired.revision);
    assert.equal(expired.unavailableProviderIds.size, 0);
  });
});
