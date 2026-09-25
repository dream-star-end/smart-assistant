import test from "node:test";
import assert from "node:assert/strict";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import type { ProxyBody } from "./shared.js";
import type { BoxToolUse } from "./boxCliToolHandoff.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";

const uses: BoxToolUse[] = [
  { id: "toolu_same_A", boxName: "mcp__ocbridge__t0",
    clientName: "local_echo", input: { value: "ping" } },
  { id: "toolu_same_B", boxName: "mcp__ocbridge__t0",
    clientName: "local_echo", input: { value: "ping" } },
];
const body = (): ProxyBody => ({ model: "box-api-claude-opus-5-5", max_tokens: 128,
  messages: [
    { role: "assistant", content: uses.map((use) => ({ type: "tool_use",
      id: use.id, name: use.clientName, input: use.input })) },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_same_B", content: "second" },
      { type: "tool_result", tool_use_id: "toolu_same_A", content: "first" },
    ] },
  ] });

test("same-name same-input tool results bind by model ID, not arrival order", () => {
  const matched = matchBoxToolResults(body(), uses);
  assert.deepEqual(matched.map((entry) => [entry.modelToolUseId,
    entry.content[0]?.type === "text" ? entry.content[0].text : null]), [
    ["toolu_same_A", "first"], ["toolu_same_B", "second"],
  ]);
  assert.notEqual(matched[0]?.contentHash, matched[1]?.contentHash);
  const digests = uses.map(({ id, boxName, clientName, input }) => ({
    id, boxName, clientName, inputHash: hashBoxToolInput(input) }));
  assert.deepEqual(matchBoxToolResults(body(), digests), matched,
    "cross-request resume must validate only persisted hashes, not PG raw arguments");
});

test("real CCB trailing token-budget system hint does not hide the exact tool result", () => {
  const value = body();
  value.messages.push({ role: "system", content: [{ type: "text",
    text: "<total_tokens>14999987 tokens left</total_tokens>",
    cache_control: { type: "ephemeral" } }] });
  assert.deepEqual(matchBoxToolResults(value, uses), matchBoxToolResults(body(), uses));
  (value.messages.at(-1) as { content: unknown }).content = [{ type: "text", text: "different system instruction",
    cache_control: { type: "ephemeral" } }];
  assert.throws(() => matchBoxToolResults(value, uses), /BOX_TOOL_RESULT_CONTEXT_INVALID/);
});

test("missing, duplicate or rewritten tool history fails before result publication", () => {
  const missing = body();
  (missing.messages[1] as { content: unknown[] }).content.pop();
  assert.throws(() => matchBoxToolResults(missing, uses), /BOX_TOOL_RESULT_SET_MISMATCH/);
  const duplicate = body();
  (duplicate.messages[1] as { content: Array<{ tool_use_id: string }> }).content[1]!.tool_use_id = "toolu_same_B";
  assert.throws(() => matchBoxToolResults(duplicate, uses), /BOX_TOOL_RESULT_SET_MISMATCH/);
  const altered = body();
  (altered.messages[0] as { content: Array<{ input: unknown }> }).content[0]!.input = { value: "other" };
  assert.throws(() => matchBoxToolResults(altered, uses), /BOX_TOOL_RESULT_HISTORY_MISMATCH/);
});

test("error and image content map exactly to virtual MCP, unsupported blocks fail", () => {
  const image = Buffer.from("synthetic-image").toString("base64");
  const request = body();
  (request.messages[1] as { content: unknown[] }).content = [
    { type: "tool_result", tool_use_id: "toolu_same_A", is_error: true,
      content: [{ type: "text", text: "failed" }] },
    { type: "tool_result", tool_use_id: "toolu_same_B",
      content: [{ type: "image", source: { type: "base64",
        media_type: "image/png", data: image } }] },
  ];
  const matched = matchBoxToolResults(request, uses);
  assert.equal(matched[0]?.isError, true);
  assert.deepEqual(matched[1]?.content, [{ type: "image", data: image,
    mimeType: "image/png" }]);
  (request.messages[1] as { content: unknown[] }).content = [
    { type: "tool_result", tool_use_id: "toolu_same_A", content: [{ type: "audio" }] },
    { type: "tool_result", tool_use_id: "toolu_same_B", content: "ok" },
  ];
  assert.throws(() => matchBoxToolResults(request, uses), /BOX_TOOL_RESULT_CONTENT_INVALID/);
  (request.messages[1] as { content: unknown[] }).content = [
    { type: "tool_result", tool_use_id: "toolu_same_A",
      content: [{ type: "text", text: "quoted", citations: [{ type: "web_search_result_location" }] }] },
    { type: "tool_result", tool_use_id: "toolu_same_B", content: "ok" },
  ];
  assert.throws(() => matchBoxToolResults(request, uses), /BOX_TOOL_RESULT_CONTENT_INVALID/,
    "semantic citations must never be silently stripped or omitted from the hash");
});
