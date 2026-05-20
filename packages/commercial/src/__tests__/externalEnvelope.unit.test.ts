/**
 * V3 CC 外接 plan Phase 7(2026-05-20)— `http/proxy/externalEnvelope.ts` unit 测试。
 *
 * 跑法: npx tsx --test src/__tests__/externalEnvelope.unit.test.ts
 *
 * 覆盖 plan §4 invariant #11(11 类 case,原 7 类 + Codex Phase 7 plan-review MINOR 补 4):
 *   1. body.system === undefined → 注入 DEFAULT_PREFIX + ephemeral cache_control
 *   2. body.system === "" → 同上
 *   3. body.system === "<DEFAULT_PREFIX>\n\n<rest>" (string with prefix) → 归一化成 array 后命中 → skip prepend
 *   4. body.system === [{type:text, text:"<DEFAULT_PREFIX>..."}] → skip,数组引用 + 内容均不变
 *   5. body.system === [{type:text, text:"random custom"}] → prepend 新块,原块在 index 1
 *   6. 三个 prefix 变体均能命中 skip
 *   7. idempotency:第二次调用结果 === 第一次调用结果
 *   8. 混合 block:[{type:image,...},{type:text,text:"random"}] → prepend,image 块位置后移内容不变
 *   9. 非首块命中 prefix:[{type:text,text:"other"},{type:text,text:"<DEFAULT_PREFIX>..."}] → skip
 *  10. metadata 不变:helper 前后 body.metadata 深比较恒等
 *  11. 4 cache_control 块的非 CC body → 仍机械 prepend 第 5 个(不预检不拒绝)
 *
 * 不覆盖(范围外):
 *   - handler 接入点的 containerId / route.kind 双判别 → ccExternalEndpoint.integ.test.ts
 *   - 最终序列化 outbound JSON 形态 → ccExternalEndpoint.integ.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { normalizeExternalApiKeyEnvelope } from "../http/proxy/externalEnvelope.js";
import type { ProxyBody } from "../http/proxy/shared.js";
import type { Logger } from "../logging/logger.js";

// ─── 测试 helpers ─────────────────────────────────────────────────────────

/** 测试用 logger:吞日志,只记调用次数,无副作用。 */
function makeTestLogger(): Logger & { calls: { level: string; msg: string; fields?: unknown }[] } {
  const calls: { level: string; msg: string; fields?: unknown }[] = [];
  const noop = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    calls.push({ level, msg, fields });
  };
  const logger = {
    trace: noop("trace"),
    debug: noop("debug"),
    info: noop("info"),
    warn: noop("warn"),
    error: noop("error"),
    child(): Logger {
      return logger as Logger;
    },
    calls,
  };
  return logger as Logger & { calls: typeof calls };
}

/** 构造最小可用 ProxyBody,system 字段由 caller 注入。 */
function makeBody(overrides: Partial<ProxyBody> = {}): ProxyBody {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  } as ProxyBody;
}

const DEFAULT_PREFIX =
  `You are Claude Code, Anthropic's official CLI for Claude.`;
const AGENT_SDK_CC_PRESET =
  `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`;
const AGENT_SDK =
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`;

// ─── 测试 ────────────────────────────────────────────────────────────────

describe("normalizeExternalApiKeyEnvelope — invariant #11 (plan §3.5.2)", () => {
  test("#1 system undefined → prepend DEFAULT_PREFIX + ephemeral cache_control", () => {
    const log = makeTestLogger();
    const body = makeBody();
    assert.equal(body.system, undefined);

    normalizeExternalApiKeyEnvelope(body, log);

    assert.deepEqual(body.system, [
      {
        type: "text",
        text: DEFAULT_PREFIX,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("#2 system 空字符串 → 转 array 后未命中 prefix → prepend", () => {
    const log = makeTestLogger();
    const body = makeBody({ system: "" });

    normalizeExternalApiKeyEnvelope(body, log);

    // 原空串被归一化成 [{type:text, text:""}],未命中 prefix 后 prepend
    assert.deepEqual(body.system, [
      {
        type: "text",
        text: DEFAULT_PREFIX,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "" },
    ]);
  });

  test("#3 system string 含 DEFAULT_PREFIX 开头 → 转 array + 命中 startsWith + skip prepend", () => {
    const log = makeTestLogger();
    const original = `${DEFAULT_PREFIX}\n\nrest of the prompt`;
    const body = makeBody({ system: original });

    normalizeExternalApiKeyEnvelope(body, log);

    // 命中 skip:string 被归一化成 array,原文本 byte-identical 保留,无 cache_control 注入
    assert.deepEqual(body.system, [{ type: "text", text: original }]);
  });

  test("#4 system array 首块含 prefix → skip,数组引用 + 内容不变", () => {
    const log = makeTestLogger();
    const block = {
      type: "text",
      text: `${DEFAULT_PREFIX}\n\nadditional context`,
      cache_control: { type: "ephemeral" },
    };
    const arr = [block];
    const body = makeBody({ system: arr });

    normalizeExternalApiKeyEnvelope(body, log);

    // 命中 skip:数组引用相同(无 prepend),内容 byte-identical
    assert.strictEqual(body.system, arr);
    assert.strictEqual((body.system as unknown[])[0], block);
    assert.deepEqual(body.system, [block]);
  });

  test("#5 system array 未含 prefix → prepend 新块,原块在 index 1", () => {
    const log = makeTestLogger();
    const original = { type: "text", text: "random custom prompt" };
    const body = makeBody({ system: [original] });

    normalizeExternalApiKeyEnvelope(body, log);

    assert.deepEqual(body.system, [
      {
        type: "text",
        text: DEFAULT_PREFIX,
        cache_control: { type: "ephemeral" },
      },
      original,
    ]);
    // 原 block 引用保留
    assert.strictEqual((body.system as unknown[])[1], original);
  });

  test("#6 三种 prefix 变体均能命中 skip", () => {
    for (const prefix of [DEFAULT_PREFIX, AGENT_SDK_CC_PRESET, AGENT_SDK]) {
      const log = makeTestLogger();
      const block = { type: "text", text: `${prefix}\n\nrest` };
      const body = makeBody({ system: [block] });

      normalizeExternalApiKeyEnvelope(body, log);

      assert.deepEqual(
        body.system,
        [block],
        `prefix=${prefix.slice(0, 30)}... should skip prepend`,
      );
    }
  });

  test("#7 idempotency:第二次调用结果与第一次完全相等(byte-identical)", () => {
    const log = makeTestLogger();
    const body = makeBody({ system: [{ type: "text", text: "random" }] });

    normalizeExternalApiKeyEnvelope(body, log);
    const afterFirst = JSON.parse(JSON.stringify(body.system));

    normalizeExternalApiKeyEnvelope(body, log);
    const afterSecond = JSON.parse(JSON.stringify(body.system));

    assert.deepEqual(afterSecond, afterFirst);
    // 长度仍是 2(prepend block + 原 block),没有重复注入
    assert.equal((body.system as unknown[]).length, 2);
  });

  test("#8 混合 block:image + text(无 prefix)→ prepend,image 块位置后移内容不变", () => {
    const log = makeTestLogger();
    const imageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "fakebase64" },
    };
    const textBlock = { type: "text", text: "describe this image" };
    const body = makeBody({ system: [imageBlock, textBlock] });

    normalizeExternalApiKeyEnvelope(body, log);

    assert.deepEqual(body.system, [
      {
        type: "text",
        text: DEFAULT_PREFIX,
        cache_control: { type: "ephemeral" },
      },
      imageBlock,
      textBlock,
    ]);
    // 原 image / text 块引用保留(无 deep clone 副作用)
    assert.strictEqual((body.system as unknown[])[1], imageBlock);
    assert.strictEqual((body.system as unknown[])[2], textBlock);
  });

  test("#9 非首块含 prefix → skip(锁住遍历所有 text block,而非只看首块)", () => {
    const log = makeTestLogger();
    const firstBlock = { type: "text", text: "some other system prefix" };
    const ccBlock = {
      type: "text",
      text: `${DEFAULT_PREFIX}\n\nrest`,
    };
    const arr = [firstBlock, ccBlock];
    const body = makeBody({ system: arr });

    normalizeExternalApiKeyEnvelope(body, log);

    // 命中 skip:数组引用 + 内容均不变
    assert.strictEqual(body.system, arr);
    assert.deepEqual(body.system, [firstBlock, ccBlock]);
  });

  test("#10 metadata 不变:无论 system 形态如何,body.metadata 深比较恒等", () => {
    const log = makeTestLogger();

    // Case 10a: metadata 缺失
    {
      const body = makeBody();
      assert.equal(body.metadata, undefined);
      normalizeExternalApiKeyEnvelope(body, log);
      assert.equal(body.metadata, undefined);
    }

    // Case 10b: metadata 已存在,prepend 路径
    {
      const meta = { user_id: `{"device_id":"abc"}`, session_id: "s1" };
      const body = makeBody({
        system: [{ type: "text", text: "random" }],
        metadata: meta,
      });
      normalizeExternalApiKeyEnvelope(body, log);
      assert.strictEqual(body.metadata, meta); // 引用相同
      assert.deepEqual(body.metadata, {
        user_id: `{"device_id":"abc"}`,
        session_id: "s1",
      });
    }

    // Case 10c: metadata 已存在,skip 路径
    {
      const meta = { user_id: "preserved" };
      const body = makeBody({
        system: [{ type: "text", text: `${DEFAULT_PREFIX}\n\nrest` }],
        metadata: meta,
      });
      normalizeExternalApiKeyEnvelope(body, log);
      assert.strictEqual(body.metadata, meta);
      assert.deepEqual(body.metadata, { user_id: "preserved" });
    }
  });

  test("#11 4 个 cache_control 块的非 CC body → 仍机械 prepend 第 5 个(不预检不拒绝)", () => {
    const log = makeTestLogger();
    // 客户端凑了 4 个 cache_control:1 个在 system,3 个在 tools(模拟"刚好用满 4 块"的边界)
    const userBlock = {
      type: "text",
      text: "random custom prompt",
      cache_control: { type: "ephemeral" },
    };
    const body = makeBody({
      system: [userBlock],
      tools: [
        { name: "t1", description: "x", input_schema: {}, cache_control: { type: "ephemeral" } },
        { name: "t2", description: "x", input_schema: {}, cache_control: { type: "ephemeral" } },
        { name: "t3", description: "x", input_schema: {}, cache_control: { type: "ephemeral" } },
      ],
    });

    normalizeExternalApiKeyEnvelope(body, log);

    // helper 机械 prepend,不做 4 块上限预检 — 总计 5 个 cache_control 块(1 注入 + 1 原 system + 3 tools)
    assert.deepEqual(body.system, [
      {
        type: "text",
        text: DEFAULT_PREFIX,
        cache_control: { type: "ephemeral" },
      },
      userBlock,
    ]);
    // tools 完全不动
    assert.equal(body.tools?.length, 3);
    // 数 cache_control 总数:1 (注入) + 1 (userBlock) + 3 (tools) = 5
    let totalCacheControl = 0;
    for (const blk of body.system as Array<Record<string, unknown>>) {
      if (blk.cache_control) totalCacheControl++;
    }
    for (const t of body.tools as Array<Record<string, unknown>>) {
      if (t.cache_control) totalCacheControl++;
    }
    assert.equal(totalCacheControl, 5);
  });

  test("info log 在 skip 路径触发 external_envelope_skip(含 blocks / orig_kind / prefix_variant)", () => {
    // 2026-05-20 v1.0.183:升 info 级 + 加结构指纹字段(parity 诊断,不记 prompt 内容)
    const log = makeTestLogger();
    const body = makeBody({
      system: [{ type: "text", text: `${DEFAULT_PREFIX}\n\nx` }],
    });

    normalizeExternalApiKeyEnvelope(body, log);

    const skipLog = log.calls.find((c) => c.msg === "external_envelope_skip");
    assert.ok(skipLog, "skip log should be emitted");
    assert.equal(skipLog?.level, "info", "升 info 级以便 prod LOG_LEVEL=info 看见");
    assert.deepEqual(skipLog?.fields, {
      reason: "cc_prefix_present",
      blocks: 1,
      orig_kind: "array",
      prefix_variant: 0, // DEFAULT_PREFIX = index 0
    });
  });

  test("info log skip 路径区分 3 个 prefix 变体的 prefix_variant 索引", () => {
    // AGENT_SDK_CLAUDE_CODE_PRESET = index 1
    {
      const log = makeTestLogger();
      const body = makeBody({
        system: [{ type: "text", text: `${AGENT_SDK_CC_PRESET}\n\nx` }],
      });
      normalizeExternalApiKeyEnvelope(body, log);
      const skipLog = log.calls.find((c) => c.msg === "external_envelope_skip");
      assert.equal((skipLog?.fields as { prefix_variant: number })?.prefix_variant, 1);
    }
    // AGENT_SDK = index 2
    {
      const log = makeTestLogger();
      const body = makeBody({
        system: [{ type: "text", text: `${AGENT_SDK}\n\nx` }],
      });
      normalizeExternalApiKeyEnvelope(body, log);
      const skipLog = log.calls.find((c) => c.msg === "external_envelope_skip");
      assert.equal((skipLog?.fields as { prefix_variant: number })?.prefix_variant, 2);
    }
  });

  test("info log skip 路径 orig_kind=string 当客户端发 string 形态 system", () => {
    const log = makeTestLogger();
    const body = makeBody({ system: `${DEFAULT_PREFIX}\n\nrest` });
    normalizeExternalApiKeyEnvelope(body, log);
    const skipLog = log.calls.find((c) => c.msg === "external_envelope_skip");
    assert.equal((skipLog?.fields as { orig_kind: string })?.orig_kind, "string");
  });

  test("info log 在 prepend 路径触发 external_envelope_injected(含 blocks=2 / orig_kind=array / prefix_variant=0)", () => {
    const log = makeTestLogger();
    const body = makeBody({ system: [{ type: "text", text: "random" }] });

    normalizeExternalApiKeyEnvelope(body, log);

    const injLog = log.calls.find((c) => c.msg === "external_envelope_injected");
    assert.ok(injLog, "inject log should be emitted");
    assert.equal(injLog?.level, "info");
    assert.deepEqual(injLog?.fields, {
      blocks: 2, // 注入后原 1 + 新 prefix block
      orig_kind: "array",
      prefix_variant: 0, // 注入的总是 DEFAULT_PREFIX
    });
  });

  test("info log inject 路径 orig_kind=undefined 当客户端无 system", () => {
    const log = makeTestLogger();
    const body = makeBody({}); // system 缺失
    normalizeExternalApiKeyEnvelope(body, log);
    const injLog = log.calls.find((c) => c.msg === "external_envelope_injected");
    assert.equal((injLog?.fields as { orig_kind: string })?.orig_kind, "undefined");
    assert.equal((injLog?.fields as { blocks: number })?.blocks, 1); // 只有新注入的 prefix block
  });

  test("非 text block 的 text 字段不被误判(text 字段在 image block 上含 prefix 仍不命中)", () => {
    const log = makeTestLogger();
    // 故意构造一个 type=image 但 text 字段含 prefix 的怪 block(虽然 schema 上不合法,
    // 但 envelope helper 必须只看 type:text 块,锁定 isCcPrefixBlock 的检测窄度)
    const sneakyBlock = {
      type: "image",
      text: `${DEFAULT_PREFIX}\n\nfake`,
    };
    const body = makeBody({ system: [sneakyBlock] });

    normalizeExternalApiKeyEnvelope(body, log);

    // image 块的 text 字段被忽略 → 未命中 → prepend 注入
    assert.deepEqual(body.system, [
      {
        type: "text",
        text: DEFAULT_PREFIX,
        cache_control: { type: "ephemeral" },
      },
      sneakyBlock,
    ]);
  });
});
