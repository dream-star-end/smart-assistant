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
