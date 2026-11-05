import test from "node:test";
import assert from "node:assert/strict";
import { allowUnsafeAutomaticCheckpoint, assessTurnRecoveryTape } from "@openclaude/protocol";
import { makeDelegateProgressBlock, toNestedDelegateProgressLine } from "../../../gateway/src/delegateProgress.js";
import { leftoverFramesToRecoveryRecords } from "../db/sessionRecoveryEvidence.js";
import { filterMonotonicLiveFramePayloads } from "../dispatch/leftoverFrameFence.js";

const progress = (phase: Parameters<typeof makeDelegateProgressBlock>[0]["phase"], executionId = "execution-a") =>
  makeDelegateProgressBlock({ runId: executionId, usageRunId: executionId, agentId: "worker", phase, text: "synthetic progress" });
const frame = (block: unknown, frameSeq?: number) => ({ type: "outbound.message", blocks: [block],
  ...(frameSeq === undefined ? {} : { frameSeq }) });
const project = (...blocks: unknown[]) => leftoverFramesToRecoveryRecords(blocks.map(block => frame(block)));
const completedTape = [{ role: "tool", toolUseId: "toolu_saved", toolName: "Bash", _completed: true,
  status: "completed", text: "persisted result" },
  { role: "assistant", text: "API Error: 503", _errorCode: "upstream_failed" }];
const eligible = (records: readonly unknown[]) => allowUnsafeAutomaticCheckpoint({
  status: "completed", errorCode: "upstream_failed", leftoverBacked: false,
  records: [...completedTape, ...records] });

test("real producer start then done supersedes its older pending frame for the existing settled-tools checkpoint", () => {
  const start = progress("start"), done = progress("done");
  assert.equal(start.usageRunId, start.runId);
  const records = project(start, done);
  assert.deepEqual(records, [{ role: "delegate-progress", _completed: true }]);
  assert.equal(assessTurnRecoveryTape(completedTape).checkpointSafe, false);
  assert.equal(eligible(records), true);
});

test("only done completes; errors, activity and unknown metadata remain pending", () => {
  for (const last of [progress("error"), progress("start"), progress("text"), progress("tool"),
    { ...progress("done"), phase: "unknown", _completed: true },
    { ...progress("done"), phase: undefined, _completed: true }]) {
    assert.equal(eligible(project(progress("start"), last)), false);
  }
});

test("display rebinding cannot change execution identity or complete a different execution", () => {
  assert.equal(eligible(project(progress("start"), { ...progress("done"), runId: "other-card", agentId: "other-agent" })), true);
  const different = { ...progress("done", "execution-b"), runId: "execution-a", agentId: "worker" };
  assert.equal(eligible(project(progress("start"), different)), false);
  const child = progress("done", "execution-child");
  const nested = toNestedDelegateProgressLine(child, { runId: "execution-a", agentId: "worker", label: "parent-child" });
  assert.equal(nested?.phase, "text");
  assert.equal(nested?.usageRunId, child.usageRunId);
  assert.equal(eligible(project(progress("start"), nested)), false);
  const richNested = toNestedDelegateProgressLine({ ...child, block: { kind: "text", text: "child answer" } },
    { runId: "execution-a", agentId: "worker", label: "parent-child" });
  assert.equal(eligible(project(progress("start"), richNested)), false);
});

test("real phase frames with absent or malformed execution keys never borrow completion", () => {
  for (const usageRunId of [undefined, null, "", " ", "contains space", "x".repeat(257), 7]) {
    assert.equal(eligible(project({ ...progress("done"), usageRunId, _completed: true })), false);
    assert.equal(eligible(project({ ...progress("start"), usageRunId }, progress("done"))), false);
  }
});

test("usage alone never creates or changes process state; an execution block in usage remains blocking", () => {
  const usage = { ...progress("usage"), usage: { inputTokens: 1 } };
  assert.deepEqual(project(usage), []);
  assert.equal(eligible(project(progress("start"), progress("done"), usage)), true);
  assert.equal(eligible(project(progress("start"), usage)), false);
  for (const block of [null, { kind: "tool_use", id: "toolu_running" }]) {
    assert.equal(eligible(project(progress("start"), progress("done"), { ...usage, block })), false);
  }
});

test("a later genuine start or activity reopens the same execution despite earlier done", () => {
  for (const phase of ["start", "tool", "thinking", "plan"] as const) {
    assert.equal(eligible(project(progress("start"), progress("done"), progress(phase))), false);
  }
});

test("legacy completion remains independent and cannot supersede a real pending execution", () => {
  assert.deepEqual(project({ kind: "delegate_progress", _completed: true }),
    [{ role: "delegate-progress", _completed: true }]);
  assert.equal(eligible(project(progress("start"), { ...progress("done"), phase: undefined, _completed: true })), false);
  const legacy = { kind: "delegate_progress", usageRunId: "execution-a", _completed: true };
  assert.equal(eligible(project(progress("start"), legacy)), false);
});

test("the existing caller fence orders sequence numbers and drops duplicates before projection", () => {
  const records = leftoverFramesToRecoveryRecords(filterMonotonicLiveFramePayloads([
    frame(progress("done"), 3), frame(progress("start"), 1),
    frame(progress("error"), 3), frame(progress("tool"), 2),
  ]));
  assert.equal(eligible(records), true);
  assert.equal(eligible(leftoverFramesToRecoveryRecords(filterMonotonicLiveFramePayloads([
    frame(progress("done"), 3), frame(progress("start"), 4),
  ]))), false);
});

test("OCV5-716: nested grandchild start -> tool -> done settles its own execution once parent also completes", () => {
  const routing = { runId: "execution-a", agentId: "worker", label: "worker↳grandchild" };
  const nestedStart = toNestedDelegateProgressLine(progress("start", "execution-grandchild"), routing);
  const nestedTool = toNestedDelegateProgressLine(progress("tool", "execution-grandchild"), routing);
  const nestedDone = toNestedDelegateProgressLine(progress("done", "execution-grandchild"), routing);
  assert.equal(nestedDone?.phase, "text");
  assert.equal(nestedDone?.nestedPhase, "done");
  assert.equal(nestedDone?.usageRunId, "execution-grandchild");
  // While parent execution-a is still running, nestedDone alone does not make the turn eligible.
  assert.equal(eligible(project(progress("start", "execution-a"), nestedStart, nestedTool, nestedDone)), false);
  // Once parent execution-a also emits done, both executions are settled and checkpoint is eligible.
  const settled = project(
    progress("start", "execution-a"),
    nestedStart,
    nestedTool,
    nestedDone,
    progress("done", "execution-a"),
  );
  assert.deepEqual(settled, [
    { role: "delegate-progress", _completed: true },
    { role: "delegate-progress", _completed: true },
  ]);
  assert.equal(eligible(settled), true);
});

test("OCV5-717: loadLeftoverRecoveryRecords queries limit+1 and fails closed when leftover stream is truncated", async () => {
  const {
    loadLeftoverRecoveryRecords,
    mergeTapeAndLeftoverRecoveryAssessment,
    isLeftoverRecoveryRecordsTruncated,
  } = await import("../db/sessionRecoveryEvidence.js");
  const seenParams: unknown[][] = [];
  const fakeClient = {
    query: async (_sql: string, params: unknown[]) => {
      seenParams.push(params);
      const limitPlusOne = Number(params[3]);
      const rows = Array.from({ length: limitPlusOne }, (_, idx) => ({
        payload: Buffer.from(
          JSON.stringify(
            frame(
              idx === 0 ? progress("start", "exec-1") : progress("done", "exec-1"),
              idx + 1,
            ),
          ),
          "utf8",
        ),
      }));
      return { rows };
    },
  };
  const truncatedRecords = await loadLeftoverRecoveryRecords(
    fakeClient as never,
    "sess-trunc",
    "c:3",
    "cm-trunc",
    5,
  );
  assert.equal(seenParams[0]?.[3], 6);
  assert.equal(isLeftoverRecoveryRecordsTruncated(truncatedRecords), true);
  assert.equal(eligible(truncatedRecords), false);
  const merged = mergeTapeAndLeftoverRecoveryAssessment(completedTape, truncatedRecords);
  assert.equal(merged.mode, "checkpoint");
  assert.equal(merged.checkpointSafe, false);
});
