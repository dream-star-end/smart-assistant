/**
 * 终态错误卡(W3 FE-errors)。懒加载块:它按错误码查 protocol 错误目录(约 7KB gzip),
 * 目录不进首屏(first-screen-budget)。入口见 lazyTurnErrorNotice.tsx。
 *
 * 正文:服务端给的 userError 优先,否则按码查目录;这一轮特有的说法(计费事实、白名单原因、
 * 冻结的旧快照正文)由调用方作为 fixedBody 传入。动作按目录建议,执行入口由调用方给。
 */
import type { ReactNode } from "react";
import { parseAttachmentTotalExceeded } from "@openclaude/protocol/browser";
import type { ChatMessage } from "../../lib/chat/model";
import { errorPresentation } from "../../lib/chat/render";
import { readUserError, type ErrorNoticeAction, type UserError } from "../../lib/chat/userErrorView";
import type { CardCallbacks } from "./cards";
import { errorTechnicalDetails, standaloneErrorTitle } from "../../lib/chat/userErrorNotice";
import { resolveUserError } from "../../lib/chat/userErrorLookup";
import type { NoticeTone } from "../../lib/ui/statusTone";
import { ErrorTechDetails } from "../ErrorTechDetails";
import { Notice } from "../ui/Notice";
import { errorNoticeActions, type ErrorNoticeActionsInput, noticeActions } from "./errorNoticeActions";

export { ErrorTechDetails };

export type TurnErrorNoticeProps = {
  role: "alert" | "status";
  tone: NoticeTone;
  title?: ReactNode;
  className?: string;
  /** 服务端给的人话错误(错误帧 / 提交时的快照);没有就按 code 查目录。 */
  userError?: UserError;
  code?: string;
  /** 这一轮特有的正文;有它就不用目录正文。 */
  fixedBody?: string;
  /** 正文下的补充说明。 */
  note?: ReactNode;
  /** 目录建议 → 可执行的按钮(最多两个)。终态卡传门控输入,由本块按目录排出按钮(errorNoticeActions)。 */
  actions: ((userError: UserError) => readonly ErrorNoticeAction[]) | Omit<ErrorNoticeActionsInput, "userError">;
  /** 技术详情(码、请求 ID、消息 ID),默认收起。 */
  details?: string | Parameters<typeof errorTechnicalDetails>[0];
};

export function TurnErrorNotice(p: TurnErrorNoticeProps) {
  const userError = resolveUserError(p.userError, p.code);
  const details = typeof p.details === "string" ? p.details : p.details ? errorTechnicalDetails(p.details) : undefined;
  return (
    <Notice
      role={p.role}
      tone={p.tone}
      className={p.className}
      title={p.title ?? standaloneErrorTitle(userError)}
      actions={noticeActions(typeof p.actions === "function" ? p.actions(userError) : errorNoticeActions({ ...p.actions, userError }))}
      details={details ? <ErrorTechDetails text={details} /> : undefined}
    >
      {p.fixedBody ?? userError.message}
      {p.note}
    </Notice>
  );
}

/** Durable dispatch failure rendered as status, never as Agent-authored text. */
export function TurnStatusCard({
  msg,
  cb,
  currentTurn,
}: {
  msg: ChatMessage;
  cb: CardCallbacks;
  currentTurn: boolean;
}) {
  const presented = errorPresentation(msg._errorCode, "", msg._errorDetail, true);
  const attachmentTotalBlocked = parseAttachmentTotalExceeded(msg._errorCode) !== null
    || presented.code === "attachment_total_exceeded";
  const retryTarget = !attachmentTotalBlocked && msg._clientMessageId
    ? cb.resolveRetryTarget?.(msg._clientMessageId)
    : undefined;
  const retry = retryTarget && cb.onRetrySend
    ? { label: "重试", onClick: () => cb.onRetrySend?.(retryTarget) }
    : !attachmentTotalBlocked && cb.onRegenerate
      ? { label: "重新尝试", onClick: cb.onRegenerate }
      : undefined;
  const details = {
    code: msg._errorCode,
    requestId: msg.usage?.traceId,
    clientMessageId: msg._clientMessageId,
    detail: presented.detail,
  };
  return (
    <TurnErrorNotice
      role="status"
      tone="attention"
      className="animate-in"
      title={presented.title}
      userError={readUserError(msg._userError)}
      code={presented.code}
      fixedBody={presented.fixedMessage ? presented.message : undefined}
      actions={() => (currentTurn && retry ? [retry] : [])}
      details={details}
    />
  );
}
