/**
 * T-40 — runClaudeChat 端到端:真 PG(账号池)+ 真 InMemoryHealthRedis + mock fetch。
 *
 * 覆盖 T-40 验收相关部分(不含 WS 层,WS 的连接/kick 另测):
 *   1. 正常流 → meta + delta × N + usage + done + health.onSuccess
 *   2. expires_at 将到期(skew 内)→ 先 refresh 再 stream,新 token 命中 fetch
 *   3. 上游 401 → 自动 refresh + 重试一次成功 → health.onSuccess(不算 failure)
 *   4. 上游 401 × 2 → ERR_UPSTREAM_AUTH → health.onFailure
 *   5. 上游 500 → ERR_UPSTREAM + upstreamStatus=500 → health.onFailure
 *   6. 账号池空 → ERR_ACCOUNT_POOL_UNAVAILABLE(无 release)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { createAccount, getAccount } from "../account-pool/store.js";
import {
  AccountHealthTracker,
  InMemoryHealthRedis,
} from "../account-pool/health.js";
import { AccountScheduler } from "../account-pool/scheduler.js";
import type { RefreshHttpClient } from "../account-pool/refresh.js";
import {
  runClaudeChat,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  ERR_UPSTREAM,
  ERR_UPSTREAM_AUTH,
  type ChatEvent,
} from "../chat/orchestrator.js";

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

let pgAvailable = false;
const KEY = randomBytes(KMS_KEY_BYTES);
const keyFn = (): Buffer => Buffer.from(KEY);

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }));
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE usage_records, claude_accounts RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

function sseResponse(status: number, chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl): void {
      const enc = new TextEncoder();
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, { status });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

function mkDeps(mockFetch: typeof fetch, refreshHttp?: RefreshHttpClient): {
  scheduler: AccountScheduler;
  tracker: AccountHealthTracker;
  proxyDeps: { fetch: typeof fetch };
  refreshDeps: { http?: RefreshHttpClient; keyFn: () => Buffer; now: () => Date };
} {
  const redis = new InMemoryHealthRedis();
  const tracker = new AccountHealthTracker({ redis });
  const scheduler = new AccountScheduler({ health: tracker, keyFn });
  return {
    scheduler,
    tracker,
    proxyDeps: { fetch: mockFetch },
    refreshDeps: {
      http: refreshHttp,
      keyFn,
      now: () => new Date(),
    },
  };
}

const baseInput = {
  userId: 1n,
  mode: "chat" as const,
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 500,
};

/* ----- normal flow ------------------------------------------------------- */

describe("orchestrator e2e - 正常流", () => {
  test("pick → stream → meta+delta+usage+done + DB success_count++", async (t) => {
    if (skipIfNoDb(t)) return;
    const acct = await createAccount({ label: "e2e-ok", plan: "pro", token: "TOK-OK" }, keyFn);

    const fetchCalls: string[] = [];
    const mockFetch = (async (_u: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      fetchCalls.push(auth);
      return sseResponse(200, [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    }) as unknown as typeof fetch;

    const deps = mkDeps(mockFetch);
    const events: ChatEvent[] = await collect(runClaudeChat(baseInput, deps));

    assert.deepEqual(
      events.map((e) => e.type),
      ["meta", "delta", "delta", "usage", "done"],
    );
    assert.equal((events[0] as { account_id: bigint }).account_id, acct.id);
    assert.equal((events[1] as { text: string }).text, "hello ");
    assert.equal((events[2] as { text: string }).text, "world");
    const u = events[3] as { usage: { input_tokens: bigint; output_tokens: bigint }; stop_reason: string };
    assert.equal(u.usage.input_tokens, 12n);
    assert.equal(u.usage.output_tokens, 7n);
    assert.equal(u.stop_reason, "end_turn");
    assert.equal(fetchCalls[0], "Bearer TOK-OK");

    // DB 侧:success_count 应 +1
    const row = await getAccount(acct.id);
    assert.equal(row!.success_count, 1n);
  });
});

/* ----- expires_at 将到期 → 预先 refresh ---------------------------------- */

describe("orchestrator e2e - 预先 refresh", () => {
  test("token 即将过期 → refresh + stream 用新 token", async (t) => {
    if (skipIfNoDb(t)) return;
    const acct = await createAccount(
      {
        label: "e2e-preref",
        plan: "pro",
        token: "OLD-TOK",
        refresh: "OLD-REF",
        expires_at: new Date(Date.now() + 60_000), // 60s 后,skew=5min 内
      },
      keyFn,
    );

    const fetchCalls: string[] = [];
    const mockFetch = (async (_u: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      fetchCalls.push(auth);
      return sseResponse(200, [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    }) as unknown as typeof fetch;

    const refreshHttp: RefreshHttpClient = {
      async post() {
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "NEW-TOK",
            refresh_token: "NEW-REF",
            expires_in: 3600,
          }),
        };
      },
    };

    const deps = mkDeps(mockFetch, refreshHttp);
    const events = await collect(runClaudeChat(baseInput, deps));

    // 只有一次 fetch 调用,用的是 NEW-TOK
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0], "Bearer NEW-TOK");
    assert.equal(events.at(-1)?.type, "done");

    // DB 里 oauth_token_enc 应已被替换(明文解不出就通过 success_count 验证链路走通)
    const row = await getAccount(acct.id);
    assert.equal(row!.success_count, 1n);
  });
});

/* ----- 401 → refresh → retry --------------------------------------------- */

describe("orchestrator e2e - 401 → refresh + retry", () => {
  test("首次 401 → refresh → 重试成功", async (t) => {
    if (skipIfNoDb(t)) return;
    const acct = await createAccount(
      { label: "e2e-401", plan: "pro", token: "EXP-TOK", refresh: "OLD-REF" },
      keyFn,
    );

    const fetchCalls: string[] = [];
    const mockFetch = (async (_u: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      fetchCalls.push(auth);
      if (auth === "Bearer EXP-TOK") {
        return new Response('{"error":"token expired"}', { status: 401 });
      }
      if (auth === "Bearer FRESH-TOK") {
        return sseResponse(200, [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"retry-ok"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]);
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const refreshHttp: RefreshHttpClient = {
      async post() {
        return {
          status: 200,
          body: JSON.stringify({ access_token: "FRESH-TOK", expires_in: 3600 }),
        };
      },
    };

    const deps = mkDeps(mockFetch, refreshHttp);
    const events = await collect(runClaudeChat(baseInput, deps));

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0], "Bearer EXP-TOK");
    assert.equal(fetchCalls[1], "Bearer FRESH-TOK");
    const deltas = events.filter((e) => e.type === "delta") as Array<{ text: string }>;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, "retry-ok");
    assert.equal(events.at(-1)?.type, "done");

    // 401 → refresh 成功 → 整体 success。success_count = 1
    const row = await getAccount(acct.id);
    assert.equal(row!.success_count, 1n);
    assert.equal(row!.fail_count, 0n);
  });
});

/* ----- 401 × 2 → ERR_UPSTREAM_AUTH --------------------------------------- */

describe("orchestrator e2e - 401 重试后仍 401", () => {
  test("refresh 后再 401 → ERR_UPSTREAM_AUTH + fail_count++", async (t) => {
    if (skipIfNoDb(t)) return;
    const acct = await createAccount(
      { label: "e2e-401x2", plan: "pro", token: "BAD-TOK", refresh: "OLD" },
      keyFn,
    );

    const mockFetch = (async () =>
      new Response("unauthorized", { status: 401 })
    ) as unknown as typeof fetch;

    const refreshHttp: RefreshHttpClient = {
      async post() {
        return { status: 200, body: JSON.stringify({ access_token: "NEW", expires_in: 3600 }) };
      },
    };

    const deps = mkDeps(mockFetch, refreshHttp);
    const events = await collect(runClaudeChat(baseInput, deps));
    const err = events.find((e) => e.type === "error") as { code: string; upstreamStatus?: number };
    assert.equal(err.code, ERR_UPSTREAM_AUTH);
    assert.equal(err.upstreamStatus, 401);

    const row = await getAccount(acct.id);
    assert.equal(row!.fail_count, 1n);
    assert.ok((row!.last_error ?? "").length > 0);
  });
});

/* ----- 500 → ERR_UPSTREAM ------------------------------------------------ */

describe("orchestrator e2e - 上游非 401 错误", () => {
  test("500 → ERR_UPSTREAM + upstreamStatus=500 + fail_count++", async (t) => {
    if (skipIfNoDb(t)) return;
    const acct = await createAccount({ label: "e2e-500", plan: "pro", token: "T" }, keyFn);
    const mockFetch = (async () =>
      new Response('{"err":"internal"}', { status: 500 })
    ) as unknown as typeof fetch;
    const deps = mkDeps(mockFetch);
    const events = await collect(runClaudeChat(baseInput, deps));
    const err = events.find((e) => e.type === "error") as { code: string; upstreamStatus?: number };
    assert.equal(err.code, ERR_UPSTREAM);
    assert.equal(err.upstreamStatus, 500);
    const row = await getAccount(acct.id);
    assert.equal(row!.fail_count, 1n);
  });
});

/* ----- 无账号 ------------------------------------------------------------ */

describe("orchestrator e2e - 账号池空", () => {
  test("无 active 账号 → ERR_ACCOUNT_POOL_UNAVAILABLE(无 fetch 调用)", async (t) => {
    if (skipIfNoDb(t)) return;
    const fetchCalls: unknown[] = [];
    const mockFetch = (async () => {
      fetchCalls.push(1);
      return new Response("should not happen", { status: 200 });
    }) as unknown as typeof fetch;
    const deps = mkDeps(mockFetch);
    const events = await collect(runClaudeChat(baseInput, deps));
    assert.equal(events.length, 1);
    const err = events[0] as { type: string; code: string };
    assert.equal(err.type, "error");
    assert.equal(err.code, ERR_ACCOUNT_POOL_UNAVAILABLE);
    assert.equal(fetchCalls.length, 0);
  });
});
