// accounts 页数据形状 —— 与后端 serializeAccount(commercial/src/http/admin/accounts.ts)
// 以及 accountsStats / account-pool snapshot 序列化器逐字段对齐。数字/大整数一律走
// string(bigint::text)或 number(pct/health),前端不做隐式转换。

/** GET /api/admin/accounts?with_stats=1 的单行(serializeAccount + today_* 聚合)。 */
export type AccountRow = {
  id: string;
  provider: string;
  group_id: string | null;
  label: string;
  plan: string;
  status: string;
  health_score: number | null;
  cooldown_until: string | null;
  oauth_expires_at: string | null;
  subscription_end_at: string | null;
  last_used_at: string | null;
  last_error: string | null;
  success_count: string;
  fail_count: string;
  quota_remaining: number | null;
  quota_5h_pct: number | null;
  quota_5h_resets_at: string | null;
  quota_7d_pct: number | null;
  quota_7d_resets_at: string | null;
  quota_updated_at: string | null;
  egress_proxy: string | null;
  has_egress_proxy: boolean;
  egress_proxy_id: string | null;
  egress_proxy_pool_label: string | null;
  egress_host_uuid: string | null;
  has_refresh_token: boolean;
  cursor_quota_class: "unknown" | "other_ok" | "cursor_only" | null;
  cursor_sand_enabled: boolean | null;
  /** 0257 — Sand 凭证形态:api_key(crsr_ 换 token)| session(Cursor 账号登录会话)。 */
  cursor_credential_kind: "api_key" | "session" | null;
  cursor_auth_id: string | null;
  /** 0262 — Sand / Grok Bot 池用量(每小时 sweeper 刷新;仅 session 行有值)。可选以兼容旧后端。 */
  cursor_sand_usage_pct?: number | null;
  cursor_sand_period_start?: string | null;
  cursor_sand_next_reset_at?: string | null;
  cursor_sand_access_state?: string | null;
  cursor_plan_membership?: string | null;
  cursor_billing_cycle_end?: string | null;
  cursor_usage_updated_at?: string | null;
  cursor_usage_error?: string | null;
  created_at: string;
  updated_at: string;
  today_requests?: number;
  today_errors?: number;
};

/** GET /api/admin/accounts/stats(KPI 口径)。 */
export type AccountsPoolStats = {
  total: number;
  active: number;
  cooldown: number;
  disabled: number;
  banned: number;
  expired_refreshable: number;
  expired_unrefreshable: number;
  expiring_24h: number;
  today_requests: number;
  today_errors: number;
};

/** GET /api/admin/stats/account-pool(donut + 平均健康口径)。 */
export type AccountPoolSnapshot = {
  total: number;
  active: number;
  cooldown: number;
  disabled: number;
  banned: number;
  avg_health: number;
  today_success_rate: number;
};

/** GET /api/admin/accounts/refresh-events 的单条事件。 */
export type RefreshEvent = {
  id: string;
  account_id: string;
  ts: string;
  ok: boolean;
  err_code: string | null;
  err_msg: string | null;
};

/** GET /api/admin/accounts/:id/recent-users 的单行。 */
export type RecentUser = {
  user_id: string;
  email: string | null;
  request_count: number;
  last_used_at: string;
};

/** GET /api/admin/accounts/:id/cursor-usage — Cursor 账号会话(Sand)额度快照。 */
export type CursorUsageSnapshot = {
  fetched_at: string;
  errors: Record<string, string>;
  plan: {
    name: string | null;
    price: string | null;
    membership_type: string | null;
    subscription_status: string | null;
    billing_cycle_start: string | null;
    billing_cycle_end: string | null;
  };
  included: {
    used_cents: number | null;
    limit_cents: number | null;
    remaining_cents: number | null;
    total_percent_used: number | null;
    auto_percent_used: number | null;
    api_percent_used: number | null;
    is_unlimited: boolean | null;
    display_message: string | null;
  };
  on_demand: {
    enabled: boolean | null;
    used_cents: number | null;
    limit_cents: number | null;
    remaining_cents: number | null;
    usage_based_allowed: boolean | null;
  };
  cycle_usage: {
    range_start: string | null;
    range_end: string | null;
    total_cost_cents: number | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_cache_write_tokens: number | null;
    total_cache_read_tokens: number | null;
    models: Array<{
      model: string;
      cost_cents: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_write_tokens: number | null;
      cache_read_tokens: number | null;
    }>;
  };
  /** Grok Bot / Sand 独立池(与 included 无关,按周重置)。旧后端可能不返回该字段。 */
  sand?: {
    access_state: string | null;
    block_reason: string | null;
    usage_percent: number | null;
    has_available_usage: boolean | null;
    has_included_limit: boolean | null;
    period_start: string | null;
    next_reset_at: string | null;
    on_demand_visible: boolean | null;
    on_demand_eligible: boolean | null;
    grok_plan: string | null;
    grok_plan_label: string | null;
    super_grok_linked: boolean | null;
    super_grok_granted: boolean | null;
    super_grok_linked_at: string | null;
    link_blocked_reason: string | null;
  };
};

/** 创建/编辑账号表单依赖:active 代理池条目。 */
export type ActiveProxy = {
  id: string;
  label: string;
  url_masked: string;
  status: string;
};

/** 官方 OAuth 账号分组(供账号绑定下拉)。 */
export type OAuthGroup = {
  id: string;
  label: string;
  kind: string;
  provider: string;
  enabled: boolean;
};

export const ACCOUNT_PLANS = ["pro", "max", "team"] as const;
export const ACCOUNT_STATUSES = ["active", "cooldown", "disabled", "banned"] as const;
