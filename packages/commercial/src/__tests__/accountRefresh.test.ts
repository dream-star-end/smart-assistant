/**
 * T-33 单元:refresh 模块的纯函数 + 默认值行为。
 *
 * DB / 加密路径走 integ 测试(accountRefresh.integ.test.ts)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefresh,
  DEFAULT_REFRESH_SKEW_MS,
  DEFAULT_OAUTH_ENDPOINT,
  DEFAULT_FALLBACK_EXPIRES_MS,
  RefreshError,
} from "../account-pool/refresh.js";

describe("shouldRefresh", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const skew = 5 * 60 * 1000;

  test("null expiresAt → false(视为永不过期)", () => {
    assert.equal(shouldRefresh(null, now, skew), false);
  });

  test("刚好 now + skew 边界 → true(等号算需要刷新)", () => {
    const edge = new Date(now.getTime() + skew);
    assert.equal(shouldRefresh(edge, now, skew), true);
  });

  test("大于 now + skew → false", () => {
    const future = new Date(now.getTime() + skew + 1);
    assert.equal(shouldRefresh(future, now, skew), false);
  });

  test("已过期(<=now) → true", () => {
    const past = new Date(now.getTime() - 1);
    assert.equal(shouldRefresh(past, now, skew), true);
  });

  test("skew=0:只有过期才 refresh", () => {
    assert.equal(shouldRefresh(new Date(now.getTime() + 1), now, 0), false);
    assert.equal(shouldRefresh(now, now, 0), true);
  });
});

describe("默认常量", () => {
  test("skew = 5min / 1h fallback", () => {
    assert.equal(DEFAULT_REFRESH_SKEW_MS, 5 * 60 * 1000);
    assert.equal(DEFAULT_FALLBACK_EXPIRES_MS, 60 * 60 * 1000);
  });

  test("endpoint 形如 https://.../oauth/token", () => {
    assert.ok(DEFAULT_OAUTH_ENDPOINT.startsWith("https://"));
    assert.ok(DEFAULT_OAUTH_ENDPOINT.endsWith("/oauth/token"));
  });
});

describe("RefreshError", () => {
  test("保留 code / status", () => {
    const e = new RefreshError("http_error", "boom", { status: 502 });
    assert.equal(e.name, "RefreshError");
    assert.equal(e.code, "http_error");
    assert.equal(e.status, 502);
  });

  test("不带 status 时 status=undefined", () => {
    const e = new RefreshError("bad_response", "nope");
    assert.equal(e.status, undefined);
  });

  test("保留 cause", () => {
    const cause = new Error("root");
    const e = new RefreshError("http_error", "wrapped", { cause });
    assert.equal((e as { cause?: unknown }).cause, cause);
  });
});
