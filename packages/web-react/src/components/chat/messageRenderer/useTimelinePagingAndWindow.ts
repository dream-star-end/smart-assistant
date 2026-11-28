import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../../../lib/chat/model";
import type { UserUpwardPagingController } from "../../../lib/chat/tapePaging";
import {
  computePaintRange,
  EAGER_MEDIA_TAIL_ITEMS,
  EAGER_PAYLOAD_TAIL_ITEMS,
  measuredRangePx,
  paintWindowEnabled,
  rowHeightEstimatePx,
  selectPaintRange,
} from "../../../lib/chat/timelinePaint";
import { loadedArchivedMetrics } from "../archivePaging";
import { findPaintNeighborhood } from "./SessionFindBar";
import {
  defaultTailStart,
  type FindPinState,
  type FollowBottomControllerRef,
  lastUserItemIndex,
  LIVE_UNITS_AUTO_PAGE_CAP,
  type LiveUnitsViewportHold,
  type MessageListArchive,
  type RenderItem,
  renderItemKey,
  TIMELINE_WINDOW_EXPAND_ITEMS,
} from "./types";
import { captureLiveUnitsAnchor } from "./viewportScrollEffects";

type LiveUnitsAutoFillParams = {
  liveHasMore: boolean;
  liveAttention: "error" | "cap" | null;
  setLiveUnitsAttention: Dispatch<SetStateAction<{ session?: string; kind: "error" | "cap" } | null>>;
  archive: MessageListArchive | null | undefined;
  sessionId: string | undefined;
  requestedLiveCursorRef: MutableRefObject<string | null>;
  liveAutoPagesRef: MutableRefObject<{ session?: string; count: number }>;
  requestOlderLiveUnits: () =>
    | false
    | Promise<
        | undefined
        | {
            ok?: boolean;
            hasMore?: boolean;
            error?: boolean;
            inflight?: boolean;
          }
      >;
};

function useLiveUnitsAutoFillEffect(params: LiveUnitsAutoFillParams): void {
  const {
    liveHasMore, liveAttention, setLiveUnitsAttention, archive,
    sessionId, requestedLiveCursorRef, liveAutoPagesRef, requestOlderLiveUnits,
  } = params;
  useEffect(() => {
    if (!liveHasMore) {
      if (liveAttention) setLiveUnitsAttention(null);
      return;
    }
    if (liveAttention) return;
    const cursor = archive?.liveUnitsCursor;
    if (typeof cursor !== "string" || cursor.length === 0 || archive?.loading) return;
    const mark = `${sessionId ?? ""}\0${cursor}`;
    if (requestedLiveCursorRef.current === mark) return;
    if (liveAutoPagesRef.current.count >= LIVE_UNITS_AUTO_PAGE_CAP) {
      setLiveUnitsAttention({ session: sessionId, kind: "cap" });
      return;
    }
    const pending = requestOlderLiveUnits();
    if (pending === false) return;
    requestedLiveCursorRef.current = mark;
    liveAutoPagesRef.current.count += 1;
    void pending.then((result) => {
      if (!result || result.inflight || requestedLiveCursorRef.current !== mark) return;
      if (result.error || result.ok === false) {
        requestedLiveCursorRef.current = null;
        setLiveUnitsAttention({ session: sessionId, kind: "error" });
      }
    });
  }, [
    liveHasMore, liveAttention, setLiveUnitsAttention,
    archive?.liveUnitsCursor, archive?.loading, sessionId,
    requestedLiveCursorRef, liveAutoPagesRef, requestOlderLiveUnits,
  ]);
}

export type ArchiveAndLiveUnitsPagingParams = {
  archive: MessageListArchive | null | undefined;
  safeMessages: ChatMessage[];
  pagingGeneration: string;
  processPaging: UserUpwardPagingController;
  sessionId: string | undefined;
  scrollParent: HTMLElement | null | undefined;
  followBottomRefBox: MutableRefObject<FollowBottomControllerRef | undefined>;
  viewportPreserveLockRef: MutableRefObject<boolean>;
  liveUnitsHoldRef: MutableRefObject<LiveUnitsViewportHold | null>;
  liveUnitsSettleRef: MutableRefObject<LiveUnitsViewportHold | null>;
  itemCountRef: MutableRefObject<number>;
  startOverrideRef: MutableRefObject<number | null>;
  pendingExpandCorrectionRef: MutableRefObject<{ height: number; top: number } | null>;
  beginViewportPreserve: () => void;
  setWindowVersion: Dispatch<SetStateAction<number>>;
};

function useManualArchivePaging(
  params: ArchiveAndLiveUnitsPagingParams,
  archiveQueueTokenRef: MutableRefObject<number>,
) {
  const {
    archive, safeMessages, pagingGeneration, processPaging, scrollParent,
    itemCountRef, startOverrideRef, pendingExpandCorrectionRef,
    beginViewportPreserve, setWindowVersion,
  } = params;
  const [archiveQueued, setArchiveQueued] = useState(false);
  const archiveQueuedRef = useRef(false);

  useEffect(() => {
    void processPaging;
    archiveQueueTokenRef.current += 1;
    archiveQueuedRef.current = false;
    setArchiveQueued(false);
  }, [processPaging, archiveQueueTokenRef]);

  const legacyArchivedRemaining = archive?.hasMore === undefined
    ? Math.max(
        0,
        (archive?.archivedCount ?? 0) - loadedArchivedMetrics(
          safeMessages,
          archive?.archivedThroughSeq ?? 0,
        ).anchors,
      )
    : 0;
  const hasOlderHistory = archive?.hasMore ?? (legacyArchivedRemaining > 0);
  const requestOlderArchive = useCallback(() => {
    if (!archive || !hasOlderHistory || archive.loading || archiveQueuedRef.current) return;
    archiveQueuedRef.current = true;
    setArchiveQueued(true);
    const token = ++archiveQueueTokenRef.current;
    const requestKey = `timeline::${pagingGeneration}`;
    processPaging.signalUserInteraction();
    void processPaging.runExplicit(requestKey, async () => {
      await archive.onLoadOlder();
    }).finally(() => {
      if (archiveQueueTokenRef.current !== token) return;
      archiveQueuedRef.current = false;
      setArchiveQueued(false);
    });
  }, [archive, hasOlderHistory, pagingGeneration, processPaging, archiveQueueTokenRef]);

  const expandLocalWindow = useCallback(() => {
    const current = startOverrideRef.current ?? defaultTailStart(itemCountRef.current);
    if (current <= 0) return;
    beginViewportPreserve();
    if (scrollParent) {
      pendingExpandCorrectionRef.current = {
        height: scrollParent.scrollHeight,
        top: scrollParent.scrollTop,
      };
    }
    startOverrideRef.current = Math.max(0, current - TIMELINE_WINDOW_EXPAND_ITEMS);
    setWindowVersion((value) => value + 1);
  }, [
    scrollParent, itemCountRef, startOverrideRef,
    pendingExpandCorrectionRef, beginViewportPreserve, setWindowVersion,
  ]);

  return { legacyArchivedRemaining, hasOlderHistory, archiveQueued, requestOlderArchive, expandLocalWindow };
}

function useLiveUnitsAutoPaging(
  params: ArchiveAndLiveUnitsPagingParams,
  archiveQueueTokenRef: MutableRefObject<number>,
) {
  const {
    archive, processPaging, sessionId, scrollParent, followBottomRefBox,
    viewportPreserveLockRef, liveUnitsHoldRef, liveUnitsSettleRef, setWindowVersion,
  } = params;
  const liveQueuedRef = useRef(false);
  const [liveUnitsBusy, setLiveUnitsBusy] = useState(false);
  const requestedLiveCursorRef = useRef<string | null>(null);
  const liveAutoPagesRef = useRef<{ session?: string; count: number }>({ count: 0 });
  const [liveUnitsAttention, setLiveUnitsAttention] = useState<{
    session?: string;
    kind: "error" | "cap";
  } | null>(null);

  const liveHasMore = archive?.liveHasMoreBefore === true;
  const liveAttention = liveUnitsAttention && liveUnitsAttention.session === sessionId
    ? liveUnitsAttention.kind
    : null;
  if (liveAutoPagesRef.current.session !== sessionId) {
    liveAutoPagesRef.current = { session: sessionId, count: 0 };
  }

  const requestOlderLiveUnits = useCallback(() => {
    if (!archive?.onLoadOlderLiveUnits || !liveHasMore || archive.loading || liveQueuedRef.current) {
      return false as const;
    }
    liveQueuedRef.current = true;
    setLiveUnitsBusy(true);
    const token = ++archiveQueueTokenRef.current;
    const following = followBottomRefBox.current?.current === true;
    if (!following) viewportPreserveLockRef.current = true;
    liveUnitsHoldRef.current = {
      following,
      epoch: processPaging.interactionVersion(),
      anchor: !following && scrollParent ? captureLiveUnitsAnchor(scrollParent) : null,
    };
    return Promise.resolve(archive.onLoadOlderLiveUnits())
      .then((result) => result ?? undefined)
      .finally(() => {
      if (archiveQueueTokenRef.current !== token) return;
      const hold = liveUnitsHoldRef.current;
      liveUnitsHoldRef.current = null;
      liveUnitsSettleRef.current = hold;
      liveQueuedRef.current = false;
      setLiveUnitsBusy(false);
      setWindowVersion((value) => value + 1);
    });
  }, [
    archive, liveHasMore, scrollParent, processPaging, archiveQueueTokenRef,
    followBottomRefBox, viewportPreserveLockRef, liveUnitsHoldRef, liveUnitsSettleRef, setWindowVersion,
  ]);

  useLiveUnitsAutoFillEffect({
    liveHasMore, liveAttention, setLiveUnitsAttention, archive,
    sessionId, requestedLiveCursorRef, liveAutoPagesRef, requestOlderLiveUnits,
  });

  const handleManualOlderLiveSteps = () => {
    if (liveAttention === "error") {
      requestedLiveCursorRef.current = null;
      setLiveUnitsAttention(null);
      return;
    }
    const pending = requestOlderLiveUnits();
    if (pending === false) return;
    void pending.then((result) => {
      if (!result || result.inflight) return;
      if (result.error || result.ok === false) {
        setLiveUnitsAttention({ session: sessionId, kind: "error" });
      }
    });
  };

  return { liveHasMore, liveUnitsBusy, liveAttention, handleManualOlderLiveSteps };
}

export function useArchiveAndLiveUnitsPaging(params: ArchiveAndLiveUnitsPagingParams) {
  const archiveQueueTokenRef = useRef(0);
  const manual = useManualArchivePaging(params, archiveQueueTokenRef);
  const live = useLiveUnitsAutoPaging(params, archiveQueueTokenRef);
  return { ...manual, ...live };
}

function seedInitialEagerKeySets(
  visibleItems: RenderItem[],
  eagerPayloadKeysRef: MutableRefObject<Set<string> | null>,
  eagerMediaKeysRef: MutableRefObject<Set<string> | null>,
): void {
  if (eagerPayloadKeysRef.current !== null || visibleItems.length === 0) return;
  const tail = visibleItems.slice(-EAGER_PAYLOAD_TAIL_ITEMS);
  const eager = new Set(tail.map(renderItemKey));
  for (const item of tail) {
    if (item.kind !== "process") continue;
    for (const message of item.members) {
      if (message._payloadDeferred) eager.add(message._timelineUnitKey ?? message.id);
    }
  }
  eagerPayloadKeysRef.current = eager;
  eagerMediaKeysRef.current = new Set(
    visibleItems.slice(-EAGER_MEDIA_TAIL_ITEMS).map(renderItemKey),
  );
}

export type ComputePaintWindowParams = {
  renderItems: RenderItem[];
  scrollParent: HTMLElement | null | undefined;
  sending: boolean;
  archiveLoading: boolean;
  archiveQueued: boolean;
  findPin: FindPinState | null;
  paintRange: { start: number; end: number };
  followBottomRef: FollowBottomControllerRef | undefined;
  itemCountRef: MutableRefObject<number>;
  visibleCountRef: MutableRefObject<number>;
  visibleKeysRef: MutableRefObject<string[]>;
  startOverrideRef: MutableRefObject<number | null>;
  eagerPayloadKeysRef: MutableRefObject<Set<string> | null>;
  eagerMediaKeysRef: MutableRefObject<Set<string> | null>;
  pinStartRef: MutableRefObject<number | undefined>;
  rowHeightCacheRef: MutableRefObject<Map<string, number>>;
};

export function computeTimelinePaintWindow(params: ComputePaintWindowParams) {
  const {
    renderItems, scrollParent, sending, archiveLoading, archiveQueued,
    findPin, paintRange, followBottomRef, itemCountRef, visibleCountRef,
    visibleKeysRef, startOverrideRef, eagerPayloadKeysRef, eagerMediaKeysRef,
    pinStartRef, rowHeightCacheRef,
  } = params;
  itemCountRef.current = renderItems.length;
  if (scrollParent && renderItems.length > 0 && startOverrideRef.current === null) {
    startOverrideRef.current = defaultTailStart(renderItems.length);
  }
  const windowStart = !scrollParent || renderItems.length === 0
    ? 0
    : Math.min(
        startOverrideRef.current ?? defaultTailStart(renderItems.length),
        defaultTailStart(renderItems.length),
      );
  const visibleItems = renderItems.slice(windowStart);
  visibleCountRef.current = visibleItems.length;
  visibleKeysRef.current = visibleItems.map(renderItemKey);
  seedInitialEagerKeySets(visibleItems, eagerPayloadKeysRef, eagerMediaKeysRef);

  const paintOn = paintWindowEnabled(scrollParent, visibleItems.length) && !archiveLoading && !archiveQueued;
  const lastUserVisible = lastUserItemIndex(visibleItems);
  const pinPaintStart = sending && lastUserVisible >= 0 ? lastUserVisible : undefined;
  pinStartRef.current = pinPaintStart;
  const estimatePx = rowHeightEstimatePx(rowHeightCacheRef.current);
  const keyAt = (index: number) => renderItemKey(visibleItems[index]!);

  let paintStart = 0;
  let paintEnd = visibleItems.length;
  if (paintOn && scrollParent) {
    const visIdx = findPin ? findPin.renderIndex - windowStart : -1;
    if (findPin && visIdx >= 0 && visIdx < visibleItems.length) {
      const extra = findPaintNeighborhood(scrollParent.clientHeight, estimatePx);
      paintStart = Math.max(0, visIdx - extra);
      paintEnd = Math.min(visibleItems.length, visIdx + 1 + extra);
    } else {
      const followBottom = followBottomRef?.current === true;
      const desired = computePaintRange({
        count: visibleItems.length, scrollTop: scrollParent.scrollTop,
        clientHeight: scrollParent.clientHeight, followBottom, keyAt,
        heights: rowHeightCacheRef.current, pinStart: pinPaintStart, estimatePx,
      });
      const chosen = selectPaintRange({
        prev: paintRange, next: desired, followBottom, count: visibleItems.length,
        scrollTop: scrollParent.scrollTop, clientHeight: scrollParent.clientHeight,
        keyAt, heights: rowHeightCacheRef.current, pinStart: pinPaintStart, estimatePx,
      });
      paintStart = chosen.start;
      paintEnd = chosen.end;
    }
  }
  const paintedItems = visibleItems.slice(paintStart, paintEnd);
  const topSpacerPx = paintStart > 0
    ? measuredRangePx(0, paintStart, keyAt, rowHeightCacheRef.current, estimatePx)
    : 0;
  const bottomSpacerPx = paintEnd < visibleItems.length
    ? measuredRangePx(paintEnd, visibleItems.length, keyAt, rowHeightCacheRef.current, estimatePx)
    : 0;

  return {
    windowStart, visibleItems, paintStart, paintEnd,
    paintedItems, pinPaintStart, estimatePx, topSpacerPx, bottomSpacerPx,
  };
}
