import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID } from "@openclaude/protocol";

import { materializeLosslessTurn } from "../http/losslessTurnTape.js";

const TURN_KEY = "a".repeat(64);

describe("materializeLosslessTurn", () => {
  test("keeps full thinking, tool IO, assistant text and child transcript", () => {
    const thinking = "reasoning😀".repeat(20_000);
    const answer = "answer正文".repeat(20_000);
    const input = { command: "printf x".repeat(20_000) };
    const output = "stdout\n".repeat(40_000);
    const child = "child transcript".repeat(20_000);
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 7,
      status: "completed",
      turnKey: TURN_KEY,
      text: answer,
      thinkingText: thinking,
      createdAt: 1_783_944_000_000,
      tools: [{
        toolUseId: "tool-1",
        blockId: "tool-1",
        toolName: "Bash",
        inputJson: input,
        inputPreview: "preview only",
        output,
        isError: false,
        durationMs: 10,
        ts: 2,
        arrivedAt: 2,
        futureExactField: { nested: child },
      }],
      agentGroups: [{
        runId: "dlg-1",
        agentId: "reviewer",
        goal: "review all details",
        status: "ok",
        resultSummary: child,
        transcript: [{ kind: "thinking", text: child }, { kind: "text", text: child }],
        completedAt: 3,
      }],
    });

    const thinkingRecord = turn.records.find((record) => record.role === "thinking")!;
    const toolRecord = turn.records.find((record) => record.role === "tool")!;
    const groupRecord = turn.records.find((record) => record.role === "agent-group")!;
    const assistantRecord = turn.records.find((record) => record.role === "assistant")!;
    assert.equal(thinkingRecord.payload.text, thinking);
    assert.deepEqual(toolRecord.payload.inputJson, input);
    assert.equal(toolRecord.payload.output, output);
    assert.deepEqual(toolRecord.payload.futureExactField, { nested: child });
    assert.equal(groupRecord.payload._resultPreview, child);
    assert.deepEqual(groupRecord.payload.childBlocks, [
      { kind: "thinking", text: child },
      { kind: "text", text: child },
    ]);
    assert.equal(assistantRecord.payload.text, answer);
    for (const record of turn.records) {
      assert.equal(
        createHash("sha256").update(record.payloadBytes).digest("hex"),
        record.payloadSha256,
      );
    }
  });

  test("keeps every plan/goal update and materializes the final projection without caps", () => {
    const hugeDetail = "完整结构化细节😀".repeat(20_000);
    const planUpdates = Array.from({ length: 80 }, (_, index) => ({
      kind: "plan",
      blockId: "plan-live",
      text: index === 79 ? hugeDetail : `draft-${index}`,
      explanation: index === 37 ? hugeDetail : `explain-${index}`,
      steps: [{
        step: index === 79 ? hugeDetail : `step-${index}`,
        status: index === 79 ? "completed" : "inProgress",
      }],
      partial: index !== 79,
      futureExactField: { ordinal: index, detail: index === 41 ? hugeDetail : "kept" },
      _ocObservedAt: 1_783_944_000_100 + index,
      _ocEventOrdinal: index,
    }));
    const goalUpdates = [
      {
        kind: "goal",
        blockId: "goal-live",
        objective: "first objective",
        status: "in_progress",
        tokenBudget: null,
        tokensUsed: 123,
        _ocObservedAt: 1_783_944_000_200,
        _ocEventOrdinal: 80,
      },
      {
        kind: "goal",
        blockId: "goal-live",
        objective: hugeDetail,
        status: "complete",
        tokenBudget: null,
        tokensUsed: 456,
        timeUsedSeconds: 789,
        futureExactField: { nested: hugeDetail },
        _ocObservedAt: 1_783_944_000_201,
        _ocEventOrdinal: 81,
      },
    ];

    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 9,
      status: "completed",
      turnKey: TURN_KEY,
      text: "",
      createdAt: 1_783_944_000_000,
      structuredBlocks: [...planUpdates, ...goalUpdates],
    });

    const planRecord = turn.records.find((record) => record.role === "plan")!;
    const goalRecord = turn.records.find((record) => record.role === "goal")!;
    assert.equal(turn.records.filter((record) => record.role === "plan").length, 1);
    assert.equal(turn.records.filter((record) => record.role === "goal").length, 1);
    assert.equal(planRecord.payload.text, hugeDetail);
    assert.equal(planRecord.payload._partial, false);
    assert.equal((planRecord.payload._eventHistory as unknown[]).length, 80);
    assert.deepEqual((planRecord.payload._eventHistory as unknown[])[0], {
      kind: "plan",
      blockId: "plan-live",
      text: "draft-0",
      explanation: "explain-0",
      steps: [{ step: "step-0", status: "inProgress" }],
      partial: true,
      futureExactField: { ordinal: 0, detail: "kept" },
    });
    assert.equal(
      ((planRecord.payload._eventHistory as Array<Record<string, unknown>>)[41]!
        .futureExactField as Record<string, unknown>).detail,
      hugeDetail,
    );
    assert.equal(goalRecord.payload.text, hugeDetail);
    assert.equal(goalRecord.payload.goalStatus, "complete");
    assert.equal((goalRecord.payload._eventHistory as unknown[]).length, 2);
    assert.deepEqual((goalRecord.payload._eventHistory as unknown[])[1], {
      kind: "goal",
      blockId: "goal-live",
      objective: hugeDetail,
      status: "complete",
      tokenBudget: null,
      tokensUsed: 456,
      timeUsedSeconds: 789,
      futureExactField: { nested: hugeDetail },
    });
    assert.equal(planRecord.ts, 1_783_944_000_179);
    assert.equal(goalRecord.ts, 1_783_944_000_201);
  });

  test("rejects divergent segment aggregates instead of silently dropping either representation", () => {
    assert.throws(() => materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 8,
      status: "completed",
      turnKey: TURN_KEY,
      text: "complete answer",
      createdAt: 1_783_944_000_000,
      assistantSegments: [{ index: 0, text: "incomplete", ts: 1 }],
    }), /do not reconstruct/);
  });

  test("orders projections and opaque runtime events by one global ordinal", () => {
    const rawOne = { jsonrpc: "2.0", method: "item/reasoning/textDelta", params: { delta: "raw-1" } };
    const rawFive = { type: "tool_progress", bytes: "x".repeat(20_000), future: { exact: true } };
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "codex",
      turnIndex: 10,
      status: "completed",
      turnKey: TURN_KEY,
      text: "answer",
      thinkingText: "think",
      createdAt: 1_783_944_000_000,
      runtimeEvents: [
        { ordinal: 1, observedAt: 1_783_944_000_500, source: "codex-jsonrpc", payload: rawOne },
        { ordinal: 5, observedAt: 1_783_944_000_100, source: "ccb", payload: rawFive },
      ],
      thinkingSegments: [{ index: 0, text: "think", ts: 99, eventOrdinal: 2 }],
      structuredBlocks: [{
        kind: "goal",
        blockId: "goal-1",
        objective: "keep all",
        status: "in_progress",
        _ocObservedAt: 100,
        _ocEventOrdinal: 3,
      }],
      tools: [{
        toolUseId: "tool-1",
        blockId: "tool-1",
        toolName: "Bash",
        inputJson: { command: "true" },
        inputPreview: "true",
        output: "done",
        isError: false,
        durationMs: 1,
        ts: 101,
        arrivedAt: 101,
        eventOrdinal: 4,
      }],
      assistantSegments: [{ index: 0, text: "answer", ts: 98, eventOrdinal: 6 }],
    });

    assert.deepEqual(turn.records.map((record) => record.eventOrdinal), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(turn.records.map((record) => record.role), [
      "runtime-event",
      "thinking",
      "goal",
      "tool",
      "runtime-event",
      "assistant",
    ]);
    const runtime = turn.records.filter((record) => record.role === "runtime-event");
    assert.deepEqual(runtime[0]!.payload._runtimeEvent, rawOne);
    assert.deepEqual(runtime[1]!.payload._runtimeEvent, rawFive);
    assert.equal(runtime[1]!.payload.text, JSON.stringify(rawFive));
  });

  test("materializes an uncapped visible assistant row for an error-only paid turn", () => {
    const detail = "provider exact error detail\n".repeat(20_000);
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 11,
      status: "crashed",
      turnKey: TURN_KEY,
      text: "",
      errorCode: "RUNNER_CRASHED",
      errorDetail: detail,
      createdAt: 1_783_944_000_000,
      runtimeEvents: [{
        ordinal: 0,
        observedAt: 1_783_944_000_000,
        source: "gateway",
        payload: { type: "terminal_error", detail },
      }],
    });
    const assistant = turn.records.find((record) => record.role === "assistant")!;
    assert.equal(assistant.payload.text, detail);
    assert.equal(assistant.payload._errorDetail, detail);
    assert.equal(assistant.payload._isError, true);
    assert.equal(turn.billingAnchorId, assistant.id);
  });

  test("upgraded pre-agentId tapes reuse the historical v1 record namespace", () => {
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID,
      turnIndex: 12,
      status: "completed",
      turnKey: TURN_KEY,
      text: "legacy reply",
      thinkingText: "legacy thinking",
      createdAt: 1_783_944_000_000,
      tools: [{
        toolUseId: "tool-legacy",
        blockId: "tool-legacy",
        toolName: "Read",
        inputJson: { file: "legacy" },
        inputPreview: "legacy",
        output: "legacy output",
        isError: false,
        durationMs: 1,
        ts: 1,
      }],
    });
    assert.deepEqual(turn.records.map((record) => record.id), [
      "srv-web-lossless-123-t12-thinking",
      "srv-web-lossless-123-t12-tool-tool-legacy",
      "srv-web-lossless-123-t12",
    ]);
    assert.ok(turn.records.every((record) => !record.id.includes(LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID)));
  });
});
