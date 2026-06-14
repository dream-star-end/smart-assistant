/**
 * V3 CC 外接 plan Phase 4 — apiKeyAdmin **integ** test(端到端闭环)。
 *
 * 跑法: npx tsx --test src/__tests__/apiKeyAdmin.integ.test.ts
 *
 * 这是 Phase 1+2+3+4 的"压舱石"测试。与 apiKeyAdmin.unit.test.ts 区别:
 *
 *   单元 test: handler-only,fakePool 三条 SQL allowlist,目标是字段 shape /
 *              错误码映射 / invariant #1 落锁。
 *   integ test (本文件): **真路由** `createCommercialHandler` 跑请求,**真 repo**
 *              `makePgApiKeyRepo` 落 SQL,fakePool 维护一张 in-memory `user_api_keys`
 *              表,Phase 4 admin API 写入 → Phase 2 strategy.findByPrefix 读取 →
 *              Phase 3 proxy 拿真 plaintext 跑 happy → Phase 4 revoke → 再发
 *              same token 必 401。这条链断哪儿测就红哪儿,**不**靠 spy 替身。
 *
 * 覆盖的闭环不变量(plan §4 + §7 Phase 4):
 *
 *   A. 闭环 happy           — POST /api/me/api-keys → 拿 plaintext →
 *                              POST /api/anthropic/v1/messages Bearer plaintext → 200
 *   B. 闭环 revoke ⇒ 401   — POST → use → DELETE :id → use 同 plaintext → 401 API_KEY_INVALID
 *   C. invariant #1 SQL 锁  — list 响应 banned-field scan(plaintext/key_hash/secret 严禁)
 *   D. 跨用户隔离           — UID_A 创建,UID_B DELETE :id_A → 404 + 不撤销 + UID_A 还能用
 *   E. CRUD shape           — created_at / last_used_at ISO 字符串,id BigInt → string
 *   F. label boundary       — "" / "   " / 81 chars → 400 INVALID_LABEL
 *   G. UNAUTHORIZED         — admin endpoint 无 JWT → 401,**不**触碰 DB
 *   H. existence privacy    — DELETE 不存在的 id(且 ≤ BIGINT max)→ 404,与 "not yours" 同码
 *
 * 不在本 test 覆盖(plan §8 OUT-OF-SCOPE):PATCH label / 轮转 / IP allowlist / 审计事件。
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

import { createCommercialHandler } from "../http/router.js";
import type { CommercialHttpDeps } from "../http/handlers.js";
import { makeAnthropicProxyHandler } from "../http/anthropicProxy.js";
import { makeApiKeyIdentityStrategy } from "../auth/apiKeyIdentity.js";
import { makePgApiKeyRepo, hashApiKeySecret } from "../auth/apiKeyRepo.js";
import { signAccess } from "../auth/jwt.js";
import { setPoolOverride, resetPool } from "../db/index.js";
import { _clearMaintenanceCache } from "../middleware/maintenanceMode.js";
import { createLogger } from "../logging/logger.js";
import type { AccountScheduler, PickResult, ReleaseInput } from "../account-pool/scheduler.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { RateLimitRedis } from "../middleware/rateLimit.js";
import type { PricingCache, ModelPricing } from "../billing/pricing.js";

// ─── 固定常量 ───────────────────────────────────────────────────────────────

const JWT_SECRET = "test-jwt-secret-not-actually-used-cc-external-32b!";
const USER_A_ID = "7";
const USER_B_ID = "8";
const FIXED_MODEL = "claude-sonnet-4-6";
const FIXED_PINNED_USER_ID = createHash("sha256")
  .update("test-pinned-account-phase4-integ")
  .digest("hex");

const FIXED_PRICING: ModelPricing = {
  model_id: FIXED_MODEL,
  display_name: "Claude Sonnet 4.6",
  input_per_mtok: 300n,
  output_per_mtok: 1500n,
  cache_read_per_mtok: 30n,
  cache_write_per_mtok: 375n,
  multiplier: "2.000",
  enabled: true,
  sort_order: 100,
  visibility: "public",
  extra_system_prompt: null,
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

// ─── SSE upstream mock ──────────────────────────────────────────────────────

function makeFullSseChunks(): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
}

function sseResponse(status: number, chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl): void {
      const enc = new TextEncoder();
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

// ─── In-memory user_api_keys-backed fakePool ───────────────────────────────
//
// 这是本 integ test 的核心:**真**的 PgApiKeyRepo 会发 INSERT/SELECT/UPDATE,
// 这个 fakePool 把它们落到 JS Map(模拟一张 user_api_keys 表),让 Phase 4
// admin 写入的 row 能被 Phase 2 strategy.findByPrefix 真实读到 — 这正是
// "create→use→revoke→use" 闭环必须的。
//
// 表 schema 映射(列 → JS 字段):
//   id BIGINT PK            → row.id (string)
//   user_id BIGINT NOT NULL → row.user_id (string)
//   label TEXT NOT NULL     → row.label
//   key_prefix CHAR(8)      → row.key_prefix
//   key_hash BYTEA          → row.key_hash (Buffer)
//   created_at TIMESTAMPTZ  → row.created_at (Date)
//   last_used_at TZ NULL    → row.last_used_at (Date|null)
//   revoked_at TZ NULL      → row.revoked_at (Date|null)
//
// **未知 SQL 一律抛**(unit test 同设计):防"新加的 query 悄悄走 fallthrough 伪通过"。

interface UserApiKeyRow {
  id: string;
  user_id: string;
  label: string;
  key_prefix: string;
  key_hash: Buffer;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface FakePoolHandle {
  pool: Pool;
  table: Map<string, UserApiKeyRow>;
  queries: { sql: string; params: unknown[] }[];
  /** 强制塞一行(测试边缘 case,如手工种 revoked row)。 */
  upsert(row: UserApiKeyRow): void;
}

function buildFakePool(): FakePoolHandle {
  const table = new Map<string, UserApiKeyRow>();
  let nextId = 100n;
  const queries: { sql: string; params: unknown[] }[] = [];

  const handle = (sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } => {
    queries.push({ sql, params });
    const trimmed = sql.trim();
    const head = trimmed.slice(0, 96).toUpperCase();

    // ─── proxy / billing path SQL ────────────────────────────────────────
    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (head.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
    if (head.startsWith("SELECT VALUE, DESCRIPTION, UPDATED_AT")) {
      // maintenance_mode = false(无 row → DEFAULTS)
      return { rows: [], rowCount: 0 };
    }
    if (head.startsWith("INSERT INTO REQUEST_FINALIZE_JOURNAL")) return { rows: [], rowCount: 1 };
    if (head.startsWith("UPDATE REQUEST_FINALIZE_JOURNAL")) return { rows: [], rowCount: 1 };
    if (head.startsWith("INSERT INTO USAGE_RECORDS")) return { rows: [{ id: "1" }], rowCount: 1 };
    if (head.startsWith("SELECT CREDITS")) return { rows: [{ credits: "99999999" }], rowCount: 1 };
    if (head.startsWith("UPDATE USERS SET CREDITS")) return { rows: [], rowCount: 1 };
    if (head.startsWith("INSERT INTO CREDIT_LEDGER")) return { rows: [{ id: "101" }], rowCount: 1 };
    if (head.startsWith("UPDATE USAGE_RECORDS SET LEDGER_ID")) return { rows: [], rowCount: 1 };
    if (head.startsWith("UPDATE CLAUDE_ACCOUNTS SET")) return { rows: [], rowCount: 1 };

    // ─── user_api_keys path SQL(本文件核心)──────────────────────────────
    //
    // 注:正则匹配按 SQL 形状,允许换行/缩进。
    if (/^INSERT\s+INTO\s+USER_API_KEYS/i.test(trimmed)) {
      const [userId, label, keyPrefix, keyHash] = params as [string, string, string, Buffer];
      // 模拟 UNIQUE(key_prefix) — **全表唯一**(贴合生产 migration:UNIQUE 索引不附带
      // `revoked_at IS NULL` partial 条件,撤销后 prefix 也不能复用)。Codex Phase 4
      // code-review NIT 1 采纳。
      for (const row of table.values()) {
        if (row.key_prefix === keyPrefix) {
          const err = new Error("duplicate key_prefix") as Error & { code: string; constraint: string };
          err.code = "23505";
          err.constraint = "user_api_keys_key_prefix_unique";
          throw err;
        }
      }
      const id = (nextId++).toString();
      const createdAt = new Date();
      const row: UserApiKeyRow = {
        id, user_id: userId, label, key_prefix: keyPrefix, key_hash: keyHash,
        created_at: createdAt, last_used_at: null, revoked_at: null,
      };
      table.set(id, row);
      return { rows: [{ id, created_at: createdAt }], rowCount: 1 };
    }

    // findByPrefix:SELECT … WHERE key_prefix=$1 AND revoked_at IS NULL
    if (/^SELECT\s+ID,\s*USER_ID,\s*LABEL,\s*KEY_PREFIX,\s*KEY_HASH/i.test(trimmed)) {
      const [keyPrefix] = params as [string];
      for (const row of table.values()) {
        if (row.key_prefix === keyPrefix && row.revoked_at === null) {
          return {
            rows: [{
              id: row.id, user_id: row.user_id, label: row.label,
              key_prefix: row.key_prefix, key_hash: row.key_hash,
              created_at: row.created_at, last_used_at: row.last_used_at,
            }],
            rowCount: 1,
          };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // list:SELECT id, label, key_prefix, created_at, last_used_at … WHERE user_id=$1 AND revoked_at IS NULL
    if (/^SELECT\s+ID,\s*LABEL,\s*KEY_PREFIX,\s*CREATED_AT,\s*LAST_USED_AT/i.test(trimmed)) {
      const [userId] = params as [string];
      const rows = [...table.values()]
        .filter((r) => r.user_id === userId && r.revoked_at === null)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map((r) => ({
          id: r.id, label: r.label, key_prefix: r.key_prefix,
          created_at: r.created_at, last_used_at: r.last_used_at,
        }));
      return { rows, rowCount: rows.length };
    }

    // revoke:UPDATE … SET revoked_at = now() WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL
    if (/^UPDATE\s+USER_API_KEYS\s+SET\s+REVOKED_AT/i.test(trimmed)) {
      const [userId, id] = params as [string, string];
      const row = table.get(id);
      if (row && row.user_id === userId && row.revoked_at === null) {
        row.revoked_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // touchLastUsed:UPDATE user_api_keys SET last_used_at = now() WHERE id=$1
    if (/^UPDATE\s+USER_API_KEYS\s+SET\s+LAST_USED_AT/i.test(trimmed)) {
      const [id] = params as [string];
      const row = table.get(id);
      if (row) row.last_used_at = new Date();
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`unknown SQL in fakePool: ${trimmed.slice(0, 160)}`);
  };

  const fakeClient = {
    async query(sql: string, params: unknown[] = []) { return handle(sql, params); },
    release: () => {},
  };
  const pool = {
    queries,
    async query(sql: string, params: unknown[] = []) { return handle(sql, params); },
    async connect() { return fakeClient; },
    async end() { /* noop */ },
  };
  return {
    pool: pool as unknown as Pool,
    table,
    queries,
    upsert(row) { table.set(row.id, row); },
  };
}

// ─── 其它 fake deps(同 ccExternalEndpoint.integ.test 简化版)──────────────

function buildFakePreCheckRedis(): PreCheckRedis {
  return {
    async atomicReserve(input) {
      return { ok: true, locked: BigInt(input.maxCost), needed: BigInt(input.maxCost) };
    },
    async releaseReservation() { return true; },
  };
}

function buildFakeRateLimitRedis(): RateLimitRedis {
  let counter = 0;
  return {
    async incr() { counter++; return counter; },
    async expire() { return 1; },
  };
}

function buildFakeScheduler(): AccountScheduler {
  return {
    async pick(): Promise<PickResult> {
      return {
        account_id: 1001n,
        plan: "pro",
        token: Buffer.from("FAKE-TOKEN-VALUE"),
        refresh: null,
        expires_at: null,
        egress_proxy: null,
        egress_target: null,
        egress_proxy_id: null,
        egress_host_uuid: null,
        pinned_user_id: FIXED_PINNED_USER_ID,
        account_uuid: null,
        persona: null,
      };
    },
    async release(_input: ReleaseInput): Promise<void> {},
  } as unknown as AccountScheduler;
}

function buildFakePricing(): PricingCache {
  const m = new Map([[FIXED_MODEL, FIXED_PRICING]]);
  return { get(id: string) { return m.get(id) ?? null; } } as unknown as PricingCache;
}

// ─── MockReq / MockRes ─────────────────────────────────────────────────────

interface MockReqOpts {
  url?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

class MockReq extends Readable {
  url: string;
  method: string;
  headers: Record<string, string>;
  constructor(opts: MockReqOpts = {}) {
    super();
    this.url = opts.url ?? "/";
    this.method = opts.method ?? "GET";
    this.headers = {
      host: "x.invalid",
      "content-type": "application/json",
      // CC 外接 UA gate(2026-05-19,plan §3.5):integ test 默认走真实 CC CLI
      // UA 形态;UA 不对的负例显式在 headers 里覆盖。
      "user-agent": "claude-cli/2.1.888 (external, cli)",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) {
      const buf = Buffer.from(
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      );
      this.headers["content-length"] = String(buf.length);
      this.push(buf);
    }
    this.push(null);
  }
  socket = { remoteAddress: "127.0.0.1" } as unknown as IncomingMessage["socket"];
}

class MockRes {
  statusCode = 0;
  responseHeaders: Record<string, string | number | readonly string[]> = {};
  chunks: Buffer[] = [];
  ended = false;
  headersSent = false;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  setHeader(k: string, v: string | number | readonly string[]) {
    this.responseHeaders[k.toLowerCase()] = v;
  }
  writeHead(status: number, headers?: Record<string, string | number | readonly string[]>) {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.responseHeaders[k.toLowerCase()] = v;
      }
    }
    this.headersSent = true;
  }
  write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return true;
  }
  end(chunk?: string | Buffer): void {
    if (chunk != null) this.write(chunk);
    this.ended = true;
    this.emit("close");
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    if (!this.listeners.has(ev)) this.listeners.set(ev, []);
    this.listeners.get(ev)!.push(cb);
    return this;
  }
  off(ev: string, cb: (...a: unknown[]) => void): this {
    const arr = this.listeners.get(ev);
    if (arr) {
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    }
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    const arr = this.listeners.get(ev);
    if (arr) for (const cb of arr.slice()) cb(...args);
  }
  bodyText(): string { return Buffer.concat(this.chunks).toString("utf8"); }
  bodyJson(): unknown { return JSON.parse(this.bodyText()); }
}

// ─── harness ───────────────────────────────────────────────────────────────

interface Harness {
  fp: FakePoolHandle;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  jwtFor(userId: string, role?: "admin" | "user"): Promise<string>;
}

interface HarnessOpts {
  /** Layer 2 strategy 内 loadUserModelAuthz mock 返的 role(默认 admin)。 */
  authzRole?: "admin" | "user";
}

async function buildHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const fp = buildFakePool();
  setPoolOverride(fp.pool);

  const pricing = buildFakePricing();
  const apiKeyRepo = makePgApiKeyRepo(fp.pool);

  // 真 strategy:loadUserModelAuthz 直接 grant 该 user 用 FIXED_MODEL。
  //
  // Phase 6 admin-only rollout(plan §3.4):本 integ test harness 默认走 admin —
  // 与生产首期上线契约一致。Layer 2 在 strategy 内会比较 authz.role !== "admin"
  // 直接 throw API_KEY_INVALID,JWT 默认也用 admin(见 jwtFor),保证 Phase 1+2+3+4
  // 既有闭环全部继续 pass。**单独的非 admin 负面测试**(plan §3.4 Layer 2 闭环)
  // 通过 opts.authzRole="user" 切换 mock,验 Layer 2 兜底无副作用。
  const authzRole = opts.authzRole ?? "admin";
  const apiKeyStrategy = makeApiKeyIdentityStrategy({
    repo: apiKeyRepo,
    pricing,
    loadUserModelAuthz: async () => ({
      role: authzRole,
      grantedModelIds: new Set<string>([FIXED_MODEL]),
    }),
  });

  const logger = createLogger({
    level: "warn",
    base: { test: "apiKeyAdmin.integ" },
    out: () => {},
  });

  const externalApiKeyProxy = makeAnthropicProxyHandler({
    pgPool: fp.pool,
    pricing,
    preCheckRedis: buildFakePreCheckRedis(),
    scheduler: buildFakeScheduler(),
    identity: apiKeyStrategy,
    rateLimitRedis: buildFakeRateLimitRedis(),
    fetchImpl: async () => sseResponse(200, makeFullSseChunks()),
    upstreamEndpoint: "https://upstream.test/v1/messages",
    logger,
    // Phase 5 envelope rewriter wiring(2026-05-21):外接 ApiKey + OAuth 路径
    // 命中时 handler 会强制走 buildPlatformEnvelope。这里 admin 测试既不验证
    // envelope 内容、又走 OAuth happy path,注入 no-op loader(返 null = "无
    // attribution 可注入",builder 走纯 PII strip + envelope 强制路径,见 plan
    // §3.1 H1)+ 32 字符固定测试 secret,避免 503 PLATFORM_ENVELOPE_UNAVAILABLE。
    platformContextLoader: { load: async () => null, invalidate: () => {} },
    platformServerSecret: "test-platform-hmac-secret-32char",
  });

  const deps: CommercialHttpDeps = {
    jwtSecret: JWT_SECRET,
    mailer: { sendTemplate: async () => {} } as unknown as CommercialHttpDeps["mailer"],
    redis: buildFakeRateLimitRedis(),
    pricing,
    preCheckRedis: buildFakePreCheckRedis(),
    externalApiKeyProxy,
  };
  const handler = createCommercialHandler(deps, { logger });

  return {
    fp,
    handler,
    // Phase 6 admin-only rollout(plan §3.4):harness JWT 默认走 admin —
    // 与生产首期上线契约一致,既有 happy 闭环测试不需要逐个加 role 字段。
    // 非 admin 负面用例传 role:"user" 显式覆写。
    async jwtFor(userId, role = "admin") {
      const r = await signAccess({ sub: userId, role }, JWT_SECRET);
      return r.token;
    },
  };
}

async function runReq(h: Harness, opts: MockReqOpts): Promise<MockRes> {
  const req = new MockReq(opts);
  const res = new MockRes();
  await h.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

beforeEach(() => {
  _clearMaintenanceCache();
});
afterEach(async () => {
  await resetPool();
  _clearMaintenanceCache();
});

// ════════════════════════════════════════════════════════════════════════════
// A. 闭环 happy — create → use → list
// B. 闭环 revoke ⇒ 401 — create → use → DELETE → 同 plaintext 再用 → 401
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 4 闭环 — create → use → revoke → use-fails 全链路真实跑通", () => {
  test("A. POST /api/me/api-keys → GET 显示该 key + B. plaintext 当 Bearer 跑 happy", async () => {
    const h = await buildHarness();
    const jwt = await h.jwtFor(USER_A_ID);

    // —— create
    const createRes = await runReq(h, {
      method: "POST",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${jwt}` },
      body: { label: "cc-laptop" },
    });
    assert.equal(createRes.statusCode, 201, `create body=${createRes.bodyText()}`);
    const created = createRes.bodyJson() as Record<string, string>;
    assert.match(created.plaintext, /^oc-cc\.[0-9a-z]{8}\.[0-9a-f]{48}$/);
    assert.equal(created.label, "cc-laptop");
    assert.match(created.key_prefix, /^[0-9a-z]{8}$/);
    assert.equal(created.plaintext.split(".")[1], created.key_prefix);
    const keyId = created.id;
    assert.match(keyId, /^\d+$/);

    // —— list 显示该 key
    const listRes = await runReq(h, {
      method: "GET",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.bodyJson() as { keys: Array<Record<string, unknown>> };
    assert.equal(listBody.keys.length, 1);
    assert.equal(listBody.keys[0]!.id, keyId);
    assert.equal(listBody.keys[0]!.label, "cc-laptop");
    assert.equal(listBody.keys[0]!.key_prefix, created.key_prefix);
    assert.equal(listBody.keys[0]!.last_used_at, null); // 没用过

    // —— invariant #1 banned-field scan(HTTP 层落锁)
    // 递归遍历对象**键名**,不做 substring match —— 避免 label/value 偶然含
    // "secret" / "plaintext" 等词导致 false-trigger(Codex Phase 4 code-review NIT 2)。
    const BANNED_KEYS = new Set(["plaintext", "key_hash", "keyHash", "secret", "keySecret", "key_secret"]);
    const assertNoBannedKey = (obj: unknown, path: string) => {
      if (obj === null || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => assertNoBannedKey(v, `${path}[${i}]`));
        return;
      }
      for (const k of Object.keys(obj)) {
        assert.ok(!BANNED_KEYS.has(k), `list 响应键名禁止 "${k}";位置=${path}.${k}`);
        assertNoBannedKey((obj as Record<string, unknown>)[k], `${path}.${k}`);
      }
    };
    assertNoBannedKey(listBody, "$");

    // —— plaintext 当 Bearer 跑 happy /api/anthropic/v1/messages
    const proxyRes1 = await runReq(h, {
      method: "POST",
      url: "/api/anthropic/v1/messages",
      headers: {
        authorization: `Bearer ${created.plaintext}`,
        "anthropic-version": "2023-06-01",
      },
      body: { model: FIXED_MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(proxyRes1.statusCode, 200, `proxy body=${proxyRes1.bodyText()}`);

    // —— DELETE
    const delRes = await runReq(h, {
      method: "DELETE",
      url: `/api/me/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(delRes.statusCode, 200);
    assert.deepEqual(delRes.bodyJson(), { ok: true });

    // —— 同 plaintext 再用 → 401(strategy.findByPrefix 走 revoked_at IS NULL 过滤)
    //
    // **HTTP 层错误码是 "UNAUTHORIZED" 而不是 "API_KEY_INVALID"**:proxy handler
    // (proxy/index.ts:144)统一把所有 IdentityError(MISSING_API_KEY / BAD_API_KEY_FORMAT /
    // API_KEY_INVALID)映射成 401 UNAUTHORIZED,errcode 只进 log 不外泄 ——
    // 这是反枚举设计(plan §4 invariant #7,与"unknown key" 与 "revoked key"
    // 返同一码同源)。Phase 3 同型测试(ccExternalEndpoint.integ.test:809-820)
    // 也只断 status 401,不断 body errcode。
    const proxyRes2 = await runReq(h, {
      method: "POST",
      url: "/api/anthropic/v1/messages",
      headers: {
        authorization: `Bearer ${created.plaintext}`,
        "anthropic-version": "2023-06-01",
      },
      body: { model: FIXED_MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(proxyRes2.statusCode, 401, `revoke 后 proxy body=${proxyRes2.bodyText()}`);
    const err2 = proxyRes2.bodyJson() as { error?: { code?: string } };
    assert.equal(err2.error?.code, "UNAUTHORIZED");

    // —— list 也应不再显示该 key(revoked_at 过滤)
    const list2 = await runReq(h, {
      method: "GET",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(list2.statusCode, 200);
    assert.deepEqual(list2.bodyJson(), { keys: [] });

    // —— DELETE 已撤销 id → 404(不暴露 "exists but revoked")
    const delAgain = await runReq(h, {
      method: "DELETE",
      url: `/api/me/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(delAgain.statusCode, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. 跨用户隔离 — UID_A 创建,UID_B DELETE :id_A 不应撤销
// ════════════════════════════════════════════════════════════════════════════

describe("跨用户隔离 — UID_B 不能撤销 UID_A 的 key", () => {
  test("UID_A 创建 → UID_B DELETE :id_A → 404 + key 仍存活 + UID_A 还能用", async () => {
    const h = await buildHarness();
    const jwtA = await h.jwtFor(USER_A_ID);
    const jwtB = await h.jwtFor(USER_B_ID);

    // UID_A 创建
    const createRes = await runReq(h, {
      method: "POST",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${jwtA}` },
      body: { label: "a-laptop" },
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.bodyJson() as Record<string, string>;
    const keyId = created.id;

    // UID_B DELETE :id_A → 404,**不**撤销
    const delRes = await runReq(h, {
      method: "DELETE",
      url: `/api/me/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${jwtB}` },
    });
    assert.equal(delRes.statusCode, 404, `UID_B 跨用户撤销必须 404;got=${delRes.bodyText()}`);

    // 表里该 row 仍 active
    const row = h.fp.table.get(keyId);
    assert.ok(row, "row 应存在");
    assert.equal(row!.revoked_at, null, "row 不应被撤销");

    // UID_A 仍能用该 plaintext
    const proxyRes = await runReq(h, {
      method: "POST",
      url: "/api/anthropic/v1/messages",
      headers: {
        authorization: `Bearer ${created.plaintext}`,
        "anthropic-version": "2023-06-01",
      },
      body: { model: FIXED_MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(proxyRes.statusCode, 200, `UID_A plaintext 应仍 happy;got=${proxyRes.bodyText()}`);

    // UID_B GET list 看不到 UID_A 的 key
    const listB = await runReq(h, {
      method: "GET",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${jwtB}` },
    });
    assert.equal(listB.statusCode, 200);
    assert.deepEqual(listB.bodyJson(), { keys: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F. label boundary
// ════════════════════════════════════════════════════════════════════════════

describe("label 边界 — repo CHECK 1..80 chars after trim", () => {
  test("空串 / 纯空白 / 81 chars → 400 INVALID_LABEL", async () => {
    const h = await buildHarness();
    const jwt = await h.jwtFor(USER_A_ID);

    for (const bad of ["", "   ", "x".repeat(81)]) {
      const res = await runReq(h, {
        method: "POST",
        url: "/api/me/api-keys",
        headers: { authorization: `Bearer ${jwt}` },
        body: { label: bad },
      });
      assert.equal(res.statusCode, 400, `label="${bad.slice(0, 16)}…" 应被拒;got=${res.statusCode}`);
      const err = res.bodyJson() as { error?: { code?: string } };
      assert.equal(err.error?.code, "INVALID_LABEL");
    }

    // 80 chars boundary 应通过
    const ok = await runReq(h, {
      method: "POST",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${jwt}` },
      body: { label: "x".repeat(80) },
    });
    assert.equal(ok.statusCode, 201);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G. UNAUTHORIZED — admin endpoints 无 JWT
// ════════════════════════════════════════════════════════════════════════════

describe("admin endpoints 无 JWT → 401 不触碰 DB", () => {
  test("GET / POST / DELETE 三条 endpoint 各自 401", async () => {
    const h = await buildHarness();

    const getRes = await runReq(h, { method: "GET", url: "/api/me/api-keys" });
    assert.equal(getRes.statusCode, 401);

    const postRes = await runReq(h, {
      method: "POST",
      url: "/api/me/api-keys",
      body: { label: "x" },
    });
    assert.equal(postRes.statusCode, 401);

    const delRes = await runReq(h, { method: "DELETE", url: "/api/me/api-keys/1" });
    assert.equal(delRes.statusCode, 401);

    // 未触达 DB(无 INSERT / SELECT 落到 fakePool;只有未鉴权前可能的 maintenance gate
    // 读 system_settings;那是 GET 路径不算 user_api_keys 表)
    const dbTouched = h.fp.queries.some((q) => /USER_API_KEYS/i.test(q.sql));
    assert.ok(!dbTouched, `401 不应触达 user_api_keys 表;queries=${JSON.stringify(h.fp.queries.map((q) => q.sql.slice(0, 40)))}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// H. existence privacy — DELETE 不存在 id (≤ BIGINT max) → 404
// ════════════════════════════════════════════════════════════════════════════

describe("DELETE 不存在的 id → 404(与 not-yours 同码,不暴露存在性)", () => {
  test("不存在的 id=999999999 → 404", async () => {
    const h = await buildHarness();
    const jwt = await h.jwtFor(USER_A_ID);
    const res = await runReq(h, {
      method: "DELETE",
      url: "/api/me/api-keys/999999999",
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 6 admin-only rollout(plan §3.4)— 两层防御都覆盖,**端到端真路由跑**。
//
// Layer 1(管理面 HTTP):非 admin JWT 进 GET/POST/DELETE /api/me/api-keys
//   一律 403 ADMIN_ONLY,user_api_keys 表完全不被触达。
//
// Layer 2(strategy.resolve):admin 创建了 key 后,authz 回滚至 user role
//   (模拟 "管理员把 key 给到普通用户后又被降权"),非 admin 拿真 plaintext 走
//   /api/anthropic/v1/messages → 401 UNAUTHORIZED,且 **preCheck / journal /
//   ledger / usage_records / claude_accounts** 任意 SQL 都不能触达 —— 这是
//   "secret 已 verify 后才 throw" 的核心闭环:strategy 已 bumpLastUsedThrottled
//   完才扔 IdentityError,proxy/index.ts 把 IdentityError 全部映成 401,不进
//   计费/调度链(plan §3.4 + Codex plan-review §5 闭环 1+6 采纳)。
//
// 这两条用例直接锁 "上线给管理员用 + 普通用户即使有 key 也无法消费 quota"
// 的承诺;失守任一条,生产数据就可能被普通用户消费 claude_accounts pool。
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 6 admin-only rollout — Layer 1 管理面 403 闭环", () => {
  test("非 admin JWT 进 GET/POST/DELETE → 全部 403 ADMIN_ONLY,user_api_keys 未触达", async () => {
    const h = await buildHarness();
    const userJwt = await h.jwtFor(USER_A_ID, "user");

    // GET
    const getRes = await runReq(h, {
      method: "GET",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${userJwt}` },
    });
    assert.equal(getRes.statusCode, 403, `GET body=${getRes.bodyText()}`);
    assert.equal((getRes.bodyJson() as { error?: { code?: string } }).error?.code, "ADMIN_ONLY");

    // POST
    const postRes = await runReq(h, {
      method: "POST",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${userJwt}` },
      body: { label: "shouldnt-create" },
    });
    assert.equal(postRes.statusCode, 403, `POST body=${postRes.bodyText()}`);
    assert.equal((postRes.bodyJson() as { error?: { code?: string } }).error?.code, "ADMIN_ONLY");

    // DELETE 合法 path
    const delRes = await runReq(h, {
      method: "DELETE",
      url: "/api/me/api-keys/42",
      headers: { authorization: `Bearer ${userJwt}` },
    });
    assert.equal(delRes.statusCode, 403, `DELETE body=${delRes.bodyText()}`);
    assert.equal((delRes.bodyJson() as { error?: { code?: string } }).error?.code, "ADMIN_ONLY");

    // DELETE malformed path — admin gate 在 path 解析**之前**,非 admin 也得 403 不是 404。
    const delBad = await runReq(h, {
      method: "DELETE",
      url: "/api/me/api-keys/abc",
      headers: { authorization: `Bearer ${userJwt}` },
    });
    assert.equal(delBad.statusCode, 403, `DELETE-bad body=${delBad.bodyText()}`);
    assert.equal((delBad.bodyJson() as { error?: { code?: string } }).error?.code, "ADMIN_ONLY");

    // 闭环 — user_api_keys 表完全不被触达,空表
    assert.equal(h.fp.table.size, 0, "non-admin 应在 admin gate 全部 reject,DB 表零行");
    const touched = h.fp.queries.some((q) => /USER_API_KEYS/i.test(q.sql));
    assert.ok(!touched, `non-admin 不应触达 user_api_keys 表;queries=${JSON.stringify(h.fp.queries.map((q) => q.sql.slice(0, 40)))}`);
  });
});

describe("Phase 6 admin-only rollout — Layer 2 strategy 兜底 401 + 零副作用", () => {
  test("admin 创建 key 后 authz 降级 user,真 plaintext → 401,**preCheck / journal / ledger 全不触达**", async () => {
    // —— Step 1: 用默认 admin harness 创建一个真实的 key,拿到 plaintext。
    const hAdmin = await buildHarness({ authzRole: "admin" });
    const adminJwt = await hAdmin.jwtFor(USER_A_ID, "admin");
    const createRes = await runReq(hAdmin, {
      method: "POST",
      url: "/api/me/api-keys",
      headers: { authorization: `Bearer ${adminJwt}` },
      body: { label: "for-non-admin-to-misuse" },
    });
    assert.equal(createRes.statusCode, 201, `create body=${createRes.bodyText()}`);
    const created = createRes.bodyJson() as Record<string, string>;
    const plaintext = created.plaintext;
    const keyId = created.id;
    const keyPrefix = created.key_prefix;
    const keyHash = hAdmin.fp.table.get(keyId)!.key_hash;
    await resetPool(); // 释放 admin harness 的 pool override(afterEach 也会但此处显式更稳)

    // —— Step 2: 切到 authz=user harness — 模拟 "owner role 已被降级"。
    //    新 harness 用全新 fakePool,需要把 key row 手工种回去。
    const hUser = await buildHarness({ authzRole: "user" });
    // 用 fakePool.upsert() 把 admin 创建的那行 row 种回去,保持 key_hash 一致。
    hUser.fp.upsert({
      id: keyId,
      user_id: USER_A_ID,
      label: created.label,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      created_at: new Date(created.created_at),
      last_used_at: null,
      revoked_at: null,
    });

    // —— Step 3: 拿真 plaintext 走 /api/anthropic/v1/messages — 应 401 + 无任何
    //            计费/调度副作用。
    const proxyRes = await runReq(hUser, {
      method: "POST",
      url: "/api/anthropic/v1/messages",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "anthropic-version": "2023-06-01",
      },
      body: { model: FIXED_MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true },
    });
    assert.equal(proxyRes.statusCode, 401, `non-admin proxy body=${proxyRes.bodyText()}`);
    // 反枚举:不区分 unknown / revoked / non-admin,统一 UNAUTHORIZED(proxy/index.ts:144)。
    const err = proxyRes.bodyJson() as { error?: { code?: string } };
    assert.equal(err.error?.code, "UNAUTHORIZED");

    // —— Step 4: **闭环零副作用** — secret verify 已成功(bumpLastUsedThrottled
    //            会跑 → last_used_at 必须被更新);但 admin gate throw 后,proxy
    //            handler catch IdentityError 直接 401,不进 preCheck / 不调度
    //            claude_account / 不开 journal / 不写 usage_records / 不写 ledger。
    const sqlSeen = hUser.fp.queries.map((q) => q.sql.trim().toUpperCase());

    // last_used_at 更新必须发生(顺序锁:secret OK 后 strategy 才 bump,bump 完才 reject)
    const bumped = sqlSeen.some((s) => /^UPDATE\s+USER_API_KEYS\s+SET\s+LAST_USED_AT/.test(s));
    assert.ok(bumped, "secret 已 verify → bumpLastUsedThrottled 必须执行(顺序锁,见 Layer 2 Codex §5 闭环 1)");
    // table 内 row 的 last_used_at 也应该非 null
    const row = hUser.fp.table.get(keyId)!;
    assert.ok(row.last_used_at !== null, "last_used_at 必须被更新");

    // 但任何 billing/scheduling 副作用一概禁止
    const FORBIDDEN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
      { re: /INSERT\s+INTO\s+REQUEST_FINALIZE_JOURNAL/, reason: "journal 不能开" },
      { re: /UPDATE\s+REQUEST_FINALIZE_JOURNAL/, reason: "journal 不能写" },
      { re: /INSERT\s+INTO\s+USAGE_RECORDS/, reason: "usage_records 不能写" },
      { re: /INSERT\s+INTO\s+CREDIT_LEDGER/, reason: "credit_ledger 不能写" },
      { re: /UPDATE\s+USERS\s+SET\s+CREDITS/, reason: "users.credits 不能动" },
      { re: /UPDATE\s+CLAUDE_ACCOUNTS\s+SET/, reason: "claude_accounts 不能 release" },
    ];
    for (const { re, reason } of FORBIDDEN_PATTERNS) {
      const hit = sqlSeen.find((s) => re.test(s));
      assert.ok(!hit, `Phase 6 Layer 2 闭环:${reason};hit=${hit?.slice(0, 80)}`);
    }
  });
});
