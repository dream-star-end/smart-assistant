/**
 * /api/admin/org-invoices — 平台超管开票申请处理(企业版 P3.1 批次 D)。
 *
 *   GET   /api/admin/org-invoices?status=pending|issued|rejected   → 队列(keyset)
 *   PATCH /api/admin/org-invoices/:id  { status, admin_note }      → issued | rejected
 *
 * 全部 /api/admin/* 已被 router.ts 全局 admin gate(requireAdminVerifyDb)覆盖;
 * PATCH 仍自行 requireAdminVerifyDb 以拿 admin 身份写 admin_audit(同既有 handler 同构)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { extractTailId, parsePositiveInt } from "./_shared.js";
import {
  listAdminInvoiceRequests,
  processInvoiceRequest,
  type AdminInvoiceRequestRow,
  type InvoiceStatus,
} from "../../org/orgInvoices.js";
import { OrgError } from "../../org/types.js";

const INVOICE_STATUSES: readonly InvoiceStatus[] = ["pending", "issued", "rejected"];

function throwOrg(err: unknown): never {
  if (err instanceof OrgError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

function serialize(r: AdminInvoiceRequestRow): Record<string, unknown> {
  return {
    id: r.id,
    org_id: r.org_id,
    org_name: r.org_name,
    order_ids: r.order_ids,
    amount_cents: r.amount_cents,
    profile_snapshot: r.profile_snapshot,
    status: r.status,
    requested_by: r.requested_by,
    admin_note: r.admin_note,
    processed_by: r.processed_by,
    processed_at: r.processed_at instanceof Date ? r.processed_at.toISOString() : r.processed_at,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

// ─── GET /api/admin/org-invoices ────────────────────────────────────

export async function handleAdminListOrgInvoices(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sp = url.searchParams;
  const statusRaw = sp.get("status");
  let status: InvoiceStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!(INVOICE_STATUSES as readonly string[]).includes(statusRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid status", {
        issues: [{ path: "status", message: statusRaw }],
      });
    }
    status = statusRaw as InvoiceStatus;
  }
  const limit = parsePositiveInt(sp.get("limit"), "limit", 200);
  const cursorRaw = sp.get("cursor");
  let cursor: string | undefined;
  if (cursorRaw !== null && cursorRaw !== "") {
    if (!/^[1-9][0-9]{0,19}$/.test(cursorRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid cursor", {
        issues: [{ path: "cursor", message: cursorRaw }],
      });
    }
    cursor = cursorRaw;
  }
  const r = await listAdminInvoiceRequests({ status, limit, cursor });
  sendJson(res, 200, { rows: r.rows.map(serialize), next_cursor: r.next_cursor });
}

// ─── PATCH /api/admin/org-invoices/:id ──────────────────────────────

export async function handleAdminPatchOrgInvoice(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailId(url, "/api/admin/org-invoices/");
  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (b.status !== "issued" && b.status !== "rejected") {
    throw new HttpError(400, "VALIDATION", "status must be issued or rejected");
  }
  let adminNote: string | null = null;
  if (b.admin_note !== undefined && b.admin_note !== null) {
    if (typeof b.admin_note !== "string") {
      throw new HttpError(400, "VALIDATION", "admin_note must be a string");
    }
    const t = b.admin_note.trim();
    if (t.length > 1000) {
      throw new HttpError(400, "VALIDATION", "admin_note too long (max 1000)");
    }
    adminNote = t.length > 0 ? t : null;
  }
  try {
    const r = await processInvoiceRequest(id, b.status, adminNote, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, {
      invoice: {
        id: r.id,
        org_id: r.org_id,
        order_ids: r.order_ids,
        amount_cents: r.amount_cents,
        profile_snapshot: r.profile_snapshot,
        status: r.status,
        requested_by: r.requested_by,
        admin_note: r.admin_note,
        processed_by: r.processed_by,
        processed_at: r.processed_at instanceof Date ? r.processed_at.toISOString() : r.processed_at,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      },
    });
  } catch (err) {
    throwOrg(err);
  }
}
