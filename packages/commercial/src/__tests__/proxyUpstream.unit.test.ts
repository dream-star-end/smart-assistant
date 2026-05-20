/**
 * V3 Phase 3 — `http/proxy/upstream.ts` 单元测试。
 *
 * 跑法: npx tsx --test src/__tests__/proxyUpstream.unit.test.ts
 *
 * 覆盖目标:把 anthropicProxy.ts handler 收敛进 upstream.ts 的所有边界行为
 * 都直接打到 pickUpstream / PreparedUpstreamSession API 上,不再绕一圈 e2e:
 *
 *   - selectUpstreamRoute(model) 路由判定
 *   - validateUpstreamConfig 早拒绝(deepseek 缺 key)
 *   - pickUpstream OAuth happy / refresh 成功 / refresh transient / refresh non-transient
 *   - pickUpstream pool_busy / pool_unavailable 无 release 调用
 *   - pickUpstream dispatcher 抛 → preparation_failed + release(failure)
 *   - pickUpstream DeepSeek 路径合成 session,无 scheduler/dispatcher 调用
 *   - PreparedUpstreamSession.applyUpstreamAuth(OAuth + DeepSeek + 三个边界:
 *     有 anthropic-beta 客户端值 / 无值,pinned schema 合法 / 不合法)
 *   - PreparedUpstreamSession.sanitizeMessages(OAuth strip + DeepSeek passthrough)
 *   - PreparedUpstreamSession.zeroizeSecrets idempotent
 *   - upstreamEndpoint 覆盖
 *   - releaseUpstreamSession OAuth / DeepSeek / scheduler.release throw 兜底
 *
 * 整链 e2e(SSE + journal + finalizer)归 anthropicProxy.integ.test.ts。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  selectUpstreamRoute,
  validateUpstreamConfig,
  pickUpstream,
  releaseUpstreamSession,
  type PickUpstreamDeps,
} from "../http/proxy/upstream.js";
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  type PickInput,
  type PickResult,
  type ReleaseInput,
} from "../account-pool/scheduler.js";
import { RefreshError, type RefreshDeps } from "../account-pool/refresh.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "proxyUpstream.unit.test" });

// ─── 共用 helper ─────────────────────────────────────────────────────────

const PINNED_OK = "f".repeat(64); // 64 hex
const PINNED_BAD = "not-hex-bad-length"; // schema breach

function makePick(over: Partial<PickResult> = {}): PickResult {
  return {
    account_id: 7n,
    plan: "pro",
    token: Buffer.from("AAAA-old-token", "utf8"),
    refresh: Buffer.from("BBBB-old-refresh", "utf8"),
    expires_at: null,
    egress_proxy: null,
    egress_target: null,
    pinned_user_id: PINNED_OK,
    envelope_version: 1,
    fingerprint_salt: Buffer.alloc(16),
    ...over,
  };
}

interface SchedulerSpy {
  scheduler: PickUpstreamDeps["scheduler"];
  pickCalls: number;
  /** Phase 1.5 (2026-05-21):捕获每次 pick 的 input,用于断言 kind 透传。 */
  pickInputs: PickInput[];
  releaseCalls: ReleaseInput[];
}

function makeScheduler(opts: {
  pickResult?: PickResult;
  pickThrow?: unknown;
}): SchedulerSpy {
  const releaseCalls: ReleaseInput[] = [];
  const pickInputs: PickInput[] = [];
  let pickCalls = 0;
  const scheduler: PickUpstreamDeps["scheduler"] = {
    async pick(input) {
      pickCalls += 1;
      pickInputs.push(input);
      if (opts.pickThrow) throw opts.pickThrow;
      return opts.pickResult ?? makePick();
    },
    async release(input) {
      releaseCalls.push(input);
    },
  };
  return {
    scheduler,
    get pickCalls() {
      return pickCalls;
    },
    pickInputs,
    releaseCalls,
  };
}

function bodyFor(model: string): {
  model: string;
  messages: unknown[];
  metadata?: { session_id?: string; user_id?: unknown };
} {
  return { model, messages: [{ role: "user", content: "hi" }] };
}

// ─── selectUpstreamRoute ─────────────────────────────────────────────────

describe("selectUpstreamRoute", () => {
  test("model 以 deepseek- 开头 → kind=deepseek", () => {
    assert.deepEqual(selectUpstreamRoute("deepseek-v4-pro"), { kind: "deepseek" });
    assert.deepEqual(selectUpstreamRoute("deepseek-chat"), { kind: "deepseek" });
  });
  test("其它 model → kind=oauth", () => {
    assert.deepEqual(selectUpstreamRoute("claude-sonnet-4-6"), { kind: "oauth" });
    assert.deepEqual(selectUpstreamRoute("gpt-5"), { kind: "oauth" });
    assert.deepEqual(selectUpstreamRoute(""), { kind: "oauth" });
  });
});

// ─── validateUpstreamConfig ──────────────────────────────────────────────

describe("validateUpstreamConfig", () => {
  test("deepseek 路由 + 缺 key → deepseek_not_configured", () => {
    assert.deepEqual(
      validateUpstreamConfig({ kind: "deepseek" }, {}),
      { kind: "deepseek_not_configured" },
    );
    assert.deepEqual(
      validateUpstreamConfig({ kind: "deepseek" }, { deepseekApiKey: "" }),
      { kind: "deepseek_not_configured" },
    );
  });
  test("deepseek 路由 + 有 key → null(放行)", () => {
    assert.equal(
      validateUpstreamConfig({ kind: "deepseek" }, { deepseekApiKey: "ds-key" }),
      null,
    );
  });
  test("oauth 路由 → 任何 deepseekApiKey 都返回 null", () => {
    assert.equal(validateUpstreamConfig({ kind: "oauth" }, {}), null);
    assert.equal(validateUpstreamConfig({ kind: "oauth" }, { deepseekApiKey: "" }), null);
    assert.equal(validateUpstreamConfig({ kind: "oauth" }, { deepseekApiKey: "k" }), null);
  });
});

// ─── pickUpstream — DeepSeek 路径 ────────────────────────────────────────

describe("pickUpstream — DeepSeek route", () => {
  test("不调 scheduler;session.endpoint = deepseek 端点;applyUpstreamAuth 用 deepseekApiKey + strip beta", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, deepseekApiKey: "DS-KEY" },
      bodyFor("deepseek-v4-pro"),
      { kind: "deepseek" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const { session } = res;
    assert.equal(sched.pickCalls, 0, "DeepSeek 路径绝不调 scheduler.pick");
    assert.equal(session.accountId, null);
    assert.equal(session.pinnedUserId, null);
    assert.equal(session.dispatcher, undefined);
    assert.equal(session.shouldUpdateQuotaFromResponse, false);
    assert.match(session.endpoint, /deepseek/i);

    const safeHeaders: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    };
    const body = { metadata: { user_id: "client-original" } } as unknown as Parameters<
      typeof session.applyUpstreamAuth
    >[1];
    session.applyUpstreamAuth(safeHeaders, body, log);
    assert.equal(safeHeaders.authorization, "Bearer DS-KEY");
    assert.equal(
      safeHeaders["anthropic-beta"],
      undefined,
      "DeepSeek 路径必须显式 delete anthropic-beta(不是 noop)",
    );
    // metadata 不应被改
    assert.equal(
      (body as { metadata?: { user_id?: unknown } }).metadata?.user_id,
      "client-original",
    );
  });

  test("sanitizeMessages 返回原 messages 引用(无 strip 操作)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, deepseekApiKey: "k" },
      bodyFor("deepseek-v4-pro"),
      { kind: "deepseek" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const messages = [{ role: "user", content: "hi" }];
    const out = res.session.sanitizeMessages(messages, "deepseek-v4-pro", log);
    assert.equal(out, messages, "DeepSeek 路径必须 return 同一数组引用,无 strip");
  });

  test("zeroizeSecrets 是 noop(deepseekApiKey 来自配置,不归 session)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, deepseekApiKey: "k" },
      bodyFor("deepseek-v4-pro"),
      { kind: "deepseek" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    res.session.zeroizeSecrets(); // 调一次不抛
    res.session.zeroizeSecrets(); // 二次也不抛
  });
});

// ─── pickUpstream — OAuth pick 失败 ──────────────────────────────────────

describe("pickUpstream — OAuth pick 失败", () => {
  test("AccountPoolBusyError → kind=pool_busy,scheduler.release 不调", async () => {
    const sched = makeScheduler({
      pickThrow: new AccountPoolBusyError("all busy"),
    });
    const res = await pickUpstream(
      { scheduler: sched.scheduler },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_busy");
    assert.equal(sched.releaseCalls.length, 0, "case (a) — pick 失败不持有 account,绝不 release");
  });

  test("AccountPoolUnavailableError → kind=pool_unavailable,scheduler.release 不调", async () => {
    const sched = makeScheduler({
      pickThrow: new AccountPoolUnavailableError("no active"),
    });
    const res = await pickUpstream(
      { scheduler: sched.scheduler },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    assert.equal(sched.releaseCalls.length, 0);
  });

  test("scheduler.pick 抛未知 error → 重抛(handler 上层走 500)", async () => {
    const sched = makeScheduler({ pickThrow: new Error("db wedged") });
    await assert.rejects(
      pickUpstream(
        { scheduler: sched.scheduler },
        bodyFor("claude-sonnet-4-6"),
        { kind: "oauth" },
        log,
      ),
      /db wedged/,
    );
  });
});

// ─── pickUpstream — OAuth happy path ─────────────────────────────────────

describe("pickUpstream — OAuth happy path", () => {
  test("不到期 → 不调 refresh;session.accountId/pinnedUserId/dispatcher/quota 正确", async () => {
    const pick = makePick({ expires_at: null });
    const sched = makeScheduler({ pickResult: pick });
    const stubDispatcher = { kind: "stub-dispatcher" };
    let getDispatcherCalls = 0;
    const getDispatcher = async () => {
      getDispatcherCalls += 1;
      return stubDispatcher as unknown as undefined; // 类型对齐
    };
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: getDispatcher as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const { session } = res;
    assert.equal(getDispatcherCalls, 1);
    assert.equal(session.accountId, 7n);
    assert.equal(session.pinnedUserId, PINNED_OK);
    assert.equal(session.dispatcher, stubDispatcher);
    assert.equal(session.shouldUpdateQuotaFromResponse, true);
    assert.equal(sched.releaseCalls.length, 0);
  });

  test("expires_at 未到 skew → 不调 refresh", async () => {
    const pick = makePick({ expires_at: new Date(Date.now() + 10 * 60 * 1000) });
    const sched = makeScheduler({ pickResult: pick });
    let refreshHttpCalls = 0;
    const refreshDeps: RefreshDeps = {
      http: {
        async post() {
          refreshHttpCalls += 1;
          return { status: 200, body: "{}" };
        },
      },
    };
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        refreshDeps,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.equal(refreshHttpCalls, 0);
  });
});

// ─── applyUpstreamAuth / sanitizeMessages — OAuth ────────────────────────

describe("PreparedUpstreamSession (OAuth) — applyUpstreamAuth", () => {
  async function makeSession(over: Partial<PickResult> = {}) {
    const pick = makePick(over);
    const sched = makeScheduler({ pickResult: pick });
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    if (!res.ok) throw new Error("expected ok");
    return { pick, session: res.session };
  }

  test("写 Bearer + merge anthropic-beta(unshift oauth-2025-04-20 在前)", async () => {
    const { session } = await makeSession();
    const headers: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14, fine-grained-2025-01-01",
    };
    const body = { metadata: {} } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth(headers, body, log);

    assert.match(headers.authorization, /^Bearer /);
    const tokens = headers["anthropic-beta"].split(",").map((s) => s.trim());
    assert.equal(tokens[0], "oauth-2025-04-20", "oauth-2025-04-20 必须 unshift 到最前");
    assert.ok(tokens.includes("interleaved-thinking-2025-05-14"));
    assert.ok(tokens.includes("fine-grained-2025-01-01"));
  });

  test("客户端已有 oauth-2025-04-20 → 不重复加(merge 而非覆盖)", async () => {
    const { session } = await makeSession();
    const headers: Record<string, string> = {
      "anthropic-beta": "oauth-2025-04-20, my-custom-beta",
    };
    session.applyUpstreamAuth(headers, { metadata: {} } as never, log);
    const tokens = headers["anthropic-beta"].split(",").map((s) => s.trim());
    assert.equal(tokens.filter((t) => t === "oauth-2025-04-20").length, 1);
  });

  test("客户端无 anthropic-beta → 只写 oauth-2025-04-20", async () => {
    const { session } = await makeSession();
    const headers: Record<string, string> = {};
    session.applyUpstreamAuth(headers, { metadata: {} } as never, log);
    assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
  });

  test("pinned_user_id 合法 (64 hex) → device_id 锚定", async () => {
    const { session } = await makeSession();
    const body = {
      metadata: { user_id: JSON.stringify({ device_id: "client-original" }) },
    } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth({}, body, log);
    const parsed = JSON.parse(
      String((body as { metadata?: { user_id?: unknown } }).metadata!.user_id),
    );
    assert.equal(parsed.device_id, PINNED_OK, "device_id 必须被锚定到 pinned_user_id");
  });

  test("pinned schema breach → fail-open + log.warn,不重写 device_id", async () => {
    const { session } = await makeSession({ pinned_user_id: PINNED_BAD as unknown as string });
    const body = {
      metadata: { user_id: JSON.stringify({ device_id: "client-original" }) },
    } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth({}, body, log);
    const parsed = JSON.parse(
      String((body as { metadata?: { user_id?: unknown } }).metadata!.user_id),
    );
    assert.equal(
      parsed.device_id,
      "client-original",
      "breach 时保留客户端原值,不阻塞请求",
    );
  });

  test("metadata 不存在 → 自动创建对象再 rewrite", async () => {
    const { session } = await makeSession();
    const body = {} as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth({}, body, log);
    assert.ok((body as { metadata?: { user_id?: unknown } }).metadata);
  });
});

describe("PreparedUpstreamSession (OAuth) — sanitizeMessages", () => {
  test("无 malformed thinking → 返回原引用(stripMalformedThinkingBlocks 内部 short-circuit)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const messages = [{ role: "user", content: "hi" }];
    const out = res.session.sanitizeMessages(messages, "claude-sonnet-4-6", log);
    // 出现 strip 时 r.messages 是新数组,否则是同一引用
    assert.deepEqual(out, messages);
  });

  test("含 malformed thinking block → 被 strip 掉", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // 构造一个 signature 缺失的 thinking block
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "no sig" }, // 缺 signature → 被 strip
          { type: "text", text: "ok" },
        ],
      },
    ];
    const out = res.session.sanitizeMessages(messages, "claude-sonnet-4-6", log) as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    const types = out[0].content.map((c) => c.type);
    assert.ok(!types.includes("thinking"));
    assert.ok(types.includes("text"));
  });
});

// ─── zeroizeSecrets — OAuth idempotent ───────────────────────────────────

describe("PreparedUpstreamSession (OAuth) — zeroizeSecrets idempotent", () => {
  test("第一次调:token + refresh 被 fill(0);第二次:不抛", async () => {
    const pick = makePick();
    const tokenBuf = pick.token;
    const refreshBuf = pick.refresh!;
    const sched = makeScheduler({ pickResult: pick });
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    res.session.zeroizeSecrets();
    assert.ok(tokenBuf.every((b) => b === 0), "token 被 fill(0)");
    assert.ok(refreshBuf.every((b) => b === 0), "refresh 被 fill(0)");
    // 第二次 idempotent
    res.session.zeroizeSecrets();
  });

  test("refresh = null → zeroize 只动 token 不抛", async () => {
    const pick = makePick({ refresh: null });
    const sched = makeScheduler({ pickResult: pick });
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    res.session.zeroizeSecrets();
    assert.ok(pick.token.every((b) => b === 0));
  });
});

// ─── pickUpstream — refresh 成功(老 token 零化 + dispatcher 锚定 HIGH#5)─
//
// 这组测试通过 `refreshAccountTokenImpl` test seam 直接验证 upstream 层调用 refresh
// 时的协调行为(老 token 零化时序、dispatcher 强制覆盖、新 pick 进 session),
// 不耦合 refresh.ts 自身的 PG / KMS / OAuth 细节(那是 refresh.ts 自己的责任)。

describe("pickUpstream — refresh 成功 + HIGH#5 同出口锚定", () => {
  test("refresh 完后新 token 进 session;老 token+refresh 被零化;refreshDeps.dispatcher 被强制覆盖为 getDispatcher 返回值", async () => {
    const oldToken = Buffer.from("OLD-TOKEN-aaaa", "utf8");
    const oldRefresh = Buffer.from("OLD-REFRESH-bbbb", "utf8");
    const pick = makePick({
      token: oldToken,
      refresh: oldRefresh,
      expires_at: new Date(Date.now() - 1000), // 已过期 → 触发 refresh
    });
    const sched = makeScheduler({ pickResult: pick });

    const stubDispatcher = { kind: "the-account-dispatcher" } as unknown;
    const callerWrongDispatcher = { kind: "caller-wrong-dispatcher" } as unknown;

    let observedRefreshDispatcher: unknown = "<unset>";
    let observedAccountId: bigint | string | undefined;
    const refreshAccountTokenImpl = (async (
      accountId: bigint | string,
      refreshDeps?: RefreshDeps,
    ) => {
      observedAccountId = accountId;
      observedRefreshDispatcher = refreshDeps?.dispatcher;
      return {
        token: Buffer.from("NEW-TOKEN", "utf8"),
        refresh: Buffer.from("NEW-REFRESH", "utf8"),
        expires_at: new Date(Date.now() + 3600_000),
      };
    }) as unknown as PickUpstreamDeps["refreshAccountTokenImpl"];

    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        // caller 故意塞 wrong dispatcher,upstream 层应该覆盖掉
        refreshDeps: { dispatcher: callerWrongDispatcher } as RefreshDeps,
        refreshAccountTokenImpl,
        getDispatcher: (async () => stubDispatcher) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(observedAccountId, 7n);
    assert.equal(
      observedRefreshDispatcher,
      stubDispatcher,
      "HIGH#5:refresh 的 dispatcher 必须被强制覆盖为 getDispatcher 返回值",
    );
    // 老 token + refresh 已被零化
    assert.ok(oldToken.every((b) => b === 0), "老 token 必须 fill(0)");
    assert.ok(oldRefresh.every((b) => b === 0), "老 refresh 必须 fill(0)");
    // session.dispatcher 仍是 stub(同 IP)
    assert.equal(res.session.dispatcher, stubDispatcher);
  });
});

// ─── pickUpstream — refresh 失败:transient vs non-transient ─────────────

describe("pickUpstream — refresh 失败 release kind 分流", () => {
  test("RefreshError(network_transient) → release(transient_network) + zero + refresh_failed{transient:true}", async () => {
    const pick = makePick({ expires_at: new Date(Date.now() - 1000) });
    const sched = makeScheduler({ pickResult: pick });
    const refreshAccountTokenImpl = (async () => {
      throw new RefreshError("network_transient", "ECONNRESET");
    }) as unknown as PickUpstreamDeps["refreshAccountTokenImpl"];

    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        refreshDeps: {},
        refreshAccountTokenImpl,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "refresh_failed");
    if (res.error.kind !== "refresh_failed") return;
    assert.equal(res.error.transient, true);
    assert.equal(res.error.err instanceof RefreshError, true);
    assert.equal((res.error.err as RefreshError).code, "network_transient");

    assert.equal(sched.releaseCalls.length, 1);
    assert.equal(sched.releaseCalls[0].account_id, 7n);
    assert.equal(sched.releaseCalls[0].result.kind, "transient_network");
    assert.ok(pick.token.every((b) => b === 0));
    assert.ok(pick.refresh!.every((b) => b === 0));
  });

  test("RefreshError(http_error) → release(failure) + refresh_failed{transient:false}", async () => {
    const pick = makePick({ expires_at: new Date(Date.now() - 1000) });
    const sched = makeScheduler({ pickResult: pick });
    const refreshAccountTokenImpl = (async () => {
      throw new RefreshError("http_error", "refresh endpoint returned 400");
    }) as unknown as PickUpstreamDeps["refreshAccountTokenImpl"];

    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        refreshDeps: {},
        refreshAccountTokenImpl,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "refresh_failed");
    if (res.error.kind !== "refresh_failed") return;
    assert.equal(res.error.transient, false);
    assert.equal((res.error.err as RefreshError).code, "http_error");
    assert.equal(sched.releaseCalls.length, 1);
    assert.equal(sched.releaseCalls[0].result.kind, "failure");
  });

  test("非 RefreshError 抛(unknown 错)→ release(failure) + refresh_failed{transient:false}", async () => {
    const pick = makePick({ expires_at: new Date(Date.now() - 1000) });
    const sched = makeScheduler({ pickResult: pick });
    const refreshAccountTokenImpl = (async () => {
      throw new Error("unknown explosion");
    }) as unknown as PickUpstreamDeps["refreshAccountTokenImpl"];

    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        refreshDeps: {},
        refreshAccountTokenImpl,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "refresh_failed");
    if (res.error.kind !== "refresh_failed") return;
    assert.equal(res.error.transient, false);
    assert.equal(sched.releaseCalls.length, 1);
    assert.equal(sched.releaseCalls[0].result.kind, "failure");
  });

  test("(b₁) scheduler.release 自身 throw → 被 swallow,token/refresh 仍被零化,error 传出", async () => {
    // hardening:secret hygiene 不能因 best-effort release 失败而中断
    const pick = makePick({ expires_at: new Date(Date.now() - 1000) });
    const scheduler: PickUpstreamDeps["scheduler"] = {
      async pick() {
        return pick;
      },
      async release() {
        throw new Error("scheduler release blew up");
      },
    };
    const refreshAccountTokenImpl = (async () => {
      throw new RefreshError("http_error", "401 from refresh endpoint");
    }) as unknown as PickUpstreamDeps["refreshAccountTokenImpl"];

    const res = await pickUpstream(
      {
        scheduler,
        refreshDeps: {},
        refreshAccountTokenImpl,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "refresh_failed");
    if (res.error.kind !== "refresh_failed") return;
    assert.equal(res.error.transient, false);
    // 关键:即使 release throw 也必须把 secret 清干净
    assert.ok(pick.token.every((b) => b === 0), "token 应被零化即使 release throw");
    assert.ok(pick.refresh!.every((b) => b === 0), "refresh 应被零化即使 release throw");
  });
});

// ─── pickUpstream — dispatcher 抛 → preparation_failed ───────────────────

describe("pickUpstream — preparation guard (b₂)", () => {
  test("getDispatcher 抛 → kind=preparation_failed + release(failure) + zero token", async () => {
    const pick = makePick();
    const sched = makeScheduler({ pickResult: pick });
    const getDispatcher = async () => {
      throw new Error("dispatcher build failed");
    };
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: getDispatcher as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "preparation_failed");
    assert.equal(sched.releaseCalls.length, 1);
    assert.equal(sched.releaseCalls[0].account_id, 7n);
    assert.equal(sched.releaseCalls[0].result.kind, "failure");
    // 老 token 应被零化
    assert.ok(pick.token.every((b) => b === 0));
  });

  test("scheduler.release 在 (b₂) 兜底里也 throw → 被 swallow,error 仍传出", async () => {
    const pick = makePick();
    const scheduler: PickUpstreamDeps["scheduler"] = {
      async pick() {
        return pick;
      },
      async release() {
        throw new Error("release failed too");
      },
    };
    const res = await pickUpstream(
      {
        scheduler,
        getDispatcher: (async () => {
          throw new Error("dispatcher failure");
        }) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "preparation_failed");
  });
});

// ─── upstreamEndpoint override ───────────────────────────────────────────

describe("pickUpstream — upstreamEndpoint override", () => {
  test("OAuth + 传 upstreamEndpoint → session.endpoint 用覆盖值;DeepSeek 路径不受影响", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        upstreamEndpoint: "https://override.test/v1/messages",
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.session.endpoint, "https://override.test/v1/messages");

    const dsSched = makeScheduler({});
    const ds = await pickUpstream(
      {
        scheduler: dsSched.scheduler,
        deepseekApiKey: "k",
        upstreamEndpoint: "https://override.test/v1/messages",
      },
      bodyFor("deepseek-v4-pro"),
      { kind: "deepseek" },
      log,
    );
    assert.equal(ds.ok, true);
    if (!ds.ok) return;
    assert.match(
      ds.session.endpoint,
      /deepseek/i,
      "DeepSeek endpoint 由内部常量决定,不受 upstreamEndpoint 覆盖影响",
    );
  });

  test("不传 upstreamEndpoint → OAuth 走默认 anthropic 端点", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.session.endpoint, "https://api.anthropic.com/v1/messages");
  });
});

// ─── releaseUpstreamSession ──────────────────────────────────────────────

describe("releaseUpstreamSession (case c — finalizer-pre window)", () => {
  test("OAuth session + accountId 非空 → 调 scheduler.release(failure)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    await releaseUpstreamSession(
      sched.scheduler,
      res.session,
      { kind: "failure", error: "journal failed" },
      log,
    );
    assert.equal(sched.releaseCalls.length, 1);
    assert.equal(sched.releaseCalls[0].account_id, 7n);
    assert.equal(sched.releaseCalls[0].result.kind, "failure");
  });

  test("DeepSeek session (accountId=null) → noop,不调 scheduler.release", async () => {
    let releaseCallCount = 0;
    const scheduler: PickUpstreamDeps["scheduler"] = {
      async pick() {
        throw new Error("not called");
      },
      async release() {
        releaseCallCount += 1;
      },
    };
    const res = await pickUpstream(
      { scheduler, deepseekApiKey: "k" },
      bodyFor("deepseek-v4-pro"),
      { kind: "deepseek" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    await releaseUpstreamSession(
      scheduler,
      res.session,
      { kind: "failure", error: "x" },
      log,
    );
    assert.equal(releaseCallCount, 0, "DeepSeek path: accountId=null → release noop");
  });

  test("scheduler.release 抛 → 不抛,log 兜底", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // 用专属 scheduler 把 release 设成 throw
    const throwingScheduler: PickUpstreamDeps["scheduler"] = {
      async pick() {
        throw new Error("not called");
      },
      async release() {
        throw new Error("release exploded");
      },
    };
    // 不应抛
    await releaseUpstreamSession(
      throwingScheduler,
      res.session,
      { kind: "failure", error: "x" },
      log,
    );
  });
});

// ─── pickUpstream — V3 envv2 Phase 1.5 accountKind 透传 ────────────────────
//
// 验证 handler 通过 5th `opts.accountKind` 透传账号池分区给 scheduler:
//   - accountKind='external_api' → scheduler.pick.input.kind === 'external_api'
//   - accountKind undefined       → scheduler.pick.input.kind === undefined
//                                   (scheduler 内部 default 'platform',与历史等价)
//   - DeepSeek 路径 + 任何 accountKind → scheduler.pick **不被调用**(零交叉)
//
// 这三 case 锁住 "handler 决策 → scheduler input" 的边界。真实 SQL 池隔离行为
// 由 accountKindPool.integ.test.ts 在 real PG 上覆盖,本 unit 只验调用契约。
describe("pickUpstream — V3 envv2 Phase 1.5 accountKind 透传", () => {
  test("opts.accountKind='external_api' → scheduler.pick.input.kind = 'external_api'", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
      { accountKind: "external_api" },
    );
    assert.equal(res.ok, true);
    assert.equal(sched.pickCalls, 1);
    assert.equal(sched.pickInputs.length, 1);
    assert.equal(
      sched.pickInputs[0].kind,
      "external_api",
      "handler 注入 accountKind='external_api' 必须透传到 scheduler.pick.input.kind",
    );
  });

  test("opts.accountKind 缺省 → scheduler.pick.input.kind = undefined(scheduler 内部 default platform)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
      // 故意不传 opts,模拟容器路径
    );
    assert.equal(res.ok, true);
    assert.equal(sched.pickCalls, 1);
    assert.equal(
      sched.pickInputs[0].kind,
      undefined,
      "不传 accountKind 时,scheduler.pick.input.kind 必须是 undefined,让 scheduler 自己 default platform",
    );
  });

  test("DeepSeek route + accountKind='external_api' → scheduler.pick 不被调用(早返零交叉)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, deepseekApiKey: "DS-KEY" },
      bodyFor("deepseek-v4-pro"),
      { kind: "deepseek" },
      log,
      { accountKind: "external_api" }, // 故意传错(配错时),DeepSeek 早返不该走 pool
    );
    assert.equal(res.ok, true);
    assert.equal(sched.pickCalls, 0, "DeepSeek 路径必须早返,绝不调 scheduler.pick");
  });
});
