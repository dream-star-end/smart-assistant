// leaderLease 集成:epoch 化交接协议(RFC-v5-dual-master-cohort D4 R4)。
//
// 覆盖 Codex 实现审计点名的两类竞态 + 恢复矩阵关键路径:
//   · seed 首竞得(epoch0 无 holder → 安装 epoch1)
//   · graceful 交接零重叠(desired 翻转→旧 drain+ACK+unlock→新拿锁见 ACK 零等待安装)
//   · kill 模拟接管(predecessor 进程死→liveness 判定→安装)
//   · 【Codex-1】旧 epoch 迟到 ACK 不污染新代(epoch/instance 条件匹配空行 no-op)
//   · 【Codex-2】等待 fence 时 desired 反转立即放弃(不安装 + 释放 advisory)
//
// 用真 PG(专用 schema apply 0135),但 desiredWatch 打桩(可控翻转,不依赖 5s 轮询)、
// isProcessAlive/self 身份/timer 全注入 → 确定性。参照 pgSessionsBackend.integ.test.ts harness。

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { createLeaderLeaseController, type LeaderLeaseController } from "../deploy/leaderLease.js";
import type { DesiredSnapshot, DesiredWatch, Slot } from "../deploy/deployState.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_p3_lease_test";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0135 = path.resolve(here, "../db/migrations/0135_deploy_state.sql");

let pool: Pool;
let pgAvailable = false;
const liveControllers: LeaderLeaseController[] = [];

async function probeAvailability(): Promise<boolean> {
  const p = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

// 可控 fake DesiredWatch:同步翻转 desired,触发 onChange。
function fakeWatch(initial: DesiredSnapshot): DesiredWatch & { set: (snap: Partial<DesiredSnapshot>) => void } {
  let snap: DesiredSnapshot = initial;
  const subs = new Set<(s: DesiredSnapshot) => void>();
  return {
    current: () => snap,
    waitReady: async () => snap,
    refreshNow: async () => snap,
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    stop: () => { subs.clear(); },
    set: (patch) => { snap = { ...snap, ...patch }; for (const cb of subs) cb(snap); },
  };
}

function snap(desiredLeaderSlot: Slot, generation = 1): DesiredSnapshot {
  return { desiredLeaderSlot, desiredControlSlot: desiredLeaderSlot, activeSlot: "A", phase: "stable", generation };
}

interface Ev { type: "acquire" | "fence"; slot: string; at: number; }

function mkController(o: {
  slot: Slot;
  watch: DesiredWatch;
  instanceId: string; // 必须是合法 UUID(holder_instance_id 列类型)
  label: string;      // 事件标签(与 UUID 解耦,便于断言)
  pid: number;
  startTicks: number;
  isProcessAlive?: (pid: number, st: number) => boolean;
  fenceWaitMs?: number;
  events: Ev[];
  eligibleEnv?: boolean;
  /** 注入 fail-stop 观测(默认 process.exit);测试永不真退进程。 */
  onFatal?: (reason: string, detail?: unknown) => void;
  /** onFence 返回值(默认 {drained:true};BLOCKER 1 stuck 场景传 {drained:false,stuck}）。 */
  fenceOutcome?: { drained: boolean; stuck: string[] };
  /** deferred onAcquire:提供则 onAcquire 推事件后阻塞在此 gate(测 onAcquire 等待期竞态)。 */
  acquireGate?: Promise<void>;
  /** deferred onFence:提供则 onFence 推事件后阻塞在此 gate(测 graceful drain 期断连)。 */
  fenceGate?: Promise<void>;
}): LeaderLeaseController {
  const c = createLeaderLeaseController({
    pool,
    slot: o.slot,
    desiredWatch: o.watch,
    eligibleEnv: o.eligibleEnv ?? true,
    instanceId: o.instanceId,
    selfPid: o.pid,
    selfStartTicks: o.startTicks,
    isProcessAlive: o.isProcessAlive ?? (() => false),
    heartbeatMs: 80,
    recompeteMs: 30,
    fenceWaitMs: o.fenceWaitMs ?? 2000,
    fenceWaitPollMs: 30,
    onFatal: o.onFatal ?? ((reason) => { throw new Error(`unexpected fail-stop: ${reason}`); }),
    callbacks: {
      onAcquire: async () => {
        o.events.push({ type: "acquire", slot: o.label, at: Date.now() });
        if (o.acquireGate) await o.acquireGate;
      },
      onFence: async () => {
        o.events.push({ type: "fence", slot: o.label, at: Date.now() });
        if (o.fenceGate) await o.fenceGate;
        return o.fenceOutcome ?? { drained: true, stuck: [] };
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  liveControllers.push(c);
  return c;
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4000, stepMs = 20): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function readLease(): Promise<{ epoch: number; slot: string | null; instance: string | null; ack: number | null; req: number | null }> {
  const r = await pool.query(
    `SELECT lease_epoch, holder_slot, holder_instance_id, fenced_ack_epoch, fence_requested_epoch FROM leader_lease WHERE singleton = true`,
  );
  const row = r.rows[0];
  return {
    epoch: Number(row.lease_epoch),
    slot: row.holder_slot,
    instance: row.holder_instance_id,
    ack: row.fenced_ack_epoch === null ? null : Number(row.fenced_ack_epoch),
    req: row.fence_requested_epoch === null ? null : Number(row.fence_requested_epoch),
  };
}

/** 直接把 leader_lease 置成某个 predecessor 态(模拟死进程 / 活进程留下的行)。 */
async function setLease(o: { epoch: number; slot: Slot | null; instance: string | null; pid: number | null; startTicks: number | null; ack?: number | null; req?: number | null }): Promise<void> {
  await pool.query(
    `UPDATE leader_lease SET lease_epoch=$1, holder_slot=$2, holder_instance_id=$3, holder_pid=$4,
       holder_pid_start_ticks=$5, fenced_ack_epoch=$6, fence_requested_epoch=$7, updated_at=now()
       WHERE singleton = true`,
    [o.epoch, o.slot, o.instance, o.pid, o.startTicks, o.ack ?? null, o.req ?? null],
  );
}

before(async () => {
  pgAvailable = await probeAvailability();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("REQUIRE_TEST_DB=1 但 PG 不可用");
    return;
  }
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({ connectionString: TEST_DB_URL, max: 12, options: `-c search_path=${SCHEMA}` });
  const sql = await readFile(MIGRATION_0135, { encoding: "utf8" });
  await pool.query(sql);
});

afterEach(async () => {
  if (!pgAvailable) return;
  // 关停本用例起的所有 controller(释放 advisory + 销毁连接),再复位 lease 到 seed。
  while (liveControllers.length) {
    const c = liveControllers.pop()!;
    try { await c.shutdown(); } catch { /* ignore */ }
  }
  // fail-stop 测试中 onFatal 被注入为观测器(不真退进程)→ 持 advisory 的孤儿 lease 连接不会随
  // 进程死释放。真实生产靠 process.exit 释放;测试里显式 terminate 任何残留 advisory 后端,复位隔离。
  try {
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND pid <> pg_backend_pid()");
  } catch { /* ignore */ }
  await setLease({ epoch: 0, slot: null, instance: null, pid: null, startTicks: null, ack: null, req: null });
});

after(async () => {
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
});

describe("leaderLease epoch 协议", () => {
  test("seed 首竞得:epoch0 无 holder → 安装 epoch1 + onAcquire", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const wA = fakeWatch(snap("A"));
    const id = randomUUID();
    const c = mkController({ slot: "A", watch: wA, instanceId: id, label: "c1", pid: 1001, startTicks: 111, events });
    c.start();
    await waitFor(() => c.status().state === "leader");
    const lease = await readLease();
    assert.equal(lease.epoch, 1);
    assert.equal(lease.slot, "A");
    assert.equal(lease.instance, id);
    assert.equal(lease.ack, null);
    assert.equal(events.filter((e) => e.type === "acquire").length, 1);
    assert.equal(c.status().leasePid, 1001);
  });

  test("graceful 交接零重叠:desired 翻转 → 旧 drain+ACK+unlock → 新零等待安装 epoch2", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const wA = fakeWatch(snap("A")); // c1 slot A,desired A
    const wB = fakeWatch(snap("A")); // c2 slot B,desired 初始 A(standby)
    const idG1 = randomUUID();
    const idG2 = randomUUID();
    const c1 = mkController({ slot: "A", watch: wA, instanceId: idG1, label: "g1", pid: 2001, startTicks: 211, events });
    const c2 = mkController({ slot: "B", watch: wB, instanceId: idG2, label: "g2", pid: 2002, startTicks: 212, events });
    c1.start();
    c2.start();
    await waitFor(() => c1.status().state === "leader");
    assert.equal(c2.status().state, "standby"); // desired=A,c2 是 B → 不竞

    // 翻转 desired → B:c1 优雅让位(drain+ACK+unlock),c2 竞得。
    wA.set({ desiredLeaderSlot: "B" });
    wB.set({ desiredLeaderSlot: "B" });
    await waitFor(() => c2.status().state === "leader");

    // 零重叠:c1 的 fence 必须先于 c2 的 acquire。
    const fenceG1 = events.find((e) => e.type === "fence" && e.slot === "g1");
    const acqG2 = events.find((e) => e.type === "acquire" && e.slot === "g2");
    assert.ok(fenceG1, "c1 应 fence");
    assert.ok(acqG2, "c2 应 acquire");
    assert.ok(fenceG1!.at <= acqG2!.at, "c1 fence 必须早于 c2 acquire(零重叠)");

    const lease = await readLease();
    assert.equal(lease.epoch, 2);
    assert.equal(lease.slot, "B");
    assert.equal(lease.instance, idG2);
    assert.equal(lease.ack, null); // 安装清空 ack
  });

  test("kill 模拟接管:predecessor 进程死 → liveness 判定 → 安装 epoch+1", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    // 预置一个"死"的 predecessor(epoch5,pid 99999 已死)。无人持 advisory(死进程已释放)。
    await setLease({ epoch: 5, slot: "A", instance: randomUUID(), pid: 99999, startTicks: 88888, ack: null, req: null });
    const wA = fakeWatch(snap("A"));
    const idTaker = randomUUID();
    const c = mkController({
      slot: "A", watch: wA, instanceId: idTaker, label: "taker", pid: 3001, startTicks: 311, events,
      isProcessAlive: (pid) => pid !== 99999, // 99999 已死
      fenceWaitMs: 3000,
    });
    c.start();
    await waitFor(() => c.status().state === "leader", 6000);
    const lease = await readLease();
    assert.equal(lease.epoch, 6);
    assert.equal(lease.instance, idTaker);
    assert.equal(lease.ack, null);
    assert.equal(lease.req, null);
  });

  test("【BLOCKER 2】pg_terminate lease 连接 → drain + 独立短连接 ACK → 新 holder 秒级接管(非 45s liveness)", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const fatals: string[] = [];
    const wA = fakeWatch(snap("A")); // c1 slot A,desired A
    const wB = fakeWatch(snap("A")); // c2 slot B,desired 初始 A(standby)
    const idA = randomUUID();
    const idB = randomUUID();
    const c1 = mkController({ slot: "A", watch: wA, instanceId: idA, label: "t1", pid: 8001, startTicks: 811, events, onFatal: (r) => fatals.push(r) });
    // c2 视 c1 进程恒"活着"(我们只掐连接、不杀进程)→ c2 绝不能靠 liveness 提前接管,
    // 必须靠 c1 掉线后短连接写的 ACK 才能安装 → 这正是 BLOCKER 2 要验证的秒级接管路径。
    const c2 = mkController({
      slot: "B", watch: wB, instanceId: idB, label: "t2", pid: 8002, startTicks: 812, events,
      isProcessAlive: () => true, fenceWaitMs: 15000, onFatal: (r) => fatals.push(r),
    });
    c1.start();
    c2.start();
    await waitFor(() => c1.status().state === "leader");
    assert.equal(c2.status().state, "standby");
    assert.equal((await readLease()).epoch, 1);

    // 找到持 advisory 的后端 pid(c1 的 lease 连接;排除本查询自身后端)。
    const pidRow = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND pid <> pg_backend_pid()",
    );
    assert.ok(pidRow.rows[0]?.pid, "应能定位持 advisory 的 lease 后端");

    // desired 翻 B(c1 让位资格失效、c2 取得资格),再 terminate c1 的 lease 连接。
    wA.set({ desiredLeaderSlot: "B" });
    wB.set({ desiredLeaderSlot: "B" });
    await pool.query("SELECT pg_terminate_backend($1)", [pidRow.rows[0].pid]);

    const t0 = Date.now();
    await waitFor(() => c2.status().state === "leader", 12000);
    const elapsed = Date.now() - t0;
    const after = await readLease();
    assert.equal(after.epoch, 2, "c2 安装 epoch2");
    assert.equal(after.slot, "B");
    assert.equal(after.instance, idB);
    // 关键:c1 靠掉线后短连接 ACK 让 c2 秒级接管,远快于 fenceWaitMs=15s(liveness 对 c2 恒 false)。
    assert.ok(elapsed < 10000, `新 holder 应秒级接管(靠 ACK,实际 ${elapsed}ms)`);
    assert.ok(events.some((e) => e.type === "fence" && e.slot === "t1"), "c1 应因掉线 fence");
    assert.deepEqual(fatals, [], "happy 路径(drain 成功 + 短连接 ACK 成功)绝不 fail-stop");
  });

  test("【BLOCKER 1】graceful 让位时 drain 未完成(drained:false)→ fail-stop,不写 ACK 不 unlock", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const fatals: string[] = [];
    const wA = fakeWatch(snap("A"));
    const idA = randomUUID();
    const c1 = mkController({
      slot: "A", watch: wA, instanceId: idA, label: "s1", pid: 9001, startTicks: 911, events,
      onFatal: (r) => fatals.push(r),
      fenceOutcome: { drained: false, stuck: ["idleSweep"] }, // drain 谎报未完成
    });
    c1.start();
    await waitFor(() => c1.status().state === "leader");
    assert.equal((await readLease()).epoch, 1);

    // desired 翻走 → 优雅让位;但 drain 返回 drained:false → 必须 fail-stop,绝不写 ACK/unlock。
    wA.set({ desiredLeaderSlot: "B" });
    await waitFor(() => fatals.length > 0, 4000);
    assert.match(fatals[0]!, /drain incomplete/);
    const lease = await readLease();
    assert.equal(lease.ack, null, "drain 未完成绝不写 ACK");
    assert.equal(lease.epoch, 1, "lease 未交出(仍 epoch1/holder=c1)");
  });

  test("【Codex-1】旧 epoch 迟到 ACK 不污染新代", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    // 现态:已安装 epoch2/holder=new(ack NULL)。
    const idNew = randomUUID();
    const idOld = randomUUID();
    await setLease({ epoch: 2, slot: "B", instance: idNew, pid: 4002, startTicks: 412, ack: null, req: null });
    // 旧 holder(epoch1/old)迟到 ACK:SET fenced_ack_epoch=1 WHERE holder_instance_id=old AND lease_epoch=1。
    const r = await pool.query(
      `UPDATE leader_lease SET fenced_ack_epoch=1 WHERE singleton=true AND holder_instance_id=$1 AND lease_epoch=1`,
      [idOld],
    );
    assert.equal(r.rowCount, 0, "迟到 ACK 的 WHERE 应匹配空行(epoch/instance 已变)");
    const lease = await readLease();
    assert.equal(lease.epoch, 2);
    assert.equal(lease.instance, idNew);
    assert.equal(lease.ack, null, "新代 ack 不被旧 ACK 污染");
  });

  test("【Codex-2】等待 fence 时 desired 反转 → 立即放弃(不安装 + 释放 advisory)", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    // 预置一个"活着但没 ACK"的 predecessor(epoch3);c 拿到 advisory 后会进入 fence 等待。
    const idLive = randomUUID();
    await setLease({ epoch: 3, slot: "A", instance: idLive, pid: 5555, startTicks: 511, ack: null, req: null });
    const wB = fakeWatch(snap("B")); // c slot B,desired 初始 B → 竞
    const c = mkController({
      slot: "B", watch: wB, instanceId: randomUUID(), label: "flip", pid: 6001, startTicks: 611, events,
      isProcessAlive: () => true, // predecessor 一直"活着"→ 不会走 liveness 提前 break
      fenceWaitMs: 5000, // 给足等待窗
    });
    c.start();
    // 等它写下 fence_requested=3(进入等待循环)。
    await waitFor(async () => (await readLease()).req === 3, 4000);
    // 此刻 desired 反转 → 立即放弃。
    wB.set({ desiredLeaderSlot: "A" });
    // 等它离开等待:状态回 standby(desired≠self)、绝不 leader、不 onAcquire。
    await waitFor(() => c.status().state === "standby", 4000);
    assert.equal(events.some((e) => e.type === "acquire"), false, "放弃时绝不 onAcquire");
    const lease = await readLease();
    assert.equal(lease.epoch, 3, "未安装新代(仍 epoch3)");
    assert.equal(lease.instance, idLive, "holder 未变");
    // advisory 已释放:另开一连接应能拿到(证明放弃时释放了锁)。
    const probe = await pool.connect();
    try {
      const got = await probe.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
        ["oc_leader_lease_v5"],
      );
      assert.equal(got.rows[0]?.ok, true, "放弃后 advisory 应可被再次获取");
      await probe.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["oc_leader_lease_v5"]);
    } finally {
      probe.release();
    }
  });

  test("【BLOCKER 1】deferred onAcquire 期间 desired 翻走 → 安全 step-down(drain+ACK+释放),绝不进 leader", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const fatals: string[] = [];
    const wA = fakeWatch(snap("A"));
    const idA = randomUUID();
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((res) => { releaseAcquire = res; });
    const c = mkController({
      slot: "A", watch: wA, instanceId: idA, label: "b1", pid: 12001, startTicks: 1211, events,
      onFatal: (r) => fatals.push(r), acquireGate,
    });
    c.start();
    // onAcquire 已被调用(lease 已安装 epoch1)但 gate 未放 → 仍在 acquiring,尚未 leader。
    await waitFor(() => events.some((e) => e.type === "acquire"));
    await waitFor(async () => (await readLease()).epoch === 1);
    assert.notEqual(c.status().state, "leader");
    // 等待期 desired 翻走(finalize 交接场景)。
    wA.set({ desiredLeaderSlot: "B" });
    // 放开 onAcquire → 二次确认 desired≠self → step-down(drain 已启动 bundle),绝不进 leader。
    releaseAcquire();
    await waitFor(() => c.status().state === "standby", 5000);
    assert.notEqual(c.status().state, "leader");
    assert.ok(events.some((e) => e.type === "fence" && e.slot === "b1"), "应 drain 已启动 bundle(onFence)");
    assert.deepEqual(fatals, [], "drain 成功 → 不 fail-stop");
    const lease = await readLease();
    assert.equal(lease.epoch, 1, "未推进(仍 epoch1)");
    assert.equal(lease.instance, idA, "holder 仍是自己");
    assert.equal(lease.ack, 1, "graceful step-down 写本 epoch(1)ACK");
    // advisory 已释放:另开连接可再取(证明 step-down 释放了锁)。
    const probe = await pool.connect();
    try {
      const got = await probe.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", ["oc_leader_lease_v5"]);
      assert.equal(got.rows[0]?.ok, true, "step-down 后 advisory 应可再取");
      await probe.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["oc_leader_lease_v5"]);
    } finally { probe.release(); }
  });

  test("【BLOCKER 1】deferred onAcquire 期间 lease 断连(pg_terminate)→ 让路不进 leader,drain 收尾无 fail-stop", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const fatals: string[] = [];
    const wA = fakeWatch(snap("A"));
    const idA = randomUUID();
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((res) => { releaseAcquire = res; });
    const c = mkController({
      slot: "A", watch: wA, instanceId: idA, label: "b1t", pid: 13001, startTicks: 1311, events,
      onFatal: (r) => fatals.push(r), acquireGate, isProcessAlive: () => true,
    });
    c.start();
    await waitFor(() => events.some((e) => e.type === "acquire"));
    await waitFor(async () => (await readLease()).epoch === 1);
    assert.notEqual(c.status().state, "leader");
    const pidRow = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND pid <> pg_backend_pid()");
    assert.ok(pidRow.rows[0]?.pid, "定位 lease 后端");
    // desired 翻 B(隔离:掉线后不以 leader 重竞,只验"onAcquire 返回不误进 leader")。
    wA.set({ desiredLeaderSlot: "B" });
    await pool.query("SELECT pg_terminate_backend($1)", [pidRow.rows[0].pid]);
    // 放开 onAcquire:post-check 见 leaseClient 已被 onLeaseClientError 置空(或 stepDown 接管)→ 绝不进 leader。
    releaseAcquire();
    await waitFor(() => c.status().state === "standby", 8000);
    assert.notEqual(c.status().state, "leader", "旧实现会无条件进 leader(连接已死 heartbeat 空转真空);修后绝不");
    assert.ok(events.some((e) => e.type === "fence" && e.slot === "b1t"), "掉线/让位应触发 drain");
    assert.deepEqual(fatals, [], "drain + 短连接 ACK 成功 → 不 fail-stop");
  });

  test("【BLOCKER 2】graceful drain 中 terminate lease backend → 回退短连接 ACK → 后继秒级接管(非 45s liveness)", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const fatals: string[] = [];
    const wA = fakeWatch(snap("A"));
    const wB = fakeWatch(snap("A"));
    const idA = randomUUID();
    const idB = randomUUID();
    let releaseFence!: () => void;
    const fenceGate = new Promise<void>((res) => { releaseFence = res; });
    const c1 = mkController({
      slot: "A", watch: wA, instanceId: idA, label: "gd1", pid: 14001, startTicks: 1411, events,
      onFatal: (r) => fatals.push(r), fenceGate,
    });
    // c2 视 c1 进程恒"活着"→ 绝不靠 liveness 提前接管,只能靠 c1 掉线后短连接写的 ACK(BLOCKER 2 路径)。
    const c2 = mkController({
      slot: "B", watch: wB, instanceId: idB, label: "gd2", pid: 14002, startTicks: 1412, events,
      isProcessAlive: () => true, fenceWaitMs: 15000, onFatal: (r) => fatals.push(r),
    });
    c1.start();
    c2.start();
    await waitFor(() => c1.status().state === "leader");
    assert.equal(c2.status().state, "standby");
    // 翻 desired → B:c1 优雅让位,drain(onFence)阻塞在 fenceGate。
    wA.set({ desiredLeaderSlot: "B" });
    wB.set({ desiredLeaderSlot: "B" });
    await waitFor(() => events.some((e) => e.type === "fence" && e.slot === "gd1"));
    // drain 进行中(fenceGate 未放):terminate c1 的 lease 后端。stepDown 已清 leaseClient →
    // onLeaseClientError 忽略此掉线;drain 后 lease-conn ACK 必失败 → 回退短连接 ACK(修前:只 warn → c2 卡 45s)。
    const pidRow = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND pid <> pg_backend_pid()");
    assert.ok(pidRow.rows[0]?.pid, "定位 c1 lease 后端");
    await pool.query("SELECT pg_terminate_backend($1)", [pidRow.rows[0].pid]);
    const t0 = Date.now();
    releaseFence(); // drain 完成 → lease-conn ACK 失败 → 短连接 ACK → c2 见 ACK 秒级接管
    await waitFor(() => c2.status().state === "leader", 12000);
    const elapsed = Date.now() - t0;
    const after = await readLease();
    assert.equal(after.epoch, 2, "c2 安装 epoch2");
    assert.equal(after.slot, "B");
    assert.equal(after.instance, idB);
    assert.ok(elapsed < 10000, `后继靠短连接 ACK 秒级接管(非 45s liveness,实际 ${elapsed}ms)`);
    assert.deepEqual(fatals, [], "lease-conn ACK 失败但短连接 ACK 成功 → 不 fail-stop");
  });

  test("ineligible(env kill-switch)恒不竞锁", async (t) => {
    if (!pgAvailable) return t.skip("no PG");
    const events: Ev[] = [];
    const wA = fakeWatch(snap("A"));
    const c = mkController({ slot: "A", watch: wA, instanceId: randomUUID(), label: "kill", pid: 7001, startTicks: 711, events, eligibleEnv: false });
    c.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.status().state, "ineligible");
    assert.equal(events.length, 0);
    const lease = await readLease();
    assert.equal(lease.epoch, 0, "ineligible 未安装");
  });
});
