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
  listModelUsageAggregates,
  putProviderOps,
  effortMetaForModel,
  UnknownProviderError,
  CODEX_PROVIDER_ID,
  type PutProviderOpsInput,
  type ModelUsageWindow,
} from "../../admin/modelOps.js";
import { invalidateDegradedProvidersCache } from "../../admin/providerHealthGate.js";
import { snapshotInflight, type InflightSnapshot } from "../proxy/inflightTracker.js";
import {
  ocGatewayIpForChannel,
  ocInternalProxyPortForChannel,
} from "../../agent-sandbox/v3supervisor.js";
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
    minimax: !!c.MINIMAX_TOKEN_PLAN_KEY,
    ark: !!c.ARK_CODING_PLAN_KEY,
    opencodego: !!c.OPENCODE_GO_API_KEY,
    kimi: !!c.ARK_AGENT_PLAN_KEY,
    // codex 走 OAuth 账号池(claude_accounts runtime_channel='v5'),不依赖静态 env key;
    // 这里恒 true 表示"env key 形态不适用"(池水位在 accounts tab 看)。
    [CODEX_PROVIDER_ID]: true,
  };
}

// ─── 0106 容量面:在飞快照获取 ───────────────────────────────────────
//
// v5 拓扑下 /v1/messages 由 egress 进程独占 → egress 的计数是权威;master 经内网
// /internal/v5/egress-stats 拉取(地址用与 egress bind **同一推导函数**,不猜 env)。
// egress split 未开或拉取失败 → fail-soft 回落本进程快照并标注 source。

interface StatsResult {
  by_model: InflightSnapshot["by_model"];
  source: "egress" | "local" | "local_fallback";
  started_at: string;
}

async function fetchInflightStats(): Promise<StatsResult> {
  const local = (source: StatsResult["source"]): StatsResult => {
    const snap = snapshotInflight();
    return { by_model: snap.by_model, source, started_at: snap.started_at };
  };
  if (process.env.OC_EGRESS_SPLIT !== "1") return local("local");
  // 地址推导与 egress bind 用同一权威函数(内部按 OC_RUNTIME_CHANNEL 判定),不猜 env。
  const url = `http://${ocGatewayIpForChannel()}:${ocInternalProxyPortForChannel()}/internal/v5/egress-stats`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return local("local_fallback");
    const j = (await res.json()) as { inflight?: InflightSnapshot };
    if (!j?.inflight?.by_model) return local("local_fallback");
    return { by_model: j.inflight.by_model, source: "egress", started_at: j.inflight.started_at };
  } catch {
    return local("local_fallback");
  }
}

const ZERO_WINDOW: ModelUsageWindow = {
  requests: 0,
  input_tokens: "0",
  output_tokens: "0",
  cache_read_tokens: "0",
  credits: "0",
};

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
  const [rows, providersBase, usageAgg, stats] = await Promise.all([
    listPricing(),
    listProvidersOverview(keyConfiguredMap()),
    listModelUsageAggregates(),
    fetchInflightStats(),
  ]);
  const models = rows.map((r) => ({
    ...serializePricing(r),
    provider: { id: providerIdForModel(r.model_id) },
    effort: effortMetaForModel(r.model_id),
    inflight: stats.by_model[r.model_id] ?? null,
    usage: usageAgg[r.model_id] ?? { d1: ZERO_WINDOW, d7: ZERO_WINDOW },
  }));
  // provider 级汇总:当前并发合计(含 pricing 表以外的历史模型,按路由归属)+ 24h 用量。
  const inflightByProvider = new Map<string, number>();
  for (const [model, v] of Object.entries(stats.by_model)) {
    const pid = providerIdForModel(model);
    inflightByProvider.set(pid, (inflightByProvider.get(pid) ?? 0) + v.current);
  }
  const usageByProvider = new Map<string, { requests: number; tokens: bigint; credits: bigint }>();
  for (const [model, agg] of Object.entries(usageAgg)) {
    const pid = providerIdForModel(model);
    const cur = usageByProvider.get(pid) ?? { requests: 0, tokens: 0n, credits: 0n };
    cur.requests += agg.d1.requests;
    cur.tokens += BigInt(agg.d1.input_tokens) + BigInt(agg.d1.output_tokens);
    cur.credits += BigInt(agg.d1.credits);
    usageByProvider.set(pid, cur);
  }
  const providers = providersBase.map((p) => {
    const u = usageByProvider.get(p.id);
    return {
      ...p,
      inflight_current: inflightByProvider.get(p.id) ?? 0,
      usage_d1: {
        requests: u?.requests ?? 0,
        tokens: (u?.tokens ?? 0n).toString(),
        credits: (u?.credits ?? 0n).toString(),
      },
    };
  });
  sendJson(res, 200, {
    models,
    providers,
    stats: { source: stats.source, started_at: stats.started_at },
  });
}

// ─── GET /api/admin/model-ops/stats(轻量,前端 30s 轮询) ─────────────

export async function handleAdminModelOpsStats(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const stats = await fetchInflightStats();
  sendJson(res, 200, stats);
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
  if (b.concurrency_limit !== undefined) {
    if (b.concurrency_limit !== null && typeof b.concurrency_limit !== "number") {
      throw new HttpError(400, "VALIDATION", "concurrency_limit must be number or null");
    }
    input.concurrency_limit = b.concurrency_limit as number | null;
  }
  if (b.health_mode !== undefined) {
    if (typeof b.health_mode !== "string") {
      throw new HttpError(400, "VALIDATION", "health_mode must be string");
    }
    // 具体枚举校验在 putProviderOps.normalizeHealthMode(RangeError → translateRangeError → 400)。
    input.health_mode = b.health_mode as PutProviderOpsInput["health_mode"];
  }

  try {
    await putProviderOps(id, input, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    // health_mode 改动即时生效:清本进程 gate 缓存(egress 进程按其 TTL 自然刷新)。
    invalidateDegradedProvidersCache();
  } catch (err) {
    if (err instanceof UnknownProviderError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
  const providers = await listProvidersOverview(keyConfiguredMap());
  sendJson(res, 200, { provider: providers.find((p) => p.id === id) ?? null });
}
