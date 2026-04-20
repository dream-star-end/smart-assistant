/**
 * T-11 — JWT 签发与校验。
 *
 * 规约(见 05-SEC §2):
 *   - access_token: HS256 JWT,TTL 15min
 *   - payload: { sub: user_id, role, iat, exp, jti }
 *   - refresh_token: opaque random 32 bytes,base64url;**服务端 sha256 存库**
 *   - JWT_SECRET 必须从 env 注入,长度 ≥ 32 bytes(HMAC 标准建议)
 *   - 拒绝 alg:none(jose 默认 verifyJWT 强制 alg 白名单,我们再加一道断言)
 *
 * 不在本文件里:
 *   - refresh token 的 DB 操作(查 refresh_tokens 表 / revoke)
 *   - rate limit / IP 绑定告警
 *   两者放到 T-14 登录路由那边
 */

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { createHash, randomBytes } from "node:crypto";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15min
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 day
export const REFRESH_TOKEN_BYTES = 32;

/** access token 的算法白名单。HS256 单机够用;未来切 RS256/EdDSA 在此处加入。 */
const ALLOWED_ALGS = ["HS256"] as const;
type Alg = (typeof ALLOWED_ALGS)[number];
const DEFAULT_ALG: Alg = "HS256";

/** access payload claims。`sub` 一律为字符串(JWT spec)。 */
export interface AccessPayload {
  sub: string; // user_id 字符串(BIGINT 序列化)
  role: "user" | "admin";
}

export interface AccessClaims extends AccessPayload {
  iat: number;
  exp: number;
  jti: string;
}

export interface AccessIssueResult {
  token: string;
  exp: number; // unix seconds
  jti: string;
}

export interface RefreshIssueResult {
  /** 给客户端的 raw token(base64url),只此一次出现,后续比对走 hash */
  token: string;
  /** sha256(token) 的 hex,存到 refresh_tokens.token_hash */
  hash: string;
  /** unix seconds */
  expires_at: number;
}

export class JwtError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JwtError";
  }
}

export function secretToKey(secret: string | Uint8Array): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.length < 32) {
      throw new JwtError("JWT secret must be at least 32 bytes for HS256");
    }
    return secret;
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new JwtError("JWT secret is missing");
  }
  // 字符串 secret 按 UTF-8 编码进 HMAC,长度按字节算
  const buf = new TextEncoder().encode(secret);
  if (buf.length < 32) {
    throw new JwtError("JWT secret must be at least 32 bytes for HS256");
  }
  return buf;
}

/**
 * 签发 access token。
 *
 * @param payload 业务 payload(sub, role)
 * @param secret HMAC 密钥(env 里读)
 * @param now 可选注入(测试用)— 默认 Date.now() / 1000
 */
export async function signAccess(
  payload: AccessPayload,
  secret: string | Uint8Array,
  options: { ttlSeconds?: number; now?: number } = {},
): Promise<AccessIssueResult> {
  const key = secretToKey(secret);
  const ttl = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const iat = options.now ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const jti = randomBytes(16).toString("hex");

  const token = await new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: DEFAULT_ALG, typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);

  return { token, exp, jti };
}

/**
 * 校验 access token,返回 claims 或抛 JwtError。
 *
 * 强制:
 *   - algorithms 白名单(防 alg:none / 算法混淆)
 *   - 内置过期校验(jose 自动)
 *   - sub 必须是非空字符串
 */
export async function verifyAccess(
  token: string,
  secret: string | Uint8Array,
  options: { now?: number } = {},
): Promise<AccessClaims> {
  if (typeof token !== "string" || token.length === 0) {
    throw new JwtError("token is empty");
  }
  const key = secretToKey(secret);
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: [...ALLOWED_ALGS],
      currentDate: options.now !== undefined ? new Date(options.now * 1000) : undefined,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    // 区分 expired / 其他校验失败,但都包成 JwtError 不暴露内部细节
    if (err instanceof joseErrors.JWTExpired) {
      throw new JwtError("token expired", { cause: err });
    }
    if (err instanceof joseErrors.JOSEAlgNotAllowed) {
      throw new JwtError("algorithm not allowed", { cause: err });
    }
    throw new JwtError("token verification failed", { cause: err });
  }

  // 二次断言关键字段(jose 已校 exp,但 sub/role 是业务字段)
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new JwtError("token missing sub claim");
  }
  if (payload.role !== "user" && payload.role !== "admin") {
    throw new JwtError("token has invalid role claim");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new JwtError("token missing iat/exp claim");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new JwtError("token missing jti claim");
  }
  return {
    sub: payload.sub,
    role: payload.role,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
  };
}

/**
 * 生成 opaque refresh token + 入库用的 sha256 hash。
 *
 * 调用方负责把 hash + expires_at 入 refresh_tokens 表;raw token 只发一次给客户端。
 */
export function issueRefresh(options: { ttlSeconds?: number; now?: number } = {}): RefreshIssueResult {
  const raw = randomBytes(REFRESH_TOKEN_BYTES);
  const token = raw.toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? REFRESH_TOKEN_TTL_SECONDS;
  return { token, hash, expires_at: now + ttl };
}

/**
 * 给定客户端送来的 refresh token raw 值,算它的 hash,用来查表。
 * 永远不要把 raw token 直接拿去比对,DB 里只存 hash。
 */
export function refreshTokenHash(rawToken: string): string {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw new JwtError("refresh token is empty");
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(rawToken, "base64url");
  } catch {
    throw new JwtError("refresh token is not valid base64url");
  }
  if (raw.length === 0) {
    throw new JwtError("refresh token decoded to empty buffer");
  }
  return createHash("sha256").update(raw).digest("hex");
}
