/**
 * `/api/org/*` 发票路由(批次 D — 方案 §5)。
 *
 *   GET  /api/org/invoice-profile  (admin)   → 抬头(无 → null)
 *   PUT  /api/org/invoice-profile  (billing) → upsert 抬头(§14 收紧 + §17.3 财务委派)
 *   GET  /api/org/invoices         (admin)   → 本 org 开票申请列表
 *   POST /api/org/invoices         (billing) → 对已付订单发起开票申请
 *
 * org 由 auth.orgId(requireOrgRole 推导)唯一决定;金额由服务端合计,**不接受**客户端金额。
 * 计费写面(PUT profile / POST invoices)门 = owner ∥ billing_delegate;读面保持 admin。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { OrgError } from "../../org/types.js";
import {
  getInvoiceProfile,
  upsertInvoiceProfile,
  listInvoiceRequests,
  createInvoiceRequest,
  type InvoiceProfile,
  type InvoiceRequestRow,
} from "../../org/orgInvoices.js";
import type { OrgRoute, OrgRouteAuth } from "./routeTypes.js";

function gated(auth: OrgRouteAuth): { userId: string; orgId: string } {
  if (auth.orgId === undefined) {
    throw new HttpError(500, "INTERNAL", "missing org auth context");
  }
  return { userId: auth.userId, orgId: auth.orgId };
}

function throwOrg(err: unknown): never {
  if (err instanceof OrgError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function serializeProfile(p: InvoiceProfile): Record<string, unknown> {
  return {
    org_id: p.org_id,
    title: p.title,
    tax_id: p.tax_id,
    address: p.address,
    email: p.email,
    updated_by: p.updated_by,
    updated_at: p.updated_at instanceof Date ? p.updated_at.toISOString() : p.updated_at,
  };
}

function serializeRequest(r: InvoiceRequestRow): Record<string, unknown> {
  return {
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
  };
}

// ─── GET /api/org/invoice-profile ───────────────────────────────────

async function handleGetProfile(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = gated(auth);
  const p = await getInvoiceProfile(orgId);
  sendJson(res, 200, { profile: p ? serializeProfile(p) : null });
}

// ─── PUT /api/org/invoice-profile ───────────────────────────────────

async function handlePutProfile(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, userId } = gated(auth);
  const b = asObject(await readJsonBody(req));
  if (typeof b.title !== "string") {
    throw new HttpError(400, "VALIDATION", "title is required");
  }
  try {
    const p = await upsertInvoiceProfile(
      orgId,
      {
        title: b.title,
        taxId: typeof b.tax_id === "string" ? b.tax_id : b.tax_id === null ? null : undefined,
        address: typeof b.address === "string" ? b.address : b.address === null ? null : undefined,
        email: typeof b.email === "string" ? b.email : b.email === null ? null : undefined,
      },
      userId,
    );
    sendJson(res, 200, { profile: serializeProfile(p) });
  } catch (err) {
    throwOrg(err);
  }
}

// ─── GET /api/org/invoices ──────────────────────────────────────────

async function handleListInvoices(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId } = gated(auth);
  const rows = await listInvoiceRequests(orgId);
  sendJson(res, 200, { invoices: rows.map(serializeRequest) });
}

// ─── POST /api/org/invoices ─────────────────────────────────────────

async function handleCreateInvoice(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
  auth: OrgRouteAuth,
): Promise<void> {
  const { orgId, userId } = gated(auth);
  const b = asObject(await readJsonBody(req));
  try {
    const r = await createInvoiceRequest(orgId, b.order_ids, userId);
    sendJson(res, 201, { invoice: serializeRequest(r) });
  } catch (err) {
    throwOrg(err);
  }
}

export const invoicesRoutes: OrgRoute[] = [
  { method: "GET", pattern: "/api/org/invoice-profile", minRole: "admin", handler: handleGetProfile },
  // 计费写面:§14 owner-only → §17.3 放开给财务委派(minRole='billing'=owner ∥ billing_delegate)。
  { method: "PUT", pattern: "/api/org/invoice-profile", minRole: "billing", handler: handlePutProfile },
  { method: "GET", pattern: "/api/org/invoices", minRole: "admin", handler: handleListInvoices },
  { method: "POST", pattern: "/api/org/invoices", minRole: "billing", handler: handleCreateInvoice },
];
