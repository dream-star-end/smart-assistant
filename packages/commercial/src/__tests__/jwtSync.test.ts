// v1.0.158 诊断埋点配套:覆盖 `verifyCommercialJwtSyncDetailed` 的主要失败 reason
// 分支,并用等价性锁保证它与原 `verifyCommercialJwtSync` 的 ok/fail 结论一致。
//
// 等价性是关键不变式:detailed 版在 handleMediaSign 替代了 silent null 版,如果
// 二者在某条 token 上结论不同,401 行为就会偏离原语义。
//
// 注:`sig-decode` 在当前 Node `Buffer.from(..., "base64url")` 实现下属死分支
// (任意字符串都不抛),不单独测;保留 reason 仅是 schema 完整性。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import {
  verifyCommercialJwtSync,
  verifyCommercialJwtSyncDetailed,
  type VerifyDetailedResult,
} from "../auth/jwtSync.js";

const SECRET = randomBytes(64).toString("hex");
const ALT_SECRET = randomBytes(64).toString("hex");
const KEY = new TextEncoder().encode(SECRET);

async function signToken(opts: {
  sub?: unknown;
  role?: unknown;
  exp?: number;
  iat?: number;
  alg?: string;
}): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const exp = opts.exp ?? iat + 900;
  // jose 不允许直接把非法 role/sub 塞进类型化 setters,改用 protected header + payload obj
  const payload: Record<string, unknown> = {
    sub: opts.sub ?? "42",
    role: opts.role ?? "user",
    iat,
    exp,
  };
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: (opts.alg ?? "HS256") as "HS256" })
    .sign(KEY);
}

function expectFail(r: VerifyDetailedResult): Extract<VerifyDetailedResult, { ok: false }> {
  assert.equal(r.ok, false, `expected fail, got ${JSON.stringify(r)}`);
  return r as Extract<VerifyDetailedResult, { ok: false }>;
}

describe("verifyCommercialJwtSyncDetailed", () => {
  test("ok roundtrip — same secret + valid claims", async () => {
    const tok = await signToken({ sub: "42", role: "user" });
    const r = verifyCommercialJwtSyncDetailed(tok, SECRET);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.claims.sub, "42");
      assert.equal(r.claims.role, "user");
      assert.equal(typeof r.claims.exp, "number");
    }
  });

  test("no-token: empty / falsy", () => {
    assert.equal(expectFail(verifyCommercialJwtSyncDetailed("", SECRET)).reason, "no-token");
    assert.equal(
      expectFail(verifyCommercialJwtSyncDetailed("anything", "")).reason,
      "no-token",
    );
  });

  test("shape: not 3-segment", () => {
    assert.equal(
      expectFail(verifyCommercialJwtSyncDetailed("a.b", SECRET)).reason,
      "shape",
    );
    assert.equal(
      expectFail(verifyCommercialJwtSyncDetailed("aaa", SECRET)).reason,
      "shape",
    );
  });

  test("header-parse: header b64 is not JSON", () => {
    // header = base64url("not-json"),其余两段任意
    const headerB64 = Buffer.from("not-json").toString("base64url");
    const tok = `${headerB64}.${Buffer.from("{}").toString("base64url")}.sig`;
    assert.equal(
      expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET)).reason,
      "header-parse",
    );
  });

  test("alg: header alg != HS256", async () => {
    // 手工拼一个 alg=HS512 header,payload + sig 任意(走不到 sig 阶段)
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString(
      "base64url",
    );
    const payloadB64 = Buffer.from(JSON.stringify({ sub: "1" })).toString("base64url");
    const tok = `${headerB64}.${payloadB64}.sig`;
    assert.equal(
      expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET)).reason,
      "alg",
    );
  });

  test("sig: wrong secret → signature mismatch", async () => {
    const tok = await signToken({ sub: "1", role: "user" });
    const r = expectFail(verifyCommercialJwtSyncDetailed(tok, ALT_SECRET));
    assert.equal(r.reason, "sig");
    // sig 阶段必然无 parsedClaims
    assert.equal(r.parsedClaims, undefined);
  });

  test("payload-shape: signature 校验过,但 payload 是 JSON primitive(非 object)", () => {
    // header HS256 + payload=`123` (合法 JSON 但 typeof !== 'object') + 正确签名
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    );
    const payloadB64 = Buffer.from("123").toString("base64url");
    const sig = createHmac("sha256", SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const tok = `${headerB64}.${payloadB64}.${sig}`;
    const r = expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET));
    assert.equal(r.reason, "payload-shape");
    // payload-shape 阶段不携带 parsedClaims —— payload 非 object,没有 sub/role/exp 可读
    assert.equal(r.parsedClaims, undefined);
  });

  test("payload-parse: signature 校验过但 payload 不是 JSON", () => {
    // header HS256 + 非法 payload + 重新签名 → sig 校验通过,payload 解析失败
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    );
    const payloadB64 = Buffer.from("not-json").toString("base64url");
    const sig = createHmac("sha256", SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const tok = `${headerB64}.${payloadB64}.${sig}`;
    assert.equal(
      expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET)).reason,
      "payload-parse",
    );
  });

  test("expired: token 已过 exp", async () => {
    const tok = await signToken({ sub: "1", role: "user", exp: 1 });
    const r = expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET));
    assert.equal(r.reason, "expired");
    // expired 阶段必带 parsedClaims —— 诊断时间漂移需要
    assert.ok(r.parsedClaims);
    assert.equal(r.parsedClaims!.exp, 1);
    assert.equal(r.parsedClaims!.sub, "1");
  });

  test("sub-bad: sub 是空字符串 / 非 string", async () => {
    const tok = await signToken({ sub: "", role: "user" });
    const r = expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET));
    assert.equal(r.reason, "sub-bad");
    assert.ok(r.parsedClaims);
  });

  test("role-bad: role ∉ {user, admin}", async () => {
    const tok = await signToken({ sub: "1", role: "ghost" });
    const r = expectFail(verifyCommercialJwtSyncDetailed(tok, SECRET));
    assert.equal(r.reason, "role-bad");
    assert.ok(r.parsedClaims);
    assert.equal(r.parsedClaims!.role, "ghost");
  });

  test("等价性:detailed.ok 与 sync 返回非 null 必须同步", async () => {
    const samples: Array<{ build: () => Promise<string> | string; secret: string }> = [
      { build: () => signToken({ sub: "1", role: "user" }), secret: SECRET },
      { build: () => signToken({ sub: "1", role: "admin" }), secret: SECRET },
      { build: () => signToken({ sub: "1", role: "user" }), secret: ALT_SECRET },
      { build: () => signToken({ sub: "1", role: "user", exp: 1 }), secret: SECRET },
      { build: () => signToken({ sub: "", role: "user" }), secret: SECRET },
      { build: () => signToken({ sub: "1", role: "ghost" }), secret: SECRET },
      { build: () => "", secret: SECRET },
      { build: () => "not-three-segs", secret: SECRET },
    ];
    for (const s of samples) {
      const tok = await Promise.resolve(s.build());
      const detailed = verifyCommercialJwtSyncDetailed(tok, s.secret);
      const sync = verifyCommercialJwtSync(tok, s.secret);
      assert.equal(
        detailed.ok,
        sync !== null,
        `divergence on sample: detailed=${JSON.stringify(detailed)} sync=${sync === null ? "null" : "claims"}`,
      );
    }
  });
});
