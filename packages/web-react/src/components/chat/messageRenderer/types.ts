import type { ReactNode } from "react";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../../lib/chat/model";
import type { processSwarmSnapshot } from "../../../lib/chat/swarmBoardEvidence";
import type { UserUpwardPagingController } from "../../../lib/chat/tapePaging";
import type { CardCallbacks } from "../cards";
import { timelineMessageKey } from "../findInSession";
import type { PermissionRespond } from "../permissionPromptState";
import type { DisplayTokenUsage } from "../tokenUsage";
import type { TurnActivityInfo } from "../TurnActivity";

// Ordinary DOM timeline. First paint mounts only the newest tail so a 600-row
// session does not commit every card before the first frame. Scrolling near the
// top reveals already-resident rows; server history still uses the explicit
// hasMore / loadOlder button (scroll never issues a network page).
export const TIMELINE_INITIAL_TAIL_ITEMS = 80;
export const TIMELINE_WINDOW_EXPAND_ITEMS = 80;
/** Safety stop for a cursor that keeps moving. One manual page remains after this. */
export const LIVE_UNITS_AUTO_PAGE_CAP = 40;
export const TIMELINE_EXPAND_NEAR_TOP_PX = 160;
export const RUNTIME_TEXT_STEP = 32 * 1024;
/** 延迟记录读取失败后的静默重试间隔(OCV5-421)。用尽才显示「点击重试」。 */
export const LAZY_PAYLOAD_RETRY_MS = [1500, 4000] as const;
/** Wait long enough for the 200ms wheel quiet fence plus a few layout frames. */
export const FIND_ALIGN_BUDGET_MS = 1200;
export const FIND_ALIGN_STABLE_FRAMES = 3;

export type RendererProps = {
  message: ChatMessage;
  /** 渲染签名（变更触发重渲；不变则 memo 跳过——防闪核心）。*/
  sig: string;
  isLast: boolean;
  sending: boolean;
  /** 是否属于「当前活跃段」(最后一条 user 消息之后)。判定收口在 chat/turnSegment.ts,
   *  与 PinnedTaskTracker 的任务源提取共用同一函数——决定 TodoWrite/plan 抑制还是渲染只读卡。*/
  inActiveTurn: boolean;
  /** 当前活跃会话的本轮活动快照（AssistantCard 流式空正文分支据此渲染阶段反馈）。透传，
   *  不进 memo 比较键——TurnActivity 自带 1s tick，无需靠父级重渲驱动秒数。 */
  turnActivity?: TurnActivityInfo | null;
  /** 本轮活动状态由稳定的 MessageList footer 独占，避免行类型切换时重复挂卸。 */
  activityInFooter?: boolean;
  /** 服务端历史代次；隔离旧请求与同 id 的新时间线。 */
  historyGeneration?: number | string;
  /** 生命周期归 MessageList，而不是可卸载的虚拟行。 */
  processPaging?: UserUpwardPagingController;
  /** Exact call usage for this card, or the final assistant's turn fallback. */
  tokenUsage?: DisplayTokenUsage;
  /** 债D:agent-group 单卡(未成团的退化委派)本 turn 的委派成本(十进制大数字符串)。
   *  来自队长助手行 usage.delegates,按 _delegateAgentId 匹配;非 agent-group 行恒 undefined。
   *  值来自**别的行**(助手行)故不在 message sig 内,单列进 memo 比较器,成本后到时正常重渲。*/
  delegateCost?: string;
  /** 该行是否为「所在轮末条 assistant 正文」(评价反馈行只挂末条,轮内中间回复不出)。
   *  值随后续消息追加而翻转,**已编进 sig head**(messageSignature 的 turnFinalAssistant)→
   *  由 a.sig===b.sig 覆盖翻转重渲,无需单列进 memo 比较器。*/
  turnFinalAssistant?: boolean;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  /** 只读会话查看：禁止权限/问答卡触发任何写动作。 */
  readOnly?: boolean;
  /** 同一可见轮已有错误卡/状态卡，用户行不再重复展示失败标签和重试。 */
  failurePresentedBelow?: boolean;
  /** 初始尾部 locator：跳过 600px IO，进会话即兑付正文。 */
  eagerPayload?: boolean;
  /** MessageList owns PermissionPromptHost; timeline cards must not mount a second modal. */
  hostedPermission?: boolean;
};

export type MessageRendererComponent = (props: RendererProps) => ReactNode;

export type LeafRenderItem =
  | {
      kind: "single";
      m: ChatMessage;
      isLast: boolean;
      idx: number;
      delegateCost?: string;
      tokenUsage?: DisplayTokenUsage;
    }
  | { kind: "team"; members: ChatMessage[]; sig: string; delegateCosts?: Record<string, string> }
  | {
      kind: "thinking";
      members: ChatMessage[];
      sig: string;
      isLast: boolean;
      idx: number;
      tokenUsage?: DisplayTokenUsage;
    };

export type SingleRenderItem = Extract<LeafRenderItem, { kind: "single" }>;

export type RenderItem =
  | LeafRenderItem
  | {
      kind: "process";
      key: string;
      members: ChatMessage[];
      items: LeafRenderItem[];
      active: boolean;
      swarm?: ReturnType<typeof processSwarmSnapshot>;
    }
  | {
      kind: "approval-group";
      key: string;
      members: ChatMessage[];
      items: SingleRenderItem[];
      ticketIds: string[];
    };

export type ProcessRenderItem = Extract<RenderItem, { kind: "process" }>;

export type LiveUnitsViewportAnchor = {
  top: number;
  member: string;
};

export type LiveUnitsViewportHold = {
  following: boolean;
  epoch: number;
  anchor: LiveUnitsViewportAnchor | null;
};

export type FindPinState = {
  gen: number;
  renderIndex: number;
  renderKey: string;
  /** Timeline key of the matched message. Equals renderKey for a single row. */
  memberKey?: string;
};

export type ScrollerGeometryTarget = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export type FollowBottomControllerRef = {
  current: boolean;
  jumpToBottom?: (el: ScrollerGeometryTarget) => void;
  scrollToBottom?: (el: ScrollerGeometryTarget) => void;
  correctTo?: (el: ScrollerGeometryTarget, nextTop: number) => void;
  /** Consume a leftover keyboard/wheel mark. Does not clear fences. */
  releaseUserIntent?: () => void;
};

/**
 * Unified timeline paging context. Loading is an explicit-button action;
 * scrolling only navigates already resident records.
 */
export type MessageListArchive = {
  /** Unified server cursor reports an older exact page. */
  hasMore?: boolean;
  /** Rolling-test/old-caller compatibility only. */
  archivedCount?: number;
  archivedThroughSeq?: number;
  /** 云端加载进行中(按钮转 loading 态、禁用)。 */
  loading: boolean;
  /** 上次云端加载失败(按钮转「加载失败，点击重试」,点击即重试)。 */
  error: boolean;
  /** 拉更早一页归档(App 接线 loadOlderHistory + 前插后视口保持)。 */
  onLoadOlder: () => void | Promise<void>;
  /** Hot live-unit window still has earlier units than the first pack. */
  liveHasMoreBefore?: boolean;
  /** Server cursor for the next older live-unit page. Auto-load keys on this. */
  liveUnitsCursor?: string | null;
  onLoadOlderLiveUnits?: () =>
    | void
    | Promise<void>
    | Promise<
        | undefined
        | {
            ok?: boolean;
            hasMore?: boolean;
            error?: boolean;
            inflight?: boolean;
          }
      >;
};

export type MessageListProps = {
  /** Main chat uses result-first presentation; diagnostics may retain raw rows. */
  processDisclosure?: boolean;
  messages: ChatMessage[];
  sending: boolean;
  /** Active browser turn's live token display; estimates are explicitly marked. */
  liveTurnUsage?: { clientMessageId: string; usage: LiveTurnTokenUsageSnapshot };
  /** 本轮活动快照（TurnActivity 阶段反馈）；null=无活跃轮。*/
  turnActivity?: TurnActivityInfo | null;
  /** 会话级 transient 软提示（非消息卡片，末尾 info 条渲染）。*/
  transientNotice?: { text: string } | null;
  /** 已有部分消息可见，但 canonical history 仍在加载。 */
  historyLoading?: boolean;
  /** 归档分页上下文；缺省=无归档(仅本地翻页)。*/
  archive?: MessageListArchive | null;
  cb: CardCallbacks;
  onRespondPermission: PermissionRespond;
  /** 管理端等只读 surface；默认 false，用户端行为不变。 */
  readOnly?: boolean;
  /** Existing chat scroller. When present, first paint mounts the newest tail. */
  scrollParent?: HTMLElement | null;
  /** Server history revision. A new revision gets a fresh paging intent owner. */
  historyGeneration?: number | string;
  sessionId?: string;
  /**
   * App stick-to-bottom intent. When true, content-height growth (late card
   * layout, streaming) re-snaps the scroller to the end. Window expand sets
   * this false and holds a preserve lock so ResizeObserver cannot yank to
   * bottom while correctedScrollTop runs.
   */
  followBottomRef?: FollowBottomControllerRef;
  /** 会话内查找条。有值即渲染；关闭后高亮一并清除。 */
  find?: { onClose: () => void };
};

export function defaultTailStart(length: number): number {
  return Math.max(0, length - TIMELINE_INITIAL_TAIL_ITEMS);
}

export function itemMessages(item: LeafRenderItem): ChatMessage[] {
  return item.kind === "single" ? [item.m] : item.members;
}

export function itemRows(item: RenderItem): ChatMessage[] {
  return item.kind === "process" || item.kind === "approval-group" ? item.members : itemMessages(item);
}

export function renderItemKey(item: RenderItem): string {
  try {
    if (item.kind === "process" || item.kind === "approval-group") return item.key;
    if (item.kind === "single") {
      return timelineMessageKey(item.m);
    }
    const key = item.members[0]?._timelineUnitKey ?? item.members[0]?.id ?? item.kind;
    return typeof key === "string" && key.length > 0 ? key : item.kind;
  } catch {
    return "corrupt-item";
  }
}

export function lastUserItemIndex(items: RenderItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === "single" && item.m.role === "user") return i;
  }
  return -1;
}

export function escapeFindSelector(key: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(key)
    : key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Measured row heights, bucketed per session. Row keys are timeline unit keys
 * (unique per record), so a bucket survives leaving and re-entering a session.
 * Bounded so long sessions cannot pin memory; eviction is oldest-session-first.
 */
const ROW_HEIGHT_BUCKETS_MAX = 12;
const rowHeightBuckets = new Map<string, Map<string, number>>();

export function rowHeightBucket(sessionId: string | undefined): Map<string, number> {
  const id = sessionId ?? "";
  const existing = rowHeightBuckets.get(id);
  if (existing) {
    rowHeightBuckets.delete(id);
    rowHeightBuckets.set(id, existing);
    return existing;
  }
  const created = new Map<string, number>();
  rowHeightBuckets.set(id, created);
  while (rowHeightBuckets.size > ROW_HEIGHT_BUCKETS_MAX) {
    const oldest = rowHeightBuckets.keys().next().value;
    if (oldest === undefined) break;
    rowHeightBuckets.delete(oldest);
  }
  return created;
}
