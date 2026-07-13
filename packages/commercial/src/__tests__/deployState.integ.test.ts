// deployState 集成测试(RFC-v5-dual-master-cohort §3)。
//
// harness 严格参照 pgSessionsBackend.integ.test.ts:专用 schema(search_path 隔离)apply 0135,
// 收尾 DROP SCHEMA CASCADE;无 PG → skip(除非 REQUIRE_TEST_DB=1)。
//
// 覆盖:
//   · readDeployState 读 seed
//   · casDeployState 命中(lock_version+1 + journal 同事务)
//   · CAS 并发:恰一 ok,输家读到赢家结果且不 +2
//   · journal 原子性:CAS 落空不插 journal
//   · startDesiredWatch:refreshNow 立即反映 + onChange 恰一次

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { casDeployState, readDeployState, startDesiredWatch } from "../deploy/deployState.js";
import type { DesiredSnapshot } from "../deploy/deployState.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function rawRow(desiredControlSlot: "A" | "B", lockVersion: number) {
  return {
    generation: "1",
    phase: "stable" as const,
    active_slot: "A" as const,
    candidate_slot: null,
    active_release: "bootstrap",
    candidate_release: null,
    previous_active_release: null,
    desired_leader_slot: "A" as const,
    desired_control_slot: desiredControlSlot,
    cohort_percent: 0,
    cohort_salt: "",
    cohort_allowlist: [],
    lock_version: String(lockVersion),
    transition_step: 0,
    operation_id: null,
    updated_at: new Date().toISOString(),
  };
}

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_p3_deploystate_test";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0135 = path.resolve(here, "../db/migrations/0135_deploy_state.sql");

let pool: Pool;
let pgAvailable = false;

async function probeAvailability(): Promise<boolean> {
  const p = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try {
      await p.end();
    } catch {
      /* ignore */
    }
    return false;
  }
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

  pool = new Pool({ connectionString: TEST_DB_URL, max: 10, options: `-c search_path=${SCHEMA}` });
  const sql = await readFile(MIGRATION_0135, { encoding: "utf8" });
  await pool.query(sql);
});

after(async () => {
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
});

// 每个用例复位到已知 seed 态(单行 UPDATE 覆盖全部字段 + 清空 journal),互不污染。
beforeEach(async () => {
  if (!pgAvailable) return;
  await pool.query(
    `UPDATE deploy_state SET
       generation=1, phase='stable', active_slot='A', candidate_slot=NULL,
       active_release='bootstrap', candidate_release=NULL,
       desired_leader_slot='A', desired_control_slot='A',
       cohort_percent=0, cohort_salt='', cohort_allowlist='{}',
       lock_version=1, transition_step=0, operation_id=NULL, updated_at=now()
     WHERE singleton=true`,
  );
  await pool.query(`TRUNCATE deploy_state_journal`);
});

const maybe = (name: string, fn: () => Promise<void> | void) =>
  test(name, async (t) => {
    if (!pgAvailable) {
      t.skip("PG 不可用");
      return;
    }
    await fn();
  });

describe("deployState readDeployState / casDeployState", () => {
  maybe("readDeployState 读到 seed", async () => {
    const row = await readDeployState(pool);
    assert.equal(row.phase, "stable");
    assert.equal(row.activeSlot, "A");
    assert.equal(row.desiredLeaderSlot, "A");
    assert.equal(row.desiredControlSlot, "A");
    assert.equal(row.lockVersion, 1);
    assert.equal(row.cohortPercent, 0);
    assert.equal(row.candidateSlot, null);
  });

  maybe("casDeployState 命中:lock_version+1 + phase 更新 + journal 同事务落行", async () => {
    const res = await casDeployState(pool, {
      expectedLockVersion: 1,
      patch: { phase: "canary", candidateSlot: "B", transitionStep: 1 },
      journal: { operationId: "op1", step: 1, action: "canary-start" },
    });
    assert.equal(res.ok, true);
    assert.equal(res.row.lockVersion, 2);
    assert.equal(res.row.phase, "canary");
    assert.equal(res.row.candidateSlot, "B");
    assert.equal(res.row.transitionStep, 1);

    const j = await pool.query(
      "SELECT operation_id, step, action FROM deploy_state_journal WHERE operation_id=$1",
      ["op1"],
    );
    assert.equal(j.rowCount, 1);
    assert.equal(j.rows[0].step, 1);
    assert.equal(j.rows[0].action, "canary-start");
  });

  maybe("CAS 并发:两并发 expectedLockVersion=1,恰一 ok,输家读到赢家结果且不 +2", async () => {
    const [a, b] = await Promise.all([
      casDeployState(pool, { expectedLockVersion: 1, patch: { phase: "canary" } }),
      casDeployState(pool, { expectedLockVersion: 1, patch: { phase: "finalizing" } }),
    ]);
    const oks = [a.ok, b.ok];
    assert.equal(oks.filter(Boolean).length, 1, "恰一个 CAS 命中");
    const winner = a.ok ? a : b;
    const loser = a.ok ? b : a;
    assert.equal(winner.row.lockVersion, 2, "赢家 lock_version=2");
    // 输家读到已 +1 的赢家结果(而非旧值 1,也不是错误的 3)。
    assert.equal(loser.row.lockVersion, 2, "输家读到赢家已 +1 的 lock_version");

    const now = await readDeployState(pool);
    assert.equal(now.lockVersion, 2, "输家未再改动 → 终态 lock_version 恰 2(非 3)");
    assert.equal(now.phase, winner.row.phase, "终态 phase = 赢家 patch");
  });

  maybe("journal 原子性:CAS 落空(expectedLockVersion 错)时不插入 journal", async () => {
    const res = await casDeployState(pool, {
      expectedLockVersion: 999,
      patch: { phase: "canary" },
      journal: { operationId: "op-miss", step: 1, action: "should-not-insert" },
    });
    assert.equal(res.ok, false);
    // 落空返回当前实际行(lock_version 仍 1)。
    assert.equal(res.row.lockVersion, 1);
    assert.equal(res.row.phase, "stable");
    const j = await pool.query("SELECT count(*)::int AS n FROM deploy_state_journal");
    assert.equal(j.rows[0].n, 0, "CAS 落空绝不插 journal(与 UPDATE 同事务回滚)");
  });
});

describe("deployState startDesiredWatch", () => {
  test("interval 慢读与 refreshNow 串行，旧快照不能迟到覆盖新快照", async () => {
    const first = deferred<{ rowCount: number; rows: ReturnType<typeof rawRow>[] }>();
    let queries = 0;
    const fakePool = {
      query: () => {
        queries += 1;
        if (queries === 1) return first.promise;
        return Promise.resolve({ rowCount: 1, rows: [rawRow("B", 2)] });
      },
    } as unknown as Pool;
    const watch = startDesiredWatch({ pool: fakePool, intervalMs: 60_000 });
    try {
      await new Promise((r) => setImmediate(r));
      assert.equal(queries, 1, "首轮慢读已发出");
      const refreshed = watch.refreshNow();
      await new Promise((r) => setImmediate(r));
      assert.equal(queries, 1, "refreshNow 必须排在首轮之后，不能并发查询");
      first.resolve({ rowCount: 1, rows: [rawRow("A", 1)] });
      const next = await refreshed;
      assert.equal(next.desiredControlSlot, "B");
      assert.equal(watch.current()?.desiredControlSlot, "B", "最终缓存保持新快照，不被旧读反向覆盖");
    } finally {
      watch.stop();
    }
  });

  maybe("desired_control_slot 变更后 refreshNow 立即反映 + onChange 恰一次", async () => {
    const watch = startDesiredWatch({ pool, intervalMs: 50 });
    try {
      const initial = await watch.waitReady();
      assert.equal(initial.desiredControlSlot, "A");

      let fired = 0;
      let lastSnap: DesiredSnapshot | null = null;
      const unsub = watch.onChange((s) => {
        fired += 1;
        lastSnap = s;
      });

      await pool.query(`UPDATE deploy_state SET desired_control_slot='B' WHERE singleton=true`);
      const refreshed = await watch.refreshNow();
      assert.equal(refreshed.desiredControlSlot, "B", "refreshNow 立即反映新值");
      assert.equal(fired, 1, "onChange 恰被调用一次");
      // 经回调赋值,TS 线性流会把 lastSnap 收窄到 null;显式 cast 回真实类型。
      assert.equal((lastSnap as DesiredSnapshot | null)?.desiredControlSlot, "B");

      unsub();
    } finally {
      watch.stop();
    }
  });
});
