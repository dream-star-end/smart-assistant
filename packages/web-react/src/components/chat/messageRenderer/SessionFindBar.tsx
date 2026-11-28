import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../../../lib/chat/model";
import { overscanPx, PAINT_MIN_ITEMS } from "../../../lib/chat/timelinePaint";
import { IconButton, Input, Spinner } from "../../ui";
import { captureVisibleVirtualRowAnchor, type VisibleVirtualRowAnchor } from "../archivePaging";
import {
  type FindMatch,
  type FindRenderLookupItem,
  findMatches,
  locateFindMatch,
  stepMatch,
  timelineMessageKey,
} from "../findInSession";
import {
  escapeFindSelector,
  FIND_ALIGN_BUDGET_MS,
  FIND_ALIGN_STABLE_FRAMES,
  type FindPinState,
  type FollowBottomControllerRef,
  type MessageListArchive,
  type RenderItem,
  renderItemKey,
} from "./types";

function findLookupItems(items: RenderItem[]): FindRenderLookupItem[] {
  return items.map((item) => {
    if (item.kind === "single") {
      const key = renderItemKey(item);
      return { key, memberKeys: [timelineMessageKey(item.m)] };
    }
    return {
      key: renderItemKey(item),
      memberKeys: item.members.map((member) => timelineMessageKey(member)),
    };
  });
}

function findToolbarEl(scroller: HTMLElement): HTMLElement | null {
  const input = scroller.querySelector('[aria-label="在会话中查找"]');
  if (!(input instanceof HTMLElement)) return null;
  let node: HTMLElement | null = input;
  while (node && node !== scroller) {
    const pos = typeof getComputedStyle === "function" ? getComputedStyle(node).position : node.style.position;
    if (pos === "sticky" || pos === "fixed") return node;
    node = node.parentElement;
  }
  const wrap = input.closest("div");
  return wrap instanceof HTMLElement ? wrap : null;
}

export function findViewTop(scroller: HTMLElement): number {
  const view = scroller.getBoundingClientRect();
  const bar = findToolbarEl(scroller)?.getBoundingClientRect() ?? null;
  return bar && bar.height > 0 ? bar.bottom : view.top;
}

function findTargetVisible(el: HTMLElement, scroller: HTMLElement): boolean {
  const row = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const top = findViewTop(scroller);
  return row.height > 0 && row.bottom > top + 1 && row.top >= top - 1 && row.top < view.bottom - 1;
}

function eventInFindToolbar(scroller: HTMLElement, target: EventTarget | null): boolean {
  const bar = findToolbarEl(scroller);
  return !!(bar && target instanceof Node && bar.contains(target));
}

export function findPaintNeighborhood(clientHeight: number, estimatePx: number): number {
  const extraPx = overscanPx(clientHeight);
  return Math.max(PAINT_MIN_ITEMS, Math.ceil(extraPx / Math.max(1, estimatePx)));
}

export function pinnedFindElement(scroller: HTMLElement, pin: FindPinState): HTMLElement | null {
  if (pin.memberKey) {
    const member = scroller.querySelector(`[data-find-member="${escapeFindSelector(pin.memberKey)}"]`);
    if (member instanceof HTMLElement) return member;
  }
  const row = scroller.querySelector(`[data-chat-virtual-key="${escapeFindSelector(pin.renderKey)}"]`);
  return row instanceof HTMLElement ? row : null;
}

function runFindSettleFrames(
  left: number,
  gen: number,
  pin: FindPinState,
  scroller: HTMLElement,
  follow: FollowBottomControllerRef,
  findGenRef: MutableRefObject<number>,
): void {
  if (left <= 0 || findGenRef.current !== gen) return;
  requestAnimationFrame(() => {
    if (findGenRef.current !== gen) return;
    const node = pinnedFindElement(scroller, pin);
    if (node instanceof HTMLElement) {
      const next = node.getBoundingClientRect();
      follow.correctTo?.(scroller, scroller.scrollTop + (next.top - findViewTop(scroller)));
    }
    runFindSettleFrames(left - 1, gen, pin, scroller, follow, findGenRef);
  });
}

function useFindFocusReturn(
  find: { onClose: () => void } | undefined,
  bumpFindGeneration: () => void,
  setFindQuery: Dispatch<SetStateAction<string>>,
  setFindCursor: Dispatch<SetStateAction<number>>,
): void {
  const findReturnFocusRef = useRef<HTMLElement | null>(null);
  const prevFindRef = useRef(find);
  if (!prevFindRef.current && find && typeof document !== "undefined") {
    const active = document.activeElement;
    findReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }
  prevFindRef.current = find;
  useEffect(() => {
    if (!find) {
      bumpFindGeneration();
      setFindQuery("");
      setFindCursor(0);
      const target = findReturnFocusRef.current;
      findReturnFocusRef.current = null;
      if (
        target?.isConnected &&
        (document.activeElement === null || document.activeElement === document.body)
      ) {
        target.focus({ preventScroll: true });
      }
    }
  }, [find, bumpFindGeneration, setFindQuery, setFindCursor]);
}

function useFindGestureCancel(
  scrollParent: HTMLElement | null | undefined,
  findPinRef: MutableRefObject<FindPinState | null>,
  bumpFindGeneration: () => void,
): void {
  useEffect(() => {
    const scroller = scrollParent;
    if (!scroller) return;
    const cancelIfFindPending = (event?: Event) => {
      if (
        event &&
        event.type !== "wheel" &&
        event.type !== "touchmove" &&
        eventInFindToolbar(scroller, event.target)
      ) {
        return;
      }
      if (findPinRef.current) bumpFindGeneration();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (eventInFindToolbar(scroller, event.target)) return;
      const gutter = scroller.offsetWidth - scroller.clientWidth;
      const edge = Math.max(gutter, 12);
      const rect = scroller.getBoundingClientRect();
      if (event.clientX >= rect.right - edge - 1) cancelIfFindPending();
    };
    scroller.addEventListener("wheel", cancelIfFindPending, { passive: true });
    scroller.addEventListener("touchmove", cancelIfFindPending, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown);
    return () => {
      scroller.removeEventListener("wheel", cancelIfFindPending);
      scroller.removeEventListener("touchmove", cancelIfFindPending);
      scroller.removeEventListener("pointerdown", onPointerDown);
    };
  }, [scrollParent, findPinRef, bumpFindGeneration]);
}

type FindPinAlignmentParams = {
  findPin: FindPinState | null;
  setFindPin: Dispatch<SetStateAction<FindPinState | null>>;
  findGenRef: MutableRefObject<number>;
  findPinRef: MutableRefObject<FindPinState | null>;
  lastViewportAnchorRef: MutableRefObject<VisibleVirtualRowAnchor | null>;
  scrollParent: HTMLElement | null | undefined;
  followBottomRef: FollowBottomControllerRef | undefined;
  windowVersion: number;
};

function useFindPinAlignment({
  findPin,
  setFindPin,
  findGenRef,
  findPinRef,
  lastViewportAnchorRef,
  scrollParent,
  followBottomRef,
  windowVersion,
}: FindPinAlignmentParams): void {
  useLayoutEffect(() => {
    void windowVersion;
    const pin = findPin;
    const scroller = scrollParent;
    const follow = followBottomRef;
    if (!pin || !scroller || !follow) return;
    const gen = pin.gen;
    let frame = 0;
    let stable = 0;
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const clearIfCurrent = () => {
      if (findGenRef.current !== gen) return;
      findPinRef.current = null;
      setFindPin((prev) => (prev && prev.gen === gen ? null : prev));
    };
    const tick = () => {
      frame = 0;
      if (findGenRef.current !== gen || findPinRef.current?.gen !== gen) return;
      const el = pinnedFindElement(scroller, pin);
      if (el instanceof HTMLElement) {
        const row = el.getBoundingClientRect();
        follow.correctTo?.(scroller, scroller.scrollTop + (row.top - findViewTop(scroller)));
        if (findGenRef.current !== gen) return;
        stable = findTargetVisible(el, scroller) ? stable + 1 : 0;
        if (stable >= FIND_ALIGN_STABLE_FRAMES) {
          if (findGenRef.current === gen) {
            lastViewportAnchorRef.current = captureVisibleVirtualRowAnchor(scroller);
            clearIfCurrent();
            runFindSettleFrames(8, gen, pin, scroller, follow, findGenRef);
          }
          return;
        }
      } else {
        stable = 0;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - started > FIND_ALIGN_BUDGET_MS) {
        clearIfCurrent();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [
    findPin, setFindPin, findGenRef, findPinRef,
    lastViewportAnchorRef, scrollParent, followBottomRef, windowVersion,
  ]);
}

export type SessionFindStateParams = {
  find: { onClose: () => void } | undefined;
  messages: ChatMessage[];
  sessionId: string | undefined;
  sending: boolean;
  scrollParent: HTMLElement | null | undefined;
  followBottomRef: FollowBottomControllerRef | undefined;
  windowVersion: number;
  lastViewportAnchorRef: MutableRefObject<VisibleVirtualRowAnchor | null>;
};

export type SessionFindState = ReturnType<typeof useSessionFindState>;

export function useSessionFindState(params: SessionFindStateParams) {
  const { find, messages, sessionId, sending, scrollParent, followBottomRef, windowVersion, lastViewportAnchorRef } = params;
  const [findQuery, setFindQuery] = useState("");
  const [findCursor, setFindCursor] = useState(0);
  const [findPin, setFindPin] = useState<FindPinState | null>(null);
  const findGenRef = useRef(0);
  const findPinRef = useRef<FindPinState | null>(null);
  findPinRef.current = findPin;

  const findMatchesList = useMemo(
    () => (find ? findMatches(messages, findQuery) : []),
    [find, messages, findQuery],
  );
  const findHitKeys = useMemo(() => new Set(findMatchesList.map((m) => m.key)), [findMatchesList]);
  const bumpFindGeneration = useCallback(() => {
    findGenRef.current += 1;
    findPinRef.current = null;
    setFindPin((prev) => (prev ? null : prev));
  }, []);

  useEffect(() => {
    void findQuery;
    setFindCursor(0);
    bumpFindGeneration();
  }, [findQuery, bumpFindGeneration]);
  useEffect(() => {
    void sessionId;
    bumpFindGeneration();
    setFindCursor(0);
  }, [sessionId, bumpFindGeneration]);
  useFindFocusReturn(find, bumpFindGeneration, setFindQuery, setFindCursor);
  useEffect(() => {
    if (sending) bumpFindGeneration();
  }, [sending, bumpFindGeneration]);
  useEffect(() => {
    const pin = findPinRef.current;
    if (!pin) return;
    const stillHit = findMatchesList.some((match) => match.key === (pin.memberKey ?? pin.renderKey));
    if (!stillHit) bumpFindGeneration();
  }, [findMatchesList, bumpFindGeneration]);
  useFindGestureCancel(scrollParent, findPinRef, bumpFindGeneration);
  useFindPinAlignment({
    findPin, setFindPin, findGenRef, findPinRef, lastViewportAnchorRef,
    scrollParent, followBottomRef, windowVersion,
  });

  return {
    findQuery, setFindQuery, findCursor, setFindCursor,
    findPin, setFindPin, findGenRef, findPinRef, findMatchesList, findHitKeys,
  };
}

export function projectSessionFind(
  find: { onClose: () => void } | undefined,
  findState: SessionFindState,
  renderItems: RenderItem[],
  windowStart: number,
  sending: boolean,
  scrollParent: HTMLElement | null | undefined,
  followBottomRef: FollowBottomControllerRef | undefined,
  revealRenderIndex: (targetIndex: number) => void,
) {
  const { findCursor, setFindCursor, setFindPin, findGenRef, findPinRef, findMatchesList, findHitKeys } = findState;
  const findCurrent =
    findMatchesList.length === 0
      ? -1
      : Math.min(Math.max(0, findCursor), findMatchesList.length - 1);
  const findLookup = find ? findLookupItems(renderItems) : [];
  const findCurrentTarget =
    findCurrent >= 0 ? locateFindMatch(findLookup, findMatchesList[findCurrent]) : null;
  const findHitRowKeys = new Set(
    findHitKeys.size > 0
      ? findLookup
          .filter((entry) => entry.memberKeys.some((member) => findHitKeys.has(member)))
          .map((entry) => entry.key)
      : [],
  );
  const jumpTo = (match: FindMatch) => {
    if (!followBottomRef || !scrollParent) return;
    const target = locateFindMatch(findLookupItems(renderItems), match);
    const gen = findGenRef.current + 1;
    findGenRef.current = gen;
    if (!target) {
      findPinRef.current = null;
      setFindPin(null);
      return;
    }
    followBottomRef.current = false;
    followBottomRef.releaseUserIntent?.();
    if (target.renderIndex < windowStart) revealRenderIndex(target.renderIndex);
    const pin: FindPinState = {
      gen, renderIndex: target.renderIndex,
      renderKey: target.renderKey, memberKey: target.memberKey,
    };
    findPinRef.current = pin;
    setFindPin(pin);
    const el = pinnedFindElement(scrollParent, pin);
    if (el instanceof HTMLElement) {
      const row = el.getBoundingClientRect();
      followBottomRef.correctTo?.(scrollParent, scrollParent.scrollTop + (row.top - findViewTop(scrollParent)));
    }
  };
  const goFind = (dir: 1 | -1) => {
    if (sending || findMatchesList.length === 0) return;
    const next = stepMatch(findMatchesList, findCurrent, dir);
    if (next < 0) return;
    setFindCursor(next);
    const match = findMatchesList[next];
    if (match) jumpTo(match);
  };
  return { findCurrent, findCurrentTarget, findHitRowKeys, goFind };
}

function FindScopeHint({
  matchCount,
  archive,
  archiveQueued,
  onSearchOlder,
  stopFindKeys,
}: {
  matchCount: number;
  archive: MessageListArchive | null | undefined;
  archiveQueued: boolean;
  onSearchOlder: () => void;
  stopFindKeys: (event: { stopPropagation: () => void }) => void;
}) {
  const busy = Boolean(archive?.loading) || archiveQueued;
  return (
    <div
      className="flex basis-full items-center justify-between gap-2 text-caption text-muted"
      data-testid="find-scope-hint"
    >
      <span className="min-w-0">
        {matchCount === 0 ? "已加载部分无匹配，" : ""}更早的记录还没加载，不在查找范围内
      </span>
      <button
        type="button"
        onKeyDown={stopFindKeys}
        onClick={onSearchOlder}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-hover px-3 py-1 text-caption text-muted transition-colors hover:text-fg disabled:cursor-default disabled:opacity-60 [@media(hover:none)]:min-h-11"
      >
        {busy
          ? <><Spinner size={12} /> 加载中…</>
          : archive?.error
            ? <span className="text-danger">加载失败，点击重试</span>
            : "搜更早"}
      </button>
    </div>
  );
}

function FindStepButtons({
  find,
  sending,
  matchCount,
  goFind,
  stopFindKeys,
}: {
  find: { onClose: () => void };
  sending: boolean;
  matchCount: number;
  goFind: (dir: 1 | -1) => void;
  stopFindKeys: (event: { stopPropagation: () => void }) => void;
}) {
  const stepOnKey = (dir: 1 | -1) => (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
    stopFindKeys(event);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      goFind(dir);
    }
  };
  const stepDisabled = sending || matchCount === 0;
  return (
    <>
      <IconButton
        shape="square"
        size="sm"
        aria-label="上一处"
        title={sending ? "生成中暂不可跳转" : "上一处"}
        disabled={stepDisabled}
        onKeyDown={stepOnKey(-1)}
        onClick={() => goFind(-1)}
      >
        <ChevronUp size={16} />
      </IconButton>
      <IconButton
        shape="square"
        size="sm"
        aria-label="下一处"
        title={sending ? "生成中暂不可跳转" : "下一处"}
        disabled={stepDisabled}
        onKeyDown={stepOnKey(1)}
        onClick={() => goFind(1)}
      >
        <ChevronDown size={16} />
      </IconButton>
      <IconButton
        shape="square"
        size="sm"
        aria-label="关闭查找"
        title="关闭查找"
        onKeyDown={stopFindKeys}
        onClick={find.onClose}
      >
        <X size={16} />
      </IconButton>
    </>
  );
}

export type SessionFindBarProps = {
  find: { onClose: () => void };
  findQuery: string;
  setFindQuery: (next: string) => void;
  findCurrent: number;
  matchCount: number;
  sending: boolean;
  hasOlderHistory: boolean;
  archive: MessageListArchive | null | undefined;
  archiveQueued: boolean;
  onSearchOlder: () => void;
  goFind: (dir: 1 | -1) => void;
};

export function SessionFindBar({
  find,
  findQuery,
  setFindQuery,
  findCurrent,
  matchCount,
  sending,
  hasOlderHistory,
  archive,
  archiveQueued,
  onSearchOlder,
  goFind,
}: SessionFindBarProps) {
  const stopFindKeys = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };
  return (
    <div
      className="oc-surface-glass sticky top-0 z-10 mx-auto flex max-w-3xl flex-wrap items-center gap-1.5 rounded-b-xl px-5 py-2 shadow-soft"
      onKeyDown={stopFindKeys}
      onPointerDown={stopFindKeys}
      onTouchStart={stopFindKeys}
    >
      <Input
        aria-label="在会话中查找"
        placeholder="在会话中查找…"
        autoFocus
        inputSize="sm"
        value={findQuery}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          stopFindKeys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            find.onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            goFind(e.shiftKey ? -1 : 1);
          }
        }}
        className="min-w-0 flex-1"
      />
      {findQuery.trim() ? (
        <span className="shrink-0 text-caption tabular-nums text-muted" data-testid="find-count">
          {matchCount === 0 ? "无匹配" : `${findCurrent + 1}/${matchCount}`}
        </span>
      ) : null}
      <FindStepButtons
        find={find}
        sending={sending}
        matchCount={matchCount}
        goFind={goFind}
        stopFindKeys={stopFindKeys}
      />
      {findQuery.trim() && hasOlderHistory ? (
        <FindScopeHint
          matchCount={matchCount}
          archive={archive}
          archiveQueued={archiveQueued}
          onSearchOlder={onSearchOlder}
          stopFindKeys={stopFindKeys}
        />
      ) : null}
    </div>
  );
}
