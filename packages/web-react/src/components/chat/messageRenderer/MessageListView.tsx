import { type ReactNode, useMemo, useRef, useState } from "react";
import { UserUpwardPagingController } from "../../../lib/chat/tapePaging";
import { createBlankDetector } from "../../../lib/chat/timelineBlankProbe";
import type { VisibleVirtualRowAnchor } from "../archivePaging";
import { PermissionPromptHost } from "../lazyTimelineCards";
import {
  ScrollToBottomButton,
  shouldShowScrollToBottom,
  useScrollToBottomVisibility,
} from "../ScrollToBottomButton";
import {
  projectTimelineMessages,
  timelineMessagesFingerprint,
} from "../timelineProjection";
import {
  createTimelineItemRenderer,
  HistoryPageLoader,
  OlderLiveStepsLoader,
  PaintedTimelineRows,
  resolveOlderLiveStepsKey,
  TimelineFooter,
} from "./MessageListParts";
import {
  buildTimelineRenderPipeline,
  filterTimelineInputMessages,
} from "./processCoalesce";
import {
  projectSessionFind,
  SessionFindBar,
  type SessionFindState,
  useSessionFindState,
} from "./SessionFindBar";
import {
  type FollowBottomControllerRef,
  type LiveUnitsViewportHold,
  type MessageListArchive,
  type MessageListProps,
  type MessageRendererComponent,
  type RenderItem,
  rowHeightBucket,
  TIMELINE_INITIAL_TAIL_ITEMS,
} from "./types";
import {
  computeTimelinePaintWindow,
  useArchiveAndLiveUnitsPaging,
} from "./useTimelinePagingAndWindow";
import {
  useExpandAndLiveSettleLayoutEffect,
  useInitialBottomSnapLayoutEffect,
  useListResizeFollowLayoutEffect,
  useLiveUnitsHoldLayoutEffect,
  useRowMeasureAndSpanAnchorLayoutEffect,
} from "./viewportLayoutEffects";
import {
  usePrefetchMarkdownEffect,
  useRowGeometryWarmupEffect,
  useScrollerPagingAndExpandEffect,
  useScrollPaintRangeEffect,
  useTimelineBlankProbeEffect,
} from "./viewportScrollEffects";

function useViewportGeometryRefs(
  sessionId: string | undefined,
  followBottomRef: FollowBottomControllerRef | undefined,
) {
  const [windowVersion, setWindowVersion] = useState(0);
  const [paintRange, setPaintRange] = useState({ start: 0, end: TIMELINE_INITIAL_TAIL_ITEMS });
  const itemCountRef = useRef(0);
  const visibleCountRef = useRef(0);
  const startOverrideRef = useRef<number | null>(null);
  const pendingExpandCorrectionRef = useRef<{ height: number; top: number } | null>(null);
  const viewportPreserveLockRef = useRef(false);
  const liveUnitsHoldRef = useRef<LiveUnitsViewportHold | null>(null);
  const liveUnitsSettleRef = useRef<LiveUnitsViewportHold | null>(null);
  const listRootRef = useRef<HTMLDivElement | null>(null);
  const didSnapToBottomRef = useRef(false);
  const followBottomRefBox = useRef(followBottomRef);
  followBottomRefBox.current = followBottomRef;
  const lastViewportAnchorRef = useRef<VisibleVirtualRowAnchor | null>(null);
  const rowHeightCacheRef = useRef<Map<string, number>>(rowHeightBucket(sessionId));
  const visibleKeysRef = useRef<string[]>([]);
  const eagerPayloadKeysRef = useRef<Set<string> | null>(null);
  const eagerMediaKeysRef = useRef<Set<string> | null>(null);
  const lastPaintSpanRef = useRef({ start: -1, end: -1 });
  const pinStartRef = useRef<number | undefined>(undefined);
  const blankDetectorRef = useRef(createBlankDetector());
  const blankProbeStateRef = useRef({ paintStart: 0, paintEnd: 0, sending: false, messagesLength: 0 });
  const sessionIdRef = useRef(sessionId);

  const beginViewportPreserve = () => {
    viewportPreserveLockRef.current = true;
    const follow = followBottomRefBox.current;
    if (follow) follow.current = false;
  };
  const endViewportPreserve = () => {
    if (typeof requestAnimationFrame !== "function") {
      viewportPreserveLockRef.current = false;
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewportPreserveLockRef.current = false;
      });
    });
  };

  return {
    windowVersion, setWindowVersion, paintRange, setPaintRange,
    itemCountRef, visibleCountRef, startOverrideRef, pendingExpandCorrectionRef,
    viewportPreserveLockRef, liveUnitsHoldRef, liveUnitsSettleRef, listRootRef,
    didSnapToBottomRef, followBottomRefBox, lastViewportAnchorRef, rowHeightCacheRef,
    visibleKeysRef, eagerPayloadKeysRef, eagerMediaKeysRef, lastPaintSpanRef,
    pinStartRef, blankDetectorRef, blankProbeStateRef, sessionIdRef,
    beginViewportPreserve, endViewportPreserve,
  };
}

function useMessageListSessionCore(props: MessageListProps) {
  const { messages: rawMessages, sessionId, historyGeneration = "legacy", scrollParent, followBottomRef } = props;
  const messagesFingerprint = timelineMessagesFingerprint(rawMessages);
  const messages = useMemo(
    () => filterTimelineInputMessages(rawMessages, messagesFingerprint),
    [rawMessages, messagesFingerprint],
  );
  const [disclosureState, setDisclosureState] = useState<{
    session?: string;
    values: Record<string, boolean>;
  }>({ values: {} });
  const disclosureValues = disclosureState.session === sessionId ? disclosureState.values : {};
  const setDisclosure = (key: string, open: boolean) =>
    setDisclosureState((previous) => ({
      session: sessionId,
      values: { ...(previous.session === sessionId ? previous.values : {}), [key]: open },
    }));

  const pagingOwnerRef = useRef<{ generation: string; controller: UserUpwardPagingController } | null>(null);
  const pagingGeneration = String(historyGeneration);
  if (!pagingOwnerRef.current || pagingOwnerRef.current.generation !== pagingGeneration) {
    pagingOwnerRef.current = {
      generation: pagingGeneration,
      controller: new UserUpwardPagingController(),
    };
  }
  const processPaging = pagingOwnerRef.current.controller;
  const geometry = useViewportGeometryRefs(sessionId, followBottomRef);
  const [showScrollToBottom, setShowScrollToBottom] = useScrollToBottomVisibility({
    scrollParent,
    listRootRef: geometry.listRootRef,
    followBottomRef,
    sessionId,
    messageCount: messages.length,
  });

  return {
    messages, disclosureValues, setDisclosure, pagingGeneration,
    processPaging, showScrollToBottom, setShowScrollToBottom, ...geometry,
  };
}

type SessionCore = ReturnType<typeof useMessageListSessionCore>;

function syncSessionSwitchRefs(
  core: SessionCore,
  findState: SessionFindState,
  sessionId: string | undefined,
): void {
  if (core.sessionIdRef.current === sessionId) return;
  core.sessionIdRef.current = sessionId;
  core.startOverrideRef.current = null;
  core.didSnapToBottomRef.current = false;
  core.viewportPreserveLockRef.current = false;
  core.liveUnitsHoldRef.current = null;
  core.liveUnitsSettleRef.current = null;
  core.rowHeightCacheRef.current = rowHeightBucket(sessionId);
  core.visibleKeysRef.current = [];
  core.eagerPayloadKeysRef.current = null;
  core.eagerMediaKeysRef.current = null;
  core.lastViewportAnchorRef.current = null;
  core.lastPaintSpanRef.current = { start: -1, end: -1 };
  findState.findGenRef.current += 1;
  findState.findPinRef.current = null;
}

function useTimelineObserverEffects(props: MessageListProps, core: SessionCore): void {
  const { cb, scrollParent, sessionId } = props;
  const messagesLength = core.messages.length;
  useScrollerPagingAndExpandEffect({
    scrollParent, processPaging: core.processPaging, itemCountRef: core.itemCountRef,
    startOverrideRef: core.startOverrideRef, pendingExpandCorrectionRef: core.pendingExpandCorrectionRef,
    liveUnitsHoldRef: core.liveUnitsHoldRef, viewportPreserveLockRef: core.viewportPreserveLockRef,
    beginViewportPreserve: core.beginViewportPreserve, setWindowVersion: core.setWindowVersion,
  });
  useScrollPaintRangeEffect({
    scrollParent, windowVersion: core.windowVersion, sessionId, messagesLength,
    visibleCountRef: core.visibleCountRef, visibleKeysRef: core.visibleKeysRef,
    followBottomRefBox: core.followBottomRefBox, rowHeightCacheRef: core.rowHeightCacheRef,
    pinStartRef: core.pinStartRef, lastViewportAnchorRef: core.lastViewportAnchorRef,
    setPaintRange: core.setPaintRange,
  });
  usePrefetchMarkdownEffect(scrollParent, sessionId);
  useTimelineBlankProbeEffect({
    scrollParent, sessionId, cb, listRootRef: core.listRootRef,
    blankDetectorRef: core.blankDetectorRef, blankProbeStateRef: core.blankProbeStateRef,
    followBottomRefBox: core.followBottomRefBox,
  });
  useRowGeometryWarmupEffect({
    scrollParent, sessionId, windowVersion: core.windowVersion, messagesLength,
    listRootRef: core.listRootRef, didSnapToBottomRef: core.didSnapToBottomRef,
    visibleCountRef: core.visibleCountRef, rowHeightCacheRef: core.rowHeightCacheRef,
  });
}

function useTimelineDataAndViewport(
  props: MessageListProps,
  core: SessionCore,
  findState: SessionFindState,
) {
  const {
    processDisclosure = false, sending, liveTurnUsage, archive,
    scrollParent, sessionId, followBottomRef,
  } = props;
  const messagesLength = core.messages.length;
  useTimelineObserverEffects(props, core);

  const projection = useMemo(
    () => projectTimelineMessages(core.messages, sessionId),
    [core.messages, sessionId],
  );
  const paging = useArchiveAndLiveUnitsPaging({
    archive, safeMessages: projection.safeMessages, pagingGeneration: core.pagingGeneration,
    processPaging: core.processPaging, sessionId, scrollParent,
    followBottomRefBox: core.followBottomRefBox, viewportPreserveLockRef: core.viewportPreserveLockRef,
    liveUnitsHoldRef: core.liveUnitsHoldRef, liveUnitsSettleRef: core.liveUnitsSettleRef,
    itemCountRef: core.itemCountRef, startOverrideRef: core.startOverrideRef,
    pendingExpandCorrectionRef: core.pendingExpandCorrectionRef,
    beginViewportPreserve: core.beginViewportPreserve, setWindowVersion: core.setWindowVersion,
  });

  useExpandAndLiveSettleLayoutEffect({
    windowVersion: core.windowVersion, scrollParent, processPaging: core.processPaging,
    followBottomRef, followBottomRefBox: core.followBottomRefBox,
    pendingExpandCorrectionRef: core.pendingExpandCorrectionRef,
    liveUnitsSettleRef: core.liveUnitsSettleRef, endViewportPreserve: core.endViewportPreserve,
  });
  useListResizeFollowLayoutEffect({
    scrollParent, followBottomRef, windowVersion: core.windowVersion, messagesLength,
    listRootRef: core.listRootRef, viewportPreserveLockRef: core.viewportPreserveLockRef,
    findPinRef: findState.findPinRef, lastViewportAnchorRef: core.lastViewportAnchorRef,
  });
  useInitialBottomSnapLayoutEffect({
    scrollParent, windowVersion: core.windowVersion, messagesLength, sessionId,
    didSnapToBottomRef: core.didSnapToBottomRef, itemCountRef: core.itemCountRef, followBottomRef,
  });

  const pipeline = useMemo(
    () => buildTimelineRenderPipeline(
      projection.renderableMessages, projection.turnLineageParents,
      sending, liveTurnUsage, processDisclosure,
    ),
    [projection.renderableMessages, projection.turnLineageParents, sending, liveTurnUsage, processDisclosure],
  );
  const paintWindow = computeTimelinePaintWindow({
    renderItems: pipeline.renderItems, scrollParent, sending,
    archiveLoading: Boolean(archive?.loading), archiveQueued: paging.archiveQueued,
    findPin: findState.findPin, paintRange: core.paintRange, followBottomRef,
    itemCountRef: core.itemCountRef, visibleCountRef: core.visibleCountRef,
    visibleKeysRef: core.visibleKeysRef, startOverrideRef: core.startOverrideRef,
    eagerPayloadKeysRef: core.eagerPayloadKeysRef, eagerMediaKeysRef: core.eagerMediaKeysRef,
    pinStartRef: core.pinStartRef, rowHeightCacheRef: core.rowHeightCacheRef,
  });
  core.blankProbeStateRef.current = {
    paintStart: paintWindow.paintStart, paintEnd: paintWindow.paintEnd, sending, messagesLength,
  };

  useLiveUnitsHoldLayoutEffect({
    scrollParent, liveUnitsHoldRef: core.liveUnitsHoldRef,
    followBottomRefBox: core.followBottomRefBox, processPaging: core.processPaging,
  });
  useRowMeasureAndSpanAnchorLayoutEffect({
    paintStart: paintWindow.paintStart, paintEnd: paintWindow.paintEnd,
    scrollParent, windowVersion: core.windowVersion, sessionId,
    visibleItemsLength: paintWindow.visibleItems.length, listRootRef: core.listRootRef,
    rowHeightCacheRef: core.rowHeightCacheRef, lastPaintSpanRef: core.lastPaintSpanRef,
    followBottomRefBox: core.followBottomRefBox, viewportPreserveLockRef: core.viewportPreserveLockRef,
    findPinRef: findState.findPinRef, lastViewportAnchorRef: core.lastViewportAnchorRef,
  });

  return { projection, paging, pipeline, paintWindow };
}

type TimelineViewportData = ReturnType<typeof useTimelineDataAndViewport>;

type TimelineScrollViewportProps = {
  core: SessionCore;
  findPinRenderKey: string | undefined;
  findActive: boolean;
  findCurrentRenderKey: string | undefined;
  findHitRowKeys: ReadonlySet<string>;
  showHistoryBoundary: boolean;
  archive: MessageListArchive | null | undefined;
  paging: TimelineViewportData["paging"];
  paintWindow: TimelineViewportData["paintWindow"];
  olderLiveStepsKey: string | null;
  olderLiveStepsControl: ReactNode;
  footer: ReactNode;
  canJumpToBottom: boolean;
  onJumpToBottom: () => void;
  renderItem: (it: RenderItem, renderIndex?: number) => ReactNode;
};

function TimelineScrollViewport({
  core, findPinRenderKey, findActive, findCurrentRenderKey, findHitRowKeys,
  showHistoryBoundary, archive, paging, paintWindow,
  olderLiveStepsKey, olderLiveStepsControl, footer,
  canJumpToBottom, onJumpToBottom, renderItem,
}: TimelineScrollViewportProps) {
  return (
    <div
      ref={core.listRootRef}
      className="mx-auto max-w-3xl space-y-4 px-5 py-8"
      data-testid="timeline-short-list"
      data-timeline-window-count={paintWindow.visibleItems.length}
      data-timeline-paint-count={paintWindow.paintedItems.length}
      data-find-pin={findPinRenderKey ?? ""}
    >
      <HistoryPageLoader
        showHistoryBoundary={showHistoryBoundary}
        windowStart={paintWindow.windowStart}
        hasOlderHistory={paging.hasOlderHistory}
        legacyArchivedRemaining={paging.legacyArchivedRemaining}
        archive={archive}
        archiveQueued={paging.archiveQueued}
        onExpandLocal={paging.expandLocalWindow}
        onRequestOlderArchive={paging.requestOlderArchive}
      />
      {paintWindow.paintStart > 0 ? (
        <div aria-hidden data-testid="timeline-paint-spacer-top" style={{ height: paintWindow.topSpacerPx }} />
      ) : null}
      <PaintedTimelineRows
        paintedItems={paintWindow.paintedItems}
        visibleItemsLength={paintWindow.visibleItems.length}
        paintStart={paintWindow.paintStart}
        windowStart={paintWindow.windowStart}
        pinPaintStart={paintWindow.pinPaintStart}
        estimatePx={paintWindow.estimatePx}
        findActive={findActive}
        findCurrentRenderKey={findCurrentRenderKey}
        findHitRowKeys={findHitRowKeys}
        eagerMediaKeysRef={core.eagerMediaKeysRef}
        rowHeightCacheRef={core.rowHeightCacheRef}
        renderItem={renderItem}
      />
      {paintWindow.paintEnd < paintWindow.visibleItems.length ? (
        <div aria-hidden data-testid="timeline-paint-spacer-bottom" style={{ height: paintWindow.bottomSpacerPx }} />
      ) : null}
      {olderLiveStepsKey === null ? olderLiveStepsControl : null}
      {footer}
      {canJumpToBottom && (
        <ScrollToBottomButton visible={core.showScrollToBottom} onClick={onJumpToBottom} />
      )}
    </div>
  );
}

type MessageListTranscriptProps = {
  props: MessageListProps;
  core: SessionCore;
  findState: SessionFindState;
  timeline: TimelineViewportData;
  footer: ReactNode;
  pendingSig: string;
  renderRecord: MessageRendererComponent;
};

function jumpTimelineToBottom(
  core: SessionCore,
  scrollParent: HTMLElement | null | undefined,
  followBottomRef: FollowBottomControllerRef | undefined,
): void {
  if (!scrollParent || !followBottomRef?.jumpToBottom) return;
  core.pendingExpandCorrectionRef.current = null;
  core.viewportPreserveLockRef.current = false;
  core.liveUnitsHoldRef.current = null;
  core.liveUnitsSettleRef.current = null;
  core.lastViewportAnchorRef.current = null;
  followBottomRef.jumpToBottom(scrollParent);
  core.setShowScrollToBottom(shouldShowScrollToBottom(
    followBottomRef.current, core.messages.length,
    scrollParent.scrollHeight - scrollParent.clientHeight - scrollParent.scrollTop,
  ));
}

function MessageListStickyChrome({
  props,
  core,
  findState,
  paging,
  pendingSig,
  findCurrent,
  goFind,
}: {
  props: MessageListProps;
  core: SessionCore;
  findState: SessionFindState;
  paging: TimelineViewportData["paging"];
  pendingSig: string;
  findCurrent: number;
  goFind: (dir: 1 | -1) => void;
}) {
  const { sending, archive, onRespondPermission, readOnly = false, scrollParent, sessionId, find } = props;
  return (
    <>
      {!readOnly && pendingSig.length > 0 ? (
        <PermissionPromptHost
          messages={core.messages}
          onRespond={onRespondPermission}
          readOnly={readOnly}
          sending={sending}
          sessionId={sessionId}
          scrollParent={scrollParent}
        />
      ) : null}
      {find ? (
        <SessionFindBar
          find={find}
          findQuery={findState.findQuery}
          setFindQuery={findState.setFindQuery}
          findCurrent={findCurrent}
          matchCount={findState.findMatchesList.length}
          sending={sending}
          hasOlderHistory={paging.hasOlderHistory}
          archive={archive}
          archiveQueued={paging.archiveQueued}
          onSearchOlder={paging.requestOlderArchive}
          goFind={goFind}
        />
      ) : (
        <div
          aria-hidden
          data-testid="timeline-top-fade"
          className="pointer-events-none sticky top-0 z-10 -mb-3 h-3 bg-gradient-to-b from-bg to-transparent"
        />
      )}
    </>
  );
}

function MessageListTranscript({
  props, core, findState, timeline, footer, pendingSig, renderRecord,
}: MessageListTranscriptProps) {
  const {
    sending, turnActivity, archive, cb, onRespondPermission,
    readOnly = false, scrollParent, historyGeneration = "legacy",
    sessionId, followBottomRef, find,
  } = props;
  const { projection, paging, pipeline, paintWindow } = timeline;
  const showHistoryBoundary =
    paging.hasOlderHistory ||
    paintWindow.windowStart > 0 ||
    projection.renderableMessages.some((m) => typeof m._historyPageLoadedFrom === "string");
  const olderLiveStepsKey = resolveOlderLiveStepsKey(
    paging.liveHasMore, paging.liveAttention, paintWindow.visibleItems,
  );
  const olderLiveStepsControl = (
    <OlderLiveStepsLoader
      liveHasMore={paging.liveHasMore}
      liveAttention={paging.liveAttention}
      liveUnitsBusy={paging.liveUnitsBusy}
      onClick={paging.handleManualOlderLiveSteps}
    />
  );
  const findProjection = projectSessionFind(
    find, findState, pipeline.renderItems, paintWindow.windowStart,
    sending, scrollParent, followBottomRef,
    (targetIndex) => {
      core.beginViewportPreserve();
      core.startOverrideRef.current = targetIndex;
      core.setWindowVersion((v) => v + 1);
    },
  );
  const renderItem = createTimelineItemRenderer({
    renderItems: pipeline.renderItems, turnStart: pipeline.turnStart,
    actionRowFinal: pipeline.actionRowFinal, failureIsPresentedBelow: projection.failureIsPresentedBelow,
    sending, sessionId, historyGeneration, processPaging: core.processPaging,
    turnActivity, readOnly, cb, onRespondPermission, findQuery: findState.findQuery,
    disclosureValues: core.disclosureValues, setDisclosure: core.setDisclosure,
    olderLiveStepsKey, olderLiveStepsControl, eagerPayloadKeysRef: core.eagerPayloadKeysRef,
    renderRecord,
  });

  return (
    <>
      <MessageListStickyChrome
        props={props}
        core={core}
        findState={findState}
        paging={paging}
        pendingSig={pendingSig}
        findCurrent={findProjection.findCurrent}
        goFind={findProjection.goFind}
      />
      <TimelineScrollViewport
        core={core}
        findPinRenderKey={findState.findPin?.renderKey}
        findActive={Boolean(find)}
        findCurrentRenderKey={findProjection.findCurrentTarget?.renderKey}
        findHitRowKeys={findProjection.findHitRowKeys}
        showHistoryBoundary={showHistoryBoundary}
        archive={archive}
        paging={paging}
        paintWindow={paintWindow}
        olderLiveStepsKey={olderLiveStepsKey}
        olderLiveStepsControl={olderLiveStepsControl}
        footer={footer}
        canJumpToBottom={Boolean(followBottomRef?.jumpToBottom && core.messages.length > 0)}
        onJumpToBottom={() => jumpTimelineToBottom(core, scrollParent, followBottomRef)}
        renderItem={renderItem}
      />
    </>
  );
}

export function MessageListView({
  props,
  renderRecord,
}: {
  props: MessageListProps;
  renderRecord: MessageRendererComponent;
}) {
  const {
    processDisclosure = false, sending, turnActivity,
    transientNotice, historyLoading = false, scrollParent,
    sessionId, followBottomRef, find,
  } = props;
  const core = useMessageListSessionCore(props);
  const findState = useSessionFindState({
    find,
    messages: core.messages,
    sessionId,
    sending,
    scrollParent,
    followBottomRef,
    windowVersion: core.windowVersion,
    lastViewportAnchorRef: core.lastViewportAnchorRef,
  });
  syncSessionSwitchRefs(core, findState, sessionId);
  const timeline = useTimelineDataAndViewport(props, core, findState);

  const footer = (
    <TimelineFooter
      processDisclosure={processDisclosure}
      renderItems={timeline.pipeline.renderItems}
      renderableMessages={timeline.projection.renderableMessages}
      turnStart={timeline.pipeline.turnStart}
      sending={sending}
      turnActivity={turnActivity}
      transientNotice={transientNotice}
      historyLoading={historyLoading}
    />
  );
  const pendingSig = core.messages
    .filter((message) => message.role === "permission")
    .map((message) => `${message.requestId}:${message._resolved}:${message._controlPending}:${message._inputTruncated}`)
    .join("|");

  if (scrollParent === null) return null;
  if (
    scrollParent &&
    timeline.paintWindow.visibleItems.length === 0 &&
    (sending || historyLoading || transientNotice)
  ) {
    return <div className="mx-auto max-w-3xl px-5 py-8">{footer}</div>;
  }
  return (
    <MessageListTranscript
      props={props}
      core={core}
      findState={findState}
      timeline={timeline}
      footer={footer}
      pendingSig={pendingSig}
      renderRecord={renderRecord}
    />
  );
}
