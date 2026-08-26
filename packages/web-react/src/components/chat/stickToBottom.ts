/** Near-bottom sticky follow for the ordinary-DOM transcript scroller. */

export const STICK_TO_BOTTOM_PX = 80;

function distanceFromBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  px: number = STICK_TO_BOTTOM_PX,
): boolean {
  return distanceFromBottom(el) < px;
}

/**
 * Intent-based stick-to-bottom.
 *
 * Content-height growth (cards finishing layout, streaming markdown) must not
 * look like the user scrolled away. Wheel / touch / pointer / keyboard
 * navigation updates `following`. Unmarked scrollbar drags are inferred from
 * a real upward viewport move. Programmatic snaps ignore the next scroll
 * event so they cannot clear or set intent.
 *
 * Restick and tail-window pinning must use `canRestick`, not `following`.
 * A live gesture sets `canRestick=false` immediately so ResizeObserver /
 * version effects cannot write the user back to the bottom before `onScroll`.
 * Inertial scroll after the first event still uses `gestureOriginGap` while
 * `gesture` is true, even after `userIntent` was consumed.
 */
export function createStickToBottomController() {
  const following = { current: true };
  const programmatic = { current: false };
  const userIntent = { current: false };
  const gesture = { current: false };
  // Absolute scrollTop can rise while the user scrolls upward if a streaming
  // card grows at the same time. Bottom-relative distance preserves the real
  // direction across those layout changes.
  const lastDistanceFromBottom = { current: null as number | null };
  const lastScrollTop = { current: null as number | null };
  // Per-event `lastGap + 1` would swallow 8 consecutive 1px moves. Leave
  // detection is relative to the gap at the start of this gesture.
  const gestureOriginGap = { current: null as number | null };

  const reset = () => {
    following.current = true;
    programmatic.current = false;
    userIntent.current = false;
    gesture.current = false;
    lastDistanceFromBottom.current = null;
    lastScrollTop.current = null;
    gestureOriginGap.current = null;
  };

  const markUserIntent = () => {
    userIntent.current = true;
    gesture.current = true;
    if (gestureOriginGap.current === null) {
      gestureOriginGap.current = lastDistanceFromBottom.current;
    }
  };

  const releaseUserIntent = () => {
    gesture.current = false;
    gestureOriginGap.current = null;
  };

  const leaveFollowing = () => {
    following.current = false;
    programmatic.current = false;
    userIntent.current = false;
  };

  const scrollToBottom = (
    el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => {
    if (!following.current || gesture.current) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    lastDistanceFromBottom.current = distanceFromBottom(el);
    lastScrollTop.current = el.scrollTop;
  };

  const onScroll = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => {
    const previousDistance = lastDistanceFromBottom.current;
    const previousTop = lastScrollTop.current;
    const currentDistance = distanceFromBottom(el);
    lastDistanceFromBottom.current = currentDistance;
    lastScrollTop.current = el.scrollTop;
    if (gesture.current && gestureOriginGap.current === null) {
      gestureOriginGap.current = previousDistance ?? currentDistance;
    }
    const leaveBaseline = gestureOriginGap.current ?? previousDistance;
    // Gesture (including inertia after userIntent was consumed) and the
    // originating input both leave relative to the gesture-start gap.
    if (
      (userIntent.current || gesture.current) &&
      leaveBaseline !== null &&
      currentDistance > leaveBaseline + 1
    ) {
      leaveFollowing();
      return;
    }
    if (programmatic.current) {
      programmatic.current = false;
      userIntent.current = false;
      return;
    }
    if (!userIntent.current) {
      // Scrollbar / other unmarked input: a real upward viewport move, not
      // content-height growth under a stable scrollTop.
      if (
        !gesture.current &&
        previousDistance !== null &&
        previousTop !== null &&
        currentDistance > previousDistance + 1 &&
        el.scrollTop < previousTop - 1
      ) {
        leaveFollowing();
      }
      return;
    }
    userIntent.current = false;
    following.current = isNearBottom(el);
  };

  const canRestick = {
    get current() {
      return following.current && !gesture.current;
    },
    set current(value: boolean) {
      following.current = value;
    },
    scrollToBottom,
  };

  return {
    following,
    canRestick,
    gesture,
    reset,
    markUserIntent,
    releaseUserIntent,
    scrollToBottom,
    onScroll,
  };
}

export type StickToBottomController = ReturnType<typeof createStickToBottomController>;
