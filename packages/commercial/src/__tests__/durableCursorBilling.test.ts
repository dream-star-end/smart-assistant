import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";

import {
  settleDurableCursorBilling,
  type DurableCursorBillingDeps,
} from "../billing/durableCursorBilling.js";
import { runCursorAuditReconcileTick } from "../billing/cursorAuditReconciler.js";
import type { PricingCache } from "../billing/pricing.js";
import type { ModelPricing } from "../billing/pricing.js";

/**
 * Minimal mock-pool coverage for the settle-before-close contract
 * (OCV5-180 D1): the cursor audit row may flip pending→terminal only AFTER
 * the usage settle committed. A settle failure must leave the row pending so
 * the reconciler retries; a close failure must not lose the committed usage.
 */

const REQ = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const UID = 3n;
const UID_S = "3";

function pricingFor(modelId: string): ModelPricing {
  return {
    display_name: modelId,
    input_per_mtok: 200n,
    output_per_mtok: 600n,
    cache_read_per_mtok: 50n,
    cache_write_per_mtok: 0n,
    enabled: true,
    sort_order: 1,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    model_id: modelId,
    multiplier: "1.000",
  } as unknown as ModelPricing;
}

interface QueryRecord {
  sql: string;
  params: unknown[] | undefined;
}

interface FakePoolOptions {
  auditStatus?: string;
  auditUserId?: string;
  pricing?: ModelPricing | null;
  /** Make the audit-close UPDATE throw once (usage already committed). */
  failCloseOnce?: boolean;
  /** Make the usage INSERT throw this object once (unique violation etc). */
  failInsertOnce?: unknown;
  /** Rows returned by the reconciler tick scan (status='pending' result). */
  scanRows?: Array<Record<string, unknown>>;
}

interface FakePoolControl {
  pool: Pool;
  queries: QueryRecord[];
  /** Audit-close UPDATEs that actually succeeded (injected failures excluded). */
  closeUpdateCount(): number;
  usageInsertCount(): number;
}

function makeFakePool(opts: FakePoolOptions = {}): FakePoolControl {
  const queries: QueryRecord[] = [];
  let failedClose = false;
  let failedInsert = false;
  let closeOkCount = 0;

  function record(sql: string, params: unknown[] | undefined): void {
    queries.push({ sql, params });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeClient: any = {
    async query(sqlOrCfg: unknown, params?: unknown[]): Promise<unknown> {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      record(sql, params);
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT") return { rows: [], rowCount: 0 };
      if (trimmed === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (trimmed.startsWith("SELECT m.org_id")) return { rows: [], rowCount: 0 };
      if (/FROM client_sessions cs/.test(trimmed) && /board_project_id/.test(trimmed)) {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("INSERT INTO usage_records")) {
        if (!failedInsert && opts.failInsertOnce !== undefined) {
          failedInsert = true;
          throw opts.failInsertOnce;
        }
        return { rows: [{ id: "100" }], rowCount: 1 };
      }
      if (trimmed.startsWith("SELECT usage_records.id::text AS id")) {
        // loadSettledUsageAttribution after a 23505: the other writer won.
        return {
          rows: [{ id: "100", ledger_id: null, attribution_credits: null }],
          rowCount: 1,
        };
      }
      throw new Error(`fakeClient: unhandled SQL: ${trimmed.slice(0, 90)}`);
    },
    release(): void {
      /* noop */
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePool: any = {
    async connect(): Promise<PoolClient> {
      return fakeClient as PoolClient;
    },
    async query(sqlOrCfg: unknown, params?: unknown[]): Promise<unknown> {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      record(sql, params);
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT model_id, session_id, user_id::text AS user_id")) {
        return {
          rows: [
            {
              model_id: "cursor-grok-4.6-high",
              session_id: "sess_1",
              user_id: opts.auditUserId ?? UID_S,
            },
          ],
          rowCount: 1,
        };
      }
      if (trimmed.startsWith("SELECT dispatch_id::text AS dispatch_id")) {
        return { rows: [{ dispatch_id: "42", attempt_no: 1 }], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE cursor_external_usage_audit")) {
        if (!failedClose && opts.failCloseOnce) {
          failedClose = true;
          throw new Error("injected close failure");
        }
        closeOkCount += 1;
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE claude_accounts")) {
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith("SELECT a.request_id")) {
        // reconciler tick scan; tests configure rows via opts.scanRows.
        return { rows: opts.scanRows ?? [], rowCount: (opts.scanRows ?? []).length };
      }
      throw new Error(`fakePool: unhandled SQL: ${trimmed.slice(0, 90)}`);
    },
  };

  return {
    pool: fakePool as Pool,
    queries,
    closeUpdateCount() {
      return closeOkCount;
    },
    usageInsertCount() {
      return queries.filter((q) => q.sql.trim().startsWith("INSERT INTO usage_records")).length;
    },
  };
}

function frame(usage: Record<string, number>): Parameters<typeof settleDurableCursorBilling>[2] {
  return {
    requestId: REQ,
    engine: "cursor",
    engineSessionId: "sess_1",
    status: "success",
    durationMs: 1000,
    usage: usage as { input_tokens?: number; output_tokens?: number },
  };
}

function deps(ctrl: FakePoolControl, model: ModelPricing | null): DurableCursorBillingDeps {
  const pricing = {
    get: (id: string) => (model !== null && id === "cursor-grok-4.6-high" ? model : null),
  } as unknown as PricingCache;
  return { pgPool: ctrl.pool, pricing };
}

describe("settleDurableCursorBilling settle-before-close (OCV5-180 D1)", () => {
  test("pricing miss throws and never closes the audit row", async () => {
    const ctrl = makeFakePool({ pricing: null });
    await assert.rejects(
      settleDurableCursorBilling(deps(ctrl, null), UID, frame({ input_tokens: 1000, output_tokens: 5 })),
      /pricing missing/,
    );
    assert.equal(ctrl.closeUpdateCount(), 0);
    assert.equal(ctrl.usageInsertCount(), 0);
  });

  test("settle commits before the audit row closes (query order)", async () => {
    const ctrl = makeFakePool({ pricing: pricingFor("cursor-grok-4.6-high") });
    // Zero-output turn settles at zero cost (no wallet SQL needed).
    await settleDurableCursorBilling(
      deps(ctrl, pricingFor("cursor-grok-4.6-high")),
      UID,
      frame({ input_tokens: 1000, output_tokens: 0 }),
    );
    const insertIdx = ctrl.queries.findIndex((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.ok(insertIdx >= 0, "usage insert recorded");
    const closePos = ctrl.queries.findIndex((q) =>
      q.sql.trim().startsWith("UPDATE cursor_external_usage_audit"),
    );
    assert.ok(closePos > insertIdx, "audit close must come after the usage settle");
    assert.equal(ctrl.closeUpdateCount(), 1);
    const closeParams = ctrl.queries[closePos]?.params;
    assert.equal(closeParams?.[1], "success");
  });

  test("close UPDATE failure keeps usage committed; retry is idempotent and closes", async () => {
    const ctrl = makeFakePool({
      pricing: pricingFor("cursor-grok-4.6-high"),
      failCloseOnce: true,
    });
    // 1st call: settle commits, close throws.
    await assert.rejects(
      settleDurableCursorBilling(
        deps(ctrl, pricingFor("cursor-grok-4.6-high")),
        UID,
        frame({ input_tokens: 1000, output_tokens: 0 }),
      ),
      /injected close failure/,
    );
    assert.equal(ctrl.usageInsertCount(), 1);
    assert.equal(ctrl.closeUpdateCount(), 0);
    // 2nd call: the usage INSERT hits the UNIQUE fence (23505) and the
    // idempotent path returns the existing row; the audit then closes.
    const outcome = await settleDurableCursorBilling(
      { ...deps(ctrl, pricingFor("cursor-grok-4.6-high")), pgPool: ctrl.pool },
      UID,
      frame({ input_tokens: 1000, output_tokens: 0 }),
      {},
    );
    assert.equal(outcome, "already_committed");
    assert.equal(ctrl.usageInsertCount(), 2); // second attempt tried and hit 23505
    assert.equal(ctrl.closeUpdateCount(), 1); // closed exactly once, on retry
  });

  test("audit user mismatch refuses to settle against the foreign wallet", async () => {
    const ctrl = makeFakePool({
      auditUserId: "7",
      pricing: pricingFor("cursor-grok-4.6-high"),
    });
    const outcome = await settleDurableCursorBilling(
      deps(ctrl, pricingFor("cursor-grok-4.6-high")),
      UID,
      frame({ input_tokens: 1000, output_tokens: 5 }),
    );
    assert.equal(outcome, "no_audit");
    assert.equal(ctrl.usageInsertCount(), 0);
    assert.equal(ctrl.closeUpdateCount(), 0);
  });

  test("live overrides keep unavailable status, live terminalCode and verified accountId", async () => {
    const ctrl = makeFakePool({ pricing: pricingFor("cursor-grok-4.6-high") });
    const outcome = await settleDurableCursorBilling(
      deps(ctrl, pricingFor("cursor-grok-4.6-high")),
      UID,
      frame({ input_tokens: 1000, output_tokens: 5 }),
      { engineStatus: "unavailable", terminalCode: "AUTH_UNAVAILABLE", accountId: 99n },
    );
    assert.ok(outcome === "already_committed" || outcome === "waived");
    const close = ctrl.queries.find((q) =>
      q.sql.trim().startsWith("UPDATE cursor_external_usage_audit"),
    );
    assert.equal(close?.params?.[1], "unavailable");
    assert.equal(close?.params?.[2], "AUTH_UNAVAILABLE");
    // Verified attribution reaches the usage row and the pool usage counters.
    const insert = ctrl.queries.find((q) => q.sql.trim().startsWith("INSERT INTO usage_records"));
    assert.equal(insert?.params?.[2], "99");
    const bump = ctrl.queries.find((q) => q.sql.trim().startsWith("UPDATE claude_accounts"));
    assert.ok(bump, "cursor account usage counters bumped");
    assert.match(String(bump?.sql), /fail_count = fail_count \+ 1/);
    assert.equal(bump?.params?.[1], "cursor_AUTH_UNAVAILABLE");
  });
});

describe("cursor audit reconciler zero-write on terminal gaps (OCV5-180 D1)", () => {
  test("tick scans only status='pending' and performs no writes when none are pending", async () => {
    const ctrl = makeFakePool({ pricing: pricingFor("cursor-grok-4.6-high") });
    const tick = await runCursorAuditReconcileTick({
      pgPool: ctrl.pool,
      pool: ctrl.pool,
      pricing: {
        get: () => pricingFor("cursor-grok-4.6-high"),
      } as unknown as PricingCache,
      zeroChargeBefore: null,
      minAgeMs: 0,
    });
    assert.equal(tick.scanned, 0);
    const scan = ctrl.queries.find((q) => q.sql.includes("FROM cursor_external_usage_audit a"));
    assert.ok(scan, "tick scan recorded");
    assert.match(scan!.sql, /a\.status = 'pending'/);
    const writes = ctrl.queries.filter(
      (q) => !/^\s*(SELECT|BEGIN|COMMIT|ROLLBACK)/i.test(q.sql.trim()),
    );
    assert.equal(writes.length, 0, `terminal-only state must stay zero-write, got ${writes.length}`);
  });

  test("settle failure keeps the audit pending; the next tick settles and closes exactly once", async () => {
    const scanRows = [
      {
        request_id: REQ,
        user_id: UID_S,
        session_id: "sess_1",
        model_id: "cursor-grok-4.6-high",
        created_at: "2026-09-07T00:00:00.000Z",
        dispatch_id: "42",
        attempt_no: 1,
        dispatch_status: "terminal",
        dispatch_outcome: "completed",
        terminal_at: "2026-09-07T00:00:05.000Z",
        tape_turn_key: null,
        tape_status: "completed",
        tape_usage: { inputTokens: 1000, outputTokens: 0 },
        tape_created_at: "1788327689956",
        tape_finalized_at: "1788327698393",
        tape_engine_billing: null,
      },
    ];
    const ctrl = makeFakePool({
      pricing: pricingFor("cursor-grok-4.6-high"),
      failInsertOnce: new Error("transient PG failure"),
      scanRows,
    });
    const pricing = { get: () => pricingFor("cursor-grok-4.6-high") } as unknown as PricingCache;

    const tick1 = await runCursorAuditReconcileTick({
      pgPool: ctrl.pool,
      pool: ctrl.pool,
      pricing,
      zeroChargeBefore: null,
      minAgeMs: 0,
    });
    assert.equal(tick1.scanned, 1);
    assert.equal(tick1.errors, 1);
    assert.equal(ctrl.closeUpdateCount(), 0, "failed settle must not close the audit row");

    const tick2 = await runCursorAuditReconcileTick({
      pgPool: ctrl.pool,
      pool: ctrl.pool,
      pricing,
      zeroChargeBefore: null,
      minAgeMs: 0,
    });
    assert.equal(tick2.scanned, 1);
    assert.equal(tick2.errors, 0);
    assert.equal(ctrl.usageInsertCount(), 2); // one failed + one committed
    assert.equal(ctrl.closeUpdateCount(), 1); // closed exactly once, on success
  });
});
