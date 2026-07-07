/**
 * `/api/org/*` 声明式路由契约(共享类型)。
 *
 * 单独成文件避免 routes.ts(聚合器)与 membersRoutes.ts / 各批次 *Routes.ts
 * 之间的循环 import:各路由表文件只依赖这里的类型,routes.ts 依赖各路由表。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import type { OrgRole, OrgRoleGate } from "../../org/types.js";

/**
 * 路由 handler 收到的鉴权上下文。
 *
 * minRole != null 的 gated 路由:orgId/orgRole/billingEnabled/billingDelegate 由分发器保证
 * 非空(来自 requireOrgRole)。minRole == null 的路由(邀请接受/自助开通):只有 userId。
 */
export interface OrgRouteAuth {
  userId: string;
  orgId?: string;
  orgRole?: OrgRole;
  billingEnabled?: boolean;
  /** §17.3 财务委派(owner 恒 true);gated 路由非空,minRole=null 路由 undefined。 */
  billingDelegate?: boolean;
}

export type OrgRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
  /** 从 pattern 里抽出的路径参数(如 :uid / :id)。 */
  params: Record<string, string>,
) => Promise<void>;

export interface OrgRoute {
  method: string;
  /** 路径模板,支持 `:name` 占位,如 `/api/org/members/:uid`。 */
  pattern: string;
  /**
   * 最低 org 角色门槛(真实角色 owner/admin/member,或计费伪角色 'billing'=owner ∥
   * billing_delegate,§17.3)。分发器统一先跑 requireOrgRole(minRole) 再进 handler
   * ——结构上不可能漏鉴权。null = 受邀者尚非成员,只 requireAuth(邀请接受/自助开通)。
   */
  minRole: OrgRoleGate | null;
  handler: OrgRouteHandler;
}
