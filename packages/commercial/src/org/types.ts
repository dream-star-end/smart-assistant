/**
 * 企业版(P3.1)org 子系统共享类型 + 错误 + 角色序。
 *
 * 单独抽出避免 orgs/memberships/invitations/requireOrgRole 之间的循环依赖:
 * 它们都依赖 OrgRole / OrgError / 角色比较,但彼此不应互相 import 全部。
 */

export type OrgRole = "owner" | "admin" | "member";
export type OrgStatus = "active" | "suspended" | "deleting" | "deleted";
export type MembershipStatus = "active" | "suspended";

/**
 * 路由鉴权门槛(§17.3):真实 org 角色 + 计费伪角色 'billing'。
 *   - 真实角色('owner'/'admin'/'member')走角色序 roleAtLeast。
 *   - 伪角色 'billing' = owner ∥ billing_delegate(财务委派),不进角色序,由 requireOrgRole
 *     单独判定。伪角色只用于计费写面(topup/subscribe/seats/invoice 写),让 owner 可把
 *     计费能力授予非 admin 的财务成员而不放开成员管理。
 */
export type OrgRoleGate = OrgRole | "billing";

/** 角色权限序:owner > admin > member。数值仅用于比较,不外泄。 */
const ROLE_RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };

export function roleRank(role: OrgRole): number {
  return ROLE_RANK[role] ?? 0;
}

/** role 是否 ≥ min(owner ≥ admin ≥ member)。 */
export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/**
 * org 子系统的结构化领域错误。
 *
 * 数据层抛 OrgError(status + code + message),HTTP 层原样映射到 HttpError,
 * 保证前端拿到稳定的 code(前端据此做 toast / 引导)。故意携带 status 让 HTTP
 * 层无需维护一张"错误 → 状态码"映射表(避免第二套并行机制)。
 */
export class OrgError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OrgError";
    this.status = status;
    this.code = code;
  }
}
