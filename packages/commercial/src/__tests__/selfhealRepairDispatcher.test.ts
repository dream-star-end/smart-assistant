/**
 * v5 自愈体系切片②ⓐ — repairDispatcher 单元(注入 fake query/tx/fetch,无 DB/网络)。
 *
 * 验:未配置跳过 / 保险丝(≥2 失败停派+告警)/ 冷却 / singleflight 23505 丢弃 /
 * 202 → dispatched(POST 头/URL/幂等)/ 非 202 → pending_post_failed / postCancel 语义。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  dispatchRepair,
  postCancel,
  type FetchLike,
  type DispatcherDeps,
} from "../selfheal/repairDispatcher.js";
import type { AlertEventInput } from "../admin/alertOutbox.js";

function qr<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as unknown as QueryResult<T>;
}

interface FakeOpts {
  incidentStatus?: string;
  failedCount?: number;
  cooldownHit?: boolean;
  insertError?: { code?: string };
}

/** 构造一套 fake query/tx,按 SQL 关键片段返回 canned 行。 */
function makeFake(opts: FakeOpts = {}) {
  const state = {
    queries: [] as string[],
    casCalls: [] as string[],
    insertedId: "10",
    insertedAttempt: 1,
  };
  const fakeQuery = (async (sql: string, params?: unknown[]) => {
    state.queries.push(sql);
    if (/FROM incidents i\b/.test(sql) && /event_type/.test(sql)) {
      return qr([
        {
          id: String((params as unknown[])?.[0] ?? "1"),
          condition_key: "ops.monitor:svc_v5",
          status: opts.incidentStatus ?? "open",
          event_type: "ops.monitor:svc_v5",
        },
      ]);
    }
    if (/COUNT\(\*\)::text AS n FROM codex_repairs/.test(sql)) {
      return qr([{ n: String(opts.failedCount ?? 0) }]);
    }
    if (/SELECT 1 AS one FROM codex_repairs r/.test(sql)) {
      return qr(opts.cooldownHit ? [{ one: 1 }] : []);
    }
    return qr([]);
  }) as unknown as DispatcherDeps["query"];

  const fakeTx = (async <T>(fn: (c: PoolClient) => Promise<T>) => {
    const client = {
      query: async (sql: string) => {
        if (/INSERT INTO codex_repairs/.test(sql) && /RETURNING id::text/.test(sql)) {
          if (opts.insertError) throw opts.insertError;
          return qr([{ id: state.insertedId, attempt: state.insertedAttempt }]);
        }
        if (/UPDATE codex_repairs/.test(sql)) {
          state.casCalls.push(sql);
          return qr([]);
        }
        return qr([]);
      },
    } as unknown as PoolClient;
    return fn(client);
  }) as unknown as DispatcherDeps["tx"];

  return { state, fakeQuery, fakeTx };
}

function makeFetch(status: number, body = "") {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => body };
  };
  return { calls, fetchFn };
}

const NOW = 1_700_000_000_000;

beforeEach(() => {
  process.env.OC_SELFHEAL_DISPATCH_URL = "http://127.0.0.1:19999";
  process.env.OC_SELFHEAL_WEBHOOK_HMAC = "webhook-hmac-secret";
  process.env.OC_SELFHEAL_MASTER_SECRET = "master-secret";
});

describe("repairDispatcher.dispatchRepair", () => {
  test("未配置 DISPATCH_URL → skipped:not_configured", async () => {
    delete process.env.OC_SELFHEAL_DISPATCH_URL;
    const { fakeQuery, fakeTx } = makeFake();
    const { fetchFn } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "not_configured");
  });

  test("保险丝:同 incident ≥2 失败 → 停派 + ops.repair_failed 告警", async () => {
    const { fakeQuery, fakeTx } = makeFake({ failedCount: 2 });
    const { fetchFn, calls } = makeFetch(202);
    const alerts: AlertEventInput[] = [];
    const r = await dispatchRepair("1", {
      query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW,
      enqueueAlert: (e) => alerts.push(e),
    });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "fuse_failed");
    assert.equal(calls.length, 0, "熔断不 POST");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].event_type, "ops.repair_failed");
    assert.equal(alerts[0].severity, "critical");
  });

  test("冷却:同 event_type 30min 内已派单 → skipped:cooldown", async () => {
    const { fakeQuery, fakeTx } = makeFake({ cooldownHit: true });
    const { fetchFn, calls } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "cooldown");
    assert.equal(calls.length, 0);
  });

  test("singleflight:INSERT 23505 冲突 → skipped:singleflight_conflict", async () => {
    const { fakeQuery, fakeTx } = makeFake({ insertError: { code: "23505" } });
    const { fetchFn, calls } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "singleflight_conflict");
    assert.equal(calls.length, 0);
  });

  test("happy path:INSERT ok + POST 202 → dispatched,POST 头/URL 正确", async () => {
    const { fakeQuery, fakeTx, state } = makeFake();
    const { fetchFn, calls } = makeFetch(202);
    const r = await dispatchRepair("7", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "dispatched");
    assert.equal((r as { repairId: string }).repairId, "10");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:19999/api/webhooks/v5-selfheal");
    const h = calls[0].init.headers;
    assert.equal(h["X-Selfheal-Ts"], String(NOW));
    assert.ok(/^[0-9a-f]{32}$/.test(h["X-Selfheal-Nonce"]));
    assert.ok(/^[0-9a-f]{64}$/.test(h["X-Selfheal-Sig"]));
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { repairId: "10", incidentId: "7", attempt: 1 });
    // markDispatched 的 CAS 被执行(pending→dispatched)。
    assert.ok(state.casCalls.some((s) => /status = 'dispatched'/.test(s)));
  });

  test("POST 非 202 → pending_post_failed(留 pending 待 redispatch)", async () => {
    const { fakeQuery, fakeTx, state } = makeFake();
    const { fetchFn } = makeFetch(500, "boom");
    const r = await dispatchRepair("7", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "pending_post_failed");
    assert.equal((r as { repairId: string }).repairId, "10");
    assert.ok(!state.casCalls.some((s) => /status = 'dispatched'/.test(s)), "未 CAS dispatched");
  });

  test("incident 已 resolved → skipped:incident_resolved", async () => {
    const { fakeQuery, fakeTx } = makeFake({ incidentStatus: "resolved" });
    const { fetchFn } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "incident_resolved");
  });
});

describe("repairDispatcher.postCancel", () => {
  test("200 {terminated:true} → ok+terminated", async () => {
    const { fetchFn, calls } = makeFetch(200, JSON.stringify({ terminated: true }));
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "timeout" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, true);
    assert.equal(r.terminated, true);
    assert.equal(calls[0].url, "http://127.0.0.1:19999/api/webhooks/v5-selfheal-cancel");
  });

  test("200 {accepted:true,terminated:false} → ok+accepted 未终止", async () => {
    const { fetchFn } = makeFetch(200, JSON.stringify({ accepted: true, terminated: false }));
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "timeout" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, true);
    assert.equal(r.terminated, false);
    assert.equal(r.accepted, true);
  });

  test("网络异常 → ok=false(fail-closed 不释放槽)", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "timeout" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, false);
    assert.equal(r.terminated, false);
  });
});
