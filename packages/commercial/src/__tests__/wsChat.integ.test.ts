/**
 * T-40b — /ws/chat WebSocket handler 集成测试。
 *
 * 用 real ws client(`ws` 包)+ real PG + InMemory Redis + mock fetch 验证:
 *   1. 正常流:start → delta × N → usage → debit → done(WS 1000 close)+ DB 扣费 + usage_records
 *   2. 未带 token → 401(握手阶段拒绝)
 *   3. 第 4 条同 user 的连接 → 最老被踢(收到 error + close 1008),新的继续能用
 *   4. 上游 500 → error frame + close 1011 + usage_records.status='error' + 余额未动
 *   5. 未知 model → error frame + close 1008,未走 preCheck
 *
 * 注意:为了避免打到真 Claude API,runClaudeChat 的 proxyDeps.fetch 注入为 mock。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { PricingCache } from "../billing/pricing.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { createAccount } from "../account-pool/store.js";
import { AccountHealthTracker, InMemoryHealthRedis } from "../account-pool/health.js";
import { AccountScheduler } from "../account-pool/scheduler.js";
import { createChatWsHandler } from "../ws/chat.js";

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

let pgAvailable = false;
let server: Server | null = null;
let baseUrl = "";
let pricing: PricingCache;
let preCheckRedis: InMemoryPreCheckRedis;
let healthRedis: InMemoryHealthRedis;
// 每个 test 可替换的 fetch mock
let currentMockFetch: typeof fetch = (async () => {
  throw new Error("no fetch mock installed");
}) as unknown as typeof fetch;
let shutdownWs: (() => Promise<void>) | null = null;

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
  healthRedis = new InMemoryHealthRedis();
  const tracker = new AccountHealthTracker({ redis: healthRedis });
  const scheduler = new AccountScheduler({ health: tracker, keyFn });

  const handler = createChatWsHandler({
    jwtSecret: JWT_SECRET,
    pricing,
    preCheckRedis,
    chatDeps: {
      scheduler,
      proxyDeps: { fetch: ((...a: unknown[]) => currentMockFetch(...(a as [string, RequestInit?]))) as unknown as typeof fetch },
      refreshDeps: { keyFn, now: () => new Date() },
    },
    // 超时调短防 test hang
    startTimeoutMs: 3_000,
    maxPerUser: 3,
  });
  shutdownWs = () => handler.shutdown();

  server = createServer((req, res) => {
    res.statusCode = 404;
    res.end("nope");
  });
  server.on("upgrade", (req, socket, head) => {
    handler.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (shutdownWs) { try { await shutdownWs(); } catch { /* */ } }
  if (server) {
    // 强制踢掉所有还存活的 socket(包括已 upgrade 的 WS 与 idle keepalive),
    // 否则 server.close() 会等它们自然断开,在有遗留 WS 连接的测试里必超时。
    try { server.closeAllConnections(); } catch { /* node<18.2 没这 API,忽略 */ }
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
  // 清 in-memory health redis
  healthRedis = new InMemoryHealthRedis();
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

interface FrameLog {
  frames: unknown[];
  closed: { code: number; reason: string } | null;
}

async function runWs(url: string, startFrame: unknown | null, opts: { waitMs?: number } = {}): Promise<FrameLog> {
  const log: FrameLog = { frames: [], closed: null };
  return await new Promise<FrameLog>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error(`ws test timeout after ${opts.waitMs ?? 5000}ms. frames=${JSON.stringify(log.frames)}`));
    }, opts.waitMs ?? 5000);
    const ws = new WebSocket(url);
    ws.on("open", () => {
      if (startFrame !== null) ws.send(JSON.stringify(startFrame));
    });
    ws.on("message", (raw) => {
      try { log.frames.push(JSON.parse(raw.toString("utf8"))); }
      catch { log.frames.push({ __raw: raw.toString("utf8") }); }
    });
    ws.on("close", (code, reason) => {
      log.closed = { code, reason: reason.toString("utf8") };
      clearTimeout(timer);
      resolve(log);
    });
    ws.on("error", () => {
      // ws 'error' 紧随 close 触发 —— 以 close 为准
    });
  });
}

/* ----- 1. 正常流 ------------------------------------------------------- */
describe("POST /ws/chat - 正常流", () => {
  test("start → delta + usage + debit + done + 扣费落库", async (t) => {
    if (skipIfNoDb(t)) return;
    const { id: uid, token } = await createUser("ok@example.com", 10_000n);
    await createAccount({ label: "ok", plan: "pro", token: "TOK-OK" }, keyFn);

    currentMockFetch = (async () => sseResponse(200, [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])) as unknown as typeof fetch;

    const r = await runWs(`${baseUrl}/ws/chat?token=${token}`, {
      type: "start",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 500,
    });

    const types = r.frames.map((f: any) => f.type);
    assert.deepEqual(types, ["delta", "delta", "usage", "debit", "done"]);
    assert.equal((r.frames[0] as any).text, "hello ");
    assert.equal((r.frames[1] as any).text, "world");
    const usage = r.frames[2] as { type: "usage"; input_tokens: number; output_tokens: number; stop_reason: string };
    assert.equal(usage.input_tokens, 12);
    assert.equal(usage.output_tokens, 7);
    assert.equal(usage.stop_reason, "end_turn");
    const debit = r.frames[3] as { type: "debit"; cost_credits: string; balance_after: string };
    // cost 很小(12 in 7 out,sonnet 价格):按 debit 一起校验余额下降
    assert.equal(r.closed!.code, 1000);

    const uRow = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(uRow.rows[0].credits, debit.balance_after);
    const ledger = await query<{ cnt: string }>("SELECT COUNT(*)::text AS cnt FROM credit_ledger WHERE user_id=$1", [uid]);
    assert.equal(ledger.rows[0].cnt, "1");
    const usageRows = await query<{ status: string; cost_credits: string; input_tokens: string; output_tokens: string }>(
      "SELECT status, cost_credits::text AS cost_credits, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens FROM usage_records WHERE user_id=$1", [uid]);
    assert.equal(usageRows.rows.length, 1);
    assert.equal(usageRows.rows[0].status, "success");
    assert.equal(usageRows.rows[0].input_tokens, "12");
    assert.equal(usageRows.rows[0].output_tokens, "7");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0, "precheck lock must be released");
  });
});

/* ----- 2. 鉴权 ------------------------------------------------------- */
/**
 * 鉴权失败后 WS 接受 upgrade(101),紧接着发 `{type:'error'}` 帧再 close(1008)。
 * 这样前端 WebSocket API 能拿到错误 code/message(浏览器握手失败时看不到 body),
 * 且跨 Bun/Node 行为一致(Bun 对 upgrade socket 的裸 write 有丢包问题)。
 */
describe("POST /ws/chat - 鉴权", () => {
  test("missing token → error frame code=UNAUTHORIZED + close 1008", async (t) => {
    if (skipIfNoDb(t)) return;
    const r = await runWs(`${baseUrl}/ws/chat`, null);
    const err = r.frames.find((f: any) => f.type === "error") as { code: string; message: string } | undefined;
    assert.ok(err, `expected error frame, got ${JSON.stringify(r.frames)}`);
    assert.equal(err.code, "UNAUTHORIZED");
    assert.equal(r.closed!.code, 1008);
  });

  test("bad token → error + close 1008", async (t) => {
    if (skipIfNoDb(t)) return;
    const r = await runWs(`${baseUrl}/ws/chat?token=totally-bogus`, null);
    const err = r.frames.find((f: any) => f.type === "error") as { code: string } | undefined;
    assert.ok(err);
    assert.equal(err.code, "UNAUTHORIZED");
    assert.equal(r.closed!.code, 1008);
  });
});

/* ----- 3. 上游错误 ---------------------------------------------------- */
describe("POST /ws/chat - 上游错误", () => {
  test("上游 500 → error frame + close 1011 + usage_records.status='error' + 余额未动", async (t) => {
    if (skipIfNoDb(t)) return;
    const { id: uid, token } = await createUser("up500@example.com", 10_000n);
    await createAccount({ label: "a", plan: "pro", token: "T" }, keyFn);
    currentMockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const r = await runWs(`${baseUrl}/ws/chat?token=${token}`, {
      type: "start",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 100,
    });

    const errFrame = r.frames.find((f: any) => f.type === "error") as { type: "error"; code: string } | undefined;
    assert.ok(errFrame, "expected error frame");
    assert.equal(errFrame.code, "ERR_UPSTREAM");
    assert.equal(r.closed!.code, 1011);

    const u = await query<{ credits: string }>("SELECT credits::text AS credits FROM users WHERE id=$1", [uid]);
    assert.equal(u.rows[0].credits, "10000");
    const rows = await query<{ status: string; cost_credits: string }>("SELECT status, cost_credits::text AS cost_credits FROM usage_records WHERE user_id=$1", [uid]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, "error");
    assert.equal(rows.rows[0].cost_credits, "0");
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });
});

/* ----- 4. 未知 model --------------------------------------------------- */
describe("POST /ws/chat - model 校验", () => {
  test("未知 model → error frame + close 1008", async (t) => {
    if (skipIfNoDb(t)) return;
    const { token } = await createUser("unk@example.com", 10_000n);

    const r = await runWs(`${baseUrl}/ws/chat?token=${token}`, {
      type: "start",
      model: "no-such-model-xxx",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
    });
    const errFrame = r.frames.find((f: any) => f.type === "error") as { code: string } | undefined;
    assert.ok(errFrame);
    assert.equal(errFrame.code, "UNKNOWN_MODEL");
    assert.equal(r.closed!.code, 1008);
    assert.equal(Object.keys(preCheckRedis.snapshot()).length, 0);
  });
});

/* ----- 5. Kick oldest -------------------------------------------------- */
describe("POST /ws/chat - 同用户最多 3 并发", () => {
  test("第 4 条进来,最老的那条被踢", async (t) => {
    if (skipIfNoDb(t)) return;
    const { token } = await createUser("multi@example.com", 10_000n);

    // 建 3 条长 idle 连接(不发 start;依赖 startTimeoutMs 但远超 3s 要足够)
    const conns: WebSocket[] = [];
    const closeEvents: { i: number; code: number; reason: string }[] = [];

    function open(): Promise<WebSocket> {
      return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${baseUrl}/ws/chat?token=${token}`);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    }

    for (let i = 0; i < 3; i++) {
      const ws = await open();
      const idx = i;
      ws.on("close", (code, reason) => {
        closeEvents.push({ i: idx, code, reason: reason.toString("utf8") });
      });
      conns.push(ws);
      // 稍微错开 opened_at,保证 conn[0] 最老
      await new Promise((r) => setTimeout(r, 15));
    }

    // 开第 4 条 → registry 应踢 conns[0]
    const ws4 = await open();
    conns.push(ws4);

    // 等 conns[0] 的 close 事件
    await new Promise((r) => setTimeout(r, 200));

    const kick = closeEvents.find((e) => e.i === 0);
    assert.ok(kick, `expected conns[0] close; got ${JSON.stringify(closeEvents)}`);
    assert.equal(kick.code, 1008);

    // conns[1/2/3] 仍 OPEN
    for (const i of [1, 2]) {
      assert.equal(conns[i].readyState, conns[i].OPEN, `conn[${i}] should be open`);
    }
    assert.equal(ws4.readyState, ws4.OPEN);

    // 清理
    for (const c of conns) { try { c.close(); } catch { /* */ } }
    await new Promise((r) => setTimeout(r, 100));
  });
});
