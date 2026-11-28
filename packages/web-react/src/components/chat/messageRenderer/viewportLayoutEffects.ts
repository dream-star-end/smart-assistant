import { type MutableRefObject, useLayoutEffect } from "react";
import type { UserUpwardPagingController } from "../../../lib/chat/tapePaging";
import { measureMountedRowHeight } from "../../../lib/chat/timelinePaint";
import {
  captureVisibleVirtualRowAnchor,
  correctedScrollTop,
  correctToVisibleVirtualRowAnchor,
  type VisibleVirtualRowAnchor,
} from "../archivePaging";
import { snapScrollToBottomOnce } from "../stickToBottom";
import type {
  FindPinState,
  FollowBottomControllerRef,
  LiveUnitsViewportHold,
} from "./types";
import { restoreLiveUnitsAnchor } from "./viewportScrollEffects";

export type ExpandAndLiveSettleParams = {
  windowVersion: number;
  scrollParent: HTMLElement | null | undefined;
  processPaging: UserUpwardPagingController;
  followBottomRef: FollowBottomControllerRef | undefined;
  followBottomRefBox: MutableRefObject<FollowBottomControllerRef | undefined>;
  pendingExpandCorrectionRef: MutableRefObject<{ height: number; top: number } | null>;
  liveUnitsSettleRef: MutableRefObject<LiveUnitsViewportHold | null>;
  endViewportPreserve: () => void;
};

export function useExpandAndLiveSettleLayoutEffect(params: ExpandAndLiveSettleParams): void {
  const {
    windowVersion, scrollParent, processPaging, followBottomRef,
    followBottomRefBox, pendingExpandCorrectionRef, liveUnitsSettleRef, endViewportPreserve,
  } = params;
  useLayoutEffect(() => {
    void windowVersion;
    const el = scrollParent;
    const pending = pendingExpandCorrectionRef.current;
    if (pending && el) {
      pendingExpandCorrectionRef.current = null;
      if (typeof followBottomRef?.correctTo === "function") {
        followBottomRef.correctTo(el, correctedScrollTop(pending.height, el.scrollHeight, pending.top));
      }
      endViewportPreserve();
    }
    const settled = liveUnitsSettleRef.current;
    if (!settled) return;
    liveUnitsSettleRef.current = null;
    const follow = followBottomRefBox.current;
    if (!el || !follow) {
      if (!settled.following) endViewportPreserve();
      return;
    }
    const gestured = processPaging.interactionVersion() !== settled.epoch;
    if (settled.following) {
      if (!gestured) {
        follow.current = true;
        follow.scrollToBottom?.(el);
      }
      return;
    }
    if (settled.anchor && typeof follow.correctTo === "function") {
      restoreLiveUnitsAnchor(el, settled.anchor, follow.correctTo);
    }
    endViewportPreserve();
  }, [
    windowVersion, scrollParent, processPaging, followBottomRef,
    followBottomRefBox, pendingExpandCorrectionRef, liveUnitsSettleRef, endViewportPreserve,
  ]);
}

export type ListResizeFollowParams = {
  scrollParent: HTMLElement | null | undefined;
  followBottomRef: FollowBottomControllerRef | undefined;
  windowVersion: number;
  messagesLength: number;
  listRootRef: MutableRefObject<HTMLDivElement | null>;
  viewportPreserveLockRef: MutableRefObject<boolean>;
  findPinRef: MutableRefObject<FindPinState | null>;
  lastViewportAnchorRef: MutableRefObject<VisibleVirtualRowAnchor | null>;
};

export function useListResizeFollowLayoutEffect(params: ListResizeFollowParams): void {
  const {
    scrollParent, followBottomRef, windowVersion, messagesLength,
    listRootRef, viewportPreserveLockRef, findPinRef, lastViewportAnchorRef,
  } = params;
  useLayoutEffect(() => {
    void windowVersion;
    void messagesLength;
    const scroller = scrollParent;
    const root = listRootRef.current;
    if (!scroller || !root || !followBottomRef || typeof ResizeObserver === "undefined") return;
    const recapture = () => {
      lastViewportAnchorRef.current = captureVisibleVirtualRowAnchor(scroller);
    };
    const follow = () => {
      if (viewportPreserveLockRef.current || findPinRef.current) return;
      if (followBottomRef.current) {
        followBottomRef.scrollToBottom?.(scroller);
        recapture();
        return;
      }
      const anchor = lastViewportAnchorRef.current;
      if (anchor && typeof followBottomRef.correctTo === "function") {
        correctToVisibleVirtualRowAnchor(scroller, anchor, followBottomRef.correctTo);
      }
      recapture();
    };
    const observer = new ResizeObserver(follow);
    observer.observe(root);
    if (!lastViewportAnchorRef.current) recapture();
    return () => observer.disconnect();
  }, [
    scrollParent, followBottomRef, windowVersion, messagesLength,
    listRootRef, viewportPreserveLockRef, findPinRef, lastViewportAnchorRef,
  ]);
}

export type InitialBottomSnapParams = {
  scrollParent: HTMLElement | null | undefined;
  windowVersion: number;
  messagesLength: number;
  sessionId: string | undefined;
  didSnapToBottomRef: MutableRefObject<boolean>;
  itemCountRef: MutableRefObject<number>;
  followBottomRef: FollowBottomControllerRef | undefined;
};

export function useInitialBottomSnapLayoutEffect(params: InitialBottomSnapParams): void {
  const {
    scrollParent, windowVersion, messagesLength, sessionId,
    didSnapToBottomRef, itemCountRef, followBottomRef,
  } = params;
  useLayoutEffect(() => {
    void windowVersion;
    void messagesLength;
    void sessionId;
    const el = scrollParent;
    if (!el || didSnapToBottomRef.current || itemCountRef.current === 0) return;
    didSnapToBottomRef.current = true;
    if (typeof followBottomRef?.scrollToBottom === "function") {
      followBottomRef.scrollToBottom(el);
    } else {
      snapScrollToBottomOnce(el);
    }
  }, [
    scrollParent, windowVersion, messagesLength, sessionId,
    didSnapToBottomRef, itemCountRef, followBottomRef,
  ]);
}

export function useLiveUnitsHoldLayoutEffect({
  scrollParent,
  liveUnitsHoldRef,
  followBottomRefBox,
  processPaging,
}: {
  scrollParent: HTMLElement | null | undefined;
  liveUnitsHoldRef: MutableRefObject<LiveUnitsViewportHold | null>;
  followBottomRefBox: MutableRefObject<FollowBottomControllerRef | undefined>;
  processPaging: UserUpwardPagingController;
}): void {
  useLayoutEffect(() => {
    const el = scrollParent;
    const hold = liveUnitsHoldRef.current;
    const follow = followBottomRefBox.current;
    if (!el || !hold || !follow) return;
    if (hold.following) {
      if (follow.current && processPaging.interactionVersion() === hold.epoch) {
        follow.scrollToBottom?.(el);
      }
      return;
    }
    if (hold.anchor && typeof follow.correctTo === "function") {
      restoreLiveUnitsAnchor(el, hold.anchor, follow.correctTo);
    }
  });
}

export type RowMeasureAndSpanAnchorParams = {
  paintStart: number;
  paintEnd: number;
  scrollParent: HTMLElement | null | undefined;
  windowVersion: number;
  sessionId: string | undefined;
  visibleItemsLength: number;
  listRootRef: MutableRefObject<HTMLDivElement | null>;
  rowHeightCacheRef: MutableRefObject<Map<string, number>>;
  lastPaintSpanRef: MutableRefObject<{ start: number; end: number }>;
  followBottomRefBox: MutableRefObject<FollowBottomControllerRef | undefined>;
  viewportPreserveLockRef: MutableRefObject<boolean>;
  findPinRef: MutableRefObject<FindPinState | null>;
  lastViewportAnchorRef: MutableRefObject<VisibleVirtualRowAnchor | null>;
};

export function useRowMeasureAndSpanAnchorLayoutEffect(params: RowMeasureAndSpanAnchorParams): void {
  const {
    paintStart, paintEnd, scrollParent, windowVersion, sessionId, visibleItemsLength,
    listRootRef, rowHeightCacheRef, lastPaintSpanRef, followBottomRefBox,
    viewportPreserveLockRef, findPinRef, lastViewportAnchorRef,
  } = params;
  useLayoutEffect(() => {
    void windowVersion;
    void sessionId;
    void visibleItemsLength;
    const root = listRootRef.current;
    if (root) {
      for (const row of root.querySelectorAll<HTMLElement>("[data-chat-virtual-key]")) {
        const key = row.getAttribute("data-chat-virtual-key");
        const height = measureMountedRowHeight(row);
        if (key && height !== null) rowHeightCacheRef.current.set(key, height);
      }
    }
    const el = scrollParent;
    if (!el) return;
    const spanChanged =
      lastPaintSpanRef.current.start !== paintStart || lastPaintSpanRef.current.end !== paintEnd;
    lastPaintSpanRef.current = { start: paintStart, end: paintEnd };
    const follow = followBottomRefBox.current;
    if (
      spanChanged &&
      follow &&
      follow.current !== true &&
      !viewportPreserveLockRef.current &&
      !findPinRef.current &&
      lastViewportAnchorRef.current &&
      typeof follow.correctTo === "function"
    ) {
      correctToVisibleVirtualRowAnchor(el, lastViewportAnchorRef.current, follow.correctTo);
    }
    lastViewportAnchorRef.current = captureVisibleVirtualRowAnchor(el);
  }, [
    paintStart, paintEnd, scrollParent, windowVersion, sessionId, visibleItemsLength,
    listRootRef, rowHeightCacheRef, lastPaintSpanRef, followBottomRefBox,
    viewportPreserveLockRef, findPinRef, lastViewportAnchorRef,
  ]);
}
