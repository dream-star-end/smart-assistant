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
  /** 批1b F13①:selfheal_release_fuse engaged=TRUE 时该行(触发 ⑨ 告警步)。 */
  fuseAlertRow?: Record<string, unknown> | null;
  /** 批1b F13①:outbox 已有该 engagement 的告警(→ 永久去重,不再入队)。 */
  outboxHasAlert?: boolean;
}

function makeSweepFake(opts: SweepFakeOpts = {}) {
  const rec = { casSqls: [] as string[], eventKinds: [] as string[], releaseCas: [] as string[] };
  const cas = opts.casRowCount ?? 1;
  const fakeQuery = (async (sql: string) => {
    if (/WHERE r\.status = 'verifying'/.test(sql)) return qr(opts.verifyingRows ?? []);
    if (/status IN \('dispatched','acked','running'\)/.test(sql)) return qr(opts.watchRows ?? []);
    if (/status IN \('cancel_requested','cancelling'\)/.test(sql)) return qr(opts.cancelRows ?? []);
    if (/SELECT 1 AS one FROM codex_repairs WHERE status = ANY/.test(sql)) {
      return qr(opts.activeExists ? [{ one: 1 }] : []);
    }
    if (/FROM incidents i JOIN incident_policies p/.test(sql)) return qr(opts.candidateRows ?? []);
    // 批1b F13①:⑨ 熔断告警步的 fuse SELECT + outbox 去重 SELECT。
    if (/SELECT reason, release_request_id, engaged_at FROM selfheal_release_fuse/.test(sql)) {
      return qr(opts.fuseAlertRow ? [opts.fuseAlertRow] : []);
    }
    if (/FROM admin_alert_outbox/.test(sql)) return qr(opts.outboxHasAlert ? [{ one: 1 }] : []);
    return qr([]);
  }) as unknown as RepairSweepDeps["query"];

  const fakeTx = (async <T>(fn: (c: PoolClient) => Promise<T>) => {
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (/UPDATE codex_repairs/.test(sql)) {
          rec.casSqls.push(sql);
          return qr([], cas);
        }
        // 批1b F2:cancel 步按裁决收口 release request 行。
        if (/UPDATE selfheal_release_requests/.test(sql)) {
          rec.releaseCas.push(sql);
          return qr([], 1);
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
    postCancel: async () => ({ ok: false, terminated: false, accepted: false, releaseCancel: null }),
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
      postCancel: async () => ({ ok: true, terminated: true, accepted: true, releaseCancel: null }),
    }));
    assert.equal(r.cancelled, 1);
    assert.ok(fake.rec.casSqls.some((s) => /status='cancelled'/.test(s)));
  });

  test("cancel 失联(ok=false)→ 不释放槽(fail-closed)", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: false, terminated: false, accepted: false, releaseCancel: null }),
    }));
    assert.equal(r.cancelled, 0);
    assert.ok(!fake.rec.casSqls.some((s) => /status='cancelled'/.test(s)));
  });

  // ── 批1b F2:cancel webhook 的 release 裁决收口 release request ──
  test("F2:releaseCancel=cancelled → CAS release request 置 cancelled + releaseCancelled++", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested", release_request_id: "rr9" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: true, terminated: false, accepted: true, releaseCancel: "cancelled" }),
    }));
    assert.equal(r.releaseCancelled, 1);
    assert.ok(fake.rec.releaseCas.some((s) => /UPDATE selfheal_release_requests/.test(s) && /status='cancelled'/.test(s)),
      "release request CAS 到 cancelled");
  });

  test("F2:releaseCancel=not_found → 同样收口 cancelled(个人版无对应 release job)", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested", release_request_id: "rr9" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: true, terminated: false, accepted: true, releaseCancel: "not_found" }),
    }));
    assert.equal(r.releaseCancelled, 1);
  });

  test("F2/R2-1:releaseCancel=too_late(200,ok=true)→ 不动 release request(交 receipt 裁决)", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested", release_request_id: "rr9" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      // R2-1:too_late 现走 200(ok=true,accepted=true);release 已 pre-claim 部署,repair 转 cancelling 待 receipt。
      postCancel: async () => ({ ok: true, terminated: false, accepted: true, releaseCancel: "too_late" }),
    }));
    assert.equal(r.releaseCancelled, 0);
    assert.equal(fake.rec.releaseCas.length, 0, "too_late 绝不 CAS release request");
  });

  test("F2/R2-1:releaseCancel=repair_mismatch(409,ok=false)→ 不收口 release request(仅告警)", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested", release_request_id: "rr9" }],
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: false, terminated: false, accepted: false, releaseCancel: "repair_mismatch" }),
    }));
    assert.equal(r.releaseCancelled, 0);
    assert.equal(fake.rec.releaseCas.length, 0, "repair_mismatch 绝不 CAS release request");
  });

  test("F2:repair 级 cancel(无 rrid)→ 不触发 release 收口", async () => {
    const fake = makeSweepFake({
      cancelRows: [{ id: "10", incident_id: "7", status: "cancel_requested" }], // 无 release_request_id
    });
    const r = await sweepRepairsOnce(baseDeps(fake, {
      postCancel: async () => ({ ok: true, terminated: true, accepted: true, releaseCancel: null }),
    }));
    assert.equal(r.releaseCancelled, 0);
    assert.equal(fake.rec.releaseCas.length, 0);
  });
});

// ── 批1b F13①:熔断 engaged → durable critical 告警(⑨,dedupe)──
describe("sweepRepairsOnce — F13① 熔断 engaged 告警", () => {
  test("fuse engaged 且 outbox 无历史 → critical 告警入队 + fuseAlerts++", async () => {
    const fake = makeSweepFake({
      fuseAlertRow: { reason: "proof_inconclusive", release_request_id: "rr9", engaged_at: new Date(NOW - 1000) },
      outboxHasAlert: false,
    });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.fuseAlerts, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].event_type, "ops.repair_failed");
    assert.equal(alerts[0].severity, "critical");
    assert.equal(alerts[0].payload?.kind, "release_fuse_engaged");
    assert.equal(alerts[0].dedupe_key, "ops.repair_failed:release_fuse_engaged:rr9");
  });

  test("fuse engaged 但 outbox 已有该 engagement 告警 → 永久去重,不重复入队", async () => {
    const fake = makeSweepFake({
      fuseAlertRow: { reason: "proof_inconclusive", release_request_id: "rr9", engaged_at: new Date(NOW - 1000) },
      outboxHasAlert: true,
    });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.fuseAlerts, 0);
    assert.equal(alerts.length, 0);
  });

  test("fuse 未 engaged → 无告警", async () => {
    const fake = makeSweepFake({ fuseAlertRow: null });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(baseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.fuseAlerts, 0);
    assert.equal(alerts.length, 0);
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

// ─── 批1b:release delivery / watch / fuse 步单元 ───────────────────────

interface ReleaseFakeOpts {
  fuseEngaged?: boolean;
  claimRow?: Record<string, unknown> | null;
  watchRows?: Record<string, unknown>[];
  convergeRows?: Record<string, unknown>[];
}

function makeReleaseFake(opts: ReleaseFakeOpts = {}) {
  const rec = {
    finalizeSqls: [] as string[],
    eventDetails: [] as string[],
    convergeCas: 0,
    convergeParams: [] as unknown[],
  };
  let claimServed = false;
  const fakeQuery = (async (sql: string, params?: unknown[]) => {
    // 其他步全空(不干扰):verify / timeout / cancel / active / candidate。
    if (/WHERE r\.status = 'verifying'/.test(sql)) return qr([]);
    if (/status IN \('dispatched','acked','running'\)/.test(sql)) return qr([]);
    if (/status IN \('cancel_requested','cancelling'\)/.test(sql)) return qr([]);
    if (/SELECT 1 AS one FROM codex_repairs WHERE status = ANY/.test(sql)) return qr([]);
    if (/FROM incidents i JOIN incident_policies p/.test(sql)) return qr([]);
    // 熔断收敛 SELECT(带 cleared_at 条件)优先于 engaged 检查匹配。
    if (/cleared_at IS NOT NULL AND personal_ack_at IS NULL/.test(sql) && /SELECT reason/.test(sql)) {
      return qr(opts.convergeRows ?? []);
    }
    if (/SET delivery_attempts = delivery_attempts \+ 1/.test(sql)) {
      if (claimServed || !opts.claimRow || opts.fuseEngaged) return qr([]);
      claimServed = true;
      return qr([opts.claimRow]);
    }
    if (/WHERE \(status='accepted'/.test(sql)) return qr(opts.watchRows ?? []);
    return qr([]);
  }) as unknown as RepairSweepDeps["query"];

  const fakeTx = (async <T>(fn: (c: PoolClient) => Promise<T>) => {
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (/UPDATE selfheal_release_requests\s+SET status=/.test(sql)) {
          rec.finalizeSqls.push(sql);
          return qr([], 1);
        }
        if (/INSERT INTO codex_repair_events/.test(sql)) {
          rec.eventDetails.push(String((params as unknown[])?.[3] ?? ""));
          return qr([]);
        }
        if (/SELECT 1 FROM selfheal_release_fuse WHERE id = 1 FOR UPDATE/.test(sql)) {
          return qr([{ "?column?": 1 }]);
        }
        if (/UPDATE selfheal_release_fuse_epochs SET personal_ack_at/.test(sql)) {
          rec.convergeCas++;
          rec.convergeParams = params ?? [];
          return qr([], 1);
        }
        if (/UPDATE selfheal_release_fuse SET personal_ack_at/.test(sql)) return qr([], 1);
        return qr([]);
      },
    } as unknown as PoolClient;
    return fn(client);
  }) as unknown as RepairSweepDeps["tx"];

  return { rec, fakeQuery, fakeTx };
}

function releaseDeps(fake: ReturnType<typeof makeReleaseFake>, extra: Partial<RepairSweepDeps> = {}): RepairSweepDeps {
  return {
    query: fake.fakeQuery,
    tx: fake.fakeTx,
    now: nowFn,
    redispatchPending: async () => 0,
    postCancel: async () => ({ ok: false, terminated: false, accepted: false, releaseCancel: null }),
    resolveIncident: async () => ({ resolved: true, rev: 2 }),
    dispatchRepair: async () => ({ status: "skipped", reason: "test" }),
    enqueueAlert: () => {},
    ...extra,
  };
}

const CLAIM_ROW = {
  id: "100", release_request_id: "rr1", repair_id: "55", incident_id: "7",
  approved_sha: "a".repeat(40), base_sha: "b".repeat(40),
  deploy_plan_hash: "c".repeat(64), manifest_hash: "d".repeat(64), delivery_attempts: 1,
};

describe("sweepRepairsOnce — 批1b release 步", () => {
  test("delivery accepted:交付 202 → request accepted + releaseDelivered++,body 为 §3.1 全字段", async () => {
    const fake = makeReleaseFake({ claimRow: CLAIM_ROW });
    const calls: unknown[] = [];
    const r = await sweepRepairsOnce(releaseDeps(fake, {
      postReleaseDelivery: async (input) => { calls.push(input); return { outcome: "accepted" }; },
    }));
    assert.equal(r.releaseDelivered, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      repairId: "55", incidentId: "7", releaseRequestId: "rr1",
      approvedSha: "a".repeat(40), baseSha: "b".repeat(40),
      deployPlanHash: "c".repeat(64), manifestHash: "d".repeat(64),
    });
    assert.ok(fake.rec.finalizeSqls.some((s) => /status='accepted'/.test(s)), "CAS 到 accepted");
    assert.ok(fake.rec.eventDetails.some((d) => d.includes("rr1")), "事件 detail 带 rrid");
  });

  test("delivery authority_mismatch(409)→ manual_required + critical 告警", async () => {
    const fake = makeReleaseFake({ claimRow: CLAIM_ROW });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(releaseDeps(fake, {
      postReleaseDelivery: async () => ({ outcome: "authority_mismatch", reason: "authority_mismatch" }),
      enqueueAlert: (e) => alerts.push(e),
    }));
    assert.equal(r.releaseManualRequired, 1);
    assert.ok(fake.rec.finalizeSqls.some((s) => /status='manual_required'/.test(s)));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].event_type, "ops.repair_failed");
    assert.equal(alerts[0].severity, "critical");
  });

  test("fuse engaged → delivery 整步跳过(不交付)", async () => {
    const fake = makeReleaseFake({ fuseEngaged: true, claimRow: CLAIM_ROW });
    const calls: unknown[] = [];
    const r = await sweepRepairsOnce(releaseDeps(fake, {
      postReleaseDelivery: async (input) => { calls.push(input); return { outcome: "accepted" }; },
    }));
    assert.equal(r.releaseDelivered, 0);
    assert.equal(calls.length, 0, "熔断时不交付任何 release");
  });

  test("watch:accepted/deploying 停滞 → 只告警不改状态", async () => {
    const fake = makeReleaseFake({
      watchRows: [{ release_request_id: "rr1", repair_id: "55", incident_id: "7", stage: "accepted_no_deploying" }],
    });
    const alerts: AlertEventInput[] = [];
    const r = await sweepRepairsOnce(releaseDeps(fake, { enqueueAlert: (e) => alerts.push(e) }));
    assert.equal(r.releaseWatchAlerts, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].event_type, "ops.repair_timeout");
    assert.equal(fake.rec.finalizeSqls.length, 0, "watch 绝不改 request 状态");
  });

  test("fuse 双侧收敛:v5 已清 + 未 ack → 投递个人版 → 回填 personal_ack_at", async () => {
    const clearedAt = new Date("2026-07-18T12:34:56.000Z");
    const fake = makeReleaseFake({ convergeRows: [{
      reason: "deploy_unknown",
      clear_reason: "admin cleared",
      cleared_by: "42",
      release_request_id: "rr-epoch-a",
      cleared_at: clearedAt,
    }] });
    const clears: unknown[] = [];
    const r = await sweepRepairsOnce(releaseDeps(fake, {
      postFuseClear: async (input) => { clears.push(input); return { ok: true }; },
    }));
    assert.equal(r.fuseConverged, 1);
    assert.deepEqual(clears[0], {
      reason: "admin cleared",
      clearedBy: "42",
      expectedReleaseRequestId: "rr-epoch-a",
    });
    assert.equal(fake.rec.convergeCas, 1, "personal_ack_at 回填 CAS 执行一次");
    assert.deepEqual(fake.rec.convergeParams, ["rr-epoch-a"], "ACK CAS 绑定 exact epoch 主键");
  });

  test("fuse 多 epoch 收敛:A/B 清除义务逐项投递且各自 ACK", async () => {
    const fake = makeReleaseFake({ convergeRows: [
      {
        reason: "A unknown", clear_reason: "A adjudicated", cleared_by: "42",
        release_request_id: "rr-a", cleared_at: new Date("2026-07-18T12:00:00.123Z"),
      },
      {
        reason: "B unknown", clear_reason: "B adjudicated", cleared_by: "42",
        release_request_id: "rr-b", cleared_at: new Date("2026-07-18T12:01:00.456Z"),
      },
    ] });
    const clears: Array<{ expectedReleaseRequestId: string; reason: string }> = [];
    const r = await sweepRepairsOnce(releaseDeps(fake, {
      postFuseClear: async (input) => {
        clears.push({
          expectedReleaseRequestId: input.expectedReleaseRequestId,
          reason: input.reason,
        });
        return { ok: true };
      },
    }));
    assert.equal(r.fuseConverged, 2);
    assert.deepEqual(clears, [
      { expectedReleaseRequestId: "rr-a", reason: "A adjudicated" },
      { expectedReleaseRequestId: "rr-b", reason: "B adjudicated" },
    ]);
    assert.equal(fake.rec.convergeCas, 2);
  });

  test("dormant:无 release request → 全部 release 步零行为", async () => {
    const fake = makeReleaseFake({}); // 无 claimRow / watch / converge
    const r = await sweepRepairsOnce(releaseDeps(fake));
    assert.equal(r.releaseDelivered, 0);
    assert.equal(r.releaseManualRequired, 0);
    assert.equal(r.releaseWatchAlerts, 0);
    assert.equal(r.fuseConverged, 0);
    assert.equal(r.errors, 0);
  });
});
