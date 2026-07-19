import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, test } from "node:test";

import { LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID } from "@openclaude/protocol";

import { computeGoalTokensUsed, materializeLosslessTurn } from "../http/losslessTurnTape.js";

const TURN_KEY = "a".repeat(64);

describe("materializeLosslessTurn", () => {
  test("stamps exact client turn attribution into every immutable record and hash", () => {
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 6,
      clientMessageId: "m-user-exact_1",
      status: "completed",
      turnKey: TURN_KEY,
      text: "answer",
      thinkingText: "thought",
      createdAt: 1_783_944_000_000,
      tools: [{
        toolUseId: "tool-exact",
        blockId: "tool-exact",
        toolName: "Read",
        inputJson: { file: "x" },
        inputPreview: "x",
        output: "done",
        isError: false,
        durationMs: 1,
        ts: 1,
      }],
    });
    assert.ok(turn.records.length >= 3);
    for (const record of turn.records) {
      assert.equal(record.payload._clientMessageId, "m-user-exact_1");
      assert.equal(
        createHash("sha256").update(record.payloadBytes).digest("hex"),
        record.payloadSha256,
      );
    }
  });

  test("rejects malformed attribution and forbids it on content-only continuations", () => {
    const base = {
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 6,
      status: "completed" as const,
      turnKey: TURN_KEY,
      text: "answer",
      createdAt: 1_783_944_000_000,
    };
    assert.throws(
      () => materializeLosslessTurn({ ...base, clientMessageId: "bad id" }),
      /clientMessageId is invalid/,
    );
    assert.throws(
      () => materializeLosslessTurn({
        ...base,
        clientMessageId: "m-user-exact",
        continuationOfTurnKey: "b".repeat(64),
        text: "",
        runtimeEvents: [{ ordinal: 1, observedAt: 2, source: "ccb", payload: { type: "tail" } }],
      }),
      /continuation must contain only/,
    );
  });

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

  test("keeps every plan/goal update and materializes the final readable record without caps", () => {
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
        platformGoalId: "11111111-1111-4111-8111-111111111111",
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
        platformGoalId: "11111111-1111-4111-8111-111111111111",
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
    assert.equal(goalRecord.payload.blockId, "platform-goal-11111111-1111-4111-8111-111111111111");
    assert.equal(goalRecord.payload.goalStatus, "complete");
    assert.equal((goalRecord.payload._eventHistory as unknown[]).length, 2);
    assert.deepEqual((goalRecord.payload._eventHistory as unknown[])[1], {
      kind: "goal",
      blockId: "goal-live",
      platformGoalId: "11111111-1111-4111-8111-111111111111",
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

  test("orders readable records and opaque runtime events by one global ordinal", () => {
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

  test("batches ordinary runtime events losslessly while leaving Bash tails directly queryable", () => {
    const previous = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING;
    process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = "1";
    try {
      const runtimeEvents = Array.from({ length: 9 }, (_, ordinal) => ({
        ordinal,
        observedAt: 1_783_944_000_000 + ordinal,
        source: "ccb" as const,
        payload: ordinal === 4
          ? {
              type: "system",
              subtype: "bash_output_tail",
              tool_use_id: "tool-bg",
              tail: "still directly queryable",
              total_bytes: 24,
            }
          : { type: "progress", ordinal, exact: `payload-${ordinal}` },
      }));
      const turn = materializeLosslessTurn({
        sessionId: "web-lossless-123",
        agentId: "main",
        turnIndex: 101,
        status: "completed",
        turnKey: TURN_KEY,
        text: "",
        createdAt: 1_783_944_000_000,
        runtimeEvents,
      });

      assert.equal(turn.logicalRecordCount, 9);
      assert.equal(turn.records.length, 3, "two batches plus one unbatched Bash tail");
      assert.match(turn.runtimeBatchManifestSha256!, /^[0-9a-f]{64}$/);
      const tail = turn.records.find((record) => record.payload._runtimeEvent);
      assert.equal(
        (tail!.payload._runtimeEvent as Record<string, unknown>).subtype,
        "bash_output_tail",
      );
      const reconstructed: Array<Record<string, unknown>> = [];
      for (const record of turn.records) {
        const rawBatch = record.payload._runtimeEventBatch;
        if (!rawBatch || typeof rawBatch !== "object" || Array.isArray(rawBatch)) continue;
        const batch = rawBatch as Record<string, unknown>;
        const manifest = batch.manifest as Array<Record<string, unknown>>;
        const raw = gunzipSync(Buffer.from(String(batch.data), "base64"));
        for (const entry of manifest) {
          const offset = Number(entry.offset);
          const length = Number(entry.length);
          const bytes = raw.subarray(offset, offset + length);
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            entry.payloadSha256,
          );
          reconstructed.push(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
        }
      }
      assert.deepEqual(
        reconstructed.map((payload) => payload._ocEventOrdinal),
        [0, 1, 2, 3, 5, 6, 7, 8],
      );
      assert.deepEqual(
        reconstructed.map((payload) => payload._runtimeEvent),
        runtimeEvents.filter((event) => event.ordinal !== 4).map((event) => event.payload),
      );
      const replay = materializeLosslessTurn({
        sessionId: "web-lossless-123",
        agentId: "main",
        turnIndex: 101,
        status: "completed",
        turnKey: TURN_KEY,
        text: "",
        createdAt: 1_783_944_000_000,
        runtimeEvents,
      });
      assert.deepEqual(
        replay.records.map((record) => ({
          id: record.id,
          payloadSha256: record.payloadSha256,
          payloadBytes: record.payloadBytes,
        })),
        turn.records.map((record) => ({
          id: record.id,
          payloadSha256: record.payloadSha256,
          payloadBytes: record.payloadBytes,
        })),
        "ACK-loss replay must reproduce byte-identical physical batch records",
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LOSSLESS_TURN_TAPE_RUNTIME_BATCHING");
      else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previous;
    }
  });

  test("runtime batching is default-off and requires an explicit safe-rollout opt-in", () => {
    const previous = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING;
    Reflect.deleteProperty(process.env, "LOSSLESS_TURN_TAPE_RUNTIME_BATCHING");
    try {
      const turn = materializeLosslessTurn({
        sessionId: "web-lossless-123",
        agentId: "main",
        turnIndex: 102,
        status: "completed",
        turnKey: TURN_KEY,
        text: "",
        createdAt: 1_783_944_000_000,
        runtimeEvents: Array.from({ length: 4 }, (_, ordinal) => ({
          ordinal,
          observedAt: 1_783_944_000_000 + ordinal,
          source: "gateway" as const,
          payload: { ordinal },
        })),
      });
      assert.equal(turn.records.length, 4);
      assert.equal(turn.logicalRecordCount, 4);
      assert.equal(turn.runtimeBatchManifestSha256, undefined);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LOSSLESS_TURN_TAPE_RUNTIME_BATCHING");
      else process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING = previous;
    }
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

  test("materializes post-terminal runtime continuations without inventing visible text", () => {
    const continuationOfTurnKey = "b".repeat(64);
    const rawTail = {
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "tool-bg",
      tail: "late complete stdout",
      total_bytes: 20,
      truncated_head: false,
      futureExactField: { keep: true },
    };
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "tail_deadbeef",
      turnIndex: 13,
      status: "completed",
      turnKey: TURN_KEY,
      continuationOfTurnKey,
      text: "",
      createdAt: 1_783_944_000_000,
      runtimeEvents: [{
        ordinal: 99,
        observedAt: 1_783_944_000_000,
        source: "ccb",
        payload: rawTail,
      }],
    });
    assert.equal(turn.records.length, 1);
    assert.equal(turn.records[0]!.role, "runtime-event");
    assert.deepEqual(turn.records[0]!.payload._runtimeEvent, rawTail);
    assert.equal(turn.records[0]!.payload._continuationOfTurnKey, continuationOfTurnKey);
    assert.equal(turn.engineBillings.length, 0);
  });

  test("retains and validates root plus every delegate engine billing frame", () => {
    const sessionId = "web-lossless-123";
    const rootBilling = {
      requestId: "1".repeat(32),
      turnKey: TURN_KEY,
      engineSessionId: `oceng-${"2".repeat(48)}`,
      status: "success" as const,
      durationMs: 5,
      usage: { input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 3 },
      rateLimits: { util5h: 12.5, reset5h: "2026-07-14T00:00:00.000Z" },
    };
    const delegateBilling = {
      requestId: "3".repeat(32),
      turnKey: "4".repeat(64),
      parentTurnKey: TURN_KEY,
      parentSessionId: sessionId,
      delegateAgentId: "reviewer",
      engineSessionId: `oceng-${"5".repeat(48)}`,
      status: "error" as const,
      durationMs: 9,
      usage: { input_tokens: 8, output_tokens: 2 },
      errorReason: "exact delegate failure",
    };
    const turn = materializeLosslessTurn({
      sessionId,
      agentId: "codex",
      turnIndex: 14,
      status: "completed",
      turnKey: TURN_KEY,
      requestId: rootBilling.requestId,
      text: "paid answer",
      createdAt: 1_783_944_000_000,
      engineBilling: rootBilling,
      agentGroups: [{
        runId: "dlg-billing",
        agentId: "reviewer",
        goal: "review",
        status: "failed",
        completedAt: 1_783_944_000_001,
        engineBillings: [delegateBilling],
      }],
    });
    const sanitizedDelegateBilling = {
      requestId: delegateBilling.requestId,
      turnKey: delegateBilling.turnKey,
      parentTurnKey: delegateBilling.parentTurnKey,
      parentSessionId: delegateBilling.parentSessionId,
      delegateAgentId: delegateBilling.delegateAgentId,
      engineSessionId: delegateBilling.engineSessionId,
      status: delegateBilling.status,
      durationMs: delegateBilling.durationMs,
      usage: delegateBilling.usage,
      terminalCode: "CODEX_ERROR",
    };
    assert.deepEqual(turn.engineBillings, [rootBilling, sanitizedDelegateBilling]);
    const group = turn.records.find((record) => record.role === "agent-group")!;
    assert.deepEqual(group.payload.engineBillings, [sanitizedDelegateBilling]);
    assert.equal(JSON.stringify(turn).includes("exact delegate failure"), false);
    assert.equal(JSON.stringify(turn).includes("errorReason"), false);
    assert.throws(() => materializeLosslessTurn({
      sessionId,
      agentId: "codex",
      turnIndex: 15,
      status: "completed",
      turnKey: TURN_KEY,
      requestId: "6".repeat(32),
      text: "must reject mismatched billing",
      createdAt: 1_783_944_000_000,
      engineBilling: rootBilling,
    }), /does not match requestId/);
  });

  test("sums root plus mixed nested delegate goal usage exactly once", () => {
    const turn = materializeLosslessTurn({
      sessionId: "web-lossless-123",
      agentId: "main",
      turnIndex: 16,
      status: "completed",
      turnKey: TURN_KEY,
      text: "done",
      createdAt: 1_783_944_000_000,
      goalId: "11111111-1111-4111-8111-111111111111",
      goalStateRevision: 4,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1 },
      agentGroups: [{
        runId: "dlg-root",
        agentId: "worker",
        goal: "work",
        status: "ok",
        completedAt: 1_783_944_000_001,
        goalUsageRecords: [
          { runId: "dlg-root", agentId: "worker", engine: "ccb", inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 },
          { runId: "dlg-child", agentId: "reviewer", engine: "codex", inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 1 },
        ],
      }],
    });
    assert.equal(computeGoalTokensUsed(turn.payload), 36);
    const duplicate = structuredClone(turn.payload);
    (duplicate.agentGroups![0]!.goalUsageRecords as Array<Record<string, unknown>>).push(
      structuredClone((duplicate.agentGroups![0]!.goalUsageRecords as Array<Record<string, unknown>>)[0]!),
    );
    assert.throws(() => computeGoalTokensUsed(duplicate), /duplicate goal usage runId/);
  });
});
