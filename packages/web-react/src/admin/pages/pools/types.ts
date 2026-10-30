/** OCV5-424 /api/admin/pools 的前端类型与展示文案。 */

export type CooldownReason = "rate_limited" | "quota" | "auth" | "credential" | "upstream";

export interface PoolMember {
  service: string;
  memberKind: "account" | "relay_key" | "api_key" | "box_profile";
  id: string;
  credentialType: "subscription" | "api_key";
  label: string;
  status: string;
  disabledBy: string | null;
  healthScore: number | null;
  cooldownReason: CooldownReason | null;
  cooldownUntil: string | null;
  nextProbeAt: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  hints: Record<string, string | number | null>;
  /** Usage quota windows, or a note saying why there are none (OCV5-424 merged tab). */
  quota?: MemberQuota;
}

export interface QuotaWindowView {
  label: string;
  /** 0–100 used share; null when the upstream gives no figure for this window. */
  usedPct: number | null;
  resetsAt: string | null;
}

export interface MemberQuota {
  windows: QuotaWindowView[];
  updatedAt: string | null;
  note: string | null;
}

export interface PoolView {
  service: string;
  accepts_api_keys: boolean;
  members: PoolMember[];
  counts: { active: number; cooldown: number; disabled: number; total: number };
}

/** Box Claude group (Claude Code logins inside a Cursor Box; not in the accounts table). */
export interface BoxClaudeModelView {
  id: string;
  upstream_model: string;
  enabled: boolean | null;
  visibility: string | null;
  catalog_state: string | null;
  engine: string | null;
  provider: string | null;
  inflight: { current: number; peak: number } | null;
}

export interface BoxQuotaWindowView {
  used: number;
  resets_at: string | null;
}

export interface BoxClaudeLoginView {
  account_id: string;
  profile: string;
  enabled: boolean;
  is_default: boolean;
  login_state: string;
  email_hint: string | null;
  utilization: number | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  health_updated_at: string | null;
  quota: { five_hour: BoxQuotaWindowView | null; weekly: BoxQuotaWindowView | null; reason: string | null };
}

export interface BoxClaudeView {
  routes: { key: "A" | "B"; runner: "print" | "interactive"; models: BoxClaudeModelView[] }[];
  caps: {
    max_runs_per_account: number;
    max_runs_per_user: number;
    proxy_concurrency: number | null;
    proxy_rate_per_minute: number | null;
  };
  inflight_source: "egress" | "local" | "local_fallback" | "unavailable";
  logins: BoxClaudeLoginView[];
}

export interface PoolsResponse {
  pools: PoolView[];
  /** Absent on servers before the Box Claude group; null when it could not be collected. */
  box_claude?: BoxClaudeView | null;
  policy: {
    fail_threshold: number;
    rate_limit_ms: [number, number];
    auth_backoff_ms: [number, number];
    credential_backoff_ms: [number, number];
    upstream_backoff_ms: [number, number];
    quota_default_ms: number;
  };
}

const SERVICE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex / ChatGPT",
  grok: "Grok",
  box: "Box(Cursor)",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  ark: "火山方舟",
  "ark-k3": "火山方舟 Kimi K3",
  kimi: "Kimi(火山)",
  moonshot: "Moonshot",
  zai: "Z.AI",
  bailian: "阿里百炼",
  opencodego: "OpenCode Go",
  openai: "OpenAI",
};

export function serviceLabel(service: string): string {
  return SERVICE_LABELS[service] ?? service;
}

export function cooldownLabel(reason: CooldownReason | null): string {
  switch (reason) {
    case "rate_limited":
      return "限流冷却";
    case "quota":
      return "配额冷却";
    case "auth":
      return "认证失效·自动探测";
    case "credential":
      return "凭证异常·自动探测";
    case "upstream":
      return "上游故障冷却";
    default:
      return "冷却中";
  }
}

/** 冷却剩余时间(到期后显示"即将恢复")。 */
export function remainingLabel(until: string | null, nowMs: number = Date.now()): string {
  if (!until) return "即将恢复";
  const ms = Date.parse(until) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "即将恢复";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} 小时 ${min % 60} 分后`;
  return `${Math.round(h / 24)} 天后`;
}
