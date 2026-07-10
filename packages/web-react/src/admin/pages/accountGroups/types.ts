// accountGroups 页数据形状 —— 对齐后端 serializeGroup / serializeCredential
// (commercial/src/http/admin/accountGroups.ts)。

export type AccountGroup = {
  id: string;
  label: string;
  kind: "official_oauth" | "api_relay";
  provider: string;
  enabled: boolean;
  priority: number;
  models: string[];
  created_at: string;
  updated_at: string;
};

export type RelayCredential = {
  id: string;
  group_id: string;
  label: string;
  base_url: string;
  model_provider: string;
  provider_name: string | null;
  wire_api: string;
  preferred_auth_method: string;
  disable_response_storage: boolean;
  status: "active" | "disabled" | "cooldown";
  health_score: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  last_error: string | null;
  success_count: string;
  fail_count: string;
  created_at: string;
  updated_at: string;
};

export const ACCOUNT_GROUP_KIND_LABEL: Record<string, string> = {
  official_oauth: "官方 OAuth 订阅",
  api_relay: "API 中转站",
};

export const GROUP_KINDS = ["official_oauth", "api_relay"] as const;
