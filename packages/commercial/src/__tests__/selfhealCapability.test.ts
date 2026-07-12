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
  test("签发→校验闭环,回带 attempt+jti + exp=now+90min(M2:4 段 token)", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 3, now);
    assert.equal(cap.exp, now + CAPABILITY_TTL_MS);
    assert.equal(cap.token.split(".").length, 4, "token = attempt.exp.jti.sig");
    assert.match(cap.jti, /^[0-9a-f]{32}$/, "jti = 16B hex");
    const v = verifyCapability(cap.token, "42", now + 1000);
    assert.equal(v.ok, true);
    assert.equal(v.attempt, 3);
    assert.equal(v.jti, cap.jti, "verify 回带 token 内 jti(端点消费防重放)");
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

  test("结构非法:段数不对 / 非 hex jti / 非 hex sig → malformed", () => {
    assert.equal(verifyCapability("garbage", "42").reason, "malformed");
    assert.equal(verifyCapability("1.2", "42").reason, "malformed");
    assert.equal(verifyCapability("1.2.3", "42").reason, "malformed"); // 旧 3 段格式不再接受
    assert.equal(
      verifyCapability(`1.99999999999999.NOTHEX.${"0".repeat(64)}`, "42").reason,
      "malformed",
    );
    assert.equal(
      verifyCapability(`1.99999999999999.${"a".repeat(32)}.nothex`, "42").reason,
      "malformed",
    );
  });

  test("篡改 attempt 字段 → sig 不符(bad_sig)", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const [, exp, jti, sig] = cap.token.split(".");
    const tampered = `9.${exp}.${jti}.${sig}`;
    const v = verifyCapability(tampered, "42", now + 1000);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad_sig");
  });

  test("篡改 jti(换成另一个合法形状 hex)→ sig 不符(bad_sig)——jti 被签名保护", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const [attempt, exp, jti, sig] = cap.token.split(".");
    const otherJti = jti.startsWith("a") ? "b" + jti.slice(1) : "a" + jti.slice(1);
    const v = verifyCapability(`${attempt}.${exp}.${otherJti}.${sig}`, "42", now + 1000);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad_sig");
  });

  test("篡改 sig 一位 → bad_sig", () => {
    const now = 1_000_000_000_000;
    const cap = issueCapability("42", 1, now);
    const [attempt, exp, jti, sig] = cap.token.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    const v = verifyCapability(`${attempt}.${exp}.${jti}.${flipped}`, "42", now + 1000);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad_sig");
  });

  test("同参数两次签发 jti 各不相同(随机),两个 token 均可独立验过", () => {
    const now = 1_000_000_000_000;
    const a = issueCapability("42", 1, now);
    const b = issueCapability("42", 1, now);
    assert.notEqual(a.jti, b.jti);
    assert.equal(verifyCapability(a.token, "42", now).ok, true);
    assert.equal(verifyCapability(b.token, "42", now).ok, true);
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
