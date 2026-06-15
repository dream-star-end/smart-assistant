/**
 * /api/admin/metrics — Prometheus text exposition(T-62)。
 *
 * S3 拆分自 http/admin.ts。handler 函数体逐字节等价,只允许 import
 * 路径变化(plan §1.2 + §4.5 mechanical byte-equal gate)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { renderPrometheus } from "../../admin/metrics.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";

// ─── metrics(T-62)──────────────────────────────────────────────────

/**
 * 常时比较:常数时间判等,防 timing 攻击(token 长度泄漏除外)。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * GET /api/admin/metrics → Prometheus text exposition。
 *
 * 认证两选一:
 *   1. `COMMERCIAL_METRICS_BEARER` env 设了 → Authorization: Bearer <该 token>
 *      长寿命 machine credential,给 Prometheus scraper 用。长度必须 ≥ 32。
 *   2. 否则回落到 admin JWT(短 TTL,15min 内手工 curl 调试用)
 *
 * 为什么不开 /metrics 无 auth:account_pool_health 会泄漏 Claude 账号池哪些
 * 活/哪些挂,对外是有价值的侦察情报(02-ARCH §7.2 "超管后台拉取展示")。
 */
export async function handleAdminMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const scrapeBearer = process.env.COMMERCIAL_METRICS_BEARER ?? "";
  let authorized = false;
  if (scrapeBearer.length >= 32) {
    const h = req.headers["authorization"];
    if (typeof h === "string" && h.startsWith("Bearer ")) {
      const token = h.slice("Bearer ".length).trim();
      if (constantTimeEqual(token, scrapeBearer)) authorized = true;
    }
  }
  if (!authorized) {
    // 回落 admin JWT:失败会抛 HttpError(401/403),由 router 统一翻译。
    // B5:用 verify-db(JWT + DB role/status 复核),降权/封停的 admin 即使 JWT 未过期
    // 也读不到 metrics(此路由在 router 层走 self-auth 白名单,DB 复核只能在这里做)。
    await requireAdminVerifyDb(req, deps.jwtSecret);
  }
  const body = await renderPrometheus();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}
