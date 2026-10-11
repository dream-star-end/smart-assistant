// OCV5-328 (#27da48a8): one model message called an exposed tool and, beside
// it, tools this Box invocation does not expose. Claude Code runs the exposed
// call first and answers the others itself afterwards. The decoder hands the
// exposed calls off, keeps the others hidden, and the next round takes the
// CLI's own answers before its model message.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BoxCliToolHandoffDecoder, BoxCliToolHandoffError } from "./boxCliToolHandoff.js";
import { hashBoxAssistantContent } from "./boxCallFingerprint.js";

const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "Bash", description: "Synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }], "natural");
const boxName = "mcp__ocbridge__Bash";
const hiddenName = "mcp__openclaude-memory__delegate_task";
const event = (value: unknown) => ({ type: "stream_event", event: value });
const init = { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] };
const start = (id: string, input = 10) => event({ type: "message_start", message: {
  id, model, role: "assistant", content: [],
  usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0 } } });
const text = (id: string, index: number, value: string) => [
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [{ type: "text", text: value }] } },
  event({ type: "content_block_stop", index }),
];
// Claude Code 2.1.288 writes one assistant snapshot per completed block.
const call = (id: string, index: number, toolId: string, name: string) => [
  event({ type: "content_block_start", index,
    content_block: { type: "tool_use", id: toolId, name, input: {} } }),
  event({ type: "content_block_delta", index,
    delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [{ type: "tool_use", id: toolId, name, input: { value: "x" } }] } },
  event({ type: "content_block_stop", index }),
];
const stop = (reason: string, output: number, input = 10) => [
  event({ type: "message_delta", delta: { stop_reason: reason },
    usage: { input_tokens: input, output_tokens: output } }),
  event({ type: "message_stop" }),
];
const cliError = (id: string, name = hiddenName) => ({ type: "user", message: { role: "user",
  content: [{ type: "tool_result", tool_use_id: id, is_error: true,
    content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>` }] },
  parent_tool_use_id: null, session_id: "12345678-1234-4123-8123-123456789abc" });
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
const code = (expected: string) => (error: unknown) =>
  error instanceof BoxCliToolHandoffError && error.code === expected;
const next = (prior: Array<{ id: string; name: string }>) =>
  new BoxCliToolHandoffDecoder(model, catalog,
    { alreadyInitialized: true, allowFinal: true, priorRejectedToolUses: prior });
const finalMessage = [start("msg_b", 30), ...text("msg_b", 0, "Done."), ...stop("end_turn", 4, 30),
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 40, output_tokens: 13 } }];

test("an exposed call followed by unexposed calls hands off the exposed one only", () => {
  // the shape of #27da48a8: text, ExecuteExtraTool, then two direct calls
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const { sse, last } = feed(decoder, [init, start("msg_a"),
    ...text("msg_a", 0, "I'll test the other models in that route the same way."),
    ...call("msg_a", 1, "toolu_good", boxName),
    ...call("msg_a", 2, "toolu_hidden_1", hiddenName),
    ...call("msg_a", 3, "toolu_hidden_2", hiddenName),
    ...stop("tool_use", 9)]);
  assert.ok(sse.includes("I'll test the other models"), "text streams live");
  assert.ok(!sse.includes("toolu_") && !sse.includes(hiddenName), "no call leaves before the handoff");
  const candidate = last.candidate!;
  assert.deepEqual(candidate.toolUses.map((use) => [use.id, use.clientName]), [["toolu_good", "Bash"]]);
  assert.deepEqual(candidate.rejectedToolUses, [{ id: "toolu_hidden_1", name: hiddenName },
    { id: "toolu_hidden_2", name: hiddenName }]);
  const visible = [{ type: "text", text: "I'll test the other models in that route the same way." },
    { type: "tool_use", id: "toolu_good", name: "Bash", input: { value: "x" } }];
  assert.deepEqual(decoder.completedMessage().content, visible);
  assert.equal(decoder.completedMessage().stop_reason, "tool_use");
  assert.equal(candidate.assistantContentHash, hashBoxAssistantContent(visible));
  const held = decoder.commitHandoff({ durableRevision: "rev-1",
    journaledToolUseIds: ["toolu_good"], verifiedPendingToolUseIds: ["toolu_good"] });
  assert.ok(held.includes("toolu_good") && held.includes('"name":"Bash"'));
  assert.ok(!held.includes("toolu_hidden") && !held.includes(hiddenName), "hidden calls never reach the client");
  assert.equal(held.match(/event: content_block_start/g)?.length, 1);
  assert.equal(held.match(/event: message_delta/g)?.length, 1);
  assert.equal(held.match(/event: message_stop/g)?.length, 1);
});

test("an unexposed call before the exposed one is hidden the same way", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const { last } = feed(decoder, [init, start("msg_a"),
    ...call("msg_a", 0, "toolu_hidden_1", hiddenName),
    ...call("msg_a", 1, "toolu_good", boxName), ...stop("tool_use", 9)]);
  assert.deepEqual(last.candidate!.toolUses.map((use) => use.id), ["toolu_good"]);
  assert.deepEqual(last.candidate!.rejectedToolUses, [{ id: "toolu_hidden_1", name: hiddenName }]);
  const held = decoder.commitHandoff({ durableRevision: "rev-1",
    journaledToolUseIds: ["toolu_good"], verifiedPendingToolUseIds: ["toolu_good"] });
  assert.ok(held.includes('"index":0') && !held.includes('"index":1'), "visible indexes stay dense");
});

test("a message with only exposed calls records no hidden calls", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog);
  const { last } = feed(decoder, [init, start("msg_a"),
    ...call("msg_a", 0, "toolu_good", boxName), ...stop("tool_use", 9)]);
  assert.equal(Object.hasOwn(last.candidate!, "rejectedToolUses"), false);
});

test("the next round takes the CLI's answers to the hidden calls before its model message", () => {
  const prior = [{ id: "toolu_hidden_1", name: hiddenName }, { id: "toolu_hidden_2", name: hiddenName }];
  const decoder = next(prior);
  const echo = { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_good", content: "ok" }] } };
  assert.equal(decoder.priorCliToolErrorDue(echo), false, "a published-result echo is not the decoder's");
  assert.equal(decoder.priorCliToolErrorDue(cliError("toolu_hidden_1")), true);
  const { sse, last } = feed(decoder, [cliError("toolu_hidden_1"), cliError("toolu_hidden_2"),
    ...finalMessage]);
  assert.ok(!sse.includes("No such tool") && !sse.includes("toolu_hidden"));
  assert.equal(last.finalCandidate!.stopReason, "end_turn");
  assert.equal(decoder.priorCliToolErrorDue(cliError("toolu_hidden_1")), false, "answered once");
  // both answers in one record
  const together = cliError("toolu_hidden_1");
  together.message.content.push(cliError("toolu_hidden_2").message.content[0]!);
  assert.equal(feed(next(prior), [together, ...finalMessage]).last.finalCandidate!.stopReason, "end_turn");
});

test("the next round fails closed on anything but those exact answers", () => {
  const prior = [{ id: "toolu_hidden_1", name: hiddenName }];
  // the model cannot start before the CLI answered every hidden call
  assert.throws(() => feed(next(prior), finalMessage), code("BOX_TOOL_CLI_ERROR_MISSING"));
  // only Claude Code's own unknown-tool error for that call's name
  assert.throws(() => feed(next(prior), [cliError("toolu_hidden_1", "Bash")]),
    code("BOX_TOOL_CLI_ERROR_INVALID"));
  const ran = cliError("toolu_hidden_1");
  (ran.message.content[0] as { is_error: boolean }).is_error = false;
  assert.throws(() => feed(next(prior), [ran]), code("BOX_TOOL_CLI_ERROR_INVALID"));
  // an answer nobody is waiting for
  assert.throws(() => feed(next(prior), [cliError("toolu_other")]), code("BOX_TOOL_CLI_ERROR_INVALID"));
  assert.throws(() => feed(next(prior), [cliError("toolu_hidden_1"), cliError("toolu_hidden_1")]),
    code("BOX_TOOL_RECORD_INVALID"));
  assert.throws(() => feed(next([]), [cliError("toolu_hidden_1")]), code("BOX_TOOL_RECORD_INVALID"));
  // never after the model message started
  const late = next(prior);
  assert.throws(() => feed(late, [cliError("toolu_hidden_1"), start("msg_b", 30),
    cliError("toolu_hidden_1")]), code("BOX_TOOL_RECORD_INVALID"));
  // a hidden call is never one of this run's own tools, and ids are unique
  const invalid = (uses: Array<{ id: string; name: string }>, options = {}) => assert.throws(
    () => new BoxCliToolHandoffDecoder(model, catalog, { alreadyInitialized: true,
      priorRejectedToolUses: uses, ...options }), code("BOX_TOOL_DECODER_INVALID"));
  invalid([{ id: "toolu_hidden_1", name: boxName }]);
  invalid([{ id: "toolu_hidden_1", name: hiddenName }, { id: "toolu_hidden_1", name: hiddenName }]);
  invalid([{ id: "not-a-tool-id", name: hiddenName }]);
  invalid(prior, { alreadyInitialized: false });
});

test("mixed messages keep every other fail-closed rule", () => {
  const fails = (values: unknown[], expected: string, options = {}) => assert.throws(
    () => feed(new BoxCliToolHandoffDecoder(model, catalog, options), values), code(expected));
  // a hidden call cannot reuse an exposed call's id, or the reverse
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_dup", boxName),
    ...call("msg_a", 1, "toolu_dup", hiddenName)], "BOX_TOOL_DUPLICATE_ID");
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_dup", hiddenName),
    ...call("msg_a", 1, "toolu_dup", boxName)], "BOX_TOOL_DUPLICATE_ID");
  // tool calls cannot end the turn
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_good", boxName),
    ...call("msg_a", 1, "toolu_hidden_1", hiddenName), ...stop("end_turn", 3)],
  "BOX_TOOL_ID_OR_NAME_INVALID", { allowFinal: true });
  // a malformed id or name is not a hidden call
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_good", boxName),
    ...call("msg_a", 1, "toolu_hidden_1", "bad name")], "BOX_TOOL_ID_OR_NAME_INVALID");
  fails([init, start("msg_a"), ...call("msg_a", 0, "toolu_good", boxName),
    ...call("msg_a", 1, "call_1", hiddenName)], "BOX_TOOL_ID_OR_NAME_INVALID");
});

// What Claude Code 2.1.288 on the Box really writes for such a message
// (captured 2026-10-06 with a one-tool `ocbridge` MCP server): the exposed
// call, two direct calls to an unexposed tool, then after the exposed result
// one `No such tool available` record per direct call, then the final answer.
test("a real Claude Code capture of a mixed message runs through both rounds", () => {
  const lines = readFileSync(new URL("./ocv5-328-mixed-calls.stdout.jsonl", import.meta.url), "utf8")
    .split("\n").filter(Boolean);
  const bridge = compileBoxToolCatalog([{ name: "ExecuteExtraTool", description: "Run an extra tool",
    input_schema: { type: "object", properties: { tool_name: { type: "string" },
      params: { type: "object" } } } }], "natural");
  const first = new BoxCliToolHandoffDecoder(model, bridge);
  let at = 0, sse = "";
  let candidate: ReturnType<BoxCliToolHandoffDecoder["push"]>["candidate"] = null;
  for (; at < lines.length && !candidate; at++) {
    const pushed = first.push(lines[at] + "\n");
    sse += pushed.sse; candidate = pushed.candidate;
  }
  assert.ok(candidate, "the mixed message is handed off");
  assert.deepEqual(candidate.toolUses.map((use) => [use.boxName, use.clientName]),
    [["mcp__ocbridge__ExecuteExtraTool", "ExecuteExtraTool"]]);
  assert.deepEqual(candidate.rejectedToolUses?.map((use) => use.name),
    [hiddenName, hiddenName]);
  const held = first.commitHandoff({ durableRevision: "rev-1",
    journaledToolUseIds: candidate.toolUses.map((use) => use.id),
    verifiedPendingToolUseIds: candidate.toolUses.map((use) => use.id) });
  assert.ok(!(sse + held).includes(hiddenName + '","input'), "no hidden tool_use block is forwarded");
  for (const hidden of candidate.rejectedToolUses!) assert.ok(!(sse + held).includes(hidden.id));
  assert.equal((first.completedMessage().content as Array<{ type: string }>)
    .filter((block) => block.type === "tool_use").length, 1);

  const second = new BoxCliToolHandoffDecoder(model, bridge, { alreadyInitialized: true,
    allowFinal: true, priorRejectedToolUses: candidate.rejectedToolUses });
  let echoes = 0, answers = 0, final: ReturnType<BoxCliToolHandoffDecoder["push"]>["finalCandidate"] = null;
  for (; at < lines.length && !final; at++) {
    const record = JSON.parse(lines[at]!) as { type?: string };
    if (record.type === "user" && !second.priorCliToolErrorDue(record)) { echoes++; continue; }
    if (record.type === "user") answers++;
    final = second.push(lines[at] + "\n").finalCandidate;
  }
  assert.deepEqual([echoes, answers], [1, 2], "one published-result echo, two CLI answers");
  assert.equal(final?.stopReason, "end_turn");
});
