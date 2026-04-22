/**
 * v3 file proxy — `requireUserVerifyDb` helper.
 *
 * **背景**:containerFileProxy 在 JWT 验通过后,要对 `sub` 做 DB double-check —— 用户
 * 是否还是 active。与 `admin/requireAdmin.ts::requireAdminVerifyDb` 对齐,防止被 ban
 * 的用户 JWT 还没过期时继续下载容器内文件。
 *
 * **返回约定**:
 *   - DB 有行 + role='user' + status='active' → 返回 `{ id }`(调用方继续 proxy)
 *   - 否则(查不到 / role 漂移 / banned) → 返回 `null`(调用方 403 FORBIDDEN)
 *
 * **为什么不与 requireAdminVerifyDb 合成一个函数**:
 *   - admin 版本 throws HttpError 供 router 高层 catch;本函数在
 *     containerFileProxy 内部直接分支决策,throw 反而噪音
 *   - role 约束刚好相反(user vs admin),合在一起反而需要加参数
 */

import type { Pool } from "pg";

export interface VerifiedUser {
  id: string;
}

/**
 * `sub` 来自 JWT.sub(PG bigint 的字符串表示)。直接参数化,PG 自己做 bigint 解析。
 */
export async function requireUserVerifyDb(
  sub: string,
  pool: Pool,
): Promise<VerifiedUser | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id
       FROM users
      WHERE id = $1::bigint
        AND role = 'user'
        AND status = 'active'
      LIMIT 1`,
    [sub],
  );
  if (r.rowCount === 0) return null;
  return { id: r.rows[0]!.id };
}
