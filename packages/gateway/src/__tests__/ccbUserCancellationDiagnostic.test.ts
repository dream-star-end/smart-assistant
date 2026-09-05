/**
 * isCcbUserCancellationDiagnostic — the CCB error_during_execution result
 * shapes that mean "the user pressed Stop" vs. genuine engine failures.
 *
 * Incident: INC-20260903-CCB-TOOL-PHASE-STOP-RED-CARD
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isCcbUserCancellationDiagnostic } from "../engine/ccbAdapter.js";

function ede(errors: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ subtype: "error_during_execution", errors, ...extra });
}

const NULL_USER = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";
const NULL_UNDEF = "[ede_diagnostic] result_type=undefined last_content_type=n/a stop_reason=null";
const TOOL_USER = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
const ABORTED = "Error: Request was aborted.\n    at withRetry (/app/cli.js:1:1)";

describe("isCcbUserCancellationDiagnostic", () => {
  test("streaming-phase abort: stop_reason=null diagnostics", () => {
    assert.equal(isCcbUserCancellationDiagnostic(ede([NULL_USER]), null), true);
    assert.equal(isCcbUserCancellationDiagnostic(ede([NULL_UNDEF]), null), true);
    assert.equal(isCcbUserCancellationDiagnostic(ede([NULL_USER, ABORTED]), null), true);
  });

  test("legacy shape: Request was aborted without a diagnostic line", () => {
    assert.equal(isCcbUserCancellationDiagnostic(ede([ABORTED]), null), true);
  });

  test("legacy shape under an authoritative stop_reason is CCB's verdict, not a user Stop", () => {
    assert.equal(isCcbUserCancellationDiagnostic(ede([ABORTED]), "refusal"), false);
    assert.equal(isCcbUserCancellationDiagnostic(ede([ABORTED]), "end_turn"), false);
    assert.equal(isCcbUserCancellationDiagnostic(ede([ABORTED]), "tool_use"), false);
  });

  test("tool-phase abort: stop_reason=tool_use diagnostic with matching TurnResult stopReason", () => {
    assert.equal(isCcbUserCancellationDiagnostic(ede([TOOL_USER]), "tool_use"), true);
    assert.equal(isCcbUserCancellationDiagnostic(ede([TOOL_USER, ABORTED]), "tool_use"), true);
  });

  test("diagnostic stop_reason must agree with the result frame stop_reason", () => {
    assert.equal(isCcbUserCancellationDiagnostic(ede([TOOL_USER]), null), false);
    assert.equal(isCcbUserCancellationDiagnostic(ede([NULL_USER]), "tool_use"), false);
    assert.equal(isCcbUserCancellationDiagnostic(ede([NULL_USER]), "end_turn"), false);
  });

  test("any other trailing error means a real failure, not a cancellation", () => {
    assert.equal(
      isCcbUserCancellationDiagnostic(ede([NULL_USER, "Error: upstream request failed"]), null),
      false,
    );
    assert.equal(
      isCcbUserCancellationDiagnostic(ede([TOOL_USER, "Error: upstream request failed"]), "tool_use"),
      false,
    );
    assert.equal(
      isCcbUserCancellationDiagnostic(ede([ABORTED, "Error: ENOENT"]), null),
      false,
    );
  });

  test("other diagnostics / shapes are never cancellations", () => {
    assert.equal(
      isCcbUserCancellationDiagnostic(
        ede(["[ede_diagnostic] result_type=assistant last_content_type=tool_use stop_reason=tool_use"]),
        "tool_use",
      ),
      false,
    );
    assert.equal(
      isCcbUserCancellationDiagnostic(
        ede(["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=max_tokens"]),
        "max_tokens",
      ),
      false,
    );
    assert.equal(isCcbUserCancellationDiagnostic(ede([]), null), false);
    assert.equal(isCcbUserCancellationDiagnostic(ede(["No conversation found with session ID: x"]), null), false);
    assert.equal(isCcbUserCancellationDiagnostic('{"subtype":"success"}', null), false);
    assert.equal(isCcbUserCancellationDiagnostic("not json error_during_execution \"subtype\":\"error_during_execution\"", null), false);
    assert.equal(isCcbUserCancellationDiagnostic(undefined, null), false);
  });
});
