/**
 * /api/admin/plans — 充值套餐管理(P-Plans)。
 *
 * 两个端点:
 *   GET   /api/admin/plans          列出全部套餐(无分页,记录有限)
 *   PATCH /api/admin/plans/:code    修改 label / amount_cents / credits / sort_order / enabled
 *
 * 鉴权:GET requireAdmin;PATCH requireAdminVerifyDb。
 *
 * S3 拆分自 http/admin.ts。serializer/handler 函数体逐字节等价
 * (plan §1.2 + §4.5 mechanical byte-equal gate)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import {
  listPlans,
  patchPlan,
  PlanNotFoundError,
  type TopupPlanRowView,
  type PatchPlanInput,
} from "../../admin/plans.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { extractTailSlug, translateRangeError } from "./_shared.js";

function serializePlan(r: TopupPlanRowView): Record<string, unknown> {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    amount_cents: r.amount_cents,
    credits: r.credits,
    sort_order: r.sort_order,
    enabled: r.enabled,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

// ─── GET /api/admin/plans ──────────────────────────────────────────

export async function handleAdminListPlans(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listPlans();
  sendJson(res, 200, { rows: rows.map(serializePlan) });
}

// ─── PATCH /api/admin/plans/:code ──────────────────────────────────

export async function handleAdminPatchPlan(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const code = extractTailSlug(url, "/api/admin/plans/", /^[A-Za-z0-9_-]{1,64}$/);

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: PatchPlanInput = {};
  if (b.label !== undefined) {
    if (typeof b.label !== "string") {
      throw new HttpError(400, "VALIDATION", "label must be string", {
        issues: [{ path: "label", message: String(b.label) }],
      });
    }
    patch.label = b.label;
  }
  if (b.amount_cents !== undefined) {
    if (typeof b.amount_cents !== "string" && typeof b.amount_cents !== "number") {
      throw new HttpError(400, "VALIDATION", "amount_cents must be string or number");
    }
    patch.amount_cents = b.amount_cents;
  }
  if (b.credits !== undefined) {
    if (typeof b.credits !== "string" && typeof b.credits !== "number") {
      throw new HttpError(400, "VALIDATION", "credits must be string or number");
    }
    patch.credits = b.credits;
  }
  if (b.sort_order !== undefined) {
    if (typeof b.sort_order !== "number" || !Number.isInteger(b.sort_order)) {
      throw new HttpError(400, "VALIDATION", "sort_order must be integer");
    }
    patch.sort_order = b.sort_order;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    }
    patch.enabled = b.enabled;
  }

  try {
    const r = await patchPlan(code, patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { plan: serializePlan(r) });
  } catch (err) {
    if (err instanceof PlanNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}
