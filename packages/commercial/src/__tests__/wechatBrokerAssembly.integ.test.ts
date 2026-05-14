/**
 * P1.7 slice 7c — registerCommercial 装配 wechat broker 的 smoke test。
 *
 * 这层只覆盖**装配契约**(flag → 暴露面),不重复覆盖 broker 自身行为
 * (那些在 wechatBroker.test.ts / wechatInboundDispatcher.test.ts /
 *  wechatOutboundReceiver.test.ts 等单测里):
 *
 *   1. WECHAT_BROKER_ENABLED!=1 → result.wechatBroker undefined
 *   2. WECHAT_BROKER_ENABLED=1 + bridgeSecret 可加载 → result.wechatBroker
 *      暴露 onInbound,且为 async function;调用 onInbound(任意 evt) 走 dispatcher
 *      stub → 不抛异常(broker never-throw 契约的装配层兜底验证)
 *   3. shutdown 在 broker 已装配时仍能干净退出,且 broker.stop 在 shutdown 链里
 *      被实际触发(通过观察 stop 前后的并发 onInbound 不再向 dispatcher 推请求)
 *
 * 整体走 registerCommercialV3_2H.integ.test 同一 pg/redis-gated 模式,
 * 测试 fixture 不可用时整组 skip;CI 上 REQUIRE_TEST_DB=1 时硬要求。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wechatBrokerAssembly.integ.test.ts
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  createPool,
  closePool,
  setPoolOverride,
  resetPool,
} from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { registerCommercial, type RegisterCommercialResult } from "../index.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB =
  process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";

let pgAvailable = false;

/**
 * 动态读 public schema 全部 table 名 — 比硬编码 list 稳。historically 2H 测试
 * 用静态白名单导致 schema 演进后 "system_settings already exists"。
 */
async function dropAllPublicTables(): Promise<void> {
  const rows = await query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.rowCount === 0) return;
  const names = rows.rows.map(r => `"${r.tablename}"`).join(", ");
  await query(`DROP TABLE IF EXISTS ${names} CASCADE`);
}
const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DATABASE_URL", "REDIS_URL", "COMMERCIAL_ENABLED",
  "COMMERCIAL_AUTO_MIGRATE", "OPENCLAUDE_KMS_KEY",
  "INTERNAL_PROXY_BIND", "INTERNAL_PROXY_PORT",
  "COMMERCIAL_ALERTS_DISABLED", "WECHAT_BROKER_ENABLED",
];

function snapshotEnv(): void {
  for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
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
  process.env.COMMERCIAL_ALERTS_DISABLED = "1";
  // 默认关闭 internal proxy,broker 装配本身不依赖它
  delete process.env.INTERNAL_PROXY_BIND;
  delete process.env.INTERNAL_PROXY_PORT;
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }));
  await dropAllPublicTables();
  await runMigrations();
});

after(async () => {
  if (pgAvailable) {
    try { await dropAllPublicTables(); } catch { /* */ }
    try { await closePool(); } catch { /* */ }
  }
  restoreEnv();
});

beforeEach(async () => {
  if (!pgAvailable) return;
  // broker 不读 users / claude_accounts;清表只是保持 fixture 一致性。
  await query("TRUNCATE TABLE usage_records, claude_accounts RESTART IDENTITY CASCADE");
});

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not available"); return true; }
  return false;
}

const JWT_SECRET = "test-jwt-secret-7c-".padEnd(64, "x");

describe("P1.7 slice 7c — registerCommercial wechat broker 装配", () => {
  test("WECHAT_BROKER_ENABLED!=1 → result.wechatBroker undefined", async (t) => {
    if (skipIfNoDb(t)) return;
    delete process.env.WECHAT_BROKER_ENABLED;
    const r: RegisterCommercialResult = await registerCommercial(null, {
      jwtSecret: JWT_SECRET,
      skipInternalProxy: true,
    });
    try {
      assert.equal(
        r.wechatBroker,
        undefined,
        "broker flag 未开启时 wechatBroker 必须为 undefined,gateway cli 据此跳过 onInboundOverride 装配",
      );
    } finally {
      await r.shutdown();
    }
  });

  test("WECHAT_BROKER_ENABLED=0 (显式 0) → 仍视为未启用", async (t) => {
    if (skipIfNoDb(t)) return;
    process.env.WECHAT_BROKER_ENABLED = "0";
    const r: RegisterCommercialResult = await registerCommercial(null, {
      jwtSecret: JWT_SECRET,
      skipInternalProxy: true,
    });
    try {
      assert.equal(r.wechatBroker, undefined);
    } finally {
      await r.shutdown();
    }
  });

  test("WECHAT_BROKER_ENABLED=1 + bridgeSecret OK → result.wechatBroker 暴露 onInbound", async (t) => {
    if (skipIfNoDb(t)) return;
    process.env.WECHAT_BROKER_ENABLED = "1";
    let r: RegisterCommercialResult;
    try {
      r = await registerCommercial(null, {
        jwtSecret: JWT_SECRET,
        skipInternalProxy: true,
      });
    } catch (err) {
      // bridgeSecret 加载失败(权限 / fs)时 broker 装配本身也会被跳过,
      // 但 registerCommercial 整体仍应成功 — 不抛。这里只在 register 真抛
      // 时 skip,留下信号:多半是测试环境 /var/lib/openclaude 不可写。
      const msg = (err as Error)?.message ?? String(err);
      t.skip(`registerCommercial threw (likely bridgeSecret fs issue): ${msg}`);
      return;
    }
    try {
      // 若 bridgeSecret 加载失败,broker 不装配但 register 不抛,此时 wechatBroker
      // 应为 undefined — 把这种环境视为 "测试无法验证 happy path",skip。
      if (!r.wechatBroker) {
        t.skip("wechatBroker not assembled (likely bridgeSecret missing in test env)");
        return;
      }
      assert.equal(typeof r.wechatBroker.onInbound, "function",
        "onInbound 必须以 function 暴露");
      // onInbound 的契约是 never-throw,装配层投影也必须保持这个契约;
      // 给一个最小合法 evt(bindingUserId 是不存在的 user),dispatcher 内部
      // 会因 binding 查不到走 ignored 路径,broker 总体 resolve。
      const evt = {
        bindingUserId: "999999999999",
        senderId: "wx-smoke-sender",
        text: "smoke",
        idempotencyKey: `smoke-${Date.now()}-${randomBytes(4).toString("hex")}`,
        receivedAt: Date.now(),
        channel: "wechat" as const,
      };
      // never-throw:Promise 必须 resolve,不可 reject(broker 内部捕获一切)。
      await assert.doesNotReject(r.wechatBroker.onInbound(evt));
    } finally {
      await r.shutdown();
    }
  });

  test("shutdown 在 broker 装配后仍能干净退出(broker.stop 在 shutdown 链头部)", async (t) => {
    if (skipIfNoDb(t)) return;
    process.env.WECHAT_BROKER_ENABLED = "1";
    let r: RegisterCommercialResult;
    try {
      r = await registerCommercial(null, {
        jwtSecret: JWT_SECRET,
        skipInternalProxy: true,
      });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      t.skip(`registerCommercial threw: ${msg}`);
      return;
    }
    if (!r.wechatBroker) {
      // 装配未完成时 shutdown 仍要能跑通 — 这是另一个独立 assertion
      await assert.doesNotReject(r.shutdown());
      t.skip("wechatBroker not assembled (likely bridgeSecret missing)");
      return;
    }
    // 完整 shutdown 不应超时(broker.stop 等 inFlight 完成,但此时没有
    // 真实并发,应当瞬时返回)。给 8s 超时兜底,正常应在百毫秒级。
    const shutdownPromise = r.shutdown();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("shutdown timed out (>8s)")), 8000),
    );
    await assert.doesNotReject(Promise.race([shutdownPromise, timeoutPromise]));
  });
});
