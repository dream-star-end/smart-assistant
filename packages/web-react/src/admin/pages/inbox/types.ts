// 站内信页共享的后端形状（以 packages/commercial/src/http/admin/inbox.ts 为准）。

export type InboxAudience = "all" | "user";
export type InboxLevel = "info" | "notice" | "promo" | "warning";
export type EmailSendStatus = "queued" | "done" | "partial" | "interrupted";

export interface EmailSummary {
  total: number;
  sent: number;
  failed: number;
  interrupted: number;
  dropped: number;
}

export interface InboxMessage {
  id: string | number;
  audience: InboxAudience;
  user_id: string | null;
  title: string;
  body_md: string;
  level: InboxLevel;
  created_by: string | number | null;
  created_at: string;
  expires_at: string | null;
  read_count: number;
  recipients: number;
  notify_email: boolean;
  email_send_status: EmailSendStatus | null;
  email_sent_at: string | null;
  email_summary: EmailSummary | null;
}

export interface MessagesResp {
  messages: InboxMessage[];
  total: number;
}

export interface EmailConfig {
  enabled: boolean;
  provider: "resend" | "stub";
}

export interface CreateMessagePayload {
  audience: InboxAudience;
  title: string;
  body_md: string;
  level: InboxLevel;
  user_id?: string;
  expires_at?: string;
  notify_email?: boolean;
}

export const INBOX_LEVEL_LABELS: Record<InboxLevel, string> = {
  info: "普通",
  notice: "通知",
  promo: "运营",
  warning: "警告",
};

export const INBOX_LEVEL_TONE: Record<InboxLevel, "neutral" | "info" | "accent" | "warning"> = {
  info: "neutral",
  notice: "info",
  promo: "accent",
  warning: "warning",
};

export const EMAIL_STATUS_META: Record<
  EmailSendStatus,
  { label: string; tone: "info" | "success" | "warning" | "danger" }
> = {
  queued: { label: "排队中", tone: "info" },
  done: { label: "已发完", tone: "success" },
  partial: { label: "部分失败", tone: "warning" },
  interrupted: { label: "中断", tone: "danger" },
};
