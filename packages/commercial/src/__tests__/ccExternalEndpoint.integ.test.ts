/**
 * V3 CC 外接 plan Phase 3 — public-facing endpoint integ test
 * (`POST /api/anthropic/v1/messages`)
 *
 * 跑法: npx tsx --test src/__tests__/ccExternalEndpoint.integ.test.ts
 *
 * 与 anthropicProxy.integ.test.ts 区别:
 *   - 入口走 `createCommercialHandler`(不是直接调 makeAnthropicProxyHandler),
 *     这样才能锁住 Phase 3 新加的 router adapter(maintenance gate / 503 degraded /
 *     path 精确匹配 / url 重写 / 合成 ctx)行为不变量。
 *   - IdentityStrategy 是 `makeApiKeyIdentityStrategy`(不是 container 双因子),
 *     token 形态 `oc-cc.<8b36>.<48hex>`,authz 失败码 / containerId=null 路径都进端到端测。
 *   - hostUuid / boundIp 是 sentinel `"external-api-key"`(plan §3.2 Codex MINOR 2):
 *     测试只验语义不验值,handler/strategy 都不应消费这两个字段做安全判断。
 *
 * 覆盖的不变量(plan §4 + Phase 3 plan-review):
 *   1. Happy path        — token 合法 + model 已授权 → 200 + journal/usage_records 写入 +
 *                          container_id IS NULL(plan §5 决策)+ touchLastUsed 调用一次
 *   2. Path leak 防线    — typo path / wrong method → 404,既不进 proxy 也不串到其它 handler
 *   3. Auth failure      — missing / bad-format / invalid prefix → 401,
 *                          pgPool 不写 journal,preCheck 不 reserve,touchLastUsed 不调
 *   4. Authz failure     — token 合法但 model 未在 grants → 403 NOT_AUTHORIZED,
 *                          preCheck 不 reserve(fail-closed,无 release 复杂度)
 *   5. Maintenance gate  — system_settings.maintenance_mode=true + 非 admin →
 *                          503 MAINTENANCE,不进 proxy(adapter 在 maintenance gate 之后)
 *   6. JWT-vs-API-key    — 客户端发普通 v3 JWT(非 oc-cc.*)→ 401 BAD_API_KEY_FORMAT,
 *                          确认 ApiKeyIdentityStrategy 不被 JWT bearer 误触发
 *   7. 503 degraded      — externalApiKeyProxy 未注入 → 503 EXTERNAL_PROXY_UNAVAILABLE
 *                          (Codex Phase 3 plan-review MINOR 1:部署故障 ≠ 404)
 *   8. last_used throttle — 同一 key 5 min 内连续 N 次请求 → repo.touchLastUsed 只调一次
 *                          (closure-scope LRU 节流 wired 端到端)
 *
 * 测试策略:
 *   - 不依赖真实 PG / Redis;fakePool 走 explicit SQL allowlist(未知 SQL 直接抛,防"未来代码
 *     悄悄引入新 query 走 happy fallthrough"伪通过)。
 *   - upstream fetch 也 mock,跑完整 SSE chunk(input/output usage)走完 happy 计费路径。
 *   - 每个 test afterEach 都 `resetPool()` + `_clearMaintenanceCache()` 防泄漏到下一个。
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  makeAnthropicProxyHandler,
  type AnthropicProxyHandler,
} from "../http/anthropicProxy.js";
import { makeApiKeyIdentityStrategy } from "../auth/apiKeyIdentity.js";
import type {
  ApiKeyRepo,
  ApiKeyRow,
  ApiKeySummary,
  CreatedApiKey,
} from "../auth/apiKeyRepo.js";
import { createCommercialHandler } from "../http/router.js";
import type { CommercialHttpDeps } from "../http/handlers.js";
import type { AccountScheduler, PickResult, ReleaseInput } from "../account-pool/scheduler.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { RateLimitRedis } from "../middleware/rateLimit.js";
import type { PricingCache, ModelPricing } from "../billing/pricing.js";
import { createLogger } from "../logging/logger.js";
import { setPoolOverride, resetPool } from "../db/index.js";
import { _clearMaintenanceCache } from "../middleware/maintenanceMode.js";
import type { Pool } from "pg";

// ─── 固定常量 ───────────────────────────────────────────────────────────────

const FIXED_USER_ID = 7n;
const FIXED_API_KEY_ID = 42n;
const FIXED_PREFIX = "abcd1234";          // 8 chars [0-9a-z]
const FIXED_SECRET = "deadbeef".repeat(6); // 48 hex chars
const FIXED_TOKEN = `oc-cc.${FIXED_PREFIX}.${FIXED_SECRET}`;
const FIXED_MODEL = "claude-sonnet-4-6";
const FIXED_ACCOUNT_ID = 1001n;
const FIXED_PINNED_USER_ID = createHash("sha256")
  .update("test-pinned-account-cc-external")
  .digest("hex");
const FIXED_JWT_SECRET = "test-jwt-secret-not-actually-used-cc-external";

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

// ─── SSE upstream mock(同 anthropicProxy.integ.test 简化版) ───────────────

function makeFullSseChunks(opts: { inputTok?: number; outputTok?: number } = {}): string[] {
  const inputTok = opts.inputTok ?? 100;
  const outputTok = opts.outputTok ?? 50;
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        usage: {
          input_tokens: inputTok,
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
        input_tokens: inputTok,
        output_tokens: outputTok,
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

// ─── fakePool(SQL allowlist)──────────────────────────────────────────────
//
// 与 anthropicProxy.integ.test.ts 同一思路:explicit allowlist,未知 SQL 抛错。
// 多挂一个 `SELECT value, description, updated_at, updated_by` 因为 maintenance
// 闸门会走 `getSystemSetting("maintenance_mode")`。

interface FakePoolOverride {
  userCredits?: bigint;
  maintenanceMode?: boolean;
}

function buildFakePool(override: FakePoolOverride = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];

  const handle = (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    const trimmed = sql.trim();
    const head = trimmed.slice(0, 64).toUpperCase();

    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (head.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };

    // system_settings → maintenance gate 读这里
    if (head.startsWith("SELECT VALUE, DESCRIPTION, UPDATED_AT")) {
      // 模拟 row 存在时按 override 返;不存在时 rows=[] 让 getSystemSetting 走 DEFAULTS(false)
      if (override.maintenanceMode === true) {
        return {
          rows: [{
            value: true,
            description: null,
            updated_at: new Date("2026-05-18T00:00:00Z"),
            updated_by: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    if (head.startsWith("INSERT INTO REQUEST_FINALIZE_JOURNAL")) {
      return { rows: [], rowCount: 1 };
    }
    if (head.startsWith("UPDATE REQUEST_FINALIZE_JOURNAL")) {
      return { rows: [], rowCount: 1 };
    }
    if (head.startsWith("INSERT INTO USAGE_RECORDS")) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    if (head.startsWith("SELECT CREDITS")) {
      const c = override.userCredits ?? 99_999_999n;
      return { rows: [{ credits: c.toString() }], rowCount: 1 };
    }
    if (head.startsWith("UPDATE USERS SET CREDITS")) {
      return { rows: [], rowCount: 1 };
    }
    if (head.startsWith("INSERT INTO CREDIT_LEDGER")) {
      return { rows: [{ id: "101" }], rowCount: 1 };
    }
    if (head.startsWith("UPDATE USAGE_RECORDS SET LEDGER_ID")) {
      return { rows: [], rowCount: 1 };
    }
    if (head.startsWith("UPDATE CLAUDE_ACCOUNTS SET")) {
      return { rows: [], rowCount: 1 };
    }
    // user_api_keys.touchLastUsed
    if (head.startsWith("UPDATE USER_API_KEYS SET LAST_USED_AT")) {
      return { rows: [], rowCount: 1 };
    }
    // user_api_keys.findByPrefix — fakeApiKeyRepo 自己 mock,不会落到这条
    // user_api_keys.list / revoke 同理

    throw new Error(`unknown SQL in fakePool: ${trimmed.slice(0, 120)}`);
  };

  const fakeClient = {
    async query(sql: string, params: unknown[] = []) {
      return handle(sql, params);
    },
    release: () => {},
  };

  const pool = {
    queries,
    async query(sql: string, params: unknown[] = []) {
      return handle(sql, params);
    },
    async connect() {
      return fakeClient;
    },
    async end() { /* noop */ },
  };
  return pool;
}

// ─── 其它 fake deps ─────────────────────────────────────────────────────────

interface PreCheckSpy {
  redis: PreCheckRedis;
  reserveCalls: Array<{ userId: string; requestId: string; maxCost: string }>;
  releaseCalls: Array<{ userId: string; requestId: string }>;
}

function buildFakePreCheckRedis(): PreCheckSpy {
  const reserveCalls: PreCheckSpy["reserveCalls"] = [];
  const releaseCalls: PreCheckSpy["releaseCalls"] = [];
  const redis: PreCheckRedis = {
    async atomicReserve(input) {
      reserveCalls.push({
        userId: String(input.userId),
        requestId: input.requestId,
        maxCost: input.maxCost.toString(),
      });
      return { ok: true, locked: BigInt(input.maxCost), needed: BigInt(input.maxCost) };
    },
    async releaseReservation(input) {
      releaseCalls.push({
        userId: String(input.userId),
        requestId: input.requestId,
      });
      return true;
    },
  };
  return { redis, reserveCalls, releaseCalls };
}

function buildFakeRateLimitRedis(): RateLimitRedis {
  let counter = 0;
  return {
    async incr() { counter++; return counter; },
    async expire() { return 1; },
  };
}

interface SchedulerSpy {
  scheduler: AccountScheduler;
  pickCalls: number;
  releaseCalls: ReleaseInput[];
}

function buildFakeScheduler(): SchedulerSpy {
  let pickCalls = 0;
  const releaseCalls: ReleaseInput[] = [];
  const scheduler = {
    async pick(): Promise<PickResult> {
      pickCalls++;
      return {
        account_id: FIXED_ACCOUNT_ID,
        plan: "pro",
        token: Buffer.from("FAKE-TOKEN-VALUE"),
        refresh: null,
        expires_at: null,
        egress_proxy: null,
        egress_target: null,
        pinned_user_id: FIXED_PINNED_USER_ID,
      };
    },
    async release(input: ReleaseInput): Promise<void> {
      releaseCalls.push(input);
    },
  } as unknown as AccountScheduler;
  return {
    scheduler,
    get pickCalls() { return pickCalls; },
    releaseCalls,
  };
}

function buildFakePricing(models: ModelPricing[] = [FIXED_PRICING]): PricingCache {
  const m = new Map(models.map((p) => [p.model_id, p]));
  return {
    get(id: string) { return m.get(id) ?? null; },
  } as unknown as PricingCache;
}

// ─── fake ApiKeyRepo(spy)──────────────────────────────────────────────────

interface ApiKeyRepoSpy {
  repo: ApiKeyRepo;
  findByPrefixCalls: string[];
  touchLastUsedCalls: bigint[];
  setRow(r: ApiKeyRow | null): void;
}

function hashSecretBytes(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

function makeDefaultRow(): ApiKeyRow {
  return {
    id: FIXED_API_KEY_ID,
    userId: FIXED_USER_ID,
    label: "cc-cli-laptop",
    keyPrefix: FIXED_PREFIX,
    keyHash: hashSecretBytes(FIXED_SECRET),
    createdAt: new Date("2026-05-18T00:00:00Z"),
    lastUsedAt: null,
  };
}

function buildApiKeyRepoSpy(initialRow: ApiKeyRow | null = makeDefaultRow()): ApiKeyRepoSpy {
  let row = initialRow;
  const findByPrefixCalls: string[] = [];
  const touchLastUsedCalls: bigint[] = [];
  const repo: ApiKeyRepo = {
    async create(): Promise<CreatedApiKey> {
      throw new Error("not used in integ test");
    },
    async findByPrefix(prefix: string): Promise<ApiKeyRow | null> {
      findByPrefixCalls.push(prefix);
      return row;
    },
    async list(): Promise<ApiKeySummary[]> { return []; },
    async revoke(): Promise<boolean> { return false; },
    async touchLastUsed(id: bigint): Promise<void> {
      touchLastUsedCalls.push(id);
    },
  };
  return {
    repo,
    findByPrefixCalls,
    touchLastUsedCalls,
    setRow(r) { row = r; },
  };
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
    this.url = opts.url ?? "/api/anthropic/v1/messages";
    this.method = opts.method ?? "POST";
    this.headers = {
      host: "x.invalid",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      // CC 外接 UA gate(2026-05-19,plan §3.5):integ test 默认走真实 CC CLI
      // UA 形态;UA 不对的负例显式在 headers 里覆盖。
      "user-agent": "claude-cli/2.1.888 (external, cli)",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) {
      const buf = Buffer.from(
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      );
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

interface HarnessOpts {
  poolOverride?: FakePoolOverride;
  /** 完全不注入 externalApiKeyProxy(测试 503 EXTERNAL_PROXY_UNAVAILABLE)。 */
  omitExternalProxy?: boolean;
  /** 覆盖 user authz(默认:user role + 已授权 FIXED_MODEL)。 */
  authz?: { role: "user" | "admin"; grantedModelIds: ReadonlySet<string> };
  /**
   * 覆盖 FIXED_PRICING 的局部字段(测试 visibility=admin/hidden 的 authz 拒绝路径)。
   * 默认 visibility=public → canUseModel 直接 true,与 grants 无关,无法测 authz 拒绝。
   */
  pricingOverride?: Partial<ModelPricing>;
  /** strategy.now()(节流测试用)。 */
  now?: () => number;
  /** 注入 fetch (默认:happy SSE)。 */
  fetchImpl?: typeof fetch;
}

function buildHarness(opts: HarnessOpts = {}) {
  const pool = buildFakePool(opts.poolOverride);
  setPoolOverride(pool as unknown as Pool);

  const preCheckSpy = buildFakePreCheckRedis();
  const rateLimitRedis = buildFakeRateLimitRedis();
  const schedulerSpy = buildFakeScheduler();
  const effectivePricing: ModelPricing = opts.pricingOverride
    ? { ...FIXED_PRICING, ...opts.pricingOverride }
    : FIXED_PRICING;
  const pricing = buildFakePricing([effectivePricing]);
  const apiKeyRepoSpy = buildApiKeyRepoSpy();

  // logger sink:每条 JSON line parse 后存 logEvents,让测试可断言 log msg/code。
  const logEvents: Array<Record<string, unknown>> = [];
  const testLogger = createLogger({
    level: "trace",
    base: { test: "ccExternalEndpoint.integ" },
    out: (line: string) => {
      try { logEvents.push(JSON.parse(line) as Record<string, unknown>); }
      catch { /* skip */ }
    },
  });

  // Phase 6 admin-only rollout(plan §3.4):默认 authz role=admin —— Layer 2
  // strategy 内 admin gate 会 reject 非 admin 即使 secret 验对了。既有 happy
  // 用例(token 合法 + model 已授权 → 200)默认 admin 即可保持绿,**单独**
  // Phase 6 负面用例显式 opts.authz={role:"user"} 触发 401。
  const apiKeyStrategy = makeApiKeyIdentityStrategy({
    repo: apiKeyRepoSpy.repo,
    pricing,
    loadUserModelAuthz: async () => opts.authz ?? {
      role: "admin",
      grantedModelIds: new Set<string>([FIXED_MODEL]),
    },
    now: opts.now,
  });

  const externalApiKeyProxy: AnthropicProxyHandler | undefined = opts.omitExternalProxy
    ? undefined
    : makeAnthropicProxyHandler({
        pgPool: pool as unknown as Pool,
        pricing,
        preCheckRedis: preCheckSpy.redis,
        scheduler: schedulerSpy.scheduler,
        identity: apiKeyStrategy,
        rateLimitRedis,
        fetchImpl: opts.fetchImpl ?? (async () => sseResponse(200, makeFullSseChunks())),
        upstreamEndpoint: "https://upstream.test/v1/messages",
        logger: testLogger,
        // 无 broadcast / appendCostCredits 注入,handler 内部 ?. fail-soft
      });

  // 极简 CommercialHttpDeps — 只装与 Phase 3 adapter 相关的字段。其它都标 undefined,
  // router 内部走"该 endpoint 未配 → 503"或 fall-through 兜底,与 production
  // 真实路径一致(任何"deps 没填齐"的回退都是显式的)。
  const deps: CommercialHttpDeps = {
    jwtSecret: FIXED_JWT_SECRET,
    mailer: { sendTemplate: async () => {} } as unknown as CommercialHttpDeps["mailer"],
    redis: rateLimitRedis,
    pricing,
    preCheckRedis: preCheckSpy.redis,
    externalApiKeyProxy,
  };

  const handler = createCommercialHandler(deps, { logger: testLogger });

  async function run(opts2: MockReqOpts = {}): Promise<MockRes> {
    const req = new MockReq({
      headers: { authorization: `Bearer ${FIXED_TOKEN}` },
      body: minBody(),
      ...opts2,
      // headers shallow-merge:caller 给的 headers 与 auth 合并
      ...(opts2.headers
        ? { headers: { authorization: `Bearer ${FIXED_TOKEN}`, ...opts2.headers } }
        : {}),
    });
    const res = new MockRes();
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return res;
  }

  return {
    deps,
    handler,
    run,
    pool,
    preCheckSpy,
    schedulerSpy,
    apiKeyRepoSpy,
    logEvents,
  };
}

// 最小可用 body —— 默认 model 在 grants 里 + max_tokens 极小 + stream=true。
function minBody(modelOverride?: string): Record<string, unknown> {
  return {
    model: modelOverride ?? FIXED_MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

function readErrCode(res: MockRes): string | undefined {
  const j = res.bodyJson() as { error?: { code?: string } };
  return j.error?.code;
}

// 每个 test 之间清理:pool override + maintenance cache。前者直接泄漏会导致下一个
// test setPoolOverride throw `pool already initialized`;后者会让"上一个 test 设过
// maintenance=true 60s 内污染所有后续 test"。
beforeEach(() => {
  _clearMaintenanceCache();
});
afterEach(async () => {
  await resetPool();
  _clearMaintenanceCache();
});

// ════════════════════════════════════════════════════════════════════════════
// (1) Happy path
// ════════════════════════════════════════════════════════════════════════════

describe("happy path — 合法 token + 已授权 model → 200 + container_id IS NULL", () => {
  test("end-to-end 200 + journal/usage_records 写入 + container_id 透传 NULL + touchLastUsed 1 次", async () => {
    const h = buildHarness();
    const res = await h.run();
    // proxy 透传上游 200(SSE)
    assert.equal(res.statusCode, 200, `status=${res.statusCode}; body=${res.bodyText()}`);

    // findByPrefix 被查了 1 次,prefix 是 FIXED_PREFIX
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 1);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls[0], FIXED_PREFIX);

    // touchLastUsed 是 fire-and-forget,需 yield microtask
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 1);
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls[0], FIXED_API_KEY_ID);

    // preCheck.atomicReserve 调了一次,userId = FIXED_USER_ID
    assert.equal(h.preCheckSpy.reserveCalls.length, 1);
    assert.equal(h.preCheckSpy.reserveCalls[0]!.userId, String(FIXED_USER_ID));

    // scheduler.pick 也被调了一次
    assert.equal(h.schedulerSpy.pickCalls, 1);

    // 至少有一条 INSERT INTO request_finalize_journal 落 fakePool
    const journalInserts = h.pool.queries.filter((q) =>
      q.sql.trim().toUpperCase().startsWith("INSERT INTO REQUEST_FINALIZE_JOURNAL"),
    );
    assert.equal(journalInserts.length, 1, "journal 插入 1 次");
    // container_id 入参必须是 null(plan §5 决策:ApiKey 路径不串容器维度)
    const journalParams = journalInserts[0]!.params;
    // params 顺序见 anthropicProxy.ts startInflightJournal —— container_id 位置必为 null
    const hasNullContainer = journalParams.some((p) => p === null);
    assert.ok(hasNullContainer, `journal params 必须含 NULL(container_id);got=${JSON.stringify(journalParams)}`);
  });

  // Codex Phase 3 code-review MINOR 锁:router pre-route adapter 在 dispatch 前
  // 已把 ensureRequestId 生成的 id 写回 req.headers,proxy handler 内部 ensureRequestId
  // 会复用同一个 id,响应头 x-request-id 与 router log 中的 requestId 必须一致。
  // 入站不带 x-request-id 是真实公网请求的常态,这条 test 防止 fix regress。
  test("入站无 x-request-id 时,router 与 proxy 共用同一 requestId(response 头反映)", async () => {
    const h = buildHarness();
    const res = await h.run(); // 默认 headers 不含 x-request-id
    assert.equal(res.statusCode, 200);
    const rid = res.responseHeaders["x-request-id"];
    assert.equal(typeof rid, "string", "response 必带 x-request-id");
    // 32 hex chars = ensureRequestId 默认格式;客户端没传时 router 生成、proxy 复用
    assert.match(rid as string, /^[0-9a-f]{32}$/, "格式 = 32 hex chars(randomBytes 16)");
  });

  test("入站带 x-request-id 时,router/proxy 都透传同一 id", async () => {
    const h = buildHarness();
    const passedId = "test-rid-abc123_XYZ-789";
    const res = await h.run({ headers: { "x-request-id": passedId } });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.responseHeaders["x-request-id"],
      passedId,
      "客户端传的 request id 必须透传",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (2) Path leak prevention
// ════════════════════════════════════════════════════════════════════════════

describe("path leak 防线 — typo path / wrong method 不应进 proxy", () => {
  test("POST /api/anthropic/v1/foo(typo)→ 404,不进 proxy(strategy 不被调用)", async () => {
    const h = buildHarness();
    const res = await h.run({ url: "/api/anthropic/v1/foo" });
    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.bodyText()}`);
    // 关键:strategy / preCheck / scheduler 都没被触碰
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls, 0);
  });

  test("GET /api/anthropic/v1/messages(wrong method)→ 404,不进 proxy", async () => {
    const h = buildHarness();
    const res = await h.run({ method: "GET", body: undefined });
    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.bodyText()}`);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
  });

  test("OPTIONS /api/anthropic/v1/messages(wrong method)→ 404,不进 proxy", async () => {
    const h = buildHarness();
    const res = await h.run({ method: "OPTIONS", body: undefined });
    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.bodyText()}`);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0);
  });

  // Codex Phase 3 code-review 建议:exact-match 的 trailing-slash 边缘锁死。
  // 路径 `/api/anthropic/v1/messages/` 不应 normalize 到无尾斜杠形式去命中精确路由。
  test("POST /api/anthropic/v1/messages/(尾斜杠)→ 404,不进 proxy", async () => {
    const h = buildHarness();
    const res = await h.run({ url: "/api/anthropic/v1/messages/" });
    assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.bodyText()}`);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (3) Auth failure no side-effects
// ════════════════════════════════════════════════════════════════════════════

describe("auth failure — invalid token 不应留下任何账务副作用", () => {
  test("missing Authorization 头 → 401,无 DB/preCheck 副作用", async () => {
    const h = buildHarness();
    // 显式 headers 不带 authorization
    const req = new MockReq({ body: minBody(), headers: {} });
    const res = new MockRes();
    await h.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 401);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0, "无 token 不查 DB");
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls, 0);
    // pgPool 也不能写 journal
    const journalInserts = h.pool.queries.filter((q) =>
      q.sql.trim().toUpperCase().startsWith("INSERT INTO REQUEST_FINALIZE_JOURNAL"),
    );
    assert.equal(journalInserts.length, 0, "auth fail → 不应写 journal");
  });

  test("bad-format Authorization → 401,不查 DB", async () => {
    const h = buildHarness();
    const res = await h.run({ headers: { authorization: "Bearer not-a-valid-token-format" } });
    assert.equal(res.statusCode, 401);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0, "格式错不应触碰 DB");
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
  });

  test("findByPrefix → null(prefix 不存在 / 已撤销)→ 401,无副作用", async () => {
    // Codex Phase 3 plan-review NIT:用 findByPrefix→null 模拟"撤销+不存在",
    // Phase 1 SQL constraint 已经把 revoked_at IS NULL 过滤了。
    const h = buildHarness();
    h.apiKeyRepoSpy.setRow(null);
    const res = await h.run();
    assert.equal(res.statusCode, 401);
    // DB 查询了 1 次(strategy 走到 findByPrefix 才能判 null)
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 1);
    // 但 touchLastUsed / preCheck / scheduler 都没动
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls, 0);
  });

  test("secret 错(hash mismatch)→ 401,touchLastUsed 不调", async () => {
    const h = buildHarness();
    // row 用 FIXED_SECRET 算的 hash,但客户端发送一个改了 1 字节的 secret
    const wrongSecret = "f" + FIXED_SECRET.slice(1); // 首字节 d → f
    const res = await h.run({
      headers: { authorization: `Bearer oc-cc.${FIXED_PREFIX}.${wrongSecret}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 1);
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 0, "secret 错不能 bump last_used");
  });

  // §3.5 UA gate(2026-05-19 加):端到端验 UA 不对 → 401 + 0 副作用 + anti-enum
  test("非 claude-cli UA → 401,不查 DB / 不 preCheck / 不写 journal(anti-enum)", async () => {
    const h = buildHarness();
    const goodAuth = `Bearer oc-cc.${FIXED_PREFIX}.${FIXED_SECRET}`;
    for (const ua of [
      "curl/8.4.0",
      "PostmanRuntime/7.36.0",
      "Mozilla/5.0",
      "python-requests/2.31.0",
      "claude-code/2.1.888", // 注意:不是 claude-cli/,易混淆故意拦
      "",
    ]) {
      const res = await h.run({
        headers: { authorization: goodAuth, "user-agent": ua },
      });
      assert.equal(res.statusCode, 401, `ua=${JSON.stringify(ua)} 应 401`);
    }
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0, "UA 不对不应触碰 DB");
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls, 0);
    const journalInserts = h.pool.queries.filter((q) =>
      q.sql.trim().toUpperCase().startsWith("INSERT INTO REQUEST_FINALIZE_JOURNAL"),
    );
    assert.equal(journalInserts.length, 0, "UA gate fail → 不应写 journal");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (4) Authz failure
// ════════════════════════════════════════════════════════════════════════════

describe("authz failure — token 合法 + model 未授权 → 403", () => {
  test("admin role + hidden-visibility model + 空 grants → 403 NOT_AUTHORIZED,preCheck 不 reserve", async () => {
    // canUseModel:visibility="public" 永远 true,visibility="admin" 只看 role,
    // visibility="hidden" 只看 grants。Phase 6 admin-only rollout 把 strategy.resolve
    // 内的 role!=="admin" 路径吃掉了(Layer 2 直接 401),所以此处必须用
    // role="admin" + visibility="hidden" + 空 grants 组合,才能保留 "authz fail
    // → 403 NOT_AUTHORIZED" 闭环测试 — 用 hidden + 空 grants 让 canUseModel false。
    // 同源语义见 anthropicProxy.integ.test.ts。
    const h = buildHarness({
      pricingOverride: { visibility: "hidden" },
      authz: { role: "admin", grantedModelIds: new Set() },
    });
    const res = await h.run();
    assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.bodyText()}`);
    assert.equal(readErrCode(res), "NOT_AUTHORIZED");

    // touchLastUsed 仍然会调 1 次(strategy.resolve 已经成功,authz 在 resolve 之后)
    // 这是与 invariant 3 的对比:auth fail = resolve 失败 = 无 bump
    //                       authz fail = resolve 成功 = bump 已发生
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 1, "resolve 成功后 touchLastUsed 已 fire");

    // 但 preCheck.atomicReserve **必须没**被调(authz 失败在 reserve 之前)
    assert.equal(h.preCheckSpy.reserveCalls.length, 0, "authz fail → 不进 reservation 路径");
    assert.equal(h.schedulerSpy.pickCalls, 0, "authz fail → 不进 pick 路径");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 6 admin-only rollout(plan §3.4)Layer 2 — strategy 内 admin gate 闭环
//
// secret 验对 → bumpLastUsedThrottled 已 fire → admin gate 看到 role="user"
// → 抛 IdentityError("API_KEY_INVALID"),proxy/index.ts catch 后 401 UNAUTHORIZED。
//
// 与 Layer 1(管理面 403 ADMIN_ONLY)的责任分工:Layer 1 拦住"创建/列表/撤销"
// 入口,Layer 2 拦住"消费 quota"入口。两层都被破口才会失守 — 即使 DB 残留
// user-role 的 key(SQL 直插 / 历史遗留 / 未来 staff 协助),这一层仍兜底。
//
// 反枚举一致:与 unknown prefix / revoked / secret-mismatch 同走 API_KEY_INVALID,
// 攻击者无法靠错误码区分。preCheck / scheduler / journal / usage_records /
// credit_ledger 全部不能触达 — 否则 user 拿合法 key 可消耗 claude_accounts pool。
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 6 admin-only Layer 2 — strategy 内 admin gate(authz role=user → 401 + 零账务)", () => {
  test("token+secret 合法但 authz role=user → 401 UNAUTHORIZED + touchLastUsed 调 1 次 + preCheck/scheduler 全不触发", async () => {
    // 默认 token+row 都用 FIXED_PREFIX/SECRET,secret 一定 verify 通过 →
    // bumpLastUsedThrottled 必须 fire(顺序锁,与 secret-mismatch 路径区分)。
    // 之后 strategy 内 admin gate 看到 role="user" → throw API_KEY_INVALID。
    const h = buildHarness({
      authz: { role: "user", grantedModelIds: new Set<string>([FIXED_MODEL]) },
    });
    const res = await h.run();
    assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.bodyText()}`);
    // 反枚举:proxy/index.ts 把 IdentityError 全部映成 UNAUTHORIZED,errcode 不外泄区分理由。
    assert.equal(readErrCode(res), "UNAUTHORIZED");

    // 顺序锁 — secret 已 verify → bumpLastUsedThrottled 必须 fire(ops 可见 last_used_at)。
    // 不能因为 admin gate reject 就把 bump 跳过 — 见 strategy 代码注释 "顺序说明"。
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 1, "findByPrefix 调过(secret 比对前提)");
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 1, "secret OK → bump 必须发生(non-admin attempt 也要可见)");

    // 零账务副作用 — admin gate throw IdentityError 后 proxy/index.ts catch 直接 401,
    // 不进 preCheck / scheduler / journal / usage_records / credit_ledger 任何 SQL。
    assert.equal(h.preCheckSpy.reserveCalls.length, 0, "admin gate reject → 不进 preCheck reservation");
    assert.equal(h.schedulerSpy.pickCalls, 0, "admin gate reject → 不进 scheduler pick");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (5) Maintenance gate
// ════════════════════════════════════════════════════════════════════════════

describe("maintenance gate — system_settings.maintenance_mode=true → 503", () => {
  test("maintenance=true + 非 admin Bearer → 503 MAINTENANCE,不进 proxy", async () => {
    const h = buildHarness({ poolOverride: { maintenanceMode: true } });
    const res = await h.run();
    assert.equal(res.statusCode, 503);
    assert.equal(readErrCode(res), "MAINTENANCE");
    // 关键:adapter 在 maintenance gate 之后,所以 strategy 不应被调用
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0, "维护期 strategy 不应被触发");
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (6) JWT vs API key
// ════════════════════════════════════════════════════════════════════════════

describe("JWT vs API key — 客户端发普通 v3 JWT → BAD_API_KEY_FORMAT", () => {
  test("Bearer <looks-like-jwt-but-not-oc-cc> → 401,DB 不查询", async () => {
    // 形态像 JWT(三段 base64),但不匹配 oc-cc.<prefix>.<secret>;
    // strategy 的 token regex 不会过,直接 BAD_API_KEY_FORMAT。
    const fakeJwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJ1c2VyMSIsInJvbGUiOiJ1c2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ",
      "Z2FyYmFnZS1zaWduYXR1cmU",
    ].join(".");
    const h = buildHarness();
    const res = await h.run({ headers: { authorization: `Bearer ${fakeJwt}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0, "JWT 不应触发 user_api_keys 查询");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (7) 503 degraded
// ════════════════════════════════════════════════════════════════════════════

describe("503 degraded — externalApiKeyProxy 未注入 → EXTERNAL_PROXY_UNAVAILABLE", () => {
  test("装配失败 / 未注入 → 503 EXTERNAL_PROXY_UNAVAILABLE,不进 strategy", async () => {
    // 仍然走完整 createCommercialHandler 路径,但 deps.externalApiKeyProxy = undefined。
    // adapter 必须返 503 而非 404 —— 部署故障不该伪装成"用户 URL 写错"。
    const h = buildHarness({ omitExternalProxy: true });
    const res = await h.run();
    assert.equal(res.statusCode, 503);
    assert.equal(readErrCode(res), "EXTERNAL_PROXY_UNAVAILABLE");
    // 严格:任何 strategy / scheduler / preCheck 调用都不该发生
    assert.equal(h.apiKeyRepoSpy.findByPrefixCalls.length, 0);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (8) last_used_at throttle
// ════════════════════════════════════════════════════════════════════════════

describe("last_used_at throttle — 5min in-process LRU 端到端 wired", () => {
  test("同一 key 5min 内连续 3 次请求 → touchLastUsed 只调用 1 次", async () => {
    // 注入固定 now,5min throttle 必须用 strategy 的 closure-scope cache 落锤。
    let nowMs = 1_000_000;
    const h = buildHarness({ now: () => nowMs });

    // 第 1 次:fire
    let res = await h.run();
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 1, "首次 → 1 次 bump");

    // 第 2 次:推进 1min,仍 < 5min,不应再 bump
    nowMs += 60_000;
    res = await h.run();
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 1, "1min 后第二次 → 仍 1");

    // 第 3 次:再推进 3min(累计 4min < 5min),仍不应 bump
    nowMs += 180_000;
    res = await h.run();
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 1, "4min 后第三次 → 仍 1");

    // 第 4 次:跨过 5min 临界 → 必须重新 bump
    nowMs += 120_000; // 累计 6min
    res = await h.run();
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.apiKeyRepoSpy.touchLastUsedCalls.length, 2, "5min 后 → 再 bump");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (9) Phase 7 §3.5.2 — 出站 envelope 归一化端到端(invariant #11)
//
// 这些 case 与 externalEnvelope.unit.test.ts 的关系:unit 直接调 helper 验
// system 形态变换;integ 走完整 createCommercialHandler → strategy →
// runUpstreamRoundTrip 路径,断言**最终序列化到上游的 outbound JSON**(在
// core.ts:160 `JSON.stringify({...body, messages: upstreamMessages, stream: true})`
// 之后,fetch 拦截器看到的 body)同时含 sysprompt prefix(envelope helper 注入)
// **和** metadata.user_id device_id pin(applyUpstreamAuth 后续阶段注入)。
//
// Codex Phase 7 plan-review MINOR:必须断 outbound body 而非 helper 输出,
// 否则 helper 与后续 applyUpstreamAuth 的合作性破裂(职责拆分点)只有 integ
// 能锁住。
//
// 负例选 "DeepSeek 路径" 而非 "容器路径":本文件 IdentityStrategy 是
// ApiKey,containerId 恒为 null,机械上无法构造容器路径请求;DeepSeek 路径
// (`route.kind !== "oauth"`)是 §3.5.2 predicate 的另一半,同样需要锁住。
// 容器路径的 envelope skip 在 anthropicProxy.integ.test.ts 既有 happy 用例
// 隐式覆盖(那里 IdentityStrategy 是 container,outbound body 历来无 CC prefix
// 注入 — 本 Phase 7 改动不会破坏该不变量,因为 predicate 第一项 `containerId
// === null` 就过滤掉了)。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 捕获 upstream fetch 的请求 body(POST 给 Anthropic / DeepSeek 的最终 JSON)。
 * 返回 [fetchImpl, getCapturedBody]。fetchImpl 应注入 buildHarness(fetchImpl: ...)。
 *
 * 设计:不预解析,只存原始 string;断言侧 JSON.parse 后看结构,失败时可直接
 * 打印 raw 字节排查。
 */
function makeCapturingFetch(): {
  fetchImpl: typeof fetch;
  getBody(): string | undefined;
} {
  let captured: string | undefined;
  const fetchImpl: typeof fetch = (async (
    _url: string | URL,
    init?: RequestInit,
  ) => {
    if (init?.body && typeof init.body === "string") {
      captured = init.body;
    }
    return sseResponse(200, makeFullSseChunks());
  }) as unknown as typeof fetch;
  return { fetchImpl, getBody: () => captured };
}

describe("Phase 7 §3.5.2 出站 envelope — invariant #11 端到端", () => {
  test("正例 1:客户端无 system / 无 metadata → outbound 含 CC prefix block + cache_control + metadata.user_id device_id", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({ fetchImpl: cap.fetchImpl });
    // body 不含 system / 不含 metadata
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200, `status=${res.statusCode}; body=${res.bodyText()}`);

    const raw = cap.getBody();
    assert.ok(raw, "upstream fetch 必须收到 body");
    const sent = JSON.parse(raw!) as Record<string, unknown>;

    // (a) system 被归一化为 array,第一个 block 是 CC DEFAULT prefix + cache_control
    assert.ok(Array.isArray(sent.system), `system 必须是 array;got=${typeof sent.system}`);
    const systemArr = sent.system as Array<Record<string, unknown>>;
    assert.ok(systemArr.length >= 1, "system 至少有 1 个 block");
    const first = systemArr[0]!;
    assert.equal(first.type, "text", "首 block type=text");
    assert.equal(
      first.text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "首 block.text = CC DEFAULT prefix(字面 byte 匹配)",
    );
    assert.deepEqual(
      first.cache_control,
      { type: "ephemeral" },
      "注入 block 必带 cache_control: ephemeral(降本)",
    );

    // (b) device_id pin 也已 injected(envelope helper 与 applyUpstreamAuth 合作)
    assert.ok(sent.metadata && typeof sent.metadata === "object", "metadata 存在");
    const meta = sent.metadata as Record<string, unknown>;
    assert.equal(typeof meta.user_id, "string", "metadata.user_id 是 string(JSON-encoded)");
    const userIdParsed = JSON.parse(meta.user_id as string) as Record<string, unknown>;
    assert.equal(
      userIdParsed.device_id,
      FIXED_PINNED_USER_ID,
      "metadata.user_id.device_id = 账号绑定的 pinned_user_id",
    );
  });

  test("正例 2:客户端发已含 CC prefix 的 system(string 形态)→ envelope skip,不重复 prepend;device_id pin 仍生效", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({ fetchImpl: cap.fetchImpl });
    // 客户端模拟容器 CCB 行为:system 是 string 形态,且以 CC DEFAULT prefix 开头
    const ccSystemString =
      "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive CLI tool that helps users...";
    const res = await h.run({
      body: { ...minBody(), system: ccSystemString },
    });
    assert.equal(res.statusCode, 200, `status=${res.statusCode}; body=${res.bodyText()}`);

    const raw = cap.getBody();
    assert.ok(raw, "upstream fetch 必须收到 body");
    const sent = JSON.parse(raw!) as Record<string, unknown>;

    // helper 把 string 归一化成 array,但因检测到 prefix → skip prepend;
    // 期望 system = [{type:"text", text: <原 string>}],**没有**额外 prepend 的 cache_control block。
    assert.ok(Array.isArray(sent.system), "归一化后是 array");
    const systemArr = sent.system as Array<Record<string, unknown>>;
    assert.equal(
      systemArr.length,
      1,
      `skip 路径下不应 prepend 新 block;got len=${systemArr.length}`,
    );
    assert.equal(systemArr[0]!.type, "text");
    assert.equal(systemArr[0]!.text, ccSystemString, "原 text 完整保留");
    assert.equal(
      systemArr[0]!.cache_control,
      undefined,
      "skip 路径下不注入 cache_control(原 string 形态本就没有)",
    );

    // device_id pin 仍然生效(envelope helper 不动 metadata,applyUpstreamAuth 兜底)
    const meta = sent.metadata as Record<string, unknown>;
    const userIdParsed = JSON.parse(meta.user_id as string) as Record<string, unknown>;
    assert.equal(userIdParsed.device_id, FIXED_PINNED_USER_ID);
  });

  test("负例:DeepSeek 路径(route.kind !== 'oauth')→ envelope **不**注入 CC prefix", async () => {
    // 构造 DeepSeek 路径:model 以 `deepseek-` 开头,deps.deepseekApiKey 已注入(避免 503),
    // 用户 authz 含此 model。
    const DS_MODEL = "deepseek-v4-pro";
    const DS_PRICING: ModelPricing = {
      ...FIXED_PRICING,
      model_id: DS_MODEL,
      display_name: "DeepSeek v4 Pro",
    };
    const cap = makeCapturingFetch();
    // buildHarness 不支持注入 deepseekApiKey,手搓 minimal harness 段。
    const pool = buildFakePool({});
    setPoolOverride(pool as unknown as Pool);
    const preCheckSpy = buildFakePreCheckRedis();
    const rateLimitRedis = buildFakeRateLimitRedis();
    const schedulerSpy = buildFakeScheduler();
    const pricing = buildFakePricing([FIXED_PRICING, DS_PRICING]);
    const apiKeyRepoSpy = buildApiKeyRepoSpy();
    const logEvents: Array<Record<string, unknown>> = [];
    const testLogger = createLogger({
      level: "trace",
      base: { test: "ccExternalEndpoint.integ.deepseek" },
      out: (line) => {
        try { logEvents.push(JSON.parse(line) as Record<string, unknown>); }
        catch { /* skip */ }
      },
    });
    const apiKeyStrategy = makeApiKeyIdentityStrategy({
      repo: apiKeyRepoSpy.repo,
      pricing,
      loadUserModelAuthz: async () => ({
        role: "admin",
        grantedModelIds: new Set<string>([DS_MODEL]),
      }),
    });
    const externalApiKeyProxy = makeAnthropicProxyHandler({
      pgPool: pool as unknown as Pool,
      pricing,
      preCheckRedis: preCheckSpy.redis,
      scheduler: schedulerSpy.scheduler,
      identity: apiKeyStrategy,
      rateLimitRedis,
      fetchImpl: cap.fetchImpl,
      upstreamEndpoint: "https://upstream.test/v1/messages",
      logger: testLogger,
      deepseekApiKey: "test-deepseek-key", // ← 关键:避免 503
    });
    const deps: CommercialHttpDeps = {
      jwtSecret: FIXED_JWT_SECRET,
      mailer: { sendTemplate: async () => {} } as unknown as CommercialHttpDeps["mailer"],
      redis: rateLimitRedis,
      pricing,
      preCheckRedis: preCheckSpy.redis,
      externalApiKeyProxy,
    };
    const handler = createCommercialHandler(deps, { logger: testLogger });
    const req = new MockReq({
      headers: { authorization: `Bearer ${FIXED_TOKEN}` },
      body: { ...minBody(DS_MODEL), system: "be helpful" },
    });
    const res = new MockRes();
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 200, `status=${res.statusCode}; body=${res.bodyText()}`);
    const raw = cap.getBody();
    assert.ok(raw, "upstream fetch 必须收到 body(DeepSeek 路径)");
    const sent = JSON.parse(raw!) as Record<string, unknown>;

    // 关键不变量:DeepSeek 路径下 system 必须保持客户端原值(string "be helpful"),
    // **不**经 envelope 归一化、**不**被 prepend CC prefix。
    assert.equal(
      sent.system,
      "be helpful",
      `DeepSeek 路径下 system 不应被改写;got=${JSON.stringify(sent.system)}`,
    );

    // 反向断:确认 logEvents 里没有 `external_envelope_injected` / `external_envelope_skip`
    // —— predicate 第二项 `route.kind === "oauth"` 应该把 DeepSeek 路径整段跳过。
    const envelopeLogs = logEvents.filter((e) => {
      const m = e.msg;
      return m === "external_envelope_injected" || m === "external_envelope_skip";
    });
    assert.equal(
      envelopeLogs.length,
      0,
      `DeepSeek 路径下不应调 envelope helper;got logs=${JSON.stringify(envelopeLogs)}`,
    );

    // 清理(本 case 没走 buildHarness,需手动)
    // pool override 由 afterEach 兜底 resetPool。
  });
});
