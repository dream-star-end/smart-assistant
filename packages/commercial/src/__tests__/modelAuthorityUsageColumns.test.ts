/**
 * 模型权威批次 · 切片 6 —— usage_records 的四列权威留证(0135;方案 §4 / R3-m11)。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/modelAuthorityUsageColumns.test.ts
 *
 * 断言的是**列序与参数位**:execution_revision=$17 / projection_revision=$18 /
 * security_epoch=$19 / authority_kind=$20。列清单一旦变更本测试强制同步(与既有
 * usageAttribution.test.ts 的做法同源)。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";

import { settleUsageAndLedger } from "../billing/proxyBilling.js";

function makeSettleStubs() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const stubClient = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO usage_records")) {
        inserts.push({ sql, params: params ?? [] });
        return { rows: [{ id: "9001" }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    release: () => {},
  };
  const stubPool = { connect: async () => stubClient } as unknown as Pool;
  return { inserts, stubPool };
}

const base = {
  userId: 1n,
  accountId: null,
  model: "glm-5.2",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
  snapshotJson: "{}",
  costCredits: 0n, // cost=0 → 不走 ledger,聚焦 INSERT 参数
  status: "success" as const,
  sessionId: null,
};

describe("settleUsageAndLedger — 模型权威四列", () => {
  test("bridge_signed:四列按位落库(projection_revision 为 NULL)", async () => {
    const { inserts, stubPool } = makeSettleStubs();
    await settleUsageAndLedger(stubPool, {
      ...base,
      requestId: "req-bridge-1",
      authority: {
        executionRevision: "a".repeat(64),
        projectionRevision: null,
        securityEpoch: 7n,
        kind: "bridge_signed",
      },
    });
    const { sql, params } = inserts[0]!;
    assert.match(sql, /execution_revision/);
    assert.match(sql, /projection_revision/);
    assert.match(sql, /security_epoch/);
    assert.match(sql, /authority_kind/);
    assert.equal(params[16], "a".repeat(64));
    assert.equal(params[17], null);
    // BIGINT 用十进制字符串绑(BigInt 直传 pg 会抛;number 会丢精度)
    assert.equal(params[18], "7");
    assert.equal(params[19], "bridge_signed");
  });

  test("local_catalog:带 per-uid projectionRevision", async () => {
    const { inserts, stubPool } = makeSettleStubs();
    await settleUsageAndLedger(stubPool, {
      ...base,
      requestId: "req-local-1",
      authority: {
        executionRevision: "b".repeat(64),
        projectionRevision: "c".repeat(64),
        securityEpoch: 12n,
        kind: "local_catalog",
      },
    });
    const { params } = inserts[0]!;
    assert.equal(params[16], "b".repeat(64));
    assert.equal(params[17], "c".repeat(64));
    assert.equal(params[18], "12");
    assert.equal(params[19], "local_catalog");
  });

  test("未传 authority(legacy / 影子期 / codexFinalizer)→ 四列 NULL(落库形状不变)", async () => {
    const { inserts, stubPool } = makeSettleStubs();
    await settleUsageAndLedger(stubPool, { ...base, requestId: "req-legacy-1" });
    const { params } = inserts[0]!;
    assert.equal(params[16], null);
    assert.equal(params[17], null);
    assert.equal(params[18], null);
    assert.equal(params[19], null);
  });
});
