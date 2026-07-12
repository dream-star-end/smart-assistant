/**
 * v5 自愈体系切片②ⓐ — repairDispatcher 单元(注入 fake query/tx/fetch,无 DB/网络)。
 *
 * 验:未配置跳过 / 保险丝(≥2 失败停派+告警)/ 冷却 / singleflight 23505 丢弃 /
 * 202 → dispatched(POST 头/URL/幂等)/ 非 202 → pending_post_failed / postCancel 语义。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { createHash, createHmac } from "node:crypto";
import {
  dispatchRepair,
  postCancel,
  postRelease,
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
  /** Guarded INSERT…SELECT matched 0 rows (incident recovered mid-dispatch). */
  insertNoRow?: boolean;
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
          // insertNoRow: the guarded INSERT…SELECT matched 0 rows (incident
          // resolved / condition recovered between read and insert) — H2 TOCTOU.
          if (opts.insertNoRow) return qr([]);
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

  test("TOCTOU(H2):incident 读到 open 但守卫 INSERT 0 行 → skipped:incident_recovered,不派单", async () => {
    // incident 步1 读为 open,但恢复发生在读与守卫 INSERT…SELECT 之间(WHERE 匹配 0 行)。
    const { fakeQuery, fakeTx } = makeFake({ insertNoRow: true });
    const { fetchFn, calls } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "incident_recovered");
    assert.equal(calls.length, 0, "已恢复系统绝不派单");
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
    // M3 跨仓契约锁定:sig = HMAC(secret, `${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`)。
    {
      const bodySha = createHash("sha256").update(calls[0].init.body).digest("hex");
      const expected = createHmac("sha256", "webhook-hmac-secret")
        .update(`POST./api/webhooks/v5-selfheal.${h["X-Selfheal-Ts"]}.${h["X-Selfheal-Nonce"]}.10.${bodySha}`)
        .digest("hex");
      assert.equal(h["X-Selfheal-Sig"], expected, "路由绑定 HMAC 契约漂移");
    }
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

describe("repairDispatcher.postRelease(收尾批 §B + BLOCKER1 body 裁决)", () => {
  test("200 {ok:true,status:'deployed'} → ok,POST 到 /api/webhooks/v5-selfheal-release,body 只含 id,同 HMAC 契约", async () => {
    const { fetchFn, calls } = makeFetch(200, JSON.stringify({ ok: true, status: "deployed", detail: null }));
    const r = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, true);
    assert.equal(r.remoteStatus, "deployed");
    assert.equal(calls[0].url, "http://127.0.0.1:19999/api/webhooks/v5-selfheal-release");
    assert.deepEqual(JSON.parse(calls[0].init.body), { repairId: "10", incidentId: "7" });
    const h = calls[0].init.headers;
    const bodySha = createHash("sha256").update(calls[0].init.body).digest("hex");
    const expected = createHmac("sha256", "webhook-hmac-secret")
      .update(`POST./api/webhooks/v5-selfheal-release.${h["X-Selfheal-Ts"]}.${h["X-Selfheal-Nonce"]}.10.${bodySha}`)
      .digest("hex");
    assert.equal(h["X-Selfheal-Sig"], expected);
  });

  test("BLOCKER1 负例:200 但 body.status!=='deployed' → ok=false,携带 remoteStatus/reason", async () => {
    const { fetchFn } = makeFetch(
      200,
      JSON.stringify({ ok: true, status: "in_progress", detail: { reason: "deploy already running" } }),
    );
    const r = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, false, "2xx 不是部署成功的权威,body.status 才是");
    assert.equal(r.remoteStatus, "in_progress");
    assert.equal(r.reason, "deploy already running");
  });

  test("BLOCKER1 负例:200 但 body.ok!==true → ok=false", async () => {
    const { fetchFn } = makeFetch(200, JSON.stringify({ ok: false, status: "deployed", detail: null }));
    const r = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, false);
  });

  test("BLOCKER1 负例:200 但 body 非 JSON → ok=false", async () => {
    const { fetchFn } = makeFetch(200, "OK");
    const r = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, false, "无法解析的 body 绝不算部署成功");
    assert.equal(r.remoteStatus, undefined);
  });

  test("非 2xx(409 pending/rejected)→ ok=false,body 的 status/detail.reason 仍被解析供展示", async () => {
    const { fetchFn } = makeFetch(
      409,
      JSON.stringify({ ok: false, status: "rejected", detail: { reason: "denylist hit: deploy-v5.sh" } }),
    );
    const r = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 409);
    assert.equal(r.remoteStatus, "rejected");
    assert.equal(r.reason, "denylist hit: deploy-v5.sh");
  });

  test("3xx(SSRF 重定向逃逸面)按失败;5xx/网络异常 → ok=false", async () => {
    const { fetchFn: f302 } = makeFetch(302, "");
    assert.equal((await postRelease({ repairId: "10", incidentId: "7" }, { fetch: f302, now: () => NOW })).ok, false);
    const { fetchFn: f500 } = makeFetch(500, JSON.stringify({ ok: false, status: "deploy_failed", detail: { reason: "smoke failed" } }));
    const r500 = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: f500, now: () => NOW });
    assert.equal(r500.ok, false);
    assert.equal(r500.remoteStatus, "deploy_failed");
    assert.equal(r500.reason, "smoke failed");
    const fThrow: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const rThrow = await postRelease({ repairId: "10", incidentId: "7" }, { fetch: fThrow, now: () => NOW });
    assert.equal(rThrow.ok, false);
    assert.equal(rThrow.error, "ECONNREFUSED");
  });
});
