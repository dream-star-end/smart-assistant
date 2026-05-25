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
import type { AccountScheduler, PickInput, PickResult, ReleaseInput } from "../account-pool/scheduler.js";
import { AccountPoolUnavailableError } from "../account-pool/scheduler.js";
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
  /** 最近一次 pick 收到的 enforceAccountUuid 值;H6 断言 phase6 透传到 scheduler 用 */
  lastEnforceAccountUuid: boolean | undefined;
}

interface FakeSchedulerOpts {
  /** H6:scheduler 返回的 account_uuid。默认 null。 */
  accountUuid?: string | null;
}

function buildFakeScheduler(opts: FakeSchedulerOpts = {}): SchedulerSpy {
  const accountUuid = opts.accountUuid ?? null;
  let pickCalls = 0;
  let lastEnforceAccountUuid: boolean | undefined;
  const releaseCalls: ReleaseInput[] = [];
  const scheduler = {
    async pick(input: PickInput): Promise<PickResult> {
      pickCalls++;
      lastEnforceAccountUuid = input.enforceAccountUuid === true;
      // H6 fail_closed:scheduler 真实路径下会过滤 NULL 候选;若全 NULL 则抛 'no_uuid'。
      // mock 这里复刻同语义,让 integ 测能验证 503 端到端贯通。
      if (lastEnforceAccountUuid && accountUuid === null) {
        throw new AccountPoolUnavailableError("no_uuid");
      }
      return {
        account_id: FIXED_ACCOUNT_ID,
        plan: "pro",
        token: Buffer.from("FAKE-TOKEN-VALUE"),
        refresh: null,
        expires_at: null,
        egress_proxy: null,
        egress_target: null,
        pinned_user_id: FIXED_PINNED_USER_ID,
        account_uuid: accountUuid,
        persona: null,
      };
    },
    async release(input: ReleaseInput): Promise<void> {
      releaseCalls.push(input);
    },
  } as unknown as AccountScheduler;
  return {
    scheduler,
    get pickCalls() { return pickCalls; },
    get lastEnforceAccountUuid() { return lastEnforceAccountUuid; },
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
  /**
   * Step 7 golden tests:让 loader 返指定 ctx(默认 null,表示空 attribution placeholder)。
   * 注意:此处只覆盖 *loader 返回值*,handler 装配本身仍走齐(loader+secret 都注入),
   * 区别于 (7.5) fail-closed 用例的"漏注 deps"路径。
   */
  platformCtx?: import("../platform/volumeContextReader.js").PlatformContext | null;
  /** Phase 6 H6:透传到 makeAnthropicProxyHandler 的 phase6AccountUuidEnforce(默认 undefined → off)。 */
  phase6AccountUuidEnforce?: "off" | "fail_open" | "fail_closed";
  /** Phase 6 H6:fake scheduler 返回的 account_uuid(默认 null)。 */
  schedulerAccountUuid?: string | null;
}

function buildHarness(opts: HarnessOpts = {}) {
  const pool = buildFakePool(opts.poolOverride);
  setPoolOverride(pool as unknown as Pool);

  const preCheckSpy = buildFakePreCheckRedis();
  const rateLimitRedis = buildFakeRateLimitRedis();
  const schedulerSpy = buildFakeScheduler({ accountUuid: opts.schedulerAccountUuid });
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
        // Phase 5 envelope rewriter wiring(2026-05-21):buildHarness 默认走 OAuth
        // 路径 happy 闭环,handler 在 containerId===null && route.kind==='oauth'
        // 命中时强制 buildPlatformEnvelope。注入 no-op loader(无 attribution)+
        // 32 字符固定测试 secret 即可让 builder 走"纯 envelope 强制 + PII strip"
        // 分支,避免 503 PLATFORM_ENVELOPE_UNAVAILABLE。专门验 envelope 内容
        // 的用例覆盖在 Step 7 platformEnvelopeBuilder golden test;专门验 503
        // fail-closed 的用例显式手搓 handler(不走 buildHarness)。
        // Step 7 golden tests 通过 opts.platformCtx 让 loader 返指定 ctx 验证
        // ctx → outbound system[N+1] 端到端贯通(非 null placeholder 路径)。
        platformContextLoader: {
          load: async () => opts.platformCtx ?? null,
          invalidate: () => {},
        },
        platformServerSecret: "test-platform-hmac-secret-32char",
        phase6AccountUuidEnforce: opts.phase6AccountUuidEnforce,
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
// (7.5) Phase 5 envelope fail-closed:handler 装配漏注 loader/secret
// ════════════════════════════════════════════════════════════════════════════
//
// 跟 (7) 的区别:那是 deps.externalApiKeyProxy = undefined(router 层降级);
// 这里 externalApiKeyProxy 装配齐了进 router,但 handler 内部 deps.platformContextLoader
// 或 deps.platformServerSecret 被漏 — handler 内部 fail-closed 走 PLATFORM_ENVELOPE_UNAVAILABLE。
// 触发条件需命中 `containerId === null && route.kind === "oauth"`,即外接 ApiKey + OAuth 上游。

describe("Phase 5 envelope fail-closed — handler 装配漏注 loader/secret", () => {
  test("loader 缺失 + secret 已配 → 503 PLATFORM_ENVELOPE_UNAVAILABLE,handler 内部 fail-closed", async () => {
    // 完整 setup 与 buildHarness 一致,只在 makeAnthropicProxyHandler 调用时漏注 loader。
    const pool = buildFakePool({});
    setPoolOverride(pool as unknown as Pool);
    const preCheckSpy = buildFakePreCheckRedis();
    const rateLimitRedis = buildFakeRateLimitRedis();
    const schedulerSpy = buildFakeScheduler();
    const pricing = buildFakePricing();
    const apiKeyRepoSpy = buildApiKeyRepoSpy();
    const logger = createLogger({
      level: "warn",
      base: { test: "ccExternalEndpoint.integ.envelope-fail-closed" },
      out: () => {},
    });
    const apiKeyStrategy = makeApiKeyIdentityStrategy({
      repo: apiKeyRepoSpy.repo,
      pricing,
      loadUserModelAuthz: async () => ({
        role: "admin",
        grantedModelIds: new Set<string>([FIXED_MODEL]),
      }),
    });
    const externalApiKeyProxy = makeAnthropicProxyHandler({
      pgPool: pool as unknown as Pool,
      pricing,
      preCheckRedis: preCheckSpy.redis,
      scheduler: schedulerSpy.scheduler,
      identity: apiKeyStrategy,
      rateLimitRedis,
      fetchImpl: async () => sseResponse(200, makeFullSseChunks()),
      upstreamEndpoint: "https://upstream.test/v1/messages",
      logger,
      // ← platformContextLoader 故意不注入,模拟装配 bug;secret 仍给齐以隔离变量
      platformServerSecret: "test-platform-hmac-secret-32char",
    });
    const deps: CommercialHttpDeps = {
      jwtSecret: FIXED_JWT_SECRET,
      mailer: { sendTemplate: async () => {} } as unknown as CommercialHttpDeps["mailer"],
      redis: rateLimitRedis,
      pricing,
      preCheckRedis: preCheckSpy.redis,
      externalApiKeyProxy,
    };
    const handler = createCommercialHandler(deps, { logger });
    const req = new MockReq({
      headers: { authorization: `Bearer ${FIXED_TOKEN}` },
      body: minBody(),
    });
    const res = new MockRes();
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 503, `status=${res.statusCode}; body=${res.bodyText()}`);
    assert.equal(readErrCode(res), "PLATFORM_ENVELOPE_UNAVAILABLE");
    // 锁顺序不变量:Phase 5 envelope rewriter 在 estimateInputTokens / preCheck.reserve
    // **之前** 失败 → 任何账务侧效应都不该触发(plan §3.5.2 行为锁)
    assert.equal(preCheckSpy.reserveCalls.length, 0, "fail-closed 必须在 preCheck.reserve 之前");
    assert.equal(schedulerSpy.pickCalls, 0, "fail-closed 必须在 scheduler.pick 之前");
  });

  test("secret 缺失 + loader 已配 → 503 PLATFORM_ENVELOPE_UNAVAILABLE", async () => {
    // 镜像上一个 test,只换缺失方向 — 验证 OR 语义(任一缺失就 fail-closed)。
    const pool = buildFakePool({});
    setPoolOverride(pool as unknown as Pool);
    const preCheckSpy = buildFakePreCheckRedis();
    const rateLimitRedis = buildFakeRateLimitRedis();
    const schedulerSpy = buildFakeScheduler();
    const pricing = buildFakePricing();
    const apiKeyRepoSpy = buildApiKeyRepoSpy();
    const logger = createLogger({
      level: "warn",
      base: { test: "ccExternalEndpoint.integ.envelope-fail-closed-secret" },
      out: () => {},
    });
    const apiKeyStrategy = makeApiKeyIdentityStrategy({
      repo: apiKeyRepoSpy.repo,
      pricing,
      loadUserModelAuthz: async () => ({
        role: "admin",
        grantedModelIds: new Set<string>([FIXED_MODEL]),
      }),
    });
    const externalApiKeyProxy = makeAnthropicProxyHandler({
      pgPool: pool as unknown as Pool,
      pricing,
      preCheckRedis: preCheckSpy.redis,
      scheduler: schedulerSpy.scheduler,
      identity: apiKeyStrategy,
      rateLimitRedis,
      fetchImpl: async () => sseResponse(200, makeFullSseChunks()),
      upstreamEndpoint: "https://upstream.test/v1/messages",
      logger,
      platformContextLoader: { load: async () => null, invalidate: () => {} },
      // ← platformServerSecret 故意不注入
    });
    const deps: CommercialHttpDeps = {
      jwtSecret: FIXED_JWT_SECRET,
      mailer: { sendTemplate: async () => {} } as unknown as CommercialHttpDeps["mailer"],
      redis: rateLimitRedis,
      pricing,
      preCheckRedis: preCheckSpy.redis,
      externalApiKeyProxy,
    };
    const handler = createCommercialHandler(deps, { logger });
    const req = new MockReq({
      headers: { authorization: `Bearer ${FIXED_TOKEN}` },
      body: minBody(),
    });
    const res = new MockRes();
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 503, `status=${res.statusCode}; body=${res.bodyText()}`);
    assert.equal(readErrCode(res), "PLATFORM_ENVELOPE_UNAVAILABLE");
    // 同上 test 锁顺序不变量
    assert.equal(preCheckSpy.reserveCalls.length, 0, "fail-closed 必须在 preCheck.reserve 之前");
    assert.equal(schedulerSpy.pickCalls, 0, "fail-closed 必须在 scheduler.pick 之前");
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
// (8.5) Phase 5 Step 7 — H1 / H2 / PII strip / RPC fallback golden tests
// ════════════════════════════════════════════════════════════════════════════
//
// 端到端锁的 Phase 5 不变量(plan §5.2 / §8):
//   - H1 多机一致:同 ApiKey + 同 userId,不同 client 客户端 → 上游 fetch 到的
//     `system[0]`/`system[1]`/`system[N+1]` byte-level 完全相同;`metadata.user_id`
//     keyset 同形态;`account_uuid` byte-level 稳定;`session_id` server-generated
//     且不携带客户端透传值
//   - H2 外接 / 容器 metadata 同形态:外接 outbound `metadata.user_id` keyset =
//     {device_id, account_uuid, session_id} 三必有键,无 extra
//   - PII strip 端到端:客户端 system block 含 hostname / 用户名路径 / device-id
//     等 PII → 上游 fetch 看到的 outbound 对应 block = `[redacted-by-platform]`
//   - RPC fallback:loader.load() 返 null(reader 故障 / volume 不存在)→ handler
//     不抛 503,builder 走 ctx=null 路径(占位 attribution),outbound 200
//
// Unit 测试已覆盖 builder 内部逻辑;此处端到端验证 handler 装配链(loader → builder →
// applyUpstreamAuth → fetch)流向上游 body 的最终形态,锁 Step 6 接入点不退化。

/**
 * 捕获 upstream fetch 的请求 body(POST 给 Anthropic / DeepSeek 的最终 JSON)。
 * 返回 [fetchImpl, getCapturedBody]。fetchImpl 应注入 buildHarness(fetchImpl: ...)。
 *
 * 设计:不预解析,只存原始 string;断言侧 JSON.parse 后看结构,失败时可直接
 * 打印 raw 字节排查。Phase 5 Step 7 H1/H2/PII/FALLBACK 全部用此 helper 验最终
 * outbound JSON 形态。
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

describe("Phase 5 Step 7 — H1 / H2 / PII strip / fallback golden tests", () => {
  // FIXED_PINNED_USER_ID 来自 fake account-pool;applyUpstreamAuth 会用它覆盖
  // envelope builder 占位的 device_id。Step 7 unit 测试已验 device_id 占位写"";
  // integ 这里关心的是"最终上游看到的"形态,所以期望 device_id = pinned。

  test("H1.1 同 userId 不同 client body → outbound system[0]/[1]/[N+1] byte-level 一致", async () => {
    // 3 个完全不同的 client body — 模拟 3 台机器分别发请求
    const clientBodies = [
      {
        ...minBody(),
        system: "client A: Mac with hostname: alice-mac.local",
        metadata: { user_id: JSON.stringify({ device_id: "client-A-deviceid" }) },
      },
      {
        ...minBody(),
        system: [{ type: "text", text: "client B array-form system" }],
        metadata: { user_id: JSON.stringify({ device_id: "client-B-deviceid" }) },
      },
      {
        ...minBody(),
        // 客户端 C 不传 system / metadata
      },
    ];
    const outbounds: Array<Record<string, unknown>> = [];
    for (const body of clientBodies) {
      const cap = makeCapturingFetch();
      const h = buildHarness({ fetchImpl: cap.fetchImpl });
      const res = await h.run({ body });
      assert.equal(res.statusCode, 200, `status=${res.statusCode}: ${res.bodyText()}`);
      const raw = cap.getBody();
      assert.ok(raw);
      outbounds.push(JSON.parse(raw!) as Record<string, unknown>);
      await resetPool();
      _clearMaintenanceCache();
    }

    // 抽 3 个 outbound 的 system 数组
    const systems = outbounds.map((b) => b.system as Array<{ text: string }>);

    // system[0] attribution forge — 3 client byte-level 完全相同
    assert.equal(systems[0]![0]!.text, systems[1]![0]!.text);
    assert.equal(systems[1]![0]!.text, systems[2]![0]!.text);
    assert.ok(systems[0]![0]!.text.startsWith("x-anthropic-billing-header: cc_version="));

    // system[1] CC prefix — byte-level 完全相同
    assert.equal(systems[0]![1]!.text, systems[1]![1]!.text);
    assert.equal(systems[1]![1]!.text, systems[2]![1]!.text);
    assert.equal(
      systems[0]![1]!.text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );

    // system[N+1] 平台 context 块(尾)— byte-level 完全相同(占位形态)
    const last0 = systems[0]![systems[0]!.length - 1]!.text;
    const last1 = systems[1]![systems[1]!.length - 1]!.text;
    const last2 = systems[2]![systems[2]!.length - 1]!.text;
    assert.equal(last0, last1);
    assert.equal(last1, last2);
    assert.ok(last0.startsWith("# OpenClaude Platform Context"));
  });

  test("H1.2 同 userId 不同 client body → metadata.user_id keyset 同形态 + account_uuid 字节级稳定 + session_id 各异", async () => {
    const accountUuids: string[] = [];
    const sessionIds: string[] = [];
    const keysets: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const cap = makeCapturingFetch();
      const h = buildHarness({ fetchImpl: cap.fetchImpl });
      // 客户端透传一个 session_id 占位值,验它必被覆盖
      const res = await h.run({
        body: {
          ...minBody(),
          metadata: {
            user_id: JSON.stringify({
              device_id: `client-${i}-deviceid`,
              session_id: "CLIENT_INJECTED_SESSION_DO_NOT_LEAK",
            }),
          },
        },
      });
      assert.equal(res.statusCode, 200);
      const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
      const userIdObj = JSON.parse(
        (sent.metadata as Record<string, unknown>).user_id as string,
      ) as Record<string, string>;
      keysets.push(Object.keys(userIdObj).sort());
      accountUuids.push(userIdObj.account_uuid!);
      sessionIds.push(userIdObj.session_id!);
      await resetPool();
      _clearMaintenanceCache();
    }
    // keyset 必恒为 [account_uuid, device_id, session_id]
    assert.deepEqual(keysets[0], ["account_uuid", "device_id", "session_id"]);
    assert.deepEqual(keysets[0], keysets[1]);
    assert.deepEqual(keysets[1], keysets[2]);
    // account_uuid 同 userId 跨多次稳定
    assert.equal(accountUuids[0], accountUuids[1]);
    assert.equal(accountUuids[1], accountUuids[2]);
    // session_id 各不相同 + 都不等于 client 透传值
    assert.notEqual(sessionIds[0], sessionIds[1]);
    assert.notEqual(sessionIds[1], sessionIds[2]);
    for (const sid of sessionIds) {
      assert.notEqual(sid, "CLIENT_INJECTED_SESSION_DO_NOT_LEAK");
      assert.match(
        sid,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  test("H2.1 outbound metadata.user_id 仅含 3 必有 key(device_id/account_uuid/session_id),无 extra", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({ fetchImpl: cap.fetchImpl });
    const res = await h.run({
      body: {
        ...minBody(),
        metadata: {
          user_id: JSON.stringify({
            device_id: "x",
            custom_inner_extra: "leak1",
            another_field: 42,
          }),
          // session_id 是 schema-allowed 的顶层 key,但 builder 必须 strip
          // (schema metadata 是 .strict(),custom_top_extra 这类未声明 key 会被 zod 直接 400,无法走到 builder)
          session_id: "top-level-session-should-die",
        } as Record<string, unknown>,
      },
    });
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const meta = sent.metadata as Record<string, unknown>;
    // 顶层只剩 user_id
    assert.deepEqual(Object.keys(meta), ["user_id"]);
    const userIdObj = JSON.parse(meta.user_id as string) as Record<string, unknown>;
    // 内层只 3 必有 key
    assert.deepEqual(Object.keys(userIdObj).sort(), [
      "account_uuid",
      "device_id",
      "session_id",
    ]);
  });

  test("PII.E2E.1 outbound system 块含 hostname/UNIX 路径/device-id 都被 [redacted-by-platform]", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({ fetchImpl: cap.fetchImpl });
    const piiBlock1 = "Hostname: leak-host.example.com";
    const piiBlock2 = "User dir at /Users/alice-the-engineer/projects";
    const piiBlock3 = `Device id hash: ${"deadbeef".repeat(4)}`; // hex32
    const res = await h.run({
      body: {
        ...minBody(),
        system: [
          { type: "text", text: piiBlock1 },
          { type: "text", text: piiBlock2 },
          { type: "text", text: piiBlock3 },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const systemArr = sent.system as Array<{ text: string }>;
    // system[0] / [1] 是 server forge,attribution + CC prefix
    // system[2..N] 是 PII 后的 tail;system[N+1] 是平台 context 块
    // 我们的 3 个 PII block 应在 system[2..4],全部 redacted
    const tailBlocks = systemArr.slice(2, 5);
    for (const b of tailBlocks) {
      assert.equal(b.text, "[redacted-by-platform]", `应整 block redact;got=${b.text}`);
    }
    // outbound raw 字面也不应残留任何 PII 子串(双重保险)
    const raw = cap.getBody()!;
    assert.ok(!raw.includes("alice-the-engineer"), "用户名路径不应出现在 outbound raw");
    assert.ok(!raw.includes("leak-host.example.com"), "hostname 不应出现在 outbound raw");
    assert.ok(!raw.includes("deadbeefdeadbeefdeadbeefdeadbeef"), "device-id 不应出现");
  });

  test("PII.E2E.2 PII negative anchor — `localhost` 单词不命中(非 field-style)", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({ fetchImpl: cap.fetchImpl });
    const benign = "Please connect to localhost on port 3000";
    const res = await h.run({
      body: { ...minBody(), system: [{ type: "text", text: benign }] },
    });
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const systemArr = sent.system as Array<{ text: string }>;
    // tail block 应原样保留(不被 PII 误伤)
    const tail = systemArr[2]!.text;
    assert.equal(tail, benign);
  });

  test("FALLBACK.1 platformContextLoader 返 null(reader 故障/volume 不存在)→ 不抛 503,outbound 200 + platform 块用占位", async () => {
    const cap = makeCapturingFetch();
    // buildHarness 默认 loader 就是 `async () => null`,等价 RPC fallback;
    // 显式 platformCtx: null 写出来加强用例语义
    const h = buildHarness({ fetchImpl: cap.fetchImpl, platformCtx: null });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200, `应 200;status=${res.statusCode}: ${res.bodyText()}`);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const systemArr = sent.system as Array<{ text: string }>;
    const last = systemArr[systemArr.length - 1]!.text;
    assert.equal(
      last,
      "# OpenClaude Platform Context\n[platform-context-unavailable]",
      "ctx=null → 占位文本(server-canonical default,保 H1 多机一致)",
    );
  });

  test("FALLBACK.2 platformContextLoader 返实际 ctx → outbound platform 块含 USER.md / MEMORY / skills", async () => {
    const ctx = {
      userMd: "# boss\nthe user is boss",
      memoryMd: "- [Memo](file.md) — info hook",
      skills: [{ name: "search-skill", description: "web search" }],
      volumeMtime: new Date("2026-05-21T00:00:00.000Z"),
    };
    const cap = makeCapturingFetch();
    const h = buildHarness({ fetchImpl: cap.fetchImpl, platformCtx: ctx });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const systemArr = sent.system as Array<{ text: string }>;
    const last = systemArr[systemArr.length - 1]!.text;
    assert.ok(last.startsWith("# OpenClaude Platform Context"));
    assert.ok(last.includes("## User"));
    assert.ok(last.includes("the user is boss"));
    assert.ok(last.includes("## Memory Index"));
    assert.ok(last.includes("## Skills"));
    assert.ok(last.includes("- **search-skill** — web search"));
  });
});

// ─── Phase 6 H6 — account_uuid 锚定到 OAuth 账号真 UUID ──────────────────────
//
// 详见 docs/V3_PHASE6_ACCOUNT_UUID_ANCHOR_PLAN_2026-05-21.md §2.8 H6 test matrix。
//
// 集成层(handler 端到端)验证 phase6Enforce + scheduler.account_uuid 二维矩阵
// 在 outbound `metadata.user_id.account_uuid` 字节级语义:
//   - H6.A enforce=off   → builder HMAC 占位透出(不被 hook 覆盖)
//   - H6.B fail_open + uuid 真 → metadata.account_uuid = pick.account_uuid
//   - H6.C fail_closed + uuid=null → 503 POOL_UNAVAILABLE(scheduler 抛 'no_uuid')
//
// 单元层(pickUpstream + applyUpstreamAuth 分支 / refresh rebind)在
// proxyUpstream.unit.test.ts;rewriteMetadataAccountUuid / isUuidLike 纯函数
// 单测在 anthropicProxy.test.ts。
describe("Phase 6 H6 — account_uuid 锚定到 OAuth 账号真 UUID(integ)", () => {
  // 一个合法 canonical UUID(8-4-4-4-12 hex,任意版本)— 来代表回填后落库的真值
  const REAL_ACCOUNT_UUID = "12345678-9abc-def0-1234-56789abcdef0";

  test("H6.A enforce=off → hook 不跑,outbound metadata.account_uuid 保 HMAC 占位(非真 UUID)", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({
      fetchImpl: cap.fetchImpl,
      // phase6AccountUuidEnforce 未注入 → 默认 off
      schedulerAccountUuid: REAL_ACCOUNT_UUID, // 即使 pick 给真值,off 也不该用
    });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200, `status=${res.statusCode}: ${res.bodyText()}`);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const meta = sent.metadata as Record<string, unknown>;
    const userIdObj = JSON.parse(meta.user_id as string) as Record<string, string>;
    // off 路径:account_uuid 字段仍存在(builder HMAC 注入),但不等于真 UUID
    assert.ok(userIdObj.account_uuid, "builder 占位应仍存在");
    assert.notEqual(userIdObj.account_uuid, REAL_ACCOUNT_UUID,
      "off 模式不应把真 UUID 透到上游");
    // scheduler 未被要求 enforceAccountUuid
    assert.equal(h.schedulerSpy.lastEnforceAccountUuid, false);
  });

  test("H6.B fail_open + pick.account_uuid=REAL_UUID → outbound metadata.account_uuid = REAL_UUID", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({
      fetchImpl: cap.fetchImpl,
      phase6AccountUuidEnforce: "fail_open",
      schedulerAccountUuid: REAL_ACCOUNT_UUID,
    });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const meta = sent.metadata as Record<string, unknown>;
    const userIdObj = JSON.parse(meta.user_id as string) as Record<string, string>;
    assert.equal(userIdObj.account_uuid, REAL_ACCOUNT_UUID,
      "fail_open + 真 UUID:hook 必须用 pick.account_uuid 覆盖 builder 占位");
    // fail_open 不在 scheduler 层 enforce
    assert.equal(h.schedulerSpy.lastEnforceAccountUuid, false);
  });

  test("H6.B' fail_open + pick.account_uuid=null → metadata.account_uuid 保 builder 占位(hook 静默跳过)", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({
      fetchImpl: cap.fetchImpl,
      phase6AccountUuidEnforce: "fail_open",
      schedulerAccountUuid: null, // 回填未跑完
    });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200, "fail_open + null:必须 200 不阻塞");
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const meta = sent.metadata as Record<string, unknown>;
    const userIdObj = JSON.parse(meta.user_id as string) as Record<string, string>;
    // fail_open + null:hook 静默,builder 占位仍存在但不等于任何真 UUID
    assert.ok(userIdObj.account_uuid, "builder 占位应仍存在");
    assert.notEqual(userIdObj.account_uuid, REAL_ACCOUNT_UUID);
  });

  test("H6.C fail_closed + 全池 account_uuid=null → 503 POOL_UNAVAILABLE,无 release 调用", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({
      fetchImpl: cap.fetchImpl,
      phase6AccountUuidEnforce: "fail_closed",
      schedulerAccountUuid: null,
    });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 503, `应 503;status=${res.statusCode}: ${res.bodyText()}`);
    // scheduler 被要求 enforceAccountUuid 但 pool 全 null → 抛 'no_uuid' → 503
    assert.equal(h.schedulerSpy.lastEnforceAccountUuid, true);
    // pool_unavailable 路径无 account 持有,scheduler.release 不应被调
    assert.equal(h.schedulerSpy.releaseCalls.length, 0);
  });

  test("H6.C' fail_closed + pick.account_uuid=REAL_UUID → 正常 200 + 写入 metadata.account_uuid", async () => {
    const cap = makeCapturingFetch();
    const h = buildHarness({
      fetchImpl: cap.fetchImpl,
      phase6AccountUuidEnforce: "fail_closed",
      schedulerAccountUuid: REAL_ACCOUNT_UUID,
    });
    const res = await h.run({ body: minBody() });
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
    const meta = sent.metadata as Record<string, unknown>;
    const userIdObj = JSON.parse(meta.user_id as string) as Record<string, string>;
    assert.equal(userIdObj.account_uuid, REAL_ACCOUNT_UUID);
    // fail_closed 在 scheduler 层 enforce
    assert.equal(h.schedulerSpy.lastEnforceAccountUuid, true);
  });

  test("H6.A/B keyset 形态稳定 — [account_uuid, device_id, session_id] 三必有键", async () => {
    // 验跨多个 phase6Enforce 配置 outbound 内层 key 集合不变
    const matrix: Array<{
      enforce: "off" | "fail_open" | "fail_closed";
      uuid: string | null;
    }> = [
      { enforce: "off", uuid: null },
      { enforce: "off", uuid: REAL_ACCOUNT_UUID },
      { enforce: "fail_open", uuid: null },
      { enforce: "fail_open", uuid: REAL_ACCOUNT_UUID },
      { enforce: "fail_closed", uuid: REAL_ACCOUNT_UUID },
    ];
    for (const { enforce, uuid } of matrix) {
      const cap = makeCapturingFetch();
      const h = buildHarness({
        fetchImpl: cap.fetchImpl,
        phase6AccountUuidEnforce: enforce,
        schedulerAccountUuid: uuid,
      });
      const res = await h.run({ body: minBody() });
      assert.equal(res.statusCode, 200, `case ${enforce}+${uuid ?? "null"}: 应 200`);
      const sent = JSON.parse(cap.getBody()!) as Record<string, unknown>;
      const meta = sent.metadata as Record<string, unknown>;
      const userIdObj = JSON.parse(meta.user_id as string) as Record<string, unknown>;
      assert.deepEqual(Object.keys(userIdObj).sort(), [
        "account_uuid",
        "device_id",
        "session_id",
      ], `case ${enforce}+${uuid ?? "null"}: keyset 必恒为三必有键`);
      await resetPool();
      _clearMaintenanceCache();
    }
  });
});
