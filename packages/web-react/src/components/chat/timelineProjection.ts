import type { ChatMessage } from "../../lib/chat/model";
import { collectRecoveredTurnStatusRecordIds } from "../../lib/chat/manualTaskContinuation";
import { returnStrayRowsToOwnerTurn } from "../../lib/chat/order";
import { isRecoveryControlUserTurn } from "../../lib/chat/pure";
import {
  collectAutomaticRecoveredSourceIds,
  recoveryFailureIsPresentedBelow,
} from "../../lib/chat/recoveryFailureOutlet";
import {
  collectResolvedDispatchTurnIds,
  collectTurnStatusRecordTurnIds,
  isErrorCardHeld,
  isErrorCardHeldWithAnswer,
  isErrorCardSupersededByTurnStatus,
  isRedundantRuntimeEnvelope,
  isTurnStatusSuppressedByTape,
} from "../../lib/chat/render";
import { sanitizeChatMessages } from "../../lib/chat/sanitizeChatMessages";
import {
  projectVisibleAssistantRows,
  splitStoppedNarration,
  turnRecoveryParents,
} from "./turnSegment";

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function quickTextStamp(text: string | null | undefined): string {
  if (!text) return "0";
  const len = text.length;
  return `${len}:${text.charCodeAt(0)}:${text.charCodeAt(len >> 1)}:${text.charCodeAt(len - 1)}`;
}

/**
 * Fast single-pass fingerprint over a ChatMessage[] that detects both array
 * replacements and in-place reducer mutations without cloning or running regexes.
 * Lets MessageList memoize its sanitize/filter/disclosure/find pipelines across
 * unrelated re-renders (scroll paint window, find cursor steps, disclosure toggles,
 * turn-activity timer ticks).
 */
export function timelineMessagesFingerprint(messages: readonly ChatMessage[]): string {
  const len = messages.length;
  if (len === 0) return "0";
  const parts: string[] = [String(len)];
  for (let i = 0; i < len; i += 1) {
    const m = messages[i];
    if (!m) {
      parts.push("null");
      continue;
    }
    parts.push(
      `${m.id}|${m.role}|${m.status ?? ""}|${m.toolUseId ?? ""}|${quickTextStamp(m.text)}|${quickTextStamp(m.output)}|${quickTextStamp(m.partialJson)}|${quickTextStamp(m.summary)}|${m._completed ? 1 : 0}|${m._errorCode ?? ""}|${m._errorHeldForRecovery ? 1 : 0}|${m._errorCardSnapshot?.disposition ?? ""}|${m._resolved ? 1 : 0}|${m._behavior ?? ""}|${m._turnStatusRecord ? 1 : 0}|${m._recoveryOfClientMessageId ?? ""}|${m._automaticRecovery ? 1 : 0}|${m._clientMessageId ?? ""}|${m._timelineUnitKey ?? ""}|${m._payloadDeferred ? 1 : 0}|${m._timelineAuxiliary ?? ""}|${m._turnTapeProcess ? 1 : 0}|${m.entries?.length ?? 0}|${m.childBlocks?.length ?? 0}|${m.completedAt ?? 0}|${m.ts ?? 0}|${m.usage?.costCredits ?? ""}|${m.usage?.waived ? 1 : 0}|${m.usage?.traceId ?? ""}|${m._callUsage?.usage?.totalTokens ?? ""}`,
    );
  }
  return parts.join("\u0002");
}

export type TimelineProjection = {
  safeMessages: ChatMessage[];
  renderableMessages: ChatMessage[];
  turnLineageParents: Map<string, string>;
  failureIsPresentedBelow: (message: ChatMessage) => boolean;
};

/**
 * Pure sanitization, recovery-lineage resolution, and renderable-row projection
 * for MessageList. Extracted from MessageRenderer.tsx so it can be cleanly
 * memoized and keep MessageRenderer within its file-size ceiling.
 */
export function projectTimelineMessages(
  messages: ChatMessage[],
  sessionId: string | undefined,
): TimelineProjection {
  const safeMessages = sanitizeChatMessages(messages, sessionId);
  const resolvedDispatchTurnIds = collectResolvedDispatchTurnIds(safeMessages);
  const statusRecordTurnIds = collectTurnStatusRecordTurnIds(safeMessages, resolvedDispatchTurnIds);
  const recoveredStatusRecordIds = collectRecoveredTurnStatusRecordIds(safeMessages);
  const recoveredSourceIds = new Set(
    safeMessages
      .filter(isRecoveryControlUserTurn)
      .map((message) => message._recoveryOfClientMessageId)
      .filter(isNonEmptyId),
  );
  const automaticRecoveredSourceIds = collectAutomaticRecoveredSourceIds(safeMessages);
  const childErrorIds = new Set(
    safeMessages
      .filter((message) => message.role === "assistant" && !!message._errorCode)
      .map((message) => message._clientMessageId)
      .filter(isNonEmptyId),
  );
  const manuallyContinuedSourceIds = new Set(
    safeMessages
      .filter(
        (message) =>
          isRecoveryControlUserTurn(message) &&
          message._automaticRecovery !== true &&
          (message.status !== "error" || childErrorIds.has(message.id)),
      )
      .map((message) => message._recoveryOfClientMessageId)
      .filter(isNonEmptyId),
  );
  const continuationViewMessages = safeMessages.map((message): ChatMessage =>
    message.role === "assistant" &&
    !!message._errorCode &&
    typeof message._clientMessageId === "string" &&
    manuallyContinuedSourceIds.has(message._clientMessageId)
      ? { ...message, _errorHeldForRecovery: true, _errorCardSnapshot: { disposition: "silent" } }
      : message,
  );
  const turnLineageParents = turnRecoveryParents(safeMessages);
  const renderableMessages = projectVisibleAssistantRows(
    splitStoppedNarration(
      returnStrayRowsToOwnerTurn(
        continuationViewMessages.filter(
          (m) =>
            !(m as ChatMessage & { _historyProjection?: unknown })._historyProjection &&
            typeof m.id === "string" &&
            !m.id.startsWith("projection-") &&
            !m.id.startsWith("oc-dispatch-err:") &&
            m._turnTapeProcess !== true &&
            m._timelineAuxiliary === undefined &&
            m.role !== "runtime-event" &&
            !isRecoveryControlUserTurn(m) &&
            !(
              m.role === "assistant" &&
              !!m._errorCode &&
              typeof m._clientMessageId === "string" &&
              recoveredSourceIds.has(m._clientMessageId) &&
              (m._errorCardSnapshot?.disposition !== "card" ||
                manuallyContinuedSourceIds.has(m._clientMessageId)) &&
              !isErrorCardHeldWithAnswer(m)
            ) &&
            !(isErrorCardHeld(m) && !isErrorCardHeldWithAnswer(m)) &&
            !isRedundantRuntimeEnvelope(m) &&
            !recoveredStatusRecordIds.has(m.id) &&
            !isTurnStatusSuppressedByTape(m, resolvedDispatchTurnIds) &&
            !isErrorCardSupersededByTurnStatus(m, statusRecordTurnIds),
        ),
      ),
    ),
    turnLineageParents,
  );
  const visibleUserIds = new Set(
    renderableMessages.filter((message) => message.role === "user").map((message) => message.id),
  );
  const recoveryParents = new Map(
    safeMessages
      .filter(
        (message) =>
          isRecoveryControlUserTurn(message) && isNonEmptyId(message._recoveryOfClientMessageId),
      )
      .map((message) => [message.id, message._recoveryOfClientMessageId as string]),
  );
  const visibleErrorTurnId = (clientMessageId: string) => {
    let current = clientMessageId;
    const visited = new Set<string>();
    while (!visibleUserIds.has(current) && !visited.has(current)) {
      visited.add(current);
      const parent = recoveryParents.get(current);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const presentedErrorTurnIds = new Set(
    renderableMessages
      .filter(
        (message) =>
          typeof message._clientMessageId === "string" &&
          message._clientMessageId.length > 0 &&
          (message._turnStatusRecord === true ||
            (message.role === "assistant" && !!message._errorCode && !isErrorCardHeld(message))),
      )
      .map((message) => visibleErrorTurnId(message._clientMessageId as string)),
  );
  for (const sourceId of manuallyContinuedSourceIds) {
    presentedErrorTurnIds.add(visibleErrorTurnId(sourceId));
  }
  const renderableIds = new Set(renderableMessages.map((message) => message.id));
  const failureIsPresentedBelow = (message: ChatMessage): boolean =>
    recoveryFailureIsPresentedBelow({
      message,
      presentedErrorTurnIds,
      automaticRecoveredSourceIds,
      safeMessages,
      renderableIds,
      visibleErrorTurnId,
    });

  return {
    safeMessages,
    renderableMessages,
    turnLineageParents,
    failureIsPresentedBelow,
  };
}
