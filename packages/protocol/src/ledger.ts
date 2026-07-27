/**
 * credit_ledger.reason 的跨端单一权威。
 *
 * 枚举与最终约束迁移 0131_image_generation_billing.sql 保持精确一致；
 * 中文标签描述积分变化的真实语义，不把正向套餐发放误写成扣费。
 */
export const LEDGER_REASONS = [
  "topup",
  "chat",
  "agent_chat",
  "agent_subscription",
  "refund",
  "admin_adjust",
  "promotion",
  "minimax_media",
  "image_generation",
  "subscription",
  "subscription_expire",
  "pack",
] as const;

export type LedgerReason = (typeof LEDGER_REASONS)[number];

export const LEDGER_REASON_LABELS = {
  topup: "充值到账",
  chat: "对话消耗",
  agent_chat: "智能体对话消耗",
  agent_subscription: "智能体订阅扣费",
  refund: "退款到账",
  admin_adjust: "人工调整",
  promotion: "活动赠送",
  minimax_media: "媒体生成消耗",
  image_generation: "图片生成消耗",
  subscription: "套餐额度发放",
  subscription_expire: "周期额度清零",
  pack: "加量包到账",
} as const satisfies Record<LedgerReason, string>;

/** 未知 reason 保留原文，避免新服务端值在旧前端被静默吞掉。 */
export function ledgerReasonLabel(reason: string): string {
  return (LEDGER_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}
