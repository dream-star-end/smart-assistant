/**
 * T-24 — orders 模块单元测试(不触 DB,只测纯函数)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateOrderNo } from "../payment/orders.js";
import { extractOrderNoFromUrl } from "../http/payment.js";

describe("generateOrderNo", () => {
  test("格式 YYYYMMDD-<8hex>,日期跟注入时钟", () => {
    const fixed = new Date(Date.UTC(2026, 3, 17, 12, 0, 0)); // 2026-04-17
    const no = generateOrderNo(() => fixed);
    assert.match(no, /^20260417-[0-9a-f]{8}$/);
  });

  test("连续生成不同 —— 碰撞概率极低", () => {
    const s = new Set<string>();
    for (let i = 0; i < 1000; i += 1) s.add(generateOrderNo());
    assert.equal(s.size, 1000);
  });
});

describe("extractOrderNoFromUrl", () => {
  test("正常抽取", () => {
    assert.equal(
      extractOrderNoFromUrl("/api/payment/orders/20260417-abc12345"),
      "20260417-abc12345",
    );
  });
  test("带 query 也能抽", () => {
    assert.equal(
      extractOrderNoFromUrl("/api/payment/orders/ORDER.1?foo=bar"),
      "ORDER.1",
    );
  });
  test("路径不对 → null", () => {
    assert.equal(extractOrderNoFromUrl("/api/payment/plans"), null);
    assert.equal(extractOrderNoFromUrl("/api/payment/orders/"), null);
    assert.equal(extractOrderNoFromUrl("/api/payment/orders/a/b"), null);
  });
  test("非法字符 → null", () => {
    // 拒绝 slash / 空格 / 中文 / 反斜杠 等
    assert.equal(extractOrderNoFromUrl("/api/payment/orders/ab%20cd"), null);
    assert.equal(extractOrderNoFromUrl("/api/payment/orders/中文"), null);
  });
  test("超长 → null", () => {
    const seg = "a".repeat(65);
    assert.equal(extractOrderNoFromUrl(`/api/payment/orders/${seg}`), null);
  });
});
