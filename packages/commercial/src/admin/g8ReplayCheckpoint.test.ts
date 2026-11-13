import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  G8_BOX_REJECT_CODES,
  g8TurnEndCheckpointInput,
  judgeG8Replay,
  resetG8ReplayCheckpointForTest,
  type G8ReplayVerdict,
} from "@openclaude/protocol";

import { BOX_CONTINUATION_REJECTION_REASONS } from "./durableMetricRollups.js";
import { EVENTS } from "./alertEvents.js";
import {
  deliverG8Replay,
  g8ReplayAlertEvent,
  installG8ReplayCheckpoint,
  runG8ReplayCheckpoint,
  type G8ReplayPorts,
} from "./g8ReplayCheckpoint.js";
import { incG8ReplayCheck, renderPrometheus, resetMetricsForTest } from "./metrics.js";

const trace = "33333333333333333333333333333333";

function ports(): G8ReplayPorts & { records: G8ReplayVerdict[]; alerts: string[] } {
  const records: G8ReplayVerdict[] = [];
  const alerts: string[] = [];
  return {
    records,
    alerts,
    record(verdict) {
      records.push(verdict);
    },
    alert(event) {
      alerts.push(`${event.event_type}:${event.severity}:${event.dedupe_key}`);
    },
    now: () => Date.UTC(2026, 9, 31, 1, 0, 0),
  };
}

describe("g8 replay checkpoint", () => {
  afterEach(() => {
    resetG8ReplayCheckpointForTest();
    resetMetricsForTest();
  });

  test("the Box continuation set is covered by the replay vocabulary", () => {
    for (const code of BOX_CONTINUATION_REJECTION_REASONS) {
      assert.equal(G8_BOX_REJECT_CODES.has(code), true, code);
    }
    assert.equal(G8_BOX_REJECT_CODES.has("BOX_REPLAY_EVIDENCE_INVALID"), true);
  });

  test("an ok verdict is recorded and not alerted", () => {
    const sink = ports();
    const verdict = judgeG8Replay({
      point: "turn_end",
      traceId: trace,
      dispatchStatus: "terminal",
      dispatchOutcome: "completed",
      engineReported: "ended",
      settledChargeCount: 1,
    });
    deliverG8Replay(verdict, sink);
    assert.equal(sink.records.length, 1);
    assert.equal(sink.records[0]?.traceId, trace);
    assert.equal(sink.records[0]?.verdict, "ok");
    assert.deepEqual(sink.alerts, []);
    assert.equal(g8ReplayAlertEvent(verdict, sink.now()), null);
  });

  test("a severe verdict alerts the existing outbox and does not stop", () => {
    const sink = ports();
    const verdict = judgeG8Replay(g8TurnEndCheckpointInput({
      traceId: trace,
      outcome: "not_accepted",
      failureCode: "BOX_TOOL_RESULT_MISMATCH",
    }));
    const event = g8ReplayAlertEvent(verdict, sink.now());
    assert.ok(event);
    assert.equal(event?.event_type, EVENTS.OPS_G8_REPLAY_SEVERE);
    assert.equal(event?.severity, "warning");
    assert.equal(event?.body.includes(`npx tsx scripts/oc-trace.ts ${trace}`), true);
    assert.equal(event?.body.includes("--session"), false);
    assert.equal(JSON.stringify(event).includes("stop"), false);
    deliverG8Replay(verdict, sink);
    assert.equal(sink.alerts.length, 1);
    assert.equal(sink.records[0]?.stopSession, false);
  });

  test("a duplicate charge alerts at critical", () => {
    const verdict = judgeG8Replay({
      point: "turn_end",
      traceId: trace,
      settledChargeCount: 2,
      stackedSettledTurns: 2,
    });
    const event = g8ReplayAlertEvent(verdict, Date.UTC(2026, 9, 31, 1, 0, 0));
    assert.equal(event?.severity, "critical");
    assert.equal(verdict.stopSession, false);
  });

  test("installing the listener records through the checkpoint and uninstall clears it", () => {
    const sink = ports();
    assert.equal(runG8ReplayCheckpoint({
      point: "compact_summary",
      traceId: trace,
      boxDecision: "rejected",
    }), null);
    installG8ReplayCheckpoint(sink);
    const hit = runG8ReplayCheckpoint({
      point: "compact_summary",
      traceId: trace,
      boxDecision: "rejected",
    });
    assert.equal(hit?.verdict, "box_rejected");
    assert.equal(hit?.point, "compact_summary");
    assert.equal(sink.records[0]?.traceId, trace);
    assert.equal(sink.alerts.length, 1);
    resetG8ReplayCheckpointForTest();
    assert.equal(runG8ReplayCheckpoint({
      point: "compact_summary",
      traceId: trace,
      boxDecision: "rejected",
    }), null);
  });

  test("the metric series appears only after a check runs", async () => {
    const before = await renderPrometheus({ override: { agentContainersRunning: 0 } });
    assert.equal(before.includes("g8_replay_check_total"), false);
    assert.equal((before.match(/^# HELP /gm) ?? []).length, 25);
    incG8ReplayCheck("turn_end", "box_rejected");
    incG8ReplayCheck("turn_end", "trace-id-must-not-be-a-label");
    const during = await renderPrometheus({ override: { agentContainersRunning: 0 } });
    assert.equal(during.includes('g8_replay_check_total{point="turn_end",verdict="box_rejected"} 1'), true);
    assert.equal(during.includes("trace-id-must-not-be-a-label"), false);
    resetMetricsForTest();
    const after = await renderPrometheus({ override: { agentContainersRunning: 0 } });
    assert.equal(after.includes("g8_replay_check_total"), false);
  });
});
