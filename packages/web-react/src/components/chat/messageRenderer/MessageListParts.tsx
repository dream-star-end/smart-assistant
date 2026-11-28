import { Info } from "lucide-react";
import { memo, type MutableRefObject, type ReactNode } from "react";
import type { ChatMessage } from "../../../lib/chat/model";
import { safeMessageSignature } from "../../../lib/chat/render";
import type { UserUpwardPagingController } from "../../../lib/chat/tapePaging";
import { PAINT_ESTIMATE_PX, PAINT_MIN_ITEMS } from "../../../lib/chat/timelinePaint";
import { cn } from "../../../lib/utils";
import { MessageBoundary } from "../../MessageBoundary";
import { TaskApprovalGroupSlot } from "../../tool/taskApprovalCoalesce";
import { Alert, Spinner } from "../../ui";
import type { CardCallbacks } from "../cards";
import { ThinkingCard } from "../cards";
import { PartialHistorySkeleton } from "../HistorySkeleton";
import { GeneratingPlaceholderCard, TeamPanel } from "../lazyTimelineCards";
import type { PermissionRespond } from "../permissionPromptState";
import {
  keepDistinctActivity,
  ProcessDisclosure,
  processSections,
  turnOutcome,
} from "../ProcessDisclosure";
import { TimelineEagerMediaContext } from "../timelineEager";
import { delegateTokenUsage, tokenUsageSignature } from "../tokenUsage";
import { TurnActivity, type TurnActivityInfo } from "../TurnActivity";
import { processTimeBounds, turnHasVisibleWork } from "./processCoalesce";
import {
  itemMessages,
  type LeafRenderItem,
  type MessageListArchive,
  type MessageRendererComponent,
  type ProcessRenderItem,
  type RenderItem,
  renderItemKey,
  type SingleRenderItem,
} from "./types";

export function TapeBackedCard({ children }: { children: ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

/**
 * 「工作过程」组的 memo 边界(#1240)。已结束的组以 sig 比较，进行中的组(live)照常每帧渲染。
 */
const ProcessGroupMemo = memo(
  function ProcessGroupMemo({
    children,
  }: {
    live: boolean;
    sig: string;
    deps: readonly unknown[];
    children: ReactNode;
  }) {
    return <>{children}</>;
  },
  (a, b) =>
    !a.live &&
    !b.live &&
    a.sig === b.sig &&
    a.deps.length === b.deps.length &&
    a.deps.every((value, index) => Object.is(value, b.deps[index])),
);

function genPlaceholderSig(m: ChatMessage): string {
  const gp = m._genPlaceholder;
  return `genph|${m.id}|${gp?.status}|${gp?.startedAt}|${gp?.aspect}`;
}

function singleRowSig(
  it: SingleRenderItem,
  sending: boolean,
  actionRowFinal: readonly boolean[],
  failureIsPresentedBelow: (m: ChatMessage) => boolean,
): string {
  const turnFinalAssistant = actionRowFinal[it.idx] ?? false;
  const failurePresentedBelow = failureIsPresentedBelow(it.m);
  return `${safeMessageSignature(it.m, {
    isLast: it.isLast,
    sending,
    turnFinalAssistant,
  })}|tu:${tokenUsageSignature(it.tokenUsage)}|du:${tokenUsageSignature(delegateTokenUsage(it.m))}|pe:${failurePresentedBelow ? 1 : 0}`;
}

export type TimelineItemRenderContext = {
  renderItems: RenderItem[];
  turnStart: number;
  actionRowFinal: readonly boolean[];
  failureIsPresentedBelow: (m: ChatMessage) => boolean;
  sending: boolean;
  sessionId: string | undefined;
  historyGeneration: number | string;
  processPaging: UserUpwardPagingController;
  turnActivity: TurnActivityInfo | null | undefined;
  readOnly: boolean;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  findQuery: string;
  disclosureValues: Record<string, boolean>;
  setDisclosure: (key: string, open: boolean) => void;
  olderLiveStepsKey: string | null;
  olderLiveStepsControl: ReactNode;
  eagerPayloadKeysRef: MutableRefObject<Set<string> | null>;
  renderRecord: MessageRendererComponent;
};

function computeLeafMemoKey(it: LeafRenderItem, ctx: TimelineItemRenderContext): string {
  if (it.kind === "team") return `team|${it.sig}|${JSON.stringify(it.delegateCosts ?? null)}`;
  if (it.kind === "thinking") return `thinking|${it.sig}|${it.tokenUsage?.totalTokens ?? ""}`;
  if (it.m._genPlaceholder) return genPlaceholderSig(it.m);
  const rowId = it.m._timelineUnitKey ?? it.m.id;
  let rowSig: string;
  try {
    rowSig = singleRowSig(it, ctx.sending, ctx.actionRowFinal, ctx.failureIsPresentedBelow);
  } catch {
    rowSig = `corrupt-row|${rowId}`;
  }
  const eager = ctx.eagerPayloadKeysRef.current?.has(rowId) === true ? 1 : 0;
  return `${rowSig}|ia:${it.idx >= ctx.turnStart ? 1 : 0}|dc:${it.delegateCost ?? ""}|ep:${eager}`;
}

function renderProcessGroupItem(
  it: ProcessRenderItem,
  renderIndex: number | undefined,
  ctx: TimelineItemRenderContext,
  renderItem: (child: RenderItem, idx?: number) => ReactNode,
): ReactNode {
  const sections = processSections(it.items, itemMessages, renderItemKey);
  const needle = ctx.findQuery.trim().toLowerCase();
  const sectionHit = (section: { messages: ChatMessage[]; narrative: boolean }) =>
    !!needle &&
    section.messages.some(
      (message) =>
        (message.role === "assistant" || message.role === "user") &&
        (message.text ?? "").toLowerCase().includes(needle),
    );
  const explicit = ctx.disclosureValues[it.key];
  const open = sections.some(sectionHit) || (explicit === undefined ? it.active : explicit);
  const bounds = processTimeBounds(ctx.renderItems, it, renderIndex);
  const olderSteps = ctx.olderLiveStepsKey === it.key ? ctx.olderLiveStepsControl : null;
  const live = it.active || olderSteps !== null;
  const sig = live
    ? ""
    : [
        open ? 1 : 0,
        needle,
        bounds.startedAt ?? "",
        bounds.endedAt ?? "",
        turnOutcome(bounds.following),
        ...sections.map((section) => (ctx.disclosureValues[`detail:${section.key}`] === true ? 1 : 0)),
        ...it.items.map((leaf) => computeLeafMemoKey(leaf, ctx)),
      ].join("\u0001");

  return (
    <ProcessGroupMemo
      live={live}
      sig={sig}
      deps={[
        ctx.sessionId, ctx.sending, ctx.historyGeneration,
        ctx.processPaging, ctx.readOnly, ctx.cb, ctx.onRespondPermission,
      ]}
    >
      <ProcessDisclosure
        sections={sections}
        onFirstTextPaint={ctx.cb.onFirstTextPaint}
        active={it.active}
        open={open}
        setOpen={(next) => ctx.setDisclosure(it.key, next)}
        detailOpen={(key) => {
          if (ctx.disclosureValues[`detail:${key}`] === true) return true;
          const section = sections.find((candidate) => candidate.key === key);
          return !!section && sectionHit(section);
        }}
        setDetailOpen={(key, nextOpen) => ctx.setDisclosure(`detail:${key}`, nextOpen)}
        renderItem={renderItem}
        keyOf={renderItemKey}
        messagesOf={itemMessages}
        olderSteps={olderSteps}
        activity={it.active ? ctx.turnActivity : null}
        bounds={bounds}
        swarm={it.swarm}
        tokenUsageOf={(item) => ("tokenUsage" in item ? item.tokenUsage : undefined)}
      />
    </ProcessGroupMemo>
  );
}

function renderSingleMessageItem(it: SingleRenderItem, ctx: TimelineItemRenderContext): ReactNode {
  const RenderRecord = ctx.renderRecord;
  const turnFinalAssistant = ctx.actionRowFinal[it.idx] ?? false;
  const failurePresentedBelow = ctx.failureIsPresentedBelow(it.m);
  const rowId = it.m._timelineUnitKey ?? it.m.id;
  let rowSig: string;
  try {
    rowSig = singleRowSig(it, ctx.sending, ctx.actionRowFinal, ctx.failureIsPresentedBelow);
  } catch {
    return (
      <MessageBoundary messageId={rowId} sig={`corrupt-row|${rowId}`}>
        <div
          className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-meta text-muted"
          data-testid="corrupt-message-placeholder"
        >
          该条内容暂时无法显示
        </div>
      </MessageBoundary>
    );
  }
  return (
    <MessageBoundary messageId={rowId} sig={rowSig}>
      <RenderRecord
        message={it.m}
        sig={rowSig}
        isLast={it.isLast}
        sending={ctx.sending}
        inActiveTurn={it.idx >= ctx.turnStart}
        turnActivity={ctx.turnActivity}
        activityInFooter={ctx.sending}
        historyGeneration={ctx.historyGeneration}
        processPaging={ctx.processPaging}
        tokenUsage={it.tokenUsage}
        delegateCost={it.delegateCost}
        turnFinalAssistant={turnFinalAssistant}
        cb={ctx.cb}
        onRespondPermission={ctx.onRespondPermission}
        readOnly={ctx.readOnly}
        failurePresentedBelow={failurePresentedBelow}
        eagerPayload={ctx.eagerPayloadKeysRef.current?.has(rowId) === true}
        hostedPermission
      />
    </MessageBoundary>
  );
}

export function createTimelineItemRenderer(
  ctx: TimelineItemRenderContext,
): (it: RenderItem, renderIndex?: number) => ReactNode {
  const renderItem = (it: RenderItem, renderIndex?: number): ReactNode => {
    if (it.kind === "approval-group") {
      return (
        <TaskApprovalGroupSlot ticketIds={it.ticketIds}>
          {it.items.map((child) => (
            <div key={renderItemKey(child)}>{renderItem(child, renderIndex)}</div>
          ))}
        </TaskApprovalGroupSlot>
      );
    }
    if (it.kind === "process") {
      return renderProcessGroupItem(it, renderIndex, ctx, renderItem);
    }
    if (it.kind === "single" && it.m._genPlaceholder) {
      const gp = it.m._genPlaceholder;
      return (
        <MessageBoundary messageId={it.m.id} sig={genPlaceholderSig(it.m)}>
          <GeneratingPlaceholderCard
            aspect={gp.aspect}
            status={gp.status}
            startedAt={gp.startedAt}
            reason={gp.reason}
          />
        </MessageBoundary>
      );
    }
    if (it.kind === "team") {
      return (
        <MessageBoundary messageId={it.members[0]!.id} sig={it.sig}>
          <TeamPanel members={it.members} sig={it.sig} delegateCosts={it.delegateCosts} />
        </MessageBoundary>
      );
    }
    if (it.kind === "thinking") {
      return (
        <MessageBoundary messageId={it.members[0]!.id} sig={it.sig}>
          <TapeBackedCard>
            <ThinkingCard
              msgs={it.members}
              sig={it.sig}
              ctx={{ isLast: it.isLast, sending: ctx.sending, activityInFooter: ctx.sending }}
              tokenUsage={it.tokenUsage}
            />
          </TapeBackedCard>
        </MessageBoundary>
      );
    }
    return renderSingleMessageItem(it, ctx);
  };
  return renderItem;
}

export function resolveOlderLiveStepsKey(
  liveHasMore: boolean,
  liveAttention: "error" | "cap" | null,
  visibleItems: RenderItem[],
): string | null {
  if (!liveHasMore || !liveAttention) return null;
  let key: string | null = null;
  for (const item of visibleItems) {
    if (item.kind === "process") key = renderItemKey(item);
  }
  return key;
}

export function OlderLiveStepsLoader({
  liveHasMore,
  liveAttention,
  liveUnitsBusy,
  onClick,
}: {
  liveHasMore: boolean;
  liveAttention: "error" | "cap" | null;
  liveUnitsBusy: boolean;
  onClick: () => void;
}) {
  if (!liveHasMore || !liveAttention) return null;
  return (
    <div className="flex justify-center pb-2" data-testid="older-live-steps-loader">
      <button
        type="button"
        onClick={onClick}
        disabled={liveUnitsBusy}
        aria-busy={liveUnitsBusy}
        className="oc-btn-tactile oc-btn-secondary-craft inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface px-3.5 py-1 text-caption font-medium text-muted shadow-soft transition-colors hover:border-border-strong hover:text-fg disabled:cursor-default disabled:opacity-60 [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-2.5"
      >
        {liveUnitsBusy
          ? <><Spinner size={12} /> 加载中…</>
          : liveAttention === "error"
            ? <span className="text-danger">加载失败，点击重试</span>
            : "加载更早的处理步骤"}
      </button>
    </div>
  );
}

function historyButtonLabel(
  canRevealOlder: boolean,
  windowStart: number,
  busy: boolean,
  hasError: boolean,
  legacyArchivedRemaining: number,
): ReactNode {
  if (!canRevealOlder) return "已到最早记录";
  if (windowStart === 0 && busy) return <><Spinner size={12} /> 加载中…</>;
  if (windowStart === 0 && hasError) return <span className="text-danger">加载失败，点击重试</span>;
  if (windowStart > 0) return `查看更早历史记录（还有 ${windowStart} 条）`;
  if (legacyArchivedRemaining > 0) return `查看更早历史记录（还有 ${legacyArchivedRemaining} 条）`;
  return "查看更早历史记录";
}

export function HistoryPageLoader({
  showHistoryBoundary,
  windowStart,
  hasOlderHistory,
  legacyArchivedRemaining,
  archive,
  archiveQueued,
  onExpandLocal,
  onRequestOlderArchive,
}: {
  showHistoryBoundary: boolean;
  windowStart: number;
  hasOlderHistory: boolean;
  legacyArchivedRemaining: number;
  archive: MessageListArchive | null | undefined;
  archiveQueued: boolean;
  onExpandLocal: () => void;
  onRequestOlderArchive: () => void;
}) {
  if (!showHistoryBoundary) return null;
  const canRevealOlder = windowStart > 0 || hasOlderHistory;
  const busy = Boolean(archive?.loading) || archiveQueued;
  return (
    <div
      className="mx-auto flex max-w-3xl justify-center px-5 pb-4 pt-8"
      data-testid="history-page-loader"
    >
      <button
        type="button"
        onClick={windowStart > 0 ? onExpandLocal : hasOlderHistory ? onRequestOlderArchive : undefined}
        disabled={!canRevealOlder || busy}
        aria-busy={hasOlderHistory && windowStart === 0 && busy}
        className="oc-btn-tactile oc-btn-secondary-craft mx-auto inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface px-3.5 py-1 text-caption font-medium text-muted shadow-soft transition-colors hover:border-border-strong hover:text-fg disabled:cursor-default disabled:opacity-60 [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-2.5"
      >
        {historyButtonLabel(canRevealOlder, windowStart, busy, Boolean(archive?.error), legacyArchivedRemaining)}
      </button>
    </div>
  );
}

export function TimelineFooter({
  processDisclosure,
  renderItems,
  renderableMessages,
  turnStart,
  sending,
  turnActivity,
  transientNotice,
  historyLoading,
}: {
  processDisclosure: boolean;
  renderItems: RenderItem[];
  renderableMessages: ChatMessage[];
  turnStart: number;
  sending: boolean;
  turnActivity: TurnActivityInfo | null | undefined;
  transientNotice: { text: string } | null | undefined;
  historyLoading: boolean;
}) {
  const workVisible = turnHasVisibleWork(processDisclosure, renderItems, renderableMessages, turnStart);
  const showTurnActivity = sending && (!workVisible || keepDistinctActivity(turnActivity));
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-8 pt-4" data-testid="timeline-footer">
      <div data-testid="turn-activity-footer">
        {showTurnActivity ? (
          <div className="min-w-0">
            <TurnActivity info={turnActivity ?? { startedAt: null, agentName: "助手" }} />
          </div>
        ) : null}
      </div>
      {transientNotice && (
        <Alert tone="info" icon={<Info size={16} />}>
          {transientNotice.text}
        </Alert>
      )}
      {historyLoading && <PartialHistorySkeleton />}
    </div>
  );
}

export function PaintedTimelineRows({
  paintedItems,
  visibleItemsLength,
  paintStart,
  windowStart,
  pinPaintStart,
  estimatePx,
  findActive,
  findCurrentRenderKey,
  findHitRowKeys,
  eagerMediaKeysRef,
  rowHeightCacheRef,
  renderItem,
}: {
  paintedItems: RenderItem[];
  visibleItemsLength: number;
  paintStart: number;
  windowStart: number;
  pinPaintStart: number | undefined;
  estimatePx: number;
  findActive: boolean;
  findCurrentRenderKey: string | undefined;
  findHitRowKeys: ReadonlySet<string>;
  eagerMediaKeysRef: MutableRefObject<Set<string> | null>;
  rowHeightCacheRef: MutableRefObject<Map<string, number>>;
  renderItem: (it: RenderItem, renderIndex?: number) => ReactNode;
}) {
  return (
    <>
      {paintedItems.map((item, paintedIndex) => {
        const key = renderItemKey(item);
        const findCurrentHere = findCurrentRenderKey === key;
        const findRowHit = findHitRowKeys.has(key);
        const eagerMedia = eagerMediaKeysRef.current?.has(key) === true;
        const visibleIndex = paintStart + paintedIndex;
        const liveRow =
          (typeof pinPaintStart === "number" && visibleIndex >= pinPaintStart) ||
          visibleIndex >= visibleItemsLength - PAINT_MIN_ITEMS;
        const cachedHeight = liveRow
          ? undefined
          : rowHeightCacheRef.current.get(key) ??
            (estimatePx !== PAINT_ESTIMATE_PX ? estimatePx : undefined);
        return (
          <TimelineEagerMediaContext.Provider key={key} value={eagerMedia}>
            <div
              className={cn(
                liveRow
                  ? "chat-virtual-item chat-timeline-row chat-timeline-row-live"
                  : "chat-virtual-item chat-timeline-row",
                findActive && findCurrentHere && "ring-1 ring-accent/60",
                findActive && !findCurrentHere && findRowHit && "bg-accent-soft/30",
              )}
              data-chat-virtual-key={key}
              data-find-current={findActive && findCurrentHere ? "" : undefined}
              style={cachedHeight ? { containIntrinsicSize: `auto ${cachedHeight}px` } : undefined}
            >
              {renderItem(item, windowStart + visibleIndex)}
            </div>
          </TimelineEagerMediaContext.Provider>
        );
      })}
    </>
  );
}
