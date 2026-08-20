/** Near-bottom sticky follow for the ordinary-DOM transcript scroller. */

export const STICK_TO_BOTTOM_PX = 80;

export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  px: number = STICK_TO_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < px;
}

/**
 * Intent-based stick-to-bottom.
 *
 * Content-height growth (cards finishing layout, streaming markdown) must not
 * look like the user scrolled away. Only wheel / touch / pointer / keyboard
 * navigation updates `following`. Programmatic snaps ignore the next scroll
 * event so they cannot clear or set intent.
 */
export function createStickToBottomController() {
  const following = { current: true };
  const programmatic = { current: false };
  const userIntent = { current: false };

  const reset = () => {
    following.current = true;
    programmatic.current = false;
    userIntent.current = false;
  };

  const markUserIntent = () => {
    userIntent.current = true;
  };

  const scrollToBottom = (el: { scrollTop: number; scrollHeight: number }) => {
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
  };

  const onScroll = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => {
    if (programmatic.current) {
      programmatic.current = false;
      userIntent.current = false;
      return;
    }
    if (!userIntent.current) return;
    userIntent.current = false;
    following.current = isNearBottom(el);
  };

  return { following, reset, markUserIntent, scrollToBottom, onScroll };
}

export type StickToBottomController = ReturnType<typeof createStickToBottomController>;
