// 站内信级别体系的单一权威源。
// 用户侧通知抽屉（components/InboxDialog）与管理中心站内信页（admin/pages/inbox）共用这一套
// label + Badge tone 映射；此前两端各持一套文案（用户侧「通知/公告/活动/提醒」vs admin
// 「普通/通知/运营/警告」）导致同一 level 在两处叫法不同 —— 现统一收口于此。
import type { InboxLevel } from "./types";

/** 站内信级别可用的 Badge 色调子集（对齐 ui/Badge 的 tone）。 */
export type InboxLevelTone = "neutral" | "info" | "accent" | "warning";

/**
 * 级别 → { 文案, Badge 色调 } 的权威映射。改文案/色调只改这里，两端自动一致。
 * 级别对应的图标（lucide-react）由 UI 层各自映射（本文件不引 JSX），见 InboxDialog.LEVEL_ICON。
 */
export const INBOX_LEVEL_META: Record<InboxLevel, { label: string; tone: InboxLevelTone }> = {
  info: { label: "通知", tone: "neutral" },
  notice: { label: "公告", tone: "info" },
  promo: { label: "活动", tone: "accent" },
  warning: { label: "提醒", tone: "warning" },
};
