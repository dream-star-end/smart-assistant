/**
 * `/api/org/*` 报表路由(批次 D — 方案 §5)。
 *
 *   GET /api/org/usage?window=24h|7d|30d   (admin) → org 维度用量报表
 *     单一响应含四段:summary + 按成员 + 按模型 + 趋势(方案 §5「可并入上面响应」,
 *     不做 /usage/members 第二套端点)。
 *
 * org 由 auth.orgId(requireOrgRole 从 caller membership 推导)唯一决定,**绝不接受**
 * 客户端传 org_id / user_id 列表(防新增 IDOR 面)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "../util.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { getOrgUsageReport, isUsageWindow, type UsageWindow } from "../../org/orgReports.js";
import type { OrgRoute, OrgRouteAuth } from "./routeTypes.js";

/** gated 路由收窄:分发器保证 admin gate 后 orgId 非空,这里做 fail-closed 兜底。 */
function requireOrgId(auth: OrgRouteAuth): string {
  if (auth.orgId === undefined) {
    throw new HttpError(500, "INTERNAL", "missing org auth context");
  }
  return auth.orgId;
}

async function handleOrgUsage(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const orgId = requireOrgId(auth);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const raw = url.searchParams.get("window");
  // 缺省 7d;显式传值必须命中白名单,否则 400(不静默兜底,避免前端窗口切换失灵被吞)。
  let window: UsageWindow = "7d";
  if (raw !== null && raw !== "") {
    if (!isUsageWindow(raw)) {
      throw new HttpError(400, "VALIDATION", "window must be 24h, 7d or 30d", {
        issues: [{ path: "window", message: raw }],
      });
    }
    window = raw;
  }
  const report = await getOrgUsageReport(orgId, window);
  sendJson(res, 200, report);
}

export const reportsRoutes: OrgRoute[] = [
  { method: "GET", pattern: "/api/org/usage", minRole: "admin", handler: handleOrgUsage },
];
