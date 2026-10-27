import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  hasMeaningfulAutomaticRecoveryProgress,
  shouldDeclineLiveServiceRestartRecovery,
} from "@openclaude/protocol";
import { materializeLosslessTurn } from "../http/losslessTurnTape.js";
import {
  applyServiceRestartFold,
  foldServiceRestartLiveFrames,
  isSyntheticServiceRestartPayload,
} from "../db/serviceRestartLiveFold.js";

// Shape of gateway buildSyntheticCrashedTapePayload after the sink adds turnKey.
const synthetic = {
  agentId: "main",
  sessionId: "webocv5646fold",
  turnIndex: 2,
  clientMessageId: "m-ocv5-646",
  status: "crashed",
  turnKey: "a".repeat(64),
  createdAt: 1_793_102_341_000,
  text: "",
  errorCode: "SERVICE_RESTART",
  errorDetail: "任务因服务重启中断，此前已生成的过程已完整保留",
  dispatchId: "d70edbec-2cb4-4054-aab2-23f84ca7fbd6",
  attemptNo: 1,
};

const frame = (frameSeq: number, ...blocks: Array<Record<string, unknown>>) =>
  ({ type: "outbound.message", frameSeq, blocks });

describe("OCV5-646 SERVICE_RESTART live-frame fold", () => {
  test("only the bare boot-recovery tape qualifies", () => {
    assert.equal(isSyntheticServiceRestartPayload(synthetic), true);
    assert.equal(isSyntheticServiceRestartPayload({ ...synthetic, text: "partial" }), false);
    assert.equal(isSyntheticServiceRestartPayload({ ...synthetic, errorCode: "ENGINE_ERROR" }), false);
    assert.equal(isSyntheticServiceRestartPayload({ ...synthetic, status: "interrupted" }), false);
    assert.equal(isSyntheticServiceRestartPayload({ ...synthetic, tools: [] }), false);
    assert.equal(isSyntheticServiceRestartPayload({ ...synthetic, thinkingText: "x" }), false);
  });

  test("folds deltas, pairs tools, skips control frames and replayed seqs", () => {
    const folded = foldServiceRestartLiveFrames([
      frame(1, { kind: "thinking", text: "先核对", messageId: "m1" }),
      frame(2, { kind: "thinking", text: "故障", messageId: "m1" }),
      frame(3, { kind: "text", text: "要根治，", messageId: "m1" }),
      frame(3, { kind: "text", text: "要根治，", messageId: "m1" }),
      frame(4, { kind: "text", text: "不能只加重试。", messageId: "m1" }),
      frame(5, { kind: "tool_use", blockId: "tu-1", toolName: "Bash", inputJson: { command: "ls" }, inputPreview: "ls" }),
      { type: "outbound.permission_request", frameSeq: 6, requestId: "p1" },
      frame(7, { kind: "tool_result", toolUseBlockId: "tu-1", output: "a.ts" }),
      frame(8, { kind: "tool_use", blockId: "tu-2", toolName: "Read", inputPreview: "b.ts" }),
      frame(9, { kind: "text", text: "Failed to authenticate. API Error: 403", messageId: "m2" }),
    ]);
    assert.equal(folded.thinkingText, "先核对故障");
    assert.equal(folded.text, "要根治，不能只加重试。\n\nFailed to authenticate. API Error: 403");
    assert.deepEqual(folded.tools, [
      { blockId: "tu-1", toolName: "Bash", inputJson: { command: "ls" }, inputPreview: "ls", output: "a.ts", isError: false, completed: true },
      { blockId: "tu-2", toolName: "Read", inputPreview: "b.ts", output: "", isError: false, completed: false },
    ]);
  });

  test("clips oversized tool text and drops oversized input JSON", () => {
    const big = "x".repeat(70 * 1024);
    const [tool] = foldServiceRestartLiveFrames([
      frame(1, { kind: "tool_use", blockId: "tu", toolName: "Write", inputJson: { content: big }, inputPreview: big }),
      frame(2, { kind: "tool_result", toolUseBlockId: "tu", output: big }),
    ]).tools;
    assert.equal(tool!.inputJson, undefined);
    assert.ok(tool!.output.length < 65 * 1024 && tool!.output.endsWith("(已截断)"));
    assert.ok(tool!.inputPreview.length < 65 * 1024);
  });

  test("nothing streamed → the synthetic payload is returned unchanged", () => {
    const folded = foldServiceRestartLiveFrames([{ type: "outbound.permission_request" }]);
    assert.equal(applyServiceRestartFold(synthetic, folded), synthetic);
  });

  test("materialized records keep the answer, the restart code and the billing anchor", () => {
    const bare = materializeLosslessTurn(synthetic);
    const turn = materializeLosslessTurn(applyServiceRestartFold(synthetic, foldServiceRestartLiveFrames([
      frame(1, { kind: "thinking", text: "先核对", messageId: "m1" }),
      frame(2, { kind: "text", text: "要根治。", messageId: "m1" }),
      frame(3, { kind: "tool_use", blockId: "tu-1", toolName: "Bash", inputPreview: "ls" }),
    ])));
    assert.equal(turn.billingAnchorId, bare.billingAnchorId);
    assert.deepEqual(turn.records.map((record) => record.role), ["thinking", "tool", "assistant"]);
    const answer = turn.records.at(-1)!.payload as Record<string, unknown>;
    assert.equal(answer.text, "要根治。");
    assert.equal(answer._errorCode, "SERVICE_RESTART");
    assert.equal(answer._errorDetail, synthetic.errorDetail);
    assert.equal((turn.records[1]!.payload as Record<string, unknown>).partial, true);

    // Once prune has removed the frames, the tape alone still shows progress,
    // so automatic recovery keeps declining a turn that had real output.
    const records = turn.records.map((record) => record.payload);
    assert.equal(hasMeaningfulAutomaticRecoveryProgress(records), true);
    assert.equal(shouldDeclineLiveServiceRestartRecovery({ errorCode: "SERVICE_RESTART", records }), true);
    assert.equal(
      hasMeaningfulAutomaticRecoveryProgress(bare.records.map((record) => record.payload)),
      false,
    );
  });
});
