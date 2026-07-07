import { describe, expect, it } from "vitest";
import { pickResumableTrainRun } from "./skillTrainReentry";
import type { SkillTrainRun } from "./types";

function run(over: Partial<SkillTrainRun>): SkillTrainRun {
  return {
    runId: "r",
    skillName: "coding-suite",
    status: "diff_ready",
    phase: "diff_ready",
    proposalCount: 1,
    toolCalls: 3,
    error: null,
    summary: null,
    startedAt: 1000,
    finishedAt: null,
    ...over,
  };
}

describe("pickResumableTrainRun", () => {
  it("recovers a diff_ready run as a draft entry", () => {
    const picked = pickResumableTrainRun([run({ runId: "a", status: "diff_ready" })], "coding-suite");
    expect(picked).toEqual({ run: expect.objectContaining({ runId: "a" }), kind: "draft" });
  });

  it("recovers running / queued runs as active (resume polling)", () => {
    expect(pickResumableTrainRun([run({ status: "running" })], "coding-suite")?.kind).toBe("active");
    expect(pickResumableTrainRun([run({ status: "queued" })], "coding-suite")?.kind).toBe("active");
  });

  it("ignores terminal runs (merged / discarded / failed)", () => {
    for (const status of ["merged", "discarded", "failed"] as const) {
      expect(pickResumableTrainRun([run({ status })], "coding-suite")).toBeNull();
    }
  });

  it("only matches the current skill (skips other skills and null skillName)", () => {
    const runs = [
      run({ runId: "other", skillName: "office-suite", status: "diff_ready" }),
      run({ runId: "auto", skillName: null, status: "running" }),
    ];
    expect(pickResumableTrainRun(runs, "coding-suite")).toBeNull();
  });

  it("picks the most recent resumable run by startedAt", () => {
    const runs = [
      run({ runId: "old", status: "diff_ready", startedAt: 1000 }),
      run({ runId: "new", status: "running", startedAt: 5000 }),
      run({ runId: "mid", status: "diff_ready", startedAt: 3000 }),
    ];
    const picked = pickResumableTrainRun(runs, "coding-suite");
    expect(picked?.run.runId).toBe("new");
    expect(picked?.kind).toBe("active");
  });

  it("returns null when there are no runs", () => {
    expect(pickResumableTrainRun([], "coding-suite")).toBeNull();
  });
});
