import test from "node:test";
import assert from "node:assert/strict";
import { boxFailureFromError, parseBoxFirstFailure, summarizeBoxFailureValue } from "./boxFailureEvidence.js";

test("Box first failure envelope rejects raw content and unbounded metadata", () => {
  const evidence = { version: 1, observedAtMs: 1_793_620_000_000,
    code: "BOX_CLI_UPSTREAM_REFUSED", phase: "continuation",
    diagnostic: { branch: "synthetic_api_error", upstreamTag: "authentication_failed",
      upstreamStatus: 401, observedBytes: 12, observedSha256: "a".repeat(64) } };
  assert.deepEqual(parseBoxFirstFailure(evidence), evidence);
  for (const changed of [
    { ...evidence, text: "private output" }, { ...evidence, code: "private output" },
    { ...evidence, phase: "private output" }, { ...evidence, observedAtMs: Number.NaN },
    { ...evidence, diagnostic: { raw: "private output" } },
    { ...evidence, diagnostic: { upstreamTag: "private output" } },
    { ...evidence, diagnostic: { observedBytes: -1 } },
    { ...evidence, diagnostic: { expectedBlocks: 100_001 } },
    { ...evidence, diagnostic: { upstreamStatus: 600 } },
    { ...evidence, diagnostic: { observedSha256: "private output" } },
  ]) assert.equal(parseBoxFirstFailure(changed), null);
});

test("Box error projection preserves only a named code and validated diagnostic", () => {
  const err = Object.assign(new Error("private synthetic API text"), {
    code: "BOX_TOOL_SNAPSHOT_MISMATCH",
    boxFailureDiagnostic: { branch: "snapshot_coverage", expectedBlocks: 2, observedBlocks: 1 },
    cause: { token: "private-token" },
  });
  assert.deepEqual(boxFailureFromError(err, "continuation"), {
    code: "BOX_TOOL_SNAPSHOT_MISMATCH", phase: "continuation",
    diagnostic: { branch: "snapshot_coverage", expectedBlocks: 2, observedBlocks: 1 },
  });
  assert.equal(boxFailureFromError(new Error("private text"), "proxy_stream"), null);
  assert.deepEqual(boxFailureFromError(Object.assign(new Error("private text"), {
    code: "BOX_SPOOL_WORKER_FAILED", boxFailureDiagnostic: { raw: "private text" },
  }), "remote_terminal"), { code: "BOX_SPOOL_WORKER_FAILED", phase: "remote_terminal" });
  assert.ok(!JSON.stringify(boxFailureFromError(err, "continuation")).includes("private"));
});

test("Box diagnostic summary emits type, length and hash without retaining content", () => {
  const summary = summarizeBoxFailureValue("private output");
  assert.equal(summary.type, "text");
  assert.equal(summary.bytes, 14);
  assert.match(String(summary.sha256), /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(summary).includes("private"));
  const cycle: Record<string, unknown> = { type: "tool_use" }; cycle.self = cycle;
  assert.deepEqual(summarizeBoxFailureValue(cycle), { type: "tool_use" });
  assert.deepEqual(summarizeBoxFailureValue(undefined), { type: "missing" });
});

test("the existing unproven-terminal code is preserved without broadening the error allowlist", () => {
  const code = "BOX_TOOL_TERMINAL_UNPROVEN";
  assert.deepEqual(boxFailureFromError(Object.assign(new Error(code), { code }), "first_round"),
    { code, phase: "first_round" });
  assert.equal(boxFailureFromError(new Error(`${code}: private detail`), "first_round"), null);
  assert.equal(boxFailureFromError({ code: "BOX_TOOL_OTHER_UNPROVEN" }, "first_round"), null);
});

test("today's exact Box tool, Exec417 and compact failures survive bounded first-error projection", () => {
  const cases = [
    ["BOX_TOOL_INPUT_INVALID", undefined],
    ["BOX_TOOL_ORDER_INVALID", undefined],
    ["BOX_EXEC_HTTP_417", { branch: "exec_http", upstreamStatus: 417 }],
    ["BOX_CLI_COMPACT_BOUNDARY_INVALID", { branch: "compact_boundary" }],
  ] as const;
  for (const [code, diagnostic] of cases) {
    const error = Object.assign(new Error("private model or HTTP response"), {
      code, cause: { input: "private arguments", token: "private credential" },
    });
    const projected = boxFailureFromError(error, "continuation");
    const expected = { code, phase: "continuation", ...(diagnostic ? { diagnostic } : {}) };
    assert.deepEqual(projected, expected);
    assert.deepEqual(parseBoxFirstFailure({ version: 1, observedAtMs: 100, ...expected }),
      { version: 1, observedAtMs: 100, ...expected });
    assert.ok(!JSON.stringify(projected).includes("private"));
  }
  for (const code of ["BOX_EXEC_HTTP_418", "BOX_EXEC_HTTP_417: private", "BOX_TOOL_ORDER_INVALID_OTHER"])
    assert.equal(boxFailureFromError({ code }, "continuation"), null);
});

test("tool-order state metadata accepts only fixed events and the five decoder bits", () => {
  const base = { version: 1, observedAtMs: 100, code: "BOX_TOOL_ORDER_INVALID", phase: "first_round" };
  for (const eventType of ["message_start", "content_block_start", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop"]) {
    for (const stateFlags of [0, 31]) {
      const diagnostic = { branch: "tool_event_order", eventType, stateFlags, blockIndex: 0 };
      assert.deepEqual(parseBoxFirstFailure({ ...base, diagnostic }), { ...base, diagnostic });
    }
  }
  for (const diagnostic of [
    { branch: "tool_event_order", eventType: "private-tool-name" },
    ...[-1, 32, 1.5, Number.NaN, "1"].map((stateFlags) => ({ branch: "tool_event_order", stateFlags })),
    { branch: "tool_event_order", args: "private arguments" },
    { branch: "private branch", stateFlags: 1 },
  ]) assert.equal(parseBoxFirstFailure({ ...base, diagnostic }), null);
  const diagnostic = { branch: "resume_publish", upstreamStatus: 417 };
  assert.deepEqual(parseBoxFirstFailure({ ...base, code: "BOX_EXEC_HTTP_417", diagnostic }),
    { ...base, code: "BOX_EXEC_HTTP_417", diagnostic });
});
