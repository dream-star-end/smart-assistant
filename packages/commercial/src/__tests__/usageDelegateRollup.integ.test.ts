/**
 * GET /api/me/usage — delegate 归组聚合(0104 读侧)真 PG 集成测试。
 *
 * 0104 迁移给 usage_records 加了 mode('chat'|'agent'|'delegate')/
 * parent_session_id / delegate_agent_id;写侧(anthropicProxy settle)对 delegate
 * 子会话打标。本套件锁 handleGetMyUsage 的读侧归组语义:
 *
 *   1. 纯 chat 会话 → 行为与旧版逐字节一致 + delegate 附加字段零值(向后兼容)
 *   2. delegate 行并入 parent_session_id 归组;与同键父 chat 行合并;
 *      per-delegate 明细按 (agent, model) 分桶、积分降序
 *   3. 线上现状形态:父 chat 行键(引擎 UUID)≠ parent 键(web*)→ 两行并存,
 *      delegate 归组行 delegate_only=true
 *   4. parent_session_id 为空的 delegate 孤儿行 → 按自身 session_id 独立成行,
 *      delegate_only 标注
 *   5. 跨用户隔离(WHERE user_id,无 IDOR)
 *   6. session_id IS NULL 的 delegate 行 → 维持 legacy_unattributed 语义,不进 sessions
 *   7. 归组后的分页 has_more / offset 语义
 *
 * harness 与 settleUsage.integ.test.ts 同款:probe 55432 fixture,不可用则 skip
 * (CI / REQUIRE_TEST_DB=1 下强制要求)。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
} from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { signAccess } from "../auth/jwt.js";
import {
  handleGetMyUsage,
  type CommercialHttpDeps,
  type RequestContext,
} from "../http/handlers.js";
import { HttpError } from "../http/util.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const JWT_SECRET = "u".repeat(64);

let pgAvailable = false;
let server: Server | null = null;
let baseUrl = "";

async function cleanCommercialSchema(): Promise<void> {
  await resetTestSchemaForTest();
  await query("GRANT ALL ON SCHEMA public TO public");
}

async function probe(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) {
      throw new Error(
        "Postgres test fixture required (CI=true or REQUIRE_TEST_DB=1). " +
          "See docs/V5_CI.md for bootstrap.",
      );
    }
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await cleanCommercialSchema();
  await runMigrations();

  // 最小 HTTP harness:handleGetMyUsage 只消费 deps.jwtSecret,ctx 未使用。
  server = createServer((req, res) => {
    void handleGetMyUsage(
      req,
      res,
      {} as RequestContext,
      { jwtSecret: JWT_SECRET } as unknown as CommercialHttpDeps,
    ).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (pgAvailable) {
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE usage_records, credit_ledger, users RESTART IDENTITY CASCADE",
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

async function createUser(email: string): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', 0, 'user') RETURNING id::text AS id",
    [email],
  );
  return BigInt(r.rows[0]!.id);
}

let reqSeq = 0;

/** 直插 usage_records 造数(读侧测试,不经写侧 settle;写侧禁改且已有自己的套件)。 */
async function insertUsage(opts: {
  userId: bigint;
  sessionId: string | null;
  mode?: "chat" | "delegate";
  parentSessionId?: string | null;
  delegateAgentId?: string | null;
  model?: string;
  input?: number;
  output?: number;
  cost?: bigint;
  /** ISO 时间戳;控制 MAX(created_at) 排序 */
  createdAt?: string;
  status?: "success" | "error";
}): Promise<void> {
  reqSeq += 1;
  await query(
    `INSERT INTO usage_records
       (user_id, session_id, mode, parent_session_id, delegate_agent_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        price_snapshot, cost_credits, request_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, '{}'::jsonb, $9, $10, $11,
             COALESCE($12::timestamptz, NOW()))`,
    [
      opts.userId.toString(),
      opts.sessionId,
      opts.mode ?? "chat",
      opts.parentSessionId ?? null,
      opts.delegateAgentId ?? null,
      opts.model ?? "glm-5.2",
      opts.input ?? 1000,
      opts.output ?? 500,
      (opts.cost ?? 10n).toString(),
      `req-${reqSeq}`,
      opts.status ?? "success",
      opts.createdAt ?? null,
    ],
  );
}

type UsageResponse = {
  summary: { requests_total: string; billed_credits: string };
  legacy_unattributed: { requests: string; billed_credits: string };
  sessions: {
    rows: Array<{
      session_id: string;
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
      last_used_at: string;
      delegate_credits: string;
      delegate_requests: string;
      delegate_only: boolean;
      delegates?: Array<{
        delegate_agent_id: string | null;
        model: string;
        requests: string;
        billed_credits: string;
      }>;
    }>;
    has_more: boolean;
  };
};

async function getUsage(userId: bigint, qs = ""): Promise<UsageResponse> {
  const { token } = await signAccess(
    { sub: userId.toString(), role: "user" },
    JWT_SECRET,
  );
  const res = await fetch(`${baseUrl}/api/me/usage${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `GET /api/me/usage → ${res.status}`);
  return (await res.json()) as UsageResponse;
}

const T1 = "2026-07-01T10:00:00Z";
const T2 = "2026-07-01T11:00:00Z";
const T3 = "2026-07-01T12:00:00Z";
const T4 = "2026-07-01T13:00:00Z";

describe("GET /api/me/usage delegate 归组(integ)", () => {
  test("纯 chat 会话:聚合与旧语义一致,delegate 附加字段零值", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("chat-only@example.com");
    await insertUsage({ userId: uid, sessionId: "uuid-a", cost: 30n, createdAt: T1 });
    await insertUsage({ userId: uid, sessionId: "uuid-a", cost: 20n, createdAt: T2 });
    await insertUsage({ userId: uid, sessionId: "uuid-b", cost: 5n, createdAt: T3 });

    const body = await getUsage(uid);
    assert.equal(body.sessions.rows.length, 2);
    // 排序:MAX(created_at) DESC → uuid-b(T3)在前
    const [b, a] = body.sessions.rows;
    assert.equal(b!.session_id, "uuid-b");
    assert.equal(b!.requests, "1");
    assert.equal(b!.billed_credits, "5");
    assert.equal(a!.session_id, "uuid-a");
    assert.equal(a!.requests, "2");
    assert.equal(a!.billed_credits, "50");
    for (const row of body.sessions.rows) {
      assert.equal(row.delegate_credits, "0");
      assert.equal(row.delegate_requests, "0");
      assert.equal(row.delegate_only, false);
      assert.equal(row.delegates, undefined, "纯 chat 行不携带 delegates 明细");
    }
    assert.equal(body.sessions.has_more, false);
  });

  test("delegate 行并入 parent 归组:同键父 chat 行合并 + per-agent×model 明细", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("merge@example.com");
    // 父会话自己的行与归组键同键(写侧未来对齐客户端会话 id 的形态)
    await insertUsage({ userId: uid, sessionId: "webmr-p1", cost: 100n, input: 2000, output: 900, createdAt: T1 });
    // delegate:coder×2(glm-5.2,30+30)、coder×1(minimax-m3,10)、hidden-reviewer×1(50)
    await insertUsage({
      userId: uid, sessionId: "dlg-uuid-1", mode: "delegate",
      parentSessionId: "webmr-p1", delegateAgentId: "coder", cost: 30n, createdAt: T2,
    });
    await insertUsage({
      userId: uid, sessionId: "dlg-uuid-1", mode: "delegate",
      parentSessionId: "webmr-p1", delegateAgentId: "coder", cost: 30n, createdAt: T3,
    });
    await insertUsage({
      userId: uid, sessionId: "dlg-uuid-2", mode: "delegate", model: "minimax-m3",
      parentSessionId: "webmr-p1", delegateAgentId: "coder", cost: 10n, createdAt: T3,
    });
    await insertUsage({
      userId: uid, sessionId: "dlg-uuid-3", mode: "delegate",
      parentSessionId: "webmr-p1", delegateAgentId: "hidden-reviewer", cost: 50n, createdAt: T4,
    });

    const body = await getUsage(uid);
    assert.equal(body.sessions.rows.length, 1, "全部并入单一父会话行");
    const row = body.sessions.rows[0]!;
    assert.equal(row.session_id, "webmr-p1");
    assert.equal(row.requests, "5");
    assert.equal(row.billed_credits, "220");
    assert.equal(row.delegate_credits, "120");
    assert.equal(row.delegate_requests, "4");
    assert.equal(row.delegate_only, false, "含父 chat 行 → 非纯 delegate");
    assert.equal(row.last_used_at, new Date(T4).toISOString());
    // 明细:(agent, model) 分桶,组内积分降序
    assert.ok(row.delegates);
    assert.deepEqual(row.delegates, [
      { delegate_agent_id: "coder", model: "glm-5.2", requests: "2", billed_credits: "60" },
      { delegate_agent_id: "hidden-reviewer", model: "glm-5.2", requests: "1", billed_credits: "50" },
      { delegate_agent_id: "coder", model: "minimax-m3", requests: "1", billed_credits: "10" },
    ]);
  });

  test("线上现状形态:父 chat 行(引擎 UUID 键)与 delegate 归组行(web* 键)并存", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("split@example.com");
    await insertUsage({ userId: uid, sessionId: "uuid-parent", cost: 80n, createdAt: T2 });
    await insertUsage({
      userId: uid, sessionId: "dlg-uuid-9", mode: "delegate",
      parentSessionId: "webmr-p2", delegateAgentId: "hidden-reviewer", cost: 40n, createdAt: T3,
    });

    const body = await getUsage(uid);
    assert.equal(body.sessions.rows.length, 2);
    const [dlgRow, chatRow] = body.sessions.rows;
    assert.equal(dlgRow!.session_id, "webmr-p2");
    assert.equal(dlgRow!.delegate_only, true);
    assert.equal(dlgRow!.delegate_credits, "40");
    assert.deepEqual(dlgRow!.delegates, [
      { delegate_agent_id: "hidden-reviewer", model: "glm-5.2", requests: "1", billed_credits: "40" },
    ]);
    assert.equal(chatRow!.session_id, "uuid-parent");
    assert.equal(chatRow!.delegate_only, false);
    assert.equal(chatRow!.delegate_credits, "0");
  });

  test("parent 缺失的 delegate 孤儿行:按自身 session_id 独立成行并标注", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("orphan@example.com");
    await insertUsage({
      userId: uid, sessionId: "dlg-orphan-1", mode: "delegate",
      parentSessionId: null, delegateAgentId: "coder", cost: 25n, createdAt: T1,
    });

    const body = await getUsage(uid);
    assert.equal(body.sessions.rows.length, 1);
    const row = body.sessions.rows[0]!;
    assert.equal(row.session_id, "dlg-orphan-1");
    assert.equal(row.requests, "1");
    assert.equal(row.billed_credits, "25");
    assert.equal(row.delegate_credits, "25");
    assert.equal(row.delegate_requests, "1");
    assert.equal(row.delegate_only, true);
    assert.deepEqual(row.delegates, [
      { delegate_agent_id: "coder", model: "glm-5.2", requests: "1", billed_credits: "25" },
    ]);
  });

  test("跨用户隔离:他人同 parent 键的 delegate 行不掺入", async (t) => {
    if (skipIfNoPg(t)) return;
    const alice = await createUser("alice@example.com");
    const bob = await createUser("bob@example.com");
    await insertUsage({
      userId: alice, sessionId: "dlg-a", mode: "delegate",
      parentSessionId: "webmr-shared", delegateAgentId: "coder", cost: 10n, createdAt: T1,
    });
    await insertUsage({
      userId: bob, sessionId: "dlg-b", mode: "delegate",
      parentSessionId: "webmr-shared", delegateAgentId: "hidden-reviewer", cost: 99n, createdAt: T2,
    });

    const body = await getUsage(alice);
    assert.equal(body.sessions.rows.length, 1);
    const row = body.sessions.rows[0]!;
    assert.equal(row.session_id, "webmr-shared");
    assert.equal(row.billed_credits, "10");
    assert.deepEqual(row.delegates, [
      { delegate_agent_id: "coder", model: "glm-5.2", requests: "1", billed_credits: "10" },
    ]);
  });

  test("session_id IS NULL 的 delegate 行:维持 legacy 桶语义,不进 sessions", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("legacy@example.com");
    await insertUsage({
      userId: uid, sessionId: null, mode: "delegate",
      parentSessionId: "webmr-p9", delegateAgentId: "coder", cost: 7n, createdAt: T1,
    });

    const body = await getUsage(uid);
    assert.equal(body.sessions.rows.length, 0, "session_id NULL 不进 sessions(语义未变)");
    assert.equal(body.legacy_unattributed.requests, "1");
    assert.equal(body.legacy_unattributed.billed_credits, "7");
  });

  test("归组后的分页:has_more / offset 以归组行数为准", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("paging@example.com");
    // 3 个归组:webmr-g1(2 条 delegate)、uuid-g2、uuid-g3
    await insertUsage({
      userId: uid, sessionId: "dlg-1", mode: "delegate",
      parentSessionId: "webmr-g1", delegateAgentId: "coder", cost: 1n, createdAt: T4,
    });
    await insertUsage({
      userId: uid, sessionId: "dlg-2", mode: "delegate",
      parentSessionId: "webmr-g1", delegateAgentId: "coder", cost: 2n, createdAt: T3,
    });
    await insertUsage({ userId: uid, sessionId: "uuid-g2", cost: 3n, createdAt: T2 });
    await insertUsage({ userId: uid, sessionId: "uuid-g3", cost: 4n, createdAt: T1 });

    const page1 = await getUsage(uid, "?sessions_limit=2");
    assert.equal(page1.sessions.rows.length, 2);
    assert.equal(page1.sessions.has_more, true);
    assert.deepEqual(
      page1.sessions.rows.map((r) => r.session_id),
      ["webmr-g1", "uuid-g2"],
    );
    assert.equal(page1.sessions.rows[0]!.requests, "2");

    const page2 = await getUsage(uid, "?sessions_limit=2&sessions_offset=2");
    assert.equal(page2.sessions.rows.length, 1);
    assert.equal(page2.sessions.has_more, false);
    assert.equal(page2.sessions.rows[0]!.session_id, "uuid-g3");
  });

  test("error 状态行不计入 sessions 聚合(status='success' 过滤未变)", async (t) => {
    if (skipIfNoPg(t)) return;
    const uid = await createUser("errrow@example.com");
    await insertUsage({
      userId: uid, sessionId: "dlg-err", mode: "delegate",
      parentSessionId: "webmr-err", delegateAgentId: "coder", cost: 0n,
      status: "error", createdAt: T1,
    });
    const body = await getUsage(uid);
    assert.equal(body.sessions.rows.length, 0);
  });
});
