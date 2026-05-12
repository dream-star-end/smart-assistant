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

import type { Pool } from 'pg'

export interface VerifiedUser {
  id: string
}

/**
 * `sub` 来自 JWT.sub(PG bigint 的字符串表示)。直接参数化,PG 自己做 bigint 解析。
 */
export async function requireUserVerifyDb(sub: string, pool: Pool): Promise<VerifiedUser | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id
       FROM users
      WHERE id = $1::bigint
        AND role = 'user'
        AND status = 'active'
      LIMIT 1`,
    [sub],
  )
  if (r.rowCount === 0) return null
  return { id: r.rows[0]!.id }
}

/**
 * `requireUserVerifyDb` 的 multi-role 版 —— 给 signed URL endpoint(/api/media-sign +
 * /api/media-signed)用。
 *
 * 与 `requireUserVerifyDb` 的差异:
 *   - 允许 `allowedRoles` 显式枚举 user / admin(signed URL 同时服务两者)
 *   - 返回 role,调用方可以做基于 role 的下游行为(目前 signed URL 两者等价)
 *
 * 不替代 `requireUserVerifyDb` —— containerFileProxy 的 PROXY 路径(router.ts)
 * 只服务 user role,admin 走 BLOCKED 的 admin bypass cookie 通道。该函数仅供
 * cookie-free signed URL 端点使用。
 *
 * **运行时 role 收窄**:即使 SQL `role = ANY($2)` 已限制结果集,DB 类型漂移
 * (新增 role 值未对齐 enum)也可能让 pg 把字符串原样返回。再做一次 `role !==
 * 'user' && role !== 'admin'` 收窄,避免攻击者通过 DB 数据漂移拿到非预期 role。
 */
export type VerifiedAccount = { id: string; role: 'user' | 'admin' }

export async function requireActiveAccountVerifyDb(
  sub: string,
  allowedRoles: readonly ('user' | 'admin')[],
  pool: Pool,
): Promise<VerifiedAccount | null> {
  if (allowedRoles.length === 0) return null
  const r = await pool.query<{ id: string; role: string }>(
    `SELECT id::text AS id, role
       FROM users
      WHERE id = $1::bigint
        AND role = ANY($2::text[])
        AND status = 'active'
      LIMIT 1`,
    [sub, allowedRoles],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0]!
  // 运行时收窄(防 DB 类型漂移)
  if (row.role !== 'user' && row.role !== 'admin') return null
  return { id: row.id, role: row.role }
}
