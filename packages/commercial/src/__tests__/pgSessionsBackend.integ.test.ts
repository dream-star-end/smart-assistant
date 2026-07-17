// pgSessionsBackend 集成 + 并发契约测试(RFC-v5-sessions-pg §9)。
//
// 需 PG fixture(openclaude_test，与其它 integ 同库)。为不污染共享 public schema，本套件在
// 专用 schema `oc_p2_sessions_test` 里 apply 0066/0078 WeChat outbox + 0134 六表 + 状态机表
// + 0147 lossless tape + GoalState placeholder migration
// (pool 走 search_path 隔离)，
// 收尾 DROP SCHEMA CASCADE。无 PG → skip（与既有 integ 模式一致）。
//
// 覆盖:
//   · contract 核心路径:upsert / append / appendForRequest / appendCostCredits / 双 miss 收敛 /
//     drainDelegate / 删除级联 / readArchived 分页 / wechat CRUD / 逻辑版本单调
//   · §9 双连接 barrier 并发:N 并发 append(_seq 唯一严格递增)/ appendForRequest vs
//     appendCostCredits 双 miss 两序收敛 / upsert stale 竞态

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import type { ClientSession, MessageLike } from "@openclaude/storage";
import { LOSSLESS_TURN_TAPE_PART_BYTES, LOSSLESS_TURN_TAPE_VERSION } from "@openclaude/protocol";
import { createHash } from "node:crypto";
import {
  createPgSessionsBackend,
  startSessionsGcSweeper,
  type PgSessionsBackend,
} from "../db/pgSessionsBackend.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_p2_sessions_test";
const GENERATION = 1;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0066 = path.resolve(here, "../db/migrations/0066_wechat_pointer_outbox_audit.sql");
const MIGRATION_0078 = path.resolve(here, "../db/migrations/0078_wechat_outbox_backoff_hol.sql");
const MIGRATION_0134 = path.resolve(here, "../db/migrations/0134_sessions_master_pg.sql");
const MIGRATION_0147 = path.resolve(here, "../db/migrations/0147_lossless_turn_tapes.sql");
const MIGRATION_GOAL_STATE = path.resolve(here, "../db/migrations/0159_goal_state.sql");
const MIGRATION_0157 = path.resolve(here, "../db/migrations/0157_lossless_runtime_batches.sql");

let pool: Pool;
let backend: PgSessionsBackend;
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
  // 先用无 search_path 的连接建 schema。
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();

  // 业务 pool 走 search_path 隔离 —— 0134 的 unqualified CREATE TABLE 落进本 schema。
  pool = new Pool({ connectionString: TEST_DB_URL, max: 10, options: `-c search_path=${SCHEMA}` });
  await pool.query(await readFile(MIGRATION_0066, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_0078, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_0134, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_0147, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_GOAL_STATE, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_0157, { encoding: "utf8" }));
  // 0167 also alters billing/inbox tables that are intentionally absent from
  // this isolated sessions schema. Mirror its tape column and waiver table so
  // the backend contract still exercises the production SQL shape.
  await pool.query(`
    ALTER TABLE client_session_turn_tapes
      ADD COLUMN waive_reason TEXT
        CHECK (waive_reason IS NULL OR waive_reason IN (
          'idle_timeout', 'no_response', 'platform_authority_expired', 'turn_limit'
        ));
    CREATE TABLE turn_waivers (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      turn_key TEXT NOT NULL CHECK (turn_key ~ '^[0-9a-f]{64}$'),
      reason TEXT NOT NULL CHECK (reason IN (
        'idle_timeout', 'no_response', 'platform_authority_expired', 'turn_limit'
      )),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
      refunded_credits BIGINT NOT NULL DEFAULT 0,
      record_count INTEGER NOT NULL DEFAULT 0,
      inbox_message_id BIGINT,
      applied_at TIMESTAMPTZ,
      UNIQUE (user_id, turn_key),
      CHECK (
        (status = 'pending' AND applied_at IS NULL AND inbox_message_id IS NULL)
        OR
        (status = 'applied' AND applied_at IS NOT NULL AND inbox_message_id IS NOT NULL)
      )
    );
  `);
  // 状态机行(pg_authoritative 须带 source_digest/completed_at,见 0134 CHECK)。
  await pool.query(
    `INSERT INTO sessions_store_migration_state (singleton, authority, generation, cutover_id, source_digest, completed_at)
       VALUES (true, 'pg_authoritative', $1, 'test-cutover', 'test-digest', $2)`,
    [GENERATION, Date.now()],
  );
  backend = createPgSessionsBackend(pool, { expectedGeneration: GENERATION });
});

after(async () => {
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  await pool.end();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await pool.query(
    `TRUNCATE client_sessions, client_session_archive_chunks, client_session_archived_ids,
             server_authored_request_map, pending_usage_patches, turn_waivers,
             wechat_bindings CASCADE`,
  );
});

// ── helpers ──────────────────────────────────────────────────────────────────
function mkSession(over: Partial<ClientSession> = {}): ClientSession {
  const now = Date.now();
  return {
    id: over.id ?? "s-1",
    userId: over.userId ?? "u-1",
    agentId: over.agentId ?? "main",
    title: over.title ?? "新会话",
    pinned: over.pinned ?? false,
    createdAt: over.createdAt ?? now,
    lastAt: over.lastAt ?? now,
    messages: over.messages ?? [],
    updatedAt: over.updatedAt ?? now,
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildTape(payload: Record<string, unknown>) {
  const canonical = Buffer.from(JSON.stringify(payload), "utf8");
  const turnKey = payload.turnKey as string;
  const tapeSha256 = sha256(canonical);
  const tapeId = sha256(`test-tape\0${turnKey}`);
  const partCount = Math.ceil(canonical.length / LOSSLESS_TURN_TAPE_PART_BYTES);
  const base = {
    protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
    sessionId: payload.sessionId as string,
    agentId: payload.agentId as string,
    turnIndex: payload.turnIndex as number,
    status: payload.status as "completed" | "interrupted" | "crashed",
    turnKey,
    tapeId,
    tapeSha256,
    totalBytes: canonical.length,
    partCount,
    createdAt: payload.createdAt as number,
    ...(typeof payload.waiveReason === "string"
      ? {
          waiveReason: payload.waiveReason as
            | "idle_timeout"
            | "no_response"
            | "platform_authority_expired"
            | "turn_limit",
        }
      : {}),
  } as const;
  return {
    canonical,
    parts: Array.from({ length: partCount }, (_, partIndex) => {
      const bytes = canonical.subarray(
        partIndex * LOSSLESS_TURN_TAPE_PART_BYTES,
        Math.min(canonical.length, (partIndex + 1) * LOSSLESS_TURN_TAPE_PART_BYTES),
      );
      return {
        request: {
          ...base,
          action: "part" as const,
          partIndex,
          partSha256: sha256(bytes),
          data: bytes.toString("base64"),
        },
        bytes,
      };
    }),
    finalize: { ...base, action: "finalize" as const },
  };
}

const maybe = (name: string, fn: () => Promise<void> | void) =>
  test(name, async (t) => {
    if (!pgAvailable) {
      t.skip("PG 不可用");
      return;
    }
    await fn();
  });

describe("pgSessionsBackend contract", () => {
  maybe("probeSessionsDb 六表列/类型 + generation 一致 → ok", async () => {
    const r = await backend.probeSessionsDb();
    assert.deepEqual(r, { ok: true });
  });

  maybe("probeSessionsDb generation 漂移 → ok:false", async () => {
    const drifted = createPgSessionsBackend(pool, { expectedGeneration: 999 });
    const r = await drifted.probeSessionsDb();
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /generation 漂移/);
  });

  maybe("upsert 新建 → getClientSession 往返一致", async () => {
    const s = mkSession({ messages: [{ id: "m-1", role: "user", text: "hi" }], updatedAt: 1000 });
    assert.equal(await backend.upsertClientSession(s), "applied");
    const got = await backend.getClientSession("s-1", "u-1");
    assert.ok(got);
    assert.equal(got.title, "新会话");
    assert.equal((got.messages as MessageLike[]).length, 1);
    assert.equal((got.messages as MessageLike[])[0].id, "m-1");
  });

  maybe("classifyClientSessions 批量区分 active/deleted/missing 并保序", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-live", userId: "u-1" }));
    await backend.upsertClientSession(mkSession({ id: "s-deleted", userId: "u-1" }));
    await backend.deleteClientSession("s-deleted", "u-1");
    assert.deepEqual(await backend.classifyClientSessions([
      { sessionId: "s-live", userId: "u-1" },
      { sessionId: "s-deleted", userId: "u-1" },
      { sessionId: "s-missing", userId: "u-1" },
      { sessionId: "s-live", userId: "other-user" },
    ]), [
      { sessionId: "s-live", userId: "u-1", state: "active" },
      { sessionId: "s-deleted", userId: "u-1", state: "deleted" },
      { sessionId: "s-missing", userId: "u-1", state: "missing" },
      { sessionId: "s-live", userId: "other-user", state: "missing" },
    ]);
  });

  maybe("upsert stale(baseSyncedAt 落后)→ rejected_stale", async () => {
    await backend.upsertClientSession(mkSession({ updatedAt: 5000 }));
    // baseSyncedAt=1000 < 现有 updated_at(5000) → 拒。
    const r = await backend.upsertClientSession(mkSession({ title: "改", updatedAt: 6000 }), 1000);
    assert.equal(r, "rejected_stale");
    const got = await backend.getClientSession("s-1", "u-1");
    assert.equal(got?.title, "新会话");
  });

  maybe("appendServerAuthoredMessage 幂等 + session_not_found/deleted", async () => {
    assert.deepEqual(
      await backend.appendServerAuthoredMessage("nope", "u-1", { id: "x", role: "assistant", text: "a" }),
      { applied: false, reason: "session_not_found" },
    );
    await backend.upsertClientSession(mkSession());
    assert.deepEqual(await backend.appendServerAuthoredMessage("s-1", "u-1", { id: "a1", role: "assistant", text: "hi" }), {
      applied: true,
    });
    // 重放同 id → already_exists
    assert.deepEqual(await backend.appendServerAuthoredMessage("s-1", "u-1", { id: "a1", role: "assistant", text: "hi" }), {
      applied: false,
      reason: "already_exists",
    });
    // 软删后 → session_deleted
    await backend.deleteClientSession("s-1", "u-1");
    assert.deepEqual(await backend.appendServerAuthoredMessage("s-1", "u-1", { id: "a2", role: "assistant", text: "y" }), {
      applied: false,
      reason: "session_deleted",
    });
  });

  maybe("逻辑版本单调:rename 严格递增,stale PUT 不倒退", async () => {
    await backend.upsertClientSession(mkSession({ updatedAt: 1000 }));
    const r1 = await backend.renameClientSession("s-1", "u-1", "t1");
    const r2 = await backend.renameClientSession("s-1", "u-1", "t2");
    const r3 = await backend.renameClientSession("s-1", "u-1", "t3");
    assert.ok(r1.ok && r2.ok && r3.ok);
    assert.ok(r2.updatedAt > r1.updatedAt, `${r2.updatedAt} > ${r1.updatedAt}`);
    assert.ok(r3.updatedAt > r2.updatedAt, `${r3.updatedAt} > ${r2.updatedAt}`);
  });

  maybe("appendForRequest 先到 → map 记录 + 幂等 already_exists", async () => {
    await backend.upsertClientSession(mkSession());
    assert.deepEqual(await backend.appendServerAuthoredMessageForRequest("req-1", "s-1", "u-1", { id: "srv-1", role: "assistant", text: "hello" } as MessageLike & { id: string }), {
      applied: true,
    });
    const map = await pool.query("SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id=$1 AND user_id=$2", ["req-1", "u-1"]);
    assert.equal(map.rows[0].session_id, "s-1");
    assert.equal(map.rows[0].msg_id, "srv-1");
    // 重放 → already_exists（幂等）
    assert.deepEqual(await backend.appendServerAuthoredMessageForRequest("req-1", "s-1", "u-1", { id: "srv-1", role: "assistant", text: "hello" } as MessageLike & { id: string }), {
      applied: false,
      reason: "already_exists",
    });
  });

  maybe("appendForRequest 拒绝重映射(map 已存在但 msgId 不一致)→ fail-closed", async () => {
    await backend.upsertClientSession(mkSession());
    await backend.appendServerAuthoredMessageForRequest("req-r", "s-1", "u-1", { id: "srv-a", role: "assistant" } as MessageLike & { id: string });
    // 同 requestId 复用到不同 msgId → 抛错。MAJOR-1 后 SQLite 侧同样 fail-closed(双 backend 对齐,
    // 见 storage usageAggregation.test.ts「不可重映射」),此处为 PG 侧对齐断言。
    await assert.rejects(
      () => backend.appendServerAuthoredMessageForRequest("req-r", "s-1", "u-1", { id: "srv-b", role: "assistant" } as MessageLike & { id: string }),
      /拒绝重映射/,
    );
  });

  maybe("appendCostCredits hit → patch;miss → pending;idempotent → noop", async () => {
    await backend.upsertClientSession(mkSession());
    // 先写消息 + map
    await backend.appendServerAuthoredMessageForRequest("req-c", "s-1", "u-1", { id: "srv-c", role: "assistant", text: "x" } as MessageLike & { id: string });
    assert.deepEqual(await backend.appendCostCredits("req-c", "u-1", "700"), { applied: "patched" });
    // 幂等重放 → noop
    assert.deepEqual(await backend.appendCostCredits("req-c", "u-1", "700"), { applied: "noop" });
    const got = await backend.getClientSession("s-1", "u-1");
    const msg = (got!.messages as MessageLike[]).find((m) => m.id === "srv-c") as MessageLike & { usage?: Record<string, unknown> };
    assert.equal(msg.usage?.costCredits, "700");
    // map miss → park pending
    assert.deepEqual(await backend.appendCostCredits("req-none", "u-1", "42"), { applied: "pending" });
    const pend = await pool.query("SELECT cost_credits FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2", ["req-none", "u-1"]);
    assert.equal(pend.rows[0].cost_credits, "42");
  });

  maybe("双 miss 收敛 · 顺序A(cost 先 park,append 后 drain)", async () => {
    await backend.upsertClientSession(mkSession());
    assert.deepEqual(await backend.appendCostCredits("req-A", "u-1", "300"), { applied: "pending" });
    assert.deepEqual(await backend.appendServerAuthoredMessageForRequest("req-A", "s-1", "u-1", { id: "srv-A", role: "assistant" } as MessageLike & { id: string }), { applied: true });
    // 收敛:map 有、pending 空、成本已 patch 进消息
    const map = await pool.query("SELECT 1 FROM server_authored_request_map WHERE request_id=$1 AND user_id=$2", ["req-A", "u-1"]);
    assert.equal(map.rowCount, 1);
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id=$1", ["req-A"]);
    assert.equal(pend.rowCount, 0);
    const got = await backend.getClientSession("s-1", "u-1");
    const msg = (got!.messages as MessageLike[]).find((m) => m.id === "srv-A") as MessageLike & { usage?: Record<string, unknown> };
    assert.equal(msg.usage?.costCredits, "300");
  });

  maybe("双 miss 收敛 · 顺序B(append 先,cost 后 hit patch)", async () => {
    await backend.upsertClientSession(mkSession());
    assert.deepEqual(await backend.appendServerAuthoredMessageForRequest("req-B", "s-1", "u-1", { id: "srv-B", role: "assistant" } as MessageLike & { id: string }), { applied: true });
    assert.deepEqual(await backend.appendCostCredits("req-B", "u-1", "301"), { applied: "patched" });
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id=$1", ["req-B"]);
    assert.equal(pend.rowCount, 0);
    const got = await backend.getClientSession("s-1", "u-1");
    const msg = (got!.messages as MessageLike[]).find((m) => m.id === "srv-B") as MessageLike & { usage?: Record<string, unknown> };
    assert.equal(msg.usage?.costCredits, "301");
  });

  maybe("drainDelegateCostForClientSession 按父客户端会话归并 + delegates 明细", async () => {
    await backend.upsertClientSession(mkSession({ id: "leader", userId: "u-1" }));
    // 队长助手行落库
    await backend.appendServerAuthoredMessage("leader", "u-1", { id: "srv-leader", role: "assistant", text: "team" });
    // 两笔委派成本 park(parent_session_id=leader)
    await backend.appendCostCredits("d1", "u-1", "100", "agentSess1", "leader", "agentA");
    await backend.appendCostCredits("d2", "u-1", "250", "agentSess2", "leader", "agentB");
    const res = await backend.drainDelegateCostForClientSession("leader", "u-1", "srv-leader");
    assert.equal(res.merged, "350");
    assert.equal(res.drained, 2);
    assert.deepEqual(res.delegates, [
      { agentId: "agentA", costCredits: "100" },
      { agentId: "agentB", costCredits: "250" },
    ]);
    // pending 已排空
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE parent_session_id=$1", ["leader"]);
    assert.equal(pend.rowCount, 0);
    // 无委派成本时零副作用
    const res2 = await backend.drainDelegateCostForClientSession("leader", "u-1", "srv-leader");
    assert.deepEqual(res2, { merged: "0", drained: 0 });
  });

  maybe("删除级联:软删清归档 chunk/id + delegate pending", async () => {
    // 造归档:大 blob 触发 spill
    const big = "x".repeat(40 * 1024);
    const msgs: MessageLike[] = [];
    for (let i = 0; i < 80; i++) msgs.push({ id: `m-${i}`, role: "user", text: big });
    await backend.upsertClientSession(mkSession({ id: "s-del", messages: msgs, updatedAt: 1 }));
    const before = await backend.getClientSession("s-del", "u-1");
    assert.ok((before!.archivedCount ?? 0) > 0, "应触发 spill 产生归档");
    // 一笔指向该会话的 delegate pending
    await backend.appendCostCredits("dx", "u-1", "5", "as", "s-del", "aX");
    assert.equal(await backend.deleteClientSession("s-del", "u-1"), true);
    for (const t of ["client_session_archive_chunks", "client_session_archived_ids"]) {
      const r = await pool.query(`SELECT 1 FROM ${t} WHERE session_id=$1`, ["s-del"]);
      assert.equal(r.rowCount, 0, `${t} 应被级联清空`);
    }
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE parent_session_id=$1", ["s-del"]);
    assert.equal(pend.rowCount, 0, "delegate pending 应级联清");
  });

  maybe("readArchivedMessages 分页(升序 + hasMore + 游标)", async () => {
    const big = "y".repeat(40 * 1024);
    const msgs: MessageLike[] = [];
    for (let i = 0; i < 90; i++) msgs.push({ id: `a-${i}`, role: "user", text: big });
    await backend.upsertClientSession(mkSession({ id: "s-arch", messages: msgs, updatedAt: 1 }));
    const got = await backend.getClientSession("s-arch", "u-1");
    const archived = got!.archivedCount ?? 0;
    assert.ok(archived > 0);
    const page1 = await backend.readArchivedMessages("s-arch", "u-1", 0, 10);
    assert.ok(page1.messages.length <= 10);
    // 升序
    for (let i = 1; i < page1.messages.length; i++) {
      assert.ok((page1.messages[i]._seq as number) > (page1.messages[i - 1]._seq as number));
    }
    if (page1.hasMore) {
      assert.ok(page1.oldestSeq !== null);
      const page2 = await backend.readArchivedMessages("s-arch", "u-1", page1.oldestSeq!, 10);
      // 严格更早,不重叠
      if (page2.messages.length) {
        assert.ok((page2.messages[page2.messages.length - 1]._seq as number) < page1.oldestSeq!);
      }
    }
  });

  maybe("wechat CRUD + 账号唯一冲突 → WechatAccountAlreadyBoundError", async () => {
    await backend.upsertWechatBinding({ userId: "u-1", accountId: "acc-1", loginUserId: "L1", botToken: "tok1" });
    const b = await backend.getWechatBindingByUserId("u-1");
    assert.equal(b?.accountId, "acc-1");
    assert.equal(b?.status, "active");
    // 另一个 user 绑同一 account → 冲突
    await assert.rejects(
      () => backend.upsertWechatBinding({ userId: "u-2", accountId: "acc-1", loginUserId: "L2", botToken: "tok2" }),
      /wechat account already bound/,
    );
    // cursor / status 更新
    await backend.updateWechatBindingCursor("u-1", "buf-x", { k: "v" });
    await backend.updateWechatBindingStatus("u-1", "disabled");
    const b2 = await backend.getWechatBindingByUserId("u-1");
    assert.equal(b2?.getUpdatesBuf, "buf-x");
    assert.equal(b2?.status, "disabled");
    assert.equal((await backend.listActiveWechatBindings()).length, 0);
    assert.equal((await backend.listAllWechatBindings()).length, 1);
    await backend.deleteWechatBinding("u-1");
    assert.equal(await backend.getWechatBindingByUserId("u-1"), null);
  });

  maybe("sweepUsageAggregationGc:老化计数 + 过期硬删", async () => {
    await backend.upsertClientSession(mkSession());
    // 一条 2h 前 park 的 pending(created_at 手动写老)
    const twoHAgo = Date.now() - 2 * 60 * 60_000;
    await pool.query(
      "INSERT INTO pending_usage_patches (request_id, user_id, cost_credits, created_at) VALUES ($1,$2,$3,$4)",
      ["old", "u-1", "1", twoHAgo],
    );
    // 一条 8d 前的 map
    const eightDAgo = Date.now() - 8 * 24 * 60 * 60_000;
    await pool.query(
      "INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id, written_at) VALUES ($1,$2,$3,$4,$5)",
      ["oldmap", "u-1", "s-1", "m", eightDAgo],
    );
    const stats = await backend.sweepUsageAggregationGc();
    assert.equal(stats.pendingAging, 1); // 2h 在 [1h,24h) 老化窗
    assert.equal(stats.mapExpired, 1);
  });

  maybe("BLOCKER-1 首建服务端时钟下限:updatedAt=0 首建 → 第二个 baseSyncedAt=0 upsert rejected_stale", async () => {
    const before = Date.now();
    assert.equal(await backend.upsertClientSession(mkSession({ id: "s-b1", updatedAt: 0 })), "applied");
    const got = await backend.getClientSession("s-b1", "u-1");
    assert.ok(got!.updatedAt >= before, `首建 updated_at(${got!.updatedAt}) 应 ≥ 服务端 now(${before})`);
    // 第二个 baseSyncedAt=0 的 upsert:existing.updated_at(≈now) > 0 → rejected_stale。
    // 修前:首建存客户端 0,此处 0<=0 会被误 applied = 双写击穿(BLOCKER-1 正是修这个)。
    const r = await backend.upsertClientSession(mkSession({ id: "s-b1", title: "改", updatedAt: 0 }), 0);
    assert.equal(r, "rejected_stale");
  });

  maybe("MAJOR-2 软删会话 late-cost:map-hit 但会话已软删 → noop 不 park", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-late", userId: "u-1" }));
    await backend.appendServerAuthoredMessageForRequest("req-late", "s-late", "u-1", {
      id: "srv-late",
      role: "assistant",
    } as MessageLike & { id: string });
    // 软删会话(map 仍在,未过 7d GC)。
    assert.equal(await backend.deleteClientSession("s-late", "u-1"), true);
    // late-cost 到达:map-hit 但会话已软删 → noop(不 park,防永不 drain 的孤儿 pending)。
    assert.deepEqual(await backend.appendCostCredits("req-late", "u-1", "42"), { applied: "noop" });
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2", ["req-late", "u-1"]);
    assert.equal(pend.rowCount, 0, "软删会话 late-cost 不应 park pending");
  });
});

describe("pgSessionsBackend lossless turn tape", () => {
  maybe("waived terminal tape commits one immutable pending billing fence", async () => {
    const sessionId = "s-waived-terminal";
    const userId = "c:7";
    const turnKey = "8".repeat(64);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "crashed",
      waiveReason: "platform_authority_expired",
      turnKey,
      text: "",
      errorCode: "MODEL_AUTHORITY_EXPIRED",
      errorDetail: "safe platform message",
      createdAt: 1_783_944_000_000,
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    assert.deepEqual(await backend.finalizeLosslessTurnTape(userId, tape.finalize), {
      applied: "finalized",
      recordCount: 1,
      engineBillings: [],
    });
    assert.deepEqual(await backend.finalizeLosslessTurnTape(userId, tape.finalize), {
      applied: "idempotent",
      recordCount: 1,
      engineBillings: [],
    });
    const rows = await pool.query<{
      waive_reason: string;
      reason: string;
      status: string;
    }>(
      `SELECT t.waive_reason,w.reason,w.status
         FROM client_session_turn_tapes t
         JOIN turn_waivers w ON w.user_id=7 AND w.turn_key=t.turn_key
        WHERE t.session_id=$1 AND t.user_id=$2`,
      [sessionId, userId],
    );
    assert.deepEqual(rows.rows, [{
      waive_reason: "platform_authority_expired",
      reason: "platform_authority_expired",
      status: "pending",
    }]);

    for (const projection of [undefined, { projection: "chat" as const }]) {
      const hydrated = await backend.getClientSession(sessionId, userId, projection);
      const messages = hydrated?.messages as Array<{
        role?: unknown;
        _turnKey?: unknown;
        usage?: { waived?: unknown };
      }> | undefined;
      const assistant = messages?.find((message) => message.role === "assistant");
      assert.equal(
        assistant?._turnKey,
        turnKey,
        "billing anchor must retain its exact logical turn for live waiver projection",
      );
      assert.equal(
        assistant?.usage?.waived,
        undefined,
        "a pending decision must not claim that refund and receipt already completed",
      );
    }

    await pool.query(
      `UPDATE turn_waivers
          SET status='applied', applied_at=NOW(), inbox_message_id=901
        WHERE user_id=7 AND turn_key=$1`,
      [turnKey],
    );
    for (const projection of [undefined, { projection: "chat" as const }]) {
      const hydrated = await backend.getClientSession(sessionId, userId, projection);
      const assistant = (hydrated?.messages as Array<{
        role?: unknown;
        usage?: { waived?: unknown };
      }> | undefined)?.find((message) => message.role === "assistant");
      assert.equal(
        assistant?.usage?.waived,
        true,
        "an applied waiver with receipt must survive refresh and cross-device hydration",
      );
    }

    await assert.rejects(
      backend.finalizeLosslessTurnTape(userId, {
        ...tape.finalize,
        waiveReason: "idle_timeout",
      }),
      /finalize header conflict/,
    );
  });

  maybe("publishes goal usage only after finalize and late-cost commits", async () => {
    const sessionId = "s-goal-live-usage";
    const userId = "c:42";
    const goalId = "11111111-1111-4111-8111-111111111111";
    const turnKey = "9".repeat(64);
    const observations: Array<{ revision: string; tapeFinalized: boolean; components: number }> = [];
    const observedBackend = createPgSessionsBackend(pool, {
      expectedGeneration: GENERATION,
      onGoalUsageChanged: async (changedUserId, changedSessionId) => {
        assert.equal(changedUserId, userId);
        assert.equal(changedSessionId, sessionId);
        const row = (await pool.query<{
          revision: string;
          tape_finalized: boolean;
          components: number;
        }>(
          `SELECT g.snapshot_revision::text AS revision,
                  EXISTS (
                    SELECT 1 FROM client_session_turn_tapes t
                     WHERE t.session_id=g.session_id AND t.user_id=$2
                       AND t.goal_id=g.goal_id AND t.finalized_at IS NOT NULL
                  ) AS tape_finalized,
                  (SELECT COUNT(*)::int FROM turn_tape_cost_components c
                    WHERE c.session_id=g.session_id AND c.user_id=$2) AS components
             FROM session_goals g WHERE g.session_id=$1`,
          [sessionId, userId],
        )).rows[0]!;
        observations.push({
          revision: row.revision,
          tapeFinalized: row.tape_finalized,
          components: row.components,
        });
      },
    });

    await observedBackend.upsertClientSession(mkSession({ id: sessionId, userId }));
    await pool.query(
      `INSERT INTO session_goals
         (session_id,goal_id,objective,status,active_started_at)
       VALUES ($1,$2,'验证实时 usage 快照','active',clock_timestamp())`,
      [sessionId, goalId],
    );
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      text: "goal usage",
      createdAt: 1_783_944_000_000,
      goalId,
      goalStateRevision: 1,
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    for (const part of tape.parts) {
      await observedBackend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    assert.equal((await observedBackend.finalizeLosslessTurnTape(userId, tape.finalize)).applied, "finalized");
    assert.deepEqual(observations, [{ revision: "2", tapeFinalized: true, components: 0 }]);

    assert.deepEqual(
      await observedBackend.appendCostCredits(
        "goal-live-cost", userId, "4", "ccb-live", null, null, turnKey,
      ),
      { applied: "patched" },
    );
    assert.deepEqual(observations, [
      { revision: "2", tapeFinalized: true, components: 0 },
      { revision: "3", tapeFinalized: true, components: 1 },
    ]);
    assert.deepEqual(
      await observedBackend.appendCostCredits(
        "goal-live-cost", userId, "4", "ccb-live", null, null, turnKey,
      ),
      { applied: "noop" },
    );
    assert.deepEqual(observations, [
      { revision: "2", tapeFinalized: true, components: 0 },
      { revision: "3", tapeFinalized: true, components: 1 },
      // Recovery replay repairs the window where the component committed but
      // the process died before its post-commit live notification, without
      // manufacturing another database revision.
      { revision: "3", tapeFinalized: true, components: 1 },
    ]);
  });

  maybe("multipart finalize hydrates every full detail and exact turn billing", async () => {
    const sessionId = "s-lossless1";
    const userId = "u-lossless";
    const turnKey = "a".repeat(64);
    const thinking = "思考😀".repeat(70_000);
    const answer = "完整回答".repeat(60_000);
    const toolOutput = "stdout\n".repeat(70_000);
    const toolInput = { command: "echo exact".repeat(40_000) };
    const child = "child-detail".repeat(50_000);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));

    // Billing may arrive before the tape. The exact key parks well clear of any
    // GC window (24h keyless hard-delete / 7d unreachable expiry both杜绝误删
    // in-flight turns), then finalize must consume it atomically.
    assert.deepEqual(
      await backend.appendCostCredits("cost-before", userId, "7", "ccb-1", null, null, turnKey),
      { applied: "pending" },
    );
    assert.deepEqual(
      await backend.appendCostCredits("cost-before", userId, "07", "ccb-1", null, null, turnKey),
      { applied: "pending" },
    );
    await assert.rejects(
      backend.appendCostCredits("cost-before", userId, "8", "ccb-1", null, null, turnKey),
      /pending cost component refuses remapping/,
    );
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      text: answer,
      thinkingText: thinking,
      createdAt: 1_783_944_000_000,
      requestId: "top-request",
      agentSessionId: "ccb-1",
      usage: { inputTokens: 10, outputTokens: 20 },
      tools: [{
        toolUseId: "tool-1",
        blockId: "tool-1",
        toolName: "Bash",
        inputJson: toolInput,
        inputPreview: "preview",
        output: toolOutput,
        isError: false,
        durationMs: 1,
        ts: 2,
        arrivedAt: 2,
      }],
      agentGroups: [{
        runId: "dlg-1",
        agentId: "reviewer",
        goal: "review",
        status: "ok",
        resultSummary: child,
        transcript: [{ kind: "thinking", text: child }, { kind: "text", text: child }],
        completedAt: 3,
      }],
    });
    assert.ok(tape.parts.length > 3);
    for (const part of tape.parts) {
      assert.deepEqual(
        await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes),
        { applied: "stored" },
      );
    }
    assert.deepEqual(
      await backend.finalizeLosslessTurnTape(userId, tape.finalize),
      { applied: "finalized", recordCount: 4, engineBillings: [] },
    );

    let hydrated = await backend.getClientSession(sessionId, userId);
    assert.ok(hydrated);
    const messages = hydrated.messages as MessageLike[];
    assert.equal(messages.find((m) => m.role === "thinking")?.text, thinking);
    const tool = messages.find((m) => m.role === "tool")!;
    assert.deepEqual(tool.inputJson, toolInput);
    assert.equal(tool.output, toolOutput);
    const group = messages.find((m) => m.role === "agent-group")!;
    assert.equal(group._resultPreview, child);
    assert.deepEqual(group.childBlocks, [
      { kind: "thinking", text: child },
      { kind: "text", text: child },
    ]);
    const assistant = messages.find((m) => m.role === "assistant")!;
    assert.equal(assistant.text, answer);
    // 跨层契约(前端同步权威传播 P2 的作证前提):complete anchor 的水合行必须带
    // `_turnTapeComplete:true` —— 前端只认此标记的行作"整 turn 已原子落库"证据。
    for (const role of ["assistant", "thinking", "tool"] as const) {
      assert.equal(messages.find((m) => m.role === role)?._turnTapeComplete, true,
        `complete-anchor 水合的 ${role} 行必须携带 _turnTapeComplete:true`);
    }
    assert.equal((assistant.usage as Record<string, unknown>).costCredits, "7");

    // The hot session only stores small refs; canonical bytes remain intact
    // in content-addressed part rows.
    const hot = await pool.query<{ messages: string }>(
      "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );
    assert.ok(Buffer.byteLength(hot.rows[0]!.messages, "utf8") < 16 * 1024);
    assert.doesNotMatch(hot.rows[0]!.messages, /完整回答完整回答完整回答/);
    const hotAnchors = JSON.parse(hot.rows[0]!.messages) as MessageLike[];
    assert.equal(hotAnchors.length, 1, "one constant-size hot anchor represents the whole turn");
    assert.equal(hotAnchors[0]!._turnTapeComplete, true);
    assert.equal(hotAnchors[0]!._turnTapeRecordCount, 4);
    // 2026-07-16 起:原始分片(脱敏前 payload)随 finalize 一律清除——records 才是
    // 脱敏后的持久权威,上文水合断言已证明细节完整;parts 留存即隐私偏差+双份存储。
    const rawParts = await pool.query(
      `SELECT 1 FROM client_session_turn_tape_parts
        WHERE session_id=$1 AND user_id=$2`,
      [sessionId, userId],
    );
    assert.equal(rawParts.rowCount, 0, "finalize 后原始分片必须被清除");

    // A browser may immediately PUT the fully hydrated GET projection back.
    // Expanded rows are read-only projections and must not be copied into the
    // hot JSON tail; otherwise one refresh would defeat out-of-line storage.
    const hydratedProjectionSyncedAt = hydrated.updatedAt;
    assert.equal(
      await backend.upsertClientSession(
        mkSession({
          id: sessionId,
          userId,
          createdAt: hydrated.createdAt,
          lastAt: hydrated.lastAt,
          updatedAt: hydratedProjectionSyncedAt,
          messages: hydrated.messages,
        }),
        hydratedProjectionSyncedAt,
      ),
      "applied",
    );
    const hotAfterProjectionPut = await pool.query<{ messages: string }>(
      "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );
    assert.equal((JSON.parse(hotAfterProjectionPut.rows[0]!.messages) as MessageLike[]).length, 1);
    hydrated = await backend.getClientSession(sessionId, userId);
    assert.ok(hydrated);
    assert.equal((hydrated.messages as MessageLike[]).find((m) => m.role === "assistant")?.text, answer);

    // A later browser PUT contains only its streamed placeholders. The
    // tape-backed server refs must win by semantic role/blockId/runId and
    // remain hydratable; otherwise a routine sync would recreate the exact
    // "reply disappears after relogin" failure.
    const syncedAt = hydrated.updatedAt;
    assert.equal(
      await backend.upsertClientSession(
        mkSession({
          id: sessionId,
          userId,
          createdAt: hydrated.createdAt,
          lastAt: hydrated.lastAt,
          updatedAt: syncedAt,
          messages: [
            { id: "m-think", role: "thinking", text: "placeholder", ts: 1 },
            { id: "m-tool", role: "tool", text: "placeholder", toolName: "Bash", blockId: "tool-1", ts: 2 },
            {
              id: "m-group",
              role: "agent-group",
              text: "review",
              ts: 3,
              _delegateRunId: "dlg-1",
              childBlocks: [{ kind: "text", text: "placeholder" }],
            },
            { id: "m-answer", role: "assistant", text: "placeholder", ts: 4 },
          ],
        }),
        syncedAt,
      ),
      "applied",
    );
    hydrated = await backend.getClientSession(sessionId, userId);
    assert.ok(hydrated);
    assert.equal((hydrated.messages as MessageLike[]).filter((m) => m.role === "thinking").length, 1);
    assert.equal((hydrated.messages as MessageLike[]).find((m) => m.role === "thinking")?.text, thinking);
    assert.equal((hydrated.messages as MessageLike[]).filter((m) => m.role === "tool").length, 1);
    assert.equal((hydrated.messages as MessageLike[]).find((m) => m.role === "tool")?.output, toolOutput);
    assert.equal((hydrated.messages as MessageLike[]).filter((m) => m.role === "agent-group").length, 1);
    assert.equal((hydrated.messages as MessageLike[]).filter((m) => m.role === "assistant").length, 1);
    assert.equal((hydrated.messages as MessageLike[]).find((m) => m.role === "assistant")?.text, answer);
    const beforeLateCostSeq = Math.max(
      ...(hydrated.messages as MessageLike[]).map((m) => typeof m._seq === "number" ? m._seq : 0),
    );

    // Late normal + delegate components join this exact leader turn and sum;
    // idempotent retry cannot remap or change a component's amount.
    assert.deepEqual(
      await backend.appendCostCredits("cost-late", userId, "5", "ccb-1", null, null, turnKey),
      { applied: "patched" },
    );
    const costDelta = await backend.getClientSessionPartial(sessionId, userId, beforeLateCostSeq);
    assert.ok(costDelta?.isPartial);
    const deltaAssistant = (costDelta.messages as MessageLike[]).find((m) => m.role === "assistant");
    assert.ok(deltaAssistant, "late exact cost must bump the billing anchor sequence");
    assert.equal((deltaAssistant.usage as Record<string, unknown>).costCredits, "12");
    assert.deepEqual(
      await backend.appendCostCredits(
        "cost-delegate",
        userId,
        "3",
        "ccb-child",
        sessionId,
        "reviewer",
        "b".repeat(64),
        turnKey,
      ),
      { applied: "patched" },
    );
    assert.deepEqual(
      await backend.appendCostCredits(
        "cost-delegate",
        userId,
        "3",
        "ccb-child",
        sessionId,
        "reviewer",
        "b".repeat(64),
        turnKey,
      ),
      { applied: "noop" },
    );
    await assert.rejects(
      backend.appendCostCredits(
        "cost-delegate",
        userId,
        "4",
        "ccb-child",
        sessionId,
        "reviewer",
        "b".repeat(64),
        turnKey,
      ),
      /refuses remapping/,
    );
    hydrated = await backend.getClientSession(sessionId, userId);
    const billed = (hydrated!.messages as MessageLike[]).find((m) => m.role === "assistant")!;
    assert.equal((billed.usage as Record<string, unknown>).costCredits, "15");
    assert.deepEqual((billed.usage as Record<string, unknown>).delegates, [
      { agentId: "reviewer", costCredits: "3" },
    ]);
    const components = await pool.query(
      "SELECT 1 FROM turn_tape_cost_components WHERE user_id=$1",
      [userId],
    );
    assert.equal(components.rowCount, 3);
  });

  maybe("GC 对带 key pending:24h 硬删不碰;tape 迟到窗口(7d)内保留", async () => {
    // 2026-07-16 起语义从"永不删"改为**有界**:tape 经 fsync 重试队列分钟-小时级必达,
    // 7d 后仍无任何 finalized tape 可达的行是死重(生产曾滞留 300 行),由
    // pendingUnreachableExpired 分支清除(见 lossless 收尾闭合套件)。本用例守住
    // 窗口内不误删:2d 龄 + 无 tape → 24h 硬删(keyless 专属)与不可达清除都不得碰它。
    const userId = "u-retain";
    const turnKey = "c".repeat(64);
    await backend.appendCostCredits("retain-cost", userId, "9", null, null, null, turnKey);
    await pool.query(
      "UPDATE pending_usage_patches SET created_at=$1 WHERE request_id=$2 AND user_id=$3",
      [Date.now() - 2 * 24 * 60 * 60_000, "retain-cost", userId],
    );
    const stats = await backend.sweepUsageAggregationGc(Date.now());
    assert.equal(stats.pendingExpired, 0);
    assert.equal(stats.pendingUnreachableExpired, 0, "7d 窗口内的不可达行不得清除");
    const retained = await pool.query(
      "SELECT cost_credits FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
      ["retain-cost", userId],
    );
    assert.equal(retained.rowCount, 1);
  });

  maybe("ledger-atomic pending remains refresh-visible after tape finalize and reconciles without double count", async () => {
    const sessionId = "s-cost-atomic";
    const userId = "c:42";
    const turnKey = "d".repeat(64);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      text: "atomic cost answer",
      createdAt: 1_783_944_000_000,
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await backend.finalizeLosslessTurnTape(userId, tape.finalize);

    // Simulates settleUsageAndLedger committing the debit+pending row, then
    // the egress process crashing before appendCostCredits can run.
    await pool.query(
      `INSERT INTO pending_usage_patches
         (request_id,user_id,session_id,turn_key,cost_credits)
       VALUES ($1,$2,$3,$4,$5)`,
      ["atomic-cost", userId, "ccb-atomic", turnKey, "11"],
    );
    let hydrated = await backend.getClientSession(sessionId, userId);
    let assistant = (hydrated!.messages as MessageLike[]).find((m) => m.role === "assistant")!;
    assert.equal((assistant.usage as Record<string, unknown>).costCredits, "11");

    assert.deepEqual(
      await backend.appendCostCredits(
        "atomic-cost", userId, "11", "ccb-atomic", null, null, turnKey,
      ),
      { applied: "patched" },
    );
    assert.equal(
      (await pool.query(
        "SELECT 1 FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
        ["atomic-cost", userId],
      )).rowCount,
      0,
    );
    hydrated = await backend.getClientSession(sessionId, userId);
    assistant = (hydrated!.messages as MessageLike[]).find((m) => m.role === "assistant")!;
    assert.equal((assistant.usage as Record<string, unknown>).costCredits, "11");
  });

  maybe("rolling v1 ACK-loss replay upgrades hot legacy rows to one v2 tape without duplicates", async () => {
    const sessionId = "s-rolling-v1-v2";
    const userId = "u-rolling";
    const turnKey = "e".repeat(64);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const prefix = `srv-${sessionId}-main-t1`;
    await backend.appendServerAuthoredMessage(sessionId, userId, {
      id: `${prefix}-thinking`, role: "thinking", text: "legacy thought", ts: 1,
    });
    await backend.appendServerAuthoredMessage(sessionId, userId, {
      id: `${prefix}-tool-tool-1`, role: "tool", text: "legacy tool", blockId: "tool-1", ts: 2,
    });
    await backend.appendServerAuthoredMessage(sessionId, userId, {
      id: prefix, role: "assistant", text: "legacy answer", ts: 3,
    });
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      text: "exact v2 answer",
      thinkingText: "exact v2 thought",
      createdAt: 3,
      tools: [{
        toolUseId: "tool-1",
        blockId: "tool-1",
        toolName: "Bash",
        inputJson: { command: "printf exact" },
        inputPreview: "printf exact",
        output: "exact v2 tool",
        isError: false,
        durationMs: 1,
        ts: 2,
        arrivedAt: 2,
      }],
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    assert.deepEqual(
      await backend.finalizeLosslessTurnTape(userId, tape.finalize),
      { applied: "finalized", recordCount: 3, engineBillings: [] },
    );
    const hot = await pool.query<{ messages: string }>(
      "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );
    assert.equal((JSON.parse(hot.rows[0]!.messages) as MessageLike[]).length, 1);
    const hydrated = await backend.getClientSession(sessionId, userId);
    const messages = hydrated!.messages as MessageLike[];
    assert.equal(messages.filter((m) => m.role === "thinking").length, 1);
    assert.equal(messages.filter((m) => m.role === "tool").length, 1);
    assert.equal(messages.filter((m) => m.role === "assistant").length, 1);
    assert.equal(messages.find((m) => m.role === "thinking")?.text, "exact v2 thought");
    assert.equal(messages.find((m) => m.role === "tool")?.output, "exact v2 tool");
    assert.equal(messages.find((m) => m.role === "assistant")?.text, "exact v2 answer");
  });

  maybe("post-terminal Bash tail continuation survives relogin and updates the owning tool exactly", async () => {
    const sessionId = "s-lossless-bash-tail";
    const userId = "u-lossless-bash-tail";
    const originalTurnKey = "f".repeat(64);
    const continuationTurnKey = "9".repeat(64);
    const rawTail = {
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "tool-bg",
      tail: "后台命令迟到的完整 stdout\u0000\n第二行😀\\u0000\ud800",
      total_bytes: 45,
      truncated_head: false,
      future_exact_field: { nested: ["逐字", "保留"] },
    };
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));

    const original = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey: originalTurnKey,
      text: "先返回主回复",
      createdAt: 1_783_944_000_000,
      tools: [{
        toolUseId: "tool-bg",
        blockId: "tool-bg",
        toolName: "Bash",
        inputJson: { command: "long-running-command" },
        inputPreview: "long-running-command",
        output: "命令仍在后台运行",
        isError: false,
        durationMs: 1,
        ts: 1_783_944_000_001,
        arrivedAt: 1_783_944_000_001,
      }],
      runtimeEvents: [{
        ordinal: 1,
        observedAt: 1_783_944_000_002,
        source: "ccb",
        payload: { type: "stream_event", hidden_blob: "x".repeat(64 * 1024) },
      }],
    });
    for (const part of original.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    assert.deepEqual(
      await backend.finalizeLosslessTurnTape(userId, original.finalize),
      { applied: "finalized", recordCount: 3, engineBillings: [] },
    );

    const continuation = buildTape({
      sessionId,
      agentId: "tail_deadbeef",
      turnIndex: 2,
      status: "completed",
      turnKey: continuationTurnKey,
      continuationOfTurnKey: originalTurnKey,
      text: "",
      createdAt: 1_783_944_000_100,
      runtimeEvents: [
        {
          ordinal: 99,
          observedAt: 1_783_944_000_100,
          source: "ccb",
          payload: rawTail,
        },
        {
          ordinal: 100,
          observedAt: 1_783_944_000_101,
          source: "codex-jsonrpc",
          payload: {
            method: "item/completed",
            params: {
              type: "system",
              subtype: "bash_output_tail",
              tool_use_id: "tool-bg",
              tail: "nested marker must not win",
              total_bytes: 999_999,
            },
            unicodeNoise: "nul=\u0000 surrogate=\ud800 literal=\\u0000",
          },
        },
      ],
    });
    for (const part of continuation.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    assert.deepEqual(
      await backend.finalizeLosslessTurnTape(userId, continuation.finalize),
      { applied: "finalized", recordCount: 2, engineBillings: [] },
    );

    const hydrated = await backend.getClientSession(sessionId, userId);
    assert.ok(hydrated);
    const messages = hydrated.messages as MessageLike[];
    const tool = messages.find((message) => message.role === "tool" && message.blockId === "tool-bg");
    assert.ok(tool);
    assert.deepEqual(tool.bashTail, {
      tail: rawTail.tail,
      totalBytes: rawTail.total_bytes,
      truncatedHead: false,
    });
    const runtime = messages.find((message) =>
      message.role === "runtime-event" &&
      (message._runtimeEvent as { subtype?: string } | undefined)?.subtype === "bash_output_tail");
    assert.ok(runtime, "continuation raw event remains reload-visible, not only reduced into bashTail");
    assert.deepEqual(runtime._runtimeEvent, rawTail);
    assert.equal(runtime._continuationOfTurnKey, originalTurnKey);
    assert.equal(messages.filter((message) => message.role === "assistant").length, 1,
      "runtime continuation must not invent or duplicate a visible assistant reply");

    const chat = await backend.getClientSession(sessionId, userId, { projection: "chat" });
    assert.ok(chat);
    const chatMessages = chat.messages as MessageLike[];
    assert.equal(chatMessages.some((message) => message._runtimeEvent !== undefined), false,
      "browser projection must not expose exact raw runtime payloads");
    assert.equal(chatMessages.filter((message) => message.role === "assistant").length, 1);
    assert.equal(chatMessages.filter((message) => message.role === "tool").length, 1);
    const patch = chatMessages.find(
      (message) => (message._historyProjection as { kind?: string } | undefined)?.kind === "bash-tail",
    );
    assert.ok(patch);
    assert.deepEqual(patch._historyProjection, {
      kind: "bash-tail",
      toolUseId: "tool-bg",
      tail: rawTail.tail,
      totalBytes: rawTail.total_bytes,
      truncatedHead: false,
    });

    const originalSeq = Math.min(...chatMessages.flatMap((message) =>
      typeof message._seq === "number" ? [message._seq] : []));
    const incremental = await backend.getClientSessionPartial(
      sessionId,
      userId,
      originalSeq,
      { projection: "chat" },
    );
    assert.ok(incremental?.isPartial);
    assert.equal((incremental.messages as MessageLike[]).some((message) => message.role === "tool"), false,
      "tail-only incremental does not refetch the owning tape");
    assert.equal((incremental.messages as MessageLike[]).some(
      (message) => (message._historyProjection as { kind?: string } | undefined)?.kind === "bash-tail",
    ), true);
  });

  maybe("runtime-event batches reduce physical rows but exact hydration restores every logical payload", async () => {
    const previousBatching = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING;
    process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = "1";
    try {
      const sessionId = "s-lossless-runtime-batch";
      const userId = "u-lossless-runtime-batch";
      await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
      const runtimeEvents = Array.from({ length: 8 }, (_, ordinal) => ({
        ordinal,
        observedAt: 1_783_944_100_000 + ordinal,
        source: "gateway",
        payload: { type: "raw-progress", ordinal, exact: `value-${ordinal}` },
      }));
      const tape = buildTape({
        sessionId,
        agentId: "main",
        turnIndex: 1,
        status: "completed",
        turnKey: "8".repeat(64),
        text: "visible answer",
        createdAt: 1_783_944_100_000,
        runtimeEvents,
      });
      for (const part of tape.parts) {
        await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
      }
      assert.deepEqual(
        await backend.finalizeLosslessTurnTape(userId, tape.finalize),
        { applied: "finalized", recordCount: 2, engineBillings: [] },
        "one physical runtime batch plus one assistant row",
      );
      const physical = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [sessionId, userId, tape.finalize.tapeId],
      );
      assert.equal(Number(physical.rows[0]!.count), 2);

      const exact = await backend.getClientSession(sessionId, userId);
      assert.ok(exact);
      const exactMessages = exact.messages as MessageLike[];
      const runtime = exactMessages.filter((message) => message.role === "runtime-event");
      assert.equal(runtime.length, 8);
      assert.deepEqual(
        runtime.map((message) => message._runtimeEvent),
        runtimeEvents.map((event) => event.payload),
      );
      assert.ok(runtime.every((message) => message._turnTapePhysicalMsgId !== undefined));
      assert.equal(exactMessages.find((message) => message.role === "assistant")?.text, "visible answer");

      const chat = await backend.getClientSession(sessionId, userId, { projection: "chat" });
      assert.ok(chat);
      const chatMessages = chat.messages as MessageLike[];
      assert.equal(chatMessages.some((message) => message.role === "runtime-event"), false);
      assert.equal(chatMessages.find((message) => message.role === "assistant")?.text, "visible answer");
      const storage = await pool.query<{ record_storage_format: number }>(
        `SELECT record_storage_format FROM client_session_turn_tapes
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [sessionId, userId, tape.finalize.tapeId],
      );
      assert.equal(storage.rows[0]!.record_storage_format, 3);
    } finally {
      if (previousBatching === undefined) Reflect.deleteProperty(process.env, "LOSSLESS_TURN_TAPE_RUNTIME_BATCHING");
      else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previousBatching;
    }
  });
});

describe("pgSessionsBackend §9 并发(双连接 barrier)", () => {
  maybe("N 并发 append:零丢消息、_seq 唯一严格递增", async () => {
    await backend.upsertClientSession(mkSession());
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        backend.appendServerAuthoredMessage("s-1", "u-1", { id: `c-${i}`, role: "assistant", text: `m${i}` }),
      ),
    );
    assert.ok(results.every((r) => r.applied), "全部 append 应成功");
    const got = await backend.getClientSession("s-1", "u-1");
    const seqs = (got!.messages as MessageLike[]).map((m) => m._seq as number).sort((a, b) => a - b);
    // 唯一
    assert.equal(new Set(seqs).size, seqs.length, "_seq 必须唯一");
    // 严格递增
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
    // 零丢:N 条 server 消息都在
    const ids = new Set((got!.messages as MessageLike[]).map((m) => m.id));
    for (let i = 0; i < N; i++) assert.ok(ids.has(`c-${i}`), `缺 c-${i}`);
  });

  maybe("appendForRequest vs appendCostCredits 并发双 miss → advisory 下恒收敛", async () => {
    await backend.upsertClientSession(mkSession());
    // 同 (requestId,userId) 并发:advisory_xact_lock 串行化 → 无论哪序,终态收敛
    await Promise.all([
      backend.appendServerAuthoredMessageForRequest("req-Z", "s-1", "u-1", { id: "srv-Z", role: "assistant" } as MessageLike & { id: string }),
      backend.appendCostCredits("req-Z", "u-1", "999"),
    ]);
    // 不变量:map 恰一行、pending 空(绝不并存)、成本落到消息
    const map = await pool.query("SELECT 1 FROM server_authored_request_map WHERE request_id=$1 AND user_id=$2", ["req-Z", "u-1"]);
    assert.equal(map.rowCount, 1);
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id=$1", ["req-Z"]);
    assert.equal(pend.rowCount, 0);
    const got = await backend.getClientSession("s-1", "u-1");
    const msg = (got!.messages as MessageLike[]).find((m) => m.id === "srv-Z") as MessageLike & { usage?: Record<string, unknown> };
    assert.equal(msg.usage?.costCredits, "999");
  });

  maybe("并发 upsert stale 竞态:恰一个 applied,另一个 rejected_stale", async () => {
    await backend.upsertClientSession(mkSession({ updatedAt: 1000 }));
    // BLOCKER-1:首建 updated_at 现取 MAX(客户端, 服务端 now) → 读回真实存库版本作 baseSyncedAt
    // (两并发都以它进入)。FOR UPDATE 串行:先者 applied 并 bump 版本,后者在锁下见版本已推进
    // → rejected_stale。
    const base = (await backend.getClientSession("s-1", "u-1"))!.updatedAt;
    const [a, b] = await Promise.all([
      backend.upsertClientSession(mkSession({ title: "A", updatedAt: base + 1 }), base),
      backend.upsertClientSession(mkSession({ title: "B", updatedAt: base + 1 }), base),
    ]);
    const outcomes = [a, b].sort();
    assert.deepEqual(outcomes, ["applied", "rejected_stale"]);
  });

  maybe("BLOCKER-1 双连接首建竞态 barrier:updatedAt=0 并发首建 → 恰一 applied 一 rejected_stale", async () => {
    // 全新 id、无既有行、两并发首建、baseSyncedAt 默认 0、updatedAt=0。修前两者都 store 0 →
    // 后者 ON CONFLICT WHERE 0<=0 命中 → 双 applied(双写击穿)。修后:先者 store MAX(0,now)=now,
    // 后者在 FOR UPDATE/ON CONFLICT 串行下见 now>0(>baseSyncedAt 0)→ 哨兵 ROLLBACK → rejected_stale。
    const [a, b] = await Promise.all([
      backend.upsertClientSession(mkSession({ id: "s-race1", title: "A", updatedAt: 0 })),
      backend.upsertClientSession(mkSession({ id: "s-race1", title: "B", updatedAt: 0 })),
    ]);
    assert.deepEqual([a, b].sort(), ["applied", "rejected_stale"]);
    // 恰一行落库,updated_at 是服务端时钟(≠0)。
    const got = await backend.getClientSession("s-race1", "u-1");
    assert.ok(got && got.updatedAt > 0, "落库版本应是服务端时钟(>0)");
  });

  maybe("MAJOR-1 appendForRequest × sweepGc 交错:锁序统一(session→map→pending)无死锁,状态收敛", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-lock", userId: "u-1" }));
    // 预置若干"老" pending/map(8d 前)触发 sweepGc 实际删除,制造与 appendForRequest 的 map/pending
    // 锁争用面(修前 appendForRequest 锁序 pending→map 与 sweepGc 的 map→pending 反序 → 死锁环)。
    const oldTs = Date.now() - 8 * 24 * 60 * 60_000;
    for (let i = 0; i < 20; i++) {
      await pool.query(
        "INSERT INTO server_authored_request_map (request_id, user_id, session_id, msg_id, written_at) VALUES ($1,$2,$3,$4,$5)",
        [`gcmap-${i}`, "u-1", "s-lock", `gm-${i}`, oldTs],
      );
      await pool.query(
        "INSERT INTO pending_usage_patches (request_id, user_id, cost_credits, created_at) VALUES ($1,$2,$3,$4)",
        [`gcpend-${i}`, "u-1", "1", oldTs],
      );
    }
    // 并发:多路 appendForRequest + appendCostCredits(锁 map→pending)与 sweepGc(删 map→pending)交错。
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      ops.push(
        backend.appendServerAuthoredMessageForRequest(`fr-${i}`, "s-lock", "u-1", {
          id: `srv-fr-${i}`,
          role: "assistant",
        } as MessageLike & { id: string }),
      );
      ops.push(backend.appendCostCredits(`fr-${i}`, "u-1", "5"));
      ops.push(backend.sweepUsageAggregationGc());
    }
    const settled = await Promise.allSettled(ops);
    const deadlocks = settled.filter((s) => {
      if (s.status !== "rejected") return false;
      const r = (s as PromiseRejectedResult).reason as { code?: string; message?: string } | undefined;
      return r?.code === "40P01" || /deadlock/i.test(String(r?.message ?? r ?? ""));
    });
    assert.equal(deadlocks.length, 0, "锁序统一后不应出现死锁(40P01)");
    // 收敛:每个 fr-i 的 map 恰一行、pending 无残留(append drain 或 cost hit 后必无 pending)。
    for (let i = 0; i < 12; i++) {
      const map = await pool.query("SELECT 1 FROM server_authored_request_map WHERE request_id=$1 AND user_id=$2", [`fr-${i}`, "u-1"]);
      assert.equal(map.rowCount, 1, `fr-${i} map 应恰一行`);
      const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id=$1", [`fr-${i}`]);
      assert.equal(pend.rowCount, 0, `fr-${i} pending 不应残留`);
    }
  });

  maybe("MAJOR-2 delete × costCredits barrier:并发不产生孤儿 pending", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-dc", userId: "u-1" }));
    await backend.appendServerAuthoredMessageForRequest("req-dc", "s-dc", "u-1", {
      id: "srv-dc",
      role: "assistant",
    } as MessageLike & { id: string });
    // 并发软删 + late-cost:两者在 client_sessions 行锁上串行。cost 先 → patch(applied);
    // delete 先 → cost 见软删 → noop。两序都不 park。
    const [, costRes] = await Promise.all([
      backend.deleteClientSession("s-dc", "u-1"),
      backend.appendCostCredits("req-dc", "u-1", "77"),
    ]);
    assert.ok(
      costRes.applied === "patched" || costRes.applied === "noop",
      `cost 结果应为 patched/noop,实为 ${costRes.applied}`,
    );
    const pend = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id=$1", ["req-dc"]);
    assert.equal(pend.rowCount, 0, "并发 delete × cost 不应产生孤儿 pending");
  });
});

describe("startSessionsGcSweeper advisory lease", () => {
  maybe("持锁者独占执行,备者竞不到锁", async () => {
    let statsCount = 0;
    const s1 = startSessionsGcSweeper({ pool, intervalMs: 50, recompeteMs: 50, onStats: () => statsCount++ });
    // 给 s1 时间竞到锁并跑一轮
    await new Promise((r) => setTimeout(r, 200));
    // 备者:同一固定 key 竞不到 → 不成为持有者(直接探测)
    const probe = await pool.query("SELECT pg_try_advisory_lock(hashtextextended('oc_sessions_sweep_gc',0)) AS ok");
    assert.equal(probe.rows[0].ok, false, "s1 持锁期间他人不应竞到");
    await s1.stop();
    // stop 后锁释放 → 现在能竞到
    const probe2 = await pool.query("SELECT pg_try_advisory_lock(hashtextextended('oc_sessions_sweep_gc',0)) AS ok");
    assert.equal(probe2.rows[0].ok, true, "stop 后锁应释放");
    await pool.query("SELECT pg_advisory_unlock(hashtextextended('oc_sessions_sweep_gc',0))");
    assert.ok(statsCount >= 1, "持锁者应至少跑过一轮 sweep");
  });
});

// ── 2026-07-16 巡检批:lossless 收尾 GC 语义闭合 ────────────────────────────────
// 生产事实:345 行带 key 的 pending 全部对应已结算请求(45 行可折叠 / 300 行读路径
// 永不可达);215/233 盘 finalized tape 的原始分片(72MB)从未回收。本组断言三条新
// 语义:晚到折叠(收敛单一权威)、不可达超期清除、finalize 后 parts 兜底清扫。
describe("sweepUsageAggregationGc lossless 收尾闭合", () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  /** 造一盘最小 finalized tape,返回其坐标(不走 stage/finalize 全流程,直插表)。 */
  async function seedFinalizedTape(args: {
    sessionId: string;
    userId: string;
    turnKey: string;
    finalizedAt?: number;
  }): Promise<{ tapeId: string; billingAnchorId: string }> {
    const tapeId = sha256(`gc-tape\0${args.turnKey}`);
    const billingAnchorId = `anchor-${args.turnKey.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO client_session_turn_tapes
         (session_id, user_id, tape_id, agent_id, turn_index, status, turn_key,
          tape_sha256, total_bytes, part_count, created_at, billing_anchor_id, finalized_at)
       VALUES ($1,$2,$3,'main',1,'completed',$4,$5,1,1,$6,$7,$8)`,
      [
        args.sessionId,
        args.userId,
        tapeId,
        args.turnKey,
        sha256(tapeId),
        Date.now() - 3 * HOUR,
        billingAnchorId,
        args.finalizedAt ?? Date.now() - 3 * HOUR,
      ],
    );
    return { tapeId, billingAnchorId };
  }

  async function seedKeyedPending(args: {
    requestId: string;
    userId: string;
    turnKey?: string | null;
    parentTurnKey?: string | null;
    cost: string;
    ageMs: number;
    delegateAgentId?: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO pending_usage_patches
         (request_id, user_id, session_id, delegate_agent_id, turn_key, parent_turn_key, cost_credits, created_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7)`,
      [
        args.requestId,
        args.userId,
        args.delegateAgentId ?? null,
        args.turnKey ?? null,
        args.parentTurnKey ?? null,
        args.cost,
        Date.now() - args.ageMs,
      ],
    );
  }

  maybe("晚到折叠:aged 带 key 行折进 cost components 后删,坐标取 finalized tape anchor", async () => {
    const userId = "u-gc-fold";
    const sessionId = "s-gc-fold";
    const turnKey = "b".repeat(64);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = await seedFinalizedTape({ sessionId, userId, turnKey });
    // 晚到成本(2h 前 stage;错过 finalize 内折叠时机)——一条 turn_key 直挂,一条
    // parent_turn_key 挂(delegate 归因形态)。
    await seedKeyedPending({ requestId: "gc-fold-1", userId, turnKey, cost: "42", ageMs: 2 * HOUR });
    await seedKeyedPending({
      requestId: "gc-fold-2", userId, parentTurnKey: turnKey, cost: "8",
      ageMs: 2 * HOUR, delegateAgentId: "reviewer",
    });

    const stats = await backend.sweepUsageAggregationGc();
    assert.equal(stats.pendingFolded, 2, "两条晚到成本都应折叠");
    assert.equal(stats.pendingFoldAnomaly, 0);

    const comps = await pool.query<{ request_id: string; cost_credits: string; tape_id: string; billing_anchor_id: string; delegate_agent_id: string | null }>(
      `SELECT request_id, cost_credits::text, tape_id, billing_anchor_id, delegate_agent_id
         FROM turn_tape_cost_components WHERE user_id=$1 ORDER BY request_id`,
      [userId],
    );
    assert.equal(comps.rowCount, 2);
    assert.equal(comps.rows[0]!.tape_id, tape.tapeId);
    assert.equal(comps.rows[0]!.billing_anchor_id, tape.billingAnchorId);
    assert.equal(comps.rows[0]!.cost_credits, "42");
    assert.equal(comps.rows[1]!.cost_credits, "8");
    assert.equal(comps.rows[1]!.delegate_agent_id, "reviewer");
    const left = await pool.query("SELECT 1 FROM pending_usage_patches WHERE user_id=$1", [userId]);
    assert.equal(left.rowCount, 0, "折叠完成后 pending 应清空");
  });

  maybe("折叠原子换源:sweep 后水合积分徽章不变(单一权威收敛,无双计)", async () => {
    const userId = "u-gc-hydrate";
    const sessionId = "s-gc-hydrate";
    const turnKey = "c".repeat(64);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    // 真实全流程:先 park 晚到成本用的 key,再 stage+finalize 一盘真 tape。
    const tape = buildTape({
      sessionId, agentId: "main", turnIndex: 1, status: "completed", turnKey,
      text: "答案", createdAt: Date.now() - 2 * HOUR, requestId: "gc-hyd-top",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await backend.finalizeLosslessTurnTape(userId, tape.finalize);
    // finalize 后才落的成本 locator(生产形态:settle 路径 stageUsageCostLocator 在
    // tape finalize 之后写入,错过 finalize 内折叠;appendCostCredits 主路径此时会直折,
    // 不经 pending)。直插 pending 复现该形态,读路径此刻靠 UNION 兜底显示。
    await seedKeyedPending({ requestId: "gc-hyd-late", userId, turnKey, cost: "13", ageMs: 2 * HOUR });
    const costOf = async (): Promise<string> => {
      const s = await backend.getClientSession(sessionId, userId);
      const anchor = (s!.messages as MessageLike[]).find((m) => m.role === "assistant")!;
      return String((anchor.usage as Record<string, unknown>).costCredits);
    };
    assert.equal(await costOf(), "13", "折叠前:pending UNION 兜底显示");
    const stats = await backend.sweepUsageAggregationGc();
    assert.equal(stats.pendingFolded, 1);
    assert.equal(await costOf(), "13", "折叠后:component 显示,徽章金额不变");
  });

  maybe("折叠异常:同 (request_id,user_id) 已有坐标不符的 component → 保留并计数", async () => {
    const userId = "u-gc-anomaly";
    const sessionId = "s-gc-anomaly";
    const turnKey = "d".repeat(64);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = await seedFinalizedTape({ sessionId, userId, turnKey });
    // 同 request 已有指向"另一盘 tape"的 component(坐标不符)。
    const otherKey = "e".repeat(64);
    const other = await seedFinalizedTape({ sessionId, userId, turnKey: otherKey });
    await pool.query(
      `INSERT INTO turn_tape_cost_components
         (request_id, user_id, session_id, tape_id, billing_anchor_id, cost_credits, delegate_agent_id, updated_at)
       VALUES ('gc-anomaly-1',$1,$2,$3,$4,99,NULL,$5)`,
      [userId, sessionId, other.tapeId, other.billingAnchorId, Date.now()],
    );
    await seedKeyedPending({ requestId: "gc-anomaly-1", userId, turnKey, cost: "42", ageMs: 2 * HOUR });

    const stats = await backend.sweepUsageAggregationGc();
    assert.equal(stats.pendingFoldAnomaly, 1, "坐标不符必须计入异常");
    const pending = await pool.query("SELECT 1 FROM pending_usage_patches WHERE request_id='gc-anomaly-1'");
    assert.equal(pending.rowCount, 1, "异常行必须保留待人工核对");
    const comp = await pool.query<{ cost_credits: string }>(
      "SELECT cost_credits::text FROM turn_tape_cost_components WHERE request_id='gc-anomaly-1' AND user_id=$1",
      [userId],
    );
    assert.equal(comp.rows[0]!.cost_credits, "99", "既有 component 不可被覆盖");
    void tape;
  });

  maybe("不可达清除:无任何 finalized tape 匹配的带 key 行,7d 后删、7d 内留", async () => {
    const userId = "u-gc-orphan";
    await seedKeyedPending({ requestId: "gc-orphan-old", userId, turnKey: "f".repeat(64), cost: "1", ageMs: 8 * DAY });
    await seedKeyedPending({ requestId: "gc-orphan-new", userId, turnKey: "0".repeat(64), cost: "2", ageMs: 2 * DAY });
    const stats = await backend.sweepUsageAggregationGc();
    assert.equal(stats.pendingUnreachableExpired, 1, "只清 7d 以上的不可达行");
    const rows = await pool.query<{ request_id: string }>(
      "SELECT request_id FROM pending_usage_patches WHERE user_id=$1",
      [userId],
    );
    assert.deepEqual(rows.rows.map((r) => r.request_id), ["gc-orphan-new"]);
  });

  maybe("parts 兜底清扫:finalized tape 的 48h+ 分片删,新分片与未 finalize 的留", async () => {
    const userId = "u-gc-parts";
    const sessionId = "s-gc-parts";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const done = await seedFinalizedTape({ sessionId, userId, turnKey: "1".repeat(64) });
    // 未 finalize 的 tape(上传中断形态)。
    const stagingTapeId = sha256("gc-tape-staging");
    await pool.query(
      `INSERT INTO client_session_turn_tapes
         (session_id, user_id, tape_id, agent_id, turn_index, status, turn_key,
          tape_sha256, total_bytes, part_count, created_at)
       VALUES ($1,$2,$3,'main',2,'completed',$4,$5,1,1,$6)`,
      [sessionId, userId, stagingTapeId, "2".repeat(64), sha256(stagingTapeId), Date.now() - 3 * DAY],
    );
    const seedPart = (tapeId: string, idx: number, ageMs: number) =>
      pool.query(
        `INSERT INTO client_session_turn_tape_parts
           (session_id, user_id, tape_id, part_index, part_sha256, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sessionId, userId, tapeId, idx, sha256(`p${idx}`), Buffer.from("x"), Date.now() - ageMs],
      );
    await seedPart(done.tapeId, 0, 3 * DAY); // finalized + 老 → 删
    await seedPart(done.tapeId, 1, 1 * HOUR); // finalized + 新(理论重放窗口)→ 留
    await seedPart(stagingTapeId, 0, 3 * DAY); // 未 finalize → 留(等 finalize 消费)
    const stats = await backend.sweepUsageAggregationGc();
    assert.equal(stats.tapePartsPurged, 1);
    const left = await pool.query<{ tape_id: string; part_index: number }>(
      "SELECT tape_id, part_index FROM client_session_turn_tape_parts WHERE user_id=$1 ORDER BY tape_id, part_index",
      [userId],
    );
    assert.equal(left.rowCount, 2);
    assert.ok(
      left.rows.every((r) => (r.tape_id === done.tapeId ? r.part_index === 1 : r.part_index === 0)),
      "只删 finalized+超期分片",
    );
  });
});
