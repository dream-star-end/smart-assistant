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
import {
  proxyBodySchema,
  enforceFieldByteBudgets,
  estimateInputTokens,
  estimateMaxCostBothSides,
  buildSafeUpstreamHeaders,
  ConcurrencyLimiter,
  extractSessionId,
  ALLOWED_BETA_VALUES,
  ANTHROPIC_VERSION,
  SIZE_LIMITS,
  _UsageObserver,
  type ProxyBody,
} from "../http/anthropicProxy.js";
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

  test("tools 序列化超 64KB → 413", () => {
    const tools = Array.from({ length: 30 }, () => ({
      name: "x",
      description: bigStr(3000),
      input_schema: { type: "object" },
    }));
    const body: ProxyBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "ok" }],
      tools,
    };
    assert.throws(
      () => enforceFieldByteBudgets(body),
      (e: unknown) => e instanceof HttpError && e.status === 413,
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
