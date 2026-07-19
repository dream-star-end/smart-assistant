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
  postReleaseDelivery,
  postFuseClear,
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
  fuseAlertExists?: boolean;
  cooldownHit?: boolean;
  /** incident 的 event_type/condition_key(默认 ops.monitor:svc_v5)。 */
  eventType?: string;
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
    insertSql: "",
  };
  const fakeQuery = (async (sql: string, params?: unknown[]) => {
    state.queries.push(sql);
    if (/FROM incidents i\b/.test(sql) && /event_type/.test(sql)) {
      return qr([
        {
          id: String((params as unknown[])?.[0] ?? "1"),
          condition_key: opts.eventType ?? "ops.monitor:svc_v5",
          status: opts.incidentStatus ?? "open",
          event_type: opts.eventType ?? "ops.monitor:svc_v5",
        },
      ]);
    }
    if (/COUNT\(\*\)::text AS n FROM codex_repairs/.test(sql)) {
      return qr([{ n: String(opts.failedCount ?? 0) }]);
    }
    if (/FROM admin_alert_outbox/.test(sql)) {
      return qr(opts.fuseAlertExists ? [{ one: 1 }] : []);
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
          state.insertSql = sql; // BLOCKER1: assert tier+opcode frozen in this INSERT
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

  test("保险丝:历史 sent 告警已存在 → 永久去重,不重复推送", async () => {
    const { fakeQuery, fakeTx } = makeFake({ failedCount: 2, fuseAlertExists: true });
    const { fetchFn, calls } = makeFetch(202);
    const alerts: AlertEventInput[] = [];
    const r = await dispatchRepair("1", {
      query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW,
      enqueueAlert: (e) => alerts.push(e),
    });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "fuse_failed");
    assert.equal(calls.length, 0, "熔断不 POST 修复");
    assert.equal(alerts.length, 0, "已发送过的 incident 保险丝告警不再重复入队");
  });

  test("冷却:同 event_type 30min 内已派单 → skipped:cooldown", async () => {
    const { fakeQuery, fakeTx } = makeFake({ cooldownHit: true });
    const { fetchFn, calls } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "skipped");
    assert.equal((r as { reason: string }).reason, "cooldown");
    assert.equal(calls.length, 0);
  });

  test("冷却豁免:transport drill(精确常量)不受 cooldown 拦截,可连续重跑", async () => {
    const { fakeQuery, fakeTx } = makeFake({
      cooldownHit: true, // 即便冷却窗口内有既往派单记录……
      eventType: "selfheal.drill:transport_v1",
    });
    const { fetchFn, calls } = makeFetch(202);
    const r = await dispatchRepair("1", { query: fakeQuery, tx: fakeTx, fetch: fetchFn, now: () => NOW });
    assert.equal(r.status, "dispatched", "drill 派单不因 cooldown 跳过");
    assert.equal(calls.length, 1, "隧道 POST 照常发出");
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
    // BLOCKER1:INSERT 同事务从 policy 快照 tier + action_opcode 到 repair 行。
    assert.match(state.insertSql, /action_opcode/);
    assert.match(state.insertSql, /p\.execution_class = 'tier1'/);
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

  test("批1b:带 releaseRequestId → body 含 rrid(兼取消 release job);不带 → 不含", async () => {
    const withR = makeFetch(200, JSON.stringify({ terminated: true }));
    await postCancel(
      { repairId: "10", incidentId: "7", reason: "resolve", releaseRequestId: "rr-abc" },
      { fetch: withR.fetchFn, now: () => NOW },
    );
    assert.equal(JSON.parse(withR.calls[0].init.body).releaseRequestId, "rr-abc");
    const withoutR = makeFetch(200, JSON.stringify({ terminated: true }));
    await postCancel({ repairId: "10", incidentId: "7", reason: "timeout" }, { fetch: withoutR.fetchFn, now: () => NOW });
    assert.equal("releaseRequestId" in JSON.parse(withoutR.calls[0].init.body), false, "无 rrid 时 body 不含该键");
  });

  // ── 批1b F2:release cancel 裁决 releaseCancel(200 与 409 都解析)──
  test("F2:200 {releaseCancel:'cancelled'} → ok+releaseCancel='cancelled'", async () => {
    const { fetchFn } = makeFetch(200, JSON.stringify({ terminated: false, releaseCancel: "cancelled" }));
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "resolve", releaseRequestId: "rr1" },
      { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, true);
    assert.equal(r.releaseCancel, "cancelled");
  });

  test("F2:200 {releaseCancel:'not_found'} → 'not_found'", async () => {
    const { fetchFn } = makeFetch(200, JSON.stringify({ releaseCancel: "not_found" }));
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "resolve", releaseRequestId: "rr1" },
      { fetch: fetchFn, now: () => NOW });
    assert.equal(r.releaseCancel, "not_found");
  });

  test("F2/R2-1:200 {releaseCancel:'too_late'} → ok=true(too_late 不再是 409),releaseCancel 透传", async () => {
    const { fetchFn } = makeFetch(200, JSON.stringify({ terminated: false, accepted: true, releaseCancel: "too_late" }));
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "resolve", releaseRequestId: "rr1" },
      { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, true, "too_late 走 200,repair 级不再 fail-closed");
    assert.equal(r.terminated, false);
    assert.equal(r.accepted, true, "个人版受理但未终止(部署在途,repair 待 receipt 收口)");
    assert.equal(r.releaseCancel, "too_late", "release 级裁决透传(sweeper 不动 release 行,交 receipt)");
  });

  test("F2/R2-1:409 {ok:false,releaseCancel:'repair_mismatch'} → ok=false 但仍解析 releaseCancel", async () => {
    const { fetchFn } = makeFetch(409, JSON.stringify({ ok: false, releaseCancel: "repair_mismatch" }));
    const r = await postCancel({ repairId: "10", incidentId: "7", reason: "resolve", releaseRequestId: "rr1" },
      { fetch: fetchFn, now: () => NOW });
    assert.equal(r.ok, false, "唯一 409(契约校验失败)→ repair 级 fail-closed");
    assert.equal(r.releaseCancel, "repair_mismatch", "409 body 的 releaseCancel 仍透传(sweeper 仅告警不收口)");
  });

  test("F2:无 releaseCancel 字段 / 非法值 → null", async () => {
    const { fetchFn: f1 } = makeFetch(200, JSON.stringify({ terminated: true }));
    assert.equal((await postCancel({ repairId: "10", incidentId: "7", reason: "x" }, { fetch: f1, now: () => NOW })).releaseCancel, null);
    const { fetchFn: f2 } = makeFetch(200, JSON.stringify({ releaseCancel: "bogus" }));
    assert.equal((await postCancel({ repairId: "10", incidentId: "7", reason: "x", releaseRequestId: "rr1" }, { fetch: f2, now: () => NOW })).releaseCancel, null);
  });
});

const RELEASE_BODY = {
  repairId: "10",
  incidentId: "7",
  releaseRequestId: "rr-uuid-123",
  approvedSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  deployPlanHash: "c".repeat(64),
  manifestHash: "d".repeat(64),
};

describe("repairDispatcher.postReleaseDelivery(批1b:durable async intake,只认状态码)", () => {
  test("202 → accepted;POST 到 /api/webhooks/v5-selfheal-release,body 为 §3.1 全字段,同 HMAC 契约", async () => {
    const { fetchFn, calls } = makeFetch(202, JSON.stringify({ ok: true, status: "accepted", releaseRequestId: "rr-uuid-123" }));
    const r = await postReleaseDelivery(RELEASE_BODY, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.outcome, "accepted");
    assert.equal(calls[0].url, "http://127.0.0.1:19999/api/webhooks/v5-selfheal-release");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      repairId: "10", incidentId: "7", releaseRequestId: "rr-uuid-123",
      approvedSha: "a".repeat(40), baseSha: "b".repeat(40),
      deployPlanHash: "c".repeat(64), manifestHash: "d".repeat(64),
    });
    const h = calls[0].init.headers;
    const bodySha = createHash("sha256").update(calls[0].init.body).digest("hex");
    const expected = createHmac("sha256", "webhook-hmac-secret")
      .update(`POST./api/webhooks/v5-selfheal-release.${h["X-Selfheal-Ts"]}.${h["X-Selfheal-Nonce"]}.10.${bodySha}`)
      .digest("hex");
    assert.equal(h["X-Selfheal-Sig"], expected, "release 交付走与 dispatch 相同的路由绑定 HMAC");
  });

  test("409 → authority_mismatch,body.error 作 reason 透传(→ manual_required)", async () => {
    const { fetchFn } = makeFetch(409, JSON.stringify({ ok: false, error: "authority_mismatch" }));
    const r = await postReleaseDelivery(RELEASE_BODY, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.outcome, "authority_mismatch");
    assert.equal(r.httpStatus, 409);
    assert.equal(r.reason, "authority_mismatch");
  });

  test("400/422 确定性契约拒绝 → authority_mismatch,不无限 retry", async () => {
    for (const status of [400, 422]) {
      const { fetchFn } = makeFetch(status, JSON.stringify({ ok: false, error: "invalid_frozen_hash" }));
      const r = await postReleaseDelivery(RELEASE_BODY, { fetch: fetchFn, now: () => NOW });
      assert.equal(r.outcome, "authority_mismatch");
      assert.equal(r.reason, "invalid_frozen_hash");
    }
  });

  test("硬 deadline 覆盖 headers 与 body，injected fetch 忽略 signal 也有界", async () => {
    const neverHeaders: FetchLike = async () => await new Promise(() => {});
    const a = await postReleaseDelivery(RELEASE_BODY, {
      fetch: neverHeaders, requestTimeoutMs: 20, now: () => NOW,
    });
    assert.equal(a.outcome, "retry");
    assert.match(a.error ?? "", /request_timeout/);

    const neverBody: FetchLike = async () => ({
      status: 202,
      text: async () => await new Promise(() => {}),
    });
    const b = await postReleaseDelivery(RELEASE_BODY, {
      fetch: neverBody, requestTimeoutMs: 20, now: () => NOW,
    });
    assert.equal(b.outcome, "retry");
    assert.match(b.error ?? "", /request_timeout/);
  });

  test("423 → fuse_engaged(退避重投,不转终态)", async () => {
    const { fetchFn } = makeFetch(423, JSON.stringify({ ok: false, error: "release_fuse_engaged" }));
    const r = await postReleaseDelivery(RELEASE_BODY, { fetch: fetchFn, now: () => NOW });
    assert.equal(r.outcome, "fuse_engaged");
    assert.equal(r.reason, "release_fuse_engaged");
  });

  test("5xx / 3xx / 网络异常 → retry(attempts++ 退避)", async () => {
    const { fetchFn: f500 } = makeFetch(500, "boom");
    assert.equal((await postReleaseDelivery(RELEASE_BODY, { fetch: f500, now: () => NOW })).outcome, "retry");
    const { fetchFn: f302 } = makeFetch(302, "");
    assert.equal((await postReleaseDelivery(RELEASE_BODY, { fetch: f302, now: () => NOW })).outcome, "retry");
    const fThrow: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    const rThrow = await postReleaseDelivery(RELEASE_BODY, { fetch: fThrow, now: () => NOW });
    assert.equal(rThrow.outcome, "retry");
    assert.equal(rThrow.error, "ECONNREFUSED");
  });

  test("200(非 202)→ retry(intake 必须精确 202 才算受理)", async () => {
    const { fetchFn } = makeFetch(200, JSON.stringify({ ok: true, status: "accepted" }));
    assert.equal((await postReleaseDelivery(RELEASE_BODY, { fetch: fetchFn, now: () => NOW })).outcome, "retry");
  });

  test("baseSha=null 序列化进 body(首部署无 base)", async () => {
    const { fetchFn, calls } = makeFetch(202, "");
    await postReleaseDelivery({ ...RELEASE_BODY, baseSha: null }, { fetch: fetchFn, now: () => NOW });
    assert.equal(JSON.parse(calls[0].init.body).baseSha, null);
  });
});

describe("repairDispatcher.postFuseClear(批1b:熔断双侧收敛)", () => {
  test("2xx → ok;POST 到 /api/webhooks/v5-selfheal-fuse-clear,body repairId='fuse',同 HMAC 契约", async () => {
    const epoch = "rr-epoch-a";
    const { fetchFn, calls } = makeFetch(200, JSON.stringify({
      cleared: true, outcome: "cleared", releaseRequestId: epoch,
    }));
    const r = await postFuseClear(
      { reason: "admin cleared", clearedBy: "42", expectedReleaseRequestId: epoch },
      { fetch: fetchFn, now: () => NOW },
    );
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, "http://127.0.0.1:19999/api/webhooks/v5-selfheal-fuse-clear");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      repairId: "fuse", reason: "admin cleared", clearedBy: "42", expectedReleaseRequestId: epoch,
    });
    const h = calls[0].init.headers;
    const bodySha = createHash("sha256").update(calls[0].init.body).digest("hex");
    const expected = createHmac("sha256", "webhook-hmac-secret")
      .update(`POST./api/webhooks/v5-selfheal-fuse-clear.${h["X-Selfheal-Ts"]}.${h["X-Selfheal-Nonce"]}.fuse.${bodySha}`)
      .digest("hex");
    assert.equal(h["X-Selfheal-Sig"], expected, "fuse-clear 用固定 repairId='fuse' 复用签名串格式");
  });

  test("非 2xx / 网络异常 → ok=false(下轮再收敛)", async () => {
    const { fetchFn: f500 } = makeFetch(500, "");
    assert.equal((await postFuseClear(
      { reason: "x", clearedBy: "1", expectedReleaseRequestId: "rr-a" },
      { fetch: f500, now: () => NOW },
    )).ok, false);
    const fThrow: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    assert.equal((await postFuseClear(
      { reason: "x", clearedBy: "1", expectedReleaseRequestId: "rr-a" },
      { fetch: fThrow, now: () => NOW },
    )).ok, false);
  });

  test("2xx ACK 必须回显 exact epoch", async () => {
    const wrong = makeFetch(200, JSON.stringify({ cleared: true, releaseRequestId: "rr-b" }));
    assert.equal((await postFuseClear(
      { reason: "x", clearedBy: "1", expectedReleaseRequestId: "rr-a" },
      { fetch: wrong.fetchFn, now: () => NOW },
    )).ok, false);
    const malformed = makeFetch(200, JSON.stringify({ cleared: true }));
    assert.equal((await postFuseClear(
      { reason: "x", clearedBy: "1", expectedReleaseRequestId: "rr-a" },
      { fetch: malformed.fetchFn, now: () => NOW },
    )).ok, false);
  });
});
