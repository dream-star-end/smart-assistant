/**
 * literatureConfig — admin/CRUD 归一化 + token mask 单测。
 *
 * 不碰 DB。覆盖契约:
 *   - maskToken:null/空 → null;长度≥4 → "****" + last4
 *   - normalizeBaseUrl:必须 http(s)://;trim;不留 trailing slash;非法抛 RangeError
 *   - normalizeTokenValue:8..256 可见 ASCII;非法抛 RangeError
 *   - normalizeIntInRange:整数 + 范围;非法抛 RangeError
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  maskToken,
  normalizeBaseUrl,
  normalizeTokenValue,
  normalizeIntInRange,
} from "../admin/literatureConfig.js";

describe("maskToken", () => {
  test("null → null", () => {
    assert.equal(maskToken(null), null);
  });

  test("空字符串 → null", () => {
    assert.equal(maskToken(""), null);
  });

  test("长度 ≥ 4 → '****' + last4", () => {
    assert.equal(maskToken("abcd1234"), "****1234");
    assert.equal(maskToken("a-very-long-token-xyz"), "****-xyz");
  });

  test("长度 < 4 → '****'(不泄露任何片段)", () => {
    assert.equal(maskToken("abc"), "****");
    assert.equal(maskToken("x"), "****");
  });
});

describe("normalizeBaseUrl", () => {
  test("http/https URL 通过,trailing slash 去掉", () => {
    assert.equal(normalizeBaseUrl("https://data.rag.ac.cn"), "https://data.rag.ac.cn");
    assert.equal(normalizeBaseUrl("https://data.rag.ac.cn/"), "https://data.rag.ac.cn");
    assert.equal(normalizeBaseUrl("http://localhost:8080"), "http://localhost:8080");
    assert.equal(normalizeBaseUrl("  https://x.com/  "), "https://x.com");
  });

  test("非 http(s) 抛 RangeError", () => {
    for (const bad of ["ftp://x.com", "file:///etc/passwd", "javascript:alert(1)", ""]) {
      assert.throws(
        () => normalizeBaseUrl(bad),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_base_url",
        `bad: ${bad}`,
      );
    }
  });

  test("非 string 抛 RangeError", () => {
    for (const bad of [null, undefined, 42, true, {}]) {
      assert.throws(
        () => normalizeBaseUrl(bad as unknown),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_base_url",
      );
    }
  });

  test("含空白(中间)拒绝", () => {
    assert.throws(
      () => normalizeBaseUrl("https://x .com"),
      (err: unknown) => err instanceof RangeError,
    );
  });

  test("纯 origin: 非空 path 拒绝", () => {
    // proxy 自己拼 /arxiv/?...,base 带任何 path 都会被静默二次拼接,易出 bug
    for (const bad of [
      "https://x.com/extra",
      "https://x.com/api/v1",
      "https://x.com/arxiv/",
      "https://x.com/a/",
    ]) {
      assert.throws(
        () => normalizeBaseUrl(bad),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_base_url",
        `bad: ${bad}`,
      );
    }
  });

  test("纯 origin: query/hash 拒绝", () => {
    for (const bad of ["https://x.com/?a=1", "https://x.com/#frag", "https://x.com?a=1"]) {
      assert.throws(
        () => normalizeBaseUrl(bad),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_base_url",
        `bad: ${bad}`,
      );
    }
  });

  test("纯 origin: userinfo 拒绝", () => {
    // 凭据绝不能塞 base_url,会污染日志/header 拼接
    for (const bad of ["https://user@x.com", "https://user:pass@x.com", "https://u:p@x.com/"]) {
      assert.throws(
        () => normalizeBaseUrl(bad),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_base_url",
        `bad: ${bad}`,
      );
    }
  });

  test("带 port 的 origin 通过", () => {
    assert.equal(normalizeBaseUrl("https://x.com:8443"), "https://x.com:8443");
    assert.equal(normalizeBaseUrl("https://x.com:8443/"), "https://x.com:8443");
  });
});

describe("normalizeTokenValue", () => {
  test("8..256 可见 ASCII 通过,trim", () => {
    assert.equal(normalizeTokenValue("abcd1234"), "abcd1234");
    assert.equal(normalizeTokenValue("  sk-foo-bar-baz_123  "), "sk-foo-bar-baz_123");
    assert.equal(normalizeTokenValue("A".repeat(256)), "A".repeat(256));
  });

  test("< 8 字符拒绝", () => {
    assert.throws(
      () => normalizeTokenValue("abc"),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_token",
    );
  });

  test("> 256 字符拒绝", () => {
    assert.throws(
      () => normalizeTokenValue("A".repeat(257)),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_token",
    );
  });

  test("包含空白 / 控制字符拒绝", () => {
    for (const bad of ["abcd 1234", "abcd\t1234", "abcd\n1234", "abcd\x00xyz"]) {
      assert.throws(
        () => normalizeTokenValue(bad),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_token",
        `bad: ${JSON.stringify(bad)}`,
      );
    }
  });

  test("非 string 拒绝", () => {
    for (const bad of [null, undefined, 42, true, {}]) {
      assert.throws(
        () => normalizeTokenValue(bad as unknown),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_token",
      );
    }
  });
});

describe("normalizeIntInRange", () => {
  test("范围内整数通过", () => {
    assert.equal(normalizeIntInRange(10, 1, 100, "x"), 10);
    assert.equal(normalizeIntInRange(1, 1, 100, "x"), 1);
    assert.equal(normalizeIntInRange(100, 1, 100, "x"), 100);
  });

  test("越界拒绝", () => {
    assert.throws(
      () => normalizeIntInRange(0, 1, 100, "invalid_x"),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_x",
    );
    assert.throws(
      () => normalizeIntInRange(101, 1, 100, "invalid_x"),
      (err: unknown) => err instanceof RangeError && err.message === "invalid_x",
    );
  });

  test("非整数拒绝", () => {
    for (const bad of [3.14, NaN, Infinity, "10", null, undefined]) {
      assert.throws(
        () => normalizeIntInRange(bad as unknown as number, 1, 100, "invalid_x"),
        (err: unknown) => err instanceof RangeError && err.message === "invalid_x",
      );
    }
  });
});
