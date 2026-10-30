import { AUTOMATIC_TURN_RETRY_MAX, normalizeTurnErrorCode, supportsAutomaticTurnRecovery,
  type AutomaticTurnRecoverySnapshot } from "@openclaude/protocol/browser";
import { detectServerTerminalTurns } from "../persist";
import { isServerAuthoredRow, type ChatMessage, type ChatSession } from "./model";
import { enterDeferredRecoverySoftState, type DeferredTerminalErrorPaint } from "./reducer";
import { friendlyBridgeErrorMessage, safeBridgeErrorDetail } from "./pure";
import { rememberRetryStatus } from "./retryStatus";

  /** Jobs and finalized source rows share one PG read snapshot. */
export function applyAutomaticRecoverySnapshot(
    sess: ChatSession,
    incoming: ChatMessage[],
    recoveries: AutomaticTurnRecoverySnapshot[] | undefined,
    effects: {
      defer: (paint: DeferredTerminalErrorPaint) => boolean;
      settle: (cmid: string, outcome: "adopted" | "declined") => void;
    },
  ): void {
    if (!Array.isArray(recoveries)) return;
    const terminals = detectServerTerminalTurns(incoming);
    for (const [cmid, kind] of terminals) {
      if (kind === "completed" && !incoming.some((message) => message._clientMessageId === cmid && message._errorCode)) {
        effects.settle(cmid, "adopted");
        continue;
      }
      const error = sess.messages.find((message) => message.role === "assistant" &&
        message._clientMessageId === cmid && !!message._errorCode);
      if (!error || !supportsAutomaticTurnRecovery(error._errorCode!)) continue;
      const child = sess.messages.some((message) => message.role === "user" &&
        message._automaticRecovery === true && message._recoveryOfClientMessageId === cmid &&
        isServerAuthoredRow(message));
      if (child || sess._cancelledAutomaticRecoveryIds?.[cmid] === true) continue;
      const job = recoveries.find((item) => item.sourceClientMessageId === cmid);
      // Phase A is visible before Phase B atomically decides recovery. Only
      // this response can say whether an empty job set is authoritative.
      const decisionPending = incoming.some((message) => message._clientMessageId === cmid &&
        message._automaticRecoveryDecisionPending === true);
      if (!job && !decisionPending) {
        sess._automaticRecoveryDecisions = { ...(sess._automaticRecoveryDecisions ?? {}), [cmid]: true };
        effects.settle(cmid, "declined");
        continue;
      }
      if (sess._cancelledAutomaticRecoveryIds?.[job?.rootClientMessageId ?? cmid] === true) continue;
      // A later user intent or an ACKed child owns the UI, even if this older
      // snapshot completed after the live adoption.
      const index = sess.messages.findIndex((message) => message.role === "user" && message.id === cmid);
      if (index < 0 || sess.messages.slice(index + 1).some((message) => message.role === "user")) continue;
      if (sess._sendingInFlight && sess._activeClientMessageId && sess._activeClientMessageId !== cmid) continue;
      const normalized = normalizeTurnErrorCode(error._errorCode);
      const paint: DeferredTerminalErrorPaint = {
        normalized, text: friendlyBridgeErrorMessage(normalized),
        clientMessageId: cmid, detail: safeBridgeErrorDetail(normalized),
      };
      if (!effects.defer(paint)) continue;
      error._errorCardSnapshot = undefined;
      sess._deferredTerminalErrorClientMessageId = cmid;
      enterDeferredRecoverySoftState(sess, cmid);
      sess._turnStatus = { kind: "retrying", attempt: job?.attempt ?? 1, max: AUTOMATIC_TURN_RETRY_MAX, retryAt: Date.now() };
      // 重连/刷新后靠快照恢复「正在自动重试（n/N）」的真实进度。
      if (job) rememberRetryStatus(sess, job, job.retryStatus);
    }
  }

