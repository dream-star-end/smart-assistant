import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { notifyRecoveryJobTerminals } from "../db/pgSessionsBackend.js";
import type { RecoveryJobTerminalRow } from "../dispatch/turnRecoveryStore.js";
import { readPgSessionsBackendSource } from "./helpers/pgSessionsSource.js";

describe("notifyRecoveryJobTerminals", () => {
  test("invokes the hook for completed/paused even when no recovery decision exists", async () => {
    const calls: Array<{ status: string; reason: string | null }> = [];
    await notifyRecoveryJobTerminals(
      (_userId, _sessionId, info) => {
        calls.push({ status: info.terminalStatus, reason: info.pauseReason });
      },
      "c:7",
      "session-1",
      [
        {
          rootClientMessageId: "root-1",
          errorCode: "upstream_failed",
          semanticAttempt: 1,
          status: "completed",
          pauseReason: null,
        },
        {
          rootClientMessageId: "root-1",
          errorCode: "liveness_timeout",
          semanticAttempt: 2,
          status: "paused",
          pauseReason: "automatic_silent_no_progress",
        },
        {
          rootClientMessageId: "root-1",
          errorCode: "liveness_timeout",
          semanticAttempt: 3,
          status: "cancelled",
          pauseReason: "automatic_silent_no_progress",
        },
      ] satisfies RecoveryJobTerminalRow[],
    );
    assert.deepEqual(calls, [
      { status: "completed", reason: null },
      { status: "paused", reason: "automatic_silent_no_progress" },
    ]);
  });

  test("a throwing hook does not reject", async () => {
    await notifyRecoveryJobTerminals(
      () => {
        throw new Error("friction writer boom");
      },
      "c:7",
      "session-1",
      [{
        rootClientMessageId: "root-1",
        errorCode: "upstream_failed",
        semanticAttempt: 1,
        status: "completed",
        pauseReason: null,
      }],
    );
  });
});

describe("finalizeLosslessTurnTape recovery-job hook wiring", () => {
  test("post-commit hook runs on applied=finalized independently of recoveryDecision", () => {
    const src = readPgSessionsBackendSource();
    const callbacksAt = src.indexOf("async function publishFinalizePostCommitCallbacks(");
    assert.ok(callbacksAt >= 0, "publishFinalizePostCommitCallbacks missing");
    const callbacksSlice = src.slice(callbacksAt, callbacksAt + 1200);
    assert.match(callbacksSlice, /if \(outcome\.result\.applied !== "finalized"\) return;/);
    assert.match(callbacksSlice, /\/\/ Includes recoveryDecision == null/);
    assert.match(callbacksSlice, /await notifyRecoveryJobTerminals\(/);
    const finalizeAt = src.indexOf("async function runFinalizeLosslessTurnTape(");
    assert.ok(finalizeAt >= 0, "runFinalizeLosslessTurnTape missing");
    assert.match(
      src.slice(finalizeAt, finalizeAt + 3500),
      /await publishFinalizePostCommitCallbacks\(/,
    );
    const recoveryAt = src.indexOf("async function settleOrScheduleAutomaticRecovery(");
    assert.ok(recoveryAt >= 0, "settleOrScheduleAutomaticRecovery missing");
    const recoverySlice = src.slice(recoveryAt, recoveryAt + 1500);
    assert.match(
      recoverySlice,
      /if \(billingUserId === null\)\s*\{[\s\S]{0,120}\}\s*if \(turn\.payload\.continuationOfTurnKey\)/,
    );
  });
});
