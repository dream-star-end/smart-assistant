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
    { ...evidence, phase: "private output" }, { ...evidence, observedAtMs: NaN },
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


test("proven subscription window metadata survives the existing first-failure envelope", () => {
  const evidence = { version: 1, code: "BOX_CLI_QUOTA_EXHAUSTED", phase: "continuation", observedAtMs: 1_790_000_000_000,
    diagnostic: { branch: "synthetic_api_error", upstreamTag: "rate_limit", quotaWindow: "five_hour", quotaResetAtMs: 1_791_300_000_000 } };
  assert.deepEqual(parseBoxFirstFailure(evidence), evidence);
  for (const changed of [{ quotaWindow: "minute" }, { quotaResetAtMs: NaN }, { quotaResetAtMs: -1 }, { quotaResetAtMs: 9e20 }]) {
    assert.equal(parseBoxFirstFailure({ ...evidence, diagnostic: { ...evidence.diagnostic, ...changed } }), null);
  }
  assert.deepEqual(boxFailureFromError({ code: evidence.code, boxFailureDiagnostic: evidence.diagnostic }, "continuation"),
    { code: evidence.code, phase: "continuation", diagnostic: evidence.diagnostic });
});
