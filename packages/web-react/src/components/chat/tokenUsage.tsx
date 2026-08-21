import type {
  CallTokenUsageSnapshot,
  TurnTokenUsageSnapshot,
} from "@openclaude/protocol/frames";
import type {
  ChatMessage,
  ChildBlock,
  LiveTurnTokenUsageSnapshot,
  MsgUsage,
} from "../../lib/chat/model";
import { groupDigits } from "../../lib/utils";

export type DisplayTokenUsage = LiveTurnTokenUsageSnapshot & {
  callId?: string;
  shared?: boolean;
};

type UsageLike = Partial<LiveTurnTokenUsageSnapshot> | MsgUsage | null | undefined;

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function tokenUsageSnapshot(usage: UsageLike): LiveTurnTokenUsageSnapshot | undefined {
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
    ...("estimated" in usage && usage.estimated === true ? { estimated: true } : {}),
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
  if (!Array.isArray(children)) return [];
  const out: TurnTokenUsageSnapshot[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
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
  const liveSource = msg._delegateUsageByRun && typeof msg._delegateUsageByRun === "object"
    && !Array.isArray(msg._delegateUsageByRun)
    ? msg._delegateUsageByRun
    : {};
  const live = Object.values(liveSource).map(tokenUsageSnapshot);
  if (live.length > 0) return addTokenUsage(live);
  return addTokenUsage(finalUsageFromChildren(msg.childBlocks));
}

export function displayCallTokenUsage(
  call: CallTokenUsageSnapshot | undefined,
): DisplayTokenUsage | undefined {
  const usage = tokenUsageSnapshot(call?.usage);
  if (!usage || !call) return undefined;
  const targets = Array.isArray(call.targetIds) ? call.targetIds : [];
  return {
    ...usage,
    ...(typeof call.callId === "string" && call.callId.length > 0 ? { callId: call.callId } : {}),
    shared: targets.length > 1,
  };
}

/** Merge a card group without double-counting several targets from the same
 * model call. */
export function groupedCallTokenUsage(
  calls: Iterable<CallTokenUsageSnapshot | undefined>,
): DisplayTokenUsage | undefined {
  const unique = new Map<string, CallTokenUsageSnapshot>();
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const callId = typeof call.callId === "string" && call.callId.length > 0
      ? call.callId
      : `legacy:${unique.size}`;
    unique.set(callId, call);
  }
  const usage = addTokenUsage([...unique.values()].map((call) => call.usage));
  if (!usage) return undefined;
  const onlyCall = unique.size === 1 ? unique.values().next().value : undefined;
  return {
    ...usage,
    ...(onlyCall
      ? {
          ...(typeof onlyCall.callId === "string" && onlyCall.callId.length > 0
            ? { callId: onlyCall.callId } : {}),
          shared: Array.isArray(onlyCall.targetIds) && onlyCall.targetIds.length > 1,
        }
      : {}),
  };
}

export function tokenUsageSignature(usage: DisplayTokenUsage | undefined): string {
  if (!usage) return "";
  const estimated = (usage as LiveTurnTokenUsageSnapshot).estimated === true;
  return `${usage.totalTokens}:${estimated ? "estimated" : "exact"}:${usage.callId ?? "turn"}:${usage.shared ? "shared" : "solo"}`;
}

export function formatCompactTokenCount(totalTokens: number): string {
  if (totalTokens < 1_000) return String(totalTokens);
  const units = [
    { value: 1_000_000_000, suffix: "b" },
    { value: 1_000_000, suffix: "m" },
    { value: 1_000, suffix: "k" },
  ];
  const start = units.findIndex((candidate) => totalTokens >= candidate.value);
  const formatAt = (index: number): string => {
    const unit = units[index];
    const scaled = totalTokens / unit.value;
    const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
    const rounded = Number(scaled.toFixed(decimals));
    if (rounded >= 1_000 && index > 0) return formatAt(index - 1);
    return `${rounded}${unit.suffix}`;
  };
  return formatAt(start);
}

export function TokenUsageBadge({
  usage,
  label = "本轮",
}: {
  usage?: DisplayTokenUsage;
  label?: string;
}) {
  const exact = tokenUsageSnapshot(usage);
  if (!exact) return null;
  const compact = formatCompactTokenCount(exact.totalTokens);
  const prefix = usage?.shared ? "共" : exact.estimated ? "约" : "";
  const full = groupDigits(String(exact.totalTokens));
  const title = usage?.shared
    ? `同一次模型调用由多张卡片共享，共 ${full} token`
    : exact.estimated
      ? `${label}估算约 ${full} token`
      : `${label} ${full} token`;
  return (
    <span
      key={exact.totalTokens}
      className="whitespace-nowrap text-[11px] font-medium tabular-nums text-faint animate-in"
      title={title}
      aria-label={title}
    >
      {prefix}{compact}
    </span>
  );
}
