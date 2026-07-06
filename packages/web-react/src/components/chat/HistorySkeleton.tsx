import { Sparkles } from "lucide-react";
import { Avatar, Skeleton } from "../ui";

/**
 * 冷会话加载骨架屏。
 *
 * 现状痛点：切换 / 深链打开一个本地无缓存的会话时，getSession 拉取期间消息区先空白
 * （旧逻辑此时 wsMessages 为空 → 命中 showEmpty → 渲染 EmptyState），历史到达后又突然
 * 整屏填充，视觉上是「空 → 闪 → 满」。这里在「确知有历史待加载 / 深链未落定」的窗口内
 * 渲染消息形骨架，把突变换成平滑过渡。
 *
 * 判定信号（shouldShowHistorySkeleton）刻意不新造状态机 / 不改 reducer：
 *  - 有缓存消息（wsMessages 非空）→ 绝不显示骨架（避免与真内容打架 / 闪烁）；
 *  - 有 in-flight turn（sending）→ 走既有 typing 指示，不是历史加载；
 *  - 侧栏 meta 已知 messageCount>0 → 确知有历史 → 骨架直到内容到达（capExpired 安全兜底）；
 *  - meta 未知（深链 / listSessions 未落定）→ 800ms 兜底窗（graceExpired）后放行 EmptyState。
 */
export function shouldShowHistorySkeleton(p: {
  /** 已选中会话且非 demo。 */
  selected: boolean;
  /** 前置门（容器未就绪/未订阅）激活时不显示骨架（AgentGate 占位）。 */
  gated: boolean;
  /** 本地缓存/流式消息条数（wsMessages.length）。>0 即绝不骨架。 */
  cachedCount: number;
  /** 本轮进行中（wsSending）。 */
  sending: boolean;
  /** 侧栏 meta 已知的历史消息数；0=未知或确为空。 */
  knownMessageCount: number;
  /** 是否权威已知该会话 meta（listSessions 已落定且命中列表）。 */
  metaKnown: boolean;
  /** 800ms 兜底窗已过（meta 未知分支用）。 */
  graceExpired: boolean;
  /** 安全兜底超时已过（有历史分支的封顶，防历史拉取失败时骨架永停）。 */
  capExpired: boolean;
}): boolean {
  if (!p.selected || p.gated) return false;
  if (p.cachedCount > 0) return false; // 有缓存消息 → 绝不骨架
  if (p.sending) return false; // 有 in-flight turn → 走 typing 指示
  if (p.knownMessageCount > 0) return !p.capExpired; // 确知有历史 → 骨架至到达/兜底
  if (p.metaKnown) return false; // 权威已知为空会话 → 直接 EmptyState
  return !p.graceExpired; // meta 未知（深链/列表未落定）→ 800ms 兜底窗
}

/** 单条骨架气泡：左（助手，带头像）/右（用户）交替形态。 */
function SkeletonBubble({ side }: { side: "left" | "right" }) {
  if (side === "right") {
    // 用户消息：右对齐，单块圆角气泡。
    return (
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/2 max-w-[280px] rounded-2xl" />
      </div>
    );
  }
  // 助手消息：左侧头像 + 两三行文本条。
  return (
    <div className="flex gap-4">
      <Avatar tone="brand" className="mt-0.5 hidden shadow-sm sm:inline-flex">
        <Sparkles size={16} />
      </Avatar>
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

/**
 * 消息区加载骨架：2~3 条左右交替气泡，容器几何对齐 MessageList
 * （mx-auto max-w-3xl px-5 py-8 gap-4），历史到达时替换为真列表无跳动。
 */
export function MessageListSkeleton() {
  return (
    <div
      className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-8"
      aria-busy="true"
      aria-label="正在加载会话历史"
    >
      <SkeletonBubble side="right" />
      <SkeletonBubble side="left" />
      <SkeletonBubble side="right" />
    </div>
  );
}
