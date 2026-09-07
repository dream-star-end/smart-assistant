import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { notifyRecoveryJobTerminals } from "../db/pgSessionsBackend.js";
import type { RecoveryJobTerminalRow } from "../dispatch/turnRecoveryStore.js";

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
    const srcPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../db/pgSessionsBackend.ts",
    );
    const src = readFileSync(srcPath, "utf8");
    const finalizeAt = src.indexOf("async finalizeLosslessTurnTape(");
    assert.ok(finalizeAt >= 0);
    const slice = src.slice(finalizeAt, finalizeAt + 80_000);
    assert.match(slice, /if \(result\.applied === "finalized"\) \{\s*\/\/ Includes recoveryDecision == null/);
    assert.match(slice, /await notifyRecoveryJobTerminals\(/);
    assert.match(
      slice,
      /if \(billingUserId !== null\) \{\s*if \(turn\.payload\.continuationOfTurnKey\)/,
    );
  });
});
