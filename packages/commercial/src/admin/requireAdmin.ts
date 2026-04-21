/**
 * T-54 - 管理员中间件。
 *
 * 基于 T-16 `requireAuth`,额外校验 claims.role === 'admin'。非 admin → 403
 * FORBIDDEN(和 401 分开:401 表示 token 无效,403 表示 token 合法但越权)。
 *
 * `requireAdmin`(JWT-only):不查 DB。role 写进 access JWT(24h TTL),
 * 即使 DB 里刚撤掉 admin 角色,最坏 24 小时内仍可通过。用于纯读路由,
 * 读了数据没直接业务影响、且希望省一次 DB roundtrip。
 *
 * `requireAdminVerifyDb`(JWT + DB):JWT 先过,再 `SELECT role, status`
 * 确认 DB 里当前仍是 active admin。用于任何"能动账/动钱/动账号池/改配置"
 * 的破坏性写操作 —— 即使 JWT 还没过期,只要 DB 里被降权/封停就立刻拒绝。
 * 这是 2026-04-21 安全审计 Medium#5 要求的 "admin de-escalation 立即生效"
 * 承诺,从前文 docstring 夸下的 "写操作 double-check" 真正落实。
 *
 * 性能说明:每个 write 操作多一次 PG roundtrip(~1ms LAN),不会成为瓶颈;
 * admin 后台调用量级低(人工点操作),比 adjustCredits 本身 tx 便宜得多。
 */

import type { IncomingMessage } from "node:http";
import { requireAuth, type AuthedUser } from "../http/auth.js";
import { HttpError } from "../http/util.js";
import { query } from "../db/queries.js";

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

/**
 * 同 requireAdmin,再额外查 DB 确认 (role, status) 未变。用于任何破坏性写操作。
 *
 * 三种失败路径:
 *   - JWT/role claim 不是 admin      → 403 FORBIDDEN("admin role required")
 *   - DB 里用户行不存在              → 403 FORBIDDEN("admin account not found")
 *   - DB 里 role != 'admin'          → 403 FORBIDDEN("admin role revoked in DB")
 *   - DB 里 status != 'active'       → 403 FORBIDDEN("admin account not active: <status>")
 *
 * 为什么查 users.status(而不仅仅是 role)?被 ban 的 admin(banned / deleting /
 * deleted)即使 role 列还挂着 'admin',也不应能继续动账 —— 这是故意对齐 v3 的
 * "status=active 是所有授权操作的共同前置"不变量。
 */
export async function requireAdminVerifyDb(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
): Promise<AuthedUser> {
  const user = await requireAdmin(req, jwtSecret);
  const r = await query<{ role: string; status: string }>(
    "SELECT role, status FROM users WHERE id = $1",
    [user.id],
  );
  if (r.rows.length === 0) {
    // JWT 合法但 DB 里用户已被删 —— 不可能出现的话那就是 DB 数据漂移,务必 403 不放过
    throw new HttpError(403, "FORBIDDEN", "admin account not found");
  }
  const row = r.rows[0];
  if (row.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "admin role revoked in DB");
  }
  if (row.status !== "active") {
    throw new HttpError(403, "FORBIDDEN", `admin account not active: ${row.status}`);
  }
  return user;
}
