import test from "node:test";
import assert from "node:assert/strict";
import { validateBoxTextRequest } from "./boxRequestGate.js";
import type { ProxyBody } from "./shared.js";
import { applyModelDefaultEffort } from "./shared.js";

const base = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
  messages: [{ role: "user", content: "synthetic text" }] } as ProxyBody;

test("Box text route accepts only proved completed-history text shape", () => {
  assert.equal(validateBoxTextRequest(base), null);
  assert.equal(validateBoxTextRequest({ ...base, stream: undefined }), "BOX_STREAM_REQUIRED");
  assert.equal(validateBoxTextRequest({ ...base, tools: [{ name: "Bash" }] }),
    "BOX_TOOLS_REQUIRE_LIVE_BRIDGE");
  assert.equal(validateBoxTextRequest({ ...base, output_config: { effort: "high" } }),
    "BOX_EFFORT_UNMAPPED");
  assert.equal(validateBoxTextRequest({ ...base, thinking: { type: "enabled" } }),
    "BOX_EFFORT_UNMAPPED");
  assert.equal(validateBoxTextRequest({ ...base, context_management: {} }),
    "BOX_PARAMETER_UNMAPPED");
  assert.equal(validateBoxTextRequest({ ...base, messages: [
    { role: "user", content: [{ type: "image", source: { type: "base64", data: "abc" } }] },
  ] }), "BOX_BLOCK_UNSUPPORTED");
});

test("pricing default effort injection is rejected, not silently dropped", () => {
  const input = structuredClone(base);
  applyModelDefaultEffort(input, "high");
  assert.equal(validateBoxTextRequest(input), "BOX_EFFORT_UNMAPPED");
});
