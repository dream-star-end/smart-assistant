// 0135_deploy_state.sql 迁移集成测试(P3/RFC-v5-dual-master-cohort)。
//
// harness 同 pgSessionsBackend.integ.test.ts:专用 schema apply,收尾 DROP SCHEMA CASCADE;
// 无 PG → skip(除非 REQUIRE_TEST_DB=1)。
//
// 覆盖:
//   · 幂等:连续 apply 两次不报错;ON CONFLICT DO NOTHING 不覆盖已改动的 seed 行
//   · CHECK 约束:非法 phase / active_slot='C' / cohort_percent=200 抛错
//   · leader_lease seed(lease_epoch=0,holder_instance_id IS NULL)
//   · oauth_pending_states 存在 + expires_at 索引 + 原子消费路径(DELETE ... RETURNING)

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { casDeployState, readDeployState } from "../deploy/deployState.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_p3_migration0135_test";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0135 = path.resolve(here, "../db/migrations/0135_deploy_state.sql");

let pool: Pool;
let migrationSql = "";
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

  pool = new Pool({ connectionString: TEST_DB_URL, max: 5, options: `-c search_path=${SCHEMA}` });
  migrationSql = await readFile(MIGRATION_0135, { encoding: "utf8" });
  await pool.query(migrationSql); // 首次 apply
});

after(async () => {
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
});

// 复位 deploy_state 到 seed + 清 oauth 表,保证用例互不污染(leader_lease seed 只建一次,保留)。
beforeEach(async () => {
  if (!pgAvailable) return;
  await pool.query(
    `UPDATE deploy_state SET
       generation=1, phase='stable', active_slot='A', candidate_slot=NULL,
       active_release=NULL, candidate_release=NULL, previous_active_release=NULL,
       desired_leader_slot='A', desired_control_slot='A',
       cohort_percent=0, cohort_salt='', cohort_allowlist='{}',
       lock_version=1, transition_step=0, operation_id=NULL, updated_at=now()
     WHERE singleton=true`,
  );
  await pool.query(`TRUNCATE oauth_pending_states`);
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

describe("0135 迁移幂等 + 约束 + seed", () => {
  maybe("二次 apply 幂等:不报错、deploy_state 仍单行、ON CONFLICT DO NOTHING 不覆盖已改动", async () => {
    // 先 CAS 改一个字段。
    const cas = await casDeployState(pool, { expectedLockVersion: 1, patch: { phase: "canary" } });
    assert.equal(cas.ok, true);
    assert.equal(cas.row.phase, "canary");

    // 再 apply 一次 —— 不应抛错,且 INSERT ON CONFLICT DO NOTHING 不覆盖已改动的行。
    await pool.query(migrationSql);

    const after2 = await readDeployState(pool);
    assert.equal(after2.phase, "canary", "ON CONFLICT DO NOTHING → seed 不覆盖已有运行态");
    assert.equal(after2.activeRelease, null, "0135 真实 seed active_release=NULL");
    assert.equal(after2.previousActiveRelease, null, "0135 真实 seed previous_active_release=NULL");

    const cnt = await pool.query("SELECT count(*)::int AS n FROM deploy_state");
    assert.equal(cnt.rows[0].n, 1, "deploy_state 仍只有一行");
  });

  maybe("CHECK 约束生效:非法 phase / active_slot='C' / cohort_percent=200 抛错", async () => {
    await assert.rejects(
      () => pool.query(`UPDATE deploy_state SET phase='bogus' WHERE singleton=true`),
      /check|violat/i,
    );
    await assert.rejects(
      () => pool.query(`UPDATE deploy_state SET active_slot='C' WHERE singleton=true`),
      /check|violat/i,
    );
    await assert.rejects(
      () => pool.query(`UPDATE deploy_state SET cohort_percent=200 WHERE singleton=true`),
      /check|violat/i,
    );
    // 失败的 UPDATE 不改状态。
    const row = await readDeployState(pool);
    assert.equal(row.phase, "stable");
    assert.equal(row.activeSlot, "A");
    assert.equal(row.cohortPercent, 0);
  });

  maybe("leader_lease seed 存在(lease_epoch=0,holder_instance_id IS NULL)", async () => {
    const r = await pool.query(
      "SELECT lease_epoch, holder_instance_id, holder_slot FROM leader_lease WHERE singleton=true",
    );
    assert.equal(r.rowCount, 1, "leader_lease 单行已 seed");
    assert.equal(Number(r.rows[0].lease_epoch), 0);
    assert.equal(r.rows[0].holder_instance_id, null);
    assert.equal(r.rows[0].holder_slot, null);
  });

  maybe("oauth_pending_states:表存在 + expires_at 索引 + 原子消费(DELETE ... RETURNING payload)", async () => {
    // 索引存在。
    const idx = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='oauth_pending_states'",
      [SCHEMA],
    );
    const idxNames = idx.rows.map((x) => x.indexname);
    assert.ok(idxNames.includes("idx_oauth_pending_expires"), `缺 expires_at 索引: ${idxNames.join(",")}`);

    // 原子消费路径:INSERT 后 DELETE ... WHERE expires_at>now() RETURNING payload。
    await pool.query(
      "INSERT INTO oauth_pending_states (state_hash, payload, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
      ["sh-1", "payload-json-1"],
    );
    const consumed = await pool.query(
      "DELETE FROM oauth_pending_states WHERE state_hash=$1 AND expires_at>now() RETURNING payload",
      ["sh-1"],
    );
    assert.equal(consumed.rowCount, 1, "一次性消费命中");
    assert.equal(consumed.rows[0].payload, "payload-json-1");
    // 重复消费 → 空(已被 DELETE)。
    const again = await pool.query(
      "DELETE FROM oauth_pending_states WHERE state_hash=$1 AND expires_at>now() RETURNING payload",
      ["sh-1"],
    );
    assert.equal(again.rowCount, 0, "原子消费不可重放");
  });
});
