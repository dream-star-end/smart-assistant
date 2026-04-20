/**
 * V3 Phase 2 Task 2I-1 — 结构化 logger 单元测试。
 *
 * 跑法: npx tsx --test src/__tests__/logger.test.ts
 *
 * 覆盖:
 *   - JSON-line 输出格式 (ts/level/msg + base + fields)
 *   - level filter
 *   - child binding 合并 + 不影响父 logger
 *   - SENSITIVE_KEYS redaction (顶层 + 嵌套 + 数组里的对象 + child binding + base)
 *   - case-insensitive sensitive key matching
 *   - cyclic ref → "<cyclic>"
 *   - depth limit → "<truncated:depth>"
 *   - bigint 序列化
 *   - Error → {name, message, stack}
 *   - parseLevel 容错
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createLogger,
  parseLevel,
  SENSITIVE_KEYS,
  type Logger,
  type LogLevel,
} from "../logging/logger.js";

function captureLogger(opts?: { level?: LogLevel; base?: Record<string, unknown> }): {
  logger: Logger;
  lines: string[];
  parsed: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    ...opts,
    out: (line) => { lines.push(line); },
    now: () => "2026-04-20T00:00:00.000Z",
  });
  return {
    logger,
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("createLogger — basic output", () => {
  test("writes one JSON line per call with ts/level/msg", () => {
    const c = captureLogger();
    c.logger.info("hello", { foo: 1 });
    assert.equal(c.lines.length, 1);
    const obj = c.parsed()[0]!;
    assert.equal(obj.ts, "2026-04-20T00:00:00.000Z");
    assert.equal(obj.level, "info");
    assert.equal(obj.msg, "hello");
    assert.equal(obj.foo, 1);
  });

  test("level filter drops below threshold", () => {
    const c = captureLogger({ level: "warn" });
    c.logger.debug("d");
    c.logger.info("i");
    c.logger.warn("w");
    c.logger.error("e");
    const parsed = c.parsed();
    assert.deepEqual(parsed.map((p) => p.level), ["warn", "error"]);
  });

  test("base bindings appear in every line", () => {
    const c = captureLogger({ base: { service: "x", host: "h" } });
    c.logger.info("a");
    c.logger.warn("b");
    const parsed = c.parsed();
    assert.equal(parsed[0]!.service, "x");
    assert.equal(parsed[0]!.host, "h");
    assert.equal(parsed[1]!.service, "x");
  });

  test("ts/level/msg cannot be overridden by fields", () => {
    const c = captureLogger();
    c.logger.info("real-msg", { ts: "fake", level: "fake", msg: "fake" });
    const obj = c.parsed()[0]!;
    assert.equal(obj.ts, "2026-04-20T00:00:00.000Z");
    assert.equal(obj.level, "info");
    assert.equal(obj.msg, "real-msg");
  });
});

describe("logger.child", () => {
  test("merges parent + child bindings; child wins on conflict", () => {
    const c = captureLogger({ base: { a: 1, b: 2 } });
    const ch = c.logger.child({ b: 99, c: 3 });
    ch.info("hi");
    const obj = c.parsed()[0]!;
    assert.equal(obj.a, 1);
    assert.equal(obj.b, 99);
    assert.equal(obj.c, 3);
  });

  test("child does not mutate parent", () => {
    const c = captureLogger({ base: { a: 1 } });
    const ch = c.logger.child({ a: 999, extra: true });
    c.logger.info("from-parent");
    ch.info("from-child");
    const parsed = c.parsed();
    assert.equal(parsed[0]!.a, 1);
    assert.equal(parsed[0]!.extra, undefined);
    assert.equal(parsed[1]!.a, 999);
    assert.equal(parsed[1]!.extra, true);
  });
});

describe("redact — SENSITIVE_KEYS", () => {
  test("top-level sensitive key value replaced", () => {
    const c = captureLogger();
    c.logger.info("login", { user: "u", password: "secret-pw", token: "abc" });
    const obj = c.parsed()[0]!;
    assert.equal(obj.user, "u");
    assert.equal(obj.password, "<redacted>");
    assert.equal(obj.token, "<redacted>");
  });

  test("case-insensitive: TOKEN / Token / token all redacted", () => {
    const c = captureLogger();
    c.logger.info("x", { TOKEN: "a", Token: "b", token: "c" });
    const obj = c.parsed()[0]!;
    assert.equal(obj.TOKEN, "<redacted>");
    assert.equal(obj.Token, "<redacted>");
    assert.equal(obj.token, "<redacted>");
  });

  test("nested object sensitive keys redacted", () => {
    const c = captureLogger();
    c.logger.info("x", {
      ctx: {
        user: "u",
        request: { body: "raw-payload", method: "POST" },
      },
    });
    const obj = c.parsed()[0]!;
    const ctx = obj.ctx as Record<string, unknown>;
    assert.equal((ctx.request as Record<string, unknown>).body, "<redacted>");
    assert.equal((ctx.request as Record<string, unknown>).method, "POST");
  });

  test("sensitive key inside array element object redacted", () => {
    const c = captureLogger();
    c.logger.info("x", {
      messages: ["should-be-stripped"],
      items: [{ name: "ok", secret: "leak" }, { name: "ok2", token: "leak2" }],
    });
    const obj = c.parsed()[0]!;
    assert.equal(obj.messages, "<redacted>");
    const items = obj.items as Record<string, unknown>[];
    assert.equal(items[0]!.secret, "<redacted>");
    assert.equal(items[0]!.name, "ok");
    assert.equal(items[1]!.token, "<redacted>");
  });

  test("child bindings also redacted", () => {
    const c = captureLogger();
    const ch = c.logger.child({ uid: 5, password: "no-leak", api_key: "no-leak" });
    ch.info("x");
    const obj = c.parsed()[0]!;
    assert.equal(obj.uid, 5);
    assert.equal(obj.password, "<redacted>");
    assert.equal(obj.api_key, "<redacted>");
  });

  test("base bindings also redacted", () => {
    const c = captureLogger({ base: { service: "x", anthropic_auth_token: "leak" } });
    c.logger.info("y");
    const obj = c.parsed()[0]!;
    assert.equal(obj.service, "x");
    assert.equal(obj.anthropic_auth_token, "<redacted>");
  });

  test("the SENSITIVE_KEYS set covers all known prompt + creds fields", () => {
    // Smoke regression:这些字段如果被某次 PR 删了从 SENSITIVE_KEYS 里漏出去,
    // 立即在这里报红 —— 是 hard 安全 invariant
    const required = [
      "prompt", "messages", "body", "content", "text",
      "system", "system_prompt",
      "secret", "secret_hash", "password", "token",
      "access_token", "refresh_token", "authorization",
      "anthropic_auth_token", "api_key", "cookie",
    ];
    for (const k of required) {
      assert.equal(SENSITIVE_KEYS.has(k), true, `SENSITIVE_KEYS missing required field: ${k}`);
    }
  });
});

describe("redact — edge cases", () => {
  test("cyclic ref does not throw", () => {
    const c = captureLogger();
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    assert.doesNotThrow(() => c.logger.info("cyc", { o }));
    const obj = c.parsed()[0]!;
    const oOut = obj.o as Record<string, unknown>;
    assert.equal(oOut.a, 1);
    assert.equal(oOut.self, "<cyclic>");
  });

  test("BigInt becomes string (no JSON.stringify throw)", () => {
    const c = captureLogger();
    c.logger.info("big", { n: 12345678901234567890n });
    const obj = c.parsed()[0]!;
    assert.equal(typeof obj.n, "string");
    assert.equal(obj.n, "12345678901234567890");
  });

  test("Error → {name, message, stack}", () => {
    const c = captureLogger();
    const e = new TypeError("boom");
    c.logger.error("bad", { err: e });
    const obj = c.parsed()[0]!;
    const err = obj.err as Record<string, unknown>;
    assert.equal(err.name, "TypeError");
    assert.equal(err.message, "boom");
    assert.equal(typeof err.stack, "string");
  });

  test("depth > 8 truncated", () => {
    const c = captureLogger();
    let nested: Record<string, unknown> = { leaf: "end" };
    for (let i = 0; i < 12; i++) {
      nested = { wrap: nested };
    }
    c.logger.info("deep", { x: nested });
    const obj = c.parsed()[0]!;
    let cur: unknown = obj.x;
    let truncated = false;
    for (let i = 0; i < 20; i++) {
      if (cur === "<truncated:depth>") { truncated = true; break; }
      if (cur && typeof cur === "object" && "wrap" in (cur as object)) {
        cur = (cur as Record<string, unknown>).wrap;
      } else {
        break;
      }
    }
    assert.equal(truncated, true);
  });

  test("null / undefined / primitives pass through", () => {
    const c = captureLogger();
    c.logger.info("p", { a: null, b: undefined, c: 0, d: false, e: "" });
    const obj = c.parsed()[0]!;
    assert.equal(obj.a, null);
    assert.equal("b" in obj, false); // JSON drops undefined
    assert.equal(obj.c, 0);
    assert.equal(obj.d, false);
    assert.equal(obj.e, "");
  });
});

describe("parseLevel", () => {
  test("undefined → info", () => { assert.equal(parseLevel(undefined), "info"); });
  test("empty → info", () => { assert.equal(parseLevel(""), "info"); });
  test("WARN → warn (case-insensitive)", () => { assert.equal(parseLevel("WARN"), "warn"); });
  test("debug → debug", () => { assert.equal(parseLevel("debug"), "debug"); });
  test("garbage → info", () => { assert.equal(parseLevel("foo"), "info"); });
});
