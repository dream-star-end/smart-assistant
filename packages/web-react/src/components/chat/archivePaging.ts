/**
 * 长会话「热尾巴 + 归档」分页的纯逻辑(无 React / DOM 依赖,便于单测)。
 *
 * 会话行体积有界后,超阈值的老消息被 spill 到归档 chunk 表,client_sessions 主行只留「热尾巴」。
 * 前端 messages 数组 = 尾巴 + 用户经「从云端加载更早的历史」按钮陆续拉回并**前插**的归档行。
 *
 * 关键不变量(决定分页 UI 无跳变):
 *  - 归档行携带 server 权威 `_orderSeq` 且不高于水位;热尾巴行高于水位。
 *  - 拉一页归档后,新加载的**可见行**全部从窗口裁剪量中扣除 → 既有可见窗口 `visible`
 *    不需 bump,刚拉回的归档行天然落在挂载窗口内(不会被再次藏进「加载更多」按钮)。
 *  - lossless tape 的一个归档 anchor 会展开成多条可见行且共享同一 `_orderSeq`;因此窗口计算按
 *    已加载可见行数,而「还有 N 条归档」按 distinct `_seq` anchor 数,两者不可混用。
 */
import type { ChatMessage } from "../../lib/chat/model";

/**
 * 当前 messages 数组里「已从云端拉回」的真实归档记录统计。
 * - rows:匹配水位的真实记录行数,用于保证刚拉回的可见行全部挂载。
 * - anchors:distinct `_orderSeq` 数。lossless tape 的所有展开行共享该 anchor,用于从
 *   `archivedCount` 扣除真正已加载的归档 anchor。
 * archivedThroughSeq ≤ 0 或无归档时恒 0。O(n),n 为当前会话内存行数。
 */
export function loadedArchivedMetrics(
  messages: Pick<ChatMessage, "_seq" | "_orderSeq">[],
  archivedThroughSeq: number,
): { rows: number; anchors: number } {
  if (!(archivedThroughSeq > 0)) return { rows: 0, anchors: 0 };
  let rows = 0;
  const anchors = new Set<number>();
  for (const m of messages) {
    const orderSeq = typeof m._orderSeq === "number" ? m._orderSeq : m._seq;
    if (typeof orderSeq === "number" && orderSeq <= archivedThroughSeq) {
      rows++;
      anchors.add(orderSeq);
    }
  }
  return { rows, anchors: anchors.size };
}

/**
 * 前插旧消息后为「视口不跳」校正的 scrollTop:把插入前后的高度差全部计入,让原先可见的
 * 那条消息保持在同一屏幕位置。prevTop 为插入前 scrollTop,new/prevHeight 为插入后/前 scrollHeight。
 */
export function correctedScrollTop(prevHeight: number, newHeight: number, prevTop: number): number {
  return prevTop + (newHeight - prevHeight);
}

export type VisibleVirtualRowAnchor = {
  key: string;
  top: number;
  scrollTop: number;
  scrollHeight: number;
  historyLayoutRevision: string | null;
};

/** Capture an actual rendered row instead of total scrollHeight. Bottom live
 * growth then cannot contaminate correction for rows prepended at the top. */
export function captureVisibleVirtualRowAnchor(
  scroller: HTMLElement,
): VisibleVirtualRowAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const rows = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-chat-virtual-key]"),
  );
  const row = rows.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  }) ?? rows.find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top);
  const key = row?.getAttribute("data-chat-virtual-key");
  if (!row || !key) return null;
  return {
    key,
    top: row.getBoundingClientRect().top - viewport.top,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    historyLayoutRevision: scroller
      .querySelector<HTMLElement>("[data-chat-history-layout-revision]")
      ?.getAttribute("data-chat-history-layout-revision") ?? null,
  };
}

/** Re-align one exact immutable virtual row. Returns false while Virtuoso has
 * not mounted/measured that row yet, allowing the caller to retry next frame. */
export function correctToVisibleVirtualRowAnchor(
  scroller: HTMLElement,
  anchor: VisibleVirtualRowAnchor,
): boolean {
  const row = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-chat-virtual-key]"),
  ).find((candidate) => candidate.getAttribute("data-chat-virtual-key") === anchor.key);
  if (!row) {
    // A large prepend can temporarily move the anchor outside Virtuoso's
    // mounted range before its per-row measurements settle. Move by the
    // observed total-height delta as a bootstrap only; subsequent frames use
    // the exact immutable row as soon as it remounts. This is not the final
    // correction, so concurrent bottom growth cannot permanently skew it.
    const heightDelta = scroller.scrollHeight - anchor.scrollHeight;
    if (Math.abs(heightDelta) > 0.5) {
      scroller.scrollTop = anchor.scrollTop + heightDelta;
    }
    return false;
  }
  const currentTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const delta = currentTop - anchor.top;
  if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
  return true;
}

type FrameScheduler = (callback: () => void) => void;

/** Repeat row correction while Virtuoso finishes measuring. Real user input
 * is supplied separately through `cancelled`, so programmatic scroll events
 * do not mask a later wheel/touch/keyboard decision. */
export function restoreVisibleVirtualRowAnchor(
  scroller: HTMLElement,
  anchor: VisibleVirtualRowAnchor,
  cancelled: () => boolean,
  schedule: FrameScheduler = (callback) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
    else callback();
  },
): Promise<void> {
  return new Promise((resolve) => {
    let observedPrependLayout = false;
    let stableFrames = 0;
    const correct = () => {
      if (cancelled()) {
        resolve();
        return;
      }
      const beforeRow = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-chat-virtual-key]"),
      ).find((candidate) => candidate.getAttribute("data-chat-virtual-key") === anchor.key);
      const beforeTop = beforeRow
        ? beforeRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null;
      const layoutMarker = scroller.querySelector<HTMLElement>(
        "[data-chat-history-layout-revision]",
      );
      const currentLayoutRevision = layoutMarker?.getAttribute(
        "data-chat-history-layout-revision",
      ) ?? null;
      const acknowledgedLayoutRevision = layoutMarker?.getAttribute(
        "data-chat-history-layout-ack",
      ) ?? null;
      const newLayoutAcknowledged =
        currentLayoutRevision !== null &&
        currentLayoutRevision !== anchor.historyLayoutRevision &&
        acknowledgedLayoutRevision === currentLayoutRevision;
      if (
        newLayoutAcknowledged ||
        beforeTop === null ||
        Math.abs(beforeTop - anchor.top) > 0.5
      ) {
        observedPrependLayout = true;
      }

      const found = correctToVisibleVirtualRowAnchor(scroller, anchor);
      const row = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-chat-virtual-key]"),
      ).find((candidate) => candidate.getAttribute("data-chat-virtual-key") === anchor.key);
      const currentTop = row
        ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null;

      if (
        observedPrependLayout && beforeTop !== null &&
        Math.abs(beforeTop - anchor.top) <= 0.5 &&
        found && currentTop !== null &&
        Math.abs(currentTop - anchor.top) <= 0.5
      ) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      // Do not finish on an arbitrary frame budget. Under a slow scheduler the
      // immutable row can remount after many frames; resolving before that is
      // the exact cause of the visible history jump. Two post-layout stable
      // frames prove the row entered the frame already mounted and aligned,
      // rather than merely looking aligned immediately after this frame's
      // correction. User input/session switch still terminates immediately
      // through `cancelled`.
      if (stableFrames >= 2) resolve();
      else schedule(correct);
    };
    schedule(correct);
  });
}

/** 「加载更多」按钮态(§4/§5)。 */
export type LoadMoreDescriptor =
  // 本地内存里还有未挂载的更早消息(翻内存即可);count 含「归档未拉」数,让用户看到总量。
  | { mode: "local"; count: number }
  // 本地已翻尽,云端还有归档未拉(走 loadOlderHistory)。
  | { mode: "cloud"; remaining: number }
  // 无更早历史。
  | null;

export type LoadMorePlan = {
  /** messages.slice 起点:藏掉最老的 localUnmounted 行,已拉回的归档行恒在挂载窗口内。 */
  sliceStart: number;
  /** 按钮态。 */
  button: LoadMoreDescriptor;
};

/**
 * 「加载更多」按钮状态机 + 挂载窗口切片起点(单一权威,组件与单测共用)。
 *  - localUnmounted = 尾巴里尚未挂载的可见行数
 *    = max(0, (total − archivedLoadedRows) − visible)。
 *  - remainingArchived = 云端还没拉回的归档 anchor 数
 *    = max(0, archivedCount − archivedLoadedAnchors)。
 * 优先本地翻页(count = 本地未挂 + 归档未拉,§4 计数含归档数);本地翻尽再走云端(§5 文案)。
 * sliceStart === localUnmounted:归档可见行前插使 total、archivedLoadedRows 同增 → 差恒定 →
 * localUnmounted 不因拉归档回升,刚拉回的可见行不会被重新藏起来。
 */
export function planLoadMore(input: {
  total: number;
  visible: number;
  archivedLoadedRows: number;
  archivedLoadedAnchors: number;
  archivedCount: number;
}): LoadMorePlan {
  const localUnmounted = Math.max(0, input.total - input.archivedLoadedRows - input.visible);
  const remainingArchived = Math.max(0, input.archivedCount - input.archivedLoadedAnchors);
  const button: LoadMoreDescriptor =
    localUnmounted > 0
      ? { mode: "local", count: localUnmounted + remainingArchived }
      : remainingArchived > 0
        ? { mode: "cloud", remaining: remainingArchived }
        : null;
  return { sliceStart: localUnmounted, button };
}
