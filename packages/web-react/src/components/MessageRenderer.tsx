import { ReadOnlySystemActionsBoundary } from "./iui/ReadOnlySystemActionsBoundary";
/**
 * P5 会话渲染入口（门面）。
 *
 * MessageRenderer：按 role 分派单条 ChatMessage 到对应卡片（tool 委托 ToolCardSlot），
 * 经 messageSignature 做 memo 防闪。
 * MessageList：会话消息流列表 + 虚拟画窗 + 向上分页 + 会话内查找（子模块位于 chat/messageRenderer/*）。
 */
import { memo, type ReactNode } from "react";
import type { ChatMessage } from "../lib/chat/model";
import { isRecoveryTurnClientMessageId } from "../lib/chat/pure";
import { isRedundantRuntimeEnvelope, messageKind } from "../lib/chat/render";
import {
  AssistantCard,
  DelegateProgressCard,
  PlanCard,
  SystemCard,
  ThinkingCard,
  TurnStatusCard,
  UserCard,
} from "./chat/cards";
import { FirstTextPaintCommitProbe } from "./chat/FirstTextPaintCommitProbe";
import {
  AgentGroupCard,
  DeferredTapeRecordCard,
  ExactTapeRecordDisclosure,
  GeneratingPlaceholderCard,
  PermissionCard,
  RuntimeEventCard,
} from "./chat/lazyTimelineCards";
import { TapeBackedCard } from "./chat/messageRenderer/MessageListParts";
import { MessageListView } from "./chat/messageRenderer/MessageListView";
import {
  type MessageListArchive,
  type MessageListProps,
  type RendererProps,
  TIMELINE_INITIAL_TAIL_ITEMS,
} from "./chat/messageRenderer/types";
import { isAwaitingPermissionPrompt } from "./chat/permissionPromptState";
import { isClearedGoalRecord, isHistoricalGoalRecord } from "./chat/ProcessDisclosure";
import { shouldShowScrollToBottom } from "./chat/ScrollToBottomButton";
import type { DisplayTokenUsage } from "./chat/tokenUsage";
import { ToolCardSlot } from "./chat/toolCardSlot";
import { asStr, resolveToolInput } from "./tool/format";

export { shouldShowScrollToBottom, TIMELINE_INITIAL_TAIL_ITEMS };
export type { MessageListArchive };

export function MessageRenderer(props: RendererProps) {
  return (
    <ReadOnlySystemActionsBoundary readOnly={props.readOnly ?? false}>
      <MessageRendererInner {...props} />
    </ReadOnlySystemActionsBoundary>
  );
}

export function MessageList(props: MessageListProps) {
  return (
    <ReadOnlySystemActionsBoundary readOnly={props.readOnly ?? false}>
      <MessageListView props={props} renderRecord={MessageRenderer} />
    </ReadOnlySystemActionsBoundary>
  );
}

function shouldSuppressTimelineRow(message: ChatMessage): boolean {
  if (message._timelineAuxiliary || message.role === "runtime-event") return true;
  if (isRedundantRuntimeEnvelope(message)) return true;
  return Boolean(message._turnTapeProcess);
}

function renderToolMessageCard(
  message: ChatMessage,
  inActiveTurn: boolean,
  sending: boolean,
  tokenUsage: DisplayTokenUsage | undefined,
): ReactNode {
  if (message.toolName === "codex:imageGeneration") {
    const input = resolveToolInput(message);
    const failedStatus = /^(failed|error)$/i.test(asStr(input?.status)) || !!message.error;
    const running = !message._completed && !message.error && !failedStatus;
    if (running) {
      return <GeneratingPlaceholderCard aspect={1} status="running" startedAt={message.ts} />;
    }
  }
  if (message.toolName === "TodoWrite" && inActiveTurn && sending) {
    return null;
  }
  return <ToolCardSlot message={message} tokenUsage={tokenUsage} />;
}

function renderPlanMessageCard(
  message: ChatMessage,
  inActiveTurn: boolean,
  sending: boolean,
  readOnly: boolean,
  tokenUsage: DisplayTokenUsage | undefined,
): ReactNode {
  if ((message.steps?.length ?? 0) > 0 && inActiveTurn && sending) return null;
  return (
    <TapeBackedCard>
      <PlanCard msg={message} tokenUsage={tokenUsage} />
      {readOnly && <ExactTapeRecordDisclosure messages={[message]} label="计划" />}
    </TapeBackedCard>
  );
}

function renderPermissionMessageCard(props: RendererProps): ReactNode {
  const { message, inActiveTurn, sending, onRespondPermission, readOnly = false, hostedPermission = false } = props;
  // INC-20260904-STOP-LEAVES-PERMISSION-PENDING (fix C):
  // Recovery-owned (`m-recover-*`) unresolved prompts stay live even when `_sendingInFlight` is false.
  const recoveryOwned = isRecoveryTurnClientMessageId(message._turnOwnerId);
  const live =
    !readOnly &&
    inActiveTurn &&
    (sending || (recoveryOwned && isAwaitingPermissionPrompt(message)));
  return (
    <PermissionCard
      msg={message}
      onRespond={onRespondPermission}
      readOnly={readOnly}
      livePrompt={live}
      renderMode={hostedPermission ? "card" : "both"}
    />
  );
}

function renderAuxiliaryMessageCard(props: RendererProps): ReactNode {
  const { message, delegateCost } = props;
  switch (messageKind(message)) {
    case "agent-group":
      return <AgentGroupCard msg={message} delegateCost={delegateCost} />;
    case "delegate-progress":
      return <DelegateProgressCard msg={message} />;
    case "system":
      return <SystemCard msg={message} />;
    default:
      return message._timelineRecord === true || message._turnTapeId
        ? <RuntimeEventCard message={message} />
        : null;
  }
}

function areRendererPropsEqual(a: RendererProps, b: RendererProps): boolean {
  return (
    a.sig === b.sig &&
    a.inActiveTurn === b.inActiveTurn &&
    a.tokenUsage?.totalTokens === b.tokenUsage?.totalTokens &&
    a.delegateCost === b.delegateCost &&
    a.activityInFooter === b.activityInFooter &&
    a.historyGeneration === b.historyGeneration &&
    a.processPaging === b.processPaging &&
    a.readOnly === b.readOnly &&
    a.failurePresentedBelow === b.failurePresentedBelow &&
    a.eagerPayload === b.eagerPayload &&
    a.cb === b.cb &&
    a.onRespondPermission === b.onRespondPermission
  );
}

const MessageRendererInner = memo(
  function MessageRenderer(props: RendererProps) {
    const { message, sig, isLast, sending, inActiveTurn, cb, readOnly = false } = props;
    if (shouldSuppressTimelineRow(message)) return null;
    if (message._payloadDeferred) {
      return <DeferredTapeRecordCard {...props} renderRecord={MessageRenderer} />;
    }
    if (message._turnStatusRecord) {
      return <TurnStatusCard msg={message} cb={cb} currentTurn={inActiveTurn} />;
    }
    const ctx = {
      isLast,
      sending,
      turnActivity: props.turnActivity,
      inActiveTurn,
      turnFinalAssistant: props.turnFinalAssistant,
      activityInFooter: props.activityInFooter,
    };
    switch (messageKind(message)) {
      case "user":
        return (
          <UserCard
            msg={message}
            cb={cb}
            failurePresentedBelow={props.failurePresentedBelow ?? false}
            readOnly={readOnly}
            awaitingReply={sending && isLast}
          />
        );
      case "assistant":
        return (
          <>
            <FirstTextPaintCommitProbe message={message} onFirstTextPaint={cb.onFirstTextPaint} />
            <AssistantCard msg={message} ctx={ctx} cb={cb} tokenUsage={props.tokenUsage} readOnly={readOnly} />
          </>
        );
      case "thinking":
        return (
          <TapeBackedCard>
            <ThinkingCard msgs={[message]} sig={sig} ctx={ctx} tokenUsage={props.tokenUsage} />
          </TapeBackedCard>
        );
      case "tool":
        return renderToolMessageCard(message, inActiveTurn, sending, props.tokenUsage);
      case "plan":
        return renderPlanMessageCard(message, inActiveTurn, sending, readOnly, props.tokenUsage);
      case "goal":
        // Current objectives belong only to the composer dock. Completed
        // rows remain read-only historical diagnostics inside the process.
        if (isClearedGoalRecord(message) || !isHistoricalGoalRecord(message)) return null;
        return (
          <TapeBackedCard>
            <p className="whitespace-pre-wrap break-words text-sm text-fg">{message.text || "会话目标"}</p>
            {readOnly && <ExactTapeRecordDisclosure messages={[message]} label="目标" />}
          </TapeBackedCard>
        );
      case "permission":
        return renderPermissionMessageCard(props);
      default:
        return renderAuxiliaryMessageCard(props);
    }
  },
  areRendererPropsEqual,
);
