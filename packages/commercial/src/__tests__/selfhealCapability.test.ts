/**
 * v5 自愈体系切片②ⓐ — 逐 repair capability 纯单元(无 DB/HTTP)。
 *
 * 验:签发→校验闭环 / 绑 repairId(换 id 必败)/ 过期 / 结构非法 / 篡改 attempt|sig 必败。
 */

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { issueCapability, verifyCapability, CAPABILITY_TTL_MS } from "../selfheal/capability.js";

before(() => {
  process.env.OC_SELFHEAL_MASTER_SECRET = "test-master-secret-0123456789abcdef";
});

describe("selfheal capability", () => {
  test("签发→校验闭环,回带 attempt + exp=now+90min", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 3, now);
    assert.equal(cap.exp, now + CAPABILITY_TTL_MS);
    const v = verifyCapability(cap.token, "42", now + 1000);
    assert.equal(v.ok, true);
    assert.equal(v.attempt, 3);
  });

  test("绑 repairId:换一个 repairId 校验必败(sig 载荷含 repairId)", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const v = verifyCapability(cap.token, "43", now + 1000);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad_sig");
  });

  test("过期:now >= exp → expired", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const v = verifyCapability(cap.token, "42", now + CAPABILITY_TTL_MS + 1);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "expired");
  });

  test("结构非法:段数不对 / 非 hex sig → malformed", () => {
    assert.equal(verifyCapability("garbage", "42").reason, "malformed");
    assert.equal(verifyCapability("1.2", "42").reason, "malformed");
    assert.equal(verifyCapability("1.99999999999999.nothex", "42").reason, "malformed");
  });

  test("篡改 attempt 字段 → sig 不符(bad_sig)", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const [, exp, sig] = cap.token.split(".");
    const tampered = `9.${exp}.${sig}`;
    const v = verifyCapability(tampered, "42", now + 1000);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad_sig");
  });

  test("篡改 sig 一位 → bad_sig", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const [attempt, exp, sig] = cap.token.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    const v = verifyCapability(`${attempt}.${exp}.${flipped}`, "42", now + 1000);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad_sig");
  });

  test("不同 attempt 各自签发,校验回带对应 attempt", () => {
    const now = 1_000_000_000_000;
    for (const a of [1, 2, 7]) {
      const cap = issueCapability("100", a, now);
      const v = verifyCapability(cap.token, "100", now);
      assert.equal(v.ok, true);
      assert.equal(v.attempt, a);
    }
  });
});
