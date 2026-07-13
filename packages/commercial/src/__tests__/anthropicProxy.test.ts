/**
 * V3 Phase 2 Task 2D — anthropicProxy 单元测试(纯函数 / in-memory 部分)。
 *
 * 跑法: npx tsx --test src/__tests__/anthropicProxy.test.ts
 *
 * 覆盖:
 *   - body schema (strict, 拒绝 unknown 字段, 拒绝 stream:false, max_tokens 范围)
 *   - 字节预算 (messages/system/tools 单字段超限 → 413)
 *   - estimateInputTokens (chars/4)
 *   - estimateMaxCostBothSides (input + output 双侧用 output 单价)
 *   - buildSafeUpstreamHeaders (anthropic-version 严格 / anthropic-beta allowlist)
 *   - ConcurrencyLimiter (per-key cap + release 释放)
 *   - UsageObserver (SSE message_start / message_delta + final detection)
 *
 * 整链 e2e(SSE upstream + journal commit / abort)放 anthropicProxy.integ.test.ts。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  proxyBodySchema,
  enforceFieldByteBudgets,
  estimateInputTokens,
  estimateMaxCostBothSides,
  buildSafeUpstreamHeaders,
  ConcurrencyLimiter,
  extractSessionId,
  isDeepseekModel,
  isAnthropicInvalidRequestError,
  isClientAbort,
  rewriteMetadataAccountUuid,
  rewriteMetadataDeviceId,
  stripMalformedThinkingBlocks,
  stripNonTextContentBlocks,
  isUuidLike,
  DEEPSEEK_UPSTREAM_ENDPOINT,
  ALLOWED_BETA_VALUES,
  ANTHROPIC_VERSION,
  SIZE_LIMITS,
  MAX_TOOLS_COUNT,
  _UsageObserver,
  type ProxyBody,
} from "../http/anthropicProxy.js";
import { makeFinalizer } from "../billing/proxyBilling.js";
import { rootLogger } from "../logging/logger.js";
import { HttpError } from "../http/util.js";
import type { ModelPricing } from "../billing/pricing.js";

const sonnet: ModelPricing = {
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
  default_effort: null,
  updated_at: new Date("2026-04-01T00:00:00Z"),
};

// ─── body schema ──────────────────────────────────────────────────────────

describe("proxyBodySchema — happy path", () => {
  test("最小可用 body", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.success, true);
  });

  test("带 system / tools / temperature / top_p / top_k / stream:true", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      system: "be brief",
      tools: [{ name: "calc", description: "..." }],
      temperature: 0.5,
      top_p: 0.95,
      top_k: 40,
      stream: true,
      stop_sequences: ["\n\n"],
      metadata: { user_id: "u1", session_id: "s1" },
    });
    assert.equal(r.success, true);
  });

  // 2026-04-22 回归:前端"思考深度"菜单选非默认档 → CCB 把 effort 放进
  // output_config 里下来,proxy 不放行就整轮 400 BAD_BODY。
  test("带 output_config: { effort: 'max' } (CCB effort beta)", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    });
    assert.equal(r.success, true);
  });
});

describe("proxyBodySchema — 拒绝 unknown 字段(strict)", () => {
  test("body 顶层多 1 个字段 → fail", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      max_tokens_to_sample: 999, // 老版本字段,绝不允许混进
    });
    assert.equal(r.success, false);
  });

  test("metadata 子对象多字段 → fail(metadata 也是 strict)", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "u1", evil: true },
    });
    assert.equal(r.success, false);
  });
});

describe("proxyBodySchema — 数值/数组边界", () => {
  test("max_tokens <= 0 → fail", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 0,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.success, false);
  });

  test("max_tokens > 200_000 → fail", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1_000_000,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.success, false);
  });

  test("messages 空数组 → fail", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [],
    });
    assert.equal(r.success, false);
  });

  test("messages 超 2000 条 → fail", () => {
    const msgs = Array.from({ length: 2001 }, () => ({ role: "user", content: "x" }));
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: msgs,
    });
    assert.equal(r.success, false);
  });

  test("tools 允许商业版团队委派常见的 80 个小工具", () => {
    const tools = Array.from({ length: 80 }, (_, i) => ({
      name: `tool_${i}`,
      description: "small tool",
      input_schema: { type: "object" },
    }));
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools,
    });
    assert.equal(r.success, true);
  });

  test("tools 超过 MAX_TOOLS_COUNT → fail", () => {
    const tools = Array.from({ length: MAX_TOOLS_COUNT + 1 }, (_, i) => ({
      name: `tool_${i}`,
      description: "small tool",
      input_schema: { type: "object" },
    }));
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools,
    });
    assert.equal(r.success, false);
  });

  test("stream:false 显式给 → fail(我们只跑 stream)", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    assert.equal(r.success, false);
  });

  test("stream:true 显式给 OK,stream 字段省略也 OK", () => {
    for (const stream of [true, undefined]) {
      const r = proxyBodySchema.safeParse({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        ...(stream !== undefined ? { stream } : {}),
      });
      assert.equal(r.success, true);
    }
  });

  test("temperature 越界 → fail", () => {
    const r = proxyBodySchema.safeParse({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "x" }],
      temperature: 5,
    });
    assert.equal(r.success, false);
  });
});

// ─── 字节预算 ──────────────────────────────────────────────────────────────

describe("enforceFieldByteBudgets", () => {
  function bigStr(bytes: number): string {
    // ascii 一字符 = 1 byte
    return "a".repeat(bytes);
  }

  test("messages 字段 < limit → 通过", () => {
    const body: ProxyBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: bigStr(100) }],
    };
    assert.doesNotThrow(() => enforceFieldByteBudgets(body));
  });

  test("messages 序列化超 256KB → 413 BODY_FIELD_TOO_LARGE", () => {
    const body: ProxyBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: bigStr(SIZE_LIMITS.messages + 100) }],
    };
    assert.throws(
      () => enforceFieldByteBudgets(body),
      (e: unknown) =>
        e instanceof HttpError && e.status === 413 && e.code === "BODY_FIELD_TOO_LARGE",
    );
  });

  test("system 字符串超 32KB → 413", () => {
    const body: ProxyBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "ok" }],
      system: bigStr(SIZE_LIMITS.system + 100),
    };
    assert.throws(
      () => enforceFieldByteBudgets(body),
      (e: unknown) => e instanceof HttpError && e.status === 413,
    );
  });

  test("tools 序列化超 SIZE_LIMITS.tools → 413 BODY_FIELD_TOO_LARGE", () => {
    // 单个超大 description 覆盖 tools 字段字节预算上限。
    // 用 `SIZE_LIMITS.tools + 100` 而非 hard-coded KB,阈值变了测试自动跟随
    // (2026-04-21 调整后 64KB → 2MB,详见 src/http/proxy/shared.ts:133-149)。
    // 不用 MAX_TOOLS_COUNT-1 个小 tools 凑量是为了避开「tools 数组长度」这条
    // 正交校验,聚焦字段字节预算这条独立分支。
    const tools = [
      {
        name: "x",
        description: bigStr(SIZE_LIMITS.tools + 100),
        input_schema: { type: "object" },
      },
    ];
    const body: ProxyBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "ok" }],
      tools,
    };
    assert.throws(
      () => enforceFieldByteBudgets(body),
      (e: unknown) =>
        e instanceof HttpError && e.status === 413 && e.code === "BODY_FIELD_TOO_LARGE",
    );
  });
});

// ─── input token estimate ─────────────────────────────────────────────────

describe("estimateInputTokens", () => {
  test("空 messages → 至少 1 token(JSON 包装本身有几字符)", () => {
    const n = estimateInputTokens({
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: "" }],
    });
    assert.ok(n >= 1);
  });

  test("100 字符 content → 约 25 token(±2,因 JSON 包裹)", () => {
    const n = estimateInputTokens({
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: "a".repeat(100) }],
    });
    // [{"role":"user","content":"aaa..."}] ~ 130 chars / 4 = 33
    assert.ok(n >= 25 && n <= 50, `got ${n}`);
  });

  test("system + tools 也算入", () => {
    const small = estimateInputTokens({
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
    });
    const big = estimateInputTokens({
      model: "x",
      max_tokens: 1,
      messages: [{ role: "user", content: "x" }],
      system: "a".repeat(1000),
      tools: [{ name: "y", description: "a".repeat(1000) }],
    });
    assert.ok(big > small, "system+tools 应增加 token 估算");
  });
});

// ─── 双侧 cost 估算 ───────────────────────────────────────────────────────

describe("estimateMaxCostBothSides", () => {
  test("0 input + 0 output → 0", () => {
    assert.equal(estimateMaxCostBothSides(0, 0, sonnet), 0n);
  });

  test("1M 总 token (sonnet output 1500*2.0) → 3000 分", () => {
    // 与 estimateMaxCost(1_000_000, sonnet) 一致(双侧累加,单价同 output)
    assert.equal(estimateMaxCostBothSides(500_000, 500_000, sonnet), 3000n);
  });

  test("input 远大于 output 也按 output 单价(保守 = 安全)", () => {
    // 100k input + 1k output = 101k tokens
    // 101000 * 1500 * 2000 / 1e9 = 303 → ceil = 303
    assert.equal(estimateMaxCostBothSides(100_000, 1_000, sonnet), 303n);
  });
});

// ─── header allowlist ─────────────────────────────────────────────────────

describe("buildSafeUpstreamHeaders", () => {
  test("空 header → 默认三件套", () => {
    const h = buildSafeUpstreamHeaders({});
    assert.equal(h["content-type"], "application/json");
    assert.equal(h.accept, "text/event-stream");
    assert.equal(h["anthropic-version"], ANTHROPIC_VERSION);
    assert.equal(h["anthropic-beta"], undefined);
  });

  test("anthropic-version 与常量一致 → 通过", () => {
    const h = buildSafeUpstreamHeaders({ "anthropic-version": ANTHROPIC_VERSION });
    assert.equal(h["anthropic-version"], ANTHROPIC_VERSION);
  });

  test("anthropic-version 异值 → 400", () => {
    assert.throws(
      () => buildSafeUpstreamHeaders({ "anthropic-version": "2099-99-99" }),
      (e: unknown) =>
        e instanceof HttpError && e.status === 400 && e.code === "ANTHROPIC_VERSION_NOT_ALLOWED",
    );
  });

  test("白名单 beta 单值 → 通过", () => {
    const h = buildSafeUpstreamHeaders({ "anthropic-beta": "oauth-2025-04-20" });
    assert.equal(h["anthropic-beta"], "oauth-2025-04-20");
  });

  test("白名单 beta 多值 → 全过", () => {
    const h = buildSafeUpstreamHeaders({
      "anthropic-beta": "oauth-2025-04-20, claude-code-20250219",
    });
    assert.equal(h["anthropic-beta"], "oauth-2025-04-20,claude-code-20250219");
  });

  test("非白名单 beta → 400 ANTHROPIC_BETA_NOT_ALLOWED", () => {
    assert.throws(
      () => buildSafeUpstreamHeaders({ "anthropic-beta": "evil-beta-2099" }),
      (e: unknown) =>
        e instanceof HttpError && e.status === 400 && e.code === "ANTHROPIC_BETA_NOT_ALLOWED",
    );
  });

  test("白名单含一个 + 非白一个 → 400", () => {
    assert.throws(
      () =>
        buildSafeUpstreamHeaders({
          "anthropic-beta": "oauth-2025-04-20, evil",
        }),
      (e: unknown) => e instanceof HttpError && e.status === 400,
    );
  });

  test("ALLOWED_BETA_VALUES 包含 OAuth + claude-code 这两个核心值(回归)", () => {
    assert.equal(ALLOWED_BETA_VALUES.has("oauth-2025-04-20"), true);
    assert.equal(ALLOWED_BETA_VALUES.has("claude-code-20250219"), true);
  });
});

// ─── concurrency limiter ──────────────────────────────────────────────────

describe("ConcurrencyLimiter", () => {
  test("acquire 直到 cap 全占用 → 第 N+1 次返 null", () => {
    const c = new ConcurrencyLimiter(3);
    const r1 = c.acquire("uid:1");
    const r2 = c.acquire("uid:1");
    const r3 = c.acquire("uid:1");
    const r4 = c.acquire("uid:1");
    assert.ok(r1 && r2 && r3);
    assert.equal(r4, null);
    assert.equal(c.count("uid:1"), 3);
  });

  test("不同 key 互不影响", () => {
    const c = new ConcurrencyLimiter(1);
    assert.ok(c.acquire("uid:a"));
    assert.equal(c.acquire("uid:a"), null);
    assert.ok(c.acquire("uid:b"));
  });

  test("release 后再 acquire 成功", () => {
    const c = new ConcurrencyLimiter(1);
    const r = c.acquire("uid:1");
    assert.ok(r);
    assert.equal(c.acquire("uid:1"), null);
    r();
    assert.equal(c.count("uid:1"), 0);
    assert.ok(c.acquire("uid:1"));
  });

  test("release 幂等(多次调用只算一次)", () => {
    const c = new ConcurrencyLimiter(2);
    const r1 = c.acquire("uid:1");
    const r2 = c.acquire("uid:1");
    assert.ok(r1 && r2);
    r1();
    r1(); // 重复释放不应该让 count 变负
    assert.equal(c.count("uid:1"), 1);
    r2();
    assert.equal(c.count("uid:1"), 0);
  });

  test("maxPerKey <= 0 构造时抛", () => {
    assert.throws(() => new ConcurrencyLimiter(0), TypeError);
    assert.throws(() => new ConcurrencyLimiter(-1), TypeError);
  });
});

// ─── UsageObserver ────────────────────────────────────────────────────────

describe("UsageObserver — SSE 解析 + usage 提取", () => {
  function feedEvents(o: InstanceType<typeof _UsageObserver>, lines: string[]): void {
    o.push(lines.join("\n") + "\n\n");
  }

  test("初始 → kind:none", () => {
    const o = new _UsageObserver();
    assert.deepEqual(o.result(), { kind: "none" });
  });

  test("仅 message_start → kind:partial,input_tokens 设值", () => {
    const o = new _UsageObserver();
    feedEvents(o, [
      "event: message_start",
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "m1", usage: { input_tokens: 100, output_tokens: 0 } },
      })}`,
    ]);
    const r = o.result();
    assert.equal(r.kind, "partial");
    if (r.kind === "partial") {
      assert.equal(BigInt(r.usage.input_tokens), 100n);
      assert.equal(BigInt(r.usage.output_tokens), 0n);
    }
  });

  test("message_start + message_delta(无 stop_reason)→ partial(以 delta 为准)", () => {
    const o = new _UsageObserver();
    feedEvents(o, [
      "event: message_start",
      `data: ${JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 0 } },
      })}`,
    ]);
    feedEvents(o, [
      "event: message_delta",
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: {},
        usage: { input_tokens: 100, output_tokens: 50 },
      })}`,
    ]);
    const r = o.result();
    assert.equal(r.kind, "partial");
    if (r.kind === "partial") {
      assert.equal(BigInt(r.usage.output_tokens), 50n);
    }
  });

  test("message_delta 含 stop_reason='end_turn' → kind:final", () => {
    const o = new _UsageObserver();
    feedEvents(o, [
      "event: message_delta",
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 100, output_tokens: 50 },
      })}`,
    ]);
    const r = o.result();
    assert.equal(r.kind, "final");
    if (r.kind === "final") {
      assert.equal(BigInt(r.usage.output_tokens), 50n);
    }
  });

  test("cache_creation_input_tokens / cache_read_input_tokens 也提取出来", () => {
    const o = new _UsageObserver();
    feedEvents(o, [
      "event: message_delta",
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
      })}`,
    ]);
    const r = o.result();
    assert.equal(r.kind, "final");
    if (r.kind === "final") {
      assert.equal(BigInt(r.usage.cache_read_tokens), 5n);
      assert.equal(BigInt(r.usage.cache_write_tokens), 3n);
    }
  });

  test("非 message_start/delta 事件忽略", () => {
    const o = new _UsageObserver();
    feedEvents(o, [
      "event: content_block_delta",
      `data: ${JSON.stringify({ delta: { text: "hi" } })}`,
    ]);
    assert.deepEqual(o.result(), { kind: "none" });
  });

  test("注释行(`: ping`)和空行不影响后续事件", () => {
    const o = new _UsageObserver();
    o.push(": ping\n\n");
    o.push(
      [
        "event: message_delta",
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 2 },
        })}`,
        "",
        "",
      ].join("\n"),
    );
    const r = o.result();
    assert.equal(r.kind, "final");
  });

  test("跨 chunk 的事件能被拼接(模拟 TCP 切割)", () => {
    const o = new _UsageObserver();
    const json = JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 7, output_tokens: 8 },
    });
    const full = `event: message_delta\ndata: ${json}\n\n`;
    // 切成 3 段送入
    o.push(full.slice(0, 5));
    o.push(full.slice(5, 30));
    o.push(full.slice(30));
    const r = o.result();
    assert.equal(r.kind, "final");
    if (r.kind === "final") {
      assert.equal(BigInt(r.usage.input_tokens), 7n);
      assert.equal(BigInt(r.usage.output_tokens), 8n);
    }
  });

  test("malformed JSON 不抛(下一条 OK 事件正常处理)", () => {
    const o = new _UsageObserver();
    feedEvents(o, ["event: message_delta", "data: {not-json"]);
    feedEvents(o, [
      "event: message_delta",
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 1, output_tokens: 1 },
      })}`,
    ]);
    const r = o.result();
    assert.equal(r.kind, "final");
  });

  test("buffer cap:塞 1MB 不切事件不会 OOM(被截断)", () => {
    const o = new _UsageObserver();
    const garbage = "x".repeat(512 * 1024);
    o.push(garbage);
    o.push(garbage);
    // observer 不抛、没有事件命中 → 仍是 none
    assert.deepEqual(o.result(), { kind: "none" });
  });
});

// ─── extractSessionId ─────────────────────────────────────────────────────

describe("extractSessionId — 顶层 metadata.session_id 优先", () => {
  test("显式 session_id 直接返回", () => {
    assert.equal(extractSessionId({ session_id: "abc" }), "abc");
  });

  test("显式 + user_id 都有 → 取显式", () => {
    assert.equal(
      extractSessionId({
        session_id: "explicit",
        user_id: JSON.stringify({ session_id: "nested" }),
      }),
      "explicit",
    );
  });

  test("显式 trim 空白", () => {
    assert.equal(extractSessionId({ session_id: "  abc  " }), "abc");
  });

  test("显式截断到 256(防 zod 上限被改大)", () => {
    const long = "x".repeat(300);
    const got = extractSessionId({ session_id: long });
    assert.equal(got?.length, 256);
    assert.equal(got, "x".repeat(256));
  });

  test("显式全空白 → fallback 到 user_id 不被阻断", () => {
    assert.equal(
      extractSessionId({
        session_id: "   ",
        user_id: JSON.stringify({ session_id: "sid-1" }),
      }),
      "sid-1",
    );
  });
});

describe("extractSessionId — 从 user_id JSON 提取(Claude Code 编码方式)", () => {
  test("user_id 是 JSON object 含 session_id → 提取", () => {
    assert.equal(
      extractSessionId({
        user_id: JSON.stringify({
          device_id: "d",
          account_uuid: "a",
          session_id: "sid-1",
        }),
      }),
      "sid-1",
    );
  });

  test("嵌套 session_id trim", () => {
    assert.equal(
      extractSessionId({ user_id: JSON.stringify({ session_id: "  sid-1  " }) }),
      "sid-1",
    );
  });

  test("user_id JSON 无 session_id 字段 → null", () => {
    assert.equal(
      extractSessionId({ user_id: JSON.stringify({ device_id: "d" }) }),
      null,
    );
  });

  test("user_id 是普通字符串(非 JSON) → null", () => {
    assert.equal(extractSessionId({ user_id: "raw-device-string" }), null);
  });

  test("user_id 是 malformed JSON → null(catch 路径)", () => {
    assert.equal(extractSessionId({ user_id: "{bad json" }), null);
  });

  test("user_id JSON 但 session_id 类型错误 → null", () => {
    assert.equal(
      extractSessionId({ user_id: JSON.stringify({ session_id: 12345 }) }),
      null,
    );
    assert.equal(
      extractSessionId({ user_id: JSON.stringify({ session_id: null }) }),
      null,
    );
  });

  test("user_id 是 JSON 数组 → null(必须 plain object)", () => {
    assert.equal(extractSessionId({ user_id: JSON.stringify(["sid"]) }), null);
  });

  test("user_id 是 JSON 数字 / null → null", () => {
    assert.equal(extractSessionId({ user_id: "42" }), null);
    assert.equal(extractSessionId({ user_id: "null" }), null);
  });

  test("user_id 中 session_id 长度 >256 → 截断到 256", () => {
    const long = "y".repeat(300);
    const got = extractSessionId({
      user_id: JSON.stringify({ session_id: long }),
    });
    assert.equal(got?.length, 256);
    assert.equal(got, "y".repeat(256));
  });

  test("嵌套 session_id 全空白 → null", () => {
    assert.equal(
      extractSessionId({ user_id: JSON.stringify({ session_id: "   " }) }),
      null,
    );
  });
});

describe("extractSessionId — 边界", () => {
  test("metadata=undefined → null", () => {
    assert.equal(extractSessionId(undefined), null);
  });

  test("metadata={} → null", () => {
    assert.equal(extractSessionId({}), null);
  });

  test("user_id 为空字符串 → null", () => {
    assert.equal(extractSessionId({ user_id: "" }), null);
  });
});

// ─── isDeepseekModel — 2026-05-02 deepseek 接入 ────────────────────────────

describe("isDeepseekModel", () => {
  test("deepseek-v4-flash → true", () => {
    assert.equal(isDeepseekModel("deepseek-v4-flash"), true);
  });

  test("deepseek-v4-pro → true", () => {
    assert.equal(isDeepseekModel("deepseek-v4-pro"), true);
  });

  test("`deepseek-` 任意后缀都命中(prefix 语义,无版本/家族 allowlist)", () => {
    assert.equal(isDeepseekModel("deepseek-v5-ultra"), true);
    assert.equal(isDeepseekModel("deepseek-coder-x"), true);
  });

  test("claude / gpt 系列绝不命中", () => {
    assert.equal(isDeepseekModel("claude-sonnet-4-6"), false);
    assert.equal(isDeepseekModel("claude-opus-4-6"), false);
    assert.equal(isDeepseekModel("gpt-5.6-sol"), false);
    assert.equal(isDeepseekModel("haiku-4-5"), false);
  });

  test("空字符串 / 仅 'deepseek'(无连字符) → false(防误命中)", () => {
    assert.equal(isDeepseekModel(""), false);
    // 'deepseek' 单独一个 token 不带 '-' 不算 —— 我们 model_id 全部带 '-' 后缀
    assert.equal(isDeepseekModel("deepseek"), false);
  });

  test("DEEPSEEK_UPSTREAM_ENDPOINT 是官方 anthropic-兼容路径", () => {
    assert.equal(
      DEEPSEEK_UPSTREAM_ENDPOINT,
      "https://api.deepseek.com/anthropic/v1/messages",
    );
  });
});

// ─── isAnthropicInvalidRequestError — d1 cooldown 防御 ────────────────────

describe("isAnthropicInvalidRequestError", () => {
  test("典型 thinking signature 错误 → true", () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "messages.13.content.0: Invalid `signature` in `thinking` block.",
      },
    });
    assert.equal(isAnthropicInvalidRequestError(body), true);
  });

  test("authentication_error → false(账号问题,该扣分)", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    assert.equal(isAnthropicInvalidRequestError(body), false);
  });

  test("permission_error / rate_limit_error / overloaded → false", () => {
    for (const t of [
      "permission_error",
      "rate_limit_error",
      "overloaded_error",
      "api_error",
    ]) {
      const body = JSON.stringify({ type: "error", error: { type: t } });
      assert.equal(isAnthropicInvalidRequestError(body), false, `${t} should not match`);
    }
  });

  test("空串 / 非 JSON / 缺 error.type → false(保守降级)", () => {
    assert.equal(isAnthropicInvalidRequestError(""), false);
    assert.equal(isAnthropicInvalidRequestError("not json"), false);
    assert.equal(isAnthropicInvalidRequestError("{}"), false);
    assert.equal(isAnthropicInvalidRequestError('{"error":{}}'), false);
    assert.equal(
      isAnthropicInvalidRequestError('{"error":{"type":1234}}'),
      false,
    );
  });
});

// ─── isClientAbort — req/res close 不该扣账号分 ──────────────────────────

describe("isClientAbort", () => {
  test("AbortError(标准 DOMException 风格)→ true", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    assert.equal(isClientAbort(err), true);
  });

  test("undici code='ABORT_ERR' → true", () => {
    const err = Object.assign(new Error("abort"), { code: "ABORT_ERR" });
    assert.equal(isClientAbort(err), true);
  });

  test("普通 Error / 没 abort 痕迹 → false", () => {
    assert.equal(isClientAbort(new Error("ECONNRESET")), false);
    assert.equal(isClientAbort(new Error("upstream returned 500")), false);
    assert.equal(
      isClientAbort(new Error("socket hang up")),
      false,
    );
    assert.equal(isClientAbort("string err"), false);
    assert.equal(isClientAbort(null), false);
    assert.equal(isClientAbort(undefined), false);
  });

  test("不依赖 ac.signal.aborted —— 只看 err 形状(Codex MAJOR 修复)", () => {
    // 模拟"我们自己 res.end() 后 ac.signal.aborted=true、但 err 是真实上游 5xx"
    // 的场景:helper 必须返回 false 让其走 fail(扣账号分),而不是被 signal flag
    // 误判成 client_error。
    const err = new Error("upstream returned 502: socket reset mid-stream");
    assert.equal(isClientAbort(err), false);
  });
});

// ─── makeFinalizer.failClient — handler 级行为(Codex MEDIUM #3) ─────────

describe("makeFinalizer.failClient → scheduler.release 走 client_error", () => {
  test("fail vs failClient:同样写 abort journal,但 release.kind 区分", async () => {
    type ReleaseCall = { account_id: bigint | string; slotId: string; kind: string; error?: string | null };
    const releaseCalls: ReleaseCall[] = [];
    const queriedSql: string[] = [];

    const stubScheduler = {
      release: async (input: { account_id: bigint | string; slotId: string; result: { kind: string; error?: string | null } }) => {
        releaseCalls.push({
          account_id: input.account_id,
          slotId: input.slotId,
          kind: input.result.kind,
          error: input.result.error ?? null,
        });
      },
    };

    const stubPool = {
      query: async (sql: string, _params?: unknown[]) => {
        queriedSql.push(sql);
        return { rows: [], rowCount: 0 } as never;
      },
    };

    const stubRedis = {
      releaseReservation: async () => true,
    };

    const baseCtx = {
      requestId: "req-test-failclient",
      userId: 1n,
      containerId: 0n,
      accountId: 42n,
      slotId: "slot-test",
      model: "claude-sonnet-4-6",
      pricing: sonnet,
      precheckCredits: 100n,
      preCheckReservation: { userId: "u1", requestId: "req-test-failclient" },
      log: rootLogger,
      sessionId: null,
    };

    // 1) failClient → release.kind === 'client_error'
    const f1 = makeFinalizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pgPool: stubPool, preCheckRedis: stubRedis, scheduler: stubScheduler } as any,
      baseCtx,
    );
    const out1 = await f1.failClient({ kind: "none" }, new Error("invalid_request_error: thinking"));
    assert.equal(out1.state, "aborted");
    assert.equal(out1.finalCredits, 0n);
    assert.equal(releaseCalls.length, 1);
    assert.equal(releaseCalls[0].kind, "client_error");
    assert.equal(releaseCalls[0].account_id, 42n);
    assert.equal(releaseCalls[0].slotId, "slot-test"); // B7:slotId 透传到 scheduler.release

    // 2) fail (control) → release.kind === 'failure'
    const f2 = makeFinalizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pgPool: stubPool, preCheckRedis: stubRedis, scheduler: stubScheduler } as any,
      { ...baseCtx, requestId: "req-test-fail" },
    );
    await f2.fail({ kind: "none" }, new Error("upstream 502"));
    assert.equal(releaseCalls.length, 2);
    assert.equal(releaseCalls[1].kind, "failure");

    // 3) accountId=null (DeepSeek path) → 不调 scheduler.release
    const f3 = makeFinalizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pgPool: stubPool, preCheckRedis: stubRedis, scheduler: stubScheduler } as any,
      { ...baseCtx, requestId: "req-test-deepseek", accountId: null },
    );
    await f3.failClient({ kind: "none" }, new Error("client closed"));
    assert.equal(releaseCalls.length, 2, "accountId=null 时跳过 scheduler.release");

    // 4) journal abort SQL 被两条 fail/failClient 都写到了
    const abortSqlCount = queriedSql.filter((s) => s.includes("SET state='aborted'")).length;
    assert.equal(abortSqlCount, 3, "三次 fail/failClient 都写了 abort journal");
  });
});

// ─── stripMalformedThinkingBlocks ─────────────────────────────────────────

describe("stripMalformedThinkingBlocks", () => {
  // 阈值是 16,Anthropic 实际 signature 远长于此,这里用 32 字节的合法占位
  const VALID_SIG = "a".repeat(32);
  const VALID_DATA = "b".repeat(32);

  test("合法 thinking block 不被剔除", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think", signature: VALID_SIG },
          { type: "text", text: "result" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 0);
    assert.strictEqual(r.messages, messages, "无改动时返回原数组引用");
  });

  test("thinking block signature 缺失 → 整块剔除,其它 block 保留", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "..." }, // 缺 signature
          { type: "text", text: "answer" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
    assert.equal(r.redactedThinkingStripped, 0);
    const newAssistant = (r.messages[1] as { content: unknown[] });
    assert.equal(newAssistant.content.length, 1);
    assert.deepEqual(newAssistant.content[0], { type: "text", text: "answer" });
  });

  test("thinking block signature 空字符串 → 剔除", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "" }] },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
  });

  test("thinking block signature 短字符串(< 16) → 剔除", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "tiny" }] },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
  });

  test("redacted_thinking 合法 data → 保留", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: VALID_DATA },
          { type: "text", text: "ok" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 0);
    assert.strictEqual(r.messages, messages);
  });

  test("redacted_thinking 缺 data / 短 data / 空 data → 剔除并计入 redactedThinkingStripped", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking" }, // 缺 data
          { type: "redacted_thinking", data: "" }, // 空
          { type: "redacted_thinking", data: "abc" }, // 短
          { type: "text", text: "ok" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 3);
    const c = (r.messages[1] as { content: unknown[] }).content;
    assert.equal(c.length, 1);
    assert.deepEqual(c[0], { type: "text", text: "ok" });
  });

  test("thinking + redacted_thinking 各坏一个 → 计数分别 +1", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x", signature: "" },
          { type: "redacted_thinking", data: "" },
          { type: "text", text: "kept" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
    assert.equal(r.redactedThinkingStripped, 1);
  });

  test("content 为字符串 → 不动(含 string content 的 assistant 历史保留)", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: "plain text response" },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 0);
    assert.strictEqual(r.messages, messages);
  });

  test("user message 中混入 thinking block → 不动(只清 assistant 历史)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "thinking", thinking: "x", signature: "" }, // bad sig 但在 user 里
          { type: "text", text: "q" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 0);
    assert.strictEqual(r.messages, messages);
  });

  test("非 record block(null / 字符串 / 数字 / 数组)→ 原样保留,helper 不抛", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          null,
          "stringy",
          123,
          ["nested-array"],
          { type: "text", text: "kept" },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 0);
    assert.strictEqual(r.messages, messages);
  });

  test("assistant 唯一 thinking block 被剔除 → content 替换为 [thinking block removed] 占位", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "" }] },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
    const c = (r.messages[1] as { content: unknown[] }).content;
    assert.equal(c.length, 1);
    assert.deepEqual(c[0], { type: "text", text: "[thinking block removed]" });
  });

  test("多条 message,只有部分被改 → 未改的 message 引用相等(===)", () => {
    const userMsg = { role: "user", content: "q" };
    const cleanAssistant = { role: "assistant", content: [{ type: "text", text: "first" }] };
    const dirtyAssistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "" }, // 坏
        { type: "text", text: "second" },
      ],
    };
    const messages = [userMsg, cleanAssistant, { role: "user", content: "q2" }, dirtyAssistant];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
    assert.notStrictEqual(r.messages, messages, "外层数组应换新");
    assert.strictEqual(r.messages[0], userMsg);
    assert.strictEqual(r.messages[1], cleanAssistant);
    assert.strictEqual(r.messages[2], messages[2]);
    assert.notStrictEqual(r.messages[3], dirtyAssistant);
  });

  test("原 messages 数组 / 原 message 对象不被 mutate", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x", signature: "" },
          { type: "text", text: "kept" },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 1);
    assert.equal(JSON.stringify(messages), before, "原对象未被 mutate");
  });

  test("边界:length === 16 的 signature / data 应保留(防 < 被改成 <= 的回归)", () => {
    const exact16Sig = "x".repeat(16);
    const exact16Data = "y".repeat(16);
    assert.equal(exact16Sig.length, 16);
    assert.equal(exact16Data.length, 16);
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x", signature: exact16Sig },
          { type: "redacted_thinking", data: exact16Data },
        ],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0);
    assert.equal(r.redactedThinkingStripped, 0);
    assert.strictEqual(r.messages, messages);
  });

  test("设计取舍:长但伪造的 signature(>= 16) 被保留,网关不做 HMAC 验证", () => {
    // 这是一个明确记录的局限性:网关无 HMAC 密钥,无法识别"长度合法但 HMAC
    // 错"的伪造 signature。这种情况由 Anthropic 上游自行拒绝。本用例确保
    // 未来维护者不要把这里的启发式当成"签名真实性校验"。
    const fakedSig = "this-is-fake-but-long-enough-to-pass-the-heuristic";
    assert.ok(fakedSig.length >= 16);
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "fake reasoning", signature: fakedSig }],
      },
    ];
    const r = stripMalformedThinkingBlocks(messages);
    assert.equal(r.thinkingStripped, 0, "长但伪造 signature 不被本规则剔除");
    assert.equal(r.redactedThinkingStripped, 0);
  });
});

// ─── stripNonTextContentBlocks(文本 provider text-only 输入兜底)──────────────

describe("stripNonTextContentBlocks", () => {
  const IMG = (mt = "image/jpeg") => ({
    type: "image",
    source: { type: "base64", media_type: mt, data: "AAAA" },
  });

  test("纯文本会话无改动 → 返回原数组引用(copy-on-write)", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [{ type: "text", text: "tool output" }],
          },
        ],
      },
    ];
    const r = stripNonTextContentBlocks(messages);
    assert.equal(r.imagesStripped, 0);
    assert.equal(r.documentsStripped, 0);
    assert.strictEqual(r.messages, messages, "无非文本块时返回原引用");
  });

  test("顶层 image block → 就地换占位 text,文本兄弟块保留", () => {
    const messages = [
      { role: "user", content: [IMG(), { type: "text", text: "看这张图" }] },
    ];
    const r = stripNonTextContentBlocks(messages);
    assert.equal(r.imagesStripped, 1);
    const content = (r.messages[0] as { content: any[] }).content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /image omitted/);
    assert.deepEqual(content[1], { type: "text", text: "看这张图" });
  });

  test("tool_result 内嵌 image → 就地换占位,保留 tool_use_id 与文本子块(命中生产实况)", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_34f5d63b",
            content: [
              { type: "text", text: "Read 了一张图" },
              IMG(),
              IMG("image/png"),
            ],
          },
        ],
      },
    ];
    const r = stripNonTextContentBlocks(messages);
    assert.equal(r.imagesStripped, 2);
    const tr = (r.messages[0] as { content: any[] }).content[0];
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.tool_use_id, "call_34f5d63b");
    assert.equal(tr.content.length, 3);
    assert.equal(tr.content[0].text, "Read 了一张图");
    assert.match(tr.content[1].text, /image omitted/);
    assert.match(tr.content[2].text, /image omitted/);
  });

  test("tool_result content 全是图 → 占位保证非空(上游拒空 content)", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c", content: [IMG()] }],
      },
    ];
    const r = stripNonTextContentBlocks(messages);
    assert.equal(r.imagesStripped, 1);
    const tr = (r.messages[0] as { content: any[] }).content[0];
    assert.equal(tr.content.length, 1);
    assert.equal(tr.content[0].type, "text");
  });

  test("document block → 就地换占位,计入 documentsStripped", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
          { type: "text", text: "总结一下" },
        ],
      },
    ];
    const r = stripNonTextContentBlocks(messages);
    assert.equal(r.documentsStripped, 1);
    assert.equal(r.imagesStripped, 0);
    const content = (r.messages[0] as { content: any[] }).content;
    assert.match(content[0].text, /document omitted/);
  });

  test("string content / 非数组 content 跳过,不抛错", () => {
    const messages = [
      { role: "user", content: "plain string" },
      { role: "assistant", content: null },
      { not_a_message: true },
    ];
    const r = stripNonTextContentBlocks(messages as unknown[]);
    assert.equal(r.imagesStripped, 0);
    assert.strictEqual(r.messages, messages);
  });

  test("不 mutate 入参原数组/原对象", () => {
    const origInner = [{ type: "text", text: "t" }, IMG()];
    const origMsg = { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: origInner }] };
    const messages = [origMsg];
    const r = stripNonTextContentBlocks(messages);
    assert.notStrictEqual(r.messages, messages);
    // 原对象未被改写
    assert.equal((origMsg.content[0] as any).content[1].type, "image");
    assert.equal(origInner.length, 2);
  });

  // 行为锁:strip 必须在 estimateInputTokens **之前**(否则历史里的大 base64 图会先被静态
  // input cap 误判 413 + 高估 preCheck cost)。用源码文本结构钉死调用顺序,避免未来重排回归。
  test("index.ts:strip 调用在 estimateInputTokens(body) 之前,且 gated route.kind==='static'", () => {
    const indexPath = fileURLToPath(new URL("../http/proxy/index.ts", import.meta.url));
    const src = readFileSync(indexPath, "utf-8");

    // 锚定真实调用(`estimateInputTokens(body)` 也出现在注释里,故用赋值整句锚定)。
    const stripIdx = src.indexOf("stripNonTextContentBlocks(body.messages)");
    assert.ok(stripIdx >= 0, "必须存在 stripNonTextContentBlocks(body.messages) 调用");

    const estimateIdx = src.indexOf("const inputTokens = estimateInputTokens(body)");
    assert.ok(estimateIdx >= 0, "必须存在 const inputTokens = estimateInputTokens(body) 调用");
    assert.ok(stripIdx < estimateIdx, "strip 必须在 estimateInputTokens(body) 之前");

    // strip 必须 gated 在 `if (route.kind === "static" && !modelSupportsVision)` 内:
    // 只对静态**纯文本**模型 strip;MiniMax-M3 等原生识图的模型不 strip。
    //
    // 2026-07-12 模型权威批次:gate 从 **provider 级** `route.provider.supportsVision` 收窄成
    // **per-model** `modelSupportsVision` —— catalog 生效时取该行的 capability_profile
    // (方案 §4 "proxy 清洗消费 catalog 行 per-model"),legacy 期回落 provider 级 spec。
    // 语义没变(纯文本模型才 strip),但表达力升级:同一 provider 下未来会同时有多模态与
    // 纯文本型号,provider 级 flag 表达不了。
    const gateIdx = src.lastIndexOf(
      'if (route.kind === "static" && !modelSupportsVision)',
      stripIdx,
    );
    assert.ok(
      gateIdx >= 0 && gateIdx < stripIdx,
      'strip 必须 gated 在 if (route.kind === "static" && !modelSupportsVision) 内',
    );

    // input cap guard 也必须 gated 在 !modelSupportsVision —— vision 请求含大 base64 图,
    // estimateInputTokens(JSON.length/4)把图当文本 token 高估(2MB 图≈725k),误撞文本 context cap → 413。
    // 期望源码里有**两处** !modelSupportsVision:strip gate + input cap gate。
    const supportsVisionGates = (src.match(/!modelSupportsVision/g) ?? []).length;
    assert.ok(
      supportsVisionGates >= 2,
      'strip 与 static input cap guard 两处都必须 gated 在 !modelSupportsVision',
    );

    // modelSupportsVision 的**权威来源**:catalog descriptor(gate 生效)→ 否则 provider spec。
    // 这条断言防止未来有人把它改回 provider 级或写死 true(后者会让纯文本上游收到图 → 400 打死会话)。
    assert.match(
      src,
      /const modelSupportsVision = gate[\s\S]{0,200}capabilityProfile\.supportsVision/,
      "modelSupportsVision 必须优先取 catalog descriptor 的 per-model capability",
    );
  });
});

// ─── rewriteMetadataDeviceId(反风控:device_id 锚定到账号 pinned_user_id)──
//
// 详见 anthropicProxy.ts 中 `rewriteMetadataDeviceId` 的文档注释。这些是纯函数
// 单测;真 PG schema 回归测试在 accountPinnedUserId.integ.test.ts。

describe("rewriteMetadataDeviceId", () => {
  // 用一个合法 64 字符小写 hex 作为 pinned_user_id 测试桩,跟 0067 migration
  // CHECK 约束(^[0-9a-f]{64}$)对齐。
  const PINNED = "a".repeat(64);

  test("覆盖既有 device_id 为 pinned_user_id", () => {
    const input = JSON.stringify({
      device_id: "old-random-from-container",
      account_uuid: "acc-uuid-1",
      session_id: "sess-1",
    });
    const out = rewriteMetadataDeviceId(input, PINNED);
    const parsed = JSON.parse(out);
    assert.equal(parsed.device_id, PINNED);
  });

  test("metadata.user_id 缺失 → 注入最小 {device_id} JSON", () => {
    const out = rewriteMetadataDeviceId(undefined, PINNED);
    assert.deepEqual(JSON.parse(out), { device_id: PINNED });
  });

  test("保留 account_uuid / session_id / extras 等非 device_id 字段", () => {
    const input = JSON.stringify({
      device_id: "old",
      account_uuid: "acc-uuid-1",
      session_id: "sess-1",
      extra_telemetry_kv: "x",
    });
    const out = rewriteMetadataDeviceId(input, PINNED);
    const parsed = JSON.parse(out);
    assert.equal(parsed.device_id, PINNED);
    assert.equal(parsed.account_uuid, "acc-uuid-1");
    assert.equal(parsed.session_id, "sess-1");
    assert.equal(parsed.extra_telemetry_kv, "x");
  });

  test("非法 JSON → 保持原值不动(fail-open,不把诡异输入推到 Anthropic 网关)", () => {
    const original = "not-a-json-string";
    const out = rewriteMetadataDeviceId(original, PINNED);
    assert.equal(out, original);
  });

  test("user_id 是 JSON 数组 → 保持原值(对齐 extractSessionId 拒绝数组的口径)", () => {
    const original = "[]";
    const out = rewriteMetadataDeviceId(original, PINNED);
    assert.equal(out, original);
  });

  test("user_id 是 JSON primitive(string/number/null)→ 保持原值", () => {
    for (const original of ['"plain-string"', "42", "null", "true"]) {
      const out = rewriteMetadataDeviceId(original, PINNED);
      assert.equal(out, original, `primitive ${original} should be preserved`);
    }
  });
});

// ─── rewriteMetadataAccountUuid(Phase 6 H6:account_uuid 锚定到账号真 uuid)──
//
// 详见 http/proxy/shared.ts 中 `rewriteMetadataAccountUuid` 的文档注释。fail-open
// 全 case 保留可用性,与 rewriteMetadataDeviceId 同型。这里 PINNED 用一个合法
// canonical uuid 作为账号真 uuid 测试桩(回填脚本/applyUpstreamAuth 共用同一
// isUuidLike 校验,见下方 isUuidLike describe)。
describe("rewriteMetadataAccountUuid", () => {
  const PINNED = "12345678-aaaa-bbbb-cccc-1234567890ab";

  test("userIdStr 为 undefined → 返回最小 {account_uuid} JSON", () => {
    const out = rewriteMetadataAccountUuid(undefined, PINNED);
    assert.deepEqual(JSON.parse(out), { account_uuid: PINNED });
  });

  test("userIdStr 为空串 → 同 undefined,返回最小 {account_uuid} JSON", () => {
    const out = rewriteMetadataAccountUuid("", PINNED);
    assert.deepEqual(JSON.parse(out), { account_uuid: PINNED });
  });

  test("plain object → spread 保留其他字段并覆盖 account_uuid", () => {
    const input = JSON.stringify({
      device_id: "d".repeat(64),
      account_uuid: "stale-or-client-supplied",
      session_id: "sess-1",
      extra_telemetry_kv: "x",
    });
    const out = rewriteMetadataAccountUuid(input, PINNED);
    const parsed = JSON.parse(out);
    assert.equal(parsed.account_uuid, PINNED);
    assert.equal(parsed.device_id, "d".repeat(64));
    assert.equal(parsed.session_id, "sess-1");
    assert.equal(parsed.extra_telemetry_kv, "x");
  });

  test("非 JSON 字符串 → 保持原值不动(fail-open)", () => {
    const original = "not-a-json-string";
    const out = rewriteMetadataAccountUuid(original, PINNED);
    assert.equal(out, original);
  });

  test("JSON 数组 / primitive(string/number/null/bool) → 保持原值不动", () => {
    for (const original of ['[]', '[1,2,3]', '"plain-string"', "42", "null", "true"]) {
      const out = rewriteMetadataAccountUuid(original, PINNED);
      assert.equal(out, original, `non-object JSON ${original} should be preserved`);
    }
  });

  // ─── strict=true(fail_closed)分支:H6 invariant 强保证 ───
  test("strict=true + undefined → {account_uuid} 最小 JSON(同 fail_open)", () => {
    const out = rewriteMetadataAccountUuid(undefined, PINNED, true);
    assert.deepEqual(JSON.parse(out), { account_uuid: PINNED });
  });

  test("strict=true + plain object → spread + 覆盖(同 fail_open)", () => {
    const input = JSON.stringify({ device_id: "d", session_id: "s" });
    const out = rewriteMetadataAccountUuid(input, PINNED, true);
    const parsed = JSON.parse(out);
    assert.equal(parsed.account_uuid, PINNED);
    assert.equal(parsed.device_id, "d");
    assert.equal(parsed.session_id, "s");
  });

  test("strict=true + 非法 JSON → 强 normalize 到 {account_uuid}(fail_open 会保持原值)", () => {
    const out = rewriteMetadataAccountUuid("not-a-json-string", PINNED, true);
    assert.deepEqual(JSON.parse(out), { account_uuid: PINNED });
  });

  test("strict=true + JSON 数组 / primitive → 强 normalize 到 {account_uuid}", () => {
    for (const original of ["[]", "[1,2,3]", '"plain"', "42", "null", "true"]) {
      const out = rewriteMetadataAccountUuid(original, PINNED, true);
      assert.deepEqual(
        JSON.parse(out),
        { account_uuid: PINNED },
        `strict=true 必须 normalize 非 object JSON ${original}`,
      );
    }
  });
});

// ─── isUuidLike(account_uuid canonical 校验)──
//
// 回填脚本写入 SQL 前与 applyUpstreamAuth 使用 pinned account_uuid 前共用同一
// 正则;故意不强制 v4,允许 Anthropic profile.account.uuid 用 v1/v5 等版本。
describe("isUuidLike", () => {
  test("canonical 小写 hex uuid → true", () => {
    assert.equal(isUuidLike("12345678-9abc-def0-1234-56789abcdef0"), true);
  });

  test("canonical 大写也接受(case-insensitive)", () => {
    assert.equal(isUuidLike("12345678-9ABC-DEF0-1234-56789ABCDEF0"), true);
  });

  test("空串 → false", () => {
    assert.equal(isUuidLike(""), false);
  });

  test("缺少分隔符 → false", () => {
    assert.equal(isUuidLike("123456789abcdef0123456789abcdef0"), false);
  });

  test("段长度错 → false", () => {
    assert.equal(isUuidLike("12345678-9abc-def0-1234-56789abcdef"), false);
    assert.equal(isUuidLike("1234567-9abc-def0-1234-56789abcdef0"), false);
  });

  test("含非 hex 字符 → false", () => {
    assert.equal(isUuidLike("12345678-9abc-defg-1234-56789abcdef0"), false);
  });

  test("尾部空白 / 前后多字符 → false(正则锚定 ^$)", () => {
    assert.equal(isUuidLike(" 12345678-9abc-def0-1234-56789abcdef0"), false);
    assert.equal(isUuidLike("12345678-9abc-def0-1234-56789abcdef0 "), false);
  });
});

// ─── makeFinalizer.commit — 零输出免单(模型无响应/超时不扣费) ─────────────

describe("makeFinalizer.commit → 零输出免单", () => {
  function makeStubs() {
    const queriedSql: string[] = [];
    const stubClient = {
      query: async (sql: string, _params?: unknown[]) => {
        queriedSql.push(sql);
        if (sql.includes("INSERT INTO usage_records")) {
          return { rows: [{ id: "9001" }], rowCount: 1 } as never;
        }
        // spendTwoBucket 依赖:钱包行锁 / 期内桶行锁 / ledger 插入
        if (sql.includes("FROM users WHERE id")) {
          return { rows: [{ credits: "1000000" }], rowCount: 1 } as never;
        }
        if (sql.includes("FROM user_subscriptions")) {
          return { rows: [], rowCount: 0 } as never;
        }
        if (sql.includes("INSERT INTO credit_ledger")) {
          return { rows: [{ id: "7001" }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      release: () => {},
    };
    const stubPool = {
      query: async (sql: string, _params?: unknown[]) => {
        queriedSql.push(sql);
        return { rows: [], rowCount: 0 } as never;
      },
      connect: async () => stubClient,
    };
    const stubScheduler = { release: async () => {} };
    const stubRedis = { releaseReservation: async () => true };
    return { queriedSql, stubPool, stubScheduler, stubRedis };
  }

  const baseCtx = {
    userId: 1n,
    containerId: 0n,
    accountId: 42n,
    slotId: "slot-waive",
    model: "claude-sonnet-4-6",
    pricing: sonnet,
    precheckCredits: 100n,
    log: rootLogger,
    sessionId: null,
  };

  test("kind=final 但 output_tokens=0 → finalCredits=0,不走双钱包扣费", async () => {
    const { queriedSql, stubPool, stubScheduler, stubRedis } = makeStubs();
    const f = makeFinalizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pgPool: stubPool, preCheckRedis: stubRedis, scheduler: stubScheduler } as any,
      {
        ...baseCtx,
        requestId: "req-waive-1",
        preCheckReservation: { userId: "u1", requestId: "req-waive-1" },
      },
    );
    const out = await f.commit({
      kind: "final",
      usage: { input_tokens: 200_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
    assert.equal(out.state, "committed");
    assert.equal(out.finalCredits, 0n, "零输出必须免单(input 成本平台自担)");
    // usage_records 审计行照写,但绝不能碰双钱包/ledger
    assert.ok(queriedSql.some((s) => s.includes("INSERT INTO usage_records")), "审计行仍要落");
    assert.ok(
      !queriedSql.some((s) => s.includes("period_credits") || s.includes("credit_ledger")),
      "免单路径不得写 ledger/扣桶",
    );
  });

  test("对照:同 input 但 output_tokens>0 → 正常计费(finalCredits>0)", async () => {
    const { stubPool, stubScheduler, stubRedis } = makeStubs();
    const f = makeFinalizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pgPool: stubPool, preCheckRedis: stubRedis, scheduler: stubScheduler } as any,
      {
        ...baseCtx,
        requestId: "req-waive-2",
        preCheckReservation: { userId: "u1", requestId: "req-waive-2" },
      },
    );
    const out = await f.commit({
      kind: "final",
      usage: { input_tokens: 200_000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
    assert.equal(out.state, "committed");
    assert.ok(out.finalCredits > 0n, "有输出必须照常计费");
  });
});
