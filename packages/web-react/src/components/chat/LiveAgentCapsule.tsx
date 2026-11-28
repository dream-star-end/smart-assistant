import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  Image as ImageIcon,
  ListChecks,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTerminalDelegateState, type InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../lib/chat/model";
import {
  firstLinePreview,
  formatCompactElapsed,
  formatCountdown,
  isTerminalMediaJobStatus,
  isTerminalMuseJobStatus,
  type SessionBgCommandItem,
  type SessionCronItem,
  type SessionMuseJobItem,
} from "../../lib/chat/sessionBackgroundTasks";
import { AtelierIcon } from "../ui/AtelierIcons";
import {
  PinnedDelegateTrackerLazy,
  PinnedSwarmDock,
  PinnedTaskTrackerLazy,
} from "./lazyTimelineCards";
import {
  AUTO_DISMISS_SUCCEEDED_MS,
  PinnedBackgroundTasksPanel,
  summarizeBgCommand,
} from "./PinnedBackgroundTasksPanel";
import { SwarmElapsedTicker } from "./SwarmElapsedTicker";
import type { SwarmOpenRequest } from "./swarmDetect";
import { detectSwarmAlerts, formatSwarmCapsuleDetail, isSwarmActive } from "./swarmUtils";
import type { TodoItem } from "./todoExtract";
import "./liveActivity.css";

export type HudKind = "swarm" | "delegate" | "media" | "bg_cmd" | "schedule" | "task";

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export type LiveAgentCapsuleProps = {
  timelineMessages?: ChatMessage[];
  todos: TodoItem[];
  settled: boolean;
  wsSending: boolean;
  tokenUsage?: LiveTurnTokenUsageSnapshot;
  delegateItems: InflightDelegateItem[];
  onDismissDelegate: (id: string) => void;
  onCancelDelegate?: (jobId: string) => Promise<boolean>;
  onStopTurn?: () => void;
  latestSwarm: SwarmSnapshot | null;
  latestSwarmCardId?: string;
  latestSwarmBlockId?: string;
  latestSwarmKey?: string | null;
  dismissedSwarmKey?: string | null;
  onOpenSwarmBoard: (req: SwarmOpenRequest) => void;
  onDismissSwarm?: (key: string) => void;
  museJobs?: SessionMuseJobItem[];
  mediaJobs?: MediaGenerationJob[];
  bgCommands?: SessionBgCommandItem[];
  sessionCrons?: SessionCronItem[];
  onCancelMuseJob?: (jobId: string) => Promise<boolean>;
  onDismissMuseJob?: (jobId: string) => void;
  onCancelMediaJob?: (jobId: string) => Promise<boolean>;
  onCancelBgCommand?: (entryId: string) => Promise<boolean>;
  onToggleSessionCron?: (cronId: string, enabled: boolean) => Promise<boolean>;
  onDeleteSessionCron?: (cronId: string) => Promise<boolean>;
};

export default function LiveAgentCapsule({
  timelineMessages,
  todos,
  settled,
  wsSending,
  tokenUsage,
  delegateItems,
  onDismissDelegate,
  onCancelDelegate,
  onStopTurn,
  latestSwarm,
  latestSwarmCardId,
  latestSwarmBlockId,
  latestSwarmKey,
  dismissedSwarmKey,
  onOpenSwarmBoard,
  onDismissSwarm,
  museJobs = [],
  mediaJobs = [],
  bgCommands = [],
  sessionCrons = [],
  onCancelMuseJob,
  onDismissMuseJob,
  onCancelMediaJob,
  onCancelBgCommand,
  onToggleSessionCron,
  onDeleteSessionCron,
}: LiveAgentCapsuleProps) {
  void timelineMessages;
  void tokenUsage;
  void latestSwarmKey;
  void dismissedSwarmKey;
  void onDismissSwarm;
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [autoHiddenDelegates, setAutoHiddenDelegates] = useState<ReadonlySet<string>>(() => new Set());
  const [autoHiddenMedia, setAutoHiddenMedia] = useState<ReadonlySet<string>>(() => new Set());
  const delegateStartRef = useRef(new Map<string, number>());
  const delegateAutoTimersRef = useRef(new Map<string, number>());
  const mediaAutoTimersRef = useRef(new Map<string, number>());
  const onDismissDelegateRef = useRef(onDismissDelegate);
  onDismissDelegateRef.current = onDismissDelegate;
  const onDismissMuseJobRef = useRef(onDismissMuseJob);
  onDismissMuseJobRef.current = onDismissMuseJob;

  // 成功终态自动短暂展示后静默隐藏，不再强迫用户点「知道了」
  useEffect(() => {
    const timers = delegateAutoTimersRef.current;
    const succeededIds = new Set<string>();
    for (const item of delegateItems) {
      if (item.state === "completed") succeededIds.add(item.jobId);
    }
    for (const [id, timer] of timers) {
      if (!succeededIds.has(id)) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    }
    for (const id of succeededIds) {
      if (autoHiddenDelegates.has(id) || timers.has(id)) continue;
      const timer = window.setTimeout(() => {
        timers.delete(id);
        setAutoHiddenDelegates((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        onDismissDelegateRef.current(id);
      }, AUTO_DISMISS_SUCCEEDED_MS);
      timers.set(id, timer);
    }
  }, [delegateItems, autoHiddenDelegates]);

  useEffect(() => {
    const timers = mediaAutoTimersRef.current;
    const succeededIds = new Set<string>();
    for (const job of museJobs) {
      if (job.status === "succeeded") succeededIds.add(job.id);
    }
    for (const job of mediaJobs) {
      if (job.status === "completed") succeededIds.add(job.id);
    }
    for (const [id, timer] of timers) {
      if (!succeededIds.has(id)) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    }
    for (const id of succeededIds) {
      if (autoHiddenMedia.has(id) || timers.has(id)) continue;
      const timer = window.setTimeout(() => {
        timers.delete(id);
        setAutoHiddenMedia((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        onDismissMuseJobRef.current?.(id);
      }, AUTO_DISMISS_SUCCEEDED_MS);
      timers.set(id, timer);
    }
  }, [museJobs, mediaJobs, autoHiddenMedia]);

  useEffect(
    () => () => {
      for (const timer of delegateAutoTimersRef.current.values()) window.clearTimeout(timer);
      delegateAutoTimersRef.current.clear();
      for (const timer of mediaAutoTimersRef.current.values()) window.clearTimeout(timer);
      mediaAutoTimersRef.current.clear();
    },
    [],
  );

  const visibleDelegates = useMemo(
    () => delegateItems.filter((item) => !(item.state === "completed" && autoHiddenDelegates.has(item.jobId))),
    [delegateItems, autoHiddenDelegates],
  );
  const visibleMuseJobs = useMemo(
    () => museJobs.filter((j) => !(j.status === "succeeded" && autoHiddenMedia.has(j.id))),
    [museJobs, autoHiddenMedia],
  );
  const visibleMediaJobs = useMemo(
    () => mediaJobs.filter((j) => !(j.status === "completed" && autoHiddenMedia.has(j.id))),
    [mediaJobs, autoHiddenMedia],
  );
  // 当前回合正在执行时不重复弹出后台命令胶囊，仅对脱离当前回合的独立/残留后台任务展示
  const visibleBgCommands = wsSending ? [] : bgCommands;
  // OCV5-858: 过滤已完成且已停用的一次性续跑 cron，避免已完成的一次性定时任务残留为「定时已暂停」。
  const visibleSessionCrons = useMemo(
    () =>
      sessionCrons.filter((c) => {
        const hasRun = typeof c.lastRunAt === "number" && Number.isFinite(c.lastRunAt) && c.lastRunAt > 0;
        const nextAfterLast =
          typeof c.nextRunAt === "number" &&
          Number.isFinite(c.nextRunAt) &&
          (!hasRun || c.nextRunAt > (c.lastRunAt as number));
        return !(c.oneshot && !c.enabled && hasRun && !nextAfterLast);
      }),
    [sessionCrons],
  );

  const swarmActive = latestSwarm ? isSwarmActive(latestSwarm.phase) : false;
  const hasSwarm = swarmActive;
  const hasDelegate = visibleDelegates.length > 0;
  const hasMedia = visibleMuseJobs.length > 0 || visibleMediaJobs.length > 0;
  const hasBgCmd = visibleBgCommands.length > 0;
  const hasSchedule = visibleSessionCrons.length > 0;
  const hasIncompleteTodo = todos.some((t) => t.status !== "completed");
  const hasTask = hasIncompleteTodo && (!settled || wsSending);

  const runningDelegates = useMemo(
    () => visibleDelegates.filter((item) => item.state === "running"),
    [visibleDelegates],
  );
  const liveDelegates = useMemo(
    () => visibleDelegates.filter((item) => !isTerminalDelegateState(item.state)),
    [visibleDelegates],
  );
  const primaryDelegate = useMemo(() => {
    const pool =
      runningDelegates.length > 0
        ? runningDelegates
        : liveDelegates.length > 0
          ? liveDelegates
          : visibleDelegates;
    return pool.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [visibleDelegates, liveDelegates, runningDelegates]);

  const activeMuseJobs = useMemo(
    () => visibleMuseJobs.filter((j) => !isTerminalMuseJobStatus(j.status)),
    [visibleMuseJobs],
  );
  const activeMediaJobs = useMemo(
    () => visibleMediaJobs.filter((j) => !isTerminalMediaJobStatus(j.status)),
    [visibleMediaJobs],
  );
  const mediaActiveCount = activeMuseJobs.length + activeMediaJobs.length;
  const mediaTotalCount = visibleMuseJobs.length + visibleMediaJobs.length;
  const mediaRunning = mediaActiveCount > 0;

  const primaryBgCmd = visibleBgCommands[0] ?? null;
  const enabledCrons = useMemo(
    () => visibleSessionCrons.filter((c) => c.enabled),
    [visibleSessionCrons],
  );
  const primaryCron = enabledCrons[0] ?? visibleSessionCrons[0] ?? null;

  // 活跃运行态优先于待触发定时/已终态提示，保持单行胶囊只聚焦此刻最关键的运行态
  const activeOrder: HudKind[] = [];
  if (hasSwarm) activeOrder.push("swarm");
  if (hasDelegate && liveDelegates.length > 0) activeOrder.push("delegate");
  if (hasMedia && mediaRunning) activeOrder.push("media");
  if (hasBgCmd) activeOrder.push("bg_cmd");
  if (hasTask) activeOrder.push("task");
  if (hasDelegate && liveDelegates.length === 0) activeOrder.push("delegate");
  if (hasMedia && !mediaRunning) activeOrder.push("media");
  if (hasSchedule) activeOrder.push("schedule");

  useEffect(() => {
    const seen = Date.now();
    const ids = new Set(visibleDelegates.map((item) => item.jobId));
    for (const id of delegateStartRef.current.keys()) {
      if (!ids.has(id)) delegateStartRef.current.delete(id);
    }
    for (const item of visibleDelegates) {
      if (isTerminalDelegateState(item.state)) continue;
      if (!delegateStartRef.current.has(item.jobId)) {
        const anchor = item.updatedAt > 0 ? Math.min(seen, item.updatedAt) : seen;
        delegateStartRef.current.set(item.jobId, anchor);
      }
    }
  }, [visibleDelegates]);

  // Swarm elapsed time is isolated inside <SwarmElapsedTicker />, so LiveAgentCapsule
  // does not trigger parent 1s re-renders when only a swarm is running.
  const fastTimerRunning =
    runningDelegates.length > 0 || mediaRunning || hasBgCmd;
  useEffect(() => {
    if (!fastTimerRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [fastTimerRunning]);

  const slowCountdownRunning = !fastTimerRunning && enabledCrons.length > 0;
  useEffect(() => {
    if (!slowCountdownRunning) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [slowCountdownRunning, visibleSessionCrons]);

  useEffect(() => {
    if (activeOrder.length === 0 && expanded) setExpanded(false);
  }, [activeOrder.length, expanded]);

  if (activeOrder.length === 0) return null;

  const primaryKind = activeOrder[0]!;
  const extraCount = activeOrder.length - 1;

  let isRunning = false;
  let label = "";
  let detail = "";
  let timer = "";
  let primaryMediaIsImage = false;

  const swarmAlerts = primaryKind === "swarm" && latestSwarm ? detectSwarmAlerts(latestSwarm) : null;

  if (primaryKind === "swarm" && latestSwarm) {
    isRunning = swarmActive;
    label = latestSwarm.title || "蜂群协作";
    detail = formatSwarmCapsuleDetail(latestSwarm);
    timer = "";
  } else if (primaryKind === "delegate" && primaryDelegate) {
    const liveCount = liveDelegates.length;
    isRunning = runningDelegates.length > 0;
    label = liveCount > 0 ? `后台 ${liveCount} 进行中` : `后台 ${visibleDelegates.length} 已结束`;
    detail = firstLinePreview(primaryDelegate.goal) || primaryDelegate.goal;
    if (isRunning) {
      const start = delegateStartRef.current.get(primaryDelegate.jobId) ?? now;
      timer = formatCompactElapsed(now - start);
    }
  } else if (primaryKind === "media") {
    isRunning = mediaRunning;
    const primaryMuse = activeMuseJobs[0] ?? visibleMuseJobs[0] ?? null;
    const primaryMedia = activeMediaJobs[0] ?? visibleMediaJobs[0] ?? null;
    if (primaryMuse && (activeMuseJobs.length > 0 || activeMediaJobs.length === 0)) {
      primaryMediaIsImage = primaryMuse.kind === "image";
      const kindWord = primaryMuse.kind === "image" ? "图片" : "视频";
      if (mediaActiveCount > 1) {
        label = `媒体 ${mediaActiveCount} 进行中`;
      } else if (primaryMuse.status === "queued") {
        label = primaryMuse.queuePosition ? `排队第 ${primaryMuse.queuePosition} 位` : `${kindWord}排队中`;
      } else if (primaryMuse.status === "running") {
        label = `${kindWord}生成中`;
      } else if (primaryMuse.status === "succeeded") {
        label = `${kindWord}已完成`;
      } else if (primaryMuse.status === "failed") {
        label = `${kindWord}生成失败`;
      } else {
        label = mediaTotalCount > 1 ? `媒体 ${mediaTotalCount} 项` : `${kindWord}已取消`;
      }
      detail = firstLinePreview(primaryMuse.promptPreview) || `${kindWord}任务`;
      const anchor = primaryMuse.startedAt ?? primaryMuse.queuedAt;
      if (mediaRunning && anchor > 0) {
        timer = formatCompactElapsed(Math.max(0, now - anchor));
      }
    } else if (primaryMedia) {
      const kindWord = primaryMedia.kind === "video_compose" ? "视频合成" : "视频";
      if (mediaActiveCount > 1) {
        label = `媒体 ${mediaActiveCount} 进行中`;
      } else if (primaryMedia.status === "queued" || primaryMedia.status === "dispatching") {
        label = primaryMedia.queuePosition ? `排队第 ${primaryMedia.queuePosition} 位` : `${kindWord}排队中`;
      } else if (primaryMedia.status === "running" || primaryMedia.status === "reconnecting") {
        label = `${kindWord}生成中`;
      } else if (primaryMedia.status === "completed") {
        label = `${kindWord}已完成`;
      } else if (primaryMedia.status === "failed") {
        label = `${kindWord}生成失败`;
      } else {
        label = `${kindWord}已取消`;
      }
      detail = firstLinePreview(primaryMedia.prompt ?? "") || `${kindWord}任务`;
      const createdMs = parseIsoMs(primaryMedia.createdAt);
      if (mediaRunning && createdMs > 0) {
        timer = formatCompactElapsed(Math.max(0, now - createdMs));
      }
    }
  } else if (primaryKind === "bg_cmd" && primaryBgCmd) {
    isRunning = true;
    label = visibleBgCommands.length > 1 ? `后台任务 ${visibleBgCommands.length}` : "后台任务运行中";
    detail = summarizeBgCommand(primaryBgCmd);
    if (primaryBgCmd.startedAt > 0) {
      timer = formatCompactElapsed(Math.max(0, now - primaryBgCmd.startedAt));
    }
  } else if (primaryKind === "schedule" && primaryCron) {
    isRunning = false;
    label =
      enabledCrons.length > 1
        ? `定时续跑 ${enabledCrons.length}`
        : enabledCrons.length === 1
          ? "定时续跑"
          : "定时已暂停";
    detail = primaryCron.name;
    timer = primaryCron.enabled ? formatCountdown(primaryCron.nextRunAt, now) : "已暂停";
  } else if (primaryKind === "task") {
    const done = todos.filter((t) => t.status === "completed").length;
    const activeTodo =
      todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed") ?? null;
    isRunning = wsSending || activeTodo?.status === "in_progress";
    label = `任务 ${done}/${todos.length}`;
    detail = activeTodo
      ? activeTodo.status === "in_progress" && activeTodo.activeForm
        ? activeTodo.activeForm
        : activeTodo.content
      : "";
  }

  const hasBackgroundPanel = hasMedia || hasBgCmd || hasSchedule;

  const renderPrimaryIcon = () => {
    switch (primaryKind) {
      case "swarm":
        return <AtelierIcon name="swarm" size={12} className="oc-live-capsule-icon" />;
      case "delegate":
        return <AtelierIcon name="agent" size={12} className="oc-live-capsule-icon" />;
      case "bg_cmd":
        return <AtelierIcon name="terminal" size={12} className="oc-live-capsule-icon" />;
      case "media":
        return primaryMediaIsImage ? (
          <ImageIcon size={11} strokeWidth={1.85} aria-hidden className="oc-live-capsule-icon" />
        ) : (
          <Film size={11} strokeWidth={1.85} aria-hidden className="oc-live-capsule-icon" />
        );
      case "schedule":
        return <Clock size={11} strokeWidth={1.85} aria-hidden className="oc-live-capsule-icon" />;
      case "task":
        return <ListChecks size={11} strokeWidth={1.85} aria-hidden className="oc-live-capsule-icon" />;
    }
  };

  return (
    <div data-testid="pinned-hud-stack">
      {expanded && (
        <div className="oc-live-expanded-stack" data-testid="live-agent-expanded">
          {hasTask && (
            <PinnedTaskTrackerLazy
              todos={todos}
              active={wsSending}
              settled={settled}
            />
          )}
          {hasBackgroundPanel && (
            <PinnedBackgroundTasksPanel
              museJobs={visibleMuseJobs}
              mediaJobs={visibleMediaJobs}
              bgCommands={visibleBgCommands}
              sessionCrons={visibleSessionCrons}
              now={now}
              autoDismissSucceeded={false}
              onCancelMuseJob={onCancelMuseJob}
              onDismissMuseJob={onDismissMuseJob}
              onCancelMediaJob={onCancelMediaJob}
              onCancelBgCommand={onCancelBgCommand}
              onToggleSessionCron={onToggleSessionCron}
              onDeleteSessionCron={onDeleteSessionCron}
            />
          )}
          {hasDelegate && (
            <PinnedDelegateTrackerLazy
              items={visibleDelegates}
              autoDismissSucceeded={false}
              onDismiss={onDismissDelegate}
              onCancel={onCancelDelegate}
              onStop={onStopTurn}
            />
          )}
          {hasSwarm && latestSwarm && (
            <PinnedSwarmDock
              snapshot={latestSwarm}
              cardId={latestSwarmCardId}
              blockId={latestSwarmBlockId}
              onOpenBoard={onOpenSwarmBoard}
            />
          )}
        </div>
      )}

      <div className="oc-live-capsule-wrap">
        <div
          className="oc-live-capsule flex min-w-0 max-w-full items-center gap-2 overflow-hidden"
          data-testid="live-agent-capsule"
          data-primary-kind={primaryKind}
          data-running={isRunning ? "true" : "false"}
        >
          <button
            type="button"
            data-testid="live-agent-capsule-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? `收起运行状态：${label}` : `展开运行状态：${label}`}
            onClick={() => setExpanded((v) => !v)}
            className="oc-live-capsule-main oc-spring-press min-w-0 flex-1 overflow-hidden"
          >
            <span
              className="oc-icon-badge oc-icon-badge-accent flex size-5 shrink-0 items-center justify-center rounded-full"
            >
              {renderPrimaryIcon()}
            </span>
            <span
              title={label}
              className={
                primaryKind === "swarm"
                  ? "oc-live-capsule-label min-w-0 flex-1 truncate"
                  : "oc-live-capsule-label max-w-36 shrink-0 truncate"
              }
            >
              {label}
            </span>
            {detail && (
              <span
                title={detail}
                className={
                  primaryKind === "swarm"
                    ? "oc-live-capsule-detail hidden max-w-44 shrink-0 truncate sm:inline"
                    : "oc-live-capsule-detail min-w-0 flex-1 truncate"
                }
              >
                {detail}
              </span>
            )}
            {primaryKind === "swarm" && latestSwarm ? (
              <SwarmElapsedTicker
                startedAt={latestSwarm.startedAt}
                active={swarmActive}
                data-testid="live-agent-capsule-timer"
                className="oc-live-capsule-timer shrink-0"
              />
            ) : timer ? (
              <span data-testid="live-agent-capsule-timer" className="oc-live-capsule-timer shrink-0">
                {timer}
              </span>
            ) : null}
            {extraCount > 0 && (
              <span data-testid="live-agent-capsule-more" className="oc-live-capsule-more shrink-0">
                +{extraCount}
              </span>
            )}
            {expanded ? (
              <ChevronDown size={14} aria-hidden className="shrink-0 text-faint" />
            ) : (
              <ChevronUp size={14} aria-hidden className="shrink-0 text-faint" />
            )}
          </button>

          {primaryKind === "swarm" && latestSwarm && swarmAlerts?.hasAlert && (
            <button
              type="button"
              data-testid="live-agent-capsule-swarm-alert"
              title={swarmAlerts.summary}
              onClick={() =>
                onOpenSwarmBoard({
                  snapshot: latestSwarm,
                  cardId: latestSwarmCardId,
                  blockId: latestSwarmBlockId,
                  focusMember: swarmAlerts.primaryFocusMember,
                  focusSeq: swarmAlerts.primaryFocusSeq,
                })
              }
              className={
                swarmAlerts.failedMembers.length > 0
                  ? "oc-spring-press inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-soft px-2 py-1 text-caption font-semibold text-danger transition-colors hover:bg-danger/20 [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
                  : "oc-spring-press inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-caption font-semibold text-warning transition-colors hover:bg-warning/20 [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
              }
            >
              <AlertTriangle size={11} aria-hidden className="shrink-0" />
              <span className="max-w-28 truncate">
                {swarmAlerts.failedMembers.length > 0
                  ? `${swarmAlerts.failedMembers.length} 异常`
                  : "停滞预警"}
              </span>
            </button>
          )}

          {primaryKind === "swarm" && latestSwarm && (
            <button
              type="button"
              data-testid="live-agent-capsule-action"
              onClick={() =>
                onOpenSwarmBoard({
                  snapshot: latestSwarm,
                  cardId: latestSwarmCardId,
                  blockId: latestSwarmBlockId,
                })
              }
              className="oc-live-capsule-action oc-spring-press shrink-0"
            >
              <span>看板</span>
              <ArrowUpRight size={11} aria-hidden className="shrink-0" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
