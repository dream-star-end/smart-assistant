import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";
import { boxContinuationCompatibility, boxContinuationRejections } from "../../admin/metrics.js";
import { durableMetricSnapshotForTest } from "../../admin/durableMetricRollups.js";

const published = [{ type: "text" as const, text: "hello\nworld" }];
const expected = { modelToolUseId: "toolu_a", content: published, isError: false,
  contentHash: createHash("sha256").update(JSON.stringify({ content: published, isError: false })).digest("hex") };
const observation = (content: unknown, extra = {}) => ({ type: "user", message: { role: "user",
  content: [{ type: "tool_result", tool_use_id: "toolu_a", content, ...extra }] } });

test("result representation is compared semantically, without changing the published hash", async () => {
  for (const content of ["hello\nworld", published,
    [{ type: "text", text: "hello\n" }, { type: "text", text: "world" }],
    { type: "future_wrapper", content: published },
    [{ type: "text", text: "hello\nworld", future_metadata: { version: 2 } }],
    [{ type: "future_result_reference", reference: "opaque-cli-handle" }],
  ]) {
    const before = structuredClone(expected);
    const verifier = new BoxToolResultEcho([expected]);
    verifier.accept(observation(content));
    await verifier.verifyDeferred();
    verifier.assertComplete();
    assert.deepEqual(expected, before);
  }
});

test("unknown shapes cannot hide known content, ID or error contradictions", () => {
  for (const raw of [
    observation({ type: "future_wrapper", content: [{ type: "text", text: "wrong" }] }),
    observation([{ type: "text", text: "wrong", future_metadata: true }]),
    observation([{ type: "future_ref" }, { type: "text", text: "wrong" }]),
    observation(published, { tool_use_id: "toolu_other", future_metadata: true }),
    observation({ type: "future_ref" }, { is_error: true }),
    observation(null), observation([{ type: "text", text: 4 }]),
  ]) assert.throws(() => new BoxToolResultEcho([expected]).accept(raw), /BOX_TOOL_ECHO_/);
  const verifier = new BoxToolResultEcho([expected]);
  verifier.accept(observation({ type: "future_wrapper", content: published }));
  assert.throws(() => verifier.accept(observation(published)), /BOX_TOOL_ECHO_ID_INVALID/);
  const { content: _content, ...hashOnly } = expected;
  assert.throws(() => new BoxToolResultEcho([hashOnly]).accept(observation({ type: "future_ref" })),
    /BOX_TOOL_ECHO_CONTENT_MISMATCH/);
});

test("unknown shape warnings and rejection reasons are bounded and durably observable", async () => {
  boxContinuationCompatibility.reset(); boxContinuationRejections.reset();
  const previous = process.env.OC_DURABLE_METRIC_ROLLUPS;
  process.env.OC_DURABLE_METRIC_ROLLUPS = "1";
  try {
    const verifier = new BoxToolResultEcho([expected]);
    verifier.accept(observation(published, { new_cli_field: "never-log-this-value" }));
    verifier.assertComplete();
    assert.throws(() => new BoxToolResultEcho([expected]).accept(observation("wrong")), /MISMATCH/);
    const lines: string[] = [];
    boxContinuationCompatibility.render(lines); boxContinuationRejections.render(lines);
    assert.match(lines.join("\n"), /stage="echo".*reason="envelope"|reason="envelope".*stage="echo"/);
    assert.match(lines.join("\n"), /BOX_TOOL_ECHO_CONTENT_MISMATCH/);
    assert.ok(!lines.join("\n").includes("never-log-this-value"));
    const durable = durableMetricSnapshotForTest().filter((item) => item.metric === "box_continuation_decisions");
    assert.ok(durable.some((item) => item.labels.kind === "echo:compatible:envelope" && item.sampleCount > 0));
    assert.ok(durable.some((item) => item.labels.kind === "echo:rejected:BOX_TOOL_ECHO_CONTENT_MISMATCH"));
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "OC_DURABLE_METRIC_ROLLUPS");
    else process.env.OC_DURABLE_METRIC_ROLLUPS = previous;
  }
});
