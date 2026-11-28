import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
} from "react";
import type { UserUpwardPagingController } from "../../../lib/chat/tapePaging";
import {
  BLANK_SAMPLE_INTERVAL_MS,
  collectProbeInput,
  createBlankDetector,
  persistSnapshot,
  readPersistedSnapshot,
} from "../../../lib/chat/timelineBlankProbe";
import {
  computePaintRange,
  createRowGeometryWarmup,
  paintWindowEnabled,
  rowHeightEstimatePx,
  selectPaintRange,
} from "../../../lib/chat/timelinePaint";
import { prefetchMarkdownImpl } from "../../Markdown";
import { captureVisibleVirtualRowAnchor, type VisibleVirtualRowAnchor } from "../archivePaging";
import type { CardCallbacks } from "../cards";
import {
  defaultTailStart,
  escapeFindSelector,
  type FollowBottomControllerRef,
  type LiveUnitsViewportAnchor,
  type LiveUnitsViewportHold,
  TIMELINE_EXPAND_NEAR_TOP_PX,
  TIMELINE_WINDOW_EXPAND_ITEMS,
} from "./types";

/** Topmost on-screen step. A process shell's own top does not move when an
 * older page is inserted inside it, so the anchor has to be that step. */
export function captureLiveUnitsAnchor(scroller: HTMLElement): LiveUnitsViewportAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const rows = scroller.querySelectorAll<HTMLElement>("[data-chat-virtual-key]");
  for (const row of rows) {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= viewport.top + 0.5 || rowRect.top >= viewport.bottom - 0.5) continue;
    for (const candidate of row.querySelectorAll<HTMLElement>("[data-find-member]")) {
      const rect = candidate.getBoundingClientRect();
      const member = candidate.getAttribute("data-find-member");
      if (!member || rect.height <= 0) continue;
      if (rect.bottom <= viewport.top + 0.5 || rect.top >= viewport.bottom - 0.5) continue;
      return { top: rect.top - viewport.top, member };
    }
  }
  return null;
}

/** Move by the anchor's position after this commit, not by a height taken
 * before the request. */
export function restoreLiveUnitsAnchor(
  scroller: HTMLElement,
  anchor: LiveUnitsViewportAnchor,
  writeTop: (el: HTMLElement, nextTop: number) => void,
): void {
  const el = scroller.querySelector<HTMLElement>(
    `[data-find-member="${escapeFindSelector(anchor.member)}"]`,
  );
  if (!el) return;
  const current = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const delta = current - anchor.top;
  if (Math.abs(delta) > 0.5) writeTop(scroller, scroller.scrollTop + delta);
}

function isNavigationKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    event.key === "ArrowDown" ||
    event.key === "PageDown" ||
    event.key === "End" ||
    event.key === " "
  );
}

function isMouseInScrollbarGutter(scroller: HTMLElement, event: PointerEvent): boolean {
  if (event.pointerType !== "mouse") return false;
  const gutter = scroller.offsetWidth - scroller.clientWidth;
  if (gutter <= 0) return false;
  const rect = scroller.getBoundingClientRect();
  return event.clientX >= rect.right - gutter - 1 || event.clientX <= rect.left + gutter + 1;
}

type ScrollerListenerHandlers = {
  onWheel: () => void;
  onTouchStart: () => void;
  onTouchMove: () => void;
  endTouch: () => void;
  cancelTouch: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  endPointer: (event?: PointerEvent) => void;
  onWindowBlur: () => void;
  onScroll: () => void;
};

function attachScrollerListeners(
  scroller: HTMLElement,
  h: ScrollerListenerHandlers,
  clearTouchIdle: () => void,
): () => void {
  scroller.addEventListener("wheel", h.onWheel, { passive: true });
  scroller.addEventListener("touchstart", h.onTouchStart, { passive: true });
  scroller.addEventListener("touchmove", h.onTouchMove, { passive: true });
  scroller.addEventListener("touchend", h.endTouch, { passive: true });
  scroller.addEventListener("touchcancel", h.cancelTouch, { passive: true });
  scroller.addEventListener("keydown", h.onKeyDown);
  scroller.addEventListener("pointerdown", h.onPointerDown);
  window.addEventListener("pointerup", h.endPointer);
  window.addEventListener("pointercancel", h.endPointer);
  window.addEventListener("blur", h.onWindowBlur);
  scroller.addEventListener("scroll", h.onScroll, { passive: true });
  return () => {
    clearTouchIdle();
    scroller.removeEventListener("wheel", h.onWheel);
    scroller.removeEventListener("touchstart", h.onTouchStart);
    scroller.removeEventListener("touchmove", h.onTouchMove);
    scroller.removeEventListener("touchend", h.endTouch);
    scroller.removeEventListener("touchcancel", h.cancelTouch);
    scroller.removeEventListener("keydown", h.onKeyDown);
    scroller.removeEventListener("pointerdown", h.onPointerDown);
    window.removeEventListener("pointerup", h.endPointer);
    window.removeEventListener("pointercancel", h.endPointer);
    window.removeEventListener("blur", h.onWindowBlur);
    scroller.removeEventListener("scroll", h.onScroll);
  };
}

function bindScrollerInteractionListeners(
  scroller: HTMLElement,
  processPaging: UserUpwardPagingController,
  liveUnitsHoldRef: MutableRefObject<LiveUnitsViewportHold | null>,
  viewportPreserveLockRef: MutableRefObject<boolean>,
): () => void {
  let touchMomentum = false;
  let touchIdleTimer: number | null = null;
  let scrollbarPointerId: number | null = null;
  const clearTouchIdle = () => {
    if (touchIdleTimer !== null) {
      window.clearTimeout(touchIdleTimer);
      touchIdleTimer = null;
    }
  };
  const armTouchIdle = () => {
    clearTouchIdle();
    touchIdleTimer = window.setTimeout(() => {
      touchIdleTimer = null;
      touchMomentum = false;
    }, 240);
  };
  const endPointer = (event?: PointerEvent) => {
    if (scrollbarPointerId === null || (event && event.pointerId !== scrollbarPointerId)) return;
    scrollbarPointerId = null;
    processPaging.signalUserInteraction();
  };
  return attachScrollerListeners(
    scroller,
    {
      onWheel: () => processPaging.signalUserInteraction(),
      onTouchStart: () => {
        processPaging.signalUserInteraction();
        touchMomentum = true;
        clearTouchIdle();
      },
      onTouchMove: () => {
        touchMomentum = true;
        processPaging.signalUserInteraction();
      },
      endTouch: () => {
        processPaging.signalUserInteraction();
        touchMomentum = true;
        armTouchIdle();
      },
      cancelTouch: () => {
        processPaging.signalUserInteraction();
        touchMomentum = false;
        clearTouchIdle();
      },
      onKeyDown: (event) => {
        if (isNavigationKey(event)) processPaging.signalUserInteraction();
      },
      onPointerDown: (event) => {
        if (scrollbarPointerId !== null || !isMouseInScrollbarGutter(scroller, event)) return;
        scrollbarPointerId = event.pointerId;
        processPaging.signalUserInteraction();
      },
      endPointer,
      onWindowBlur: () => endPointer(),
      onScroll: () => {
        const hold = liveUnitsHoldRef.current;
        if (hold?.following && processPaging.interactionVersion() !== hold.epoch) {
          hold.following = false;
          hold.anchor = captureLiveUnitsAnchor(scroller);
          viewportPreserveLockRef.current = true;
        }
        if (scrollbarPointerId !== null) {
          processPaging.signalUserInteraction();
        } else if (touchMomentum) {
          processPaging.signalUserInteraction();
          armTouchIdle();
        }
      },
    },
    clearTouchIdle,
  );
}

export type ScrollerPagingAndExpandParams = {
  scrollParent: HTMLElement | null | undefined;
  processPaging: UserUpwardPagingController;
  itemCountRef: MutableRefObject<number>;
  startOverrideRef: MutableRefObject<number | null>;
  pendingExpandCorrectionRef: MutableRefObject<{ height: number; top: number } | null>;
  liveUnitsHoldRef: MutableRefObject<LiveUnitsViewportHold | null>;
  viewportPreserveLockRef: MutableRefObject<boolean>;
  beginViewportPreserve: () => void;
  setWindowVersion: Dispatch<SetStateAction<number>>;
};

export function useScrollerPagingAndExpandEffect(params: ScrollerPagingAndExpandParams): void {
  const {
    scrollParent, processPaging, itemCountRef, startOverrideRef,
    pendingExpandCorrectionRef, liveUnitsHoldRef, viewportPreserveLockRef,
    beginViewportPreserve, setWindowVersion,
  } = params;
  useEffect(() => {
    const scroller = scrollParent;
    if (!scroller) return;
    const unbindInteraction = bindScrollerInteractionListeners(
      scroller, processPaging, liveUnitsHoldRef, viewportPreserveLockRef,
    );
    const onExpandNearTop = () => {
      if (scroller.scrollTop > TIMELINE_EXPAND_NEAR_TOP_PX) return;
      const current = startOverrideRef.current ?? defaultTailStart(itemCountRef.current);
      if (current <= 0) return;
      beginViewportPreserve();
      pendingExpandCorrectionRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      startOverrideRef.current = Math.max(0, current - TIMELINE_WINDOW_EXPAND_ITEMS);
      setWindowVersion((value) => value + 1);
    };
    scroller.addEventListener("scroll", onExpandNearTop, { passive: true });
    return () => {
      unbindInteraction();
      scroller.removeEventListener("scroll", onExpandNearTop);
    };
  }, [
    scrollParent, processPaging, itemCountRef, startOverrideRef,
    pendingExpandCorrectionRef, liveUnitsHoldRef, viewportPreserveLockRef,
    beginViewportPreserve, setWindowVersion,
  ]);
}

export type ScrollPaintRangeParams = {
  scrollParent: HTMLElement | null | undefined;
  windowVersion: number;
  sessionId: string | undefined;
  messagesLength: number;
  visibleCountRef: MutableRefObject<number>;
  visibleKeysRef: MutableRefObject<string[]>;
  followBottomRefBox: MutableRefObject<FollowBottomControllerRef | undefined>;
  rowHeightCacheRef: MutableRefObject<Map<string, number>>;
  pinStartRef: MutableRefObject<number | undefined>;
  lastViewportAnchorRef: MutableRefObject<VisibleVirtualRowAnchor | null>;
  setPaintRange: Dispatch<SetStateAction<{ start: number; end: number }>>;
};

export function useScrollPaintRangeEffect(params: ScrollPaintRangeParams): void {
  const {
    scrollParent, windowVersion, sessionId, messagesLength, visibleCountRef,
    visibleKeysRef, followBottomRefBox, rowHeightCacheRef, pinStartRef,
    lastViewportAnchorRef, setPaintRange,
  } = params;
  useEffect(() => {
    void windowVersion;
    void sessionId;
    void messagesLength;
    const el = scrollParent;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const count = visibleCountRef.current;
      if (!paintWindowEnabled(el, count)) return;
      const keys = visibleKeysRef.current;
      const followBottom = followBottomRefBox.current?.current === true;
      const estimatePx = rowHeightEstimatePx(rowHeightCacheRef.current);
      const keyAt = (index: number) => keys[index] ?? "";
      const next = computePaintRange({
        count, scrollTop: el.scrollTop, clientHeight: el.clientHeight,
        followBottom, keyAt, heights: rowHeightCacheRef.current,
        pinStart: pinStartRef.current, estimatePx,
      });
      setPaintRange((prev) => selectPaintRange({
        prev, next, followBottom, count,
        scrollTop: el.scrollTop, clientHeight: el.clientHeight,
        keyAt, heights: rowHeightCacheRef.current,
        pinStart: pinStartRef.current, estimatePx,
      }));
    };
    const onScroll = () => {
      lastViewportAnchorRef.current = captureVisibleVirtualRowAnchor(el);
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    lastViewportAnchorRef.current = captureVisibleVirtualRowAnchor(el);
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    scrollParent, windowVersion, sessionId, messagesLength,
    visibleCountRef, visibleKeysRef, followBottomRefBox,
    rowHeightCacheRef, pinStartRef, lastViewportAnchorRef, setPaintRange,
  ]);
}

export function usePrefetchMarkdownEffect(
  scrollParent: HTMLElement | null | undefined,
  sessionId: string | undefined,
): void {
  useEffect(() => {
    void sessionId;
    if (!scrollParent) return;
    void prefetchMarkdownImpl();
  }, [sessionId, scrollParent]);
}

export type TimelineBlankProbeParams = {
  scrollParent: HTMLElement | null | undefined;
  sessionId: string | undefined;
  cb: CardCallbacks;
  listRootRef: MutableRefObject<HTMLDivElement | null>;
  blankDetectorRef: MutableRefObject<ReturnType<typeof createBlankDetector>>;
  blankProbeStateRef: MutableRefObject<{
    paintStart: number;
    paintEnd: number;
    sending: boolean;
    messagesLength: number;
  }>;
  followBottomRefBox: MutableRefObject<FollowBottomControllerRef | undefined>;
};

export function useTimelineBlankProbeEffect(params: TimelineBlankProbeParams): void {
  const {
    scrollParent, sessionId, cb, listRootRef,
    blankDetectorRef, blankProbeStateRef, followBottomRefBox,
  } = params;
  useEffect(() => {
    const scroller = scrollParent;
    if (!scroller || typeof window === "undefined") return;
    blankDetectorRef.current = createBlankDetector();
    let lastSampleAt = 0;
    let disposed = false;
    const collect = () => collectProbeInput({
      scroller, root: listRootRef.current,
      paintStart: blankProbeStateRef.current.paintStart,
      paintEnd: blankProbeStateRef.current.paintEnd,
      sending: blankProbeStateRef.current.sending,
      followBottom: followBottomRefBox.current ? followBottomRefBox.current.current === true : null,
      messagesLength: blankProbeStateRef.current.messagesLength,
    });
    const sample = (force = false) => {
      if (disposed) return;
      const now = Date.now();
      if (!force && now - lastSampleAt < BLANK_SAMPLE_INTERVAL_MS) return;
      lastSampleAt = now;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      let report: ReturnType<typeof blankDetectorRef.current.sample>;
      try {
        report = blankDetectorRef.current.sample(collect(), now);
      } catch {
        return;
      }
      if (!report) return;
      persistSnapshot(sessionId, report);
      cb.onTimelineBlank?.({ sessionId, report });
    };
    const timer = window.setInterval(() => sample(false), BLANK_SAMPLE_INTERVAL_MS);
    const onScroll = () => sample(false);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const w = window as typeof window & {
      __ocTimelineDump?: () => unknown;
      __ocTimelineBlankLast?: () => unknown;
    };
    w.__ocTimelineDump = () => {
      const input = collect();
      return {
        sessionId, now: Date.now(), input,
        classification: blankDetectorRef.current.sample(input, Date.now())?.classification ?? "sampled",
        lastConfirmed: blankDetectorRef.current.lastSnapshot(),
        persisted: readPersistedSnapshot(),
      };
    };
    w.__ocTimelineBlankLast = () => readPersistedSnapshot();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      scroller.removeEventListener("scroll", onScroll);
      if (w.__ocTimelineDump) Reflect.deleteProperty(w, "__ocTimelineDump");
      if (w.__ocTimelineBlankLast) Reflect.deleteProperty(w, "__ocTimelineBlankLast");
    };
  }, [scrollParent, sessionId, cb, listRootRef, blankDetectorRef, blankProbeStateRef, followBottomRefBox]);
}

export type RowGeometryWarmupParams = {
  scrollParent: HTMLElement | null | undefined;
  sessionId: string | undefined;
  windowVersion: number;
  messagesLength: number;
  listRootRef: MutableRefObject<HTMLDivElement | null>;
  didSnapToBottomRef: MutableRefObject<boolean>;
  visibleCountRef: MutableRefObject<number>;
  rowHeightCacheRef: MutableRefObject<Map<string, number>>;
};

export function useRowGeometryWarmupEffect(params: RowGeometryWarmupParams): void {
  const {
    scrollParent, sessionId, windowVersion, messagesLength,
    listRootRef, didSnapToBottomRef, visibleCountRef, rowHeightCacheRef,
  } = params;
  useEffect(() => {
    void sessionId;
    void windowVersion;
    void messagesLength;
    const root = listRootRef.current;
    const scroller = scrollParent;
    if (!root || !scroller || !didSnapToBottomRef.current || visibleCountRef.current === 0) return;
    const warmup = createRowGeometryWarmup({
      getRows: () => root.querySelectorAll<HTMLElement>("[data-chat-virtual-key]"),
      cache: rowHeightCacheRef.current,
    });
    const abort = () => warmup.abort();
    scroller.addEventListener("wheel", abort, { passive: true });
    scroller.addEventListener("touchstart", abort, { passive: true });
    scroller.addEventListener("pointerdown", abort);
    scroller.addEventListener("keydown", abort);
    warmup.start();
    return () => {
      abort();
      scroller.removeEventListener("wheel", abort);
      scroller.removeEventListener("touchstart", abort);
      scroller.removeEventListener("pointerdown", abort);
      scroller.removeEventListener("keydown", abort);
    };
  }, [
    scrollParent, sessionId, windowVersion, messagesLength,
    listRootRef, didSnapToBottomRef, visibleCountRef, rowHeightCacheRef,
  ]);
}
