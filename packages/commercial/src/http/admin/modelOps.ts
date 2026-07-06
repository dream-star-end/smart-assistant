/**
 * /api/admin/model-ops + PUT /api/admin/providers/:id — 模型与服务商统一运维页(0105)。
 *
 * GET  model-ops:models(listPricing + provider 归属 chip + effort 适用性)
 *              + providers(protocol 注册表派生枚举 ⟕ 稀疏 provider_ops ⟕ 延迟样本)。
 * PUT  providers/:id:编辑 provider 运维字段(订阅到期/备注/显示名)。
 *
 * 鉴权:GET requireAdmin;PUT requireAdminVerifyDb(与 pricing.ts 同款分层)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import { listPricing } from "../../admin/pricing.js";
import { serializePricing } from "./pricing.js";
import {
  listProvidersOverview,
  putProviderOps,
  effortMetaForModel,
  UnknownProviderError,
  CODEX_PROVIDER_ID,
  type PutProviderOpsInput,
} from "../../admin/modelOps.js";
import { findRouteProviderForModel } from "@openclaude/protocol";
import { loadConfig } from "../../config.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { extractTailSlug, translateRangeError } from "./_shared.js";

// loadConfig 是纯函数(每次重新 parse env);admin 只读面按进程懒缓存一次即可。
let cfgCache: ReturnType<typeof loadConfig> | null = null;
function cfg(): ReturnType<typeof loadConfig> {
  cfgCache ??= loadConfig();
  return cfgCache;
}

function keyConfiguredMap(): Record<string, boolean> {
  const c = cfg();
  return {
    deepseek: !!c.DEEPSEEK_API_KEY,
    minimax: !!c.ARK_AGENT_PLAN_KEY,
    ark: !!c.ARK_CODING_PLAN_KEY,
    opencodego: !!c.OPENCODE_GO_API_KEY,
    kimi: !!c.ARK_AGENT_PLAN_KEY,
    // codex 走 OAuth 账号池(claude_accounts runtime_channel='v5'),不依赖静态 env key;
    // 这里恒 true 表示"env key 形态不适用"(池水位在 accounts tab 看)。
    [CODEX_PROVIDER_ID]: true,
  };
}

/** 模型 → 服务商归属 chip:静态路由按注册表;gpt-* → codex;其余 → oauth。 */
function providerIdForModel(modelId: string): string {
  const p = findRouteProviderForModel(modelId);
  if (p) return p.id;
  if (modelId.toLowerCase().startsWith("gpt-")) return CODEX_PROVIDER_ID;
  return "oauth";
}

// ─── GET /api/admin/model-ops ───────────────────────────────────────

export async function handleAdminModelOpsOverview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listPricing();
  const models = rows.map((r) => ({
    ...serializePricing(r),
    provider: { id: providerIdForModel(r.model_id) },
    effort: effortMetaForModel(r.model_id),
  }));
  const providers = await listProvidersOverview(keyConfiguredMap());
  sendJson(res, 200, { models, providers });
}

// ─── PUT /api/admin/providers/:id ───────────────────────────────────

export async function handleAdminPutProviderOps(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = extractTailSlug(url, "/api/admin/providers/", /^[a-z0-9_-]{1,32}$/);

  const body = (await readJsonBody(req)) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  const b = body as Record<string, unknown>;
  const input: PutProviderOpsInput = {};
  for (const f of ["subscription_expires_at", "notes", "display_name"] as const) {
    const v = b[f];
    if (v !== undefined) {
      if (v !== null && typeof v !== "string") {
        throw new HttpError(400, "VALIDATION", `${f} must be string or null`);
      }
      input[f] = v as string | null;
    }
  }

  try {
    await putProviderOps(id, input, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
  } catch (err) {
    if (err instanceof UnknownProviderError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
  const providers = await listProvidersOverview(keyConfiguredMap());
  sendJson(res, 200, { provider: providers.find((p) => p.id === id) ?? null });
}
