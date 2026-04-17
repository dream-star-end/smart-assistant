import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../auth/passwords.js";

describe("auth.passwords", () => {
  test("hashPassword returns a PHC argon2id string", async () => {
    const h = await hashPassword("hunter2-correct");
    assert.match(h, /^\$argon2id\$/);
    // PHC 包含 m=,t=,p= 三个参数段
    assert.match(h, /m=65536/);
    assert.match(h, /t=3/);
    assert.match(h, /p=1/);
  });

  test("verifyPassword: roundtrip success", async () => {
    const h = await hashPassword("right-password");
    assert.equal(await verifyPassword("right-password", h), true);
  });

  test("verifyPassword: wrong password returns false", async () => {
    const h = await hashPassword("right-password");
    assert.equal(await verifyPassword("wrong-password", h), false);
  });

  test("verifyPassword: empty password returns false", async () => {
    const h = await hashPassword("real");
    assert.equal(await verifyPassword("", h), false);
  });

  test("verifyPassword: malformed hash returns false (no throw)", async () => {
    assert.equal(await verifyPassword("anything", "not-a-hash"), false);
    assert.equal(await verifyPassword("anything", ""), false);
    assert.equal(await verifyPassword("anything", "$bcrypt$wrong"), false);
  });

  test("hashPassword: same input twice gives different hash (random salt)", async () => {
    const a = await hashPassword("identical");
    const b = await hashPassword("identical");
    assert.notEqual(a, b, "salts must differ");
    // 但都能 verify
    assert.equal(await verifyPassword("identical", a), true);
    assert.equal(await verifyPassword("identical", b), true);
  });

  test("hashPassword rejects non-string", async () => {
    // @ts-expect-error - 故意传错类型测试 runtime guard
    await assert.rejects(hashPassword(12345), TypeError);
  });

  test("verifyPassword tolerates non-string args without throwing", async () => {
    // @ts-expect-error
    assert.equal(await verifyPassword(null, "h"), false);
    // @ts-expect-error
    assert.equal(await verifyPassword("p", null), false);
  });

  test("hashPassword handles very long passwords (avoid silent truncation)", async () => {
    const long = "a".repeat(2048);
    const h = await hashPassword(long);
    assert.equal(await verifyPassword(long, h), true);
    // 改一个字符就应该 fail —— 证明不是截断匹配
    const altered = `${long.slice(0, -1)}b`;
    assert.equal(await verifyPassword(altered, h), false);
  });
});
