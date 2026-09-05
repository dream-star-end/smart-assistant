import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mapRegisterFunnelCode } from "./handlers.js";
import { paymentCheckoutCode, paymentPaidLatencyMs } from "./payment.js";

describe("OCV5-104 funnel event mapping", () => {
  test("register failed codes map onto the frozen set and ignore validation", () => {
    assert.equal(mapRegisterFunnelCode("CONFLICT"), "CONFLICT");
    assert.equal(mapRegisterFunnelCode("TURNSTILE_FAILED"), "TURNSTILE");
    assert.equal(mapRegisterFunnelCode("EMAIL_DOMAIN_BLOCKED"), "EMAIL_DOMAIN_BLOCKED");
    assert.equal(mapRegisterFunnelCode("VALIDATION"), null);
    assert.equal(mapRegisterFunnelCode("REGISTRATION_DISABLED"), null);
  });

  test("checkout code is kind_plan sanitized to [A-Za-z0-9_]", () => {
    assert.equal(
      paymentCheckoutCode({ kind: "subscription", plan_code: "lite" }),
      "subscription_lite",
    );
    assert.equal(
      paymentCheckoutCode({ kind: "topup", plan_code: "plan-10" }),
      "topup_plan_10",
    );
    assert.equal(
      paymentCheckoutCode({ kind: "pack", plan_code: null }),
      "pack_none",
    );
  });

  test("paid latency_ms is paid_at minus created_at", () => {
    const created = new Date("2026-09-01T00:00:00.000Z");
    const paid = new Date("2026-09-01T00:01:30.000Z");
    assert.equal(paymentPaidLatencyMs({ created_at: created, paid_at: paid }), 90_000);
    assert.equal(paymentPaidLatencyMs({ created_at: created, paid_at: null }), null);
  });
});
