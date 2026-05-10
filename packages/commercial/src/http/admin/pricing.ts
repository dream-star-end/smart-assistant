/**
 * /api/admin/pricing — 模型定价管理(P-Pricing)。
 *
 * 两个端点:
 *   GET   /api/admin/pricing                列出全部模型定价(无分页)
 *   PATCH /api/admin/pricing/:model_id      修改 multiplier / enabled / extra_system_prompt
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
  listPricing,
  patchPricing,
  PricingNotFoundError,
  type ModelPricingRowView,
  type PatchPricingInput,
} from "../../admin/pricing.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { extractTailSlug, translateRangeError } from "./_shared.js";

function serializePricing(r: ModelPricingRowView): Record<string, unknown> {
  return {
    model_id: r.model_id,
    display_name: r.display_name,
    input_per_mtok: r.input_per_mtok,
    output_per_mtok: r.output_per_mtok,
    cache_read_per_mtok: r.cache_read_per_mtok,
    cache_write_per_mtok: r.cache_write_per_mtok,
    multiplier: r.multiplier,
    enabled: r.enabled,
    sort_order: r.sort_order,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
    visibility: r.visibility,
    extra_system_prompt: r.extra_system_prompt,
  };
}

// ─── GET /api/admin/pricing ────────────────────────────────────────

export async function handleAdminListPricing(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listPricing();
  sendJson(res, 200, { rows: rows.map(serializePricing) });
}

// ─── PATCH /api/admin/pricing/:model_id ─────────────────────────────

export async function handleAdminPatchPricing(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const modelId = extractTailSlug(url, "/api/admin/pricing/", /^[A-Za-z0-9._-]{1,64}$/);

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: PatchPricingInput = {};
  if (b.multiplier !== undefined) {
    if (typeof b.multiplier !== "string" && typeof b.multiplier !== "number") {
      throw new HttpError(400, "VALIDATION", "multiplier must be string or number", {
        issues: [{ path: "multiplier", message: String(b.multiplier) }],
      });
    }
    patch.multiplier = b.multiplier;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    }
    patch.enabled = b.enabled;
  }
  // 0060 — extra_system_prompt:undefined→不改;null/string→交给 normalizeExtraSystemPrompt 收口。
  // 这里只挡明显的非法类型(数组/对象/数字),细粒度长度校验在 normalize 层抛 RangeError → translateRangeError。
  if (b.extra_system_prompt !== undefined) {
    if (b.extra_system_prompt !== null && typeof b.extra_system_prompt !== "string") {
      throw new HttpError(400, "VALIDATION", "extra_system_prompt must be string or null");
    }
    patch.extra_system_prompt = b.extra_system_prompt;
  }

  try {
    const r = await patchPricing(modelId, patch, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { pricing: serializePricing(r) });
  } catch (err) {
    if (err instanceof PricingNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}
