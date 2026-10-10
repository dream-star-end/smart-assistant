// OCV5-368: when a model message ends at `max_tokens`, Claude Code writes its
// own synthetic resume turn ("Output token limit hit. Resume directly …") and
// continues in a new model message of the same run. Live 2026-10-10 (commercial
// #8bbb12ed): a final answer spent its 32000-token cap on thinking, the resume
// turn was rejected as a compaction, and the answer the CLI then wrote was
// dropped. The decoder now joins the resumed message to the visible one, like
// an OCV5-301 retry, and bills both calls.
import test from "node:test";
import assert from "node:assert/strict";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BOX_TOOL_MESSAGE_STREAM_MAX_BYTES, BoxCliToolHandoffDecoder,
  BoxCliToolHandoffError } from "./boxCliToolHandoff.js";
import { isBoxCliOutputLimitResume } from "./boxCliCompaction.js";
import { hashBoxAssistantContent } from "./boxCallFingerprint.js";

const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "Bash", description: "Synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }], "natural");
const boxName = "mcp__ocbridge__Bash";
const session = "12345678-1234-4123-8123-123456789abc";
const event = (value: unknown) => ({ type: "stream_event", event: value });
const init = { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] };
const start = (id: string, input = 10, read = 0) => event({ type: "message_start", message: {
  id, model, role: "assistant", content: [],
  usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read } } });
const thinking = (id: string, index: number, value: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
  event({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: value } }),
  event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig-${id}` } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [...prior, { type: "thinking", thinking: value, signature: `sig-${id}` }] } },
  event({ type: "content_block_stop", index }),
];
const text = (id: string, index: number, value: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [...prior, { type: "text", text: value }] } },
  event({ type: "content_block_stop", index }),
];
const call = (id: string, index: number, toolId: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index,
    content_block: { type: "tool_use", id: toolId, name: boxName, input: {} } }),
  event({ type: "content_block_delta", index,
    delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id, model, role: "assistant",
    content: [...prior, { type: "tool_use", id: toolId, name: boxName, input: { value: "x" } }] } },
  event({ type: "content_block_stop", index }),
];
const stop = (reason: string, output: number, input = 10) => [
  event({ type: "message_delta", delta: { stop_reason: reason },
    usage: { input_tokens: input, output_tokens: output } }),
  event({ type: "message_stop" }),
];
// Shape and wording of Claude Code 2.1.296's record (live spool, 2026-10-10).
const RESUME_TEXT = "Output token limit hit. Resume directly — no apology, no recap of what you were doing. "
  + "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
const resume = (value = RESUME_TEXT) => ({ type: "user", parent_tool_use_id: null, isSynthetic: true,
  session_id: session, uuid: "87654321-4321-4321-8321-cba987654321",
  timestamp: "2026-10-10T01:35:05.324Z",
  message: { role: "user", content: [{ type: "text", text: value }] } });
const status = { type: "system", subtype: "status", status: "requesting" };
const result = (input: number, output: number, read = 0) => ({ type: "result", subtype: "success",
  is_error: false, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read } });
// msg_a: thinking only, cut at max_tokens; msg_b: the resumed answer.
const cutThenAnswer = [init, start("msg_a"), ...thinking("msg_a", 0, "long plan"),
  ...stop("max_tokens", 32000), resume(), status,
  start("msg_b", 12, 3), ...thinking("msg_b", 0, "short plan"),
  ...text("msg_b", 1, "The answer.", [{ type: "thinking", thinking: "short plan", signature: "sig-msg_b" }]),
  ...stop("end_turn", 7040, 12)];

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
const fails = (values: unknown[], code: string, options: object = { allowFinal: true }) => assert.throws(
  () => feed(new BoxCliToolHandoffDecoder(model, catalog, options), values),
  (error: unknown) => error instanceof BoxCliToolHandoffError && error.code === code, code);

for (const native of [false, true]) {
  test(`a max_tokens cut resumed by the CLI settles as one answer (native=${native})`, () => {
    const decoder = new BoxCliToolHandoffDecoder(model, catalog,
      { allowFinal: true, ...(native ? { trustedNativeSessionId: session } : {}) });
    const { sse, last } = feed(decoder, [...cutThenAnswer, result(22, 39040, 3)]);
    assert.equal(sse.match(/event: message_start/g)?.length, 1, "one client message");
    assert.ok(!sse.includes("max_tokens") && !sse.includes("Output token limit"),
      "neither the cut nor the CLI's resume turn reaches the client");
    assert.ok(sse.includes("long plan") && sse.includes("short plan") && sse.includes("The answer."));
    assert.ok(sse.includes('"index":2'), "the resumed blocks continue the visible indices");
    const final = last.finalCandidate!;
    assert.equal(final.stopReason, "end_turn");
    assert.deepEqual([final.inputTokens, final.outputTokens, final.cacheReadTokens],
      [22, 39040, 3], "both upstream calls are billed");
    const visible = [{ type: "thinking", thinking: "long plan", signature: "sig-msg_a" },
      { type: "thinking", thinking: "short plan", signature: "sig-msg_b" },
      { type: "text", text: "The answer." }];
    const completed = decoder.completedMessage();
    assert.equal(completed.id, "msg_a");
    assert.equal(completed.stop_reason, "end_turn");
    assert.deepEqual(completed.content, visible);
    assert.equal(final.assistantContentHash, hashBoxAssistantContent(visible));
    decoder.finishFinal();
    const terminal = decoder.commitFinal({ terminalReason: "worker_complete", journaledUsage: {
      inputTokens: 22, outputTokens: 39040, cacheReadTokens: 3, cacheWriteTokens: 0 } });
    assert.equal(terminal.match(/event: message_delta/g)?.length, 1);
    assert.match(terminal, /"stop_reason":"end_turn"/);
    assert.match(terminal, /"output_tokens":39040/, "client sees cumulative usage");
  });
}

test("a resumed message may end in a tool call and hand off with summed usage", () => {
  const decoder = new BoxCliToolHandoffDecoder(model, catalog, { allowFinal: true });
  const { last } = feed(decoder, [init, start("msg_a"), ...thinking("msg_a", 0, "plan"),
    ...stop("max_tokens", 100), resume(), start("msg_b", 12), ...call("msg_b", 0, "toolu_after_cut"),
    ...stop("tool_use", 9, 12)]);
  assert.deepEqual(last.candidate!.toolUses.map((use) => use.id), ["toolu_after_cut"]);
  assert.deepEqual([last.candidate!.inputTokens, last.candidate!.outputTokens], [22, 109]);
});

test("a message cut again after the CLI's last resume still settles at max_tokens", () => {
  const cut = (id: string) => [start(id), ...thinking(id, 0, `plan ${id}`), ...stop("max_tokens", 5)];
  const decoder = new BoxCliToolHandoffDecoder(model, catalog, { allowFinal: true });
  const { last } = feed(decoder, [init, ...cut("msg_a"), resume(), ...cut("msg_b"), resume(),
    ...cut("msg_c"), resume(), ...cut("msg_d"), result(40, 20)]);
  assert.equal(last.finalCandidate!.stopReason, "max_tokens");
  assert.equal(last.finalCandidate!.outputTokens, 20);
  // a fourth resume is beyond Claude Code's own limit and fails closed
  fails([init, ...cut("msg_a"), resume(), ...cut("msg_b"), resume(), ...cut("msg_c"), resume(),
    ...cut("msg_d"), resume()], "BOX_CLI_COMPACT_UNBOUND");
});

test("a synthetic user turn anywhere else still fails closed", () => {
  const cutA = [init, start("msg_a"), ...thinking("msg_a", 0, "plan")];
  // inside a message, before its stop
  fails([...cutA, resume()], "BOX_CLI_COMPACT_UNBOUND");
  fails([...cutA, resume()], "BOX_CLI_COMPACT_PHASE", { allowFinal: true, trustedNativeSessionId: session });
  // after a complete answer
  fails([...cutA, ...stop("end_turn", 4), resume()], "BOX_CLI_COMPACT_UNBOUND");
  // not the resume shape: a tool result, two blocks, a nested agent turn
  const toolResult = resume();
  toolResult.message.content = [{ type: "tool_result", tool_use_id: "toolu_a", content: "x" } as never];
  fails([...cutA, ...stop("max_tokens", 4), toolResult], "BOX_CLI_COMPACT_UNBOUND");
  const twoBlocks = resume();
  twoBlocks.message.content.push({ type: "text", text: "more" });
  fails([...cutA, ...stop("max_tokens", 4), twoBlocks], "BOX_CLI_COMPACT_UNBOUND");
  fails([...cutA, ...stop("max_tokens", 4), { ...resume(), parent_tool_use_id: "toolu_a" }],
    "BOX_CLI_COMPACT_UNBOUND");
  fails([...cutA, ...stop("max_tokens", 4), resume("x".repeat(4097))], "BOX_CLI_COMPACT_UNBOUND");
  // a compaction after the cut still needs its boundary and stays out of the model phase
  fails([...cutA, ...stop("max_tokens", 4), { type: "system", subtype: "compact_boundary",
    session_id: session }], "BOX_CLI_COMPACT_PHASE", { allowFinal: true, trustedNativeSessionId: session });
  // the CLI must continue after its resume turn: a bare result is not an answer
  fails([...cutA, ...stop("max_tokens", 4), resume(), result(10, 4)], "BOX_TOOL_FINAL_RESULT_INVALID");
  // a max_tokens stop is final-only, as before
  fails([...cutA, ...stop("max_tokens", 4)], "BOX_TOOL_STOP_REASON_INVALID", {});
});

test("the resume shape check is independent of the CLI's wording", () => {
  assert.equal(isBoxCliOutputLimitResume(resume()), true);
  assert.equal(isBoxCliOutputLimitResume(resume("Output token limit hit while you were still reasoning.")), true);
  assert.equal(isBoxCliOutputLimitResume({ ...resume(), isSynthetic: false }), false);
  assert.equal(isBoxCliOutputLimitResume(resume("")), false);
  const extraKey = resume();
  (extraKey.message.content[0] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  assert.equal(isBoxCliOutputLimitResume(extraKey), false);
});

test("OCV5-368 a 128k-token answer far above 1 MiB of stream still settles", () => {
  // ~3 MB of text deltas in 60000 small chunks, the way the CLI streams a long answer
  const chunk = "x".repeat(50);
  const deltas = Array.from({ length: 60_000 }, () => event({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: chunk } }));
  const decoder = new BoxCliToolHandoffDecoder(model, catalog, { allowFinal: true });
  const { last } = feed(decoder, [init, start("msg_long"),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), ...deltas,
    { type: "assistant", message: { id: "msg_long", model, role: "assistant",
      content: [{ type: "text", text: chunk.repeat(60_000) }] } },
    event({ type: "content_block_stop", index: 0 }), ...stop("end_turn", 120_000),
    result(10, 120_000)]);
  assert.equal(last.finalCandidate!.outputTokens, 120_000);
  assert.ok(BOX_TOOL_MESSAGE_STREAM_MAX_BYTES >= 6_400_000, "room for a full 128k-token text answer");
});
