/**
 * OCV5-537(FINDINGS DAT-8):保留期裁定不能无限拖延,且 wechat_audit 的 7 天清理真的在跑。
 * 无 DB:SQL 执行全部注入。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AUDIT_RETENTION_POLICIES,
  WECHAT_AUDIT_SWEEP_BATCH,
  WECHAT_AUDIT_SWEEP_DAYS,
  startAuditRetentionSweeper,
  sweepWechatAudit,
} from "../admin/auditRetention.js";
import { DEFERRED_TABLES, RETENTION_REGISTRY } from "../admin/retentionRegistry.js";

describe("deferred retention decisions expire (DAT-8)", () => {
  test("no deferred table is past its due date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = Object.entries(DEFERRED_TABLES)
      .filter(([, d]) => d.dueDate < today)
      .map(([t, d]) => `${t} (owner ${d.owner}, due ${d.dueDate})`);
    assert.deepEqual(overdue, [], `decide these or set a new dated owner decision: ${overdue.join("; ")}`);
  });

  test("every deferred due date is a real YYYY-MM-DD date", () => {
    for (const [t, d] of Object.entries(DEFERRED_TABLES)) {
      assert.match(d.dueDate, /^\d{4}-\d{2}-\d{2}$/, t);
      assert.equal(new Date(`${d.dueDate}T00:00:00Z`).toISOString().slice(0, 10), d.dueDate, t);
    }
  });

  test("the three 2026-09-30 decisions are settled", () => {
    assert.deepEqual(RETENTION_REGISTRY.wechat_audit, {
      kind: "bespoke-sweeper",
      sweeper: "auditRetentionSweeper.sweepWechatAudit (admin/auditRetention.ts)",
    });
    assert.deepEqual(RETENTION_REGISTRY.response_rating, { kind: "durable" });
    // Marketplace rating aggregates join usage events to ratings over the full history, so no TTL.
    assert.deepEqual(RETENTION_REGISTRY.marketplace_skill_usage_events, { kind: "durable" });
    assert.equal(AUDIT_RETENTION_POLICIES.some((x) => x.table === "marketplace_skill_usage_events"), false);
  });
});

describe("wechat_audit 7-day sweep (DAT-8)", () => {
  test("deletes by epoch-ms received_at in bounded batches", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const n = await sweepWechatAudit(async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 4 };
    });
    assert.equal(n, 4);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /DELETE FROM wechat_audit/);
    assert.match(calls[0].sql, /received_at < \(EXTRACT\(EPOCH FROM NOW\(\)\) \* 1000\)::bigint - \$1::bigint \* 86400000/);
    assert.match(calls[0].sql, /LIMIT \$2/);
    assert.deepEqual(calls[0].params, [String(WECHAT_AUDIT_SWEEP_DAYS), WECHAT_AUDIT_SWEEP_BATCH]);
    assert.equal(WECHAT_AUDIT_SWEEP_DAYS, 7);
  });

  test("the audit retention tick runs it and reports per table; a failure is isolated", async () => {
    let wechatRuns = 0;
    const errors: string[] = [];
    const h = startAuditRetentionSweeper({
      intervalMs: 3_600_000,
      purgeFn: async () => 0,
      sessionGoalsPurgeFn: async () => 0,
      wechatAuditPurgeFn: async () => {
        wechatRuns += 1;
        if (wechatRuns === 2) throw new Error("boom");
        return 3;
      },
      onError: (t) => errors.push(t),
    });
    try {
      assert.equal((await h.runNow()).wechat_audit, 3);
      assert.equal((await h.runNow()).wechat_audit, -1);
      assert.deepEqual(errors, ["wechat_audit"]);
    } finally {
      await h.stop();
    }
  });
});
