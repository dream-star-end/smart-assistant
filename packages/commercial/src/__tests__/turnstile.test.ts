import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { verifyTurnstile, TurnstileError, resolveTurnstileBypass } from "../auth/turnstile.js";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe("auth.turnstile.verifyTurnstile", () => {
  test("returns true on success=true response", async () => {
    const ok = await verifyTurnstile("user-token", "secret", {
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 })),
    });
    assert.equal(ok, true);
  });

  test("returns false on success=false response", async () => {
    const ok = await verifyTurnstile("user-token", "secret", {
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ success: false, "error-codes": ["invalid"] }), { status: 200 })),
    });
    assert.equal(ok, false);
  });

  test("throws TurnstileError on non-2xx HTTP", async () => {
    await assert.rejects(
      verifyTurnstile("token", "secret", {
        fetchImpl: fakeFetch(() => new Response("oops", { status: 500 })),
      }),
      (err: unknown) => err instanceof TurnstileError && /HTTP 500/.test((err as Error).message),
    );
  });

  test("throws TurnstileError on fetch network error", async () => {
    await assert.rejects(
      verifyTurnstile("token", "secret", {
        fetchImpl: () => Promise.reject(new Error("ENOTFOUND")) as never,
      }),
      TurnstileError,
    );
  });

  test("returns false on empty token without making any HTTP call", async () => {
    let called = false;
    const ok = await verifyTurnstile("", "secret", {
      fetchImpl: fakeFetch(() => {
        called = true;
        return new Response("{}");
      }),
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  test("bypass=true returns true even when secret is missing", async () => {
    const ok = await verifyTurnstile("any-token", undefined, { bypass: true });
    assert.equal(ok, true);
  });

  test("throws TurnstileError when secret is missing and not bypassed", async () => {
    await assert.rejects(
      verifyTurnstile("token", undefined),
      (err: unknown) => err instanceof TurnstileError && /not configured/.test((err as Error).message),
    );
  });

  test("forwards remoteIp to verification request body", async () => {
    let capturedBody = "";
    await verifyTurnstile("token", "secret", {
      remoteIp: "1.2.3.4",
      fetchImpl: fakeFetch((_url, init) => {
        capturedBody = init.body!.toString();
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }),
    });
    assert.match(capturedBody, /remoteip=1\.2\.3\.4/);
    assert.match(capturedBody, /response=token/);
    assert.match(capturedBody, /secret=secret/);
  });
});

/**
 * resolveTurnstileBypass —— 旁路判定的单一权威(2026-07-26 安全整改)。
 *
 * 背景:生产 env 曾长期挂着 TURNSTILE_TEST_BYPASS=1,注册/登录/找回密码三个公开入口的
 * 人机验证全站失效。之所以摘不掉,是因为 4 条生产自动化(e2e-journey / smoke-turn /
 * baseline-evals / market-skill-eval)都在发占位 token。整改把"旁路"从环境级降到账号级。
 *
 * 这些用例锁的是**作用域收敛**:白名单只对指定邮箱生效,任何其他账号一律走真实校验。
 */
describe("auth.turnstile.resolveTurnstileBypass", () => {
  const ACCOUNTS = ["v5-canary@claudeai.chat", "v5-evals@claudeai.chat"] as const;

  test("enforce=false 直接放行(显式产品配置,优先级最高)", () => {
    assert.equal(resolveTurnstileBypass({ enforce: false }), true);
    // 即使白名单为空、也没有全局旁路,不强制就是不强制
    assert.equal(
      resolveTurnstileBypass({ enforce: false, bypassAccounts: [], accountEmail: "someone@example.com" }),
      true,
    );
  });

  test("enforce 缺省(undefined)= 强制,绝不因忘传而放行", () => {
    // 这条是本开关最危险的失效形态:新调用点忘了透传 enforce,若默认放行则等于全站关掉
    assert.equal(resolveTurnstileBypass({ accountEmail: "someone@example.com" }), false);
    assert.equal(resolveTurnstileBypass({}), false);
  });

  test("enforce=true 时白名单语义不变", () => {
    assert.equal(
      resolveTurnstileBypass({ enforce: true, bypassAccounts: ACCOUNTS, accountEmail: "v5-canary@claudeai.chat" }),
      true,
    );
    assert.equal(
      resolveTurnstileBypass({ enforce: true, bypassAccounts: ACCOUNTS, accountEmail: "someone@example.com" }),
      false,
    );
  });

  test("全局旁路为真时直接放行(dev/CI 语义,生产由 config fail-closed 拦死)", () => {
    assert.equal(resolveTurnstileBypass({ globalBypass: true }), true);
    // 全局旁路优先级最高:即使没有白名单、没有邮箱也放行
    assert.equal(
      resolveTurnstileBypass({ globalBypass: true, bypassAccounts: [], accountEmail: null }),
      true,
    );
  });

  test("命中白名单的账号放行", () => {
    assert.equal(
      resolveTurnstileBypass({ bypassAccounts: ACCOUNTS, accountEmail: "v5-canary@claudeai.chat" }),
      true,
    );
  });

  test("白名单比对忽略大小写与首尾空白", () => {
    for (const variant of ["  V5-Canary@ClaudeAI.chat  ", "V5-CANARY@CLAUDEAI.CHAT", " v5-canary@claudeai.chat"]) {
      assert.equal(
        resolveTurnstileBypass({ bypassAccounts: ACCOUNTS, accountEmail: variant }),
        true,
        `variant=${JSON.stringify(variant)} 应命中`,
      );
    }
    // 白名单侧同样容忍未规范化的配置(防绕过 config 直接构造 deps 的调用方静默失配)
    assert.equal(
      resolveTurnstileBypass({ bypassAccounts: ["  V5-Canary@ClaudeAI.chat "], accountEmail: "v5-canary@claudeai.chat" }),
      true,
    );
  });

  test("未命中白名单的账号一律不放行 —— 这是真实用户的路径", () => {
    for (const email of ["someone@example.com", "v5-canary@evil.com", "v5-canary@claudeai.chat.evil.com", ""]) {
      assert.equal(
        resolveTurnstileBypass({ bypassAccounts: ACCOUNTS, accountEmail: email }),
        false,
        `email=${JSON.stringify(email)} 不应放行`,
      );
    }
  });

  test("白名单为空/未配时任何账号都不放行(缺省即最严)", () => {
    assert.equal(resolveTurnstileBypass({ accountEmail: "v5-canary@claudeai.chat" }), false);
    assert.equal(
      resolveTurnstileBypass({ bypassAccounts: [], accountEmail: "v5-canary@claudeai.chat" }),
      false,
    );
  });

  test("accountEmail 缺失/非字符串时不放行(不能靠 undefined 撞进白名单)", () => {
    assert.equal(resolveTurnstileBypass({ bypassAccounts: ACCOUNTS }), false);
    assert.equal(resolveTurnstileBypass({ bypassAccounts: ACCOUNTS, accountEmail: null }), false);
    assert.equal(
      resolveTurnstileBypass({ bypassAccounts: ACCOUNTS, accountEmail: undefined }),
      false,
    );
  });
});
