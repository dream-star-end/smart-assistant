import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { useMemo, useState } from "react";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../lib/chat/model";
import {
  PinnedDelegateTrackerLazy,
  PinnedGoalBarLazy,
  PinnedSwarmDock,
  PinnedTaskTrackerLazy,
} from "./lazyTimelineCards";
import type { SwarmOpenRequest } from "./swarmDetect";
import { extractLatestTodos } from "./todoExtract";
import { currentTurnSettled } from "./turnSegment";

const MAX_COMPACT_PINNED_BARS = 2;

function hasVisibleGoalMessage(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "goal") continue;
    const status = (message.goalStatus ?? "").trim().toLowerCase();
    return !(message.cleared === true || status === "cleared");
  }
  return false;
}

export type PinnedHudStackProps = {
  timelineMessages: ChatMessage[];
  chatVersion: number;
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

/**
 * Compact stacked HUD budget above the Composer.
 * Keeps at most 2 concurrent pinned bars expanded by default (priority:
 * Swarm > Delegate > Task > Goal) while collapsing overflow behind a 1-line
 * toggle so the composer never gets pushed off-screen.
 * The `#pending-approval-bar-slot` portal host is never folded.
 */
export function PinnedHudStack({
  timelineMessages,
  chatVersion,
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
}: PinnedHudStackProps) {
  const [expanded, setExpanded] = useState(false);

  const { todos, settled, hasGoal } = useMemo(() => {
    void chatVersion;
    return {
      todos: extractLatestTodos(timelineMessages),
      settled: currentTurnSettled(timelineMessages),
      hasGoal: hasVisibleGoalMessage(timelineMessages),
    };
  }, [timelineMessages, chatVersion]);

  const hasSwarm = Boolean(latestSwarm && dismissedSwarmKey !== latestSwarmKey);
  const hasDelegate = delegateItems.length > 0;
  const hasTask = todos.length > 0 && (!settled || wsSending);

  const activeOrder: Array<"swarm" | "delegate" | "task" | "goal"> = [];
  if (hasSwarm) activeOrder.push("swarm");
  if (hasDelegate) activeOrder.push("delegate");
  if (hasTask) activeOrder.push("task");
  if (hasGoal) activeOrder.push("goal");

  const overflowCount = Math.max(0, activeOrder.length - MAX_COMPACT_PINNED_BARS);
  const visibleSet = new Set(
    expanded || overflowCount === 0
      ? activeOrder
      : activeOrder.slice(0, MAX_COMPACT_PINNED_BARS),
  );

  return (
    <>
      {(!hasGoal || visibleSet.has("goal")) && <PinnedGoalBarLazy messages={timelineMessages} />}
      {(!hasTask || visibleSet.has("task")) && (
        <PinnedTaskTrackerLazy
          todos={todos}
          active={wsSending}
          settled={settled}
          tokenUsage={tokenUsage}
        />
      )}
      {(!hasDelegate || visibleSet.has("delegate")) && (
        <PinnedDelegateTrackerLazy
          items={delegateItems}
          onDismiss={onDismissDelegate}
          onStop={onStopTurn}
        />
      )}
      {latestSwarm && (!hasSwarm || visibleSet.has("swarm")) && (
        <PinnedSwarmDock
          snapshot={latestSwarm}
          cardId={latestSwarmCardId}
          blockId={latestSwarmBlockId}
          dismissed={dismissedSwarmKey === latestSwarmKey}
          onOpenBoard={onOpenSwarmBoard}
          onDismiss={() => latestSwarmKey && onDismissSwarm(latestSwarmKey)}
        />
      )}
      {overflowCount > 0 && (
        <div className="mx-auto mb-1.5 flex max-w-3xl justify-end px-4" data-testid="pinned-hud-overflow">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center rounded-full border border-border/70 bg-surface/90 px-2.5 py-0.5 text-caption text-muted transition-colors hover:bg-hover hover:text-fg [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
          >
            {expanded ? "收起多余状态栏" : `还有 ${overflowCount} 项运行状态 · 展开`}
          </button>
        </div>
      )}
    </>
  );
}
