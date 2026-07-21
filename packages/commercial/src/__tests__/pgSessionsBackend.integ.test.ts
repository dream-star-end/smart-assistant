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
import { createServer } from "node:http";
import { request as undiciRequest } from "undici";
import { Pool } from "pg";
import type { ClientSession, ClientTimelineCursor, MessageLike } from "@openclaude/storage";
import { LOSSLESS_TURN_TAPE_PART_BYTES, LOSSLESS_TURN_TAPE_VERSION } from "@openclaude/protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  createPgSessionsBackend,
  startSessionsGcSweeper,
  type PgSessionsBackend,
} from "../db/pgSessionsBackend.js";
import {
  casAdmittedToAccepted,
  casAdmittedToRejecting,
  casToManualReconcile,
  casToTerminal,
  getDispatch,
  resolveManualReconcile,
  scanOpenSessionGone,
} from "../dispatch/turnDispatchStore.js";
import { runReconcileTick } from "../dispatch/turnDispatchReconciler.js";
import { _sanitizeMasterHistoricalMessagesForFrame } from "../ws/userChatBridge.js";
import {
  makeServerAuthoredHandler,
  SERVER_AUTHORED_PATH,
  type ServerAuthoredStorage,
} from "../http/internalServerAuthored.js";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";

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
const MIGRATION_0170 = path.resolve(here, "../db/migrations/0170_durable_turn_dispatch.sql");
const MIGRATION_0175 = path.resolve(here, "../db/migrations/0175_client_session_history_revision.sql");
const MIGRATION_0173 = path.resolve(here, "../db/migrations/0173_client_session_model.sql");
const MIGRATION_0176 = path.resolve(here, "../db/migrations/0176_direct_turn_timeline.sql");
const MIGRATION_0177 = path.resolve(here, "../db/migrations/0177_unified_client_timeline.sql");

let pool: Pool;
let backend: PgSessionsBackend;
let pgAvailable = false;
let migration0176EscapedNulBackfill: {
  physical_record_count: number;
  logical_record_count: number;
  record_payload_bytes: string;
} | null = null;

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
  await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
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
  // 0170 会 ALTER 计费/观测三表;本套件不测它们,建最小 stub 让迁移可 apply。
  await pool.query(
    "CREATE TABLE IF NOT EXISTS request_finalize_journal (request_id TEXT PRIMARY KEY)",
  );
  await pool.query("CREATE TABLE IF NOT EXISTS usage_records (id BIGSERIAL PRIMARY KEY)");
  await pool.query("CREATE TABLE IF NOT EXISTS turn_traces (trace_id TEXT PRIMARY KEY)");
  await pool.query(await readFile(MIGRATION_0170, { encoding: "utf8" }));
  // 0173:client_sessions.model_id(会话级模型选择;本套件的读写 SQL 均已含该列)。
  await pool.query(await readFile(MIGRATION_0173, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_0175, { encoding: "utf8" }));
  // Production history legally contains JSON text escapes such as \u0000.
  // Seed one before 0176 so the migration itself (not merely the new runtime)
  // proves it never coerces the TEXT history authority through JSONB.
  const nulSessionId = "s-migration-0176-escaped-nul";
  const nulUserId = "u-migration-0176-escaped-nul";
  const nulTapeId = "a".repeat(64);
  const nulTapeSha = "b".repeat(64);
  const nulPayloads = [
    Buffer.from(JSON.stringify({ id: "nul-thinking", role: "thinking", text: "step" })),
    Buffer.from(JSON.stringify({ id: "nul-final", role: "assistant", text: "complete" })),
  ];
  const nulMessages = JSON.stringify([
    { id: "legal-json", role: "user", text: "contains\u0000escaped nul" },
    {
      id: "nul-final",
      role: "assistant",
      _turnTapeId: nulTapeId,
      _turnTapeSha256: nulTapeSha,
      _turnTapeComplete: true,
      _turnTapeRecordCount: 2,
      _turnTapeLogicalRecordCount: 2,
    },
  ]);
  await pool.query(
    `INSERT INTO client_sessions
       (id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,updated_at)
     VALUES ($1,$2,'main','migration fixture',0,1,1,$3,2,1)`,
    [nulSessionId, nulUserId, nulMessages],
  );
  await pool.query(
    `INSERT INTO client_session_turn_tapes
       (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
        total_bytes,part_count,billing_anchor_id,created_at,finalized_at)
     VALUES ($1,$2,$3,'main',1,'completed',$4,$5,$6,1,'nul-final',1,1)`,
    [
      nulSessionId,
      nulUserId,
      nulTapeId,
      "c".repeat(64),
      nulTapeSha,
      nulPayloads.reduce((sum, payload) => sum + payload.length, 0),
    ],
  );
  for (const [ordinal, payload] of nulPayloads.entries()) {
    await pool.query(
      `INSERT INTO client_session_turn_tape_records
         (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        nulSessionId,
        nulUserId,
        nulTapeId,
        ordinal === 0 ? "nul-thinking" : "nul-final",
        ordinal,
        ordinal === 0 ? "thinking" : "assistant",
        ordinal + 1,
        sha256(payload),
        payload,
      ],
    );
  }
  await pool.query(await readFile(MIGRATION_0176, { encoding: "utf8" }));
  await pool.query(await readFile(MIGRATION_0177, { encoding: "utf8" }));
  migration0176EscapedNulBackfill = (
    await pool.query<NonNullable<typeof migration0176EscapedNulBackfill>>(
      `SELECT physical_record_count, logical_record_count, record_payload_bytes::text
         FROM client_session_turn_tapes
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [nulSessionId, nulUserId, nulTapeId],
    )
  ).rows[0] ?? null;
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
    ...(over.modelId !== undefined ? { modelId: over.modelId } : {}),
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

  maybe("history revision 匹配才 partial，PUT 缺席删除 bump 并强制 full", async () => {
    const sessionId = "s-history-revision";
    await backend.upsertClientSession(mkSession({
      id: sessionId,
      messages: [
        { id: "hr-1", role: "user", text: "one", ts: 1 },
        { id: "hr-2", role: "user", text: "two", ts: 2 },
      ],
      updatedAt: 1000,
    }));
    let full = await backend.getClientSession(sessionId, "u-1");
    assert.ok(full);
    assert.equal(full.historyRevision, 0);
    assert.equal(full.timelineGeneration, 1);
    const timelineBefore = await backend.readClientTimelinePage(sessionId, "u-1", null, 1);
    assert.ok(timelineBefore?.nextCursor, "two real records must yield one older-page cursor");

    assert.equal((await backend.getClientSessionPartial(sessionId, "u-1", 1))?.isPartial, false);
    assert.equal((await backend.getClientSessionPartial(sessionId, "u-1", 1, {
      sinceHistoryRevision: 99,
    }))?.isPartial, false);
    assert.equal((await backend.getClientSessionPartial(sessionId, "u-1", 1, {
      sinceHistoryRevision: 0,
    }))?.isPartial, true);

    assert.equal(await backend.upsertClientSession({
      ...full,
      messages: (full.messages as MessageLike[]).filter((message) => message.id !== "hr-2"),
      updatedAt: full.updatedAt,
    }, full.updatedAt), "applied");
    const repaired = await backend.getClientSessionPartial(sessionId, "u-1", 2, {
      sinceHistoryRevision: 0,
    });
    assert.ok(repaired);
    assert.equal(repaired.isPartial, false);
    assert.equal(repaired.historyRevision, 1);
    assert.deepEqual((repaired.messages as MessageLike[]).map((message) => message.id), ["hr-1"]);
    await assert.rejects(
      backend.readClientTimelinePage(sessionId, "u-1", timelineBefore!.nextCursor, 1),
      { name: "ClientTimelineCursorStaleError" },
    );

    full = await backend.getClientSession(sessionId, "u-1");
    assert.equal(full?.historyRevision, 1);
    assert.equal(full?.timelineGeneration, 2);
  });

  maybe("timeline detail metadata and latest page share one repeatable-read snapshot", async () => {
    const sessionId = "s-timeline-snapshot";
    const userId = "u-timeline-snapshot";
    await backend.upsertClientSession(mkSession({
      id: sessionId,
      userId,
      messages: [{ id: "snapshot-a", role: "user", text: "A", ts: 1 }],
      updatedAt: 100,
    }));

    const appendBetweenDetailAndPage = async (id: string, text: string) => {
      const current = (
        await pool.query<{ messages: string; next_seq: number; updated_at: string }>(
          "SELECT messages,next_seq,updated_at::text FROM client_sessions WHERE id=$1 AND user_id=$2",
          [sessionId, userId],
        )
      ).rows[0]!;
      const messages = JSON.parse(current.messages) as MessageLike[];
      const seq = current.next_seq;
      messages.push({
        id,
        role: "user",
        text,
        ts: seq,
        _source: "server",
        _seq: seq,
        _orderSeq: seq,
      });
      await pool.query(
        `UPDATE client_sessions
            SET messages=$3,message_count=$4,next_seq=$5,last_at=$6,
                updated_at=updated_at+10,history_revision=history_revision+1,
                timeline_generation=timeline_generation+1
          WHERE id=$1 AND user_id=$2`,
        [sessionId, userId, JSON.stringify(messages), messages.length, seq + 1, seq],
      );
    };

    const backendWithInterleave = (interleave: () => Promise<void>): PgSessionsBackend => {
      let fired = false;
      const proxyPool = {
        query: (...args: unknown[]) => (pool.query as (...queryArgs: unknown[]) => unknown)(...args),
        connect: async () => {
          const client = await pool.connect();
          const query = client.query.bind(client) as (...queryArgs: unknown[]) => Promise<unknown>;
          return new Proxy(client, {
            get(target, property, receiver) {
              if (property === "query") {
                return async (...args: unknown[]) => {
                  const result = await query(...args);
                  const first = args[0] as string | { text?: string } | undefined;
                  const sql = typeof first === "string" ? first : first?.text ?? "";
                  if (!fired && /SELECT\s+cs\.id,\s*cs\.user_id/i.test(sql)) {
                    fired = true;
                    await interleave();
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
      return createPgSessionsBackend(proxyPool as unknown as Pool, {
        expectedGeneration: GENERATION,
      });
    };

    const first = await backendWithInterleave(
      () => appendBetweenDetailAndPage("snapshot-b", "B"),
    ).getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(first);
    assert.equal(first.timelineGeneration, 1);
    assert.deepEqual((first.messages as MessageLike[]).map((message) => message.id), ["snapshot-a"]);

    const current = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(current);
    assert.equal(current.timelineGeneration, 2);
    assert.ok(current.updatedAt > first.updatedAt);
    assert.deepEqual((current.messages as MessageLike[]).map((message) => message.id), [
      "snapshot-a", "snapshot-b",
    ]);

    const partial = await backendWithInterleave(
      () => appendBetweenDetailAndPage("snapshot-c", "C"),
    ).getClientSessionPartial(sessionId, userId, 0, { view: "timeline" });
    assert.ok(partial);
    assert.equal(partial.timelineGeneration, 2);
    assert.equal(partial.updatedAt, current.updatedAt);
    assert.deepEqual((partial.messages as MessageLike[]).map((message) => message.id), [
      "snapshot-a", "snapshot-b",
    ]);

    const latest = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.equal(latest?.timelineGeneration, 3);
    assert.ok((latest?.updatedAt ?? 0) > partial.updatedAt);
    assert.deepEqual((latest!.messages as MessageLike[]).map((message) => message.id), [
      "snapshot-a", "snapshot-b", "snapshot-c",
    ]);
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

  maybe("server append 去重 phantom 行会推进 history revision", async () => {
    const sessionId = "s-history-phantom";
    await backend.upsertClientSession(mkSession({
      id: sessionId,
      messages: [
        { id: "hp-user", role: "user", text: "q", ts: 1 },
        { id: "hp-local", role: "assistant", text: "partial", ts: 2 },
      ],
    }));
    const before = await backend.getClientSession(sessionId, "u-1");
    assert.ok(before);
    assert.deepEqual(await backend.appendServerAuthoredMessage(sessionId, "u-1", {
      id: "hp-server", role: "assistant", text: "complete", ts: 3,
    }), { applied: true });
    const repaired = await backend.getClientSessionPartial(sessionId, "u-1", 2, {
      sinceHistoryRevision: before.historyRevision,
    });
    assert.ok(repaired);
    assert.equal(repaired.isPartial, false);
    assert.equal(repaired.historyRevision, (before.historyRevision ?? 0) + 1);
    assert.deepEqual((repaired.messages as MessageLike[]).map((message) => message.id), [
      "hp-user", "hp-server",
    ]);
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

  maybe("model_id(会话级模型选择):PUT 建行携带/未携带 COALESCE 保留/setClientSessionModel 单调", async () => {
    // 建行携带 → 全读路径回带
    await backend.upsertClientSession(mkSession({ modelId: "kimi-k3" }));
    const got = await backend.getClientSession("s-1", "u-1");
    assert.equal(got?.modelId, "kimi-k3");
    assert.equal((await backend.listClientSessions("u-1")).find((s) => s.id === "s-1")?.modelId, "kimi-k3");
    assert.equal((await backend.getClientSessionPartial("s-1", "u-1", 0))?.modelId, "kimi-k3");

    // 全量 PUT 未携带 → COALESCE 保留(SQLite 侧同语义,见 storage sessionsClientModel.test)
    const r = await backend.upsertClientSession(mkSession({ updatedAt: got!.updatedAt }), got!.updatedAt);
    assert.equal(r, "applied");
    assert.equal((await backend.getClientSession("s-1", "u-1"))?.modelId, "kimi-k3");

    // setClientSessionModel:落值 + 逻辑版本严格递增;缺行 ok:false
    const m1 = await backend.setClientSessionModel("s-1", "u-1", "glm-5.2");
    const m2 = await backend.setClientSessionModel("s-1", "u-1", "gpt-5.5");
    assert.ok(m1.ok && m2.ok);
    assert.ok(m2.updatedAt > m1.updatedAt, `${m2.updatedAt} > ${m1.updatedAt}`);
    assert.equal((await backend.getClientSession("s-1", "u-1"))?.modelId, "gpt-5.5");
    assert.equal((await backend.setClientSessionModel("s-nope", "u-1", "kimi-k3")).ok, false);
    // 从未选择的会话:键缺席(缺席=未表态,前端回落 default_model)
    await backend.upsertClientSession(mkSession({ id: "s-nomodel" }));
    const none = await backend.getClientSession("s-nomodel", "u-1");
    assert.ok(none);
    assert.equal("modelId" in none!, false);
  });

  maybe("appendForRequest 先到 → map 记录 + 幂等 already_exists", async () => {
    await backend.upsertClientSession(mkSession());
    assert.deepEqual(await backend.appendServerAuthoredMessageForRequest("req-1", "s-1", "u-1", { id: "srv-1", role: "assistant", text: "hello" } as MessageLike & { id: string }), {
      applied: true,
    });
    const map = await pool.query("SELECT session_id, msg_id FROM server_authored_request_map WHERE request_id=$1 AND user_id=$2", ["req-1", "u-1"]);
    assert.equal(map.rows[0].session_id, "s-1");
    assert.equal(map.rows[0].msg_id, "srv-1");
    // 重放 → already_exists(幂等)+ 回带现有 _seq(durable dispatch admit 复用 anchor)
    assert.deepEqual(await backend.appendServerAuthoredMessageForRequest("req-1", "s-1", "u-1", { id: "srv-1", role: "assistant", text: "hello" } as MessageLike & { id: string }), {
      applied: false,
      reason: "already_exists",
      seq: 1,
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
    const timelinePage = await backend.readClientTimelinePage("s-arch", "u-1", null, 10);
    assert.ok(timelinePage?.nextCursor);
    const timelineGeneration = timelinePage!.timelineGeneration;
    assert.deepEqual(await backend.appendServerAuthoredMessage("s-arch", "u-1", {
      id: "a-new", role: "assistant", text: big,
    }), { applied: true });
    assert.ok(
      ((await backend.getClientSession("s-arch", "u-1"))?.archivedCount ?? 0) > archived,
      "the append must move another immutable hot prefix into archive storage",
    );
    const afterSpill = await backend.readClientTimelinePage(
      "s-arch", "u-1", timelinePage!.nextCursor, 10,
    );
    assert.equal(afterSpill?.timelineGeneration, timelineGeneration,
      "hot-to-archive movement must not invalidate an immutable timeline cursor");
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

  maybe("detail/partial 的 archivedCount 以 chunk.message_count 实际合计收口", async () => {
    const big = "z".repeat(40 * 1024);
    const messages = Array.from({ length: 90 }, (_, i): MessageLike => ({
      id: `drift-${i}`, role: "user", text: big,
    }));
    await backend.upsertClientSession(mkSession({ id: "s-arch-drift", messages, updatedAt: 1 }));
    const actual = Number((await pool.query<{ n: string }>(
      `SELECT COALESCE(SUM(message_count),0)::text AS n
         FROM client_session_archive_chunks WHERE session_id=$1 AND user_id=$2`,
      ["s-arch-drift", "u-1"],
    )).rows[0]!.n);
    assert.ok(actual > 0, "测试前提:已产生 archive chunks");
    await pool.query(
      "UPDATE client_sessions SET archived_count=$3 WHERE id=$1 AND user_id=$2",
      ["s-arch-drift", "u-1", actual + 5],
    );
    const detail = await backend.getClientSession("s-arch-drift", "u-1");
    const partial = await backend.getClientSessionPartial("s-arch-drift", "u-1", 0);
    assert.equal(detail!.archivedCount, actual, "detail 不透传漂移的缓存计数");
    assert.equal(partial!.archivedCount, actual, "partial 不透传漂移的缓存计数");
    assert.equal(partial!.totalMessageCount, partial!.messages.length + actual);

    await backend.upsertClientSession(mkSession({ id: "s-arch-zero", userId: "u-1" }));
    await pool.query(
      "UPDATE client_sessions SET archived_count=3 WHERE id=$1 AND user_id=$2",
      ["s-arch-zero", "u-1"],
    );
    assert.equal((await backend.getClientSession("s-arch-zero", "u-1"))!.archivedCount, 0,
      "零 chunk 时实际归档数为 0");
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
  maybe("repairs stale partial derived rows atomically under concurrent replay without double cost", async () => {
    const sessionId = "s-partial-derived-recovery";
    const userId = "c:227";
    const turnKey = "1".repeat(64);
    const requestId = "partial-derived-cost";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      requestId,
      text: "the complete paid answer",
      tools: [{
        blockId: "partial-derived-tool",
        toolName: "Bash",
        inputJson: { command: "printf exact" },
        output: "exact tool output",
        completed: true,
      }],
      usage: { inputTokens: 11, outputTokens: 13 },
      createdAt: 1_783_944_000_000,
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await pool.query(
      `INSERT INTO pending_usage_patches
         (request_id,user_id,session_id,turn_key,cost_credits)
       VALUES ($1,$2,'ccb-partial-derived',$3,'207')`,
      [requestId, userId, turnKey],
    );

    // Force the terminal transaction to roll back after per-ordinal staging,
    // reproducing a process/release boundary with durable partial derived rows.
    await pool.query(
      "UPDATE client_sessions SET messages='not-json' WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );
    await assert.rejects(
      backend.finalizeLosslessTurnTape(userId, tape.finalize),
      /target session row malformed/,
    );
    await pool.query(
      "UPDATE client_sessions SET messages='[]' WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );

    type RecordSnapshot = {
      msg_id: string;
      ordinal: number;
      role: string;
      ts: string;
      content_sha256: string;
      payload: Buffer;
      visible_payload: Buffer;
      visible_content_sha256: string;
      model_sidecar_complete: boolean;
    };
    type ModelSnapshot = {
      physical_ordinal: number;
      logical_ordinal: number;
      msg_id: string;
      role: string;
      semantic_text: string;
      token_estimate: number;
      ts: string | null;
      client_message_id: string | null;
    };
    const expectedRecords = (
      await pool.query<RecordSnapshot>(
        `SELECT msg_id,ordinal,role,ts::text,content_sha256,payload,visible_payload,
                visible_content_sha256,model_sidecar_complete
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          ORDER BY ordinal`,
        [sessionId, userId, tape.finalize.tapeId],
      )
    ).rows;
    const expectedModels = (
      await pool.query<ModelSnapshot>(
        `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                token_estimate,ts::text,client_message_id
           FROM client_session_turn_tape_model_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          ORDER BY physical_ordinal,logical_ordinal`,
        [sessionId, userId, tape.finalize.tapeId],
      )
    ).rows;
    assert.ok(expectedRecords.length > 1);
    assert.ok(expectedModels.length > 0);
    const staleOrdinal = expectedModels[0]!.physical_ordinal;
    const stalePayload = Buffer.from('{"stale":true}', "utf8");
    await pool.query(
      `UPDATE client_session_turn_tape_records
          SET role='error',ts=ts+99,content_sha256=$4,payload=$5,
              visible_payload=$5,visible_content_sha256=$4,model_sidecar_complete=TRUE
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$6`,
      [sessionId, userId, tape.finalize.tapeId, sha256(stalePayload), stalePayload, staleOrdinal],
    );
    await pool.query(
      `DELETE FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4`,
      [sessionId, userId, tape.finalize.tapeId, staleOrdinal],
    );
    await pool.query(
      `INSERT INTO client_session_turn_tape_model_records
         (session_id,user_id,tape_id,physical_ordinal,logical_ordinal,msg_id,role,
          semantic_text,token_estimate,ts,client_message_id)
       VALUES ($1,$2,$3,$4,999,'stale-sidecar','error','stale semantic text',1,NULL,NULL)`,
      [sessionId, userId, tape.finalize.tapeId, staleOrdinal],
    );
    await pool.query(`
      CREATE TABLE oc_test_tape_record_updates (tape_id TEXT NOT NULL, ordinal INTEGER NOT NULL);
      CREATE OR REPLACE FUNCTION oc_test_log_tape_record_update()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO oc_test_tape_record_updates(tape_id,ordinal)
        VALUES (NEW.tape_id,NEW.ordinal);
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_oc_test_log_tape_record_update
      AFTER UPDATE ON client_session_turn_tape_records
      FOR EACH ROW EXECUTE FUNCTION oc_test_log_tape_record_update();
    `);

    try {
      const results = await Promise.all([
        backend.finalizeLosslessTurnTape(userId, tape.finalize),
        backend.finalizeLosslessTurnTape(userId, tape.finalize),
      ]);
      assert.deepEqual(
        results.map((result) => result.applied).sort(),
        ["finalized", "idempotent"],
      );
      const updatedOrdinals = (
        await pool.query<{ ordinal: number }>(
          `SELECT DISTINCT ordinal FROM oc_test_tape_record_updates
            WHERE tape_id=$1 ORDER BY ordinal`,
          [tape.finalize.tapeId],
        )
      ).rows.map((row) => row.ordinal);
      assert.deepEqual(
        updatedOrdinals,
        [staleOrdinal],
        "bulk exact summary must skip every already-correct ordinal",
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS trg_oc_test_log_tape_record_update
          ON client_session_turn_tape_records;
        DROP FUNCTION IF EXISTS oc_test_log_tape_record_update();
        DROP TABLE IF EXISTS oc_test_tape_record_updates;
      `);
    }
    const repairedRecords = (
      await pool.query<RecordSnapshot>(
        `SELECT msg_id,ordinal,role,ts::text,content_sha256,payload,visible_payload,
                visible_content_sha256,model_sidecar_complete
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          ORDER BY ordinal`,
        [sessionId, userId, tape.finalize.tapeId],
      )
    ).rows;
    const repairedModels = (
      await pool.query<ModelSnapshot>(
        `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                token_estimate,ts::text,client_message_id
           FROM client_session_turn_tape_model_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
          ORDER BY physical_ordinal,logical_ordinal`,
        [sessionId, userId, tape.finalize.tapeId],
      )
    ).rows;
    assert.deepEqual(repairedRecords, expectedRecords);
    assert.deepEqual(repairedModels, expectedModels);
    assert.equal(
      (await backend.finalizeLosslessTurnTape(userId, tape.finalize)).applied,
      "idempotent",
    );
    const billing = (
      await pool.query<{ count: string; credits: string }>(
        `SELECT COUNT(*)::text AS count,COALESCE(SUM(cost_credits),0)::text AS credits
           FROM turn_tape_cost_components
          WHERE request_id=$1 AND user_id=$2`,
        [requestId, userId],
      )
    ).rows[0]!;
    assert.deepEqual(billing, { count: "1", credits: "207" });
    assert.equal(
      (await pool.query(
        "SELECT 1 FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
        [requestId, userId],
      )).rowCount,
      0,
      "the pending paid component is folded exactly once",
    );
  });

  maybe("exact summary repairs every mutable record and model field it verifies", async () => {
    const cases: Array<{
      name: string;
      mutate: (args: {
        sessionId: string;
        userId: string;
        tapeId: string;
        ordinal: number;
      }) => Promise<void>;
    }> = [
      {
        name: "declared raw hash",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `UPDATE client_session_turn_tape_records SET content_sha256=$5
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
            [sessionId, userId, tapeId, ordinal, "f".repeat(64)],
          );
        },
      },
      {
        name: "raw payload bytes",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `UPDATE client_session_turn_tape_records SET payload=convert_to('{"corrupt":true}','UTF8')
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
            [sessionId, userId, tapeId, ordinal],
          );
        },
      },
      {
        name: "declared visible hash",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `UPDATE client_session_turn_tape_records SET visible_content_sha256=$5
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
            [sessionId, userId, tapeId, ordinal, "e".repeat(64)],
          );
        },
      },
      {
        name: "visible payload bytes",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `UPDATE client_session_turn_tape_records
                SET visible_payload=convert_to('{"visible":"corrupt"}','UTF8')
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
            [sessionId, userId, tapeId, ordinal],
          );
        },
      },
      {
        name: "sidecar marker",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `UPDATE client_session_turn_tape_records SET model_sidecar_complete=FALSE
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
            [sessionId, userId, tapeId, ordinal],
          );
        },
      },
      ...([
        ["model logical identity", "logical_ordinal=logical_ordinal+1000"],
        ["model msg id", "msg_id=msg_id||'-corrupt'"],
        ["model role", "role='error'"],
        ["model semantic text", "semantic_text=semantic_text||'-corrupt'"],
        ["model token estimate", "token_estimate=token_estimate+1"],
        ["model timestamp", "ts=COALESCE(ts,0)+1"],
        ["model client message id", "client_message_id='corrupt-client-message'"],
      ] as const).map(([name, assignment]) => ({
        name,
        mutate: async ({ sessionId, userId, tapeId, ordinal }: {
          sessionId: string;
          userId: string;
          tapeId: string;
          ordinal: number;
        }) => {
          await pool.query(
            `UPDATE client_session_turn_tape_model_records SET ${assignment}
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4`,
            [sessionId, userId, tapeId, ordinal],
          );
        },
      })),
      {
        name: "missing model row",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `DELETE FROM client_session_turn_tape_model_records
              WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4`,
            [sessionId, userId, tapeId, ordinal],
          );
        },
      },
      {
        name: "extra model row",
        mutate: async ({ sessionId, userId, tapeId, ordinal }) => {
          await pool.query(
            `INSERT INTO client_session_turn_tape_model_records
               (session_id,user_id,tape_id,physical_ordinal,logical_ordinal,msg_id,role,
                semantic_text,token_estimate,ts,client_message_id)
             VALUES ($1,$2,$3,$4,999999,'extra-model','error','extra',1,NULL,NULL)`,
            [sessionId, userId, tapeId, ordinal],
          );
        },
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const sessionId = `s-summary-field-${index}`;
      const userId = `u-summary-field-${index}`;
      const tape = buildTape({
        sessionId,
        agentId: "main",
        turnIndex: 1,
        status: "completed",
        turnKey: sha256(`summary-field-${index}`),
        text: `summary field ${entry.name}`,
        createdAt: 1_783_944_100_000 + index,
      });
      await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
      for (const part of tape.parts) {
        await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
      }
      await pool.query(
        "UPDATE client_sessions SET messages='not-json' WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );
      await assert.rejects(
        backend.finalizeLosslessTurnTape(userId, tape.finalize),
        /target session row malformed/,
      );
      await pool.query(
        "UPDATE client_sessions SET messages='[]' WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );

      const expectedRecord = (
        await pool.query<{
          msg_id: string;
          role: string;
          ts: string;
          content_sha256: string;
          payload: Buffer;
          visible_payload: Buffer;
          visible_content_sha256: string;
          model_sidecar_complete: boolean;
        }>(
          `SELECT msg_id,role,ts::text,content_sha256,payload,visible_payload,
                  visible_content_sha256,model_sidecar_complete
             FROM client_session_turn_tape_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            ORDER BY ordinal LIMIT 1`,
          [sessionId, userId, tape.finalize.tapeId],
        )
      ).rows[0]!;
      const ordinal = (
        await pool.query<{ ordinal: number }>(
          `SELECT physical_ordinal AS ordinal
             FROM client_session_turn_tape_model_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            ORDER BY physical_ordinal,logical_ordinal LIMIT 1`,
          [sessionId, userId, tape.finalize.tapeId],
        )
      ).rows[0]!.ordinal;
      const expectedModels = (
        await pool.query(
          `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                  token_estimate,ts::text,client_message_id
             FROM client_session_turn_tape_model_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4
            ORDER BY logical_ordinal`,
          [sessionId, userId, tape.finalize.tapeId, ordinal],
        )
      ).rows;

      await entry.mutate({ sessionId, userId, tapeId: tape.finalize.tapeId, ordinal });
      assert.equal(
        (await backend.finalizeLosslessTurnTape(userId, tape.finalize)).applied,
        "finalized",
        entry.name,
      );
      const repairedRecord = (
        await pool.query(
          `SELECT msg_id,role,ts::text,content_sha256,payload,visible_payload,
                  visible_content_sha256,model_sidecar_complete
             FROM client_session_turn_tape_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
            ORDER BY ordinal LIMIT 1`,
          [sessionId, userId, tape.finalize.tapeId],
        )
      ).rows[0]!;
      const repairedModels = (
        await pool.query(
          `SELECT physical_ordinal,logical_ordinal,msg_id,role,semantic_text,
                  token_estimate,ts::text,client_message_id
             FROM client_session_turn_tape_model_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND physical_ordinal=$4
            ORDER BY logical_ordinal`,
          [sessionId, userId, tape.finalize.tapeId, ordinal],
        )
      ).rows;
      assert.deepEqual(repairedRecord, expectedRecord, entry.name);
      assert.deepEqual(repairedModels, expectedModels, entry.name);
    }
  });

  maybe("exact summary stays two bulk queries instead of one query per physical record", async () => {
    const sessionId = "s-summary-query-count";
    const userId = "u-summary-query-count";
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey: "3".repeat(64),
      text: "bulk summary complete",
      tools: Array.from({ length: 120 }, (_, index) => ({
        blockId: `summary-tool-${index}`,
        toolName: "Bash",
        inputJson: { command: `printf ${index}` },
        output: `summary-output-${index}`,
        completed: true,
        arrivedAt: 1_783_944_200_000 + index,
      })),
      createdAt: 1_783_944_200_500,
    });
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await pool.query(
      "UPDATE client_sessions SET messages='not-json' WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );
    await assert.rejects(
      backend.finalizeLosslessTurnTape(userId, tape.finalize),
      /target session row malformed/,
    );
    await pool.query(
      "UPDATE client_sessions SET messages='[]' WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );

    let recordSummaries = 0;
    let modelSummaries = 0;
    const proxyPool = {
      query: async (...args: unknown[]) => {
        const first = args[0] as string | { text?: string } | undefined;
        const sql = typeof first === "string" ? first : first?.text ?? "";
        if (/AS payload_sha256/i.test(sql)) recordSummaries += 1;
        if (/AS semantic_text_sha256/i.test(sql)) modelSummaries += 1;
        return (pool.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
      },
      connect: () => pool.connect(),
    };
    const observedBackend = createPgSessionsBackend(proxyPool as unknown as Pool, {
      expectedGeneration: GENERATION,
    });
    assert.equal(
      (await observedBackend.finalizeLosslessTurnTape(userId, tape.finalize)).applied,
      "finalized",
    );
    assert.deepEqual(
      { recordSummaries, modelSummaries },
      { recordSummaries: 1, modelSummaries: 1 },
    );
    assert.equal(
      (await pool.query(
        `SELECT COUNT(*)::int AS count FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
        [sessionId, userId, tape.finalize.tapeId],
      )).rows[0]!.count,
      121,
    );
  });

  maybe("final header-lock verification rehashes bytes changed after the exact summary", async () => {
    for (const field of ["payload", "visible_payload"] as const) {
      const sessionId = `s-summary-toctou-${field}`;
      const userId = `u-summary-toctou-${field}`;
      const tape = buildTape({
        sessionId,
        agentId: "main",
        turnIndex: 1,
        status: "completed",
        turnKey: sha256(`summary-toctou-${field}`),
        text: `summary TOCTOU ${field}`,
        createdAt: 1_783_944_250_000,
      });
      await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
      for (const part of tape.parts) {
        await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
      }
      await pool.query(
        "UPDATE client_sessions SET messages='not-json' WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );
      await assert.rejects(
        backend.finalizeLosslessTurnTape(userId, tape.finalize),
        /target session row malformed/,
      );
      await pool.query(
        "UPDATE client_sessions SET messages='[]' WHERE id=$1 AND user_id=$2",
        [sessionId, userId],
      );

      let corruptedAfterSummary = false;
      const proxyPool = {
        query: async (...args: unknown[]) => {
          const result = await (pool.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
          const first = args[0] as string | { text?: string } | undefined;
          const sql = typeof first === "string" ? first : first?.text ?? "";
          if (!corruptedAfterSummary && /AS semantic_text_sha256/i.test(sql)) {
            corruptedAfterSummary = true;
            await pool.query(
              `UPDATE client_session_turn_tape_records
                  SET ${field}=convert_to('{"postSummary":"corrupt"}','UTF8')
                WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=0`,
              [sessionId, userId, tape.finalize.tapeId],
            );
          }
          return result;
        },
        connect: () => pool.connect(),
      };
      const observedBackend = createPgSessionsBackend(proxyPool as unknown as Pool, {
        expectedGeneration: GENERATION,
      });
      await assert.rejects(
        observedBackend.finalizeLosslessTurnTape(userId, tape.finalize),
        /staged record manifest conflict/,
      );
      assert.equal(corruptedAfterSummary, true);
      assert.equal(
        (await pool.query<{ finalized_at: string | null }>(
          `SELECT finalized_at::text FROM client_session_turn_tapes
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
          [sessionId, userId, tape.finalize.tapeId],
        )).rows[0]!.finalized_at,
        null,
        `${field} corruption must not be finalized`,
      );
      assert.equal(
        (await backend.finalizeLosslessTurnTape(userId, tape.finalize)).applied,
        "finalized",
      );
      const repaired = (
        await pool.query<{
          content_sha256: string;
          payload_sha256: string;
          visible_content_sha256: string;
          visible_payload_sha256: string;
        }>(
          `SELECT content_sha256,
                  encode(public.digest(payload,'sha256'),'hex') AS payload_sha256,
                  visible_content_sha256,
                  encode(public.digest(visible_payload,'sha256'),'hex') AS visible_payload_sha256
             FROM client_session_turn_tape_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=0`,
          [sessionId, userId, tape.finalize.tapeId],
        )
      ).rows[0]!;
      assert.equal(repaired.payload_sha256, repaired.content_sha256);
      assert.equal(repaired.visible_payload_sha256, repaired.visible_content_sha256);
    }
  });

  maybe("billing work rolls back if the terminal tape update fails, then concurrent replay charges once", async () => {
    const sessionId = "s-finalize-billing-boundary";
    const userId = "c:228";
    const turnKey = "4".repeat(64);
    const requestId = "finalize-billing-boundary";
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      requestId,
      text: "atomic billing boundary answer",
      createdAt: 1_783_944_300_000,
    });
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await pool.query(
      `INSERT INTO pending_usage_patches
         (request_id,user_id,session_id,turn_key,cost_credits)
       VALUES ($1,$2,'ccb-billing-boundary',$3,'344')`,
      [requestId, userId, turnKey],
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION oc_test_fail_terminal_tape_update()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tape_id='${tape.finalize.tapeId}' AND NEW.finalized_at IS NOT NULL THEN
          RAISE EXCEPTION 'test terminal tape update failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_oc_test_fail_terminal_tape_update
      BEFORE UPDATE ON client_session_turn_tapes
      FOR EACH ROW EXECUTE FUNCTION oc_test_fail_terminal_tape_update();
    `);
    try {
      await assert.rejects(
        backend.finalizeLosslessTurnTape(userId, tape.finalize),
        /test terminal tape update failure/,
      );
      assert.equal(
        (await pool.query(
          `SELECT 1 FROM turn_tape_cost_components
            WHERE request_id=$1 AND user_id=$2`,
          [requestId, userId],
        )).rowCount,
        0,
        "cost component must roll back with the terminal header",
      );
      assert.equal(
        (await pool.query(
          `SELECT 1 FROM pending_usage_patches
            WHERE request_id=$1 AND user_id=$2`,
          [requestId, userId],
        )).rowCount,
        1,
        "pending cost must remain recoverable",
      );
      assert.equal(
        (await pool.query<{ finalized_at: string | null }>(
          `SELECT finalized_at::text FROM client_session_turn_tapes
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
          [sessionId, userId, tape.finalize.tapeId],
        )).rows[0]!.finalized_at,
        null,
      );
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS trg_oc_test_fail_terminal_tape_update
          ON client_session_turn_tapes;
        DROP FUNCTION IF EXISTS oc_test_fail_terminal_tape_update();
      `);
    }

    const results = await Promise.all([
      backend.finalizeLosslessTurnTape(userId, tape.finalize),
      backend.finalizeLosslessTurnTape(userId, tape.finalize),
    ]);
    assert.deepEqual(
      results.map((result) => result.applied).sort(),
      ["finalized", "idempotent"],
    );
    assert.deepEqual(
      (await pool.query<{ count: string; credits: string }>(
        `SELECT COUNT(*)::text AS count,COALESCE(SUM(cost_credits),0)::text AS credits
           FROM turn_tape_cost_components
          WHERE request_id=$1 AND user_id=$2`,
        [requestId, userId],
      )).rows[0],
      { count: "1", credits: "344" },
    );
    assert.equal(
      (await pool.query(
        `SELECT 1 FROM pending_usage_patches
          WHERE request_id=$1 AND user_id=$2`,
        [requestId, userId],
      )).rowCount,
      0,
    );
  });

  maybe("a real HTTP client abort does not cancel finalize and the concurrent replay is idempotent", async () => {
    const sessionId = "s-http-abort-finalize";
    const numericUserId = 229;
    const userId = `c:${numericUserId}`;
    const turnKey = "5".repeat(64);
    const requestId = "http-abort-finalize";
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      requestId,
      text: "commit after the HTTP client disconnects",
      createdAt: 1_783_944_400_000,
    });
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await pool.query(
      `INSERT INTO pending_usage_patches
         (request_id,user_id,session_id,turn_key,cost_credits)
       VALUES ($1,$2,'ccb-http-abort',$3,'502')`,
      [requestId, userId, turnKey],
    );

    const barrierKey = 1_780_178;
    const locker = await pool.connect();
    await locker.query("SELECT pg_advisory_lock($1)", [barrierKey]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION oc_test_wait_before_terminal_tape_update()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tape_id='${tape.finalize.tapeId}' AND NEW.finalized_at IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(${barrierKey});
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_oc_test_wait_before_terminal_tape_update
      BEFORE UPDATE ON client_session_turn_tapes
      FOR EACH ROW EXECUTE FUNCTION oc_test_wait_before_terminal_tape_update();
    `);

    const secret = "a".repeat(64);
    const token = `oc-v3.7.${secret}`;
    const hostUuid = "http-abort-host";
    const boundIp = "172.30.0.229";
    const identityRepo = {
      async findActiveByHostAndBoundIp(host: string, ip: string) {
        if (host !== hostUuid || ip !== boundIp) return null;
        return {
          id: 7,
          user_id: numericUserId,
          host_uuid: hostUuid,
          bound_ip: boundIp,
          secret_hash: createHash("sha256").update(Buffer.from(secret, "hex")).digest(),
        };
      },
    } as ContainerIdentityRepo;
    const handler = makeServerAuthoredHandler({
      identityRepo,
      storage: {} as ServerAuthoredStorage,
      losslessTurnTapeStorage: backend,
      metric: () => undefined,
    });
    let handlerError: unknown;
    const server = createServer((req, res) => {
      void handler(req, res, { hostUuid, boundIp }).catch((err) => {
        handlerError = err;
        res.destroy(err as Error);
      });
    });
    let lockerHeld = true;
    let serverListening = false;
    try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    serverListening = true;
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}${SERVER_AUTHORED_PATH}`;
    const headers = {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    };
    const body = JSON.stringify(tape.finalize);
    const controller = new AbortController();
    const first = undiciRequest(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    const waitDeadline = Date.now() + 5_000;
    let barrierObserved = false;
    while (Date.now() < waitDeadline) {
      barrierObserved = Boolean((
        await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted
           ) AS waiting`,
          [barrierKey],
        )
      ).rows[0]?.waiting);
      if (barrierObserved) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(barrierObserved, true, "first finalize must reach the post-billing transaction barrier");

    const replay = undiciRequest(url, { method: "POST", headers, body });
    controller.abort();
    await assert.rejects(first, /abort/i);
    await locker.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
    locker.release();
    lockerHeld = false;

    const replayResponse = await replay;
    const replayBody = JSON.parse(await replayResponse.body.text()) as {
      ok: boolean;
      idempotent?: boolean;
    };
    assert.equal(replayResponse.statusCode, 200);
    assert.equal(replayBody.ok, true);
    assert.equal(replayBody.idempotent, true);
    assert.equal(handlerError, undefined);
    assert.deepEqual(
      (await pool.query<{ finalized: boolean; parts: string }>(
        `SELECT finalized_at IS NOT NULL AS finalized,
                (SELECT COUNT(*)::text FROM client_session_turn_tape_parts p
                  WHERE p.session_id=t.session_id AND p.user_id=t.user_id AND p.tape_id=t.tape_id) AS parts
           FROM client_session_turn_tapes t
          WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3`,
        [sessionId, userId, tape.finalize.tapeId],
      )).rows[0],
      { finalized: true, parts: "0" },
    );
    assert.deepEqual(
      (await pool.query<{ count: string; credits: string }>(
        `SELECT COUNT(*)::text AS count,COALESCE(SUM(cost_credits),0)::text AS credits
           FROM turn_tape_cost_components
          WHERE request_id=$1 AND user_id=$2`,
        [requestId, userId],
      )).rows[0],
      { count: "1", credits: "502" },
    );
    assert.equal(
      (await pool.query(
        "SELECT 1 FROM pending_usage_patches WHERE request_id=$1 AND user_id=$2",
        [requestId, userId],
      )).rowCount,
      0,
    );
    } finally {
      if (lockerHeld) {
        await locker.query("SELECT pg_advisory_unlock($1)", [barrierKey]);
        locker.release();
      }
      await pool.query(`
        DROP TRIGGER IF EXISTS trg_oc_test_wait_before_terminal_tape_update
          ON client_session_turn_tapes;
        DROP FUNCTION IF EXISTS oc_test_wait_before_terminal_tape_update();
      `);
      if (serverListening) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
          server.closeAllConnections();
        });
      }
    }
  });

  maybe("an agent-group compatibility trigger cannot delete source parts outside its ordinal rollback", async () => {
    const sessionId = "s-agent-group-trigger-rollback";
    const userId = "u-agent-group-trigger-rollback";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey: "2".repeat(64),
      text: "answer after delegated work",
      agentGroups: [{
        runId: "trigger-rollback-agent-group",
        agentId: "reviewer",
        goal: "review exact output",
        status: "ok",
        resultSummary: "exact delegated result",
        completedAt: 1_783_944_000_010,
      }],
      createdAt: 1_783_944_000_000,
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
    }
    await pool.query(`
      CREATE OR REPLACE FUNCTION oc_test_delete_parts_on_agent_group()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.role='agent-group' THEN
          DELETE FROM client_session_turn_tape_parts
           WHERE session_id=NEW.session_id AND user_id=NEW.user_id AND tape_id=NEW.tape_id;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_oc_test_delete_parts_on_agent_group
      BEFORE INSERT OR UPDATE OF payload,role ON client_session_turn_tape_records
      FOR EACH ROW EXECUTE FUNCTION oc_test_delete_parts_on_agent_group();
    `);
    try {
      await assert.rejects(
        backend.finalizeLosslessTurnTape(userId, tape.finalize),
        /source parts changed during record staging/,
      );
      const state = (
        await pool.query<{ finalized_at: string | null; parts: string; groups: string }>(
          `SELECT t.finalized_at::text,
                  (SELECT COUNT(*)::text FROM client_session_turn_tape_parts p
                    WHERE p.session_id=t.session_id AND p.user_id=t.user_id AND p.tape_id=t.tape_id) AS parts,
                  (SELECT COUNT(*)::text FROM client_session_turn_tape_records r
                    WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
                      AND r.role='agent-group') AS groups
             FROM client_session_turn_tapes t
            WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3`,
          [sessionId, userId, tape.finalize.tapeId],
        )
      ).rows[0]!;
      assert.equal(state.finalized_at, null);
      assert.equal(Number(state.parts), tape.parts.length, "trigger DELETE rolled back with the record");
      assert.equal(state.groups, "0", "the trigger-mutated agent-group row also rolled back");
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS trg_oc_test_delete_parts_on_agent_group
          ON client_session_turn_tape_records;
        DROP FUNCTION IF EXISTS oc_test_delete_parts_on_agent_group();
      `);
    }
    assert.equal((await backend.finalizeLosslessTurnTape(userId, tape.finalize)).applied, "finalized");
  });

  maybe("an incomplete physically impossible declaration cannot head-of-line block a complete tape", async () => {
    const incompleteSessionId = "s-incomplete-huge-tape";
    const completeSessionId = "s-complete-after-incomplete";
    const incompleteUserId = "u-incomplete-huge-tape";
    const completeUserId = "u-complete-after-incomplete";
    await backend.upsertClientSession(mkSession({ id: incompleteSessionId, userId: incompleteUserId }));
    await backend.upsertClientSession(mkSession({ id: completeSessionId, userId: completeUserId }));

    // This declaration is intentionally much larger than a normal Node heap,
    // but only its first valid fixed-size part exists. The former admission
    // path waited on totalBytes before noticing the missing parts and poisoned
    // the process-global FIFO forever.
    const incompleteTotalBytes = 16 * 1024 * 1024 * 1024;
    const incompletePartCount = Math.ceil(incompleteTotalBytes / LOSSLESS_TURN_TAPE_PART_BYTES);
    const firstPart = Buffer.alloc(LOSSLESS_TURN_TAPE_PART_BYTES, 0x7b);
    const incompleteBase = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      sessionId: incompleteSessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed" as const,
      turnKey: "d".repeat(64),
      tapeId: "e".repeat(64),
      tapeSha256: "f".repeat(64),
      totalBytes: incompleteTotalBytes,
      partCount: incompletePartCount,
      createdAt: 1_783_944_000_000,
    };
    await backend.stageLosslessTurnTapePart(incompleteUserId, {
      ...incompleteBase,
      action: "part",
      partIndex: 0,
      partSha256: sha256(firstPart),
      data: firstPart.toString("base64"),
    }, firstPart);

    const complete = buildTape({
      sessionId: completeSessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey: "c".repeat(64),
      text: "normal exact answer",
      createdAt: 1_783_944_000_001,
    });
    for (const part of complete.parts) {
      await backend.stageLosslessTurnTapePart(completeUserId, part.request, part.bytes);
    }

    const incompleteFinalize = backend.finalizeLosslessTurnTape(incompleteUserId, {
      ...incompleteBase,
      action: "finalize",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const completeFinalize = backend.finalizeLosslessTurnTape(completeUserId, complete.finalize);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const [incompleteResult, completeResult] = await Promise.race([
      Promise.all([incompleteFinalize, completeFinalize]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("incomplete tape blocked the following complete finalize")),
          2_000,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    assert.deepEqual(incompleteResult, { applied: "incomplete" });
    assert.deepEqual(completeResult, {
      applied: "finalized",
      recordCount: 1,
      engineBillings: [],
    });
  });

  maybe("stages later immutable parts while a concurrent writer holds the hot session row", async () => {
    const sessionId = "s-tape-stage-no-hot-row-lock";
    const userId = "u-tape-stage-no-hot-row-lock";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = buildTape({
      sessionId,
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey: "7".repeat(64),
      text: "large exact answer".repeat(80_000),
      createdAt: 1_783_944_000_000,
    });
    assert.ok(tape.parts.length > 1);
    await backend.stageLosslessTurnTapePart(userId, tape.parts[0]!.request, tape.parts[0]!.bytes);

    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM client_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
      const staged = backend.stageLosslessTurnTapePart(
        userId,
        tape.parts[1]!.request,
        tape.parts[1]!.bytes,
      );
      const result = await Promise.race([
        staged,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("part staging waited on the unrelated hot session row")),
          1_000,
        )),
      ]);
      assert.deepEqual(result, { applied: "stored" });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

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

    for (const view of [undefined, { view: "timeline" as const }]) {
      const hydrated = await backend.getClientSession(sessionId, userId, view);
      const messages = hydrated?.messages as MessageLike[] | undefined;
      const assistant = messages?.find((message) => message.role === "assistant");
      assert.equal(
        assistant?._turnKey,
        turnKey,
        "billing anchor must retain its exact logical turn for live waiver projection",
      );
      assert.equal(
        (assistant?.usage as { waived?: boolean } | undefined)?.waived,
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
    for (const view of [undefined, { view: "timeline" as const }]) {
      const hydrated = await backend.getClientSession(sessionId, userId, view);
      const assistant = (hydrated?.messages as MessageLike[] | undefined)
        ?.find((message) => message.role === "assistant");
      assert.equal(
        (assistant?.usage as { waived?: boolean } | undefined)?.waived,
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

    // A browser may immediately PUT the fully hydrated GET expansion back.
    // Expanded rows are read-only records and must not be copied into the
    // hot JSON tail; otherwise one refresh would defeat out-of-line storage.
    const hydratedReadSyncedAt = hydrated.updatedAt;
    assert.equal(
      await backend.upsertClientSession(
        mkSession({
          id: sessionId,
          userId,
          createdAt: hydrated.createdAt,
          lastAt: hydrated.lastAt,
          updatedAt: hydratedReadSyncedAt,
          messages: hydrated.messages,
        }),
        hydratedReadSyncedAt,
      ),
      "applied",
    );
    const hotAfterReadPut = await pool.query<{ messages: string }>(
      "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2",
      [sessionId, userId],
    );
    assert.equal((JSON.parse(hotAfterReadPut.rows[0]!.messages) as MessageLike[]).length, 1);
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
    const costDelta = await backend.getClientSessionPartial(sessionId, userId, beforeLateCostSeq, {
      sinceHistoryRevision: hydrated.historyRevision,
    });
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
    const beforeUpgrade = await backend.getClientSession(sessionId, userId);
    assert.ok(beforeUpgrade);
    const beforeUpgradeMaxSeq = Math.max(...(beforeUpgrade.messages as MessageLike[]).map(
      (message) => typeof message._seq === "number" ? message._seq : 0,
    ));
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
    const repaired = await backend.getClientSessionPartial(
      sessionId,
      userId,
      beforeUpgradeMaxSeq,
      { sinceHistoryRevision: beforeUpgrade.historyRevision },
    );
    assert.ok(repaired);
    assert.equal(repaired.isPartial, false, "legacy substitute removal must force a full repair");
    assert.equal(repaired.historyRevision, (beforeUpgrade.historyRevision ?? 0) + 1);
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

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(timeline);
    const timelineMessages = timeline.messages as MessageLike[];
    const visibleTimeline = browserVisibleTimeline(timelineMessages);
    assert.equal(visibleTimeline.some((message) => message.role === "runtime-event"), false);
    assert.equal(visibleTimeline.filter((message) => message.role === "assistant").length, 1);
    assert.equal(visibleTimeline.filter((message) => message.role === "tool").length, 1);
    const tailAuxiliary = timelineMessages.find((message) =>
      message._timelineAuxiliary === "bash-tail" && message._runtimeEvent !== undefined);
    assert.ok(tailAuxiliary, "exact tail travels only as hidden ToolCard reconciliation evidence");
    assert.deepEqual(tailAuxiliary._runtimeEvent, rawTail);
    assert.equal(timelineMessages.some((message) => message._turnTapeProcess === true), false);
    assert.equal(timelineMessages.every((message) => message._timelineRecord === true), true);

    const originalSeq = Math.min(...timelineMessages.flatMap((message) =>
      typeof message._seq === "number" ? [message._seq] : []));
    const incremental = await backend.getClientSessionPartial(
      sessionId,
      userId,
      originalSeq,
      { view: "timeline", sinceHistoryRevision: timeline.historyRevision },
    );
    assert.equal(incremental?.isPartial, false,
      "timeline refreshes replace only the newest unified page, never a semantic subset");
    assert.equal((incremental!.messages as MessageLike[]).some((message) => message.role === "tool"), true);
    assert.equal((incremental.messages as MessageLike[]).some(
      (message) => message._turnTapeId === continuation.finalize.tapeId &&
        message._timelineAuxiliary === "bash-tail" && message._runtimeEvent !== undefined,
    ), true, "refresh returns exact hidden tail evidence, not a synthetic visible patch");
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

      const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
      assert.ok(timeline);
      const timelineMessages = timeline.messages as MessageLike[];
      assert.equal(timelineMessages.filter((message) => message._runtimeEvent !== undefined).length, 0,
        "opaque runtime batches remain exact in the audit view but never become browser cards");
      const visibleAnswer = timelineMessages.find((message) => message.role === "assistant");
      assert.equal(visibleAnswer?.text, "visible answer");
      assert.equal(timelineMessages.some((message) => message._turnTapeProcess === true), false);
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

describe("durable turn dispatch(RFC §2.1 受理 / §2.4 收敛 / §2.5 状态展示 / §7.9 late tape)", () => {
  const UID = 9n;
  const CUSER = "c:9";

  function admitInput(over: Partial<Parameters<PgSessionsBackend["admitUserTurn"]>[0]> = {}) {
    const cmid = (over.clientMessageId as string | undefined) ?? "cm-dd-1";
    return {
      uid: UID,
      sessionUserId: CUSER,
      sessionId: "s-dd-admit-1",
      clientMessageId: cmid,
      agentId: "main",
      model: "gpt-5.6-sol",
      requestHash: "h".repeat(64),
      billingRequestId: `brq-${cmid}`,
      dispatchId: randomUUID(),
      ownerId: "conn-A",
      message: { id: cmid, role: "user", text: "hi", ts: 1_783_950_000_000 } as MessageLike & { id: string },
      ...over,
    };
  }

  maybe("受理冲突表:fresh admitted → 同键 lease 活 already_owned → 异 hash immutable_conflict → 终态 completed dedup", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-dd-admit-1", userId: CUSER }));
    const fresh = await backend.admitUserTurn(admitInput());
    assert.equal(fresh.kind, "admitted");
    const d0 = (fresh as { dispatch: { dispatchId: string; anchorSeq: bigint | null } }).dispatch;
    assert.ok(d0.anchorSeq !== null, "受理事务内应带回 user 行 anchorSeq");
    // user 行已幂等落库(受理与 append 同事务)。
    const sess = await backend.getClientSession("s-dd-admit-1", CUSER);
    assert.ok(sess!.messages.some((m) => (m as { id?: string }).id === "cm-dd-1"));
    // 同键 lease 活 → already_owned(不开第二条执行)。
    const dup = await backend.admitUserTurn(admitInput({ dispatchId: randomUUID() }));
    assert.equal(dup.kind, "already_owned");
    // 同键异 hash → immutable_conflict(同 id 不同内容拒)。
    const mut = await backend.admitUserTurn(
      admitInput({ dispatchId: randomUUID(), requestHash: "x".repeat(64) }),
    );
    assert.equal(mut.kind, "immutable_conflict");
    // 终态 completed 后同键 → deduplicated(既有 outbound.ack 语义)。
    await casToTerminal(pool, { dispatchId: d0.dispatchId, outcome: "completed" });
    const dd = await backend.admitUserTurn(admitInput({ dispatchId: randomUUID() }));
    assert.equal(dd.kind, "deduplicated");
  });

  maybe("verified status atomically invalidates unified cursors and stays immediately after its skewed user", async () => {
    const sessionId = "s-dd-visible-status";
    const clientMessageId = "cm-dd-visible-status";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId: CUSER }));
    const admitted = await backend.admitUserTurn(admitInput({
      sessionId,
      clientMessageId,
      message: {
        id: clientMessageId,
        role: "user",
        text: "future-clock user",
        // Deliberately newer than the server terminal clock. Durable order,
        // not clock skew, must place the verified status after this row.
        ts: 9_000_000_000_000,
      } as MessageLike & { id: string },
    }));
    assert.equal(admitted.kind, "admitted");
    const dispatch = (admitted as { dispatch: { dispatchId: string } }).dispatch;

    const raw = (
      await pool.query<{ messages: string; next_seq: number }>(
        "SELECT messages,next_seq FROM client_sessions WHERE id=$1 AND user_id=$2",
        [sessionId, CUSER],
      )
    ).rows[0]!;
    const messages = JSON.parse(raw.messages) as MessageLike[];
    for (let seq = raw.next_seq; seq < raw.next_seq + 130; seq++) {
      messages.push({
        id: `status-tail-${seq}`,
        role: "assistant",
        text: `tail ${seq}`,
        ts: seq,
        _source: "server",
        _seq: seq,
        _orderSeq: seq,
      });
    }
    await pool.query(
      `UPDATE client_sessions
          SET messages=$3,message_count=$4,next_seq=$5,last_at=$6,updated_at=updated_at+1
        WHERE id=$1 AND user_id=$2`,
      [
        sessionId,
        CUSER,
        JSON.stringify(messages),
        messages.length,
        raw.next_seq + 130,
        raw.next_seq + 129,
      ],
    );
    assert.ok(await casToTerminal(pool, {
      dispatchId: dispatch.dispatchId,
      outcome: "executed_error",
      failureCode: "RESULT_RECOVERY_PENDING",
      clientNotified: false,
    }));

    const before = await backend.readClientTimelinePage(sessionId, CUSER, null, 100);
    assert.ok(before?.nextCursor, "long real timeline must issue an older-page cursor");
    const identityBefore = (
      await pool.query<{ history_revision: string; timeline_generation: string }>(
        "SELECT history_revision::text,timeline_generation::text FROM client_sessions WHERE id=$1 AND user_id=$2",
        [sessionId, CUSER],
      )
    ).rows[0]!;

    const counts = await runReconcileTick({
      pool,
      container: {
        rejectIfAbsent: async () => ({ kind: "unreachable" as const, detail: "not used" }),
        getDispatchState: async () => ({ kind: "unreachable" as const, detail: "not used" }),
      },
      assessBilling: async () => "not_billed",
      now: () => Date.now(),
    });
    assert.equal(counts.visibleFailures, 1);
    assert.equal(counts.notified, 1);

    const identityAfter = (
      await pool.query<{ history_revision: string; timeline_generation: string }>(
        "SELECT history_revision::text,timeline_generation::text FROM client_sessions WHERE id=$1 AND user_id=$2",
        [sessionId, CUSER],
      )
    ).rows[0]!;
    assert.equal(BigInt(identityAfter.history_revision), BigInt(identityBefore.history_revision) + 1n);
    assert.equal(BigInt(identityAfter.timeline_generation), BigInt(identityBefore.timeline_generation) + 1n);
    await assert.rejects(
      backend.readClientTimelinePage(sessionId, CUSER, before!.nextCursor, 100),
      { name: "ClientTimelineCursorStaleError" },
    );

    let cursor: ClientTimelineCursor | null = null;
    let hasMore = true;
    const all: MessageLike[] = [];
    while (hasMore) {
      const page = await backend.readClientTimelinePage(sessionId, CUSER, cursor, 100);
      assert.ok(page);
      all.unshift(...page.messages);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }
    const userIndex = all.findIndex((message) => message.id === clientMessageId);
    const statusIndex = all.findIndex((message) => message.id === `turn-status:${dispatch.dispatchId}`);
    assert.equal(statusIndex, userIndex + 1);
    assert.equal(all[userIndex]!._orderSeq, all[statusIndex]!._orderSeq);
    assert.equal(all[statusIndex]!._timelineLogicalOrdinal, 1);
    assert.ok((all[userIndex]!.ts ?? 0) > (all[statusIndex]!.ts ?? 0),
      "clock skew fixture must prove timestamp sorting would have been wrong");

    const second = await runReconcileTick({
      pool,
      container: {
        rejectIfAbsent: async () => ({ kind: "unreachable" as const, detail: "not used" }),
        getDispatchState: async () => ({ kind: "unreachable" as const, detail: "not used" }),
      },
      assessBilling: async () => "not_billed",
    });
    assert.equal(second.visibleFailures, 0);
    const identityReplay = (
      await pool.query<{ timeline_generation: string }>(
        "SELECT timeline_generation::text FROM client_sessions WHERE id=$1 AND user_id=$2",
        [sessionId, CUSER],
      )
    ).rows[0]!;
    assert.equal(identityReplay.timeline_generation, identityAfter.timeline_generation);
  });

  maybe("超 4 MiB 用户消息受理为精确侧车:热行恒小、范围读无损、模型上下文仍取真实文本", async () => {
    const sessionId = "s-dd-large-user";
    const clientMessageId = "cm-dd-large-user";
    const text = `LARGE-USER-HEAD\n${"超长用户真实正文😀".repeat(300_000)}\nLARGE-USER-TAIL`;
    assert.ok(Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId: CUSER }));
    const admitted = await backend.admitUserTurn(admitInput({
      sessionId,
      clientMessageId,
      requestHash: sha256(text),
      message: {
        id: clientMessageId,
        role: "user",
        text,
        _modelText: "MODEL-VISIBLE-EXACT-PROMPT",
        ts: 1_783_950_000_123,
        _media: [{ kind: "image", url: "/api/media/guide.png" }],
        _retryMedia: [
          { kind: "image", url: "/api/media/source.png", hidden: true },
          { kind: "image", url: "/api/media/guide.png" },
        ],
        _imageEdit: {
          clientJobId: "a".repeat(32),
          sourceIndex: 0,
          guideIndex: 1,
          width: 100,
          height: 80,
        },
        _routing: { model: "gpt-5.6-sol", teamMode: true, effortLevel: "high" },
        _sendAttempt: 2,
      } as MessageLike & { id: string },
    }));
    assert.equal(admitted.kind, "admitted");

    const hot = await pool.query<{ messages: string }>(
      "SELECT messages FROM client_sessions WHERE id=$1 AND user_id=$2",
      [sessionId, CUSER],
    );
    assert.ok(Buffer.byteLength(hot.rows[0]!.messages, "utf8") < 32 * 1024);
    const locator = (JSON.parse(hot.rows[0]!.messages) as MessageLike[])[0]!;
    assert.equal(locator.id, clientMessageId);
    assert.equal(locator.text, "");
    assert.equal(locator._payloadDeferred, true);
    assert.equal(locator._userPayloadDeferred, true);
    assert.equal(locator._userPayloadId, clientMessageId);
    assert.deepEqual(locator._routing, {
      model: "gpt-5.6-sol",
      teamMode: true,
      effortLevel: "high",
    });
    assert.equal(locator._sendAttempt, 2);
    assert.equal(locator._deferredRetryEligible, true);
    assert.equal(locator._media, undefined);
    assert.equal(locator._retryMedia, undefined);
    assert.equal(locator._imageEdit, undefined);
    assert.equal(locator._modelText, undefined);
    assert.ok(typeof locator._payloadBytes === "number" && locator._payloadBytes > 4 * 1024 * 1024);

    const metadata = await backend.readUserMessagePayload(
      sessionId, CUSER, clientMessageId, 0, 0,
    );
    assert.ok(metadata);
    assert.equal(metadata.payload.length, 0);
    assert.equal(metadata.totalBytes, locator._payloadBytes);
    assert.equal(metadata.contentSha256, locator._payloadSha256);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < metadata.totalBytes; offset += 1024 * 1024) {
      const chunk = await backend.readUserMessagePayload(
        sessionId,
        CUSER,
        clientMessageId,
        offset,
        Math.min(1024 * 1024, metadata.totalBytes - offset),
      );
      assert.ok(chunk);
      assert.equal(chunk.offset, offset);
      chunks.push(chunk.payload);
    }
    const raw = Buffer.concat(chunks);
    assert.equal(raw.length, metadata.totalBytes);
    assert.equal(sha256(raw), metadata.contentSha256);
    const decoded = JSON.parse(raw.toString("utf8")) as MessageLike;
    assert.equal(decoded.id, clientMessageId);
    assert.equal(decoded.role, "user");
    assert.equal(decoded.text, text);
    assert.equal(decoded._modelText, "MODEL-VISIBLE-EXACT-PROMPT");
    assert.equal(decoded._source, "server");
    assert.deepEqual(decoded._retryMedia, [
      { kind: "image", url: "/api/media/source.png", hidden: true },
      { kind: "image", url: "/api/media/guide.png" },
    ]);
    assert.deepEqual(decoded._imageEdit, {
      clientJobId: "a".repeat(32),
      sourceIndex: 0,
      guideIndex: 1,
      width: 100,
      height: 80,
    });
    assert.deepEqual(decoded._routing, {
      model: "gpt-5.6-sol",
      teamMode: true,
      effortLevel: "high",
    });
    assert.equal(
      await backend.readUserMessagePayload(sessionId, "c:8", clientMessageId),
      null,
    );

    const modelContext = await backend.getEngineContextMessages(sessionId, CUSER, {
      contextWindow: null,
    });
    assert.equal(modelContext?.length, 1);
    assert.equal(modelContext?.[0]?.role, "user");
    assert.equal(modelContext?.[0]?.text, "MODEL-VISIBLE-EXACT-PROMPT");
    assert.equal((modelContext?.[0] as MessageLike)._userPayloadDeferred, undefined);
  });

  maybe("tape-state 单 statement 同时返回租户内 tape + dispatch lease 证据", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-dd-lease-1", userId: CUSER }));
    const admitted = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-lease-1", clientMessageId: "cm-dd-lease-1" }),
    );
    assert.equal(admitted.kind, "admitted");
    const dispatch = (admitted as {
      dispatch: { dispatchId: string; leaseEpoch: number };
    }).dispatch;

    const fresh = await backend.getTurnTapeStateByDispatch(CUSER, dispatch.dispatchId, 1);
    assert.deepEqual(fresh, { state: "none", status: null, dispatchLeaseActive: true });
    assert.deepEqual(
      await backend.getTurnTapeStateByDispatch("c:8", dispatch.dispatchId, 1),
      { state: "none", status: null, dispatchLeaseActive: false },
      "错误租户不能观察 lease",
    );
    assert.deepEqual(
      await backend.getTurnTapeStateByDispatch(CUSER, dispatch.dispatchId, 2),
      { state: "none", status: null, dispatchLeaseActive: false },
      "attemptNo 必须同样参与 lease scope",
    );

    assert.ok(await casAdmittedToAccepted(pool, {
      dispatchId: dispatch.dispatchId,
      expectedEpoch: dispatch.leaseEpoch,
    }));
    assert.equal(
      (await backend.getTurnTapeStateByDispatch(CUSER, dispatch.dispatchId, 1))
        .dispatchLeaseActive,
      true,
      "accepted 行在短租约有效期内仍是 secondary fence",
    );

    await pool.query(
      "UPDATE turn_dispatches SET lease_until = statement_timestamp() - interval '1 second' WHERE dispatch_id = $1",
      [dispatch.dispatchId],
    );
    assert.equal(
      (await backend.getTurnTapeStateByDispatch(CUSER, dispatch.dispatchId, 1))
        .dispatchLeaseActive,
      false,
      "过期 lease 不再延后恢复",
    );

    await backend.upsertClientSession(mkSession({ id: "s-dd-lease-2", userId: CUSER }));
    const rejectingAdmit = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-lease-2", clientMessageId: "cm-dd-lease-2" }),
    );
    assert.equal(rejectingAdmit.kind, "admitted");
    const rejectingDispatch = (rejectingAdmit as {
      dispatch: { dispatchId: string; leaseEpoch: number };
    }).dispatch;
    assert.ok(await casAdmittedToRejecting(pool, {
      dispatchId: rejectingDispatch.dispatchId,
      expectedEpoch: rejectingDispatch.leaseEpoch,
      ownerId: "reconciler-test",
    }));
    assert.equal(
      (await backend.getTurnTapeStateByDispatch(CUSER, rejectingDispatch.dispatchId, 1))
        .dispatchLeaseActive,
      false,
      "rejecting 不属于 lease-active open execution set",
    );
  });

  maybe("受理即建行(PUT-vs-WS 竞态根治):无预建行 admitted;ensure PUT 后到 rejected_stale;墓碑/他人行不动", async () => {
    // ① 无预建行(前端 ensure PUT 尚未到达,2026-07-18 线上新会话首条消息必失败根因):
    //    受理事务自建行 → admitted,user 行与 anchorSeq 同事务落地。
    const fresh = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-race-1", clientMessageId: "cm-dd-race-1" }),
    );
    assert.equal(fresh.kind, "admitted");
    assert.ok((fresh as { dispatch: { anchorSeq: bigint | null } }).dispatch.anchorSeq !== null);
    const sess = await backend.getClientSession("s-dd-race-1", CUSER);
    assert.ok(sess);
    assert.equal(sess.agentId, "main");
    assert.equal(sess.title, "新会话");
    assert.ok(sess.messages.some((m) => (m as { id?: string }).id === "cm-dd-race-1"));
    // ② 后到的 ensure PUT(messages:[]、baseSyncedAt=0)→ rejected_stale 空操作,user 行不丢。
    const late = await backend.upsertClientSession(
      mkSession({ id: "s-dd-race-1", userId: CUSER, updatedAt: 0 }),
      0,
    );
    assert.equal(late, "rejected_stale");
    const after = await backend.getClientSession("s-dd-race-1", CUSER);
    assert.ok(after!.messages.some((m) => (m as { id?: string }).id === "cm-dd-race-1"));
    // ③ 墓碑不复活:已删会话受理仍 session_deleted。
    await backend.upsertClientSession(mkSession({ id: "s-dd-race-2", userId: CUSER }));
    await backend.deleteClientSession("s-dd-race-2", CUSER);
    const tomb = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-race-2", clientMessageId: "cm-dd-race-2" }),
    );
    assert.equal(tomb.kind, "session_deleted");
    // ④ 同 id 他人行不劫持:受理 session_not_found,原行归属不变。
    await backend.upsertClientSession(mkSession({ id: "s-dd-race-3", userId: "c:8" }));
    const foreign = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-race-3", clientMessageId: "cm-dd-race-3" }),
    );
    assert.equal(foreign.kind, "session_not_found");
    const owner = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM client_sessions WHERE id = 's-dd-race-3'",
    );
    assert.equal(owner.rows[0]!.user_id, "c:8");
  });

  maybe("⓪ 会话亡自动结案:墓碑会话的 open dispatch 入扫描并可结案;活会话不误伤", async () => {
    // 墓碑路径:admit(短租约)→ 删会话 → scanOpenSessionGone 捞出 → manual(session_deleted)+机器 resolution。
    await backend.upsertClientSession(mkSession({ id: "s-dd-gone-1", userId: CUSER }));
    const admit = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-gone-1", clientMessageId: "cm-dd-gone-1", leaseTtlMs: 1 }),
    );
    assert.equal(admit.kind, "admitted");
    const d = (admit as { dispatch: { dispatchId: string } }).dispatch;
    await backend.deleteClientSession("s-dd-gone-1", CUSER);
    const future = Date.now() + 5_000; // 租约(1ms TTL)必已过期
    const rows = await scanOpenSessionGone(pool, { minAgeMs: 0, limit: 50, now: future });
    assert.ok(rows.some((r) => r.dispatchId === d.dispatchId), "墓碑会话的 open dispatch 应入扫描");
    const held = await casToManualReconcile(pool, {
      dispatchId: d.dispatchId,
      conflictReason: "session_deleted",
      fromStatuses: ["admitted", "accepted", "rejecting"],
    });
    assert.ok(held);
    assert.ok(await resolveManualReconcile(pool, { dispatchId: d.dispatchId, resolution: "auto_closed:session_deleted" }));
    const after = await getDispatch(pool, d.dispatchId);
    assert.equal(after!.status, "manual_reconcile");
    assert.equal(after!.resolution, "auto_closed:session_deleted");
    // 已结案 → 不再入扫描(status 出 open 三态)。
    const again = await scanOpenSessionGone(pool, { minAgeMs: 0, limit: 50, now: future });
    assert.ok(!again.some((r) => r.dispatchId === d.dispatchId));
    // 活会话不误伤:同样短租约过期,但会话未删 → 不入扫描(交 ① 分支容器求证)。
    await backend.upsertClientSession(mkSession({ id: "s-dd-gone-2", userId: CUSER }));
    const admit2 = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-gone-2", clientMessageId: "cm-dd-gone-2", leaseTtlMs: 1 }),
    );
    assert.equal(admit2.kind, "admitted");
    const d2 = (admit2 as { dispatch: { dispatchId: string } }).dispatch;
    const live = await scanOpenSessionGone(pool, { minAgeMs: 0, limit: 50, now: future });
    assert.ok(!live.some((r) => r.dispatchId === d2.dispatchId), "活会话的 dispatch 不得被会话亡臂误伤");
  });

  maybe("finalize 收敛(§2.4):tape header 带 dispatch 身份 → dispatch terminal(outcome=tape.status)", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-dd-conv-2", userId: CUSER }));
    const admit = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-conv-2", clientMessageId: "cm-dd-2" }),
    );
    assert.equal(admit.kind, "admitted");
    const d = (admit as { dispatch: { dispatchId: string } }).dispatch;
    const tape = buildTape({
      sessionId: "s-dd-conv-2", agentId: "main", turnIndex: 1, status: "completed",
      turnKey: "a".repeat(64), text: "回复正文", createdAt: 1_783_950_100_000,
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(CUSER, part.request, part.bytes, {
        dispatchId: d.dispatchId, attemptNo: 1,
      });
    }
    assert.equal((await backend.finalizeLosslessTurnTape(CUSER, tape.finalize)).applied, "finalized");
    const row = await getDispatch(pool, d.dispatchId);
    assert.equal(row!.status, "terminal");
    assert.equal(row!.outcome, "completed");
    // tape 三态查询(容器 boot recovery 契约):finalized + 精确 status(M1)。
    const tapeState = await backend.getTurnTapeStateByDispatch(CUSER, d.dispatchId, 1);
    assert.equal(tapeState.state, "finalized");
    assert.equal(tapeState.status, "completed");
    assert.equal(tapeState.dispatchLeaseActive, false);
  });

  for (const tapeStatus of ["completed", "interrupted", "crashed"] as const) {
    maybe(`recovery sentinel + late ${tapeStatus} tape → timeline removes placeholder and keeps real outcome`, async () => {
      const suffix = tapeStatus.slice(0, 4);
      const sessionId = `s-dd-recovery-${suffix}`;
      const clientMessageId = `cm-dd-recovery-${suffix}`;
      await backend.upsertClientSession(mkSession({ id: sessionId, userId: CUSER }));
      const admit = await backend.admitUserTurn(
        admitInput({ sessionId, clientMessageId }),
      );
      assert.equal(admit.kind, "admitted");
      const d = (admit as { dispatch: { dispatchId: string } }).dispatch;
      assert.ok(await casToTerminal(pool, {
        dispatchId: d.dispatchId,
        outcome: "executed_error",
        failureCode: "RESULT_RECOVERY_PENDING",
        clientNotified: true,
      }));
      const before = await backend.getClientSession(sessionId, CUSER, { view: "timeline" });
      assert.ok(before!.messages.some((m) => (m as MessageLike)._turnStatusRecord === true));

      const tape = buildTape({
        sessionId,
        agentId: "main",
        turnIndex: 1,
        status: tapeStatus,
        turnKey: createHash("sha256").update(tapeStatus).digest("hex"),
        text: `real ${tapeStatus} transcript`,
        createdAt: 1_783_950_150_000,
      });
      for (const part of tape.parts) {
        await backend.stageLosslessTurnTapePart(CUSER, part.request, part.bytes, {
          dispatchId: d.dispatchId,
          attemptNo: 1,
        });
      }
      assert.equal(
        (await backend.finalizeLosslessTurnTape(CUSER, tape.finalize)).applied,
        "finalized",
      );
      const row = await getDispatch(pool, d.dispatchId);
      assert.equal(row!.status, "terminal");
      assert.equal(row!.outcome, tapeStatus);
      assert.equal(row!.failureCode, null);
      assert.equal(row!.clientNotified, false);
      const after = await backend.getClientSession(sessionId, CUSER, { view: "timeline" });
      assert.ok(!after!.messages.some((m) => (m as MessageLike)._turnStatusRecord === true));
      const finalRecord = (after!.messages as MessageLike[]).find((m) => m.role === "assistant");
      assert.equal(finalRecord?.text, `real ${tapeStatus} transcript`);
      assert.equal(finalRecord?._timelineRecord, true);
    });
  }

  maybe("late tape(§7.9):verified failure → true tape finalize moves dispatch to manual and timeline shows only truth", async () => {
    await backend.upsertClientSession(mkSession({ id: "s-dd-late-3", userId: CUSER }));
    const admit = await backend.admitUserTurn(
      admitInput({ sessionId: "s-dd-late-3", clientMessageId: "cm-dd-3" }),
    );
    const d = (admit as { dispatch: { dispatchId: string; anchorSeq: bigint | null } }).dispatch;
    // reconciler 误判路径:terminal(not_accepted) 且同事务 no-billing proof 已完成。
    await casToTerminal(pool, {
      dispatchId: d.dispatchId, outcome: "not_accepted", failureCode: "dispatch_lost",
    });
    await pool.query(
      "UPDATE turn_dispatches SET client_notified=TRUE WHERE dispatch_id=$1",
      [d.dispatchId],
    );
    const revisionBefore = BigInt((await pool.query<{ history_revision: string }>(
      "SELECT history_revision FROM client_sessions WHERE id = $1 AND user_id = $2",
      ["s-dd-late-3", CUSER],
    )).rows[0]!.history_revision);
    // Browser timeline reads the durable status directly; exact engine context
    // never receives this UI status record.
    const timelineRead = await backend.getClientSession("s-dd-late-3", CUSER, { view: "timeline" });
    assert.ok(timelineRead!.messages.some((m) => (m as MessageLike)._turnStatusRecord === true));
    const exactRead = await backend.getClientSession("s-dd-late-3", CUSER);
    assert.ok(!exactRead!.messages.some((m) => (m as MessageLike)._turnStatusRecord === true));
    // late true tape arrives:materialize all immutable records + move the
    // dispatch to manual_reconcile in the same transaction.
    const tape = buildTape({
      sessionId: "s-dd-late-3", agentId: "main", turnIndex: 1, status: "completed",
      turnKey: "b".repeat(64), text: "迟到的真回复", createdAt: 1_783_950_200_000,
    });
    for (const part of tape.parts) {
      await backend.stageLosslessTurnTapePart(CUSER, part.request, part.bytes, {
        dispatchId: d.dispatchId, attemptNo: 1,
      });
    }
    assert.equal((await backend.finalizeLosslessTurnTape(CUSER, tape.finalize)).applied, "finalized");
    const revisionAfter = BigInt((await pool.query<{ history_revision: string }>(
      "SELECT history_revision FROM client_sessions WHERE id = $1 AND user_id = $2",
      ["s-dd-late-3", CUSER],
    )).rows[0]!.history_revision);
    assert.equal(revisionAfter, revisionBefore + 1n, "removing the previously visible status advances absence revision");
    assert.equal((await backend.finalizeLosslessTurnTape(CUSER, tape.finalize)).applied, "idempotent");
    const revisionAfterReplay = BigInt((await pool.query<{ history_revision: string }>(
      "SELECT history_revision FROM client_sessions WHERE id = $1 AND user_id = $2",
      ["s-dd-late-3", CUSER],
    )).rows[0]!.history_revision);
    assert.equal(revisionAfterReplay, revisionAfter, "幂等 replay 不得重复推进 revision");
    const row = await getDispatch(pool, d.dispatchId);
    assert.equal(row!.status, "manual_reconcile");
    assert.equal(row!.conflictReason, "late_tape");
    const after = await backend.getClientSession("s-dd-late-3", CUSER, { view: "timeline" });
    assert.ok(!after!.messages.some((m) => (m as MessageLike)._turnStatusRecord === true),
      "late truth removes the stale failure status from the browser timeline");
    const finalRecord = (after!.messages as MessageLike[]).find((m) => m.role === "assistant");
    assert.equal(finalRecord?.text, "迟到的真回复");
    assert.equal(finalRecord?._timelineRecord, true);
  });
});

// ── Direct immutable timeline + lazy tape paging ─────────────────────────────
function directTape(
  sessionId: string,
  turnKey: string,
  over: {
    text?: string;
    createdAt?: number;
    clientMessageId?: string;
    tools?: Array<Record<string, unknown>>;
    thinkingText?: string;
    thinkingSegments?: Array<{ index: number; text: string; ts: number; eventOrdinal?: number }>;
    runtimeEvents?: Array<{
      ordinal: number;
      observedAt: number;
      source: "ccb" | "codex-jsonrpc" | "gateway";
      payload: unknown;
    }>;
    agentGroups?: Array<Record<string, unknown>>;
    structuredBlocks?: Array<Record<string, unknown>>;
    assistantSegments?: Array<{ index: number; text: string; ts: number; eventOrdinal?: number }>;
    turnIndex?: number;
  } = {},
) {
  return buildTape({
    sessionId,
    agentId: "main",
    turnIndex: over.turnIndex ?? 1,
    status: "completed",
    turnKey,
    text: over.text ?? "最终回答",
    createdAt: over.createdAt ?? 1_783_944_000_000,
    usage: { inputTokens: 1, outputTokens: 2 },
    ...(over.clientMessageId !== undefined ? { clientMessageId: over.clientMessageId } : {}),
    ...(over.tools !== undefined ? { tools: over.tools } : {}),
    ...(over.thinkingText !== undefined ? { thinkingText: over.thinkingText } : {}),
    ...(over.thinkingSegments !== undefined ? { thinkingSegments: over.thinkingSegments } : {}),
    ...(over.runtimeEvents !== undefined ? { runtimeEvents: over.runtimeEvents } : {}),
    ...(over.agentGroups !== undefined ? { agentGroups: over.agentGroups } : {}),
    ...(over.structuredBlocks !== undefined ? { structuredBlocks: over.structuredBlocks } : {}),
    ...(over.assistantSegments !== undefined ? { assistantSegments: over.assistantSegments } : {}),
  });
}

async function stageAndFinalize(userId: string, tape: ReturnType<typeof buildTape>): Promise<void> {
  for (const part of tape.parts) {
    await backend.stageLosslessTurnTapePart(userId, part.request, part.bytes);
  }
  const result = await backend.finalizeLosslessTurnTape(userId, tape.finalize);
  assert.equal(result.applied, "finalized");
}

async function readDeferredRecord(
  sessionId: string,
  userId: string,
  tapeId: string,
  locator: MessageLike,
): Promise<MessageLike> {
  assert.equal(locator._payloadDeferred, true);
  assert.ok(typeof locator._recordOrdinal === "number");
  const payload = await backend.readTapeRecordPayload(
    sessionId,
    userId,
    tapeId,
    locator._recordOrdinal,
  );
  assert.ok(payload);
  return JSON.parse(payload.payload.toString("utf8")) as MessageLike;
}

function browserVisibleTimeline(messages: MessageLike[]): MessageLike[] {
  return messages.filter((message) =>
    message._timelineAuxiliary === undefined && message.role !== "runtime-event");
}

describe("pgSessionsBackend direct turn timeline", () => {
  maybe("engine context hydrates real tape-backed tool, plan, goal and delegate facts", async () => {
    const sessionId = "s-direct-engine-semantic";
    const userId = "u-direct-engine-semantic";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "e".repeat(64), {
      text: "final answer after completed work",
      thinkingText: "private chain of thought",
      tools: [{
        blockId: "tool-semantic-1",
        toolName: "Bash",
        inputJson: { command: "cat result.txt" },
        output: "EXACT-TAPE-TOOL-RESULT",
        completed: true,
      }],
      agentGroups: [{
        runId: "delegate-semantic-1",
        agentId: "coder",
        goal: "review implementation",
        status: "ok",
        completedAt: 1_783_944_000_010,
        resultSummary: "EXACT-TAPE-DELEGATE-SUMMARY",
        transcript: [{ kind: "text", text: "EXACT-TAPE-DELEGATE-RESULT" }],
      }],
      structuredBlocks: [
        { kind: "plan", blockId: "plan-semantic", text: "release plan", steps: [{ step: "deploy", status: "completed" }] },
        { kind: "goal", blockId: "goal-semantic", objective: "ship exact history", status: "complete" },
      ],
    });
    await stageAndFinalize(userId, tape);

    const context = await backend.getEngineContextMessages(sessionId, userId);
    assert.ok(context);
    assert.deepEqual(
      context.map((message) => message.role),
      ["tool", "assistant", "goal", "plan", "agent-group"],
    );
    assert.equal(context.some((message) => message.role === "thinking"), false);
    assert.equal(context.find((message) => message.role === "tool")?.output, "EXACT-TAPE-TOOL-RESULT");
    assert.equal(
      (context.find((message) => message.role === "agent-group")?.childBlocks as Array<{ text?: string }>)[0]?.text,
      "EXACT-TAPE-DELEGATE-RESULT",
    );
  });

  maybe("finite engine context lazily rebuilds predecessor model rows in bounded batches", async () => {
    const sessionId = "s-direct-engine-predecessor";
    const userId = "u-direct-engine-predecessor";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "d".repeat(64), {
      text: "predecessor final answer",
      tools: [{
        blockId: "predecessor-tool",
        toolName: "Bash",
        inputJson: { command: "printf exact" },
        output: "PREDECESSOR-EXACT-TOOL-OUTPUT",
        completed: true,
      }],
    });
    await stageAndFinalize(userId, tape);
    await pool.query(
      `DELETE FROM client_session_turn_tape_model_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [sessionId, userId, tape.finalize.tapeId],
    );
    await pool.query(
      `UPDATE client_session_turn_tape_records
          SET model_sidecar_complete=FALSE
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [sessionId, userId, tape.finalize.tapeId],
    );
    await pool.query(
      `UPDATE client_session_turn_tapes SET model_record_count=-1
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [sessionId, userId, tape.finalize.tapeId],
    );

    const context = await backend.getEngineContextMessages(sessionId, userId, {
      contextWindow: 2_000,
    });
    assert.ok(context);
    assert.deepEqual(context.map((message) => message.role), ["tool", "assistant"]);
    assert.match(String(context[0]?.text), /PREDECESSOR-EXACT-TOOL-OUTPUT/);
    assert.equal(context[1]?.text, "predecessor final answer");
    const state = (
      await pool.query<{
        model_record_count: number;
        incomplete: string;
        sidecars: string;
      }>(
        `SELECT t.model_record_count,
                (SELECT COUNT(*)::text FROM client_session_turn_tape_records r
                  WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id
                    AND r.model_sidecar_complete=FALSE) AS incomplete,
                (SELECT COUNT(*)::text FROM client_session_turn_tape_model_records m
                  WHERE m.session_id=t.session_id AND m.user_id=t.user_id AND m.tape_id=t.tape_id)
                  AS sidecars
           FROM client_session_turn_tapes t
          WHERE t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3`,
        [sessionId, userId, tape.finalize.tapeId],
      )
    ).rows[0]!;
    assert.equal(state.incomplete, "0");
    assert.equal(state.model_record_count, Number(state.sidecars));
  });

  maybe("0176 is metadata-only for the large record table and tolerates legal escaped NUL history", async () => {
    assert.deepEqual(migration0176EscapedNulBackfill, {
      physical_record_count: 0,
      logical_record_count: 0,
      record_payload_bytes: "0",
    });
    const sql = await readFile(MIGRATION_0176, { encoding: "utf8" });
    assert.doesNotMatch(sql, /FROM\s+client_session_turn_tape_records/i);
  });

  maybe("engine context reads archive plus hot narrative with no fixed row ceiling", async () => {
    const sessionId = "s-engine-context-complete-history";
    const userId = "u-engine-context-complete-history";
    const archived = Array.from({ length: 60 }, (_, index) => ({
      id: `archive-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `archived narrative ${index + 1}`,
      _seq: index + 1,
    }));
    const hot = Array.from({ length: 25 }, (_, index) => ({
      id: `hot-${index + 61}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `hot narrative ${index + 61}`,
      _seq: index + 61,
    }));
    await pool.query(
      `INSERT INTO client_sessions
         (id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
          updated_at,next_seq,archived_through_seq,archived_count)
       VALUES ($1,$2,'main','long context',0,1,85,$3,85,85,86,60,60)`,
      [sessionId, userId, JSON.stringify(hot)],
    );
    await pool.query(
      `INSERT INTO client_session_archive_chunks
         (session_id,user_id,first_seq,last_seq,message_count,messages,created_at)
       VALUES ($1,$2,1,60,60,$3,1)`,
      [sessionId, userId, JSON.stringify(archived)],
    );

    const context = await backend.getEngineContextMessages(sessionId, userId);
    assert.ok(context);
    assert.equal(context.length, 85);
    assert.equal(context[0]?.id, "archive-1");
    assert.equal(context[59]?.id, "archive-60");
    assert.equal(context.at(-1)?.id, "hot-85");
  });

  maybe("0176 leaves legacy tables inert so the predecessor remains runnable during rollout", async () => {
    const tables = await pool.query<{ chat: string | null; failures: string | null }>(
      `SELECT to_regclass('tape_chat_projection')::text AS chat,
              to_regclass('turn_dispatch_error_projections')::text AS failures`,
    );
    assert.deepEqual(tables.rows[0], {
      chat: "tape_chat_projection",
      failures: "turn_dispatch_error_projections",
    });
  });

  maybe("a predecessor finalizer racing 0176 is readable even when new header counters remain zero", async () => {
    const sessionId = "s-direct-migration-race";
    const userId = "u-direct-migration-race";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "6".repeat(64), {
      clientMessageId: "cm-migration-race",
      thinkingText: "race thinking",
      text: "race final exact",
    });
    await stageAndFinalize(userId, tape);
    await pool.query(
      `UPDATE client_session_turn_tapes
          SET physical_record_count=0, logical_record_count=0, record_payload_bytes=0
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [sessionId, userId, tape.finalize.tapeId],
    );

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(timeline);
    const raceFinal = (timeline.messages as MessageLike[]).find(
      (message) => message.role === "assistant",
    );
    assert.equal(raceFinal?.text, "race final exact");
    assert.equal((timeline.messages as MessageLike[]).find(
      (message) => message.role === "thinking")?.text, "race thinking");
    assert.equal((timeline.messages as MessageLike[]).some(
      (message) => message._turnTapeProcess === true), false);
    assert.equal(
      await backend.hasCompletedClientTurn(sessionId, userId, "cm-migration-race"),
      true,
    );
  });

  maybe("unified timeline returns every latest semantic record directly and pages older physical units exactly once", async () => {
    const sessionId = "s-direct-timeline-truth";
    const userId = "u-direct-timeline-truth";
    const turnKey = "1".repeat(64);
    await backend.upsertClientSession(mkSession({
      id: sessionId,
      userId,
      messages: [{ id: "cm-direct-truth", role: "user", text: "继续", ts: 1_783_943_999_999 }],
    }));
    const tape = directTape(sessionId, turnKey, {
      clientMessageId: "cm-direct-truth",
      thinkingText: "逐步分析真实内容",
      thinkingSegments: [{
        index: 0,
        text: "逐步分析真实内容",
        ts: 1_783_944_000_000,
        eventOrdinal: 1,
      }],
      tools: [{
        blockId: "tool-truth",
        toolName: "Bash",
        inputJson: { command: "printf truth" },
        output: "真实工具输出",
        completed: true,
        eventOrdinal: 2,
      }],
      runtimeEvents: [{
        ordinal: 7,
        observedAt: 1_783_944_000_001,
        source: "gateway",
        payload: { type: "progress", exact: "真实运行事件" },
      }],
      text: "这是 Agent 的真实最终回答",
    });
    await stageAndFinalize(userId, tape);

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(timeline);
    const initial = timeline.messages as MessageLike[];
    const initialVisible = browserVisibleTimeline(initial);
    assert.deepEqual(initialVisible.map((message) => message.role), [
      "user", "thinking", "tool", "assistant",
    ]);
    assert.equal(initialVisible.find((message) => message.role === "thinking")?.text, "逐步分析真实内容");
    assert.equal(initialVisible.find((message) => message.role === "tool")?.text, "真实工具输出");
    assert.equal(initialVisible.find((message) => message.role === "assistant")?.text, "这是 Agent 的真实最终回答");
    assert.equal(initial.some((message) => message.role === "runtime-event"), false,
      "transport/audit envelopes never enter the browser timeline");
    assert.equal(initial.some((message) => message._turnTapeProcess === true), false);
    assert.ok(initial.every((message) => message._timelineRecord === true));

    let cursor: ClientTimelineCursor | null = null;
    let hasMore = true;
    const traversed: MessageLike[] = [];
    while (hasMore) {
      const one = await backend.readClientTimelinePage(sessionId, userId, cursor, 2);
      assert.ok(one);
      traversed.unshift(...one.messages);
      cursor = one.nextCursor;
      hasMore = one.hasMore;
      assert.equal(hasMore, cursor !== null);
    }
    assert.deepEqual(browserVisibleTimeline(traversed).map((message) => message.role), [
      "user", "thinking", "tool", "assistant",
    ]);
    const visibleUnitKeys = browserVisibleTimeline(traversed).map((message) => message._timelineUnitKey);
    assert.equal(new Set(visibleUnitKeys).size, visibleUnitKeys.length);

    const page = await backend.listTurnTapeRecords(
      sessionId, userId, tape.finalize.tapeId, 0, 200,
    );
    assert.ok(page);
    assert.equal(page.nextCursor, null);
    assert.equal(page.total, 3);
    assert.deepEqual(page.records.map((message) => message.role), ["thinking", "tool", "runtime-event"]);
    assert.equal(page.records.find((message) => message.role === "tool")?.text, "真实工具输出");
    assert.equal(page.records.some((message) => message._runtimeEvent !== undefined), true);

    const exact = await backend.getClientSession(sessionId, userId);
    assert.ok(exact);
    assert.equal((exact.messages as MessageLike[]).some(
      (message) => (message._runtimeEvent as { exact?: string } | undefined)?.exact === "真实运行事件",
    ), true, "opaque audit evidence remains server-side");
  });

  maybe("initial unified timeline keeps intermediate assistant, tool and final records in exact process order", async () => {
    const sessionId = "s-direct-final-anchor-only";
    const userId = "u-direct-final-anchor-only";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "5".repeat(64), {
      text: "中间说明最终结论",
      assistantSegments: [
        { index: 0, text: "中间说明", ts: 1_783_944_000_001, eventOrdinal: 1 },
        { index: 1, text: "最终结论", ts: 1_783_944_000_003, eventOrdinal: 3 },
      ],
      tools: [{
        blockId: "between-segments",
        toolName: "Bash",
        inputJson: { command: "printf between" },
        output: "between output",
        completed: true,
        arrivedAt: 1_783_944_000_002,
        eventOrdinal: 2,
      }],
    });
    await stageAndFinalize(userId, tape);

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(timeline);
    const visible = browserVisibleTimeline(timeline.messages as MessageLike[]);
    assert.deepEqual(visible.map(
      (message) => [message.role, message.text]), [
      ["assistant", "中间说明"],
      ["tool", "between output"],
      ["assistant", "最终结论"],
    ]);
    assert.equal((timeline.messages as MessageLike[]).some(
      (message) => message._payloadDeferred === true || message._turnTapeProcess === true), false);

    const page = await backend.listTurnTapeRecords(
      sessionId, userId, tape.finalize.tapeId, 0, 200,
    );
    assert.ok(page);
    assert.deepEqual(page.records.map((message) => [message.role, message.text]), [
      ["assistant", "中间说明"],
      ["tool", "between output"],
    ]);
    assert.equal(page.records.some((message) => message.text === "最终结论"), false,
      "the compatibility per-tape endpoint still excludes only its separately rendered billing anchor");
  });

  maybe("transport-only continuation rows never consume logical page slots or hide the real final answer", async () => {
    const sessionId = "s-direct-runtime-flood";
    const userId = "u-direct-runtime-flood";
    const originalTurnKey = "2".repeat(64);
    const continuationTurnKey = "3".repeat(64);
    await backend.upsertClientSession(mkSession({
      id: sessionId,
      userId,
      messages: [{ id: "cm-runtime-flood", role: "user", text: "给我最终结果", ts: 1_783_944_100_000 }],
    }));
    await stageAndFinalize(userId, directTape(sessionId, originalTurnKey, {
      clientMessageId: "cm-runtime-flood",
      text: "不会被运行事件挤走的真实最终回答",
      createdAt: 1_783_944_100_001,
    }));

    const previousBatching = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING;
    process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = "0";
    const continuation = buildTape({
      sessionId,
      agentId: "tail_runtime_flood",
      turnIndex: 2,
      status: "completed",
      turnKey: continuationTurnKey,
      continuationOfTurnKey: originalTurnKey,
      text: "",
      createdAt: 1_783_944_100_100,
      runtimeEvents: Array.from({ length: 230 }, (_, index) => ({
        ordinal: index + 1,
        observedAt: 1_783_944_100_100 + index,
        source: "gateway",
        payload: { type: "progress", index },
      })),
    });
    try {
      await stageAndFinalize(userId, continuation);
    } finally {
      if (previousBatching === undefined) delete process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING;
      else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previousBatching;
    }

    const physical = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND role='runtime-event'`,
      [sessionId, userId, continuation.finalize.tapeId],
    );
    assert.equal(physical.rows[0]!.count, "230", "fixture must exceed the 200-row transport quantum");

    const page = await backend.readClientTimelinePage(sessionId, userId, null, 2);
    assert.ok(page);
    const visible = browserVisibleTimeline(page.messages);
    assert.deepEqual(visible.map((message) => [message.role, message.text]), [
      ["user", "给我最终结果"],
      ["assistant", "不会被运行事件挤走的真实最终回答"],
    ]);
    assert.equal(page.messages.some((message) => message.role === "runtime-event"), false);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
  });

  maybe("user tape API preserves future Agent fields while stripping only known private runtime data", async () => {
    const sessionId = "s-direct-security-boundary";
    const userId = "u-direct-security-boundary";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "8".repeat(64), {
      text: "安全边界后的完整回答",
      runtimeEvents: [
        {
          ordinal: 1,
          observedAt: 1_783_944_000_001,
          source: "codex-jsonrpc",
          payload: {
            type: "thread/started",
            params: {
              rateLimits: { credits: { balance: "BALANCE_SECRET" }, planType: "PLAN_SECRET" },
              threadSettings: { collaborationMode: { settings: { developer_instructions: "DEV_SECRET" } } },
              cwd: "/INTERNAL/CWD/SECRET",
              apiKeySource: "API_KEY_SOURCE_SECRET",
              plugins: ["PLUGIN_SECRET"],
              mcp_servers: ["MCP_SECRET"],
              signature: "THINKING_SIGNATURE_SECRET",
            },
          },
        },
        {
          ordinal: 2,
          observedAt: 1_783_944_000_002,
          source: "gateway",
          payload: {
            type: "system",
            subtype: "bash_output_tail",
            tool_use_id: "bash-safe",
            tail: "SAFE_EXACT_BASH_TAIL",
            total_bytes: 20,
            truncated_head: false,
            cwd: "/MUST/NOT/LEAK",
          },
        },
      ],
      agentGroups: [{
        runId: "dlg-security",
        agentId: "reviewer",
        goal: "完整审查",
        status: "ok",
        resultSummary: "CHILD_EXACT_RESULT",
        transcript: [{
          kind: "text",
          text: "CHILD_EXACT_TRANSCRIPT",
          _nestedDelegateRuntimeEvents: [{ payload: { developer_instructions: "NESTED_DEV_SECRET" } }],
        }, {
          kind: "future_widget",
          futureField: { exact: "FUTURE_CHILD_FIELD" },
        }],
        runtimeEvents: [{
          ordinal: 3,
          observedAt: 1_783_944_000_003,
          source: "codex-jsonrpc",
          payload: { cwd: "/CHILD/CWD/SECRET", skills: ["CHILD_SKILL_SECRET"] },
        }],
        completedAt: 1_783_944_000_004,
      }],
    });
    await stageAndFinalize(userId, tape);

    const page = await backend.listTurnTapeRecords(sessionId, userId, tape.finalize.tapeId, 0, 200);
    assert.ok(page);
    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(timeline);
    const final = (timeline.messages as MessageLike[]).find(
      (message) => message.role === "assistant",
    );
    assert.ok(final);
    const wire = JSON.stringify({ page, final });
    for (const secret of [
      "BALANCE_SECRET", "PLAN_SECRET", "DEV_SECRET", "/INTERNAL/CWD/SECRET",
      "API_KEY_SOURCE_SECRET", "PLUGIN_SECRET", "MCP_SECRET", "THINKING_SIGNATURE_SECRET",
      "/MUST/NOT/LEAK", "NESTED_DEV_SECRET", "/CHILD/CWD/SECRET", "CHILD_SKILL_SECRET",
    ]) assert.equal(wire.includes(secret), false, `${secret} must stay server-side`);
    assert.match(wire, /SAFE_EXACT_BASH_TAIL/);
    assert.match(wire, /CHILD_EXACT_RESULT/);
    assert.match(wire, /CHILD_EXACT_TRANSCRIPT/);
    assert.match(wire, /FUTURE_CHILD_FIELD/);
    assert.match(wire, /安全边界后的完整回答/);
    assert.equal(page.records.filter((message) => message.role === "runtime-event").length, 2);

    const rawRows = await pool.query<{ ordinal: number; role: string; raw: string }>(
      `SELECT ordinal, role, convert_from(payload, 'UTF8') AS raw
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
        ORDER BY ordinal`,
      [sessionId, userId, tape.finalize.tapeId],
    );
    assert.equal(rawRows.rows.some((row) => row.raw.includes("DEV_SECRET")), true);
    const opaqueRuntime = rawRows.rows.find((row) => row.raw.includes("BALANCE_SECRET"));
    assert.ok(opaqueRuntime);
    const safeRuntime = await backend.readTapeRecordPayload(
      sessionId, userId, tape.finalize.tapeId, opaqueRuntime.ordinal,
    );
    assert.ok(safeRuntime);
    assert.match(safeRuntime.payload.toString("utf8"), /thread\/started/);
    assert.doesNotMatch(safeRuntime.payload.toString("utf8"), /BALANCE_SECRET|DEV_SECRET|INTERNAL\/CWD/);

    const groupRow = rawRows.rows.find((row) => row.role === "agent-group");
    assert.ok(groupRow);
    const groupPayload = await backend.readTapeRecordPayload(
      sessionId, userId, tape.finalize.tapeId, groupRow.ordinal,
    );
    assert.ok(groupPayload);
    const safeGroup = groupPayload.payload.toString("utf8");
    assert.match(safeGroup, /CHILD_EXACT_TRANSCRIPT/);
    assert.doesNotMatch(safeGroup, /NESTED_DEV_SECRET|CHILD_SKILL_SECRET|CHILD\/CWD/);
  });

  maybe("batched runtime payload remains fully visible after private fields are stripped", async () => {
    const previousBatching = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING;
    process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = "1";
    try {
      const sessionId = "s-direct-runtime-batch-security";
      const userId = "u-direct-runtime-batch-security";
      await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
      const runtimeEvents = Array.from({ length: 4 }, (_, index) => ({
        ordinal: index,
        observedAt: 1_783_944_100_000 + index,
        source: "codex-jsonrpc" as const,
        payload: { type: "opaque", params: { developer_instructions: `BATCH_SECRET_${index}` } },
      }));
      const tape = directTape(sessionId, "7".repeat(64), { runtimeEvents, text: "batch complete" });
      await stageAndFinalize(userId, tape);
      const batch = (
        await pool.query<{ ordinal: number }>(
          `SELECT ordinal FROM client_session_turn_tape_records
            WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND msg_id LIKE '%-runtime-batch-%'`,
          [sessionId, userId, tape.finalize.tapeId],
        )
      ).rows[0];
      assert.ok(batch);
      const page = await backend.listTurnTapeRecords(sessionId, userId, tape.finalize.tapeId, 0, 200);
      assert.ok(page);
      assert.doesNotMatch(JSON.stringify(page), /BATCH_SECRET_/);
      assert.equal(page.records.filter((message) => message.role === "runtime-event").length, 4);
      const payload = await backend.readTapeRecordPayload(
        sessionId, userId, tape.finalize.tapeId, batch.ordinal,
      );
      assert.ok(payload);
      assert.doesNotMatch(payload.payload.toString("utf8"), /BATCH_SECRET_/);
    } finally {
      if (previousBatching === undefined) Reflect.deleteProperty(process.env, "LOSSLESS_TURN_TAPE_RUNTIME_BATCHING");
      else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previousBatching;
    }
  });

  maybe("legacy rolling per-record refs hydrate exactly in hot and archive history", async () => {
    const sessionId = "s-direct-rolling-ref";
    const userId = "u-direct-rolling-ref";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "9".repeat(64), { text: "legacy rolling truth" });
    await stageAndFinalize(userId, tape);
    const record = (
      await pool.query<{ msg_id: string; content_sha256: string }>(
        `SELECT msg_id, content_sha256
           FROM client_session_turn_tape_records
          WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND role='assistant'`,
        [sessionId, userId, tape.finalize.tapeId],
      )
    ).rows[0];
    assert.ok(record);
    const rollingRef: MessageLike = {
      id: "legacy-rolling-ref",
      role: "assistant",
      text: "",
      _seq: 1,
      _turnTapeId: tape.finalize.tapeId,
      _turnTapeMsgId: record.msg_id,
      // Legacy rolling refs carry the per-record hash in this field.
      _turnTapeSha256: record.content_sha256,
    };
    await pool.query(
      `UPDATE client_sessions
          SET messages=$3, message_count=1, next_seq=2,
              archived_through_seq=0, archived_count=0
        WHERE id=$1 AND user_id=$2`,
      [sessionId, userId, JSON.stringify([rollingRef])],
    );

    const hot = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.equal((hot?.messages as MessageLike[])[0]?.text, "legacy rolling truth");

    await pool.query(
      `UPDATE client_sessions
          SET messages='[]', archived_through_seq=1, archived_count=1
        WHERE id=$1 AND user_id=$2`,
      [sessionId, userId],
    );
    await pool.query(
      `INSERT INTO client_session_archive_chunks
         (session_id,user_id,first_seq,last_seq,message_count,messages,created_at)
       VALUES ($1,$2,1,1,1,$3,1)`,
      [sessionId, userId, JSON.stringify([rollingRef])],
    );
    const archived = await backend.readArchivedMessages(
      sessionId, userId, 0, 20, { view: "timeline" },
    );
    assert.equal(archived.messages[0]?.text, "legacy rolling truth");

    const corruptRef = { ...rollingRef, _turnTapeSha256: "f".repeat(64) };
    await pool.query(
      `UPDATE client_session_archive_chunks SET messages=$3
        WHERE session_id=$1 AND user_id=$2`,
      [sessionId, userId, JSON.stringify([corruptRef])],
    );
    await assert.rejects(
      backend.readArchivedMessages(sessionId, userId, 0, 20, { view: "timeline" }),
      /record hash mismatch/,
    );
  });

  maybe("more than 512 physical records page to completion without a total cap, sentinel, or replacement", async () => {
    const sessionId = "s-direct-many-records";
    const userId = "u-direct-many-records";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tools = Array.from({ length: 530 }, (_, index) => ({
      blockId: `bulk-${index}`,
      toolName: "Bash",
      inputJson: { command: `printf ${index}` },
      output: `真实输出-${index}`,
      completed: true,
    }));
    const tape = directTape(sessionId, "2".repeat(64), { tools, text: "全部过程完成" });
    await stageAndFinalize(userId, tape);

    let cursor = 0;
    const records: MessageLike[] = [];
    const pageSizes: number[] = [];
    for (;;) {
      const page = await backend.listTurnTapeRecords(
        sessionId, userId, tape.finalize.tapeId, cursor, 10_000,
      );
      assert.ok(page);
      assert.equal(page.total, 530);
      pageSizes.push(page.records.length);
      records.push(...page.records);
      if (page.nextCursor === null) break;
      assert.ok(page.nextCursor > cursor);
      cursor = page.nextCursor;
    }

    assert.deepEqual(pageSizes, [200, 200, 130], "the server uses bounded page quanta, not a total cap");
    assert.equal(records.length, 530);
    assert.equal(new Set(records.map((message) => message.id)).size, 530);
    assert.equal(records.filter((message) => message.role === "tool").length, 530);
    assert.equal(records.some((message) => message._payloadDeferred === true), false);
    assert.equal(records.some((message) => message._projectionTruncated === true), false);
    assert.equal(records.some((message) => message._tapeCollapsed === true), false);

    let reverseBefore: number | null = null;
    const reverseRecords: MessageLike[] = [];
    const reversePageSizes: number[] = [];
    for (;;) {
      const page = await backend.listTurnTapeRecords(
        sessionId, userId, tape.finalize.tapeId, 0, 10_000, reverseBefore,
      );
      assert.ok(page);
      assert.equal(page.total, 530);
      reversePageSizes.push(page.records.length);
      reverseRecords.unshift(...page.records);
      if (page.nextCursor === null) break;
      if (reverseBefore !== null) assert.ok(page.nextCursor < reverseBefore);
      reverseBefore = page.nextCursor;
    }
    assert.deepEqual(reversePageSizes, [200, 200, 130]);
    assert.deepEqual(
      reverseRecords.map((message) => message.id),
      records.map((message) => message.id),
      "tail-first pages restore every real record without loss, duplication, or replacement",
    );

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    const initial = timeline!.messages as MessageLike[];
    const initialVisible = browserVisibleTimeline(initial);
    assert.equal(initialVisible.length, 100, "initial selection is one bounded newest logical-record page");
    assert.equal(initialVisible.at(-1)?.role, "assistant");
    assert.equal(initialVisible.at(-1)?.text, "全部过程完成");
    assert.equal(initial.some((message) => message._turnTapeProcess === true), false);
    assert.equal(timeline!.timelineHasMore, true);

    let timelineCursor: ClientTimelineCursor | null = null;
    let timelineHasMore = true;
    const allTimeline: MessageLike[] = [];
    while (timelineHasMore) {
      const timelinePage = await backend.readClientTimelinePage(
        sessionId, userId, timelineCursor, 200,
      );
      assert.ok(timelinePage);
      allTimeline.unshift(...timelinePage.messages);
      timelineCursor = timelinePage.nextCursor;
      timelineHasMore = timelinePage.hasMore;
    }
    const allVisibleTimeline = browserVisibleTimeline(allTimeline);
    assert.equal(allVisibleTimeline.length, 531);
    assert.equal(new Set(allVisibleTimeline.map((message) => message._timelineUnitKey)).size, 531);
    assert.equal(allVisibleTimeline.filter((message) => message.role === "tool").length, 530);
    assert.equal(allVisibleTimeline.at(-1)?.text, "全部过程完成");
  });

  maybe("an oversized physical record streams its exact post-redaction JSON bytes with no content ceiling", async () => {
    const sessionId = "s-direct-large-record";
    const userId = "u-direct-large-record";
    const hugeOutput = "0123456789abcdef".repeat(90_000);
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "3".repeat(64), {
      tools: [{
        blockId: "large-tool",
        toolName: "Bash",
        inputJson: { command: "produce-large-output" },
        output: hugeOutput,
        completed: true,
      }],
      text: "large record complete",
    });
    await stageAndFinalize(userId, tape);

    const page = await backend.listTurnTapeRecords(
      sessionId, userId, tape.finalize.tapeId, 0, 20,
    );
    assert.ok(page);
    const deferred = page.records.find((message) => message._payloadDeferred === true);
    assert.ok(deferred, "large record is represented only by an exact byte locator until requested");
    assert.equal(deferred.role, "tool");
    assert.ok(typeof deferred._payloadBytes === "number" && deferred._payloadBytes > 1_000_000);
    assert.match(String(deferred._payloadSha256), /^[0-9a-f]{64}$/,
      "the finalized allowlisted payload is hash-addressed before disclosure");
    const ordinal = deferred._recordOrdinal;
    assert.ok(typeof ordinal === "number");

    const metadata = await backend.readTapeRecordPayload(
      sessionId, userId, tape.finalize.tapeId, ordinal, 0, 0,
    );
    assert.ok(metadata);
    assert.equal(metadata.payload.length, 0);
    assert.equal(metadata.msgId, deferred.id);
    assert.equal(metadata.role, "tool");
    assert.equal(metadata.tapeSha256, tape.finalize.tapeSha256);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < metadata.totalBytes; offset += 1024 * 1024) {
      const chunk = await backend.readTapeRecordPayload(
        sessionId, userId, tape.finalize.tapeId, ordinal, offset,
        Math.min(1024 * 1024, metadata.totalBytes - offset),
      );
      assert.ok(chunk);
      assert.equal(chunk.offset, offset);
      assert.ok(chunk.payload.length <= 1024 * 1024);
      chunks.push(chunk.payload);
    }
    const raw = Buffer.concat(chunks);
    assert.equal(raw.length, metadata.totalBytes);
    assert.equal(raw.length, deferred._payloadBytes);
    assert.equal(sha256(raw), metadata.contentSha256);
    const decoded = JSON.parse(raw.toString("utf8")) as MessageLike & { output?: string };
    assert.equal(decoded.id, deferred.id);
    assert.equal(decoded.text, hugeOutput);
    assert.equal(decoded.output, hugeOutput);
    assert.equal(await backend.readTapeRecordPayload(
      sessionId, "u-someone-else", tape.finalize.tapeId, ordinal,
    ), null);
    assert.equal(await backend.readTapeRecordPayload(
      sessionId, userId, "f".repeat(64), ordinal,
    ), null);
  });

  maybe("timeline GET returns many sub-quantum final answers exactly without substitution", async () => {
    const sessionId = "s-direct-many-large-finals";
    const userId = "u-direct-many-large-finals";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const count = 24;
    for (let index = 0; index < count; index += 1) {
      const marker = `LARGE-FINAL-${index}-TAIL`;
      const tape = directTape(
        sessionId,
        index.toString(16).padStart(64, "0"),
        {
          turnIndex: index + 1,
          createdAt: 1_783_944_200_000 + index,
          text: `${"完整正文".repeat(16_000)}${marker}`,
        },
      );
      await stageAndFinalize(userId, tape);
    }

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    assert.ok(timeline);
    const wire = JSON.stringify(timeline);
    const finals = (timeline.messages as MessageLike[]).filter((message) => message.role === "assistant");
    assert.equal(finals.length, count);
    assert.equal(finals.every((message) => message._payloadDeferred !== true), true);
    assert.ok(Buffer.byteLength(wire, "utf8") < 8 * 1024 * 1024,
      "one page stays inside the physical raw-byte quantum while preserving every exact answer");
    assert.equal(wire.includes("LARGE-FINAL-0-TAIL"), true);
    assert.equal(wire.includes(`LARGE-FINAL-${count - 1}-TAIL`), true);
  });

  maybe("a multi-megabyte final answer is a lazy locator whose exact bytes remain range-readable", async () => {
    const sessionId = "s-direct-huge-final";
    const userId = "u-direct-huge-final";
    const exactTail = "-HUGE-FINAL-EXACT-TAIL";
    const exactText = `${"真实回答".repeat(300_000)}${exactTail}`;
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "a".repeat(64), { text: exactText });
    await stageAndFinalize(userId, tape);

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    const locator = (timeline!.messages as MessageLike[]).find((message) => message.role === "assistant");
    assert.equal(locator?._payloadDeferred, true);
    assert.ok(Number(locator?._payloadBytes ?? 0) > 1_000_000);
    assert.match(String(locator?._payloadSha256), /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(timeline).includes(exactTail), false);
    const decoded = await readDeferredRecord(sessionId, userId, tape.finalize.tapeId, locator!);
    assert.equal(decoded.text, exactText);
  });

  maybe("legacy large rows omit an unknown visible hash, then materialize one on first range read", async () => {
    const sessionId = "s-direct-legacy-large-visible";
    const userId = "u-direct-legacy-large-visible";
    const exactText = `${"旧版完整回答".repeat(220_000)}-LEGACY-EXACT-TAIL`;
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "b".repeat(64), { text: exactText });
    await stageAndFinalize(userId, tape);
    await pool.query(
      `UPDATE client_session_turn_tape_records
          SET visible_payload=NULL, visible_content_sha256=NULL
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND role='assistant'`,
      [sessionId, userId, tape.finalize.tapeId],
    );

    const timeline = await backend.getClientSession(sessionId, userId, { view: "timeline" });
    const locator = (timeline!.messages as MessageLike[]).find((message) => message.role === "assistant");
    assert.equal(locator?._payloadDeferred, true);
    assert.equal(locator?._payloadSha256, undefined,
      "raw tape hash must never be advertised as the derived visible-payload hash");
    const ordinal = locator?._recordOrdinal;
    assert.ok(typeof ordinal === "number");
    const metadata = await backend.readTapeRecordPayload(
      sessionId, userId, tape.finalize.tapeId, ordinal, 0, 0,
    );
    assert.ok(metadata);
    assert.match(metadata.contentSha256, /^[0-9a-f]{64}$/);
    const decoded = await readDeferredRecord(sessionId, userId, tape.finalize.tapeId, locator!);
    assert.equal(decoded.text, exactText);
    const stored = await pool.query<{ visible_content_sha256: string | null; bytes: string | null }>(
      `SELECT visible_content_sha256,
              CASE WHEN visible_payload IS NULL THEN NULL ELSE octet_length(visible_payload)::text END AS bytes
         FROM client_session_turn_tape_records
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND ordinal=$4`,
      [sessionId, userId, tape.finalize.tapeId, ordinal],
    );
    assert.equal(stored.rows[0]?.visible_content_sha256, metadata.contentSha256);
    assert.equal(Number(stored.rows[0]?.bytes), metadata.totalBytes);
  });

  maybe("corrupt immutable bytes reject the read instead of producing a truncated or synthetic message", async () => {
    const sessionId = "s-direct-corrupt-record";
    const userId = "u-direct-corrupt-record";
    await backend.upsertClientSession(mkSession({ id: sessionId, userId }));
    const tape = directTape(sessionId, "4".repeat(64), {
      thinkingText: "must remain exact",
      text: "complete",
    });
    await stageAndFinalize(userId, tape);
    await pool.query(
      `UPDATE client_session_turn_tape_records
          SET payload=$4, visible_payload=$4
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3 AND role='thinking'`,
      [sessionId, userId, tape.finalize.tapeId, Buffer.from('{"broken":', "utf8")],
    );

    await assert.rejects(
      backend.listTurnTapeRecords(sessionId, userId, tape.finalize.tapeId, 0, 20),
      /hash mismatch|JSON invalid|Unexpected end/i,
    );
    await assert.rejects(
      backend.getClientSession(sessionId, userId),
      /hash mismatch|JSON invalid|Unexpected end/i,
    );
  });
});
