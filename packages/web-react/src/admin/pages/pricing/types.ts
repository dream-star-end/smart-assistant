// 模型与服务商运维页(model-ops)的共享类型 —— 与后端 serializePricing +
// listProvidersOverview + model-ops overview 附加字段严格对齐(见
// packages/commercial/src/http/admin/modelOps.ts、admin/modelOps.ts)。

export type UsageWindow = {
  requests: number;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  credits: string;
};

export type Inflight = { current: number; peak: number; peak_at: string | null };

export type ModelRowData = {
  model_id: string;
  display_name: string | null;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string;
  cache_write_per_mtok: string;
  multiplier: string;
  enabled: boolean;
  sort_order: number;
  updated_at: string;
  updated_by: string | null;
  visibility: string;
  extra_system_prompt: string | null;
  default_effort: string | null;
  lock_version: number;
  provider: { id: string };
  effort: { applicable: boolean; allowed: string[] };
  inflight: Inflight | null;
  usage: { d1: UsageWindow; d7: UsageWindow } | null;
};

export type HealthMode = "auto" | "forced_degraded" | "forced_healthy";

export type ProviderData = {
  id: string;
  display_name: string;
  endpoint: string;
  egress: string;
  keyConfigured: boolean;
  probeEnabled: boolean;
  subscription_expires_at: string | null;
  notes: string | null;
  concurrency_limit: number | null;
  ops_updated_at: string | null;
  health: {
    effective: "healthy" | "degraded";
    mode: HealthMode;
    observed: "healthy" | "degraded";
    since: string | null;
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
  inflight_current: number;
  usage_d1: { requests: number; tokens: string; credits: string };
};

export type ModelOpsResp = {
  models: ModelRowData[];
  providers: ProviderData[];
  stats: { source: string; started_at: string };
};

export type StatsResp = {
  by_model: Record<string, Inflight>;
  source: string;
  started_at: string;
};

export const PRICE_FIELDS = [
  ["input_per_mtok", "输入价"],
  ["output_per_mtok", "输出价"],
  ["cache_read_per_mtok", "缓存读"],
  ["cache_write_per_mtok", "缓存写"],
] as const;
export type PriceField = (typeof PRICE_FIELDS)[number][0];

export const VISIBILITY_OPTIONS = [
  { value: "public", label: "public(所有人)" },
  { value: "admin", label: "admin(仅超管)" },
  { value: "hidden", label: "hidden(隐藏)" },
] as const;
