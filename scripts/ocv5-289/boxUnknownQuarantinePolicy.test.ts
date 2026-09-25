import test from "node:test";
import assert from "node:assert/strict";
import { assessUnknownProbeQuarantine } from "./boxUnknownQuarantinePolicy.js";

const observed = { run: { present: true, kind: "dir", mode: 0o700, ageSec: 11000 },
  proof: { present: true, kind: "dir", mode: 0o700 },
  terminal: { present: false },
  runEntries: { present: true, count: 5, pendingCount: 0,
    resultCount: 0, unexpectedCount: 0 },
  stream: { present: true, stdoutBytes: 32514, stderrBytes: 0,
    stdoutSha256: "a".repeat(64), partialLine: false, truncated: false,
    resultCount: 1, lastType: "result", lastResultSubtype: "success",
    lastResultIsError: true, invalidCount: 0, unrecognizedCount: 0,
    toolUseCount: 0, toolResultCount: 0 },
  processes: { matches: [], claudeLikeCount: 1,
    claudeLike: [{ name: "claude", ageSec: 85000 }], scanned: 200,
    unreadableYoung: 0, cmdlineTruncated: false, fdTruncated: false,
    incomplete: true },
};
const input = { observed, runNonce: "b".repeat(24),
  lockSha256: "c".repeat(64), nowMs: 1_790_000_000_000 };

test("old synthetic terminal error requires two stable observations and never claims keeper proof", () => {
  const first = assessUnknownProbeQuarantine(input);
  assert.equal(first.ready, false);
  assert.equal(assessUnknownProbeQuarantine({ ...input,
    nowMs: input.nowMs + 61_000,
    observed: { ...observed, run: { ...observed.run, ageSec: 11061 } },
    previous: first.snapshot }).ready, true);
  assert.throws(() => assessUnknownProbeQuarantine({ ...input,
    nowMs: input.nowMs + 59_000, previous: first.snapshot }),
  /BOX_UNKNOWN_QUARANTINE_OBSERVATION_CHANGED/);
});

test("active, unreadable-young, changed or tool-bearing runs remain locked", () => {
  for (const variant of [
    { processes: { ...observed.processes, matches: [{ pid: 42 }] } },
    { processes: { ...observed.processes, unreadableYoung: 1 } },
    { processes: { ...observed.processes, claudeLike:
      [{ name: "claude", ageSec: 100 }] } },
    { stream: { ...observed.stream, toolUseCount: 1 } },
    { stream: { ...observed.stream, invalidCount: 1 } },
    { stream: { ...observed.stream, unrecognizedCount: 1 } },
    { stream: { ...observed.stream, lastResultSubtype: null } },
    { stream: { ...observed.stream, lastResultIsError: false } },
    { stream: { ...observed.stream, truncated: true } },
    { runEntries: { ...observed.runEntries, pendingCount: 1 } },
    { terminal: { present: true } },
  ]) {
    assert.throws(() => assessUnknownProbeQuarantine({ ...input,
      observed: { ...observed, ...variant } }),
    /BOX_UNKNOWN_QUARANTINE_EVIDENCE_INVALID/);
  }
  const first = assessUnknownProbeQuarantine(input);
  assert.throws(() => assessUnknownProbeQuarantine({ ...input,
    nowMs: input.nowMs + 61_000,
    observed: { ...observed, run: { ...observed.run, ageSec: 11061 },
      stream: { ...observed.stream, stdoutSha256: "d".repeat(64) } },
    previous: first.snapshot }),
  /BOX_UNKNOWN_QUARANTINE_OBSERVATION_CHANGED/);
});
