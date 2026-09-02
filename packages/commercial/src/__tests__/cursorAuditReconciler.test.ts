import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { billingFrameFromTape, parseZeroChargeCutoff } from "../billing/cursorAuditReconciler.js";
import { isCursorDurableBilling, mapAuditTerminalCode } from "../billing/durableCursorBilling.js";

const REQ = "bfd2ba7de2a304639f7a31f26e22034a";
const TURN_KEY = "ac0077c8004891f16142be97447fbd2b29b767ba4aec73afae2ee37e6f7c934f";

describe("billingFrameFromTape", () => {
  const tapeUsage = {
    turn: 1,
    model: "cursor-fable-5.1-high",
    traceId: REQ,
    inputTokens: 1129142,
    totalTokens: 1139666,
    outputTokens: 10524,
    cacheReadTokens: 7,
    cacheCreationTokens: 3,
  };

  test("rebuilds a cursor durable frame from a legacy finalized tape", () => {
    const frame = billingFrameFromTape({
      request_id: REQ,
      session_id: "webmtjpkn3qxyd3di",
      tape_turn_key: TURN_KEY,
      tape_status: "completed",
      tape_usage: tapeUsage,
      tape_created_at: "1788327689956",
      tape_finalized_at: "1788327698393",
    });
    assert.ok(frame);
    assert.equal(frame.engine, "cursor");
    assert.equal(isCursorDurableBilling(frame), true);
    assert.equal(frame.requestId, REQ);
    assert.equal(frame.turnKey, TURN_KEY);
    assert.equal(frame.status, "success");
    assert.equal(frame.terminalCode, undefined);
    assert.equal(frame.durationMs, 8437);
    assert.deepEqual(frame.usage, {
      input_tokens: 1129142,
      output_tokens: 10524,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    });
  });

  test("interrupted/crashed tapes become non-charging error frames", () => {
    const interrupted = billingFrameFromTape({
      request_id: REQ, session_id: null, tape_turn_key: TURN_KEY,
      tape_status: "interrupted", tape_usage: tapeUsage, tape_created_at: "1", tape_finalized_at: "2",
    })!;
    assert.equal(interrupted.status, "error");
    assert.equal(interrupted.terminalCode, "USER_CANCELLED");
    assert.equal(mapAuditTerminalCode(interrupted), "USER_CANCELLED");
    const crashed = billingFrameFromTape({
      request_id: REQ, session_id: null, tape_turn_key: null,
      tape_status: "crashed", tape_usage: tapeUsage, tape_created_at: "1", tape_finalized_at: "2",
    })!;
    assert.equal(crashed.status, "error");
    assert.equal(crashed.terminalCode, "CODEX_ERROR");
    // audit CHECK vocabulary never receives CODEX_ERROR
    assert.equal(mapAuditTerminalCode(crashed), "ENGINE_ERROR");
    assert.equal(crashed.turnKey, undefined);
  });

  test("tape traceId is the client trace chip, not the billing requestId: never a refusal", () => {
    // Live data: every tape's usage.traceId differs from the dispatch's
    // billing_request_id. The dispatch join is authoritative.
    const frame = billingFrameFromTape({
      request_id: REQ, session_id: null, tape_turn_key: TURN_KEY, tape_status: "completed",
      tape_usage: { ...tapeUsage, traceId: "0".repeat(32) }, tape_created_at: "1", tape_finalized_at: "2",
    });
    assert.ok(frame);
    assert.equal(frame.requestId, REQ);
    assert.equal(frame.usage?.output_tokens, 10524);
  });

  test("refuses a tape with no usage", () => {
    assert.equal(
      billingFrameFromTape({
        request_id: REQ, session_id: null, tape_turn_key: TURN_KEY, tape_status: "completed",
        tape_usage: null, tape_created_at: "1", tape_finalized_at: "2",
      }),
      null,
    );
  });
});

describe("mapAuditTerminalCode / isCursorDurableBilling", () => {
  test("success clears terminal code; codex/grok frames are not cursor", () => {
    assert.equal(mapAuditTerminalCode({ status: "success", terminalCode: "CODEX_ERROR" }), null);
    assert.equal(mapAuditTerminalCode({ status: "error" }), "ENGINE_ERROR");
    assert.equal(
      isCursorDurableBilling({ requestId: REQ, engineSessionId: "x", status: "success", durationMs: 1 }),
      false,
    );
  });
});

describe("parseZeroChargeCutoff", () => {
  test("parses ISO and rejects garbage", () => {
    assert.equal(parseZeroChargeCutoff(undefined), null);
    assert.equal(parseZeroChargeCutoff("not a date"), null);
    assert.equal(parseZeroChargeCutoff("2026-09-02T10:00:00Z")?.toISOString(), "2026-09-02T10:00:00.000Z");
  });
});
