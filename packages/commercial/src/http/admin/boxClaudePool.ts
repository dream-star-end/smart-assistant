/**
 * OCV5-424 — the Box Claude group of the admin 服务池 page.
 *
 * Box Claude runs on the Claude Code logins inside a Cursor Box (box_claude_profiles),
 * not on the subscription accounts table, so the generic pool adapters never list it.
 * This view shows the two routes (A: box-api-claude-* via `claude -p`, B: box-claude-*
 * via an interactive Claude Code), which models are on, the live in-flight count per
 * model, the capacity caps, and each login's 5-hour / weekly quota as the Box CLI last
 * reported it. Read-only: it never touches a Box or its credential files.
 */
import { BOX_API_MODELS } from "@openclaude/protocol";
import { query } from "../../db/queries.js";
import { resolveBoxCapacityPolicy } from "../proxy/boxCapacityPolicy.js";
import { listBoxProfileQuotas, listBoxProfiles, type BoxProfileQuota, type BoxProfileRow } from "../proxy/boxClaudeProfileStore.js";
import { isMaskedEmail } from "../proxy/boxProfileDiscovery.js";
import { fetchInflightStats, type StatsResult } from "./modelOps.js";

export interface BoxClaudeModelView {
  id: string;
  upstream_model: string;
  /** model_pricing.enabled (null: no pricing row). */
  enabled: boolean | null;
  visibility: string | null;
  /** model_catalog state of the active-or-latest entry (null: not in the catalog). */
  catalog_state: string | null;
  engine: string | null;
  provider: string | null;
  inflight: { current: number; peak: number } | null;
}

export interface BoxClaudeRouteView {
  key: "A" | "B";
  runner: "print" | "interactive";
  models: BoxClaudeModelView[];
}

export interface BoxQuotaWindowView { used: number; resets_at: string | null }

export interface BoxClaudeLoginView {
  account_id: string;
  profile: string;
  enabled: boolean;
  is_default: boolean;
  login_state: string;
  email_hint: string | null;
  /** Highest window utilization 0..1 (pre-0309 rows only have this). */
  utilization: number | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  health_updated_at: string | null;
  quota: { five_hour: BoxQuotaWindowView | null; weekly: BoxQuotaWindowView | null; reason: string | null };
}

export interface BoxClaudeView {
  routes: BoxClaudeRouteView[];
  caps: { max_runs_per_account: number; max_runs_per_user: number; proxy_concurrency: number | null; proxy_rate_per_minute: number | null };
  inflight_source: StatsResult["source"] | "unavailable";
  logins: BoxClaudeLoginView[];
}

export const BOX_QUOTA_REASON_NO_DATA = "尚无数据：额度由 Box 内 Claude CLI 在每次运行时上报，该登录下次被使用后出现";
export const BOX_QUOTA_REASON_NOT_SCHEDULED = "登录未参与调度，不会被使用，额度不更新";
export const BOX_QUOTA_REASON_NOT_LOGGED_IN = "登录未完成，无法上报额度";

function windowView(used: number | null, resetsAt: Date | null): BoxQuotaWindowView | null {
  return used === null ? null : { used, resets_at: resetsAt?.toISOString() ?? null };
}

export function loginView(row: BoxProfileRow, quota: BoxProfileQuota | undefined, nowMs = Date.now()): BoxClaudeLoginView {
  const cooling = row.cooldownUntil !== null && row.cooldownUntil.getTime() > nowMs;
  const fiveHour = quota ? windowView(quota.quota5h, quota.quota5hResetsAt) : null;
  const weekly = quota ? windowView(quota.quota7d, quota.quota7dResetsAt) : null;
  let reason: string | null = null;
  if (!fiveHour && !weekly) {
    reason = row.loginState !== "logged_in" ? BOX_QUOTA_REASON_NOT_LOGGED_IN
      : !row.enabled ? BOX_QUOTA_REASON_NOT_SCHEDULED
      : row.utilization !== null
        ? `仅有合并值：最高窗口已用 ${Math.round(row.utilization * 100)}%（分窗口数据在该登录下次被使用后出现）`
        : BOX_QUOTA_REASON_NO_DATA;
  }
  return {
    account_id: row.accountId.toString(),
    profile: row.profile,
    enabled: row.enabled,
    is_default: row.isDefault,
    login_state: row.loginState,
    email_hint: isMaskedEmail(row.emailHint) ? row.emailHint : null,
    utilization: row.utilization,
    cooldown_until: cooling ? row.cooldownUntil!.toISOString() : null,
    cooldown_reason: cooling ? row.lastReason : null,
    health_updated_at: row.healthUpdatedAt?.toISOString() ?? null,
    quota: { five_hour: fiveHour, weekly, reason },
  };
}

async function modelRows(): Promise<{ pricing: Map<string, { enabled: boolean; visibility: string }>; catalog: Map<string, { state: string; engine: string; provider: string }> }> {
  const ids = BOX_API_MODELS.map((m) => m.id);
  const pricing = new Map<string, { enabled: boolean; visibility: string }>();
  const catalog = new Map<string, { state: string; engine: string; provider: string }>();
  try {
    const p = await query<{ model_id: string; enabled: boolean; visibility: string }>(
      "SELECT model_id, enabled, visibility FROM model_pricing WHERE model_id = ANY($1::text[])", [ids]);
    for (const r of p.rows) pricing.set(r.model_id, { enabled: r.enabled, visibility: r.visibility });
  } catch { /* informational */ }
  try {
    // The active entry wins; otherwise the newest one says why the model is not live.
    const c = await query<{ model_id: string; state: string; engine: string; provider_id: string }>(
      `SELECT DISTINCT ON (model_id) model_id, state, engine, provider_id FROM model_catalog
        WHERE model_id = ANY($1::text[]) ORDER BY model_id, (state = 'active') DESC, updated_at DESC`, [ids]);
    for (const r of c.rows) catalog.set(r.model_id, { state: r.state, engine: r.engine, provider: r.provider_id });
  } catch { /* informational */ }
  return { pricing, catalog };
}

export async function collectBoxClaude(
  inflight: () => Promise<StatsResult> = fetchInflightStats,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BoxClaudeView> {
  const [{ pricing, catalog }, stats, rows, quotas] = await Promise.all([
    modelRows(),
    inflight().catch(() => null),
    listBoxProfiles().catch(() => [] as BoxProfileRow[]),
    listBoxProfileQuotas().catch(() => [] as BoxProfileQuota[]),
  ]);
  const model = (m: (typeof BOX_API_MODELS)[number]): BoxClaudeModelView => {
    const p = pricing.get(m.id);
    const c = catalog.get(m.id);
    const s = stats?.by_model[m.id];
    return {
      id: m.id, upstream_model: m.upstreamModel,
      enabled: p?.enabled ?? null, visibility: p?.visibility ?? null,
      catalog_state: c?.state ?? null, engine: c?.engine ?? null, provider: c?.provider ?? null,
      inflight: stats ? { current: s?.current ?? 0, peak: s?.peak ?? 0 } : null,
    };
  };
  const caps = resolveBoxCapacityPolicy(env);
  const quotaOf = (r: BoxProfileRow) => quotas.find((q) => q.accountId === r.accountId && q.profile === r.profile);
  return {
    routes: [
      { key: "A", runner: "print", models: BOX_API_MODELS.filter((m) => m.runner === "print").map(model) },
      { key: "B", runner: "interactive", models: BOX_API_MODELS.filter((m) => m.runner === "interactive").map(model) },
    ],
    caps: {
      max_runs_per_account: caps.maxRunsPerAccount, max_runs_per_user: caps.maxRunsPerUser,
      proxy_concurrency: caps.proxyConcurrency, proxy_rate_per_minute: caps.proxyRatePerMinute,
    },
    inflight_source: stats?.source ?? "unavailable",
    logins: rows.map((r) => loginView(r, quotaOf(r))),
  };
}
