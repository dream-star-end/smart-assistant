import { pickErrorActions } from "../../lib/chat/userErrorNotice";
import { requestSubscribeIntent, type SubscribeIntent } from "../../lib/subscribeIntent";
import { reportClientFriction } from "../../lib/clientFriction";
import type { ChatMessage } from "../../lib/chat/model";
import type {
  ErrorActionHandlers,
  ErrorNoticeAction,
  UserError,
} from "../../lib/chat/userErrorView";
import type { NoticeAction } from "../ui/Notice";
import type { CardCallbacks } from "./cards";

/** Notice 的动作是一到两个的元组;没有动作时不渲染动作行。 */
export function noticeActions(list: readonly ErrorNoticeAction[]): readonly [NoticeAction] | readonly [NoticeAction, NoticeAction] | undefined {
  if (list.length === 0) return undefined;
  return list.length === 1 ? [list[0]!] : [list[0]!, list[1]!];
}

/** Current task errors continue within their conversation. Navigation keeps its
 * own admission gates; historical errors never start another task. */
export type ErrorNoticeActionsInput = {
  msg: ChatMessage;
  cb: CardCallbacks;
  userError: UserError;
  isLastTurn: boolean;
  waived: boolean;
  /** Retained for legacy callers; execution never replays this target. */
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
    if (input.continueInterrupted) h.retry = { label: "继续", onClick: input.continueInterrupted };
    if (!waived) {
      if (cb.onOpenModelPicker) h.switch_model = { label: "切换模型", onClick: cb.onOpenModelPicker };
      const editTarget = input.editTarget;
      if (editTarget && cb.onEditResend) h.edit_message = { label: "修改消息", onClick: () => cb.onEditResend?.(editTarget) };
      const reload = { label: "刷新页面", onClick: () => window.location.reload() };
      h.refresh = reload;
      h.relogin = reload;
    }
  }
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
