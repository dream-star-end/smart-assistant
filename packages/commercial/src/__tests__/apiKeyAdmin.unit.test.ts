/**
 * V3 CC 外接 plan Phase 4 — apiKeyAdmin handler 单元测试。
 *
 * 单元层关心:
 *   - 字段 shape(snake_case 出参、ISO 时间戳、BigInt → string)
 *   - 错误码映射(repo 错误 → HttpError code)
 *   - **invariant #1**:list 响应严禁含 secret / keyHash 字段(HTTP 层落锁)
 *   - DELETE path regex 边界(尾斜杠 / 非数字 / 超 BIGINT 上限)
 *
 * 与 integ test 的分工:
 *   - 这里**不**走真路由,直接调 handler 函数,fake JWT + fakePool
 *   - 不测跨用户隔离闭环(那是 integ 层 SQL 真实 WHERE user_id 锁的)
 *   - 不测 revoke → strategy.findByPrefix 闭环(那需要走 Phase 3 链路)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import {
  handleListMyApiKeys,
  handleCreateMyApiKey,
  handleRevokeMyApiKey,
} from "../http/apiKeyAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";
import { signAccess } from "../auth/jwt.js";
import { setPoolOverride, resetPool } from "../db/index.js";
import type { Pool } from "pg";
import { ApiKeyRepoError } from "../auth/apiKeyRepo.js";

const JWT_SECRET = "test-jwt-secret-not-actually-used-for-anything-real-32b";
const USER_ID = "7";
const OTHER_USER_ID = "8";

// ─── Mock req / res ────────────────────────────────────────────────────────

class MockReq extends Readable {
  url: string;
  method: string;
  headers: Record<string, string>;
  constructor(opts: {
    url?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}) {
    super();
    this.url = opts.url ?? "/api/me/api-keys";
    this.method = opts.method ?? "GET";
    this.headers = {
      host: "x.invalid",
      "content-type": "application/json",
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
  }
  on(): this { return this; }
  off(): this { return this; }
  emit(): boolean { return true; }
  bodyText(): string { return Buffer.concat(this.chunks).toString("utf8"); }
  bodyJson(): unknown { return JSON.parse(this.bodyText()); }
}

// ─── fakePool — 只 mock 三条 SQL,其余抛(允许测试发现意外 query)──────────────

interface FakePoolOpts {
  /** list 返回行 */
  listRows?: Array<{ id: string; label: string; key_prefix: string; created_at: Date; last_used_at: Date | null }>;
  /** create 返回 id + created_at */
  createReturning?: { id: string; created_at: Date };
  /** create 抛错(优先于 createReturning) */
  createError?: unknown;
  /** revoke 影响行数 */
  revokeRowCount?: number;
}

function buildFakePool(opts: FakePoolOpts = {}): Pool {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const head = sql.trim().toUpperCase();
      if (head.startsWith("SELECT ID, LABEL, KEY_PREFIX, CREATED_AT, LAST_USED_AT")) {
        return { rows: opts.listRows ?? [], rowCount: (opts.listRows ?? []).length };
      }
      if (head.startsWith("INSERT INTO USER_API_KEYS")) {
        if (opts.createError) throw opts.createError;
        return {
          rows: [opts.createReturning ?? { id: "999", created_at: new Date("2026-05-18T00:00:00Z") }],
          rowCount: 1,
        };
      }
      if (head.startsWith("UPDATE USER_API_KEYS")) {
        return { rows: [], rowCount: opts.revokeRowCount ?? 0 };
      }
      throw new Error(`unknown SQL in fakePool: ${head.slice(0, 100)}`);
    },
    async connect() {
      return { query: pool.query.bind(pool), release: () => {} };
    },
    async end() {},
  } as unknown as Pool & { queries: Array<{ sql: string; params: unknown[] }> };
  return pool;
}

// Phase 6 admin-only rollout(plan §3.4):管理面 endpoint 当前只对 admin 开放。
// 单元测试默认走 admin role(reflect 上线契约);非 admin 路径用 makeUserAuthHeader
// 单独验 403 ADMIN_ONLY。去 gate 后把默认改回 "user" 即可。
async function makeAuthHeader(uidStr: string = USER_ID): Promise<{ authorization: string }> {
  const { token } = await signAccess({ sub: uidStr, role: "admin" }, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

async function makeUserAuthHeader(uidStr: string = USER_ID): Promise<{ authorization: string }> {
  const { token } = await signAccess({ sub: uidStr, role: "user" }, JWT_SECRET);
  return { authorization: `Bearer ${token}` };
}

function makeDeps(): CommercialHttpDeps {
  return {
    jwtSecret: JWT_SECRET,
    // 其余字段不被 handler 消费;保持 minimal 注入
  } as unknown as CommercialHttpDeps;
}

const FAKE_CTX = {} as RequestContext;

// ────────────────────────────────────────────────────────────────────────────
// (1) GET /api/me/api-keys
// ────────────────────────────────────────────────────────────────────────────

describe("handleListMyApiKeys — GET list", () => {
  test("空列表 → 200 + keys=[]", async () => {
    setPoolOverride(buildFakePool({ listRows: [] }));
    try {
      const req = new MockReq({ headers: await makeAuthHeader() });
      const res = new MockRes();
      await handleListMyApiKeys(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        FAKE_CTX,
        makeDeps(),
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.bodyJson(), { keys: [] });
    } finally { await resetPool(); }
  });

  test("两行 → 字段 shape: id(string)/label/key_prefix/created_at(ISO)/last_used_at(ISO|null)", async () => {
    setPoolOverride(
      buildFakePool({
        listRows: [
          {
            id: "42",
            label: "laptop",
            key_prefix: "abcd1234",
            created_at: new Date("2026-05-18T00:00:00Z"),
            last_used_at: new Date("2026-05-18T01:00:00Z"),
          },
          {
            id: "43",
            label: "ci",
            key_prefix: "wxyz5678",
            created_at: new Date("2026-05-17T00:00:00Z"),
            last_used_at: null, // 从未用过
          },
        ],
      }),
    );
    try {
      const req = new MockReq({ headers: await makeAuthHeader() });
      const res = new MockRes();
      await handleListMyApiKeys(req as any, res as any, FAKE_CTX, makeDeps());
      assert.equal(res.statusCode, 200);
      const body = res.bodyJson() as { keys: Array<Record<string, unknown>> };
      assert.equal(body.keys.length, 2);
      assert.deepEqual(body.keys[0], {
        id: "42",
        label: "laptop",
        key_prefix: "abcd1234",
        created_at: "2026-05-18T00:00:00.000Z",
        last_used_at: "2026-05-18T01:00:00.000Z",
      });
      assert.equal(body.keys[1]!.last_used_at, null);
    } finally { await resetPool(); }
  });

  // Codex Phase 4 plan-review NIT:HTTP 层显式锁住 invariant #1。
  test("响应**不含** plaintext / key_hash / keyHash 字段(invariant #1 HTTP 锁)", async () => {
    setPoolOverride(
      buildFakePool({
        listRows: [
          {
            id: "42",
            label: "laptop",
            key_prefix: "abcd1234",
            created_at: new Date("2026-05-18T00:00:00Z"),
            last_used_at: null,
          },
        ],
      }),
    );
    try {
      const req = new MockReq({ headers: await makeAuthHeader() });
      const res = new MockRes();
      await handleListMyApiKeys(req as any, res as any, FAKE_CTX, makeDeps());
      // 递归扫**键名**,不做 substring match —— 避免 label/value 含 "secret" 等词
      // 造成 false-positive(Codex Phase 4 code-review NIT 2 采纳)。
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
      assertNoBannedKey(res.bodyJson(), "$");
    } finally { await resetPool(); }
  });

  test("无 Authorization 头 → 401 UNAUTHORIZED,不查 DB", async () => {
    const pool = buildFakePool();
    setPoolOverride(pool);
    try {
      const req = new MockReq({ headers: {} });
      const res = new MockRes();
      await assert.rejects(
        handleListMyApiKeys(req as any, res as any, FAKE_CTX, makeDeps()),
        (err: { status?: number; code?: string }) =>
          err.status === 401 && err.code === "UNAUTHORIZED",
      );
      assert.equal((pool as unknown as { queries: unknown[] }).queries.length, 0, "auth 失败前不查 DB");
    } finally { await resetPool(); }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (2) POST /api/me/api-keys
// ────────────────────────────────────────────────────────────────────────────

describe("handleCreateMyApiKey — POST create", () => {
  test("happy → 201 + plaintext 形态 oc-cc.<8b36>.<48hex>", async () => {
    setPoolOverride(
      buildFakePool({
        createReturning: { id: "999", created_at: new Date("2026-05-18T00:00:00Z") },
      }),
    );
    try {
      const req = new MockReq({
        method: "POST",
        body: { label: "laptop" },
        headers: await makeAuthHeader(),
      });
      const res = new MockRes();
      await handleCreateMyApiKey(req as any, res as any, FAKE_CTX, makeDeps());
      assert.equal(res.statusCode, 201);
      const body = res.bodyJson() as Record<string, string>;
      assert.equal(body.id, "999");
      assert.equal(body.label, "laptop");
      assert.match(body.key_prefix, /^[0-9a-z]{8}$/);
      assert.match(body.plaintext, /^oc-cc\.[0-9a-z]{8}\.[0-9a-f]{48}$/);
      // plaintext 的 prefix 与 key_prefix 必须一致
      const prefixFromToken = body.plaintext.split(".")[1];
      assert.equal(prefixFromToken, body.key_prefix);
      assert.equal(body.created_at, "2026-05-18T00:00:00.000Z");
    } finally { await resetPool(); }
  });

  test("缺 label / 非 object body → 400 INVALID_BODY 或 INVALID_LABEL", async () => {
    setPoolOverride(buildFakePool());
    try {
      // body 是 JSON valid scalar(非 object)— 42 → readJsonBody 返 number → handler 检出
      // (注:若发非 JSON 文本如 "raw",readJsonBody 会先抛 INVALID_JSON,走不到这里)
      const req1 = new MockReq({ method: "POST", body: 42, headers: await makeAuthHeader() });
      await assert.rejects(
        handleCreateMyApiKey(req1 as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 400 && e.code === "INVALID_BODY",
      );
      // body 是 array(非 object)— 同样应被 handler 显式拦下
      const reqArr = new MockReq({ method: "POST", body: [], headers: await makeAuthHeader() });
      await assert.rejects(
        handleCreateMyApiKey(reqArr as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 400 && e.code === "INVALID_BODY",
      );
      // body 是 {} 缺 label
      const req2 = new MockReq({ method: "POST", body: {}, headers: await makeAuthHeader() });
      await assert.rejects(
        handleCreateMyApiKey(req2 as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 400 && e.code === "INVALID_LABEL",
      );
      // label 是 number
      const req3 = new MockReq({ method: "POST", body: { label: 42 }, headers: await makeAuthHeader() });
      await assert.rejects(
        handleCreateMyApiKey(req3 as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 400 && e.code === "INVALID_LABEL",
      );
    } finally { await resetPool(); }
  });

  test("repo LABEL_INVALID(空白/超长)→ 400 INVALID_LABEL", async () => {
    setPoolOverride(
      buildFakePool({
        createError: new ApiKeyRepoError("LABEL_INVALID", "label must be 1..80 chars after trim"),
      }),
    );
    try {
      const req = new MockReq({
        method: "POST",
        body: { label: "   " }, // trim 后为空,repo 会抛
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleCreateMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 400 && e.code === "INVALID_LABEL",
      );
    } finally { await resetPool(); }
  });

  test("repo PREFIX_COLLISION → 500 INTERNAL(天体级巧合)", async () => {
    setPoolOverride(
      buildFakePool({
        createError: new ApiKeyRepoError(
          "PREFIX_COLLISION_RETRIES_EXHAUSTED",
          "failed to create unique key_prefix after 3 attempts",
        ),
      }),
    );
    try {
      const req = new MockReq({
        method: "POST",
        body: { label: "x" },
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleCreateMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 500 && e.code === "INTERNAL",
      );
    } finally { await resetPool(); }
  });

  test("repo unknown error → 透传(不吞,handler 不假装成 500)", async () => {
    setPoolOverride(buildFakePool({ createError: new Error("DB connection lost") }));
    try {
      const req = new MockReq({
        method: "POST",
        body: { label: "x" },
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleCreateMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: Error) => e.message === "DB connection lost",
      );
    } finally { await resetPool(); }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (3) DELETE /api/me/api-keys/:id
// ────────────────────────────────────────────────────────────────────────────

describe("handleRevokeMyApiKey — DELETE revoke", () => {
  test("happy revoke(rowCount=1)→ 200 + ok:true", async () => {
    setPoolOverride(buildFakePool({ revokeRowCount: 1 }));
    try {
      const req = new MockReq({
        url: "/api/me/api-keys/42",
        method: "DELETE",
        headers: await makeAuthHeader(),
      });
      const res = new MockRes();
      await handleRevokeMyApiKey(req as any, res as any, FAKE_CTX, makeDeps());
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.bodyJson(), { ok: true });
    } finally { await resetPool(); }
  });

  test("not found / 不属于该 user(rowCount=0)→ 404 NOT_FOUND", async () => {
    setPoolOverride(buildFakePool({ revokeRowCount: 0 }));
    try {
      const req = new MockReq({
        url: "/api/me/api-keys/42",
        method: "DELETE",
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleRevokeMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 404 && e.code === "NOT_FOUND",
      );
    } finally { await resetPool(); }
  });

  test("path 不匹配(尾斜杠 / 非数字 / 缺 id)→ 404,**不查 DB**", async () => {
    const pool = buildFakePool();
    setPoolOverride(pool);
    try {
      // 缺 id
      const req1 = new MockReq({
        url: "/api/me/api-keys/",
        method: "DELETE",
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleRevokeMyApiKey(req1 as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number }) => e.status === 404,
      );
      // 非数字
      const req2 = new MockReq({
        url: "/api/me/api-keys/abc",
        method: "DELETE",
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleRevokeMyApiKey(req2 as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number }) => e.status === 404,
      );
      // 前导 0
      const req3 = new MockReq({
        url: "/api/me/api-keys/042",
        method: "DELETE",
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleRevokeMyApiKey(req3 as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number }) => e.status === 404,
      );
      assert.equal((pool as unknown as { queries: unknown[] }).queries.length, 0, "path 不匹配前不该查 DB");
    } finally { await resetPool(); }
  });

  // Codex Phase 4 plan-review MINOR 2:超 PG BIGINT 上限 → 404,不让 DB cast 500
  test("超 PG BIGINT 上限(20 位数字)→ 404 NOT_FOUND,**不查 DB**", async () => {
    const pool = buildFakePool();
    setPoolOverride(pool);
    try {
      // 9223372036854775808 = BIGINT_MAX + 1,确实超界
      const req = new MockReq({
        url: "/api/me/api-keys/9223372036854775808",
        method: "DELETE",
        headers: await makeAuthHeader(),
      });
      await assert.rejects(
        handleRevokeMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 404 && e.code === "NOT_FOUND",
      );
      assert.equal(
        (pool as unknown as { queries: unknown[] }).queries.length,
        0,
        "超 BIGINT 上限前不该查 DB",
      );
    } finally { await resetPool(); }
  });

  test("无 Authorization 头 → 401 UNAUTHORIZED", async () => {
    const pool = buildFakePool();
    setPoolOverride(pool);
    try {
      const req = new MockReq({
        url: "/api/me/api-keys/42",
        method: "DELETE",
        headers: {},
      });
      await assert.rejects(
        handleRevokeMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 401 && e.code === "UNAUTHORIZED",
      );
      assert.equal((pool as unknown as { queries: unknown[] }).queries.length, 0);
    } finally { await resetPool(); }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (4) 跨用户隔离 — repo SQL `WHERE user_id` 已 enforce,handler 端只验 uid 传对
// ────────────────────────────────────────────────────────────────────────────

describe("跨用户隔离 — repo.revoke 收到正确的 userId param", () => {
  test("JWT UID_A 的 DELETE 请求,SQL params 包含 USER_ID 而非 OTHER", async () => {
    const pool = buildFakePool({ revokeRowCount: 1 });
    setPoolOverride(pool);
    try {
      const req = new MockReq({
        url: "/api/me/api-keys/42",
        method: "DELETE",
        headers: await makeAuthHeader(USER_ID),
      });
      const res = new MockRes();
      await handleRevokeMyApiKey(req as any, res as any, FAKE_CTX, makeDeps());

      const queries = (pool as unknown as { queries: Array<{ sql: string; params: unknown[] }> }).queries;
      const update = queries.find((q) => q.sql.trim().toUpperCase().startsWith("UPDATE USER_API_KEYS"));
      assert.ok(update, "应当有一条 UPDATE");
      // SQL params: [userId_str, id_str]
      assert.equal(update!.params[0], USER_ID, `repo 收到的 userId 必须是 ${USER_ID}`);
      assert.notEqual(update!.params[0], OTHER_USER_ID);
      assert.equal(update!.params[1], "42");
    } finally { await resetPool(); }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (5) Phase 6 admin-only rollout gate(Layer 1)— 非 admin → 403 ADMIN_ONLY
//
// plan §3.4:CC 外接管理面首期只对 admin 开放;普通用户 JWT 进 GET/POST/DELETE
// 一律 403,且 repo 不被触达(handler 第一行就 throw)。Layer 2 在 strategy
// 内做兜底,即使 DB 残留非 admin 的 key 也无法使用 —— 见
// apiKeyIdentity.unit.test.ts 内同名 describe。
// ────────────────────────────────────────────────────────────────────────────

describe("Phase 6 admin-only — 非 admin → 403 ADMIN_ONLY", () => {
  test("GET 非 admin → 403,repo.list 未被调", async () => {
    const pool = buildFakePool({ listRows: [] });
    setPoolOverride(pool);
    try {
      const req = new MockReq({ headers: await makeUserAuthHeader() });
      const res = new MockRes();
      await assert.rejects(
        handleListMyApiKeys(req as any, res as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 403 && e.code === "ADMIN_ONLY",
      );
      assert.equal(
        (pool as unknown as { queries: unknown[] }).queries.length,
        0,
        "admin gate 在 repo.list 之前 reject",
      );
    } finally { await resetPool(); }
  });

  test("POST 非 admin → 403,repo.create 未被调", async () => {
    const pool = buildFakePool({
      createReturning: { id: "999", created_at: new Date("2026-05-18T00:00:00Z") },
    });
    setPoolOverride(pool);
    try {
      const req = new MockReq({
        method: "POST",
        body: { label: "laptop" },
        headers: await makeUserAuthHeader(),
      });
      const res = new MockRes();
      await assert.rejects(
        handleCreateMyApiKey(req as any, res as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 403 && e.code === "ADMIN_ONLY",
      );
      assert.equal(
        (pool as unknown as { queries: unknown[] }).queries.length,
        0,
        "admin gate 在 repo.create 之前 reject",
      );
    } finally { await resetPool(); }
  });

  test("DELETE 非 admin → 403,repo.revoke 未被调(即使 path 合法)", async () => {
    const pool = buildFakePool({ revokeRowCount: 1 });
    setPoolOverride(pool);
    try {
      const req = new MockReq({
        url: "/api/me/api-keys/42",
        method: "DELETE",
        headers: await makeUserAuthHeader(),
      });
      const res = new MockRes();
      await assert.rejects(
        handleRevokeMyApiKey(req as any, res as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 403 && e.code === "ADMIN_ONLY",
      );
      assert.equal(
        (pool as unknown as { queries: unknown[] }).queries.length,
        0,
        "admin gate 在 repo.revoke 之前 reject",
      );
    } finally { await resetPool(); }
  });

  // 锁住 handler 内的顺序:admin gate 在 path regex **之前**。
  // 否则非 admin 撞 malformed path 会返 404(暴露 path 校验细节),
  // 与 "admin-only rollout 期间不区分 path 是否合法" 的契约不符。
  test("DELETE 非 admin + malformed path → 403 而不是 404(admin gate 在 path 解析前)", async () => {
    const pool = buildFakePool();
    setPoolOverride(pool);
    try {
      const req = new MockReq({
        url: "/api/me/api-keys/abc", // 非数字 path,合法 admin 走会得 404
        method: "DELETE",
        headers: await makeUserAuthHeader(),
      });
      await assert.rejects(
        handleRevokeMyApiKey(req as any, new MockRes() as any, FAKE_CTX, makeDeps()),
        (e: { status?: number; code?: string }) =>
          e.status === 403 && e.code === "ADMIN_ONLY",
      );
      assert.equal((pool as unknown as { queries: unknown[] }).queries.length, 0);
    } finally { await resetPool(); }
  });
});
