/**
 * V3 anthropicProxy — Phase 0 BASELINE integration tests (BLOCKING for refactor).
 *
 * 目的:在 anthropicProxy.ts 拆分(identity / billing / proxy core)动手之前,
 * 用 spy/counter 把 5 条容易被搬运改坏的行为不变量锁死。任何 phase 完成都必
 * 须把这套 baseline 全部跑过 — 任何一条 fail 即"行为偏移",必须停下定位。
 *
 * 见 docs/V3_ANTHROPIC_PROXY_SPLIT_PLAN_2026-05-18.md §3.2 五条铁律 + Phase 0。
 *
 * 不变量清单:
 *   (1) Release ownership 4 阶段铁律
 *       - (a) pick 失败:仅 releasePreCheck,不 scheduler.release
 *       - (b) refresh 失败:scheduler.release({failure|transient_network}) + releasePreCheck
 *       - (c) startInflightJournal 失败:scheduler.release({failure}) + releasePreCheck
 *       - (d) finalizer 创建后:release 全部由 finalize.{commit,fail,failClient} 一次性接管
 *   (2) Abort 分类只看 isClientAbort(err),不看 ac.signal.aborted
 *       - 正常 commit:不走 client_error 路径
 *       - upstream 4xx/5xx (非 invalid_request_error):failure
 *       - upstream 400 invalid_request_error:client_error
 *       - 客户端 abort (AbortError / ABORT_ERR):client_error
 *   (3) Post-commit 顺序:committed && debitedCredits > 0 → appendCostCredits 先,
 *       broadcastToUser 后(串行)。debitedCredits=null|0n / aborted → 两者皆不调。
 *       appendCostCredits 抛错被 swallow,broadcast 仍照常发(fail-soft 持久化)。
 *   (4) DeepSeek (pick=null) full noop set:
 *       - scheduler.pick / scheduler.release / refresh / quota / dispatcher 全部跳过
 *       - strip 客户端传入的 anthropic-beta(不仅是"不注入"),也不重写 metadata.user_id
 *         claude 路径反过来:必须 merge oauth-2025-04-20 + 重写 metadata.user_id.device_id
 *   (5) 模型门关:pricing.get 返 null OR pricing.enabled=false → 400 UNKNOWN_MODEL,
 *       且发生在 loadUserModelAuthz / preCheck.atomicReserve / scheduler.pick 之前
 *
 * 实现策略:
 *   - **不依赖真实 PG / Redis** — Phase 0 锁的是 handler boundary behavior,
 *     深入 SQL 不属于本套用例范围(那是 settleUsageAndLedger 自己的 ledger
 *     integ test 该锁的)。用 fakePool / fakeRedis / fakeScheduler 注入。
 *   - **stub 真实 dep 注入点**(identityRepo / scheduler / preCheckRedis / pricing),
 *     不 stub 已封装的内部函数(verifyContainerIdentity / preCheckWithCost)。
 *   - 用 spy 数组 + 顺序断言验证调用栈,不只验返回值。
 *   - fakePool **explicit allowlist** — 未知 SQL prefix 直接抛(避免"未来代码加了
 *     新 query,沉默走 happy 默认值"的伪通过)。
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, createCipheriv, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  makeAnthropicProxyHandler,
  type AnthropicProxyDeps,
  type AnthropicProxyIdentityCtx,
} from "../http/anthropicProxy.js";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import { makeContainerIdentityStrategy } from "../auth/proxyIdentity.js";
import type { IdentityStrategy } from "../auth/proxyIdentity.js";
import type {
  AccountScheduler,
  PickResult,
  ReleaseInput,
} from "../account-pool/scheduler.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { RateLimitRedis } from "../middleware/rateLimit.js";
import type { PricingCache, ModelPricing } from "../billing/pricing.js";
import { createLogger } from "../logging/logger.js";
import { setPoolOverride, resetPool } from "../db/index.js";
import type { Pool } from "pg";

// ─── 通用构件 ─────────────────────────────────────────────────────────────

/** 64 个 hex 字符的 secret(随机)。 */
function makeSecretHex(): string {
  const buf = createHash("sha256")
    .update(randomUUID())
    .digest();
  return buf.toString("hex"); // 64 chars
}

/** 给 identityRepo 返回的 row.secret_hash:Buffer = SHA-256(raw 32 字节)。 */
function hashSecretBytes(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

// 固定 32 字节 KMS key,用于伪造 claude_accounts.oauth_token_enc / refresh 解密通过
const TEST_KMS_KEY = Buffer.alloc(32, 7);

/** AES-256-GCM encrypt to {ct: Buffer(ciphertext||tag), nonce: Buffer(12)} */
function aeadEncrypt(plaintext: string): { ct: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TEST_KMS_KEY, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct: Buffer.concat([enc, tag]), nonce };
}

const FIXED_PRICING: ModelPricing = {
  model_id: "claude-sonnet-4-6",
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

const DEEPSEEK_PRICING: ModelPricing = {
  ...FIXED_PRICING,
  model_id: "deepseek-v4-pro",
  display_name: "DeepSeek V4 Pro",
};

/** 一个完整 SSE 流: message_start 带 input usage + message_delta 带 stop_reason + final usage。 */
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

// ─── Mock pg Pool — explicit allowlist,unknown SQL 抛错 ─────────────────────
//
// 行为约定:
//   * INSERT INTO request_finalize_journal → { rows: [], rowCount: 1 }
//   * UPDATE request_finalize_journal      → { rows: [], rowCount: 1 }
//   * INSERT INTO usage_records            → { rows: [{id: '1'}], rowCount: 1 }
//   * SELECT credits FROM users            → { rows: [{credits: '<userCredits>'}], rowCount: 1 }
//   * UPDATE users SET credits             → { rows: [], rowCount: 1 }
//   * INSERT INTO credit_ledger            → { rows: [{id: '101'}], rowCount: 1 }
//   * UPDATE usage_records SET ledger_id   → { rows: [], rowCount: 1 }
//   * SELECT a.id ... FROM claude_accounts → 取决于 claudeAccount override
//   * BEGIN / COMMIT / ROLLBACK            → { rows: [], rowCount: 0 }
//
// 任何 query 都记录在 pool.queries 数组,便于断言 SQL 序列。
// **未识别的 SQL prefix 抛 Error("unknown SQL in fakePool")** —— 让未来的源码改
// 动若沉默引入新 query 立即在测试里炸开,而不是走入"默认 happy fallthrough"
// 隐藏行为偏移。

interface FakePoolOverride {
  /** 让 startInflightJournal 抛错(invariant 1c)。 */
  failJournalInsert?: Error;
  /** 让 settleUsageAndLedger 的 BEGIN 抛错。 */
  failSettleBegin?: Error;
  /** 用户余额(分,默认 99_999_999 = 充足)。 */
  userCredits?: bigint;
  /** 注入 claude_accounts row;不注入则 SELECT a.id ... 返空(refreshAccountToken → account_not_found)。 */
  claudeAccount?: {
    id: string;
    plan: string;
    token: string;
    refresh: string | null;
    expiresAt: Date | null;
  };
}

function buildFakePool(override: FakePoolOverride = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];

  const handle = (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    const trimmed = sql.trim();
    const head = trimmed.slice(0, 64).toUpperCase();

    // BEGIN / COMMIT / ROLLBACK (transaction control)
    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    // SET LOCAL ... (statement_timeout 等 — 不实际生效,允许通过)
    if (head.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };

    if (head.startsWith("INSERT INTO REQUEST_FINALIZE_JOURNAL")) {
      if (override.failJournalInsert) throw override.failJournalInsert;
      return { rows: [], rowCount: 1 };
    }
    if (head.startsWith("UPDATE REQUEST_FINALIZE_JOURNAL")) {
      return { rows: [], rowCount: 1 };
    }
    if (head.startsWith("INSERT INTO USAGE_RECORDS")) {
      return { rows: [{ id: "1" }], rowCount: 1 };
    }
    // 兼容 getBalance 与 settleUsageAndLedger 的 select(SELECT credits::text AS credits)
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
    // maybeUpdateAccountQuota → UPDATE claude_accounts SET quota_5h_pct = ...
    // 故意 allowlist 但**不在 deepseek 用例中应被触发** —— deepseek 路径 pick=null,
    // 结构上跳过此 SQL;若 future bug 在 deepseek 路径误调,会被
    // `pool.queries.filter(/UPDATE CLAUDE_ACCOUNTS/i)` 直接捕获(见 invariant 4)。
    if (head.startsWith("UPDATE CLAUDE_ACCOUNTS SET")) {
      return { rows: [], rowCount: 1 };
    }
    // refreshAccountToken → getTokenForUse 查 claude_accounts
    // store.ts L523-548 query: SELECT a.id::text AS id, a.plan, a.oauth_token_enc, ...
    if (head.startsWith("SELECT A.ID::TEXT AS ID, A.PLAN")) {
      if (!override.claudeAccount) {
        return { rows: [], rowCount: 0 };
      }
      const acc = override.claudeAccount;
      const tokenEnc = aeadEncrypt(acc.token);
      const refreshEnc = acc.refresh !== null ? aeadEncrypt(acc.refresh) : null;
      return {
        rows: [{
          id: acc.id,
          plan: acc.plan,
          oauth_token_enc: tokenEnc.ct,
          oauth_nonce: tokenEnc.nonce,
          oauth_refresh_enc: refreshEnc ? refreshEnc.ct : null,
          oauth_refresh_nonce: refreshEnc ? refreshEnc.nonce : null,
          oauth_expires_at: acc.expiresAt,
          egress_proxy: null,
          egress_host_id: null,
          egress_host: null,
          egress_host_fp: null,
          egress_host_psk_nonce: null,
          egress_host_psk_ct: null,
          pool_url_enc: null,
          pool_url_nonce: null,
        }],
        rowCount: 1,
      };
    }

    throw new Error(`unknown SQL in fakePool: ${trimmed.slice(0, 120)}`);
  };

  const fakeClient = {
    async query(sql: string, params: unknown[] = []) {
      if (sql === "BEGIN" && override.failSettleBegin) throw override.failSettleBegin;
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
    // db/index closePool() 在 resetPool 中要求,fake 提供 noop
    async end() { /* noop */ },
  };
  return pool;
}

// ─── Mock 其它 deps ─────────────────────────────────────────────────────────

function buildFakeIdentityRepo(opts: {
  containerId: number;
  userId: number;
  secretHex: string;
  hostUuid: string;
  boundIp: string;
}): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== opts.hostUuid || boundIp !== opts.boundIp) return null;
      return {
        id: opts.containerId,
        user_id: opts.userId,
        bound_ip: opts.boundIp,
        host_uuid: opts.hostUuid,
        secret_hash: hashSecretBytes(opts.secretHex),
      };
    },
  };
}

interface PreCheckSpy {
  redis: PreCheckRedis;
  reserveCalls: Array<{ userId: string; requestId: string; maxCost: string }>;
  releaseCalls: Array<{ userId: string; requestId: string }>;
}

function buildFakePreCheckRedis(releaseOrder?: string[]): PreCheckSpy {
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
      releaseOrder?.push("preCheck");
      return true;
    },
  };
  return { redis, reserveCalls, releaseCalls };
}

function buildFakeRateLimitRedis() {
  // 永远 incr 返 1(首次窗口),expire noop。
  let counter = 0;
  const redis: RateLimitRedis = {
    async incr() {
      counter++;
      return counter;
    },
    async expire() {
      return 1;
    },
  };
  return redis;
}

interface PickSpec {
  pinned_user_id?: string;
  account_id?: bigint;
  expires_at?: Date | null;
  envelope_version?: number;
  fingerprint_salt?: Buffer;
}

interface SchedulerSpy {
  scheduler: AccountScheduler;
  pickCalls: unknown[];
  releaseCalls: ReleaseInput[];
  setPickError(err: Error | null): void;
  setPickSpec(spec: PickSpec | null): void;
}

function buildFakeScheduler(initialSpec: PickSpec | null = {}, releaseOrder?: string[]): SchedulerSpy {
  let pickError: Error | null = null;
  let pickSpec: PickSpec | null = initialSpec;
  const pickCalls: unknown[] = [];
  const releaseCalls: ReleaseInput[] = [];

  const scheduler = {
    async pick(input: unknown): Promise<PickResult> {
      pickCalls.push(input);
      if (pickError) throw pickError;
      if (!pickSpec) throw new Error("pickSpec=null but pick called");
      const pinned = pickSpec.pinned_user_id ??
        // 0067 schema:64-char lowercase hex
        createHash("sha256").update("test-device").digest("hex");
      return {
        account_id: pickSpec.account_id ?? 1001n,
        plan: "pro",
        token: Buffer.from("FAKE-TOKEN-VALUE"),
        refresh: null,
        expires_at: pickSpec.expires_at ?? null, // null → 不触发 refresh
        egress_proxy: null,
        egress_target: null,
        pinned_user_id: pinned,
        envelope_version: pickSpec.envelope_version ?? 1,
        fingerprint_salt: pickSpec.fingerprint_salt ?? Buffer.alloc(16),
      };
    },
    async release(input: ReleaseInput): Promise<void> {
      releaseCalls.push(input);
      releaseOrder?.push("scheduler");
    },
  } as unknown as AccountScheduler;

  return {
    scheduler,
    pickCalls,
    releaseCalls,
    setPickError(e) { pickError = e; },
    setPickSpec(s) { pickSpec = s; },
  };
}

function buildFakePricing(models: ModelPricing[] = [FIXED_PRICING]): PricingCache {
  const m = new Map(models.map((p) => [p.model_id, p]));
  return {
    get(id: string) {
      return m.get(id) ?? null;
    },
  } as unknown as PricingCache;
}

// ─── Mock IncomingMessage / ServerResponse ─────────────────────────────────

class MockReq extends Readable {
  url = "/v1/messages";
  method = "POST";
  headers: Record<string, string>;
  constructor(bodyJson: unknown, headersExtra: Record<string, string> = {}) {
    super();
    this.headers = {
      host: "x.invalid",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headersExtra,
    };
    const buf = Buffer.from(JSON.stringify(bodyJson));
    this.push(buf);
    this.push(null);
  }
  // Node IncomingMessage 接口要求,但 handler 不会调
  socket = { remoteAddress: "172.30.0.10" } as unknown as IncomingMessage["socket"];
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
  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  bodyJson(): unknown {
    return JSON.parse(this.bodyText());
  }
}

// ─── 完整 harness builder ──────────────────────────────────────────────────

interface HarnessOpts {
  poolOverride?: FakePoolOverride;
  pickSpec?: PickSpec | null;
  pricings?: ModelPricing[];
  /** 注入 fetch:测试上游响应 */
  fetchImpl?: typeof fetch;
  /** 用户 model authz:默认 user role + 空 grants */
  authz?: { role: "user" | "admin"; grantedModelIds: ReadonlySet<string> };
  /** loadUserModelAuthz throw → 模拟 500 路径 */
  authzError?: Error;
  /** deepseekApiKey 注入 */
  deepseekApiKey?: string;
  /** 注入 refreshDeps 启用 refresh 路径(为 invariant 1(b) 用)。 */
  refreshHttpPost?: (
    url: string,
    headers: Record<string, string>,
    body: string,
    dispatcher?: unknown,
  ) => Promise<{ status: number; body: string }>;
  /** appendCostCredits 自定义实现(覆盖默认 push events.persist)。 */
  appendCostCreditsImpl?: AnthropicProxyDeps["appendCostCredits"];
  /**
   * 注入自定义 IdentityStrategy(默认走 container strategy)。
   *
   * Phase 1.5(2026-05-21):为外接 ApiKey 路径(`containerId === null`)的 handler
   * integ 测试预留 seam。production wiring 在 anthropicProxyRoutes 内构造 strategy,
   * 测试这里直接传 fake 即可绕开容器双因子构造 / DB row,聚焦验证
   * `isExternalApiKeyOAuthPath` 分流是否正确把 `accountKind` 透传到 scheduler.pick。
   */
  identityStrategyOverride?: IdentityStrategy;
}

const FIXED_USER_ID = 7;
const FIXED_CONTAINER_ID = 42;
const FIXED_HOST_UUID = "host-self";
const FIXED_BOUND_IP = "172.30.0.10";
const FIXED_ACCOUNT_ID = 1001n;
const FIXED_PINNED_USER_ID = createHash("sha256")
  .update("test-pinned-account")
  .digest("hex");

function buildHarness(opts: HarnessOpts = {}) {
  const secretHex = makeSecretHex();
  const identityRepo = buildFakeIdentityRepo({
    containerId: FIXED_CONTAINER_ID,
    userId: FIXED_USER_ID,
    secretHex,
    hostUuid: FIXED_HOST_UUID,
    boundIp: FIXED_BOUND_IP,
  });
  const pool = buildFakePool(opts.poolOverride);
  // 注入到 db/index 模块 singleton — preCheckWithCost 内部 getBalance() 走模块 pool
  setPoolOverride(pool as unknown as Pool);
  // 共享的 release 顺序数组:用于 invariant 1(c) 等场景锁住 scheduler.release 先于 preCheck release
  const releaseOrder: string[] = [];
  const preCheckSpy = buildFakePreCheckRedis(releaseOrder);
  const rateLimitRedis = buildFakeRateLimitRedis();
  const initialPickSpec: PickSpec = {
    pinned_user_id: FIXED_PINNED_USER_ID,
    account_id: FIXED_ACCOUNT_ID,
    ...(opts.pickSpec ?? {}),
  };
  const schedulerSpy = buildFakeScheduler(
    opts.pickSpec === null ? null : initialPickSpec,
    releaseOrder,
  );
  const pricing = buildFakePricing(opts.pricings ?? [FIXED_PRICING, DEEPSEEK_PRICING]);

  const appendCostCreditsCalls: Array<{
    requestId: string;
    userId: string;
    costCredits: string;
  }> = [];
  const broadcastCalls: Array<{ uid: bigint; payload: unknown }> = [];
  const events: string[] = []; // 顺序追踪 (persist→broadcast)

  const refreshDeps = opts.refreshHttpPost
    ? {
        http: { post: opts.refreshHttpPost },
        keyFn: () => Buffer.from(TEST_KMS_KEY),
      }
    : undefined;

  // In-memory logger sink:每条 emit 出来的 JSON line 都 parse 进 logEvents。
  // 测试断言走 logEvents.some(e => e.msg === "proxy_refresh_failed" && e.code === ...) —
  // 这把"log evidence"从 grep 升格为 test-level 不变量。
  // level=trace 收全部,即使将来某条降级到 debug 也照样捕获。
  const logEvents: Array<Record<string, unknown>> = [];
  const testLogger = createLogger({
    level: "trace",
    base: { test: "anthropicProxy.integ" },
    out: (line: string) => {
      try {
        logEvents.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* 跳过非 JSON 行(不应该出现,但兜底) */
      }
    },
  });

  // V3 Phase 2(2026-05-18):身份层 strategy 物理切出后,把 loadUserModelAuthz
  // 行为留在 harness 闭包,strategy 透传。setAuthz() 让既有测试通过覆写一行就能
  // 调整 authz 实现(原来直接覆写 h.deps.loadUserModelAuthz)。
  // recordHostRequest 注入为可计数的 spy:绕开模块级全局 counter,允许测试断言
  // "post-auth 流量计数只在 verify 成功后 fire,且 authz deny 不回滚"。
  let authzImpl: (
    uid: bigint,
  ) => Promise<{ role: "user" | "admin"; grantedModelIds: ReadonlySet<string> }> =
    async () => {
      if (opts.authzError) throw opts.authzError;
      return opts.authz ?? {
        role: "user",
        grantedModelIds: new Set<string>(),
      };
    };
  const recordHostRequestCalls: string[] = [];
  const identityStrategy: IdentityStrategy = opts.identityStrategyOverride
    ?? makeContainerIdentityStrategy({
      repo: identityRepo,
      pricing,
      loadUserModelAuthz: (uid) => authzImpl(uid),
      recordHostRequest: (hostUuid) => {
        recordHostRequestCalls.push(hostUuid);
      },
    });

  const deps: AnthropicProxyDeps = {
    pgPool: pool as unknown as AnthropicProxyDeps["pgPool"],
    pricing,
    preCheckRedis: preCheckSpy.redis,
    scheduler: schedulerSpy.scheduler,
    identity: identityStrategy,
    rateLimitRedis,
    fetchImpl: opts.fetchImpl ?? (async () =>
      sseResponse(200, makeFullSseChunks())),
    upstreamEndpoint: "https://upstream.test/v1/messages",
    refreshDeps,
    logger: testLogger,
    deepseekApiKey: opts.deepseekApiKey,
    appendCostCredits: opts.appendCostCreditsImpl
      ?? (async (requestId, userIdArg, costCredits) => {
        appendCostCreditsCalls.push({ requestId, userId: userIdArg, costCredits });
        events.push("persist");
      }),
    broadcastToUser: (uid, payload) => {
      broadcastCalls.push({ uid, payload });
      events.push("broadcast");
    },
  };

  const handler = makeAnthropicProxyHandler(deps);

  const ctx: AnthropicProxyIdentityCtx = { hostUuid: FIXED_HOST_UUID, boundIp: FIXED_BOUND_IP };
  const token = `oc-v3.${FIXED_CONTAINER_ID}.${secretHex}`;

  async function run(
    body: Record<string, unknown>,
    extraReqHeaders: Record<string, string> = {},
  ): Promise<MockRes> {
    const req = new MockReq(body, {
      authorization: `Bearer ${token}`,
      ...extraReqHeaders,
    });
    const res = new MockRes();
    await handler(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      ctx,
    );
    return res;
  }

  return {
    deps,
    handler,
    run,
    pool,
    schedulerSpy,
    preCheckSpy,
    releaseOrder,
    appendCostCreditsCalls,
    broadcastCalls,
    events,
    logEvents,
    ctx,
    /** 覆写 strategy 内部的 loadUserModelAuthz 闭包(替代旧 `h.deps.loadUserModelAuthz = ...`)。 */
    setAuthz(
      fn: (uid: bigint) => Promise<{
        role: "user" | "admin";
        grantedModelIds: ReadonlySet<string>;
      }>,
    ) {
      authzImpl = fn;
    },
    /** Phase 2 obs spy:strategy.resolve 内部触发的 recordHostRequest 调用记录。 */
    recordHostRequestCalls,
  };
}

// 每个 test 跑完都重置 module-level pool override(避免泄漏到下个 test)
afterEach(async () => {
  await resetPool();
});

/** sendJsonError 输出 `{error: {code, message}}` —— body.error.code 才是 code。 */
function readErrCode(res: MockRes): string | undefined {
  const j = res.bodyJson() as { error?: { code?: string } };
  return j.error?.code;
}

// 一个最小可用 body(默认非 deepseek)
function minBody(modelOverride?: string): Record<string, unknown> {
  return {
    model: modelOverride ?? "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
}

// ─── 不变量 (1):Release ownership 4 阶段 ─────────────────────────────────

describe("invariant 1 — release ownership 4 阶段铁律", () => {
  // V3 envv2 Phase 4 (2026-05-21) 顺序调整后铁律:
  //   pickUpstream 现在跑在 preCheck **之前**(为了让 v2 envelope normalize 拿到
  //   session.fingerprintSalt)。所以 stage (a) pool_busy / stage (b*) refresh_failed
  //   触发时 **preCheck 从未 reserve 过**,无须 release。
  //   stage (c) journal_failed 已在 preCheck 成功之后,仍需双侧 release(顺序锁 scheduler→preCheck)。

  // (a) pick 失败 → 无任何 release;preCheck 从未 reserve
  test("(a) scheduler.pick 抛 AccountPoolBusy → 既无 scheduler.release 也无 preCheck.reserve/release", async () => {
    const h = buildHarness();
    const { AccountPoolBusyError } = await import("../account-pool/scheduler.js");
    h.schedulerSpy.setPickError(new AccountPoolBusyError("all busy"));

    const res = await h.run(minBody());
    assert.equal(res.statusCode, 429, "pool busy → 429");
    assert.equal(
      h.schedulerSpy.releaseCalls.length,
      0,
      "stage (a): 不应调用 scheduler.release(pick 失败 → 未占账号)",
    );
    assert.equal(
      h.preCheckSpy.reserveCalls.length,
      0,
      "stage (a): pickUpstream 在 preCheck 之前 → preCheck 从未 reserve",
    );
    assert.equal(
      h.preCheckSpy.releaseCalls.length,
      0,
      "stage (a): preCheck 既未 reserve 也无 release",
    );
    assert.deepEqual(h.releaseOrder, [], "stage (a): release 调用链空");
  });

  // (b1) refresh RefreshError(account_not_found) → kind="failure"
  // 触发方式:expires_at 已过期 + refreshDeps 配置好,但 fakePool 没有 claudeAccount
  // → getTokenForUse 返 null → RefreshError("account_not_found")
  test("(b1) refresh 失败 RefreshError(account_not_found, 非 transient) → scheduler.release({failure}) + releasePreCheck + 502", async () => {
    const h = buildHarness({
      // 不注入 claudeAccount → SELECT a.id 返空 → RefreshError("account_not_found")
      pickSpec: { expires_at: new Date(0) }, // 强制 shouldRefresh=true
      refreshHttpPost: async () => {
        // 永远不会被调用 — getTokenForUse 先返 null 抛 account_not_found
        throw new Error("http should not be called");
      },
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 502, "refresh fail → 502");
    assert.equal(readErrCode(res), "UPSTREAM_AUTH_REFRESH_FAILED");
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "failure",
      "account_not_found 不是 network_transient → kind=failure(扣健康分)",
    );
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.account_id,
      FIXED_ACCOUNT_ID,
      "release 必须带 pick.account_id",
    );
    assert.equal(
      h.preCheckSpy.reserveCalls.length,
      0,
      "(b1) pickUpstream 在 preCheck 之前 → preCheck 从未 reserve",
    );
    assert.equal(
      h.preCheckSpy.releaseCalls.length,
      0,
      "(b1) preCheck 未 reserve 自然不 release",
    );
    assert.deepEqual(h.releaseOrder, ["scheduler"], "(b1) 只有 scheduler.release 一次");
    // MINOR 1:把 "code 分类" 从 grep 升格为 test 级断言
    const refreshFail = h.logEvents.find(
      (e) => e["msg"] === "proxy_refresh_failed",
    );
    assert.ok(refreshFail, "(b1) 必须发 proxy_refresh_failed 日志");
    assert.equal(
      refreshFail!["code"],
      "account_not_found",
      "(b1) 日志 code=account_not_found(对应 getTokenForUse 返 null)",
    );
    assert.equal(refreshFail!["transient"], false, "(b1) account_not_found 不算 transient");
  });

  // (b2) refresh RefreshError(network_transient) → kind="transient_network"
  // 触发方式:有效 claudeAccount + http.post 抛网络错 → catch 包成 network_transient
  test("(b2) refresh 失败 RefreshError(network_transient) → scheduler.release({transient_network})", async () => {
    const h = buildHarness({
      poolOverride: {
        claudeAccount: {
          id: FIXED_ACCOUNT_ID.toString(),
          plan: "pro",
          token: "ANTHROPIC_TOKEN_OLD",
          refresh: "REFRESH_TOKEN_OLD",
          expiresAt: new Date(0),
        },
      },
      pickSpec: { expires_at: new Date(0) },
      refreshHttpPost: async () => {
        // 模拟代理 / DNS / TLS 抖动:fetch 抛 generic Error
        throw new Error("ECONNREFUSED upstream OAuth endpoint");
      },
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 502);
    assert.equal(readErrCode(res), "UPSTREAM_AUTH_REFRESH_FAILED");
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "transient_network",
      "网络层抖动 → transient_network(不扣健康分)— 这条铁律决定了代理一抖整池不被烧",
    );
    assert.equal(
      h.preCheckSpy.reserveCalls.length,
      0,
      "(b2) pickUpstream 在 preCheck 之前 → preCheck 从未 reserve",
    );
    assert.equal(h.preCheckSpy.releaseCalls.length, 0, "(b2) preCheck 未 reserve 不 release");
    assert.deepEqual(h.releaseOrder, ["scheduler"], "(b2) 只有 scheduler.release 一次");
    // MINOR 1:code 分类是 transient_network(代理一抖整池不被烧的核心字段)
    const refreshFail = h.logEvents.find(
      (e) => e["msg"] === "proxy_refresh_failed",
    );
    assert.ok(refreshFail, "(b2) 必须发 proxy_refresh_failed 日志");
    assert.equal(
      refreshFail!["code"],
      "network_transient",
      "(b2) 日志 code=network_transient(http.post 抛 generic Error → catch 包成)",
    );
    assert.equal(refreshFail!["transient"], true, "(b2) network_transient 必须 transient=true");
  });

  // (b3) refresh RefreshError(http_error 4xx) → kind="failure"
  // 触发方式:有效 claudeAccount + http.post 返 401 → isTransientHttpStatus(401)=false → http_error
  test("(b3) refresh 失败 RefreshError(http_error 401) → scheduler.release({failure})", async () => {
    const h = buildHarness({
      poolOverride: {
        claudeAccount: {
          id: FIXED_ACCOUNT_ID.toString(),
          plan: "pro",
          token: "ANTHROPIC_TOKEN_OLD",
          refresh: "REFRESH_TOKEN_OLD",
          expiresAt: new Date(0),
        },
      },
      pickSpec: { expires_at: new Date(0) },
      refreshHttpPost: async () => ({ status: 401, body: '{"error":"invalid_grant"}' }),
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 502);
    assert.equal(readErrCode(res), "UPSTREAM_AUTH_REFRESH_FAILED");
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "failure",
      "HTTP 401 = 永久拒绝 → failure(扣健康分,符合 disableOnFailure 语义)",
    );
    assert.equal(
      h.preCheckSpy.reserveCalls.length,
      0,
      "(b3) pickUpstream 在 preCheck 之前 → preCheck 从未 reserve",
    );
    assert.equal(h.preCheckSpy.releaseCalls.length, 0, "(b3) preCheck 未 reserve 不 release");
    assert.deepEqual(h.releaseOrder, ["scheduler"], "(b3) 只有 scheduler.release 一次");
    // MINOR 1:401 这种永久拒绝必须分类为 http_error,不能错误归到 network_transient
    // 否则 disableOnFailure 语义破坏(账号永久挂了反而不扣健康分)
    const refreshFail = h.logEvents.find(
      (e) => e["msg"] === "proxy_refresh_failed",
    );
    assert.ok(refreshFail, "(b3) 必须发 proxy_refresh_failed 日志");
    assert.equal(
      refreshFail!["code"],
      "http_error",
      "(b3) 日志 code=http_error(401 走 isTransientHttpStatus=false 分支)",
    );
    assert.equal(refreshFail!["transient"], false, "(b3) http_error 不算 transient");
  });

  // (c) startInflightJournal 失败 → scheduler.release({failure}) + releasePreCheck
  // 顺序锁:scheduler.release 必须先于 preCheck release(避免"账号未释放前已宣告 quota 退还"
  // 的窗口期被并发 reserve 撞上)
  test("(c) journal INSERT 抛错 → scheduler.release({failure}) 先 → preCheck release 后", async () => {
    const h = buildHarness({
      poolOverride: { failJournalInsert: new Error("journal-down") },
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 500, "journal 失败应 500 INTERNAL");
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(h.schedulerSpy.releaseCalls[0]!.result.kind, "failure");
    assert.equal(h.schedulerSpy.releaseCalls[0]!.account_id, FIXED_ACCOUNT_ID);
    assert.equal(h.preCheckSpy.releaseCalls.length, 1);
    assert.deepEqual(
      h.releaseOrder,
      ["scheduler", "preCheck"],
      "stage (c) 顺序铁律:scheduler.release 必须先,preCheck release 后",
    );
  });

  // (d) 正常 commit → finalize 接管,scheduler.release 一次,kind=success
  test("(d) normal commit → finalize 一次性释放,kind='success'", async () => {
    const h = buildHarness();
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 200);
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(h.schedulerSpy.releaseCalls[0]!.result.kind, "success");
    assert.equal(h.schedulerSpy.releaseCalls[0]!.account_id, FIXED_ACCOUNT_ID);
    assert.equal(h.preCheckSpy.releaseCalls.length, 1);
  });

  // V3 envv2 Phase 4(2026-05-21 Codex plan-review #1+#2 采纳)新路径:
  //   pickUpstream 在 preCheck **之前**,所以 preCheck 抛 InsufficientCredits 时 session 已
  //   ready,handler 必须 release。但用户余额问题不该扣账号健康分 → kind='client_error'
  //   (scheduler.release ReleaseResult 注释:client_error 只 dec inflight,不进 cooldown)。
  //   atomicReserve 在 preCheckWithCost 内被 `balance ≤ 0` 提前拦下 — Redis 端无 reservation。
  test("(d insufficient_credits) preCheck 抛 InsufficientCredits → scheduler.release({client_error}) + 402 + 无 preCheck reserve", async () => {
    const h = buildHarness({ poolOverride: { userCredits: 0n } });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 402, "balance=0 应 402 INSUFFICIENT_CREDITS");
    assert.equal(readErrCode(res), "INSUFFICIENT_CREDITS");
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "client_error",
      "余额不足是用户问题,**不扣**账号健康分(否则单个穷用户能把账号刷进 cooldown)",
    );
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.account_id,
      FIXED_ACCOUNT_ID,
      "release 必须带 pick.account_id",
    );
    assert.equal(
      h.preCheckSpy.reserveCalls.length,
      0,
      "balance≤0 在 atomicReserve 之前抛 → Redis 端从未 reserve",
    );
    assert.equal(
      h.preCheckSpy.releaseCalls.length,
      0,
      "preCheck 未 reserve 不 release",
    );
    assert.deepEqual(h.releaseOrder, ["scheduler"], "只有 scheduler.release 一次");
  });

  // (d) negative — upstream 5xx error → finalize.fail,kind=failure
  test("(d negative) upstream 5xx → finalize.fail,kind='failure'", async () => {
    const h = buildHarness({
      fetchImpl: async () =>
        new Response("oops", { status: 503 }),
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 502, "上游 5xx 翻 502");
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(h.schedulerSpy.releaseCalls[0]!.result.kind, "failure");
    assert.equal(h.preCheckSpy.releaseCalls.length, 1);
  });

  // (d) negative — upstream 400 invalid_request_error → failClient,kind=client_error
  test("(d negative) upstream 400 invalid_request_error → finalize.failClient,kind='client_error'", async () => {
    const h = buildHarness({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { type: "invalid_request_error", message: "bad sig" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 502);
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "client_error",
      "invalid_request_error 不扣账号健康分 — 必须走 client_error",
    );
  });
});

// ─── 不变量 (5):模型门关 fail-closed,且在 authz / preCheck / pick 之前 ─────

describe("invariant 5 — 模型门关:pricing.enabled=false → 400 UNKNOWN_MODEL", () => {
  test("pricing.get(model)=null → 400 + authz/preCheck.atomicReserve/scheduler.pick 全未调用", async () => {
    let authzCalled = false;
    const h = buildHarness({ pricings: [] });
    h.setAuthz(async () => {
      authzCalled = true;
      return { role: "user", grantedModelIds: new Set() };
    });
    const res = await h.run(minBody("claude-sonnet-4-6"));
    assert.equal(res.statusCode, 400);
    assert.equal(readErrCode(res), "UNKNOWN_MODEL");
    // 三道锁,缺一不可:位置位于 authz / preCheck / pick 之前
    assert.equal(
      authzCalled,
      false,
      "loadUserModelAuthz 不能在 model gate 之前调用(fail-closed 顺序)",
    );
    assert.equal(
      h.preCheckSpy.reserveCalls.length,
      0,
      "preCheck.atomicReserve 必须在 model gate 之后(否则 UNKNOWN_MODEL 会先吃 Redis quota 配额)",
    );
    assert.equal(
      h.schedulerSpy.pickCalls.length,
      0,
      "scheduler.pick 必须在 model gate 之后(否则 UNKNOWN_MODEL 会占账号 inflight)",
    );
    // release 由"没分配"自动 0 次(已被上面 reserveCalls/pickCalls=0 蕴含)
    assert.equal(h.schedulerSpy.releaseCalls.length, 0);
    assert.equal(h.preCheckSpy.releaseCalls.length, 0);
  });

  test("pricing.enabled=false → 400 + 顺序锁同上", async () => {
    const disabled: ModelPricing = { ...FIXED_PRICING, enabled: false };
    let authzCalled = false;
    const h = buildHarness({ pricings: [disabled] });
    h.setAuthz(async () => {
      authzCalled = true;
      return { role: "user", grantedModelIds: new Set() };
    });
    const res = await h.run(minBody("claude-sonnet-4-6"));
    assert.equal(res.statusCode, 400);
    assert.equal(readErrCode(res), "UNKNOWN_MODEL");
    assert.equal(authzCalled, false);
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls.length, 0);
  });

  test("pricing.visibility='admin' + user role + 无 grant → 403 NOT_AUTHORIZED(在 model gate **之后**,preCheck/pick **之前**)", async () => {
    const adminOnly: ModelPricing = { ...FIXED_PRICING, visibility: "admin" };
    let authzCalled = false;
    const h = buildHarness({ pricings: [adminOnly] });
    h.setAuthz(async () => {
      authzCalled = true;
      return { role: "user", grantedModelIds: new Set() };
    });
    const res = await h.run(minBody("claude-sonnet-4-6"));
    assert.equal(res.statusCode, 403);
    assert.equal(readErrCode(res), "NOT_AUTHORIZED");
    assert.equal(authzCalled, true, "authz 在 model gate 通过后必须被调");
    // authz 失败后,后续不应继续到 preCheck / pick
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls.length, 0);
  });
});

// ─── Phase 2 新增 invariant 组(Codex 评审建议)── 身份策略边界 ────────────────
//
// 这些测试不再属于"模型门关"语义,而是 Phase 2 IdentityStrategy 抽出后新增的
// 三联耦合 invariant(身份双因子 + post-auth metric + 401 errcode 透传)。
// 单独成 describe 是为了让未来读者一眼看出:这些是 strategy 契约的护栏,
// 不是 pricing.enabled 门关的延伸。
//
// 避免的回归:
//  (a) 新 strategy 实现时把 recordHostRequest 漏掉,导致 oncall 流量计数失踪
//  (b) 把 recordHostRequest 错位到 verify 之前 / authz 之后,导致"未授权流量被计数"
//  (c) identity 401 路径漏掉 metric `incrAnthropicProxyReject("identity")` 计数

describe("Phase 2 — identity strategy boundary invariants", () => {
  test("identity 成功 + authz 403 deny → recordHostRequest 仍 fire 一次(post-auth = 身份通过,不是模型授权通过)", async () => {
    const adminOnly: ModelPricing = { ...FIXED_PRICING, visibility: "admin" };
    const h = buildHarness({ pricings: [adminOnly] });
    h.setAuthz(async () => ({ role: "user", grantedModelIds: new Set() }));
    const res = await h.run(minBody("claude-sonnet-4-6"));
    assert.equal(res.statusCode, 403);
    assert.equal(readErrCode(res), "NOT_AUTHORIZED");
    assert.deepEqual(
      h.recordHostRequestCalls,
      [FIXED_HOST_UUID],
      "post-auth recordHostRequest 在 verify 成功后立即 fire,authz deny 不回滚 — " +
      "证明 post-auth ≡ 身份双因子通过,不依赖模型授权",
    );
  });

  test("identity 验证失败(BAD_SECRET)→ 401 + log proxy_identity_failed{errcode=BAD_SECRET} + metric identity + recordHostRequest 不 fire", async () => {
    const h = buildHarness();
    // 构造一个错的 Authorization header:secret 段不匹配
    const wrongSecret = "f".repeat(64);
    const badToken = `oc-v3.${FIXED_CONTAINER_ID}.${wrongSecret}`;
    const req = new MockReq(minBody(), { authorization: `Bearer ${badToken}` });
    const res = new MockRes();
    await h.handler(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      h.ctx,
    );
    assert.equal(res.statusCode, 401);
    const j = res.bodyJson() as { error?: { code?: string } };
    assert.equal(
      j.error?.code,
      "UNAUTHORIZED",
      "401 response code 锁 UNAUTHORIZED(body 不外泄 errcode)",
    );
    // log evidence:errcode 必须出现在 server log 里,不能因 strategy 包装丢失
    const identityFailedLog = h.logEvents.find(
      (e) => e.msg === "proxy_identity_failed",
    );
    assert.ok(
      identityFailedLog,
      "proxy_identity_failed log 必须 fire — Phase 2 strategy 包装不能吞 errcode 信号",
    );
    assert.equal(
      identityFailedLog?.errcode,
      "BAD_SECRET",
      "errcode 透传:IdentityError.code 等于原 ContainerIdentityError.code",
    );
    // recordHostRequest 不能 fire(verify 不通过不算成功请求)
    assert.equal(
      h.recordHostRequestCalls.length,
      0,
      "post-auth recordHostRequest 必须只在 verify 成功后 fire — 失败路径不能污染流量统计",
    );
    // preCheck / pick / authz 全都不能调
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.schedulerSpy.pickCalls.length, 0);
  });
});

// ─── 不变量 (3):Post-commit persist→broadcast 顺序 + gate + fail-soft ──────

describe("invariant 3 — post-commit persist → broadcast 顺序 + gate + fail-soft", () => {
  test("正常 commit + debitedCredits>0 → 先 appendCostCredits,后 broadcastToUser", async () => {
    const h = buildHarness();
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 200);
    assert.equal(h.appendCostCreditsCalls.length, 1, "appendCostCredits 调用一次");
    assert.equal(h.broadcastCalls.length, 1, "broadcastToUser 调用一次");
    // 顺序锁:persist 必须在 broadcast 之前
    assert.deepEqual(
      h.events,
      ["persist", "broadcast"],
      "顺序:persist → broadcast",
    );
    // payload + args 校验(MINOR 7:不仅 count,还要锁 arg shape)
    assert.equal(h.appendCostCreditsCalls[0]!.userId, String(FIXED_USER_ID));
    assert.match(
      h.appendCostCreditsCalls[0]!.costCredits,
      /^\d+$/,
      "costCredits BigInt 字符串",
    );
    const payload = h.broadcastCalls[0]!.payload as { type?: string; costCredits?: string };
    assert.equal(payload.type, "outbound.cost_charged");
    assert.equal(payload.costCredits, h.appendCostCreditsCalls[0]!.costCredits, "broadcast 与 persist 用同一数值");
    assert.equal(h.broadcastCalls[0]!.uid, BigInt(FIXED_USER_ID));
  });

  test("commit 但 debitedCredits=0 (零 output token)→ persist 与 broadcast 都不调", async () => {
    const h = buildHarness({
      fetchImpl: async () =>
        sseResponse(
          200,
          makeFullSseChunks({ inputTok: 0, outputTok: 0 }),
        ),
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 200);
    // cost=0 → debitedCredits 路径:status='success' 但 cost_credits=0,
    // settleUsageAndLedger 不走 ledger 分支 → debitedCredits=null
    // → gate (committed && debitedCredits !== null && debitedCredits > 0n) = false
    assert.equal(h.appendCostCreditsCalls.length, 0);
    assert.equal(h.broadcastCalls.length, 0);
  });

  test("aborted(stream 抛错)→ persist 与 broadcast 都不调", async () => {
    const errStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.error(new Error("network reset mid-stream"));
      },
    });
    const h = buildHarness({
      fetchImpl: async () =>
        new Response(errStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    await h.run(minBody());
    // mid-stream error → finalize.fail → outcome.state='aborted' → gate=false
    assert.equal(h.appendCostCreditsCalls.length, 0);
    assert.equal(h.broadcastCalls.length, 0);
  });

  // MAJOR 5 (Codex CR):persist 抛错时 broadcast **必须仍然发**(fail-soft)。
  // 这条对应 anthropicProxy.ts L2258-2271 的 try/catch + 注释 "Failure here is
  // logged but does NOT block the broadcast"。重构若把 broadcast 放到 try 块内
  // 就会变成"persist 失败 broadcast 也丢"—— 本 test 锁住这条不变量。
  test("appendCostCredits 抛错 → broadcastToUser 仍然 fire(fail-soft 持久化语义)", async () => {
    const broadcastFiredAfterPersistThrow: string[] = [];
    const h = buildHarness({
      appendCostCreditsImpl: async () => {
        broadcastFiredAfterPersistThrow.push("persist-attempted");
        throw new Error("simulated DB write failure");
      },
    });
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 200);
    assert.equal(
      broadcastFiredAfterPersistThrow.length,
      1,
      "appendCostCredits 必须被调一次(即使会抛)",
    );
    assert.equal(
      h.broadcastCalls.length,
      1,
      "appendCostCredits throw 不能 short-circuit broadcast — in-page 即时更新仍需保证",
    );
  });
});

// ─── 不变量 (4):DeepSeek pick=null full noop set + 反向 claude 路径锚定 ─────

describe("invariant 4 — DeepSeek (pick=null) noop set + 反向 claude 锚定", () => {
  // DeepSeek strip 测试 — 明确传入 anthropic-beta + metadata.user_id,确保不是 vacuous
  // MINOR 2 加固:
  //   - 注入 refreshHttpPost spy 并断言 calls=0(直接证 refresh path 没 fire)
  //   - 上游响应**故意带 anthropic-ratelimit-unified-* 配额 headers**;如果 deepseek
  //     路径误调 maybeUpdateAccountQuota → fakePool 会捕获 `UPDATE claude_accounts`,
  //     断言 0 行 → 证明 pick=null 的 `if (pick)` 结构性 gate 真生效
  test("deepseek 模型:full noop set — strip beta + 保留 device_id + refresh 与 quota update 都不 fire", async () => {
    let upstreamHeaders: Record<string, string> | null = null;
    let upstreamUrl: string | null = null;
    let upstreamBody: { metadata?: { user_id?: unknown } } | null = null;
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      upstreamUrl = String(url);
      upstreamHeaders = init?.headers as Record<string, string>;
      upstreamBody = init?.body ? JSON.parse(String(init.body)) : null;
      // 故意带配额 headers:若 maybeUpdateAccountQuota 在 deepseek 路径误 fire,
      // 这些 headers 会触发 UPDATE claude_accounts;无 headers 时函数会 early-return,
      // 测试就退化为 vacuous(分不清"gate 生效" vs "headers 缺失")。
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl): void {
          const enc = new TextEncoder();
          for (const c of makeFullSseChunks()) ctrl.enqueue(enc.encode(c));
          ctrl.close();
        },
      });
      const resetEpoch = String(Math.floor(Date.now() / 1000) + 18000);
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          // util 是 fraction 0-1(Anthropic 文档约定),quota.ts parseUtil ×100 clamp
          "anthropic-ratelimit-unified-5h-utilization": "0.42",
          "anthropic-ratelimit-unified-5h-reset": resetEpoch,
          "anthropic-ratelimit-unified-7d-utilization": "0.30",
          "anthropic-ratelimit-unified-7d-reset": resetEpoch,
        },
      });
    }) as unknown as typeof fetch;

    // refreshHttpPost spy:deepseek 路径根本无 pick.expires_at 可触发 refresh,
    // calls 必须恒为 0。直接证 refresh path 在 pick=null 下被结构性绕开。
    const refreshHttpCalls: Array<{ url: string }> = [];
    const refreshHttpPost = async (
      url: string,
      _headers: Record<string, string>,
      _body: string,
      _dispatcher?: unknown,
    ): Promise<{ status: number; body: string }> => {
      refreshHttpCalls.push({ url });
      return { status: 200, body: "{}" };
    };

    const h = buildHarness({
      fetchImpl,
      deepseekApiKey: "DS-SECRET-KEY",
      pricings: [DEEPSEEK_PRICING, FIXED_PRICING],
      authz: { role: "user", grantedModelIds: new Set(["deepseek-v4-pro"]) },
      refreshHttpPost,
    });

    // 客户端 explicitly 传入 anthropic-beta 与 metadata.user_id(plain object JSON)
    const clientDeviceId = "client-original-device";
    const body = {
      ...minBody("deepseek-v4-pro"),
      metadata: { user_id: JSON.stringify({ device_id: clientDeviceId, session_id: "s1" }) },
    };
    const res = await h.run(body, {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });

    assert.equal(res.statusCode, 200);
    assert.equal(h.schedulerSpy.pickCalls.length, 0, "deepseek 不调 scheduler.pick");
    assert.equal(h.schedulerSpy.releaseCalls.length, 0, "deepseek 不调 scheduler.release");
    assert.equal(h.preCheckSpy.releaseCalls.length, 1, "preCheck 仍按 payment 维度释放");
    // MINOR 2:refresh path 必须结构性绕开(pick=null 没 expires_at 可 refresh)
    assert.equal(
      refreshHttpCalls.length,
      0,
      "deepseek 路径不应触发 refresh httpPost — pick=null 即没 token 可 refresh",
    );
    // MINOR 2:即使上游带了 quota headers,maybeUpdateAccountQuota 也不能 fire
    // —— 因为 anthropicProxy.ts 把它放在 `if (pick) { ... }` 块内
    const quotaUpdates = h.pool.queries.filter(
      (q) => /UPDATE\s+CLAUDE_ACCOUNTS/i.test(q.sql),
    );
    assert.equal(
      quotaUpdates.length,
      0,
      "deepseek 路径不应 UPDATE claude_accounts(maybeUpdateAccountQuota 被 if(pick) gate 跳过)",
    );

    assert.ok(upstreamHeaders, "fetch 必须被调用");
    assert.equal(
      upstreamHeaders!.authorization,
      "Bearer DS-SECRET-KEY",
      "Authorization 必须用 deepseekApiKey",
    );
    assert.equal(
      upstreamHeaders!["anthropic-beta"],
      undefined,
      "客户端传入的 anthropic-beta 必须被 strip(不是 'noop' 而是显式 delete)",
    );
    assert.match(upstreamUrl!, /deepseek/i, "endpoint 切到 DEEPSEEK_UPSTREAM_ENDPOINT");

    // metadata.user_id 不应被重写(pick=null,无 pinned_user_id 可锚)
    const parsedUserId = JSON.parse(String(upstreamBody!.metadata!.user_id));
    assert.equal(
      parsedUserId.device_id,
      clientDeviceId,
      "deepseek 路径必须保留客户端原 device_id(不锚定到 pinned)",
    );
    assert.equal(parsedUserId.session_id, "s1", "其他字段也不应被改");
  });

  test("deepseek 模型 + deepseekApiKey 未配置 → 503 DEEPSEEK_NOT_CONFIGURED + scheduler/preCheck 都不调用", async () => {
    const h = buildHarness({
      pricings: [DEEPSEEK_PRICING],
      authz: { role: "user", grantedModelIds: new Set(["deepseek-v4-pro"]) },
    });
    const res = await h.run(minBody("deepseek-v4-pro"));
    assert.equal(res.statusCode, 503);
    assert.equal(readErrCode(res), "DEEPSEEK_NOT_CONFIGURED");
    assert.equal(h.schedulerSpy.pickCalls.length, 0);
    assert.equal(h.schedulerSpy.releaseCalls.length, 0);
    // 5c) DEEPSEEK_NOT_CONFIGURED 在 preCheck 之前 → reserve 也 0
    assert.equal(h.preCheckSpy.reserveCalls.length, 0);
    assert.equal(h.preCheckSpy.releaseCalls.length, 0);
  });

  // 反向锚定:claude 路径必须 merge oauth-2025-04-20 + 重写 metadata.user_id.device_id
  test("claude 路径(对照组):merge oauth-2025-04-20 到 anthropic-beta + metadata.user_id.device_id 被锚定到 pinned_user_id", async () => {
    let upstreamHeaders: Record<string, string> | null = null;
    let upstreamBody: { metadata?: { user_id?: unknown } } | null = null;
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      upstreamHeaders = init?.headers as Record<string, string>;
      upstreamBody = init?.body ? JSON.parse(String(init.body)) : null;
      return sseResponse(200, makeFullSseChunks());
    }) as unknown as typeof fetch;

    const h = buildHarness({ fetchImpl });

    const clientDeviceId = "client-original-device";
    const body = {
      ...minBody("claude-sonnet-4-6"),
      metadata: { user_id: JSON.stringify({ device_id: clientDeviceId, session_id: "s2" }) },
    };
    await h.run(body, {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });

    assert.ok(upstreamHeaders);
    const beta = upstreamHeaders!["anthropic-beta"] ?? "";
    const tokens = beta.split(",").map((s) => s.trim());
    assert.ok(
      tokens.includes("oauth-2025-04-20"),
      `claude 路径必须 merge oauth-2025-04-20,实际: ${beta}`,
    );
    assert.ok(
      tokens.includes("interleaved-thinking-2025-05-14"),
      `客户端 anthropic-beta 必须保留(allowlist 内),实际: ${beta}`,
    );

    const parsedUserId = JSON.parse(String(upstreamBody!.metadata!.user_id));
    assert.equal(
      parsedUserId.device_id,
      FIXED_PINNED_USER_ID,
      "claude 路径 metadata.user_id.device_id 必须被锚定到 pick.pinned_user_id",
    );
    assert.equal(parsedUserId.session_id, "s2", "其他字段保留");
  });
});

// ─── 不变量 (2):isClientAbort 分类源 ────────────────────────────────────

describe("invariant 2 — abort 分类只看 isClientAbort(err),不看 ac.signal.aborted", () => {
  test("正常 commit → kind=success(不是 client_error,也不是 failure)", async () => {
    const h = buildHarness();
    const res = await h.run(minBody());
    assert.equal(res.statusCode, 200);
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(h.schedulerSpy.releaseCalls[0]!.result.kind, "success");
  });

  test("fetch 抛 AbortError(客户端断流)→ kind=client_error", async () => {
    const fetchImpl = (async () => {
      const err: Error & { name: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const h = buildHarness({ fetchImpl });
    await h.run(minBody());
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "client_error",
      "AbortError 必须归到 client_error(不扣账号健康分)",
    );
  });

  test("mid-stream upstream network error → kind=failure(不是 client_error)", async () => {
    const errStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder();
        ctrl.enqueue(enc.encode(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
        ));
        ctrl.error(new Error("socket hang up"));
      },
    });
    const h = buildHarness({
      fetchImpl: async () =>
        new Response(errStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    await h.run(minBody());
    assert.equal(h.schedulerSpy.releaseCalls.length, 1);
    assert.equal(
      h.schedulerSpy.releaseCalls[0]!.result.kind,
      "failure",
      "mid-stream net error 不是 client abort,必须算 failure(扣健康分)",
    );
  });
});

// ─── Phase 1.5 — pickUpstream accountKind 透传 ─────────────────────────────────
//
// 锁 V3 envv2 Phase 1.5 行为(2026-05-21):handler 在 isExternalApiKeyOAuthPath
// 命中时,**必须**把 `accountKind: "external_api"` 透传到 scheduler.pick;其它路径
// (容器 OAuth / DeepSeek)不传(传 undefined → scheduler 走默认 platform 池,与
// Phase 1 之前等价)。任意一条偏移即外接 / 容器池物理隔离破裂 → 整池 anti-abuse
// 风险,必须 fail-fast 而不是回归到 prod 才被发现。
//
// 实现策略:
//   - 用 schedulerSpy.pickCalls 记录的实际 pick(input) 参数验证,不仅看 calls 数。
//   - 外接路径通过 `identityStrategyOverride` 注入返回 `containerId: null` 的 fake
//     strategy(绕开容器双因子 + 真实 ApiKey repo 构造),保持 test 聚焦"分流"本身。
//   - DeepSeek 路径同时验"完全跳过 scheduler.pick" — pick=null noop 不可破。
describe("Phase 1.5 — pickUpstream accountKind 透传", () => {
  /**
   * Fake IdentityStrategy:resolve 返回 `containerId: null`(外接 ApiKey 形态),
   * authorize noop(test 不验 authz 分支,验的是 identity 类型对 pickUpstream 的影响)。
   */
  function makeFakeApiKeyIdentityStrategy(uid: bigint): IdentityStrategy {
    return {
      async resolve(_req, _ctx) {
        return { uid, containerId: null };
      },
      async authorize(_identity, _pricing, _model) {
        /* noop:authz 分支不在本 case 验证范围 */
      },
    };
  }

  test("外接 ApiKey + OAuth 上游:pickUpstream({accountKind:'external_api'}) → 503 ACCOUNT_POOL_UNAVAILABLE", async () => {
    const { AccountPoolUnavailableError } = await import("../account-pool/scheduler.js");
    const h = buildHarness({
      identityStrategyOverride: makeFakeApiKeyIdentityStrategy(BigInt(FIXED_USER_ID)),
    });
    // 让 scheduler.pick 抛 pool unavailable —— 验外接池空场景 handler 仍把 kind 透传
    h.schedulerSpy.setPickError(new AccountPoolUnavailableError("external pool empty"));

    const res = await h.run(minBody());

    assert.equal(res.statusCode, 503, "external pool 空 → 503");
    assert.equal(readErrCode(res), "ACCOUNT_POOL_UNAVAILABLE");
    assert.equal(
      h.schedulerSpy.pickCalls.length,
      1,
      "外接路径仍调 scheduler.pick(只是 pool 空抛错)",
    );
    const pickInput = h.schedulerSpy.pickCalls[0] as { kind?: string };
    assert.equal(
      pickInput.kind,
      "external_api",
      "isExternalApiKeyOAuthPath=true 必须把 accountKind=external_api 透传到 scheduler.pick",
    );
  });

  test("容器 + OAuth 上游:pickUpstream 不传 accountKind(scheduler 默认 platform 池)", async () => {
    // 默认 harness = 容器 strategy + 默认 fetch 走 happy SSE
    const h = buildHarness();

    const res = await h.run(minBody());

    assert.equal(res.statusCode, 200, "happy path 容器调用应 200");
    assert.equal(h.schedulerSpy.pickCalls.length, 1);
    const pickInput = h.schedulerSpy.pickCalls[0] as { kind?: string };
    assert.equal(
      pickInput.kind,
      undefined,
      "容器路径必须不传 accountKind(scheduler 内部默认到 platform,保 Phase 1 行为等价)",
    );
  });

  test("DeepSeek 路由:不调用 scheduler.pick(noop set 不可破)", async () => {
    const h = buildHarness({
      deepseekApiKey: "sk-deepseek-test",
      // pickSpec=null 仅在 scheduler.pick 被错误调用时才会抛"pickSpec=null but pick called",
      // 强化"deepseek 路径根本不触达 scheduler"的不变量验证。
      pickSpec: null,
    });

    const res = await h.run(minBody("deepseek-v4-pro"));

    assert.equal(res.statusCode, 200, "deepseek happy path 200");
    assert.equal(
      h.schedulerSpy.pickCalls.length,
      0,
      "deepseek 路由 pickUpstream 应合成 session,不触达 scheduler.pick",
    );
  });
});
