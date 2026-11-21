import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { lazy, Suspense, useMemo } from "react";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../lib/chat/model";
import type { SwarmOpenRequest } from "./swarmDetect";
import { extractLatestTodos } from "./todoExtract";
import { currentTurnSettled } from "./turnSegment";

const LiveAgentCapsuleLazy = lazy(() => import("./LiveAgentCapsule"));

function findVisibleGoalMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "goal") continue;
    const status = (message.goalStatus ?? "").trim().toLowerCase();
    if (message.cleared === true || status === "cleared") return null;
    return message;
  }
  return null;
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
 * Zero-cost gatekeeper above the Composer: stays out of the first-screen modulepreload
 * graph while idle and lazy-loads LiveAgentCapsule (plus swarmUtils/icons/CSS) only when
 * at least one live signal (Swarm / Delegate / Task / Goal) is active.
 */
export function PinnedHudStack(props: PinnedHudStackProps) {
  const { timelineMessages, chatVersion, wsSending, delegateItems, latestSwarm } = props;

  const { todos, settled, goalMessage } = useMemo(() => {
    void chatVersion;
    return {
      todos: extractLatestTodos(timelineMessages),
      settled: currentTurnSettled(timelineMessages),
      goalMessage: findVisibleGoalMessage(timelineMessages),
    };
  }, [timelineMessages, chatVersion]);

  // Only keep the floating HUD pinned while a swarm is actively running; completed swarms stay in the timeline card.
  const hasSwarm = Boolean(latestSwarm && (latestSwarm.phase === "starting" || latestSwarm.phase === "running"));
  const hasDelegate = delegateItems.length > 0;
  const hasTask = todos.some((t) => t.status !== "completed") && (!settled || wsSending);
  const hasGoal = goalMessage !== null;

  if (!hasSwarm && !hasDelegate && !hasTask && !hasGoal) return null;

  return (
    <Suspense fallback={null}>
      <LiveAgentCapsuleLazy
        {...props}
        todos={todos}
        settled={settled}
        goalMessage={goalMessage}
      />
    </Suspense>
  );
}
