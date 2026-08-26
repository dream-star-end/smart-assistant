import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  classifyClientFrictionPersistError,
  isBrowserFirstTextPaintNamespace,
  isBrowserFirstTextPaintReport,
  normalizeClientFrictionReport,
  resolveOwnedFirstTextPaintAttribution,
} from "../http/clientErrors.js";

describe("client friction normalization", () => {
  test("keeps stable classifications and drops every raw browser field", () => {
    const normalized = normalizeClientFrictionReport({
      event_id: "event_1",
      surface: "auth",
      stage: "refresh",
      code: "REFRESH_RACE",
      outcome: "recovered",
      attempts: 2,
      latency_ms: 180,
      trace_id: "trace_1",
      session_id: "session_1",
      entity_slug: "skill.one",
      model: "qwen3.7-max",
      provider: "opencodego",
      client_build: "abc-123",
      browser_family: "chrome",
      device_class: "desktop",
      message: "DO_NOT_PERSIST message",
      stack: "DO_NOT_PERSIST stack",
      path: "/private/conversation",
      url: "https://example.invalid/private",
      user_agent: "DO_NOT_PERSIST ua",
      details: { secret: "DO_NOT_PERSIST" },
    }, "fallback");

    assert.deepEqual(normalized, {
      correlation: "event_1",
      surface: "auth",
      stage: "refresh",
      code: "REFRESH_RACE",
      outcome: "recovered",
      attempts: 2,
      latencyMs: 180,
      model: "qwen3.7-max",
      provider: "opencodego",
      clientBuild: "abc-123",
      browserFamily: "chrome",
      deviceClass: "desktop",
      traceId: "trace_1",
      sessionId: "session_1",
      entitySlug: "skill.one",
      errorName: null,
      scriptRef: null,
      lineNo: null,
      colNo: null,
      errorFingerprint: null,
    });
    assert.equal(JSON.stringify(normalized).includes("DO_NOT_PERSIST"), false);
  });

  test("keeps bounded error location identifiers and rejects free text (0248)", () => {
    const accepted = normalizeClientFrictionReport({
      surface: "client",
      stage: "runtime",
      code: "JS_ERROR",
      error_name: "TypeError",
      script_ref: "index-Ab3xY9.js",
      line_no: 1234,
      col_no: 56,
      error_fingerprint: "9f3a1c20",
    }, "fallback");
    assert.equal(accepted.errorName, "TypeError");
    assert.equal(accepted.scriptRef, "index-Ab3xY9.js");
    assert.equal(accepted.lineNo, 1234);
    assert.equal(accepted.colNo, 56);
    assert.equal(accepted.errorFingerprint, "9f3a1c20");

    const rejected = normalizeClientFrictionReport({
      surface: "client",
      stage: "runtime",
      code: "JS_ERROR",
      error_name: "has spaces DO_NOT_PERSIST",
      script_ref: "https://example.invalid/private/path.js",
      line_no: -1,
      col_no: 10_000_001,
      error_fingerprint: "UPPER-not-hex",
    }, "fallback");
    assert.equal(rejected.errorName, null);
    assert.equal(rejected.scriptRef, null);
    assert.equal(rejected.lineNo, null);
    assert.equal(rejected.colNo, null);
    assert.equal(rejected.errorFingerprint, null);
    assert.equal(JSON.stringify(rejected).includes("DO_NOT_PERSIST"), false);
  });

  test("keeps lowercase semantic error codes used by the browser contract", () => {
    const normalized = normalizeClientFrictionReport({
      surface: "chat",
      stage: "recovery",
      code: "context_too_long",
      outcome: "failed",
    }, "fallback");
    assert.equal(normalized.code, "context_too_long");
  });

  test("recognizes only the bounded browser first-text paint codes", () => {
    const base = normalizeClientFrictionReport({
      event_id: "paint_1",
      surface: "webchat",
      stage: "first_text_paint",
      code: "FIRST_TEXT_PAINT",
      outcome: "succeeded",
      latency_ms: 31000,
      trace_id: "a".repeat(32),
      session_id: "session_1",
    }, "fallback");
    assert.equal(isBrowserFirstTextPaintNamespace(base), true);
    assert.equal(isBrowserFirstTextPaintReport(base), true);
    assert.equal(isBrowserFirstTextPaintReport({ ...base, code: "FIRST_TEXT_FRAME" }), false);
    assert.equal(isBrowserFirstTextPaintReport({ ...base, outcome: "failed" }), false);
    assert.equal(isBrowserFirstTextPaintReport({ ...base, surface: "chat" }), false);
  });

  test("reserved paint namespace rejects malformed reports before any ownership query", async () => {
    const query = async () => {
      assert.fail("reserved malformed paint report must not query or persist");
    };
    for (const body of [
      {
        surface: "webchat", stage: "first_text_paint", code: "FIRST_TEXT_PAINT",
        trace_id: "c".repeat(32), session_id: "session_3", latency_ms: 1,
      },
      {
        surface: "webchat", stage: "first_text_paint", code: "OTHER_CODE",
        outcome: "succeeded", trace_id: "c".repeat(32), session_id: "session_3", latency_ms: 1,
      },
    ]) {
      const report = normalizeClientFrictionReport(body, "fallback");
      assert.equal(isBrowserFirstTextPaintNamespace(report), true);
      assert.equal(isBrowserFirstTextPaintReport(report), false);
      assert.equal(
        await resolveOwnedFirstTextPaintAttribution(report, 3n, { query } as never),
        null,
      );
    }
  });

  test("paint attribution joins trace + dispatch session + user as one exact turn", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const runner = {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        return { rows: [{ model: "gpt-5.6-sol-1m", provider: "openai" }], rowCount: 1 };
      },
    };
    const report = normalizeClientFrictionReport({
      event_id: "paint_2",
      surface: "webchat",
      stage: "first_text_paint",
      code: "FIRST_TEXT_PAINT",
      outcome: "succeeded",
      latency_ms: 32000,
      trace_id: "b".repeat(32),
      session_id: "session_2",
    }, "fallback");
    assert.deepEqual(
      await resolveOwnedFirstTextPaintAttribution(report, 3n, runner as never),
      { model: "gpt-5.6-sol-1m", provider: "openai" },
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /JOIN turn_dispatches d/);
    assert.match(calls[0]!.sql, /d\.session_id=\$3/);
    assert.match(calls[0]!.sql, /t\.user_id=\$2::bigint/);
    assert.deepEqual(calls[0]!.params, ["b".repeat(32), "3", "session_2"]);
  });

  test("invalid tokens collapse to bounded defaults", () => {
    const normalized = normalizeClientFrictionReport({
      surface: "../../raw",
      type: "has spaces",
      code: "lowercase raw text",
      outcome: "invented",
      event_id: "contains spaces",
      model: "x".repeat(129),
      provider: "UPPERCASE",
      browser_family: "bad/slash",
      device_class: "watch",
      entity_slug: "contains spaces",
    }, "fallback_id");
    assert.equal(normalized.correlation, "fallback_id");
    assert.equal(normalized.surface, "client");
    assert.equal(normalized.stage, "runtime");
    assert.equal(normalized.code, "CLIENT_UNKNOWN");
    assert.equal(normalized.outcome, "failed");
    assert.equal(normalized.model, null);
    assert.equal(normalized.provider, null);
    assert.equal(normalized.browserFamily, null);
    assert.equal(normalized.deviceClass, "unknown");
    assert.equal(normalized.entitySlug, null);
  });

  test("persist failures expose bounded structure without leaking raw database detail", () => {
    const err = Object.assign(new Error("DO_NOT_LOG rejected row contains private values"), {
      code: "23514",
      constraint: "product_friction_events_code_check",
      detail: "DO_NOT_LOG row=(secret)",
    });
    const classified = classifyClientFrictionPersistError(err);
    assert.deepEqual(classified, {
      errorClass: "Error",
      errorCode: "23514",
      errorConstraint: "product_friction_events_code_check",
    });
    assert.equal(JSON.stringify(classified).includes("DO_NOT_LOG"), false);

    assert.deepEqual(
      classifyClientFrictionPersistError({
        code: "bad code with spaces",
        constraint: "../../unsafe",
      }),
      { errorClass: "object", errorCode: null, errorConstraint: null },
    );
  });
});
