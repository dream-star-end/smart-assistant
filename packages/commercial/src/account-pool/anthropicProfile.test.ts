/**
 * Unit tests for `anthropicProfile.ts` — mock globalThis.fetch,验证错误分类、
 * uuid canonicalize、retry 行为、safeErrMsg 脱敏。
 *
 * 不触 DB / dispatcher,纯函数语义。
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchAnthropicAccountUuid,
  safeErrMsg,
  PROFILE_ENDPOINT,
} from "./anthropicProfile.js";

const VALID_UUID = "12345678-1234-1234-1234-123456789abc";
const VALID_UUID_UPPER = "12345678-1234-1234-1234-123456789ABC";

interface FetchCall {
  url: string;
  init: RequestInit & { dispatcher?: unknown };
}

function mockFetch(
  responder: (call: FetchCall, callIdx: number) => Response | Promise<Response> | never,
) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit & { dispatcher?: unknown }) => {
    const call = { url: String(url), init: (init ?? {}) as FetchCall["init"] };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("safeErrMsg", () => {
  test("脱敏 UUID", () => {
    const got = safeErrMsg(new Error(`Key (account_uuid)=(${VALID_UUID}) exists`));
    assert.ok(!got.includes(VALID_UUID), "uuid should be redacted");
    assert.ok(got.includes("<uuid>"));
  });
  test("脱敏 email", () => {
    const got = safeErrMsg(new Error("user kraussosterland1907@gmail.com not found"));
    assert.ok(!got.includes("@gmail.com"), "email should be redacted");
    assert.ok(got.includes("<email>"));
  });
  test("截断到 200 字符", () => {
    const got = safeErrMsg(new Error("x".repeat(500)));
    assert.equal(got.length, 200);
  });
  test("非 Error 也能处理", () => {
    assert.equal(safeErrMsg("plain string"), "plain string");
    assert.equal(safeErrMsg(null), "null");
  });
});

describe("fetchAnthropicAccountUuid - 200 happy path", () => {
  test("返回 ok + lowercased uuid", async () => {
    const m = mockFetch(() =>
      jsonResponse(200, { account: { uuid: VALID_UUID_UPPER } }),
    );
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "ok");
      if (r.kind === "ok") {
        assert.equal(r.uuid, VALID_UUID, "uuid 应该已经被 lowercase");
      }
      assert.equal(m.calls.length, 1);
      assert.equal(m.calls[0].url, PROFILE_ENDPOINT);
      const headers = m.calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer tok");
    } finally {
      m.restore();
    }
  });
});

describe("fetchAnthropicAccountUuid - 错误分类", () => {
  test("401 → token_invalid", async () => {
    const m = mockFetch(() => jsonResponse(401, { error: "invalid_token" }));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "token_invalid");
      if (r.kind === "token_invalid") assert.equal(r.status, 401);
    } finally {
      m.restore();
    }
  });
  test("403 → token_invalid", async () => {
    const m = mockFetch(() => jsonResponse(403, "forbidden"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "token_invalid");
    } finally {
      m.restore();
    }
  });
  test("429 → http_4xx", async () => {
    const m = mockFetch(() => jsonResponse(429, "too many"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "http_4xx");
      if (r.kind === "http_4xx") assert.equal(r.status, 429);
    } finally {
      m.restore();
    }
  });
  test("502 → http_5xx", async () => {
    const m = mockFetch(() => jsonResponse(502, "bad gateway"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "http_5xx");
    } finally {
      m.restore();
    }
  });
  test("network 异常 → network", async () => {
    const m = mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "network");
      if (r.kind === "network") assert.ok(r.detail.includes("ECONNREFUSED"));
    } finally {
      m.restore();
    }
  });
  test("200 但非 JSON → bad_shape", async () => {
    const m = mockFetch(() => jsonResponse(200, "not json {{{"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "bad_shape");
      if (r.kind === "bad_shape") assert.equal(r.detail, "json_parse_error");
    } finally {
      m.restore();
    }
  });
  test("200 但无 account 字段 → bad_shape", async () => {
    const m = mockFetch(() => jsonResponse(200, { profile: {} }));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "bad_shape");
    } finally {
      m.restore();
    }
  });
  test("200 但 uuid 非 UUID 形 → bad_shape", async () => {
    const m = mockFetch(() => jsonResponse(200, { account: { uuid: "not-a-uuid" } }));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "bad_shape");
      if (r.kind === "bad_shape") assert.equal(r.detail, "uuid_not_uuid_like");
    } finally {
      m.restore();
    }
  });
  test("200 但 uuid 字段不是字符串 → bad_shape", async () => {
    const m = mockFetch(() => jsonResponse(200, { account: { uuid: 12345 } }));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "bad_shape");
      if (r.kind === "bad_shape") assert.equal(r.detail, "uuid_not_string");
    } finally {
      m.restore();
    }
  });
});

describe("fetchAnthropicAccountUuid - retryOnTransient", () => {
  test("network 失败一次后重试成功", async () => {
    const m = mockFetch((_call, idx) => {
      if (idx === 0) throw new Error("ECONNREFUSED");
      return jsonResponse(200, { account: { uuid: VALID_UUID } });
    });
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined, {
        retryOnTransient: true,
        timeoutMs: 500,
      });
      assert.equal(r.kind, "ok");
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });
  test("5xx 失败一次后重试成功", async () => {
    const m = mockFetch((_call, idx) => {
      if (idx === 0) return jsonResponse(503, "down");
      return jsonResponse(200, { account: { uuid: VALID_UUID } });
    });
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined, {
        retryOnTransient: true,
        timeoutMs: 500,
      });
      assert.equal(r.kind, "ok");
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });
  test("token_invalid 不重试", async () => {
    const m = mockFetch(() => jsonResponse(401, "bad token"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined, {
        retryOnTransient: true,
        timeoutMs: 500,
      });
      assert.equal(r.kind, "token_invalid");
      assert.equal(m.calls.length, 1, "token_invalid 不应触发 retry");
    } finally {
      m.restore();
    }
  });
  test("bad_shape 不重试", async () => {
    const m = mockFetch(() => jsonResponse(200, { account: { uuid: "bad" } }));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined, {
        retryOnTransient: true,
        timeoutMs: 500,
      });
      assert.equal(r.kind, "bad_shape");
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });
  test("两次 5xx 都失败 → 返第二次错误", async () => {
    const m = mockFetch(() => jsonResponse(503, "down"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined, {
        retryOnTransient: true,
        timeoutMs: 500,
      });
      assert.equal(r.kind, "http_5xx");
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });
  test("retryOnTransient=false 不重试", async () => {
    const m = mockFetch(() => jsonResponse(503, "down"));
    try {
      const r = await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(r.kind, "http_5xx");
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });
});

describe("fetchAnthropicAccountUuid - dispatcher 注入", () => {
  test("传入 dispatcher 会进入 init", async () => {
    const fakeDispatcher = { kind: "fake" } as unknown as import("undici").Dispatcher;
    const m = mockFetch(() => jsonResponse(200, { account: { uuid: VALID_UUID } }));
    try {
      await fetchAnthropicAccountUuid("tok", fakeDispatcher);
      assert.equal(m.calls[0].init.dispatcher, fakeDispatcher);
    } finally {
      m.restore();
    }
  });
  test("不传 dispatcher 时 init 无该字段", async () => {
    const m = mockFetch(() => jsonResponse(200, { account: { uuid: VALID_UUID } }));
    try {
      await fetchAnthropicAccountUuid("tok", undefined);
      assert.equal(m.calls[0].init.dispatcher, undefined);
    } finally {
      m.restore();
    }
  });
});
