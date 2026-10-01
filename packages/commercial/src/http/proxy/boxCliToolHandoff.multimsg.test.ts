// OCV5-301: Claude Code answers a call to a tool this Box invocation does not
// expose with its own `<tool_use_error>` result, and the model retries in a
// new message of the same run. Native Claude Code shows one continuing turn;
// the decoder merges the segments into the one client-visible message.
import test from "node:test";
import assert from "node:assert/strict";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BoxCliToolHandoffDecoder, BoxCliToolHandoffError } from "./boxCliToolHandoff.js";
import { hashBoxAssistantContent } from "./boxCallFingerprint.js";

const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "Bash", description: "Synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }], "natural");
const boxName = "mcp__ocbridge__Bash";
const event = (value: unknown) => ({ type: "stream_event", event: value });
const init = { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] };
const start = (id: string, input = 10, read = 0) => event({ type: "message_start", message: {
  id, model, role: "assistant", content: [],
  usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read } } });
const text = (id: string, index: number, value: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [...prior, { type: "text", text: value }] } },
  event({ type: "content_block_stop", index }),
];
const call = (id: string, index: number, toolId: string, name: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index,
    content_block: { type: "tool_use", id: toolId, name, input: {} } }),
  event({ type: "content_block_delta", index,
    delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [...prior, { type: "tool_use", id: toolId, name, input: { value: "x" } }] } },
  event({ type: "content_block_stop", index }),
];
const stop = (reason: string, output: number, input = 10) => [
  event({ type: "message_delta", delta: { stop_reason: reason },
    usage: { input_tokens: input, output_tokens: output } }),
  event({ type: "message_stop" }),
];
const cliError = (...ids: string[]) => ({ type: "user", message: { role: "user",
  content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true,
    content: "<tool_use_error>Error: No such tool available: Bash</tool_use_error>" })) },
  parent_tool_use_id: null, session_id: "12345678-1234-4123-8123-123456789abc" });
const rejectedSegment = (msg: string, toolId: string, name = "Bash", input = 10) => [
  start(msg, input), ...text(msg, 0, "Let me run it."),
  ...call(msg, 1, toolId, name, [{ type: "text", text: "Let me run it." }]),
  ...stop("tool_use", 7, input),
];
function feed(decoder: BoxCliToolHandoffDecoder, values: unknown[]) {
  let sse = "";
  let last: ReturnType<BoxCliToolHandoffDecoder["push"]> | null = null;
  for (const value of values) {
    last = decoder.push(JSON.stringify(value) + "\n");
    sse += last.sse;
    if (last.candidate || last.finalCandidate) break;
  }
  return { sse, last: last! };
}
const fails = (values: unknown[], code: string, options = {}) => assert.throws(
  () => feed(new BoxCliToolHandoffDecoder(model, catalog, options), values),
  (error: unknown) => error instanceof BoxCliToolHandoffError && error.code === code, code);

test("a CLI-rejected call is dropped and the retry joins the same visible tool handoff", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const { sse, last } = feed(decoder, [init, ...rejectedSegment("msg_a", "toolu_bad_1"),
    cliError("toolu_bad_1"),
    start("msg_b", 30, 5), ...text("msg_b", 0, "Using the bridge."),
    ...call("msg_b", 1, "toolu_good_1", boxName, [{ type: "text", text: "Using the bridge." }]),
    ...stop("tool_use", 9, 30)]);
  assert.equal(sse.match(/event: message_start/g)?.length, 1, "one client message");
  assert.ok(!sse.includes("toolu_bad_1") && !sse.includes('"name":"Bash"'),
    "the rejected call and the held good call stay unseen");
  assert.ok(sse.includes('"index":0') && sse.includes('"index":1'));
  assert.ok(sse.includes("Let me run it.") && sse.includes("Using the bridge."));
  const candidate = last.candidate!;
  assert.deepEqual(candidate.toolUses.map((use) => [use.id, use.clientName]),
    [["toolu_good_1", "Bash"]]);
  assert.deepEqual([candidate.inputTokens, candidate.outputTokens, candidate.cacheReadTokens],
    [40, 16, 5], "both paid calls are billed");
  const completed = decoder.completedMessage();
  assert.equal(completed.id, "msg_a");
  const visible = [{ type: "text", text: "Let me run it." }, { type: "text", text: "Using the bridge." },
    { type: "tool_use", id: "toolu_good_1", name: "Bash", input: { value: "x" } }];
  assert.deepEqual(completed.content, visible);
  assert.equal(candidate.assistantContentHash, hashBoxAssistantContent(visible));
  const held = decoder.commitHandoff({ durableRevision: "rev-1",
    journaledToolUseIds: ["toolu_good_1"], verifiedPendingToolUseIds: ["toolu_good_1"] });
  assert.ok(held.includes('"index":2') && held.includes('"name":"Bash"'));
  assert.equal(held.match(/event: message_delta/g)?.length, 1);
  assert.equal(held.match(/event: message_stop/g)?.length, 1);
  assert.match(held, /"output_tokens":16/, "client sees cumulative usage");
});

test("a rejected call followed by a final answer settles with summed usage", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog, { allowFinal: true });
  const { last } = feed(decoder, [init, ...rejectedSegment("msg_a", "toolu_bad_1", "ExecuteExtraTool"),
    cliError("toolu_bad_1"), start("msg_b", 30), ...text("msg_b", 0, "Done without it."),
    ...stop("end_turn", 4, 30),
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 40, output_tokens: 11 } }]);
  const final = last.finalCandidate!;
  assert.deepEqual([final.inputTokens, final.outputTokens], [40, 11]);
  decoder.finishFinal();
  const terminal = decoder.commitFinal({ terminalReason: "worker_complete", journaledUsage: {
    inputTokens: 40, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  assert.equal(terminal.match(/event: message_stop/g)?.length, 1);
});

test("two rejected calls may be answered in separate CLI records", () => {
  const msg = "msg_a";
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const { last } = feed(decoder, [init, start(msg),
    ...call(msg, 0, "toolu_bad_1", "Read"),
    ...call(msg, 1, "toolu_bad_2", "Grep", [{ type: "tool_use", id: "toolu_bad_1",
      name: "Read", input: { value: "x" } }]),
    ...stop("tool_use", 7), cliError("toolu_bad_1"), cliError("toolu_bad_2"),
    start("msg_b", 30), ...call("msg_b", 0, "toolu_good", boxName), ...stop("tool_use", 3, 30)]);
  assert.deepEqual(last.candidate!.toolUses.map((use) => use.id), ["toolu_good"]);
});

test("anything outside the exact rejected-call shape still fails closed", () => {
  const base = [init, ...rejectedSegment("msg_a", "toolu_bad_1")];
  const retry = [start("msg_b", 30), ...call("msg_b", 0, "toolu_good", boxName), ...stop("tool_use", 3, 30)];
  // the CLI's own error result is mandatory before the retry
  fails([...base, ...retry], "BOX_TOOL_CLI_ERROR_MISSING");
  // wrong id, not an error, or not a CLI tool_use_error text
  fails([...base, cliError("toolu_other")], "BOX_TOOL_CLI_ERROR_INVALID");
  const notError = cliError("toolu_bad_1");
  (notError.message.content[0] as { is_error: boolean }).is_error = false;
  fails([...base, notError], "BOX_TOOL_CLI_ERROR_INVALID");
  const freeText = cliError("toolu_bad_1");
  (freeText.message.content[0] as { content: string }).content = "ran fine";
  fails([...base, freeText], "BOX_TOOL_CLI_ERROR_INVALID");
  // a user record with nothing rejected, and a synthetic one
  fails([init, start("msg_a"), cliError("toolu_bad_1")], "BOX_TOOL_RECORD_INVALID");
  // valid and unknown calls mixed in one message keep the old rejection
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_good", boxName),
    ...call("msg_a", 1, "toolu_bad_1", "Bash", [{ type: "tool_use", id: "toolu_good",
      name: boxName, input: { value: "x" } }])], "BOX_TOOL_ID_OR_NAME_INVALID");
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_bad_1", "Bash"),
    ...call("msg_a", 1, "toolu_good", boxName, [{ type: "tool_use", id: "toolu_bad_1",
      name: "Bash", input: { value: "x" } }])], "BOX_TOOL_ID_OR_NAME_INVALID");
  // a reused upstream message id is not a new segment
  fails([...base, cliError("toolu_bad_1"), start("msg_a", 30)], "BOX_TOOL_MESSAGE_INVALID");
  // bounded: the fourth consecutive rejection fails
  fails([init, ...rejectedSegment("m1", "toolu_b1"), cliError("toolu_b1"),
    ...rejectedSegment("m2", "toolu_b2"), cliError("toolu_b2"),
    ...rejectedSegment("m3", "toolu_b3"), cliError("toolu_b3"),
    ...rejectedSegment("m4", "toolu_b4")], "BOX_TOOL_ID_OR_NAME_INVALID");
  // the run's cumulative result must cover every merged segment
  fails([...base, cliError("toolu_bad_1"), start("msg_b", 30), ...text("msg_b", 0, "ok"),
    ...stop("end_turn", 4, 30), { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 30, output_tokens: 4 } }], "BOX_TOOL_FINAL_USAGE_INVALID",
  { allowFinal: true });
  // a rejected-only message cannot end the turn
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_bad_1", "Bash"), ...stop("end_turn", 2)],
    "BOX_TOOL_ID_OR_NAME_INVALID", { allowFinal: true });
});
