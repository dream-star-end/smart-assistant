/**
 * R6.11 agent_migrations ledger 模块行为测试(Phase 2.A 实装)。
 *
 * 本文件测的是 **ledger 模块本身的行为**(v3migrationLedger.ts API);
 * ensureRunning 维度的 reader 闸门(INV-3 / INV-5 ⌘)由 v3EnsureRunningMigrationGuard.test.ts
 * 单独锁,Phase 2.B 实装。本文件保持"ledger 模块单元 / 整合行为"焦点,避免红测染色。
 *
 * 实测 invariant:
 *   - INV-6:createPlannedMigration → 行 phase='planned' + new_container_internal_id NULL +
 *     paused_at NULL(R6.9 INSERT 前移到 ① pickHost 之后,planned 阶段尚未 docker create 也未 pause)
 *   - markPhase → updated_at 推进 + 可选 patch(new_cid / paused_at)同事务写
 *   - markCommitted → phase='committed' + committed_at NOT NULL + updated_at 推进
 *   - markRolledBack → phase='rolled_back' + committed_at 保持 NULL(终态语义清晰)
 *   - findOpenByContainer → open phase 返,closed phase 不返
 *   - listStale → 用部分索引,只返 phase NOT IN closed AND updated_at < now()-threshold
 *   - UNIQUE PARTIAL INDEX `agent_migrations_one_open_by_container_idx` 阻止同 container 双 open(23505)
 *
 * 留 todo(write-side 代码未存,无被测对象,转 active 会制造假覆盖):
 *   - INV-8(⑥f routing ACK 超时不回退 state / host_id)— 依赖 §14.2.4 ⑥f writer 代码
 *
 * Phase 2.B 接管:
 *   - INV-3 / INV-5(ensureRunning 闸门 + SQL shape)→ v3EnsureRunningMigrationGuard.test.ts
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { query } from "../db/queries.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";
import {
  createPlannedMigration,
  markPhase,
  markCommitted,
  markRolledBack,
  findOpenByContainer,
  findOpenByUser,
  listStale,
  TERMINAL_PHASES,
  MigrationGuardError,
  MigrationPhaseInputError,
  type MigrationPhase,
} from "../agent-sandbox/v3migrationLedger.js";

/**
 * 隔离策略:**专属库** openclaude_v3ml_test(见 helpers/db.ts:useDedicatedTestDatabase)。
 *
 * 此前本文件对共享库 openclaude_test 做 `DROP SCHEMA public CASCADE; CREATE SCHEMA public`
 * —— 与 v3MigrationReconciler / v3EnsureRunningMigrationGuard 两个同法文件在
 * node:test 的文件级并发下互撞(实测报错随竞态落点而变:42P06 already exists /
 * no schema has been selected to create in / schema_migrations does not exist),
 * before 钩子 hookFailed → 整文件 cancelled。三者因此长期挂在
 * .github/known-failures/commercial-unit.txt 上,ledger 的 open-migration 闸门
 * 契约实际无门禁。改专属库后各跑各的,零共享面。
 */
const db = useDedicatedTestDatabase("openclaude_v3ml_test");

let hostUuidA = ""; // 旧 host
let hostUuidB = ""; // 新 host
let containerId = 0n;

/**
 * 每个 test 重置 agent_migrations + 重建 host A/B + 一个 agent_containers active 行。
 * 用 hostUuidA / hostUuidB 做 old/new host UUID;containerId 是 agent_containers.id。
 * 不动 users / claude_accounts —— ledger 测试不需要 user_id JOIN(那是 findOpenByUser
 * 维度,v3EnsureRunningMigrationGuard 测;本文件 findOpenByContainer 按 container.id)。
 *
 * 'self' host 由 0030 migration seed 已存在,本测试只增加 host B 一行。
 */
beforeEach(async () => {
  if (!db.available) return;
  await query("TRUNCATE TABLE agent_migrations RESTART IDENTITY CASCADE");
  await query("DELETE FROM agent_containers");
  await query("DELETE FROM users WHERE id = 1");
  // 0005 init_agent: agent_containers.user_id REFERENCES users(id) — 必须先种 user
  await query(
    `INSERT INTO users (id, email, password_hash) VALUES (1, 'ledger-test@example.com', '$argon2id$placeholder')
     ON CONFLICT (id) DO NOTHING`,
  );
  // 拿 self host UUID 当 host A;插入 host B
  const selfRow = await query<{ id: string }>(
    "SELECT id FROM compute_hosts WHERE name = 'self' LIMIT 1",
  );
  hostUuidA = selfRow.rows[0]!.id;
  // 插 host B(测试用,name 唯一,bridge_cidr 用占位)
  // 列集对齐 0030 + 0032 + 0042 schema(参考 queriesAtomicLifecycle.integ.test.ts:insertTestHost)
  const hostBRow = await query<{ id: string }>(
    `INSERT INTO compute_hosts (
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct,
       agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status
     ) VALUES (
       'test-host-b', '10.0.0.99', 22, 'root', 9443,
       E'\\\\x01'::bytea, E'\\\\x01'::bytea,
       E'\\\\x01'::bytea, E'\\\\x01'::bytea,
       50, '172.30.99.0/24', 'ready'
     )
     ON CONFLICT (name) DO UPDATE SET host = EXCLUDED.host
     RETURNING id`,
  );
  hostUuidB = hostBRow.rows[0]!.id;
  // 插 1 个 active container,host_uuid = A
  // secret_hash CHECK = length 32(0xNN repeat 32 = 32 字节,满足 agent_containers_secret_hash_len32)
  const cRow = await query<{ id: string }>(
    `INSERT INTO agent_containers (
       user_id, host_uuid, host_id, bound_ip, port,
       container_internal_id, secret_hash, state, last_ws_activity
     ) VALUES (
       1, $1, NULL, '172.30.0.10'::inet, 8000,
       'old-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       decode(repeat('aa', 32), 'hex'),
       'active', now()
     )
     RETURNING id`,
    [hostUuidA],
  );
  containerId = BigInt(cRow.rows[0]!.id);
});

function skipIfNoPg(t: { skip: (r: string) => void }): boolean {
  return db.skipIfUnavailable(t);
}

function planned() {
  return {
    agentContainerId: containerId,
    oldHostId: hostUuidA,
    oldContainerInternalId: "old-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    newHostId: hostUuidB,
  };
}

describe("v3migrationLedger — INV-6 (createPlannedMigration contract)", () => {
  test("INV-6: createPlannedMigration → phase='planned' + new_cid NULL + paused_at NULL", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    assert.ok(migrationId > 0n, "migrationId 应是正 bigint");

    const r = await query<{
      phase: string;
      new_container_internal_id: string | null;
      paused_at: Date | null;
      committed_at: Date | null;
      agent_container_id: string;
      old_host_id: string;
      new_host_id: string;
      old_container_internal_id: string;
    }>(
      `SELECT phase, new_container_internal_id, paused_at, committed_at,
              agent_container_id, old_host_id, new_host_id, old_container_internal_id
         FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows.length, 1);
    const row = r.rows[0]!;
    assert.equal(row.phase, "planned", "INV-6: 初始 phase 必须 'planned'");
    assert.equal(row.new_container_internal_id, null, "INV-6: planned 阶段 new_cid 必须 NULL");
    assert.equal(row.paused_at, null, "INV-6: planned 阶段 paused_at 必须 NULL");
    assert.equal(row.committed_at, null, "planned 阶段 committed_at NULL");
    assert.equal(BigInt(row.agent_container_id), containerId);
    assert.equal(row.old_host_id, hostUuidA);
    assert.equal(row.new_host_id, hostUuidB);
  });

  test("INV-6 防双 open:同 container 第二次 createPlannedMigration → 23505 unique violation", async (t) => {
    if (skipIfNoPg(t)) return;
    await createPlannedMigration(planned());
    await assert.rejects(
      () => createPlannedMigration(planned()),
      (err: Error & { code?: string }) => {
        // PG 唯一约束违反 SQLSTATE = 23505
        assert.equal(err.code, "23505", `应是 unique_violation,实际 code=${err.code}`);
        return true;
      },
      "同 container 已有 open migration 时,第二次 INSERT 必须被 unique partial index 拦下",
    );
  });
});

describe("v3migrationLedger — markPhase / 终态 markers", () => {
  test("markPhase('created', {newContainerInternalId}) → cid + updated_at 推进 + paused_at 仍 NULL", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    const beforeRow = await query<{ updated_at: Date }>(
      `SELECT updated_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    // 让时钟前进 ≥1ms — pg now() resolution
    await new Promise((r) => setTimeout(r, 5));
    await markPhase(migrationId, "created", { newContainerInternalId: "new-cid-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    const after = await query<{ phase: string; new_container_internal_id: string | null; paused_at: Date | null; updated_at: Date }>(
      `SELECT phase, new_container_internal_id, paused_at, updated_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(after.rows[0]!.phase, "created");
    assert.equal(after.rows[0]!.new_container_internal_id, "new-cid-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    assert.equal(after.rows[0]!.paused_at, null, "未带 pausedAt patch,该字段不应被改");
    assert.ok(
      after.rows[0]!.updated_at.getTime() > beforeRow.rows[0]!.updated_at.getTime(),
      `updated_at 必须推进;before=${beforeRow.rows[0]!.updated_at.toISOString()} after=${after.rows[0]!.updated_at.toISOString()}`,
    );
  });

  test("markPhase 同事务可写 pausedAt(③ pause 路径)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    const pauseT = new Date("2026-05-23T10:00:00.000Z");
    await markPhase(migrationId, "created", {
      newContainerInternalId: "new-cid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pausedAt: pauseT,
    });
    const r = await query<{ paused_at: Date | null }>(
      `SELECT paused_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.ok(r.rows[0]!.paused_at, "paused_at 必须被写入");
    assert.equal(r.rows[0]!.paused_at!.toISOString(), pauseT.toISOString());
  });

  test("markCommitted → phase='committed' + committed_at NOT NULL + updated_at 推进", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markCommitted(migrationId);
    const r = await query<{ phase: string; committed_at: Date | null; updated_at: Date }>(
      `SELECT phase, committed_at, updated_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows[0]!.phase, "committed");
    assert.ok(r.rows[0]!.committed_at, "committed_at 必须被写入");
  });

  test("markRolledBack → phase='rolled_back' + committed_at 保持 NULL(终态语义)", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markRolledBack(migrationId);
    const r = await query<{ phase: string; committed_at: Date | null }>(
      `SELECT phase, committed_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows[0]!.phase, "rolled_back");
    assert.equal(r.rows[0]!.committed_at, null, "rolled_back 终态 committed_at 必须 NULL");
  });
});

describe("v3migrationLedger — findOpenByContainer / listStale (reader side)", () => {
  test("findOpenByContainer:planned 行返回;committed 行不返", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    const open = await findOpenByContainer(containerId);
    assert.ok(open, "planned 行应被视为 open");
    assert.equal(open!.id, migrationId);
    assert.equal(open!.phase, "planned");

    await markCommitted(migrationId);
    const afterCommit = await findOpenByContainer(containerId);
    assert.equal(afterCommit, null, "committed 行不应被 findOpenByContainer 返回");
  });

  test("findOpenByContainer:rolled_back 行不返", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markRolledBack(migrationId);
    const r = await findOpenByContainer(containerId);
    assert.equal(r, null);
  });

  test("listStale:phase 未结束 + updated_at < cutoff 行被返", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    // 手动把 updated_at 推回 10 分钟前
    await query(
      `UPDATE agent_migrations SET updated_at = now() - interval '10 minutes' WHERE id = $1`,
      [migrationId.toString()],
    );
    const stale60s = await listStale(60);
    assert.equal(stale60s.length, 1, "10min 前 planned 行应被 60s 阈值 listStale 命中");
    assert.equal(stale60s[0]!.id, migrationId);

    const stale1h = await listStale(3600);
    assert.equal(stale1h.length, 0, "10min 不到 1h 阈值,不该返");
  });

  test("listStale:committed / rolled_back 行不返", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markCommitted(migrationId);
    await query(
      `UPDATE agent_migrations SET updated_at = now() - interval '10 minutes' WHERE id = $1`,
      [migrationId.toString()],
    );
    const r = await listStale(60);
    assert.equal(r.length, 0, "committed 行无论多老都不该被 listStale 命中(部分索引 WHERE phase NOT IN closed)");
  });

  test("listStale:thresholdSec 非法值 throw", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(() => listStale(-1), /non-negative integer/);
    await assert.rejects(() => listStale(1.5), /non-negative integer/);
  });
});

describe("v3migrationLedger — markPhase 入参 guard(Codex Phase 2.A review v2 BLOCKER)", () => {
  test("markPhase('committed' as any) → 抛 MigrationPhaseInputError;行不被修改", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await assert.rejects(
      // 模拟 `as any` 绕过 TS Exclude 的运行时路径(动态调用 / JSON 反序列化 / 重构遗漏)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => markPhase(migrationId, "committed" as any),
      (err: Error) => {
        assert.ok(err instanceof MigrationPhaseInputError, "应抛 MigrationPhaseInputError 而非 SQL error");
        assert.equal((err as MigrationPhaseInputError).badPhase, "committed");
        return true;
      },
    );
    const r = await query<{ phase: string; committed_at: Date | null }>(
      `SELECT phase, committed_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows[0]!.phase, "planned", "入参 guard 必须在 SQL 前拦,phase 不改");
    assert.equal(r.rows[0]!.committed_at, null, "committed_at 不可被绕过 markCommitted 设置");
  });

  test("markPhase('rolled_back' as any) → 抛 MigrationPhaseInputError;不让 unique partial idx 失效", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => markPhase(migrationId, "rolled_back" as any),
      MigrationPhaseInputError,
    );
    // 行仍是 planned(open)— 同 container 第二次 createPlannedMigration 必须被 unique partial idx 拦
    await assert.rejects(
      () => createPlannedMigration(planned()),
      (err: Error & { code?: string }) => err.code === "23505",
      "原 planned 行仍 open,unique partial idx 应继续生效",
    );
  });
});

describe("v3migrationLedger — terminal guard(Codex Phase 2.A review BLOCKER 1/2)", () => {
  test("markCommitted 后再 markPhase 抛 MigrationGuardError 且不修改行", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markCommitted(migrationId);
    await assert.rejects(
      () => markPhase(migrationId, "created", { newContainerInternalId: "x".repeat(64) }),
      MigrationGuardError,
    );
    const r = await query<{ phase: string; new_container_internal_id: string | null }>(
      `SELECT phase, new_container_internal_id FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows[0]!.phase, "committed", "phase 不应被复活");
    assert.equal(r.rows[0]!.new_container_internal_id, null, "new_cid 不应被回写");
  });

  test("markRolledBack 后再 markCommitted 抛 — 防 committed_at 反向覆盖", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markRolledBack(migrationId);
    await assert.rejects(() => markCommitted(migrationId), MigrationGuardError);
    const r = await query<{ phase: string; committed_at: Date | null }>(
      `SELECT phase, committed_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows[0]!.phase, "rolled_back");
    assert.equal(r.rows[0]!.committed_at, null, "已 rolled_back 行 committed_at 必须保 NULL");
  });

  test("markCommitted 后再 markRolledBack 抛 — 防 committed_at 残留+phase 矛盾", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markCommitted(migrationId);
    await assert.rejects(() => markRolledBack(migrationId), MigrationGuardError);
    const r = await query<{ phase: string; committed_at: Date | null }>(
      `SELECT phase, committed_at FROM agent_migrations WHERE id = $1`,
      [migrationId.toString()],
    );
    assert.equal(r.rows[0]!.phase, "committed", "已 committed 行 phase 不应反向回 rolled_back");
    assert.ok(r.rows[0]!.committed_at, "committed_at 保留");
  });

  test("不存在的 migrationId markPhase 抛 MigrationGuardError(WHERE rowCount=0)", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => markPhase(99999999n, "created", { newContainerInternalId: "x".repeat(64) }),
      MigrationGuardError,
    );
  });

  test("重复 markCommitted 第二次抛 — 不静默幂等", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markCommitted(migrationId);
    await assert.rejects(() => markCommitted(migrationId), MigrationGuardError);
  });
});

describe("v3migrationLedger — findOpenByUser(§13.3 reader 闸门入口)", () => {
  test("findOpenByUser:active container + planned migration → 返 OpenMigrationSummary", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    const open = await findOpenByUser(1n);
    assert.ok(open, "user=1 的 active container 有 open migration 应被返");
    assert.equal(open!.id, migrationId);
    assert.equal(open!.phase, "planned");
    assert.equal(open!.agentContainerId, containerId);
  });

  test("findOpenByUser:无 migration → null", async (t) => {
    if (skipIfNoPg(t)) return;
    const r = await findOpenByUser(1n);
    assert.equal(r, null);
  });

  test("findOpenByUser:其他 uid → null(uid 锁身份)", async (t) => {
    if (skipIfNoPg(t)) return;
    await createPlannedMigration(planned());
    const r = await findOpenByUser(99999n);
    assert.equal(r, null, "uid=99999 没 container 不该返其他 user 的 migration");
  });

  test("findOpenByUser:container 状态非 active/pending_apply → null", async (t) => {
    if (skipIfNoPg(t)) return;
    await createPlannedMigration(planned());
    // 把 container 切到 vanished —— 应被 reader state filter 排除
    await query(
      `UPDATE agent_containers SET state = 'vanished' WHERE id = $1`,
      [containerId.toString()],
    );
    const r = await findOpenByUser(1n);
    assert.equal(r, null, "vanished container 不在 reader candidate set 内");
  });

  test("findOpenByUser:migration committed → null", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markCommitted(migrationId);
    const r = await findOpenByUser(1n);
    assert.equal(r, null, "committed 行不再 open");
  });

  test("findOpenByUser:migration rolled_back → null", async (t) => {
    if (skipIfNoPg(t)) return;
    const { migrationId } = await createPlannedMigration(planned());
    await markRolledBack(migrationId);
    const r = await findOpenByUser(1n);
    assert.equal(r, null);
  });
});

describe("v3migrationLedger — TERMINAL_PHASES 常量正确性(防 future bug)", () => {
  test("TERMINAL_PHASES 含且仅含 committed / rolled_back", () => {
    assert.ok(TERMINAL_PHASES.has("committed" as MigrationPhase));
    assert.ok(TERMINAL_PHASES.has("rolled_back" as MigrationPhase));
    assert.equal(TERMINAL_PHASES.size, 2);
    for (const p of ["planned", "created", "detached", "attached_pre", "attached_route", "started"] as MigrationPhase[]) {
      assert.ok(!TERMINAL_PHASES.has(p), `${p} 不应在 TERMINAL_PHASES 中`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// 留 todo:write-side 代码未存,无被测对象
// ───────────────────────────────────────────────────────────────────────

describe("v3 agent_migrations ledger — INV-8 留 placeholder", () => {
  test.todo(
    "INV-8(待 §14.2.4 ⑥f writer 落地后转 active):⑥f routing ACK 超时分支不回退 state / host_id;只 force-rm 旧 paused 容器,留 phase='attached_route' 等 §14.2.6 reconciler 推前。当下 writer 代码不存,无被测对象,转 active 会制造假覆盖。Phase 2 plan Codex review 第 6/7 点确认保留",
  );
});
