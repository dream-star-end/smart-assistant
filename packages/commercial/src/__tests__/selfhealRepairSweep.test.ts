/**
 * v5 自愈体系切片②ⓐ — sweepRepairsOnce 状态机时序看护单元(注入 fake,无 DB/网络)。
 *
 * 验:verify freshness fence 四分支(succeeded / verification_failed / inconclusive / 未到期等待)/
 * timeout 看护 → cancel_requested + 告警 / cancel 中间态推进(terminated→cancelled)/ autoRepair 派单。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { sweepRepairsOnce, type RepairSweepDeps } from "../selfheal/sweeper.js";
import type { AlertEventInput } from "../admin/alertOutbox.js";

function qr<T extends QueryResultRow>(rows: T[], rowCount?: number): QueryResult<T> {
  return {
    rows,
    rowCount: rowCount ?? rows.length,
    command: "",
    oid: 0,
    fields: [],
  } as unknown as QueryResult<T>;
}

const NOW = 1_700_000_000_000;
const nowFn = () => NOW;

interface SweepFakeOpts {
  verifyingRows?: Record<string, unknown>[];
  watchRows?: Record<string, unknown>[];
  cancelRows?: Record<string, unknown>[];
  activeExists?: boolean;
  candidateRows?: Record<string, unknown>[];
  casRowCount?: number;
}

function makeSweepFake(opts: SweepFakeOpts = {}) {
  const rec = { casSqls: [] as string[], eventKinds: [] as string[] };
  const cas = opts.casRowCount ?? 1;
  const fakeQuery = (async (sql: string) => {
    if (/WHERE r\.status = 'verifying'/.test(sql)) return qr(opts.verifyingRows ?? []);
    if (/status IN \('dispatched','acked','running'\)/.test(sql)) return qr(opts.watchRows ?? []);
    if (/status IN \('cancel_requested','cancelling'\)/.test(sql)) return qr(opts.cancelRows ?? []);
    if (/SELECT 1 AS one FROM codex_repairs WHERE status = ANY/.test(sql)) {
      return qr(opts.activeExists ? [{ one: 1 }] : []);
    }
    if (/FROM incidents i JOIN incident_policies p/.test(sql)) return qr(opts.candidateRows ?? []);
    return qr([]);
  }) as unknown as RepairSweepDeps["query"];

  const fakeTx = (async <T>(fn: (c: PoolClient) => Promise<T>) => {
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (/UPDATE codex_repairs/.test(sql)) {
          rec.casSqls.push(sql);
          return qr([], cas);
        }
        if (/INSERT INTO codex_repair_events/.test(sql)) {
          rec.eventKinds.push(String((params as unknown[])?.[1] ?? ""));
          return qr([]);
        }
        return qr([]);
      },
    } as unknown as PoolClient;
    return fn(client);
  }) as unknown as RepairSweepDeps["tx"];

  return { rec, fakeQuery, fakeTx };
}

function baseDeps(fake: ReturnType<typeof makeSweepFake>, extra: Partial<RepairSweepDeps> = {}): RepairSweepDeps {
  return {
    query: fake.fakeQuery,
    tx: fake.fakeTx,
    now: nowFn,
    redispatchPending: async () => 0,
    postCancel: async () => ({ ok: false, terminated: false, accepted: false }),
    resolveIncident: async () => ({ resolved: true, rev: 2 }),
    dispatchRepair: async () => ({ status: "skipped", reason: "test" }),
    enqueueAlert: () => {},
    ...extra,
  };
}

beforeEach(() => {
  process.env.OC_SELFHEAL_DISPATCH_URL = "http://127.0.0.1:19999";
  process.env.OC_SELFHEAL_WEBHOOK_HMAC = "hmac";
});

describe("sweepRepairsOnce — verify freshness fence", () => {
  test("新观测 firing=false → succeeded + resolveIncident(source=codex)", async () => {
    const fake = makeSweepFake({
      verifyingRows: [{
        id: "10", incident_id: "7",
        verify_after: new Date(NOW - 60_000),
        verify_deadline: new Date(NOW + 60_000),
        firing: false,
        observed_at: new Date(NOW - 1_000), // > verify_after → fresh
      }],
    });
    const resolveCalls: Array<[string, string]> = [];
    const r = await sweepRepairsOnce(baseDeps(fake, {
      resolveIncident: async (id, source) => {
        resolveCalls.push([id as string, source as string]);
        return { resolved: true, rev: 2 };
      },
    }));
    assert.equal(r.succeeded, 1);
    assert.deepEqual(resolveCalls, [["7", "codex"]]);
    assert.ok(fake.rec.casSqls.some((s) => /status='succeeded'/.test(s)));
  });

  test("新观测 firing=true 且过 deadline → verification_failed + 告警", async () => {
    const fake = makeSweepFake({
      verifyingRows: [{
        id: "10", incident_id: "7",
        verify_after: new Date(NOW - 60_000),
        verify_deadline: new Date(NOW - 1_000), // 已过
        firing: true,
        observed_at: new Date(NOW - 10_000), // fresh
      }],
    });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.verificationFailed, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].payload?.kind, "verification_failed");
  });

  test("无新观测且过 deadline → verification_inconclusive(非失败)", async () => {
    const fake = makeSweepFake({
      verifyingRows: [{
        id: "10", incident_id: "7",
        verify_after: new Date(NOW - 60_000),
        verify_deadline: new Date(NOW - 1_000),
        firing: true,
        observed_at: new Date(NOW - 120_000), // <= verify_after → 非 fresh
      }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake));
    assert.equal(r.inconclusive, 1);
    assert.equal(r.verificationFailed, 0);
  });

  test("新观测 firing=true 未到 deadline → 等待(不裁决)", async () => {
    const fake = makeSweepFake({
      verifyingRows: [{
        id: "10", incident_id: "7",
        verify_after: new Date(NOW - 60_000),
        verify_deadline: new Date(NOW + 60_000), // 未过
        firing: true,
        observed_at: new Date(NOW - 1_000), // fresh
      }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake));
    assert.equal(r.succeeded, 0);
    assert.equal(r.verificationFailed, 0);
    assert.equal(r.inconclusive, 0);
  });
});

describe("sweepRepairsOnce — timeout 看护 + cancel 推进", () => {
  test("running 超总预算 → cancel_requested + 告警", async () => {
    const fake = makeSweepFake({
      watchRows: [{
        id: "10", incident_id: "7", status: "running",
        created_at: new Date(NOW - 100 * 60_000), // 超 90min
        dispatched_at: new Date(NOW - 99 * 60_000),
      }],
    });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.cancelRequested, 1);
    assert.ok(fake.rec.casSqls.some((s) => /status='cancel_requested'/.test(s)));
    assert.equal(alerts[0].payload?.kind, "timeout_total");
  });

  test("dispatched 超 ack 预算 → cancel_requested(kind=ack)", async () => {
    const fake = makeSweepFake({
      watchRows: [{
        id: "10", incident_id: "7", status: "dispatched",
        created_at: new Date(NOW - 6 * 60_000),
        dispatched_at: new Date(NOW - 6 * 60_000), // 超 5min ack 预算
      }],
    });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.cancelRequested, 1);
    assert.equal(alerts[0].payload?.kind, "timeout_ack");
  });

  test("running 未超预算 → 不动", async () => {
    const fake = makeSweepFake({
      watchRows: [{
        id: "10", incident_id: "7", status: "running",
        created_at: new Date(NOW - 10 * 60_000),
        dispatched_at: new Date(NOW - 9 * 60_000),
      }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake));
    assert.equal(r.cancelRequested, 0);
  });

  test("cancel_requested + 个人版确认 terminated → cancelled(释放槽)", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: true, terminated: true, accepted: true }),
    }));
    assert.equal(r.cancelled, 1);
    assert.ok(fake.rec.casSqls.some((s) => /status='cancelled'/.test(s)));
  });

  test("cancel 失联(ok=false)→ 不释放槽(fail-closed)", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: false, terminated: false, accepted: false }),
    }));
    assert.equal(r.cancelled, 0);
    assert.ok(!fake.rec.casSqls.some((s) => /status='cancelled'/.test(s)));
  });
});

describe("sweepRepairsOnce — autoRepair 派单", () => {
  test("无活跃修复 + auto_repair incident → dispatchRepair 派单", async () => {
    const fake = makeSweepFake({
      activeExists: false,
      candidateRows: [{ id: "7" }, { id: "8" }],
    });
    const dispatched: string[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, {
      dispatchRepair: async (id) => {
        dispatched.push(id);
        return { status: "dispatched", repairId: "10", attempt: 1 };
      },
    }));
    assert.equal(r.dispatched, 1);
    assert.deepEqual(dispatched, ["7"], "singleflight:派第一个成功即止");
  });

  test("已有活跃修复 → 不派单(singleflight)", async () => {
    const fake = makeSweepFake({ activeExists: true, candidateRows: [{ id: "7" }] });
    const dispatched: string[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, {
      dispatchRepair: async (id) => {
        dispatched.push(id);
        return { status: "dispatched", repairId: "10", attempt: 1 };
      },
    }));
    assert.equal(r.dispatched, 0);
    assert.equal(dispatched.length, 0);
  });
});
