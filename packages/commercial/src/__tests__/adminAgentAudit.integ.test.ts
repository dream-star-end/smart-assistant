/**
 * T-54 集成:admin agent_audit 查询 + requireAdmin 中间件。
 *
 * 覆盖:
 *   1. writeAgentAudit + listAgentAudit happy path(2 个用户,各自 1-2 条)
 *   2. user_id 过滤
 *   3. tool 过滤
 *   4. keyset 分页 before + limit + next_before
 *   5. 非法参数 → RangeError(HTTP 层转 400)
 *   6. requireAdmin:role=user → 403 FORBIDDEN
 *   7. requireAdmin:role=admin + 完整流程 → 200 + 序列化正确(含 ISO 时间)
 *
 * 不覆盖:
 *   - WS agent 层写 audit(T-52 已覆盖)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import {
  getAgentAuditStats,
  listAgentAudit,
  AGENT_AUDIT_MAX_LIMIT,
} from "../admin/agentAudit.js";
import { requireAdmin } from "../admin/requireAdmin.js";
import { createCommercialHandler } from "../http/router.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import { HttpError } from "../http/util.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";

const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const JWT_SECRET = "z".repeat(64);

const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_tool_rollup_counts",
  "agent_tool_rollup_reports",
  "agent_containers",
  "agent_subscriptions",
  "user_preferences",
  "request_finalize_journal",
  "orders",
  "topup_plans",
  "usage_records",
  "credit_ledger",
  "model_pricing",
  "claude_accounts",
  "refresh_tokens",
  "email_verifications",
  "users",
  "schema_migrations",
];

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> { /* drop */ }
}

async function probePg(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* ignore */ } return false; }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
  });
  try { await r.connect(); await r.ping(); return r; }
  catch { try { r.disconnect(); } catch { /* */ } return null; }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();

  redis = await probeRedis();
  if (redis) {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      verifyEmailUrlBase: "https://test.local",
      resetPasswordUrlBase: "https://test.local",
      rateLimits: {
        register: { scope: "register_t54", windowSeconds: 60, max: 100 },
        login: { scope: "login_t54", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t54", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE agent_audit, agent_containers, agent_subscriptions, admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
  if (redis) await redis.flushdb();
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

async function createUser(
  email: string,
  role: "user" | "admin" = "user",
): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [email, role],
  );
  return BigInt(r.rows[0].id);
}

// legacy /ws/agent(及其 writeAgentAudit)已删除;listAgentAudit 读路径仍是生产代码。
// 这里保留一个等价的本地 INSERT helper,专供测试造 agent_audit 数据。
interface AgentAuditTestRow {
  user_id: string;
  session_id: string;
  tool: string;
  input_meta: Record<string, unknown>;
  input_hash: string | null;
  output_hash: string | null;
  duration_ms: number;
  success: boolean;
  error_msg: string | null;
  occurred_at?: Date;
}

async function writeAgentAudit(
  pool: import("pg").Pool,
  row: AgentAuditTestRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_audit
       (user_id, session_id, tool, input_meta, input_hash, output_hash, duration_ms, success, error_msg, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, COALESCE($10, NOW()))`,
    [
      row.user_id,
      row.session_id,
      row.tool,
      JSON.stringify(row.input_meta),
      row.input_hash,
      row.output_hash,
      row.duration_ms,
      row.success,
      row.error_msg,
      row.occurred_at ?? null,
    ],
  );
}

async function insertAudit(
  uid: bigint,
  session: string,
  tool: string,
  success: boolean,
  errorMsg: string | null = null,
): Promise<void> {
  const pool = { query: query } as unknown as import("pg").Pool;
  await writeAgentAudit(pool, {
    user_id: uid.toString(),
    session_id: session,
    tool,
    input_meta: { cmd: `echo ${tool}` },
    input_hash: null,
    output_hash: null,
    duration_ms: 42,
    success,
    error_msg: errorMsg,
  });
}

async function insertContainer(
  uid: bigint,
  runtimeChannel: "v3" | "v5" = "v5",
  state: "active" | "vanished" = "active",
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO agent_containers(user_id,secret_hash,state,runtime_channel)
     VALUES ($1,$2,$3,$4) RETURNING id::text AS id`,
    [uid.toString(), randomBytes(32), state, runtimeChannel],
  );
  return result.rows[0].id;
}

interface RollupCountInput {
  agentId?: string;
  tool: string;
  outcome: "success" | "failure";
  errorClass?: string;
  failureKind?: string;
  count: number;
}

async function insertRollup(input: {
  userId: bigint;
  containerId: string;
  reporterRunId: string;
  sequence: number;
  counts: RollupCountInput[];
  endedAt?: Date;
}): Promise<void> {
  const reportId = randomBytes(16).toString("hex");
  const endedAt = input.endedAt ?? new Date();
  await query(
    `INSERT INTO agent_tool_rollup_reports(
       report_id,user_id,container_id,reporter_run_id,sequence,
       window_started_at,window_ended_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      reportId,
      input.userId.toString(),
      input.containerId,
      input.reporterRunId,
      input.sequence,
      new Date(endedAt.getTime() - 5 * 60_000),
      endedAt,
    ],
  );
  for (const count of input.counts) {
    await query(
      `INSERT INTO agent_tool_rollup_counts(
         report_id,agent_id,tool,outcome,error_class,failure_kind,call_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        reportId,
        count.agentId ?? "main",
        count.tool,
        count.outcome,
        count.errorClass ?? "none",
        count.failureKind ?? "none",
        count.count,
      ],
    );
  }
}

// ============================================================
//  listAgentAudit (DB 层)
// ============================================================

describe("listAgentAudit", () => {
  test("happy: 两用户各 2 条 → 默认按 id DESC 返回所有", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("a1@x.com");
    const u2 = await createUser("a2@x.com");
    await insertAudit(u1, "s1", "bash", true);
    await insertAudit(u1, "s1", "bash", false, "nonzero exit");
    await insertAudit(u2, "s2", "read", true);
    await insertAudit(u2, "s2", "write", true);

    const r = await listAgentAudit({});
    assert.equal(r.rows.length, 4);
    // id DESC
    for (let i = 1; i < r.rows.length; i++) {
      assert.ok(BigInt(r.rows[i - 1].id) > BigInt(r.rows[i].id));
    }
    assert.equal(r.next_before, null);
  });

  test("user_id 过滤", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("f1@x.com");
    const u2 = await createUser("f2@x.com");
    await insertAudit(u1, "s1", "bash", true);
    await insertAudit(u2, "s2", "bash", true);
    await insertAudit(u1, "s1", "read", true);

    const r = await listAgentAudit({ userId: u1 });
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) assert.equal(row.user_id, u1.toString());
  });

  test("tool 过滤", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("t1@x.com");
    await insertAudit(u1, "s1", "codex:mcpToolCall", true);
    await insertAudit(u1, "s1", "read", true);
    await insertAudit(u1, "s1", "codex:mcpToolCall", false, "boom");

    const r = await listAgentAudit({ tool: "codex:mcpToolCall" });
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) assert.equal(row.tool, "codex:mcpToolCall");
  });

  test("keyset 分页:limit=2 + before → 第二页", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("p1@x.com");
    for (let i = 0; i < 5; i++) {
      await insertAudit(u1, "s1", "bash", true);
    }
    const p1 = await listAgentAudit({ limit: 2 });
    assert.equal(p1.rows.length, 2);
    assert.ok(p1.next_before);

    const p2 = await listAgentAudit({ limit: 2, before: p1.next_before! });
    assert.equal(p2.rows.length, 2);
    // p2 所有 id 严格小于 p1.next_before
    for (const row of p2.rows) {
      assert.ok(BigInt(row.id) < BigInt(p1.next_before!));
    }

    const p3 = await listAgentAudit({ limit: 2, before: p2.next_before! });
    assert.equal(p3.rows.length, 1);
    // 最后一页:行数 < limit → next_before=null
    assert.equal(p3.next_before, null);
  });

  test("limit 上限被夹到 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("l1@x.com");
    await insertAudit(u1, "s", "bash", true);
    // 只传巨大 limit,verify 不抛(由 listAgentAudit 内部 clamp 到 200)
    const r = await listAgentAudit({ limit: 999 });
    assert.equal(r.rows.length, 1);
    assert.equal(AGENT_AUDIT_MAX_LIMIT, 200);
  });

  test("非法 tool → RangeError invalid_tool", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => listAgentAudit({ tool: "bash; DROP TABLE users;--" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_tool",
    );
  });

  test("非法 user_id → RangeError invalid_user_id", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => listAgentAudit({ userId: "abc" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_user_id",
    );
  });

  test("非法 before → RangeError invalid_before", async (t) => {
    if (skipIfNoPg(t)) return;
    await assert.rejects(
      () => listAgentAudit({ before: "-1" }),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_before",
    );
  });
});

// ============================================================
//  getAgentAuditStats (aggregate rollups + failure-only rows)
// ============================================================

describe("getAgentAuditStats", () => {
  test("computes reported-call rate and complete current-v5-fleet coverage", async (t) => {
    if (skipIfNoPg(t)) return;
    const u1 = await createUser("stats-1@x.com");
    const u2 = await createUser("stats-2@x.com");
    const c1 = await insertContainer(u1);
    const c2 = await insertContainer(u2);
    const run1 = "1".repeat(32);
    const run2 = "2".repeat(32);
    const now = new Date();
    await insertRollup({
      userId: u1,
      containerId: c1,
      reporterRunId: run1,
      sequence: 1,
      endedAt: new Date(now.getTime() - 4 * 60_000),
      counts: [
        { tool: "Bash", outcome: "success", count: 8 },
        {
          tool: "Bash",
          outcome: "failure",
          errorClass: "process_exit",
          failureKind: "process_exit",
          count: 2,
        },
      ],
    });
    await insertRollup({
      userId: u1,
      containerId: c1,
      reporterRunId: run1,
      sequence: 2,
      endedAt: new Date(now.getTime() - 60_000),
      counts: [{ tool: "Read", outcome: "success", count: 4 }],
    });
    await insertRollup({
      userId: u2,
      containerId: c2,
      reporterRunId: run2,
      sequence: 1,
      endedAt: new Date(now.getTime() - 2 * 60_000),
      counts: [{ tool: "Bash", outcome: "success", count: 2 }],
    });
    const pool = { query } as unknown as import("pg").Pool;
    await writeAgentAudit(pool, {
      user_id: u1.toString(),
      session_id: "stats-s1",
      tool: "Bash",
      input_meta: { error_class: "process_exit", failure_kind: "process_exit", exit_code: 2 },
      input_hash: "a".repeat(64),
      output_hash: "b".repeat(64),
      duration_ms: 20,
      success: false,
      error_msg: null,
      occurred_at: new Date(now.getTime() - 30_000),
    });
    await writeAgentAudit(pool, {
      user_id: u1.toString(),
      session_id: "stats-s2",
      tool: "Bash",
      input_meta: { error_class: "process_exit", failure_kind: "process_exit", exit_code: 1 },
      input_hash: "c".repeat(64),
      output_hash: "d".repeat(64),
      duration_ms: 40,
      success: false,
      error_msg: null,
      occurred_at: new Date(now.getTime() - 20_000),
    });
    await insertAudit(u1, "stats-success", "Bash", true);

    const statsNow = new Date();
    const stats = await getAgentAuditStats({ window: "24h", now: statsNow });
    assert.deepEqual(stats.rollup, {
      success_calls: 14,
      failure_calls: 2,
      total_calls: 16,
      failure_rate: 0.125,
      // 按工具分解(调用量降序):Bash=10ok/2fail,Read=4ok/0fail。
      tools: [
        { tool: "Bash", success_calls: 10, failure_calls: 2, total_calls: 12, failure_rate: 2 / 12 },
        { tool: "Read", success_calls: 4, failure_calls: 0, total_calls: 4, failure_rate: 0 },
      ],
    });
    assert.deepEqual(
      {
        scope: stats.coverage.scope,
        mode: stats.coverage.mode,
        partial: stats.coverage.partial,
        expected: stats.coverage.expected_containers,
        covered: stats.coverage.covered_containers,
      },
      {
        scope: "current_online_fleet",
        mode: "best_effort",
        partial: false,
        expected: 2,
        covered: 2,
      },
    );
    assert.equal(stats.failures.events, 2);
    assert.equal(stats.failures.affected_users, 1);
    assert.deepEqual(stats.failures.groups[0], {
      tool: "Bash",
      error_class: "process_exit",
      events: 2,
      users: 1,
      sessions: 2,
      p50_ms: 30,
      p95_ms: 39,
    });

    const bashOnly = await getAgentAuditStats({ window: "24h", tool: "Bash", now: statsNow });
    assert.deepEqual(bashOnly.rollup, {
      success_calls: 10,
      failure_calls: 2,
      total_calls: 12,
      failure_rate: 1 / 6,
      tools: [
        { tool: "Bash", success_calls: 10, failure_calls: 2, total_calls: 12, failure_rate: 1 / 6 },
      ],
    });
    const userOnly = await getAgentAuditStats({ window: "24h", userId: u1, now: statsNow });
    assert.equal(userOnly.rollup.total_calls, 14);
    assert.equal(userOnly.coverage.expected_containers, 1);
    assert.equal(userOnly.coverage.covered_containers, 1);
  });

  test("marks no-data and current-run sequence gaps as partial", async (t) => {
    if (skipIfNoPg(t)) return;
    const empty = await getAgentAuditStats({ window: "1h" });
    assert.equal(empty.rollup.failure_rate, null);
    assert.equal(empty.coverage.partial, true);
    assert.equal(empty.coverage.expected_containers, 0);

    const v5User = await createUser("gap-v5@x.com");
    const v3User = await createUser("gap-v3@x.com");
    const vanishedUser = await createUser("gap-vanished@x.com");
    const v5 = await insertContainer(v5User, "v5", "active");
    await insertContainer(v3User, "v3", "active");
    await insertContainer(vanishedUser, "v5", "vanished");
    const run = "3".repeat(32);
    const now = new Date();
    await insertRollup({
      userId: v5User,
      containerId: v5,
      reporterRunId: run,
      sequence: 1,
      endedAt: new Date(now.getTime() - 2 * 60_000),
      counts: [],
    });
    await insertRollup({
      userId: v5User,
      containerId: v5,
      reporterRunId: run,
      sequence: 3,
      endedAt: new Date(now.getTime() - 60_000),
      counts: [],
    });
    const stats = await getAgentAuditStats({ window: "1h", now });
    assert.equal(stats.coverage.expected_containers, 1);
    assert.equal(stats.coverage.covered_containers, 0);
    assert.equal(stats.coverage.partial, true);
  });

  test("uses bounded event-time windows for rollups, failure details, and coverage", async (t) => {
    if (skipIfNoPg(t)) return;
    const user = await createUser("event-time@x.com");
    const container = await insertContainer(user);
    const run = "4".repeat(32);
    const now = new Date();
    await insertRollup({
      userId: user,
      containerId: container,
      reporterRunId: run,
      sequence: 1,
      endedAt: new Date(now.getTime() - 60_000),
      counts: [{ tool: "Bash", outcome: "success", count: 3 }],
    });
    await insertRollup({
      userId: user,
      containerId: container,
      reporterRunId: run,
      sequence: 2,
      endedAt: new Date(now.getTime() + 5 * 60_000),
      counts: [{ tool: "Bash", outcome: "failure", errorClass: "other", failureKind: "unknown", count: 9 }],
    });
    const pool = { query } as unknown as import("pg").Pool;
    for (const [session, occurredAt] of [
      ["old-delayed", new Date(now.getTime() - 2 * 60 * 60_000)],
      ["current", new Date(now.getTime() - 5 * 60_000)],
      ["future", new Date(now.getTime() + 5 * 60_000)],
    ] as const) {
      await writeAgentAudit(pool, {
        user_id: user.toString(),
        session_id: session,
        tool: "Bash",
        input_meta: { error_class: "other" },
        input_hash: null,
        output_hash: null,
        duration_ms: 10,
        success: false,
        error_msg: null,
        occurred_at: occurredAt,
      });
    }

    const stats = await getAgentAuditStats({ window: "1h", userId: user, now });
    assert.deepEqual(stats.rollup, {
      success_calls: 3,
      failure_calls: 0,
      total_calls: 3,
      failure_rate: 0,
      tools: [
        { tool: "Bash", success_calls: 3, failure_calls: 0, total_calls: 3, failure_rate: 0 },
      ],
    });
    assert.equal(stats.failures.events, 1);
    assert.equal(stats.failures.groups[0].sessions, 1);
    assert.equal(stats.coverage.covered_containers, 1);

    const rows = await listAgentAudit({ userId: user });
    const current = rows.rows.find((row) => row.session_id === "current");
    assert.equal(current?.created_at.toISOString(), new Date(now.getTime() - 5 * 60_000).toISOString());
  });
});

// ============================================================
//  requireAdmin 中间件
// ============================================================

describe("requireAdmin", () => {
  test("role=user → 403 FORBIDDEN", async (t) => {
    if (skipIfNoPg(t)) return;
    const token = await signAccess({ sub: "42", role: "user" }, JWT_SECRET);
    const fakeReq = {
      headers: { authorization: `Bearer ${token.token}` },
    } as unknown as IncomingMessage;
    await assert.rejects(
      () => requireAdmin(fakeReq, JWT_SECRET),
      (err: unknown) => err instanceof HttpError && err.status === 403 && err.code === "FORBIDDEN",
    );
  });

  test("role=admin → 通过,返回 user", async (t) => {
    if (skipIfNoPg(t)) return;
    const token = await signAccess({ sub: "99", role: "admin" }, JWT_SECRET);
    const fakeReq = {
      headers: { authorization: `Bearer ${token.token}` },
    } as unknown as IncomingMessage;
    const u = await requireAdmin(fakeReq, JWT_SECRET);
    assert.equal(u.id, "99");
    assert.equal(u.role, "admin");
  });

  test("无 token → 401 UNAUTHORIZED(仍然由 requireAuth 判,不是 403)", async (t) => {
    if (skipIfNoPg(t)) return;
    const fakeReq = { headers: {} } as unknown as IncomingMessage;
    await assert.rejects(
      () => requireAdmin(fakeReq, JWT_SECRET),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );
  });
});

// ============================================================
//  HTTP end-to-end(GET /api/admin/agent-audit)
// ============================================================

describe("GET /api/admin/agent-audit (integ)", () => {
  async function getJson(
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${baseUrl}${path}`, { headers });
    let json: Record<string, unknown> = {};
    try { json = (await r.json()) as Record<string, unknown>; } catch { /* */ }
    return { status: r.status, json };
  }

  test("未认证 → 401", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await getJson("/api/admin/agent-audit");
    assert.equal(r.status, 401);
  });

  test("非 admin → 403 FORBIDDEN", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser("reader@x.com", "user");
    const tok = await signAccess({ sub: uid.toString(), role: "user" }, JWT_SECRET);
    const r = await getJson("/api/admin/agent-audit", {
      Authorization: `Bearer ${tok.token}`,
    });
    assert.equal(r.status, 403);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "FORBIDDEN");
  });

  test("admin 查询全表:按 id DESC + ISO 时间", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin@x.com", "admin");
    const u1 = await createUser("op@x.com", "user");
    await insertAudit(u1, "sA", "bash", true);
    await insertAudit(u1, "sA", "read", true);
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson("/api/admin/agent-audit", {
      Authorization: `Bearer ${tok.token}`,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    // ISO 时间格式
    assert.match(String(rows[0].created_at), /^\d{4}-\d{2}-\d{2}T/);
    // 按 id DESC
    assert.ok(BigInt(rows[0].id as string) > BigInt(rows[1].id as string));
    // next_before(本页只有 2 条 + 默认 limit=50 未满 → null)
    assert.equal(r.json.next_before, null);
  });

  test("admin 查询:user_id + tool 过滤联合作用", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin2@x.com", "admin");
    const u1 = await createUser("f1@x.com", "user");
    const u2 = await createUser("f2@x.com", "user");
    await insertAudit(u1, "s", "bash", true);
    await insertAudit(u1, "s", "read", true);
    await insertAudit(u2, "s", "bash", true);
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?user_id=${u1}&tool=bash`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 200);
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, u1.toString());
    assert.equal(rows[0].tool, "bash");
  });

  test("admin 查询:非法 tool → 400 VALIDATION", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin3@x.com", "admin");
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      "/api/admin/agent-audit?tool=bash%3B%20--", // "bash; --" URL-encoded
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 400);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "VALIDATION");
  });

  test("admin 查询:limit 超上限 → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin4@x.com", "admin");
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?limit=${AGENT_AUDIT_MAX_LIMIT + 1}`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 400);
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "VALIDATION");
  });

  test("admin 查询:keyset 分页 limit=2 → next_before 可继续翻", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin5@x.com", "admin");
    const u = await createUser("kop@x.com", "user");
    for (let i = 0; i < 5; i++) {
      await insertAudit(u, "s", "bash", true);
    }
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r1 = await getJson(
      "/api/admin/agent-audit?limit=2",
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r1.status, 200);
    const p1Rows = r1.json.rows as Array<Record<string, unknown>>;
    assert.equal(p1Rows.length, 2);
    assert.ok(r1.json.next_before);

    const r2 = await getJson(
      `/api/admin/agent-audit?limit=2&before=${r1.json.next_before}`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r2.status, 200);
    const p2Rows = r2.json.rows as Array<Record<string, unknown>>;
    assert.equal(p2Rows.length, 2);
    for (const row of p2Rows) {
      assert.ok(BigInt(row.id as string) < BigInt(r1.json.next_before as string));
    }
  });

  // ----- Acceptance (07-TASKS.md T-54) -----

  test("Acceptance 1: audit 包含 tool=bash success=true 可查", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin-acc1@x.com", "admin");
    const u = await createUser("u-ls@x.com", "user");
    // 模拟 "ls /workspace" → 由 gateway 写入 agent_audit(T-52 流程)
    const pool = { query: query } as unknown as import("pg").Pool;
    await writeAgentAudit(pool, {
      user_id: u.toString(),
      session_id: "sess-ls-1",
      tool: "bash",
      input_meta: { cmd: "ls /workspace" },
      input_hash: null,
      output_hash: null,
      duration_ms: 15,
      success: true,
      error_msg: null,
    });
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?user_id=${u}&tool=bash`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 200);
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "bash");
    assert.equal(rows[0].success, true);
  });

  test("Acceptance 2: 错误命令 → 仅返回安全分类，不暴露历史原始预览", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("admin-acc2@x.com", "admin");
    const u = await createUser("u-bad@x.com", "user");
    const pool = { query: query } as unknown as import("pg").Pool;
    await writeAgentAudit(pool, {
      user_id: u.toString(),
      session_id: "sess-bad-1",
      tool: "bash",
      input_meta: { cmd: "notacmd", input_preview: "email=user@example.com" },
      input_hash: null,
      output_hash: null,
      duration_ms: 5,
      success: false,
      error_msg: "command not found",
    });
    const tok = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const r = await getJson(
      `/api/admin/agent-audit?user_id=${u}`,
      { Authorization: `Bearer ${tok.token}` },
    );
    assert.equal(r.status, 200);
    const rows = r.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, false);
    assert.equal(rows[0].error_msg, null);
    const meta = rows[0].input_meta as Record<string, unknown>;
    assert.equal(meta.error_class, "command_not_found");
    assert.equal("input_preview" in meta, false);
  });

  test("stats endpoint requires admin and validates its bounded window", async (t) => {
    if (skipIfNoHttp(t)) return;
    const user = await createUser("stats-reader@x.com", "user");
    const userToken = await signAccess({ sub: user.toString(), role: "user" }, JWT_SECRET);
    const forbidden = await getJson("/api/admin/agent-audit/stats?window=24h", {
      Authorization: `Bearer ${userToken.token}`,
    });
    assert.equal(forbidden.status, 403);

    const admin = await createUser("stats-admin@x.com", "admin");
    const adminToken = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const invalid = await getJson("/api/admin/agent-audit/stats?window=30d", {
      Authorization: `Bearer ${adminToken.token}`,
    });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.json.error as Record<string, unknown>).code, "VALIDATION");
  });

  test("stats endpoint returns explicit best-effort coverage semantics", async (t) => {
    if (skipIfNoHttp(t)) return;
    const admin = await createUser("stats-http-admin@x.com", "admin");
    const user = await createUser("stats-http-user@x.com", "user");
    const container = await insertContainer(user);
    await insertRollup({
      userId: user,
      containerId: container,
      reporterRunId: "4".repeat(32),
      sequence: 1,
      counts: [
        { tool: "Bash", outcome: "success", count: 3 },
        {
          tool: "Bash",
          outcome: "failure",
          errorClass: "command_not_found",
          failureKind: "process_exit",
          count: 1,
        },
      ],
    });
    const adminToken = await signAccess({ sub: admin.toString(), role: "admin" }, JWT_SECRET);
    const response = await getJson("/api/admin/agent-audit/stats?window=24h&tool=Bash", {
      Authorization: `Bearer ${adminToken.token}`,
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const rollup = response.json.rollup as Record<string, unknown>;
    assert.equal(rollup.total_calls, 4);
    assert.equal(rollup.failure_rate, 0.25);
    const coverage = response.json.coverage as Record<string, unknown>;
    assert.equal(coverage.scope, "current_online_fleet");
    assert.equal(coverage.mode, "best_effort");
    assert.equal(coverage.partial, false);
  });
});
