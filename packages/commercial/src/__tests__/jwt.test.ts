import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { SignJWT } from "jose";
import {
  signAccess,
  verifyAccess,
  issueRefresh,
  refreshTokenHash,
  JwtError,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_BYTES,
} from "../auth/jwt.js";

const SECRET = randomBytes(64).toString("hex"); // 128 chars,远超 32 字节最低
const ALT_SECRET = randomBytes(64).toString("hex");

describe("auth.jwt.signAccess / verifyAccess", () => {
  test("sign + verify roundtrip with sub/role", async () => {
    const issued = await signAccess({ sub: "42", role: "user" }, SECRET);
    assert.equal(typeof issued.token, "string");
    assert.ok(issued.token.split(".").length === 3, "JWT must have 3 segments");
    const claims = await verifyAccess(issued.token, SECRET);
    assert.equal(claims.sub, "42");
    assert.equal(claims.role, "user");
    assert.equal(claims.exp, issued.exp);
    assert.equal(claims.jti, issued.jti);
  });

  test("default TTL is 15 minutes", async () => {
    const now = 1_700_000_000;
    const issued = await signAccess({ sub: "1", role: "user" }, SECRET, { now });
    assert.equal(issued.exp - now, ACCESS_TOKEN_TTL_SECONDS);
  });

  test("verify fails on wrong secret", async () => {
    const issued = await signAccess({ sub: "1", role: "user" }, SECRET);
    await assert.rejects(verifyAccess(issued.token, ALT_SECRET), JwtError);
  });

  test("verify fails on expired token", async () => {
    const t0 = 1_700_000_000;
    const issued = await signAccess({ sub: "1", role: "user" }, SECRET, { now: t0 });
    // 用注入 now 模拟时钟前进 16min(超过 15min TTL)
    await assert.rejects(
      verifyAccess(issued.token, SECRET, { now: t0 + ACCESS_TOKEN_TTL_SECONDS + 60 }),
      (err: unknown) => err instanceof JwtError && /expired/i.test((err as Error).message),
    );
  });

  test("verify rejects alg:none token (algorithm confusion)", async () => {
    // 直接拼一个 alg:none 的 JWT
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub: "1", role: "user", iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1000, jti: "abc",
    })).toString("base64url");
    const token = `${header}.${payload}.`; // 空签名
    await assert.rejects(verifyAccess(token, SECRET), JwtError);
  });

  test("verify rejects RS256 token even if signed by attacker (algs whitelist)", async () => {
    // 用同一 secret 签一个 RS256-标头的 token —— jose 内部会因为 alg/key 类型不匹配抛
    // 等价于"通过 algorithms 白名单挡住别的算法"
    const fakeAlg = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS512", typ: "JWT" })
      .setSubject("1")
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti("x")
      .sign(new TextEncoder().encode(SECRET));
    await assert.rejects(verifyAccess(fakeAlg, SECRET), JwtError);
  });

  test("verify fails on tampered payload (signature mismatch)", async () => {
    const issued = await signAccess({ sub: "1", role: "user" }, SECRET);
    // 把 role 字段改成 admin —— 签名应失效
    const [h, p, s] = issued.token.split(".");
    const decoded = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    decoded.role = "admin";
    const tamperedP = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const tampered = `${h}.${tamperedP}.${s}`;
    await assert.rejects(verifyAccess(tampered, SECRET), JwtError);
  });

  test("verify fails on missing/invalid role claim", async () => {
    // 手工签一个没有 role 的 token
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("1")
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti("x")
      .sign(new TextEncoder().encode(SECRET));
    await assert.rejects(verifyAccess(token, SECRET), (err: unknown) =>
      err instanceof JwtError && /role/.test((err as Error).message),
    );
  });

  test("sign throws on too-short secret (<32 bytes)", async () => {
    await assert.rejects(signAccess({ sub: "1", role: "user" }, "short"), JwtError);
  });

  test("verify throws JwtError on empty token (no leak)", async () => {
    await assert.rejects(verifyAccess("", SECRET), JwtError);
  });

  test("each sign produces a unique jti", async () => {
    const a = await signAccess({ sub: "1", role: "user" }, SECRET);
    const b = await signAccess({ sub: "1", role: "user" }, SECRET);
    assert.notEqual(a.jti, b.jti);
  });
});

describe("auth.jwt.issueRefresh / refreshTokenHash", () => {
  test("issue returns 32-byte raw (base64url) + hash + expires_at", () => {
    const r = issueRefresh();
    // base64url 32 bytes → 43 chars (no padding)
    assert.equal(r.token.length, 43);
    assert.equal(r.hash.length, 64); // sha256 hex
    assert.ok(r.expires_at > Math.floor(Date.now() / 1000));
  });

  test("default refresh TTL = 30 days", () => {
    const now = 1_700_000_000;
    const r = issueRefresh({ now });
    assert.equal(r.expires_at - now, REFRESH_TOKEN_TTL_SECONDS);
  });

  test("hash is deterministic for the same raw token", () => {
    const r = issueRefresh();
    const recomputed = refreshTokenHash(r.token);
    assert.equal(recomputed, r.hash);
  });

  test("two refresh tokens are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(issueRefresh().token);
    assert.equal(seen.size, 1000);
  });

  test("refreshTokenHash throws on empty input", () => {
    assert.throws(() => refreshTokenHash(""), JwtError);
  });

  test("REFRESH_TOKEN_BYTES is 32 (sanity)", () => {
    assert.equal(REFRESH_TOKEN_BYTES, 32);
  });

  test("hash matches sha256 of raw bytes (not of base64 string!)", () => {
    const r = issueRefresh();
    const rawBytes = Buffer.from(r.token, "base64url");
    const expected = createHash("sha256").update(rawBytes).digest("hex");
    assert.equal(r.hash, expected);
    // 反例:如果实现错把 base64 字符串 sha256,会和这个不同
    const wrong = createHash("sha256").update(r.token).digest("hex");
    assert.notEqual(r.hash, wrong);
  });
});
