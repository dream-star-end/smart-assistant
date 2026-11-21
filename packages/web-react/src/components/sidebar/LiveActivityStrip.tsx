import { Bell, BellOff, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  getDesktopNotifyState,
  requestDesktopNotifyToggle,
  subscribeDesktopNotifyState,
} from "../../lib/desktopNotifyPref";
import type { AuthSession } from "../../lib/types";
import { StatusPill } from "../ui";
import { PendingDecisionsDock } from "./PendingDecisionsDock";
import {
  type CollectLiveActivityInput,
  LIVE_ACTIVITY_BUCKETS,
  LIVE_BUCKET_META,
  type LiveActivityBucket,
  type LiveActivityFilter,
  type LiveActivitySummary,
  collectLiveActivity,
  filterLiveActivityItems,
  liveActivityItemLabel,
  resolveEffectiveLiveFilter,
} from "./liveActivity";
import "./liveActivity.css";

const DEFAULT_VISIBLE_LIMIT = 3;

export type LiveActivityStripProps = {
  summary: LiveActivitySummary;
  activeId?: string;
  onSelect: (sessionId: string) => void;
  onMarkRead?: (sessionId: string) => void;
  /** 仅用于测试或外部控制初始折叠态；默认展开直达列表。 */
  defaultCollapsed?: boolean;
};

function bucketIndicator(bucket: LiveActivityBucket) {
  if (bucket === "needs_you") {
    return <StatusPill status="needs_you" variant="dot" size="sm" mark="question" decorative />;
  }
  if (bucket === "running") {
    return <StatusPill status="running" variant="dot" size="sm" mark="ring" decorative />;
  }
  return <StatusPill status="done" variant="dot" size="sm" decorative />;
}

/**
 * 侧栏顶部活态指挥区：
 * - 无活态会话时静默折叠零占位（return null）；
 * - 有活态项时按 待拍板 > 运行中 > 刚完成未读 展示紧凑状态胶囊与一键直达条目；
 * - 独立于 sidebar-primary，不侵入教程入口 scope；
 * - 移动端/触屏下自动提升至 ≥44px 触控目标。
 */
export function LiveActivityStrip({
  summary,
  activeId,
  onSelect,
  onMarkRead,
  defaultCollapsed = false,
}: LiveActivityStripProps) {
  const [requestedFilter, setRequestedFilter] = useState<LiveActivityFilter>("all");
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(
    defaultCollapsed ? true : null,
  );
  const [showAll, setShowAll] = useState(false);
  const notifyState = useSyncExternalStore(
    subscribeDesktopNotifyState,
    getDesktopNotifyState,
    getDesktopNotifyState,
  );
  const notifyActive = notifyState.enabled && notifyState.permission === "granted";
  const notifyDenied = notifyState.permission === "denied";

  if (summary.total === 0) return null;

  // 仅有 1 条运行中会话且正好是当前正在查看的会话时，默认收起明细行，
  // 避免与下方项目第一行同屏重复呈现两张完全一样的活跃条；点展开或切到其它会话即恢复直达行。
  const onlyActiveRunning =
    summary.total === 1 &&
    summary.items[0]?.bucket === "running" &&
    Boolean(activeId) &&
    summary.items[0]?.session.id === activeId;
  const collapsed = collapseOverride ?? onlyActiveRunning;

  const activeFilter = resolveEffectiveLiveFilter(summary, requestedFilter);
  const items = filterLiveActivityItems(summary, activeFilter);
  const visibleItems = showAll ? items : items.slice(0, DEFAULT_VISIBLE_LIMIT);
  const hiddenCount = items.length - visibleItems.length;
  const nonEmptyBuckets = LIVE_ACTIVITY_BUCKETS.filter((b) => summary.counts[b] > 0);

  const toggleBucket = (bucket: LiveActivityBucket) => {
    setRequestedFilter((cur) => {
      const effective = resolveEffectiveLiveFilter(summary, cur);
      return effective === bucket ? "all" : bucket;
    });
    setCollapseOverride(false);
    setShowAll(false);
  };

  return (
    <section
      aria-label="活态指挥区"
      data-testid="sidebar-live-strip"
      data-has-attention={summary.counts.needs_you > 0 ? "true" : undefined}
      data-compact-active={onlyActiveRunning && collapsed ? "true" : undefined}
      className="oc-live-strip"
    >
      <div className="oc-live-strip-head">
        <div role="group" aria-label="活态状态筛选" className="oc-live-strip-pills">
          {nonEmptyBuckets.map((bucket) => {
            const meta = LIVE_BUCKET_META[bucket];
            const pressed = activeFilter === bucket;
            return (
              <button
                key={bucket}
                type="button"
                data-bucket={bucket}
                data-testid={`live-strip-filter-${bucket}`}
                aria-pressed={pressed}
                aria-label={`${meta.filterAriaLabel}（${summary.counts[bucket]}）`}
                title={pressed ? "再次点击显示全部活态会话" : meta.label}
                onClick={() => toggleBucket(bucket)}
                className="oc-live-strip-pill"
              >
                {bucketIndicator(bucket)}
                <span>{meta.shortLabel}</span>
                <span className="oc-live-strip-pill-count">{summary.counts[bucket]}</span>
              </button>
            );
          })}
        </div>
        {notifyState.permission !== "unsupported" && (
          <button
            type="button"
            data-testid="live-strip-notify-toggle"
            data-enabled={notifyActive ? "true" : undefined}
            aria-pressed={notifyActive}
            disabled={notifyDenied}
            aria-label={
              notifyDenied
                ? "桌面通知已被浏览器阻止"
                : notifyActive
                  ? "关闭桌面通知"
                  : "开启桌面通知"
            }
            title={
              notifyDenied
                ? "浏览器已阻止桌面通知，请在站点设置中允许"
                : notifyActive
                  ? "已开启桌面通知（点击关闭）"
                  : "开启桌面通知：待拍板或后台任务完成时提醒"
            }
            onClick={() => {
              void requestDesktopNotifyToggle(!notifyState.enabled);
            }}
            className="oc-live-strip-toggle oc-live-strip-notify"
          >
            {notifyActive ? <Bell size={13} strokeWidth={1.75} aria-hidden /> : <BellOff size={13} strokeWidth={1.75} aria-hidden />}
          </button>
        )}
        <button
          type="button"
          data-testid="live-strip-collapse-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `展开活态列表（${summary.total}）` : "收起活态列表"}
          title={collapsed ? "展开活态列表" : "收起活态列表"}
          onClick={() => setCollapseOverride(!collapsed)}
          className="oc-live-strip-toggle"
        >
          {collapsed ? <ChevronRight size={14} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={14} strokeWidth={1.75} aria-hidden />}
        </button>
      </div>

      {!collapsed && (
        <div className="oc-live-strip-list" data-testid="live-strip-list">
          {visibleItems.map((item) => {
            const title = item.session.title || "新对话";
            const statusLabel = liveActivityItemLabel(item);
            const isActive = item.session.id === activeId;
            return (
              <button
                key={item.session.id}
                type="button"
                data-live-session-id={item.session.id}
                data-live-bucket={item.bucket}
                data-active={isActive ? "true" : undefined}
                aria-label={`${statusLabel} · ${title}`}
                onClick={() => {
                  if (item.bucket === "unread_done") onMarkRead?.(item.session.id);
                  onSelect(item.session.id);
                }}
                className="oc-live-strip-item"
              >
                <span className="oc-live-strip-item-lead" aria-hidden>
                  {bucketIndicator(item.bucket)}
                </span>
                <span className="oc-live-strip-item-title">{title}</span>
                <span data-bucket={item.bucket} className="oc-live-strip-item-tag">
                  {statusLabel}
                </span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              data-testid="live-strip-show-more"
              onClick={() => setShowAll(true)}
              className="oc-live-strip-more"
            >
              展开其余 {hiddenCount} 条活态会话
            </button>
          )}
          {showAll && items.length > DEFAULT_VISIBLE_LIMIT && (
            <button
              type="button"
              data-testid="live-strip-show-less"
              onClick={() => setShowAll(false)}
              className="oc-live-strip-more"
            >
              收起部分活态会话
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 供 Sidebar 按需懒加载使用的封装：将 `collectLiveActivity` 聚合逻辑连同 UI 与 CSS
 * 全部留在懒块内，不进入首屏 `modulepreload` 闭包。
 */
export function SidebarLiveActivityStrip({
  sessions,
  projects,
  isSending,
  liveTerminal,
  sessionNeedsYou,
  unreadIds,
  swarmSessionIds,
  socketVersion,
  activeId,
  auth,
  onSelect,
  onMarkRead,
  onOpenBoard,
  onOpenLiveBrowser,
}: CollectLiveActivityInput & {
  socketVersion?: number;
  activeId?: string;
  auth?: AuthSession | null;
  onSelect: (sessionId: string) => void;
  onMarkRead?: (sessionId: string) => void;
  onOpenBoard?: (ticketRef?: string) => void;
  onOpenLiveBrowser?: (opts?: { url?: string; sessionId?: string | null }) => void;
}) {
  const summary = useMemo(() => {
    void socketVersion;
    return collectLiveActivity({
      sessions,
      projects,
      isSending,
      liveTerminal,
      sessionNeedsYou,
      unreadIds,
      swarmSessionIds,
      includeUnread: false,
    });
  }, [
    sessions,
    projects,
    isSending,
    liveTerminal,
    sessionNeedsYou,
    unreadIds,
    swarmSessionIds,
    socketVersion,
  ]);

  return (
    <>
      {auth && (
        <PendingDecisionsDock
          auth={auth}
          socketVersion={socketVersion}
          onSelectSession={onSelect}
          onOpenBoard={onOpenBoard}
          onOpenLiveBrowser={onOpenLiveBrowser}
        />
      )}
      <LiveActivityStrip
        summary={summary}
        activeId={activeId}
        onSelect={onSelect}
        onMarkRead={onMarkRead}
      />
    </>
  );
}
