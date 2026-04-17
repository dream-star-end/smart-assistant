/**
 * T-16 — 商业化模块的 HTTP 路由器(无框架,基于 node:http)。
 *
 * 暴露 `createCommercialHandler(deps)` → `(req, res) => Promise<boolean>`。
 * 返回 `true` 表示该路由由商业化模块处理(已写完响应),
 * `false` 表示路径不匹配,调用方应 fall through 到下层 handler。
 *
 * 设计:
 *   - 关心的前缀:/api/auth/* + /api/me
 *   - 派发前统一:setSecurityHeaders + ensureRequestId + 写 X-Request-Id 响应头
 *   - 派发后:HttpError → 标准错误响应;未捕获异常 → 500 INTERNAL
 *   - body 解析在 handler 里调用 readJsonBody(失败抛 HttpError)
 *
 * 不在本文件:
 *   - CORS:由 gateway 层统一处理(目前暂不开放跨域;Web 同源)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  REQUEST_ID_HEADER,
  ensureRequestId,
  sendError,
  setSecurityHeaders,
  clientIpOf,
  userAgentOf,
} from "./util.js";
import {
  handleRegister,
  handleLogin,
  handleRefresh,
  handleLogout,
  handleVerifyEmail,
  handleRequestPasswordReset,
  handleConfirmPasswordReset,
  handleMe,
  handleListPublicModels,
  type CommercialHttpDeps,
  type RequestContext,
} from "./handlers.js";
import { handleChat } from "./chat.js";
import {
  handleListPlans,
  handleCreateHupi,
  handleHupiCallback,
  handleGetOrder,
} from "./payment.js";
import {
  handleAgentOpen,
  handleAgentStatus,
  handleAgentCancel,
} from "./agent.js";
import { handleAdminAgentAudit } from "./adminAudit.js";
import {
  handleAdminListUsers,
  handleAdminGetUser,
  handleAdminPatchUser,
  handleAdminAdjustCredits,
  handleAdminListAudit,
  handleAdminListPricing,
  handleAdminPatchPricing,
  handleAdminListPlans,
  handleAdminPatchPlan,
  handleAdminListAccounts,
  handleAdminGetAccount,
  handleAdminCreateAccount,
  handleAdminPatchAccount,
  handleAdminDeleteAccount,
  handleAdminListAgentContainers,
  handleAdminAgentContainerAction,
  handleAdminListLedger,
  handleAdminMetrics,
} from "./admin.js";
import { incrGatewayRequest } from "../admin/metrics.js";

export type CommercialHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
) => Promise<void>;

interface Route {
  method: string;
  /**
   * 精确路径。动态参数路由(如 `/api/payment/orders/:order_no`)用 `pathPrefix` 字段,
   * 不在这里出现。
   */
  path?: string;
  /**
   * 前缀匹配:path 以 `pathPrefix` 开头的请求都会命中。Handler 自己从 url 中抽参数。
   * 用于少数带路径变量的 GET 接口。同一 method 多个 prefix 顺序即优先级。
   */
  pathPrefix?: string;
  handler: RouteHandler;
}

export function createCommercialHandler(deps: CommercialHttpDeps): CommercialHandler {
  const routes: Route[] = [
    { method: "POST", path: "/api/auth/register", handler: handleRegister },
    { method: "POST", path: "/api/auth/login", handler: handleLogin },
    { method: "POST", path: "/api/auth/refresh", handler: handleRefresh },
    { method: "POST", path: "/api/auth/logout", handler: (req, res) => handleLogout(req, res) },
    { method: "POST", path: "/api/auth/verify-email", handler: (req, res) => handleVerifyEmail(req, res) },
    { method: "POST", path: "/api/auth/request-password-reset", handler: handleRequestPasswordReset },
    { method: "POST", path: "/api/auth/confirm-password-reset", handler: (req, res) => handleConfirmPasswordReset(req, res) },
    { method: "GET", path: "/api/me", handler: handleMe },
    { method: "GET", path: "/api/public/models", handler: handleListPublicModels },
    { method: "POST", path: "/api/chat", handler: handleChat },
    { method: "GET", path: "/api/payment/plans", handler: handleListPlans },
    { method: "POST", path: "/api/payment/hupi/create", handler: handleCreateHupi },
    { method: "POST", path: "/api/payment/hupi/callback", handler: handleHupiCallback },
    { method: "GET", pathPrefix: "/api/payment/orders/", handler: handleGetOrder },
    // T-53 Agent 订阅
    { method: "POST", path: "/api/agent/open", handler: handleAgentOpen },
    { method: "GET", path: "/api/agent/status", handler: handleAgentStatus },
    { method: "POST", path: "/api/agent/cancel", handler: handleAgentCancel },
    // T-54 Agent 审计(超管)
    { method: "GET", path: "/api/admin/agent-audit", handler: handleAdminAgentAudit },
    // T-60 超管 API —— 用户管理
    { method: "GET",   path: "/api/admin/users",       handler: handleAdminListUsers },
    // 动态路径用 pathPrefix。/api/admin/users/:id/credits 优先匹配,
    // 后退到 /api/admin/users/:id(GET/PATCH)。Handler 自己区分。
    { method: "POST",  pathPrefix: "/api/admin/users/", handler: handleAdminAdjustCredits },
    { method: "GET",   pathPrefix: "/api/admin/users/", handler: handleAdminGetUser },
    { method: "PATCH", pathPrefix: "/api/admin/users/", handler: handleAdminPatchUser },
    // T-60 超管审计记录
    { method: "GET",   path: "/api/admin/audit",       handler: handleAdminListAudit },
    // T-60 超管定价
    { method: "GET",   path: "/api/admin/pricing",        handler: handleAdminListPricing },
    { method: "PATCH", pathPrefix: "/api/admin/pricing/", handler: handleAdminPatchPricing },
    // T-60 超管充值套餐
    { method: "GET",   path: "/api/admin/plans",          handler: handleAdminListPlans },
    { method: "PATCH", pathPrefix: "/api/admin/plans/",   handler: handleAdminPatchPlan },
    // T-60 超管账号池
    { method: "GET",    path: "/api/admin/accounts",         handler: handleAdminListAccounts },
    { method: "POST",   path: "/api/admin/accounts",         handler: handleAdminCreateAccount },
    { method: "GET",    pathPrefix: "/api/admin/accounts/",  handler: handleAdminGetAccount },
    { method: "PATCH",  pathPrefix: "/api/admin/accounts/",  handler: handleAdminPatchAccount },
    { method: "DELETE", pathPrefix: "/api/admin/accounts/",  handler: handleAdminDeleteAccount },
    // T-60 超管 Agent 容器
    { method: "GET",  path: "/api/admin/agent-containers",        handler: handleAdminListAgentContainers },
    { method: "POST", pathPrefix: "/api/admin/agent-containers/", handler: handleAdminAgentContainerAction },
    // T-60 超管积分流水
    { method: "GET", path: "/api/admin/ledger", handler: handleAdminListLedger },
    // T-62 Prometheus 指标
    { method: "GET", path: "/api/admin/metrics", handler: handleAdminMetrics },
  ];
  // 所有命中的前缀,fallback 时通过它判断是否要兜底 405 / 404
  const prefixes = [
    "/api/auth/",
    "/api/me",
    "/api/public/",
    "/api/chat",
    "/api/payment/",
    "/api/agent/",
    "/api/admin/",
  ];

  return async function commercialHandler(req, res): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    const isOurs = prefixes.some((p) => path === p || path.startsWith(p));
    if (!isOurs) return false;

    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const ctx: RequestContext = {
      requestId,
      clientIp: clientIpOf(req),
      userAgent: userAgentOf(req),
    };

    // 1) 精确匹配 —— 同一 path 下可能有多个 method(例:PATCH + GET /api/admin/users/:id)
    const exactCandidates = routes.filter((r) => r.path !== undefined && r.path === path);
    // 2) 前缀匹配(仅在精确不中时尝试)。T-60 同 prefix 下 GET/PATCH/POST 并存,必须
    //    在 candidates 里挑 method 匹配项;否则拿到首个(可能是 POST)就抛 405。
    const prefixCandidates = exactCandidates.length === 0
      ? routes.filter((r) => r.pathPrefix !== undefined && path.startsWith(r.pathPrefix))
      : [];
    const candidates = exactCandidates.length > 0 ? exactCandidates : prefixCandidates;
    const route = candidates.find((r) => r.method === method);
    try {
      if (candidates.length === 0) {
        throw new HttpError(404, "NOT_FOUND", "endpoint not found");
      }
      if (!route) {
        // method mismatch:返合并后的 Allow 头(该 path 下所有已定义 method)
        const allowed = [...new Set(candidates.map((r) => r.method))].join(", ");
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `method ${method} not allowed`, {
          extraHeaders: { Allow: allowed },
        });
      }
      await route.handler(req, res, ctx, deps);
    } catch (err) {
      handleError(err, res, requestId);
    }
    // T-62 metrics:按"声明的 path/pathPrefix"折叠 route label(跟踪 spec'd 端点;
    //   未命中 route 走 normalizeRoute(path) 兜底,它对未知路径原样返回)。
    //   status 直接拿响应对象实际写出的码,对齐真实 401/403/402/5xx。
    const labelRoute = route?.path ?? route?.pathPrefix ?? path;
    incrGatewayRequest(labelRoute, method, res.statusCode);
    return true;
  };
}

function handleError(err: unknown, res: ServerResponse, requestId: string): void {
  if (res.headersSent) {
    // 响应已发出,无能为力 — 关连接
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    sendError(res, err.status, err.code, err.message, requestId, err.issues, err.extraHeaders);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[commercial/http] unhandled error in request ${requestId}:`, err);
  sendError(res, 500, "INTERNAL", "internal server error", requestId);
}
