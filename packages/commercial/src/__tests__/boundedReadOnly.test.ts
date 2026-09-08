import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";

import { collectBusinessHealthSnapshot } from "../admin/businessHealth.js";
import { auditLiveRetentionCoverage } from "../admin/retentionRegistry.js";
import {
  BoundedReadError,
  withBoundedReadOnly,
  type BoundedReadClient,
} from "../db/boundedReadOnly.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function txnSql(sql: string): boolean {
  const trimmed = sql.trim();
  return /^BEGIN\b/i.test(trimmed) || trimmed.startsWith("SET LOCAL") || trimmed === "COMMIT" || trimmed === "ROLLBACK";
}

function okClient(onQuery?: (sql: string) => void): BoundedReadClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (async (sqlOrCfg: unknown) => {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      onQuery?.(sql);
      if (txnSql(sql) || sql.includes("SELECT 1")) return { rows: [{ ok: 1 }] };
      throw new Error(`unhandled SQL: ${sql.slice(0, 80)}`);
    }) as BoundedReadClient["query"],
    release() {
      /* noop */
    },
  };
}

function abortableClient(
  handler: (sql: string) => { hang: true } | Promise<unknown> | unknown,
): BoundedReadClient {
  const pending: Array<(err: Error) => void> = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (async (sqlOrCfg: unknown) => {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      const result = handler(sql);
      if (result && typeof result === "object" && "hang" in result && result.hang === true) {
        return await new Promise((_, reject) => pending.push(reject));
      }
      return result;
    }) as BoundedReadClient["query"],
    release() {
      const err = new Error("client released");
      for (const reject of pending.splice(0)) reject(err);
    },
  };
}

describe("captain isolated reds (OCV5-180 C readonly bounds)", () => {
  test("connection refusal must remain unknown in the business-health snapshot", async () => {
    const pool = {
      connect: async () => {
        throw new Error("isolated ECONNREFUSED");
      },
      query: async () => {
        throw new Error("isolated ECONNREFUSED");
      },
    } as unknown as Pool;
    await assert.doesNotReject(async () => {
      const result = await collectBusinessHealthSnapshot(pool, { statementTimeoutMs: 1 });
      assert.equal(result.tapeMaterialization.unknown, true);
      assert.equal(result.tapeMaterialization.count, null);
      assert.equal(result.retentionUnknown, true);
    });
  });

  test("a stalled pool acquisition must not outlive the bounded health check", async () => {
    const abort: Array<(err: Error) => void> = [];
    const pool = {
      connect: () =>
        new Promise<never>((_, reject) => {
          abort.push(reject);
        }),
      query: () =>
        new Promise<never>((_, reject) => {
          abort.push(reject);
        }),
    } as unknown as Pool;
    const result = await Promise.race([
      collectBusinessHealthSnapshot(pool, { statementTimeoutMs: 1 }).then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 100)),
    ]);
    assert.equal(result, "settled");
    for (const reject of abort) reject(new Error("test cleanup"));
  });
});

describe("bounded read-only helper", () => {
  test("opens BEGIN READ ONLY and never sets default_transaction_read_only on the current txn", async () => {
    const sqls: string[] = [];
    const client = okClient((sql) => sqls.push(sql));
    const value = await withBoundedReadOnly({ connect: async () => client }, 200, async (c) => {
      await c.query("SELECT 1");
      return 11;
    });
    assert.equal(value, 11);
    assert.equal(sqls.some((sql) => /^\s*BEGIN READ ONLY\s*$/i.test(sql)), true);
    assert.equal(sqls.some((sql) => /default_transaction_read_only/i.test(sql)), false);
  });

  test("query timeout destroys the client and does not hang", async () => {
    let releases = 0;
    const inner = abortableClient((sql) => {
      if (txnSql(sql)) return { rows: [] };
      return { hang: true };
    });
    const client: BoundedReadClient = {
      query: inner.query.bind(inner),
      release(err?: Error | boolean) {
        releases += 1;
        inner.release?.(err);
      },
    };
    await assert.rejects(
      withBoundedReadOnly({ connect: async () => client }, 30, async (c) => {
        await c.query("SELECT hang");
        return 1;
      }),
      (err: unknown) => err instanceof BoundedReadError && err.kind === "timeout",
    );
    assert.equal(releases, 1);
  });

  test("late connect success releases once and does not run fn", async () => {
    let resolveConnect: ((client: BoundedReadClient) => void) | undefined;
    let releases = 0;
    let fnRuns = 0;
    const pool = {
      connect: () =>
        new Promise<BoundedReadClient>((resolve) => {
          resolveConnect = resolve;
        }),
    };
    const pending = withBoundedReadOnly(pool, 25, async () => {
      fnRuns += 1;
      return 1;
    });
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof BoundedReadError && err.kind === "timeout",
    );
    const late: BoundedReadClient = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (async () => {
        fnRuns += 1;
        return { rows: [] };
      }) as BoundedReadClient["query"],
      release() {
        releases += 1;
      },
    };
    resolveConnect?.(late);
    await delay(40);
    assert.equal(fnRuns, 0);
    assert.equal(releases, 1);
  });

  test("late connect reject is consumed with no unhandledRejection", async () => {
    let rejectConnect: ((err: Error) => void) | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pool = {
        connect: () =>
          new Promise<BoundedReadClient>((_, reject) => {
            rejectConnect = reject;
          }),
      };
      await assert.rejects(
        withBoundedReadOnly(pool, 25, async () => 1),
        (err: unknown) => err instanceof BoundedReadError && err.kind === "timeout",
      );
      rejectConnect?.(new Error("late ECONNREFUSED"));
      await delay(40);
      assert.equal(unhandled.length, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("timeout then a later call recovers", async () => {
    let calls = 0;
    const abort: Array<(err: Error) => void> = [];
    const pool = {
      connect: async () => {
        calls += 1;
        if (calls === 1) {
          return await new Promise<BoundedReadClient>((_, reject) => {
            abort.push(reject);
          });
        }
        return okClient();
      },
    };
    await assert.rejects(withBoundedReadOnly(pool, 25, async () => 1), BoundedReadError);
    for (const reject of abort) reject(new Error("test cleanup"));
    const value = await withBoundedReadOnly(pool, 200, async (client) => {
      await client.query("SELECT 1");
      return 9;
    });
    assert.equal(value, 9);
    assert.equal(calls, 2);
  });
});

describe("snapshot item isolation", () => {
  test("query timeout on one count stays unknown and the snapshot still settles", async () => {
    const pool = {
      async connect() {
        return abortableClient((sql) => {
          if (txnSql(sql)) return { rows: [] };
          if (sql.includes("turn_tape_materialization_jobs")) return { hang: true };
          if (sql.includes("turn_tape_settlement_jobs")) {
            return { rows: [{ count: "2", oldest: "2026-09-01T00:00:00.000Z" }] };
          }
          if (sql.includes("cursor_external_usage_audit")) {
            return { rows: [{ count: "0", oldest: null }] };
          }
          if (sql.includes("SELECT COUNT(*)::bigint AS scanned")) return { rows: [{ scanned: "0" }] };
          if (sql.includes("WITH sampled AS")) return { rows: [] };
          if (sql.includes("information_schema.tables")) {
            return { rows: [{ table_name: "model_pricing_0903_cw_backup" }] };
          }
          throw new Error(`unhandled SQL: ${sql.slice(0, 80)}`);
        });
      },
    } as unknown as Pool;
    const settled = await Promise.race([
      collectBusinessHealthSnapshot(pool, { statementTimeoutMs: 40 }),
      delay(250).then(() => null),
    ]);
    assert.ok(settled, "snapshot must settle when one query hangs");
    assert.equal(settled!.tapeMaterialization.unknown, true);
    assert.equal(settled!.tapeMaterialization.count, null);
    assert.equal(settled!.settlementHeld.unknown, false);
    if (!settled!.settlementHeld.unknown) assert.equal(settled!.settlementHeld.count, 2);
  });

  test("retention alone hanging still reports unknown without blocking other items", async () => {
    const pool = {
      async connect() {
        return abortableClient((sql) => {
          if (txnSql(sql)) return { rows: [] };
          if (sql.includes("information_schema.tables")) return { hang: true };
          if (sql.includes("turn_tape_materialization_jobs")) {
            return { rows: [{ count: "1", oldest: "2026-09-01T00:00:00.000Z" }] };
          }
          if (sql.includes("turn_tape_settlement_jobs")) {
            return { rows: [{ count: "0", oldest: null }] };
          }
          if (sql.includes("cursor_external_usage_audit")) {
            return { rows: [{ count: "0", oldest: null }] };
          }
          if (sql.includes("SELECT COUNT(*)::bigint AS scanned")) return { rows: [{ scanned: "0" }] };
          if (sql.includes("WITH sampled AS")) return { rows: [] };
          throw new Error(`unhandled SQL: ${sql.slice(0, 80)}`);
        });
      },
    } as unknown as Pool;
    const settled = await Promise.race([
      collectBusinessHealthSnapshot(pool, { statementTimeoutMs: 40 }),
      delay(250).then(() => null),
    ]);
    assert.ok(settled, "snapshot must settle when retention hangs");
    assert.equal(settled!.retentionUnknown, true);
    assert.equal(settled!.retentionUnregistered, null);
    assert.equal(settled!.tapeMaterialization.unknown, false);
    if (!settled!.tapeMaterialization.unknown) assert.equal(settled!.tapeMaterialization.count, 1);
    const coverage = await Promise.race([
      auditLiveRetentionCoverage(pool, { statementTimeoutMs: 40 }),
      delay(250).then(() => null),
    ]);
    assert.ok(coverage);
    assert.equal(coverage!.unknown, true);
    assert.equal(coverage!.unregistered, null);
  });
});

