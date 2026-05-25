/**
 * v3 反关联根治 0073/0074 — persona.ts 单元测试。
 *
 * 跑法: bun test src/__tests__/persona.unit.test.ts
 *
 * 覆盖:
 *   - generatePersona() 无 seed → 9 keys 全合法 + 取值在 variants 池内
 *   - generatePersona(seed) deterministic — 同 seed 同 persona,不同 seed 高概率不同
 *   - assertPersona —— 合法 / 缺 key / 类型错 / 空串 / null / non-object
 *   - personaToHeaderPairs —— 9 个 kebab-case header 名 + 值映射
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Buffer } from "node:buffer";

import {
  generatePersona,
  assertPersona,
  personaToHeaderPairs,
  type Persona,
} from "../account-pool/persona.js";

// ─── generatePersona ─────────────────────────────────────────────────────

describe("generatePersona — without seed", () => {
  test("返回的 persona 通过 assertPersona(必备 keys + 非空 string)", () => {
    const p = generatePersona();
    assertPersona(p); // 不抛即 PASS
  });

  test("user_agent 严格匹配 anthropic-ai-claude-code/<pkg> Node/<runtime> <OS>", () => {
    const p = generatePersona();
    assert.match(
      p.user_agent,
      /^anthropic-ai-claude-code\/[0-9]+\.[0-9]+\.[0-9]+ Node\/v[0-9]+\.[0-9]+\.[0-9]+ (MacOS|Linux|Windows)$/,
    );
  });

  test("user_agent 三段拼接源自 persona 字段(三处一致)", () => {
    const p = generatePersona();
    // user_agent 模板 = `anthropic-ai-claude-code/${pkg} Node/${rtv} ${os}`
    assert.ok(p.user_agent.includes(`/${p.x_stainless_package_version} `));
    assert.ok(p.user_agent.includes(`Node/${p.x_stainless_runtime_version} `));
    assert.ok(p.user_agent.endsWith(` ${p.x_stainless_os}`));
  });

  test("固定字段值符合 persona.ts 注释承诺", () => {
    const p = generatePersona();
    assert.equal(p.x_stainless_lang, "js");
    assert.equal(p.x_stainless_runtime, "node");
    assert.equal(p.x_stainless_retry_count, "0");
  });

  test("可变字段值在 variants 池内", () => {
    const p = generatePersona();
    assert.ok(["arm64", "x64"].includes(p.x_stainless_arch));
    assert.ok(["MacOS", "Linux", "Windows"].includes(p.x_stainless_os));
    assert.ok(/^v\d+\.\d+\.\d+$/.test(p.x_stainless_runtime_version));
    assert.ok(/^[a-zA-Z]{2}-[A-Z]{2}/.test(p.accept_language));
  });

  test("多次调用产生熵差异(50 次至少 2 种 user_agent)", () => {
    const uas = new Set<string>();
    for (let i = 0; i < 50; i += 1) uas.add(generatePersona().user_agent);
    // arch×os×pkg×rtv×lang = 2×3×5×5×5 = 750 种 user_agent 组合(实际只用 pkg/rtv/os),
    // 50 次随机至少 2 种是统计学几乎必然。<2 是真坏代码不是噪音。
    assert.ok(uas.size >= 2, `expected >=2 distinct UAs in 50 draws, got ${uas.size}`);
  });
});

describe("generatePersona — with seed", () => {
  test("同 seed → 同 persona(deep equal)", () => {
    const seed = Buffer.from("deterministic-seed-value", "utf8");
    const a = generatePersona(seed);
    const b = generatePersona(seed);
    assert.deepEqual(a, b);
  });

  test("不同 seed → 大概率不同 persona(20 个 seed 至少 2 种 user_agent)", () => {
    const uas = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      uas.add(
        generatePersona(Buffer.from(`seed-${i}`, "utf8")).user_agent,
      );
    }
    assert.ok(uas.size >= 2, `expected >=2 distinct seeded UAs, got ${uas.size}`);
  });

  test("seed 派生 persona 通过 assertPersona", () => {
    const seed = Buffer.from("another-seed", "utf8");
    assertPersona(generatePersona(seed));
  });

  test("Buffer seed vs 等价字节序列再造的 Buffer → 同 persona(SHA-256 摊熵确定性)", () => {
    const seedA = Buffer.from([1, 2, 3, 4, 5]);
    const seedB = Buffer.from([1, 2, 3, 4, 5]);
    assert.deepEqual(generatePersona(seedA), generatePersona(seedB));
  });
});

// ─── assertPersona ───────────────────────────────────────────────────────

describe("assertPersona — 合法路径", () => {
  test("generatePersona() 出品全部通过", () => {
    for (let i = 0; i < 10; i += 1) {
      assertPersona(generatePersona());
    }
  });

  test("手工拼合法 persona(全 9 keys + 全非空 string)通过", () => {
    const p: Persona = {
      user_agent: "ua",
      x_stainless_arch: "arm64",
      x_stainless_lang: "js",
      x_stainless_os: "MacOS",
      x_stainless_package_version: "1.0.0",
      x_stainless_runtime: "node",
      x_stainless_runtime_version: "v20.0.0",
      x_stainless_retry_count: "0",
      accept_language: "en-US,en;q=0.9",
    };
    assertPersona(p);
  });
});

describe("assertPersona — 非法路径必须抛 TypeError", () => {
  function expectThrow(value: unknown, snippet: string): void {
    assert.throws(
      () => assertPersona(value),
      (err) =>
        err instanceof TypeError &&
        err.message.includes(snippet),
      `expected TypeError including ${JSON.stringify(snippet)} for value ${JSON.stringify(value)}`,
    );
  }

  test("null", () => expectThrow(null, "not an object"));
  test("undefined", () => expectThrow(undefined, "not an object"));
  test("string", () => expectThrow("persona", "not an object"));
  test("number", () => expectThrow(42, "not an object"));
  // 注:array typeof === 'object' → 不进 not-an-object 分支,
  // 但每个 key 在 array 上访问得 undefined → 走 "not a non-empty string"。
  test("array → 走 not-a-non-empty-string 分支", () =>
    expectThrow([], "not a non-empty string"));

  test("缺 user_agent key", () => {
    const partial: Record<string, string> = {
      x_stainless_arch: "arm64",
      x_stainless_lang: "js",
      x_stainless_os: "MacOS",
      x_stainless_package_version: "1.0.0",
      x_stainless_runtime: "node",
      x_stainless_runtime_version: "v20.0.0",
      x_stainless_retry_count: "0",
      accept_language: "en-US",
    };
    expectThrow(partial, "user_agent");
  });

  test("缺 accept_language key", () => {
    const partial: Record<string, string> = {
      user_agent: "ua",
      x_stainless_arch: "arm64",
      x_stainless_lang: "js",
      x_stainless_os: "MacOS",
      x_stainless_package_version: "1.0.0",
      x_stainless_runtime: "node",
      x_stainless_runtime_version: "v20.0.0",
      x_stainless_retry_count: "0",
    };
    expectThrow(partial, "accept_language");
  });

  test("空字符串 user_agent → 抛", () => {
    const p = { ...generatePersona(), user_agent: "" };
    expectThrow(p, "user_agent");
  });

  test("非 string 类型 x_stainless_retry_count(number 而非 '0')→ 抛", () => {
    const p: Record<string, unknown> = { ...generatePersona(), x_stainless_retry_count: 0 };
    expectThrow(p, "x_stainless_retry_count");
  });

  test("null user_agent → 抛", () => {
    const p: Record<string, unknown> = { ...generatePersona(), user_agent: null };
    expectThrow(p, "user_agent");
  });
});

// ─── personaToHeaderPairs ───────────────────────────────────────────────

describe("personaToHeaderPairs", () => {
  test("9 对、全 kebab-case header 名", () => {
    const p = generatePersona();
    const pairs = personaToHeaderPairs(p);
    assert.equal(pairs.length, 9);
    const names = pairs.map(([k]) => k);
    assert.deepEqual(
      [...names].sort(),
      [
        "accept-language",
        "user-agent",
        "x-stainless-arch",
        "x-stainless-lang",
        "x-stainless-os",
        "x-stainless-package-version",
        "x-stainless-retry-count",
        "x-stainless-runtime",
        "x-stainless-runtime-version",
      ].sort(),
    );
  });

  test("值与 persona 字段一一对应", () => {
    const p: Persona = {
      user_agent: "UA-X",
      x_stainless_arch: "ARM",
      x_stainless_lang: "JS",
      x_stainless_os: "OS",
      x_stainless_package_version: "PKG",
      x_stainless_runtime: "RT",
      x_stainless_runtime_version: "RTV",
      x_stainless_retry_count: "RC",
      accept_language: "AL",
    };
    const map = new Map(personaToHeaderPairs(p));
    assert.equal(map.get("user-agent"), "UA-X");
    assert.equal(map.get("x-stainless-arch"), "ARM");
    assert.equal(map.get("x-stainless-lang"), "JS");
    assert.equal(map.get("x-stainless-os"), "OS");
    assert.equal(map.get("x-stainless-package-version"), "PKG");
    assert.equal(map.get("x-stainless-runtime"), "RT");
    assert.equal(map.get("x-stainless-runtime-version"), "RTV");
    assert.equal(map.get("x-stainless-retry-count"), "RC");
    assert.equal(map.get("accept-language"), "AL");
  });
});
