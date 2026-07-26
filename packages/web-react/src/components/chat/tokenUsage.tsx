import type { TurnTokenUsageSnapshot } from "@openclaude/protocol/frames";
import type { ChatMessage, ChildBlock, MsgUsage } from "../../lib/chat/model";
import { groupDigits } from "../../lib/utils";

type UsageLike = Partial<TurnTokenUsageSnapshot> | MsgUsage | null | undefined;

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function tokenUsageSnapshot(usage: UsageLike): TurnTokenUsageSnapshot | undefined {
  if (!usage) return undefined;
  const inputTokens = safeCount(usage.inputTokens);
  const outputTokens = safeCount(usage.outputTokens);
  const cacheReadTokens = safeCount(usage.cacheReadTokens);
  const cacheCreationTokens = safeCount(usage.cacheCreationTokens);
  const fallback =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheCreationTokens ?? 0);
  const totalTokens = safeCount(usage.totalTokens) ?? fallback;
  if (totalTokens <= 0) return undefined;
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

export function addTokenUsage(
  usages: Iterable<TurnTokenUsageSnapshot | undefined>,
): TurnTokenUsageSnapshot | undefined {
  let totalTokens = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  for (const usage of usages) {
    if (!usage) continue;
    totalTokens += usage.totalTokens;
    if (usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    if (usage.cacheReadTokens !== undefined) {
      cacheReadTokens = (cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
    if (usage.cacheCreationTokens !== undefined) {
      cacheCreationTokens = (cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
    }
  }
  return tokenUsageSnapshot({
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  });
}

function finalUsageFromChildren(children: ChildBlock[] | undefined): TurnTokenUsageSnapshot[] {
  const out: TurnTokenUsageSnapshot[] = [];
  for (const child of children ?? []) {
    if (child.kind === "final" && child.meta && typeof child.meta === "object") {
      const usage = tokenUsageSnapshot(child.meta as MsgUsage);
      if (usage) out.push(usage);
    }
    if (Array.isArray(child.childBlocks)) out.push(...finalUsageFromChildren(child.childBlocks));
  }
  return out;
}

/** Live delegate snapshots win; hydrated immutable transcripts recover the
 * same aggregate from each child execution's unique final meta. */
export function delegateTokenUsage(msg: ChatMessage): TurnTokenUsageSnapshot | undefined {
  const live = Object.values(msg._delegateUsageByRun ?? {}).map(tokenUsageSnapshot);
  if (live.length > 0) return addTokenUsage(live);
  return addTokenUsage(finalUsageFromChildren(msg.childBlocks));
}

export function tokenUsageSignature(usage: TurnTokenUsageSnapshot | undefined): string {
  return usage ? String(usage.totalTokens) : "";
}

export function TokenUsageBadge({
  usage,
  label = "本轮",
}: {
  usage?: TurnTokenUsageSnapshot;
  label?: string;
}) {
  const exact = tokenUsageSnapshot(usage);
  if (!exact) return null;
  return (
    <span className="whitespace-nowrap text-[11px] font-medium tabular-nums text-faint">
      {label} {groupDigits(String(exact.totalTokens))} token
    </span>
  );
}
