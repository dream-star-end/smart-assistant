/**
 * P0 多租户越权防火墙集成测试 —— `BLOCKED_FOR_USER_RULES` 端到端验证。
 *
 * 背景见 `packages/commercial/src/http/router.ts` 的 `BLOCKED_FOR_USER_RULES`
 * 注释。测试覆盖:
 *   1. 无 token / 非 commercial JWT → **fall through**(测试 wrapper 兜 404,
 *      真线上 gateway 的 `checkHttpAuth` 会正常 401)
 *   2. 伪造/过期 commercial JWT → fall through(签名验不过,等同无 token)
 *   3. user role JWT → **403 FORBIDDEN**(覆盖 memory / skills / cron / tasks /
 *      tasks-executions / search,每个 endpoint 至少一个方法)
 *   4. admin role JWT + DB role=admin, status=active → **fall through**
 *      (DB double-check 过)
 *   5. admin role JWT + DB role 被撤 → 403(撤权即时生效)
 *   6. admin role JWT + DB status=banned → 403
 *   7. admin role JWT + DB row 不存在 → 403(用户被硬删)
 *   8. 未受保护的 commercial 路径(/api/auth/* /api/me 等)不受影响
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { createCommercialHandler } from "../http/router.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
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
  "system_settings", // 0016 —— 其他 integ test 漏列这张;裸 DROP IF EXISTS 不影响
  "users",
  "schema_migrations",
];

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";
/** fall-through 的兜底 404 body,用于和 "真正命中拦截层 403" 区分 */
const FALLTHROUGH_MARKER = "__fallthrough_404__";

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> { /* drop */ }
}

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, {
    lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1,
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
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        // fall-through:真实部署交给 gateway checkHttpAuth,这里模拟一个特征 404,
        // 测试据此断言"拦截层没拦"。
        res.statusCode = 404;
        res.end(FALLTHROUGH_MARKER);
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

after(async () => {
  if (server) {
    try { server.closeAllConnections(); } catch { /* */ }
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try { await redis.flushdb(); } catch { /* */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE admin_audit, usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
  if (redis) await redis.flushdb();
});

function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

async function createUser(
  email: string,
  role: "user" | "admin" = "user",
  status: "active" | "banned" | "deleting" | "deleted" = "active",
): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, $3) RETURNING id::text AS id",
    [email, role, status],
  );
  return BigInt(r.rows[0].id);
}

async function tokenFor(uid: bigint, role: "user" | "admin"): Promise<string> {
  const r = await signAccess({ sub: uid.toString(), role }, JWT_SECRET);
  return r.token;
}

async function fetchWith(
  path: string,
  method: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("BLOCKED_FOR_USER_RULES — user role → 403", () => {
  const cases: Array<{ path: string; method: string }> = [
    // host agent CRUD / 执行面
    { path: "/api/agents", method: "GET" },
    { path: "/api/agents", method: "POST" },
    { path: "/api/agents/main", method: "GET" },
    { path: "/api/agents/main", method: "PUT" },
    { path: "/api/agents/main", method: "DELETE" },
    { path: "/api/agents/main/persona", method: "GET" },
    { path: "/api/agents/main/persona", method: "PUT" },
    { path: "/api/agents/main/message", method: "POST" },
    { path: "/api/agents/main/delegate", method: "POST" },
    // 内存 / 技能
    { path: "/api/agents/main/memory/memory", method: "GET" },
    { path: "/api/agents/main/memory/memory", method: "PUT" },
    { path: "/api/agents/main/memory/user", method: "GET" },
    { path: "/api/agents/main/memory/user", method: "PUT" },
    { path: "/api/agents/main/skills", method: "GET" },
    { path: "/api/agents/main/skills", method: "POST" },
    { path: "/api/agents/main/skills/my-skill", method: "GET" },
    { path: "/api/agents/main/skills/my-skill", method: "DELETE" },
    // host cron / tasks / webhooks(prompt 注入 = RCE)
    { path: "/api/cron", method: "GET" },
    { path: "/api/cron", method: "POST" },
    { path: "/api/cron/task_123", method: "DELETE" },
    { path: "/api/tasks", method: "GET" },
    { path: "/api/tasks", method: "POST" },
    { path: "/api/tasks/abc-123", method: "GET" },
    { path: "/api/tasks-executions", method: "GET" },
    { path: "/api/webhooks", method: "GET" },
    { path: "/api/webhooks/my-hook", method: "POST" },
    { path: "/api/webhooks/my-hook", method: "DELETE" },
    // host 全局信息泄漏(只读)
    { path: "/api/doctor", method: "GET" },
    { path: "/api/runs", method: "GET" },
    { path: "/api/usage", method: "GET" },
    { path: "/api/usage/events", method: "GET" },
    { path: "/api/config", method: "GET" },
    // 跨用户 session FTS
    { path: "/api/search?q=foo", method: "GET" },
    // /api/doctor 全方法 —— Codex R4 发现 gateway 里没校验 method,原 M("GET") 限制让 POST/HEAD 绕过
    { path: "/api/doctor", method: "POST" },
    { path: "/api/doctor", method: "HEAD" },
    // Prometheus 全量指标 —— 任何方法都拦,默认一般只有 GET,但统一拦避免同类型绕过
    { path: "/metrics", method: "GET" },
    { path: "/metrics", method: "POST" },
    // session 迁移 —— 跨租户接管别人 legacy 历史
    { path: "/api/sessions/unclaimed", method: "GET" },
    { path: "/api/sessions/claim", method: "POST" },
    { path: "/api/sessions/claim", method: "PUT" }, // 方法不限,全拦
    // HOST 文件 & HOST 媒体
    { path: "/api/file?path=/etc/passwd", method: "GET" },
    { path: "/api/media/stolen.png", method: "GET" },
    { path: "/api/media/nested/path/to/file.mp4", method: "GET" },
    // OpenAI 兼容层(host RCE via sessions.submit)
    { path: "/v1/chat/completions", method: "POST" },
    { path: "/v1/models", method: "GET" },
    { path: "/v1/embeddings", method: "POST" }, // 即便 gateway 没实现也必须拦
  ];

  // undici: GET/HEAD **不能**带 body,其他方法带空 {} 比 no-body 更接近真实前端请求
  const METHODS_NO_BODY = new Set(["GET", "HEAD"]);
  for (const c of cases) {
    test(`${c.method} ${c.path} — commercial user → 403`, async (t) => {
      if (skipIfNoHttp(t)) return;
      const uid = await createUser(`u${Date.now()}-${Math.random()}@x.com`, "user");
      const tok = await tokenFor(uid, "user");
      const r = await fetchWith(c.path, c.method, tok, METHODS_NO_BODY.has(c.method) ? undefined : {});
      assert.equal(r.status, 403, `status body=${r.text}`);
      // HEAD 不返 body,只靠 status code 断言;其他方法 body 是 JSON error
      if (c.method !== "HEAD") {
        const parsed = JSON.parse(r.text) as { error?: { code?: string } };
        assert.equal(parsed.error?.code, "FORBIDDEN");
        assert.ok(!r.text.includes(FALLTHROUGH_MARKER), "must not fall through");
      }
    });
  }

  test("URL 编码绕过防御 —— 规则用 regex 匹配 decoded pathname", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`bypass${Date.now()}@x.com`, "user");
    const tok = await tokenFor(uid, "user");
    // Codex R4 提醒:Node `URL().pathname` **不自动**解码 %-encoded 段,仍返 `/api/agents/ma%69n/message`。
    // 现行规则 `/^\/api\/agents\/[^/]+\/(message|delegate)$/` 里 `[^/]+` 会吃掉 `ma%69n`(% / 6 / 9
    // 都不是 `/`),所以仍然命中 —— 编码绕过在这个正则下天然无效。测试两种写法都验一把:
    const rRaw = await fetchWith("/api/agents/ma%69n/message", "POST", tok, {});
    assert.equal(rRaw.status, 403, `%-encoded path should still be blocked, body=${rRaw.text}`);
    assert.ok(!rRaw.text.includes(FALLTHROUGH_MARKER));
    // 以防 regex 日后改成 `main` 精确字符串匹配 —— 再补一个 decoded 正常写法兜底断言。
    const rDecoded = await fetchWith("/api/agents/main/message", "POST", tok, {});
    assert.equal(rDecoded.status, 403);
    assert.ok(!rDecoded.text.includes(FALLTHROUGH_MARKER));
  });

  test("trailing-slash 不能绕过(gateway 自己用 exact match,命中规则一致)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`trail${Date.now()}@x.com`, "user");
    const tok = await tokenFor(uid, "user");
    // /api/cron/ —— trailing slash,我们的 regex /^\/api\/cron(\/[^/]+)?$/ 允许
    // (\/[^/]+)? 的 group 是 `/`,但 [^/]+ 要求至少 1 字符 → group 不匹配 →
    // 整体 regex 要求整串 = `/api/cron` 精确。trailing slash 不 match → fall
    // through → gateway 也不匹配其精确 `/api/cron` 路由 → 404。此行为 = 安全
    // (没绕过到任何 host cron handler),仅记录现象。
    const r = await fetchWith("/api/cron/", "GET", tok);
    // 要么 gateway 404(fall through),要么 commercial 404,均可接受 —— 关键:不能是 200。
    assert.notEqual(r.status, 200);
    assert.notEqual(r.status, 201);
  });
});

describe("BLOCKED_FOR_USER_RULES — fall through paths", () => {
  test("no token → fall through(真线上 gateway 自己 401)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await fetchWith("/api/cron", "GET");
    assert.equal(r.status, 404);
    assert.equal(r.text, FALLTHROUGH_MARKER);
  });

  test("invalid JWT → fall through", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await fetchWith("/api/cron", "GET", "not.a.valid.token");
    assert.equal(r.status, 404);
    assert.equal(r.text, FALLTHROUGH_MARKER);
  });

  test("JWT signed with wrong secret → fall through", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await signAccess({ sub: "1", role: "user" }, "w".repeat(64));
    const probe = await fetchWith("/api/cron", "GET", r.token);
    assert.equal(probe.status, 404);
    assert.equal(probe.text, FALLTHROUGH_MARKER);
  });

  test("unrelated path /api/me 不被本层拦截", async (t) => {
    if (skipIfNoHttp(t)) return;
    // /api/me 没带 token → handler 自己回 401 UNAUTHORIZED(由 commercial router
    // 正常 dispatch),不是 FALLTHROUGH_MARKER,证明我们没错拦。
    const r = await fetchWith("/api/me", "GET");
    assert.equal(r.status, 401);
    assert.ok(r.text.includes("UNAUTHORIZED"), `body=${r.text}`);
  });
});

describe("BLOCKED_FOR_USER_RULES — admin double-check", () => {
  test("admin with DB row active → fall through", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`admin${Date.now()}@x.com`, "admin", "active");
    const tok = await tokenFor(uid, "admin");
    const r = await fetchWith("/api/cron", "GET", tok);
    assert.equal(r.status, 404);
    assert.equal(r.text, FALLTHROUGH_MARKER);
  });

  test("admin with DB role 被撤 → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    // JWT 里 role=admin,但 DB 里把他降成 user —— 模拟撤权
    const uid = await createUser(`admin2${Date.now()}@x.com`, "admin", "active");
    const tok = await tokenFor(uid, "admin");
    await query("UPDATE users SET role='user' WHERE id=$1", [uid.toString()]);
    const r = await fetchWith("/api/cron", "GET", tok);
    assert.equal(r.status, 403);
    const parsed = JSON.parse(r.text) as { error?: { code?: string; message?: string } };
    assert.equal(parsed.error?.code, "FORBIDDEN");
    assert.match(String(parsed.error?.message ?? ""), /revoked/);
  });

  test("admin with DB status=banned → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`admin3${Date.now()}@x.com`, "admin", "active");
    const tok = await tokenFor(uid, "admin");
    await query("UPDATE users SET status='banned' WHERE id=$1", [uid.toString()]);
    const r = await fetchWith("/api/cron", "GET", tok);
    assert.equal(r.status, 403);
    const parsed = JSON.parse(r.text) as { error?: { message?: string } };
    assert.match(String(parsed.error?.message ?? ""), /not active/);
  });

  test("admin with DB row 被硬删 → 403", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`admin4${Date.now()}@x.com`, "admin", "active");
    const tok = await tokenFor(uid, "admin");
    await query("DELETE FROM users WHERE id=$1", [uid.toString()]);
    const r = await fetchWith("/api/cron", "GET", tok);
    assert.equal(r.status, 403);
    const parsed = JSON.parse(r.text) as { error?: { message?: string } };
    assert.match(String(parsed.error?.message ?? ""), /not found/);
  });

  test("admin bypass 成功 → admin_audit 写一条 blocked_route_bypass", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`audit${Date.now()}@x.com`, "admin", "active");
    const tok = await tokenFor(uid, "admin");
    // 拿不同的 endpoint label 做断言 —— 覆盖几个新增规则,审计 target 里能看到具体路径+方法
    const r = await fetchWith("/api/sessions/unclaimed", "GET", tok);
    assert.equal(r.status, 404); // admin bypass → gateway mock 返 FALLTHROUGH 404
    assert.equal(r.text, FALLTHROUGH_MARKER);

    // writeAdminAudit 是 best-effort 异步(不 await),给它一点时间刷盘
    await new Promise((r) => setTimeout(r, 120));

    const audit = await query<{
      admin_id: string;
      action: string;
      target: string;
      after: { path: string } | null;
    }>(
      "SELECT admin_id::text AS admin_id, action, target, after FROM admin_audit WHERE admin_id=$1 AND action=$2 ORDER BY id DESC LIMIT 1",
      [uid.toString(), "blocked_route_bypass"],
    );
    assert.equal(audit.rows.length, 1, "must have written exactly one audit row");
    const row = audit.rows[0];
    assert.equal(row.action, "blocked_route_bypass");
    assert.equal(row.target, "GET /api/sessions/(unclaimed|claim)");
    assert.deepStrictEqual(row.after, { path: "/api/sessions/unclaimed" });
  });

  test("admin bypass 审计写失败 → fall through 仍然发生(best-effort 不阻塞)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const uid = await createUser(`auditfail${Date.now()}@x.com`, "admin", "active");
    const tok = await tokenFor(uid, "admin");
    // 触发 writeAdminAudit 抛错:DROP admin_audit 表让 INSERT 抛 undefined_table。
    // writeAdminAudit 是 fire-and-forget + .catch(warn),handler 不 await,fall through 不受影响。
    // finally 直接用 0006 migration 里的 DDL 手工复建(不动 schema_migrations,避免和 runMigrations
    // 里 rate_limit_events 表已存在冲突)。
    await query("DROP TABLE IF EXISTS admin_audit CASCADE");
    try {
      const r = await fetchWith("/v1/chat/completions", "POST", tok, { messages: [] });
      // admin bypass 照常 fall through,测试 mock server 回 404 + marker
      assert.equal(r.status, 404, `fall through expected, body=${r.text}`);
      assert.equal(r.text, FALLTHROUGH_MARKER);
      // 给 best-effort 写审计的 promise 一点时间 settle 再继续(它应该 reject,但不能炸)
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await query(
        `CREATE TABLE admin_audit (
           id         BIGSERIAL PRIMARY KEY,
           admin_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
           action     TEXT NOT NULL,
           target     TEXT,
           before     JSONB,
           after      JSONB,
           ip         INET,
           user_agent TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await query("CREATE INDEX idx_aa_admin_admin_time ON admin_audit(admin_id, created_at DESC)");
      await query("CREATE INDEX idx_aa_admin_action_time ON admin_audit(action, created_at DESC)");
      await query("CREATE RULE aa_admin_no_update AS ON UPDATE TO admin_audit DO INSTEAD NOTHING");
      await query("CREATE RULE aa_admin_no_delete AS ON DELETE TO admin_audit DO INSTEAD NOTHING");
    }
  });
});
