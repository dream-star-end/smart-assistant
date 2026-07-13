// pgSessionsBackend 集成 + 并发契约测试(RFC-v5-sessions-pg §9)。
//
// 需 PG fixture(openclaude_test，与其它 integ 同库)。为不污染共享 public schema，本套件在
// 专用 schema `oc_p2_sessions_test` 里 apply 0134 六表 + 状态机表(pool 走 search_path 隔离)，
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
const MIGRATION_0134 = path.resolve(here, "../db/migrations/0134_sessions_master_pg.sql");
const MIGRATION_0147 = path.resolve(here, "../db/migrations/0147_lossless_turn_tapes.sql");

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
  const sql = await readFile(MIGRATION_0134, { encoding: "utf8" });
  await pool.query(sql);
  await pool.query(await readFile(MIGRATION_0147, { encoding: "utf8" }));
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
             server_authored_request_map, pending_usage_patches, wechat_bindings CASCADE`,
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

    // Billing may arrive before the tape. The exact key must park without a
    // TTL that can delete it, then finalize must consume it atomically.
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
      { applied: "finalized", recordCount: 4 },
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
    const rawParts = await pool.query<{ payload: Buffer }>(
      `SELECT payload FROM client_session_turn_tape_parts
        WHERE session_id=$1 AND user_id=$2 ORDER BY part_index`,
      [sessionId, userId],
    );
    assert.deepEqual(Buffer.concat(rawParts.rows.map((row) => Buffer.from(row.payload))), tape.canonical);

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

  maybe("GC never hard-deletes exact turn-key pending cost", async () => {
    const userId = "u-retain";
    const turnKey = "c".repeat(64);
    await backend.appendCostCredits("retain-cost", userId, "9", null, null, null, turnKey);
    await pool.query(
      "UPDATE pending_usage_patches SET created_at=$1 WHERE request_id=$2 AND user_id=$3",
      [1, "retain-cost", userId],
    );
    const stats = await backend.sweepUsageAggregationGc(Date.now());
    assert.equal(stats.pendingExpired, 0);
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
      { applied: "finalized", recordCount: 3 },
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
