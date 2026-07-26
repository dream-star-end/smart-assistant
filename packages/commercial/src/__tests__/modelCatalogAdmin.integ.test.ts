/**
 * 集成:/api/admin/model-catalog 状态机端到端(方案 §7 步 5 的 admin 入口)。
 *
 * 覆盖(真 PG + 真 0143 trigger + 真 HTTP 路由):
 *   1. 权限门:无 JWT → 401;普通用户 → 403(读也按写档:requireAdminVerifyDb)
 *   2. GET:0143 回填行可见(state 与 model_pricing.enabled 等价)+ security_epoch
 *   3. POST 建 staged:语义校验拒(capability 超上限 / matchesRoute 不符)→ 422
 *   4. staged → activate 缺价格行 → 422(active 却无价 = 计费面拒服务)
 *   5. 补价格行 → activate → 200:state=active + **epoch bump** + model_pricing.enabled 镜像=true
 *   6. lock_version 不符 → 409(乐观并发)
 *   7. disable → 200:镜像=false + epoch bump;disabled → activate 再次放行(状态机允许)
 *   8. switch(fn_model_switch_version):新 entry active / 旧 entry retired / alias 跟随
 *   9. switch 的**前置**校验:能力超上限的新版本被拒(存储过程会把新行直接推到 active,
 *      所以校验必须发生在调用之前 —— 这条断言就是那个保证)
 *  10. admin_audit:四个 action 全部留痕(tx fail-closed 档)
 *
 * pg/redis 不可用 → skip。
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import IORedis from "ioredis";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);
// ModelCatalogCache.startListener() 走 loadConfig()(DATABASE_URL + 必填键全校验)——
// admin 写的"提交后同步激活快照"会经过它,故测试进程必须先把这几个键喂上,否则 500 的
// 是 config 而不是业务(与生产无关的假红)。
process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL ??= TEST_REDIS_URL;
process.env.JWT_SECRET ??= JWT_SECRET;
process.env.OC_MODEL_AUTHORITY = "1";

const { createPool, closePool, setPoolOverride, resetPool } = await import("../db/index.js");
const { setModelCatalogAdminPoolOverride, resetModelCatalogAdminPoolOverride } = await import(
  "../db/modelCatalogAdmin.js"
);
const { query } = await import("../db/queries.js");
const { runMigrations } = await import("../db/migrate.js");
const { signAccess } = await import("../auth/jwt.js");
const { createCommercialHandler } = await import("../http/router.js");
const { wrapIoredis } = await import("../middleware/rateLimit.js");
const { _resetModelCatalogRuntimeForTests, peekModelCatalogCache } = await import(
  "../billing/modelCatalogRuntime.js"
);
const { listAdminAudit } = await import("../admin/audit.js");
const { resetTestSchemaForTest } = await import("./helpers/db.js");
type Mailer = import("../auth/mail.js").Mailer;

let pgAvailable = false;
let redis: IORedis | null = null;
let server: Server | null = null;
let baseUrl = "";
let adminToken = "";
let userToken = "";

class NoopMailer implements Mailer {
  async send(): Promise<void> {
    /* drop */
  }
}

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try {
    await p.query("SELECT 1");
    await p.end();
    return true;
  } catch {
    try {
      await p.end();
    } catch {
      /* */
    }
    return false;
  }
}

before(async () => {
  pgAvailable = await probePg();
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  const pool = createPool({ connectionString: TEST_DB_URL, max: 10 });
  setPoolOverride(pool);
  setModelCatalogAdminPoolOverride(pool);
  // schema 级重置(helpers/db.ts):手工 COMMERCIAL_TABLES 清单会随新迁移漂移(0143 的
  // model_catalog/model_aliases/model_security_epoch 就是新增),漏一张就撞 already exists。
  await resetTestSchemaForTest();
  await runMigrations();
  await query(
    `INSERT INTO model_authority_deploy_state(key,value,description)
     VALUES ('cutover','{}'::jsonb,'test cutover')
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
  );
  _resetModelCatalogRuntimeForTests();

  redis = new IORedis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
  } catch {
    redis = null;
  }
  // fixture fail-closed:缺 Redis 时此前静默降级(整份套件的 HTTP 路径不装配),
  // 于是"绿"只证明了没跑。REQUIRE_TEST_DB/CI 下必须红 —— 2026-07-26 门禁审计。
  if (!redis && REQUIRE_TEST_DB) {
    throw new Error("Redis test fixture required (TEST_REDIS_URL) — refusing to silently degrade");
  }
  if (!redis) return;

  const handler = createCommercialHandler({
    jwtSecret: JWT_SECRET,
    mailer: new NoopMailer(),
    redis: wrapIoredis(redis),
    turnstileBypass: true,
    verifyEmailUrlBase: "https://test.local",
    resetPasswordUrlBase: "https://test.local",
    rateLimits: {
      register: { scope: "reg_mc", windowSeconds: 60, max: 100 },
      login: { scope: "login_mc", windowSeconds: 60, max: 100 },
      requestReset: { scope: "rr_mc", windowSeconds: 60, max: 100 },
    },
  });
  server = createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  const admin = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ('mc-admin@test.local','argon2$stub',0,'admin','active') RETURNING id::text AS id",
  );
  const user = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ('mc-user@test.local','argon2$stub',0,'user','active') RETURNING id::text AS id",
  );
  adminToken = (await signAccess({ sub: admin.rows[0]!.id, role: "admin" }, JWT_SECRET)).token;
  userToken = (await signAccess({ sub: user.rows[0]!.id, role: "user" }, JWT_SECRET)).token;
});

after(async () => {
  const cache = peekModelCatalogCache();
  if (cache) await cache.stopListener();
  _resetModelCatalogRuntimeForTests();
  if (server) {
    try {
      server.closeAllConnections();
    } catch {
      /* */
    }
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (redis) {
    try {
      await redis.flushdb();
    } catch {
      /* */
    }
    await redis.quit();
  }
  if (pgAvailable) {
    try {
      await resetTestSchemaForTest();
    } catch {
      /* */
    }
    resetModelCatalogAdminPoolOverride();
    await closePool();
  }
});

function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) {
    t.skip("pg/redis/server not available");
    return true;
  }
  return false;
}

type Json = Record<string, unknown>;
async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    /* 204/空体 */
  }
  return { status: res.status, json };
}

async function epoch(): Promise<bigint> {
  const r = await query<{ epoch: string }>(
    "SELECT epoch::text AS epoch FROM model_security_epoch WHERE id",
  );
  return BigInt(r.rows[0]!.epoch);
}
async function entryOf(modelId: string, state: string): Promise<{ id: string; lock: number } | null> {
  const r = await query<{ entry_id: string; lock_version: number }>(
    "SELECT entry_id::text AS entry_id, lock_version FROM model_catalog WHERE model_id=$1 AND state=$2 ORDER BY entry_id DESC LIMIT 1",
    [modelId, state],
  );
  const row = r.rows[0];
  return row ? { id: row.entry_id, lock: row.lock_version } : null;
}

// 新模型:deepseek 前缀 → matchesRoute 命中 deepseek(机制上限:无 effort 白名单、无 vision)。
const NEW_MODEL = "deepseek-integ";
const NEW_ENTRY = {
  model_id: NEW_MODEL,
  engine: "ccb",
  provider_id: "deepseek",
  upstream_model_id: "deepseek-chat",
  context_window: 200000,
  capability_profile: {
    supports_vision: false,
    reasoning: { supported: ["low", "high"], codex_model_default: null },
    ccb: { capability_zero: false, supports_thinking: true },
  },
};

describe("admin model-catalog — 权限门", () => {
  test("无 JWT → 401;普通用户 → 403(读写同档)", async (t) => {
    if (skipIfNoHttp(t)) return;
    assert.equal((await api("GET", "/api/admin/model-catalog")).status, 401);
    assert.equal((await api("GET", "/api/admin/model-catalog", { token: userToken })).status, 403);
    assert.equal(
      (await api("POST", "/api/admin/model-catalog", { token: userToken, body: NEW_ENTRY })).status,
      403,
    );
  });
});

describe("admin model-catalog — 状态机全路径", () => {
  test("GET 列表:0143 回填行可见 + epoch", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await api("GET", "/api/admin/model-catalog", { token: adminToken });
    assert.equal(r.status, 200);
    const entries = r.json.entries as Array<Json>;
    assert.ok(entries.length > 0, "0143 应从 model_pricing 回填 catalog");
    assert.ok(BigInt(r.json.security_epoch as string) >= 1n);
    // 回填不变量:state 与 model_pricing.enabled 等价
    const drift = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM model_pricing p
        WHERE p.enabled IS DISTINCT FROM EXISTS (
          SELECT 1 FROM model_catalog c WHERE c.model_id=p.model_id AND c.state='active')`,
    );
    assert.equal(drift.rows[0]!.n, "0");
  });

  test("建 staged:能力超上限 / matchesRoute 不符 → 422", async (t) => {
    if (skipIfNoHttp(t)) return;
    // ark(glm)机制上限 efforts=['high','max'] —— 声明 low 超限
    const overCeiling = await api("POST", "/api/admin/model-catalog", {
      token: adminToken,
      body: {
        ...NEW_ENTRY,
        model_id: "glm-5.2-x",
        provider_id: "ark",
        capability_profile: {
          supports_vision: false,
          reasoning: { supported: ["low"], codex_model_default: null },
          ccb: { capability_zero: true, supports_thinking: true },
        },
      },
    });
    assert.equal(overCeiling.status, 422);
    assert.match(JSON.stringify(overCeiling.json), /matchesRoute|beyond provider mechanism limit/);

    // provider 机制集之外(形态合法 → 过形状门,被语义门拦下)
    const bogus = await api("POST", "/api/admin/model-catalog", {
      token: adminToken,
      body: { ...NEW_ENTRY, provider_id: "bogus" },
    });
    assert.equal(bogus.status, 422);
    assert.match(JSON.stringify(bogus.json), /服务端机制集/);
  });

  test("建 staged(合法)→ 201;staged 不参与执行投影", async (t) => {
    if (skipIfNoHttp(t)) return;
    const before = await epoch();
    const r = await api("POST", "/api/admin/model-catalog", {
      token: adminToken,
      body: NEW_ENTRY,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.state, "staged");
    const staged = await entryOf(NEW_MODEL, "staged");
    assert.ok(staged, "staged 行应落库");
    // 新增 staged 行 = catalog 变更 → epoch bump(0143 把任何 catalog 写都当安全敏感)
    assert.ok((await epoch()) >= before);
    // executionRevision 只含 active 行 → staged 不进投影
    const snap = peekModelCatalogCache()?.peek();
    assert.ok(snap, "admin 写后本进程快照应已激活");
    assert.equal(snap!.resolve(NEW_MODEL), null);
  });

  test("activate 缺价格行 → 422", async (t) => {
    if (skipIfNoHttp(t)) return;
    const staged = (await entryOf(NEW_MODEL, "staged"))!;
    const r = await api("POST", `/api/admin/model-catalog/${staged.id}/activate`, {
      token: adminToken,
      body: { lock_version: staged.lock },
    });
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(r.json), /model_pricing 无/);
    assert.equal((await entryOf(NEW_MODEL, "staged"))!.id, staged.id, "拒绝后仍是 staged");
  });

  test("补价格行 → activate → active + epoch bump + enabled 镜像", async (t) => {
    if (skipIfNoHttp(t)) return;
    await query(
      `INSERT INTO model_pricing(model_id, display_name, input_per_mtok, output_per_mtok,
         cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, sort_order)
       VALUES ($1,'DeepSeek Integ',100,200,10,20,1.0,FALSE,10)
       ON CONFLICT (model_id) DO NOTHING`,
      [NEW_MODEL],
    );
    const staged = (await entryOf(NEW_MODEL, "staged"))!;
    const before = await epoch();
    const r = await api("POST", `/api/admin/model-catalog/${staged.id}/activate`, {
      token: adminToken,
      body: { lock_version: staged.lock },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const active = await entryOf(NEW_MODEL, "active");
    assert.ok(active);
    assert.ok((await epoch()) > before, "activate 是安全敏感写 → epoch 必 bump");
    const mirror = await query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id=$1",
      [NEW_MODEL],
    );
    assert.equal(mirror.rows[0]!.enabled, true, "catalog→pricing.enabled 镜像应同步");
    // 快照已同步激活(admin 写"提交后快照激活成功才返回 200")
    const snap = peekModelCatalogCache()!.peek()!;
    const desc = snap.resolve(NEW_MODEL);
    assert.ok(desc, "active 行应可解析出 execution descriptor");
    assert.equal(desc!.upstreamModelId, "deepseek-chat");
  });

  test("lock_version 不符 → 409(乐观并发)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const active = (await entryOf(NEW_MODEL, "active"))!;
    const r = await api("POST", `/api/admin/model-catalog/${active.id}/disable`, {
      token: adminToken,
      body: { lock_version: active.lock + 99 },
    });
    assert.equal(r.status, 409);
    assert.ok(await entryOf(NEW_MODEL, "active"), "409 后状态不变");
  });

  test("disable → 镜像 false + epoch bump;disabled → 再 activate 放行", async (t) => {
    if (skipIfNoHttp(t)) return;
    const active = (await entryOf(NEW_MODEL, "active"))!;
    const before = await epoch();
    const off = await api("POST", `/api/admin/model-catalog/${active.id}/disable`, {
      token: adminToken,
      body: { lock_version: active.lock },
    });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.ok((await epoch()) > before);
    const mirror = await query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id=$1",
      [NEW_MODEL],
    );
    assert.equal(mirror.rows[0]!.enabled, false);

    const disabled = (await entryOf(NEW_MODEL, "disabled"))!;
    const on = await api("POST", `/api/admin/model-catalog/${disabled.id}/activate`, {
      token: adminToken,
      body: { lock_version: disabled.lock },
    });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.ok(await entryOf(NEW_MODEL, "active"));
  });

  test("switch:新版本 active / 旧版本 retired(单事务存储过程)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const oldActive = (await entryOf(NEW_MODEL, "active"))!;
    const r = await api("POST", "/api/admin/model-catalog/switch", {
      token: adminToken,
      body: {
        ...NEW_ENTRY,
        upstream_model_id: "deepseek-reasoner",
        context_window: 128000,
        lock_version: oldActive.lock,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const newId = r.json.entry_id as string;
    assert.notEqual(newId, oldActive.id);
    const states = await query<{ entry_id: string; state: string }>(
      "SELECT entry_id::text AS entry_id, state FROM model_catalog WHERE model_id=$1 ORDER BY entry_id",
      [NEW_MODEL],
    );
    const byId = new Map(states.rows.map((x) => [x.entry_id, x.state]));
    assert.equal(byId.get(oldActive.id), "retired", "旧版本单向退休");
    assert.equal(byId.get(newId), "active", "新版本接管(旧行原本 active)");
    const snap = peekModelCatalogCache()!.peek()!;
    assert.equal(
      snap.resolve(NEW_MODEL)!.upstreamModelId,
      "deepseek-reasoner",
    );
  });

  test("switch 的前置校验:能力超上限的新版本被拒(存储过程会直接推到 active)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const active = (await entryOf(NEW_MODEL, "active"))!;
    const r = await api("POST", "/api/admin/model-catalog/switch", {
      token: adminToken,
      body: {
        ...NEW_ENTRY,
        provider_id: "deepseek",
        capability_profile: {
          // deepseek 机制上限 supportsVision=false —— 声明 vision 必拒
          supports_vision: true,
          reasoning: { supported: ["low"], codex_model_default: null },
          ccb: { capability_zero: false, supports_thinking: true },
        },
        lock_version: active.lock,
      },
    });
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(r.json), /vision but provider mechanism is text-only/);
    const still = await entryOf(NEW_MODEL, "active");
    assert.equal(still!.id, active.id, "拒绝后不得产生新版本");
  });

  test("同 model 已有 live 行 → 建 staged 被 DB 唯一索引拒(409,不是 500)", async (t) => {
    if (skipIfNoHttp(t)) return;
    const r = await api("POST", "/api/admin/model-catalog", {
      token: adminToken,
      body: NEW_ENTRY, // 此时该 model 已有 active 行
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json), /live (?:行|version)/);
  });

  test("admin_audit:stage/activate/disable/switch 全部留痕", async (t) => {
    if (skipIfNoHttp(t)) return;
    const audit = await listAdminAudit({ limit: 100 });
    const actions = new Set(audit.rows.map((r) => r.action));
    for (const a of [
      "model_catalog.stage",
      "model_catalog.activate",
      "model_catalog.disable",
      "model_catalog.switch",
    ]) {
      assert.ok(actions.has(a), `admin_audit 缺 ${a}`);
    }
  });
});
