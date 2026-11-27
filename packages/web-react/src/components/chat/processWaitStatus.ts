import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import type { ChatMessage } from "../../lib/chat/model";
import { normalizeSingleUnderscoreMcp } from "./processToolName";
import { isSwarmActive } from "../../lib/chat/swarmBoardEvidence";

function swarmToolName(message: ChatMessage | undefined): string {
  if (message?.role !== "tool") return "";
  return normalizeSingleUnderscoreMcp((message.toolName ?? "").trim()).replace(/^mcp__openclaude-memory__/i, "");
}

export function isSwarmWaitTool(message: ChatMessage): boolean {
  return /^swarm_?wait$/i.test(swarmToolName(message));
}

const SWARM_STEP_RE = /^(?:Swarm(?:Manage|Post|ReadBoard|Wait)|swarm|post_message|read_board|swarm_wait)$/i;

export type ProcessLiveStatus = { text: string; pending: boolean; kind?: "swarm" };

/** A completed wait tool does not prove the coordinator is still waiting.
 * A board update can show collaboration without proving who's waiting.
 * Newer ordinary work wins over stale board evidence; replay clocks are synthetic. */
export function swarmGapStatus(
  current: { messages: readonly ChatMessage[]; narrative: boolean },
  swarm: SwarmSnapshot | null | undefined,
  completedSince: number | null,
): ProcessLiveStatus | null {
  if (!swarm || !isSwarmActive(swarm.phase)) return null;
  const last = current.messages.at(-1);
  const swarmStep = SWARM_STEP_RE.test(swarmToolName(last));
  const stepAt = current.narrative && last && !last._liveUnit ? last.ts : completedSince;
  const boardAtOrAfterStep = stepAt !== null && stepAt > 0 && swarm.updatedAt >= stepAt;
  const parked = boardAtOrAfterStep && swarm.members.some(
    (member) => member?.role === "coordinator" && member.status !== "killed" && member.waitingOnBoard === true,
  );
  if (parked) return { text: "等待蜂群回复", pending: true, kind: "swarm" };
  if (swarmStep || boardAtOrAfterStep) return { text: "蜂群协作中", pending: true, kind: "swarm" };
  return null;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 可见进展结束后,静默多久才显示等待模型响应(避免步骤间闪一下)。 */
export const QUIET_TAIL_MS = 3_000;
/** 当前步骤里的工具连续跑多久才在摘要行旁显示「已运行 N 秒」。 */
export const RUNNING_META_MS = 5_000;
