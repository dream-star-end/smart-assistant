/**
 * `/api/org/*` 声明式路由注册器 + 单一鉴权收口分发器。
 *
 * 设计(方案 §3):所有 org 路由声明为 `{ method, pattern, minRole, handler }`。
 * 分发器**统一先跑 requireOrgRole(minRole)**,再把 OrgRouteAuth 交给 handler
 * ——结构上不可能漏鉴权(对齐 router.ts admin gate 的哲学)。org 由服务端从 caller
 * 的 membership 推导,任何 org 路由不接受客户端传 org_id(防新增 IDOR 面)。
 *
 * minRole=null 仅用于 `POST /api/org/invitations/accept`(受邀者尚非成员,只 requireAuth)。
 *
 * 本文件聚合各批次路由表:成员(A)+ 计费(B)+ 技能(C)+ 报表/发票(D)。
 * 批次 B/C/D 只需往各自 *Routes.ts 加条目即自动接入 gated 分发,无需改分发器。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../util.js";
import { requireAuth } from "../auth.js";
import { getPool } from "../../db/index.js";
import { requireOrgRole } from "../../org/requireOrgRole.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import type { OrgRoute, OrgRouteAuth } from "./routeTypes.js";
import { memberRoutes } from "./membersRoutes.js";
import { billingRoutes } from "./billingRoutes.js";
import { skillsRoutes } from "./skillsRoutes.js";
import { reportsRoutes } from "./reportsRoutes.js";
import { invoicesRoutes } from "./invoicesRoutes.js";

/** 全部 org 路由(批次 A 成员 + B/C/D 占位)。 */
export const ORG_ROUTES: readonly OrgRoute[] = [
  ...memberRoutes,
  ...billingRoutes,
  ...skillsRoutes,
  ...reportsRoutes,
  ...invoicesRoutes,
];

/**
 * 匹配 pattern(支持 `:name` 占位)到 path,返回抽出的参数或 null。
 * 段数不等 → null;`:seg` 捕获非空段;普通段必须逐字相等。
 */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const pSegs = pattern.split("/");
  const uSegs = path.split("/");
  if (pSegs.length !== uSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    const u = uSegs[i];
    if (p.startsWith(":")) {
      if (u.length === 0) return null;
      params[p.slice(1)] = decodeURIComponent(u);
    } else if (p !== u) {
      return null;
    }
  }
  return params;
}

/**
 * `/api/org/*` 分发器。签名与 router.ts 的 RouteHandler 一致,可直接注册。
 *
 * 流程:path 匹配 → method 过滤(不中给 405 + Allow)→ 精确优先于占位 →
 * gate(requireOrgRole 或 requireAuth)→ handler。任一 gate 失败直接抛(fail-closed)。
 */
export async function dispatchOrgRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  const matched: Array<{ r: OrgRoute; params: Record<string, string> }> = [];
  for (const r of ORG_ROUTES) {
    const params = matchPattern(r.pattern, path);
    if (params) matched.push({ r, params });
  }
  if (matched.length === 0) {
    throw new HttpError(404, "NOT_FOUND", "org endpoint not found");
  }

  const methodMatches = matched.filter((m) => m.r.method === method);
  if (methodMatches.length === 0) {
    const allowed = [...new Set(matched.map((m) => m.r.method))].join(", ");
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `method ${method} not allowed`, {
      extraHeaders: { Allow: allowed },
    });
  }
  // 精确 pattern(无 `:` 段)优先于占位 pattern
  methodMatches.sort(
    (a, b) => (a.r.pattern.includes(":") ? 1 : 0) - (b.r.pattern.includes(":") ? 1 : 0),
  );
  const chosen = methodMatches[0];

  let auth: OrgRouteAuth;
  if (chosen.r.minRole === null) {
    const u = await requireAuth(req, deps.jwtSecret);
    auth = { userId: u.id };
  } else {
    const c = await requireOrgRole(req, deps.jwtSecret, getPool(), chosen.r.minRole);
    auth = {
      userId: c.userId,
      orgId: c.orgId,
      orgRole: c.orgRole,
      billingEnabled: c.billingEnabled,
      billingDelegate: c.billingDelegate,
    };
  }

  await chosen.r.handler(req, res, ctx, deps, auth, chosen.params);
}
