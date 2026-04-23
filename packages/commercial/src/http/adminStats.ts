/**
 * /api/admin/stats/* HTTP handlers — dashboard tab 聚合数据源。
 *
 * 全部 GET + requireAdmin(JWT 即可,无需 VerifyDb:只读不影响状态)。
 *
 *   GET /api/admin/stats/dau?window=24h|7d|30d      活跃度统计
 *   GET /api/admin/stats/revenue-by-day?days=14     按日营收
 *   GET /api/admin/stats/request-series?hours=24    请求趋势
 *   GET /api/admin/stats/alerts-summary             告警摘要
 *   GET /api/admin/stats/account-pool               账号池快照
 *
 * 所有端点都是"幂等 + 相对短查询",dashboard 前端并行拉。
 * 查询参数在 handler 侧 clamp,SQL 层再 clamp 一次(double-guard)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "./util.js";
import { requireAdmin } from "../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";
import {
  getActivityStats,
  getRevenueByDay,
  getRequestSeries,
  getAlertsSummary,
  getAccountPoolSnapshot,
  type ActivityWindow,
} from "../admin/stats.js";

/** 从 req 抽 URL,带 host fallback(req.headers.host 一定存在)。 */
function urlOf(req: IncomingMessage): URL {
  return new URL(req.url || "/", `http://${req.headers.host ?? "localhost"}`);
}

const ACTIVITY_WINDOWS: ReadonlySet<ActivityWindow> = new Set(["24h", "7d", "30d"]);

// ─── GET /api/admin/stats/dau ────────────────────────────────────────

export async function handleAdminStatsDau(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = urlOf(req);
  const raw = url.searchParams.get("window") ?? "24h";
  if (!ACTIVITY_WINDOWS.has(raw as ActivityWindow)) {
    throw new HttpError(400, "BAD_PARAM", `window must be one of: 24h, 7d, 30d`);
  }
  const out = await getActivityStats(raw as ActivityWindow);
  sendJson(res, 200, out);
}

// ─── GET /api/admin/stats/revenue-by-day ─────────────────────────────

export async function handleAdminStatsRevenueByDay(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = urlOf(req);
  const raw = url.searchParams.get("days");
  let days = 14;
  if (raw != null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 90) {
      throw new HttpError(400, "BAD_PARAM", "days must be integer in [1, 90]");
    }
    days = n;
  }
  const rows = await getRevenueByDay(days);
  sendJson(res, 200, { rows });
}

// ─── GET /api/admin/stats/request-series ─────────────────────────────

export async function handleAdminStatsRequestSeries(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = urlOf(req);
  const raw = url.searchParams.get("hours");
  let hours = 24;
  if (raw != null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 168) {
      throw new HttpError(400, "BAD_PARAM", "hours must be integer in [1, 168]");
    }
    hours = n;
  }
  const rows = await getRequestSeries(hours);
  sendJson(res, 200, { rows });
}

// ─── GET /api/admin/stats/alerts-summary ─────────────────────────────

export async function handleAdminStatsAlertsSummary(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const out = await getAlertsSummary();
  sendJson(res, 200, out);
}

// ─── GET /api/admin/stats/account-pool ────────────────────────────────

export async function handleAdminStatsAccountPool(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const out = await getAccountPoolSnapshot();
  sendJson(res, 200, out);
}
