/**
 * 同步 HS256 JWT 校验 —— 只用 node:crypto,不依赖 jose/async。
 *
 * **何用**:v3 commercial router 在 dispatch 前需要判断当前请求是否"商业版 user 身份
 * 访问 host scope 的敏感 API"(见 router.ts 的 `BLOCKED_FOR_USER_RULES`)。
 * 该判断点在非 async 同步路径上,而且我们只需要 role + sub + exp 这三个字段,
 * 不需要 jose 完整 claim 校验 —— 直接同步 HMAC 验签 + 简单 payload 校验即可。
 *
 * **与 `verifyAccess`(async)的关系**:二者校验结果**等价**(同一 secret、同一 alg、
 * 同一 TTL,payload 结构一致)。async 版本多了 jose 的 clock skew / header typ 校验,
 * 但这里做 deny-by-default 的拦截,差异不影响安全结论:只要验签通过 + exp 未过期 +
 * role ∈ {user, admin} 就足以判定"这是一个商业版 JWT 当前应视作登录"。
 *
 * **错误策略**:任何问题(空 token / 非 3 段 / alg 不是 HS256 / 验签失败 / 过期 /
 * sub/role 缺失或非法)一律返 null,不抛异常 —— 调用方据此决定 "fall through 到下层"。
 *
 * **timing safe**:用 `timingSafeEqual` 比较 HMAC,length mismatch 先短路 —— 这和
 * gateway/server.ts 原 `verifyCommercialJwt` 行为一致。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface CommercialJwtClaims {
  sub: string;
  role: "user" | "admin";
  exp: number;
}

export function verifyCommercialJwtSync(
  token: string,
  jwtSecret: string | Uint8Array,
): CommercialJwtClaims | null {
  if (!token || !jwtSecret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  } catch {
    return null;
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: unknown }).alg !== "HS256"
  ) {
    return null;
  }
  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  const expectedSig = createHmac("sha256", jwtSecret as Buffer | string)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  if (expectedSig.length !== actualSig.length) return null;
  if (!timingSafeEqual(expectedSig, actualSig)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { sub?: unknown; role?: unknown; exp?: unknown };
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== "number" || p.exp <= now) return null;
  if (typeof p.sub !== "string" || p.sub.length === 0) return null;
  if (p.role !== "user" && p.role !== "admin") return null;
  return { sub: p.sub, role: p.role, exp: p.exp };
}

/**
 * Detailed 版校验 —— 失败时带 reason + parsedClaims,**仅诊断用**(2026-05-17 起,
 * v1.0.158 加入)。
 *
 * 与 `verifyCommercialJwtSync` 的关系:**判断顺序、最终 ok/fail 结论完全等价**。
 * 区别在于 fail 路径不返回 null,而是 `{ ok: false, reason, parsedClaims? }`:
 *   - reason 标识在哪一步失败,便于结构化日志区分根因
 *   - parsedClaims 仅当 payload base64url + JSON.parse 成功后才有(即便后续
 *     exp/sub/role 校验失败也带 —— 这是诊断 token 长啥样的关键)
 *
 * 调用方约束(避免外溢):
 *   - 当前**只**给 `handleMediaSign` 用,目的是把 401 日志做出区分度
 *   - **不要**把这个函数推广到 `router.ts` 的 hot path —— 那条路径是 deny-by-default
 *     拦截,需要 silent null,引入 reason 通道反而增加判断负担
 *   - 公开错误 message 仍按 401 "invalid or expired token",不把 reason 暴露给 client
 */
export type VerifyDetailedResult =
  | { ok: true; claims: CommercialJwtClaims }
  | {
      ok: false;
      reason:
        | "no-token"
        | "shape"
        | "header-parse"
        | "alg"
        | "sig-decode"
        | "sig"
        | "payload-parse"
        | "payload-shape"
        | "expired"
        | "sub-bad"
        | "role-bad";
      /** 只在 payload JSON.parse 成功后才带 —— shape/header-parse/sig 等阶段必然缺席。 */
      parsedClaims?: {
        sub?: unknown;
        role?: unknown;
        exp?: unknown;
        iat?: unknown;
      };
    };

export function verifyCommercialJwtSyncDetailed(
  token: string,
  jwtSecret: string | Uint8Array,
): VerifyDetailedResult {
  if (!token || !jwtSecret) return { ok: false, reason: "no-token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "shape" };
  const [headerB64, payloadB64, sigB64] = parts;
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  } catch {
    return { ok: false, reason: "header-parse" };
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: unknown }).alg !== "HS256"
  ) {
    return { ok: false, reason: "alg" };
  }
  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigB64, "base64url");
  } catch {
    return { ok: false, reason: "sig-decode" };
  }
  const expectedSig = createHmac("sha256", jwtSecret as Buffer | string)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  if (expectedSig.length !== actualSig.length) {
    return { ok: false, reason: "sig" };
  }
  if (!timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: "sig" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return { ok: false, reason: "payload-parse" };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "payload-shape" };
  }
  const p = payload as {
    sub?: unknown;
    role?: unknown;
    exp?: unknown;
    iat?: unknown;
  };
  const parsedClaims = { sub: p.sub, role: p.role, exp: p.exp, iat: p.iat };
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== "number" || p.exp <= now) {
    return { ok: false, reason: "expired", parsedClaims };
  }
  if (typeof p.sub !== "string" || p.sub.length === 0) {
    return { ok: false, reason: "sub-bad", parsedClaims };
  }
  if (p.role !== "user" && p.role !== "admin") {
    return { ok: false, reason: "role-bad", parsedClaims };
  }
  return { ok: true, claims: { sub: p.sub, role: p.role, exp: p.exp } };
}
