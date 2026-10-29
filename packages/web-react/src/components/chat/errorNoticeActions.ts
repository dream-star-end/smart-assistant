import { pickErrorActions } from "../../lib/chat/userErrorNotice";
import { requestSubscribeIntent, type SubscribeIntent } from "../../lib/subscribeIntent";
import { reportClientFriction } from "../../lib/clientFriction";
import type { ChatMessage } from "../../lib/chat/model";
import {
  type ErrorActionHandlers,
  type ErrorNoticeAction,
  type UserError,
} from "../../lib/chat/userErrorView";
import type { NoticeAction } from "../ui/Notice";
import type { CardCallbacks } from "./cards";

/** Notice 的动作是一到两个的元组;没有动作时不渲染动作行。 */
export function noticeActions(list: readonly ErrorNoticeAction[]): readonly [NoticeAction] | readonly [NoticeAction, NoticeAction] | undefined {
  if (list.length === 0) return undefined;
  return list.length === 1 ? [list[0]!] : [list[0]!, list[1]!];
}

/**
 * 错误卡的建议动作 → 卡片原有的执行入口。目录只决定「建议什么、按什么顺序」;能不能点仍按原来的门:
 *  - 重发类(重新发送 / 修改消息 / 换个模型 / 刷新)只在该卡属于最后一轮时出现(历史卡一点会把无关的
 *    最新一轮重发出去,Codex 审计 R5);
 *  - 重发优先精确重发原消息(「重试」:可重试码、能找到原 user 行),否则重发最后一条
 *    (「重新尝试」);有可续接的断点时改为「从断点继续」;
 *  - 已有按钮沿用原来的名字(重试 / 切换模型 / 新建会话继续 / 刷新页面),目录新增的建议
 *    (联系管理员、修改消息)用目录的名字;
 *  - 免单卡只留重发和反馈(本轮已退款,不引导换模型或开新会话);
 *  - 「联系管理员」走反馈入口,带上这条消息的追踪信息。
 */
export type ErrorNoticeActionsInput = {
  msg: ChatMessage;
  cb: CardCallbacks;
  userError: UserError;
  isLastTurn: boolean;
  waived: boolean;
  /** 精确重发的目标(可重试码 + 原 user 行);没有则退回重发最后一条。 */
  preciseRetryTarget?: ChatMessage;
  /** 原 user 行(修改消息用),不要求可重试。 */
  editTarget?: ChatMessage;
  continueInterrupted?: () => void;
  topUp?: { label: string; intent: SubscribeIntent };
  contactAdmin?: () => void;
};

export function errorNoticeActions(input: ErrorNoticeActionsInput): ErrorNoticeAction[] {
  const { cb, isLastTurn, waived } = input;
  const h: ErrorActionHandlers = {};
  if (isLastTurn) {
    if (input.continueInterrupted) h.retry = { label: "从断点继续", onClick: input.continueInterrupted };
    else if (input.preciseRetryTarget && cb.onRetrySend) {
      const target = input.preciseRetryTarget;
      h.retry = { label: "重试", onClick: () => cb.onRetrySend?.(target) };
    } else if (cb.onRegenerate) h.retry = { label: "重新尝试", onClick: cb.onRegenerate };
    if (!waived) {
      if (cb.onOpenModelPicker) h.switch_model = { label: "切换模型", onClick: cb.onOpenModelPicker };
      const editTarget = input.editTarget;
      if (editTarget && cb.onEditResend) h.edit_message = { label: "修改消息", onClick: () => cb.onEditResend?.(editTarget) };
      const reload = { label: "刷新页面", onClick: () => window.location.reload() };
      h.refresh = reload;
      h.relogin = reload;
    }
  }
  if (!waived && cb.onStartNewSession) h.new_session = { label: "新建会话继续", onClick: cb.onStartNewSession };
  if (input.topUp && cb.onTopUp) {
    const { label, intent } = input.topUp;
    h.topup = { label, onClick: () => {
      requestSubscribeIntent(intent);
      reportClientFriction(
        { surface: "chat", stage: "exhausted_cta", code: "EXHAUSTED_CTA", outcome: "succeeded" },
        cb.getToken?.(),
      );
      cb.onTopUp?.();
    } };
  }
  if (input.contactAdmin) h.contact_admin = { label: "联系管理员", onClick: input.contactAdmin };
  // 断点续接是这张卡最有用的出口,目录没把「重试」排第一时也放在最前面。
  const order = input.continueInterrupted && isLastTurn
    ? ["retry" as const, ...input.userError.actions]
    : input.userError.actions;
  return pickErrorActions(order, h);
}
