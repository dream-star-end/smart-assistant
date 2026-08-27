/** Near-bottom sticky follow for the ordinary-DOM transcript scroller. */

export const STICK_TO_BOTTOM_PX = 80;
const WRITE_TOLERANCE_PX = 1;

export type StickScroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function distanceFromBottom(el: StickScroller): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function maxScrollTop(el: StickScroller): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

export function isNearBottom(el: StickScroller, px: number = STICK_TO_BOTTOM_PX): boolean {
  return distanceFromBottom(el) < px;
}

/**
 * Single-writer stick-to-bottom.
 *
 * The controller is the only programmatic writer of `scrollTop`. Correctness
 * comes from check-before-write against the last value we wrote (clamped when
 * `scrollHeight` shrinks). Wheel/touch marks only suspend writes to hide jitter;
 * they are not the leave/re-follow source, and there is no gesture timer.
 *
 * Re-follow only when a scroll event shows `scrollTop` increased relative to the
 * last observation and the viewport is within 80px of the bottom. A shrink-clamp
 * that lands near the bottom is not re-follow.
 *
 * A marked user scroll leaves as soon as `current < expected`. The 1px write
 * tolerance is only for unmarked clamp / subpixel noise.
 */
export function createStickToBottomController() {
  const following = { current: true };
  const writeSuspended = { current: false };
  const lastWrittenTop = { current: null as number | null };
  const lastObservedTop = { current: null as number | null };

  const expectedWrittenTop = (el: StickScroller): number | null => {
    if (lastWrittenTop.current === null) return null;
    return Math.min(lastWrittenTop.current, maxScrollTop(el));
  };

  const recordWrite = (el: StickScroller) => {
    lastWrittenTop.current = el.scrollTop;
    lastObservedTop.current = el.scrollTop;
  };

  const userMovedAboveWrite = (el: StickScroller): boolean => {
    const expected = expectedWrittenTop(el);
    if (expected === null) return false;
    return el.scrollTop < expected - WRITE_TOLERANCE_PX;
  };

  const reset = () => {
    following.current = true;
    writeSuspended.current = false;
    lastWrittenTop.current = null;
    lastObservedTop.current = null;
  };

  const markUserIntent = () => {
    writeSuspended.current = true;
  };

  const releaseUserIntent = () => {
    writeSuspended.current = false;
  };

  const scrollToBottom = (el: StickScroller) => {
    if (!following.current || writeSuspended.current) return;
    if (userMovedAboveWrite(el)) {
      following.current = false;
      return;
    }
    el.scrollTop = maxScrollTop(el);
    recordWrite(el);
  };

  const correctTo = (el: StickScroller, nextTop: number) => {
    el.scrollTop = nextTop;
    recordWrite(el);
  };

  const onScroll = (el: StickScroller) => {
    const hadUserIntent = writeSuspended.current;
    writeSuspended.current = false;
    const current = el.scrollTop;
    const maxTop = maxScrollTop(el);
    const prevObserved = lastObservedTop.current;
    const expected = expectedWrittenTop(el);
    const leaveTolerance = hadUserIntent ? 0 : WRITE_TOLERANCE_PX;

    // Browser clamped our last position after scrollHeight shrank. That is not
    // a user leave, and landing near the new bottom is not a re-follow.
    if (
      prevObserved !== null &&
      maxTop < prevObserved - WRITE_TOLERANCE_PX &&
      Math.abs(current - maxTop) <= WRITE_TOLERANCE_PX
    ) {
      lastObservedTop.current = current;
      if (lastWrittenTop.current !== null) {
        lastWrittenTop.current = Math.min(lastWrittenTop.current, current);
      }
      return;
    }

    if (expected !== null && current < expected - leaveTolerance) {
      following.current = false;
    } else if (prevObserved !== null && current < prevObserved - leaveTolerance) {
      following.current = false;
    } else if (
      prevObserved !== null &&
      current > prevObserved + WRITE_TOLERANCE_PX &&
      isNearBottom(el)
    ) {
      following.current = true;
    } else if (expected === null && prevObserved === null && !isNearBottom(el)) {
      following.current = false;
    }

    lastObservedTop.current = current;
  };

  const canRestick = {
    get current() {
      return following.current && !writeSuspended.current;
    },
    set current(value: boolean) {
      following.current = value;
    },
    scrollToBottom,
    correctTo,
  };

  return {
    following,
    canRestick,
    gesture: writeSuspended,
    reset,
    markUserIntent,
    releaseUserIntent,
    scrollToBottom,
    correctTo,
    onScroll,
  };
}

export type StickToBottomController = ReturnType<typeof createStickToBottomController>;
