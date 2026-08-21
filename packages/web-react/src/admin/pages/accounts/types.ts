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
