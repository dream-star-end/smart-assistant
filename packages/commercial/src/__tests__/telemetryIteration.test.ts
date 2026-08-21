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
import { extractFirstVisibleAttribution } from "../ws/turnPerformance.js";

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
