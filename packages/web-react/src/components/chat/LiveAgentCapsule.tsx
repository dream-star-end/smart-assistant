import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  Image as ImageIcon,
  ListChecks,
  Target,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTerminalDelegateState, type InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../lib/chat/model";
import { formatDurationSeconds } from "../../lib/chat/pure";
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
  PinnedGoalBarLazy,
  PinnedSwarmDock,
  PinnedTaskTrackerLazy,
} from "./lazyTimelineCards";
import { PinnedBackgroundTasksPanel } from "./PinnedBackgroundTasksPanel";
import type { SwarmOpenRequest } from "./swarmDetect";
import { formatSwarmElapsed, isSwarmActive, summarizeSwarmCounts, swarmPhaseMeta } from "./swarmUtils";
import type { TodoItem } from "./todoExtract";
import "./liveActivity.css";

export type HudKind = "swarm" | "delegate" | "media" | "bg_cmd" | "schedule" | "task" | "goal";

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export type LiveAgentCapsuleProps = {
  timelineMessages: ChatMessage[];
  todos: TodoItem[];
  settled: boolean;
  goalMessage: ChatMessage | null;
  wsSending: boolean;
  tokenUsage?: LiveTurnTokenUsageSnapshot;
  delegateItems: InflightDelegateItem[];
  onDismissDelegate: (id: string) => void;
  onCancelDelegate?: (jobId: string) => Promise<boolean>;
  onStopTurn?: () => void;
  latestSwarm: SwarmSnapshot | null;
  latestSwarmCardId?: string;
  latestSwarmBlockId?: string;
  latestSwarmKey: string | null;
  dismissedSwarmKey: string | null;
  onOpenSwarmBoard: (req: SwarmOpenRequest) => void;
  onDismissSwarm: (key: string) => void;
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
  goalMessage,
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
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const delegateStartRef = useRef(new Map<string, number>());

  const swarmActive = latestSwarm ? isSwarmActive(latestSwarm.phase) : false;
  const hasSwarm = swarmActive;
  const hasDelegate = delegateItems.length > 0;
  const hasMedia = museJobs.length > 0 || mediaJobs.length > 0;
  const hasBgCmd = bgCommands.length > 0;
  const hasSchedule = sessionCrons.length > 0;
  const hasIncompleteTodo = todos.some((t) => t.status !== "completed");
  const hasTask = hasIncompleteTodo && (!settled || wsSending);
  const hasGoal = goalMessage !== null;

  const runningDelegates = useMemo(
    () => delegateItems.filter((item) => item.state === "running"),
    [delegateItems],
  );
  const liveDelegates = useMemo(
    () => delegateItems.filter((item) => !isTerminalDelegateState(item.state)),
    [delegateItems],
  );
  const primaryDelegate = useMemo(() => {
    const pool =
      runningDelegates.length > 0
        ? runningDelegates
        : liveDelegates.length > 0
          ? liveDelegates
          : delegateItems;
    return pool.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [delegateItems, liveDelegates, runningDelegates]);

  const activeMuseJobs = useMemo(
    () => museJobs.filter((j) => !isTerminalMuseJobStatus(j.status)),
    [museJobs],
  );
  const activeMediaJobs = useMemo(
    () => mediaJobs.filter((j) => !isTerminalMediaJobStatus(j.status)),
    [mediaJobs],
  );
  const mediaActiveCount = activeMuseJobs.length + activeMediaJobs.length;
  const mediaTotalCount = museJobs.length + mediaJobs.length;
  const mediaRunning = mediaActiveCount > 0;

  const primaryBgCmd = bgCommands[0] ?? null;
  const enabledCrons = useMemo(
    () => sessionCrons.filter((c) => c.enabled),
    [sessionCrons],
  );
  const primaryCron = enabledCrons[0] ?? sessionCrons[0] ?? null;
  const goalActive =
    hasGoal && (goalMessage.goalStatus ?? "active").trim().toLowerCase() === "active";

  // 活跃运行态优先于待触发定时/已终态提示，保持单行胶囊只聚焦此刻最关键的运行态
  const activeOrder: HudKind[] = [];
  if (hasSwarm) activeOrder.push("swarm");
  if (hasDelegate && liveDelegates.length > 0) activeOrder.push("delegate");
  if (hasMedia && mediaRunning) activeOrder.push("media");
  if (hasBgCmd) activeOrder.push("bg_cmd");
  if (hasTask) activeOrder.push("task");
  if (hasGoal && goalActive) activeOrder.push("goal");
  if (hasDelegate && liveDelegates.length === 0) activeOrder.push("delegate");
  if (hasMedia && !mediaRunning) activeOrder.push("media");
  if (hasSchedule) activeOrder.push("schedule");
  if (hasGoal && !goalActive) activeOrder.push("goal");

  useEffect(() => {
    const seen = Date.now();
    const ids = new Set(delegateItems.map((item) => item.jobId));
    for (const id of delegateStartRef.current.keys()) {
      if (!ids.has(id)) delegateStartRef.current.delete(id);
    }
    for (const item of delegateItems) {
      if (isTerminalDelegateState(item.state)) continue;
      if (!delegateStartRef.current.has(item.jobId)) {
        const anchor = item.updatedAt > 0 ? Math.min(seen, item.updatedAt) : seen;
        delegateStartRef.current.set(item.jobId, anchor);
      }
    }
  }, [delegateItems]);

  const fastTimerRunning =
    swarmActive || runningDelegates.length > 0 || mediaRunning || hasBgCmd;
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
  }, [slowCountdownRunning, sessionCrons]);

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

  if (primaryKind === "swarm" && latestSwarm) {
    const counts = summarizeSwarmCounts(latestSwarm.members);
    const phase = swarmPhaseMeta(latestSwarm.phase);
    const latestPost = latestSwarm.posts[latestSwarm.posts.length - 1] ?? null;
    isRunning = swarmActive;
    label = latestSwarm.title || "蜂群协作";
    detail = swarmActive
      ? counts.working > 0
        ? `${counts.working} 运行中${latestPost ? ` · ${latestPost.agent}` : ""}`
        : `${counts.live} 成员`
      : phase.label;
    timer = swarmActive ? formatSwarmElapsed(latestSwarm.startedAt, now) : "";
  } else if (primaryKind === "delegate" && primaryDelegate) {
    const liveCount = liveDelegates.length;
    isRunning = runningDelegates.length > 0;
    label = liveCount > 0 ? `后台 ${liveCount} 进行中` : `后台 ${delegateItems.length} 已结束`;
    detail = firstLinePreview(primaryDelegate.goal) || primaryDelegate.goal;
    if (isRunning) {
      const start = delegateStartRef.current.get(primaryDelegate.jobId) ?? now;
      timer = formatCompactElapsed(now - start);
    }
  } else if (primaryKind === "media") {
    isRunning = mediaRunning;
    const primaryMuse = activeMuseJobs[0] ?? museJobs[0] ?? null;
    const primaryMedia = activeMediaJobs[0] ?? mediaJobs[0] ?? null;
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
    label = bgCommands.length > 1 ? `后台命令 ${bgCommands.length}` : "后台命令";
    detail = firstLinePreview(primaryBgCmd.commandPreview) || primaryBgCmd.jobId;
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
    if (tokenUsage?.totalTokens) {
      timer = `${tokenUsage.totalTokens.toLocaleString()} tok`;
    }
  } else if (primaryKind === "goal" && goalMessage) {
    isRunning = goalActive;
    label = "目标";
    detail = goalMessage.text || "会话目标";
    timer = formatDurationSeconds(goalMessage.timeUsedSeconds);
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
      case "goal":
        return <Target size={11} strokeWidth={1.85} aria-hidden className="oc-live-capsule-icon" />;
    }
  };

  return (
    <div data-testid="pinned-hud-stack">
      {expanded && (
        <div className="oc-live-expanded-stack" data-testid="live-agent-expanded">
          {hasGoal && <PinnedGoalBarLazy messages={timelineMessages} />}
          {hasTask && (
            <PinnedTaskTrackerLazy
              todos={todos}
              active={wsSending}
              settled={settled}
              tokenUsage={tokenUsage}
            />
          )}
          {hasBackgroundPanel && (
            <PinnedBackgroundTasksPanel
              museJobs={museJobs}
              mediaJobs={mediaJobs}
              bgCommands={bgCommands}
              sessionCrons={sessionCrons}
              now={now}
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
              items={delegateItems}
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
              dismissed={dismissedSwarmKey === latestSwarmKey}
              onOpenBoard={onOpenSwarmBoard}
              onDismiss={() => latestSwarmKey && onDismissSwarm(latestSwarmKey)}
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
              aria-hidden
              data-testid="live-agent-capsule-dot"
              data-running={isRunning ? "true" : "false"}
              className={
                isRunning
                  ? "oc-live-capsule-dot oc-alive-dot shrink-0"
                  : "oc-live-capsule-dot shrink-0"
              }
            />
            <span
              className={
                isRunning && primaryKind === "swarm"
                  ? "oc-icon-badge oc-icon-badge-accent oc-breathe-aura flex size-5 shrink-0 items-center justify-center rounded-full"
                  : "oc-icon-badge oc-icon-badge-accent flex size-5 shrink-0 items-center justify-center rounded-full"
              }
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
            {timer && (
              <span data-testid="live-agent-capsule-timer" className="oc-live-capsule-timer shrink-0">
                {timer}
              </span>
            )}
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
              className={
                isRunning
                  ? "oc-live-capsule-action oc-spring-press oc-shimmer-sheen shrink-0"
                  : "oc-live-capsule-action oc-spring-press shrink-0"
              }
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
