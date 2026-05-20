/**
 * V3 envv2 Phase 3(2026-05-21)— `externalEnvelopeV2.ts` golden tests.
 *
 * 跑法: npx tsx --test src/__tests__/externalEnvelopeV2.unit.test.ts
 *
 * 覆盖 plan §Phase 3 + §3 全局不变量 I1/I2/I3/I5/I5b/I6:
 *
 *   T1  同 account + 同 body → outbound 字节级一致 (I1 determinism)
 *   T2  同 account + 3 个不同 body → L0 (prefix + attribution) 完全相同 (I2)
 *   T3  不同 account → attribution fingerprint 不同 (I3)
 *   T5  客户端伪造 attribution(spoof)→ 被 strip,服务端版本生效 (I5)
 *   T5b 客户端 metadata.user_id 含 fingerprint 字段 → 被 strip (I5b)
 *   T6  Idempotency:跑两次 outbound === 跑一次
 *   T7  非 default prefix variant (agent_sdk) → 保留客户端 prefix,attribution 仍注入
 *   T7b 客户端在 system 中段塞 prefix → attribution 跟在 prefix 之后(不是 index 1)
 *   T8  cache 未 ready / variant 行缺失 → 抛 EnvelopePrefixCacheNotReadyError
 *   T9  attribution block 带 cache_control: ephemeral(不污染上游 prefix cache key)
 *
 * 不覆盖(范围外):
 *   - 接 handler / route 派发 → Phase 4
 *   - L1 派生 4 字段(os_arch / cpu_count / node_version / hostname_prefix)→ Phase 4
 *   - metadata.user_id.device_id rewrite → applyUpstreamAuth 既有路径,无关本 helper
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  normalizeExternalApiKeyEnvelopeV2,
  type V2AccountContext,
} from "../http/proxy/externalEnvelopeV2.js";
import {
  EnvelopePrefixCacheNotReadyError,
  type PrefixSource,
} from "../http/proxy/externalEnvelope.js";
import type { PrefixVariant } from "../envelope/prefixTemplateCache.js";
import type { ProxyBody } from "../http/proxy/shared.js";
import type { Logger } from "../logging/logger.js";

// ─── 测试 helpers ─────────────────────────────────────────────────────────

function makeTestLogger(): Logger & {
  calls: { level: string; msg: string; fields?: unknown }[];
} {
  const calls: { level: string; msg: string; fields?: unknown }[] = [];
  const noop = (level: string) =>
    (msg: string, fields?: Record<string, unknown>) => {
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

const FAKE_PREFIX_TEXTS: Record<PrefixVariant, string> = {
  default: DEFAULT_PREFIX,
  agent_sdk_claude_code_preset: AGENT_SDK_CC_PRESET,
  agent_sdk: AGENT_SDK,
};
const fakePrefixSource: PrefixSource = {
  get(v) {
    return FAKE_PREFIX_TEXTS[v] ?? null;
  },
};

/**
 * 固定 16-byte salt 让 fingerprint 可预测 — 任何此值改动 test snapshot 也得改,
 * 保护 invariant I6:同 salt+id 永远算出同一 fingerprint。
 */
const SALT_A = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const SALT_B = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";

function makeAccount(
  overrides: Partial<V2AccountContext> = {},
): V2AccountContext {
  return {
    id: ID_A,
    pinned_user_id: null,
    fingerprint_salt: SALT_A,
    ...overrides,
  };
}

function run(
  body: ProxyBody,
  account: V2AccountContext = makeAccount(),
  log: Logger = makeTestLogger(),
): void {
  normalizeExternalApiKeyEnvelopeV2(body, account, log, fakePrefixSource);
}

/**
 * 从 system array 抽 attribution block 的 fingerprint 值。便于断言。
 */
function extractAttributionFingerprint(body: ProxyBody): string | null {
  const sys = body.system;
  if (!Array.isArray(sys)) return null;
  for (const blk of sys) {
    if (
      blk &&
      typeof blk === "object" &&
      (blk as { type?: unknown }).type === "text" &&
      typeof (blk as { text?: unknown }).text === "string"
    ) {
      const text = (blk as { text: string }).text;
      const m = text.match(
        /^<external-api-account fingerprint="([0-9a-f]{12})" \/>$/,
      );
      if (m) return m[1]!;
    }
  }
  return null;
}

// ─── 测试 ────────────────────────────────────────────────────────────────

describe("normalizeExternalApiKeyEnvelopeV2 — plan §Phase 3", () => {
  test("T1 determinism: 同 account + 同 body 两次跑 → outbound 字节一致", () => {
    const b1 = makeBody({ system: "hello" });
    const b2 = makeBody({ system: "hello" });
    run(b1);
    run(b2);
    assert.equal(JSON.stringify(b1), JSON.stringify(b2));
  });

  test("T2 跨 body L0 一致: 同 account + 3 个不同客户端 body → prefix + attribution 完全相同", () => {
    const bodies = [
      makeBody({ system: undefined }),
      makeBody({ system: "client A custom prompt" }),
      makeBody({
        system: [
          { type: "text", text: "some completely different intro" },
        ],
      }),
    ];
    for (const b of bodies) run(b);

    // 头两块(prefix + attribution)在所有 body 字面相同
    const heads = bodies.map((b) => {
      const sys = b.system as unknown[];
      return JSON.stringify([sys[0], sys[1]]);
    });
    assert.equal(heads[0], heads[1]);
    assert.equal(heads[1], heads[2]);
  });

  test("T3 跨 account: 不同 account → attribution fingerprint 不同", () => {
    const b1 = makeBody({ system: "x" });
    const b2 = makeBody({ system: "x" });
    run(b1, makeAccount({ id: ID_A, fingerprint_salt: SALT_A }));
    run(b2, makeAccount({ id: ID_B, fingerprint_salt: SALT_B }));

    const f1 = extractAttributionFingerprint(b1);
    const f2 = extractAttributionFingerprint(b2);
    assert.ok(f1, "f1 should be present");
    assert.ok(f2, "f2 should be present");
    assert.notEqual(f1, f2);
  });

  test("T5 spoof: 客户端塞 attribution(伪造)→ 被 strip,服务端版本生效", () => {
    const forgedFingerprint = "deadbeefcafe";
    const body = makeBody({
      system: [
        {
          type: "text",
          text: `${DEFAULT_PREFIX}\n\nrest`,
        },
        {
          type: "text",
          text: `<external-api-account fingerprint="${forgedFingerprint}" />`,
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    run(body);

    const server = extractAttributionFingerprint(body);
    assert.ok(server, "server fingerprint should exist");
    assert.notEqual(server, forgedFingerprint);
    // 唯一一个 attribution block — 客户端那个被 strip
    const sys = body.system as unknown[];
    const count = sys.filter((b) =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as { text?: unknown }).text === "string" &&
      ((b as { text: string }).text).startsWith(
        '<external-api-account fingerprint="',
      ),
    ).length;
    assert.equal(count, 1);
  });

  test("T5b spoof L1: 客户端 metadata.user_id.fingerprint → strip", () => {
    const body = makeBody({
      system: "x",
      metadata: {
        user_id: JSON.stringify({
          device_id: "abc",
          fingerprint: "ffffffffffff",
          session_id: "sess1",
        }),
      },
    }) as ProxyBody;
    run(body);

    const parsed = JSON.parse(body.metadata!.user_id!) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.fingerprint, undefined);
    // 其它字段保留
    assert.equal(parsed.device_id, "abc");
    assert.equal(parsed.session_id, "sess1");
  });

  test("T6 idempotency: 跑两次 outbound === 跑一次", () => {
    const a = makeBody({ system: "shared input" });
    const b = makeBody({ system: "shared input" });
    run(a);
    run(b);
    run(b); // re-entry
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    // attribution 仅一个
    const sys = b.system as unknown[];
    const count = sys.filter((blk) =>
      typeof blk === "object" &&
      blk !== null &&
      typeof (blk as { text?: unknown }).text === "string" &&
      ((blk as { text: string }).text).startsWith(
        '<external-api-account fingerprint="',
      ),
    ).length;
    assert.equal(count, 1);
  });

  test("T7 非 default prefix variant (agent_sdk): 保留客户端 prefix,attribution 仍注入", () => {
    const body = makeBody({
      system: [
        { type: "text", text: `${AGENT_SDK}\n\nfoo` },
      ],
    });
    run(body);

    const sys = body.system as unknown[];
    // index 0 仍是 agent_sdk 起始的 text
    assert.equal((sys[0] as { type: string }).type, "text");
    assert.ok(((sys[0] as { text: string }).text).startsWith(AGENT_SDK));
    // 不应该把 DEFAULT_PREFIX 也加进来
    const defaultPresent = sys.some((b) =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as { text?: unknown }).text === "string" &&
      ((b as { text: string }).text).startsWith(DEFAULT_PREFIX) &&
      !((b as { text: string }).text).startsWith(AGENT_SDK_CC_PRESET),
    );
    assert.equal(defaultPresent, false);
    // attribution 在 index 1
    const f = extractAttributionFingerprint(body);
    assert.ok(f);
  });

  test("T7b L0 slot lock: 客户端 prefix 在 system 中段 → 移到 system[0],attribution 在 system[1],客户端 preamble 后移", () => {
    // L0 强锁:无论客户端怎么排,outbound system[0] 必是 CC prefix,system[1] 必是
    // 服务端 attribution。客户端的 preamble 被推到 prefix 之后。
    const body = makeBody({
      system: [
        { type: "text", text: "preamble client text" },
        { type: "text", text: `${DEFAULT_PREFIX}\n\nrest` },
      ],
    });
    run(body);

    const sys = body.system as unknown[];
    // system[0] = CC prefix(保留客户端原 prefix 字面与 variant)
    assert.ok(((sys[0] as { text: string }).text).startsWith(DEFAULT_PREFIX));
    assert.equal((sys[0] as { text: string }).text, `${DEFAULT_PREFIX}\n\nrest`);
    // system[1] = attribution
    const attr = sys[1] as { text: string; cache_control?: unknown };
    assert.ok(attr.text.startsWith('<external-api-account fingerprint="'));
    // system[2] = 客户端 preamble(从 index 0 被推过来)
    assert.equal((sys[2] as { text: string }).text, "preamble client text");
    // 总长 3,无重复 prefix block
    assert.equal(sys.length, 3);
  });

  test("T8 fail-closed: cache 未 ready (variant 行缺失) → throw EnvelopePrefixCacheNotReadyError", () => {
    const badSource: PrefixSource = {
      get(v) {
        if (v === "agent_sdk") return null;
        return FAKE_PREFIX_TEXTS[v]!;
      },
    };
    const body = makeBody({ system: "x" });
    assert.throws(
      () =>
        normalizeExternalApiKeyEnvelopeV2(
          body,
          makeAccount(),
          makeTestLogger(),
          badSource,
        ),
      (err: unknown) =>
        err instanceof EnvelopePrefixCacheNotReadyError &&
        err.variant === "agent_sdk",
    );
  });

  test("T9 attribution block 带 cache_control: ephemeral", () => {
    const body = makeBody({ system: "x" });
    run(body);
    const sys = body.system as unknown[];
    const attribution = sys.find((b) =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as { text?: unknown }).text === "string" &&
      ((b as { text: string }).text).startsWith(
        '<external-api-account fingerprint="',
      ),
    ) as { cache_control?: unknown };
    assert.deepEqual(attribution.cache_control, { type: "ephemeral" });
  });

  test("I6 (回归): 同 salt+id 永远算出同一 fingerprint(snapshot)", () => {
    const body = makeBody({ system: "x" });
    run(body, makeAccount({ id: ID_A, fingerprint_salt: SALT_A }));
    const fp = extractAttributionFingerprint(body);
    // 字面 snapshot:任何 salt-order / hash 函数 / slice 长度漂移都会让这个断言红
    // (锁住 plan §3 全局不变量 I6 + §3.2 fingerprint 派生约定)
    const expected = createHash("sha256")
      .update(Buffer.concat([SALT_A, Buffer.from(ID_A, "utf8")]))
      .digest("hex")
      .slice(0, 12);
    assert.equal(fp, expected);
  });

  test("metadata.user_id 非 JSON → 保持不动(fail-open)", () => {
    const body = makeBody({
      system: "x",
      metadata: { user_id: "plain-not-json-string" },
    }) as ProxyBody;
    run(body);
    assert.equal(body.metadata!.user_id, "plain-not-json-string");
  });

  test("metadata.user_id 是 JSON array → 保持不动", () => {
    const body = makeBody({
      system: "x",
      metadata: { user_id: '["a","b"]' },
    }) as ProxyBody;
    run(body);
    assert.equal(body.metadata!.user_id, '["a","b"]');
  });

  test("metadata.user_id 空 / undefined → 不写入 user_id(L1 不派生本 phase)", () => {
    const body = makeBody({ system: "x", metadata: {} }) as ProxyBody;
    run(body);
    assert.equal(body.metadata!.user_id, undefined);
  });
});
