import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  classifyClientFrictionPersistError,
  normalizeClientFrictionReport,
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
    });
    assert.equal(JSON.stringify(normalized).includes("DO_NOT_PERSIST"), false);
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
