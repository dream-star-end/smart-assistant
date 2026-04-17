/**
 * T-24 — 虎皮椒签名单元测试。
 *
 * 覆盖:
 *   - 已知 payload + secret → 与独立 md5 计算一致(同态校验,确保字典序 + 跳空 + 跳 hash 逻辑正确)
 *   - 跳过 hash / 空值 / undefined / null / NaN
 *   - bigint / number / boolean 归一化
 *   - verifyHupijiao: 正确签名 → true;篡改字段 → false;篡改 hash → false;
 *     缺 hash / 长度不对 / 大小写 hash → 仍可匹配(小写归一)
 *   - 签错 secret → false,constant time 不抛
 *   - buildSignBase 可观察中间字符串 —— 独立断言字典序
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { signHupijiao, verifyHupijiao, buildSignBase } from "../payment/hupijiao/sign.js";

const SECRET = "TEST_SECRET_abc";

function md5Hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

describe("buildSignBase", () => {
  test("按 key 字典序 + 跳 hash + 跳空值", () => {
    const params = {
      version: "1.1",
      appid: "A",
      trade_order_id: "T1",
      empty: "",
      nullish: null,
      und: undefined,
      hash: "WILL_BE_IGNORED",
      z: "last",
      a_z: "alpha",
    };
    const base = buildSignBase(params);
    // 期待:a_z=alpha&appid=A&trade_order_id=T1&version=1.1&z=last
    assert.equal(base, "a_z=alpha&appid=A&trade_order_id=T1&version=1.1&z=last");
  });

  test("bigint/number/boolean → 字符串化", () => {
    const base = buildSignBase({
      b: true, n: 42, bi: 100n, f: false,
    });
    assert.equal(base, "b=true&bi=100&f=false&n=42");
  });

  test("NaN/Infinity 视作空值", () => {
    const base = buildSignBase({ a: "x", b: Number.NaN, c: Number.POSITIVE_INFINITY });
    assert.equal(base, "a=x");
  });
});

describe("signHupijiao", () => {
  test("与独立 md5(base + & + secret) 一致", () => {
    const params = {
      version: "1.1",
      appid: "APP_1",
      trade_order_id: "20260417-xyz",
      total_fee: "10.00",
      nonce_str: "nonce",
      time: "1800000000",
    };
    const expectedBase = "appid=APP_1&nonce_str=nonce&time=1800000000&total_fee=10.00&trade_order_id=20260417-xyz&version=1.1";
    const expected = md5Hex(`${expectedBase}&${SECRET}`);
    assert.equal(signHupijiao(params, SECRET), expected);
    assert.equal(signHupijiao(params, SECRET).length, 32);
    assert.match(signHupijiao(params, SECRET), /^[0-9a-f]{32}$/);
  });

  test("不同字段顺序 → 同一签名(证明 sort 生效)", () => {
    const a = signHupijiao({ b: "2", a: "1", c: "3" }, SECRET);
    const b = signHupijiao({ c: "3", b: "2", a: "1" }, SECRET);
    assert.equal(a, b);
  });

  test("空 secret 拒绝", () => {
    assert.throws(() => signHupijiao({ a: "1" }, ""), TypeError);
  });

  test("hash 字段存在不影响结果(自动跳过)", () => {
    const a = signHupijiao({ x: "1", hash: "any" }, SECRET);
    const b = signHupijiao({ x: "1" }, SECRET);
    assert.equal(a, b);
  });
});

describe("verifyHupijiao", () => {
  test("正确签名 → true", () => {
    const p = { a: "1", b: "2", c: "3" };
    const h = signHupijiao(p, SECRET);
    assert.equal(verifyHupijiao({ ...p, hash: h }, SECRET), true);
  });

  test("篡改字段 → false", () => {
    const p = { a: "1", b: "2" };
    const h = signHupijiao(p, SECRET);
    assert.equal(verifyHupijiao({ a: "1", b: "TAMPERED", hash: h }, SECRET), false);
  });

  test("篡改 hash → false", () => {
    const p = { a: "1" };
    const h = signHupijiao(p, SECRET);
    // 翻转第一位
    const flipped = (h[0] === "0" ? "1" : "0") + h.slice(1);
    assert.equal(verifyHupijiao({ ...p, hash: flipped }, SECRET), false);
  });

  test("缺 hash → false", () => {
    assert.equal(verifyHupijiao({ a: "1" }, SECRET), false);
  });

  test("hash 长度错 → false,不抛", () => {
    assert.equal(verifyHupijiao({ a: "1", hash: "abc" }, SECRET), false);
    assert.equal(verifyHupijiao({ a: "1", hash: "z".repeat(32) }, SECRET), false); // 非 hex
  });

  test("hash 大写 vs 小写都 OK(归一比较)", () => {
    const p = { a: "1", foo: "bar" };
    const h = signHupijiao(p, SECRET);
    assert.equal(verifyHupijiao({ ...p, hash: h.toUpperCase() }, SECRET), true);
    assert.equal(verifyHupijiao({ ...p, hash: h.toLowerCase() }, SECRET), true);
  });

  test("错 secret → false", () => {
    const p = { a: "1" };
    const h = signHupijiao(p, SECRET);
    assert.equal(verifyHupijiao({ ...p, hash: h }, "WRONG_SECRET"), false);
  });
});
