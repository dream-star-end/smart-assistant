/**
 * T-33 集成:refresh 在真 PG 上的全流程。
 *
 * 覆盖:
 *   1. 正常 refresh:新 access_token 加密写回 DB + oauth_expires_at 更新 +
 *      返回 Buffer 明文等于服务器返的 access_token
 *   2. refresh_token 轮换:服务器返了新 refresh_token → DB 里 oauth_refresh_enc
 *      解密等于新 refresh;不返 → 保留原 refresh
 *   3. expires_in / expires_at 两种字段都能识别,缺失则 fallback 1h
 *   4. 账号无 refresh_token → 禁用 + 抛 no_refresh_token
 *   5. 不存在的账号 → 抛 account_not_found(不禁用)
 *   6. HTTP 5xx → 禁用 + 抛 http_error(status=502)
 *   7. HTTP 返非 JSON → 禁用 + 抛 bad_response
 *   8. HTTP 返 JSON 但缺 access_token → 禁用 + 抛 bad_response
 *   9. network throw → 抛 network_transient 但 **不**禁用账号(网络/代理抖动可恢复)
 *  10. health.manualDisable 注入时走 health 路径而非 updateAccount
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import { decryptToBuffer } from "../crypto/aead.js";
import {
  createAccount,
  getAccount,
  deleteAccount,
} from "../account-pool/store.js";
import {
  AccountHealthTracker,
  InMemoryHealthRedis,
} from "../account-pool/health.js";
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
  "agent_subscriptions", "user_preferences", "request_finalize_journal",
  "orders", "topup_plans", "usage_records",
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

function mockHttp(resp: { status: number; body: string }): RefreshHttpClient {
  return {
    async post() {
      return { status: resp.status, body: resp.body };
    },
  };
}

function throwingHttp(msg: string): RefreshHttpClient {
  return {
    async post() {
      throw new Error(msg);
    },
  };
}

async function readEncryptedRefresh(
  id: bigint | string,
): Promise<string | null> {
  const res = await query<{
    oauth_refresh_enc: Buffer | null;
    oauth_refresh_nonce: Buffer | null;
  }>(
    `SELECT oauth_refresh_enc, oauth_refresh_nonce
     FROM claude_accounts WHERE id = $1`,
    [String(id)],
  );
  const r = res.rows[0];
  if (!r?.oauth_refresh_enc || !r.oauth_refresh_nonce) return null;
  return decryptToBuffer(r.oauth_refresh_enc, r.oauth_refresh_nonce, keyFn())
    .toString("utf8");
}

async function readEncryptedAccess(id: bigint | string): Promise<string> {
  const res = await query<{ oauth_token_enc: Buffer; oauth_nonce: Buffer }>(
    `SELECT oauth_token_enc, oauth_nonce FROM claude_accounts WHERE id = $1`,
    [String(id)],
  );
  const r = res.rows[0];
  return decryptToBuffer(r.oauth_token_enc, r.oauth_nonce, keyFn()).toString("utf8");
}

const FIXED_NOW = new Date("2026-01-15T12:00:00Z");
const now = (): Date => FIXED_NOW;

describe("refreshAccountToken — 成功路径", () => {
  test("更新 access_token + expires_at(来自 expires_in);refresh_token 不返则保留", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      {
        label: "r1",
        plan: "pro",
        token: "OLD-ACCESS",
        refresh: "OLD-REFRESH",
        expires_at: new Date(FIXED_NOW.getTime() - 60_000),
      },
      keyFn,
    );
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({
        access_token: "NEW-ACCESS-42",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });
    const result = await refreshAccountToken(a.id, { http, keyFn, now });
    assert.equal(result.token.toString("utf8"), "NEW-ACCESS-42");
    assert.equal(result.plan, "pro");
    assert.equal(result.expires_at.getTime(), FIXED_NOW.getTime() + 3600_000);
    // DB 里也是新 access token
    assert.equal(await readEncryptedAccess(a.id), "NEW-ACCESS-42");
    // refresh_token 没返 → 仍是旧的
    assert.equal(await readEncryptedRefresh(a.id), "OLD-REFRESH");
    const row = await getAccount(a.id);
    assert.equal(
      row!.oauth_expires_at?.getTime(),
      FIXED_NOW.getTime() + 3600_000,
    );
    result.token.fill(0);
  });

  test("refresh_token 轮换:服务器返新 refresh → DB 更新 + 返回 Buffer 明文匹配", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "r2", plan: "max", token: "OLD-A", refresh: "OLD-R" },
      keyFn,
    );
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({
        access_token: "A2",
        refresh_token: "R2",
        expires_in: 7200,
      }),
    });
    const out = await refreshAccountToken(a.id, { http, keyFn, now });
    assert.equal(out.token.toString("utf8"), "A2");
    assert.equal(out.refresh?.toString("utf8"), "R2");
    assert.equal(await readEncryptedRefresh(a.id), "R2");
    out.token.fill(0);
    out.refresh?.fill(0);
  });

  test("expires_at(epoch seconds)也可识别", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "r-es", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    const target = Math.floor(FIXED_NOW.getTime() / 1000) + 1800;
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({ access_token: "X", expires_at: target }),
    });
    const r = await refreshAccountToken(a.id, { http, keyFn, now });
    assert.equal(r.expires_at.getTime(), target * 1000);
    r.token.fill(0);
  });

  test("expires_at(epoch ms)也可识别", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "r-em", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    const targetMs = FIXED_NOW.getTime() + 5000;
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({ access_token: "X", expires_at: targetMs }),
    });
    const r = await refreshAccountToken(a.id, { http, keyFn, now });
    assert.equal(r.expires_at.getTime(), targetMs);
    r.token.fill(0);
  });

  test("无 expires_in/expires_at → fallback 1h", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "r-fb", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({ access_token: "X" }),
    });
    const r = await refreshAccountToken(a.id, { http, keyFn, now });
    assert.equal(r.expires_at.getTime(), FIXED_NOW.getTime() + 60 * 60 * 1000);
    r.token.fill(0);
  });

  test("成功后 last_error 被清空(上次失败可能留下 msg)", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "r-le", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    await query(
      `UPDATE claude_accounts SET last_error='previous failure' WHERE id=$1`,
      [String(a.id)],
    );
    const http = mockHttp({
      status: 200,
      body: JSON.stringify({ access_token: "X", expires_in: 10 }),
    });
    const r = await refreshAccountToken(a.id, { http, keyFn, now });
    const row = await getAccount(a.id);
    assert.equal(row!.last_error, null);
    r.token.fill(0);
  });

  test("构造的 form body 含 grant_type=refresh_token + refresh_token", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "r-form", plan: "pro", token: "T", refresh: "R-VAL" },
      keyFn,
    );
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};
    const http: RefreshHttpClient = {
      async post(_url, headers, body) {
        capturedBody = body;
        capturedHeaders = headers;
        return { status: 200, body: JSON.stringify({ access_token: "X", expires_in: 60 }) };
      },
    };
    const r = await refreshAccountToken(a.id, { http, keyFn, now, clientId: "my-cli" });
    const form = new URLSearchParams(capturedBody);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "R-VAL");
    assert.equal(form.get("client_id"), "my-cli");
    assert.equal(capturedHeaders["Content-Type"], "application/x-www-form-urlencoded");
    r.token.fill(0);
  });
});

describe("refreshAccountToken — 失败路径(禁用 + 抛)", () => {
  test("账号不存在 → account_not_found(不试图禁用,因为就没有)", async (t) => {
    if (skipIfNoDb(t)) return;
    await assert.rejects(
      refreshAccountToken(9999n, { http: mockHttp({ status: 200, body: "{}" }), keyFn, now }),
      (err: unknown) =>
        err instanceof RefreshError && (err as RefreshError).code === "account_not_found",
    );
  });

  test("无 refresh_token → 禁用 + 抛 no_refresh_token", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "nr", plan: "pro", token: "T" },
      keyFn,
    );
    await assert.rejects(
      refreshAccountToken(a.id, { http: mockHttp({ status: 200, body: "{}" }), keyFn, now }),
      (err: unknown) =>
        err instanceof RefreshError && (err as RefreshError).code === "no_refresh_token",
    );
    const row = await getAccount(a.id);
    assert.equal(row!.status, "disabled");
    assert.match(row!.last_error ?? "", /refresh_no_token/);
  });

  test("HTTP 502 → 禁用 + 抛 http_error(status=502)", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "h502", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    await assert.rejects(
      refreshAccountToken(a.id, {
        http: mockHttp({ status: 502, body: "Bad Gateway" }),
        keyFn,
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof RefreshError);
        assert.equal((err as RefreshError).code, "http_error");
        assert.equal((err as RefreshError).status, 502);
        return true;
      },
    );
    const row = await getAccount(a.id);
    assert.equal(row!.status, "disabled");
    assert.match(row!.last_error ?? "", /refresh_http_502/);
  });

  test("HTTP 2xx 但非 JSON → bad_response + 禁用", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "badjson", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    await assert.rejects(
      refreshAccountToken(a.id, {
        http: mockHttp({ status: 200, body: "<html>oops</html>" }),
        keyFn,
        now,
      }),
      (err: unknown) =>
        err instanceof RefreshError && (err as RefreshError).code === "bad_response",
    );
    const row = await getAccount(a.id);
    assert.equal(row!.status, "disabled");
  });

  test("HTTP 2xx JSON 但缺 access_token → bad_response + 禁用", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "nokey", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    await assert.rejects(
      refreshAccountToken(a.id, {
        http: mockHttp({ status: 200, body: JSON.stringify({ token_type: "Bearer" }) }),
        keyFn,
        now,
      }),
      (err: unknown) =>
        err instanceof RefreshError && (err as RefreshError).code === "bad_response",
    );
    const row = await getAccount(a.id);
    assert.equal(row!.status, "disabled");
  });

  test("network 抛 → network_transient,**不**禁用账号(代理/网络抖动可恢复)", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "net", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    await assert.rejects(
      refreshAccountToken(a.id, {
        http: throwingHttp("ECONNREFUSED"),
        keyFn,
        now,
      }),
      (err: unknown) =>
        err instanceof RefreshError &&
        (err as RefreshError).code === "network_transient" &&
        (err as RefreshError).status === undefined,
    );
    // 政策更新(2026-04-19,Codex 8ec407b 复审):网络层异常无法区分是 anthropic 挂
    // 还是出口代理抖,不再 disable 账号 —— 否则代理供应商抖一次就把所有挂代理的
    // 账号烧掉。orchestrator 会照常 yield error,下次 pick 再重试。
    // 2026-04-25 审计 #H9:错误码从 http_error 拆出 network_transient,
    // 调度器按 kind:"transient_network" 释放,不扣健康分。
    const row = await getAccount(a.id);
    assert.equal(row!.status, "active");
  });

  test("health.manualDisable 注入时走 health 路径;Redis 计数器也被清", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "h-dep", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    const redis = new InMemoryHealthRedis();
    const tracker = new AccountHealthTracker({ redis });
    // 预埋 fail/health 缓存,验证 manualDisable 会清
    await redis.set(`acct:fail:${a.id}`, "2");
    await redis.set(`acct:health:${a.id}`, "80");
    await assert.rejects(
      refreshAccountToken(a.id, {
        http: mockHttp({ status: 500, body: "boom" }),
        keyFn,
        now,
        health: tracker,
      }),
      RefreshError,
    );
    const row = await getAccount(a.id);
    assert.equal(row!.status, "disabled");
    // health 模块应该清理过 redis
    assert.equal(await redis.get(`acct:fail:${a.id}`), null);
    assert.equal(await redis.get(`acct:health:${a.id}`), null);
  });
});

describe("refreshAccountToken — 并发删除", () => {
  test("refresh 成功但账号在写回前被删 → account_not_found", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "gone", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );
    // http mock 在 post 里删账号,模拟 "在 HTTP 返回后、DB updateAccount 前" 的窗口
    const raceHttp: RefreshHttpClient = {
      async post() {
        await deleteAccount(a.id);
        return {
          status: 200,
          body: JSON.stringify({ access_token: "X", expires_in: 60 }),
        };
      },
    };
    await assert.rejects(
      refreshAccountToken(a.id, { http: raceHttp, keyFn, now }),
      (err: unknown) =>
        err instanceof RefreshError && (err as RefreshError).code === "account_not_found",
    );
  });
});

describe("refreshAccountToken — singleflight (#H8)", () => {
  test("同账号 5 个并发 refresh → http.post 只被打 1 次,5 个 waiter 都拿到结果", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "sf", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );

    // 记录 http.post 被调用次数,并让 post 慢一点让并发真能撞上
    let postCount = 0;
    const slowHttp: RefreshHttpClient = {
      async post() {
        postCount++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "NEW_ACCESS",
            refresh_token: "NEW_REFRESH",
            expires_in: 3600,
          }),
        };
      },
    };

    const ps = [];
    for (let i = 0; i < 5; i++) {
      ps.push(refreshAccountToken(a.id, { http: slowHttp, keyFn, now }));
    }
    const results = await Promise.all(ps);
    assert.equal(postCount, 1, "http.post 应只调用 1 次");
    assert.equal(results.length, 5);
    // 每个 waiter 拿到独立 Buffer 实例,互不污染
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].token.toString("utf8"), "NEW_ACCESS");
      assert.equal(results[i].refresh?.toString("utf8"), "NEW_REFRESH");
      // 不同的 Buffer 对象:一个 fill(0) 不应影响另一个
      if (i > 0) {
        assert.notEqual(results[i].token, results[0].token, "Buffer 对象必须独立");
      }
    }
    // 一个 waiter fill(0) 之后,其他 waiter 的 token 不受影响
    results[0].token.fill(0);
    assert.equal(results[1].token.toString("utf8"), "NEW_ACCESS");
  });

  test("in-flight 失败 → 所有 waiter 都拒绝;下一次 call 从头再跑", async (t) => {
    if (skipIfNoDb(t)) return;
    const a = await createAccount(
      { label: "sf-fail", plan: "pro", token: "T", refresh: "R" },
      keyFn,
    );

    let postCount = 0;
    const http: RefreshHttpClient = {
      async post() {
        postCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("network down");
      },
    };

    const ps = [
      refreshAccountToken(a.id, { http, keyFn, now }),
      refreshAccountToken(a.id, { http, keyFn, now }),
      refreshAccountToken(a.id, { http, keyFn, now }),
    ];
    const settled = await Promise.allSettled(ps);
    for (const s of settled) {
      assert.equal(s.status, "rejected");
      const err = (s as PromiseRejectedResult).reason;
      assert.ok(err instanceof RefreshError);
      assert.equal((err as RefreshError).code, "network_transient");
    }
    assert.equal(postCount, 1, "3 个并发 → 1 次 HTTP");

    // inflight Map 必须被清掉:下一次调用会重新打 HTTP
    await assert.rejects(refreshAccountToken(a.id, { http, keyFn, now }));
    assert.equal(postCount, 2, "第二批调用应重新打 HTTP");
  });
});
