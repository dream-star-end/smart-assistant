/**
 * 企业版(P3.1)org 授权谓词 —— `/api/org/*` 的单一鉴权收口。
 *
 * requireAuth(JWT)→ 一次 JOIN 点查 org_memberships JOIN orgs → 校验 minRole。
 * fail-closed:任何 DB 异常按 500 处理(不放行);无行 / 角色不足 → 403。
 *
 * 设计对齐 requireAdminVerifyDb 的"每请求 DB 复核撤权即时生效"哲学:org 角色不进
 * JWT(方案 §1.1 裁决),`/api/org/*` 全是低 QPS 管理面,一次索引点查换来撤权/停用
 * 立即生效,且完全避开 AccessPayload 兼容性问题。
 *
 * org 由服务端从 caller 的 membership **推导**,不接受客户端传 org_id(防新增 IDOR 面)。
 */

import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { requireAuth } from "../http/auth.js";
import { HttpError } from "../http/util.js";
import { roleAtLeast, type OrgRole, type OrgRoleGate } from "./types.js";

export interface OrgAuthContext {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
  billingEnabled: boolean;
  /**
   * 财务委派(§17.3):org_memberships.billing_delegate。owner 恒视为具备计费权,
   * 故 owner 行的 billingDelegate 也归一化为 true(单一权威:computeBillingAuthorized)。
   */
  billingDelegate: boolean;
}

/**
 * 校验 caller 至少具备 minRole 的 org 角色。成功返回 OrgAuthContext。
 *
 * 失败路径:
 *   - token 缺失/失效           → 401(requireAuth 抛出,直接透传)
 *   - 无 active 成员归属 / org 非 active → 403 FORBIDDEN
 *   - 角色低于 minRole          → 403 FORBIDDEN
 *   - DB 异常                   → 500 INTERNAL(fail-closed,不放行)
 */
export async function requireOrgRole(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
  pool: Pool,
  minRole: OrgRoleGate,
): Promise<OrgAuthContext> {
  const user = await requireAuth(req, jwtSecret); // 401 on bad token(透传)

  let row:
    | { org_id: string; org_role: OrgRole; billing_enabled: boolean; billing_delegate: boolean }
    | undefined;
  try {
    const r = await pool.query<{
      org_id: string;
      org_role: OrgRole;
      billing_enabled: boolean;
      billing_delegate: boolean;
    }>(
      `SELECT m.org_id::text AS org_id, m.org_role, m.billing_enabled, m.billing_delegate
         FROM org_memberships m
         JOIN orgs o ON o.id = m.org_id
        WHERE m.user_id = $1::bigint AND m.status = 'active' AND o.status = 'active'
        LIMIT 1`,
      [user.id],
    );
    row = r.rows[0];
  } catch {
    // fail-closed:DB 异常不放行,也不外泄内部原因
    throw new HttpError(500, "INTERNAL", "org membership lookup failed");
  }

  if (!row) {
    throw new HttpError(403, "FORBIDDEN", "no active organization membership");
  }
  // owner 恒具备计费权(即便 billing_delegate 未打开),归一化为单一权威。
  const billingAuthorized = row.org_role === "owner" || row.billing_delegate;
  if (minRole === "billing") {
    // 计费伪角色:owner ∥ 财务委派,否则 403(错误信息说明需 owner 或财务委派)。
    if (!billingAuthorized) {
      throw new HttpError(403, "FORBIDDEN", "requires organization owner or billing delegate");
    }
  } else if (!roleAtLeast(row.org_role, minRole)) {
    throw new HttpError(403, "FORBIDDEN", "insufficient organization role");
  }
  return {
    userId: user.id,
    orgId: row.org_id,
    orgRole: row.org_role,
    billingEnabled: row.billing_enabled,
    billingDelegate: billingAuthorized,
  };
}
