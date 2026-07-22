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

import { getStaticProvider } from "@openclaude/protocol";
import {
  selectUpstreamRoute,
  validateUpstreamConfig,
  pickUpstream,
  releaseUpstreamSession,
  type PickUpstreamDeps,
} from "../http/proxy/upstream.js";
import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";

// 静态 provider route 构造助手:registry spec → UpstreamRoute。
const DEEPSEEK_ROUTE = { kind: "static" as const, provider: getStaticProvider("deepseek") };
const MINIMAX_ROUTE = { kind: "static" as const, provider: getStaticProvider("minimax") };
const ARK_ROUTE = { kind: "static" as const, provider: getStaticProvider("ark") };
const OPENCODEGO_ROUTE = { kind: "static" as const, provider: getStaticProvider("opencodego") };
const ARK_K3_ROUTE = { kind: "static" as const, provider: getStaticProvider("ark-k3") };
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  SessionPinTemporarilyUnavailableError,
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
    slotId: "slot-test-7",
    plan: "pro",
    token: Buffer.from("AAAA-old-token", "utf8"),
    refresh: Buffer.from("BBBB-old-refresh", "utf8"),
    expires_at: null,
    egress_proxy: null,
    egress_target: null,
    egress_proxy_id: null, // A2 默认未绑;bound case 通过 over 覆盖
    egress_host_uuid: null,
    pinned_user_id: PINNED_OK,
    account_uuid: null, // Phase 6 默认 null;具体 case 通过 over 覆盖
    persona: null, // v3 反关联根治 0073/0074 默认 null;具体 case 通过 over 覆盖
    ...over,
  };
}

interface SchedulerSpy {
  scheduler: PickUpstreamDeps["scheduler"];
  pickCalls: number;
  releaseCalls: ReleaseInput[];
}

function makeScheduler(opts: {
  pickResult?: PickResult;
  pickThrow?: unknown;
}): SchedulerSpy {
  const releaseCalls: ReleaseInput[] = [];
  let pickCalls = 0;
  const scheduler: PickUpstreamDeps["scheduler"] = {
    async pick(_input) {
      pickCalls += 1;
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
    releaseCalls,
  };
}

function bodyFor(model: string): {
  model: string;
  max_tokens: number;
  messages: unknown[];
  metadata?: { session_id?: string; user_id?: string };
} {
  return { model, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] };
}

// ─── selectUpstreamRoute ─────────────────────────────────────────────────

describe("selectUpstreamRoute", () => {
  test("model 以 deepseek- 开头(大小写敏感) → static/deepseek", () => {
    for (const m of ["deepseek-v4-pro", "deepseek-chat"]) {
      const r = selectUpstreamRoute(m);
      assert.equal(r.kind, "static");
      if (r.kind === "static") assert.equal(r.provider.id, "deepseek");
    }
  });
  test("MiniMax-M3(大小写不敏感) → static/minimax", () => {
    for (const m of ["MiniMax-M3", "minimax-m3"]) {
      const r = selectUpstreamRoute(m);
      assert.equal(r.kind, "static");
      if (r.kind === "static") assert.equal(r.provider.id, "minimax");
    }
  });
  test("glm-5.1 / glm-5.2(大小写不敏感) → static/ark", () => {
    for (const m of ["glm-5.1", "GLM-5.1", "glm-5.2", "GLM-5.2"]) {
      const r = selectUpstreamRoute(m);
      assert.equal(r.kind, "static");
      if (r.kind === "static") assert.equal(r.provider.id, "ark");
    }
  });
  test("qwen3.7-max / plus → static/opencodego", () => {
    for (const m of ["qwen3.7-max", "qwen3.7-plus"]) {
      const r = selectUpstreamRoute(m);
      assert.equal(r.kind, "static");
      if (r.kind === "static") assert.equal(r.provider.id, "opencodego");
    }
  });
  test("kimi-k3-ark → static/ark-k3 + legacy upstream rewrite", () => {
    const r = selectUpstreamRoute("kimi-k3-ark");
    assert.equal(r.kind, "static");
    if (r.kind === "static") {
      assert.equal(r.provider.id, "ark-k3");
      assert.equal(r.upstreamModel, "kimi-k3");
    }
  });
  test("其它 model → kind=oauth", () => {
    assert.deepEqual(selectUpstreamRoute("claude-sonnet-4-6"), { kind: "oauth" });
    assert.deepEqual(selectUpstreamRoute("gpt-5"), { kind: "oauth" });
    assert.deepEqual(selectUpstreamRoute(""), { kind: "oauth" });
    // 大小写敏感等价回归:DeepSeek-foo(大写 D)不命中 deepseek route → oauth
    assert.deepEqual(selectUpstreamRoute("DeepSeek-v4-pro"), { kind: "oauth" });
  });
});

// ─── validateUpstreamConfig ──────────────────────────────────────────────

describe("validateUpstreamConfig", () => {
  test("static 路由 + 缺 key → static_not_configured(带 providerId)", () => {
    assert.deepEqual(validateUpstreamConfig(DEEPSEEK_ROUTE, {}), {
      kind: "static_not_configured",
      providerId: "deepseek",
    });
    assert.deepEqual(
      validateUpstreamConfig(DEEPSEEK_ROUTE, { staticProviderKeys: { deepseek: "" } }),
      { kind: "static_not_configured", providerId: "deepseek" },
    );
    assert.deepEqual(validateUpstreamConfig(ARK_ROUTE, {}), {
      kind: "static_not_configured",
      providerId: "ark",
    });
    assert.deepEqual(validateUpstreamConfig(ARK_K3_ROUTE, {}), {
      kind: "static_not_configured",
      providerId: "ark-k3",
    });
  });
  test("static 路由 + 有自己的 key → null(放行)", () => {
    assert.equal(
      validateUpstreamConfig(DEEPSEEK_ROUTE, { staticProviderKeys: { deepseek: "ds-key" } }),
      null,
    );
    assert.equal(
      validateUpstreamConfig(MINIMAX_ROUTE, { staticProviderKeys: { minimax: "sk-cp-xxx" } }),
      null,
    );
    assert.equal(
      validateUpstreamConfig(ARK_ROUTE, { staticProviderKeys: { ark: "ark-key" } }),
      null,
    );
    assert.equal(
      validateUpstreamConfig(ARK_K3_ROUTE, { staticProviderKeys: { "ark-k3": "ark-plan-key" } }),
      null,
    );
  });
  test("static 路由只认自己 provider 的 key(注入了别家 key 仍 not_configured)", () => {
    assert.deepEqual(
      validateUpstreamConfig(ARK_ROUTE, { staticProviderKeys: { deepseek: "ds-key" } }),
      { kind: "static_not_configured", providerId: "ark" },
    );
  });
  test("oauth 路由 → 任何 key 都返回 null", () => {
    assert.equal(validateUpstreamConfig({ kind: "oauth" }, {}), null);
    assert.equal(
      validateUpstreamConfig({ kind: "oauth" }, { staticProviderKeys: { deepseek: "" } }),
      null,
    );
    assert.equal(
      validateUpstreamConfig({ kind: "oauth" }, { staticProviderKeys: { ark: "k" } }),
      null,
    );
  });
});

// ─── pickUpstream — DeepSeek 路径(等价回归)──────────────────────────────

describe("pickUpstream — DeepSeek route", () => {
  test("不调 scheduler;session.endpoint = deepseek 端点;applyUpstreamAuth Bearer + strip beta(不 strip body)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { deepseek: "DS-KEY" } },
      bodyFor("deepseek-v4-pro"),
      DEEPSEEK_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const { session } = res;
    assert.equal(sched.pickCalls, 0, "DeepSeek 路径绝不调 scheduler.pick");
    assert.equal(session.accountId, null);
    assert.equal(session.pinnedUserId, null);
    // 国内/亚洲静态 provider 走显式直连 dispatcher,绕开 gateway 全局 EnvHttpProxyAgent(日本节点)。
    assert.equal(session.dispatcher, directEgressDispatcher());
    assert.equal(session.shouldUpdateQuotaFromResponse, false);
    assert.match(session.endpoint, /deepseek/i);

    const safeHeaders: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    };
    // deepseek stripBodyFields=[]，故 body 上的 thinking 等字段应被保留(等价回归)。
    const body = {
      metadata: { user_id: "client-original" },
      thinking: { type: "enabled" },
    } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth(safeHeaders, body, log);
    assert.equal(safeHeaders.authorization, "Bearer DS-KEY");
    assert.equal(
      safeHeaders["anthropic-beta"],
      undefined,
      "DeepSeek 路径必须显式 delete anthropic-beta(不是 noop)",
    );
    assert.deepEqual(
      (body as { thinking?: unknown }).thinking,
      { type: "enabled" },
      "DeepSeek stripBodyFields=[]，不应 strip body 字段(与历史等价)",
    );
    assert.equal(
      (body as { metadata?: { user_id?: unknown } }).metadata?.user_id,
      "client-original",
    );
  });

  test("sanitizeMessages 返回原 messages 引用;zeroizeSecrets noop 幂等", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { deepseek: "k" } },
      bodyFor("deepseek-v4-pro"),
      DEEPSEEK_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const messages = [{ role: "user", content: "hi" }];
    assert.equal(res.session.sanitizeMessages(messages, "deepseek-v4-pro", log), messages);
    res.session.zeroizeSecrets();
    res.session.zeroizeSecrets();
  });
});

// ─── pickUpstream — MiniMax 路径(等价回归)───────────────────────────────

describe("pickUpstream — MiniMax route", () => {
  test("不调 scheduler;endpoint=ark-agent-plan(/api/plan/v1/messages);Bearer Token Plan key + strip beta/3 body extras(**保留 thinking**,MiniMax-M3 是思考模型)", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { minimax: "MM-KEY" } },
      bodyFor("MiniMax-M3"),
      MINIMAX_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const { session } = res;
    assert.equal(sched.pickCalls, 0, "MiniMax 路径绝不调 scheduler.pick");
    assert.equal(session.accountId, null);
    // 静态 provider 走显式直连 dispatcher,绕开全局日本代理。
    assert.equal(session.dispatcher, directEgressDispatcher());
    assert.equal(session.shouldUpdateQuotaFromResponse, false);
    // 2026-07-07:MiniMax-M3 文本/识图上游切回 MiniMax 官方(回退 06-30 火山迁移;火山 Ark 大图识图挂死)。
    assert.ok(session.endpoint.includes("api.minimaxi.com/anthropic/v1/messages"));

    const safeHeaders: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    };
    const body = {
      metadata: { user_id: "client-original" },
      output_config: { effort: "max" },
      context_management: { edits: [] },
      thinking: { type: "enabled" },
      service_tier: "priority",
    } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth(safeHeaders, body, log);
    assert.equal(safeHeaders.authorization, "Bearer MM-KEY");
    assert.equal(safeHeaders["anthropic-beta"], undefined);
    assert.equal((body as { output_config?: unknown }).output_config, undefined);
    assert.equal((body as { context_management?: unknown }).context_management, undefined);
    // 2026-06-16:minimax 不再 strip thinking(MiniMax-M3 是思考模型,端点接受 thinking 参数)。
    assert.deepEqual((body as { thinking?: unknown }).thinking, { type: "enabled" });
    assert.equal((body as { service_tier?: unknown }).service_tier, undefined);
    assert.equal(
      (body as { metadata?: { user_id?: unknown } }).metadata?.user_id,
      "client-original",
    );
  });
});

// ─── pickUpstream — Ark(glm-5.1)路径(新增)──────────────────────────────

describe("pickUpstream — Ark glm-5.1 route", () => {
  test("不调 scheduler;endpoint=ark coding;Bearer ARK key + strip beta/2 body extras;output_config 留合法 effort;保留 metadata/thinking", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { ark: "ARK-KEY" } },
      bodyFor("glm-5.1"),
      ARK_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const { session } = res;
    assert.equal(sched.pickCalls, 0, "Ark 路径绝不调 scheduler.pick");
    assert.equal(session.accountId, null);
    assert.equal(session.pinnedUserId, null);
    // 火山 ark 北京端点走显式直连 dispatcher,绕开全局日本代理(否则双重跨境长流式半路断)。
    assert.equal(session.dispatcher, directEgressDispatcher());
    assert.equal(session.shouldUpdateQuotaFromResponse, false);
    assert.ok(
      session.endpoint.includes("ark.cn-beijing.volces.com/api/coding/v1/messages"),
      `unexpected ark endpoint: ${session.endpoint}`,
    );

    const safeHeaders: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    };
    const body = {
      metadata: { user_id: "client-original" },
      output_config: { effort: "max" },
      context_management: { edits: [] },
      thinking: { type: "enabled", budget_tokens: 1024 },
      service_tier: "priority",
    } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth(safeHeaders, body, log);
    assert.equal(safeHeaders.authorization, "Bearer ARK-KEY");
    assert.equal(safeHeaders["anthropic-beta"], undefined);
    // output_config 不整体 strip:effort=max 是合法档位 → 重建为 { effort: "max" } 透传火山。
    assert.deepEqual(
      (body as { output_config?: unknown }).output_config,
      { effort: "max" },
      "ark 应保留合法 effort 思考深度(收窄为只剩 effort 子字段)",
    );
    assert.equal((body as { context_management?: unknown }).context_management, undefined);
    assert.equal((body as { service_tier?: unknown }).service_tier, undefined);
    // **glm-5.1 是 thinking 模型:thinking 必须被保留(不 strip)**,透传给 Ark。
    assert.deepEqual(
      (body as { thinking?: unknown }).thinking,
      { type: "enabled", budget_tokens: 1024 },
      "Ark 路径必须保留 thinking 参数(与 MiniMax 不同)",
    );
    assert.equal(
      (body as { metadata?: { user_id?: unknown } }).metadata?.user_id,
      "client-original",
    );
  });

  test("sanitizeMessages 返回原引用;zeroizeSecrets noop 幂等", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { ark: "k" } },
      bodyFor("glm-5.1"),
      ARK_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const messages = [{ role: "user", content: "hi" }];
    assert.equal(res.session.sanitizeMessages(messages, "glm-5.1", log), messages);
    res.session.zeroizeSecrets();
    res.session.zeroizeSecrets();
  });
});

// ─── Ark output_config effort 白名单清洗(边界)────────────────────────────

describe("pickUpstream — Ark output_config effort 白名单清洗", () => {
  async function arkSession() {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { ark: "k" } },
      bodyFor("glm-5.2"),
      ARK_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("ark pick failed");
    return res.session;
  }
  function cleanse(
    session: Awaited<ReturnType<typeof arkSession>>,
    outputConfig: unknown,
  ): unknown {
    const body = {
      metadata: {},
      ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
    } as unknown as Parameters<typeof session.applyUpstreamAuth>[1];
    session.applyUpstreamAuth({}, body, log);
    return (body as { output_config?: unknown }).output_config;
  }

  test("合法档位 high/max → 保留(收窄为只剩 effort 子字段)", async () => {
    const s = await arkSession();
    assert.deepEqual(cleanse(s, { effort: "high" }), { effort: "high" });
    assert.deepEqual(cleanse(s, { effort: "max" }), { effort: "max" });
  });
  test("火山合法但产品未开放的 low/medium → 删整个 output_config", async () => {
    const s = await arkSession();
    assert.equal(cleanse(s, { effort: "low" }), undefined);
    assert.equal(cleanse(s, { effort: "medium" }), undefined);
  });
  test("非法档位 minimal/xhigh → 删", async () => {
    const s = await arkSession();
    assert.equal(cleanse(s, { effort: "minimal" }), undefined);
    assert.equal(cleanse(s, { effort: "xhigh" }), undefined);
  });
  test("混入其他 firstParty-only 子字段 + 合法 effort → 收窄为只剩 effort", async () => {
    const s = await arkSession();
    assert.deepEqual(
      cleanse(s, { effort: "max", task_budget: { tokens: 1 }, format: { type: "json" } }),
      { effort: "max" },
    );
  });
  test("缺 effort / 非 string / 非 object / array / null / 无 output_config → 删或 noop", async () => {
    const s = await arkSession();
    assert.equal(cleanse(s, { task_budget: { tokens: 1 } }), undefined);
    assert.equal(cleanse(s, { effort: 3 }), undefined);
    assert.equal(cleanse(s, "max"), undefined);
    assert.equal(cleanse(s, ["max"]), undefined); // array(typeof==object)被 Array.isArray 排除
    assert.equal(cleanse(s, null), undefined);
    assert.equal(cleanse(s, undefined), undefined);
  });
});

// ─── OpenCode Go signature-bound history retention ─────────────────────

describe("pickUpstream — OpenCode Go 同 provider 历史", () => {
  test("合法签名块首发原样保留，且不改持久历史", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { opencodego: "QWEN-KEY" } },
      bodyFor("qwen3.7-max"),
      OPENCODEGO_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const messages = [
      { role: "user", content: [{ type: "thinking", thinking: "user literal" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "provider-A" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "connector_text", text: "signed connector" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } },
        ],
      },
    ];
    const before = structuredClone(messages);
    const sanitized = res.session.sanitizeMessages(messages, "qwen3.7-max", log);

    assert.deepEqual(messages, before, "清洗只能作用于 outbound copy，禁止改写持久历史");
    assert.equal(sanitized, messages);
    assert.deepEqual(sanitized, before);
  });

  test("签名块与普通文本都保留原引用", async () => {
    const sched = makeScheduler({});
    const res = await pickUpstream(
      { scheduler: sched.scheduler, staticProviderKeys: { opencodego: "QWEN-KEY" } },
      bodyFor("qwen3.7-plus"),
      OPENCODEGO_ROUTE,
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const onlyBound = [{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }];
    const cleaned = res.session.sanitizeMessages(onlyBound, "qwen3.7-plus", log);
    assert.equal(cleaned, onlyBound);
    const plain = [{ role: "assistant", content: "plain" }];
    assert.equal(res.session.sanitizeMessages(plain, "qwen3.7-plus", log), plain);
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

describe("pickUpstream — OAuth account groups", () => {
  const groupRow = (id: bigint, priority: number) => ({
    id,
    label: `group-${id}`,
    kind: "official_oauth" as const,
    provider: "claude" as const,
    enabled: true,
    priority,
    models: ["claude-sonnet-4-6"],
    created_at: new Date(0),
    updated_at: new Date(0),
  });

  test("enabled groups are tried by priority until one scheduler pick succeeds", async () => {
    const pickInputs: Array<{ groupId?: bigint | string | null }> = [];
    const scheduler: PickUpstreamDeps["scheduler"] = {
      async pick(input) {
        pickInputs.push(input);
        if (input.groupId === 10n) throw new AccountPoolUnavailableError("group empty");
        return makePick({ account_id: 20n });
      },
      async release() {},
    };
    const res = await pickUpstream(
      {
        scheduler,
        listEnabledAccountGroupsForModel: async (args) => {
          assert.deepEqual(args, {
            modelId: "claude-sonnet-4-6",
            kind: "official_oauth",
            provider: "claude",
          });
          return [groupRow(10n, 10), groupRow(20n, 20)];
        },
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(pickInputs.map((i) => i.groupId), [10n, 20n]);
    if (!res.ok) return;
    assert.equal(res.session.accountId, 20n);
  });

  test("temporary session-pin miss in earlier group continues to lower-priority groups", async () => {
    const pickInputs: Array<{ groupId?: bigint | string | null }> = [];
    const scheduler: PickUpstreamDeps["scheduler"] = {
      async pick(input) {
        pickInputs.push(input);
        if (input.groupId === 10n) {
          throw new SessionPinTemporarilyUnavailableError("pin outside this group", 0);
        }
        return makePick({ account_id: 20n });
      },
      async release() {},
    };
    const res = await pickUpstream(
      {
        scheduler,
        listEnabledAccountGroupsForModel: async () => [groupRow(10n, 10), groupRow(20n, 20)],
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(pickInputs.map((i) => i.groupId), [10n, 20n]);
    if (!res.ok) return;
    assert.equal(res.session.accountId, 20n);
  });

  test("no enabled group for model fails before scheduler.pick", async () => {
    let pickCalled = false;
    const scheduler: PickUpstreamDeps["scheduler"] = {
      async pick() {
        pickCalled = true;
        return makePick();
      },
      async release() {},
    };
    const res = await pickUpstream(
      {
        scheduler,
        listEnabledAccountGroupsForModel: async () => [],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    assert.equal(pickCalled, false);
  });
});

// ─── pickUpstream — OAuth happy path ─────────────────────────────────────

describe("pickUpstream — OAuth happy path", () => {
  test("不到期 → 不调 refresh;session.accountId/pinnedUserId/dispatcher/quota 正确", async () => {
    // A2:dispatcher 传播只对**已绑**账号有意义 → 绑 egress 让 stub dispatcher 落到 session
    const pick = makePick({
      expires_at: null,
      egress_proxy: "http://egress.test:8080",
      egress_proxy_id: 1n,
    });
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

  // ─── v3 反关联根治 0073/0074 — persona header 注入 ────────────────────
  //
  // 验证 applyUpstreamAuth 把 pick.persona 写到 safeHeaders 上,且 null 时
  // fail-open(不抛、不写,只 log.warn — 我们在这只断言"未写")。

  test("pick.persona 非 null → 9 个 stainless / accept-language / user-agent headers 全注入", async () => {
    const persona = {
      user_agent: "anthropic-ai-claude-code/1.0.71 Node/v22.16.0 Linux",
      x_stainless_arch: "x64",
      x_stainless_lang: "js",
      x_stainless_os: "Linux",
      x_stainless_package_version: "1.0.71",
      x_stainless_runtime: "node",
      x_stainless_runtime_version: "v22.16.0",
      x_stainless_retry_count: "0",
      accept_language: "en-US,en;q=0.9",
    };
    const { session } = await makeSession({ persona });
    const headers: Record<string, string> = {};
    session.applyUpstreamAuth(headers, { metadata: {} } as never, log);

    assert.equal(headers["user-agent"], persona.user_agent);
    assert.equal(headers["x-stainless-arch"], persona.x_stainless_arch);
    assert.equal(headers["x-stainless-lang"], persona.x_stainless_lang);
    assert.equal(headers["x-stainless-os"], persona.x_stainless_os);
    assert.equal(headers["x-stainless-package-version"], persona.x_stainless_package_version);
    assert.equal(headers["x-stainless-runtime"], persona.x_stainless_runtime);
    assert.equal(headers["x-stainless-runtime-version"], persona.x_stainless_runtime_version);
    assert.equal(headers["x-stainless-retry-count"], persona.x_stainless_retry_count);
    assert.equal(headers["accept-language"], persona.accept_language);
  });

  test("pick.persona = null → fail-open,9 个 persona headers 完全未写(undici 默认头兜底)", async () => {
    const { session } = await makeSession({ persona: null });
    const headers: Record<string, string> = {};
    session.applyUpstreamAuth(headers, { metadata: {} } as never, log);

    assert.equal(headers["user-agent"], undefined);
    assert.equal(headers["x-stainless-arch"], undefined);
    assert.equal(headers["x-stainless-lang"], undefined);
    assert.equal(headers["x-stainless-os"], undefined);
    assert.equal(headers["x-stainless-package-version"], undefined);
    assert.equal(headers["x-stainless-runtime"], undefined);
    assert.equal(headers["x-stainless-runtime-version"], undefined);
    assert.equal(headers["x-stainless-retry-count"], undefined);
    assert.equal(headers["accept-language"], undefined);
    // Bearer 仍然写(persona null 不影响其他注入)
    assert.match(headers.authorization, /^Bearer /);
  });

  test("persona 注入不破坏 anthropic-beta 合并(两者都在,顺序 oauth-2025-04-20 在前)", async () => {
    const persona = {
      user_agent: "ua-marker",
      x_stainless_arch: "arm64",
      x_stainless_lang: "js",
      x_stainless_os: "MacOS",
      x_stainless_package_version: "1.0.110",
      x_stainless_runtime: "node",
      x_stainless_runtime_version: "v22.14.0",
      x_stainless_retry_count: "0",
      accept_language: "ja-JP,ja;q=0.9,en;q=0.8",
    };
    const { session } = await makeSession({ persona });
    const headers: Record<string, string> = {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    };
    session.applyUpstreamAuth(headers, { metadata: {} } as never, log);

    assert.equal(headers["user-agent"], "ua-marker");
    const tokens = headers["anthropic-beta"].split(",").map((s) => s.trim());
    assert.equal(tokens[0], "oauth-2025-04-20");
    assert.ok(tokens.includes("interleaved-thinking-2025-05-14"));
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

  test("形状合法的长签名块首发保留，由明确签名错误后的 core 重试负责跨 provider 恢复", async () => {
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
    const messages = [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "foreign", signature: "q".repeat(256) },
        { type: "redacted_thinking", data: "r".repeat(256) },
        { type: "connector_text", text: "foreign connector" },
        { type: "text", text: "portable answer" },
      ],
    }];
    const before = structuredClone(messages);
    const out = res.session.sanitizeMessages(messages, "claude-sonnet-4-6", log) as Array<{
      content: Array<{ type: string }>;
    }>;
    assert.deepEqual(messages, before);
    assert.equal(out, messages);
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
      // A2:HIGH#5 同出口锚定只对已绑账号有意义 → 绑 egress
      egress_proxy: "http://egress.test:8080",
      egress_proxy_id: 1n,
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

// ─── pickUpstream — A2 出口 fail-closed ──────────────────────────────────

describe("pickUpstream — A2 egress fail-closed", () => {
  test("已绑 proxy 但 dispatcher 解析失败 → pool_unavailable(egress_unavailable) + release(transient_network) + zero token", async () => {
    const pick = makePick({
      egress_proxy: "http://broken.test:8080",
      egress_proxy_id: 1n,
    });
    const sched = makeScheduler({ pickResult: pick });
    let getDispatcherCalls = 0;
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => {
          getDispatcherCalls += 1;
          return undefined;
        }) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    if (res.error.kind !== "pool_unavailable") return;
    assert.equal((res.error.err as { reason?: string }).reason, "egress_unavailable");
    assert.equal(getDispatcherCalls, 1);
    assert.equal(sched.releaseCalls.length, 1);
    assert.equal(sched.releaseCalls[0].result.kind, "transient_network");
    assert.ok(pick.token.every((b) => b === 0), "token 必须零化");
    assert.ok(pick.refresh!.every((b) => b === 0), "refresh 必须零化");
  });

  test("已绑 proxy 但 proxy 被 disabled(egress_proxy=null)+ host ready → 仍 fail-closed,绝不回落 mTLS host", async () => {
    const pick = makePick({
      egress_proxy: null, // 池 entry 被 disabled → 解析为 null
      egress_proxy_id: 1n, // 但绑定权威源仍在(0055:claude 恒非 null)
      egress_target: {
        kind: "mtls",
        hostUuid: "h-1",
        host: "10.0.0.1",
        port: 9444,
        fingerprint: "ab".repeat(32),
        pskNonce: Buffer.alloc(12),
        pskCt: Buffer.alloc(16),
      },
      egress_host_uuid: "h-1",
    });
    const sched = makeScheduler({ pickResult: pick });
    let getDispatcherCalls = 0;
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => {
          getDispatcherCalls += 1;
          return { kind: "host-dispatcher" } as unknown as undefined;
        }) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    // 关键:proxy 权威优先 → proxy 解析为空即 fail-closed,绝不调 dispatcher 回落 host
    assert.equal(getDispatcherCalls, 0, "绝不回落到 mTLS host(否则 profile/chat IP 分叉)");
    assert.equal(sched.releaseCalls[0].result.kind, "transient_network");
  });

  test("仅绑 mTLS host 但 host 未 ready(egress_target=null)→ fail-closed", async () => {
    const pick = makePick({
      egress_proxy: null,
      egress_proxy_id: null, // 无 proxy 绑定
      egress_target: null, // host 未 ready
      egress_host_uuid: "h-2", // 绑定权威源在
    });
    const sched = makeScheduler({ pickResult: pick });
    let getDispatcherCalls = 0;
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => {
          getDispatcherCalls += 1;
          return undefined;
        }) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    assert.equal(getDispatcherCalls, 0);
  });

  test("真正未绑 + dispatcher undefined → 照常放行(default 出口,行为不变)", async () => {
    const pick = makePick({
      egress_proxy: null,
      egress_proxy_id: null,
      egress_host_uuid: null,
    });
    const sched = makeScheduler({ pickResult: pick });
    let getDispatcherCalls = 0;
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getDispatcher: (async () => {
          getDispatcherCalls += 1;
          return undefined;
        }) as PickUpstreamDeps["getDispatcher"],
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.session.dispatcher, undefined);
    assert.equal(getDispatcherCalls, 1, "未绑分支仍调一次 getDispatcher(null,null) 做 evict 清理");
    assert.equal(sched.releaseCalls.length, 0);
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
        staticProviderKeys: { deepseek: "k" },
        upstreamEndpoint: "https://override.test/v1/messages",
      },
      bodyFor("deepseek-v4-pro"),
      DEEPSEEK_ROUTE,
      log,
    );
    assert.equal(ds.ok, true);
    if (!ds.ok) return;
    assert.match(
      ds.session.endpoint,
      /deepseek/i,
      "DeepSeek endpoint 由 registry spec 决定,不受 upstreamEndpoint 覆盖影响",
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
      { scheduler, staticProviderKeys: { deepseek: "k" } },
      bodyFor("deepseek-v4-pro"),
      DEEPSEEK_ROUTE,
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

// ─── Phase 6 H6 — account_uuid 三态闭环(applyUpstreamAuth hook + scheduler 透传 + refresh rebind)
//
// 这些是 upstream 层 unit:验证 pickUpstream/applyUpstreamAuth/refresh rebind 三处
// 在 phase6Enforce off/fail_open/fail_closed 下的协调。
//   - H6.A 集成验证落在 ccExternalEndpoint.integ.test.ts(metadata.account_uuid 字节级)
//   - 此处覆盖三处枢纽:enforceAccountUuid 透传 / null 候选下 hook 静默/告警 /
//     refresh rebind 保留 pick.account_uuid。

describe("pickUpstream — phase6 enforce 透传到 scheduler.pick", () => {
  test("phase6Enforce=fail_closed → scheduler.pick({enforceAccountUuid:true})", async () => {
    let observedEnforce: boolean | undefined = "<unset>" as unknown as boolean | undefined;
    const sched: PickUpstreamDeps["scheduler"] = {
      async pick(input) {
        observedEnforce = input.enforceAccountUuid;
        return makePick({ account_uuid: "12345678-9abc-def0-1234-56789abcdef0" });
      },
      async release() {},
    };
    const res = await pickUpstream(
      {
        scheduler: sched,
        getPhase6AccountUuidEnforce: async () => "fail_closed",
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.equal(observedEnforce, true);
  });

  test("phase6Enforce=fail_open → scheduler.pick({enforceAccountUuid:false})", async () => {
    let observedEnforce: boolean | undefined = "<unset>" as unknown as boolean | undefined;
    const sched: PickUpstreamDeps["scheduler"] = {
      async pick(input) {
        observedEnforce = input.enforceAccountUuid;
        return makePick();
      },
      async release() {},
    };
    const res = await pickUpstream(
      {
        scheduler: sched,
        getPhase6AccountUuidEnforce: async () => "fail_open",
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.equal(observedEnforce, false);
  });

  test("phase6Enforce 未注入(默认 off)→ scheduler.pick({enforceAccountUuid:false})", async () => {
    let observedEnforce: boolean | undefined = "<unset>" as unknown as boolean | undefined;
    const sched: PickUpstreamDeps["scheduler"] = {
      async pick(input) {
        observedEnforce = input.enforceAccountUuid;
        return makePick();
      },
      async release() {},
    };
    const res = await pickUpstream(
      {
        scheduler: sched,
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.equal(observedEnforce, false);
  });

  test("scheduler 抛 'no_uuid' → pool_unavailable error;无 release 调用", async () => {
    const releaseCalls: ReleaseInput[] = [];
    const sched: PickUpstreamDeps["scheduler"] = {
      async pick() {
        throw new AccountPoolUnavailableError("no_uuid");
      },
      async release(input) {
        releaseCalls.push(input);
      },
    };
    const res = await pickUpstream(
      {
        scheduler: sched,
        getPhase6AccountUuidEnforce: async () => "fail_closed",
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    if (res.error.kind !== "pool_unavailable") return;
    // 结构化 reason 拿来给 metric label 分桶用
    assert.equal(res.error.err.reason, "no_uuid");
    // pool_unavailable 时无 account 持有,scheduler.release 不应被调
    assert.equal(releaseCalls.length, 0);
  });

  // Codex round 2 MINOR 1 defense-in-depth:
  // scheduler 在 fail_closed 下应过滤 NULL account_uuid 候选,但若 race condition
  // 让 NULL 漏到 pickUpstream,必须 fail closed(不是 log + warn-and-proceed)。
  test("defense-in-depth: fail_closed + scheduler 返回 account_uuid=null pick → 503 no_uuid_post_scheduler + 立即 release(failure)", async () => {
    const releaseCalls: ReleaseInput[] = [];
    const tokenBuf = Buffer.from("LEAKED-TOKEN", "utf8");
    const refreshBuf = Buffer.from("LEAKED-REFRESH", "utf8");
    const sched: PickUpstreamDeps["scheduler"] = {
      async pick() {
        // 模拟 scheduler bug:fail_closed 模式下却返回了 null uuid 的 pick
        return makePick({
          account_uuid: null,
          token: tokenBuf,
          refresh: refreshBuf,
        });
      },
      async release(input) {
        releaseCalls.push(input);
      },
    };
    const res = await pickUpstream(
      {
        scheduler: sched,
        getPhase6AccountUuidEnforce: async () => "fail_closed",
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error.kind, "pool_unavailable");
    if (res.error.kind !== "pool_unavailable") return;
    assert.equal(res.error.err.reason, "no_uuid_post_scheduler",
      "defense-in-depth reject 必须用独立 reason,跟 scheduler 内置 'no_uuid' 区分");
    // 必须立即 release 持有的 pick(failure kind 扣健康分,作为运维信号)
    assert.equal(releaseCalls.length, 1);
    assert.equal(releaseCalls[0].result.kind, "failure");
    // token / refresh 必须零化(防 leaked pick 留在 process memory)
    assert.ok(tokenBuf.every((b) => b === 0), "token buffer 必须零化");
    assert.ok(refreshBuf.every((b) => b === 0), "refresh buffer 必须零化");
  });

  // fail_open 模式下 scheduler 不过滤 null,pickUpstream 也不该拦 — null pick
  // 应当走通,applyUpstreamAuth 走静默跳过分支(builder HMAC 占位透出)。
  test("fail_open + scheduler 返回 account_uuid=null pick → 不拦,走 happy path", async () => {
    const sched = makeScheduler({
      pickResult: makePick({ account_uuid: null }),
    });
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getPhase6AccountUuidEnforce: async () => "fail_open",
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    assert.equal(sched.releaseCalls.length, 0);
  });
});

describe("applyUpstreamAuth — phase6 account_uuid 三态分支", () => {
  const REAL_UUID = "12345678-9abc-def0-1234-56789abcdef0";

  async function runApplyAuth(opts: {
    accountUuid: string | null;
    phase6Enforce: "off" | "fail_open" | "fail_closed";
    metadataUserId?: string;
  }) {
    const sched = makeScheduler({
      pickResult: makePick({ account_uuid: opts.accountUuid }),
    });
    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        getPhase6AccountUuidEnforce: async () => opts.phase6Enforce,
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const headers: Record<string, string> = {};
    const body: Record<string, unknown> = opts.metadataUserId !== undefined
      ? { metadata: { user_id: opts.metadataUserId } }
      : {};
    // applyUpstreamAuth 是 PreparedUpstreamSession 的合约方法 — body 类型 ProxyBody
    res.session.applyUpstreamAuth(headers, body as never, log);
    return body;
  }

  test("off + accountUuid 存在 → hook 不跑,metadata.user_id 不含 account_uuid(只 device_id)", async () => {
    const body = await runApplyAuth({
      accountUuid: REAL_UUID,
      phase6Enforce: "off",
    });
    // off 路径:device_id rewrite(iii)仍跑,但 account_uuid hook(iv)早退
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, unknown>;
    assert.equal(userIdObj.device_id, PINNED_OK);
    assert.equal(userIdObj.account_uuid, undefined, "off 模式不应注入 account_uuid");
  });

  test("fail_open + accountUuid=null → hook 静默跳过,metadata.user_id 不被注入", async () => {
    const body = await runApplyAuth({
      accountUuid: null,
      phase6Enforce: "fail_open",
    });
    // fail_open + null:hook 走 null 分支静默跳过,body 不增字段
    // (但 device_id rewrite 仍会注入 metadata.user_id — 因 PINNED_OK 合法)
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, unknown>;
    assert.equal(userIdObj.account_uuid, undefined, "null 候选不应注入 account_uuid");
  });

  test("fail_open + accountUuid=REAL_UUID → metadata.user_id.account_uuid = REAL_UUID", async () => {
    const body = await runApplyAuth({
      accountUuid: REAL_UUID,
      phase6Enforce: "fail_open",
    });
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, string>;
    assert.equal(userIdObj.account_uuid, REAL_UUID);
  });

  test("fail_closed + accountUuid=REAL_UUID + 客户端原 metadata.user_id 含 device_id → device_id 被覆盖且 account_uuid 注入", async () => {
    const body = await runApplyAuth({
      accountUuid: REAL_UUID,
      phase6Enforce: "fail_closed",
      metadataUserId: JSON.stringify({ device_id: "client-device" }),
    });
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, string>;
    // device_id 被 pinned_user_id(PINNED_OK = 'f' * 64)覆盖
    assert.equal(userIdObj.device_id, PINNED_OK);
    // account_uuid 是 hook(iv)注入
    assert.equal(userIdObj.account_uuid, REAL_UUID);
  });

  test("fail_open + accountUuid='bad-uuid'(非 canonical hex 8-4-4-4-12)→ hook 早退,不重写", async () => {
    const body = await runApplyAuth({
      accountUuid: "not-a-uuid",
      phase6Enforce: "fail_open",
    });
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, unknown>;
    // 脏数据 → fail-open 不重写,只 log.warn
    assert.equal(userIdObj.account_uuid, undefined);
  });

  // ─── BLOCKER 1 修复:fail_closed strict 强 normalize 客户端 malformed 输入 ───
  test("fail_closed + 客户端 metadata.user_id 是非法 JSON 字符串 → 强 normalize 注入 account_uuid", async () => {
    const body = await runApplyAuth({
      accountUuid: REAL_UUID,
      phase6Enforce: "fail_closed",
      metadataUserId: "not-a-json-string",
    });
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, string>;
    assert.equal(userIdObj.account_uuid, REAL_UUID,
      "fail_closed 必须无视客户端 malformed 输入强写 account_uuid(H6 invariant 闭环)");
  });

  test("fail_closed + 客户端 metadata.user_id 是 JSON 数组 → 强 normalize 注入 account_uuid", async () => {
    const body = await runApplyAuth({
      accountUuid: REAL_UUID,
      phase6Enforce: "fail_closed",
      metadataUserId: "[1,2,3]",
    });
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, string>;
    assert.equal(userIdObj.account_uuid, REAL_UUID);
  });

  test("fail_open + 客户端 metadata.user_id 是非法 JSON 字符串 → 保持原值(不 normalize,避诡异输入推上游)", async () => {
    const body = await runApplyAuth({
      accountUuid: REAL_UUID,
      phase6Enforce: "fail_open",
      metadataUserId: "not-a-json-string",
    });
    // device_id rewrite (iii) 也会被 malformed 输入卡住 — rewriteMetadataDeviceId 同语义保留原值。
    // 关键断言:account_uuid hook 没硬塞,保持 fail-open 语义
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    assert.equal(userIdStr, "not-a-json-string",
      "fail_open 必须保留 malformed 输入,不强 normalize");
  });
});

describe("pickUpstream — H6.D refresh rebind 保留 pick.account_uuid", () => {
  test("refresh 完后 pick.account_uuid 仍是原值 → applyUpstreamAuth metadata.account_uuid = 原 UUID", async () => {
    const REAL_UUID = "abcdef01-2345-6789-abcd-ef0123456789";
    const oldToken = Buffer.from("OLD-TOKEN", "utf8");
    const oldRefresh = Buffer.from("OLD-REFRESH", "utf8");
    const pick = makePick({
      token: oldToken,
      refresh: oldRefresh,
      expires_at: new Date(Date.now() - 1000), // 已过期 → 触发 refresh
      account_uuid: REAL_UUID,
    });
    const sched = makeScheduler({ pickResult: pick });

    const refreshAccountTokenImpl = (async () => {
      return {
        token: Buffer.from("NEW-TOKEN", "utf8"),
        refresh: Buffer.from("NEW-REFRESH", "utf8"),
        expires_at: new Date(Date.now() + 3600_000),
      };
    }) as unknown as PickUpstreamDeps["refreshAccountTokenImpl"];

    const res = await pickUpstream(
      {
        scheduler: sched.scheduler,
        refreshDeps: {} as RefreshDeps,
        refreshAccountTokenImpl,
        getDispatcher: (async () => undefined) as PickUpstreamDeps["getDispatcher"],
        getPhase6AccountUuidEnforce: async () => "fail_closed",
      },
      bodyFor("claude-sonnet-4-6"),
      { kind: "oauth" },
      log,
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;

    // 老 token + refresh 必须被零化(refresh rebind 副作用)
    assert.ok(oldToken.every((b) => b === 0), "老 token 已零化");
    assert.ok(oldRefresh.every((b) => b === 0), "老 refresh 已零化");

    // 关键断言:applyUpstreamAuth 仍能读到 REAL_UUID,证明 refresh rebind 保留了 account_uuid
    const headers: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    res.session.applyUpstreamAuth(headers, body as never, log);
    const userIdStr = (body.metadata as Record<string, string>).user_id;
    const userIdObj = JSON.parse(userIdStr) as Record<string, string>;
    assert.equal(userIdObj.account_uuid, REAL_UUID, "refresh 后 account_uuid 仍要可用");
  });
});
