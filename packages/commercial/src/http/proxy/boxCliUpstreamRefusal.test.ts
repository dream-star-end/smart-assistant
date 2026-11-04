import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { boxCliUpstreamRefusal, boxCliUpstreamRefusalDiagnostic,
  BOX_CLI_UPSTREAM_REFUSED, BOX_CLI_UPSTREAM_RATE_LIMITED } from "./boxCliUpstreamRefusal.js";

const synthetic = (tag: unknown) => ({ type: "assistant", error: tag,
  is_api_error_message: true,
  message: { model: "<synthetic>", get content(): never {
    throw new Error("diagnostics must not read API error body");
  } } });

test("synthetic refusal diagnostics allow only explicit tags and never read error text", () => {
  for (const tag of ["authentication_failed", "rate_limit", "invalid_request",
    "overloaded_error", "api_error"] as const) {
    const record = synthetic(tag);
    assert.equal(boxCliUpstreamRefusal(record), tag === "rate_limit"
      ? BOX_CLI_UPSTREAM_RATE_LIMITED : BOX_CLI_UPSTREAM_REFUSED);
    assert.deepEqual(boxCliUpstreamRefusalDiagnostic(record), {
      branch: "synthetic_api_error", upstreamTag: tag });
  }
});

test("unknown synthetic tags retain only bounded length and hash", () => {
  const secret = "private request text and credentials ".repeat(10_000);
  const diagnostic = boxCliUpstreamRefusalDiagnostic(synthetic(secret))!;
  assert.deepEqual(diagnostic, { branch: "synthetic_api_error", upstreamTag: "other",
    observedBytes: Buffer.byteLength(secret),
    observedSha256: createHash("sha256").update(secret).digest("hex") });
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= 2048);
  assert.ok(!JSON.stringify(diagnostic).includes("private request"));
  assert.equal(boxCliUpstreamRefusalDiagnostic({ type: "assistant",
    message: { model: "real-model", content: secret } }), undefined);
});
