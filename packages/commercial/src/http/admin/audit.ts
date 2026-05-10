/**
 * /api/admin/audit — admin_audit 操作日志只读列表。
 *
 * S3 拆分自 http/admin.ts。serializer + handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util.js";
import { requireAdmin } from "../../admin/requireAdmin.js";
import {
  listAdminAudit,
  ADMIN_AUDIT_MAX_LIMIT,
  type AdminAuditRowView,
} from "../../admin/audit.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { parsePositiveInt, translateRangeError } from "./_shared.js";

function serializeAudit(r: AdminAuditRowView): Record<string, unknown> {
  return {
    id: r.id,
    admin_id: r.admin_id,
    action: r.action,
    target: r.target,
    before: r.before,
    after: r.after,
    ip: r.ip,
    user_agent: r.user_agent,
    created_at: r.created_at.toISOString(),
  };
}

// ─── GET /api/admin/audit?admin_id=&action=&limit=&before= ─────────

export async function handleAdminListAudit(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const adminIdRaw = sp.get("admin_id");
  const actionRaw = sp.get("action");
  const beforeRaw = sp.get("before");
  const limit = parsePositiveInt(sp.get("limit"), "limit", ADMIN_AUDIT_MAX_LIMIT);

  try {
    const r = await listAdminAudit({
      adminId: adminIdRaw === null || adminIdRaw === "" ? undefined : adminIdRaw,
      action: actionRaw === null || actionRaw === "" ? undefined : actionRaw,
      before: beforeRaw === null || beforeRaw === "" ? undefined : beforeRaw,
      limit,
    });
    sendJson(res, 200, {
      rows: r.rows.map(serializeAudit),
      next_before: r.next_before,
    });
  } catch (err) { translateRangeError(err); }
}
