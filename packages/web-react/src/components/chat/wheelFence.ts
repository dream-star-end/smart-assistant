import { WHEEL_FENCE_QUIET_MS, type StickToBottomController } from "./stickToBottom";

/**
 * Compositor-owned scroll fence for the chat scroller: wheel / trackpad
 * sequences and the momentum phase after a touch release.
 *
 * The compositor keeps scrolling after each wheel event (smooth scrolling,
 * trackpad inertia, touch fling). A transient `markUserIntent` is consumed by
 * the first scroll event, after which ResizeObserver / paint-window corrections
 * could write scrollTop mid-gesture and snap the viewport back. Hold the fence
 * from the first wheel (or touch release) until the user is idle.
 *
 * Release rule: no wheel/touch-release for `quietMs` AND the scroller is at
 * rest (a `scrollend` arrived since the last wheel, or no scroll event for
 * `quietMs`). `scrollend` alone is not enough: Chromium ends a wheel scroll
 * transaction ~100ms after a discrete tick, so a continuous mouse-wheel run
 * emits scrollend between ticks. The quiet window from the last *input* is
 * what marks the gesture as over; scrollend only lets a finished animation
 * release sooner than the scroll-idle fallback (Safari has no scrollend).
 *
 * Shared by App.tsx and the browser harness so the real-browser gate exercises
 * the production listener ordering, not a copy.
 */
export interface ScrollKeyEventLike {
  key: string;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: EventTarget | null;
}

const NON_SCROLL_KEY_TARGETS =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="listbox"], [role="menu"], [role="combobox"]';
const SPACE_INTERACTIVE_TARGETS =
  'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]';

/**
 * Only keys that can scroll the chat viewport should suspend stick-to-bottom.
 * Shortcuts (Ctrl/Cmd+C), Escape, Tab, or Enter/Space on inline disclosures and
 * buttons do not scroll the container and must not freeze auto-follow.
 */
export function isScrollNavigationKey(event: ScrollKeyEventLike): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(NON_SCROLL_KEY_TARGETS)) return false;
  switch (event.key) {
    case "ArrowUp":
    case "ArrowDown":
    case "PageUp":
    case "PageDown":
    case "Home":
    case "End":
      return true;
    case " ":
    case "Spacebar":
      return !target?.closest(SPACE_INTERACTIVE_TARGETS);
    default:
      return false;
  }
}

export function attachWheelFence(
  el: HTMLElement,
  stick: Pick<StickToBottomController, "wheelFence" | "beginWheelFence" | "endWheelFence">,
  opts: { quietMs?: number; now?: () => number } = {},
): () => void {
  const quietMs = opts.quietMs ?? WHEEL_FENCE_QUIET_MS;
  const now = opts.now ?? (() => Date.now());
  let timer: number | null = null;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let scrollEnded = false;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const end = () => {
    clearTimer();
    if (stick.wheelFence.current) stick.endWheelFence();
  };
  const schedule = (ms: number) => {
    clearTimer();
    timer = window.setTimeout(tryEnd, Math.max(1, Math.ceil(ms)));
  };
  const tryEnd = () => {
    // `scrollend` calls tryEnd directly while a quiet timer may still be
    // queued. Only nulling the handle would orphan that timer: `schedule`
    // can track one handle, and the orphan would fire later — after a
    // detach/re-attach on the same controller — and end a fence it never owned.
    clearTimer();
    if (!stick.wheelFence.current) return;
    const t = now();
    const inputRemaining = quietMs - (t - lastInputAt);
    const scrollRemaining = scrollEnded ? 0 : quietMs - (t - lastScrollAt);
    const remaining = Math.max(inputRemaining, scrollRemaining);
    if (remaining <= 0) {
      end();
      return;
    }
    schedule(remaining);
  };
  const onInput = () => {
    stick.beginWheelFence();
    lastInputAt = now();
    scrollEnded = false;
    schedule(quietMs);
  };
  const onScroll = () => {
    if (!stick.wheelFence.current) return;
    lastScrollAt = now();
    scrollEnded = false;
    if (timer === null) schedule(quietMs);
  };
  const onScrollEnd = () => {
    if (!stick.wheelFence.current) return;
    scrollEnded = true;
    tryEnd();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isScrollNavigationKey(event)) onInput();
  };
  el.addEventListener("wheel", onInput, { passive: true });
  // Finger lift: direct manipulation ends, the fling (if any) is now the
  // compositor's. Corrections keep deferring until it comes to rest.
  el.addEventListener("touchend", onInput, { passive: true });
  el.addEventListener("touchcancel", onInput, { passive: true });
  // Boundary scroll keys (e.g. End/ArrowDown while already at bottom) emit no
  // scroll event; fencing them guarantees endWheelFence releases writeSuspended.
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("scrollend", onScrollEnd);
  return () => {
    end();
    el.removeEventListener("wheel", onInput);
    el.removeEventListener("touchend", onInput);
    el.removeEventListener("touchcancel", onInput);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("scrollend", onScrollEnd);
  };
}
