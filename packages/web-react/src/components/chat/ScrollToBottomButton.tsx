import { ChevronDown } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

export function shouldShowScrollToBottom(
  following: boolean | undefined,
  messageCount: number,
  distance = Number.POSITIVE_INFINITY,
): boolean {
  return messageCount > 0 && following === false && distance > 80;
}

export function useScrollToBottomVisibility(opts: {
  scrollParent: HTMLElement | null | undefined;
  listRootRef: RefObject<HTMLElement | null>;
  followBottomRef: { current: boolean } | undefined;
  sessionId: string | null | undefined;
  messageCount: number;
}): [boolean, (visible: boolean) => void] {
  const { scrollParent, listRootRef, followBottomRef, sessionId, messageCount } = opts;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = scrollParent;
    if (!el || !followBottomRef) {
      setVisible(false);
      return;
    }
    let frame = 0;
    const sync = () => {
      frame = 0;
      setVisible(
        shouldShowScrollToBottom(
          followBottomRef.current,
          messageCount,
          el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    el.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    if (listRootRef.current) observer?.observe(listRootRef.current);
    return () => {
      el.removeEventListener("scroll", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollParent, followBottomRef, sessionId, messageCount, listRootRef]);

  return [visible, setVisible];
}

/**
 * 回到底部轻透明暖表面小圆胶囊。
 * 作为滚动内容（ResizeObserver root）的子节点，保持零高度（h-0 -mt-4）常驻挂载，
 * 仅通过 opacity / pointer-events 切换显隐，避免改写 scrollHeight 导致几何自激。
 */
export function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <div
      aria-hidden={!visible}
      data-testid="scroll-to-bottom-dock"
      data-visible={visible ? "true" : "false"}
      className="sticky bottom-4 z-10 -mt-4 h-0 overflow-visible"
    >
      <button
        type="button"
        data-testid="scroll-to-bottom"
        aria-label="回到底部"
        tabIndex={visible ? 0 : -1}
        className={
          "absolute bottom-0 right-0 flex size-8 items-center justify-center rounded-full border border-border-control bg-elevated/90 text-fg shadow-sm backdrop-blur-md transition-all duration-200 hover:bg-hover active:scale-95 [@media(hover:none)]:-right-2 [@media(hover:none)]:size-9 " +
          (visible ? "opacity-100" : "pointer-events-none opacity-0")
        }
        onClick={onClick}
      >
        <ChevronDown size={16} />
      </button>
    </div>
  );
}
