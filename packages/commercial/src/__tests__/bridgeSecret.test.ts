import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { computeInboundNonce } from "../bridgeSecret.js";

/**
 * Tests for `computeInboundNonce` —— WeChat broker inbound 通道 nonce 派生(D3d 方案 B')。
 *
 * 关键不变量(若被违反代码合不进去):
 *   1. 输出形态:base64url 43 chars (HMAC-SHA256 = 32B,无 padding)
 *   2. domain separation:HMAC(s, "inbound:"+id) ≠ HMAC(s, id) —— 与 file-proxy 输出空间正交
 *   3. number / string 同 id 输出一致(supervisor 传 row.id 是 number,broker 端可能 String() 化)
 *   4. 不同 secret 输出截然不同(基本 HMAC 性质)
 *   5. 不同 id 输出截然不同
 */
describe("bridgeSecret.computeInboundNonce", () => {
  const secret = "a".repeat(64); // 64 hex chars,模拟 bridgeSecret 实际格式

  test("outputs base64url 32B (43 chars, no padding)", () => {
    const n = computeInboundNonce(secret, 42);
    assert.equal(n.length, 43, "base64url of 32 bytes = 43 chars (no '=' padding)");
    assert.match(n, /^[A-Za-z0-9_-]+$/, "base64url alphabet only");
    assert.ok(!n.includes("="), "no padding");
    assert.ok(!n.includes("+") && !n.includes("/"), "must be base64url, not standard base64");
  });

  test("deterministic: same (secret, id) → same nonce", () => {
    const a = computeInboundNonce(secret, 7);
    const b = computeInboundNonce(secret, 7);
    assert.equal(a, b);
  });

  test("number id and string id with same value produce same nonce", () => {
    // supervisor 传 row.id 是 number;broker 端反过来构造 header 时可能拿到 string id。
    // helper 必须 String() 归一化,否则会两边算出不同 nonce 互相 401。
    const fromNumber = computeInboundNonce(secret, 12345);
    const fromString = computeInboundNonce(secret, "12345");
    assert.equal(fromNumber, fromString);
  });

  test("domain separation: HMAC(s, 'inbound:'+id) ≠ HMAC(s, id) (file-proxy nonce)", () => {
    // 这是 D3d 核心安全断言:同一把 bridgeSecret 派生出来的 file-proxy nonce 和 inbound nonce
    // 必须不重叠(攻击者拿到一个不能当另一个用)。
    const inboundNonce = computeInboundNonce(secret, 99);
    const fileProxyNonceHex = createHmac("sha256", secret).update("99").digest("hex");
    // 两边编码不同(base64url vs hex)且输入域不同(带前缀 vs 不带),不可能撞。
    // 把 inbound 解出 raw bytes 再 hex,直接比对 raw 字节值。
    const inboundRawHex = Buffer.from(inboundNonce, "base64url").toString("hex");
    assert.notEqual(inboundRawHex, fileProxyNonceHex);
  });

  test("different secrets produce different nonces for same id", () => {
    const a = computeInboundNonce("a".repeat(64), 1);
    const b = computeInboundNonce("b".repeat(64), 1);
    assert.notEqual(a, b);
  });

  test("different ids produce different nonces for same secret", () => {
    const a = computeInboundNonce(secret, 1);
    const b = computeInboundNonce(secret, 2);
    assert.notEqual(a, b);
  });

  test("known vector: HMAC-SHA256 with explicit 'inbound:' prefix", () => {
    // 锁死字节级行为:任何人改 update() 内容(去掉前缀 / 改大小写 / 改分隔符)都会 fail。
    const expected = createHmac("sha256", secret).update("inbound:777").digest("base64url");
    assert.equal(computeInboundNonce(secret, 777), expected);
  });

  test("id=0 is handled (no falsy short-circuit bug)", () => {
    const n = computeInboundNonce(secret, 0);
    assert.equal(n.length, 43);
    assert.equal(n, computeInboundNonce(secret, "0"));
  });
});
