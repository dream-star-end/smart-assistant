/**
 * T-16 — `requireAuth(req)` 中间件:从 Authorization: Bearer 解析 access JWT,
 * 注入 user。失败一律 401,不暴露内部原因。
 */

import type { IncomingMessage } from "node:http";
import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import { HttpError } from "./util.js";

export interface AuthedUser {
  id: string;
  role: "user" | "admin";
  jti: string;
}

const BEARER_RE = /^Bearer\s+([A-Za-z0-9._-]+)$/;

export function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = BEARER_RE.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * 解析并校验 Bearer access token,返回认证用户。
 *
 * 失败抛 HttpError(401, UNAUTHORIZED)。具体内部原因(token 缺失 / 解析错 / 过期 /
 * 算法不允许 / 篡改)统一不外泄,避免给攻击者 oracle。
 */
export async function requireAuth(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
): Promise<AuthedUser> {
  const token = extractBearer(req);
  if (!token) {
    throw new HttpError(401, "UNAUTHORIZED", "missing or malformed authorization header");
  }
  let claims: AccessClaims;
  try {
    claims = await verifyAccess(token, jwtSecret);
  } catch (err) {
    if (err instanceof JwtError) {
      throw new HttpError(401, "UNAUTHORIZED", "invalid or expired token");
    }
    throw err;
  }
  return { id: claims.sub, role: claims.role, jti: claims.jti };
}
