import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import {
  armOwnedDrill,
  bindOwnedRepair,
  cleanupForSignal,
  cleanupOwnedDrill,
  fetchVersionShort,
  parseApproveRepairId,
  parseDrillOwner,
  postReleaseApproval,
  preflightReleaseApproval,
  validateAdminBase,
  withHardDeadline,
  type DrillOwner,
  type PendingReleaseEvent,
} from "../v5-selfheal-drill.js";

function qr<T extends QueryResultRow>(rows: T[] = [], rowCount = rows.length): QueryResult<T> {
  return { rows, rowCount, command: "", oid: 0, fields: [] } as QueryResult<T>;
}

type FakeDb = {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
};

const OWNER: DrillOwner = {
  schema: 1,
  runId: "123e4567-e89b-42d3-a456-426614174000",
  repairId: "42",
  conditionRev: "7",
};

const PENDING: PendingReleaseEvent = {
  eventId: "99",
  approvedSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  deployPlanHash: "c".repeat(64),
  manifestHash: "d".repeat(64),
};

const EXACT_ROW = {
  release_request_id: "rr-exact",
  source_event_id: PENDING.eventId,
  status: "queued",
  approved_sha: PENDING.approvedSha,
  base_sha: PENDING.baseSha,
  deploy_plan_hash: PENDING.deployPlanHash,
  manifest_hash: PENDING.manifestHash,
};

function pendingEventRow(p = PENDING) {
  return {
    event_id: p.eventId,
    sha: p.approvedSha,
    base_sha: p.baseSha,
    deploy_plan_hash: p.deployPlanHash,
    manifest_hash: p.manifestHash,
  };
}

function approvalDb(rows: Array<typeof EXACT_ROW>, pending = PENDING): FakeDb {
  return {
    async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
      if (sql.includes("FROM codex_repair_events")) {
        return qr([pendingEventRow(pending)] as unknown as T[]);
      }
      if (sql.includes("FROM selfheal_release_requests WHERE repair_id")) {
        return qr(rows as unknown as T[]);
      }
      throw new Error(`unexpected SQL:${sql}`);
    },
  };
}

describe("v5 selfheal drill admin transport safety", () => {
  test("--approve=<id> and split form share one parser", () => {
    assert.equal(parseApproveRepairId(["--approve=42"]), "42");
    assert.equal(parseApproveRepairId(["--approve", "43"]), "43");
    assert.equal(parseApproveRepairId(["--approve="]), null);
  });

  test("ADMIN_BASE only accepts the two exact numeric-loopback slot origins", () => {
    assert.equal(validateAdminBase("http://127.0.0.1:18790"), "http://127.0.0.1:18790");
    assert.equal(validateAdminBase("http://127.0.0.1:18795"), "http://127.0.0.1:18795");
    for (const bad of [
      "http://localhost:18790",
      "http://127.0.0.1:18790/",
      "http://127.0.0.1:18790/version",
      "http://127.0.0.1:18790?x=1",
      "http://127.0.0.1:18790@evil.example",
      "https://127.0.0.1:18790",
      "http://127.0.0.1:18791",
      "http://2130706433:18790",
      "http://[::1]:18790",
    ]) {
      assert.throws(() => validateAdminBase(bad), /V5_ADMIN_BASE_URL/);
    }
  });

  test("invalid ADMIN_BASE fails before any DB/token-side work", async () => {
    let queries = 0;
    const db: FakeDb = {
      async query<T extends QueryResultRow>(): Promise<QueryResult<T>> {
        queries++;
        return qr([]);
      },
    };
    await assert.rejects(
      preflightReleaseApproval(db, "42", "http://evil.example:18790"),
      /V5_ADMIN_BASE_URL/,
    );
    assert.equal(queries, 0);
  });

  test("preflight permits only exact deployed+verifying crash recovery", async () => {
    const makeDb = (requestStatus: string): FakeDb => ({
      async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
        if (sql.includes("FROM codex_repairs r JOIN incidents")) {
          return qr([{ status: "verifying", incident_id: "7", condition_key: "selfheal.drill:release_v1" }] as unknown as T[]);
        }
        if (sql.includes("FROM admin_alert_rule_state")) {
          return qr([{ condition_rev: OWNER.conditionRev, snapshot: { drillOwner: OWNER } }] as unknown as T[]);
        }
        if (sql.includes("FROM codex_repair_events")) {
          return qr([pendingEventRow()] as unknown as T[]);
        }
        if (sql.includes("FROM selfheal_release_requests WHERE repair_id")) {
          return qr([{ ...EXACT_ROW, status: requestStatus }] as unknown as T[]);
        }
        throw new Error(`unexpected SQL:${sql}`);
      },
    });
    const recovered = await preflightReleaseApproval(
      makeDb("deployed"),
      "42",
      "http://127.0.0.1:18790",
    );
    assert.deepEqual([...recovered.baselineRequestIds], ["rr-exact"]);
    await assert.rejects(
      preflightReleaseApproval(makeDb("deploy_failed"), "42", "http://127.0.0.1:18790"),
      /恢复只允许唯一 exact deployed \+ verifying/,
    );
  });

  test("hard deadline aborts and rejects even when the operation never settles", async () => {
    let observedAbort = false;
    const started = Date.now();
    await assert.rejects(
      withHardDeadline("hung", 30, async (s) => {
        s.addEventListener("abort", () => {
          observedAbort = true;
        });
        return await new Promise<never>(() => {});
      }),
      /hard deadline/,
    );
    assert.equal(observedAbort, true);
    assert.ok(Date.now() - started < 500, "deadline must not inherit an unbounded fetch/body wait");
  });

  test("hard deadline consumes the operation rejection that arrives after abort", async () => {
    await assert.rejects(
      withHardDeadline("late reject", 20, async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("fetch aborted after timeout");
      }),
      /hard deadline/,
    );
    // Let the losing operation settle; node:test would report an asynchronous
    // unhandledRejection if withHardDeadline had not attached its own handler.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("GET /version also rejects redirects and bounds a stalled response body", async () => {
    let init: RequestInit | undefined;
    const started = Date.now();
    const result = await fetchVersionShort(
      "http://127.0.0.1:18795",
      async (_url, requestInit) => {
        init = requestInit;
        return {
          status: 200,
          json: async () => await new Promise<never>(() => {}),
        } as unknown as Response;
      },
      30,
    );
    assert.equal(result, null);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.signal?.aborted, true);
    assert.ok(Date.now() - started < 500);
  });

  test("202 POST binds exact pending event+tuple, disables redirects, and verifies rrid in DB", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const rrid = await postReleaseApproval(
      approvalDb([EXACT_ROW]),
      "42",
      "secret-token",
      PENDING,
      "http://127.0.0.1:18790",
      new Set(),
      async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ releaseRequestId: "rr-exact" }), { status: 202 });
      },
      100,
    );
    assert.equal(rrid, "rr-exact");
    assert.equal(capturedUrl, "http://127.0.0.1:18790/api/admin/selfheal/repairs/42/release");
    assert.equal(capturedInit?.redirect, "manual");
    assert.ok(capturedInit?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      expectedPendingReleaseEventId: "99",
      approvedSha: PENDING.approvedSha,
      baseSha: PENDING.baseSha,
      deployPlanHash: PENDING.deployPlanHash,
      manifestHash: PENDING.manifestHash,
    });
  });

  test("409 recovers only the one active request with the exact frozen tuple", async () => {
    const rrid = await postReleaseApproval(
      approvalDb([EXACT_ROW]),
      "42",
      "secret-token",
      PENDING,
      "http://127.0.0.1:18795",
      new Set(["rr-exact"]),
      async () => new Response("conflict", { status: 409 }),
      100,
    );
    assert.equal(rrid, "rr-exact");

    await assert.rejects(
      postReleaseApproval(
        approvalDb([{ ...EXACT_ROW, approved_sha: "e".repeat(40) }]),
        "42",
        "secret-token",
        PENDING,
        "http://127.0.0.1:18795",
        new Set(),
        async () => new Response("conflict", { status: 409 }),
        100,
      ),
      /不同 pending event id\/frozen tuple/,
    );

    await assert.rejects(
      postReleaseApproval(
        approvalDb([{ ...EXACT_ROW, source_event_id: "98" }]),
        "42",
        "secret-token",
        PENDING,
        "http://127.0.0.1:18795",
        new Set(),
        async () => new Response("conflict", { status: 409 }),
        100,
      ),
      /不同 pending event id\/frozen tuple/,
    );
  });

  test("200 idempotent retry still verifies exact event id and frozen tuple in DB", async () => {
    const rrid = await postReleaseApproval(
      approvalDb([{ ...EXACT_ROW, status: "deployed" }]),
      "42",
      "secret-token",
      PENDING,
      "http://127.0.0.1:18790",
      new Set(["rr-exact"]),
      async () =>
        new Response(JSON.stringify({ releaseRequestId: "rr-exact", status: "deployed" }), {
          status: 200,
        }),
      100,
    );
    assert.equal(rrid, "rr-exact");
  });

  test("response loss and timeout recover a newly committed exact DB request", async () => {
    const lost = await postReleaseApproval(
      approvalDb([EXACT_ROW]),
      "42",
      "secret-token",
      PENDING,
      "http://127.0.0.1:18790",
      new Set(),
      async () => {
        throw new Error("ECONNRESET after commit");
      },
      100,
    );
    assert.equal(lost, "rr-exact");

    const started = Date.now();
    const timedOut = await postReleaseApproval(
      approvalDb([EXACT_ROW]),
      "42",
      "secret-token",
      PENDING,
      "http://127.0.0.1:18790",
      new Set(),
      async () => await new Promise<Response>(() => {}),
      30,
    );
    assert.equal(timedOut, "rr-exact");
    assert.ok(Date.now() - started < 500);
  });
});

describe("v5 selfheal drill exact owner cleanup", () => {
  test("owner parser rejects partial/unversioned snapshots", () => {
    assert.deepEqual(parseDrillOwner({ drillOwner: OWNER }), OWNER);
    assert.equal(parseDrillOwner({ drillOwner: { ...OWNER, runId: "not-uuid" } }), null);
    assert.equal(parseDrillOwner({ drillOwner: { ...OWNER, repairId: "0" } }), null);
    assert.equal(parseDrillOwner({ drillOwner: { ...OWNER, conditionRev: 7 } }), null);
  });

  test("precheck failure/unarmed cleanup performs zero DB writes or reads", async () => {
    let calls = 0;
    const db: FakeDb = {
      async query<T extends QueryResultRow>(): Promise<QueryResult<T>> {
        calls++;
        throw new Error("must not query");
      },
    };
    assert.equal(await cleanupOwnedDrill(db, "selfheal.drill:release_v1", null, "x"), "not_armed");
    assert.equal(calls, 0);
  });

  test("arm transaction persists runId and stable condition_rev before commit", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let conditionWrites = 0;
    const runId = "123e4567-e89b-42d3-a456-426614174099";
    const db: FakeDb = {
      async query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        calls.push({ sql, params });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return qr([]);
        if (sql.includes("SELECT auto_repair FROM incident_policies")) {
          return qr([{ auto_repair: false }] as unknown as T[]);
        }
        if (sql.includes("SELECT firing FROM admin_alert_rule_state")) {
          return qr([{ firing: false }] as unknown as T[]);
        }
        if (sql.includes("UPDATE incident_policies")) return qr([], 1);
        if (sql.includes("write_alert_condition")) {
          conditionWrites++;
          return qr([{ out_condition_rev: "8" }] as unknown as T[]);
        }
        throw new Error(`unexpected SQL:${sql}`);
      },
    };
    const owner = await armOwnedDrill(db, "selfheal.drill:release_v1", runId);
    assert.deepEqual(owner, { schema: 1, runId, repairId: null, conditionRev: "8" });
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1)?.sql, "COMMIT");
    assert.equal(conditionWrites, 2);
    const writes = calls.filter((call) => call.sql.includes("write_alert_condition"));
    assert.equal(JSON.parse(String(writes[0].params?.[2])).drillOwner.conditionRev, "0");
    assert.deepEqual(JSON.parse(String(writes[1].params?.[2])).drillOwner, owner);
  });

  test("repair bind transaction CASes the prior owner and persists exact repairId", async () => {
    const unbound = { ...OWNER, repairId: null };
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db: FakeDb = {
      async query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        calls.push({ sql, params });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return qr([]);
        if (sql.includes("FROM admin_alert_rule_state") && sql.includes("FOR UPDATE")) {
          return qr(
            [{ firing: true, condition_rev: "7", snapshot: { drillOwner: unbound } }] as unknown as T[],
          );
        }
        if (sql.includes("FROM codex_repairs") && sql.includes("FOR UPDATE OF r")) {
          return qr([{ condition_key: "selfheal.drill:release_v1" }] as unknown as T[]);
        }
        if (sql.includes("write_alert_condition")) {
          return qr([{ out_condition_rev: "7" }] as unknown as T[]);
        }
        throw new Error(`unexpected SQL:${sql}`);
      },
    };
    const bound = await bindOwnedRepair(db, "selfheal.drill:release_v1", unbound, "42");
    assert.deepEqual(bound, OWNER);
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1)?.sql, "COMMIT");
    const write = calls.find((call) => call.sql.includes("write_alert_condition"));
    assert.deepEqual(JSON.parse(String(write?.params?.[2])).drillOwner, OWNER);
  });

  test("cleanup is one transaction and CASes runId+repairId+condition_rev before mutation", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let writeCount = 0;
    const db: FakeDb = {
      async query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
        calls.push({ sql, params });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return qr([]);
        if (sql.includes("FROM admin_alert_rule_state") && sql.includes("FOR UPDATE")) {
          return qr(
            [{ firing: true, condition_rev: "7", snapshot: { drillOwner: OWNER } }] as unknown as T[],
          );
        }
        if (sql.includes("FROM selfheal_release_requests")) return qr([]);
        if (sql.includes("UPDATE incident_policies")) return qr([], 1);
        if (sql.includes("write_alert_condition")) {
          writeCount++;
          return qr([{ out_condition_rev: "8" }] as unknown as T[]);
        }
        throw new Error(`unexpected SQL:${sql}`);
      },
    };
    assert.equal(
      await cleanupOwnedDrill(db, "selfheal.drill:release_v1", OWNER, "test cleanup"),
      "cleaned",
    );
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls.at(-1)?.sql, "COMMIT");
    assert.equal(writeCount, 2);
    const cas = calls.find((c) => c.sql.includes("UPDATE incident_policies"));
    assert.match(cas?.sql ?? "", /drillOwner,runId/);
    assert.match(cas?.sql ?? "", /drillOwner,repairId/);
    assert.match(cas?.sql ?? "", /drillOwner,conditionRev/);
    assert.deepEqual(cas?.params, ["selfheal.drill:release_v1", "7", OWNER.runId, "42"]);
  });

  test("active release request refuses cleanup before policy/condition mutation", async () => {
    const calls: string[] = [];
    const db: FakeDb = {
      async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
        calls.push(sql);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return qr([]);
        if (sql.includes("FROM admin_alert_rule_state")) {
          return qr(
            [{ firing: true, condition_rev: "7", snapshot: { drillOwner: OWNER } }] as unknown as T[],
          );
        }
        if (sql.includes("FROM selfheal_release_requests")) {
          return qr(
            [{ release_request_id: "rr-live", status: "deploying" }] as unknown as T[],
          );
        }
        throw new Error(`unexpected mutation:${sql}`);
      },
    };
    assert.equal(
      await cleanupOwnedDrill(db, "selfheal.drill:release_v1", OWNER, "must refuse"),
      "active_release",
    );
    assert.equal(calls.some((sql) => sql.includes("UPDATE incident_policies")), false);
    assert.equal(calls.some((sql) => sql.includes("write_alert_condition")), false);
  });

  test("owner mismatch rolls back with zero mutations", async () => {
    const other = { ...OWNER, runId: "123e4567-e89b-42d3-b456-426614174001" };
    const calls: string[] = [];
    const db: FakeDb = {
      async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
        calls.push(sql);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return qr([]);
        if (sql.includes("FROM admin_alert_rule_state")) {
          return qr(
            [{ firing: true, condition_rev: "7", snapshot: { drillOwner: other } }] as unknown as T[],
          );
        }
        throw new Error(`unexpected SQL:${sql}`);
      },
    };
    assert.equal(
      await cleanupOwnedDrill(db, "selfheal.drill:release_v1", OWNER, "must not clear"),
      "not_owner",
    );
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(calls.some((sql) => sql.includes("UPDATE incident_policies")), false);
  });

  test("signals never auto-clean approve and do nothing before arm", async () => {
    let calls = 0;
    const db: FakeDb = {
      async query<T extends QueryResultRow>(): Promise<QueryResult<T>> {
        calls++;
        throw new Error("signal path must not query");
      },
    };
    assert.equal(
      await cleanupForSignal(db, "approve", { key: "selfheal.drill:release_v1", owner: OWNER }),
      "approve_preserved",
    );
    assert.equal(await cleanupForSignal(db, "release", null), "not_armed");
    assert.equal(calls, 0);
  });
});
