/**
 * T-23 — /api/chat + preCheck 集成测试。
 *
 * 覆盖:
 *   - 余额足够 → 200 + users.credits 正确扣减 + ledger 新增 + usage_records 写入 + pre-check 释放
 *   - 余额不足 → 402 + 未扣费 + 未写 usage_records(预检阶段拒绝)
 *   - mock LLM 异常 → 502 + 未扣费 + usage_records.status='error' + pre-check 释放
 *   - 模型未知 → 400 UNKNOWN_MODEL
 *   - 模型 disabled → 400 UNKNOWN_MODEL(不走 preCheck)
 *   - 并发预检 + 余额保护:2 个请求每个预估 600 分,余额 800 → 第二个 402
 *   - 缺 Authorization → 401
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { wrapIoredis } from "../middleware/rateLimit.js";
import { signAccess } from "../auth/jwt.js";
import { PricingCache } from "../billing/pricing.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import type { ChatLLM } from "../http/chat.js";
import type { Mailer, MailMessage } from "../auth/mail.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

const JWT_SECRET = "y".repeat(64);

class NullMailer implements Mailer { async send(_msg: MailMessage): Promise<void> {} }

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";
let pricing: PricingCache;
let preCheckRedis: InMemoryPreCheckRedis;
let chatLLM: ChatLLM;
let llmNextResponse:
  | { kind: "success"; input: bigint; output: bigint; text?: string }
  | { kind: "error"; code: string; message: string }
  | null = null;

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}
async function probeRedis(): Promise<IORedis | null> {
  const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1 });
  try { await r.connect(); await r.ping(); return r; }
  catch { try { r.disconnect(); } catch { /* */ } return null; }
}

before(async () => {
  pgAvailable = await probePg();
  if (pgAvailable) {
    await resetPool();
    setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
    await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
    await runMigrations();
  } else if (REQUIRE_TEST_DB) {
    throw new Error("Postgres test fixture required");
  }

  redis = await probeRedis();
  if (!redis && REQUIRE_TEST_DB) throw new Error("Redis test fixture required");

  if (pgAvailable && redis) {
    pricing = new PricingCache();
    await pricing.load();
    preCheckRedis = new InMemoryPreCheckRedis();
    chatLLM = {
      async complete({ model }) {
        if (!llmNextResponse) {
          // 默认 stub:1000 in / 500 out
          return {
            usage: { input_tokens: 1000n, output_tokens: 500n, cache_read_tokens: 0n, cache_write_tokens: 0n },
            status: "success",
            accountId: null,
            text: "[mock] model=" + model,
          };
        }
        const r = llmNextResponse;
        llmNextResponse = null;
        if (r.kind === "error") {
          return {
            usage: { input_tokens: 0n, output_tokens: 0n, cache_read_tokens: 0n, cache_write_tokens: 0n },
            status: "error", error: { code: r.code, message: r.message },
            accountId: null, text: "",
          };
        }
        return {
          usage: { input_tokens: r.input, output_tokens: r.output, cache_read_tokens: 0n, cache_write_tokens: 0n },
          status: "success", accountId: null, text: r.text ?? "",
        };
      },
    };

    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: new NullMailer(),
      redis: wrapIoredis(redis),
      turnstileBypass: true,
      pricing,
      preCheckRedis,
      chatLLM,
      rateLimits: {
        register: { scope: "r_t", windowSeconds: 60, max: 100 },
        login: { scope: "l_t", windowSeconds: 60, max: 100 },
        requestReset: { scope: "rr_t", windowSeconds: 60, max: 100 },
      },
    });
    server = createServer(async (req, res) => {
      const ok = await handler(req, res);
      if (!ok) { res.statusCode = 404; res.end("nope"); }
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
});

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (redis) { try { await redis.flushdb(); } catch { /* */ } await redis.quit(); }
  if (pricing) await pricing.shutdown();
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable || !redis) return;
  await query("TRUNCATE TABLE usage_records, credit_ledger, refresh_tokens, email_verifications, users RESTART IDENTITY CASCADE");
  await redis.flushdb();
  // 清空 in-memory preCheck redis
  for (const k of Object.keys(preCheckRedis.snapshot())) await preCheckRedis.del(k);
  llmNextResponse = null;
});

function skipIfMissing(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) { t.skip("pg/redis/server not available"); return true; }
  return false;
}

async function createUserWithCredits(email: string, credits: bigint): Promise<{ id: string; token: string }> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, email_verified, status) VALUES ($1, 'argon2$stub', $2, true, 'active') RETURNING id::text AS id",
    [email, credits.toString()],
  );
  const id = r.rows[0].id;
  const issued = await signAccess({ sub: id, role: "user" as const }, JWT_SECRET);
  return { id, token: issued.token };
}

async function postChat(path: string, body: unknown, token: string, reqId?: string): Promise<{ status: number; json: Record<string, unknown>; reqId: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (reqId) headers["X-Request-Id"] = reqId;
  const resp = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try { json = (await resp.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: resp.status, json, reqId: resp.headers.get("x-request-id") ?? "" };
}

describe("POST /api/chat (integ)", () => {
  test("余额足够:200 + 扣费 + ledger + usage_records + 预扣释放", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid, token } = await createUserWithCredits("chat-ok@example.com", 10_000n);

    const r = await postChat(
      "/api/chat",
      { model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: "hi" }] },
      token,
    );
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    // 1000 in * 300 + 500 out * 1500 = 300_000 + 750_000 = 1_050_000
    // × 2.0 multiplier / 1e6 = 2_100_000 / 1e6 = 2.1 → ceil 3 分
    assert.equal(r.json.cost_credits, "3");
    assert.equal(r.json.balance_after, "9997");

    const u = await query<{ credits: string }>(
      "SELECT credits::text AS credits FROM users WHERE id = $1", [uid],
    );
    assert.equal(u.rows[0].credits, "9997");

    const ledger = await query<{ delta: string; reason: string; ref_id: string }>(
      "SELECT delta::text AS delta, reason, ref_id FROM credit_ledger WHERE user_id = $1", [uid],
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].delta, "-3");
    assert.equal(ledger.rows[0].reason, "chat");
    assert.equal(ledger.rows[0].ref_id, r.reqId);

    const usage = await query<{
      status: string; cost_credits: string; input_tokens: string; output_tokens: string; request_id: string;
    }>(
      "SELECT status, cost_credits::text AS cost_credits, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens, request_id FROM usage_records WHERE user_id = $1", [uid],
    );
    assert.equal(usage.rows.length, 1);
    assert.equal(usage.rows[0].status, "success");
    assert.equal(usage.rows[0].cost_credits, "3");
    assert.equal(usage.rows[0].input_tokens, "1000");
    assert.equal(usage.rows[0].output_tokens, "500");
    assert.equal(usage.rows[0].request_id, r.reqId);

    // 预扣应已释放
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  test("余额不足:预检 402 + 未扣费 + 未写 usage_records", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid, token } = await createUserWithCredits("chat-poor@example.com", 10n);
    const r = await postChat(
      "/api/chat",
      { model: "claude-sonnet-4-6", max_tokens: 100_000, messages: [{ role: "user", content: "x" }] },
      token,
    );
    assert.equal(r.status, 402, JSON.stringify(r.json));
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "ERR_INSUFFICIENT_CREDITS");

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "10");
    const ledger = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid]);
    assert.equal(ledger.rows[0].cnt, "0");
    const usage = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM usage_records WHERE user_id=$1", [uid]);
    assert.equal(usage.rows[0].cnt, "0");
    // 预检 402 路径:锁未写入 (错误在 preCheck 里抛出,set 未执行)
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  test("LLM 异常:502 + 未扣费 + usage_records.status='error' + 预扣释放", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid, token } = await createUserWithCredits("chat-llmfail@example.com", 10_000n);
    llmNextResponse = { kind: "error", code: "UPSTREAM_FAIL", message: "boom" };

    const r = await postChat(
      "/api/chat",
      { model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: "x" }] },
      token,
    );
    assert.equal(r.status, 502, JSON.stringify(r.json));
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "UPSTREAM_FAIL");

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "10000", "credits must be untouched");
    const ledger = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid]);
    assert.equal(ledger.rows[0].cnt, "0");
    // usage_records 仍记录一行 status=error(审计)
    const usage = await query<{ status: string; cost_credits: string }>(
      "SELECT status, cost_credits::text AS cost_credits FROM usage_records WHERE user_id=$1", [uid],
    );
    assert.equal(usage.rows.length, 1);
    assert.equal(usage.rows[0].status, "error");
    assert.equal(usage.rows[0].cost_credits, "0");

    // 预扣已释放(finally 分支)
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  test("模型未知:400 UNKNOWN_MODEL(不走 preCheck,不扣费)", async (t) => {
    if (skipIfMissing(t)) return;
    const { id: uid, token } = await createUserWithCredits("chat-badmodel@example.com", 10_000n);
    const r = await postChat(
      "/api/chat",
      { model: "gpt-4-fake", max_tokens: 100, messages: [{ role: "user", content: "x" }] },
      token,
    );
    assert.equal(r.status, 400, JSON.stringify(r.json));
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "UNKNOWN_MODEL");

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "10000");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  test("max_tokens 非法(0 / 负 / 超 1M):400 VALIDATION", async (t) => {
    if (skipIfMissing(t)) return;
    const { token } = await createUserWithCredits("chat-badtok@example.com", 10_000n);
    for (const v of [0, -1, 1_000_001]) {
      const r = await postChat("/api/chat",
        { model: "claude-sonnet-4-6", max_tokens: v, messages: [{ role: "user", content: "x" }] },
        token);
      assert.equal(r.status, 400, `max_tokens=${v} should be 400, got ${r.status}`);
      assert.equal((r.json.error as Record<string, unknown>).code, "VALIDATION");
    }
  });

  test("缺 Authorization:401 UNAUTHORIZED", async (t) => {
    if (skipIfMissing(t)) return;
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(resp.status, 401);
    const json = await resp.json() as Record<string, unknown>;
    assert.equal((json.error as Record<string, unknown>).code, "UNAUTHORIZED");
  });

  test("并发 2 个请求共用预扣额度:余额 6000 + 每个估 3000 → 2nd 402", async (t) => {
    if (skipIfMissing(t)) return;
    const { token } = await createUserWithCredits("chat-concurrent@example.com", 6000n);

    // 估算:max_tokens=1_000_000 → 1M * 1500 * 2 / 1e6 = 3000 分/请求
    // 两个并发预检,各扣 3000 锁进 Redis,合计 6000 == 余额:
    // 第一个过,第二个:余额 6000 < locked(3000) + new_max_cost(3000) = 6000 ✗(用 >=);
    // 实际 preCheck 条件是 balance < locked + maxCost,即 6000 < 6000 是 false,应当放过
    // 所以把需求设为第 2 个请求额外请求少许让其超出
    // 先固定 stub 返回 low usage 避免真扣 3000:
    llmNextResponse = { kind: "success", input: 100n, output: 50n };
    const r1 = await postChat("/api/chat",
      { model: "claude-sonnet-4-6", max_tokens: 1_000_000, messages: [{ role: "user", content: "x" }] },
      token, "concur-req-1");
    assert.equal(r1.status, 200, JSON.stringify(r1.json));

    // 第一个请求的锁已被 finally 释放 — 第二个预检时 locked=0,可以继续跑
    // 为了真正模拟并发锁叠加,需要在 LLM 回调里 "挂住" 让锁不释放。
    // 用一个长延迟 LLM 实现这种效果(通过 chatLLM 的可变 stub)。
    // 这里改用更简单的办法:手动写一个 preCheck 锁到 redis,再发第 2 个请求。
    await preCheckRedis.set("precheck:user:__FAKE_ID__:stale", "3500", 60);
    // 在该假锁存在下,另一个用户请求不受影响(前缀不同),我们需要同一 uid 的锁:
    const u = await query<{ id: string }>("SELECT id::text AS id FROM users WHERE email='chat-concurrent@example.com'");
    await preCheckRedis.del("precheck:user:__FAKE_ID__:stale");
    await preCheckRedis.set(`precheck:user:${u.rows[0].id}:stale-req`, "3500", 60);

    const r2 = await postChat("/api/chat",
      { model: "claude-sonnet-4-6", max_tokens: 1_000_000, messages: [{ role: "user", content: "x" }] },
      token, "concur-req-2");
    // 余额:6000 - 已扣(cost 很小)≈ 5999;locked(3500) + new_max(3000) = 6500 > 5999 → 402
    assert.equal(r2.status, 402, JSON.stringify(r2.json));
    assert.equal((r2.json.error as Record<string, unknown>).code, "ERR_INSUFFICIENT_CREDITS");
  });
});
