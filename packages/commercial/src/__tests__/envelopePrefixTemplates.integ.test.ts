/**
 * V3 envv2 Phase 2(2026-05-21)— envelope_prefix_templates 端到端集成测试。
 *
 * 覆盖:
 *   ── DB 层
 *     - listEnvelopePrefixTemplates 返 3 行 active + ORDER 与 PREFIX_VARIANTS 数组对齐
 *     - bootstrap seed 字面 byte-equal externalEnvelope.ts 历史硬编码(Phase 0 baseline 锁)
 *     - updateEnvelopePrefixTemplate:更新 text + 写 admin_audit(摘要,不存明文)
 *     - 非 active 变体 / 未知 variant → PrefixTemplateNotFoundError
 *     - normalizePrefixText: 空 / 纯空白 / 非 string / 超长 → RangeError
 *   ── NOTIFY trigger 联动
 *     - PrefixTemplateCache 开 LISTEN,patch 后收到 envelope_prefix_templates_changed → onReload 触发,cache.get(variant) 反映新值
 *   ── HTTP 层
 *     - GET /api/admin/envelope-prefix-templates:非 admin 403 / admin 200 + 3 行
 *     - PUT /:variant:合法 → 200 + reload + 元信息,unknown variant → 404,非法 text → 400
 *     - 非法 method → 405
 *
 * pg/redis 不可用时 skip。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { createCommercialHandler } from "../http/router.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import IORedis from "ioredis";
import { wrapIoredis } from "../middleware/rateLimit.js";
import {
  listEnvelopePrefixTemplates,
  updateEnvelopePrefixTemplate,
  normalizePrefixText,
  PrefixTemplateNotFoundError,
  PREFIX_TEMPLATE_TEXT_MAX_LEN,
} from "../admin/envelopePrefixTemplates.js";
import {
  PrefixTemplateCache,
  PREFIX_VARIANTS,
  startPrefixTemplateCache,
  _resetPrefixTemplateCacheForTesting,
  getPrefixTemplateCache,
} from "../envelope/prefixTemplateCache.js";
import { listAdminAudit } from "../admin/audit.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

const COMMERCIAL_TABLES = [
  "envelope_prefix_templates",
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
  "users",
  "schema_migrations",
];

// 这三个字面是 0071 bootstrap seed + externalEnvelope.ts 历史硬编码,Phase 0 baseline。
// 此测试守门:任何漂移(seed / migration / 字符串)在这里先红。
const SEED_DEFAULT =
  `You are Claude Code, Anthropic's official CLI for Claude.`;
const SEED_AGENT_SDK_CC_PRESET =
  `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`;
const SEED_AGENT_SDK =
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`;

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";

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
  // 0071 的 CREATE FUNCTION 用 CREATE OR REPLACE,trigger 用 DROP IF EXISTS,
  // 因此重放 runMigrations 安全 — 这里不需要额外 DROP FUNCTION。
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
        register: { scope: "register_envp", windowSeconds: 60, max: 100 },
        login: { scope: "login_envp", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_envp", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) { res.statusCode = 404; res.end("nope"); }
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
  _resetPrefixTemplateCacheForTesting();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    "TRUNCATE TABLE admin_audit, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE",
  );
  // 重置 envelope_prefix_templates 回 seed 字面 — TRUNCATE 不会破坏表本身,直接 UPDATE 即可
  // 注意:用 $$...$$ dollar-quote 否则单引号在 ts string 里要双重转义
  await query(
    `UPDATE envelope_prefix_templates SET text = $1, updated_at = NOW(), updated_by = NULL WHERE variant = 'default'`,
    [SEED_DEFAULT],
  );
  await query(
    `UPDATE envelope_prefix_templates SET text = $1, updated_at = NOW(), updated_by = NULL WHERE variant = 'agent_sdk_claude_code_preset'`,
    [SEED_AGENT_SDK_CC_PRESET],
  );
  await query(
    `UPDATE envelope_prefix_templates SET text = $1, updated_at = NOW(), updated_by = NULL WHERE variant = 'agent_sdk'`,
    [SEED_AGENT_SDK],
  );
  if (redis) await redis.flushdb();
  _resetPrefixTemplateCacheForTesting();
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
  email: string, role: "user" | "admin" = "user",
): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [email, role],
  );
  return BigInt(r.rows[0].id);
}

async function tokenFor(uid: bigint, role: "user" | "admin"): Promise<string> {
  const r = await signAccess({ sub: uid.toString(), role }, JWT_SECRET);
  return r.token;
}

// ============================================================
// DB 层
// ============================================================

describe("envelope_prefix_templates — DB layer", () => {
  test("listEnvelopePrefixTemplates: 3 行 active + ORDER 与 PREFIX_VARIANTS 数组对齐", async (t) => {
    if (skipIfNoPg(t)) return;
    const rows = await listEnvelopePrefixTemplates();
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.variant),
      [...PREFIX_VARIANTS],
    );
    for (const r of rows) assert.equal(r.active, true);
  });

  test("bootstrap seed 字面 byte-equal externalEnvelope.ts 历史硬编码(Phase 0 baseline 锁)", async (t) => {
    if (skipIfNoPg(t)) return;
    const rows = await listEnvelopePrefixTemplates();
    const byVariant = new Map(rows.map((r) => [r.variant, r.text]));
    assert.equal(byVariant.get("default"), SEED_DEFAULT);
    assert.equal(byVariant.get("agent_sdk_claude_code_preset"), SEED_AGENT_SDK_CC_PRESET);
    assert.equal(byVariant.get("agent_sdk"), SEED_AGENT_SDK);
  });

  test("updateEnvelopePrefixTemplate: 更新 text + admin_audit(摘要,不存明文)", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const newText = `${SEED_DEFAULT} (revised)`;
    const after = await updateEnvelopePrefixTemplate("default", newText, {
      adminId: admin, ip: "1.2.3.4", userAgent: "UA",
    });
    assert.equal(after.text, newText);
    assert.equal(after.updated_by, admin.toString());

    const audits = await listAdminAudit({ action: "envelope_prefix.put" });
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].target, "variant:default");
    const aObj = audits.rows[0].after as Record<string, unknown>;
    const bObj = audits.rows[0].before as Record<string, unknown>;
    // 摘要存在,且**不**直接含明文 text
    const aText = aObj.text as { len: number; sha256: string; preview: string };
    const bText = bObj.text as { len: number; sha256: string; preview: string };
    assert.equal(aText.len, newText.length);
    assert.equal(bText.len, SEED_DEFAULT.length);
    assert.notEqual(aText.sha256, bText.sha256);
    assert.equal(aText.preview, newText.length > 40 ? `${newText.slice(0, 40)}…` : newText);
    // 防 leak 双保险:audit JSON 串明文不应直接含完整新 text(若被全文落盘可能误暴露 anti-abuse 锚点)
    assert.equal(JSON.stringify(audits.rows[0].after).includes(newText), false);
  });

  test("updateEnvelopePrefixTemplate: 未知 variant → PrefixTemplateNotFoundError", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    // active=FALSE 模拟"variant 行被误删";手工置一行 active=FALSE 看 store 行为
    await query(
      `UPDATE envelope_prefix_templates SET active = FALSE WHERE variant = 'default'`,
    );
    await assert.rejects(
      () => updateEnvelopePrefixTemplate("default", "x", { adminId: admin }),
      (e) => e instanceof PrefixTemplateNotFoundError,
    );
    // 还原(否则后续 cache test 拿不到 default)
    await query(`UPDATE envelope_prefix_templates SET active = TRUE WHERE variant = 'default'`);
  });

  test("normalizePrefixText: 合法/非法边界", () => {
    assert.equal(normalizePrefixText("hello"), "hello");
    assert.equal(normalizePrefixText("a"), "a");
    // 头尾空白**不** trim — anti-abuse 字面字节敏感
    assert.equal(normalizePrefixText("  pad  "), "  pad  ");

    assert.throws(() => normalizePrefixText(""), RangeError);
    assert.throws(() => normalizePrefixText("   \t\n  "), RangeError);
    assert.throws(() => normalizePrefixText(null), RangeError);
    assert.throws(() => normalizePrefixText(123), RangeError);
    assert.throws(() => normalizePrefixText({}), RangeError);
    assert.throws(
      () => normalizePrefixText("x".repeat(PREFIX_TEMPLATE_TEXT_MAX_LEN + 1)),
      (e) => e instanceof RangeError && (e as RangeError).message === "text_too_long",
    );
  });
});

// ============================================================
// NOTIFY 联动
// ============================================================

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("envelope_prefix_templates — NOTIFY 联动", () => {
  test("关键验收:admin 改 text → envelope_prefix_templates_changed → PrefixTemplateCache.onReload 触发 + get() 反映新值", async (t) => {
    if (skipIfNoPg(t)) return;
    const admin = await createUser("a@x.com", "admin");
    const cache = new PrefixTemplateCache();
    let reloadCount = 0;
    const reloadedTwice = new Promise<void>((resolve) => {
      cache.onReload = (_n) => {
        reloadCount += 1;
        if (reloadCount >= 2) resolve(); // 1=initial, 2=after update
      };
    });
    await cache.load();
    await cache.startListener(TEST_DB_URL);

    try {
      assert.equal(cache.get("default"), SEED_DEFAULT);
      const newText = `${SEED_DEFAULT} (updated)`;
      await updateEnvelopePrefixTemplate("default", newText, { adminId: admin });

      await Promise.race([
        reloadedTwice,
        new Promise((_, rej) => setTimeout(() => rej(new Error("NOTIFY timeout")), 3000)),
      ]);
      assert.equal(cache.get("default"), newText);
    } finally {
      await cache.shutdown();
    }
  });

  test("fail-fast:DB 缺一个 active variant → load() 抛 + startPrefixTemplateCache() 抛(Codex Phase 2 FAIL #1)", async (t) => {
    if (skipIfNoPg(t)) return;
    // 故意把 'agent_sdk' 行 deactivate,模拟 DB 误操作 / migration 漂移
    await query(`UPDATE envelope_prefix_templates SET active = FALSE WHERE variant = 'agent_sdk'`);
    try {
      const cache = new PrefixTemplateCache();
      await assert.rejects(
        () => cache.load(),
        (e) =>
          e instanceof Error &&
          /envelope_prefix_templates missing active variants/.test((e as Error).message) &&
          /agent_sdk/.test((e as Error).message),
      );

      _resetPrefixTemplateCacheForTesting();
      await assert.rejects(
        () => startPrefixTemplateCache(TEST_DB_URL),
        (e) => e instanceof Error && /agent_sdk/.test((e as Error).message),
      );
    } finally {
      // 还原供后续 test
      await query(`UPDATE envelope_prefix_templates SET active = TRUE WHERE variant = 'agent_sdk'`);
      _resetPrefixTemplateCacheForTesting();
    }
  });

  test("dirty-bit:in-flight load 期间到达的 schedule 必须最终被处理(Codex Phase 2 FAIL #2)", async (t) => {
    if (skipIfNoPg(t)) return;

    // 目的:验证 dirty-bit 在 scheduleReload 重入时不丢调度。
    // 不走 pg LISTEN/NOTIFY 路径,直接两次手工调度 — 避免 CI 慢机 NOTIFY 异步窗口的不确定性
    // (Codex Phase 2 re-review minor:确定性优于 NOTIFY 时序)
    class TestableCache extends PrefixTemplateCache {
      public loadCallCount = 0;
      public gate: Promise<void> | null = null;
      override async load(): Promise<void> {
        this.loadCallCount += 1;
        const g = this.gate;
        if (g) {
          this.gate = null; // 一次性
          await g;
        }
        await super.load();
      }
      /** test-only:同步触发 schedule,等价于 LISTEN 收到 NOTIFY 时的入口。 */
      kickReload(): void {
        // private 访问 — TS 编译期 `as any` 绕开,运行时无墙
        (this as unknown as { scheduleReload(): void }).scheduleReload();
      }
    }

    const cache = new TestableCache();
    await cache.load(); // initial bootstrap: loadCallCount=1
    assert.equal(cache.loadCallCount, 1);

    try {
      // 给"第一次 schedule 触发的 load"装 gate
      let releaseFirst: () => void = () => {};
      cache.gate = new Promise<void>((r) => (releaseFirst = r));

      // schedule #1 → load 启动 → 卡在 gate
      cache.kickReload();
      // 让微任务跑一轮,load 进入 gate 等待(loadCallCount=2)
      await waitFor(() => cache.loadCallCount === 2, 2000);

      // schedule #2 → reloadInFlight 非空 → 旧版 early-return 丢;新版置 reloadPending=true
      cache.kickReload();
      // 给一个微任务窗口确认不会立刻产生第 3 次 load
      await sleep(20);
      assert.equal(
        cache.loadCallCount,
        2,
        "in-flight 期间的 schedule 不应该立刻启动新 load(应该走 dirty-bit pending)",
      );

      // schedule #3 同期再来一发 — 多次合并仍应只补一次
      cache.kickReload();
      cache.kickReload();
      await sleep(20);
      assert.equal(cache.loadCallCount, 2);

      // 释放第一次 load → finally 看到 reloadPending=true → 补跑一次(loadCallCount=3)
      releaseFirst();
      await waitFor(() => cache.loadCallCount === 3, 2000);

      // 再等一拍,确认不会无限重 schedule(没人再 kick,reloadPending 应已清掉)
      await sleep(50);
      assert.equal(cache.loadCallCount, 3, "无新 kick 不应继续 schedule");
    } finally {
      await cache.shutdown();
    }
  });
});

// ============================================================
// HTTP 层
// ============================================================

describe("envelope_prefix_templates — HTTP", () => {
  test("GET /api/admin/envelope-prefix-templates:非 admin → 403;admin → 200 + 3 行", async (t) => {
    if (skipIfNoHttp(t)) return;
    const u = await createUser("u@x.com");
    const a = await createUser("a@x.com", "admin");
    const uTok = await tokenFor(u, "user");
    const aTok = await tokenFor(a, "admin");

    const r1 = await fetch(`${baseUrl}/api/admin/envelope-prefix-templates`, {
      headers: { Authorization: `Bearer ${uTok}` },
    });
    assert.equal(r1.status, 403);

    const r2 = await fetch(`${baseUrl}/api/admin/envelope-prefix-templates`, {
      headers: { Authorization: `Bearer ${aTok}` },
    });
    assert.equal(r2.status, 200);
    const body = (await r2.json()) as { rows: Array<{ variant: string; text: string }> };
    assert.equal(body.rows.length, 3);
    assert.deepEqual(
      body.rows.map((r) => r.variant),
      [...PREFIX_VARIANTS],
    );
  });

  test("PUT /:variant:合法 → 200 + cache reload (本进程 read-your-write)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");

    // 启 singleton cache 模拟生产环境;PUT 后 admin handler 内部会 await reloadPrefixTemplateCache()
    _resetPrefixTemplateCacheForTesting();
    await startPrefixTemplateCache(TEST_DB_URL);
    const cache = getPrefixTemplateCache()!;
    assert.equal(cache.get("agent_sdk"), SEED_AGENT_SDK);

    try {
      const newText = `${SEED_AGENT_SDK} v2`;
      const r = await fetch(
        `${baseUrl}/api/admin/envelope-prefix-templates/agent_sdk`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
          body: JSON.stringify({ text: newText }),
        },
      );
      assert.equal(r.status, 200);
      const body = (await r.json()) as {
        template: { variant: string; text: string };
        reload_warning?: string;
      };
      assert.equal(body.template.variant, "agent_sdk");
      assert.equal(body.template.text, newText);
      assert.equal(body.reload_warning, undefined);
      // Read-your-write:不依赖 NOTIFY 异步窗口
      assert.equal(cache.get("agent_sdk"), newText);
    } finally {
      await cache.shutdown();
      _resetPrefixTemplateCacheForTesting();
    }
  });

  test("PUT /:variant:unknown variant → 404;非法 text → 400", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");

    // unknown variant — URL slug 形式合法但不在闭合枚举里
    const nf = await fetch(
      `${baseUrl}/api/admin/envelope-prefix-templates/nope_variant`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "x" }),
      },
    );
    assert.equal(nf.status, 404);

    // 非法 text:空串
    const bad1 = await fetch(
      `${baseUrl}/api/admin/envelope-prefix-templates/default`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      },
    );
    assert.equal(bad1.status, 400);

    // 非法 text:缺失
    const bad2 = await fetch(
      `${baseUrl}/api/admin/envelope-prefix-templates/default`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(bad2.status, 400);

    // 非法 text:超长
    const bad3 = await fetch(
      `${baseUrl}/api/admin/envelope-prefix-templates/default`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${aTok}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(PREFIX_TEMPLATE_TEXT_MAX_LEN + 1) }),
      },
    );
    assert.equal(bad3.status, 400);
  });

  test("非法 method → 405 Allow: PUT", async (t) => {
    if (skipIfNoHttp(t)) return;
    const a = await createUser("a@x.com", "admin");
    const aTok = await tokenFor(a, "admin");
    const r = await fetch(
      `${baseUrl}/api/admin/envelope-prefix-templates/default`,
      { method: "DELETE", headers: { Authorization: `Bearer ${aTok}` } },
    );
    assert.equal(r.status, 405);
    assert.ok(r.headers.get("allow")?.includes("PUT"));
  });
});
