import { describe, expect, it } from "vitest";
import { createSession } from "./model";
import { applyContextCompacted, applyContextPressure } from "./reducer";
import { compactionStrategyLabel, computeCompactionSavedPct } from "./contextCompacted";

describe("context governance reducer (OCV5-840)", () => {
  it("applies session.context_pressure with optional tokens and breakdown", () => {
    const sess = createSession({ id: "s1", agentId: "main" });
    const ok = applyContextPressure(sess, {
      type: "session.context_pressure",
      engine: "ccb",
      scope: "native_context",
      dimension: "tokens",
      level: "warning",
      usedRatio: 0.84,
      usedTokens: 168_000,
      windowTokens: 200_000,
      breakdown: {
        systemBytes: 12_000,
        memoryBytes: 8_000,
        skillsBytes: 4_000,
        historyBytes: 90_000,
        toolsBytes: 30_000,
      },
      ts: 1_700_000_000_000,
    });
    expect(ok).toBe(true);
    expect(sess._contextPressure).toMatchObject({
      engine: "ccb",
      level: "warning",
      usedRatio: 0.84,
      usedTokens: 168_000,
      windowTokens: 200_000,
      breakdown: {
        systemBytes: 12_000,
        memoryBytes: 8_000,
        skillsBytes: 4_000,
        historyBytes: 90_000,
        toolsBytes: 30_000,
      },
    });
  });

  it("handles legacy session.context_pressure without optional fields (fail-open)", () => {
    const sess = createSession({ id: "s2", agentId: "main" });
    const ok = applyContextPressure(sess, {
      type: "session.context_pressure",
      engine: "antigravity",
      scope: "launch_prompt",
      dimension: "transport_bytes",
      level: "critical",
      usedRatio: 1.05,
    });
    expect(ok).toBe(true);
    expect(sess._contextPressure?.level).toBe("critical");
    expect(sess._contextPressure?.usedTokens).toBeUndefined();
    expect(sess._contextPressure?.breakdown).toBeUndefined();
  });

  it("applies sys.context_compacted idempotently and lowers session pressure", () => {
    const sess = createSession({ id: "s3", agentId: "main" });
    sess._compactingManual = true;
    applyContextPressure(sess, {
      type: "session.context_pressure",
      engine: "ccb",
      scope: "native_context",
      dimension: "tokens",
      level: "critical",
      usedRatio: 0.92,
      usedTokens: 184_000,
      windowTokens: 200_000,
    });

    const frame = {
      type: "sys.context_compacted" as const,
      engine: "ccb",
      scope: "native_context" as const,
      strategy: "native_summary" as const,
      beforeTokens: 184_000,
      afterTokens: 60_000,
      droppedEntries: 14,
      summaryPreview: "保留目标与关键架构决策",
      requestId: "compact-req-1",
    };

    const first = applyContextCompacted(sess, frame, () => 1_700_000_001_000);
    expect(first).not.toBeNull();
    expect(first?.text).toContain("释放约 67%");
    expect(first?.text).toContain("原始对话完整保留");
    expect(sess._compactingManual).toBe(false);
    expect(sess._contextPressure?.usedTokens).toBe(60_000);
    expect(sess._contextPressure?.usedRatio).toBeCloseTo(0.3, 3);
    expect(sess.messages).toHaveLength(1);
    expect(sess.messages[0]?._contextCompaction?.summaryPreview).toBe("保留目标与关键架构决策");

    // Duplicate delivery with same requestId is a clean no-op
    const second = applyContextCompacted(sess, frame, () => 1_700_000_002_000);
    expect(second).toBeNull();
    expect(sess.messages).toHaveLength(1);
  });

  it("computes saved pct from bytes when tokens are absent and maps checkpoint_reset label", () => {
    expect(computeCompactionSavedPct({ beforeBytes: 100_000, afterBytes: 40_000 })).toBe(60);
    expect(computeCompactionSavedPct({})).toBeNull();
    expect(compactionStrategyLabel("checkpoint_reset")).toBe("检查点重置");
    expect(compactionStrategyLabel("native_summary")).toBe("模型原生摘要压缩");
  });
});
