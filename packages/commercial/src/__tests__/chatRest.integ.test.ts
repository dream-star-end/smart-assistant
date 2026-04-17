/**
 * T-41 — /api/chat 走真 Claude 编排器(createChatLLMFromRunChat + runClaudeChat)的集成测试。
 *
 * 和 chat.integ.test.ts 的区别:
 *   - chat.integ 注入 stub ChatLLM 验证"扣费/错误/预检"的路由层逻辑
 *   - 本文件注入 `createChatLLMFromRunChat({ scheduler, proxyDeps.fetch: mock })`
 *     验证"SSE 事件流 → 聚合成 JSON 响应"的适配器 + orchestrator 集成路径
 *
 * 覆盖:
 *   1. 成功:mock 5 个 SSE 事件(start/delta×2/message_delta/stop) → 200 + text 拼接 +
 *      usage 正确 + 扣费 + debit/done/ledger/usage_records 落库 + preCheck 释放
 *   2. 上游 500 → 502 ERR_UPSTREAM + 未扣费 + usage_records.status='error' + preCheck 释放
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { createCommercialHandler } from "../http/router.js";
import { signAccess } from "../auth/jwt.js";
import { PricingCache } from "../billing/pricing.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { createAccount } from "../account-pool/store.js";
import { AccountHealthTracker, InMemoryHealthRedis } from "../account-pool/health.js";
import { AccountScheduler } from "../account-pool/scheduler.js";
import { createChatLLMFromRunChat } from "../http/chat.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import type { RateLimitRedis } from "../middleware/rateLimit.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

const JWT_SECRET = "y".repeat(64);
const KEY = randomBytes(KMS_KEY_BYTES);
const keyFn = (): Buffer => Buffer.from(KEY);

class NullMailer implements Mailer { async send(_msg: MailMessage): Promise<void> {} }

/**
 * 满足 RateLimitRedis 接口的 inline 无脑实现:永不 rate-limit。
 * 本测试关注 /api/chat 扣费路径,限流逻辑在别的测试覆盖。
 */
const noopRateRedis: RateLimitRedis = {
  async incr(_k: string): Promise<number> { return 1; },
  async expire(_k: string, _s: number): Promise<number> { return 1; },
};

let pgAvailable = false;
let server: Server | null = null;
let baseUrl = "";
let pricing: PricingCache;
let preCheckRedis: InMemoryPreCheckRedis;
let currentMockFetch: typeof fetch = (async () => {
  throw new Error("no fetch mock installed");
}) as unknown as typeof fetch;

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();

  pricing = new PricingCache();
  await pricing.load();
  preCheckRedis = new InMemoryPreCheckRedis();

  const healthRedis = new InMemoryHealthRedis();
  const tracker = new AccountHealthTracker({ redis: healthRedis });
  const scheduler = new AccountScheduler({ health: tracker, keyFn });

  // 真 LLM 适配器,注入 mock fetch —— 每个用例换 currentMockFetch
  const realChatLLM = createChatLLMFromRunChat({
    scheduler,
    proxyDeps: { fetch: ((...a: unknown[]) => currentMockFetch(...(a as [string, RequestInit?]))) as unknown as typeof fetch },
    refreshDeps: { keyFn, now: () => new Date() },
  });

  const handler = createCommercialHandler({
    jwtSecret: JWT_SECRET,
    mailer: new NullMailer(),
    redis: noopRateRedis,
    turnstileBypass: true,
    pricing,
    preCheckRedis,
    chatLLM: realChatLLM,
  });

  server = createServer(async (req, res) => {
    const ok = await handler(req, res);
    if (!ok) { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) {
    try { server.closeAllConnections(); } catch { /* */ }
    await new Promise<void>((r) => server!.close(() => r()));
  }
  if (pricing) await pricing.shutdown();
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE usage_records, credit_ledger, claude_accounts, users RESTART IDENTITY CASCADE");
  for (const k of Object.keys(preCheckRedis.snapshot())) await preCheckRedis.del(k);
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !server) { t.skip("pg / server not available"); return true; }
  return false;
}

async function createUser(email: string, credits: bigint): Promise<{ id: string; token: string }> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, email_verified, status) VALUES ($1, 'argon2$stub', $2, true, 'active') RETURNING id::text AS id",
    [email, credits.toString()],
  );
  const id = r.rows[0].id;
  const issued = await signAccess({ sub: id, role: "user" as const }, JWT_SECRET);
  return { id, token: issued.token };
}

function sseResponse(status: number, chunks: string[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl): void {
      const enc = new TextEncoder();
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, { status, headers });
}

async function postChat(
  body: unknown,
  token: string,
  requestId?: string,
): Promise<{ status: number; json: Record<string, unknown>; reqId: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (requestId) headers["x-request-id"] = requestId;
  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await resp.json()) as Record<string, unknown>; } catch { /* */ }
  return { status: resp.status, json, reqId: resp.headers.get("x-request-id") ?? "" };
}

describe("POST /api/chat with runClaudeChat (T-41)", () => {
  test("SSE 5 事件 → 200 + text 拼接 + usage + 扣费 + 预检释放", async (t) => {
    if (skipIfNoDb(t)) return;
    const { id: uid, token } = await createUser("rest-ok@example.com", 10_000n);
    await createAccount({ label: "rest", plan: "pro", token: "TOK" }, keyFn);
    currentMockFetch = (async () => sseResponse(200, [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])) as unknown as typeof fetch;

    const r = await postChat(
      { model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: "hi" }] },
      token,
    );

    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.text, "hello world");
    const usage = r.json.usage as Record<string, number>;
    assert.equal(usage.input_tokens, 20);
    assert.equal(usage.output_tokens, 10);
    // cost: (20 * 300 + 10 * 1500) * 2.0 / 1e6 = 21_000 * 2 / 1e6 = 0.042 → ceil 1 分
    assert.equal(r.json.cost_credits, "1");
    assert.equal(r.json.balance_after, "9999");

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "9999");
    const ledger = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid]);
    assert.equal(ledger.rows[0].cnt, "1");
    const usageRow = await query<{ status: string; input_tokens: string; output_tokens: string }>(
      "SELECT status, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens FROM usage_records WHERE user_id=$1",
      [uid],
    );
    assert.equal(usageRow.rows[0].status, "success");
    assert.equal(usageRow.rows[0].input_tokens, "20");
    assert.equal(usageRow.rows[0].output_tokens, "10");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  test("上游 500 → 502 + usage_records.status='error' + 余额未动 + 预检释放", async (t) => {
    if (skipIfNoDb(t)) return;
    const { id: uid, token } = await createUser("rest-500@example.com", 5_000n);
    await createAccount({ label: "rest500", plan: "pro", token: "T2" }, keyFn);
    currentMockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const r = await postChat(
      { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "x" }] },
      token,
    );
    assert.equal(r.status, 502, JSON.stringify(r.json));
    const err = r.json.error as Record<string, unknown>;
    assert.equal(err.code, "ERR_UPSTREAM");

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "5000", "credits must be untouched");
    const rows = await query<{ status: string; cost_credits: string }>(
      "SELECT status, cost_credits::text AS cost_credits FROM usage_records WHERE user_id=$1",
      [uid],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, "error");
    assert.equal(rows.rows[0].cost_credits, "0");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  /**
   * 幂等(0009_chat_idempotency):同一 x-request-id 重放成功请求 → 返回相同 ledger_id /
   * usage_record_id,不二次扣费,DB 行数不增。覆盖 debit.ts 顶部的"existing usage_records
   * 命中直接返回"路径。
   */
  test("重放同一 x-request-id(上次成功)→ 幂等返回,不二次扣费", async (t) => {
    if (skipIfNoDb(t)) return;
    const { id: uid, token } = await createUser("rest-replay-ok@example.com", 10_000n);
    await createAccount({ label: "replay-ok", plan: "pro", token: "TOK-REPLAY" }, keyFn);
    const rid = "fixed-rid-replay-ok-1";
    const successMock = (async () => sseResponse(200, [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])) as unknown as typeof fetch;

    currentMockFetch = successMock;
    const r1 = await postChat(
      { model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: "hi" }] },
      token,
      rid,
    );
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.reqId, rid);
    assert.equal(r1.json.balance_after, "9999");
    const firstLedger = r1.json.ledger_id as string;
    const firstUsage = r1.json.usage_record_id as string;

    // 第二次用同 request_id;即便换个返回不一样的 mock,debitChatSuccess 里
    // "existing usage_records 命中"分支会跳过 LLM 级别的差异校验,直接按首条记录返回。
    // 这里依然注入成功 mock,保证不会因 LLM 差异污染断言。
    currentMockFetch = successMock;
    const r2 = await postChat(
      { model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: "hi" }] },
      token,
      rid,
    );
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r2.reqId, rid);
    assert.equal(r2.json.ledger_id, firstLedger, "same ledger_id on replay");
    assert.equal(r2.json.usage_record_id, firstUsage, "same usage_record_id on replay");
    assert.equal(r2.json.balance_after, "9999", "balance unchanged on replay");

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "9999", "user credits must match single debit");
    const ledger = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid]);
    assert.equal(ledger.rows[0].cnt, "1", "credit_ledger must have exactly 1 row after replay");
    const usage = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM usage_records WHERE user_id=$1", [uid]);
    assert.equal(usage.rows[0].cnt, "1", "usage_records must have exactly 1 row after replay");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });

  /**
   * 重放上次 error 的 request_id → 409 ERR_REQUEST_ID_EXHAUSTED(debit.ts 的
   * RequestRetryWithDifferentResultError)。客户端必须换 request_id 重试,不能复用
   * 已经 "烧掉" 的那个。
   */
  test("重放同一 x-request-id(上次 error)→ 409 ERR_REQUEST_ID_EXHAUSTED", async (t) => {
    if (skipIfNoDb(t)) return;
    const { id: uid, token } = await createUser("rest-replay-err@example.com", 7_000n);
    await createAccount({ label: "replay-err", plan: "pro", token: "TOK-REPLAY-ERR" }, keyFn);
    const rid = "fixed-rid-replay-err-1";

    // 第一次:上游 500 → usage_records 写 status='error'
    currentMockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r1 = await postChat(
      { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "x" }] },
      token,
      rid,
    );
    assert.equal(r1.status, 502, JSON.stringify(r1.json));

    // 第二次:LLM 本身成功,但 debitChatSuccess 里 SELECT usage_records 命中 status!='success'
    // → RequestRetryWithDifferentResultError → 409
    currentMockFetch = (async () => sseResponse(200, [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])) as unknown as typeof fetch;
    const r2 = await postChat(
      { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "x" }] },
      token,
      rid,
    );
    assert.equal(r2.status, 409, JSON.stringify(r2.json));
    const err = r2.json.error as Record<string, unknown>;
    assert.equal(err.code, "ERR_REQUEST_ID_EXHAUSTED");

    // 余额不动;usage_records 仍然只有一行(status='error');不落 credit_ledger
    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "7000");
    const ledger = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid]);
    assert.equal(ledger.rows[0].cnt, "0");
    const rows = await query<{ status: string }>("SELECT status FROM usage_records WHERE user_id=$1", [uid]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, "error");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });
});
