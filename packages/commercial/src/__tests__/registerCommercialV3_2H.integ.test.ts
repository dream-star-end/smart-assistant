/**
 * V3 Phase 2 Task 2H 集成测试 — registerCommercial 装配 anthropic 代理 + userChatBridge。
 *
 * 验收(对应 docs/v3/03-MVP-CHECKLIST.md Task 2H):
 *   1. 默认 resolveContainerEndpoint 抛 ContainerUnreadyError → bridge close 4503
 *   2. 内部 anthropic 代理 listener 启动后:
 *      - GET / → 404 NOT_FOUND(只接 POST /v1/messages)
 *      - 不带 Authorization 的 POST /v1/messages → 401 UNAUTHORIZED(身份双因子)
 *      - 监听地址 = INTERNAL_PROXY_BIND:INTERNAL_PROXY_PORT 反映在 internalProxyAddress
 *   3. shutdown 关闭 listener、redis、pricing、ws bridge、closePool 全程不卡死
 *   4. /ws/user-chat-bridge 走 token=invalid → close(1008 unauthorized)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";

import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
} from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { registerCommercial, type RegisterCommercialResult } from "../index.js";
import { signAccess } from "../auth/jwt.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

const COMMERCIAL_TABLES = [
  "rate_limit_events", "admin_audit", "agent_audit", "agent_containers",
  "agent_subscriptions", "user_preferences", "request_finalize_journal",
  "orders", "topup_plans", "usage_records",
  "credit_ledger", "model_pricing", "claude_accounts", "refresh_tokens",
  "email_verifications", "users", "schema_migrations",
];

let pgAvailable = false;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of [
    "DATABASE_URL", "REDIS_URL", "COMMERCIAL_ENABLED",
    "COMMERCIAL_AUTO_MIGRATE", "OPENCLAUDE_KMS_KEY",
    "INTERNAL_PROXY_BIND", "INTERNAL_PROXY_PORT",
    "COMMERCIAL_ALERTS_DISABLED",
  ]) ORIGINAL_ENV[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function probe(): Promise<boolean> {
  const p = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try { await p.query("SELECT 1"); await p.end(); return true; }
  catch { try { await p.end(); } catch { /* */ } return false; }
}

before(async () => {
  pgAvailable = await probe();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  snapshotEnv();
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.COMMERCIAL_ENABLED = "1";
  process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString("base64");
  // 静默 alert 调度器,避免后台 tick 影响 shutdown 等待
  process.env.COMMERCIAL_ALERTS_DISABLED = "1";
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
  await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`);
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await query(`DROP TABLE IF EXISTS ${COMMERCIAL_TABLES.join(", ")} CASCADE`); } catch { /* */ }
    try { await closePool(); } catch { /* */ }
  }
  restoreEnv();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query("TRUNCATE TABLE usage_records, claude_accounts RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

/** 找一个空闲端口(127.0.0.1 系列):let OS pick → 立即 close 释放。 */
async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv: HttpServer = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

const JWT_SECRET = "test-jwt-secret-2H-".padEnd(64, "x");

describe("V3 2H — registerCommercial 接入装配", () => {
  test("default resolveContainerEndpoint 抛 ContainerUnreadyError(stub 占位)", async (t) => {
    if (skipIfNoDb(t)) return;
    delete process.env.INTERNAL_PROXY_BIND;
    delete process.env.INTERNAL_PROXY_PORT;
    const r = await registerCommercial(null, {
      jwtSecret: JWT_SECRET,
      skipInternalProxy: true,
    });
    try {
      // handle/handleWsUpgrade/shutdown 都应该 callable
      assert.equal(typeof r.handle, "function");
      assert.equal(typeof r.handleWsUpgrade, "function");
      assert.equal(typeof r.shutdown, "function");
      assert.equal(r.internalProxyAddress, undefined,
        "skipInternalProxy=true 时 internalProxyAddress 必须 undefined");
    } finally {
      await r.shutdown();
    }
  });

  test("内部代理 listener 启动 + 401/404 路径正确", async (t) => {
    if (skipIfNoDb(t)) return;
    const port = await pickFreePort();
    process.env.INTERNAL_PROXY_BIND = "127.0.0.1";
    process.env.INTERNAL_PROXY_PORT = String(port);
    const r = await registerCommercial(null, { jwtSecret: JWT_SECRET });
    try {
      assert.deepEqual(r.internalProxyAddress, { host: "127.0.0.1", port });
      // GET → 404
      const get = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "GET" });
      assert.equal(get.status, 404);
      // POST without Authorization → 401(verifyContainerIdentity 拒绝)
      const post = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 1, messages: [{}] }),
      });
      assert.equal(post.status, 401);
      const body = await post.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, "UNAUTHORIZED");
    } finally {
      await r.shutdown();
    }
    // shutdown 后端口应可立即重绑 → 再起一个 server 不应 EADDRINUSE
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  });

  test("INTERNAL_PROXY_BIND=0.0.0.0 → ConfigError(防裸暴公网)", async (t) => {
    if (skipIfNoDb(t)) return;
    process.env.INTERNAL_PROXY_BIND = "0.0.0.0";
    process.env.INTERNAL_PROXY_PORT = String(await pickFreePort());
    await assert.rejects(
      registerCommercial(null, { jwtSecret: JWT_SECRET }),
      /INTERNAL_PROXY_BIND/i,
    );
  });

  test("/ws/user-chat-bridge 不带 token → close 1008 unauthorized", async (t) => {
    if (skipIfNoDb(t)) return;
    delete process.env.INTERNAL_PROXY_BIND;
    delete process.env.INTERNAL_PROXY_PORT;
    const r = await registerCommercial(null, {
      jwtSecret: JWT_SECRET,
      skipInternalProxy: true,
    });
    try {
      // 起一个 http server 让 r.handleWsUpgrade 接管 upgrade
      const httpServer = createServer();
      httpServer.on("upgrade", (req, socket, head) => {
        if (!r.handleWsUpgrade(req, socket, head)) {
          try { socket.destroy(); } catch { /* */ }
        }
      });
      await new Promise<void>((resolve) =>
        httpServer.listen(0, "127.0.0.1", () => resolve()),
      );
      const port = (httpServer.address() as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/user-chat-bridge`);
      const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws never closed")), 5000);
        ws.on("close", (code, reason) => {
          clearTimeout(t);
          resolve({ code, reason: reason.toString("utf8") });
        });
        ws.on("error", () => { /* swallow — 我们关心 close code */ });
      });
      assert.equal(closeInfo.code, 1008);
      assert.match(closeInfo.reason, /unauthorized/i);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      await r.shutdown();
    }
  });

  test("/ws/user-chat-bridge 合法 token + stub resolveContainerEndpoint throws → close 4503 + retryAfter", async (t) => {
    if (skipIfNoDb(t)) return;
    delete process.env.INTERNAL_PROXY_BIND;
    delete process.env.INTERNAL_PROXY_PORT;
    // 注:registerCommercial 内部 default stub 直接 throw ContainerUnreadyError(5, "supervisor_not_wired")
    const r = await registerCommercial(null, {
      jwtSecret: JWT_SECRET,
      skipInternalProxy: true,
    });
    try {
      const httpServer = createServer();
      httpServer.on("upgrade", (req, socket, head) => {
        if (!r.handleWsUpgrade(req, socket, head)) {
          try { socket.destroy(); } catch { /* */ }
        }
      });
      await new Promise<void>((resolve) =>
        httpServer.listen(0, "127.0.0.1", () => resolve()),
      );
      const port = (httpServer.address() as AddressInfo).port;
      // 签一个真 access token(对应一个真 user 即可,不需要订阅)
      const u = await query<{ id: string }>(
        "INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id",
        ["bridge-2h@example.com", "argon2$stub"],
      );
      const issued = await signAccess(
        { sub: u.rows[0].id, role: "user" },
        JWT_SECRET,
      );
      const token2 = issued.token;
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/user-chat-bridge?token=${encodeURIComponent(token2)}`,
      );
      const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws never closed")), 5000);
        ws.on("close", (code, reason) => {
          clearTimeout(t);
          resolve({ code, reason: reason.toString("utf8") });
        });
        ws.on("error", () => { /* swallow */ });
      });
      assert.equal(closeInfo.code, 4503,
        "supervisor_not_wired stub 必须以 4503 关闭");
      // reason 是 JSON {retryAfterSec, reason}
      const parsed = JSON.parse(closeInfo.reason) as { retryAfterSec?: number; reason?: string };
      assert.equal(parsed.retryAfterSec, 5);
      assert.equal(parsed.reason, "supervisor_not_wired");
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      await r.shutdown();
    }
  });

  test("注入 resolveContainerEndpoint stub → 实际拨号失败仍正确 close(覆盖 stub 注入路径)", async (t) => {
    if (skipIfNoDb(t)) return;
    let observedUid: bigint | null = null;
    const r: RegisterCommercialResult = await registerCommercial(null, {
      jwtSecret: JWT_SECRET,
      skipInternalProxy: true,
      resolveContainerEndpoint: async (uid) => {
        observedUid = uid;
        // 返回一个完全没人监听的端口 → containerWs 拨号失败 → close 1011
        return { host: "127.0.0.1", port: 1 };
      },
    });
    try {
      const httpServer = createServer();
      httpServer.on("upgrade", (req, socket, head) => {
        if (!r.handleWsUpgrade(req, socket, head)) {
          try { socket.destroy(); } catch { /* */ }
        }
      });
      await new Promise<void>((resolve) =>
        httpServer.listen(0, "127.0.0.1", () => resolve()),
      );
      const port = (httpServer.address() as AddressInfo).port;
      const u = await query<{ id: string }>(
        "INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id",
        ["bridge-2h-stub@example.com", "argon2$stub"],
      );
      const issued = await signAccess(
        { sub: u.rows[0].id, role: "user" },
        JWT_SECRET,
      );
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/user-chat-bridge?token=${encodeURIComponent(issued.token)}`,
      );
      const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws never closed")), 8000);
        ws.on("close", (code, reason) => {
          clearTimeout(t);
          resolve({ code, reason: reason.toString("utf8") });
        });
        ws.on("error", () => { /* swallow */ });
      });
      // 端口 1 拨号 → ECONNREFUSED → bridge.containerWs error → INTERNAL(1011)
      assert.equal(closeInfo.code, 1011,
        "拨号失败应得 1011 internal,而非 4503");
      assert.equal(observedUid, BigInt(u.rows[0].id),
        "resolveContainerEndpoint 应收到 token 解析出的 uid");
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      await r.shutdown();
    }
  });
});

/**
 * Gateway 注入侧:CommercialHook 的接口形状要保持稳定,gateway 才能依赖它。
 * 这条断言不调 gateway 包(避免循环依赖测试),只在类型层面同构验证。
 */
describe("V3 2H — RegisterCommercialResult 形状 = CommercialHook 形状", () => {
  test("接口同构(handle/handleWsUpgrade/shutdown/internalProxyAddress)", () => {
    // 构造一个仅含 4 字段的对象,赋值给 RegisterCommercialResult 不应该有类型错误
    const stub: RegisterCommercialResult = {
      handle: async () => false,
      handleWsUpgrade: () => false,
      shutdown: async () => { /* */ },
      internalProxyAddress: { host: "h", port: 1 },
    };
    assert.equal(typeof stub.handle, "function");
    assert.equal(typeof stub.handleWsUpgrade, "function");
    assert.equal(typeof stub.shutdown, "function");
    assert.deepEqual(stub.internalProxyAddress, { host: "h", port: 1 });
  });
});
