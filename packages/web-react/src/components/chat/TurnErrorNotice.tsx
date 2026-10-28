/**
 * 终态错误卡(W3 FE-errors)。懒加载块:它按错误码查 protocol 错误目录(约 7KB gzip),
 * 目录不进首屏(first-screen-budget)。入口见 lazyTurnErrorNotice.tsx。
 *
 * 正文:服务端给的 userError 优先,否则按码查目录;这一轮特有的说法(计费事实、白名单原因、
 * 冻结的旧快照正文)由调用方作为 fixedBody 传入。动作按目录建议,执行入口由调用方给。
 */
import type { ReactNode } from "react";
import { resolveUserError } from "../../lib/chat/userErrorLookup";
import type { ErrorNoticeAction, UserError } from "../../lib/chat/userErrorView";
import type { NoticeTone } from "../../lib/ui/statusTone";
import { ErrorTechDetails } from "../ErrorTechDetails";
import { Notice } from "../ui/Notice";
import { noticeActions } from "./errorNoticeActions";

export type TurnErrorNoticeProps = {
  role: "alert" | "status";
  tone: NoticeTone;
  title: ReactNode;
  className?: string;
  /** 服务端给的人话错误(错误帧 / 提交时的快照);没有就按 code 查目录。 */
  userError?: UserError;
  code?: string;
  /** 这一轮特有的正文;有它就不用目录正文。 */
  fixedBody?: string;
  /** 正文下的补充说明。 */
  note?: ReactNode;
  /** 目录建议 → 可执行的按钮(最多两个,门控在调用方)。 */
  actions: (userError: UserError) => readonly ErrorNoticeAction[];
  /** 技术详情(码、请求 ID、消息 ID),默认收起。 */
  details?: string;
};

export function TurnErrorNotice(p: TurnErrorNoticeProps) {
  const userError = resolveUserError(p.userError, p.code);
  return (
    <Notice
      role={p.role}
      tone={p.tone}
      className={p.className}
      title={p.title}
      actions={noticeActions(p.actions(userError))}
      details={p.details ? <ErrorTechDetails text={p.details} /> : undefined}
    >
      {p.fixedBody ?? userError.message}
      {p.note}
    </Notice>
  );
}
