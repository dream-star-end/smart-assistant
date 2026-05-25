/**
 * V3 Phase 5 — platformEnvelopeBuilder 单元测试。
 *
 * 跑法: cd packages/commercial && npx tsx --test src/platform/__tests__/platformEnvelopeBuilder.unit.test.ts
 *
 * 矩阵(plan §5.1 Step 7,经 Codex round-2 plan-review 收敛):
 *
 *   - 强制 attribution / CC prefix(system[0]/[1])2 cases
 *   - PII strip 六类规则全覆盖 + 2 negative anchors
 *   - system[N+1] 平台 context 注入(ctx 有 / ctx null)
 *   - system 形态归一化(string / undefined / array)
 *   - messages[0..] system-reminder 替换(string / array / meta prefix scan)
 *   - metadata.user_id 收紧 + EXTRA_METADATA strip + 顶层 session_id strip
 *   - HMAC 派生稳定性(fp3 / account_uuid)
 *   - session_id **来源策略翻转**(2026-05-25 反关联根治):优先信任客户端透传
 *     metadata.user_id.session_id,客户端未送时 HMAC 派生稳定值(同 userId 恒等);
 *     早期 "随机 UUID v4 + 强制 != client" 语义已废弃。
 *   - `now` hook 锁定日期字面
 *   - ERR.2 messages=undefined 不抛(builder 必须 fail-safe)
 *
 * 私有函数(replaceSystemReminder / rewriteMetadata)的 throw 路径不可注入测试(Codex round-2
 * 反馈),由对应 happy-path 替换/keyset assertion 间接守护;若它们 future regress 必导致
 * 表面行为变,被这里的测试捕获。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPlatformEnvelope,
  deriveFp3,
  deriveAccountUuid,
} from "../platformEnvelopeBuilder.js";
import type { PlatformContext } from "../volumeContextReader.js";
import { rootLogger } from "../../logging/logger.js";
import type { ProxyBody } from "../../http/proxy/shared.js";

const log = rootLogger.child({ subsys: "platformEnvelopeBuilder.unit.test" });

const SECRET = "test-platform-hmac-secret-32char";

const FIXED_DATE = new Date("2026-05-21T00:00:00.000Z");
const fixedNow = () => FIXED_DATE;

// ─── helpers ──────────────────────────────────────────────────────────

function ctxFixture(): PlatformContext {
  return {
    userMd: "# boss\n用户名是 boss。",
    memoryMd: "- [Item 1](file1.md) — hook",
    skills: [{ name: "browser", description: "Playwright operations" }],
    volumeMtime: FIXED_DATE,
  };
}

function makeBody(overrides: Partial<ProxyBody> = {}): ProxyBody {
  return {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1000,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  } as ProxyBody;
}

function buildOnce(body: ProxyBody, ctx: PlatformContext | null = ctxFixture()) {
  return buildPlatformEnvelope({
    body,
    ctx,
    userId: 42n,
    serverSecret: SECRET,
    log,
    now: fixedNow,
  });
}

function systemTextAt(body: ProxyBody, idx: number): string {
  const arr = body.system as Array<{ text: string }>;
  return arr[idx]?.text ?? "";
}

// ─── system[0] attribution + system[1] CC prefix ──────────────────────

describe("system[0] attribution + system[1] CC prefix — server-forge,无视客户端", () => {
  test("S0/S1.1 客户端无任何 system → server 写 attribution + CC prefix + 平台 context 占位", () => {
    const body = makeBody();
    const r = buildOnce(body, null);
    const arr = body.system as Array<{ text: string }>;
    assert.equal(arr.length, 3); // [attribution, ccPrefix, platformContext]
    assert.ok(arr[0]!.text.startsWith("x-anthropic-billing-header: cc_version="));
    assert.ok(arr[0]!.text.includes(`.${r.fp3};`));
    assert.equal(arr[1]!.text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.ok(arr[2]!.text.startsWith("# OpenClaude Platform Context"));
    assert.equal(r.systemBlocks, 3);
  });

  test("S0/S1.2 客户端伪造 attribution + CC prefix → server 剥离覆盖,块数恒定", () => {
    const body = makeBody({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=1.0.0.xxx; cc_entrypoint=fake;",
        },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "extra-project-block" },
      ],
    });
    buildOnce(body);
    const arr = body.system as Array<{ text: string }>;
    // 客户端伪造的两个 leading block 被剥;extra-project-block 保留 → 共 4 块
    assert.equal(arr.length, 4);
    assert.ok(arr[0]!.text.startsWith("x-anthropic-billing-header: cc_version="));
    assert.ok(!arr[0]!.text.includes("cc_entrypoint=fake")); // 客户端值被覆盖
    assert.equal(arr[1]!.text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(arr[2]!.text, "extra-project-block");
    assert.ok(arr[3]!.text.startsWith("# OpenClaude Platform Context"));
  });

  test("S0/S1.3 客户端 system === string → 转 array 并保留为 tail block", () => {
    const body = makeBody({ system: "client raw system string" } as Partial<ProxyBody>);
    buildOnce(body, null);
    const arr = body.system as Array<{ text: string }>;
    assert.equal(arr.length, 4);
    assert.equal(arr[2]!.text, "client raw system string");
  });
});

// ─── PII strip 六类 + 2 negative anchors ──────────────────────────────

describe("PII strip — system[2..N] 命中即整块 [redacted-by-platform]", () => {
  function buildWithSystemBlock(text: string) {
    const body = makeBody({
      system: [{ type: "text", text }],
    });
    const r = buildOnce(body, null);
    return { body, r };
  }
  function assertStripped(text: string, expectStrip: boolean) {
    const { body, r } = buildWithSystemBlock(text);
    const arr = body.system as Array<{ text: string }>;
    const tailBlock = arr[2]!.text;
    if (expectStrip) {
      assert.equal(tailBlock, "[redacted-by-platform]", `expected strip for: ${text}`);
      assert.ok(r.piiStrippedIndexes.length > 0);
    } else {
      assert.equal(tailBlock, text, `expected NO strip for: ${text}`);
      assert.equal(r.piiStrippedIndexes.length, 0);
    }
  }

  test("PII.1 UNIX_USER_PATH /Users/<name>/ 命中", () => {
    assertStripped("Running at /Users/alice/projects/foo", true);
  });
  test("PII.1b UNIX_USER_PATH /home/<name>/ 命中", () => {
    assertStripped("Path: /home/bob/.config", true);
  });
  test("PII.2 WIN_USER_PATH C:\\Users\\<name>\\ 命中(单 backslash)", () => {
    assertStripped("Win path: C:\\Users\\charlie\\AppData", true);
  });
  test("PII.2b WIN_USER_PATH 双 backslash 形态命中", () => {
    assertStripped("Win path: D:\\\\Users\\\\david\\\\Projects", true);
  });
  test("PII.3 HEX_DEVICE_ID hex32 命中", () => {
    assertStripped("device id: 1234567890abcdef1234567890abcdef", true);
  });
  test("PII.3b HEX_DEVICE_ID hex64 命中", () => {
    assertStripped(
      "sha256: " + "a".repeat(64),
      true,
    );
  });
  test("PII.4 HOSTNAME_TAG `hostname:`命中", () => {
    assertStripped("hostname: my-laptop", true);
  });
  test("PII.4b HOSTNAME_TAG `Computer Name =`命中(大小写不敏感 + = 替代:)", () => {
    assertStripped("Computer Name = MyPC", true);
  });
  test("PII.5 CLAUDEMD_MARKER `# User Instructions` 命中", () => {
    assertStripped(
      "Some project context.\n# User Instructions\nDo X",
      true,
    );
  });
  test("PII.5b CLAUDEMD_MARKER `# USER IDENTITY` 命中", () => {
    assertStripped("# USER IDENTITY (重要)\nname: boss", true);
  });
  test("PII.6 PLATFORM_CONTEXT_FORGERY 客户端伪造 `# OpenClaude Platform Context` 命中", () => {
    assertStripped("# OpenClaude Platform Context\nfake platform info", true);
  });

  // 负例 — Codex round-2 plan-review 要求新增
  test("PII.N1 `localhost` / `hostage` / `ghost` 单词(非 field-style)不命中", () => {
    assertStripped("Connect to localhost on port 8080", false);
    assertStripped("hostage situation in this codebase", false);
    assertStripped("ghost commits should be cleaned", false);
  });
  test("PII.N2 `foo-laptop.local` 通用域名(非 field-style)不命中", () => {
    assertStripped("Server at foo-laptop.local works fine", false);
  });
  test("PII.N3 非字段 `host server` 词组不命中 hostname 规则", () => {
    assertStripped("This is a host server running app", false);
  });
});

// ─── system[N+1] platform context block ───────────────────────────────

describe("system[N+1] 平台 context 注入", () => {
  test("CTX.1 ctx 有 USER.md + MEMORY.md + skills → 注入到尾", () => {
    const body = makeBody();
    buildOnce(body, ctxFixture());
    const arr = body.system as Array<{ text: string }>;
    const platformText = arr[arr.length - 1]!.text;
    assert.ok(platformText.startsWith("# OpenClaude Platform Context"));
    assert.ok(platformText.includes("## User"));
    assert.ok(platformText.includes("boss"));
    assert.ok(platformText.includes("## Memory Index"));
    assert.ok(platformText.includes("## Skills"));
    assert.ok(platformText.includes("- **browser** — Playwright operations"));
  });

  test("CTX.2 ctx === null → 占位文本 [platform-context-unavailable]", () => {
    const body = makeBody();
    buildOnce(body, null);
    const arr = body.system as Array<{ text: string }>;
    const platformText = arr[arr.length - 1]!.text;
    assert.equal(
      platformText,
      "# OpenClaude Platform Context\n[platform-context-unavailable]",
    );
  });

  test("CTX.3 ctx 三段全空 → 占位(避免空 block 攻击形态)", () => {
    const body = makeBody();
    buildOnce(body, {
      userMd: "",
      memoryMd: "",
      skills: [],
      volumeMtime: null,
    });
    const arr = body.system as Array<{ text: string }>;
    const platformText = arr[arr.length - 1]!.text;
    assert.equal(
      platformText,
      "# OpenClaude Platform Context\n[platform-context-unavailable]",
    );
  });
});

// ─── messages[0..] system-reminder 替换 ──────────────────────────────

describe("messages[0..] CCB <system-reminder> 替换", () => {
  test("MSG.1 string content 命中 → 整 content 替换为 server 版", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content:
            "<system-reminder>...# claudeMd\nclient hostname: x\n</system-reminder>",
          isMeta: true,
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, true);
    const replaced = (body.messages[0] as { content: string }).content;
    assert.ok(replaced.startsWith("<system-reminder>"));
    assert.ok(replaced.includes("# claudeMd"));
    assert.ok(replaced.includes("# currentDate"));
    assert.ok(replaced.includes("Today's date is 2026-05-21."));
    assert.ok(!replaced.includes("client hostname"), "客户端原文必须不残留");
  });

  test("MSG.2 array content text-block 形态命中 → c0.text 替换", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "<system-reminder>...# claudeMd\nclient /Users/alice/.\n</system-reminder>",
            },
            { type: "text", text: "other user content" },
          ],
          isMeta: true,
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, true);
    const msg = body.messages[0] as { content: Array<{ text: string }> };
    assert.ok(msg.content[0]!.text.includes("Today's date is 2026-05-21."));
    assert.equal(msg.content[1]!.text, "other user content");
  });

  test("MSG.3 isMeta === false → 视为真实用户轮,不替换(扫描即止)", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content:
            "<system-reminder>...# claudeMd\nclient data\n</system-reminder>",
          isMeta: false,
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, false);
    assert.ok(
      (body.messages[0] as { content: string }).content.includes("client data"),
    );
  });

  test("MSG.4 role !== user → 不替换(扫描即止)", () => {
    const body = makeBody({
      messages: [
        {
          role: "assistant",
          content: "<system-reminder>...# claudeMd\n</system-reminder>",
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, false);
  });

  test("MSG.5 meta 前缀扫描:messages[0]=deferred-tools meta, messages[1]=claudeMd 命中替换", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content: "<available-deferred-tools>foo</available-deferred-tools>",
          isMeta: true,
        } as unknown,
        {
          role: "user",
          content:
            "<system-reminder>...# claudeMd\nclient hostname: hidden\n</system-reminder>",
          isMeta: true,
        } as unknown,
        {
          role: "user",
          content: "real user turn",
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, true);
    const replaced = (body.messages[1] as { content: string }).content;
    assert.ok(replaced.includes("Today's date is 2026-05-21."));
    // 真用户轮不动
    assert.equal(
      (body.messages[2] as { content: string }).content,
      "real user turn",
    );
  });

  test("MSG.6 meta 前缀里没 claudeMd → 不替换", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content: "<available-deferred-tools>foo</available-deferred-tools>",
          isMeta: true,
        } as unknown,
        { role: "user", content: "real user turn" } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, false);
  });

  test("MSG.7 messages[0] 显式 isMeta=false → 扫描立即停止,后续 claudeMd 不动", () => {
    // 真实用户轮的 CCB 表示就是 isMeta:false;扫描契约只在显式 false 时停
    const body = makeBody({
      messages: [
        { role: "user", content: "real user turn first", isMeta: false } as unknown,
        {
          role: "user",
          content: "<system-reminder># claudeMd</system-reminder>",
          isMeta: true,
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, false);
    assert.ok(
      (body.messages[1] as { content: string }).content.includes("# claudeMd"),
    );
  });

  test("MSG.8 role=assistant 中间出现 → 扫描立即停止", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content: "<available-deferred-tools>foo</available-deferred-tools>",
          isMeta: true,
        } as unknown,
        { role: "assistant", content: "old turn" } as unknown,
        {
          role: "user",
          content: "<system-reminder># claudeMd</system-reminder>",
          isMeta: true,
        } as unknown,
      ],
    });
    const r = buildOnce(body);
    assert.equal(r.systemReminderReplaced, false);
  });
});

// ─── metadata.user_id 收紧 + EXTRA_METADATA strip ─────────────────────

describe("metadata 重写 — 收紧 user_id + EXTRA strip + 顶层 session_id strip", () => {
  test("META.1 客户端 metadata.user_id JSON 含 device_id/session_id → device_id 保留占位,session_id 信任", () => {
    const body = makeBody({
      metadata: {
        user_id: JSON.stringify({
          device_id: "client-machine-deviceid",
          account_uuid: "client-uuid",
          session_id: "client-session",
        }),
      },
    });
    buildOnce(body);
    const userIdObj = JSON.parse((body.metadata!.user_id as string));
    assert.deepEqual(Object.keys(userIdObj).sort(), [
      "account_uuid",
      "device_id",
      "session_id",
    ]);
    assert.equal(userIdObj.device_id, "client-machine-deviceid");
    // account_uuid 必为 server 派生(不等于 client 透传)
    assert.notEqual(userIdObj.account_uuid, "client-uuid");
    assert.equal(userIdObj.account_uuid, deriveAccountUuid(SECRET, 42n));
    // session_id 翻转后由 client 提供(2026-05-25 根治),服务端信任不覆盖
    assert.equal(userIdObj.session_id, "client-session");
  });

  test("META.2 客户端 metadata.user_id 是非 JSON 字符串 → device_id 占空串", () => {
    const body = makeBody({
      metadata: { user_id: "not-json-just-a-string" },
    });
    buildOnce(body);
    const userIdObj = JSON.parse((body.metadata!.user_id as string));
    assert.equal(userIdObj.device_id, "");
  });

  test("META.3 客户端无 metadata → 收紧成 3-key,device_id 占空串", () => {
    const body = makeBody();
    buildOnce(body);
    assert.ok(body.metadata);
    const userIdObj = JSON.parse((body.metadata.user_id as string));
    assert.deepEqual(Object.keys(userIdObj).sort(), [
      "account_uuid",
      "device_id",
      "session_id",
    ]);
    assert.equal(userIdObj.device_id, "");
  });

  test("META.4 客户端 EXTRA_METADATA 字段(顶层 session_id / 自定义 key)全 strip", () => {
    const body = makeBody({
      metadata: {
        user_id: JSON.stringify({ device_id: "d" }),
        session_id: "top-level-session-should-die",
        custom_extra_key: "should-die",
        random_field: "should-die",
      } as Record<string, unknown>,
    });
    buildOnce(body);
    // 最终只剩 user_id 一个 key
    assert.deepEqual(Object.keys(body.metadata!), ["user_id"]);
  });

  test("META.5 客户端 metadata.user_id JSON 含 EXTRA 字段 → 也被收紧掉", () => {
    const body = makeBody({
      metadata: {
        user_id: JSON.stringify({
          device_id: "d",
          custom_random_inner: "leak",
          another_extra: 42,
        }),
      },
    });
    buildOnce(body);
    const userIdObj = JSON.parse((body.metadata!.user_id as string));
    assert.deepEqual(Object.keys(userIdObj).sort(), [
      "account_uuid",
      "device_id",
      "session_id",
    ]);
  });
});

// ─── HMAC 派生稳定性 ──────────────────────────────────────────────────

describe("HMAC 派生稳定性 — fp3 / account_uuid", () => {
  test("HMAC.1 fp3 同 userId 同 secret → 跨多次调用稳定", () => {
    const a = deriveFp3(SECRET, 100n);
    const b = deriveFp3(SECRET, 100n);
    const c = deriveFp3(SECRET, 100n);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a.length, 3);
    assert.match(a, /^[0-9a-f]{3}$/);
  });

  test("HMAC.2 fp3 不同 userId → 大概率不同(防 trivial collision)", () => {
    const a = deriveFp3(SECRET, 1n);
    const b = deriveFp3(SECRET, 2n);
    const c = deriveFp3(SECRET, 999999n);
    // 3 个值不可能全相同(12 bit 熵 + HMAC 输出)
    assert.ok(!(a === b && b === c));
  });

  test("HMAC.3 fp3 不同 secret → 不同(隔离性)", () => {
    const a = deriveFp3(SECRET, 100n);
    const b = deriveFp3("different-secret-32-chars-padding", 100n);
    assert.notEqual(a, b);
  });

  test("HMAC.4 account_uuid 形态 = UUID v4(version + variant bit 正确)", () => {
    const uuid = deriveAccountUuid(SECRET, 42n);
    assert.match(
      uuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      `account_uuid 必须符合 UUID v4 shape, got: ${uuid}`,
    );
  });

  test("HMAC.5 account_uuid 同 userId 稳定 + 不同 userId 不同", () => {
    const a = deriveAccountUuid(SECRET, 42n);
    const b = deriveAccountUuid(SECRET, 42n);
    const c = deriveAccountUuid(SECRET, 43n);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test("HMAC.6 account_uuid 不同 secret → 不同", () => {
    const a = deriveAccountUuid(SECRET, 42n);
    const b = deriveAccountUuid("different-secret-32-chars-padding", 42n);
    assert.notEqual(a, b);
  });
});

// ─── session_id 来源策略 ──────────────────────────────────────────────
// 2026-05-25 反关联根治翻转:client 优先,derived 兜底。
// 见 platformEnvelopeBuilder.ts §session_id 来源策略。

describe("session_id 来源策略 — client 优先 / derived 兜底", () => {
  test("SES.1 client 未送 + 同 userId → derived session_id 恒等(强 anti-correlation 锚)", () => {
    const sessions = new Set<string>();
    const result = { source: "" as "client" | "derived" };
    for (let i = 0; i < 5; i++) {
      const body = makeBody();
      const r = buildPlatformEnvelope({
        body,
        ctx: null,
        userId: 42n,
        serverSecret: SECRET,
        log,
        now: fixedNow,
      });
      result.source = r.sessionIdSource;
      const obj = JSON.parse(body.metadata!.user_id as string);
      sessions.add(obj.session_id);
    }
    // 同 userId 5 次 build,derived session_id 必须恒等
    assert.equal(sessions.size, 1);
    assert.equal(result.source, "derived");
  });

  test("SES.2 derived session_id 形态 = 36 字符 hex(非 UUID v4 形态,标记 server-derived 来源)", () => {
    const body = makeBody();
    buildOnce(body);
    const obj = JSON.parse(body.metadata!.user_id as string);
    assert.match(obj.session_id, /^[0-9a-f]{36}$/);
  });

  test("SES.3 client 透传 session_id → server 信任不覆盖(pin 表能锚定)", () => {
    const body = makeBody({
      metadata: {
        user_id: JSON.stringify({
          device_id: "d",
          account_uuid: "client-uuid",
          session_id: "client-supplied-session-fixed-value",
        }),
      },
    });
    const r = buildPlatformEnvelope({
      body,
      ctx: null,
      userId: 42n,
      serverSecret: SECRET,
      log,
      now: fixedNow,
    });
    const obj = JSON.parse(body.metadata!.user_id as string);
    assert.equal(obj.session_id, "client-supplied-session-fixed-value");
    assert.equal(r.sessionIdSource, "client");
  });

  test("SES.4 client 送非法 session_id(空串 / 超长 / 非 string) → fallback derived", () => {
    for (const bad of [
      "", // 空串
      "a".repeat(257), // 超 256
      12345, // 非 string
      null, // null
    ]) {
      const body = makeBody({
        metadata: {
          user_id: JSON.stringify({
            device_id: "d",
            account_uuid: "client-uuid",
            session_id: bad,
          }),
        },
      });
      const r = buildPlatformEnvelope({
        body,
        ctx: null,
        userId: 42n,
        serverSecret: SECRET,
        log,
        now: fixedNow,
      });
      const obj = JSON.parse(body.metadata!.user_id as string);
      assert.equal(r.sessionIdSource, "derived", `bad=${JSON.stringify(bad)}`);
      assert.match(obj.session_id, /^[0-9a-f]{36}$/);
    }
  });

  test("SES.5 derived session_id 由 (serverSecret, userId) 派生 — 跨 secret 不同,跨 userId 不同", () => {
    const ALT_SECRET = "alt-platform-hmac-secret-32char_";
    const bodyA = makeBody();
    const bodyB = makeBody();
    const bodyC = makeBody();
    buildPlatformEnvelope({ body: bodyA, ctx: null, userId: 42n, serverSecret: SECRET, log, now: fixedNow });
    buildPlatformEnvelope({ body: bodyB, ctx: null, userId: 42n, serverSecret: ALT_SECRET, log, now: fixedNow });
    buildPlatformEnvelope({ body: bodyC, ctx: null, userId: 99n, serverSecret: SECRET, log, now: fixedNow });
    const sA = JSON.parse(bodyA.metadata!.user_id as string).session_id;
    const sB = JSON.parse(bodyB.metadata!.user_id as string).session_id;
    const sC = JSON.parse(bodyC.metadata!.user_id as string).session_id;
    assert.notEqual(sA, sB);
    assert.notEqual(sA, sC);
    assert.notEqual(sB, sC);
  });
});

// ─── now hook ─────────────────────────────────────────────────────────

describe("now hook 锁日期 → system-reminder 含期望字面", () => {
  test("NOW.1 now=2026-05-21 → reminder 含 Today's date is 2026-05-21.", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content: "<system-reminder># claudeMd</system-reminder>",
          isMeta: true,
        } as unknown,
      ],
    });
    buildOnce(body);
    const replaced = (body.messages[0] as { content: string }).content;
    assert.ok(replaced.includes("Today's date is 2026-05-21."));
  });

  test("NOW.2 now=2030-01-15 → reminder 含 Today's date is 2030-01-15.", () => {
    const body = makeBody({
      messages: [
        {
          role: "user",
          content: "<system-reminder># claudeMd</system-reminder>",
          isMeta: true,
        } as unknown,
      ],
    });
    buildPlatformEnvelope({
      body,
      ctx: null,
      userId: 42n,
      serverSecret: SECRET,
      log,
      now: () => new Date("2030-01-15T12:00:00.000Z"),
    });
    const replaced = (body.messages[0] as { content: string }).content;
    assert.ok(replaced.includes("Today's date is 2030-01-15."));
  });
});

// ─── ERR.2:messages = undefined 不抛 ───────────────────────────────

describe("ERR fail-safe — builder 永不抛", () => {
  test("ERR.2 body.messages undefined → builder 不抛,system 改写正常完成", () => {
    const body = { model: "x", max_tokens: 10 } as unknown as ProxyBody;
    let threw = false;
    try {
      buildPlatformEnvelope({
        body,
        ctx: null,
        userId: 42n,
        serverSecret: SECRET,
        log,
        now: fixedNow,
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "builder must never throw");
    // system 改写仍应工作(messages 是别条路径)
    const arr = body.system as Array<{ text: string }>;
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 3);
  });
});

// ─── H1 multi-machine invariant(builder 层验证)───────────────────────

describe("H1 多机一致 — builder 层断言 system[0]/[1]/[N+1] 字节级一致", () => {
  test("H1.1 同 userId 不同 client body → system[0]/[1] 完全相同 byte-level", () => {
    const clients = [
      { hostname: "alice-mac", system: "client 1 ext" },
      { hostname: "bob-linux", system: "client 2 ext" },
      { hostname: "charlie-win", system: "client 3 ext" },
    ];
    const results = clients.map((c) => {
      const body = makeBody({ system: c.system });
      buildOnce(body, null);
      const arr = body.system as Array<{ text: string }>;
      return { attribution: arr[0]!.text, ccPrefix: arr[1]!.text };
    });
    // 3 个客户端 attribution / ccPrefix 必须 byte-level 相同
    assert.equal(results[0]!.attribution, results[1]!.attribution);
    assert.equal(results[1]!.attribution, results[2]!.attribution);
    assert.equal(results[0]!.ccPrefix, results[1]!.ccPrefix);
    assert.equal(results[1]!.ccPrefix, results[2]!.ccPrefix);
  });

  test("H1.2 同 userId 不同 client body → metadata.user_id keyset 同形态 + account_uuid 字节级一致", () => {
    const accountUuids: string[] = [];
    const keysets: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const body = makeBody({
        metadata: { user_id: JSON.stringify({ device_id: `client-${i}` }) },
      });
      buildOnce(body);
      const obj = JSON.parse(body.metadata!.user_id as string);
      accountUuids.push(obj.account_uuid);
      keysets.push(Object.keys(obj).sort());
    }
    assert.equal(accountUuids[0], accountUuids[1]);
    assert.equal(accountUuids[1], accountUuids[2]);
    assert.deepEqual(keysets[0], keysets[1]);
    assert.deepEqual(keysets[1], keysets[2]);
    assert.deepEqual(keysets[0], ["account_uuid", "device_id", "session_id"]);
  });

  test("H1.3 同 ctx → system[N+1] 字节级一致(平台 context 块稳定)", () => {
    const ctx = ctxFixture();
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const body = makeBody();
      buildOnce(body, ctx);
      const arr = body.system as Array<{ text: string }>;
      texts.push(arr[arr.length - 1]!.text);
    }
    assert.equal(texts[0], texts[1]);
    assert.equal(texts[1], texts[2]);
  });
});
