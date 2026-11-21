import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { ArrowUpRight, Bot, ChevronDown, ChevronUp, Hexagon, ListChecks, Target, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTerminalDelegateState, type InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../lib/chat/model";
import { formatDurationSeconds } from "../../lib/chat/pure";
import {
  PinnedDelegateTrackerLazy,
  PinnedGoalBarLazy,
  PinnedSwarmDock,
  PinnedTaskTrackerLazy,
} from "./lazyTimelineCards";
import type { SwarmOpenRequest } from "./swarmDetect";
import { formatSwarmElapsed, isSwarmActive, summarizeSwarmCounts, swarmPhaseMeta } from "./swarmUtils";
import type { TodoItem } from "./todoExtract";
import "./liveActivity.css";

type HudKind = "swarm" | "delegate" | "task" | "goal";

function firstLine(text: string): string {
  const nl = text.search(/\r|\n/);
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

function formatCompactMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
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
  onStopTurn?: () => void;
  latestSwarm: SwarmSnapshot | null;
  latestSwarmCardId?: string;
  latestSwarmBlockId?: string;
  latestSwarmKey: string | null;
  dismissedSwarmKey: string | null;
  onOpenSwarmBoard: (req: SwarmOpenRequest) => void;
  onDismissSwarm: (key: string) => void;
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
  onStopTurn,
  latestSwarm,
  latestSwarmCardId,
  latestSwarmBlockId,
  latestSwarmKey,
  dismissedSwarmKey,
  onOpenSwarmBoard,
  onDismissSwarm,
}: LiveAgentCapsuleProps) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const delegateStartRef = useRef(new Map<string, number>());

  const swarmActive = latestSwarm ? isSwarmActive(latestSwarm.phase) : false;
  const hasSwarm = Boolean(latestSwarm && (swarmActive || dismissedSwarmKey !== latestSwarmKey));
  const hasDelegate = delegateItems.length > 0;
  const hasIncompleteTodo = todos.some((t) => t.status !== "completed");
  const hasTask = hasIncompleteTodo && (!settled || wsSending);
  const hasGoal = goalMessage !== null;

  const activeOrder: HudKind[] = [];
  if (hasSwarm) activeOrder.push("swarm");
  if (hasDelegate) activeOrder.push("delegate");
  if (hasTask) activeOrder.push("task");
  if (hasGoal) activeOrder.push("goal");

  const runningDelegates = useMemo(
    () => delegateItems.filter((item) => item.state === "running"),
    [delegateItems],
  );
  const primaryDelegate = useMemo(() => {
    const live = delegateItems.filter((item) => !isTerminalDelegateState(item.state));
    const pool = runningDelegates.length > 0 ? runningDelegates : live.length > 0 ? live : delegateItems;
    return pool.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [delegateItems, runningDelegates]);

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

  const anyTimerRunning = swarmActive || runningDelegates.length > 0;
  useEffect(() => {
    if (!anyTimerRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyTimerRunning]);

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
    const liveCount = delegateItems.filter((item) => !isTerminalDelegateState(item.state)).length;
    isRunning = runningDelegates.length > 0;
    label = liveCount > 0 ? `后台 ${liveCount} 进行中` : `后台 ${delegateItems.length} 已结束`;
    detail = firstLine(primaryDelegate.goal) || primaryDelegate.goal;
    if (isRunning) {
      const start = delegateStartRef.current.get(primaryDelegate.jobId) ?? now;
      timer = formatCompactMmSs(now - start);
    }
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
    const status = (goalMessage.goalStatus ?? "active").trim().toLowerCase();
    isRunning = status === "active";
    label = "目标";
    detail = goalMessage.text || "会话目标";
    timer = formatDurationSeconds(goalMessage.timeUsedSeconds);
  }

  const PrimaryIcon =
    primaryKind === "swarm"
      ? Hexagon
      : primaryKind === "delegate"
        ? Bot
        : primaryKind === "task"
          ? ListChecks
          : Target;

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
          {hasDelegate && (
            <PinnedDelegateTrackerLazy
              items={delegateItems}
              onDismiss={onDismissDelegate}
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
          className="oc-live-capsule"
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
            className="oc-live-capsule-main"
          >
            <span
              aria-hidden
              data-testid="live-agent-capsule-dot"
              data-running={isRunning ? "true" : "false"}
              className="oc-live-capsule-dot"
            />
            <span className="oc-icon-badge oc-icon-badge-accent flex size-5 shrink-0 items-center justify-center rounded-full">
              <PrimaryIcon size={11} strokeWidth={1.85} aria-hidden className="oc-live-capsule-icon" />
            </span>
            <span className="oc-live-capsule-label">{label}</span>
            {detail && <span className="oc-live-capsule-detail">{detail}</span>}
            {timer && (
              <span data-testid="live-agent-capsule-timer" className="oc-live-capsule-timer">
                {timer}
              </span>
            )}
            {extraCount > 0 && (
              <span data-testid="live-agent-capsule-more" className="oc-live-capsule-more">
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
              className="oc-live-capsule-action"
            >
              <span>看板</span>
              <ArrowUpRight size={11} aria-hidden />
            </button>
          )}

          {primaryKind === "swarm" && !swarmActive && extraCount === 0 && latestSwarmKey && (
            <button
              type="button"
              aria-label="收起蜂群胶囊"
              title="收起"
              onClick={() => onDismissSwarm(latestSwarmKey)}
              className="oc-live-capsule-dismiss"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
