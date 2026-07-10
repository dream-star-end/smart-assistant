// 告警中心响应形状 —— 对齐 packages/commercial/src/http/adminAlerts.ts 的 serializer
// 与 admin/alert*.ts 的 *RowView。零新增路由,字段名与后端逐一对应。

export type Severity = "info" | "warning" | "critical";
export type ChannelType = "ilink_wechat" | "telegram" | "wecom_bot" | "wecom_aibot";
export type ActivationStatus = "pending" | "active" | "disabled" | "error";
export type AibotConnState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "closed"
  | "auth_failed"
  | "unknown";
export type OutboxStatus = "pending" | "sent" | "failed" | "suppressed" | "skipped";
export type EventTrigger = "polled" | "passive" | "both";

export interface AlertChannel {
  id: string;
  admin_id: string;
  channel_type: ChannelType;
  label: string;
  enabled: boolean;
  severity_min: Severity;
  event_types: string[];
  activation_status: ActivationStatus;
  last_inbound_at: string | null;
  last_send_at: string | null;
  last_error: string | null;
  has_context_token: boolean;
  tg_chat_id?: string | null;
  created_at: string;
  updated_at: string;
  // wecom_aibot 专属
  aibot_bot_id?: string;
  aibot_chat_type?: string | null;
  aibot_bound?: boolean;
  aibot_conn_state?: AibotConnState;
}

export interface EventMeta {
  event_type: string;
  severity: Severity;
  group: string;
  description: string;
  trigger: EventTrigger;
}

export interface CoverageRow {
  event_type: string;
  group: string;
  severity: Severity;
  description: string;
  trigger: EventTrigger;
  subscriber_count: number;
  deliverable_count: number;
  last_fired_at: string | null;
  last_severity: Severity | null;
}

export interface OutboxRow {
  id: string;
  event_type: string;
  severity: Severity;
  status: OutboxStatus;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  channel_id: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
}

export interface SilenceMatcher {
  event_type?: string;
  severity?: Severity;
  rule_id?: string;
}

export interface SilenceRow {
  id: string;
  matcher: SilenceMatcher;
  starts_at: string;
  ends_at: string;
  reason: string;
  created_by: string | null;
  created_at: string;
  active: boolean;
}

export interface RuleStateRow {
  rule_id: string;
  firing: boolean;
  acked: boolean;
  acked_at: string | null;
  acked_by: string | null;
  dedupe_key: string | null;
  last_transition_at: string | null;
  last_evaluated_at: string | null;
  last_payload: Record<string, unknown>;
}
