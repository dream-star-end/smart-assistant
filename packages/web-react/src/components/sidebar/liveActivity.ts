/**
 * 工作台活态指挥区（Sidebar Live Strip）与 ⌘K 活态会话共享的纯聚合模型。
 *
 * 将非归档会话按优先级收敛为三类活态桶（单会话仅落最高优先级桶，不重复出现）：
 *   1. needs_you   待我拍板（waiting approval / pending permission / waiting answer）
 *   2. running     后台运行中（本 tab isSending / runState=running / swarm 协作中）
 *   3. unread_done 刚完成未读（非错误终态且未读）
 */
import {
  type SessionNeedsYouKind,
  isSidebarSessionRunning,
  resolveSidebarDot,
} from "../../lib/sessionStatus";
import type { ChatProject, Session } from "../../lib/types";
import { compareByUpdatedDesc } from "./runningOrder";

export type LiveActivityBucket = "needs_you" | "running" | "unread_done";
export type LiveActivityFilter = "all" | LiveActivityBucket;

export const LIVE_ACTIVITY_BUCKETS: readonly LiveActivityBucket[] = [
  "needs_you",
  "running",
  "unread_done",
];

export const LIVE_BUCKET_META: Record<
  LiveActivityBucket,
  {
    label: string;
    shortLabel: string;
    filterAriaLabel: string;
  }
> = {
  needs_you: {
    label: "待我拍板",
    shortLabel: "待拍板",
    filterAriaLabel: "筛选待我拍板会话",
  },
  running: {
    label: "后台运行中",
    shortLabel: "运行中",
    filterAriaLabel: "筛选后台运行中会话",
  },
  unread_done: {
    label: "刚完成未读",
    shortLabel: "未读",
    filterAriaLabel: "筛选刚完成未读会话",
  },
};

export type LiveActivityItem = {
  session: Session;
  bucket: LiveActivityBucket;
  /** 仅 needs_you 桶携带，区分权限/方案拍板（approval）与普通问答（answer）。 */
  needsYouKind?: SessionNeedsYouKind;
  /** 是否处于多代理/蜂群协作运行态。 */
  isSwarm?: boolean;
  /** 所属项目名（存在且已知时），便于紧凑条目快速辨认上下文。 */
  projectName: string | null;
};

export type LiveActivityCounts = {
  all: number;
  needs_you: number;
  running: number;
  unread_done: number;
};

export type LiveActivitySummary = {
  items: LiveActivityItem[];
  byBucket: Record<LiveActivityBucket, LiveActivityItem[]>;
  counts: LiveActivityCounts;
  total: number;
};

export type CollectLiveActivityInput = {
  sessions: readonly Session[];
  projects?: readonly Pick<ChatProject, "id" | "name">[];
  isSending?: (id: string) => boolean;
  liveTerminal?: (
    id: string,
  ) => { lastOutcome?: string | null; lastErrorCode?: string | null } | undefined;
  sessionNeedsYou?: (id: string) => SessionNeedsYouKind | null | undefined;
  unreadIds?: ReadonlySet<string>;
  swarmSessionIds?: ReadonlySet<string>;
  /** 是否纳入「刚完成未读」桶；侧栏活态区传 false，避免历史未读列表刷屏挤占侧栏。 */
  includeUnread?: boolean;
};

function compareNeedsYouItems(a: LiveActivityItem, b: LiveActivityItem): number {
  const aApproval = a.needsYouKind === "approval" ? 0 : 1;
  const bApproval = b.needsYouKind === "approval" ? 0 : 1;
  if (aApproval !== bApproval) return aApproval - bApproval;
  return compareByUpdatedDesc(a.session, b.session);
}

function compareBucketItems(a: LiveActivityItem, b: LiveActivityItem): number {
  return compareByUpdatedDesc(a.session, b.session);
}

/** 供条目角标与读屏文案使用的精确状态词。 */
export function liveActivityItemLabel(item: Pick<LiveActivityItem, "bucket" | "needsYouKind" | "isSwarm">): string {
  if (item.bucket === "needs_you") {
    return item.needsYouKind === "approval" ? "待拍板" : "待回复";
  }
  if (item.bucket === "running") {
    return item.isSwarm ? "协作中" : "运行中";
  }
  return "已完成";
}

/** 聚合三类活态会话并给出稳定排序与精确计数。 */
export function collectLiveActivity(input: CollectLiveActivityInput): LiveActivitySummary {
  const projectById = new Map<string, string>();
  for (const p of input.projects ?? []) {
    if (p.id && p.name) projectById.set(p.id, p.name);
  }

  const byBucket: Record<LiveActivityBucket, LiveActivityItem[]> = {
    needs_you: [],
    running: [],
    unread_done: [],
  };

  for (const s of input.sessions) {
    if (s.archived) continue;
    const projectName = s.projectId ? (projectById.get(s.projectId) ?? null) : null;
    const needsYou = input.sessionNeedsYou?.(s.id) ?? null;
    const isSwarm = Boolean(input.swarmSessionIds?.has(s.id));
    const running = isSwarm || isSidebarSessionRunning(s, {
      isSending: input.isSending,
      liveTerminal: input.liveTerminal,
    });

    if (needsYou) {
      byBucket.needs_you.push({
        session: s,
        bucket: "needs_you",
        needsYouKind: needsYou,
        isSwarm: isSwarm || undefined,
        projectName,
      });
      continue;
    }

    if (running) {
      byBucket.running.push({
        session: s,
        bucket: "running",
        isSwarm: isSwarm || undefined,
        projectName,
      });
      continue;
    }

    if (input.includeUnread === false) continue;

    const unread = input.unreadIds !== undefined ? input.unreadIds.has(s.id) : Boolean(s.unread);
    if (!unread) continue;

    const live = input.liveTerminal?.(s.id);
    const dot = resolveSidebarDot(
      {
        running: false,
        lastOutcome: live?.lastOutcome ?? s.lastOutcome,
        lastErrorCode: live?.lastErrorCode ?? s.lastErrorCode,
        needsYou: null,
      },
      true,
    );
    if (dot === "unread") {
      byBucket.unread_done.push({
        session: s,
        bucket: "unread_done",
        projectName,
      });
    }
  }

  byBucket.needs_you.sort(compareNeedsYouItems);
  byBucket.running.sort(compareBucketItems);
  byBucket.unread_done.sort(compareBucketItems);

  const items = [
    ...byBucket.needs_you,
    ...byBucket.running,
    ...byBucket.unread_done,
  ];

  const counts: LiveActivityCounts = {
    all: items.length,
    needs_you: byBucket.needs_you.length,
    running: byBucket.running.length,
    unread_done: byBucket.unread_done.length,
  };

  return {
    items,
    byBucket,
    counts,
    total: items.length,
  };
}

/** 若当前选中的筛选桶已经清空（例如所有待拍板都已处理），自动回落到 all，避免出现假空态。 */
export function resolveEffectiveLiveFilter(
  summary: LiveActivitySummary,
  requested: LiveActivityFilter,
): LiveActivityFilter {
  if (requested === "all") return "all";
  return summary.counts[requested] > 0 ? requested : "all";
}

/** 按当前筛选条件返回排序后的活态条目列表。 */
export function filterLiveActivityItems(
  summary: LiveActivitySummary,
  filter: LiveActivityFilter,
): LiveActivityItem[] {
  const effective = resolveEffectiveLiveFilter(summary, filter);
  return effective === "all" ? summary.items : summary.byBucket[effective];
}
