/**
 * T-33 端到端:streamClaude + refreshAccountToken 联合场景(mock fetch + 真 PG)。
 *
 * 覆盖 T-33 验收 3 条:
 *   1. 集成:mock Anthropic API → 正常流式 → 收到事件
 *   2. 集成:token 过期 → streamClaude 抛 ProxyAuthError → refresh → 拿新 token → 重试成功
 *   3. 集成:refresh 失败 → 账号 disabled + 抛 RefreshError
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import {
  createAccount,
  getAccount,
  getTokenForUse,
} from "../account-pool/store.js";
import {
  streamClaude,
  ProxyAuthError,
} from "../account-pool/proxy.js";
import {
  refreshAccountToken,
  RefreshError,
  type RefreshHttpClient,
} from "../account-pool/refresh.js";

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

/** 把一串 SSE chunk 封成一个假 Response + ReadableStream。 */
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

const FIXED_NOW = new Date("2026-02-01T00:00:00Z");
const now = (): Date => FIXED_NOW;

describe("端到端 - 正常流", () => {
  test("pick → streamClaude → 透传事件", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "e2e", plan: "pro", token: "VALID-TOKEN", refresh: "R" },
      keyFn,
    );
    // 用 getTokenForUse 读出真明文 buffer
    const tok = await getTokenForUse(a.id, keyFn);
    assert.ok(tok);

    let seenAuth = "";
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenAuth = headers.authorization;
      return sseResponse(200, [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n',
        "data: [DONE]\n\n",
      ]);
    };
    const events = await collect(
      streamClaude(
        { account: { token: tok!.token, plan: tok!.plan }, body: { model: "m" } },
        { fetch: mockFetch as unknown as typeof fetch },
      ),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "message_start");
    assert.equal(events[1].event, "content_block_delta");
    assert.equal(seenAuth, "Bearer VALID-TOKEN");
    tok!.token.fill(0);
    tok!.refresh?.fill(0);
  });
});

describe("端到端 - token 过期 → refresh → 重试", () => {
  test("首次 401 → refresh(mock http)→ 拿新 token → 重试成功", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      {
        label: "e2e-401",
        plan: "pro",
        token: "EXPIRED-TOKEN",
        refresh: "OLD-REFRESH",
        expires_at: new Date(FIXED_NOW.getTime() - 60_000),
      },
      keyFn,
    );

    // 1) 第一次 pick 到的 token 发请求 → mock fetch 检测 EXPIRED-TOKEN → 返 401
    // 2) refresh → mock http.post 返 access_token=NEW-TOKEN
    // 3) 再次 streamClaude 用 NEW-TOKEN → 成功

    const fetchCalls: string[] = [];
    const mockFetch = async (_u: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      fetchCalls.push(auth);
      if (auth === "Bearer EXPIRED-TOKEN") {
        return new Response("{\"error\":\"token expired\"}", { status: 401 });
      }
      if (auth === "Bearer NEW-TOKEN") {
        return sseResponse(200, [
          'event: message_start\ndata: {"type":"message_start"}\n\n',
          "data: [DONE]\n\n",
        ]);
      }
      return new Response("unexpected", { status: 500 });
    };
    const refreshHttp: RefreshHttpClient = {
      async post() {
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "NEW-TOKEN",
            refresh_token: "NEW-REFRESH",
            expires_in: 3600,
          }),
        };
      },
    };

    // 模拟上层 orchestrator 的 refresh+retry 模式
    const first = await getTokenForUse(a.id, keyFn);
    assert.ok(first);
    let events: unknown[] = [];
    try {
      events = await collect(
        streamClaude(
          { account: { token: first!.token, plan: first!.plan }, body: {} },
          { fetch: mockFetch as unknown as typeof fetch },
        ),
      );
      assert.fail("expected ProxyAuthError");
    } catch (err) {
      assert.ok(err instanceof ProxyAuthError, `expected ProxyAuthError, got ${String(err)}`);
    } finally {
      first!.token.fill(0);
      first!.refresh?.fill(0);
    }

    // refresh
    const refreshed = await refreshAccountToken(a.id, {
      http: refreshHttp,
      keyFn,
      now,
    });
    try {
      events = await collect(
        streamClaude(
          { account: { token: refreshed.token, plan: refreshed.plan }, body: {} },
          { fetch: mockFetch as unknown as typeof fetch },
        ),
      );
    } finally {
      refreshed.token.fill(0);
      refreshed.refresh?.fill(0);
    }
    assert.equal(events.length, 1);
    assert.deepEqual(fetchCalls, ["Bearer EXPIRED-TOKEN", "Bearer NEW-TOKEN"]);

    // 账号状态:active + 新 expires_at
    const row = await getAccount(a.id);
    assert.equal(row!.status, "active");
    assert.equal(
      row!.oauth_expires_at?.getTime(),
      FIXED_NOW.getTime() + 3600_000,
    );
  });
});

describe("端到端 - refresh 失败 → 账号禁用", () => {
  test("refresh 返 401 → RefreshError + status=disabled + last_error 记录", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "e2e-fail", plan: "pro", token: "X", refresh: "BAD-R" },
      keyFn,
    );
    const refreshHttp: RefreshHttpClient = {
      async post() {
        return { status: 401, body: "{\"error\":\"invalid_grant\"}" };
      },
    };
    await assert.rejects(
      refreshAccountToken(a.id, { http: refreshHttp, keyFn, now }),
      (err: unknown) => {
        assert.ok(err instanceof RefreshError);
        assert.equal((err as RefreshError).code, "http_error");
        assert.equal((err as RefreshError).status, 401);
        return true;
      },
    );
    const row = await getAccount(a.id);
    assert.equal(row!.status, "disabled");
    assert.match(row!.last_error ?? "", /refresh_http_401/);
  });
});
