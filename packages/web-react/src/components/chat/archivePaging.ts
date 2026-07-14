/**
 * 长会话「热尾巴 + 归档」分页的纯逻辑(无 React / DOM 依赖,便于单测)。
 *
 * 会话行体积有界后,超阈值的老消息被 spill 到归档 chunk 表,client_sessions 主行只留「热尾巴」。
 * 前端 messages 数组 = 尾巴 + 用户经「从云端加载更早的历史」按钮陆续拉回并**前插**的归档行。
 *
 * 关键不变量(决定分页 UI 无跳变):
 *  - 归档行携带 server 权威 `_seq` 且 `_seq ≤ archivedThroughSeq`(水位线);热尾巴行的
 *    `_seq > 水位` 或本地乐观行无 `_seq`。据此可纯函数判定「已拉回多少归档行」。
 *  - 拉一页归档后,新加载的**可见行**全部从窗口裁剪量中扣除 → 既有可见窗口 `visible`
 *    不需 bump,刚拉回的归档行天然落在挂载窗口内(不会被再次藏进「加载更多」按钮)。
 *  - lossless tape 的一个归档 anchor 会展开成多条可见行且共享同一 `_seq`;因此窗口计算按
 *    已加载可见行数,而「还有 N 条归档」按 distinct `_seq` anchor 数,两者不可混用。
 */
import type { ChatMessage } from "../../lib/chat/model";

/**
 * 当前 messages 数组里「已从云端拉回」的归档投影统计。
 * - rows:匹配水位的投影行数,用于保证刚拉回的可见行全部挂载。
 * - anchors:distinct `_seq` 数。lossless tape 的所有展开行共享 anchor `_seq`,用于从
 *   `archivedCount` 扣除真正已加载的归档 anchor。
 * archivedThroughSeq ≤ 0 或无归档时恒 0。O(n),n 为当前会话内存行数。
 */
export function loadedArchivedMetrics(
  messages: Pick<ChatMessage, "_seq">[],
  archivedThroughSeq: number,
): { rows: number; anchors: number } {
  if (!(archivedThroughSeq > 0)) return { rows: 0, anchors: 0 };
  let rows = 0;
  const anchors = new Set<number>();
  for (const m of messages) {
    if (typeof m._seq === "number" && m._seq <= archivedThroughSeq) {
      rows++;
      anchors.add(m._seq);
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
