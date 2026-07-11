// 站内信页共享的后端形状（以 packages/commercial/src/http/admin/inbox.ts 为准）。

import { INBOX_LEVEL_META, type InboxLevelTone } from "../../../lib/inboxLevels";

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

// 级别文案 / 色调收口至 lib/inboxLevels —— 用户侧通知抽屉（InboxDialog）与本页共用同一权威源，
// 避免同一 level 两端叫法不一致。以下两常量只是保留旧调用签名的派生视图（改文案改 META 即可）。
export const INBOX_LEVEL_LABELS: Record<InboxLevel, string> = {
  info: INBOX_LEVEL_META.info.label,
  notice: INBOX_LEVEL_META.notice.label,
  promo: INBOX_LEVEL_META.promo.label,
  warning: INBOX_LEVEL_META.warning.label,
};

export const INBOX_LEVEL_TONE: Record<InboxLevel, InboxLevelTone> = {
  info: INBOX_LEVEL_META.info.tone,
  notice: INBOX_LEVEL_META.notice.tone,
  promo: INBOX_LEVEL_META.promo.tone,
  warning: INBOX_LEVEL_META.warning.tone,
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
