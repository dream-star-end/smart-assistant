/**
 * 委派过程树的卡内窗口：固定高度 + 贴底 + 上滑扩窗。
 * 状态全部在本组件内，childBlocks 仍以 reducer 为唯一权威。
 */
import { useCallback, useLayoutEffect, useRef, useState, type UIEvent, type WheelEvent } from "react";
import type { ChildBlock } from "../../lib/chat/model";
import { childSignature } from "../../lib/chat/render";
import { groupDigits } from "../../lib/utils";
import { ChildBlockView } from "./AgentGroupCard";

export const DELEGATE_PROCESS_TAIL_SIZE = 30;
export const DELEGATE_PROCESS_EXPAND_STEP = 10;
export const DELEGATE_PROCESS_EXPAND_TOP_PX = 80;
export const DELEGATE_PROCESS_UNSTICK_PX = 24;

export function windowStartForTail(total: number, tailSize = DELEGATE_PROCESS_TAIL_SIZE): number {
  return Math.max(0, total - tailSize);
}

export function expandWindowStart(start: number, step = DELEGATE_PROCESS_EXPAND_STEP): number {
  return Math.max(0, start - step);
}

/** 向更早方向插入节点后，把新增高度加回 scrollTop，保住当前视口。 */
export function anchoredScrollTop(
  prevScrollHeight: number,
  nextScrollHeight: number,
  prevScrollTop: number,
): number {
  return prevScrollTop + (nextScrollHeight - prevScrollHeight);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function lastBashTailBytes(children: ChildBlock[]): number | null {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.kind === "tool_use" && child.bashTail && child.bashTail.totalBytes > 0) {
      return child.bashTail.totalBytes;
    }
  }
  return null;
}

export function DelegateProcessList({ childBlocks }: { childBlocks: ChildBlock[] }) {
  const blocks = Array.isArray(childBlocks) ? childBlocks : [];
  const total = blocks.length;
  const [windowStart, setWindowStart] = useState(() => windowStartForTail(total));
  const [followBottom, setFollowBottom] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    // 贴底时只保留尾部窗口，避免直播追加把 300 条全挂进 DOM。
    setWindowStart((value) => {
      const tailStart = windowStartForTail(total);
      if (stickRef.current) return tailStart;
      return Math.min(value, tailStart);
    });
  }, [total]);

  const start = Math.min(windowStart, windowStartForTail(total));
  const mounted = blocks.slice(start);
  const mountedCount = mounted.length;
  const progress = total === 0 ? 0 : mountedCount / total;
  const tailBytes = lastBashTailBytes(blocks);
  // 末条 output/bashTail 变长时 total 不变，也要贴底。
  const lastChild = total > 0 ? blocks[total - 1] : undefined;
  const liveSig = lastChild ? childSignature(lastChild) : "";

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const anchor = pendingAnchorRef.current;
    if (anchor != null) {
      pendingAnchorRef.current = null;
      el.scrollTop = anchoredScrollTop(anchor.height, el.scrollHeight, anchor.top);
      return;
    }
    if (stickRef.current) scrollToBottom();
  }, [total, start, liveSig, tailBytes, scrollToBottom]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollTop > 0) event.stopPropagation();
    const distBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    const stuck = distBottom <= DELEGATE_PROCESS_UNSTICK_PX;
    stickRef.current = stuck;
    if (stuck !== followBottom) setFollowBottom(stuck);
    if (stuck && start !== windowStartForTail(total)) {
      setWindowStart(windowStartForTail(total));
    }
    // 用本次滚动算出的 stuck，避免「刚离底」时仍读到旧 followBottom 而扩不了窗。
    if (!stuck && el.scrollTop < DELEGATE_PROCESS_EXPAND_TOP_PX && start > 0) {
      pendingAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      setWindowStart((value) => expandWindowStart(Math.min(value, start)));
    }
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollTop > 0) event.stopPropagation();
  };

  if (total === 0) return null;

  return (
    <div className="relative">
      <div className="border-b border-border px-3.5 py-1.5">
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>
            已加载 {groupDigits(String(mountedCount))} / {groupDigits(String(total))} 步
          </span>
          {tailBytes != null && <span>输出 {formatBytes(tailBytes)}</span>}
        </div>
        <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-hover">
          <div
            className="h-full rounded-full bg-accent/70"
            style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
            data-testid="delegate-process-progress"
          />
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="delegate-process-scroller h-[min(420px,50vh)] overflow-y-auto overscroll-contain"
        data-testid="delegate-process-scroller"
        style={{ overflowAnchor: "none" }}
        onScroll={onScroll}
        onWheel={onWheel}
      >
        <div className="space-y-2 px-3.5 py-2.5">
          {mounted.map((ch, i) => (
            <div
              key={`${start + i}-${ch.blockId ?? ch.kind}`}
              className="delegate-process-child"
              data-testid="delegate-process-child"
              style={{ contentVisibility: "visible" }}
            >
              <ChildBlockView child={ch} sig={childSignature(ch)} />
            </div>
          ))}
        </div>
      </div>
      {!followBottom && (
        <button
          type="button"
          className="absolute bottom-3 right-3 rounded-full bg-fg px-2.5 py-1 text-[11px] text-bg shadow"
          onClick={() => {
            stickRef.current = true;
            setFollowBottom(true);
            setWindowStart(windowStartForTail(total));
            requestAnimationFrame(scrollToBottom);
          }}
        >
          回到最新
        </button>
      )}
    </div>
  );
}

