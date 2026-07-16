/**
 * admin「模型与服务商」运维页 — 业务层(0105)。
 *
 * 设计要点(Codex 方案评审吸收):
 * - **服务商枚举的单一权威 = protocol STATIC_KEY_PROVIDERS(+ codex 虚拟条目)**。
 *   provider_ops 表稀疏,只存可编辑运维字段(到期时间/备注/显示名),首次 PUT 才建行,
 *   GET 派生左联 —— 新增静态 provider 时本页零迁移零种子,不会漂移出第二份清单。
 * - 延迟样本是 **transport 延迟**语义(网络路径+TLS+服务端首响,egress 探测器写入),
 *   不代表订阅健康、不代表模型 TTFT(后者看 health tab 的 anthropic_proxy_ttft 直方图)。
 * - effort 适用性按 protocol spec 推导,见 effortMetaForModel —— 不维护手工清单。
 */

import type { PoolClient } from "pg";
import {
  PLATFORM_REASONING_EFFORTS,
  STATIC_KEY_PROVIDERS,
  modelReasoningPolicy,
} from "@openclaude/protocol";
import { STATIC_PROVIDER_META } from "../http/proxy/staticProviderMeta.js";
import { query, tx } from "../db/queries.js";
import { providerDegradedKey } from "../selfheal/conditionKeys.js";
import { rootLogger } from "../logging/logger.js";
import { transitionRuleState } from "./alertOutbox.js";
import { writeAdminAudit } from "./audit.js";
import { effectiveHealth, type HealthMode } from "./providerHealth.js";

export const EFFORT_ENUM = PLATFORM_REASONING_EFFORTS;
export type EffortLevel = (typeof EFFORT_ENUM)[number];

/**
 * per-model 思考深度适用性(protocol spec 推导,无手工清单):
 * - 非静态路由(OAuth/codex,gpt-5.5 等):output_config 透传上游 → 全枚举可配
 * - 静态且声明 allowedOutputConfigEfforts(ark glm):只许白名单档位
 * - 静态且 strip output_config(minimax/opencodego/kimi 等 capability-zero):不适用
 * - 静态且不 strip(deepseek):透传 → 全枚举可配
 */
export function effortMetaForModel(modelId: string): {
  applicable: boolean;
  allowed: readonly string[];
} {
  const policy = modelReasoningPolicy(modelId);
  return { applicable: policy.supported.length > 0, allowed: policy.supported };
}

// ─── provider 派生枚举 ───────────────────────────────────────────────

/** codex 虚拟条目 id(GPT-5.6,OAuth 账号池 + 容器 loopback relay,不走静态 key)。 */
export const CODEX_PROVIDER_ID = "codex";

const PROVIDER_DEFAULT_DISPLAY: Record<string, string> = {
  deepseek: "DeepSeek 官方",
  minimax: "火山方舟 Agent Plan(MiniMax)",
  ark: "火山方舟 Coding Plan(GLM)",
  opencodego: "OpenCode Go(Zen 网关)",
  kimi: "火山方舟 Agent Plan(Kimi)",
  [CODEX_PROVIDER_ID]: "ChatGPT 订阅(Codex / GPT-5.6)",
};

export function opsProviderIds(): string[] {
  return [...STATIC_KEY_PROVIDERS.map((p) => p.id), CODEX_PROVIDER_ID];
}

export interface ProviderOpsView {
  id: string;
  display_name: string;
  endpoint: string;
  egress: string;
  keyConfigured: boolean;
  probeEnabled: boolean;
  subscription_expires_at: string | null;
  notes: string | null;
  /** 0106 — 服务商并发上限(订阅规格手填,展示/利用率用,不做请求期强制)。 */
  concurrency_limit: number | null;
  ops_updated_at: string | null;
  /** 0108 — 健康度(生效派生 = effectiveHealth,单一口径;badge/gate/注解全用它)。 */
  health: {
    /** 生效状态(forced_* 或 auto+observed):degraded → badge 红 + 禁选 + (enforce)503。 */
    effective: "healthy" | "degraded";
    /** 生效策略三态。 */
    mode: HealthMode;
    /** scheduler 观测判定(与 mode 分离,forced 时供 admin 看真相 vs 强制)。 */
    observed: "healthy" | "degraded";
    /** degraded 起始(healthy 为 null)。 */
    since: string | null;
    /** 降级理由(healthy 为 null)。 */
    reason: string | null;
  };
  latest: {
    probed_at: string;
    latency_ms: number;
    ok: boolean;
    status_code: number | null;
    error: string | null;
  } | null;
  samples: Array<{ probed_at: string; latency_ms: number; ok: boolean }>;
}

type OpsRow = {
  provider_id: string;
  display_name: string | null;
  subscription_expires_at: Date | null;
  notes: string | null;
  concurrency_limit: number | null;
  updated_at: Date;
  // 0108 健康列
  health_status: string | null;
  health_mode: string | null;
  degraded_since: Date | null;
  degrade_reason: string | null;
};

type SampleRow = {
  provider_id: string;
  probed_at: Date;
  latency_ms: number;
  ok: boolean;
  status_code: number | null;
  error: string | null;
};

const SAMPLES_PER_PROVIDER = 48;

export async function listProvidersOverview(
  keyConfigured: Record<string, boolean>,
): Promise<ProviderOpsView[]> {
  const ops = await query<OpsRow>(
    `SELECT provider_id, display_name, subscription_expires_at, notes, concurrency_limit, updated_at,
            health_status, health_mode, degraded_since, degrade_reason
       FROM provider_ops`,
  );
  const opsById = new Map(ops.rows.map((r) => [r.provider_id, r]));

  const samples = await query<SampleRow>(
    `SELECT provider_id, probed_at, latency_ms, ok, status_code, error FROM (
       SELECT *, row_number() OVER (PARTITION BY provider_id ORDER BY probed_at DESC) AS rn
         FROM provider_latency_samples
     ) t WHERE rn <= $1 ORDER BY provider_id, probed_at ASC`,
    [SAMPLES_PER_PROVIDER],
  );
  const samplesById = new Map<string, SampleRow[]>();
  for (const s of samples.rows) {
    const arr = samplesById.get(s.provider_id) ?? [];
    arr.push(s);
    samplesById.set(s.provider_id, arr);
  }

  const out: ProviderOpsView[] = [];
  for (const id of opsProviderIds()) {
    const isCodex = id === CODEX_PROVIDER_ID;
    const spec = isCodex ? undefined : STATIC_KEY_PROVIDERS.find((p) => p.id === id);
    const meta = isCodex ? undefined : STATIC_PROVIDER_META[id as keyof typeof STATIC_PROVIDER_META];
    const opsRow = opsById.get(id);
    const providerSamples = samplesById.get(id) ?? [];
    const last = providerSamples.length > 0 ? providerSamples[providerSamples.length - 1] : undefined;
    const eff = effectiveHealth({
      health_status:
        opsRow?.health_status === "degraded" || opsRow?.health_status === "healthy"
          ? opsRow.health_status
          : null,
      health_mode: (opsRow?.health_mode as HealthMode) ?? "auto",
      degraded_since: opsRow?.degraded_since ?? null,
      degrade_reason: opsRow?.degrade_reason ?? null,
      ops_updated_at: opsRow?.updated_at ?? null,
    });
    out.push({
      id,
      display_name: opsRow?.display_name ?? PROVIDER_DEFAULT_DISPLAY[id] ?? id,
      endpoint: isCodex
        ? "chatgpt.com/backend-api/codex(容器 loopback relay → 账号绑定代理)"
        : spec!.upstreamEndpoint,
      egress: isCodex ? "proxy" : meta!.egress,
      keyConfigured: keyConfigured[id] ?? false,
      probeEnabled: !isCodex,
      subscription_expires_at: opsRow?.subscription_expires_at?.toISOString() ?? null,
      notes: opsRow?.notes ?? null,
      concurrency_limit: opsRow?.concurrency_limit ?? null,
      ops_updated_at: opsRow?.updated_at.toISOString() ?? null,
      health: {
        effective: eff.degraded ? "degraded" : "healthy",
        mode: eff.mode,
        observed: eff.observed,
        since: eff.since,
        reason: eff.reason,
      },
      latest: last
        ? {
            probed_at: last.probed_at.toISOString(),
            latency_ms: last.latency_ms,
            ok: last.ok,
            status_code: last.status_code,
            error: last.error,
          }
        : null,
      samples: providerSamples.map((s) => ({
        probed_at: s.probed_at.toISOString(),
        latency_ms: s.latency_ms,
        ok: s.ok,
      })),
    });
  }
  return out;
}

// ─── 用量聚合(0106 容量面) ───────────────────────────────────────────

export interface ModelUsageWindow {
  /** Journal terminal attempts (single authority; includes failures/cancels). */
  attempts: number;
  /** Successful terminal attempts. Kept as `requests` for API compatibility. */
  requests: number;
  failures: number;
  cancellations: number;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  credits: string;
}

export interface ModelUsageAgg {
  d1: ModelUsageWindow;
  d7: ModelUsageWindow;
}

type UsageAggRow = {
  model: string;
  attempts_1d: string; req_1d: string; failures_1d: string; cancellations_1d: string;
  in_1d: string; out_1d: string; cache_1d: string; credits_1d: string;
  attempts_7d: string; req_7d: string; failures_7d: string; cancellations_7d: string;
  in_7d: string; out_7d: string; cache_7d: string; credits_7d: string;
};

/**
 * per-model 24h/7d attempt 聚合。request_finalize_journal 终态是唯一请求
 * 事实源；usage_records 只按 journal.usage_id 补 token/积分，绝不 UNION 后
 * 重复计算 committed 请求。BIGINT 一律 ::text 防 JS 精度丢失。
 */
export async function listModelUsageAggregates(): Promise<Record<string, ModelUsageAgg>> {
  const r = await query<UsageAggRow>(
    `WITH classified AS (
       SELECT rfj.*,
              ur.id AS joined_usage_id,
              ur.model AS usage_model,
              ur.status AS usage_status,
              ur.input_tokens,
              ur.output_tokens,
              ur.cache_read_tokens,
              ur.cost_credits,
              CASE
                WHEN (rfj.state='aborted'
                       AND rfj.failure_code IN ('CLIENT_ABORT','USER_CANCELLED'))
                  OR (rfj.state='committed'
                       AND ur.price_snapshot->>'codex_terminal_code'='USER_CANCELLED')
                  THEN 'cancelled'
                WHEN rfj.state='committed'
                  AND ur.id IS NOT NULL
                  AND ur.status='success'
                  AND COALESCE(ur.output_tokens,0)>0
                  AND COALESCE(ur.price_snapshot->>'codex_status','success')<>'error'
                  AND COALESCE(ur.price_snapshot->>'waived','')<>'no_output' THEN 'success'
                ELSE 'failure'
              END AS terminal_outcome
         FROM request_finalize_journal rfj
         LEFT JOIN usage_records ur ON ur.id=rfj.usage_id
        WHERE rfj.created_at > NOW() - interval '7 days'
          AND rfj.state IN ('committed','aborted')
     )
     SELECT COALESCE(ctx->>'model', usage_model, 'unknown') AS model,
       COUNT(*) FILTER (WHERE rfj.created_at > NOW() - interval '24 hours')::text AS attempts_1d,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '24 hours' AND terminal_outcome='success')::text AS req_1d,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '24 hours' AND terminal_outcome='failure')::text AS failures_1d,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '24 hours' AND terminal_outcome='cancelled')::text AS cancellations_1d,
       COALESCE(SUM(input_tokens)      FILTER (WHERE created_at > NOW() - interval '24 hours'), 0)::text AS in_1d,
       COALESCE(SUM(output_tokens)     FILTER (WHERE created_at > NOW() - interval '24 hours'), 0)::text AS out_1d,
       COALESCE(SUM(cache_read_tokens) FILTER (WHERE created_at > NOW() - interval '24 hours'), 0)::text AS cache_1d,
       COALESCE(SUM(cost_credits)      FILTER (WHERE created_at > NOW() - interval '24 hours'), 0)::text AS credits_1d,
       COUNT(*)::text AS attempts_7d,
       COUNT(*) FILTER (WHERE terminal_outcome='success')::text AS req_7d,
       COUNT(*) FILTER (WHERE terminal_outcome='failure')::text AS failures_7d,
       COUNT(*) FILTER (WHERE terminal_outcome='cancelled')::text AS cancellations_7d,
       COALESCE(SUM(input_tokens), 0)::text AS in_7d,
       COALESCE(SUM(output_tokens), 0)::text AS out_7d,
       COALESCE(SUM(cache_read_tokens), 0)::text AS cache_7d,
       COALESCE(SUM(cost_credits), 0)::text AS credits_7d
     FROM classified rfj
     GROUP BY COALESCE(ctx->>'model', usage_model, 'unknown')`,
  );
  const out: Record<string, ModelUsageAgg> = {};
  for (const row of r.rows) {
    out[row.model] = {
      d1: {
        attempts: Number(row.attempts_1d),
        requests: Number(row.req_1d),
        failures: Number(row.failures_1d),
        cancellations: Number(row.cancellations_1d),
        input_tokens: row.in_1d,
        output_tokens: row.out_1d,
        cache_read_tokens: row.cache_1d,
        credits: row.credits_1d,
      },
      d7: {
        attempts: Number(row.attempts_7d),
        requests: Number(row.req_7d),
        failures: Number(row.failures_7d),
        cancellations: Number(row.cancellations_7d),
        input_tokens: row.in_7d,
        output_tokens: row.out_7d,
        cache_read_tokens: row.cache_7d,
        credits: row.credits_7d,
      },
    };
  }
  return out;
}

// ─── PUT /api/admin/providers/:id ───────────────────────────────────

export class UnknownProviderError extends Error {
  constructor(id: string) {
    super(`unknown provider: ${id}`);
    this.name = "UnknownProviderError";
  }
}

export interface PutProviderOpsInput {
  subscription_expires_at?: string | null;
  notes?: string | null;
  display_name?: string | null;
  /** 0106 — null=清除;正整数 1..100000(展示/利用率语义,非限流)。 */
  concurrency_limit?: number | null;
  /** 0108 — 健康生效策略:auto(scheduler 自动)/ forced_degraded / forced_healthy。 */
  health_mode?: HealthMode;
}

export interface PutProviderOpsCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

function normalizeExpiry(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new RangeError("invalid_subscription_expires_at");
  return d;
}

function normalizeConcurrencyLimit(v: number | null | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 1 || v > 100_000) throw new RangeError("invalid_concurrency_limit");
  return v;
}

const HEALTH_MODES: readonly HealthMode[] = ["auto", "forced_degraded", "forced_healthy"];
function normalizeHealthMode(v: HealthMode | undefined): HealthMode | undefined {
  if (v === undefined) return undefined;
  if (!HEALTH_MODES.includes(v)) throw new RangeError("invalid_health_mode");
  return v;
}

function normalizeText(v: string | null | undefined, max: number, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new RangeError(`invalid_${field}`);
  const t = v.trim();
  if (t === "") return null;
  if (t.length > max) throw new RangeError(`${field}_too_long`);
  return t;
}

/**
 * 稀疏 upsert:行不存在则建,存在则只覆盖本次提供的字段。同事务写 admin_audit。
 */
export async function putProviderOps(
  id: string,
  input: PutProviderOpsInput,
  ctx: PutProviderOpsCtx,
): Promise<void> {
  if (!opsProviderIds().includes(id)) throw new UnknownProviderError(id);
  const expiry = normalizeExpiry(input.subscription_expires_at);
  const notes = normalizeText(input.notes, 2000, "notes");
  const displayName = normalizeText(input.display_name, 128, "display_name");
  const concurrencyLimit = normalizeConcurrencyLimit(input.concurrency_limit);
  const healthMode = normalizeHealthMode(input.health_mode);

  const prevHealthMode = await tx(async (client: PoolClient) => {
    const before = await client.query<OpsRow>(
      `SELECT provider_id, display_name, subscription_expires_at, notes, concurrency_limit, updated_at, health_mode
         FROM provider_ops WHERE provider_id = $1 FOR UPDATE`,
      [id],
    );
    const b = before.rows[0];
    // 注:health_status / degraded_since / degrade_reason 是 scheduler 权威,putProviderOps 只
    // 写 health_mode(三态策略);forced_* 的降级展示由 effectiveHealth 派生,无需在此写观测列。
    const next = {
      display_name: displayName !== undefined ? displayName : (b?.display_name ?? null),
      subscription_expires_at: expiry !== undefined ? expiry : (b?.subscription_expires_at ?? null),
      notes: notes !== undefined ? notes : (b?.notes ?? null),
      concurrency_limit:
        concurrencyLimit !== undefined ? concurrencyLimit : (b?.concurrency_limit ?? null),
      health_mode: healthMode !== undefined ? healthMode : ((b?.health_mode as HealthMode) ?? "auto"),
    };
    await client.query(
      `INSERT INTO provider_ops (provider_id, display_name, subscription_expires_at, notes, concurrency_limit, health_mode, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7::bigint)
       ON CONFLICT (provider_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         subscription_expires_at = EXCLUDED.subscription_expires_at,
         notes = EXCLUDED.notes,
         concurrency_limit = EXCLUDED.concurrency_limit,
         health_mode = EXCLUDED.health_mode,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by`,
      [id, next.display_name, next.subscription_expires_at, next.notes, next.concurrency_limit, next.health_mode, String(ctx.adminId)],
    );
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "provider_ops.put",
      target: `provider:${id}`,
      before: {
        display_name: b?.display_name ?? null,
        subscription_expires_at: b?.subscription_expires_at?.toISOString() ?? null,
        notes: b?.notes ?? null,
        concurrency_limit: b?.concurrency_limit ?? null,
        health_mode: (b?.health_mode as HealthMode) ?? "auto",
      },
      after: {
        display_name: next.display_name,
        subscription_expires_at: next.subscription_expires_at?.toISOString?.() ?? null,
        notes: next.notes,
        concurrency_limit: next.concurrency_limit,
        health_mode: next.health_mode,
      },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return (b?.health_mode as HealthMode) ?? "auto";
  });

  // 健康裁定必须传导到 condition 层(admin_alert_rule_state):scheduler 在 forced_* 模式下
  // 不再评估/转移,firing 会冻结在裁定前的旧值;而 incident 投影(reconciler)是 level-triggered
  // 只看 condition —— 不传导则 forced_healthy 后降级 incident 悬挂、用户端"服务降级"横幅永不撤。
  // condition 写失败不回滚运维写(告警面故障不应阻塞 admin 操作),warn 留证即可;
  // 切回 auto 不在此强写 condition,交还 scheduler 按观测重新判定。
  if (healthMode !== undefined && healthMode !== prevHealthMode) {
    try {
      if (healthMode === "forced_healthy") {
        await transitionRuleState(providerDegradedKey(id), false, null, {
          provider_id: id,
          reason: "管理员强制恢复(forced_healthy)",
          forced_by_admin: String(ctx.adminId),
        });
      } else if (healthMode === "forced_degraded") {
        await transitionRuleState(providerDegradedKey(id), true, providerDegradedKey(id), {
          provider_id: id,
          reason: "管理员强制降级(forced_degraded)",
          forced_by_admin: String(ctx.adminId),
        });
      }
    } catch (err) {
      rootLogger.warn("provider_ops health_mode condition propagation failed", {
        provider: id,
        health_mode: healthMode,
        err: String((err as Error)?.message ?? err),
      });
    }
  }
}
