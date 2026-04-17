/**
 * T-54 - 管理员中间件。
 *
 * 基于 T-16 `requireAuth`,额外校验 claims.role === 'admin'。非 admin → 403
 * FORBIDDEN(和 401 分开:401 表示 token 无效,403 表示 token 合法但越权)。
 *
 * 不查 DB:role 写进 access JWT(24h TTL);即使 DB 里刚撤掉 admin 角色,
 * 最坏 24 小时内仍可通过 —— 但所有 admin 写操作会 double-check (T-60 的
 * `writeAdminAudit` 里查 DB),此处只用于读路由。
 */

import type { IncomingMessage } from "node:http";
import { requireAuth, type AuthedUser } from "../http/auth.js";
import { HttpError } from "../http/util.js";

export async function requireAdmin(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
): Promise<AuthedUser> {
  const user = await requireAuth(req, jwtSecret);
  if (user.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "admin role required");
  }
  return user;
}
