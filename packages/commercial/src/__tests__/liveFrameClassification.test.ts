import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";

import {
  classifyRetiredLiveJournals,
  dryRunLiveFrameRestore,
} from "../db/liveFrameClassification.js";
import {
  auditLiveRetentionCoverage,
  RETENTION_REGISTRY,
} from "../admin/retentionRegistry.js";
import { PERMANENT_OPS_LEDGER_TABLES } from "../admin/auditRetention.js";
import { collectBusinessHealthSnapshot } from "../admin/businessHealth.js";

function timeoutErr(): Error & { code: string } {
  return Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
}

function makePool(handler: (sql: string) => Promise<unknown> | unknown): Pool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeClient: any = {
    async query(sqlOrCfg: unknown) {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      return handler(sql);
    },
    release() {
      /* noop */
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePool: any = {
    async connect() {
      return fakeClient as PoolClient;
    },
    async query(sqlOrCfg: unknown) {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      return handler(sql);
    },
  };
  return fakePool as Pool;
}

describe("live frame classification (OCV5-180 C2)", () => {
  test("classifies inflight / tapeRecoverable / uniqueCopy without DELETE", async () => {
    const sqls: string[] = [];
    const pool = makePool(async (sql) => {
      sqls.push(sql);
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") return { rows: [] };
      if (trimmed.startsWith("SET LOCAL")) return { rows: [] };
      if (trimmed.includes("SELECT COUNT(*)::bigint AS scanned")) {
        return { rows: [{ scanned: "3" }] };
      }
      if (trimmed.includes("WITH sampled AS")) {
        return {
          rows: [
            {
              class: "inflight",
              streams: "1",
              frames: "4",
              bytes: "40",
              oldest_updated_at: "2026-09-08T00:00:00.000Z",
            },
            {
              class: "tapeRecoverable",
              streams: "1",
              frames: "2",
              bytes: "20",
              oldest_updated_at: "2026-08-01T00:00:00.000Z",
            },
            {
              class: "uniqueCopy",
              streams: "1",
              frames: "8",
              bytes: "80",
              oldest_updated_at: "2026-07-01T00:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`unhandled SQL: ${trimmed.slice(0, 80)}`);
    });
    const result = await classifyRetiredLiveJournals(pool);
    assert.equal(result.unknown, false);
    if (result.unknown) return;
    assert.equal(result.inflight.streams, 1);
    assert.equal(result.tapeRecoverable.streams, 1);
    assert.equal(result.uniqueCopy.streams, 1);
    assert.equal(result.uniqueCopy.frames, 8);
    assert.equal(
      sqls.some((s) => /\bDELETE\b|\bUPDATE\b|\bINSERT\b/i.test(s) && !s.includes("SET LOCAL")),
      false,
    );
  });

  test("timeout returns unknown with null counts, never fake 0", async () => {
    const pool = makePool(async (sql) => {
      if (sql.trim() === "BEGIN" || sql.trim().startsWith("SET LOCAL")) return { rows: [] };
      if (sql.trim() === "ROLLBACK") return { rows: [] };
      throw timeoutErr();
    });
    const result = await classifyRetiredLiveJournals(pool, { statementTimeoutMs: 10 });
    assert.equal(result.unknown, true);
    if (!result.unknown) return;
    assert.equal(result.inflight, null);
    assert.equal(result.tapeRecoverable, null);
    assert.equal(result.uniqueCopy, null);
    assert.equal(result.reason, "timeout");
  });

  test("dry-run restore samples tape reachable vs replay_live and writes nothing", async () => {
    const sqls: string[] = [];
    const pool = makePool(async (sql) => {
      sqls.push(sql);
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") return { rows: [] };
      if (trimmed.startsWith("SET LOCAL")) return { rows: [] };
      if (trimmed.includes("AS reachable")) {
        return { rows: [{ stream_key: "s-b", tape_id: "tape-1", reachable: true }] };
      }
      if (trimmed.includes("restore") || trimmed.includes("tape_id IS NULL")) {
        return { rows: [{ stream_key: "s-c" }] };
      }
      throw new Error(`unhandled SQL: ${trimmed.slice(0, 80)}`);
    });
    const result = await dryRunLiveFrameRestore(pool, { sampleN: 2 });
    assert.equal(result.unknown, false);
    assert.deepEqual(result.tapeRecoverableSample, [
      { streamKey: "s-b", tapeId: "tape-1", reachable: true },
    ]);
    assert.deepEqual(result.uniqueCopySample, [{ streamKey: "s-c", restore: "replay_live" }]);
    assert.equal(sqls.some((s) => /\bDELETE\b|\bUPDATE\b|\bINSERT\b/i.test(s)), false);
  });
});

describe("retention ledger + business health (OCV5-180 C4/I3)", () => {
  test("model_pricing_0903_cw_backup is a permanent ledger and never a TTL table", () => {
    assert.ok(PERMANENT_OPS_LEDGER_TABLES.includes("model_pricing_0903_cw_backup"));
    assert.equal(RETENTION_REGISTRY.model_pricing_0903_cw_backup?.kind, "permanent-ledger");
  });

  test("live coverage reports unregistered names; timeout/error is unknown not empty-green", async () => {
    const ok = await auditLiveRetentionCoverage({
      query: async () => ({
        rows: [
          { table_name: "model_pricing_0903_cw_backup" },
          { table_name: "handmade_orphan" },
        ],
      }),
    });
    assert.equal(ok.unknown, false);
    assert.deepEqual(ok.unregistered, ["handmade_orphan"]);

    const failed = await auditLiveRetentionCoverage({
      query: async () => {
        throw timeoutErr();
      },
    });
    assert.equal(failed.unknown, true);
    assert.equal(failed.unregistered, null);
  });

  test("business health snapshot has no ok field and preserves unknown", async () => {
    const pool = makePool(async (sql) => {
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") return { rows: [] };
      if (trimmed.startsWith("SET LOCAL")) return { rows: [] };
      if (trimmed.includes("turn_tape_materialization_jobs")) {
        throw timeoutErr();
      }
      if (trimmed.includes("turn_tape_settlement_jobs")) {
        return { rows: [{ count: "3", oldest: "2026-09-01T00:00:00.000Z" }] };
      }
      if (trimmed.includes("cursor_external_usage_audit")) {
        return { rows: [{ count: "132", oldest: "2026-08-15T00:00:00.000Z" }] };
      }
      if (trimmed.includes("SELECT COUNT(*)::bigint AS scanned")) {
        return { rows: [{ scanned: "1" }] };
      }
      if (trimmed.includes("WITH sampled AS")) {
        return {
          rows: [
            {
              class: "uniqueCopy",
              streams: "1",
              frames: "1",
              bytes: "10",
              oldest_updated_at: "2026-07-01T00:00:00.000Z",
            },
          ],
        };
      }
      if (trimmed.includes("information_schema.tables")) {
        return { rows: [{ table_name: "model_pricing_0903_cw_backup" }] };
      }
      throw new Error(`unhandled SQL: ${trimmed.slice(0, 80)}`);
    });
    const snapshot = await collectBusinessHealthSnapshot(pool, { statementTimeoutMs: 50 });
    assert.equal("ok" in snapshot, false);
    assert.equal(snapshot.backupFreshness, "not_in_scope");
    assert.equal(snapshot.tapeMaterialization.unknown, true);
    assert.equal(snapshot.tapeMaterialization.count, null);
    assert.equal(snapshot.settlementHeld.unknown, false);
    if (snapshot.settlementHeld.unknown) return;
    assert.equal(snapshot.settlementHeld.count, 3);
    assert.equal(snapshot.cursorAuditSuccessWithoutUsage.unknown, false);
    if (!snapshot.cursorAuditSuccessWithoutUsage.unknown) {
      assert.equal(snapshot.cursorAuditSuccessWithoutUsage.count, 132);
    }
    assert.equal(snapshot.retentionUnknown, false);
    assert.deepEqual(snapshot.retentionUnregistered, []);
  });
});
