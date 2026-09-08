import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  executeTapeRequeueInTransaction,
  isProductionDatabaseTarget,
  jobAuthorityFromSettlement,
  loadTapeJobSnapshot,
  parseRequeueArgs,
  planLateDelegateContinuation,
  planLateDelegateGroupHash,
  planLateDelegateSnapshot,
  planTapeRequeue,
  resolveTapeIdentities,
  settlementJobMatchesTapeAuthority,
  type TapeJobSnapshot,
} from "../ops/requeue-failed-tape-jobs.ts";

function snapshot(over: Partial<TapeJobSnapshot> = {}): TapeJobSnapshot {
  return {
    tapeId: "tape-1",
    sessionId: "sess-1",
    userId: "c:1",
    turnKey: "a".repeat(64),
    waiveReason: "idle_timeout",
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
    assert.equal(parsed.planLateDelegateContinuations, false);
    assert.equal(parseRequeueArgs(["--execute"]).execute, true);
    assert.equal(parseRequeueArgs(["--user", "c:9"]).userId, "c:9");
    assert.equal(
      parseRequeueArgs(["--plan-late-delegate-continuations"]).planLateDelegateContinuations,
      true,
    );
  });

  test("late-delegate planner: exact owner → continuation; missing root is retryable skip", () => {
    const owner = "b".repeat(64);
    const billing = {
      requestId: "d".repeat(32),
      parentTurnKey: owner,
      parentSessionId: "sess-1",
    };
    const ready = planLateDelegateContinuation({
      tapeId: "tape-late",
      sessionId: "sess-1",
      group: { runId: "dlg-1", engineBillings: [billing] },
      tapeTurnKey: "c".repeat(64),
      root: { sessionId: "sess-1", turnKey: owner, finalized: true },
    });
    assert.equal(ready.action, "continuation");
    const waiting = planLateDelegateContinuation({
      tapeId: "tape-late",
      sessionId: "sess-1",
      group: { runId: "dlg-1", engineBillings: [billing] },
      tapeTurnKey: "c".repeat(64),
      root: null,
    });
    assert.equal(waiting.action, "skip");
    assert.equal(waiting.reason, "root_tape_missing_retryable");
    const unfinalized = planLateDelegateContinuation({
      tapeId: "tape-late",
      sessionId: "sess-1",
      group: { runId: "dlg-1", engineBillings: [billing] },
      root: { sessionId: "sess-1", turnKey: owner, finalized: false },
    });
    assert.equal(unfinalized.action, "skip");
    assert.equal(unfinalized.reason, "root_not_finalized_retryable");
    const cross = planLateDelegateContinuation({
      tapeId: "tape-late",
      sessionId: "sess-1",
      group: { runId: "dlg-1", engineBillings: [{ ...billing, parentSessionId: "other" }] },
      root: { sessionId: "sess-1", turnKey: owner, finalized: true },
    });
    assert.equal(cross.action, "manual_reconcile");
    assert.equal(cross.reason, "cross_session_locator");
    const mixed = planLateDelegateContinuation({
      tapeId: "tape-late",
      sessionId: "sess-1",
      group: {
        runId: "dlg-1",
        engineBillings: [
          billing,
          { ...billing, parentTurnKey: "c".repeat(64), requestId: "e".repeat(32) },
        ],
      },
      root: { sessionId: "sess-1", turnKey: owner, finalized: true },
    });
    assert.equal(mixed.action, "manual_reconcile");
    assert.equal(mixed.reason, "mixed_billing_locators");
    assert.equal(mixed.requestIds.length, 2);
    assert.equal(mixed.billingLocators.length, 2);
  });

  test("snapshot planner emits missing/unchecked instead of empty plans[]", () => {
    const owner = "b".repeat(64);
    const plans = planLateDelegateSnapshot({
      snapshot: {
        tapes: [{
          tapeId: "tape-present",
          sessionId: "sess-1",
          turnKey: "c".repeat(64),
          inspected: false,
          groups: [{
            runId: "dlg-1",
            engineBillings: [{
              requestId: "d".repeat(32),
              parentTurnKey: owner,
              parentSessionId: "sess-1",
            }],
          }],
          root: { sessionId: "sess-1", turnKey: owner, finalized: true },
        }],
      },
      tapeIds: ["tape-missing", "tape-present"],
    });
    assert.equal(plans.length, 2);
    assert.equal(plans[0]?.reason, "snapshot_tape_missing");
    assert.equal(plans[1]?.reason, "snapshot_not_inspected");
    assert.notEqual(plans.length, 0);
  });

  test("planner group hash covers transcript/result/status and fence is per-requestId", () => {
    const owner = "b".repeat(64);
    const billingA = { requestId: "bill-a", parentTurnKey: owner, parentSessionId: "sess-1" };
    const billingB = { requestId: "bill-b", parentTurnKey: owner, parentSessionId: "sess-1" };
    const baseGroup = {
      runId: "dlg-1",
      status: "ok",
      resultSummary: "one",
      transcript: [{ kind: "text", text: "payload-A" }],
      engineBillings: [billingA, billingB],
    };
    const hashA = planLateDelegateGroupHash(baseGroup);
    const hashB = planLateDelegateGroupHash({
      ...baseGroup,
      transcript: [{ kind: "text", text: "payload-B" }],
    });
    const hashStatus = planLateDelegateGroupHash({ ...baseGroup, status: "failed" });
    const hashResult = planLateDelegateGroupHash({ ...baseGroup, resultSummary: "two" });
    assert.notEqual(hashA, hashB);
    assert.notEqual(hashA, hashStatus);
    assert.notEqual(hashA, hashResult);
    assert.equal(planLateDelegateGroupHash({ ...baseGroup, _ocEventOrdinal: 9 }), hashA);

    const none = planLateDelegateSnapshot({
      snapshot: {
        tapes: [{
          tapeId: "t1",
          sessionId: "sess-1",
          turnKey: "c".repeat(64),
          groups: [baseGroup],
          root: { sessionId: "sess-1", turnKey: owner, finalized: true },
          settlementFence: { requestIds: [] },
        }],
      },
      tapeIds: ["t1"],
    })[0];
    assert.equal(none?.action, "continuation");
    assert.deepEqual(none?.fence, [
      { requestId: "bill-a", inspected: true, matched: false },
      { requestId: "bill-b", inspected: true, matched: false },
    ]);

    const partial = planLateDelegateSnapshot({
      snapshot: {
        tapes: [{
          tapeId: "t1",
          sessionId: "sess-1",
          turnKey: "c".repeat(64),
          groups: [baseGroup],
          root: { sessionId: "sess-1", turnKey: owner, finalized: true },
          settlementFence: { requestIds: ["bill-a"] },
        }],
      },
      tapeIds: ["t1"],
    })[0];
    assert.equal(partial?.action, "skip");
    assert.equal(partial?.reason, "partial_request_fence");
    assert.equal(partial?.fence.filter((entry) => entry.matched).length, 1);
    assert.equal(partial?.fence.filter((entry) => !entry.matched).length, 1);

    const all = planLateDelegateSnapshot({
      snapshot: {
        tapes: [{
          tapeId: "t1",
          sessionId: "sess-1",
          turnKey: "c".repeat(64),
          groups: [baseGroup],
          root: { sessionId: "sess-1", turnKey: owner, finalized: true },
          settlementFence: { requestIds: ["bill-a", "bill-b"] },
        }],
      },
      tapeIds: ["t1"],
    })[0];
    assert.equal(all?.action, "skip");
    assert.equal(all?.reason, "request_already_on_root");
    assert.equal(all?.fence.every((entry) => entry.inspected && entry.matched), true);

    const unchecked = planLateDelegateSnapshot({
      snapshot: {
        tapes: [{
          tapeId: "t1",
          sessionId: "sess-1",
          turnKey: "c".repeat(64),
          groups: [baseGroup],
          root: { sessionId: "sess-1", turnKey: owner, finalized: true },
        }],
      },
      tapeIds: ["t1"],
    })[0];
    assert.equal(unchecked?.fence.every((entry) => entry.inspected === false && entry.matched === false), true);
    assert.notEqual(unchecked?.reason, "request_already_on_root");
  });

  test("CLI snapshot path prints per-group plans and refuses execute", () => {
    const dir = join(tmpdir(), `ocv5-180-b1-planner-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const snapshotPath = join(dir, "snapshot.json");
    const owner = "b".repeat(64);
    writeFileSync(snapshotPath, JSON.stringify({
      tapes: [{
        tapeId: "audit-selected-tape",
        sessionId: "sess-1",
        turnKey: "c".repeat(64),
        groups: [{
          runId: "dlg-1",
          engineBillings: [{
            requestId: "d".repeat(32),
            parentTurnKey: owner,
            parentSessionId: "sess-1",
          }],
        }],
        root: { sessionId: "sess-1", turnKey: owner, finalized: true },
      }],
    }));
    const runCli = (args: string[]) =>
      spawnSync("npx", ["--no-install", "tsx", "scripts/ops/requeue-failed-tape-jobs.ts", ...args], {
        encoding: "utf8",
        cwd: process.cwd(),
        env: { ...process.env, HOME: dir, OPENCLAUDE_HOME: dir },
      });
    const missing = runCli(["--plan-late-delegate-continuations", "--tape", "audit-selected-tape"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing --snapshot/);
    const execute = runCli([
      "--plan-late-delegate-continuations",
      "--snapshot",
      snapshotPath,
      "--execute",
    ]);
    assert.equal(execute.status, 2);
    const ok = runCli([
      "--plan-late-delegate-continuations",
      "--snapshot",
      snapshotPath,
      "--tape",
      "audit-selected-tape",
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    const body = JSON.parse(ok.stdout) as { plans: Array<{ action: string; groupRunId: string; requestIds: string[]; groupHash: string }> };
    assert.equal(body.plans.length, 1);
    assert.equal(body.plans[0]?.action, "continuation");
    assert.equal(body.plans[0]?.groupRunId, "dlg-1");
    assert.equal(body.plans[0]?.requestIds.length, 1);

    const snapshotB = join(dir, "snapshot-b.json");
    writeFileSync(snapshotB, JSON.stringify({
      tapes: [{
        tapeId: "audit-selected-tape",
        sessionId: "sess-1",
        turnKey: "c".repeat(64),
        groups: [{
          runId: "dlg-1",
          status: "ok",
          resultSummary: "body-b",
          transcript: [{ kind: "text", text: "payload-B" }],
          engineBillings: [
            { requestId: "d".repeat(32), parentTurnKey: owner, parentSessionId: "sess-1" },
            { requestId: "e".repeat(32), parentTurnKey: owner, parentSessionId: "sess-1" },
          ],
        }],
        root: { sessionId: "sess-1", turnKey: owner, finalized: true },
        settlementFence: { requestIds: ["d".repeat(32)] },
      }],
    }));
    const bodyB = runCli([
      "--plan-late-delegate-continuations",
      "--snapshot",
      snapshotB,
      "--tape",
      "audit-selected-tape",
    ]);
    assert.equal(bodyB.status, 0, bodyB.stderr);
    const parsedB = JSON.parse(bodyB.stdout) as {
      plans: Array<{ groupHash: string; reason: string; fence: Array<{ requestId: string; matched: boolean }> }>;
    };
    assert.notEqual(parsedB.plans[0]?.groupHash, body.plans[0]?.groupHash);
    assert.equal(parsedB.plans[0]?.reason, "partial_request_fence");
    assert.equal(parsedB.plans[0]?.fence.length, 2);
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

  test("waiver jobs must match turnKey and reason, not only billingAnchorId", () => {
    const tape = snapshot({
      settlementVerifiedAt: "2026-08-19T00:00:00.000Z",
    });
    const matching = {
      jobId: "w1",
      kind: "waiver" as const,
      status: "failed",
      lastError: "transient",
      billingAnchorId: "srv-a",
      requestId: null,
      payload: { reason: "idle_timeout", turnKey: "a".repeat(64) },
      settlementHash: "h1",
    };
    assert.equal(settlementJobMatchesTapeAuthority(matching, tape), true);
    assert.equal(
      settlementJobMatchesTapeAuthority({
        ...matching,
        payload: { reason: "idle_timeout", turnKey: "b".repeat(64) },
      }, tape),
      false,
    );
    assert.equal(
      settlementJobMatchesTapeAuthority({
        ...matching,
        payload: { reason: "no_response", turnKey: "a".repeat(64) },
      }, tape),
      false,
    );
  });

  test("any manual_reconcile settlement blocks every settlement requeue on that tape", () => {
    const decisions = planTapeRequeue(snapshot({
      settlementVerifiedAt: "2026-08-19T00:00:00.000Z",
      settlementJobs: [
        {
          jobId: "s1",
          kind: "billing",
          status: "failed",
          lastError: "transient",
          billingAnchorId: "srv-a",
          requestId: "r1",
          payload: { engineBillings: [{ model: "x", requestId: "r1" }] },
          settlementHash: "h1",
        },
        {
          jobId: "w1",
          kind: "waiver",
          status: "failed",
          lastError: "transient",
          billingAnchorId: "srv-a",
          requestId: null,
          payload: { reason: "no_response", turnKey: "b".repeat(64) },
          settlementHash: "h1",
        },
      ],
    }));
    assert.equal(decisions.some((d) => d.action === "requeue_settlement"), false);
    assert.equal(decisions.some((d) => d.action === "manual_reconcile"), true);
    assert.equal(
      decisions.some((d) => d.action === "skip" && "reason" in d && d.reason === "sibling_manual_reconcile"),
      true,
    );
  });

  test("production target matches env-file source and host, not only exact db name", () => {
    assert.equal(isProductionDatabaseTarget({
      currentDatabase: "openclaude_v5_selfhost",
      connectionString: "postgres://x@127.0.0.1:5432/openclaude_v5_selfhost",
    }), true);
    assert.equal(isProductionDatabaseTarget({
      currentDatabase: "other",
      connectionString: "postgres://x@db.internal:5432/app",
      envFile: "/etc/openclaude/commercial-v5-selfhost.env",
    }), true);
    assert.equal(isProductionDatabaseTarget({
      currentDatabase: "openclaude_v5_test",
      connectionString: "postgres://x@127.0.0.1:5432/openclaude_v5_test",
      envFile: "/tmp/dev.env",
    }), false);
  });
});

describe("requeue-failed-tape-jobs identity and TOCTOU", () => {
  test("resolveTapeIdentities refuses tape_id LIMIT 1 collisions", async () => {
    const q = {
      query: async () => ({
        rows: [
          { session_id: "s1", user_id: "c:1", tape_id: "tape-1" },
          { session_id: "s2", user_id: "c:2", tape_id: "tape-1" },
        ],
      }),
    };
    await assert.rejects(
      () => resolveTapeIdentities(q, ["tape-1"]),
      /composite primary key/,
    );
  });

  test("execute re-reads under composite FOR UPDATE in the same transaction", async () => {
    const sql: string[] = [];
    let tapeReads = 0;
    const q = {
      query: async (text: string, params: unknown[] = []) => {
        sql.push(text);
        if (text.includes("FROM client_session_turn_tapes")) {
          tapeReads += 1;
          assert.equal(params.length, 3);
          assert.deepEqual(params, ["sess-1", "c:1", "tape-1"]);
          assert.match(text, /t\.session_id=\$1 AND t\.user_id=\$2 AND t\.tape_id=\$3/);
          assert.match(text, /FOR UPDATE/);
          assert.doesNotMatch(text, /WHERE t\.tape_id=\$1\s+LIMIT 1/);
          return {
            rows: [{
              tape_id: "tape-1",
              session_id: "sess-1",
              user_id: "c:1",
              turn_key: "a".repeat(64),
              waive_reason: null,
              materialization_status: tapeReads === 1 ? "failed" : "complete",
              materialization_error: tapeReads === 1 ? "unicode" : null,
              settlement_verified_at: null,
              billing_anchor_id: "srv-a",
              engine_billings: [],
              settlement_hash: null,
            }],
          };
        }
        if (text.includes("turn_tape_materialization_jobs") && text.includes("SELECT")) {
          return {
            rows: [{
              job_id: "m1",
              status: tapeReads === 1 ? "failed" : "complete",
              last_error: tapeReads === 1 ? "unicode" : null,
            }],
          };
        }
        if (text.includes("turn_tape_settlement_jobs") && text.includes("SELECT")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO turn_tape_materialization_jobs") || text.includes("UPDATE turn_tape_")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    };
    const applied = await executeTapeRequeueInTransaction(q, {
      sessionId: "sess-1",
      userId: "c:1",
      tapeId: "tape-1",
    });
    assert.ok(sql.some((s) => s.includes("FOR UPDATE") && s.includes("t.session_id=$1 AND t.user_id=$2 AND t.tape_id=$3")));
    assert.equal(sql.some((s) => /WHERE t\.tape_id=\$1\s+LIMIT 1/.test(s)), false);
    const snapshot = await loadTapeJobSnapshot(q, {
      sessionId: "sess-1",
      userId: "c:1",
      tapeId: "tape-1",
    }, { forUpdate: true });
    assert.equal(snapshot?.matJob?.status, "complete");
    assert.ok(applied.length >= 1);
  });
});
