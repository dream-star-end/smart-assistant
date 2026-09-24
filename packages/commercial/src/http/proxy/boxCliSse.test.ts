import test from "node:test";
import assert from "node:assert/strict";
import { completedBoxCliToSse, BoxCliSseError } from "./boxCliSse.js";

const model = "claude-opus-5-5";
const event = (value: unknown) => ({ type: "stream_event", event: value });
function records(blockType = "text"): Array<Record<string, unknown>> {
  return [
    { type: "system", subtype: "init", tools: [], mcp_servers: [] },
    event({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant",
      model, content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: blockType, text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture" } }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
    event({ type: "message_stop" }),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fixture" }] } },
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 2, output_tokens: 7 } },
  ];
}
function jsonl(value: unknown[]): string { return value.map((item) => JSON.stringify(item)).join("\n") + "\n"; }
function rejected(value: unknown[], code: string): void {
  assert.throws(() => completedBoxCliToSse(jsonl(value), model),
    (error: unknown) => error instanceof BoxCliSseError && error.code === code);
}

test("completed Box CLI events become unmodified Anthropic SSE with observed usage", () => {
  const source = records();
  const output = completedBoxCliToSse(jsonl(source), model);
  assert.equal(output.inputTokens, 2);
  assert.equal(output.outputTokens, 7);
  const types = [...output.sse.matchAll(/^event: ([a-z_]+)$/gm)].map((match) => match[1]);
  assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop"]);
  assert.ok(output.sse.includes(JSON.stringify((source[3] as { event: unknown }).event)));
  assert.ok(!output.sse.includes('"type":"result"'), "CLI result is not a second model event");
});

test("tool_use is never silently consumed by the complete-call path", () => {
  rejected(records("tool_use"), "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
});

test("missing/duplicate/out-of-order events and failed result do not yield success SSE", () => {
  const missingStop = records().filter((item) => (item as { event?: { type?: string } }).event?.type !== "message_stop");
  rejected(missingStop, "BOX_CLI_RESULT_INVALID");
  const duplicateStart = records();
  duplicateStart.splice(2, 0, duplicateStart[1]!);
  rejected(duplicateStart, "BOX_CLI_EVENT_ORDER_INVALID");
  const badFinal = records();
  badFinal[8] = { ...badFinal[8], is_error: true };
  rejected(badFinal, "BOX_CLI_RESULT_INVALID");
  const badUsage = records();
  badUsage[5] = event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: -1 } });
  rejected(badUsage, "BOX_CLI_USAGE_INVALID");
});

test("rejects hidden tool evidence outside content_block_start", () => {
  const toolReason = records();
  toolReason[5] = event({ type: "message_delta", delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 7 } });
  rejected(toolReason, "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
  const toolAtStart = records();
  (toolAtStart[1] as { event: { message: { content: unknown[] } } }).event.message.content =
    [{ type: "tool_use", id: "toolu_1" }];
  rejected(toolAtStart, "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
  const toolInAssistant = records();
  toolInAssistant[7] = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1" }] } };
  rejected(toolInAssistant, "BOX_CLI_TOOL_REQUIRES_LIVE_INVOCATION");
});

test("rejects duplicate block indices and delta type mismatches", () => {
  const reused = records();
  reused.splice(5, 0, event({ type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } }));
  rejected(reused, "BOX_CLI_EVENT_ORDER_INVALID");
  const wrongDelta = records();
  wrongDelta[3] = event({ type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: "{}" } });
  rejected(wrongDelta, "BOX_CLI_DELTA_INVALID");
});

test("rejects cumulative usage regressions, cache negatives and result mismatch", () => {
  const regressed = records();
  regressed.splice(6, 0, event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 0 } }));
  rejected(regressed, "BOX_CLI_USAGE_REGRESSION");
  const badCache = records();
  (badCache[8] as { usage: { cache_read_input_tokens?: number } }).usage.cache_read_input_tokens = -1;
  rejected(badCache, "BOX_CLI_USAGE_INVALID");
  const mismatch = records();
  (mismatch[8] as { usage: { output_tokens: number } }).usage.output_tokens = 8;
  rejected(mismatch, "BOX_CLI_USAGE_MISMATCH");
});

test("terminal message_delta phase forbids later content and stop-reason reset", () => {
  const lateContent = records();
  lateContent.splice(6, 0,
    event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_stop", index: 1 }));
  rejected(lateContent, "BOX_CLI_EVENT_ORDER_INVALID");
  const resetReason = records();
  resetReason.splice(6, 0, event({ type: "message_delta", delta: { stop_reason: null },
    usage: { output_tokens: 7 } }));
  rejected(resetReason, "BOX_CLI_EVENT_ORDER_INVALID");
});

test("delta input/cache usage cannot contradict start and result", () => {
  const inputMismatch = records();
  inputMismatch[5] = event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7, input_tokens: 999 } });
  rejected(inputMismatch, "BOX_CLI_USAGE_MISMATCH");
  const cacheMismatch = records();
  cacheMismatch[5] = event({ type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7, cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20 } });
  rejected(cacheMismatch, "BOX_CLI_USAGE_MISMATCH");
});
