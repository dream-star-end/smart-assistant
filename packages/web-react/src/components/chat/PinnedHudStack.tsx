import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import { lazy, Suspense, useMemo } from "react";
import type { InflightDelegateItem } from "../../lib/chat/inflightDelegates";
import type { ChatMessage, LiveTurnTokenUsageSnapshot } from "../../lib/chat/model";
import type {
  SessionBgCommandItem,
  SessionCronItem,
  SessionMuseJobItem,
} from "../../lib/chat/sessionBackgroundTasks";
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

/**
 * Zero-cost gatekeeper above the Composer: stays out of the first-screen modulepreload
 * graph while idle and lazy-loads LiveAgentCapsule (plus swarmUtils/icons/CSS) only when
 * at least one live signal (Swarm / Delegate / Media / BgCmd / Schedule / Task / Goal) is active.
 */
export function PinnedHudStack(props: PinnedHudStackProps) {
  const {
    timelineMessages,
    chatVersion,
    wsSending,
    delegateItems,
    latestSwarm,
    museJobs = [],
    mediaJobs = [],
    bgCommands = [],
    sessionCrons = [],
  } = props;

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
  const hasMedia = museJobs.length > 0 || mediaJobs.length > 0;
  const hasBgCmd = bgCommands.length > 0;
  const hasSchedule = sessionCrons.length > 0;
  const hasTask = todos.some((t) => t.status !== "completed") && (!settled || wsSending);
  const hasGoal = goalMessage !== null;

  if (!hasSwarm && !hasDelegate && !hasMedia && !hasBgCmd && !hasSchedule && !hasTask && !hasGoal) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <LiveAgentCapsuleLazy
        {...props}
        museJobs={museJobs}
        mediaJobs={mediaJobs}
        bgCommands={bgCommands}
        sessionCrons={sessionCrons}
        todos={todos}
        settled={settled}
        goalMessage={goalMessage}
      />
    </Suspense>
  );
}
