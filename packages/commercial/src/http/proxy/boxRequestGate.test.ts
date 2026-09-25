import test from "node:test";
import assert from "node:assert/strict";
import { validateBoxTextRequest, validateBoxRequest,
  validateBoxToolRequest } from "./boxRequestGate.js";
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
  const keepAll = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  assert.equal(validateBoxTextRequest({ ...base, context_management: keepAll }), null);
  assert.equal(validateBoxTextRequest({ ...base, context_management: {
    edits: [{ type: "clear_thinking_20251015", keep: "all", extra: true }] } }),
  "BOX_PARAMETER_UNMAPPED");
  assert.equal(validateBoxTextRequest({ ...base, context_management: {
    edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] } }),
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

test("tool bridge gate is explicit and validates first and next HTTP rounds", () => {
  const tools = [{ name: "local_echo", description: "synthetic local tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }];
  const first = { ...base, tools, tool_choice: { type: "auto" },
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "medium" } } as ProxyBody;
  assert.equal(validateBoxRequest(first, false), "BOX_TOOLS_REQUIRE_LIVE_BRIDGE");
  assert.equal(validateBoxRequest(first, true), null);
  const next = { ...first, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_A",
      name: "local_echo", input: { value: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A",
      content: "OpenClaude user-container result" }] },
  ] } as ProxyBody;
  assert.equal(validateBoxToolRequest(next), null);
  const realCcb = { ...first,
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    thinking: { type: "adaptive" } } as ProxyBody;
  assert.equal(validateBoxToolRequest(realCcb), null);
  assert.equal(validateBoxToolRequest({ ...realCcb, context_management: {
    edits: [{ type: "clear_tool_uses_20250919", keep: "all" }] } }),
  "BOX_PARAMETER_UNMAPPED");
  assert.equal(validateBoxToolRequest({ ...first, tool_choice: {
    type: "tool", name: "local_echo" } }), "BOX_TOOL_CHOICE_UNMAPPED");
  assert.equal(validateBoxToolRequest({ ...first,
    output_config: { effort: "invalid" } }), "BOX_EFFORT_UNMAPPED");
  assert.equal(validateBoxRequest({ ...first, tools: {} as never }, true),
    "BOX_TOOL_COUNT_INVALID");
});
