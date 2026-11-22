/**
 * 终态错误卡(W3 FE-errors)。懒加载块:它按错误码查 protocol 错误目录(约 7KB gzip),
 * 目录不进首屏(first-screen-budget)。入口见 lazyTurnErrorNotice.tsx。
 *
 * 正文:服务端给的 userError 优先,否则按码查目录;这一轮特有的说法(计费事实、白名单原因、
 * 冻结的旧快照正文)由调用方作为 fixedBody 传入。动作按目录建议,执行入口由调用方给。
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { parseAttachmentTotalExceeded, parseIdleRecoveryPending } from "@openclaude/protocol/browser";
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

export const BOX_CAPACITY_HELD_WAIT_SECONDS = 15;
const autoContinuedBoxHoldKeys = new Set<string>();

export function _resetBoxCapacityHoldAutoContinueForTest(): void {
  autoContinuedBoxHoldKeys.clear();
}

const RATE_LIMIT_OR_MODEL_UNAVAILABLE_CODES = new Set([
  "rate_limited",
  "rate_limit",
  "model_capacity",
  "model_not_available",
  "model_unavailable",
  "unresolved_agent_model",
  "unauthorized_model",
  "upstream_overloaded",
  "provider_overloaded",
  "service_unavailable",
]);

function isRateLimitOrModelUnavailable(userError: UserError, rawCode?: string): boolean {
  const code = (userError.code || rawCode || "").toLowerCase();
  if (code === "box_capacity_held") return false;
  if (RATE_LIMIT_OR_MODEL_UNAVAILABLE_CODES.has(code)) return true;
  return userError.category === "capacity" || userError.category === "model";
}

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
  /** OCV5-734: 唯一消息键,保证 box_capacity_held 释放后自动继续至多触发一次。 */
  holdKey?: string;
  /** 可选：限流 / 模型不可用时引导切换备用模型的回调（未传时优先复用 actions.cb.onOpenModelPicker）。 */
  onOpenModelPicker?: () => void;
};

function sanitizeTurnErrorCopy(text: string | undefined, isBoxCapacityHeld: boolean): string | undefined {
  if (!text) return text;
  if (isBoxCapacityHeld) {
    return "前一步执行仍在收尾，已有进度已保留，请稍后继续。";
  }
  return text.replace(/在\s*Box\s*上的?/gi, "").replace(/\bBox\b/gi, "服务端");
}

export function TurnErrorNotice(p: TurnErrorNoticeProps) {
  const userError = resolveUserError(p.userError, p.code);
  const details = typeof p.details === "string" ? p.details : p.details ? errorTechnicalDetails(p.details) : undefined;
  const baseActions = typeof p.actions === "function" ? p.actions(userError) : errorNoticeActions({ ...p.actions, userError });
  const isBoxCapacityHeld = userError.code === "box_capacity_held" || p.code === "box_capacity_held";
  const retryAction = isBoxCapacityHeld ? baseActions.find((a) => a.label === "继续") : undefined;
  const holdKey = p.holdKey
    ?? (typeof p.actions !== "function" ? p.actions.msg.id : undefined)
    ?? (typeof p.details === "object" && p.details ? (p.details.clientMessageId ?? p.details.requestId) : undefined)
    ?? "box_capacity_held";
  const retryOnClickRef = useRef(retryAction?.onClick);
  retryOnClickRef.current = retryAction?.onClick;
  const canAutoWait = isBoxCapacityHeld && !!retryAction;
  const [secondsLeft, setSecondsLeft] = useState(() =>
    canAutoWait && !autoContinuedBoxHoldKeys.has(holdKey) ? BOX_CAPACITY_HELD_WAIT_SECONDS : 0,
  );

  useEffect(() => {
    if (!canAutoWait) return;
    if (autoContinuedBoxHoldKeys.has(holdKey)) {
      setSecondsLeft(0);
      return;
    }
    if (secondsLeft <= 0) {
      autoContinuedBoxHoldKeys.add(holdKey);
      retryOnClickRef.current?.();
      return;
    }
    const timer = window.setTimeout(() => {
      setSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [canAutoWait, holdKey, secondsLeft]);

  // 短暂自动等待期不弹中断告警卡，改为静默轻等待；仅自动继续仍未恢复或已过自动重试时才展示温和提示。
  if (canAutoWait && secondsLeft > 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="box-capacity-waiting-status"
        className="flex items-center gap-2.5 py-1.5 text-body text-muted"
      >
        <span className="oc-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="min-w-0 break-words">上一步仍在收尾，马上自动继续…</span>
      </div>
    );
  }

  const openModelPicker =
    p.onOpenModelPicker ??
    (typeof p.actions !== "function" && p.actions.isLastTurn ? p.actions.cb.onOpenModelPicker : undefined);
  const alreadyHasSwitchModel = baseActions.some(
    (a) => a.label === "切换模型" || a.label === "切换备用模型继续",
  );
  const wantFallbackModelCta =
    Boolean(openModelPicker) &&
    !alreadyHasSwitchModel &&
    isRateLimitOrModelUnavailable(userError, p.code);

  const effectiveActions =
    wantFallbackModelCta && baseActions.length < 2
      ? [...baseActions, { label: "切换备用模型继续", onClick: openModelPicker! }]
      : baseActions;
  const inlineFallbackCta =
    wantFallbackModelCta && baseActions.length >= 2 ? (
      <div className="mt-1.5">
        <button
          type="button"
          onClick={openModelPicker}
          className="oc-btn-tactile inline-flex items-center rounded-md text-caption font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          切换备用模型继续
        </button>
      </div>
    ) : null;

  const bodyText = sanitizeTurnErrorCopy(p.fixedBody ?? userError.message, isBoxCapacityHeld);

  return (
    <Notice
      role={isBoxCapacityHeld ? "status" : p.role}
      tone={isBoxCapacityHeld ? "progress" : p.tone}
      className={p.className}
      title={p.title ?? standaloneErrorTitle(userError)}
      actions={noticeActions(effectiveActions)}
      details={details ? <ErrorTechDetails text={details} /> : undefined}
    >
      {bodyText}
      {p.note}
      {inlineFallbackCta}
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
  const source = !attachmentTotalBlocked && !parseIdleRecoveryPending(msg._errorCode) && currentTurn ? cb.resolveInterruptedContinuation?.(msg) : undefined;
  const retry = source && cb.onContinueInterrupted
    ? { label: "继续", onClick: () => cb.onContinueInterrupted?.(msg) }
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
      onOpenModelPicker={currentTurn ? cb.onOpenModelPicker : undefined}
      details={details}
      holdKey={msg.id}
    />
  );
}
