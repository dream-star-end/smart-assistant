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
  path: string;
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
  ];
  // 所有命中的前缀,fallback 时通过它判断是否要兜底 405 / 404
  const prefixes = ["/api/auth/", "/api/me", "/api/public/", "/api/chat"];

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

    const route = routes.find((r) => r.path === path);
    try {
      if (!route) {
        throw new HttpError(404, "NOT_FOUND", "endpoint not found");
      }
      if (route.method !== method) {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", `method ${method} not allowed`, {
          extraHeaders: { Allow: route.method },
        });
      }
      await route.handler(req, res, ctx, deps);
    } catch (err) {
      handleError(err, res, requestId);
    }
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
