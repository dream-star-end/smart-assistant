/**
 * CG3 — nodeAgentClient rpcCall trace id 头注入测试。
 *
 * 直接单测 `_resolveEffectiveTraceId` 模块内部 seam,以及 `TRACE_ID_HEADER` 跨语言契约。
 *
 * 为什么不端到端测 rpcCall 实际发送的 HTTP 头:
 *   - rpcCall 走 mTLS https.request,需要 CA + master leaf + server leaf 全套
 *     `signHostLeafCsr` + SPIFFE URI 配置,与 trace 头注入本身的逻辑无关
 *   - Node 20 + tsx --test 没有可靠的"已经 import 绑定后再 mock node:https"机制
 *     (Node 22.3+ 的 `t.mock.module()` 是实验,且本仓 engines 还在 20)
 *   - rpcCall 那个分支(headers[TRACE_ID_HEADER] = _resolveEffectiveTraceId(...))只
 *     是 1 行调用 + 字段写入,seam 测过来再加端到端只会重复同一断言
 *
 * 端到端 trace 贯穿契约由 CG10 跨语言契约测(master TS 出帧 + Go agent fixture)兜底。
 */

import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  _resolveEffectiveTraceId,
} from "../nodeAgentClient.js";
import { TRACE_ID_HEADER, TRACE_ID_REGEX } from "@openclaude/protocol";

// 捕获 console.warn 的轻量 fixture:替换 console.warn 为 mock.fn,end 时还原。
function captureWarn<T>(fn: () => T): { value: T; calls: Array<{ msg: unknown; meta: unknown }> } {
  const original = console.warn;
  const calls: Array<{ msg: unknown; meta: unknown }> = [];
  console.warn = ((msg: unknown, meta?: unknown): void => {
    calls.push({ msg, meta });
  }) as typeof console.warn;
  try {
    const value = fn();
    return { value, calls };
  } finally {
    console.warn = original;
  }
}

describe("_resolveEffectiveTraceId — CG3 helper", () => {
  test("合法 trace id 原样返回,无 warn", () => {
    const valid = "abcdef0123456789abcdef0123456789"; // 32 hex,落 TRACE_ID_REGEX
    const { value, calls } = captureWarn(() =>
      _resolveEffectiveTraceId(valid, "host-1", "/health"),
    );
    assert.equal(value, valid);
    assert.equal(calls.length, 0, "valid trace id 不应触发 warn");
  });

  test("undefined 返回 ephemeral 新 id,无 warn(非 turn-bound caller 合规场景)", () => {
    const { value, calls } = captureWarn(() =>
      _resolveEffectiveTraceId(undefined, "host-1", "/baseline/version"),
    );
    assert.match(value, TRACE_ID_REGEX);
    assert.equal(value.length, 32);
    assert.equal(calls.length, 0, "undefined 是合规的非 turn-bound 路径,不应 warn");
  });

  test("非法 trace id(空字符串)→ regenerated ephemeral + warn", () => {
    const { value, calls } = captureWarn(() =>
      _resolveEffectiveTraceId("", "host-2", "/containers/run"),
    );
    assert.match(value, TRACE_ID_REGEX);
    assert.equal(calls.length, 1);
    const meta = calls[0]!.meta as Record<string, unknown>;
    assert.equal(meta.event, "trace-id-invalid");
    assert.equal(meta.hostId, "host-2");
    assert.equal(meta.path, "/containers/run");
    assert.equal(meta.issue, "empty");
    // 严格不打 raw:meta 必须不含原值;fresh 也不入 meta(避免误以为有追溯意义)
    assert.equal((meta as { raw?: unknown }).raw, undefined);
    assert.equal((meta as { fresh?: unknown }).fresh, undefined);
  });

  test("非法 trace id(字符集错,如包含空格)→ regenerated + warn(issue=bad-charset)", () => {
    const dirty = "abc def 0123456789abcdef0123456789"; // 含空格,落 bad-charset
    const { value, calls } = captureWarn(() =>
      _resolveEffectiveTraceId(dirty, "host-3", "/files"),
    );
    assert.notEqual(value, dirty, "脏值不应原样透传");
    assert.match(value, TRACE_ID_REGEX);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.meta as Record<string, unknown>).issue, "bad-charset");
  });

  test("非法 trace id(too-short)→ regenerated + warn(issue=too-short)", () => {
    const { value, calls } = captureWarn(() =>
      _resolveEffectiveTraceId("abc", "host-4", "/volumes/create"),
    );
    assert.match(value, TRACE_ID_REGEX);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.meta as Record<string, unknown>).issue, "too-short");
  });

  test("多次调用 ephemeral 路径 → 每次都是新 id(no static caching)", () => {
    const a = _resolveEffectiveTraceId(undefined, "h", "/p");
    const b = _resolveEffectiveTraceId(undefined, "h", "/p");
    assert.notEqual(a, b, "ephemeral id 不能被缓存");
  });
});

describe("TRACE_ID_HEADER — 跨语言契约不变量", () => {
  test("CG3 写到 master → node-agent 的头名是 x-openclaude-trace-id(小写)", () => {
    assert.equal(TRACE_ID_HEADER, "x-openclaude-trace-id");
    // Go 端 net/http 的 CanonicalMIMEHeaderKey 会读为 "X-Openclaude-Trace-Id";二者
    // 在 HTTP/1.1 大小写不敏感意义下等价。但 Node http.req.headers 的 key 一律小写,
    // node-agent (Go side via CG5) 解头时也按 canonical 取,所以这里 master 端必须
    // 是字面 lowercase。该不变量被 packages/protocol/__tests__/traceId.test.ts 也覆盖一份。
  });
});
