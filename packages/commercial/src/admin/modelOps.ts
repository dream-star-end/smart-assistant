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
  STATIC_KEY_PROVIDERS,
  findRouteProviderForModel,
} from "@openclaude/protocol";
import { STATIC_PROVIDER_META } from "../http/proxy/staticProviderMeta.js";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";

export const EFFORT_ENUM = ["low", "medium", "high", "xhigh", "max"] as const;
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
  const p = findRouteProviderForModel(modelId);
  if (!p) return { applicable: true, allowed: EFFORT_ENUM };
  if (p.allowedOutputConfigEfforts) {
    return { applicable: true, allowed: [...p.allowedOutputConfigEfforts] };
  }
  if (p.stripBodyFields.includes("output_config")) {
    return { applicable: false, allowed: [] };
  }
  return { applicable: true, allowed: EFFORT_ENUM };
}

// ─── provider 派生枚举 ───────────────────────────────────────────────

/** codex 虚拟条目 id(gpt-5.5,OAuth 账号池 + 容器 loopback relay,不走静态 key)。 */
export const CODEX_PROVIDER_ID = "codex";

const PROVIDER_DEFAULT_DISPLAY: Record<string, string> = {
  deepseek: "DeepSeek 官方",
  minimax: "火山方舟 Agent Plan(MiniMax)",
  ark: "火山方舟 Coding Plan(GLM)",
  opencodego: "OpenCode Go(Zen 网关)",
  kimi: "火山方舟 Agent Plan(Kimi)",
  [CODEX_PROVIDER_ID]: "ChatGPT 订阅(Codex / gpt-5.5)",
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
  ops_updated_at: string | null;
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
  updated_at: Date;
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
    `SELECT provider_id, display_name, subscription_expires_at, notes, updated_at
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
      ops_updated_at: opsRow?.updated_at.toISOString() ?? null,
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

  await tx(async (client: PoolClient) => {
    const before = await client.query<OpsRow>(
      `SELECT provider_id, display_name, subscription_expires_at, notes, updated_at
         FROM provider_ops WHERE provider_id = $1 FOR UPDATE`,
      [id],
    );
    const b = before.rows[0];
    const next = {
      display_name: displayName !== undefined ? displayName : (b?.display_name ?? null),
      subscription_expires_at: expiry !== undefined ? expiry : (b?.subscription_expires_at ?? null),
      notes: notes !== undefined ? notes : (b?.notes ?? null),
    };
    await client.query(
      `INSERT INTO provider_ops (provider_id, display_name, subscription_expires_at, notes, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, NOW(), $5::bigint)
       ON CONFLICT (provider_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         subscription_expires_at = EXCLUDED.subscription_expires_at,
         notes = EXCLUDED.notes,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by`,
      [id, next.display_name, next.subscription_expires_at, next.notes, String(ctx.adminId)],
    );
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "provider_ops.put",
      target: `provider:${id}`,
      before: {
        display_name: b?.display_name ?? null,
        subscription_expires_at: b?.subscription_expires_at?.toISOString() ?? null,
        notes: b?.notes ?? null,
      },
      after: {
        display_name: next.display_name,
        subscription_expires_at: next.subscription_expires_at?.toISOString?.() ?? null,
        notes: next.notes,
      },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  });
}
