/**
 * /api/admin/ledger — P1-5 ledger 列表(read-only)。
 *
 * 一个 list handler 留在本文件;CSV 导出(handleAdminExportLedgerCsv)
 * 走 ./admin/export.ts(CSV 系列另立),通过 import { parseLedgerFilter }
 * from "./ledger.js" 复用过滤参数解析。
 *
 * 鉴权:requireAdmin(只读 JWT-only)。
 *
 * S3 拆分自 http/admin.ts。serializer/parser/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 *
 * 出口约定:
 *   - serializeLedger:私有,仅本文件使用
 *   - parseLedgerFilter:**export**(export.ts 的 ledger.csv handler 复用)
 *   - handleAdminListLedger:export(router 调用)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "../util.js";
import { requireAdmin } from "../../admin/requireAdmin.js";
import {
  listLedger,
  LEDGER_MAX_LIMIT,
  LEDGER_REASONS,
  type LedgerRowView,
  type LedgerReason,
} from "../../admin/ledger.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parsePositiveInt, translateRangeError } from "./_shared.js";

function serializeLedger(r: LedgerRowView): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.user_id,
    delta: r.delta,
    balance_after: r.balance_after,
    reason: r.reason,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
    memo: r.memo,
    created_at: r.created_at.toISOString(),
  };
}

/** 从 sp 提取 ledger 共用过滤参数(user_id / reason / from / to)。 */
export function parseLedgerFilter(sp: URLSearchParams): {
  userId: string | undefined;
  reason: LedgerReason | undefined;
  from: string | undefined;
  to: string | undefined;
} {
  const userIdRaw = sp.get("user_id");
  const reasonRaw = sp.get("reason");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  let reason: LedgerReason | undefined;
  if (reasonRaw !== null && reasonRaw !== "") {
    if (!(LEDGER_REASONS as readonly string[]).includes(reasonRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid reason", {
        issues: [{ path: "reason", message: reasonRaw }],
      });
    }
    reason = reasonRaw as LedgerReason;
  }
  return {
    userId: userIdRaw === null || userIdRaw === "" ? undefined : userIdRaw,
    reason,
    from: fromRaw === null || fromRaw === "" ? undefined : fromRaw,
    to: toRaw === null || toRaw === "" ? undefined : toRaw,
  };
}

export async function handleAdminListLedger(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const filter = parseLedgerFilter(sp);
  const beforeRaw = sp.get("before");
  const limit = parsePositiveInt(sp.get("limit"), "limit", LEDGER_MAX_LIMIT);

  try {
    const r = await listLedger({
      ...filter,
      before: beforeRaw === null || beforeRaw === "" ? undefined : beforeRaw,
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeLedger),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}
