/**
 * /api/admin/{ledger,users,orders}.csv — 后台数据导出(写路由 + 审计)。
 *
 * 三个 handler:
 *   GET /api/admin/ledger.csv?user_id&reason&from&to     ledger 流水导出
 *   GET /api/admin/users.csv?q&status&...                Users 列表导出
 *   GET /api/admin/orders.csv?status&user_id&from&to     Orders 列表导出
 *
 * 鉴权:全部 requireAdminVerifyDb(写路由级保护 + admin_audit 审计)。
 *
 * 设计要点:
 * - CSV 内存构建(在 ../../admin/{ledger,users,orders}.ts 里 buildXxxCsv);
 * - **审计先于 writeHead** — 失败抛 → 不下发 body,避免 header/body 顺序 bug;
 * - parseLedgerFilter 复用自 ./ledger.ts(同一过滤参数解析,List + CSV 同源);
 * - parseUserFunnelFilters 复用自 ./users.ts(同上,List + CSV 同源)。
 *
 * S3 拆分自 http/admin.ts。三 handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../util.js";
import { requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { writeAdminAudit } from "../../admin/audit.js";
import { tx } from "../../db/queries.js";
import { buildLedgerCsv } from "../../admin/ledger.js";
import {
  buildUsersCsv,
  USER_STATUSES,
  type UserStatus,
} from "../../admin/users.js";
import {
  buildOrdersCsv,
  ORDER_STATUSES,
  type OrderStatus,
} from "../../admin/orders.js";
import { csvFilename } from "../../admin/csvHelper.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parseLedgerFilter } from "./ledger.js";
import { parseUserFunnelFilters } from "./users.js";
import { parseUserId, parseIsoTimestamp, translateRangeError } from "./_shared.js";

// ─── GET /api/admin/ledger.csv?user_id&reason&from&to (P1-5) ────────
//
// 写路由 — 用 requireAdminVerifyDb,审计 'ledger.export_csv'。
// CSV 内存构建,审计成功后再 writeHead(避免 header/body 顺序 bug)。

export async function handleAdminExportLedgerCsv(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const filter = parseLedgerFilter(url.searchParams);

  let csv: string;
  let rowCount: number;
  try {
    const r = await buildLedgerCsv(filter);
    csv = r.csv;
    rowCount = r.rowCount;
  } catch (err) { translateRangeError(err); }

  // 审计先写,失败抛 → 不下发 body。
  await tx(async (client) => {
    await writeAdminAudit(client, {
      adminId: admin.id,
      action: "ledger.export_csv",
      target: filter.userId ? `user:${filter.userId}` : "all",
      after: {
        rows: rowCount,
        filter: {
          user_id: filter.userId ?? null,
          reason: filter.reason ?? null,
          from: filter.from ?? null,
          to: filter.to ?? null,
        },
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });

  // YYYYMMDDTHHmm(UTC,文件名不掺时区差异)
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const filename = `ledger-${stamp}.csv`;

  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(csv, "utf-8"),
    "Cache-Control": "no-store",
  });
  res.end(csv);
}

// ─── GET /api/admin/users.csv?q&status (M8.4 / P2-20) ──────────────
//
// 写路由级保护:requireAdminVerifyDb + admin_audit('users.export_csv')。
// 内存构建,审计先于 writeHead — 失败抛 → 不下发 body。

export async function handleAdminExportUsersCsv(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;

  const qRaw = sp.get("q");
  const q = qRaw === null || qRaw === "" ? undefined : qRaw;

  // status 参数:repeat ?status=active&status=banned 或单值;统一传给 buildUsersCsv。
  const statusList = sp.getAll("status").filter(Boolean);
  for (const s of statusList) {
    if (!(USER_STATUSES as readonly string[]).includes(s)) {
      throw new HttpError(400, "VALIDATION", `invalid status: ${s}`, {
        issues: [{ path: "status", message: s }],
      });
    }
  }
  const status: UserStatus | UserStatus[] | undefined =
    statusList.length === 0
      ? undefined
      : statusList.length === 1
        ? (statusList[0] as UserStatus)
        : (statusList as UserStatus[]);

  // Phase B:CSV 导出与列表使用同一组过滤维度,避免运营看见的列表 ≠ 导出集
  const funnelFilters = parseUserFunnelFilters(sp);

  let csv: string;
  let rowCount: number;
  try {
    const r = await buildUsersCsv({ q, status, ...funnelFilters });
    csv = r.csv;
    rowCount = r.rowCount;
  } catch (err) {
    translateRangeError(err);
  }

  await tx(async (client) => {
    await writeAdminAudit(client, {
      adminId: admin.id,
      action: "users.export_csv",
      target: q ? `q:${q}` : "all",
      after: {
        rows: rowCount,
        filter: {
          q: q ?? null,
          status: status ?? null,
          registered_within: funnelFilters.registered_within ?? null,
          funnel_state: funnelFilters.funnel_state ?? null,
        },
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });

  const filename = csvFilename("users");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(csv, "utf-8"),
    "Cache-Control": "no-store",
  });
  res.end(csv);
}

// ─── GET /api/admin/orders.csv?status&user_id&from&to (M8.4) ───────

export async function handleAdminExportOrdersCsv(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;

  const statusRaw = sp.get("status");
  let status: OrderStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!(ORDER_STATUSES as readonly string[]).includes(statusRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: statusRaw }],
      });
    }
    status = statusRaw as OrderStatus;
  }
  const userId = parseUserId(sp.get("user_id"));
  const from = parseIsoTimestamp(sp.get("from"), "from");
  const to = parseIsoTimestamp(sp.get("to"), "to");

  let csv: string;
  let rowCount: number;
  try {
    const r = await buildOrdersCsv({ status, user_id: userId, from, to });
    csv = r.csv;
    rowCount = r.rowCount;
  } catch (err) {
    translateRangeError(err);
  }

  await tx(async (client) => {
    await writeAdminAudit(client, {
      adminId: admin.id,
      action: "orders.export_csv",
      target: userId ? `user:${userId}` : status ? `status:${status}` : "all",
      after: {
        rows: rowCount,
        filter: {
          status: status ?? null,
          user_id: userId ?? null,
          from: from ?? null,
          to: to ?? null,
        },
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  });

  const filename = csvFilename("orders");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": Buffer.byteLength(csv, "utf-8"),
    "Cache-Control": "no-store",
  });
  res.end(csv);
}
