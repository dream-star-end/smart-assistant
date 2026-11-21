import type { SessionContextPressureWire, SysContextCompactedWire } from "./frames";
import type {
  ChatSession,
  SessionContextCompactionDetail,
  SessionContextPressureState,
} from "./model";

const STRATEGY_LABELS: Record<string, string> = {
  native_summary: "模型原生摘要压缩",
  checkpoint_reset: "检查点重置",
  history_suffix: "保留近期对话尾巴",
  file_reference: "超长内容外置文件引用",
};

export function compactionStrategyLabel(strategy?: string): string {
  if (!strategy) return "上下文压缩";
  return STRATEGY_LABELS[strategy] ?? strategy;
}

export function computeCompactionSavedPct(detail: Pick<
  SessionContextCompactionDetail,
  "beforeTokens" | "afterTokens" | "beforeBytes" | "afterBytes"
>): number | null {
  if (
    typeof detail.beforeTokens === "number" &&
    typeof detail.afterTokens === "number" &&
    detail.beforeTokens > 0 &&
    detail.afterTokens >= 0
  ) {
    const pct = Math.round(((detail.beforeTokens - detail.afterTokens) / detail.beforeTokens) * 100);
    return Math.max(0, Math.min(99, pct));
  }
  if (
    typeof detail.beforeBytes === "number" &&
    typeof detail.afterBytes === "number" &&
    detail.beforeBytes > 0 &&
    detail.afterBytes >= 0
  ) {
    const pct = Math.round(((detail.beforeBytes - detail.afterBytes) / detail.beforeBytes) * 100);
    return Math.max(0, Math.min(99, pct));
  }
  return null;
}

function finiteNonNeg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function finiteFloor(v: unknown): number | undefined {
  const n = finiteNonNeg(v);
  return n !== undefined ? Math.floor(n) : undefined;
}

/** `session.context_pressure` → 规整后的会话水位快照（缺省可选字段自动 fail-open）。 */
export function buildContextPressureState(
  frame: SessionContextPressureWire,
  now: () => number = Date.now,
): SessionContextPressureState | null {
  const usedRatio = finiteNonNeg(frame.usedRatio);
  if (usedRatio === undefined) return null;
  const rawBreakdown = frame.breakdown;
  const breakdown =
    rawBreakdown && typeof rawBreakdown === "object"
      ? {
          ...(finiteFloor(rawBreakdown.systemBytes) !== undefined ? { systemBytes: finiteFloor(rawBreakdown.systemBytes) } : {}),
          ...(finiteFloor(rawBreakdown.memoryBytes) !== undefined ? { memoryBytes: finiteFloor(rawBreakdown.memoryBytes) } : {}),
          ...(finiteFloor(rawBreakdown.skillsBytes) !== undefined ? { skillsBytes: finiteFloor(rawBreakdown.skillsBytes) } : {}),
          ...(finiteFloor(rawBreakdown.projectBytes) !== undefined ? { projectBytes: finiteFloor(rawBreakdown.projectBytes) } : {}),
          ...(finiteFloor(rawBreakdown.historyBytes) !== undefined ? { historyBytes: finiteFloor(rawBreakdown.historyBytes) } : {}),
          ...(finiteFloor(rawBreakdown.toolsBytes) !== undefined ? { toolsBytes: finiteFloor(rawBreakdown.toolsBytes) } : {}),
        }
      : undefined;
  const hasBreakdown = breakdown !== undefined && Object.keys(breakdown).length > 0;
  const usedTokens = finiteFloor(frame.usedTokens);
  const windowTokens = finiteFloor(frame.windowTokens);
  return {
    engine: typeof frame.engine === "string" && frame.engine ? frame.engine : "engine",
    scope: frame.scope === "launch_prompt" ? "launch_prompt" : "native_context",
    dimension: frame.dimension === "transport_bytes" ? "transport_bytes" : "tokens",
    level: frame.level === "critical" || usedRatio >= 1 ? "critical" : "warning",
    usedRatio,
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(windowTokens !== undefined && windowTokens > 0 ? { windowTokens } : {}),
    ...(hasBreakdown ? { breakdown } : {}),
    updatedAt: typeof frame.ts === "number" && Number.isFinite(frame.ts) ? frame.ts : now(),
  };
}

/** 压缩完成后下调会话水位（无足够比例信息时清空，等待下一轮真实水位帧）。 */
export function nextPressureAfterCompaction(
  prev: SessionContextPressureState | undefined,
  frame: SysContextCompactedWire,
  now: () => number = Date.now,
): SessionContextPressureState | undefined {
  if (!prev) return undefined;
  const afterTokens = finiteNonNeg(frame.afterTokens);
  const beforeTokens = finiteNonNeg(frame.beforeTokens);
  const afterBytes = finiteNonNeg(frame.afterBytes);
  const beforeBytes = finiteNonNeg(frame.beforeBytes);
  let nextRatio: number | undefined;
  if (afterTokens !== undefined && prev.windowTokens && prev.windowTokens > 0) {
    nextRatio = afterTokens / prev.windowTokens;
  } else if (afterTokens !== undefined && beforeTokens && beforeTokens > 0) {
    nextRatio = prev.usedRatio * (afterTokens / beforeTokens);
  } else if (afterBytes !== undefined && beforeBytes && beforeBytes > 0) {
    nextRatio = prev.usedRatio * (afterBytes / beforeBytes);
  }
  if (nextRatio === undefined || !Number.isFinite(nextRatio)) return undefined;
  const clamped = Math.max(0, nextRatio);
  return {
    ...prev,
    usedRatio: clamped,
    level: clamped >= 1 ? "critical" : "warning",
    ...(afterTokens !== undefined ? { usedTokens: Math.floor(afterTokens) } : {}),
    updatedAt: now(),
  };
}

/**
 * `sys.context_compacted` → 时间线上的一条安静居中回执行（client-owned system 行）。
 * 去重优先级：requestId > frameSeq > ts，防止断线重连/环回重放插出重复回执。
 */
export function contextCompactedRow(
  sess: Pick<ChatSession, "id" | "messages">,
  frame: SysContextCompactedWire,
  now: () => number = Date.now,
): { id: string; text: string; detail: SessionContextCompactionDetail } | null {
  const identity =
    typeof frame.requestId === "string" && frame.requestId.trim()
      ? `r${frame.requestId.trim()}`
      : typeof frame.frameSeq === "number" && Number.isFinite(frame.frameSeq)
        ? `f${frame.frameSeq}`
        : typeof frame.ts === "number" && Number.isFinite(frame.ts)
          ? `t${frame.ts}`
          : `x${now()}`;
  const id = `sys-ctxcompact-${sess.id}-${identity}`;
  if (sess.messages.some((m) => m.id === id)) return null;

  const detail: SessionContextCompactionDetail = {
    engine: typeof frame.engine === "string" && frame.engine ? frame.engine : "engine",
    ...(frame.scope ? { scope: frame.scope } : {}),
    ...(frame.strategy ? { strategy: frame.strategy } : {}),
    ...(finiteFloor(frame.beforeBytes) !== undefined ? { beforeBytes: finiteFloor(frame.beforeBytes) } : {}),
    ...(finiteFloor(frame.afterBytes) !== undefined ? { afterBytes: finiteFloor(frame.afterBytes) } : {}),
    ...(finiteFloor(frame.droppedEntries) !== undefined ? { droppedEntries: finiteFloor(frame.droppedEntries) } : {}),
    ...(finiteFloor(frame.beforeTokens) !== undefined ? { beforeTokens: finiteFloor(frame.beforeTokens) } : {}),
    ...(finiteFloor(frame.afterTokens) !== undefined ? { afterTokens: finiteFloor(frame.afterTokens) } : {}),
    ...(typeof frame.summaryPreview === "string" && frame.summaryPreview.trim()
      ? { summaryPreview: frame.summaryPreview.trim().slice(0, 400) }
      : {}),
  };

  const savedPct = computeCompactionSavedPct(detail);
  const text =
    savedPct !== null && savedPct > 0
      ? `已压缩模型上下文 · 释放约 ${savedPct}% · 原始对话完整保留`
      : "已压缩模型上下文 · 原始对话完整保留";

  return { id, text, detail };
}
