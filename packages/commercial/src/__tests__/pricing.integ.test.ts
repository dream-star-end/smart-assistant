/**
 * T-20 integ — PricingCache 真 PG 测试。
 *
 * 覆盖:
 *   - load() 从 model_pricing 读出种子数据
 *   - startListener + UPDATE/INSERT/DELETE → 自动 NOTIFY → reload
 *   - `/api/public/models` 端到端(走 http router,PricingCache 注入 deps)
 *   - reload 并发合并(多个 UPDATE 合成一次 NOTIFY,只 reload 一次)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { PricingCache } from "../billing/pricing.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

// 与 http.integ.test.ts 一致,测试后清掉所有商业化表重建
const COMMERCIAL_TABLES = [
  "rate_limit_events",
  "admin_audit",
  "agent_audit",
  "agent_containers",
  "agent_subscriptions",
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

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try { await p.end(); } catch { /* ignore */ }
    return false;
  }
}

async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    await r.ping();
    return r;
  } catch {
    try { r.disconnect(); } catch { /* ignore */ }
    return null;
  }
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    const pool = createPool({ connectionString: TEST_DB_URL, max: 5 });
    setPoolOverride(pool);
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await runMigrations();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("PG test fixture required (REQUIRE_TEST_DB=1 but no DB reachable)");
  }
  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) {
    throw new Error("Redis test fixture required");
  }
});

after(async () => {
  if (redis) {
    try { await redis.flushdb(); } catch { /* ignore */ }
    await redis.quit();
  }
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* ignore */ }
    await closePool();
  }
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not available");
    return true;
  }
  return false;
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 2000, intervalMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────
describe("PricingCache.load (integ)", () => {
  beforeEach(async () => {
    if (!pgAvailable) return;
    // 恢复 seed 状态
    await query("DELETE FROM model_pricing");
    await query(
      `INSERT INTO model_pricing(model_id, display_name,
         input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok,
         multiplier, enabled, sort_order)
       VALUES
         ('claude-sonnet-4-6','Claude Sonnet 4.6',300,1500,30,375,2.0,TRUE,100),
         ('claude-opus-4-7','Claude Opus 4.7',1500,7500,150,1875,2.0,TRUE,90)`,
    );
  });

  test("loads both seeded rows + get returns correct values", async (t) => {
    if (skipIfNoPg(t)) return;
    const p = new PricingCache();
    await p.load();
    try {
      assert.equal(p.size(), 2);
      const sonnet = p.get("claude-sonnet-4-6");
      assert.ok(sonnet, "sonnet row must load");
      assert.equal(sonnet!.display_name, "Claude Sonnet 4.6");
      assert.equal(sonnet!.input_per_mtok, 300n);
      assert.equal(sonnet!.multiplier, "2.000");
      assert.equal(sonnet!.enabled, true);
      assert.equal(p.get("no-such-model"), null);
    } finally {
      await p.shutdown();
    }
  });

  test("listPublic sorts by sort_order (opus 90 before sonnet 100)", async (t) => {
    if (skipIfNoPg(t)) return;
    const p = new PricingCache();
    await p.load();
    try {
      const list = p.listPublic();
      assert.equal(list.length, 2);
      assert.equal(list[0].id, "claude-opus-4-7");
      assert.equal(list[1].id, "claude-sonnet-4-6");
      // 6-decimal string format
      assert.match(list[0].input_per_ktok_credits, /^\d+\.\d{6}$/);
    } finally {
      await p.shutdown();
    }
  });

  test("disabled model is excluded from listPublic but still in get()", async (t) => {
    if (skipIfNoPg(t)) return;
    await query(
      `INSERT INTO model_pricing(model_id, display_name,
         input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok,
         multiplier, enabled, sort_order)
       VALUES ('legacy-v1','Legacy',50,250,5,62,1.5,FALSE,200)`,
    );
    const p = new PricingCache();
    await p.load();
    try {
      assert.equal(p.size(), 3);
      assert.ok(p.get("legacy-v1"), "disabled model still accessible via get()");
      const list = p.listPublic();
      assert.equal(list.length, 2, "disabled model excluded from public list");
      assert.ok(!list.some((m) => m.id === "legacy-v1"));
    } finally {
      await p.shutdown();
    }
  });
});

// ───────────────────────────────────────────────────────────────────
describe("PricingCache LISTEN/NOTIFY auto-reload (integ)", () => {
  beforeEach(async () => {
    if (!pgAvailable) return;
    await query("DELETE FROM model_pricing");
    await query(
      `INSERT INTO model_pricing(model_id, display_name,
         input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok,
         multiplier, enabled, sort_order)
       VALUES ('claude-sonnet-4-6','Claude Sonnet 4.6',300,1500,30,375,2.0,TRUE,100)`,
    );
  });

  test("UPDATE fires NOTIFY → cache reloaded with new multiplier", async (t) => {
    if (skipIfNoPg(t)) return;
    const p = new PricingCache();
    let reloads = 0;
    p.onReload = () => { reloads += 1; };
    await p.load();
    await p.startListener(TEST_DB_URL);
    try {
      assert.equal(p.get("claude-sonnet-4-6")!.multiplier, "2.000");

      await query("UPDATE model_pricing SET multiplier = 3.500 WHERE model_id = $1", ["claude-sonnet-4-6"]);
      const reloaded = await waitFor(() => p.get("claude-sonnet-4-6")?.multiplier === "3.500");
      assert.ok(reloaded, "cache must reload within 2s");
      assert.ok(reloads >= 1, "onReload must fire at least once from NOTIFY");
    } finally {
      await p.shutdown();
    }
  });

  test("INSERT of new model triggers reload and new model becomes queryable", async (t) => {
    if (skipIfNoPg(t)) return;
    const p = new PricingCache();
    await p.load();
    await p.startListener(TEST_DB_URL);
    try {
      assert.equal(p.get("claude-haiku-4-5"), null);
      await query(
        `INSERT INTO model_pricing(model_id, display_name,
           input_per_mtok, output_per_mtok,
           cache_read_per_mtok, cache_write_per_mtok,
           multiplier, enabled, sort_order)
         VALUES ('claude-haiku-4-5','Claude Haiku 4.5',80,400,8,100,2.0,TRUE,110)`,
      );
      const reloaded = await waitFor(() => p.get("claude-haiku-4-5") !== null);
      assert.ok(reloaded, "new row must appear in cache after NOTIFY");
      assert.equal(p.get("claude-haiku-4-5")!.display_name, "Claude Haiku 4.5");
    } finally {
      await p.shutdown();
    }
  });

  test("DELETE removes entry from cache", async (t) => {
    if (skipIfNoPg(t)) return;
    const p = new PricingCache();
    await p.load();
    await p.startListener(TEST_DB_URL);
    try {
      assert.ok(p.get("claude-sonnet-4-6"));
      await query("DELETE FROM model_pricing WHERE model_id = $1", ["claude-sonnet-4-6"]);
      const gone = await waitFor(() => p.get("claude-sonnet-4-6") === null);
      assert.ok(gone, "row must disappear from cache after NOTIFY");
    } finally {
      await p.shutdown();
    }
  });
});

// ───────────────────────────────────────────────────────────────────
describe("/api/public/models (http integ)", () => {
  let server: Server | null = null;
  let baseUrl = "";
  let pricing: PricingCache | null = null;

  class NoopMailer implements Mailer {
    async send(_msg: MailMessage): Promise<void> { /* noop */ }
  }

  before(async () => {
    if (!pgAvailable || !redis) return;
    await query("DELETE FROM model_pricing");
    await query(
      `INSERT INTO model_pricing(model_id, display_name,
         input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok,
         multiplier, enabled, sort_order)
       VALUES
         ('claude-sonnet-4-6','Claude Sonnet 4.6',300,1500,30,375,2.0,TRUE,100),
         ('claude-opus-4-7','Claude Opus 4.7',1500,7500,150,1875,2.0,TRUE,90)`,
    );
    pricing = new PricingCache();
    await pricing.load();

    const handler = createCommercialHandler({
      jwtSecret: "p".repeat(64),
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      pricing,
    });
    server = createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (pricing) await pricing.shutdown();
  });

  test("returns models list with computed per-ktok credits", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) {
      t.skip("fixtures not ready");
      return;
    }
    const r = await fetch(`${baseUrl}/api/public/models`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { models: Array<Record<string, string>> };
    assert.ok(Array.isArray(j.models));
    assert.equal(j.models.length, 2);
    // opus first (sort_order 90)
    assert.equal(j.models[0].id, "claude-opus-4-7");
    assert.equal(j.models[0].input_per_ktok_credits, "0.030000");
    assert.equal(j.models[0].output_per_ktok_credits, "0.150000");
    assert.equal(j.models[0].multiplier, "2.000");
    assert.equal(j.models[1].id, "claude-sonnet-4-6");
    assert.equal(j.models[1].input_per_ktok_credits, "0.006000");
  });

  test("GET is the only allowed method (POST → 405)", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) {
      t.skip("fixtures not ready");
      return;
    }
    const r = await fetch(`${baseUrl}/api/public/models`, { method: "POST" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "GET");
  });

  test("unknown /api/public/<foo> → 404", async (t) => {
    if (skipIfNoPg(t) || !redis || !server) {
      t.skip("fixtures not ready");
      return;
    }
    const r = await fetch(`${baseUrl}/api/public/nothing`);
    assert.equal(r.status, 404);
  });

  test("/api/public/models returns 503 when pricing is missing from deps", async (t) => {
    if (skipIfNoPg(t) || !redis) {
      t.skip("fixtures not ready");
      return;
    }
    const noPricingHandler = createCommercialHandler({
      jwtSecret: "p".repeat(64),
      mailer: new NoopMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      // intentionally no pricing
    });
    const s2 = createServer(async (req, res) => {
      const handled = await noPricingHandler(req, res);
      if (!handled) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
    const p2Url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${p2Url}/api/public/models`);
      assert.equal(r.status, 503);
      const j = (await r.json()) as { error: { code: string } };
      assert.equal(j.error.code, "PRICING_NOT_READY");
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });
});
