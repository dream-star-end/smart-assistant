import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  jobAuthorityFromSettlement,
  parseRequeueArgs,
  planTapeRequeue,
  settlementJobMatchesTapeAuthority,
  type TapeJobSnapshot,
} from "../ops/requeue-failed-tape-jobs.ts";

function snapshot(over: Partial<TapeJobSnapshot> = {}): TapeJobSnapshot {
  return {
    tapeId: "tape-1",
    sessionId: "sess-1",
    userId: "c:1",
    materializationStatus: "failed",
    materializationError: "unsupported Unicode escape sequence",
    settlementVerifiedAt: null,
    billingAnchorId: "srv-a",
    requestId: "r1",
    engineBillings: [{ requestId: "r1", model: "x" }],
    settlementHash: "h1",
    matJob: { jobId: "m1", status: "failed", lastError: "unsupported Unicode escape sequence" },
    settlementJobs: [{
      jobId: "s1",
      kind: "billing",
      status: "held",
      lastError: "awaiting_materialization",
      billingAnchorId: "srv-a",
      requestId: "r1",
      payload: { engineBillings: [{ requestId: "r1", model: "x" }] },
      settlementHash: "h1",
    }],
    ...over,
  };
}

describe("requeue-failed-tape-jobs planner", () => {
  test("parseRequeueArgs defaults to dry-run", () => {
    const parsed = parseRequeueArgs(["--tape", "abc", "--plan-tapes"]);
    assert.equal(parsed.execute, false);
    assert.deepEqual(parsed.tapes, ["abc"]);
    assert.equal(parsed.planTapes, true);
    assert.equal(parseRequeueArgs(["--execute"]).execute, true);
  });

  test("stage 1 requeues materialization; stage 2 skips when settlement is unverified", () => {
    const decisions = planTapeRequeue(snapshot());
    assert.deepEqual(
      decisions.map((d) => d.action + ":" + ("reason" in d ? d.reason : "")),
      ["requeue_materialization:", "skip:settlement_not_verified"],
    );
  });

  test("complete materialization is not requeued", () => {
    const decisions = planTapeRequeue(snapshot({
      materializationStatus: "complete",
      matJob: { jobId: "m1", status: "complete", lastError: null },
    }));
    assert.equal(decisions[0]?.action, "skip");
    assert.equal(decisions[0] && "reason" in decisions[0] ? decisions[0].reason : "", "materialization_complete");
  });

  test("verified matching billing job is kind-precise requeued", () => {
    const decisions = planTapeRequeue(snapshot({
      settlementVerifiedAt: "2026-08-19T00:00:00.000Z",
      settlementJobs: [{
        jobId: "s1",
        kind: "billing",
        status: "failed",
        lastError: "transient",
        billingAnchorId: "srv-a",
        requestId: "r1",
        payload: { engineBillings: [{ model: "x", requestId: "r1" }] },
        settlementHash: "h1",
      }],
    }));
    assert.equal(decisions.some((d) => d.action === "requeue_settlement" && d.kind === "billing"), true);
  });

  test("verified mismatched authority stops at manual_reconcile", () => {
    const job = snapshot().settlementJobs[0]!;
    const mismatched = {
      ...job,
      billingAnchorId: "srv-WRONG",
      status: "failed" as const,
    };
    assert.equal(
      settlementJobMatchesTapeAuthority(mismatched, snapshot()),
      false,
    );
    const decisions = planTapeRequeue(snapshot({
      settlementVerifiedAt: "2026-08-19T00:00:00.000Z",
      settlementJobs: [mismatched],
    }));
    assert.equal(decisions.at(-1)?.action, "manual_reconcile");
    assert.equal(decisions.at(-1) && "reason" in decisions.at(-1)! ? decisions.at(-1).reason : "", "settlement_authority_mismatch");
  });

  test("job authority prefers column then payload", () => {
    assert.deepEqual(
      jobAuthorityFromSettlement({
        jobId: "s1",
        kind: "billing",
        status: "failed",
        lastError: null,
        billingAnchorId: null,
        requestId: null,
        payload: { billingAnchorId: "srv-a", requestId: "r1", engineBillings: [1] },
        settlementHash: null,
      }),
      { billingAnchorId: "srv-a", requestId: "r1", engineBillings: [1] },
    );
  });
});
