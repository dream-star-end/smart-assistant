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
      className="pointer-events-none sticky bottom-3 z-10 -mt-4 h-0 overflow-visible sm:bottom-4"
    >
      <button
        type="button"
        data-testid="scroll-to-bottom"
        aria-label="回到底部"
        tabIndex={visible ? 0 : -1}
        className={
          "oc-surface-glass oc-btn-tactile group absolute bottom-0 left-1/2 -translate-x-1/2 flex size-8 items-center justify-center rounded-full border border-border-control bg-elevated/90 text-muted shadow-float backdrop-blur-md outline-none transition-[opacity,transform,color,border-color] duration-200 ease-spring hover:-translate-y-0.5 hover:border-border-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:size-9 " +
          (visible ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0")
        }
        onClick={onClick}
      >
        <ChevronDown
          size={15}
          strokeWidth={2}
          className="transition-transform duration-200 ease-spring group-hover:translate-y-0.5 group-hover:text-accent"
        />
      </button>
    </div>
  );
}
