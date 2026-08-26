import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  durableMetricSnapshotForTest,
  observeDurableHistogram,
  resetDurableMetricRollupsForTest,
} from "../admin/durableMetricRollups.js";
import {
  insertTurnObservation,
  type TurnObservationBody,
} from "../http/internalTurnObservation.js";
import {
  extractFirstVisibleAttribution,
  extractResponseVisibilityMilestones,
  TurnResponseMilestoneTracker,
} from "../ws/turnPerformance.js";

const savedEnabled = process.env.OC_DURABLE_METRIC_ROLLUPS;
afterEach(() => {
  resetDurableMetricRollupsForTest();
  if (savedEnabled === undefined) delete process.env.OC_DURABLE_METRIC_ROLLUPS;
  else process.env.OC_DURABLE_METRIC_ROLLUPS = savedEnabled;
});

describe("telemetry iteration primitives", () => {
  test("durable histograms collapse model ids to a closed family label", () => {
    process.env.OC_DURABLE_METRIC_ROLLUPS = "1";
    assert.equal(observeDurableHistogram(
      "anthropic_proxy_ttft_seconds",
      "gpt-private-user-controlled-suffix",
      [0.5, 1, 2],
      0.75,
      1_780_000_000_000,
    ), true);
    assert.deepEqual(durableMetricSnapshotForTest(), [{
      metric: "anthropic_proxy_ttft_seconds",
      labels: { family: "gpt" },
      counts: [0, 1, 1, 1],
      sampleCount: 1,
    }]);
  });

  test("first-visible excludes status frames and classifies visible blocks", () => {
    assert.equal(extractFirstVisibleAttribution({
      type: "outbound.turn_status",
      traceId: "a".repeat(32),
    }), null);
    assert.deepEqual(extractFirstVisibleAttribution({
      type: "outbound.message",
      traceId: "b".repeat(32),
      blocks: [{ kind: "thinking", text: "x" }],
    }), { traceId: "b".repeat(32), kind: "thinking" });
    for (const visibleKind of ["plan", "goal", "delegate_progress"] as const) {
      assert.deepEqual(extractFirstVisibleAttribution({
        type: "outbound.message",
        traceId: "c".repeat(32),
        blocks: [{ kind: visibleKind }],
      }), { traceId: "c".repeat(32), kind: "agent" });
    }
    assert.deepEqual(extractFirstVisibleAttribution({
      type: "outbound.message",
      traceId: "d".repeat(32),
      blocks: [{ kind: "tool_use", toolName: "Read" }],
    }), { traceId: "d".repeat(32), kind: "tool" });
  });

  test("response milestones independently classify non-empty thinking/text and final-only text", () => {
    const traceId = "e".repeat(32);
    assert.deepEqual(extractResponseVisibilityMilestones({
      type: "outbound.message",
      traceId,
      peer: { id: "session_1" },
      blocks: [
        { kind: "thinking", text: "  " },
        { kind: "thinking", text: "reason" },
        { kind: "text", text: "answer" },
      ],
      isFinal: true,
    }), {
      traceId,
      sessionId: "session_1",
      hasThinking: true,
      hasText: true,
      isFinal: true,
    });
    assert.equal(extractResponseVisibilityMilestones({ type: "outbound.turn_status", traceId }), null);
  });

  test("turn milestone tracker records thinking/text once, then clears after final", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    } as never;
    const traceId = "f".repeat(32);
    const tracker = new TurnResponseMilestoneTracker();
    tracker.begin({
      traceId,
      sessionId: "session_1",
      model: "gpt-5.6-sol",
      userId: 3n,
      startedAtMs: 1000,
    });
    tracker.observe({
      type: "outbound.message", traceId, peer: { id: "session_1" },
      blocks: [{ kind: "thinking", text: "reason" }], isFinal: false,
    }, pool, undefined, 1500);
    tracker.observe({
      type: "outbound.message", traceId, peer: { id: "session_1" },
      blocks: [{ kind: "thinking", text: "more" }, { kind: "text", text: "answer" }], isFinal: true,
    }, pool, undefined, 2200);
    tracker.observe({
      type: "outbound.message", traceId, peer: { id: "session_1" },
      blocks: [{ kind: "text", text: "duplicate" }], isFinal: true,
    }, pool, undefined, 2500);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.params.slice(1, 8)), [
      ["3", "webchat", "first_thinking_frame", "FIRST_THINKING_FRAME", "succeeded", 1, 500],
      ["3", "webchat", "first_text_frame", "FIRST_TEXT_FRAME", "succeeded", 1, 1200],
    ]);
  });

  test("turn observation insert is event-id idempotent and updates linked trace", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const deps = {
      identityRepo: {} as never,
      queryRunner: {
        async query<Row>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return { rows: [{ inserted: true }] as Row[], rowCount: 1 };
        },
      },
    };
    const body: TurnObservationBody = {
      schemaVersion: 1,
      eventId: "evt-1",
      sessionKey: "agent:main:webchat:dm:s1",
      agentId: "main",
      traceId: "c".repeat(32),
      model: "gpt-5.6-sol",
      durationMs: 1200,
      toolCalls: 2,
      runtimeSourceCommit: "d".repeat(40),
      runtimeBootHash: "e".repeat(12),
      timestamp: Date.now(),
    };
    assert.deepEqual(await insertTurnObservation(deps, 3, 7, body), { duplicate: false });
    assert.match(calls[0]!.sql, /ON CONFLICT \(event_id\) DO NOTHING/);
    assert.match(calls[0]!.sql, /UPDATE turn_traces/);
    assert.match(calls[0]!.sql, /EXISTS \(SELECT 1 FROM inserted\)/);
    assert.equal(calls[0]!.params?.[3], body.traceId);
  });
});
